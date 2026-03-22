# ENG-011: Round 1 — Guess, Skip, and Round End — Implementation Plan

## Overview

The clue giver can start their turn, work through words by marking them guessed
or skipping them, and when the hat empties all players simultaneously see a
round score summary. This covers three new API endpoints, three new store
methods, and the GamePage UI to wire them all up.

---

## Current State Analysis

- `shared/src/types.ts:17-28` — `Game` already has `hat`, `activeTeam`,
  `currentClueGiverId`, `turnPhase`, `scores`. Missing: `currentWord`,
  `guessedThisTurn`. `status` union is missing `'round_over'`.
- `InMemoryGameStore` (`server/src/store/InMemoryGameStore.ts`) — `startGame`
  initialises all turn fields. No `readyTurn`, `guessWord`, or `skipWord` methods.
- `GameStore` interface (`server/src/store/GameStore.ts`) — no `readyTurn`,
  `guessWord`, `skipWord`.
- `games.ts` (`server/src/routes/games.ts`) — SSE and GET strip only `hat` from
  the public payload. No `/ready`, `/guess`, `/skip` routes. `POST /:joinCode/start`
  at line 119 also leaks `hat` (calls `res.json(updated)` without stripping).
- `GamePage.tsx` (`client/src/pages/GamePage.tsx:80-93`) — `ClueGiverView` has a
  hardcoded disabled "Start Turn" button. No active-turn UI exists.

---

## Desired End State

- `POST /:joinCode/ready` sets `turnPhase: 'active'` and populates `currentWord`.
- `POST /:joinCode/guess` removes the word from hat, increments scores, draws the
  next word; ends the round when hat empties.
- `POST /:joinCode/skip` defers the current word, draws the next non-skipped word
  (or falls back to a skipped word if all remaining words are skipped).
- All three endpoints broadcast via SSE so every device updates in real time.
- `GamePage` renders the correct interactive view per role and shows a round-over
  summary to all players when `status === 'round_over'`.

### Key Design Decisions

**Hat model**: `hat` contains ALL unguessed words as `Word` objects (with `id` and
`text`), including `currentWord`. Storing full `Word` objects rather than plain strings
ensures that when two players submit the same word text, guessing one occurrence removes
only that specific word by ID — not all occurrences of that text. `currentWord` (the
text string displayed to the clue giver) is derived from the hat entry by ID.

**Server-internal state**: Three fields are tracked in the store but never sent to
clients — `hat`, `skippedThisTurn`, and `currentWordId`. These are defined on a
server-side `InternalGame` type that extends the shared `Game` type. All public
response paths (SSE, GET, route handler responses) use a `toPublicGame()` helper that
strips these three fields.

**`currentWord` visibility**: Sent to all clients in SSE — no per-client filtering
in the broadcast architecture. The UI simply does not display it to guessers or
spectators. This is a party game; DevTools cheating is not a concern. Similarly,
`playerId` authorization relies on a self-reported UUID (visible to all players in the
SSE `players` array). This is an accepted tradeoff for a colocated party game with no
persistent accounts — noted here for transparency.

**`guessedThisTurn` visibility**: Public. Spectators display the running list of
word texts guessed this turn.

**Draw algorithm** (`drawNextWord`): takes `hat: Word[]`, `current: Word | null`,
`skipped: string[]` (array of word IDs skipped this turn).
1. Prefer words in `hat` where `id !== current?.id` and `id` not in `skipped`.
2. If none, fall back to any word where `id !== current?.id` — this allows
   previously-skipped words to be served, but never re-serves the word just skipped.
3. If none (hat only contains `currentWord`), return `null` → `currentWord` stays
   (player must describe it). Rounds end only through `guessWord` when hat empties.

---

## What We're NOT Doing

- No timer or `POST /end-turn` — those are ENG-012.
- No turn rotation to the next clue giver — ENG-012.
- No `status: 'finished'` (multi-round completion) — future ticket.
- No per-client SSE filtering of `currentWord` — not needed for a party game.
- No `hatSize` field — the client doesn't need a word count in this ticket.
- No regression to existing `ClueGiverView` component tests — there are no
  component tests for `GamePage` in this codebase yet.

---

## Phase 1: Extend Shared `Game` Type

### Overview

