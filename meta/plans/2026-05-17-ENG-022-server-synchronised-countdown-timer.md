---
date: "2026-05-17T18:30:00+00:00"
type: plan
skill: create-plan
work-item: "ENG-022"
status: draft
---

# ENG-022: Server-Synchronised Countdown Timer — Implementation Plan

## Overview

Replace `Date.now()` with a clock-offset-corrected value in both the visual timer
and the clue-giver's expiry polling loop, so that timer display and turn-end
detection are based on server time rather than the client's local clock.

The fix uses a DIY NTP-style approach: at game page mount, the client fires 5
sequential pings to a new `GET /api/time` endpoint, computes the median
`(serverTime − midpointClientTime)` offset, and stores it in a React hook.
Every elapsed-time calculation in the game page then uses `Date.now() + clockOffset`
instead of bare `Date.now()`. The offset re-syncs every 2 minutes; failure falls
back to offset = 0 silently.

## Current State Analysis

- `TurnTimer.tsx:12` — `Date.now() - Date.parse(turnStartedAt)` (cosmetic countdown)
- `GamePage.tsx:167` — `Date.now() - Date.parse(game.turnStartedAt!)` inside a 500ms
  `setInterval` that fires `POST /end-turn` when `elapsed >= turnDurationSeconds`
- No `/api/time` endpoint exists on the server
- Only one existing hook: `client/src/hooks/useGameState.ts`
- `timesync` npm library is archived (July 2025) and lacks TypeScript types — not used

## Desired End State

After implementation:
- `GET /api/time` returns `{ now: <epoch ms> }` (server time)
- `useClockOffset()` hook measures the server–client clock offset and re-syncs every 2 minutes
- Both timer calculations use `Date.now() + clockOffset`
- Two devices with clocks differing by up to 5 s display timers within 500 ms of each other

### Key Discoveries

- `server/src/index.ts:62` — `app.use('/api', apiLimiter)` already applies before all
  `/api/*` routes, so `/api/time` gets rate-limiting for free
- `/health` is at line 65; `/api/time` fits cleanly after `app.use('/api/games', …)` at line 63
- `ClueGiverView` is a component defined inside `GamePage.tsx`; `clockOffset` can be
  computed at the `GamePage` level and passed down as a prop

## What We're NOT Doing

- Server-side turn enforcement (auto-ending hung turns) — separate ticket
- Replacing the `CountdownCircleTimer` library with `requestAnimationFrame`
- Changing the SSE architecture
- Adding authentication to `/api/time`
- Using the `timesync` npm library

## Implementation Approach

Three phases, each independently shippable:

1. **Server** — add the `/api/time` endpoint (pure addition, zero risk)
2. **Hook** — implement `useClockOffset` (self-contained, testable in isolation)
3. **Wire up** — thread `clockOffset` into `TurnTimer` and `ClueGiverView` (two one-line changes)

---

## Phase 1: Add `GET /api/time` Endpoint

### Overview

Add a lightweight server endpoint that returns the current server epoch milliseconds.
This is the ping target used by the client's clock-sync algorithm.

### Changes Required

#### 1. `server/src/index.ts`

**File**: `server/src/index.ts`
**Change**: Add one route after `app.use('/api/games', createGamesRouter(store))` (line 63)

```ts
app.get('/api/time', (_req, res) => {
  res.json({ now: Date.now() })
})
```

No import changes needed. The existing `apiLimiter` on `/api` covers this route.

### Success Criteria

#### Automated Verification

- [ ] TypeScript compiles: `pnpm --filter @wordfetti/server build`
- [ ] Existing tests still pass: `pnpm --filter @wordfetti/server test`
- [ ] Endpoint responds with JSON: `curl -s http://localhost:3001/api/time | jq .`

#### Manual Verification

- [ ] `curl http://localhost:3001/api/time` returns `{"now":<epoch>}` where the value
  is within a few milliseconds of `Date.now()` on the calling machine

---

## Phase 2: `useClockOffset` Hook

### Overview

Create a React hook that measures the server–client clock offset using a DIY
NTP-style algorithm. The hook runs 5 ping exchanges at mount and re-syncs every
2 minutes. On any failure it falls back to 0.

### Changes Required

#### 1. New file: `client/src/hooks/useClockOffset.ts`

