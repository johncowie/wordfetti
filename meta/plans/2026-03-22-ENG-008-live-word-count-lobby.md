# ENG-008: Live Word Count in Lobby — Implementation Plan

## Overview

Add a `wordCount` field to the `Player` type, maintain it in the store on every `addWord`/`deleteWord`, broadcast the updated `Game` snapshot to SSE subscribers, and display `count / 5` with a "done" badge in `LobbyPage`.

## Current State Analysis

- `Player` (`shared/src/types.ts:10`) has `id`, `name`, `team` — no `wordCount`
- `addWord` (`InMemoryGameStore.ts:85`) and `deleteWord` (`InMemoryGameStore.ts:109`) mutate `this.words` but **never call `this.subscribers`** — no SSE broadcast happens
- The broadcast pattern is established in `joinGame` (`InMemoryGameStore.ts:57-58`) and `startGame` (`InMemoryGameStore.ts:66-67`)
- `LobbyPage` already has a live SSE stream (`LobbyPage.tsx:40-55`) that calls `setGame` on every message
- `PlayerRow` (`LobbyPage.tsx:247`) renders only the player name
- `WORDS_PER_PLAYER = 5` is exported from `shared/src/types.ts:3` and already used in the store; it is **not** imported in `LobbyPage`

## Desired End State

- Every player row in the lobby shows `n / 5` word count, updating in real time across all tabs
- When a player reaches 5/5 their row shows a visual "done" indicator (green checkmark or badge)
- A store test asserts that an SSE subscriber receives an updated snapshot with the incremented `wordCount` after `addWord`

### Key Discoveries

- `InMemoryGameStore.ts:91` uses `\`${joinCode}:${playerId}\`` as the key into `this.words` — word count can be derived cheaply from that
- The snapshot broadcast pattern is `{ ...game, players: [...game.players] }` — we must keep `wordCount` on the player objects inside `game.players`
- The `shared/dist/` compiled output is generated; we only edit source files in `shared/src/`

## What We're NOT Doing

- No new API endpoints or SSE protocol changes
- No server-side aggregation endpoint for word counts
- No persistent storage — `wordCount` lives only in-memory on the `Player` objects inside `games`

---

## Phase 1: Add `wordCount` to the `Player` type

### Overview

Extend the shared `Player` type so both server and client can carry and read the count. Default it to `0` everywhere it is currently constructed.

### Changes Required

#### 1. `shared/src/types.ts`

Add `wordCount: number` to `Player`:

```ts
export type Player = {
  id: string
  name: string
  team: Team
  wordCount: number
}
```

#### 2. `server/src/store/InMemoryGameStore.ts` — `joinGame`

Set `wordCount: 0` when constructing a new player (`InMemoryGameStore.ts:55`):

```ts
const player: Player = { id: randomUUID(), name, team, wordCount: 0 }
```

### Success Criteria

#### Automated Verification

- [x] TypeScript compiles with no errors: `pnpm --filter server tsc --noEmit` and `pnpm --filter client tsc --noEmit`

---

## Phase 2: Maintain `wordCount` in the store and broadcast via SSE

### Overview

After each `addWord` and `deleteWord`, update `player.wordCount` on the in-memory game object and push the new snapshot to all SSE subscribers — exactly as `joinGame` does.

### Changes Required

#### 1. `server/src/store/InMemoryGameStore.ts` — `addWord`

After writing the updated word list, increment `player.wordCount` on the game object and broadcast:

```ts
async addWord(joinCode: string, playerId: string, text: string): Promise<Word> {
  const game = this.games.get(joinCode)
  if (!game) throw new AppError('NOT_FOUND', 'Game not found')
  if (game.status !== 'lobby') throw new AppError('GAME_NOT_IN_LOBBY', 'Game is not in lobby')
  const player = game.players.find((p) => p.id === playerId)
  if (!player) throw new AppError('FORBIDDEN', 'Player not in game')
  const key = `${joinCode}:${playerId}`
  const playerWords = this.words.get(key) ?? []
  if (playerWords.length >= WORDS_PER_PLAYER) {
    throw new AppError('WORD_LIMIT_REACHED', 'Word limit reached')
  }
  const word: Word = { id: randomUUID(), text: text.trim() }
  this.words.set(key, [...playerWords, word])
  player.wordCount = playerWords.length + 1          // ← new
  const snapshot = { ...game, players: [...game.players] }  // ← new
  this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))  // ← new
  return { ...word }
}
```

#### 2. `server/src/store/InMemoryGameStore.ts` — `deleteWord`

After removing the word, decrement `player.wordCount` and broadcast:

