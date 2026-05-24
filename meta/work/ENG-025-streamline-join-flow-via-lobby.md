---
work_item_id: "ENG-025"
title: "Streamline Join Flow via Lobby"
date: "2026-05-24T15:03:10+00:00"
author: Anthony Scatchell
type: story
status: draft
priority: medium
parent: ""
tags: [frontend, ux, refactor]
---

# ENG-025: Streamline Join Flow via Lobby

**Type**: Story
**Status**: Draft
**Priority**: Medium
**Author**: Anthony Scatchell

## Summary

As a player joining a game, I want to see the lobby — including which teams other players are on — before committing to a team, so that I can make a balanced choice without out-of-band coordination.

Currently the join flow routes players through a dedicated `/join` page where they must pick a team blind, with no visibility of the current team composition. This story moves name entry and team selection into the lobby page itself, simplifies the `/join` page to a code-only entry point, and cleans up the now-dead code that supported the old flow.

## Context

The existing join flow has two entry points:

- `/join?code=ABCDEF` — a form collecting game code, player name, and team selection in sequence.
- `/lobby/:code` — the live lobby view, which shows a "Want to play? Join this game" anchor that redirects back to `/join?code=ABCDEF`.

Both paths require the player to select a team on `/join` before they can see who is already on which team. There is also no way to switch teams or leave, so the first choice is irreversible.

The lobby page already receives live SSE updates (player lists, word counts, game settings) via `useGameState`, so it has all the information needed to let a player make an informed team choice on the same page. Moving the join UI into the lobby eliminates a page round-trip, exposes live team composition before commitment, and removes the now-redundant join-specific code from both the client and the `/join` page.

Related: ENG-021 (duplicate player name prevention — validation logic moves surface from `/join` to lobby).

## Requirements

1. **Copy button produces a full lobby URL**: The copy button next to the game code badge on the lobby page copies `window.location.origin + '/lobby/' + joinCode` rather than the bare code string.

2. **Lobby join UI for non-participants**: When a visitor arrives at `/lobby/:code` without an active session for this game, they see the full live lobby (team columns, player names, word count, game settings) plus a "Want to play?" section at the top containing a username text input.

3. **Per-team join buttons**: A "Join [Team Name]" button is rendered below each team column. Both buttons are disabled until the username input contains at least one non-whitespace character; they become enabled and styled green once a valid username is entered.

4. **Joining from the lobby**: Clicking a team's join button POSTs to `POST /api/games/:joinCode/players` with the entered username (trimmed) and the selected team. On HTTP 201, the session is saved via `saveSession` and the join UI is hidden — the user is now a participant in the live lobby view.

5. **Duplicate name error handled inline**: If the server returns a `NAME_TAKEN` (HTTP 409) response, an inline error message is displayed near the username input. The user stays on the lobby page; no redirect occurs.

6. **`/join` page simplified to code-only entry**: The `/join` page retains only the game code input. It still calls `GET /api/games/:code` to verify the code exists before navigating. On success it navigates to `/lobby/:code`. The name input, team selector (`TeamSelector`), and team-names fetch `useEffect` are removed.

7. **Old lobby anchor removed**: The `<a href="/join?code=${joinCode}">Join this game</a>` anchor in `LobbyPage.tsx` is removed and replaced by the inline join UI.

8. **Dead code removed**:
   - `TeamSelector` removed from `JoinPage.tsx` (component itself is kept — still used in `CreateGamePage`).
   - Team-names `useEffect` (the `GET /api/games/${code}` prefetch) removed from `JoinPage.tsx`.
   - Name and team state, submit handler, and `saveSession` call removed from `JoinPage.tsx`; `saveSession` and `NAME_TAKEN` handling move to the lobby join flow.

## Acceptance Criteria