Add the new public fields and the `'round_over'` status value. Change `hat` from
`string[]` to `Word[]`. `skippedThisTurn` and `currentWordId` are server-internal and
live only on `InternalGame` (defined in Phase 2).

**Important**: Do NOT include `hat` on the shared `Game` type. `hat` is server-internal — it lives only on `InternalGame` in the store. Adding it to the shared type would make it appear to client code as a valid, typed property even though it is never populated in client payloads. If the client ever needs a word count, add a dedicated `hatSize?: number` public field instead.

### Changes Required

**File**: `shared/src/types.ts`

```ts
export type Game = {
  id: string
  joinCode: string
  status: 'lobby' | 'in_progress' | 'round_over' | 'finished'
  players: Player[]
  hostId?: string
  activeTeam?: 1 | 2
  currentClueGiverId?: string
  turnPhase?: 'ready' | 'active'
  scores?: { team1: number; team2: number }
  currentWord?: string
  guessedThisTurn?: string[]
}
```

All new fields are optional so existing tests that construct bare `Game` objects
compile without changes.

### Success Criteria

#### Automated Verification

- [x] TypeScript compiles: `cd shared && pnpm build`

---

## Phase 2: Server — Store Interface, Implementation, and Tests

### Overview

Define a server-private `InternalGame` type. Add `readyTurn`, `guessWord`, `skipWord`
to the `GameStore` interface, implement them in `InMemoryGameStore`. Write store-level
unit tests **first** (they will fail until the implementation is complete).

### Changes Required

#### 1. `GameStore` interface

**File**: `server/src/store/GameStore.ts`

Add three method signatures:

```ts
readyTurn(joinCode: string, playerId: string): Promise<Game>
guessWord(joinCode: string, playerId: string): Promise<Game>
skipWord(joinCode: string, playerId: string): Promise<Game>
```

#### 2. `InternalGame` type and updated store fields

**File**: `server/src/store/InMemoryGameStore.ts`

Add an `InternalGame` type at the top of the file (after imports). Export it so `toPublicGame` in the route layer can reference it as its parameter type — this creates a single source of truth for internal fields, and the compiler will enforce that `toPublicGame` is updated whenever `InternalGame` grows:

```ts
export type InternalGame = Game & {
  hat: Word[]
  skippedThisTurn: string[]  // word IDs skipped this turn
  currentWordId?: string     // ID of the word currently being described
}
```

Change the `games` map to use `InternalGame`:

```ts
private readonly games = new Map<string, InternalGame>()
```

Update `startGame` to build the hat as `Word[]` (not strings):

```ts
// before
const allWords = game.players.flatMap((p) =>
  (this.words.get(`${joinCode}:${p.id}`) ?? []).map((w) => w.text),
)

// after
const allWords: Word[] = game.players.flatMap((p) =>
  this.words.get(`${joinCode}:${p.id}`) ?? []
)
```

The Fisher-Yates shuffle body is unchanged — it operates on the array regardless of element type.

#### 3. Logging guidance

Any structured log lines added in the store methods (e.g. recording which word was guessed, hat size, etc.) must use `logger.debug` — **not** `logger.info` — when they include game word content. The hat word list is sensitive game data that should only appear in logs during active debugging, not in default production output. The log level will be raised to `info` in development and kept at `warn`/`error` in production as needed.

#### 4. Private helpers

Add after the existing `subscribe` method:

```ts
private assertClueGiverTurn(joinCode: string, playerId: string): InternalGame {
  const game = this.games.get(joinCode)
  if (!game) throw new AppError('NOT_FOUND', 'Game not found')
  if (game.status !== 'in_progress') throw new AppError('TURN_NOT_ALLOWED', 'Game is not in progress')
  if (game.currentClueGiverId !== playerId) throw new AppError('FORBIDDEN', 'Only the clue giver can do this')
  return game
}

private drawNextWord(hat: Word[], current: Word | null, skipped: string[]): Word | null {
  const available = hat.filter((w) => w.id !== current?.id && !skipped.includes(w.id))
  if (available.length > 0) return available[0]
  const fallback = hat.filter((w) => w.id !== current?.id)
  if (fallback.length > 0) return fallback[0]
  return null
}
```

#### 4. Add `readyTurn`

