# ENG-005 + ENG-006: Word Data Model & Word Submission Implementation Plan

## Overview

Add the `Word` type and `wordCount` field to the shared package, implement private word storage on the game store, expose two REST endpoints for submitting and listing words, and build the dedicated `WordEntryPage` that the lobby links to.

## Current State Analysis

- `Player` type has three fields: `{ id, name, team }` — no `wordCount`
- `Game` type has `{ id, joinCode, status, players, hostId? }` — no word data
- `InMemoryGameStore` has two private maps: `games` (by joinCode) and `subscribers` (SSE callbacks)
- `GameStore` interface has 6 methods — none word-related
- Routes all live in `server/src/routes/games.ts` in a single `createGamesRouter` factory
- Client router in `main.tsx` has 4 routes: `/`, `/create`, `/join`, `/game/:joinCode`
- Session shape: `{ playerId: string; joinCode: string }` — stored in localStorage

## Desired End State

After this plan is complete:
- A `Word` type (`{ id, text }`) and `WORDS_PER_PLAYER = 5` constant are exported from the shared package (`wordCount` on `Player` is deferred to ENG-008 when it will actually be kept accurate)
- `InMemoryGameStore` has a private `words: Map<joinCode:playerId, Word[]>` and implements `addWord` and `getWords` (`deleteWord` is deferred to ENG-007)
- `POST /api/games/:joinCode/words` and `GET /api/games/:joinCode/words?playerId=` endpoints exist and are tested
- The React app has a `WordEntryPage` at `/game/:joinCode/words` matching the mockup
- `LobbyPage` has an "Add Words" button for the current player

### Verification
```bash
# All server tests pass (store unit tests + route tests)
cd server && pnpm test

# TypeScript compiles cleanly for all packages
pnpm -r run build   # or equivalent typecheck command
```
Plus manual verification per the ticket's user verification steps.

## What We're NOT Doing

- Adding `wordCount` to `Player` — deferred to ENG-008 when it will actually be kept accurate via SSE broadcast
- `deleteWord` store method, endpoint, or UI — deferred to ENG-007
- Blocking game start on word submission (ENG-009)
- Validating word uniqueness per player (not in ticket spec)
- Any auth beyond matching `playerId` to an existing player in the game

## Key Discoveries

- `shared/src/index.ts:1` is `export * from './types.js'` — adding exports to `types.ts` automatically re-exports them
- `joinGame` in `InMemoryGameStore.ts:54` creates `Player` objects — no change needed here since `wordCount` is deferred to ENG-008
- Error code strings are bare string literals at call sites (no enum) — follow the `'NOT_FOUND'` / `'GAME_IN_PROGRESS'` pattern
- Route error-catching pattern: inline `if (err instanceof AppError && err.code === '...')` blocks before `next(err)` — see `games.ts:126-134`
- `isValidName` at `games.ts:10-12` already validates 1–50 char trimmed strings — reuse the same logic for word text validation
- Tests mock the store with `mockStore()` factory at `games.test.ts:11-22`; `AppError` is imported and thrown inline in mock overrides

---

## Phase 1: Shared Package — Types and Constant

### Overview

Add `Word` and `WORDS_PER_PLAYER`. `Player` is unchanged — `wordCount` is deferred to ENG-008 when it will be kept accurate. Everything downstream depends on this compiling first.

### Changes Required

#### 1. `shared/src/types.ts`

Add the `Word` type and `WORDS_PER_PLAYER` constant (leave `Player` and `Game` untouched):

```ts
export type Team = 1 | 2

export const WORDS_PER_PLAYER = 5

export type Word = {
  id: string
  text: string
}

export type Player = {
  id: string
  name: string
  team: Team
}

export type Game = {
  id: string
  joinCode: string
  status: 'lobby' | 'in_progress' | 'finished'
  players: Player[]
  hostId?: string
}
```

### Success Criteria

#### Automated Verification
- [x] `pnpm -r run build` (or typecheck) passes with no errors

---

## Phase 2: Store — Interface and Implementation

### Overview

Add two new methods to `GameStore`, implement them in `InMemoryGameStore`, and write unit tests. `deleteWord` is out of scope — it will be added in ENG-007.

### Changes Required

#### 1. `server/src/store/GameStore.ts`

Add `Word` import and two new method signatures:

```ts
import type { Game, Player, Team, Word } from '@wordfetti/shared'

export interface GameStore {
  createGame(): Promise<Game>
  createGameWithHost(name: string, team: Team): Promise<{ game: Game; player: Player }>
  getGameByJoinCode(joinCode: string): Promise<Game | null>
  joinGame(joinCode: string, name: string, team: Team): Promise<Player>
  subscribe(joinCode: string, callback: (game: Game) => void): () => void
  startGame(joinCode: string): Promise<Game>
  addWord(joinCode: string, playerId: string, text: string): Promise<Word>
  getWords(joinCode: string, playerId: string): Promise<Word[]>
}
```