```ts
async deleteWord(joinCode: string, playerId: string, wordId: string): Promise<void> {
  const game = this.games.get(joinCode)
  if (!game) throw new AppError('NOT_FOUND', 'Game not found')
  if (game.status !== 'lobby') throw new AppError('GAME_NOT_IN_LOBBY', 'Words can only be deleted while game is in lobby')
  const player = game.players.find((p) => p.id === playerId)
  if (!player) throw new AppError('FORBIDDEN', 'Player not in game')
  const key = `${joinCode}:${playerId}`
  const playerWords = this.words.get(key) ?? []
  const wordIndex = playerWords.findIndex((w) => w.id === wordId)
  if (wordIndex === -1) throw new AppError('NOT_FOUND', 'Word not found')
  this.words.set(key, playerWords.filter((w) => w.id !== wordId))
  player.wordCount = playerWords.length - 1          // ← new
  const snapshot = { ...game, players: [...game.players] }  // ← new
  this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))  // ← new
}
```

### Success Criteria

#### Automated Verification

- [x] Existing store tests still pass: `pnpm --filter server test`
- [x] TypeScript compiles: `pnpm --filter server tsc --noEmit`

---

## Phase 3: Display word count and "done" indicator in `LobbyPage`

### Overview

Import `WORDS_PER_PLAYER` and update `PlayerRow` to show `wordCount / WORDS_PER_PLAYER` and a checkmark badge when the player is done.

### Changes Required

#### 1. `client/src/pages/LobbyPage.tsx` — imports

Add `WORDS_PER_PLAYER` to the existing shared import:

```ts
import { WORDS_PER_PLAYER } from '@wordfetti/shared'
```

#### 2. `client/src/pages/LobbyPage.tsx` — `PlayerRow`

Show the count and a done indicator. `wordCount` will be `0` by default for players who haven't added any words yet:

```tsx
function PlayerRow({ player, isCurrentPlayer }: PlayerRowProps) {
  const done = player.wordCount >= WORDS_PER_PLAYER
  return (
    <li className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm">
      <span aria-hidden="true">{done ? '✅' : '⭐'}</span>
      <span className="flex-1 font-medium text-gray-800">
        {player.name}
        {isCurrentPlayer && (
          <span className="ml-1 text-xs text-gray-400">(you)</span>
        )}
      </span>
      <span className={`text-xs font-medium ${done ? 'text-green-600' : 'text-gray-400'}`}>
        {player.wordCount} / {WORDS_PER_PLAYER}
      </span>
    </li>
  )
}
```

### Success Criteria

#### Automated Verification

- [x] TypeScript compiles: `pnpm --filter client tsc --noEmit`

#### Manual Verification

- [ ] Open two browser tabs on the same lobby
- [ ] Submit a word in tab A → tab B's player row updates count within 1 second, no refresh
- [ ] Delete a word in tab A → tab B's count decrements
- [ ] Reach 5/5 → row shows ✅ and green `5 / 5` in all tabs

---

## Phase 4: Store-level test for SSE broadcast on `addWord`

### Overview

Add one focused test in `InMemoryGameStore.test.ts` confirming that a subscriber receives an updated snapshot with the incremented `wordCount` after `addWord`.

### Changes Required

#### 1. `server/src/store/InMemoryGameStore.test.ts`

Append to the existing `describe('addWord', ...)` block:

```ts
it('notifies subscribers with updated wordCount after addWord', async () => {
  const store = new InMemoryGameStore()
  const game = await store.createGame()
  const player = await store.joinGame(game.joinCode, 'Alice', 1)
  const updates: Game[] = []
  store.subscribe(game.joinCode, (g) => updates.push(g))
  await store.addWord(game.joinCode, player.id, 'apple')
  expect(updates).toHaveLength(1)
  expect(updates[0].players.find((p) => p.id === player.id)?.wordCount).toBe(1)
})
```

### Success Criteria

#### Automated Verification

- [x] New test passes: `pnpm --filter server test`

---

## Testing Strategy

### Unit Tests

- New test in `InMemoryGameStore.test.ts` (Phase 4) covers the SSE broadcast path for `addWord`
- Existing tests for `addWord` / `deleteWord` / `subscribe` continue to pass

### Manual Testing Steps

1. Start the dev server: `pnpm dev`
2. Open two browser tabs to the same lobby URL
3. In tab A, navigate to Add Words and submit a word — verify tab B count increments live
4. Delete the word in tab A — verify tab B count decrements live
5. Add 5 words — verify tab B shows ✅ and `5 / 5` for that player

## References

- Original ticket: `meta/tickets/ENG-008-live-word-count-lobby.md`
- Store implementation: `server/src/store/InMemoryGameStore.ts`
- Store tests: `server/src/store/InMemoryGameStore.test.ts`
- Lobby UI: `client/src/pages/LobbyPage.tsx`
- Shared types: `shared/src/types.ts`