```ts
async readyTurn(joinCode: string, playerId: string): Promise<Game> {
  const game = this.assertClueGiverTurn(joinCode, playerId)
  if (game.turnPhase !== 'ready') throw new AppError('TURN_ALREADY_ACTIVE', 'Turn is already active')

  const firstWord = game.hat[0] ?? null
  if (!firstWord) throw new AppError('HAT_EMPTY', 'Hat is empty')

  Object.assign(game, {
    turnPhase: 'active',
    currentWord: firstWord.text,
    currentWordId: firstWord.id,
    skippedThisTurn: [],
    guessedThisTurn: [],
  })

  const snapshot = { ...game, players: [...game.players] }
  this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))
  return snapshot
}
```

#### 5. Add `guessWord`

```ts
async guessWord(joinCode: string, playerId: string): Promise<Game> {
  const game = this.assertClueGiverTurn(joinCode, playerId)
  if (game.turnPhase !== 'active') throw new AppError('TURN_NOT_ACTIVE', 'Turn is not active')
  if (!game.currentWordId) throw new AppError('INVALID_STATE', 'No current word set')

  // Guard optional fields before any mutation — ensures no partial state corruption
  if (!game.scores) throw new AppError('INVALID_STATE', 'Game scores not initialised')
  if (!game.activeTeam) throw new AppError('INVALID_STATE', 'Active team not set')
  if (!game.currentWord) throw new AppError('INVALID_STATE', 'Current word text not set')

  const currentId = game.currentWordId
  const currentText = game.currentWord
  game.hat = game.hat.filter((w) => w.id !== currentId)
  game.scores[game.activeTeam === 1 ? 'team1' : 'team2']++
  game.guessedThisTurn = [...(game.guessedThisTurn ?? []), currentText]

  if (game.hat.length === 0) {
    Object.assign(game, {
      status: 'round_over',
      currentWord: undefined,
      currentWordId: undefined,
      turnPhase: undefined,
    })
  } else {
    const next = this.drawNextWord(game.hat, null, game.skippedThisTurn)
    game.currentWord = next?.text
    game.currentWordId = next?.id
  }

  const snapshot = { ...game, players: [...game.players] }
  this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))
  return snapshot
}
```

#### 6. Add `skipWord`

```ts
async skipWord(joinCode: string, playerId: string): Promise<Game> {
  const game = this.assertClueGiverTurn(joinCode, playerId)
  if (game.turnPhase !== 'active') throw new AppError('TURN_NOT_ACTIVE', 'Turn is not active')
  if (!game.currentWordId) throw new AppError('INVALID_STATE', 'No current word set')

  const current: Word = { id: game.currentWordId, text: game.currentWord! }
  game.skippedThisTurn = [...game.skippedThisTurn, current.id]

  const next = this.drawNextWord(game.hat, current, game.skippedThisTurn)
  if (next) {
    game.currentWord = next.text
    game.currentWordId = next.id
  }
  // else: currentWord stays — only the just-skipped word remains, player must describe it

  const snapshot = { ...game, players: [...game.players] }
  this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))
  return snapshot
}
```

#### 7. Store unit tests (write first — they should fail before implementation)

**File**: `server/src/store/InMemoryGameStore.test.ts`

Add a new `describe` block at the bottom of the existing file. Use a shared
`setupActiveGame` helper that builds a started game and calls `readyTurn` to put
it in the `active` turn phase.

Key test cases:

**`readyTurn`:**
- Sets `turnPhase: 'active'` and `currentWord` to first word's text in hat
- Resets `guessedThisTurn` to `[]`
- Broadcasts the updated game
- Throws `FORBIDDEN` when caller is not the clue giver
- Throws `TURN_ALREADY_ACTIVE` when `turnPhase === 'active'`
- Throws `TURN_NOT_ALLOWED` when game not `in_progress`

**`guessWord`:**
- Removes only the guessed word by ID (not all words with same text) — test with a hat containing two words with identical text; assert hat still has one entry after guessing
- Increments exactly the active team's score and leaves the other team's score unchanged (assert both `scores.team1` and `scores.team2` explicitly)
- Appends guessed word text to `guessedThisTurn`; accumulates correctly across two consecutive guesses
- `currentWord` advances to the next word
- Sets `status: 'round_over'` and clears `currentWord` when hat empties; a subsequent `guessWord` call throws `TURN_NOT_ALLOWED`
- Broadcasts the updated game
- Throws `FORBIDDEN`, `TURN_NOT_ACTIVE`, `TURN_NOT_ALLOWED` appropriately

