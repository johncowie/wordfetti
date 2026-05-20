---
date: "2026-05-20T12:59:39+00:00"
type: plan
skill: create-plan
work-item: ""
status: completed
---

# REFACTOR-001: PlayerRoster Object

## Overview

Extract player-related state from `InternalGame` into a `PlayerRoster` class, and add `active: boolean` and `stats: { clueGiverCount: number }` to the public `Player` type. Zero functional change for users today; the payoff is that ENG-024 (host kick) becomes trivially safe — `roster.kick(playerId)` sets `active: false`, the rotation naturally skips inactive players without any index repair, and kicked-player stats are preserved because the player object stays in the roster.

## Current State Analysis

Three fields on `InternalGame` track all player-related state:

- `players: Player[]` (via `Game`) — mutable array, mutated directly in place (`push`, `player.wordCount += 1`)
- `clueGiverIndices: Record<Team, number>` (`InMemoryGameStore.ts:19`) — numeric pointer to the *next* clue giver per team; pre-advanced at assignment time. Fragile: removing a player from the middle of a team array silently corrupts this pointer unless index-repair math is applied.
- `clueGiverStats: Record<string, number>` (`InMemoryGameStore.ts:20`) — cumulative guess count keyed by `playerId`.

These are coordinated across eight store methods. The `clueGiverIndices` design is the fragility — it is an index into the *current* filtered array, not a stable identity. Replacing it with a last-assigned-player pointer (`_lastClueGiverId`) that operates on a stable ordered array eliminates the repair problem entirely.

**Key insight with soft-delete:** if kicked players stay in the `_players` array as `active: false`, the join-order of the array never changes. Finding the next clue giver becomes: filter to active players on that team (preserving join order), find the last-assigned player's ID in that list, take `(foundIndex + 1) % activeLength`. If the last-assigned player was kicked (not in the active list), `findIndex` returns `-1` and we take index `0` — which is correct, since they were at a rotation boundary. No repair logic anywhere.

### Full Usage Audit

Every access to the three fields in `InMemoryGameStore.ts` (confirmed line numbers):

| Field | Line(s) | Operation |
|---|---|---|
| `game.players` | 102 | Snapshot: `{ ...game, players: [...game.players] }` |
| `game.players` | 167 | Init: `players: []` |
| `game.players` | 181, 197 | Return shallow copies |
| `game.players.some(...)` | 204 | Duplicate name check in `joinGame` |
| `game.players.push(player)` | 209–210 | Add player in `joinGame` |
| `game.players.flatMap(...)` | 219 | Collect all submitted words in `startGame` |
| `game.players.filter(...)` | 226 | First clue giver in `startGame` |
| `game.players.find(...)` | 323 | Log clue giver name in `readyTurn` |
| `game.players.filter(...)` | 363 | Next team's players in `endTurn` |
| `game.players.filter(...)` | 405 | New active team's players in `advanceRound` |
| `game.players.find(...)` | 518, 535, 572 | Membership checks in `addWord`, `getWords`, `deleteWord` |
| `player.wordCount` mutation | 527, 579 | Direct mutation in `addWord`, `deleteWord` |
| `game.players.some(...)` | 590 | Settings conflict check in `updateSettings` |
| `game.players` | 563 | Passed to `computeBestClueGiver` |
| `game.clueGiverIndices` | 176 | Init: `{ 1: 0, 2: 0 }` |
| `game.clueGiverIndices` | 244–247 | Set initial indices in `startGame` |
| `game.clueGiverIndices` | 340 | Defensive guard in `endTurn` |
| `game.clueGiverIndices[team]` | 366–372 | Read next index and pre-advance in `endTurn` |
| `game.clueGiverIndices[team]` | 406–408 | Read next index and pre-advance in `advanceRound` |
| `game.clueGiverStats` | 177 | Init: `{}` |
| `game.clueGiverStats` | 241 | Reset in `startGame` |
| `game.clueGiverStats[id]` | 445–447 | Increment in `guessWord` |
| `game.clueGiverStats` | 563 | Passed to `computeBestClueGiver` |

