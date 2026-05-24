---
date: "2026-05-25T00:00:00+00:00"
type: plan
skill: create-plan
work-item: "meta/work/ENG-028-host-can-extend-game-with-unlimited-custom-extra-rounds.md"
status: draft
---

# ENG-028: Host Can Extend Game with Unlimited Custom Extra Rounds

## Overview

After the hat empties at the end of round 3 (and every subsequent extra round), instead of transitioning directly to `'finished'`, the server emits a new `'awaiting_extra_round_decision'` status. All players see a holding screen while the host chooses to end the game or add another round. If the host continues, the existing `BetweenRoundsView` → `RoundSplashOverlay` transition plays normally before the extra round begins.

## Current State Analysis

- `shared/src/types.ts:54` — `status` union is `'lobby' | 'in_progress' | 'between_rounds' | 'finished'`
- `shared/src/types.ts:55` — `round?: 1 | 2 | 3` (literal union)
- `server/src/store/Game.ts:17` — mirrors the same `round?: 1 | 2 | 3` union on `GameSession`
- `server/src/store/Game.ts:146–165` — `advanceRound()`:
  - Line 149: hard cap throws `INVALID_STATE` when `round === 3`
  - Line 151: `this._hat!.refill()` — repopulates hat before the new round
  - Line 156: `(this.round === 1 ? 2 : 3)` ternary increments the round
  - Line 157: transitions directly to `'in_progress'`
- `server/src/store/Game.ts:289–291` — `_resolveRoundEndStatus(round: 1 | 2 | 3)`: returns `'finished'` when `round === 3`, otherwise `'between_rounds'`; called from `endTurn` (line 125) and `guessWord` (line 191)
- `server/src/routes/games.ts:349` — `POST /:joinCode/advance-round` route; delegates host check to the domain layer
- `client/src/pages/GamePage.tsx:12–16` — `roundRuleText(round: 1 | 2 | 3)` typed to the literal union
- `client/src/pages/GamePage.tsx:428–484` — `BetweenRoundsView` typed `round: 1 | 2 | 3`; line 436 has a `round === 3` safety guard that short-circuits to `<p>Game over!</p>`
- `client/src/pages/GamePage.tsx:486–512` — `RoundSplashOverlay` typed `round: 1 | 2 | 3`
- `client/src/pages/GamePage.tsx:59–72` — round-splash trigger fires on `'between_rounds' → 'in_progress'` status transition
- `scripts/test-driver.ts:231–234` — exits cleanly on `'finished'`; no changes needed

## Desired End State

After implementing this plan, the game loop extends naturally beyond round 3:

1. Hat empties at end of round 3 → server broadcasts `'awaiting_extra_round_decision'`
2. All players see: *"The host is choosing whether to end the game or play another round"*
3. Host additionally sees **End Game** and **Play another round** buttons
4. **End Game** → `POST /end-game` → status `'finished'` → existing results screen
5. **Play another round** → `POST /play-extra-round` → status `'between_rounds'` (round stays at 3)
6. `BetweenRoundsView` shows "Round 3 is over! Start Round 4" (host taps to advance)
7. "Start Round 4" → existing `advance-round` → round=4, hat refills, status `'in_progress'`, round-splash fires
8. Round 4 plays identically to any standard round; hat empties → `'awaiting_extra_round_decision'` again
9. Cycle repeats indefinitely

### Verification

- `pnpm test` passes (full suite including updated advance-round tests and new end-game / play-extra-round tests)
- `pnpm typecheck` (or equivalent) passes with no `1 | 2 | 3` literal type errors
- Manual play-through: complete a 3-round game, add extra rounds, verify stats accumulate correctly

## What We're NOT Doing

- No per-round rule text for extra rounds — `roundRuleText()` returns `''` for `round > 3` (house rules are set verbally)
- No changes to `scripts/test-driver.ts` — confirmed round-agnostic (exits on `'finished'`, drives turns from SSE events)
- No changes to stats accumulation — already cumulative across all rounds
- No changes to `BetweenRoundsView` wording — "Round X is over! Start Round X+1" is intentionally generic
- No round-type label or description for extra rounds in any UI

## Key Discoveries

- SSE broadcast is automatic: any `GameSession` field mutation followed by `notifyAndReturn` (InMemoryGameStore.ts:60) pushes the full snapshot to all clients — no extra wiring needed for the new status
- `_resolveRoundEndStatus` is the single chokepoint for the `'finished'` decision; both `endTurn` (line 125) and `guessWord` (line 191) call it
- `BetweenRoundsView`'s `round === 3` guard (line 436) must be removed — `'between_rounds'` with round=3 is now a valid state ("Round 3 over, start round 4")
- `advance-round` already refills the hat (line 151) — `play-extra-round` does NOT refill (the refill happens when the host clicks "Start Round N+1")
- `GameStore.ts` interface must be updated alongside `InMemoryGameStore` for any new store methods