**`skipWord`:**
- Appends current word's ID to `skippedThisTurn`; `currentWord` advances to a non-skipped word
- Skipped word does not reappear as the primary draw while other non-skipped words remain
- After a guess, a previously-skipped word does not immediately resurface as the next word (the fallback respects the just-skipped word exclusion but not past-skipped words in primary draw)
- Falls back to a previously-skipped word when all remaining words are skipped (skipping all but one, then skipping the last available non-skipped word)
- When only one word remains and it is skipped: `currentWord` stays (the same word), `status` remains `'in_progress'`
- A subsequent `skipWord` call throws `TURN_NOT_ALLOWED` after `status` is `round_over`
- Broadcasts the updated game
- Throws `FORBIDDEN`, `TURN_NOT_ACTIVE`, `TURN_NOT_ALLOWED` appropriately

### Success Criteria

#### Automated Verification

- [x] New store tests pass: `cd server && pnpm test`
- [x] TypeScript compiles: `cd server && pnpm build`

---

## Phase 3: Server — Route Handlers and Route Tests

### Overview

Add `POST /:joinCode/ready`, `POST /:joinCode/guess`, `POST /:joinCode/skip`.
Extract a `toPublicGame` helper for consistent field stripping. Fix the existing
`POST /:joinCode/start` which currently leaks `hat`. Write route tests **first**.

### Changes Required

#### 1. Add `toPublicGame` helper

**File**: `server/src/routes/games.ts`

Add near the top of the file (after the validator functions). Accept `InternalGame` as the parameter type so TypeScript enforces that `toPublicGame` is updated whenever `InternalGame` grows — the compiler will flag any new internal field that isn't stripped here:

```ts
import type { InternalGame } from '../store/InMemoryGameStore.js'

function toPublicGame(game: InternalGame) {
  const { hat: _hat, skippedThisTurn: _skipped, currentWordId: _id, ...publicGame } = game
  return publicGame
}
```

Replace all existing `const { hat: _hat, ...publicGame } = game` destructurings with
`toPublicGame(game)` — there are three in the SSE handler and GET handler. This is the
single authoritative definition of what is public; any future server-internal field
needs only one change here (adding it to `InternalGame` and destructuring it out in `toPublicGame`).

#### 2. Fix `POST /:joinCode/start` — existing hat leak

**File**: `server/src/routes/games.ts`, line 119

```ts
// before
res.json(updated)

// after
res.json(toPublicGame(updated))
```

#### 3. Add `POST /:joinCode/ready`

```ts
router.post('/:joinCode/ready', async (req, res, next) => {
  try {
    const joinCode = req.params.joinCode.toUpperCase()
    const { playerId } = req.body ?? {}
    if (typeof playerId !== 'string' || !playerId) {
      return res.status(400).json({ error: 'playerId is required' })
    }
    const updated = await store.readyTurn(joinCode, playerId)
    return res.json(toPublicGame(updated))
  } catch (err: unknown) {
    if (err instanceof AppError && err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message })
    if (err instanceof AppError && err.code === 'FORBIDDEN') return res.status(403).json({ error: err.message })
    if (err instanceof AppError && err.code === 'TURN_ALREADY_ACTIVE') return res.status(422).json({ error: err.message })
    if (err instanceof AppError && err.code === 'TURN_NOT_ALLOWED') return res.status(422).json({ error: err.message })
    if (err instanceof AppError && err.code === 'HAT_EMPTY') return res.status(422).json({ error: err.message })
    next(err)
  }
})
```

#### 4. Add `POST /:joinCode/guess`

```ts
router.post('/:joinCode/guess', async (req, res, next) => {
  try {
    const joinCode = req.params.joinCode.toUpperCase()
    const { playerId } = req.body ?? {}
    if (typeof playerId !== 'string' || !playerId) {
      return res.status(400).json({ error: 'playerId is required' })
    }
    const updated = await store.guessWord(joinCode, playerId)
    return res.json(toPublicGame(updated))
  } catch (err: unknown) {
    if (err instanceof AppError && err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message })
    if (err instanceof AppError && err.code === 'FORBIDDEN') return res.status(403).json({ error: err.message })
    if (err instanceof AppError && err.code === 'TURN_NOT_ACTIVE') return res.status(422).json({ error: err.message })
    if (err instanceof AppError && err.code === 'TURN_NOT_ALLOWED') return res.status(422).json({ error: err.message })
    if (err instanceof AppError && err.code === 'INVALID_STATE') return res.status(500).json({ error: 'Internal game state error — please reload' })
    next(err)
  }
})
```

