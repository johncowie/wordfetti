# ENG-007: Delete Word — Implementation Plan

## Overview

Add the ability for a player to delete one of their own submitted words from the word-entry page before a game starts. This requires a new `DELETE` endpoint on the backend and an `×` button per word on the frontend.

## Current State Analysis

- Words are stored in `InMemoryGameStore` in `this.words: Map<string, Word[]>` keyed by `"${joinCode}:${playerId}"` (`InMemoryGameStore.ts:12`).
- The `GameStore` interface (`GameStore.ts`) declares `addWord` and `getWords` — no delete method exists yet.
- The route handler at `games.ts:118` follows a consistent pattern: validate inputs, call store, catch `AppError` instances and map codes to HTTP statuses.
- `WordEntryPage.tsx` manages `words: Word[]` in local state. Badge, progress bar, `atLimit`, and "Back to Lobby" count all derive reactively from `words.length` — they will update automatically after `setWords` is called.
- Each word in the list is rendered as a plain `<li>` with two `<span>` children (`WordEntryPage.tsx:132-141`). No delete control exists yet.
- Tests follow a mock-store pattern: `mockStore(overrides?)` creates a stub, `buildApp(store)` wraps it in Express (`games.test.ts:11-34`).

## Desired End State

- `DELETE /api/games/:joinCode/words/:wordId` with body `{ playerId }` removes the word and returns `204 No Content`.
- Returns `403` if `playerId` does not own the word, `404` if the word is not found, `422` if the game is not in `lobby` state.
- On the word-entry page, each word shows an `×` button; clicking it calls `DELETE` and removes the word from local state.
- The input and `+` button re-enable automatically when word count drops below `WORDS_PER_PLAYER` (already reactive).
- After a page refresh, deleted words do not reappear.

## What We're NOT Doing

- No bulk delete.
- No undo/undo history.
- No soft-delete or audit trail.
- No changes to the shared `Word` type.

---

## Phase 1: Store Layer

### Overview

Add `deleteWord` to the `GameStore` interface and implement it in `InMemoryGameStore`.

### Changes Required

#### 1. `GameStore` interface

**File**: `server/src/store/GameStore.ts`

Add after the `getWords` line:

```ts
deleteWord(joinCode: string, playerId: string, wordId: string): Promise<void>
```

#### 2. `InMemoryGameStore` implementation

**File**: `server/src/store/InMemoryGameStore.ts`

