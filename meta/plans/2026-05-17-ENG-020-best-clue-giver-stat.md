---
date: "2026-05-17T15:34:07+00:00"
type: plan
skill: create-plan
work-item: "ENG-020"
status: draft
---

# Best Clue Giver Stat — Implementation Plan

## Overview

Add a "Best clue giver" section to the post-game stats page showing which player(s) gave the most successfully guessed clues across all turns and rounds, along with their count.

## Current State Analysis

The stats page (`client/src/pages/StatsPage.tsx`) fetches `GET /:joinCode/stats`, which calls `store.getGameWords()` and returns `{ wordsBySubmitter }`. The page renders one section per submitter with a word list.

Per-turn clue-giver performance is not persisted. `guessedThisTurn` on `InternalGame` is cleared at every `endTurn` and `readyTurn` call. Once a turn ends, the clue-giver's per-turn count is gone. A new accumulator on `InternalGame` is required.

### Key Discoveries

- `InternalGame` type: `server/src/store/InMemoryGameStore.ts:14` — internal game fields not exposed to clients
- `guessWord`: `InMemoryGameStore.ts:387` — increments team score and appends to `guessedThisTurn`; `currentClueGiverId` is available on the game object at this point
- `toPublicGame`: `server/src/routes/games.ts:9` — strips internal fields before sending to clients via SSE; `clueGiverStats` must be added here
- `getGameWords`: `InMemoryGameStore.ts:491` — aggregates words by submitter; this is where best clue giver computation belongs
- `GameStats` type: `shared/src/types.ts:18` — shared between server and client
- `StatsPage.tsx`: `client/src/pages/StatsPage.tsx` — straightforward fetch-and-render; `GameStats` typed state
- No `getGameWords` tests exist yet in `InMemoryGameStore.test.ts`
- Test command: `pnpm test` (vitest); type check: `pnpm typecheck`

## Desired End State

The stats page shows a "Best clue giver: Alice (8 clues)" line at the top. If tied, "Best clue givers: Alice, Bob (8 clues)". The label and count come from a `bestClueGiver` field on the API response, computed by aggregating a persistent per-player clue count accumulated throughout the game.

Verify by:
1. Playing a full game (or using the zombie script), then navigating to the stats page and confirming the best clue giver section appears above the words-by-submitter list with the correct name and count.
2. `pnpm test` passes with new accumulation and tie-handling tests.
3. `pnpm typecheck` passes across all packages.

## What We're NOT Doing

- A full ranked leaderboard of all players' clue counts
- Per-round clue giver breakdown
- Persisting clue giver stats across server restarts (in-memory store only)
- Fixing the pre-existing `createdAt`/`updatedAt` leak in `toPublicGame`

---

## Phase 1: Shared Types

### Overview

Extend `GameStats` with a `bestClueGiver` field and introduce the `BestClueGiver` type. This unblocks the server and client changes.

### Changes Required

#### `shared/src/types.ts`

Add a `BestClueGiver` type above `GameStats`, and extend `GameStats`:

```typescript
export type BestClueGiver = {
  names: string[]
  clueCount: number
}

export type GameStats = {
  wordsBySubmitter: SubmitterWords[]
  bestClueGiver: BestClueGiver | null
}
```

`null` covers the edge case where a game finishes with zero guesses (unlikely in practice but avoids a runtime error).

Also update the `mockStore` default stub in `server/src/routes/games.test.ts` (line 37) at the same time as the type change, so `pnpm typecheck` passes immediately after Phase 1:

```typescript
getGameWords: async () => ({
  wordsBySubmitter: [],
  bestClueGiver: null,
}),
```

### Success Criteria

#### Automated Verification

- [x] Type check passes across all packages: `pnpm typecheck`

---

## Phase 2: Server

### Overview

Add `clueGiverStats` to `InternalGame`, initialise it, increment on every successful guess, compute the best clue giver(s) in `getGameWords`, and strip the field from `toPublicGame` so it never leaks to clients.

### Changes Required

#### 1. `InternalGame` type — `server/src/store/InMemoryGameStore.ts:14`

Add the accumulator field:

```typescript
export type InternalGame = Game & {
  hat: Word[]
  originalWords: Word[]
  skippedThisTurn: string[]
  currentWordId?: string
  clueGiverIndices: Record<Team, number>
  clueGiverStats: Record<string, number>   // playerId → total clues guessed
  createdAt: string
  updatedAt: string
}
```

