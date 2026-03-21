# ENG-009: Gate Game Start on Word Submission

## Goal
The host cannot start the game until every player has submitted the required number of words; the Start button reflects this live.

## Key Flows
- In `POST /:joinCode/start`, add a validation step after the existing team-size check: every `player.wordCount` must be `>= WORDS_PER_PLAYER`; if not, return `422 { error: 'All players must submit their words before the game can start' }`
- Add a route test for the new `422` case
- In `LobbyPage`, compute `allWordsSubmitted = game.players.every(p => p.wordCount >= WORDS_PER_PLAYER)` and extend the Start button's disabled condition to also require `allWordsSubmitted`
- Show a descriptive hint below the Start button when words are still pending, e.g. "Waiting for 2 players to finish submitting words" (count players where `wordCount < WORDS_PER_PLAYER`)
- The per-player done indicators from ENG-008 make the pending players visually obvious without extra UI

## User Verification
- With ≥2 players per team but not all words submitted → Start button is disabled; hint shows how many players are still pending
- As each player finishes, the pending count in the hint decrements in real time (via SSE)
- Once the last player submits their final word → Start button becomes enabled for the host immediately
- Attempting `POST /start` via curl before all words are submitted returns `422` with the appropriate message
- Host starts the game once all words are submitted → game transitions successfully
