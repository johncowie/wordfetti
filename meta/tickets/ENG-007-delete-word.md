# ENG-007: Delete Word

## Goal
A player can remove any of their own submitted words from the word-entry page before the game starts.

## Key Flows
- Add `DELETE /api/games/:joinCode/words/:wordId` endpoint; body `{ playerId }`; calls `store.deleteWord`; returns `204`; returns `403` if player does not own the word, `404` if word not found, `422` if game not in `lobby`
- Add route tests for the delete endpoint (success + each error case)
- In `WordEntryPage`, add an `×` delete button next to each word in the list; on click, call `DELETE` and remove the word from local state on `204`
- Re-enable the input and `+` button if deletion brings the count below `WORDS_PER_PLAYER`
- Update the progress bar, badge, and "Back to Lobby" button count after deletion

## User Verification
- On the word-entry page, each submitted word has an `×` button; clicking it removes the word from the list immediately
- After deletion the input re-enables if the player was previously at the limit
- Refresh after deletion → the deleted word does not reappear
- Attempting `DELETE` via curl with a different `playerId` returns `403`