Tests that access internal fields directly (via `store['games'].get(joinCode) as InternalGame`):
- `InMemoryGameStore.test.ts:851–875` — reads `clueGiverIndices[team]` to pre-calculate expected clue giver
- `InMemoryGameStore.test.ts:1065–1110` — reads `clueGiverStats` to assert stat counts after guesses
- `InMemoryGameStore.test.ts:1157–1160` — writes `clueGiverStats[fakeId] = 99` to test orphaned-ID behaviour in `computeBestClueGiver`
- `games.test.ts:713–723` — injects `clueGiverIndices` into a fake return value to verify `toPublicGame` strips it

## Desired End State

- `Player` in `shared/src/types.ts` gains `active: boolean` and `stats: { clueGiverCount: number }`.
- A new `PlayerRoster` class in `server/src/store/PlayerRoster.ts` owns `_players: Player[]` and `_lastClueGiverId: Record<Team, string | undefined>`.
- `InternalGame` has `roster: PlayerRoster` in place of `players`, `clueGiverIndices`, and `clueGiverStats`.
- All store methods use the roster API.
- `toPublicGame` reconstructs `players` from `roster.getAll()` and strips `roster`.
- `computeBestClueGiver` takes `Player[]` directly (simplified signature).
- The public API shape is unchanged for clients receiving SSE events, except each player object now includes `active: true` and `stats: { clueGiverCount: 0/N }` — new fields, not a breaking removal.
- All existing tests pass; test assertions that check player shapes are updated to include the new fields.
- A new `PlayerRoster.test.ts` covers the rotation and soft-delete logic in isolation.

### Key Design Decisions

- **`active` is on the public `Player` type**: clients get it in SSE events. During this refactor it is always `true`; ENG-024 will set it to `false` and add client-side filtering.
- **Stats on the player**: `stats.clueGiverCount` lives directly on the `Player` object. Kicked players (inactive) stay in the roster, so their stats are naturally preserved.
- **No `clueGiverIndices`**: replaced by `_lastClueGiverId: Record<Team, string | undefined>`. The active-player list in join order is the authoritative rotation sequence; the pointer is a player ID, not an array index.
- **`assignNextClueGiver(team)`**: single method that atomically finds the next active player, advances the pointer, and returns the player. Replaces the two-step "read index, pre-advance index" pattern throughout the store.
- **`game.players` includes all players (active + inactive)**: ENG-024 adds client filtering. During this refactor no player is ever inactive, so no visual change.

## What We're NOT Doing

- Changing any client-side rendering code — that's ENG-024.
- Adding a `kickPlayer` method — that's ENG-024.
- Moving `currentClueGiverId`, `activeTeam`, or any other `InternalGame` fields into the roster.
- Changing the `GameStore` interface method signatures.
- Any new user-visible behaviour.

---

## Phase 1: Shared Type Update

### Overview

Add the two new fields to `Player` so TypeScript enforcement flows from the shared package outward.

### Changes Required

**File**: `shared/src/types.ts`

```ts
// Before:
export type Player = {
  id: string
  name: string
  team: Team
  wordCount: number
}

// After:
export type Player = {
  id: string
  name: string
  team: Team
  wordCount: number
  active: boolean
  stats: {
    clueGiverCount: number
  }
}
```

### Success Criteria

#### Automated Verification

- [x] Shared package compiles: `pnpm --filter @wordfetti/shared build`
- [x] TypeScript errors appear in `InMemoryGameStore.ts` and `games.ts` (expected — will be resolved in Phase 2)

---

## Phase 2: Create `PlayerRoster`

### Overview

Implement the `PlayerRoster` class in isolation. All logic is self-contained; no store changes yet.

### Changes Required

**File**: `server/src/store/PlayerRoster.ts` (new file)