#### 2. Initialise in `createGame` and `startGame`

Add `clueGiverStats: {}` to the game object literal in `createGame` (`InMemoryGameStore.ts:139`):

```typescript
clueGiverStats: {},
```

Also add it to the `Object.assign` block inside `startGame` (`InMemoryGameStore.ts:203`) alongside the other reset fields, making the invariant explicit and resilient to future refactors (e.g. a `restartGame` path):

```typescript
Object.assign(game, {
  // ... existing fields ...
  clueGiverStats: {},
})
```

#### 3. Increment in `guessWord` — `InMemoryGameStore.ts:387`

After `game.scores[...] ++` and before the hat-empty branch, add:

```typescript
if (game.currentClueGiverId) {
  game.clueGiverStats[game.currentClueGiverId] =
    (game.clueGiverStats[game.currentClueGiverId] ?? 0) + 1
}
```

The `currentClueGiverId` guard is defensive — `assertClueGiverTurn` already ensures it is set, but the optional type warrants the check.

#### 4. Compute best clue giver in `getGameWords` — `InMemoryGameStore.ts:491`

Declare `computeBestClueGiver` as an unexported **module-level function** above `getGameWords` (consistent with the existing `shuffle` helper in the same file). This keeps the pure computation separate from the stateful class and makes it directly callable without `this.`:

```typescript
function computeBestClueGiver(
  stats: Record<string, number>,
  players: Player[],
): BestClueGiver | null {
  const entries = Object.entries(stats)
  if (entries.length === 0) return null

  const max = Math.max(...entries.map(([, count]) => count))
  const playerNames = new Map(players.map((p) => [p.id, p.name]))
  const names = entries
    .filter(([, count]) => count === max)
    .map(([id]) => playerNames.get(id) ?? id)   // fallback to id if player somehow missing
    .sort((a, b) => a.localeCompare(b))

  return { names, clueCount: max }
}
```

Then extend `getGameWords` to call it and return the result:

```typescript
async getGameWords(joinCode: string): Promise<GameStats> {
  const game = this.games.get(joinCode)
  if (!game) throw new AppError('NOT_FOUND', 'Game not found')

  // ... existing wordsBySubmitter logic unchanged ...

  const bestClueGiver = computeBestClueGiver(game.clueGiverStats, game.players)

  return { wordsBySubmitter, bestClueGiver }
}
```

Names are sorted alphabetically so the display order is deterministic on ties. The `max === 0` guard has been removed — `entries.length === 0` already handles the no-guesses case, and a state where entries exist but all counts are zero is unreachable via the public API.

#### 5. Strip `clueGiverStats` from `toPublicGame` — `server/src/routes/games.ts:9`

Append `clueGiverStats?: unknown` to the existing single-line parameter type, and add `clueGiverStats: _cgs` to the destructure — retaining the existing style:

```typescript
function toPublicGame(game: Game & { hat?: unknown; skippedThisTurn?: unknown; currentWordId?: unknown; clueGiverIndices?: unknown; originalWords?: unknown; clueGiverStats?: unknown }) {
  const { hat: _hat, skippedThisTurn: _skipped, currentWordId: _id, clueGiverIndices: _ci, originalWords: _ow, clueGiverStats: _cgs, ...publicGame } = game
  return publicGame
}
```

### Success Criteria

#### Automated Verification

- [x] Type check passes: `pnpm typecheck`
- [x] Tests pass (including new tests added in Phase 4): `pnpm test`

---

## Phase 3: Frontend

### Overview

Add the "Best clue giver" section at the top of `StatsPage.tsx`, above the words-by-submitter list. Pluralise when there is a tie.

### Changes Required

#### `client/src/pages/StatsPage.tsx`

Add a `BestClueGiverSection` helper inside the file (or inline — the component is small enough):

```tsx
function BestClueGiverSection({ bestClueGiver }: { bestClueGiver: BestClueGiver | null }) {
  if (!bestClueGiver) return null
  const label = bestClueGiver.names.length === 1 ? 'Best clue giver' : 'Best clue givers'
  const names = bestClueGiver.names.join(', ')
  return (
    <section className="w-full max-w-md">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
        {label}
      </h2>
      <p className="rounded-xl bg-white px-4 py-3 text-sm text-gray-900 shadow-sm">
        {names} ({bestClueGiver.clueCount} {bestClueGiver.clueCount === 1 ? 'clue' : 'clues'})
      </p>
    </section>
  )
}
```

