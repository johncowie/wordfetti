# ENG-013: Round 1→2 Transition — Implementation Plan

## Overview

Extend the game state machine to support round transitions: when round 1's hat empties, move to `between_rounds` instead of `round_over`; add a host-only `advance-round` route that refills the hat, increments the round, and resumes play. Add client UI for the between-rounds screen, a round-start splash, and round-specific banners on the clue giver view.

## Current State Analysis

- `Game.status`: `'lobby' | 'in_progress' | 'round_over' | 'finished'` — no `between_rounds`
- `Game` has no `round` field and no mechanism for hat refill
- `InternalGame` holds internal server fields (`hat`, `clueGiverIndices`, etc.) stripped by `toPublicGame` before responding
- `guessWord` and `endTurn` (defensive guard) both unconditionally set `status: 'round_over'` when hat empties
- `GameStore` interface has no `advanceRound` method
- `GamePage.tsx:54` branches on `status === 'round_over'` to show `RoundOverView` — this will be replaced by `BetweenRoundsView`
- No `round` field exists anywhere; no round-specific banner logic exists

## Desired End State

After this ticket:
- `Game.status` includes `'between_rounds'`; `Game.round` is `1 | 2` (extended to 3 in ENG-014)
- When hat empties at end of round 1, state transitions to `status: 'between_rounds'`
- Host can call `POST /advance-round` to refill hat and start round 2
- All clients see between-rounds screen (host gets "Start Round 2" button; others wait)
- All clients see a 2-3 second round-start splash when round 2 begins
- Clue giver sees a persistent banner with the round's rule throughout their turn

### Key Discoveries

- `originalWords` should live in `InternalGame` (server-only), not shared `Game` type — clients have no use for it and the existing pattern keeps internal fields server-side. `toPublicGame` will strip it.
- `round` must be in the shared `Game` type — the client needs it for banner display and splash content.
- `round_over` stays in the status union for now — ENG-014 will clean up unused status values once all rounds are covered. The `RoundOverView` component in `GamePage.tsx` becomes dead code after this ticket but that's acceptable.
- `toPublicGame` in `games.ts:9` must be updated to strip `originalWords` from responses.
- The round-start splash requires tracking previous `status` on the client via a `useRef` to detect the `between_rounds` → `in_progress` transition.
- `guessWord` and the defensive guard in `endTurn` both need to be updated to emit `between_rounds` when `round === 1`.

## What We're NOT Doing

- Round 3 (ENG-014)
- `status: 'finished'` (ENG-014)
- Removing `round_over` from the status union (ENG-014 will clean this up)
- Per-round scoreboard (Epic 5)
- Blocking non-host clients from calling `advance-round` at the UI level (the server rejects it; no UI guard needed)

---

## Implementation Approach

Test-first. Write failing tests for each server-side change, then implement. Client rendering logic is verified manually, with one exception: `roundRuleText(round)` is a pure business-rule function (not rendering) and should be covered by two simple unit test assertions alongside the server tests.

Phases are ordered so each step compiles and tests pass before moving on.

---

## Phase 1: Shared Types

### Changes Required

**File**: `shared/src/types.ts`

Add `round` to `Game` and extend the `status` union:

```typescript
export type Game = {
  id: string
  joinCode: string
  status: 'lobby' | 'in_progress' | 'round_over' | 'between_rounds' | 'finished'
  round?: 1 | 2   // undefined before game starts; 1 after startGame; extended to 3 in ENG-014
  players: Player[]
  // ... rest unchanged
}
```

`round` is optional to avoid a breaking change on the lobby state (before `startGame` is called).

### Success Criteria

#### Automated Verification

- [x] TypeScript compiles: `npm run build` (or equivalent in workspace)

---

## Phase 2: Store — advanceRound + round-aware transitions

### Overview

Three changes to `InMemoryGameStore`:
1. `InternalGame`: add `originalWords: Word[]`
2. `startGame`: populate `originalWords`, set `round: 1`
3. `guessWord` and `endTurn` defensive guard: emit `between_rounds` when `round === 1` hat empties
4. New `advanceRound` method

### Changes Required

**File**: `server/src/store/InMemoryGameStore.ts`

#### 2a. Extend `InternalGame`