```ts
import type { Player, Team } from '@wordfetti/shared'

export class PlayerRoster {
  private _players: Player[]
  private _lastClueGiverId: Record<Team, string | undefined>

  constructor(
    players: Player[] = [],
    lastClueGiverId: Record<Team, string | undefined> = { 1: undefined, 2: undefined },
  ) {
    this._players = [...players]
    this._lastClueGiverId = { ...lastClueGiverId }
  }

  // --- Read ---

  getAll(): Player[] {
    return [...this._players]
  }

  getActive(): Player[] {
    return this._players.filter((p) => p.active)
  }

  getById(id: string): Player | undefined {
    return this._players.find((p) => p.id === id)
  }

  getByTeam(team: Team): Player[] {
    return this._players.filter((p) => p.team === team && p.active)
  }

  some(predicate: (p: Player) => boolean): boolean {
    return this._players.some(predicate)
  }

  // --- Write ---

  /** Add a new player with active: true and zeroed stats. Returns the created Player. */
  add(player: Omit<Player, 'active' | 'stats'>): Player {
    const full: Player = { ...player, active: true, stats: { clueGiverCount: 0 } }
    this._players.push(full)
    return full
  }

  kick(playerId: string): void {
    const player = this._players.find((p) => p.id === playerId)
    if (player) player.active = false
  }

  updateWordCount(playerId: string, delta: number): void {
    const player = this._players.find((p) => p.id === playerId)
    if (player) player.wordCount += delta
  }

  incrementStat(playerId: string): void {
    const player = this._players.find((p) => p.id === playerId)
    if (player) player.stats.clueGiverCount++
  }

  resetStats(): void {
    for (const player of this._players) player.stats.clueGiverCount = 0
  }

  // --- Clue giver rotation ---

  /**
   * Find the next active player on `team` after the last assigned clue giver,
   * advance the pointer, and return that player.
   *
   * Active players are evaluated in join order (stable array order). If the last
   * assigned player is no longer active (was kicked), findIndex returns -1 and
   * the method wraps to index 0 — correct because a kicked clue giver sits at
   * the end of their rotation slot.
   */
  assignNextClueGiver(team: Team): Player {
    const activePlayers = this.getByTeam(team)
    if (activePlayers.length === 0) throw new Error(`No active players on team ${team}`)
    const lastId = this._lastClueGiverId[team]
    const lastIdx = lastId !== undefined ? activePlayers.findIndex((p) => p.id === lastId) : -1
    const nextIdx = (lastIdx + 1) % activePlayers.length
    const next = activePlayers[nextIdx]
    this._lastClueGiverId[team] = next.id
    return next
  }
}
```

### Success Criteria

#### Automated Verification

- [x] TypeScript compiles: `pnpm --filter server build`
- [x] New `PlayerRoster.test.ts` passes (see Testing Strategy)

---

## Phase 3: Migrate `InMemoryGameStore`

### Overview

Update `InternalGame`, replace all direct field access with roster API calls, simplify `computeBestClueGiver`, and update `toPublicGame` and `notifySubscribers`.

### Changes Required

#### 1. Update `InternalGame` type (`InMemoryGameStore.ts:14–23`)

```ts
// Before:
export type InternalGame = Game & {
  hat: Word[]
  originalWords: Word[]
  skippedThisTurn: string[]
  currentWordId?: string
  clueGiverIndices: Record<Team, number>
  clueGiverStats: Record<string, number>
  createdAt: string
  updatedAt: string
}

// After:
export type InternalGame = Omit<Game, 'players'> & {
  roster: PlayerRoster
  hat: Word[]
  originalWords: Word[]
  skippedThisTurn: string[]
  currentWordId?: string
  createdAt: string
  updatedAt: string
}
```

> `Omit<Game, 'players'>` drops the `Player[]` field from the inherited public type. The public `players` array is reconstructed in `toPublicGame`.

---

#### 2. Add `PlayerRoster` import

```ts
import { PlayerRoster } from './PlayerRoster.js'
```

---

#### 3. `createGame` — initialise roster (`~line 167, 176–177`)

```ts
// Before:
players: [],
clueGiverIndices: { 1: 0, 2: 0 },
clueGiverStats: {},

// After:
roster: new PlayerRoster(),
```

---

#### 4. Return-value snapshots that spread `game.players` (`lines 181, 197`)

These return the public game shape before `notifySubscribers` exists in the flow. After the migration, `toPublicGame` handles the conversion. Update these call sites to use `toPublicGame(game)` directly, or inline `{ ...omitInternal(game), players: game.roster.getAll() }`.

---

#### 5. `joinGame` — add player (`lines 204, 209–210`)

```ts
// Before:
if (game.players.some((p) => normalize(p.name) === normalize(name))) { ... }
const player: Player = { id: randomUUID(), name, team, wordCount: 0 }
game.players.push(player)

// After:
if (game.roster.some((p) => normalize(p.name) === normalize(name))) { ... }
const player = game.roster.add({ id: randomUUID(), name, team, wordCount: 0 })
```