#### 5. Add `POST /:joinCode/skip`

```ts
router.post('/:joinCode/skip', async (req, res, next) => {
  try {
    const joinCode = req.params.joinCode.toUpperCase()
    const { playerId } = req.body ?? {}
    if (typeof playerId !== 'string' || !playerId) {
      return res.status(400).json({ error: 'playerId is required' })
    }
    const updated = await store.skipWord(joinCode, playerId)
    return res.json(toPublicGame(updated))
  } catch (err: unknown) {
    if (err instanceof AppError && err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message })
    if (err instanceof AppError && err.code === 'FORBIDDEN') return res.status(403).json({ error: err.message })
    if (err instanceof AppError && err.code === 'TURN_NOT_ACTIVE') return res.status(422).json({ error: err.message })
    if (err instanceof AppError && err.code === 'TURN_NOT_ALLOWED') return res.status(422).json({ error: err.message })
    if (err instanceof AppError && err.code === 'INVALID_STATE') return res.status(500).json({ error: 'Internal game state error — please reload' })
    next(err)
  }
})
```

#### 6. Route tests (write first)

**File**: `server/src/routes/games.test.ts`

Extend `mockStore` defaults to include the three new methods:

```ts
readyTurn: async () => ({ id: 'test-id', joinCode: 'ABC123', status: 'in_progress' as const, players: [], turnPhase: 'active' as const, currentWord: 'cat' }),
guessWord: async () => ({ id: 'test-id', joinCode: 'ABC123', status: 'in_progress' as const, players: [], currentWord: 'dog' }),
skipWord: async () => ({ id: 'test-id', joinCode: 'ABC123', status: 'in_progress' as const, players: [], currentWord: 'fish' }),
```

Test cases per endpoint (success + each error):

**`POST /ready`:**
- Returns 200 with updated public game
- Response body does not contain `hat`, `skippedThisTurn`, or `currentWordId`
- Returns 400 when `playerId` is missing
- Returns 404 when store throws `NOT_FOUND`
- Returns 403 when store throws `FORBIDDEN`
- Returns 422 when store throws `TURN_ALREADY_ACTIVE`
- Returns 422 when store throws `TURN_NOT_ALLOWED`
- Returns 422 when store throws `HAT_EMPTY`

**`POST /guess`:**
- Returns 200 with updated public game; response body does not contain `hat`, `skippedThisTurn`, or `currentWordId`
- Returns 200 with `status: 'round_over'` and `scores` when mock returns a round-over state (verifies the route passes through round-over correctly)
- Returns 400 when `playerId` is missing
- Returns 404, 403, 422 for respective store errors (`NOT_FOUND`, `FORBIDDEN`, `TURN_NOT_ACTIVE`, `TURN_NOT_ALLOWED`)
- Returns 500 when store throws `INVALID_STATE`

**`POST /skip`:**
- Returns 200 with updated public game; response body does not contain `hat`, `skippedThisTurn`, or `currentWordId`
- Returns 400 when `playerId` is missing
- Returns 404, 403, 422 for respective store errors
- Returns 500 when store throws `INVALID_STATE`

### Success Criteria

#### Automated Verification

- [x] All tests pass: `cd server && pnpm test`
- [x] TypeScript compiles: `cd server && pnpm build`

---

## Phase 4: Client — GamePage Interactive Views

### Overview

Wire up the three API calls in `GamePage`, expand `ClueGiverView` to handle both
`ready` and `active` turn phases, update `SpectatorView` to show guessed words and
scores, update `GuesserView` text, and add a `RoundOverView` shown to all players
when `status === 'round_over'`.

### Changes Required

**File**: `client/src/pages/GamePage.tsx`

#### 1. `GamePage` — guard ordering: `round_over` check before `currentClueGiverId` guard