```ts
import { useEffect, useState } from 'react'

async function measureClockOffset(samples = 5): Promise<number> {
  const offsets: number[] = []
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now()
    const { now: serverTime } = await fetch('/api/time').then((r) => r.json())
    offsets.push(serverTime - (t0 + Date.now()) / 2)
  }
  offsets.sort((a, b) => a - b)
  return offsets[Math.floor(offsets.length / 2)]
}

export function useClockOffset(): number {
  const [clockOffset, setClockOffset] = useState(0)

  useEffect(() => {
    let cancelled = false

    async function sync() {
      try {
        const offset = await measureClockOffset()
        if (!cancelled) setClockOffset(offset)
      } catch {
        // fall back to 0 — current behaviour
      }
    }

    sync()
    const interval = setInterval(sync, 2 * 60 * 1000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  return clockOffset
}
```

Notes:
- `cancelled` flag prevents a stale `setClockOffset` after unmount
- No external dependencies required
- Falls back to `clockOffset = 0` on any network error or parse failure
- The median filter removes RTT outlier samples without requiring a library

### Success Criteria

#### Automated Verification

- [ ] TypeScript compiles: `pnpm --filter @wordfetti/client build`

#### Manual Verification

- [ ] On the game page, open browser devtools and add a `console.log` temporarily to
  confirm the hook produces an offset value close to 0 on localhost (clocks agree)

---

## Phase 3: Wire `clockOffset` into Timer Calculations

### Overview

Pass `clockOffset` from `GamePage` into both the display timer and the expiry polling
loop so all elapsed-time calculations use server-corrected time.

### Changes Required

#### 1. `client/src/pages/GamePage.tsx`

**Call the hook at the top of `GamePage`**:

```ts
const clockOffset = useClockOffset()
```

**Pass `clockOffset` into `ClueGiverView`** (add to its props wherever it is rendered):

```tsx
<ClueGiverView ... clockOffset={clockOffset} />
```

**Add `clockOffset` to `ClueGiverView`'s props interface**:

```ts
interface ClueGiverViewProps {
  // ... existing props
  clockOffset: number
}
```

**Update the expiry calculation in `ClueGiverView` (line 167)**:

```ts
// Before:
const elapsed = Math.floor((Date.now() - Date.parse(game.turnStartedAt!)) / 1000)
// After:
const elapsed = Math.floor(((Date.now() + clockOffset) - Date.parse(game.turnStartedAt!)) / 1000)
```

**Add `clockOffset` to the `useEffect` dependency array** (line 185):

```ts
}, [game.turnPhase, game.turnStartedAt, joinCode, playerId, clockOffset])
```

#### 2. `client/src/components/TurnTimer.tsx`

**Add `clockOffset` prop**:

```ts
interface TurnTimerProps {
  duration: number
  turnStartedAt: string
  label: string
  clockOffset: number
}
```

**Update the initial remaining time calculation (line 12)**:

```ts
// Before:
duration - Math.floor((Date.now() - Date.parse(turnStartedAt)) / 1000),
// After:
duration - Math.floor(((Date.now() + clockOffset) - Date.parse(turnStartedAt)) / 1000),
```

**Pass `clockOffset` wherever `TurnTimer` is rendered in `GamePage.tsx`**:

```tsx
<TurnTimer ... clockOffset={clockOffset} />
```

### Success Criteria

#### Automated Verification

- [ ] TypeScript compiles: `pnpm --filter @wordfetti/client build`
- [ ] No new TypeScript errors: `pnpm --filter @wordfetti/client typecheck`

#### Manual Verification

- [ ] Open two browser tabs with different system-clock offsets (or simulate by temporarily
  shifting the OS clock on a second device); both timers should show values within
  ~500 ms of each other throughout a turn
- [ ] Timer initialises to correct remaining time when joining mid-turn
- [ ] Turn end fires within one polling interval (≤500 ms) of the true server deadline
- [ ] If `/api/time` is blocked (e.g. add a failing fetch temporarily), the game page
  loads and the timer still works normally with offset = 0

---

## Testing Strategy

### Manual Testing Steps

1. Start a game on two devices (or two tabs with one having a forced clock offset using
   devtools override)
2. Begin a turn and observe both timers — they should track within 500 ms
3. Let a turn expire naturally and observe the turn-end fires promptly
4. Join a game mid-turn and verify the timer shows the correct remaining time
5. Block `/api/time` in the browser's Network devtools, reload, and confirm the game
   still works

## Performance Considerations

- 5 sequential pings at page mount add ~5 × RTT (~50–250 ms on typical connections)
  before `clockOffset` is set, but `useState(0)` means the timer starts immediately
  with offset = 0 and silently corrects when the measurement completes
- Re-sync every 2 minutes is negligible traffic

## References

- Work item: `meta/work/ENG-022-server-synchronised-countdown-timer.md`
- Related: `meta/work/ENG-012`
