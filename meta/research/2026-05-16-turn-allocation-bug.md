---
date: 2026-05-16T15:11:35+02:00
researcher: John Cowie Del Corral
git_commit: 4416d823c2ea0f757e92ca44f6421525573f58c7
branch: main
repository: wordfetti
topic: "Turn allocation bug investigation"
tags: [research, codebase, turn-allocation, round-transition, advanceRound, endTurn, InMemoryGameStore]
status: complete
last_updated: 2026-05-16
last_updated_by: John Cowie Del Corral
---

# Research: Turn Allocation Bug Investigation

**Date**: 2026-05-16T15:11:35+02:00  
**Researcher**: John Cowie Del Corral  
**Git Commit**: 4416d823c2ea0f757e92ca44f6421525573f58c7  
**Branch**: main  
**Repository**: wordfetti

## Research Question

We suspect there might be a bug in turn allocation. The expected spec is:
- Each team round-robins through players in join order, independently of the other team.
- Round transitions do NOT reset the per-team rotation — whoever was next before the round ended is still next at the start of the new round.
- Turns always alternate between teams, regardless of round boundaries.
- Each team's tracking is completely independent.

## Summary

**Two bugs confirmed** in `advanceRound` (`server/src/store/InMemoryGameStore.ts`).

Both stem from the same root cause: `guessWord` ends a round mid-turn (without calling `endTurn`), so `activeTeam` and `clueGiverIndices` are left in a within-turn state. `advanceRound` was written assuming `endTurn` had already run and flipped the team — but it never did.

**Bug 1 — Wrong team starts each new round**: `activeTeam` is not flipped at round end. The team giving clues when the last word is guessed remains `activeTeam`. `advanceRound` then starts the new round with that same team, violating the alternation rule.

**Bug 2 — Same player gets two consecutive turns across a round boundary**: `advanceRound` reads `clueGiverIndices[activeTeam]` to assign the first clue giver but does NOT advance the index. When `endTurn` is later called for that team, it reads the same un-advanced index and picks the same player again.

---

## Detailed Findings

### How turn rotation works (within a round — correct)