The loading guard and `round_over` check **must be separate** and in this order:
1. `if (!game)` → return loading spinner (game data not yet arrived)
2. `if (game.status === 'round_over')` → return `RoundOverView`
3. `if (!game.currentClueGiverId)` → return loading spinner (in-progress game but clue giver not yet set)

Do NOT combine steps 1 and 3 into a single `if (!game || !game.currentClueGiverId)` check. ENG-012 (turn rotation) will clear `currentClueGiverId` when the round ends — if the combined guard fires first, all players will see "Loading..." indefinitely instead of the score summary.

```tsx
// Step 1: game data not yet arrived
if (!game) return <LoadingSpinner />

// Step 2: round is over — show summary before checking clue giver (ENG-012 will clear currentClueGiverId on round end)
if (game.status === 'round_over') {
  return (
    <div className="flex min-h-screen flex-col items-center bg-brand-cream px-4 py-8">
      <div className="w-full max-w-lg">
        <Logo />
        {game.scores
          ? <RoundOverView scores={game.scores} />
          : <p role="status" className="text-gray-400">Loading scores...</p>
        }
      </div>
    </div>
  )
}

// Then the existing clueGiver lookup and role-based render:
const clueGiver = game.players.find((p) => p.id === game.currentClueGiverId)
```

Pass `game`, `joinCode`, and `currentPlayerId` down to `ClueGiverView`. Pass `game`
to `SpectatorView`:

```tsx
return (
  <div className="flex min-h-screen flex-col items-center bg-brand-cream px-4 py-8">
    <div className="w-full max-w-lg">
      <Logo />
      {isClueGiver && (
        <ClueGiverView game={game} joinCode={joinCode!} playerId={currentPlayerId!} />
      )}
      {isGuesser && <GuesserView clueGiverName={clueGiver.name} />}
      {!isClueGiver && !isGuesser && (
        <SpectatorView clueGiverName={clueGiver.name} team={clueGiver.team} game={game} />
      )}
    </div>
  </div>
)
```

#### 2. `ClueGiverView` — Start Turn + active turn UI

Replace the static disabled button. Extract a single `callGameAction` helper to avoid repeating the `setLoading`/`setError`/`fetch`/`finally` pattern for every action. Check `response.ok` so that HTTP 4xx/5xx responses (not just network failures) surface as error messages — without this check, a server rejection silently re-enables the button with no feedback to the user:

