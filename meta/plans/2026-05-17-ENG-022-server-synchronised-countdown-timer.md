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

The fix uses a DIY NTP-style approach: at game page mount, the client fires 3
parallel pings to a new `GET /api/time` endpoint, computes the median
`(serverTime − midpointClientTime)` offset, and stores it in a React hook.
Every elapsed-time calculation in the game page then uses `Date.now() + clockOffset`
instead of bare `Date.now()`. The offset re-syncs every 2 minutes; failure falls
back to offset = 0 silently.

## Current State Analysis

- `TurnTimer.tsx:12` — `Date.now() - Date.parse(turnStartedAt)` (cosmetic countdown)
- `GamePage.tsx:167` — `Date.now() - Date.parse(game.turnStartedAt!)` inside a 500ms
  `setInterval` that fires `POST /end-turn` when `elapsed >= turnDurationSeconds`
- `TurnTimer` is rendered in **three** places in `GamePage.tsx`: `ClueGiverView` (~line 235),
  `GuesserView` (~line 283), and `SpectatorView` (~line 311) — all three must receive `clockOffset`
- No `/api/time` endpoint exists on the server
- Only one existing hook: `client/src/hooks/useGameState.ts`
- `timesync` npm library is archived (July 2025) and lacks TypeScript types — not used
- `CountdownCircleTimer` (from `react-countdown-circle-timer`) only reads `initialRemainingTime`
  at its own mount; subsequent prop changes are ignored — requires a `key` remount strategy

## Desired End State

After implementation:
- `GET /api/time` returns `{ now: <epoch ms> }` with `Cache-Control: no-store`
- `useClockOffset()` hook fires 3 parallel pings at mount, computes the median offset,
  and re-syncs every 2 minutes; fails silently to offset = 0
- All three role-views (`ClueGiverView`, `GuesserView`, `SpectatorView`) use the
  corrected time: display timers via the `clockOffset` prop + `key` remount, expiry
  detection via `clockOffsetRef.current` inside the polling interval
- Two devices with clocks differing by up to 5 s display timers within 500 ms of each other

### Key Discoveries

- `server/src/index.ts:62` — `app.use('/api', apiLimiter)` already applies before all
  `/api/*` routes, so `/api/time` gets rate-limiting for free (500 req/min per IP)
- All other API route handlers live under `server/src/routes/` — new endpoint follows
  the same pattern via `server/src/routes/time.ts`
- `ClueGiverView`, `GuesserView`, and `SpectatorView` are all defined inside `GamePage.tsx`;
  `clockOffset` is computed at `GamePage` level and passed down as props
- `CountdownCircleTimer` treats `initialRemainingTime` as mount-time-only; a `key` prop
  change forces a remount when the offset first resolves
- Adding `clockOffset` to `ClueGiverView`'s `useEffect` deps would reset `timerFiredRef`;
  a `useRef` constructed locally inside `ClueGiverView` avoids this without stale closure risk

## What We're NOT Doing

- Server-side turn enforcement (auto-ending hung turns) — separate ticket
- Replacing the `CountdownCircleTimer` library with `requestAnimationFrame`
- Changing the SSE architecture
- Adding authentication to `/api/time`
- Using the `timesync` npm library
- Raising the global `apiLimiter` rate limit (3 pings per player is well within 500 req/min
  per IP even under typical NAT scenarios)

## Implementation Approach

Three phases, each independently shippable:

1. **Server** — add the `/api/time` endpoint as a new router module (pure addition, zero risk)
2. **Hook** — implement `useClockOffset` with 3 parallel pings, timeouts, and NaN guard
3. **Wire up** — thread `clockOffset` into all three role-views and `TurnTimer`; use
   a local `clockOffsetRef` inside `ClueGiverView` for interval reads; use `key` remount for display accuracy

---

## Phase 1: Add `GET /api/time` Endpoint

### Overview

Add a lightweight server endpoint that returns the current server epoch milliseconds.
This is the ping target used by the client's clock-sync algorithm.

### Changes Required

#### 1. New file: `server/src/routes/time.ts`

All other API route handlers live under `server/src/routes/`; the new endpoint follows
the same pattern rather than being placed inline in `index.ts`.

```ts
import { Router } from 'express'

export function createTimeRouter(): Router {
  const router = Router()

  router.get('/', (_req, res) => {
    res.set('Cache-Control', 'no-store')
    res.json({ now: Date.now() })
  })

  return router
}
```

`Cache-Control: no-store` prevents any proxy or CDN from caching the timestamp —
a stale cached value would defeat the entire sync.