**File**: [`server/src/store/InMemoryGameStore.ts`](https://github.com/johncowie/wordfetti/blob/4416d823c2ea0f757e92ca44f6421525573f58c7/server/src/store/InMemoryGameStore.ts)

The `clueGiverIndices: Record<Team, number>` field (line 19) stores the **next** player index for each team — it is pre-advanced at assignment time, not at draw time.

`startGame` (lines 215–218): seeds the active team's index at `1` (past player[0] who is assigned), the inactive team at `0`.

`endTurn` (lines 317–328): flips `activeTeam`, reads `clueGiverIndices[newTeam]`, assigns that player, then immediately advances the index by 1 (modulo team size). Only the incoming team's index is ever touched.

This within-round logic is **correct**.

### Bug 1: `activeTeam` not flipped at round transition

`guessWord` (lines 396–411) drains the hat and sets `status = 'between_rounds'`, but does **not** flip `activeTeam`:

```ts
// guessWord, lines 404–411
Object.assign(game, {
  status: newStatus,          // 'between_rounds'
  currentWord: undefined,
  currentWordId: undefined,
  currentClueGiverId: undefined,
  turnPhase: undefined,
  turnStartedAt: undefined,
  // ← activeTeam NOT changed
})
```

`advanceRound` (lines 359–360) then reads `activeTeam` as-is to pick the next clue giver:

```ts
const teamPlayers = game.players.filter((p) => p.team === game.activeTeam)
const nextClueGiver = teamPlayers[game.clueGiverIndices[game.activeTeam!] % teamPlayers.length]
```

**Result**: The team that gave the last clue in round N also gives the first clue in round N+1. The other team is skipped.

**Example** (Team A: A1, A2; Team B: B1, B2; A goes first):
| Round | Turn | Player | Via |
|-------|------|--------|-----|
| 1 | 1 | A1 | startGame |
| 1 | 2 | B1 | endTurn |
| 1 | 3 | A2 | endTurn |
| 1 ends | | hat empty, activeTeam=1 | guessWord |
| 2 | 1 | **A1** ❌ | advanceRound (should be B2) |

### Bug 2: `clueGiverIndices` not advanced in `advanceRound`

`advanceRound` reads the index to assign the first clue giver of the new round but does **not** call the pre-advance step:

```ts
// advanceRound, lines 359–367
const teamPlayers = game.players.filter((p) => p.team === game.activeTeam)
const nextClueGiver = teamPlayers[game.clueGiverIndices[game.activeTeam!] % teamPlayers.length]

Object.assign(game, {
  ...
  currentClueGiverId: nextClueGiver.id,
  ...
})
// clueGiverIndices and activeTeam are unchanged ← index NOT advanced!
```

`endTurn` always pre-advances on assignment. Because `advanceRound` skips this step, the next time `endTurn` rotates back to this team it reads the same (stale) index and picks the same player again.

**Continuing the Bug 1 example**:

State entering round 2: `activeTeam=1`, `clueGiverIndices={1:0, 2:1}` — A1 assigned, index not advanced.

| Round 2 turn | Player | Via | State after |
|---|---|---|---|
| 1 | A1 ❌ | advanceRound | `indices={1:0, 2:1}` ← index still 0! |
| 2 | B2 | endTurn (newTeam=2, idx[2]=1) | `indices={1:0, 2:0}` |
| 3 | **A1 again** ❌ | endTurn (newTeam=1, idx[1]=0) | should be A2 |

A1 gets two turns before A2 gets their second turn.

### Root cause

Both bugs share the same root cause: `advanceRound` was designed assuming `endTurn` had been called at the end of round N (which would have flipped `activeTeam` to the correct next team and pre-advanced that team's index). In practice, rounds always end inside `guessWord` mid-turn, so `endTurn` is never called at the round boundary. `activeTeam` is therefore the wrong team, and `clueGiverIndices[activeTeam]` is the wrong (un-advanced) index.

---

## Code References

- [`server/src/store/InMemoryGameStore.ts:293–345`](https://github.com/johncowie/wordfetti/blob/4416d823c2ea0f757e92ca44f6421525573f58c7/server/src/store/InMemoryGameStore.ts#L293) — `endTurn`: correct per-turn rotation logic
- [`server/src/store/InMemoryGameStore.ts:347–380`](https://github.com/johncowie/wordfetti/blob/4416d823c2ea0f757e92ca44f6421525573f58c7/server/src/store/InMemoryGameStore.ts#L347) — `advanceRound`: missing team flip and index advance (both bugs here)
- [`server/src/store/InMemoryGameStore.ts:382–428`](https://github.com/johncowie/wordfetti/blob/4416d823c2ea0f757e92ca44f6421525573f58c7/server/src/store/InMemoryGameStore.ts#L382) — `guessWord`: ends round without flipping activeTeam
- [`server/src/store/InMemoryGameStore.ts:215–218`](https://github.com/johncowie/wordfetti/blob/4416d823c2ea0f757e92ca44f6421525573f58c7/server/src/store/InMemoryGameStore.ts#L215) — `startGame` clueGiverIndices seed

---

## Proposed Fix

In `advanceRound`, mirror the logic of `endTurn`: flip `activeTeam`, then read and advance `clueGiverIndices` for the new active team.

```ts
// advanceRound — replace lines 358–367 with:
const newActiveTeam: 1 | 2 = game.activeTeam === 1 ? 2 : 1
const teamPlayers = game.players.filter((p) => p.team === newActiveTeam)
const nextIndex = game.clueGiverIndices[newActiveTeam]
const nextClueGiver = teamPlayers[nextIndex % teamPlayers.length]
game.clueGiverIndices[newActiveTeam] = (nextIndex + 1) % teamPlayers.length

Object.assign(game, {
  round: (game.round === 1 ? 2 : 3) as 1 | 2 | 3,
  status: 'in_progress',
  hat: shuffledHat,
  turnPhase: 'ready',
  activeTeam: newActiveTeam,          // ← flip the team
  currentClueGiverId: nextClueGiver.id,
  currentWord: undefined,
  currentWordId: undefined,
  turnStartedAt: undefined,
  guessedThisTurn: [],
  skippedThisTurn: [],
})
// clueGiverIndices[newActiveTeam] already advanced above
// clueGiverIndices[outgoing team] unchanged — their rotation preserved
```

**Traced result after fix** (A1, B1, A2 finished round 1, hat emptied mid-A2's turn):

State entering advanceRound: `activeTeam=1`, `clueGiverIndices={1:0, 2:1}`

- `newActiveTeam = 2`
- `clueGiverIndices[2] = 1` → B2 assigned, advance to 0
- State: `activeTeam=2`, `clueGiverIndices={1:0, 2:0}`

Round 2 sequence: B2 → A1 → B1 → A2 → B2 → ... ✓

---

## Architecture Insights

The `clueGiverIndices` pre-advance convention (index always points to the NEXT player, advanced at assignment time) is applied consistently in `startGame` and `endTurn` but was missed in `advanceRound`. The fix makes `advanceRound` consistent with that convention.

The defensive guard in `endTurn` (lines 300–312) for an already-empty hat is truly unreachable in normal flow: `guessWord` sets `status='between_rounds'` and `turnPhase=undefined`, so a subsequent `endTurn` call fails `assertClueGiverTurn` (status check) before reaching the guard.

---

## Test Coverage Gaps

- No test drives a game across a round boundary and asserts specific player identity for each turn in round 2.
- No test explicitly checks `activeTeam` before and after `advanceRound` to verify it flips.
- The 4-turn-cycle test (`InMemoryGameStore.test.ts:679–708`) implicitly proves within-round rotation is correct, but does not span rounds.
- The `advanceRound` test "restores currentClueGiverId from preserved activeTeam + clueGiverIndices" (`InMemoryGameStore.test.ts:817–827`) checks the formula but does not verify team alternation.

---

## Open Questions

- Should `guessWord` flip `activeTeam` when the hat empties (so `advanceRound` can remain simpler)? The proposed fix puts all the logic in `advanceRound` instead, which keeps `guessWord` clean.
- Are there any clients that read `activeTeam` from the `between_rounds` state snapshot? If so, the fix changes the value they see during the between-rounds interstitial.