```typescript
export type InternalGame = Game & {
  hat: Word[]
  originalWords: Word[]          // full word list set at startGame; used to refill hat each round
  skippedThisTurn: string[]
  currentWordId?: string
  clueGiverIndices: Record<Team, number>
}
```

#### 2b. `startGame` — set `round` and `originalWords`; extract shuffle helper

First, extract the existing inline Fisher-Yates shuffle in `startGame` (lines 84–87) into a private module-level helper. This same helper will be called from `advanceRound` (section 2e) — one implementation, no duplication:

```typescript
function shuffle<T>(arr: T[]): T[] {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}
```

Then in the `Object.assign(game, { ... })` block (line 95):

```typescript
const shuffledWords = shuffle(allWords)
Object.assign(game, {
  status: 'in_progress',
  round: 1,
  hat: shuffledWords,
  originalWords: [...allWords],   // snapshot of the full word list (unshuffled) for hat refill each round
  activeTeam,
  currentClueGiverId: firstClueGiver.id,
  turnPhase: 'ready',
  scores: { team1: 0, team2: 0 },
  skippedThisTurn: [],
  clueGiverIndices: { ... },     // unchanged
})
```

Note: `originalWords` is stored pre-shuffle so each round's hat gets an independently fresh shuffle via `shuffle(game.originalWords)` in `advanceRound`.

#### 2c. `guessWord` — round-aware transition on hat empty

Replace the unconditional `status: 'round_over'` at line 253 with:

```typescript
if (game.hat.length === 0) {
  // TODO(ENG-014): When round 3 is added, update this ternary so round 2 also emits 'between_rounds'.
  // Consider extracting resolveRoundEndStatus(round) to avoid updating two call sites.
  const newStatus = game.round === 1 ? 'between_rounds' : 'round_over'
  Object.assign(game, {
    status: newStatus,
    currentWord: undefined,
    currentWordId: undefined,
    currentClueGiverId: undefined,
    turnPhase: undefined,
    turnStartedAt: undefined,
  })
}
```

#### 2d. `endTurn` defensive guard — same round-aware logic

Replace line 186 `status: 'round_over'` with:

```typescript
// TODO(ENG-014): Same as guessWord — update when round 3 is added.
const newStatus = game.round === 1 ? 'between_rounds' : 'round_over'
Object.assign(game, {
  status: newStatus,
  // ... rest unchanged
})
```

#### 2e. New `advanceRound` method

