---
work_item_id: "ENG-020"
title: "Best Clue Giver Stat on Post-Game Stats Page"
date: "2026-05-17T15:26:11+00:00"
author: John Cowie Del Corral
type: story
status: draft
priority: medium
parent: ""
tags: [stats, frontend, backend]
---

# ENG-020: Best Clue Giver Stat on Post-Game Stats Page

**Type**: Story
**Status**: Draft
**Priority**: Medium
**Author**: John Cowie Del Corral

## Summary

As a player, I want to see who gave the most successfully guessed clues across the whole game, so that we can celebrate the best clue giver as part of the post-game review.

The stats page (introduced in ENG-019) will gain a "Best clue giver" section at the top of the page showing the player name and total clues guessed. If two or more players are tied, the section pluralises to "Best clue givers" and lists all tied players.

## Context

ENG-019 delivered a post-game stats page showing words grouped by submitter, and explicitly identified clue-giver leaderboards as a future story it unblocks. The stats page is intended to evolve into a full post-game analysis view for all players.

A key backend change is required: the server currently clears `guessedThisTurn` at every `endTurn` call, so no per-turn clue-giver history survives to game end. A new accumulator must be added to `InternalGame` that increments per clue giver (keyed by player ID) each time a word is successfully guessed, and persists until the game is served via the stats endpoint.

## Requirements

- Add a `clueGiverStats: Record<playerId, number>` field (or equivalent) to `InternalGame` that persists across all turns and all rounds
- Increment the active clue giver's count in the `guessWord` handler (`InMemoryGameStore.ts`) each time a word is successfully guessed within a turn
- Extend `getGameWords` (or add a new `getGameStats` method) to compute the best clue giver(s): the player ID(s) with the highest count, resolved to player name(s) via `game.players`
- Extend the `GET /:joinCode/stats` response and the shared `GameStats` type to include best clue giver data: player name(s) and clue count
- Display a "Best clue giver" (singular) or "Best clue givers" (plural, on tie) section at the top of `StatsPage.tsx`, above the words-by-submitter list, showing the player name(s) and clue count

## Acceptance Criteria

- Given a completed game where Alice gave clues for 8 successfully guessed words and Bob gave clues for 5, when any player views the stats page, then "Best clue giver: Alice (8 clues)" appears at the top of the page above the words-by-submitter section
- Given a completed game where Alice and Bob each gave clues for 8 successfully guessed words, when any player views the stats page, then "Best clue givers: Alice, Bob (8 clues)" appears at the top of the page
- Given a word is successfully guessed via `guessWord`, when the turn later ends, then that clue giver's accumulated count in `clueGiverStats` has incremented and is not lost
- Given a completed game with multiple rounds, when the stats page loads, then the best clue giver count reflects clues given across all three rounds

## Open Questions

## Dependencies

- Blocked by: ENG-019 (done — this story is the follow-on it explicitly unblocks)
- Blocks:

## Assumptions

- Clue giver stats are accumulated by player ID. Display uses the player's registered name. If two players registered with the same name, their counts are still tracked separately by ID, but the display may be ambiguous — this is tolerated for now.

## Technical Notes

- `guessedThisTurn` (cleared at `endTurn`) is distinct from the new accumulator — the new field must survive `endTurn` and `readyTurn` resets
- `InMemoryGameStore.ts:387–433` (`guessWord`) is the right place to increment the accumulator, using `game.currentClueGiverId`
- The stats endpoint (`server/src/routes/games.ts:215`) currently returns `{ wordsBySubmitter }` — extend with a `bestClueGiver: { names: string[], clueCount: number }` field (or similar shape)
- Shared type `GameStats` lives in `shared/src/types.ts:18–20`

## Drafting Notes

- ENG-019 explicitly names "clue-giver leaderboards" as future work — this is that story
- "Clues" used throughout in preference to "words" — more natural in hat game terminology, confirmed with user
- Scoped to top performer(s) only, not a full ranked table — consistent with the user's "Best clue giver" framing
- Name collision ambiguity is tolerated by design: stats are computed per player ID, but only the name is shown; if names collide the count is still correct per ID but display attribution is unclear

## References

- Related: ENG-019 (post-game stats page — words by submitter)