#### 2. `server/src/index.ts`

Import and register the new router after the games router (line 63):

```ts
import { createTimeRouter } from './routes/time'

// after: app.use('/api/games', createGamesRouter(store))
app.use('/api/time', createTimeRouter())
```

The existing `apiLimiter` on `/api` covers `/api/time` automatically.

#### 3. New test: `server/src/routes/time.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createTimeRouter } from './time'

const app = express()
app.use('/api/time', createTimeRouter())

describe('GET /api/time', () => {
  it('returns a JSON body with a numeric integer now field close to the current time', async () => {
    const before = Date.now()
    const res = await request(app).get('/api/time')
    const after = Date.now()
    expect(res.status).toBe(200)
    expect(typeof res.body.now).toBe('number')
    expect(Number.isInteger(res.body.now)).toBe(true)
    expect(res.body.now).toBeGreaterThanOrEqual(before)
    expect(res.body.now).toBeLessThanOrEqual(after)
  })

  it('sets Cache-Control: no-store', async () => {
    const res = await request(app).get('/api/time')
    expect(res.headers['cache-control']).toBe('no-store')
  })
})
```

### Success Criteria

#### Automated Verification

- [x] TypeScript compiles: `pnpm --filter @wordfetti/server build`
- [x] All tests pass (including new `time.test.ts`): `pnpm --filter @wordfetti/server test`

#### Manual Verification

- [ ] `curl http://localhost:3000/api/time` returns `{"now":<epoch>}` where the value
  is within a few milliseconds of `Date.now()` on the calling machine

---

## Phase 2: `useClockOffset` Hook

### Overview

Create a React hook that measures the server–client clock offset using a DIY
NTP-style algorithm. The hook runs 3 parallel pings at mount and re-syncs every
2 minutes. On any failure it falls back to offset = 0.

The hook returns both `clockOffset` (the numeric offset in ms) and `clockOffsetReady`
(a boolean that becomes `true` after the first successful measurement). The boolean
is used by Phase 3's `key` remount strategy; separating it from the offset avoids a
correctness hole where an offset of exactly 0 (clocks agree) would prevent remounting.

### Changes Required

#### 1. New file: `client/src/hooks/useClockOffset.ts`

```ts
import { useEffect, useState } from 'react'

const PING_COUNT = 3

async function singlePing(): Promise<number> {
  const t0 = Date.now()
  const res = await fetch('/api/time', { signal: AbortSignal.timeout(2000) })
  const t1 = Date.now()  // captured before JSON parsing to exclude parse time from RTT
  const { now: serverTime } = await res.json()
  if (typeof serverTime !== 'number' || !Number.isFinite(serverTime)) {
    throw new Error('unexpected /api/time response shape')
  }
  return serverTime - (t0 + t1) / 2
}

async function measureClockOffset(): Promise<number> {
  const results = await Promise.allSettled(
    Array.from({ length: PING_COUNT }, singlePing)
  )
  const offsets = results
    .filter((r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled')
    .map(r => r.value)
  if (offsets.length === 0) throw new Error('all pings failed')
  offsets.sort((a, b) => a - b)
  return offsets[Math.floor(offsets.length / 2)]
}

export function useClockOffset(): { clockOffset: number; clockOffsetReady: boolean } {
  const [clockOffset, setClockOffset] = useState(0)
  const [clockOffsetReady, setClockOffsetReady] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function sync() {
      try {
        const offset = await measureClockOffset()
        if (!cancelled) {
          setClockOffset(offset)
          setClockOffsetReady(true)
        }
      } catch (err) {
        console.warn('[useClockOffset] clock sync failed, using offset 0:', err)
        // fall back to 0 — current behaviour; clockOffsetReady remains false
      }
    }

    sync()
    const interval = setInterval(sync, 2 * 60 * 1000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  return { clockOffset, clockOffsetReady }
}
```

Notes:
- **`PING_COUNT = 3`** constant rather than a function parameter — the parameter was dead
  interface surface since `useClockOffset` always called `measureClockOffset()` with no
  argument; removing it prevents accidental miscalling
- **`Promise.allSettled`** — if one ping is slow or fails, the other two resolve normally
  and a usable median is computed from the successful results; only throws if all three fail
- **`AbortSignal.timeout(2000)`** per ping — prevents a stalled fetch from blocking sync
  indefinitely; a failed ping falls through to `Promise.allSettled` as `'rejected'`
- **`t1` captured before `res.json()`** — excludes JSON parse time from the RTT midpoint,
  giving a more accurate server–client offset
