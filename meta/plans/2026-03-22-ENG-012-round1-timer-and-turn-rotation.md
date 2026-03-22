# ENG-012: Round 1 — Turn Timer and Turn Rotation Implementation Plan

## Overview

Add a 60-second per-turn timer and explicit turn rotation: when a turn ends (timer expires), the current word stays in the hat, active team flips, the next clue giver on the new team is set, and all devices show an appropriate between-turns UI until the new clue giver presses "Ready".

## Current State Analysis

- `Game` type (`shared/src/types.ts:17`) has `turnPhase`, `activeTeam`, `currentClueGiverId`, `currentWord` — but no `turnStartedAt`.
- `readyTurn` (`InMemoryGameStore.ts:134`) sets `turnPhase: 'active'` and draws `currentWord` from the hat **without removing it** — the current word remains in the hat throughout the turn; only `guessWord` removes words.
- `currentClueGiverId` is set once in `startGame` (`InMemoryGameStore.ts:85`) and **never rotated**. `activeTeam` is similarly never rotated.
- There is **no `endTurn` store method or route**. The only way a turn ends today is when the hat empties via `guessWord`.
- `skippedThisTurn` is in `InternalGame` only (stripped by `toPublicGame`).
- `toPublicGame` (`routes/games.ts:7`) strips `hat`, `skippedThisTurn`, `currentWordId` using destructuring. Any new internal-only fields must be added to this stripping.
- Route tests use `mockStore` factory + `buildApp(store)` pattern (`games.test.ts`). Store unit tests use setup helpers (`InMemoryGameStore.test.ts`).

## Desired End State