#### 2. `server/src/store/InMemoryGameStore.ts`

**Update the existing `@wordfetti/shared` import** to include `Word` and `WORDS_PER_PLAYER` (merge into one statement):
```ts
import { WORDS_PER_PLAYER, type Game, type Player, type Team, type Word } from '@wordfetti/shared'
```

**Add private field** after the existing `subscribers` map. Use a composite key `${joinCode}:${playerId}` so word entries are scoped to a game and can be cleaned up per-game in the future:
```ts
private readonly words = new Map<string, Word[]>()
```

**Add `addWord` method**:
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
  return { ...word }
}
```

**Add `getWords` method**:
```ts
async getWords(joinCode: string, playerId: string): Promise<Word[]> {
  const game = this.games.get(joinCode)
  if (!game) throw new AppError('NOT_FOUND', 'Game not found')
  const player = game.players.find((p) => p.id === playerId)
  if (!player) throw new AppError('FORBIDDEN', 'Player not in game')
  return [...(this.words.get(`${joinCode}:${playerId}`) ?? [])]
}
```

#### 3. `server/src/store/InMemoryGameStore.test.ts`

Add a new `describe('word methods', ...)` block. Test cases:

```ts
describe('addWord', () => {
  it('adds a word and returns it', async () => { ... })
  it('accepts the 5th word (boundary) and rejects the 6th (WORD_LIMIT_REACHED)', async () => { ... })
  it('throws NOT_FOUND when game does not exist', async () => { ... })
  it('throws FORBIDDEN when player not in game', async () => { ... })
  it('throws GAME_NOT_IN_LOBBY when game is in_progress', async () => { ... })
})

describe('getWords', () => {
  it('returns only that player\'s words', async () => { ... })
  it('throws FORBIDDEN when player not in game', async () => { ... })
})
```

Error assertions follow the existing pattern:
```ts
await expect(store.addWord(...)).rejects.toMatchObject({ code: 'WORD_LIMIT_REACHED' })
```

### Success Criteria

#### Automated Verification
- [x] `cd server && pnpm test` — all new store tests pass, existing tests still pass
- [x] TypeScript in `server` compiles with no errors

---

## Phase 3: Server Routes

### Overview

Add `POST /:joinCode/words` and `GET /:joinCode/words?playerId=` to the existing `games.ts` router, with the matching route tests.

### Changes Required

#### 1. `server/src/routes/games.ts`

Update the existing `@wordfetti/shared` import (merge into one statement):
```ts
import { WORDS_PER_PLAYER, type Team, type Word } from '@wordfetti/shared'
```

Add a `isValidWordText` helper alongside the existing validators:
```ts
function isValidWordText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 50
}
```

Add `POST /:joinCode/words` route (insert before the `POST /:joinCode/players` route):
```ts
// POST /:joinCode/words — submit a word for the current player
router.post('/:joinCode/words', async (req, res, next) => {
  try {
    const joinCode = req.params.joinCode.toUpperCase()
    const { playerId, text } = req.body ?? {}
    if (typeof playerId !== 'string' || !playerId) {
      return res.status(400).json({ error: 'playerId is required' })
    }
    if (!isValidWordText(text)) {
      return res.status(400).json({ error: 'Word must be between 1 and 50 characters' })
    }
    const word = await store.addWord(joinCode, playerId, text)
    return res.status(201).json({ word })
  } catch (err: unknown) {
    if (err instanceof AppError && err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Game not found' })
    }
    if (err instanceof AppError && err.code === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Player not in game' })
    }
    if (err instanceof AppError && err.code === 'WORD_LIMIT_REACHED') {
      return res.status(409).json({ error: `You can only submit ${WORDS_PER_PLAYER} words` })
    }
    if (err instanceof AppError && err.code === 'GAME_NOT_IN_LOBBY') {
      return res.status(422).json({ error: 'Words can only be submitted while game is in lobby' })
    }
    next(err)
  }
})
```

Add `GET /:joinCode/words` route:
```ts
// GET /:joinCode/words — list a player's submitted words
router.get('/:joinCode/words', async (req, res, next) => {
  try {
    const joinCode = req.params.joinCode.toUpperCase()
    const { playerId } = req.query
    if (typeof playerId !== 'string') {
      return res.status(400).json({ error: 'playerId query param is required' })
    }
    const words = await store.getWords(joinCode, playerId)
    return res.json({ words })
  } catch (err: unknown) {
    if (err instanceof AppError && err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Game not found' })
    }
    if (err instanceof AppError && err.code === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Player not in game' })
    }
    next(err)
  }
})
```

#### 2. `server/src/routes/games.test.ts`

Add the new routes to the `mockStore()` factory defaults:
```ts
addWord: async () => ({ id: 'w1', text: 'banana' }),
getWords: async () => [],
```

Also update the four existing inline `Player` object literals in `games.test.ts` — they do not need changes since `wordCount` is not added to the `Player` type in this plan.

Add a `describe('POST /:joinCode/words', ...)` block covering:
- `201` success with `{ word }` body
- `400` when `playerId` is missing
- `400` when `text` is empty; `400` when `text` is 51 characters (boundary — 50 chars must return `201`)
- `403` when store throws `FORBIDDEN`
- `404` when store throws `NOT_FOUND`
- `409` when store throws `WORD_LIMIT_REACHED`
- `422` when store throws `GAME_NOT_IN_LOBBY`

Add a `describe('GET /:joinCode/words', ...)` block covering:
- `200` success with `{ words: [...] }` body
- `400` when `playerId` query param is missing
- `403` when store throws `FORBIDDEN`
- `404` when store throws `NOT_FOUND`

### Success Criteria

#### Automated Verification
- [x] `cd server && pnpm test` — all new route tests pass, existing tests still pass

#### Manual Verification
- [ ] `curl -X POST http://localhost:3000/api/games/XXXX/words -H 'Content-Type: application/json' -d '{"playerId":"...","text":"banana"}' ` returns `201 { word: { id, text } }`
- [ ] `curl http://localhost:3000/api/games/XXXX/words?playerId=...` returns `200 { words: [...] }`