- **`Number.isFinite` guard** — rejects `undefined`/`NaN` responses (e.g. an HTML error page
  from a proxy) before they can corrupt elapsed-time arithmetic
- **`clockOffsetReady`** — set to `true` only after a successful measurement, even if
  `clockOffset` happens to be 0 (clocks agree); keeps the `key` remount strategy correct
- **`cancelled` flag** prevents stale `setClockOffset`/`setClockOffsetReady` after unmount
- Falls back to `clockOffset = 0` on any error — preserves current behaviour
- 3 pings vs 5 reduces per-player rate-limit budget consumption; 3 pings at mount + 3 every
  2 minutes = ~4.5 req/min per player, well within the 500 req/min per IP limit even with
  10 players on shared NAT

#### 2. New test: `client/src/hooks/useClockOffset.test.ts`

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useClockOffset } from './useClockOffset'

const mockFetch = vi.fn()
global.fetch = mockFetch

function makeFetchResponse(serverTime: number) {
  return Promise.resolve({
    json: () => Promise.resolve({ now: serverTime }),
  })
}

describe('useClockOffset', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

  it('initialises to 0 with clockOffsetReady false', () => {
    mockFetch.mockReturnValue(new Promise(() => {})) // never resolves
    const { result } = renderHook(() => useClockOffset())
    expect(result.current.clockOffset).toBe(0)
    expect(result.current.clockOffsetReady).toBe(false)
  })

  it('updates to the computed offset after pings resolve', async () => {
    // Simulate server 200ms ahead of client
    mockFetch.mockImplementation(() => {
      const now = Date.now()
      return makeFetchResponse(now + 200)
    })
    const { result } = renderHook(() => useClockOffset())
    await act(async () => { await vi.runAllTimersAsync() })
    expect(result.current.clockOffset).toBeCloseTo(200, -1)
    expect(result.current.clockOffsetReady).toBe(true)
  })

  it('falls back to 0 when all fetches reject', async () => {
    mockFetch.mockRejectedValue(new Error('network error'))
    const { result } = renderHook(() => useClockOffset())
    await act(async () => { await vi.runAllTimersAsync() })
    expect(result.current.clockOffset).toBe(0)
    expect(result.current.clockOffsetReady).toBe(false)
  })

  it('falls back to 0 when /api/time returns a non-numeric now', async () => {
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ now: 'bad' }),
    })
    const { result } = renderHook(() => useClockOffset())
    await act(async () => { await vi.runAllTimersAsync() })
    expect(result.current.clockOffset).toBe(0)
    expect(result.current.clockOffsetReady).toBe(false)
  })

  it('produces a result even when one of the three pings stalls', async () => {
    // First ping never resolves; AbortSignal.timeout(2000) will cancel it.
    // Other two succeed with server 200ms ahead.
    let call = 0
    mockFetch.mockImplementation(() => {
      call++
      if (call === 1) return new Promise(() => {}) // stalls until aborted
      return makeFetchResponse(Date.now() + 200)
    })
    const { result } = renderHook(() => useClockOffset())
    await act(async () => {
      vi.advanceTimersByTime(2001) // trigger AbortSignal timeout on the stalled ping
      await vi.runAllTimersAsync()
    })
    // 2 of 3 pings fulfilled — median of two 200ms offsets
    expect(result.current.clockOffset).toBeCloseTo(200, -1)
    expect(result.current.clockOffsetReady).toBe(true)
  })

  it('re-syncs after 2 minutes with updated offset', async () => {
    let call = 0
    mockFetch.mockImplementation(() => {
      call++
      return makeFetchResponse(Date.now() + (call <= PING_COUNT ? 100 : 300))
    })
    const { result } = renderHook(() => useClockOffset())
    await act(async () => { await vi.runAllTimersAsync() })
    await act(async () => {
      vi.advanceTimersByTime(2 * 60 * 1000)
      await vi.runAllTimersAsync()
    })
    expect(result.current.clockOffset).toBeCloseTo(300, -1)
  })
})
```

Note: the re-sync test references `PING_COUNT` — either import it from the hook module
(if exported) or use the literal `3` in the test.

### Success Criteria

#### Automated Verification

- [x] TypeScript compiles: `pnpm --filter @wordfetti/client build`
- [x] Hook tests pass: `pnpm --filter @wordfetti/client test`

#### Manual Verification

- [ ] On the game page, open browser devtools and add a `console.log` temporarily to
  confirm the hook produces an offset value close to 0 on localhost (clocks agree)
- [ ] Note: React Strict Mode double-invokes effects in development, firing 6 pings
  (3 × 2) instead of 3 at mount — this is dev-only and the `cancelled` flag handles
  cleanup correctly

---

## Phase 3: Wire `clockOffset` into Timer Calculations

### Overview

Pass `clockOffset` and `clockOffsetReady` from `GamePage` into all three role-views
(`ClueGiverView`, `GuesserView`, `SpectatorView`) and into `TurnTimer`. Two subtleties:

1. **`CountdownCircleTimer` ignores `initialRemainingTime` after mount.** Because
   `useClockOffset` resolves ~50–250 ms after `TurnTimer` mounts, the corrected offset
   arrives after the timer has already started. Forcing a remount via a `key` prop ensures
   `initialRemainingTime` is recalculated with the true offset. The key uses `clockOffsetReady`
   (not `clockOffset !== 0`) so that a genuine offset of 0 (clocks agree) still triggers
   the remount, and a re-sync failure that falls back to 0 does not trigger an unwanted
   mid-turn remount.

2. **Adding `clockOffset` to the `ClueGiverView` `useEffect` deps would reset
   `timerFiredRef`.** The `useEffect` body resets `timerFiredRef.current = false` on
   every run — if `clockOffset` were in the deps it would reset the guard on every
   re-sync, briefly re-enabling UI buttons and risking a duplicate `end-turn` POST.
   Instead, `ClueGiverView` constructs a `clockOffsetRef` locally and keeps it in
   sync with the incoming `clockOffset` prop via a dedicated one-line `useEffect`. The
   interval reads `clockOffsetRef.current` on each tick. All three role-views therefore
   accept the same `clockOffset: number` prop — the ref is a private implementation
   detail of `ClueGiverView`.

### Changes Required

#### 1. `client/src/pages/GamePage.tsx`

**Call the hook at the top of `GamePage`**:

```ts
const { clockOffset, clockOffsetReady } = useClockOffset()
```

No `clockOffsetRef` or companion `useEffect` needed at `GamePage` level — the ref
lives inside `ClueGiverView`.

**Pass props to all three role views**:

```tsx
// All three accept clockOffset: number — symmetric interface
<ClueGiverView ... clockOffset={clockOffset} />
<GuesserView   ... clockOffset={clockOffset} />
<SpectatorView ... clockOffset={clockOffset} />
```

**Add the key prop to every `<TurnTimer>` render site** (forces a remount once
when the first offset measurement resolves, so `initialRemainingTime` is correct):

```tsx
<TurnTimer
  key={clockOffsetReady ? 'synced' : 'unsynced'}
  clockOffset={clockOffset}
  ...