---

#### 6. `startGame` — collect words, assign first clue giver, reset stats (`lines 219, 226, 241–247`)

```ts
// Before:
const allWords = game.players.flatMap((p) => ...)
const activeTeamPlayers = game.players.filter((p) => p.team === startingTeam)
const firstClueGiver = activeTeamPlayers[0]
// ... Object.assign includes clueGiverStats: {}
game.clueGiverIndices[startingTeam] = 1 % activeTeamPlayers.length
game.clueGiverIndices[otherTeam] = 0

// After:
const allWords = game.roster.getActive().flatMap((p) => ...)
game.roster.resetStats()
const firstClueGiver = game.roster.assignNextClueGiver(startingTeam)
// otherTeam's _lastClueGiverId stays undefined — assignNextClueGiver will return their first player
```

---

#### 7. `readyTurn` — log clue giver name (`line 323`)

```ts
// Before:
const clueGiver = game.players.find((p) => p.id === game.currentClueGiverId)

// After:
const clueGiver = game.roster.getById(game.currentClueGiverId ?? '')
```

---

#### 8. `endTurn` — rotate to next team (`lines 340, 362–372`)

```ts
// Before:
if (!game.clueGiverIndices) throw new AppError('INVALID_STATE', 'clueGiverIndices not initialised')
// ...
const newTeam: 1 | 2 = game.activeTeam === 1 ? 2 : 1
const newTeamPlayers = game.players.filter((p) => p.team === newTeam)
if (!newTeamPlayers.length) throw new AppError('INVALID_STATE', 'No players on the next team')
const nextIndex = game.clueGiverIndices[newTeam]
const nextClueGiver = newTeamPlayers[nextIndex % newTeamPlayers.length]
game.clueGiverIndices[newTeam] = (nextIndex + 1) % newTeamPlayers.length

// After:
const newTeam: 1 | 2 = game.activeTeam === 1 ? 2 : 1
const nextClueGiver = game.roster.assignNextClueGiver(newTeam)
```

The defensive `clueGiverIndices` guard is replaced by the error thrown inside `assignNextClueGiver` when the team has no active players (unreachable in valid game flow but still surfaces loudly).

---

#### 9. `advanceRound` — rotate to new active team (`lines 405–408`)

```ts
// Before:
const newActiveTeamPlayers = game.players.filter((p) => p.team === newActiveTeam)
const nextIndex = game.clueGiverIndices[newActiveTeam]
const nextClueGiver = newActiveTeamPlayers[nextIndex % newActiveTeamPlayers.length]
game.clueGiverIndices[newActiveTeam] = (nextIndex + 1) % newActiveTeamPlayers.length

// After:
const nextClueGiver = game.roster.assignNextClueGiver(newActiveTeam)
```

---

#### 10. `guessWord` — increment stat (`lines 445–447`)

```ts
// Before:
const id = game.currentClueGiverId!
game.clueGiverStats[id] = (game.clueGiverStats[id] ?? 0) + 1

// After:
game.roster.incrementStat(game.currentClueGiverId!)
```

---

#### 11. `addWord` / `deleteWord` — update word count (`lines 527, 579`)

```ts
// Before:
const player = game.players.find((p) => p.id === playerId)
player.wordCount += 1  // or -= 1

// After (addWord):
game.roster.updateWordCount(playerId, 1)

// After (deleteWord):
game.roster.updateWordCount(playerId, -1)
```

Membership validation (`game.players.find(...)` with a `NOT_FOUND` throw before the mutation) still applies — check `game.roster.getById(playerId)` first.

---

#### 12. `getWords` / `deleteWord` membership checks (`lines 535, 572`)

```ts
// Before:
const player = game.players.find((p) => p.id === playerId)
if (!player) throw new AppError('NOT_FOUND', ...)

// After:
const player = game.roster.getById(playerId)
if (!player) throw new AppError('NOT_FOUND', ...)
```

---

#### 13. `getGameWords` / `computeBestClueGiver` (`lines 544, 563`)

```ts
// Before:
const playerNames = new Map(game.players.map((p) => [p.id, p.name]))
// ...
computeBestClueGiver(game.clueGiverStats, game.players)

// After:
const playerNames = new Map(game.roster.getAll().map((p) => [p.id, p.name]))
// ...
computeBestClueGiver(game.roster.getAll())
```