## Implementation Approach

Work bottom-up: types first, then domain logic, then store/routes, then client. Each phase is independently type-safe and testable before moving to the next.

---

## Phase 1: Widen Shared Types

### Overview

Add `'awaiting_extra_round_decision'` to the status union and widen `round` from a literal union to `number`. This unlocks type-safety downstream.

### Changes Required

#### 1. `shared/src/types.ts`

**File**: `shared/src/types.ts`  
**Lines**: 54–55

```ts
// Before
status: 'lobby' | 'in_progress' | 'between_rounds' | 'finished'
round?: 1 | 2 | 3

// After
status: 'lobby' | 'in_progress' | 'between_rounds' | 'finished' | 'awaiting_extra_round_decision'
round?: number
```

### Success Criteria

#### Automated Verification

- [x] TypeScript compilation passes: `pnpm --filter shared build` (or equivalent typecheck)
- [x] No downstream type errors introduced yet (server and client will have errors until their phases complete)

---

## Phase 2: Server Domain Logic (Game.ts)

### Overview

Update `GameSession` to support extra rounds: remove the round-3 cap, fix the round-increment ternary, change `_resolveRoundEndStatus` to emit the new status, and add `endGame` and `playExtraRound` methods.

### Changes Required

#### 1. Widen `round` field on `GameSession`

**File**: `server/src/store/Game.ts`  
**Line**: 17

```ts
// Before
round?: 1 | 2 | 3

// After
round?: number
```

#### 2. Remove round-3 cap and fix round increment in `advanceRound`

**File**: `server/src/store/Game.ts`  
**Lines**: 149, 156

```ts
// Remove line 149 entirely:
if (this.round === 3) throw new AppError('INVALID_STATE', 'Cannot advance beyond round 3')

// Line 156 — replace ternary:
// Before:
this.round = (this.round === 1 ? 2 : 3) as 2 | 3
// After:
this.round = this.round + 1
```

#### 3. Update `_resolveRoundEndStatus`

**File**: `server/src/store/Game.ts`  
**Line**: 289

```ts
// Before
private _resolveRoundEndStatus(round: 1 | 2 | 3): GameSnapshot['status'] {
  return round === 3 ? 'finished' : 'between_rounds'
}

// After
private _resolveRoundEndStatus(round: number): GameSnapshot['status'] {
  return round >= 3 ? 'awaiting_extra_round_decision' : 'between_rounds'
}
```

#### 4. Add `endGame` method

**File**: `server/src/store/Game.ts`  
Add after `advanceRound`:

```ts
endGame(playerId: string): void {
  if (this.hostId !== playerId) throw new AppError('FORBIDDEN', 'Only the host can end the game')
  if (this.status !== 'awaiting_extra_round_decision') throw new AppError('INVALID_STATE', 'Game is not awaiting extra round decision')
  this.status = 'finished'
  logger.info('Game ended by host', { joinCode: this.joinCode })
}
```

#### 5. Add `playExtraRound` method

**File**: `server/src/store/Game.ts`  
Add after `endGame`:

```ts
playExtraRound(playerId: string): void {
  if (this.hostId !== playerId) throw new AppError('FORBIDDEN', 'Only the host can start an extra round')
  if (this.status !== 'awaiting_extra_round_decision') throw new AppError('INVALID_STATE', 'Game is not awaiting extra round decision')
  this.status = 'between_rounds'
  logger.info('Extra round initiated', { joinCode: this.joinCode, round: this.round })
}
```

Note: round is NOT incremented here and hat is NOT refilled — that happens when the host subsequently clicks "Start Round N+1" which calls the existing `advanceRound`.

### Success Criteria

#### Automated Verification

- [x] `pnpm test` passes (existing advance-round test for round 3 cap should now fail — update it in Phase 5)
- [x] TypeScript compiles without errors in `server/`

---

## Phase 3: Server Store Interface and Routes

### Overview

Wire the two new domain methods through the store interface, `InMemoryGameStore`, and two new route handlers.

### Changes Required

#### 1. Update `GameStore` interface

**File**: `server/src/store/GameStore.ts`  
Add alongside existing method signatures:

```ts
endGame(joinCode: string, playerId: string): Promise<GameSnapshot>
playExtraRound(joinCode: string, playerId: string): Promise<GameSnapshot>
```