/>
```

Apply the same `key` at every call site (`ClueGiverView`, `GuesserView`, `SpectatorView`).
`clockOffsetReady` transitions from `false` to `true` exactly once per session (on the
first successful sync), so the remount fires exactly once.

#### 2. `ClueGiverView` — props, ref, and interval

**Update the props interface**:

```ts
interface ClueGiverViewProps {
  // ... existing props
  clockOffset: number  // value, not ref — ref is an internal implementation detail
}
```

**Construct `clockOffsetRef` locally at the top of `ClueGiverView`**:

```ts
// Kept in sync so the interval can read the latest offset without adding
// clockOffset to the useEffect deps (which would reset timerFiredRef).
const clockOffsetRef = useRef(clockOffset)
useEffect(() => { clockOffsetRef.current = clockOffset }, [clockOffset])
```

**Update the expiry calculation in the interval (line 167) — read the ref**:

```ts
// Before:
const elapsed = Math.floor((Date.now() - Date.parse(game.turnStartedAt!)) / 1000)
// After:
const elapsed = Math.floor(
  (Date.now() + clockOffsetRef.current - Date.parse(game.turnStartedAt!)) / 1000
)
```

**Leave the `useEffect` dependency array unchanged** (line 185):

```ts
}, [game.turnPhase, game.turnStartedAt, joinCode, playerId])
// clockOffsetRef is a stable object reference — no need to add it to deps.
// Its .current is read on each interval tick, always reflecting the latest offset.
```

#### 3. `GuesserView` — props

```ts
interface GuesserViewProps {
  // ... existing props
  clockOffset: number
}
```

Forward `clockOffset` to the `<TurnTimer>` call inside `GuesserView`.

#### 4. `SpectatorView` — props

```ts
interface SpectatorViewProps {
  // ... existing props
  clockOffset: number
}
```

Forward `clockOffset` to the `<TurnTimer>` call inside `SpectatorView`.

#### 5. `client/src/components/TurnTimer.tsx`

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
duration - Math.floor((Date.now() + clockOffset - Date.parse(turnStartedAt)) / 1000),
```

