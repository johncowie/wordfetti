# ENG-008: Live Word Count in Lobby

## Goal
When any player submits or deletes a word, all lobby participants see that player's word count update in real time without a page refresh.

## Key Flows
- Update `store.addWord` and `store.deleteWord` in `InMemoryGameStore` to increment/decrement `player.wordCount` on the `Game` object and broadcast the updated snapshot to all SSE subscribers — no SSE protocol changes needed, `wordCount` piggybacks on the existing `Game` snapshot
- In `LobbyPage`, display each player's word count in their row, e.g. `2 / 5`; show a visual "done" indicator (e.g. badge colour change or checkmark) when `player.wordCount >= WORDS_PER_PLAYER`
- Import `WORDS_PER_PLAYER` from the shared package; no magic numbers in the component
- Add a store-level test confirming that an SSE subscriber receives an updated snapshot with the incremented `wordCount` after `addWord`

## User Verification
- Open two browser tabs on the same lobby
- Submit a word on the word-entry page in tab A → tab B's player row shows the updated count within a second, no refresh needed
- Delete a word in tab A → tab B's count decrements
- When a player reaches 5/5 their row shows a visual "done" indicator in all tabs