- During an active turn, the clue giver's screen shows a 60-second countdown timer.
- When the timer hits 0, the client automatically calls `POST /end-turn`, ending the turn.
- After `endTurn`: active team flips, `currentClueGiverId` advances to the next player on the new team (cycling by join order), `turnPhase` resets to `'ready'`.
- The new clue giver's device shows "It's your turn — press Ready to start" with a Ready button.
- All other devices show "Waiting for [name] to start their turn...".
- If the hat is empty when `endTurn` is called, `status` transitions to `'round_over'` and the score summary is shown (already implemented via `guessWord`'s path; we mirror it in `endTurn`).

## Turn Duration Constant

The turn duration **must be defined as a single named constant** — not inlined as a magic number. The value is 60 seconds today but will be reduced during testing. Any duplication would require hunting down multiple sites to change it.

Define it in the shared package so both client (countdown display) and any future server-side enforcement can reference the same value:

**File:** `shared/src/types.ts` (or a dedicated `shared/src/constants.ts`)

```typescript
export const TURN_DURATION_SECONDS = 60
```

Import and use `TURN_DURATION_SECONDS` everywhere the duration appears:
- The client timer `useEffect` (`60 - elapsed` → `TURN_DURATION_SECONDS - elapsed`)
- The timer display label
- Any future server-side enforcement

## What We're NOT Doing

- Manual "End Turn" button for the clue giver (turn only ends via timer).
- Server-side timer enforcement (the server trusts the client to call `/end-turn`; enforcement can be added in a future ticket).
- Multi-round support beyond `round_over` detection.
- Persisting game state to a database.

---

## Phase 1: Shared Type + Store — `endTurn` method and `turnStartedAt`

### Overview

Add `turnStartedAt` to the shared `Game` type, wire it into `readyTurn`, add per-team clue giver index tracking to `InternalGame`, and implement the `endTurn` store method.

### Tests First

In `InMemoryGameStore.test.ts`, add failing tests for `endTurn` before implementing:

- `endTurn` with a non-clue-giver throws `FORBIDDEN`
- `endTurn` when `turnPhase !== 'active'` throws `TURN_NOT_ACTIVE`
- `endTurn` success: rotates `activeTeam`, advances `currentClueGiverId` to next player on new team, sets `turnPhase: 'ready'`, clears `currentWord`/`turnStartedAt`, hat word count unchanged
- `endTurn` when hat is empty: transitions to `'round_over'` (edge case — hat always contains current word, but guard defensively)
- `readyTurn` success: `turnStartedAt` is set to a non-null ISO string

### Changes Required

#### 1. Shared type — `turnStartedAt`

**File:** `shared/src/types.ts`

Add to the `Game` type:

```typescript
turnStartedAt?: string   // ISO timestamp set when turnPhase transitions to 'active'
```

#### 2. Store interface — `endTurn`

**File:** `server/src/store/GameStore.ts`

```typescript
endTurn(joinCode: string, playerId: string): Promise<Game>
```

#### 3. `InternalGame` — clue giver index tracking

**File:** `server/src/store/InMemoryGameStore.ts`

Extend `InternalGame`:

```typescript
type InternalGame = Game & {
  hat: Word[]
  skippedThisTurn: string[]
  currentWordId?: string
  clueGiverIndices: { 1: number; 2: number }   // next index to use per team
}
```

Update `createGame` to initialise `clueGiverIndices: { 1: 0, 2: 0 }`.

#### 4. `startGame` — initialise indices and set first clue giver via index

**File:** `server/src/store/InMemoryGameStore.ts`

After choosing `activeTeam` and the first clue giver, record that team's index has been consumed:

```typescript
const activeTeamPlayers = game.players.filter((p) => p.team === activeTeam)
const firstClueGiver = activeTeamPlayers[0]
if (!firstClueGiver) throw new AppError('INVALID_STATE', 'No players on the active team')

Object.assign(game, {
  ...existingFields,
  clueGiverIndices: {
    1: activeTeam === 1 ? 1 % Math.max(activeTeamPlayers.length, 1) : 0,
    2: activeTeam === 2 ? 1 % Math.max(activeTeamPlayers.length, 1) : 0,
  },
})
```

This means index for the starting team advances to 1 (wrapping if team has only 1 player), so on their second turn they advance correctly. The other team starts at 0.

#### 5. `readyTurn` — set `turnStartedAt`

**File:** `server/src/store/InMemoryGameStore.ts`

In the `Object.assign` block inside `readyTurn`:

```typescript
Object.assign(game, {
  turnPhase: 'active',
  currentWord: firstWord.text,
  currentWordId: firstWord.id,
  skippedThisTurn: [],
  guessedThisTurn: [],
  turnStartedAt: new Date().toISOString(),
})
```

#### 6. `endTurn` store method

**File:** `server/src/store/InMemoryGameStore.ts`

```typescript
async endTurn(joinCode: string, playerId: string): Promise<Game> {
  const game = this.assertClueGiverTurn(joinCode, playerId)
  if (game.turnPhase !== 'active') throw new AppError('TURN_NOT_ACTIVE', 'Turn is not active')

  // Current word stays in hat (never removed during active turn); just clear active state
  // Defensive check: if somehow hat is empty, end the round
  if (game.hat.length === 0) {
    Object.assign(game, {
      status: 'round_over',
      currentWord: undefined,
      currentWordId: undefined,
      turnPhase: undefined,
      turnStartedAt: undefined,
    })
    const snapshot = { ...game, players: [...game.players] }
    this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))
    return snapshot
  }

  // Rotate team
  const newTeam: 1 | 2 = game.activeTeam === 1 ? 2 : 1
  const newTeamPlayers = game.players.filter((p) => p.team === newTeam)
  if (!newTeamPlayers.length) throw new AppError('INVALID_STATE', 'No players on the next team')

  const nextIndex = game.clueGiverIndices[newTeam]
  const nextClueGiver = newTeamPlayers[nextIndex % newTeamPlayers.length]

  // Advance the index for the new team (consumed when they press Ready)
  game.clueGiverIndices[newTeam] = (nextIndex + 1) % newTeamPlayers.length

  Object.assign(game, {
    activeTeam: newTeam,
    currentClueGiverId: nextClueGiver.id,
    turnPhase: 'ready',
    currentWord: undefined,
    currentWordId: undefined,
    skippedThisTurn: [],
    guessedThisTurn: [],
    turnStartedAt: undefined,
  })

  logger.info('Turn ended', { joinCode, newActiveTeam: newTeam, nextClueGiver: nextClueGiver.name })

  const snapshot = { ...game, players: [...game.players] }
  this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))
  return snapshot
}
```

### Success Criteria

#### Automated Verification

- [ ] Store unit tests pass (including new `endTurn` tests): `cd server && npm test`
- [ ] TypeScript compiles: `cd server && npm run build` and `cd shared && npm run build`

#### Manual Verification

- [ ] `endTurn` unit tests cover: rotation, index cycling, FORBIDDEN, TURN_NOT_ACTIVE, round_over edge case

---

## Phase 2: Route — `POST /:joinCode/end-turn`

### Overview

Add the HTTP route, update `toPublicGame` to strip the new internal field, and add route-level tests.

### Tests First

In `games.test.ts`, add failing tests for `POST /:joinCode/end-turn`:

- 400 when `playerId` is missing/invalid
- 404 when store throws `NOT_FOUND`
- 403 when store throws `FORBIDDEN`
- 422 when store throws `TURN_NOT_ACTIVE`
- 422 when store throws `TURN_NOT_ALLOWED`
- 200 with public game snapshot on success

### Changes Required

#### 1. Update `toPublicGame`

**File:** `server/src/routes/games.ts`

Add `clueGiverIndices` to the stripping:

```typescript
function toPublicGame(game: Game & { hat?: unknown; skippedThisTurn?: unknown; currentWordId?: unknown; clueGiverIndices?: unknown }) {
  const { hat: _hat, skippedThisTurn: _skipped, currentWordId: _id, clueGiverIndices: _idx, ...publicGame } = game
  return publicGame
}
```

#### 2. Add the route

**File:** `server/src/routes/games.ts`

```typescript
// POST /:joinCode/end-turn — timer expired, rotate to next team's clue giver
router.post('/:joinCode/end-turn', async (req, res, next) => {
  try {
    const joinCode = req.params.joinCode.toUpperCase()
    const { playerId } = req.body ?? {}
    if (typeof playerId !== 'string' || !playerId) {
      return res.status(400).json({ error: 'playerId is required' })
    }
    const updated = await store.endTurn(joinCode, playerId)
    return res.json(toPublicGame(updated))
  } catch (err: unknown) {
    if (err instanceof AppError && err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message })
    if (err instanceof AppError && err.code === 'FORBIDDEN') return res.status(403).json({ error: err.message })
    if (err instanceof AppError && err.code === 'TURN_NOT_ACTIVE') return res.status(422).json({ error: err.message })
    if (err instanceof AppError && err.code === 'TURN_NOT_ALLOWED') return res.status(422).json({ error: err.message })
    return next(err)
  }
})
```

### Success Criteria

#### Automated Verification

- [ ] All route tests pass: `cd server && npm test`
- [ ] TypeScript compiles cleanly

---

## Phase 3: Client — Timer + Between-Turns UI

### Overview

Add a countdown timer to `ClueGiverView` that auto-calls `/end-turn` at 0, and update the between-turns "ready" state views for all roles.

### Changes Required

#### 1. Timer in `ClueGiverView`

**File:** `client/src/pages/GamePage.tsx`

Add a `useEffect`-driven countdown when `turnPhase === 'active'` and `turnStartedAt` is set. Derive remaining seconds from wall-clock diff, refresh every second via `setInterval`, call `/end-turn` (fire-and-forget) when it hits 0.

Key points:
- Derive `secondsLeft = Math.max(0, 60 - Math.floor((Date.now() - Date.parse(game.turnStartedAt)) / 1000))`
- Display the countdown in the active-turn view
- At 0, call `/end-turn` once (use a ref flag to avoid duplicate calls if the interval fires multiple times)

```tsx
import { TURN_DURATION_SECONDS } from '@wordfetti/shared'

// Inside ClueGiverView, before the return:
const timerFiredRef = useRef(false)

useEffect(() => {
  if (game.turnPhase !== 'active' || !game.turnStartedAt) return
  timerFiredRef.current = false

  const interval = setInterval(async () => {
    const elapsed = Math.floor((Date.now() - Date.parse(game.turnStartedAt!)) / 1000)
    if (elapsed >= TURN_DURATION_SECONDS && !timerFiredRef.current) {
      timerFiredRef.current = true
      clearInterval(interval)
      await fetch(`/api/games/${joinCode}/end-turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId }),
      })
    }
  }, 500)  // poll at 500ms for snappier 0-crossing detection

  return () => clearInterval(interval)
}, [game.turnPhase, game.turnStartedAt, joinCode, playerId])
```

Add a computed `secondsLeft` to render in the active-turn view:

```tsx
const secondsLeft = game.turnStartedAt
  ? Math.max(0, TURN_DURATION_SECONDS - Math.floor((Date.now() - Date.parse(game.turnStartedAt)) / 1000))
  : TURN_DURATION_SECONDS