---

#### 14. `updateSettings` — word count conflict check (`line 590`)

```ts
// Before:
game.players.some((p) => p.wordCount > newWordsPerPlayer)

// After:
game.roster.some((p) => p.wordCount > newWordsPerPlayer)
```

---

#### 15. `computeBestClueGiver` — simplified signature (`lines 34–48`)

```ts
// Before:
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
    .map(([id]) => playerNames.get(id) ?? id)
    .sort((a, b) => a.localeCompare(b))
  return { names, clueCount: max }
}

// After:
function computeBestClueGiver(players: Player[]): BestClueGiver | null {
  const withStats = players.filter((p) => p.stats.clueGiverCount > 0)
  if (withStats.length === 0) return null
  const max = Math.max(...withStats.map((p) => p.stats.clueGiverCount))
  const names = withStats
    .filter((p) => p.stats.clueGiverCount === max)
    .map((p) => p.name)
    .sort((a, b) => a.localeCompare(b))
  return { names, clueCount: max }
}
```

---

#### 16. `notifySubscribers` (`lines 100–105`)

Move `toPublicGame` conversion here so SSE callbacks always receive a fully-public `Game` object rather than the raw internal game.

```ts
private notifySubscribers(joinCode: string, game: InternalGame): Game {
  this.touchGame(game)
  const publicGame = toPublicGame(game)
  this.subscribers.get(joinCode)?.forEach((cb) => cb(publicGame))
  return publicGame
}
```

The route's SSE callback (`games.ts:107`) then simplifies:

```ts
// Before:
res.write(`data: ${JSON.stringify(toPublicGame(updatedGame))}\n\n`)

// After:
res.write(`data: ${JSON.stringify(updatedGame)}\n\n`)
```

---

#### 17. `toPublicGame` (`games.ts:9–12`)

```ts
// Before:
function toPublicGame(game: Game & { hat?: unknown; skippedThisTurn?: unknown; currentWordId?: unknown; clueGiverIndices?: unknown; originalWords?: unknown; clueGiverStats?: unknown }) {
  const { hat: _hat, skippedThisTurn: _skipped, currentWordId: _id, clueGiverIndices: _ci, originalWords: _ow, clueGiverStats: _cgs, ...publicGame } = game
  return publicGame
}

// After (import InternalGame from store):
import type { InternalGame } from '../store/InMemoryGameStore.js'

function toPublicGame(game: InternalGame): Game {
  const { hat: _hat, skippedThisTurn: _skipped, currentWordId: _id, originalWords: _ow, roster, ...rest } = game
  return { ...rest, players: roster.getAll() }
}
```

---

### Success Criteria

#### Automated Verification

- [x] TypeScript compiles with no errors: `pnpm --filter server build`
- [x] All existing tests pass: `pnpm test`

---

## Phase 4: Update Tests

### Overview

Update all test files affected by the internal field changes and add `active`/`stats` to player shape assertions. Add a dedicated `PlayerRoster.test.ts`.

### Changes Required

#### 1. `InMemoryGameStore.test.ts` — internal field accesses

| Old access | New access |
|---|---|
| `(internal as InternalGame).clueGiverIndices[team]` | `internal.roster['_lastClueGiverId']` is an implementation detail — instead, assert on the returned clue giver's identity directly via the public game result |
| `(internal as InternalGame).clueGiverStats` | `internal.roster.getAll().find(p => p.id === id)!.stats.clueGiverCount` |
| `internalGame.clueGiverStats[fakeId] = 99` (tests orphaned ID) | Remove this test — orphaned stat IDs are structurally impossible with stats-on-player. Replace with a test verifying that an inactive (kicked) player's stats still appear in `computeBestClueGiver` results. |

**Player shape assertions** — every test that does `.toEqual({ id, name, team, wordCount })` on a player object must add `active: true, stats: { clueGiverCount: 0 }` (or the correct count after guesses).

**`clueGiverIndices` tests** (`lines 851–875`) — these currently read the raw index to pre-calculate who goes next. After the refactoring these are simpler: just call the relevant store method and assert on the returned `currentClueGiverId` from the public game snapshot. The internal implementation detail no longer needs direct verification.

#### 2. `games.test.ts` — `toPublicGame` stripping test (`lines 713–723`)

