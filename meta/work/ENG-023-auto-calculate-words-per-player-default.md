---
work_item_id: "ENG-023"
title: "Auto-Calculate Words-Per-Player Default in Lobby"
date: "2026-05-18T21:09:59+00:00"
author: Anthony Scatchell
type: story
status: draft
priority: medium
parent: ""
tags: [frontend, lobby, host, settings, ux]
---

# ENG-023: Auto-Calculate Words-Per-Player Default in Lobby

**Type**: Story
**Status**: Draft
**Priority**: Medium
**Author**: Anthony Scatchell

## Summary

As a game host, I want the words-per-player setting to be automatically calculated based on the number of players in the lobby, so that the game reaches a good total word count without me having to think about it.

Currently the words-per-player input defaults to a hardcoded 3. This story replaces that static default with a dynamic calculation that aims for a configurable target total word count (defaulting to 30), recalculated in real-time as players join — while leaving the host free to override it manually at any time.

## Context

The host lobby shows an editable words-per-player input (`GameSettingsPanel` in `LobbyPage.tsx`). Its value is initialised from `settings.wordsPerPlayer`, which is stamped from `DEFAULT_GAME_CONFIG.wordsPerPlayer` (currently `3`) in `server/src/config.ts` when the game is created.

Player joins are broadcast in real-time via SSE; the full game state is replaced in `useGameState.ts` on each event, and `GameSettingsPanel` already has a `useEffect` (line 362) that syncs the input when `settings.wordsPerPlayer` changes externally. The floor protection — preventing a reduction below the highest word count already submitted by any player — is enforced server-side in `InMemoryGameStore.updateSettings()`, returning HTTP 409 on conflict.

This feature is purely a client-side lobby UX improvement. It does not change gameplay, server-side defaults, or the floor-protection logic.

## Requirements

- A pure utility function `calculateDefaultWordsPerPlayer(playerCount: number, targetTotal?: number): number` is created on the client side, encapsulating the formula and clamp logic. This is the single authoritative place for the calculation.
- The target total word count (currently 30) is extracted as a named constant — `DEFAULT_TARGET_WORD_COUNT` — in a client-side configuration file (e.g. `client/src/config.ts` or equivalent), so it can be adjusted without hunting through logic code.
- The formula is: `clamp(round(targetTotal / playerCount), 3, 10)`, where the clamp bounds (min 3, max 10) are also named constants.
- `GameSettingsPanel` tracks a `hasManuallyEdited` boolean flag (React state), initialised to `false`, and set to `true` the first time the host changes the input value.
- On each SSE-driven update that changes the player count:
  - If `hasManuallyEdited` is `true`, skip auto-calculation entirely.
  - If `hasManuallyEdited` is `false`, compute the new value. If no player has already submitted more words than the new value (mirroring the server-side floor check), update the input and call the save API with the new value.
- The hint text below (or alongside) the input reflects current state:
  - When auto-calculated: *"Auto-calculated based on {n} players"*
  - When manually edited: *"Manually set — auto-calculation paused"*
- The server-side `DEFAULT_GAME_CONFIG.wordsPerPlayer` in `server/src/config.ts` remains unchanged at `3`. The auto-calculated value is applied by the host client via the existing settings update API after the lobby is created.

## Acceptance Criteria

- Given the lobby has 5 players and the host has not edited the input, when a 6th player joins, then the words-per-player input updates to 5 (round(30/6)) and the hint reads "Auto-calculated based on 6 players".
- Given the host has manually changed the input to 7, when a new player joins, then the input remains at 7 and the hint reads "Manually set — auto-calculation paused".
- Given one player has already submitted 4 words and a new player joins such that the formula produces 3, then the input is NOT auto-updated (3 < 4 submitted words) and the current value is preserved.
- Given the lobby has 2 players, then the input shows 10 (formula 30/2=15, clamped to max 10).
- Given the lobby has 12 players, then the input shows 3 (formula 30/12=2.5, rounded to 3, clamped to min 3).
- The `calculateDefaultWordsPerPlayer` function has unit tests covering: target result, min clamp (3), max clamp (10), rounding behaviour, and custom `targetTotal` override.
- `DEFAULT_TARGET_WORD_COUNT` exists in a client-side config file and is the only place the number 30 appears in relation to this calculation.

## Open Questions

- If a player *leaves* the lobby before the game starts (if that flow exists), should the auto-calculation also re-run upward? Upward adjustment cannot violate the floor, so it is safe — but worth confirming the intended UX.

## Dependencies

- Blocked by: none
- Blocks: none

## Assumptions

- `hasManuallyEdited` is session-scoped in-memory React state — it resets if the host refreshes the page. This is intentional; a refreshed page re-derives the auto-calculated value from current player count.
- The client-side floor check reads `game.players.some(p => p.wordCount > newValue)` (strictly greater than), mirroring the server-side guard in `InMemoryGameStore.updateSettings()`. Setting to exactly a player's submitted count is allowed.
- No "reset to auto" affordance is provided. Once the host manually edits the value, auto-calculation stays paused for the session.

## Technical Notes

- `calculateDefaultWordsPerPlayer` should live in a dedicated utils file (e.g. `client/src/utils/gameSettings.ts`) to keep it independently testable.
- Relevant files: `client/src/pages/LobbyPage.tsx` (GameSettingsPanel, lines 351–453), `client/src/hooks/useGameState.ts`, `server/src/config.ts`.
- The `useEffect` at `LobbyPage.tsx:362` currently syncs the input when `settings.wordsPerPlayer` changes from an external SSE push. The auto-calculation trigger should watch player count (e.g. `game.players.length`) rather than `settings.wordsPerPlayer` to avoid a feedback loop.

## Drafting Notes

- "Admin" interpreted as the game host/creator — the player who created the lobby, guarded by the existing `isHost` check in `GameSettingsPanel`.
- The configurable constant (`DEFAULT_TARGET_WORD_COUNT`) is placed client-side rather than server-side because the auto-calculation is a client lobby UX feature. If a server-side config location (e.g. `server/src/config.ts`) is preferred for consolidation, that is a valid alternative — but it would require the value to be surfaced to the client via the game state API.
- The formula uses `Math.round` rather than `Math.floor` or `Math.ceil`. This was chosen as the most natural approximation of "approximately 30 total". If the product owner prefers always rounding up (erring toward more words), `Math.ceil` could be substituted without other changes.

## References

- Related: ENG-021, ENG-022