```tsx
function ClueGiverView({
  game,
  joinCode,
  playerId,
}: {
  game: Game
  joinCode: string
  playerId: string
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function callGameAction(action: string) {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(`/api/games/${joinCode}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId }),
      })
      if (!response.ok) {
        setError('Something went wrong — please try again')
      }
    } catch {
      setError('Something went wrong — please try again')
    } finally {
      setLoading(false)
    }
  }

  if (game.turnPhase === 'ready') {
    return (
      <div className="mt-8 flex flex-col items-center gap-6 text-center">
        <p className="text-xl font-semibold text-gray-900">You are describing!</p>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <button
          onClick={() => callGameAction('ready')}
          disabled={loading}
          className="rounded-xl bg-brand-coral px-8 py-3 text-sm font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Start Turn
        </button>
      </div>
    )
  }

  return (
    <div className="mt-8 flex flex-col items-center gap-6 text-center">
      <p className="text-sm font-medium uppercase tracking-wide text-gray-500">Describe this word</p>
      <p className="text-4xl font-bold text-gray-900">{game.currentWord}</p>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-4">
        <button
          onClick={() => callGameAction('guess')}
          disabled={loading}
          className="rounded-xl bg-brand-coral px-8 py-3 text-sm font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Guessed!
        </button>
        <button
          onClick={() => callGameAction('skip')}
          disabled={loading}
          className="rounded-xl bg-gray-200 px-8 py-3 text-sm font-semibold text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Skip
        </button>
      </div>
    </div>
  )
}
```

#### 3. `GuesserView` — update text

```tsx
function GuesserView({ clueGiverName }: { clueGiverName: string }) {
  return (
    <div className="mt-8 text-center">
      <p className="text-xl font-semibold text-gray-900">
        Your team is guessing —{' '}
        <span className="text-brand-coral">{clueGiverName}</span> is describing!
      </p>
    </div>
  )
}
```

#### 4. `SpectatorView` — add guessed words list and scores

```tsx
function SpectatorView({
  clueGiverName,
  team,
  game,
}: {
  clueGiverName: string
  team: 1 | 2
  game: Game
}) {
  const guessed = game.guessedThisTurn ?? []
  return (
    <div className="mt-8 flex flex-col gap-6 text-center">
      <p className="text-xl font-semibold text-gray-900">
        Watch closely —{' '}
        <span className="text-brand-teal">{clueGiverName}</span> is describing
        for Team {team}!
      </p>
      {game.scores && (
        <div className="flex justify-center gap-8 text-lg font-medium text-gray-700">
          <span>Team 1: {game.scores.team1}</span>
          <span>Team 2: {game.scores.team2}</span>
        </div>
      )}
      {guessed.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium uppercase tracking-wide text-gray-500">
            Guessed this turn
          </p>
          <ul className="space-y-1">
            {guessed.map((w, i) => (
              <li key={`${i}-${w}`} className="text-gray-800">{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
```

#### 5. `RoundOverView` — new component

```tsx
function RoundOverView({ scores }: { scores: { team1: number; team2: number } }) {
  return (
    <div className="mt-8 flex flex-col items-center gap-6 text-center">
      <p className="text-2xl font-bold text-gray-900">Round Over!</p>
      <div className="flex gap-8 text-xl font-semibold">
        <div className="flex flex-col items-center gap-1">
          <span className="text-sm font-medium uppercase tracking-wide text-gray-500">Team 1</span>
          <span className="text-4xl text-brand-coral">{scores.team1}</span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <span className="text-sm font-medium uppercase tracking-wide text-gray-500">Team 2</span>
          <span className="text-4xl text-brand-teal">{scores.team2}</span>
        </div>
      </div>
    </div>
  )
}
```

### Success Criteria

#### Automated Verification

- [x] TypeScript compiles: `cd client && pnpm build`
- [x] All server tests pass: `cd server && pnpm test`

#### Manual Verification

- [ ] Clue giver presses "Start Turn" → sees first word; teammates see guesser view; other team sees spectator view
- [ ] "Guessed!" → score increments on all screens in real time via SSE; next word appears for clue giver
- [ ] "Skip" → new word appears immediately; the skipped word does not reappear while other non-skipped words remain; if only one word is left the same word stays on screen
- [ ] Keep guessing until hat empties → all devices simultaneously show the round score summary
- [ ] Spectator view shows guessed words incrementing live during the turn and both team scores
- [ ] A network failure during "Guessed!" or "Skip" shows an error message and re-enables the buttons

---

## Testing Strategy

### Store Unit Tests (write first, before implementing)

Test against `InMemoryGameStore` directly (no mocks). The existing `setupReadyGame`
helper builds a started game. Add a `setupActiveGame` helper that calls `readyTurn`
on top of it.

Key logic verified at this level:
- Hat removal by ID (not text) — duplicate-text words are handled correctly
- Score increment targeting the correct team (assert both team scores explicitly)
- `guessedThisTurn` accumulation across multiple consecutive guesses
- Draw algorithm: skip avoidance, fallback to previously-skipped words (but not the just-skipped word), single-word-remaining stays
- `round_over` transition when hat empties via guess
- Post-`round_over` guard: `guessWord` and `skipWord` both throw `TURN_NOT_ALLOWED` after status is `round_over`

### Route Tests (write first, before implementing routes)

Use the existing `mockStore` + `supertest` pattern. Mock all three new methods.
Tests verify HTTP status codes and that `hat`, `skippedThisTurn`, and `currentWordId`
are absent from all three new endpoint responses.

---

## References

- Ticket: `meta/tickets/ENG-011-round1-guess-skip-round-end.md`
- Prior plan: `meta/plans/2026-03-22-ENG-010-round1-game-state-and-routing.md`
- Shared types: `shared/src/types.ts`
- Store implementation: `server/src/store/InMemoryGameStore.ts`
- Store interface: `server/src/store/GameStore.ts`
- Route handlers: `server/src/routes/games.ts`
- Route tests: `server/src/routes/games.test.ts`
- Store tests: `server/src/store/InMemoryGameStore.test.ts`
- GamePage: `client/src/pages/GamePage.tsx`