- Given I am a visitor on `/lobby/:code` with no session for this game, when the page loads, then I see a "Want to play?" label and a username text input — no "Join this game" hyperlink is present.
- Given the username input is empty or whitespace-only, when I view the team join buttons, then both buttons are disabled and not styled green.
- Given I have typed at least one non-whitespace character into the username input, when I view the team join buttons, then both buttons are enabled and styled green.
- Given I have entered a username and click "Join [Team 1]", then I am added to Team 1, the join UI (username input and both team buttons) disappears, and I remain on the lobby page continuing to receive live SSE updates as a participant.
- Given I click "Join [Team 2]" instead, then the same outcome occurs for Team 2.
- Given the username I entered matches an existing player's name (case-insensitive, trimmed), when I click a join button, then an inline error appears near the username input and I remain on the lobby page with no redirect.
- Given I am already a participant in this game (session exists), when I visit `/lobby/:code`, then no join UI is shown.
- Given I click the copy button on the lobby page, then the clipboard contains a full URL of the form `https://<domain>/lobby/<code>` — not just the bare code.
- Given I navigate to `/join?code=ABCDEF`, then the page shows only a game code input (no name or team fields), and submitting a valid code navigates me to `/lobby/ABCDEF`.
- Given I submit an invalid or non-existent code on the `/join` page, then an error is shown and I am not navigated away.
- Given the `JoinPage.tsx` source, then it contains no `TeamSelector`, no name state, no team state, no team-names fetch, and no `saveSession` call.

## Open Questions

- Should the `/join` page re-use the same `GET /api/games/:code` call it used to make for team names (now repurposed as a code-exists check), or is a lighter validation endpoint preferable? The existing endpoint returns the full game snapshot, which may be heavier than needed for a simple existence check — but introducing a new endpoint is also scope. Implementer should decide based on what's simplest.

## Dependencies

- Blocked by: none
- Blocks: none

## Assumptions

- The `GET /api/games/:joinCode` endpoint is kept as-is (used by `useGameState` and other callers); only the `/join` page's client-side invocation of it changes.
- The join UI is implemented inline within `LobbyPage.tsx` rather than extracted to a separate component, unless the implementer judges a `JoinPanel` component cleaner. Either is acceptable.

## Technical Notes

- Copy button: `LobbyPage.tsx` lines 45–51. Replace `navigator.clipboard.writeText(joinCode)` with `navigator.clipboard.writeText(\`${window.location.origin}/lobby/${joinCode}\`)`.
- Lobby "Join this game" anchor: `LobbyPage.tsx` lines 102–109 — remove the `<a>` tag and replace with the inline join UI, gated on `!currentPlayerId`.
- Join endpoint: `POST /api/games/:joinCode/players` (`server/src/routes/games.ts` line 374) — no changes required; it already accepts `{ name, team }`.
- `NAME_TAKEN` error: currently handled in `JoinPage.tsx:55`; move equivalent logic to the lobby join handler.
- `saveSession`: currently called at `JoinPage.tsx:64`; move to the lobby join success handler.
- `TeamSelector` import and usage in `JoinPage.tsx:5,118` — remove; component stays in `CreateGamePage.tsx:78`.
- Team-names `useEffect` in `JoinPage.tsx` lines 18–30 — remove; replace with a leaner code-validation call that only checks existence.
- SSE subscription via `useGameState` in `LobbyPage.tsx:22` — no changes required; non-participant visitors already receive SSE events.

## Drafting Notes

- "Simplified /join page" is interpreted as: keep game code input and existence validation, remove name/team fields. The page still needs a server call to verify the code before navigating — confirmed by the user.
- "Join buttons disappear once joined" is interpreted as conditional render on `!currentPlayerId`, consistent with how the existing "Join this game" link is already gated in `LobbyPage.tsx`.
- Story tagged `refactor` alongside `frontend` and `ux` because explicit dead-code removal is a stated requirement, not an implementation side-effect.
- Priority set to `medium` — meaningful UX improvement but does not block gameplay.
- Team switching and leaving a game are explicitly out of scope per user direction; separate stories will cover those.

## References

- Related: ENG-021 (duplicate player name prevention — `NAME_TAKEN` validation surface moves from `/join` to lobby)