```

Display it above the word (e.g., `<p className="text-sm text-gray-500">{secondsLeft}s</p>`).

Note: `secondsLeft` derived at render time will be stale between renders. Drive re-renders from the interval's state update. Add `const [, setTick] = useState(0)` and call `setTick((t) => t + 1)` inside the interval callback to force re-renders each tick.

#### 2. Between-turns "ready" views

**File:** `client/src/pages/GamePage.tsx`

The `ClueGiverView` already shows "Start Turn" + Ready button when `turnPhase === 'ready'`. The label should change to reflect it's a subsequent turn (not first turn) — but since the clue giver changes on rotation, the new clue giver will see this view fresh, so the existing "You are describing!" + "Start Turn" copy is acceptable. No change needed here.

For non-clue-givers, `GuesserView` and `SpectatorView` currently show no between-turns state — they display the active-turn UI regardless of `turnPhase`. We need to add a waiting message when `turnPhase === 'ready'`.

In `GamePage` (after `clueGiver` is resolved):

```tsx
// Replace the isGuesser and spectator rendering with turnPhase-aware views:
{isClueGiver && (
  <ClueGiverView game={game} joinCode={joinCode!} playerId={currentPlayerId!} />
)}
{!isClueGiver && game.turnPhase === 'ready' && (
  <WaitingView clueGiverName={clueGiver.name} />
)}
{!isClueGiver && game.turnPhase === 'active' && isGuesser && (
  <GuesserView clueGiverName={clueGiver.name} />
)}
{!isClueGiver && game.turnPhase === 'active' && !isGuesser && (
  <SpectatorView clueGiverName={clueGiver.name} team={clueGiver.team} game={game} />
)}
```

Add `WaitingView`:

```tsx
function WaitingView({ clueGiverName }: { clueGiverName: string }) {
  return (
    <div className="mt-8 text-center">
      <p className="text-xl font-semibold text-gray-900">
        Waiting for <span className="text-brand-coral">{clueGiverName}</span> to start their turn...
      </p>
    </div>
  )
}
```

### Success Criteria

#### Automated Verification

- [ ] Client builds with no TypeScript errors: `cd client && npm run build`
- [ ] Linting passes: `cd client && npm run lint`

#### Manual Verification

- [ ] During an active turn, clue giver's screen shows a counting-down timer (60→0)
- [ ] When timer hits 0, turn ends automatically; clue giver's screen transitions to "You are describing! / Start Turn"
- [ ] Other players see "Waiting for [name] to start their turn..." during `turnPhase === 'ready'`
- [ ] New clue giver presses "Start Turn" → `turnPhase` transitions to `'active'`, 60-second timer restarts on their screen
- [ ] Clue giver index cycles correctly through team members across multiple turns
- [ ] Active team alternates each turn
- [ ] Play continues until hat empties at a turn boundary → `status: 'round_over'` → score summary shown

---

## Testing Strategy

### Unit Tests (store layer)

- `endTurn` success with 2 players per team: verify `activeTeam`, `currentClueGiverId`, `turnPhase: 'ready'`, `turnStartedAt: undefined`
- `endTurn` index cycling: verify 3rd call on same team picks 3rd player, then wraps
- `readyTurn` success: verify `turnStartedAt` is a valid ISO string
- `endTurn` FORBIDDEN (non-clue-giver caller)
- `endTurn` TURN_NOT_ACTIVE (not in active phase)

### Route Tests

- 400/403/404/422 error mapping for `POST /end-turn`
- 200 success with stripped public game (no `clueGiverIndices` in response)

### Manual Testing Steps

1. Create a game, add 2 players per team with 5 words each, start game
2. Confirm first clue giver sees timer + word; others see waiting or guessing view
3. Let timer expire (or wait near 0) — confirm turn transitions automatically
4. Confirm the other team's first player is now the clue giver
5. Press Ready — confirm new 60s timer starts
6. Continue for 4+ turns, confirm clue giver index advances and wraps correctly

## References

- Original ticket: `meta/tickets/ENG-012-round1-timer-and-turn-rotation.md`
- ENG-011 plan: `meta/plans/2026-03-22-ENG-011-round1-guess-skip-round-end.md`
- Game type: `shared/src/types.ts:17`
- Store: `server/src/store/InMemoryGameStore.ts`
- Route: `server/src/routes/games.ts`
- Client game view: `client/src/pages/GamePage.tsx`
