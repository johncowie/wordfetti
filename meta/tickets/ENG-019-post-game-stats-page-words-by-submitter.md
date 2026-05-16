---
work_item_id: "ENG-019"
title: "Post-Game Stats Page Showing Words by Submitter"
date: "2026-05-16T13:59:41+00:00"
author: John Cowie Del Corral
type: story
status: draft
priority: medium
parent: ""
tags: [frontend, game-flow, stats]
---

# ENG-019: Post-Game Stats Page Showing Words by Submitter

**Type**: Story
**Status**: Draft
**Priority**: Medium
**Author**: John Cowie Del Corral

## Summary

As a player, I want to view a stats page after the game ends, so that I can
see all the words that were submitted and who was responsible for each one.

The stats page is reached via a "View stats" button on the existing end-of-game
screen and is accessible to all players at `/game/<code>/stats`.

## Context

The game currently ends with a screen showing each player whether their team
won or lost (ENG-014). Players have no way to review the words that were in
the hat — who submitted what is unknown after the game ends. This feature adds
a first post-game stats screen to satisfy that curiosity, with richer
analytics (guess times, skip counts, clue-giver leaderboards, duplicate
detection) deferred to future stories.

## Requirements

- A "View stats" button is added to the existing end-of-game screen, visible to all players on their devices.
- The button navigates to `/game/<code>/stats`.
- The stats page displays all words submitted to the game, grouped by the player who submitted them.
- Submitter groups are ordered alphabetically by the submitter's registered display name.
- Within each group, words are listed in alphabetical order.
- Each word entry shows the word and the registered display name of the submitter.
- The stats page is accessible via direct URL after the game has ended (i.e. a player can close the tab and return later via the URL).
- The stats page visual design matches the existing game UI theme.
- The existing game cleanup/expiry process is not modified.

## Acceptance Criteria

- Given a completed game, when a player views the end-of-game screen, then a "View stats" button is visible on all players' devices.
- Given a player clicks "View stats", then they are navigated to `/game/<code>/stats`.
- Given the stats page loads, then words are presented grouped by submitter, with each group labelled by the submitter's registered display name.
- Given multiple submitter groups, then the groups are ordered alphabetically by submitter name.
- Given a group of words for a submitter, then the words within that group are listed in alphabetical order.
- Given a player navigates directly to `/game/<code>/stats` after the game has ended, then the page loads correctly without error.
- Given there are no words in the game, then the stats page displays an appropriate empty state rather than erroring.
- Given the stats page, then its visual design is consistent with the existing game UI theme (fonts, colours, layout conventions).

## Open Questions

## Dependencies

- Blocked by: none
- Blocks: future stats stories (duplicate detection, guess times, skip counts, clue-giver leaderboards)

## Assumptions

- The stats page is accessible to anyone with the game code in the URL — no additional authentication is required.
- Word data persists long enough after game end to serve the stats page; no changes to data retention are in scope.

## Technical Notes

- Route to add: `/game/:code/stats`
- Word data (word text + submitter name) must be fetchable for a given game code post-completion.

## Drafting Notes

- "To start off with" framing is intentional — this story is deliberately narrow. Future analytics (guess times, skips, leaderboards, duplicates) are out of scope and will be separate stories.
- Stats page is read-only; no player interaction beyond navigation.
- Submitter name uses the player's registered display name, consistent with how names appear elsewhere in the game.
- Browser back is the intended return path from the stats page — no explicit back button is included in scope.
- Visual design should follow the existing game UI theme; no new design system work is implied.
- Submitter group ordering confirmed as alphabetical by display name.

## References

- Related: ENG-014 (end-of-game score display screen — the screen that will host the "View stats" button)
