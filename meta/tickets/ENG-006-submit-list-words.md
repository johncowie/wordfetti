# ENG-006: Submit & List Words

## Goal
A player can navigate to a dedicated word-entry page, submit words one at a time, and see their own submitted words listed back to them.

## Key Flows
- Add `POST /api/games/:joinCode/words` endpoint; body `{ playerId, text }`; calls `store.addWord`; returns `201 { word }`; returns `400` for invalid text, `403` if player not in game, `409` if already at word limit, `422` if game not in `lobby`
- Add `GET /api/games/:joinCode/words?playerId=...` endpoint; calls `store.getWords`; returns `200 { words: Word[] }`; returns `403` if player not in game
- Add route-level tests for both endpoints (success + each error case)
- Add a new `WordEntryPage` at route `/games/:joinCode/words` in the React app; redirect to lobby if session is missing
- Page layout (matching `screens/word-entry-screen.png`):
  - Header "Your Words" with back-arrow navigation and `N/5` badge top-right
  - Progress bar filling proportionally to `wordCount / WORDS_PER_PLAYER`
  - "Add N more word(s)" hint text above the input
  - Text input + `+` button to submit; disabled once limit is reached; helper text "Think of words, names, phrases, or pop culture references!"
  - Numbered list of submitted words (fetched via `GET` on mount)
  - "Back to Lobby (N/5)" button at the bottom
- On the `LobbyPage`, add an "Add Words" button for the current player that navigates to `WordEntryPage`

## User Verification
- In the lobby, tap "Add Words" → navigates to the word-entry page
- Type a word and press `+` → word appears in the numbered list; progress bar and badge update
- Submit 5 words → input and `+` button become disabled; progress bar is full
- Press "Back to Lobby" → returns to lobby
- Refresh the word-entry page → previously submitted words are still listed
