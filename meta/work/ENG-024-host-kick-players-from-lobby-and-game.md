---
work_item_id: "ENG-024"
title: "Host Can Kick Players from Lobby and Active Game"
date: "2026-05-20T12:59:39+00:00"
author: Anthony Scatchell
type: story
status: draft
priority: medium
parent: ""
tags: [host, game-management, lobby, multiplayer]
---

# ENG-024: Host Can Kick Players from Lobby and Active Game

**Type**: Story  
**Status**: Draft  
**Priority**: Medium  
**Author**: Anthony Scatchell

## Summary

As a game host, I want to remove a player from the game at any time (lobby or mid-game), so that a disconnected or unresponsive player does not block the game from continuing.

Currently there is no way to remove a player once they have joined. If a player's connection dies mid-game, the game can stall indefinitely on their turn. This feature gives the host a manual escape hatch.

## Context

The server uses Server-Sent Events (SSE) for real-time state broadcast. There is no persistent connection tracking — the server cannot detect that a player's browser has closed. Player removal must therefore be a deliberate host action rather than automatic disconnection detection.

Players join via a random UUID (`playerId`) which is stored client-side and sent with every request. The host is identified by `game.hostId`, set once at game creation. All existing host-gated operations (`advanceRound`, `updateSettings`, `updateTeamName`) validate the caller by comparing the `playerId` in the request body against `game.hostId` — the new kick endpoint will follow the same pattern.

Turn rotation is managed via `clueGiverIndices` (a per-team modular index into the team's player array). Removing a player from the middle of that array can leave the index out of bounds; the store method must recalculate the index after removal.

## Requirements

- A new `kickPlayer(joinCode, hostPlayerId, targetPlayerId)` store method that:
  - Validates the caller is the host (throws `FORBIDDEN` otherwise, returning HTTP 403)
  - Validates the target is not the host (host cannot kick themselves)
  - Removes the target from `game.players`
  - Recalculates `clueGiverIndices[team] % newTeamSize` to prevent out-of-bounds after removal
  - If the game is active and the kicked player is the current clue giver, advances the turn via normal rotation to the next eligible player
  - If the game is active and kicking leaves either team with 0 players, transitions the game to the `finished` state
  - Broadcasts the updated state to all SSE subscribers
- A new `DELETE /:joinCode/players/:targetPlayerId` HTTP endpoint (host-only); `playerId` of the caller sent in the request body
- A small "Manage Players" button accessible on the host's view in both the **lobby** and the **active game** screens
- An admin panel (modal or page) listing all players except the host, with a kick/boot icon per player
- A confirmation dialog before each kick: "Are you sure you want to kick [name] out of the game?"
- Kicked player's words remain in the hat and stay in play; their historical stats (`clueGiverStats`) are preserved
- All remaining SSE-connected clients receive the updated `game.players` list immediately after a kick

## Acceptance Criteria

- Given the host is on any game screen (lobby or active game), when they open the "Manage Players" panel, then every player except the host is listed with a kick icon
- Given the host clicks the kick icon for player X and confirms the dialog, when the server processes the `DELETE` request, then player X is removed from `game.players` and all connected clients immediately see the updated player list
- Given a non-host player sends a `DELETE` request for a player, when the server receives it, then it returns HTTP 403 and no player is removed
- Given the host attempts to kick themselves (e.g. via direct API call), when the server receives it, then it returns an error and the host is not removed
- Given a kicked player's words are in the hat at the time of kick, when the kick is processed, then those words remain in play for the remainder of the game
- Given the kicked player is currently the active clue giver during an active game, when kicked, then the current turn ends and the next player in the normal rotation becomes the clue giver
- Given the kicked player is not the active clue giver, when kicked during an active game, then the current turn continues uninterrupted
- Given a kick during an active game that leaves either team with zero active players, when the kick is processed, then the game transitions to the finished state and all connected clients navigate to the results/end screen
- Given a kick during the lobby, when processed, then the lobby player list updates for all connected clients and the game can still be started normally

## Open Questions

- Should the admin panel be accessible during the between-rounds phase (host is advancing the round)? Assuming yes — same host view — but worth confirming.

## Dependencies

- Blocked by: none
- Blocks: none

## Assumptions

- Minimum team size (2 per team) applies only at game-start validation; kicking mid-game can reduce a team below this minimum. The only hard guard is the "0 players on either team → end game" rule.
- Kicking is intentionally manual. Automatic disconnection detection is out of scope for this story (the server has no socket-to-player mapping).

## Technical Notes

- `clueGiverIndices` recalculation: after removing a player, do `clueGiverIndices[team] = clueGiverIndices[team] % newTeamPlayers.length` — if `newTeamPlayers.length` is 0, skip (game is ending).
- The "0 players on either team" guard should fire on the target player's team only; the other team is unaffected. If a team reaches 0, transition `game.status` to `finished` before broadcasting.
- `clueGiverStats` is keyed by `playerId` and lives only in the in-memory store session; removing from `game.players` leaves it untouched.
- Host validation pattern to follow: add `playerId` to the `DELETE` request body; inside `kickPlayer()`, check `if (game.hostId !== playerId) throw new AppError('FORBIDDEN', 'Only the host can kick players')`.

## Drafting Notes

- "Dead connections" motivation: the server cannot detect disconnections. The kick feature is manual — hosts must notice and act themselves.
- Lobby support added at user request after initial draft; the admin panel and server endpoint are game-phase-agnostic by design.
- "0 active players" guard: user mentioned 0 players total, but the real structural risk is 0 players on either team (rotation divides by team size). Guard is implemented per-team; the outcome (end game) is the same.
- Stats persistence noted as a requirement but is a free consequence of only removing from `game.players`, not from `clueGiverStats`.

## References

- Source: `host-settings.md`
- Related: ENG-022 (server-synchronised countdown timer — turn lifecycle context)