Key correctness point: `guessWord` sets `currentClueGiverId: undefined` when the hat empties (that's what triggers `between_rounds`). `advanceRound` must restore it by deriving the next clue giver from the preserved `activeTeam` + `clueGiverIndices`, mirroring the pattern in `endTurn` (lines 202–212 of `InMemoryGameStore.ts`). Without this, every `readyTurn` call in round 2 throws `FORBIDDEN` and the game is permanently stuck.

```typescript
async advanceRound(joinCode: string, playerId: string): Promise<Game> {
  const game = this.games.get(joinCode)
  if (!game) throw new AppError('NOT_FOUND', 'Game not found')
  if (game.hostId !== playerId) throw new AppError('FORBIDDEN', 'Only the host can advance the round')
  if (game.status !== 'between_rounds') throw new AppError('INVALID_STATE', 'Game is not between rounds')

  // Use the shared shuffle helper (section 2b) — no inline duplication
  const shuffledHat = shuffle(game.originalWords)

  // Restore currentClueGiverId from preserved indices — guessWord cleared it when the hat emptied.
  // clueGiverIndices and activeTeam are preserved so rotation continues from where round 1 left off.
  const teamPlayers = game.players.filter((p) => p.team === game.activeTeam)
  const nextClueGiver = teamPlayers[game.clueGiverIndices[game.activeTeam!] % teamPlayers.length]

  Object.assign(game, {
    round: 2,
    status: 'in_progress',
    hat: shuffledHat,
    turnPhase: 'ready',
    currentClueGiverId: nextClueGiver.id,
    currentWord: undefined,
    currentWordId: undefined,
    turnStartedAt: undefined,
    guessedThisTurn: [],     // clear stale data from round 1's last turn
    skippedThisTurn: [],
  })
  // clueGiverIndices and activeTeam are unchanged — rotation picks up where round 1 left off

  logger.info('Round advanced', { joinCode, round: game.round })

  const snapshot = { ...game, players: [...game.players] }
  this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))
  return snapshot
}
```

**File**: `server/src/store/GameStore.ts`

Add to interface:

```typescript
advanceRound(joinCode: string, playerId: string): Promise<Game>
```

### Tests — `InMemoryGameStore.test.ts`

Write these tests **before** implementing `advanceRound`. They should fail first.

**First**: update the existing hat-empty tests (before writing `advanceRound` tests). Each needs two variants — the existing `round: 1` case changes, and a new `round: 2` case keeps the old assertion:

```typescript
// In describe('guessWord'):
it('transitions to between_rounds when hat empties and round is 1', ...)  // was: 'sets status to round_over'
it('transitions to round_over when hat empties and round is 2', ...)      // new — exercise the else branch

// In describe('endTurn') defensive guard:
it('transitions to between_rounds when hat is empty (defensive guard) and round is 1', ...)
it('transitions to round_over when hat is empty (defensive guard) and round is 2', ...)
```

To set `round: 2` for these tests, directly mutate `internalGame.round = 2` on the internal game object after setup.

Also add `'sets round to 1'` to the existing `describe('startGame')` block:
```typescript
it('sets round to 1', async () => {
  const game = await store.startGame(joinCode)
  expect(game.round).toBe(1)
})
```

Then add a `describe('advanceRound', ...)` block after the `endTurn` describe:

```typescript
describe('advanceRound', () => {
  it('throws NOT_FOUND when game does not exist', ...)
  it('throws FORBIDDEN when caller is not the host', ...)
  it('throws INVALID_STATE when status is not between_rounds', ...)
  it('throws INVALID_STATE when round is already 2 (no round 3 in ENG-013)', ...)
  // ^ documents the boundary; ENG-014 will change this to succeed and advance to round 3
  it('sets round to 2 and status to in_progress', ...)
  it('refills the hat with the original word count', ...)
  it('hat words after refill are shuffled (order differs from originalWords)', ...)  // probabilistic; skip if too flaky
  it('restores currentClueGiverId from preserved activeTeam + clueGiverIndices', ...)
  it('preserves clueGiverIndices and activeTeam from round 1', ...)
  it('clears guessedThisTurn and skippedThisTurn', ...)
  it('sets turnPhase to ready', ...)
  it('preserves scores from round 1', ...)  // accumulate non-zero scores, call advanceRound, assert unchanged
  it('broadcasts updated game to subscribers with round 2 and status in_progress', ...)
  // ^ assert updates[0].round === 2 && updates[0].status === 'in_progress'
})
```

### Success Criteria

#### Automated Verification

- [x] New `advanceRound` tests pass: `npm run test -w server`
- [x] Updated `guessWord` and `endTurn` tests pass
- [x] TypeScript compiles

---

## Phase 3: Route — POST /advance-round

### Changes Required

**File**: `server/src/routes/games.ts`

#### 3a. Strip `originalWords` in `toPublicGame`

```typescript
function toPublicGame(game: Game & {
  hat?: unknown; skippedThisTurn?: unknown; currentWordId?: unknown;
  clueGiverIndices?: unknown; originalWords?: unknown
}) {
  const { hat: _hat, skippedThisTurn: _s, currentWordId: _id,
          clueGiverIndices: _ci, originalWords: _ow, ...publicGame } = game
  return publicGame
}
```

#### 3b. Add route (before the players route at line 311)

```typescript
// POST /:joinCode/advance-round — host advances from between_rounds to next round
router.post('/:joinCode/advance-round', async (req, res, next) => {
  try {
    const joinCode = req.params.joinCode.toUpperCase()
    const { playerId } = req.body ?? {}
    if (typeof playerId !== 'string' || !playerId) {
      return res.status(400).json({ error: 'playerId is required' })
    }
    const updated = await store.advanceRound(joinCode, playerId)
    return res.json(toPublicGame(updated))
  } catch (err: unknown) {
    if (err instanceof AppError && err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message })
    if (err instanceof AppError && err.code === 'FORBIDDEN') {
      logger.warn('Forbidden action attempted', { route: 'advance-round', joinCode: req.params.joinCode.toUpperCase(), error: err.message })
      return res.status(403).json({ error: err.message })
    }
    if (err instanceof AppError && err.code === 'INVALID_STATE') {
      // 409 Conflict: game exists but is in the wrong state for this operation (client timing error, not server fault)
      return res.status(409).json({ error: err.message })
    }
    logger.error('Unexpected error in route', { route: 'advance-round', error: err instanceof Error ? err.message : String(err) })
    next(err)
  }
})
```

### Tests — `games.test.ts`

Add `advanceRound` to `mockStore` default. **Include `originalWords` in the mock return value** so the strip test is meaningful rather than vacuous (following the exact `clueGiverIndices` strip test pattern at `games.test.ts:635`):

```typescript
advanceRound: async () => ({
  id: 'test-id', joinCode: 'ABC123', status: 'in_progress' as const, round: 2,
  players: [], turnPhase: 'ready' as const,
  originalWords: [{ id: 'w1', text: 'apple', playerId: 'p1' }],  // must be stripped by toPublicGame
} as any),
```

Add `describe('POST /api/games/:joinCode/advance-round', ...)`:

```typescript
it('returns 200 with updated game in_progress round 2', ...)
it('response body does not contain originalWords', ...)  // assert !('originalWords' in res.body)
it('returns 400 when playerId is missing', ...)
it('returns 404 when store throws NOT_FOUND', ...)
it('returns 403 when store throws FORBIDDEN', ...)
it('returns 409 when store throws INVALID_STATE', ...)  // 409 Conflict, not 500
```

### Success Criteria

#### Automated Verification

- [x] Route tests pass: `npm run test -w server`
- [x] All existing tests still pass (no regressions)
- [x] TypeScript compiles

---

## Phase 4: Client UI

### Overview

Three UI additions, all in `GamePage.tsx`:

1. **`BetweenRoundsView`** — shown when `status === 'between_rounds'`
2. **Round-start splash** — shown for 2-3 seconds when transitioning `between_rounds` → `in_progress`
3. **Round banner** — persistent banner on the clue giver view showing the round's rule

### Changes Required

**File**: `client/src/pages/GamePage.tsx`

#### 4a. Round banner helper

```typescript
function roundRuleText(round: 1 | 2): string {
  if (round === 1) return 'Describe using anything — charades style!'
  return 'One word only!'
}
```

#### 4b. Round-start splash state + detection

In `GamePage` component, add a ref to track previous status and a piece of state for splash visibility:

```typescript
const prevStatusRef = useRef<string | undefined>(undefined)
const [showRoundSplash, setShowRoundSplash] = useState(false)

useEffect(() => {
  if (prevStatusRef.current === 'between_rounds' && game?.status === 'in_progress') {
    setShowRoundSplash(true)
    const timer = setTimeout(() => setShowRoundSplash(false), 2500)
    // Update ref here too — must always reflect the latest status so future transitions are detected correctly.
    // Without this, ref stays 'between_rounds' and could re-trigger the splash on any subsequent status change.
    prevStatusRef.current = game.status
    return () => clearTimeout(timer)
  }
  // Always update the ref, even when no transition fires, so it's ready for the next check.
  // Guard against undefined (null game on SSE reconnect) to avoid losing the previous known status.
  if (game?.status !== undefined) prevStatusRef.current = game.status
}, [game?.status])
```

Render the splash as an overlay (full-screen, tap to dismiss) before the normal game view:

```tsx
{showRoundSplash && game.round && (
  <RoundSplashOverlay round={game.round} onDismiss={() => setShowRoundSplash(false)} />
)}
```

#### 4c. `BetweenRoundsView` branch

Replace the existing `if (game.status === 'round_over')` block (line 54) — add `between_rounds` handling before it. The `round_over` branch stays (dead code; harmless):

```tsx
if (game.status === 'between_rounds') {
  const isHost = currentPlayerId === game.hostId
  return (
    <div className="flex min-h-screen flex-col items-center bg-brand-cream px-4 py-8">
      <div className="w-full max-w-lg">
        <Logo />
        <BetweenRoundsView
          round={game.round ?? 1}
          isHost={isHost}
          joinCode={joinCode!}
          playerId={currentPlayerId!}
        />
      </div>
    </div>
  )
}
```

#### 4d. Round banner in `ClueGiverView`

In the active turn render (after the word display), add:

```tsx
{game.round && (
  <p className="text-sm font-medium text-gray-500 italic">
    {roundRuleText(game.round as 1 | 2)}
  </p>
)}
```

Also show it in the ready-phase render so it's visible before the turn starts.

#### 4e. New sub-components

```typescript
function BetweenRoundsView({ round, isHost, joinCode, playerId }: {
  round: 1 | 2; isHost: boolean; joinCode: string; playerId: string
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleAdvance() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/games/${joinCode}/advance-round`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as { error?: string }).error ?? 'Something went wrong')
      }
    } catch {
      setError('Something went wrong — please try again')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mt-8 flex flex-col items-center gap-6 text-center">
      <p className="text-2xl font-bold text-gray-900">Round {round} is over!</p>
      {isHost ? (
        <>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <button
            onClick={handleAdvance}
            disabled={loading}
            className="rounded-xl bg-brand-coral px-8 py-3 text-sm font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Start Round {round + 1}
          </button>
        </>
      ) : (
        <p className="text-gray-600">Waiting for the host to start Round {round + 1}...</p>
      )}
    </div>
  )
}