Add after the `getWords` method (~line 107):

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
}
```

### Success Criteria

#### Automated Verification

- [ ] TypeScript compiles without errors: `cd server && npm run build`
- [ ] Store unit tests pass: `cd server && npm test`

---

## Phase 2: API Route

### Overview

Add the `DELETE /:joinCode/words/:wordId` route handler to the games router.

### Changes Required

#### 1. Route handler

**File**: `server/src/routes/games.ts`

Add after the GET words handler (~line 166):

```ts
router.delete('/:joinCode/words/:wordId', async (req, res, next) => {
  const joinCode = req.params.joinCode.toUpperCase()
  const { wordId } = req.params
  const { playerId } = req.body
  if (!playerId || typeof playerId !== 'string') {
    return res.status(400).json({ error: 'playerId is required' })
  }
  try {
    await store.deleteWord(joinCode, playerId, wordId)
    return res.status(204).send()
  } catch (err) {
    if (err instanceof AppError) {
      if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message })
      if (err.code === 'FORBIDDEN') return res.status(403).json({ error: 'Player not in game' })
      if (err.code === 'GAME_NOT_IN_LOBBY') return res.status(422).json({ error: 'Words can only be deleted while game is in lobby' })
    }
    return next(err)
  }
})
```

### Success Criteria

#### Automated Verification

- [ ] TypeScript compiles: `cd server && npm run build`
- [ ] Route tests pass: `cd server && npm test`

#### Manual Verification

- [ ] `curl -X DELETE .../api/games/XXXX/words/<wordId> -d '{"playerId":"..."}'` returns `204`
- [ ] Curl with a different `playerId` returns `403`
- [ ] Curl with a non-existent `wordId` returns `404`

---

## Phase 3: Route Tests

### Overview

Add tests for the new DELETE endpoint following the existing `mockStore` / `buildApp` pattern (`games.test.ts:11-34`).

### Changes Required

**File**: `server/src/routes/games.test.ts`

Add a `describe('DELETE /:joinCode/words/:wordId', ...)` block after the GET words block. Cases:

| Case | Store behaviour | Expected status |
|---|---|---|
| Happy path | `deleteWord` resolves | `204`, empty body |
| Missing `playerId` | — (guard fires) | `400` |
| Store throws `FORBIDDEN` | `deleteWord` rejects with `FORBIDDEN` | `403` |
| Store throws `NOT_FOUND` | `deleteWord` rejects with `NOT_FOUND` | `404` |
| Store throws `GAME_NOT_IN_LOBBY` | `deleteWord` rejects with `GAME_NOT_IN_LOBBY` | `422` |

Default `mockStore` must also expose `deleteWord: vi.fn().mockResolvedValue(undefined)` so existing tests don't break.

### Success Criteria

#### Automated Verification

- [ ] All route tests pass: `cd server && npm test`

---

## Phase 4: Store Unit Tests

### Overview

Add `describe('deleteWord', ...)` in `InMemoryGameStore.test.ts` following the existing pattern (lines 119-166 for `addWord`).

### Cases

- Happy path: word is removed from the store; subsequent `getWords` does not include it.
- Game not found → `AppError` with `code: 'NOT_FOUND'`.
- Game not in lobby → `AppError` with `code: 'GAME_NOT_IN_LOBBY'`.
- Player not in game → `AppError` with `code: 'FORBIDDEN'`.
- Word ID not found → `AppError` with `code: 'NOT_FOUND'`.

### Success Criteria

#### Automated Verification

- [ ] All store tests pass: `cd server && npm test`

---

## Phase 5: Frontend — Delete Button

### Overview

Add an `×` button to each word row in `WordEntryPage`. On click it calls `DELETE` and updates local state. All derived UI (badge, progress bar, `atLimit`, "Back to Lobby" count) updates automatically.

### Changes Required

**File**: `client/src/pages/WordEntryPage.tsx`

#### 1. Add `handleDelete` function after `handleAdd` (~line 55):

```ts
const handleDelete = async (wordId: string) => {
  if (!session) return
  setError(null)
  const res = await fetch(`/api/games/${joinCode}/words/${wordId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: session.playerId }),
  })
  if (res.ok) {
    setWords((prev) => prev.filter((w) => w.id !== wordId))
  } else {
    const body = await res.json().catch(() => ({}))
    setError(body.error ?? 'Failed to delete word')
  }
}
```

#### 2. Update the word list `<li>` (~line 132) to include the `×` button:

```tsx
<li key={word.id} className="flex items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 shadow-sm">
  <div className="flex items-center gap-2">
    <span className="text-sm text-gray-400">{i + 1}.</span>
    <span>{word.text}</span>
  </div>
  <button
    onClick={() => handleDelete(word.id)}
    className="text-gray-400 hover:text-red-500 transition-colors"
    aria-label={`Delete ${word.text}`}
  >
    ×
  </button>
</li>
```

> Note: check the exact existing `<li>` className and adjust so the layout change is minimal. The key requirement is `flex items-center justify-between` on the `<li>` and a button at the end.

### Success Criteria

#### Automated Verification

- [ ] TypeScript compiles: `cd client && npm run build`

#### Manual Verification

- [ ] Each submitted word shows an `×` button on the word-entry page
- [ ] Clicking `×` removes the word from the list immediately
- [ ] After deletion the input/`+` button re-enable when count was at the limit
- [ ] Badge, progress bar, and "Back to Lobby" count update immediately
- [ ] Refresh after deletion: deleted word does not reappear

---

## Testing Strategy

### Unit Tests (automated)

- `InMemoryGameStore.test.ts` — five cases covering the full error surface of `deleteWord`
- `games.test.ts` — five cases covering the route handler

### Manual Testing

1. Navigate to word-entry page, add 5 words — input disables.
2. Click `×` on one word — input re-enables, count drops to 4/5.
3. Add another word — count goes back to 5/5.
4. Refresh — deleted word absent, all remaining words present.
5. `curl -X DELETE` with wrong `playerId` — returns `403`.

## References

- Ticket: `meta/tickets/ENG-007-delete-word.md`
- Store pattern: `server/src/store/InMemoryGameStore.ts:85-107`
- Route pattern: `server/src/routes/games.ts:118-166`
- Test pattern: `server/src/routes/games.test.ts:11-34`, `318-405`
- Frontend add pattern: `client/src/pages/WordEntryPage.tsx:39-55`
