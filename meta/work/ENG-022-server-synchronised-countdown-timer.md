---
work_item_id: "ENG-022"
title: "Server-Synchronised Countdown Timer"
date: "2026-05-17T17:56:55+00:00"
author: John Cowie Del Corral
type: story
status: draft
priority: medium
parent: ""
tags: [frontend, backend, real-time, performance]
---

# ENG-022: Server-Synchronised Countdown Timer

**Type**: Story
**Status**: Draft
**Priority**: Medium
**Author**: John Cowie Del Corral

## Summary

As a player, I want the countdown timer to stay in sync across all devices,
so that the end of a turn is unambiguous and doesn't cause disputes.

Currently, every client computes remaining time as
`Date.now() - Date.parse(turnStartedAt)`. Because `turnStartedAt` is a
server-side timestamp and `Date.now()` is the client's local clock, any
difference between a device's clock and the server clock produces visible
drift. Consumer devices can be off by hundreds of milliseconds to several
seconds, which is enough to cause disagreement at turn end.

## Context

The server already records `turnStartedAt` (a server-side ISO timestamp) when
a turn becomes active via `readyTurn()` (`InMemoryGameStore.ts`), and
broadcasts it to all clients in every SSE game state update. The fix is not to
change the SSE architecture but to correct each client's clock offset relative
to the server before computing elapsed time.

The clue-giver's client runs a 500ms polling interval
(`GamePage.tsx:159-185`) that detects expiry and fires `POST /end-turn`. Other
clients' timers are cosmetic. Applying the clock offset to the clue-giver's
polling loop is therefore critical, not just a display concern.

Research into NTP-style browser clock sync confirms that 3–5 HTTP ping
exchanges (measuring round-trip time and deriving server–client offset) can
achieve 20–50ms accuracy on typical internet connections — well within the
target of sub-500ms agreement. The `timesync` npm library implements this
approach out of the box.

Server-side turn enforcement (auto-ending a hung turn if the clue-giver
disconnects) is a related but distinct concern and is captured in a separate
work item.

## Requirements

- Add a `GET /api/time` endpoint that returns the current server timestamp
  (unauthenticated, no game context required).
- On game page mount, each client runs a clock offset measurement using the
  `timesync` library: 3–5 ping exchanges to `/api/time`, median-filtered to
  remove RTT outliers, producing a `clockOffset` value in milliseconds.
- The offset measurement repeats every 2 minutes for the duration of the
  session.
- All elapsed-time calculations are updated to apply the offset:
  `elapsed = (Date.now() + clockOffset) - Date.parse(turnStartedAt)`.
- This applies to both: (a) `TurnTimer.tsx` (visual countdown display) and
  (b) the `ClueGiverView` polling interval in `GamePage.tsx` (which fires
  `end-turn`).
- If the clock offset measurement fails (network error or timeout), the client
  falls back to `clockOffset = 0` (current behaviour) with no crash or hang.

## Acceptance Criteria

- Given two devices whose system clocks differ by up to 5 seconds, when a
  turn starts, both devices display a timer value within 500ms of each other
  throughout the duration of the turn.
- Given a client that joins mid-turn, the timer initialises to the correct
  remaining time (accounting for clock offset) rather than the full turn
  duration.
- Given the clock offset measurement fails, the client falls back to raw
  `Date.now()` (offset = 0) gracefully — no crash, no hang, no visible error.
- Given a turn expires, the clue-giver's `end-turn` POST fires within 500ms
  of the true deadline as measured by server time.
- Given the session has been active for more than 2 minutes, the clock offset
  is re-measured and updated without interrupting gameplay.

## Open Questions

## Dependencies

- Blocked by:
- Blocks:

## Assumptions

- `timesync` is an acceptable new client dependency. If the team prefers zero
  new dependencies, the equivalent ping logic (~20 lines) can be implemented
  inline — this is in scope to do instead.
- The `/api/time` endpoint is unauthenticated; no game context or session is
  required to call it.
- "Sub-500ms sync" means all devices display timer values within 500ms of each
  other, not 500ms of true wall-clock time.

## Technical Notes

- Current timer display: `client/src/components/TurnTimer.tsx:10-13` —
  `initialRemainingTime` computed from `Date.now() - Date.parse(turnStartedAt)`.
- Current expiry detection: `client/src/pages/GamePage.tsx:159-185` —
  500ms interval computing `elapsed = Date.now() - Date.parse(game.turnStartedAt!)`.
  Both of these must use the corrected formula.
- `timesync` supports HTTP transport; the ping endpoint needs to return a JSON
  body with at least a `{ now: <epoch ms> }` field (or the library's expected
  shape — check docs).
- Recommended: drive the visual countdown with `requestAnimationFrame` rather
  than the library's internal `setInterval`, which drifts under CPU load.
  `Date.now()` continues accurately even when the tab is backgrounded.
- Server-side turn enforcement (auto-ending hung turns) is out of scope — see
  separate work item.

## Drafting Notes

- "Sub-500ms sync" interpreted as agreement between devices, not absolute
  accuracy against true wall-clock time.
- The clue-giver's 500ms polling loop (`GamePage.tsx:159-185`) is the
  functional enforcement point — it must use the offset-corrected elapsed
  time, not just the display component.
- 2-minute re-sync interval is based on research recommendation (client clocks
  drift ~50ms per 10 minutes); user confirmed this feels appropriate for
  typical session length.
- Treating server-side hung-turn enforcement as a separate ticket per user
  instruction.

## References

- Related: ENG-012 (round 1 timer and turn rotation)
- Research: [timesync npm library](https://github.com/enmasseio/timesync)
- Research: [Syncing Countdown Timers Across Multiple Clients](https://medium.com/@flowersayo/syncing-countdown-timers-across-multiple-clients-a-subtle-but-critical-challenge-384ba5fbef9a)
- Research: [Game Networking (2): Time, Tick, Clock Synchronisation](https://daposto.medium.com/game-networking-2-time-tick-clock-synchronisation-9a0e76101fe5)