---

## Phase 4: Client — WordEntryPage and Lobby Link

### Overview

Add the `/game/:joinCode/words` route to the React router (singular `game`, matching the existing lobby route convention), implement `WordEntryPage` matching the mockup, and add the "Add Words" button to `LobbyPage`.

### Changes Required

#### 1. `client/src/main.tsx`

Add the new route import and route entry:

```ts
import { WordEntryPage } from './pages/WordEntryPage'
```

```tsx
<Route path="/game/:joinCode/words" element={<WordEntryPage />} />
```

(alongside the existing `/game/:joinCode` lobby route — consistent singular `game` prefix)

#### 2. `client/src/pages/WordEntryPage.tsx` (new file)

Full component structure:

```tsx
import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { WORDS_PER_PLAYER } from '@wordfetti/shared'
import type { Word } from '@wordfetti/shared'
import { loadSession } from '../session'

export function WordEntryPage() {
  const { joinCode } = useParams<{ joinCode: string }>()
  const navigate = useNavigate()
  const [session] = useState(() => loadSession())

  // Redirect if no valid session for this game
  useEffect(() => {
    if (!session || session.joinCode !== joinCode) {
      navigate(`/game/${joinCode}`, { replace: true })
    }
  }, [session, joinCode, navigate])

  const [words, setWords] = useState<Word[]>([])
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Fetch existing words on mount
  useEffect(() => {
    if (!session) return
    fetch(`/api/games/${joinCode}/words?playerId=${session.playerId}`)
      .then((res) => res.json())
      .then((data) => {
        setWords(data.words)
        setLoading(false)
      })
      .catch(() => {
        setError('Could not load your words. Please refresh.')
        setLoading(false)
      })
  }, [joinCode, session])

  const atLimit = words.length >= WORDS_PER_PLAYER
  const remaining = WORDS_PER_PLAYER - words.length

  async function handleAdd() {
    if (!session || !input.trim()) return
    setError(null)
    const res = await fetch(`/api/games/${joinCode}/words`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: session.playerId, text: input.trim() }),
    })
    if (res.ok) {
      const { word } = await res.json()
      setWords((prev) => [...prev, word])
      setInput('')
    } else {
      const body = await res.json().catch(() => ({}))
      setError(body.error ?? 'Failed to add word')
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-cream">
        <p role="status" className="text-gray-500">Loading…</p>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-brand-cream">
      {/* Header */}
      <div className="relative flex items-center px-4 pt-6 pb-4">
        <button
          onClick={() => navigate(`/game/${joinCode}`)}
          className="absolute left-4 text-gray-500 hover:text-gray-700"
          aria-label="Back to lobby"
        >
          ←
        </button>
        <div className="mx-auto text-center">
          <h1 className="text-xl font-bold text-gray-900">Your Words</h1>
          <p className="text-sm text-gray-500">Add words for others to guess</p>
        </div>
        {/* N/5 badge */}
        <span className="absolute right-4 rounded-full bg-brand-coral px-2.5 py-1 text-xs font-semibold text-white">
          {words.length}/{WORDS_PER_PLAYER}
        </span>
      </div>

      {/* Progress bar */}
      <div className="mx-4 h-2 overflow-hidden rounded-full bg-gray-200">
        <div
          className="h-full rounded-full bg-brand-coral transition-all"
          style={{ width: `${(words.length / WORDS_PER_PLAYER) * 100}%` }}
        />
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-4 p-4">
        {/* Hint text */}
        {!atLimit && (
          <p className="text-sm text-gray-600">
            Add {remaining} more word{remaining === 1 ? '' : 's'}
          </p>
        )}

        {/* Input row */}
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            disabled={atLimit}
            placeholder="Enter a word or phrase"
            className="flex-1 rounded-lg border border-gray-200 px-4 py-3 outline-none focus:border-brand-coral focus:ring-1 focus:ring-brand-coral disabled:opacity-50"
          />
          <button
            onClick={handleAdd}
            disabled={atLimit || !input.trim()}
            className="rounded-xl bg-brand-coral px-4 py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            +
          </button>
        </div>

        <p className="text-xs text-gray-400">
          Think of words, names, phrases, or pop culture references!
        </p>

        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        {/* Word list */}
        {words.length > 0 && (
          <ol className="flex flex-col gap-2">
            {words.map((word, i) => (
              <li
                key={word.id}
                className="flex items-center rounded-xl bg-white px-4 py-3 shadow-sm"
              >
                <span className="mr-3 text-sm font-semibold text-gray-400">{i + 1}</span>
                <span className="flex-1 text-sm text-gray-900">{word.text}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Back to Lobby button */}
      <div className="p-4">
        <button
          onClick={() => navigate(`/game/${joinCode}`)}
          className="w-full rounded-xl border border-gray-200 bg-white px-6 py-3.5 text-sm font-semibold text-gray-700 transition-opacity hover:opacity-90"
        >
          Back to Lobby ({words.length}/{WORDS_PER_PLAYER})
        </button>
      </div>
    </div>
  )
}
```