#### 2. Add methods to `InMemoryGameStore`

**File**: `server/src/store/InMemoryGameStore.ts`  
Add alongside `advanceRound` at line 187:

```ts
async endGame(joinCode: string, playerId: string): Promise<GameSnapshot> {
  const game = this.requireGame(joinCode)
  game.endGame(playerId)
  this.touch(joinCode)
  return this.notifyAndReturn(joinCode, game)
}

async playExtraRound(joinCode: string, playerId: string): Promise<GameSnapshot> {
  const game = this.requireGame(joinCode)
  game.playExtraRound(playerId)
  this.touch(joinCode)
  return this.notifyAndReturn(joinCode, game)
}
```

#### 3. Add `POST /:joinCode/end-game` route

**File**: `server/src/routes/games.ts`  
Add after the `advance-round` handler (after line 371), following the same shape:

```ts
// POST /:joinCode/end-game — host ends game from awaiting_extra_round_decision
router.post('/:joinCode/end-game', async (req, res, next) => {
  const { joinCode } = req.params
  const { playerId } = req.body
  if (!playerId) return res.status(400).json({ error: 'playerId is required' })
  try {
    const game = await store.endGame(joinCode, playerId)
    res.json(game)
  } catch (err) {
    if (err instanceof AppError) {
      if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message })
      if (err.code === 'FORBIDDEN') return res.status(403).json({ error: err.message })
      if (err.code === 'INVALID_STATE') return res.status(409).json({ error: err.message })
    }
    next(err)
  }
})
```

#### 4. Add `POST /:joinCode/play-extra-round` route

**File**: `server/src/routes/games.ts`  
Add after `end-game` handler:

```ts
// POST /:joinCode/play-extra-round — host initiates extra round from awaiting_extra_round_decision
router.post('/:joinCode/play-extra-round', async (req, res, next) => {
  const { joinCode } = req.params
  const { playerId } = req.body
  if (!playerId) return res.status(400).json({ error: 'playerId is required' })
  try {
    const game = await store.playExtraRound(joinCode, playerId)
    res.json(game)
  } catch (err) {
    if (err instanceof AppError) {
      if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message })
      if (err.code === 'FORBIDDEN') return res.status(403).json({ error: err.message })
      if (err.code === 'INVALID_STATE') return res.status(409).json({ error: err.message })
    }
    next(err)
  }
})
```

### Success Criteria

#### Automated Verification

- [x] `pnpm test` passes for server (route-level tests pass; new tests added in Phase 5)
- [x] TypeScript compiles cleanly in `server/`

---

## Phase 4: Client Changes (GamePage.tsx)

### Overview

Add the `AwaitingExtraRoundDecisionView` rendering path and relax all `1 | 2 | 3` type constraints in the inline components.

### Changes Required

#### 1. Widen `roundRuleText` parameter type and add `round > 3` case

**File**: `client/src/pages/GamePage.tsx`  
**Line**: 12

```ts
// Before
function roundRuleText(round: 1 | 2 | 3): string {

// After
function roundRuleText(round: number): string {
```

Add at the top of the function (before the existing `if (round === 1)` check):

```ts
if (round > 3) return ''
```

#### 2. Add `AwaitingExtraRoundDecisionView` inline component

**File**: `client/src/pages/GamePage.tsx`  
Add alongside `BetweenRoundsView` (e.g. just before it):

```tsx
function AwaitingExtraRoundDecisionView({ isHost, joinCode, playerId }: {
  isHost: boolean; joinCode: string; playerId: string
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleEndGame() {
    setLoading(true)
    setError(null)
    const res = await fetch(`/api/games/${joinCode}/end-game`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError(body.error ?? 'Something went wrong')
    }
    setLoading(false)
  }

  async function handlePlayExtraRound() {
    setLoading(true)
    setError(null)
    const res = await fetch(`/api/games/${joinCode}/play-extra-round`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError(body.error ?? 'Something went wrong')
    }
    setLoading(false)
  }

  return (
    <div>
      <p>The host is choosing whether to end the game or play another round</p>
      {isHost && (
        <>
          {error && <p>{error}</p>}
          <button onClick={handleEndGame} disabled={loading}>End Game</button>
          <button onClick={handlePlayExtraRound} disabled={loading}>Play another round</button>
        </>
      )}
    </div>
  )
}
```

Note: styling should follow existing patterns in `BetweenRoundsView`.

#### 3. Add rendering path for `'awaiting_extra_round_decision'`

**File**: `client/src/pages/GamePage.tsx`  
Add an early-return block alongside the `'between_rounds'` block (around line 92):