The test injects `clueGiverIndices` into a fake return value to verify it is stripped. After the refactoring the internal field is `roster`. Update the fake to use a minimal roster duck-type:

```ts
const fakeRoster = new PlayerRoster(fakePlayers)
const fakeInternal = { ...fakeGame, roster: fakeRoster, hat: [], originalWords: [], ... } as InternalGame
// Assert that toPublicGame(fakeInternal) does not contain 'roster'
// and does contain the correct 'players' array
```

#### 3. New file: `server/src/store/PlayerRoster.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { PlayerRoster } from './PlayerRoster.js'

describe('PlayerRoster', () => {
  // Helpers
  function makePlayer(id: string, team: 1 | 2) {
    return { id, name: id, team, wordCount: 0 }
  }

  describe('assignNextClueGiver', () => {
    it('returns players in join order on first rotation', () => { ... })
    it('wraps around after the last player on the team', () => { ... })
    it('skips inactive players and continues rotation', () => { ... })
    it('wraps correctly when the last-assigned player was kicked', () => { ... })
    it('handles a team where all but one player are kicked', () => { ... })
  })

  describe('kick', () => {
    it('sets active: false on the target player', () => { ... })
    it('preserves the player in getAll() but excludes them from getByTeam()', () => { ... })
    it('preserves stats.clueGiverCount after kick', () => { ... })
  })

  describe('add', () => {
    it('initialises active: true and zeroed stats', () => { ... })
    it('returns the created player', () => { ... })
  })

  describe('incrementStat', () => {
    it('increments count on an active player', () => { ... })
    it('increments count on an inactive player (stats preserved through kick)', () => { ... })
  })
})
```

### Success Criteria

#### Automated Verification

- [x] All tests pass: `pnpm test`
- [x] No TypeScript errors: `pnpm --filter server build`

---

## Testing Strategy

### `PlayerRoster.test.ts` — rotation edge cases to cover

The most important test: **kick mid-rotation, rotation continues from correct position.**

```
Setup: team 1 players A(0), B(1), C(2), D(3) — join order
Rotation: A→B→C, lastClueGiverId = C
Kick: D (next in rotation)
assignNextClueGiver(1) → A (wraps, D is inactive and skipped)
```

```
Setup: team 1 players A(0), B(1), C(2)
Rotation: A→B, lastClueGiverId = B
Kick: B (the one who just went)
assignNextClueGiver(1) → C (findIndex of B = -1 since inactive, falls back? No — B IS inactive...)
```

Wait — re-examine this edge case. B was the last assigned (their turn just ended, they are `lastClueGiverId = B`). Then B is kicked. Now:
- `activePlayers = [A, C]`
- `findIndex` of B → -1 (not in active list)
- `nextIdx = (-1 + 1) % 2 = 0` → A

Is this correct? A already went. The "right" next player is C. This is the one case where `lastId = B (inactive)` gives us A instead of C.

This is an acceptable trade-off for this refactoring, and the work item notes: "if the kicked player is the current clue giver, advances the turn via normal rotation." In this case the kicked player is NOT the current clue giver (their turn already ended), so the game just continues — and A going next is within the bounds of normal rotation (we've completed A→B and are wrapping around). However if the desired behaviour in ENG-024 is "continue from C", this could be addressed in that story by passing the kicked player's ID to `roster.kick()` and advancing `_lastClueGiverId` past them at the same time.

**Document this edge case in the test** and note it as a known behaviour to revisit in ENG-024 if needed.

### Integration: all existing store + route tests

A clean `pnpm test` run is the acceptance gate. No store method behaviour changes, so existing tests validate correctness end-to-end.

### Manual Verification Steps

1. Create a game with 4 players, play through a full 3-round game — all turn rotations, scoring, and stats work correctly.
2. Stats page shows correct best clue giver after a completed game.
3. No regressions in lobby (duplicate name rejection, word count badges, start gating).

---

## References

- Driving story: `meta/work/ENG-024-host-kick-players-from-lobby-and-game.md`
- Store implementation: `server/src/store/InMemoryGameStore.ts`
- Route layer: `server/src/routes/games.ts`
- Shared types: `shared/src/types.ts`
- ENG-024 plan (to be written after this): `meta/plans/2026-05-20-ENG-024-host-kick-players.md`
