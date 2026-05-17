---
work_item_id: "ENG-021"
title: "Prevent Duplicate Player Names in Lobby"
date: "2026-05-17T16:10:08+00:00"
author: John Cowie Del Corral
type: story
status: draft
priority: medium
parent: ""
tags: [validation, lobby, backend, frontend]
---

# ENG-021: Prevent Duplicate Player Names in Lobby

**Type**: Story
**Status**: Draft
**Priority**: Medium
**Author**: John Cowie Del Corral

## Summary

As a player joining a game lobby, I want to be told immediately if my chosen
name is already taken, so that I can pick a unique name and avoid confusion
during play.

Currently nothing prevents two players from joining with the same (or
near-identical) name. This causes ambiguity in the lobby and during the game
itself, where players are identified by name.

## Context

Players join a game by submitting a form with a join code, their name, and
their team. The server adds them to an in-memory `game.players[]` array and
notifies all lobby watchers via SSE. There is currently no check that the
submitted name is unique among existing players.

Name equality must be insensitive to casing, leading/trailing whitespace, and
runs of internal whitespace — so "Alice", "alice", "  Alice  ", and
"Alice  Smith" vs "Alice Smith" are all treated as collisions.

## Requirements

- When a player submits the join form, their name is normalised and compared
  against the normalised names of all current players in that lobby.
- Normalisation: trim outer whitespace, collapse internal whitespace runs to a
  single space, lowercase — i.e. `name.trim().toLowerCase().replace(/\s+/g, ' ')`.
- If the normalised incoming name matches any existing player's normalised name,
  the join is rejected.
- The authoritative check lives server-side in `joinGame`
  (`InMemoryGameStore.ts`), to guard against concurrent joins.
- The server returns `409 Conflict` with an error code of `NAME_TAKEN` in the
  response body (distinct from the existing `GAME_IN_PROGRESS` 409).
- The client surfaces the error inline on the join form — the player stays on
  the page and sees: "That name is already taken — please choose another."
- If a player leaves the lobby their name is freed and may be claimed by a
  subsequent joiner.

## Acceptance Criteria

- Given a lobby with a player named "Alice", when a second player submits the
  join form with the name "alice", then the join is rejected and the form
  displays "That name is already taken — please choose another."
- Given a lobby with "Alice", when a second player submits "  alice  " (padded
  whitespace), then the join is rejected with the same error.
- Given a lobby with "Alice Smith", when a second player submits "alice  smith"
  (double internal space), then the join is rejected.
- Given a lobby with "Alice", when a second player submits "Bob", then the join
  succeeds and Bob appears in the lobby.
- Given "Alice" has left the lobby, when a new player submits "Alice", then the
  join succeeds.
- Given the server rejects the name, the join form remains open and the player
  can correct their name and resubmit.
- Given the server rejects with `NAME_TAKEN`, the client does not navigate away
  from the join page.

## Open Questions

## Dependencies

- Blocked by:
- Blocks:

## Assumptions

- "Player has left" means their entry is removed from `game.players[]`. If the
  leave flow marks players inactive rather than removing them, this assumption
  breaks and the uniqueness check would need to filter by active status.
- `409 Conflict` is the appropriate status code for a taken name, consistent
  with the existing `409` returned for `GAME_IN_PROGRESS`.

## Technical Notes

- Server check: `server/src/store/InMemoryGameStore.ts` — `joinGame` method
  (~line 196). Add a normalisation helper and check `game.players` before
  pushing the new player.
- New error code `NAME_TAKEN` needed; existing `GAME_IN_PROGRESS` already
  demonstrates the pattern in `server/src/routes/games.ts:378-400`.
- Client error handling: `client/src/pages/JoinPage.tsx` — the `POST` response
  handler (~line 44-67) needs to detect the `NAME_TAKEN` 409 and set a form
  error state rather than navigating away.
- `GameStore.ts` interface contract may need updating if the interface defines
  the signature of `joinGame`.

## Drafting Notes

- Normalisation function `name.trim().toLowerCase().replace(/\s+/g, ' ')` is
  applied to both the incoming name and all existing player names at check time.
  If the normalisation spec changes, both sides must stay in sync.
- Two separate `409` responses are in play (game started vs name taken); the
  distinguishing mechanism is a typed error code in the response body. If the
  client currently checks only the HTTP status (not the body) for the
  game-started case, that handling may need auditing to avoid a false "name
  taken" message when a game is already in progress.

## References

- Related: ENG-002 (join a game flow)