#### 3. `client/src/pages/LobbyPage.tsx`

In the section that renders the current player's row (around where the start button section already checks `currentPlayerId === game.hostId`), add an "Add Words" button visible to the current player.

Find the `{currentPlayerId ? ... : ...}` section (the "Want to play?" section at lines 125-132) and add an "Add Words" button beneath the team columns, visible only to the current player:

```tsx
{currentPlayerId && (
  <button
    onClick={() => navigate(`/game/${joinCode}/words`)}
    className="w-full rounded-xl bg-brand-teal px-6 py-3.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
  >
    Add Words
  </button>
)}
```

Also add `useNavigate` to the existing React Router import and call `const navigate = useNavigate()` alongside the existing state declarations.

### Success Criteria

#### Automated Verification
- [x] `cd client && pnpm run build` compiles with no TypeScript errors
- [ ] No browser console errors on mount

#### Manual Verification
- [ ] In the lobby, "Add Words" button appears for the current player
- [ ] Clicking "Add Words" navigates to `/game/:joinCode/words`
- [ ] The word-entry page shows the progress bar, badge, input + button, and helper text
- [ ] Typing a word and pressing `+` (or Enter) adds it to the numbered list; badge and progress bar update
- [ ] After 5 words, the input and `+` button become disabled; badge shows `5/5`
- [ ] "Back to Lobby (N/5)" button returns to the lobby
- [ ] Refreshing the word-entry page re-loads previously submitted words

---

## Testing Strategy

### Unit Tests (store)
- `addWord`: success, 5th word accepted + 6th rejected (boundary), game-not-found, player-not-in-game, game-not-in-lobby
- `getWords`: returns only that player's words, player-not-in-game

### Route Tests
- `POST /words`: 201 success, 400 missing playerId, 400 empty text, 400 51-char text (50-char must pass), 403 forbidden, 404 not found, 409 limit, 422 not lobby
- `GET /words`: 200 success, 400 missing playerId, 403 forbidden, 404 not found

### Manual Testing
- Full user verification steps from both tickets (ENG-005 and ENG-006)

---

## References

- Ticket: `meta/tickets/ENG-005-word-data-model.md`
- Ticket: `meta/tickets/ENG-006-submit-list-words.md`
- Mockup: `screens/word-entry-screen.png`
- Store implementation: `server/src/store/InMemoryGameStore.ts`
- Route patterns: `server/src/routes/games.ts`
- Client session: `client/src/session.ts`
- Client router: `client/src/main.tsx`
