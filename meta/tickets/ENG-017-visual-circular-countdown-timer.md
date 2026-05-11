---
work_item_id: "ENG-017"
title: "Visual Circular Countdown Timer for All Players During Active Turns"
date: "2026-05-11T15:48:50+00:00"
author: Anthony Scatchell
type: story
status: draft
priority: medium
parent: ""
tags: [frontend, ui, gameplay, mobile]
---

# ENG-017: Visual Circular Countdown Timer for All Players During Active Turns

**Type**: Story
**Status**: Draft
**Priority**: Medium
**Author**: Anthony Scatchell

## Summary

As a player in any role, I want to see a circular countdown timer on my screen during an active turn, so that I always know how much time is left and can play the game without having to guess.

Currently, a functional turn timer exists (driven by `turnStartedAt` and `game.settings.turnDurationSeconds`) but is only displayed to the clue giver as a small grey text label. Guessers, spectators, and the opposing team see nothing. This work item adds a large, mobile-friendly circular visual timer — using `react-countdown-circle-timer` — visible to all players during any active turn, with role-appropriate contextual labels.

## Context

The underlying timer mechanism was implemented in ENG-012. The server records an ISO timestamp (`turnStartedAt`) the moment the clue giver clicks "Start Turn". Every client derives remaining seconds from wall-clock arithmetic against that timestamp. State is distributed via Server-Sent Events (SSE): all connected clients receive `turnStartedAt` immediately, and any client joining mid-turn receives it in the initial HTTP snapshot — meaning late-joiner sync is already solved without additional work.

The game is played on mobile devices. The timer must be large enough to be read at a glance on a small screen. The `react-countdown-circle-timer` library (v3) is compatible with React 18 and supports `initialRemainingTime` (for mid-turn sync), `colors`/`colorsTime` (for green→red transition), and a render-prop child for displaying the digit in the centre of the ring.

## Requirements

- Install `react-countdown-circle-timer` as a client dependency
- Create a shared `TurnTimer` component that:
  - Accepts `duration` (`game.settings.turnDurationSeconds`) and `turnStartedAt` (ISO string)
  - Computes `initialRemainingTime` at mount as `Math.max(0, duration - Math.floor((Date.now() - Date.parse(turnStartedAt)) / 1000))`
  - Renders a circular countdown ring, approximately 200px diameter, with the remaining whole seconds displayed in large text at the centre
  - Transitions colour from green (full time) through yellow/orange (mid) to red (near zero) via the library's `colors`/`colorsTime` props
  - Is sized and styled for mobile-first use (large digits, sufficient touch-safe padding)
- Render the `TurnTimer` in all four role-views when `turnPhase === 'active'` and `turnStartedAt` is set:
  - **Clue giver** (`ClueGiverView`): label above timer reads "You're giving clues"
  - **Same-team guesser** (`GuesserView`): label above timer reads "Guess the word!"
  - **Opposing team** (`WaitingView` / spectator view): label above timer reads "[ActiveTeamName] is playing, don't guess!"
- Remove the existing plain-text `{secondsLeft}s` element from `ClueGiverView` — the new component replaces it
- Timer is hidden when `turnPhase !== 'active'` or `turnStartedAt` is absent

## Acceptance Criteria

- Given a turn is active, when the clue giver views their screen, then a circular countdown timer is visible with the label "You're giving clues" above it
- Given a turn is active, when a same-team player (not the clue giver) views their screen, then the circular countdown timer is visible with the label "Guess the word!" above it
- Given a turn is active, when an opposing-team player views their screen, then the circular countdown timer is visible with the label "[ActiveTeamName] is playing, don't guess!" above it
- Given the timer is at full time, when it first renders, then the ring colour is green; as time elapses the colour transitions through yellow/orange to red near zero
- Given the turn duration is 45 seconds (default), when the timer renders on a mobile screen (~375px wide), then the ring and centre digit are clearly legible without zooming
- Given a player joins or rejoins mid-turn, when their screen loads, then the timer displays the correct remaining time (not reset to the full duration)
- Given a turn ends (timer expiry, manual end, or hat emptied), when the turn-end state is received via SSE, then the timer is no longer shown on any screen
- Given the host set a custom turn duration at game creation, when a turn is active, then all timers count down from that custom duration (not a hardcoded value)

## Open Questions

- What are the exact label strings for each role? The draft uses "You're giving clues", "Guess the word!", and "[TeamName] is playing, don't guess!" — confirm wording or leave to implementer discretion.
- Should the timer ring diameter be fixed (e.g. 200px) or scale responsively with viewport width on larger screens?

## Dependencies

- Blocked by: ENG-012 (turn timer logic and `turnStartedAt` — appears implemented)
- Blocks: nothing

## Assumptions

- The contextual label is a short text string rendered above the ring, not an overlay or modal
- "All player screens" means the four in-turn role-views: clue giver, same-team guesser, opposing-team player, and any waiting view visible during an active turn
- The `[ActiveTeamName]` in the opposing-team label uses the team name already in game state (introduced in the recent "real team names" change)

## Technical Notes

- Key files: `client/src/pages/GamePage.tsx` (ClueGiverView ~line 143, existing timer text ~line 237), `client/src/hooks/useGameState.ts` (SSE consumer), `shared/src/types.ts` (`turnStartedAt`, `GameSettings.turnDurationSeconds`)
- `react-countdown-circle-timer` v3 API sketch:
  ```tsx
  <CountdownCircleTimer
    isPlaying
    duration={game.settings.turnDurationSeconds}
    initialRemainingTime={initialRemainingTime}
    colors={['#22c55e', '#eab308', '#ef4444']}
    colorsTime={[duration, Math.floor(duration / 2), 0]}
    size={200}
    strokeWidth={12}
  >
    {({ remainingTime }) => <span className="text-5xl font-bold">{remainingTime}</span>}
  </CountdownCircleTimer>
  ```
- The `initialRemainingTime` formula is already used (in a slightly different form) in the existing `ClueGiverView` interval logic — reuse the same derivation

## Drafting Notes

- Treating the existing plain-text `{secondsLeft}s` in `ClueGiverView` as the "invisible timer" described by the user — it's technically visible to the clue giver but minimal/unstyled; the new component replaces it entirely
- The green→yellow→red colour transition is implemented via library props, not custom CSS — this is an implicit technical choice that constrains the colour scheme to what the library supports natively
- `initialRemainingTime` is computed at component mount time; if the component re-mounts mid-turn (e.g. route re-entry) it will re-sync correctly from `turnStartedAt`
- Priority set to medium: gameplay-quality improvement, not a blocker for existing functionality

## References

- Related: ENG-012 (turn timer logic implementation)
- Library: `react-countdown-circle-timer` v3 — https://github.com/vydimitrov/react-countdown-circle-timer
