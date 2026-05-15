---
work_item_id: "ENG-018"
title: "Zombie Player Test Driver Script"
date: "2026-05-15T15:07:47+00:00"
author: Anthony Scatchell
type: task
status: draft
priority: medium
parent: ""
tags: [tooling, testing, developer-experience]
---

# ENG-018: Zombie Player Test Driver Script

**Type**: Task
**Status**: Draft
**Priority**: Medium
**Author**: Anthony Scatchell

## Summary

A TypeScript CLI script that joins a wordfetti game as 3 automated "zombie" players,
drives them through the full game lifecycle, and allows a single developer to manually
test gameplay features (timer, scoring, round transitions, etc.) from one browser tab
without co-ordinating real players.

## Context

Manual testing of in-game features requires a minimum of 4 players (2 per team), live
SSE connections, and active clue-giving turns. Setting up 4 browser tabs with distinct
identities and coordinating their actions is slow and error-prone, making iterative
testing of features like the timer, scoring, and round transitions painful.

The game exposes a plain REST+SSE API. A lightweight out-of-process script can join as
fake players, subscribe to game state via SSE, and react to state changes automatically
— no changes to the production server required.

## Requirements

The script lives at `scripts/test-driver.ts` and is invoked with:

```
npx tsx scripts/test-driver.ts <joinCode> [options]
```

**CLI interface**:
- `<joinCode>` — required positional argument; the join code for an existing game in lobby state
- `--url <baseUrl>` — base URL of the API server, default `http://localhost:3000`
- `--turn-delay <ms>` — milliseconds between each zombie action during a turn, default `500`
- `--skip-chance <percent>` — integer 0–100; probability a zombie skips rather than guesses a word, default `10`

**Word list**:
- A plain text file at `scripts/test-words.txt`, one word per line
- Leading/trailing whitespace trimmed when read; blank lines ignored
- List is hardcoded in the script; no flag to override the path

**Lifecycle**:
1. Read current game state via `GET /api/games/:joinCode`
2. Join as 3 zombies with names "Bot 1", "Bot 2", "Bot 3"; assign teams greedily to balance player counts (producing a 2v2 when the real player is already in the game)
3. Each zombie submits `settings.wordsPerPlayer` words, drawn randomly from the word list
4. Open a single SSE connection (`GET /api/games/:joinCode/events`) and react to all state changes
5. When `status` becomes `in_progress` and `currentClueGiverId` is a zombie, that zombie drives its turn:
   - Call `POST /ready`
   - Loop: roll `--skip-chance`% probability — call `POST /skip` or `POST /guess` — sleep `--turn-delay` ms — repeat until the word changes to `undefined` (hat empty) or `turnPhase` returns to `ready` (timer expired)
6. Between rounds (`status === 'between_rounds'`): log that the round ended and wait for the host to advance it
7. When `status === 'finished'`: log a summary and exit with code 0

**Logging**: each state transition and zombie action is printed to stdout in a simple
human-readable format so the developer can follow along without opening the game.

**SSE dependency**: uses the `eventsource` npm package (not native Node EventSource) for
compatibility across Node versions.

## Acceptance Criteria

- Given a game in lobby state with the real player already joined, when the script runs
  with the join code, then 3 zombie players appear in the lobby within 2 seconds and
  the teams are balanced (2 players per team)
- Given zombies have joined the lobby, when the host navigates to the lobby page, then
  all 3 bots are visible with names "Bot 1", "Bot 2", "Bot 3" and each has submitted
  the required number of words before the start button becomes active
- Given it is a zombie's turn as clue giver, when the script receives that state via SSE,
  then the zombie calls `readyTurn` automatically and begins processing words after
  `--turn-delay` ms
- Given a zombie is processing words, then it skips with probability equal to
  `--skip-chance`% and guesses otherwise, independently for each word
- Given `--turn-delay 100`, when a zombie is clue giver, then it processes words
  roughly every 100ms, likely emptying the hat in a single turn
- Given 3 complete rounds finish and `status === 'finished'`, then the script exits
  with code 0 and prints a summary line
- Given `--url https://staging.example.com`, when the script starts, then all HTTP
  requests and the SSE subscription target that host
- Given `--skip-chance 0`, then zombies always guess and never skip

## Open Questions

- Should the script be added to `package.json` as a named script (e.g. `"zombie": "tsx scripts/test-driver.ts"`) for discoverability, or is `npx tsx` sufficient for now?

## Dependencies

- Blocked by: none
- Blocks: nothing

## Assumptions

- The real player creates the game first and is the host; zombies join an existing game and are never the host
- Round advancement (`POST /advance-round`) is performed manually by the real player — zombies do not need to handle it
- The script talks directly to the Express API server (port 3000 by default), bypassing the Vite dev-server proxy
- Word list duplicates across bots are acceptable — each bot samples independently with replacement

## Technical Notes

- SSE client: `eventsource` npm package. Add as a dev dependency.
- Run with `tsx` (already used in the project's test toolchain via vitest).
- The bot reacts to state changes reactively via the SSE stream rather than polling, avoiding race conditions from independent timers.
- The client-side timer (clue-giver's browser fires `end-turn` when expired) does not apply to zombies — a zombie turn ends either when the hat empties (`currentWord` becomes `undefined`) or `turnPhase` reverts to `'ready'` (the real player's browser fired `end-turn` if the zombie was too slow). The script should detect both exit conditions.
- Team balancing: after joining, read `game.players`, count each team, assign the next bot to the team with fewer players. Ties broken by always assigning to team 1 first.

## Drafting Notes

- `--url` is treated as the API base (e.g. `http://localhost:3000`), not the Vite dev server. The script constructs `/api/games/...` paths relative to this.
- `--skip-chance` replaces the fixed 10% skip probability from the brainstorm — parameterising it is low-cost and useful for stress-testing (0 = always guess, 100 = always skip).
- Zombie names "Bot 1 / Bot 2 / Bot 3" chosen for clarity over realism; easy to spot in the lobby.
- Word list as a `.txt` flat file (newline-separated) rather than a `.ts` module — simpler to edit without touching TypeScript.

## References

- Related: ENG-012 (timer and turn rotation logic the script must react to)
- Related: ENG-011 (guess/skip mechanics the script drives)
- Research: `eventsource` npm package — recommended SSE client for Node.js CLI tooling (v3+, TypeScript types included)