```tsx
if (game.status === 'awaiting_extra_round_decision') {
  return (
    <AwaitingExtraRoundDecisionView
      isHost={isHost}
      joinCode={joinCode!}
      playerId={currentPlayerId!}
    />
  )
}
```

#### 4. Remove `round === 3` guard from `BetweenRoundsView` and widen prop type

**File**: `client/src/pages/GamePage.tsx`  
**Line 428**: Change `round: 1 | 2 | 3` to `round: number` in the props signature.

**Line 436**: Remove the early-return guard entirely:
```ts
// Remove this block:
if (round === 3) return <p>Game over!</p>
```

#### 5. Widen `RoundSplashOverlay` prop type

**File**: `client/src/pages/GamePage.tsx`  
**Line 486**: Change `round: 1 | 2 | 3` to `round: number` in the props signature.

### Success Criteria

#### Automated Verification

- [x] `pnpm test` passes (client tests if any)
- [x] TypeScript compiles cleanly in `client/`
- [x] `pnpm test` (full suite) passes

#### Manual Verification

- [ ] Play through all 3 standard rounds; after round 3 the decision screen appears
- [ ] Non-host sees only the informational text, no buttons
- [ ] "End Game" transitions to the existing results screen with cumulative stats
- [ ] "Play another round" shows `BetweenRoundsView` ("Round 3 is over! Start Round 4")
- [ ] Host taps "Start Round 4"; round splash fires showing "Round 4"
- [ ] Round 4 plays normally; hat empties → decision screen reappears
- [ ] A non-host calling `POST /end-game` or `POST /play-extra-round` receives 403

---

## Phase 5: Update and Add Tests

### Overview

Update the existing test that asserts round 3 cannot be advanced past, and add tests for the two new endpoints.

### Changes Required

#### 1. Update `advance-round` test for round 3

**File**: `server/src/routes/games.test.ts`  
**Around line 862**: The test that asserts a 409 when advancing past round 3 should be removed or updated to assert that advancing from `'between_rounds'` at round 3 is now valid (returns 200).

#### 2. Add tests for `POST /:joinCode/end-game`

**File**: `server/src/routes/games.test.ts`  
Add a `describe('POST /api/games/:joinCode/end-game', ...)` block covering:

- Returns 400 when `playerId` is missing from body
- Returns 404 when `joinCode` does not exist
- Returns 403 when caller is not the host
- Returns 409 when game status is not `'awaiting_extra_round_decision'`
- Returns 200 and game transitions to `'finished'` when host calls from correct state

#### 3. Add tests for `POST /:joinCode/play-extra-round`

**File**: `server/src/routes/games.test.ts`  
Add a `describe('POST /api/games/:joinCode/play-extra-round', ...)` block covering:

- Returns 400 when `playerId` is missing
- Returns 404 when `joinCode` does not exist
- Returns 403 when caller is not the host
- Returns 409 when game status is not `'awaiting_extra_round_decision'`
- Returns 200 and game transitions to `'between_rounds'` (round unchanged) when host calls from correct state

#### 4. Add integration test for full extra-round cycle (optional but recommended)

Verify: round 3 ends → `'awaiting_extra_round_decision'` → `play-extra-round` → `'between_rounds'` → `advance-round` → `'in_progress'` (round 4) → hat empties → `'awaiting_extra_round_decision'` again.

### Success Criteria

#### Automated Verification

- [x] `pnpm test` passes across all packages with no skipped tests
- [x] All new test cases pass
- [x] Updated advance-round test reflects the removal of the round-3 cap

---

## Testing Strategy

### Manual Testing Steps

1. Start a local game with at least two players across two teams
2. Complete rounds 1–3 in full (guess all words each round)
3. Verify decision screen appears after round 3 on all devices
4. Verify non-host sees no buttons
5. Test "End Game" path → confirm results screen with all stats
6. Restart and test "Play another round" path:
   - Confirm `BetweenRoundsView` shows ("Round 3 is over! Start Round 4")
   - Confirm round splash fires ("Round 4")
   - Play round 4 fully → confirm decision screen reappears
   - Test end game from round 4+ → confirm stats accumulate all rounds

## References

- Work item: `meta/work/ENG-028-host-can-extend-game-with-unlimited-custom-extra-rounds.md`
- SSE/status event pattern: `meta/plans/2026-05-17-ENG-022-server-synchronised-countdown-timer.md`
- `advance-round` route: `server/src/routes/games.ts:349`
- `_resolveRoundEndStatus`: `server/src/store/Game.ts:289`
- `BetweenRoundsView` round 3 guard: `client/src/pages/GamePage.tsx:436`
