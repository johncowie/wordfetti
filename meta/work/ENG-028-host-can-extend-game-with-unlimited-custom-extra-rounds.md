---
work_item_id: "ENG-028"
title: "Host Can Extend Game with Unlimited Custom Extra Rounds"
date: "2026-05-24T22:47:55+00:00"
author: Anthony Scatchell
type: story
status: draft
priority: medium
parent: ""
tags: [gameplay, host-controls, rounds]
---

# ENG-028: Host Can Extend Game with Unlimited Custom Extra Rounds

**Type**: Story
**Status**: Draft
**Priority**: Medium
**Author**: Anthony Scatchell

## Summary

As a host, I want to optionally continue the game beyond the standard three rounds so that players can play additional custom rounds with rules they agree on verbally, without the game ending automatically.

After the hat empties at the end of round 3 (and every subsequent extra round), instead of the win/lose screen appearing immediately, all players see a holding screen while the host decides whether to end the game or add another round. If the host chooses to continue, the words are returned to the hat and a standard round begins — accumulating stats and scores exactly as any other round would.

## Context

The hat game currently plays exactly three rounds. The round cycle is:
- Round 1: describe (no acting, no one-word clues)
- Round 2: one word only
- Round 3: mime/charades

After round 3, the game transitions directly to `finished` and shows the win/lose results screen.

In practice, players often want to add extra rounds with house rules they invent themselves (e.g. "backwards descriptions", "sounds only"). The current code ends the game automatically, giving no opportunity for the host to facilitate this. The feature removes that hard stop and gives the host a gate to either end or continue, as many times as they like.

The zombie bot script (`scripts/test-driver.ts`) already handles unlimited rounds correctly — it drives turns based on game status events and exits only on `'finished'`, so no bot changes are required.

## Requirements

- After the hat empties at the end of round 3 (and again after each subsequent extra round), the server transitions to a new game status: `'awaiting_extra_round_decision'` rather than `'finished'`
- All connected clients display a screen for this status:
  - Text visible to all: *"The host is choosing whether to end the game or play another round"*
  - Host-only: two buttons — **End Game** and **Play another round**
- **End Game**: host-only action that transitions the game to `'finished'`; the existing win/lose results and stats screens display unchanged
- **Play another round**: host-only action that refills the hat, increments the round number, and transitions to `'between_rounds'`; the existing `BetweenRoundsView` ("Round X is over!") and `RoundSplashOverlay` ("Round X starting…") components handle the transition without modification
- Extra rounds are identical to standard rounds in every respect: same scoring logic, same stat accumulation, no round-type description or special instructions
- The cycle repeats indefinitely: after each extra round empties the hat, the `'awaiting_extra_round_decision'` screen reappears
- Stats shown at the end of the game must reflect all rounds played (e.g. a 5-round game shows cumulative stats across all 5 rounds) — the existing cumulative stats implementation already handles this without change
- All hardcoded `round: 1 | 2 | 3` type constraints must be widened to `round: number` throughout the shared types, server model, and client components

## Acceptance Criteria

- Given the hat empties at the end of round 3, when the last word is guessed, then all players see "The host is choosing whether to end the game or play another round" and the host additionally sees **End Game** and **Play another round** buttons
- Given the `'awaiting_extra_round_decision'` screen is showing, when the host taps **End Game**, then the game transitions to `'finished'` and all players are taken to the win/lose results screen
- Given the `'awaiting_extra_round_decision'` screen is showing, when the host taps **Play another round**, then the round number increments (e.g. to 4), the hat refills with the original words, and the existing between-rounds and round-splash transition screens display as normal
- Given an extra round is in progress, when the hat empties, then the `'awaiting_extra_round_decision'` screen reappears — the host can continue adding rounds indefinitely
- Given a 5-round game completes, when the results screen is shown, then the stats reflect cumulative data across all 5 rounds (no per-round breakdown)
- Given a non-host player is on the decision screen, when the host has not yet acted, then the non-host sees only the informational text and no actionable buttons
- Given the **End Game** and **Play another round** actions, when called by a non-host player, then the server returns an appropriate error (consistent with how `advance-round` guards host-only actions)
- Given the zombie bot script is running, when an extra round begins, then bots drive turns and respond to game events identically to standard rounds
- Given the zombie bot script is running, when the host taps **End Game**, then the script exits cleanly on `'finished'` as it does today

## Open Questions

- Should the `end-game` host action be a new dedicated API endpoint (e.g. `POST /api/games/:joinCode/end-game`), or should `advance-round` be extended with an optional `{ end: true }` body parameter? A dedicated endpoint is cleaner but either works.

## Dependencies

- Blocked by: nothing
- Blocks: nothing

## Assumptions

- The `'awaiting_extra_round_decision'` status is a server-side state broadcast via SSE to all clients, not a client-local UI state — required so all players see the screen consistently
- "Play another round" reuses the existing `advance-round` endpoint (after the round-3 cap is removed), rather than requiring a new endpoint; the host-facing "Start Round N+1" button in `BetweenRoundsView` already wires up to this
- Host-only enforcement for both actions follows the same pattern already used by `advance-round`

## Technical Notes

The following are the exact code locations that need to change (identified during work item drafting):

- `shared/src/types.ts:55` — widen `round?: 1 | 2 | 3` to `round?: number`
- `server/src/store/Game.ts:17` — same widening on `GameSession` field
- `server/src/store/Game.ts:289` — `_resolveRoundEndStatus`: replace `round === 3 ? 'finished' : 'between_rounds'` with logic that emits `'awaiting_extra_round_decision'` when `round >= 3`
- `server/src/store/Game.ts:149` — remove the "Cannot advance beyond round 3" guard
- `server/src/store/Game.ts:156` — replace `(round === 1 ? 2 : 3)` ternary with `round + 1`
- `client/src/pages/GamePage.tsx` — add rendering path for `'awaiting_extra_round_decision'` status; `roundRuleText()` returns empty string for `round > 3`; widen `BetweenRoundsView` and `RoundSplashOverlay` prop types from `1 | 2 | 3` to `number`
- New server action for "End Game" from the decision screen (endpoint TBD per Open Questions)
- `scripts/test-driver.ts` — no changes required; confirmed round-agnostic

## Drafting Notes

- The trigger is `round >= 3` (not `round === 3`) in `_resolveRoundEndStatus` so the logic is correct for round 4, 5, etc. without further changes
- Extra rounds intentionally have no server-defined rule text — `roundRuleText()` returning empty for `round > 3` is by design, matching the requirement that house rules are set verbally by the host
- Stats accumulation requires no changes — `Hat._originalWords.guessTimes` and `Player.stats.clueGiverCount` are already cumulative across all rounds; the stats pipeline has no per-round partitioning
- The zombie script's `process.exit(0)` on `'finished'` means it naturally stays alive through `'awaiting_extra_round_decision'` and resumes play if a new round is started — confirmed via code review of `scripts/test-driver.ts`

## References

- Related: ENG-022 (server-synchronised countdown timer — same SSE/status event pattern)