Render it above the submitter list inside the `<main>`:

```tsx
<BestClueGiverSection bestClueGiver={stats.bestClueGiver} />

{stats.wordsBySubmitter.length === 0 ? (
  ...
```

Import `BestClueGiver` from `@wordfetti/shared`.

### Success Criteria

#### Automated Verification

- [ ] Type check passes: `pnpm typecheck`

#### Manual Verification

- [ ] Navigate to the stats page after a completed game — "Best clue giver" section appears at the top with the correct name and clue count
- [ ] Trigger a tie scenario (two players with equal clue counts) — label reads "Best clue givers" and both names appear
- [ ] Words-by-submitter list remains unchanged below the new section
- [ ] Stats page still renders correctly when `bestClueGiver` is `null` (no guesses made)

---

## Phase 4: Tests

### Overview

Add unit tests covering the new accumulation behaviour and the `getGameWords` best-clue-giver output. Update the route test mock to include `bestClueGiver` in the default stub.

### Changes Required

#### `server/src/store/InMemoryGameStore.test.ts`

Add a `describe('clueGiverStats', ...)` block with a helper that runs a turn to completion. Key cases:

```typescript
describe('clueGiverStats', () => {
  it('increments the clue giver count on each successful guess', ...)
  it('persists the count across endTurn — does not reset', ...)
  it('accumulates across multiple rounds — drive advanceRound and assert count from round 1 is preserved before any round 2 guesses', ...)
})

describe('getGameWords — bestClueGiver', () => {
  it('returns the player with the most guesses as bestClueGiver', ...)
  it('returns all tied players sorted alphabetically', ...)
  it('returns null when no guesses have been made', ...)
  it('falls back to raw player ID when ID is in clueGiverStats but absent from game.players', ...)
})
```

Tests should use the existing `setupStartedGame()` helper and drive turns using `store.readyTurn` / `store.guessWord` / `store.endTurn` / `store.advanceRound`.

For the cross-round test: after draining all words in round 1 (which triggers `advanceRound` via the host), call `getGameWords` before any round 2 guesses and assert the accumulated clue count from round 1 is non-zero and matches the expected total.

For the fallback ID test: directly manipulate the internal game object (as the existing `guessWord` tests do via `as InternalGame`) to inject a `clueGiverStats` entry with a player ID not present in `game.players`, then call `getGameWords` and assert that ID string appears in `bestClueGiver.names`.

#### `server/src/routes/games.test.ts`

The mock stub update was moved to Phase 1. In this phase, add a route-level test asserting `bestClueGiver` survives HTTP serialisation:

```typescript
it('returns bestClueGiver in the stats response', async () => {
  const res = await request(buildApp(mockStore({
    getGameWords: async () => ({ wordsBySubmitter: [], bestClueGiver: null }),
  }))).get('/ABCDEF/stats')
  expect(res.status).toBe(200)
  expect(res.body).toHaveProperty('bestClueGiver', null)
})
```

### Success Criteria

#### Automated Verification

- [x] All tests pass including new ones: `pnpm test`
- [x] Type check passes: `pnpm typecheck`

---

## Testing Strategy

### Unit Tests

- Accumulation: one guess → count is 1; three guesses by same player → count is 3
- Persistence: count survives `endTurn` (not cleared)
- Cross-round: drive `advanceRound`, assert round-1 counts survive before round-2 guesses begin
- Best clue giver: single winner returned correctly
- Tie: both players returned, sorted alphabetically
- Zero guesses: `null` returned
- Fallback: player ID in `clueGiverStats` but absent from `game.players` → raw ID appears in `names`

### Manual Testing Steps

1. Start dev server: `pnpm dev`
2. Open two browser windows, create a game with 4 players (or use `pnpm zombie <code>`)
3. Play through to game end; note which player gave the most clues
4. Navigate to the stats page — verify "Best clue giver: [name] (N clues)" at the top
5. To test tie: arrange for two players to have equal counts, verify pluralised label

## References

- Work item: `meta/tickets/ENG-020-best-clue-giver-stat-on-post-game-stats-page.md`
- Related: `meta/tickets/ENG-019-post-game-stats-page-words-by-submitter.md`
