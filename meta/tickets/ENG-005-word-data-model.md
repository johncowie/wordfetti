# ENG-005: Word Data Model & Store Methods

## Goal
Add the `Word` type and `wordCount` field to shared types, and implement private word storage methods on the game store — no routes or UI yet.

## Key Flows
- Add `Word` type (`{ id: string; text: string }`) to `shared/src/types.ts`
- Add `wordCount: number` to `Player` in `shared/src/types.ts` (initialised to `0` when a player joins; this is the only word-related field that is public/broadcast-safe)
- Export a `WORDS_PER_PLAYER` constant from the shared package so client and server share a single source of truth
- In `InMemoryGameStore`, maintain a private `Map<playerId, Word[]>` — words never go on the `Game` object itself, keeping them out of SSE broadcasts
- Add `addWord(joinCode, playerId, text): Promise<Word>` to `GameStore` interface and `InMemoryGameStore`; validates game is in `lobby`, player exists, word count is below `WORDS_PER_PLAYER`, text is 1–50 chars (trimmed); returns the new `Word`
- Add `deleteWord(joinCode, playerId, wordId): Promise<void>`; throws `NOT_FOUND` if the word does not belong to that player
- Add `getWords(joinCode, playerId): Promise<Word[]>`; throws `FORBIDDEN` if the player is not in the game
- Write unit tests in `InMemoryGameStore.test.ts` covering: add word success, add word over limit, add to non-existent game, delete own word, delete another player's word (forbidden), `getWords` returns only that player's words

## User Verification
- Run `pnpm test` in the server package — all new store tests pass
- No visible change in the running app