#### 6. New test: `client/src/components/TurnTimer.test.tsx`

```ts
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TurnTimer } from './TurnTimer'

describe('TurnTimer', () => {
  it('applies clockOffset when computing initialRemainingTime', () => {
    const duration = 60
    // Turn started 10 real seconds ago; server clock is 5s ahead of client
    const turnStartedAt = new Date(Date.now() - 10_000).toISOString()
    const clockOffset = 5_000

    render(
      <TurnTimer
        duration={duration}
        turnStartedAt={turnStartedAt}
        label="Time"
        clockOffset={clockOffset}
      />
    )
    // elapsed = (Date.now() + 5000 - (Date.now() - 10000)) / 1000 = 15s
    // initialRemainingTime = 60 - 15 = 45
    // CountdownCircleTimer renders the remaining seconds as text
    expect(screen.getByText('45')).toBeTruthy()
  })

  it('applies clockOffset = 0 correctly (no change to remaining time)', () => {
    const duration = 60
    const turnStartedAt = new Date(Date.now() - 10_000).toISOString()

    render(
      <TurnTimer
        duration={duration}
        turnStartedAt={turnStartedAt}
        label="Time"
        clockOffset={0}
      />
    )
    expect(screen.getByText('50')).toBeTruthy()
  })
})
```

### Success Criteria

#### Automated Verification

- [x] TypeScript compiles: `pnpm --filter @wordfetti/client build`
  (TypeScript will catch any call site that forgets to pass `clockOffset` since
  the prop is non-optional on all four components)
- [x] Hook tests pass: `pnpm --filter @wordfetti/client test`
- [x] TurnTimer tests pass: `pnpm --filter @wordfetti/client test`

#### Manual Verification

- [ ] Open two browser tabs with different system-clock offsets (or simulate by
  temporarily shifting the OS clock on a second device); **all three role views**
  (clue-giver, guesser, spectator) should show timer values within ~500 ms of each
  other throughout a turn
- [ ] Timer initialises to the correct remaining time when joining mid-turn
- [ ] Turn end fires within one polling interval (≤500 ms) of the true server deadline
- [ ] If `/api/time` is blocked (e.g. add a failing fetch temporarily), the game page
  loads and the timer still works normally with offset = 0
- [ ] Observe that when the page first loads, the timer starts with offset = 0, then
  remounts ~50–250 ms later with the corrected offset (a brief reset is acceptable)

---

## Testing Strategy

### Automated Tests

- `server/src/routes/time.test.ts` — two cases: (1) 200 + `{ now: integer }` shape +
  bounded by before/after timestamps, (2) `Cache-Control: no-store` header
- `client/src/hooks/useClockOffset.test.ts` — six cases: initial state = 0 / ready = false,
  correct median offset + ready = true, fallback to 0 on rejection, fallback to 0 on
  non-numeric response, partial success when one ping stalls, re-sync at 2-minute interval
  with correct updated value
- `client/src/components/TurnTimer.test.tsx` — two cases: `clockOffset` reduces
  `initialRemainingTime` correctly, `clockOffset = 0` produces unmodified remaining time

### Manual Testing Steps

1. Start a game on two devices (or two tabs with one having a forced clock offset using
   devtools override)
2. Begin a turn and observe **all three role-views** (clue-giver, guesser, spectator) —
   timers should track within 500 ms across devices
3. Let a turn expire naturally and observe the turn-end fires promptly
4. Join a game mid-turn and verify the timer shows the correct remaining time
5. Block `/api/time` in the browser's Network devtools, reload, and confirm the game
   still works (timer runs from offset = 0)
6. Observe the brief timer remount ~50–250 ms after page load — confirm it is not jarring

## Performance Considerations

- 3 parallel pings at page mount reduce the latency window to ~1 × RTT (~10–100 ms)
  before `clockOffset` is set; timer starts immediately with offset = 0 and remounts
  with the corrected value once the parallel pings resolve
- `Promise.allSettled` means a slow server response does not block the two fast ones;
  the median is computed from whichever pings succeed within the 2s timeout
- Timer remount is brief and intentional — `CountdownCircleTimer` only reads
  `initialRemainingTime` at mount, so the remount is the only way to apply the offset
  to the display timer
- Re-sync every 2 minutes is negligible traffic (3 requests per player per 2 min)

## References

- Work item: `meta/work/ENG-022-server-synchronised-countdown-timer.md`
- Related: `meta/work/ENG-012`