function RoundSplashOverlay({ round, onDismiss }: { round: 1 | 2; onDismiss: () => void }) {
  const overlayRef = useRef<HTMLDivElement>(null)

  // Move focus into the overlay on mount so keyboard users can dismiss it immediately.
  useEffect(() => {
    overlayRef.current?.focus()
  }, [])

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Round ${round} starting`}
      tabIndex={0}
      className="fixed inset-0 z-50 flex items-center justify-center bg-brand-coral cursor-pointer outline-none"
      onClick={onDismiss}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onDismiss() }}
    >
      <div className="text-center text-white px-8">
        <p className="text-4xl font-bold mb-4">Round {round}</p>
        <p className="text-xl">{roundRuleText(round)}</p>
        <p className="mt-8 text-sm opacity-70">Tap or press Enter to continue</p>
      </div>
    </div>
  )
}
```

### Success Criteria

#### Automated Verification

- [x] TypeScript compiles: `npm run build -w client`
- [x] No lint errors

#### Manual Verification

- [ ] Play through round 1 until hat empties → all devices show between-rounds screen
- [ ] Host sees "Start Round 2" button; other players see waiting message
- [ ] Non-host pressing advance is rejected (403 from server)
- [ ] Host presses "Start Round 2" → splash appears on all devices for ~2.5 seconds
- [ ] Tapping the splash dismisses it early
- [ ] After splash, clue giver view shows "One word only!" banner
- [ ] During round 1, clue giver view shows "Describe using anything — charades style!" banner
- [ ] Scores from round 1 are preserved going into round 2

---

## Testing Strategy

### Unit / Integration Tests (server only)

- `InMemoryGameStore.test.ts`:
  - `startGame`: add `'sets round to 1'` assertion
  - `guessWord`: update existing hat-empty test + add `round: 2` variant (→ `round_over`)
  - `endTurn` defensive guard: same two-variant update
  - `advanceRound` suite (~13 tests covering: NOT_FOUND, FORBIDDEN, INVALID_STATE, round-2-boundary, round/status set, hat refilled, shuffle randomness, currentClueGiverId restored, clueGiverIndices/activeTeam preserved, stale arrays cleared, turnPhase, scores preserved, broadcast content)
- `games.test.ts`: `advance-round` route suite (6 tests — 200, originalWords not leaked, 400, 404, 403, **409**), updated `mockStore` default with `originalWords` in return value

### Manual Testing Steps

1. Start game → play until hat empties → confirm `between_rounds` screen on all devices
2. Press "Start Round 2" as host → confirm splash → confirm banner on clue giver view
3. Attempt "Start Round 2" as non-host → confirm error (no button shown, but worth testing API directly)
4. Verify scores carry over correctly across rounds

---

## References

- Original ticket: `meta/tickets/ENG-013-round-transition-hat-refill-banners.md`
- Pattern reference: `server/src/routes/games.test.ts:626` (end-turn test block)
- Store pattern: `server/src/store/InMemoryGameStore.ts:177` (endTurn method)
- Client pattern: `client/src/pages/GamePage.tsx:54` (status branch)
