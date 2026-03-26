# ENG-015: Configurable Game Settings — Implementation Plan

## Overview

Allow the host to configure words-per-player and round timer per game from the lobby. Settings live on the `Game` object (broadcast via SSE) so every client always shows the latest values. The host edits via two number inputs on blur; non-hosts see the same panel read-only. Once the game starts, settings are locked.

## Current State Analysis

- `WORDS_PER_PLAYER = 3` and `TURN_DURATION_SECONDS = 45` are constants in `shared/src/types.ts`.
- Server `GameConfig` (`server/src/config.ts`) only holds `wordsPerPlayer`; `turnDurationSeconds` has never existed server-side.
- `TURN_DURATION_SECONDS` is used **client-only** in `GamePage.tsx` for the countdown and end-turn trigger.
- `WORDS_PER_PLAYER` is used in `LobbyPage.tsx` (progress display, start gate, `PlayerRow`, `pendingCount`) and in `WordEntryPage.tsx` (limit display, progress bar, add/delete guards). Neither page currently reads from a `Game` object's settings field.
- The server enforces `wordsPerPlayer` in `addWord` (store) and the `/start` gate (route) via a global `config` object — not per-game.
- `Game` has no `settings` field today. There is no update-settings endpoint.
- Existing tests construct `TEST_CONFIG: GameConfig = { wordsPerPlayer: 5 }` — `turnDurationSeconds` will be added as a required field; both test files need the one-line update.

## Desired End State

- `Game` carries `settings: GameSettings` always present from creation, seeded from `DEFAULT_GAME_CONFIG`.
- The host can update settings while `status === 'lobby'` via `PATCH /:joinCode/settings`; reducing `wordsPerPlayer` below any player's current `wordCount` is rejected with a generic (non-name-disclosing) message.
- All SSE-connected clients instantly see config changes via the normal game-state broadcast.
- `addWord` and the `/start` gate read from `game.settings` not the global `config`.
- `GamePage` reads timer duration from `game.settings.turnDurationSeconds`.
- `LobbyPage` shows a settings panel below "Add Words": editable for the host, read-only for everyone else. Invalid inputs show inline errors and disable "Start Game". `PlayerRow` and `pendingCount` display the configured word count.
- `WordEntryPage` reads `wordsPerPlayer` from the game object via `useGameState`.
- The shared constants `WORDS_PER_PLAYER` and `TURN_DURATION_SECONDS` are removed; defaults are hardcoded in `DEFAULT_GAME_CONFIG`.
- All existing tests continue to pass after minor fixture updates described below.

### Verification

```
pnpm check   # typecheck + test + build (all three packages)
```

Manual: create a game, change words-per-player and observe the second tab updates in real time; try entering 0 / 999 and confirm Start Game disables; try reducing words-per-player after a player has submitted words and confirm an error + revert; start the game and confirm a subsequent `PATCH /:joinCode/settings` returns 409.

## What We're NOT Doing

- Server-side enforcement of turn duration (the server still relies on the client calling `/end-turn`; no change here).
- Preventing players from adding words before config is set (Option B — not chosen).
- Persisting config across server restarts (in-memory store; out of scope).

## Key Discoveries

- `InMemoryGameStore.addWord` (`store/InMemoryGameStore.ts:375`) already has the game object in scope — switching to `game.settings.wordsPerPlayer` is a one-liner.
- The WORD_LIMIT_REACHED route handler (`routes/games.ts:157`) builds its error string from `config.wordsPerPlayer`. Moving the message into the `AppError` thrown in the store removes the route's dependency on config for this case. Note: this intentionally couples user-facing error text to the store layer because the per-game limit is only available there.
- After changes, `config` is no longer used by any route handler in `createGamesRouter`. Remove the parameter entirely and update the two call-sites (`index.ts` and `buildApp` in tests) — a two-line change that makes the interface honest.
- `GameStore` interface (`store/GameStore.ts`) needs the new `updateSettings` signature; the test's `mockStore()` needs a matching stub.
- `WordEntryPage.tsx` does not currently call `useGameState` — it only fetches words directly. Adding `useGameState(joinCode)` is the clean path to access `game.settings.wordsPerPlayer`.

---

## Phase 1: Shared types

### Overview

Add `GameSettings` to the shared package, attach it to `Game`, and remove the now-redundant standalone constants.

### Changes

**File**: `shared/src/types.ts`

```typescript
// Remove these two lines:
export const WORDS_PER_PLAYER = 3
export const TURN_DURATION_SECONDS = 45

// Add:
export type GameSettings = {
  wordsPerPlayer: number
  turnDurationSeconds: number
}

// Add `settings` field to Game:
export type Game = {
  // ...all existing fields unchanged...
  settings: GameSettings
}
```

### Success Criteria

#### Automated
- [x] `pnpm --filter shared typecheck` passes

> **Note for implementer**: Removing the constants will cause immediate TypeScript errors in several files that import them. Do not run `pnpm check` until all phases are complete. The per-phase success criteria use package-scoped typecheck commands that can be run incrementally.

---

## Phase 2: Server config

### Overview

Add `turnDurationSeconds` as a **required** field to `GameConfig` (keeping the type honest — every game always has a timer duration). Update `TEST_CONFIG` in both test files. Hardcode both defaults directly in `DEFAULT_GAME_CONFIG` — no more imports from shared constants.

### Changes

**File**: `server/src/config.ts`

```typescript
// No imports needed from @wordfetti/shared

export type GameConfig = {
  wordsPerPlayer: number
  turnDurationSeconds: number
}

export const DEFAULT_GAME_CONFIG: GameConfig = {
  wordsPerPlayer: 3,
  turnDurationSeconds: 45,
}
```

**File**: `server/src/routes/games.test.ts` — update `TEST_CONFIG`:

```typescript
// Before:
const TEST_CONFIG: GameConfig = { wordsPerPlayer: 5 }

// After:
const TEST_CONFIG: GameConfig = { wordsPerPlayer: 5, turnDurationSeconds: 45 }
```

**File**: `server/src/store/InMemoryGameStore.test.ts` — two changes:

1. Remove the `WORDS_PER_PLAYER` import (line 4) — it will no longer exist in shared. Update or remove the comment on line 10 that references it.
2. Update `TEST_CONFIG`:

```typescript
// Before:
const TEST_CONFIG: GameConfig = { wordsPerPlayer: 5 }

// After:
const TEST_CONFIG: GameConfig = { wordsPerPlayer: 5, turnDurationSeconds: 45 }
```

### Success Criteria

#### Automated
- [x] `pnpm --filter server typecheck` passes
- [x] `pnpm test` passes

---

## Phase 3: Store — per-game settings

### Overview

Seed `game.settings` at creation. Switch `addWord` to use per-game settings. Fix snapshot to deep-copy `settings`. Add a conflict guard when reducing `wordsPerPlayer`. Add `updateSettings`.

### Changes

#### 3a. `createGame` — seed settings

**File**: `server/src/store/InMemoryGameStore.ts`

Add `GameSettings` to the shared import line. In `createGame()`, add to the `InternalGame` literal:

```typescript
settings: {
  wordsPerPlayer: this.config.wordsPerPlayer,
  turnDurationSeconds: this.config.turnDurationSeconds,
},
```

#### 3b. `addWord` — use per-game limit + embed message

Change lines 375–377:

```typescript
// Before:
if (playerWords.length >= this.config.wordsPerPlayer) {
  throw new AppError('WORD_LIMIT_REACHED', 'Word limit reached')
}

// After:
if (playerWords.length >= game.settings.wordsPerPlayer) {
  throw new AppError('WORD_LIMIT_REACHED', `You can only submit ${game.settings.wordsPerPlayer} words`)
}
```

#### 3c. New `updateSettings` method

Replace `settings` with a fresh object (not in-place mutation) so the broadcast snapshot is a true copy rather than a shared reference:

```typescript
async updateSettings(joinCode: string, playerId: string, patch: Partial<GameSettings>): Promise<Game> {
  const game = this.games.get(joinCode)
  if (!game) throw new AppError('NOT_FOUND', 'Game not found')
  if (game.status !== 'lobby') throw new AppError('INVALID_STATE', 'Settings can only be changed while the game is in the lobby')
  if (game.hostId !== playerId) throw new AppError('FORBIDDEN', 'Only the host can change game settings')

  if (patch.wordsPerPlayer !== undefined) {
    const hasConflict = game.players.some((p) => p.wordCount > patch.wordsPerPlayer!)
    if (hasConflict) {
      throw new AppError(
        'SETTINGS_CONFLICT',
        `Cannot reduce to ${patch.wordsPerPlayer} — one or more players have already submitted more words`
      )
    }
  }

  // Replace settings object (not in-place mutation) so the snapshot below holds a distinct reference
  game.settings = { ...game.settings, ...patch }
  const snapshot = { ...game, settings: { ...game.settings }, players: [...game.players] }
  this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))
  return snapshot
}
```

#### 3d. `GameStore` interface

**File**: `server/src/store/GameStore.ts`

Add `GameSettings` to the shared import and the new method signature:

```typescript
import type { Game, GameSettings, Player, Team, Word } from '@wordfetti/shared'

// Add to interface:
updateSettings(joinCode: string, playerId: string, patch: Partial<GameSettings>): Promise<Game>
```

#### 3e. Test mock stub + store-level tests

**File**: `server/src/routes/games.test.ts`

In the `mockStore()` factory add:

```typescript
updateSettings: jest.fn(),
```

Also update all inline `Game` object literals in the `mockStore()` factory and any `baseGame` fixtures to include the new required `settings` field:

```typescript
settings: { wordsPerPlayer: 5, turnDurationSeconds: 45 },
```

**File**: `server/src/store/InMemoryGameStore.test.ts`

Add a `describe('updateSettings', ...)` block covering:

- `NOT_FOUND` — unknown joinCode
- `INVALID_STATE` — game is `in_progress` (not lobby)
- `FORBIDDEN` — `playerId` is not `hostId`
- `SETTINGS_CONFLICT` — a player's `wordCount` exceeds the new `wordsPerPlayer`
- Success: `game.settings.wordsPerPlayer` updated, SSE subscriber notified with new value
- Success: `game.settings.turnDurationSeconds` updated independently

Also add a short test asserting that a newly created game has settings seeded correctly from config:

```typescript
it('seeds settings from config at game creation', async () => {
  const { game } = await store.createGameWithHost('Alice', 1)
  expect(game.settings.wordsPerPlayer).toBe(TEST_CONFIG.wordsPerPlayer)
  expect(game.settings.turnDurationSeconds).toBe(TEST_CONFIG.turnDurationSeconds)
})
```

### Success Criteria

#### Automated
- [x] `pnpm test` — all existing and new store tests pass
- [x] `pnpm --filter server typecheck` passes

---

## Phase 4: Route — settings endpoint + tidy start gate

### Overview

Add `PATCH /:joinCode/settings`. Update the `/start` gate to use per-game settings. Tidy the WORD_LIMIT_REACHED handler. Remove the now-unused `config` parameter from `createGamesRouter`. Add a per-route rate limiter. Add tests.

### Changes

#### 4a. Remove `config` parameter from `createGamesRouter`

**File**: `server/src/routes/games.ts`

```typescript
// Before:
export function createGamesRouter(store: GameStore, config: GameConfig): Router {

// After:
export function createGamesRouter(store: GameStore): Router {
```

**File**: `server/src/index.ts` — remove the second argument:

```typescript
// Before:
createGamesRouter(store, DEFAULT_GAME_CONFIG)

// After:
createGamesRouter(store)
```

**File**: `server/src/routes/games.test.ts` — update `buildApp`:

```typescript
// Before:
function buildApp(store, config) { ... createGamesRouter(store, config) ... }

// After:
function buildApp(store) { ... createGamesRouter(store) ... }
```

Also remove `GameConfig` from the import in `routes/games.ts` if it was only used for the parameter type.

#### 4b. Fix `/start` gate (line 123)

```typescript
// Before:
const allWordsSubmitted = game.players.every((p) => p.wordCount >= config.wordsPerPlayer)

// After:
const allWordsSubmitted = game.players.every((p) => p.wordCount >= game.settings.wordsPerPlayer)
```

#### 4c. Fix WORD_LIMIT_REACHED handler (line 157)

```typescript
// Before:
return res.status(409).json({ error: `You can only submit ${config.wordsPerPlayer} words` })

// After:
// Message is constructed in the store (the only place with access to per-game wordsPerPlayer)
return res.status(409).json({ error: err.message })
```

#### 4d. New `PATCH /:joinCode/settings` route

Add `GameSettings` to the shared import at the top of the file. Add a per-route rate limiter (settings changes fan out to all SSE subscribers; 100 req/30s gives generous headroom for legitimate use while keeping the recovery window short if the limit is ever hit). Add the route before `return router`:

```typescript
// Per-route limiter: settings changes broadcast to all connected clients via SSE.
// 100 req per 30s is generous for legitimate use (a human can barely trigger 10)
// but keeps the recovery window short if somehow hit during testing.
const settingsLimiter = rateLimit({ windowMs: 30_000, max: 100 })

// PATCH /:joinCode/settings — host updates game settings (lobby only)
router.patch('/:joinCode/settings', settingsLimiter, async (req, res, next) => {
  try {
    const joinCode = req.params.joinCode.toUpperCase()
    const { playerId, wordsPerPlayer, turnDurationSeconds } = req.body ?? {}

    if (typeof playerId !== 'string' || !playerId) {
      return res.status(400).json({ error: 'playerId is required' })
    }

    const patch: Partial<GameSettings> = {}

    if (wordsPerPlayer !== undefined) {
      if (!Number.isInteger(wordsPerPlayer) || wordsPerPlayer < 1 || wordsPerPlayer > 20) {
        return res.status(400).json({ error: 'wordsPerPlayer must be an integer between 1 and 20' })
      }
      patch.wordsPerPlayer = wordsPerPlayer
    }

    if (turnDurationSeconds !== undefined) {
      if (!Number.isInteger(turnDurationSeconds) || turnDurationSeconds < 5 || turnDurationSeconds > 600) {
        return res.status(400).json({ error: 'turnDurationSeconds must be an integer between 5 and 600' })
      }
      patch.turnDurationSeconds = turnDurationSeconds
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'At least one setting field must be provided' })
    }

    const updated = await store.updateSettings(joinCode, playerId, patch)
    return res.json(toPublicGame(updated))
  } catch (err: unknown) {
    if (err instanceof AppError && err.code === 'NOT_FOUND') return res.status(404).json({ error: 'Game not found' })
    if (err instanceof AppError && err.code === 'FORBIDDEN') return res.status(403).json({ error: 'Only the host can change game settings' })
    if (err instanceof AppError && err.code === 'INVALID_STATE') return res.status(409).json({ error: err.message })
    if (err instanceof AppError && err.code === 'SETTINGS_CONFLICT') return res.status(409).json({ error: err.message })
    next(err)
  }
})
```

Check how `rateLimit` is imported in the existing codebase and use the same import pattern.

#### 4e. Tests for the new endpoint

**File**: `server/src/routes/games.test.ts`

Update all `baseGame` fixture objects to include `settings: { wordsPerPlayer: 5, turnDurationSeconds: 45 }` so the migrated `/start` gate test (`game.settings.wordsPerPlayer`) works correctly.

Add a specific `/start` gate test asserting it reads from `game.settings.wordsPerPlayer`:

```typescript
it('uses game.settings.wordsPerPlayer (not global config) for the all-words-submitted gate', async () => {
  // game.settings.wordsPerPlayer = 2, players each have wordCount = 2 → should start
  const game = { ...baseGame, settings: { wordsPerPlayer: 2, turnDurationSeconds: 45 },
    players: [
      { ...player1, wordCount: 2 },
      { ...player2, wordCount: 2 },
      { ...player3, wordCount: 2 },
      { ...player4, wordCount: 2 },
    ]
  }
  mockStore({ getGameByJoinCode: jest.fn().mockResolvedValue(game), startGame: jest.fn().mockResolvedValue(game) })
  const res = await request(app).post(`/api/games/${game.joinCode}/start`).send({ playerId: game.hostId })
  expect(res.status).toBe(200)
})
```

New `describe('PATCH /:joinCode/settings', ...)` block:

- `400` — missing `playerId`
- `400` — empty patch (no fields)
- `400` — `wordsPerPlayer: 0`, `wordsPerPlayer: 21`, `wordsPerPlayer: 1.5` (non-integer)
- `400` — `turnDurationSeconds: 4`, `turnDurationSeconds: 601`, `turnDurationSeconds: 0.5`
- `403` — `playerId` is not the host (mock store throws `FORBIDDEN`)
- `409` — game already started (mock store throws `INVALID_STATE`)
- `409` — conflict with existing word counts (mock store throws `SETTINGS_CONFLICT`); response body contains the error message
- `404` — unknown `joinCode`
- `200` — valid `{ wordsPerPlayer: 5 }`: response includes `settings.wordsPerPlayer === 5`, internal fields stripped
- `200` — valid `{ turnDurationSeconds: 60 }`: response includes `settings.turnDurationSeconds === 60`

### Success Criteria

#### Automated
- [x] `pnpm test` — all tests (existing + new) pass
- [x] `pnpm --filter server typecheck` passes

---

## Phase 5: Client — LobbyPage

### Overview

Remove the `WORDS_PER_PLAYER` import and read from `game.settings` everywhere — including `PlayerRow`, `TeamColumn`, and `pendingCount`. Add `GameSettingsPanel`. On blur: validate → if valid call API → on API error, revert input to the authoritative `game.settings` value and show the error. Invalid host input disables Start Game.

### Changes

**File**: `client/src/pages/LobbyPage.tsx`

#### 5a. Remove `WORDS_PER_PLAYER` import; update all usages

Remove `WORDS_PER_PLAYER` from the `@wordfetti/shared` import. Add `GameSettings` to the import.

Replace the top-level `allWordsSubmitted` and `pendingCount` derivations:

```typescript
// Before:
const allWordsSubmitted = game.players.every((p) => p.wordCount >= WORDS_PER_PLAYER)
const pendingCount = game.players.filter((p) => p.wordCount < WORDS_PER_PLAYER).length

// After:
const allWordsSubmitted = game.players.every((p) => p.wordCount >= game.settings.wordsPerPlayer)
const pendingCount = game.players.filter((p) => p.wordCount < game.settings.wordsPerPlayer).length
```

Update `TeamColumn` to accept and pass through `wordsPerPlayer`:

```typescript
// Before:
type TeamColumnProps = { team: 1 | 2; players: Player[]; currentPlayerId: string | null }

// After:
type TeamColumnProps = { team: 1 | 2; players: Player[]; currentPlayerId: string | null; wordsPerPlayer: number }
```

Pass `game.settings.wordsPerPlayer` at the `TeamColumn` call-site.

Update `PlayerRow` to accept `wordsPerPlayer` as a prop instead of reading the constant:

```typescript
// Before (inside PlayerRow):
const done = player.wordCount >= WORDS_PER_PLAYER
// display: {player.wordCount} / {WORDS_PER_PLAYER}

// After:
// PlayerRow receives wordsPerPlayer: number prop
const done = player.wordCount >= wordsPerPlayer
// display: {player.wordCount} / {wordsPerPlayer}
```

`TeamColumn` passes `wordsPerPlayer` down to each `PlayerRow`.

#### 5b. Settings validity gate

Add near the top of `LobbyPage` (after `game` is available):

```typescript
const [settingsValid, setSettingsValid] = useState(true)
```

Add `!settingsValid` to the Start Game button's `disabled` condition:

```tsx
disabled={needsMorePlayers || !allWordsSubmitted || !settingsValid}
```

#### 5c. Insert panel in JSX

Render `GameSettingsPanel` below the Add Words button block and above the host footer, but only when the player has a session:

```tsx
{currentPlayerId && (
  <GameSettingsPanel
    settings={game.settings}
    isHost={currentPlayerId === game.hostId}
    joinCode={joinCode!}
    playerId={currentPlayerId}
    onValidityChange={setSettingsValid}
  />
)}
```

#### 5d. `GameSettingsPanel` component

Add the component at the end of the file. Use a `useRef` to track the latest `settings` prop inside async handlers, avoiding the stale-closure revert issue:

```tsx
type GameSettingsPanelProps = {
  settings: GameSettings
  isHost: boolean
  joinCode: string
  playerId: string
  onValidityChange: (valid: boolean) => void
}

function GameSettingsPanel({ settings, isHost, joinCode, playerId, onValidityChange }: GameSettingsPanelProps) {
  const [wordsInput, setWordsInput] = useState(String(settings.wordsPerPlayer))
  const [timerInput, setTimerInput] = useState(String(settings.turnDurationSeconds))
  const [wordsError, setWordsError] = useState<string | null>(null)
  const [timerError, setTimerError] = useState<string | null>(null)

  // Track latest settings in a ref so async handlers always revert to the current server value
  const settingsRef = useRef(settings)
  useEffect(() => { settingsRef.current = settings }, [settings])

  // Keep local inputs in sync with SSE updates
  useEffect(() => { setWordsInput(String(settings.wordsPerPlayer)) }, [settings.wordsPerPlayer])
  useEffect(() => { setTimerInput(String(settings.turnDurationSeconds)) }, [settings.turnDurationSeconds])

  // Propagate validity to parent so Start Game can be gated
  useEffect(() => {
    onValidityChange(wordsError === null && timerError === null)
  }, [wordsError, timerError, onValidityChange])

  async function saveField(field: 'wordsPerPlayer' | 'turnDurationSeconds', value: number) {
    const res = await fetch(`/api/games/${joinCode}/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, [field]: value }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      // Use the ref to get the authoritative server value at the time the response arrives
      const revertValue = settingsRef.current[field]
      if (field === 'wordsPerPlayer') {
        setWordsError(body.error ?? 'Could not save setting')
        setWordsInput(String(revertValue))
      } else {
        setTimerError(body.error ?? 'Could not save setting')
        setTimerInput(String(revertValue))
      }
    }
  }

  function handleWordsBlur() {
    const n = Number(wordsInput)
    if (!Number.isInteger(n) || n < 1 || n > 20) {
      setWordsError('Must be a whole number between 1 and 20')
      return
    }
    setWordsError(null)
    if (n !== settings.wordsPerPlayer) saveField('wordsPerPlayer', n)
  }

  function handleTimerBlur() {
    const n = Number(timerInput)
    if (!Number.isInteger(n) || n < 5 || n > 600) {
      setTimerError('Must be a whole number between 5 and 600')
      return
    }
    setTimerError(null)
    if (n !== settings.turnDurationSeconds) saveField('turnDurationSeconds', n)
  }

  if (!isHost) {
    return (
      <div className="mt-4 rounded-xl bg-white px-4 py-3 text-sm text-gray-600">
        <p className="mb-2 font-semibold text-gray-700">Game Settings</p>
        <p>Words per player: <span className="font-medium">{settings.wordsPerPlayer}</span></p>
        <p>Round timer: <span className="font-medium">{settings.turnDurationSeconds}s</span></p>
      </div>
    )
  }

  return (
    <div className="mt-4 rounded-xl bg-white px-4 py-3 text-sm">
      <p className="mb-3 font-semibold text-gray-700">Game Settings</p>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-gray-600">Words per player (1–20)</span>
          <input
            type="number"
            min={1}
            max={20}
            value={wordsInput}
            onChange={(e) => setWordsInput(e.target.value)}
            onBlur={handleWordsBlur}
            className="rounded-lg border border-gray-200 px-3 py-2 text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-coral"
          />
          {wordsError && <p className="text-xs text-red-500">{wordsError}</p>}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-gray-600">Round timer in seconds (5–600)</span>
          <input
            type="number"
            min={5}
            max={600}
            value={timerInput}
            onChange={(e) => setTimerInput(e.target.value)}
            onBlur={handleTimerBlur}
            className="rounded-lg border border-gray-200 px-3 py-2 text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-coral"
          />
          {timerError && <p className="text-xs text-red-500">{timerError}</p>}
        </label>
      </div>
    </div>
  )
}
```

Add `useRef` to the React import line.

### Success Criteria

#### Automated
- [x] `pnpm --filter client typecheck` passes
- [x] `pnpm --filter client build` passes

#### Manual
- [x] Host sees inputs pre-filled with defaults (3 words / 45s)
- [x] Non-host sees read-only panel with same values
- [x] Host changes a value; second tab updates in real time without refresh
- [x] `PlayerRow` shows correct fraction (`/N`) matching the configured word count
- [x] Entering 0 or 21 in words field shows inline error and disables Start Game
- [x] Clearing a field shows error and disables Start Game; restoring a valid value re-enables
- [x] Host reduces words-per-player below a player's existing count: API call fails, input reverts to previous value, generic error shown (no player name exposed)
- [x] Blurring a field with unchanged valid value does not call the API

---

## Phase 6: Client — WordEntryPage

### Overview

`WordEntryPage.tsx` currently reads `WORDS_PER_PLAYER` directly. Add `useGameState` to access the live game object and replace all constant usages with `game.settings.wordsPerPlayer`.

### Changes

**File**: `client/src/pages/WordEntryPage.tsx`

Add `useGameState` to the imports (wherever it is imported from in other pages, e.g. `'../hooks/useGameState'`). Remove `WORDS_PER_PLAYER` from the `@wordfetti/shared` import.

Add the hook call after `const { joinCode } = useParams()`:

```typescript
const game = useGameState(joinCode)
```

Replace the two derived values:

```typescript
// Before:
const atLimit = words.length >= WORDS_PER_PLAYER
const remaining = WORDS_PER_PLAYER - words.length

// After:
const wordsPerPlayer = game?.settings.wordsPerPlayer ?? 3
const atLimit = words.length >= wordsPerPlayer
const remaining = wordsPerPlayer - words.length
```

Replace all remaining `WORDS_PER_PLAYER` references in JSX with `wordsPerPlayer` (the header badge, progress bar width, and "Back to Lobby" button text).

> The `?? 3` fallback handles the brief window before the SSE connection delivers the first game snapshot. In practice this is near-instant, but it prevents a divide-by-zero or NaN in the progress bar on initial render.

### Success Criteria

#### Automated
- [x] `pnpm --filter client typecheck` passes
- [x] `pnpm --filter client build` passes

#### Manual
- [x] Word entry page shows correct limit count matching whatever the host configured

---

## Phase 7: Client — GamePage

### Overview

Replace the static `TURN_DURATION_SECONDS` with `game.settings.turnDurationSeconds` in `ClueGiverView`.

### Changes

**File**: `client/src/pages/GamePage.tsx`

Remove `TURN_DURATION_SECONDS` from the `@wordfetti/shared` import (remove the import entirely if it was the only named export used). Replace all three occurrences in `ClueGiverView` — the component already receives `game` as a prop:

1. `elapsed >= TURN_DURATION_SECONDS` → `elapsed >= game.settings.turnDurationSeconds`
2. `Math.max(0, TURN_DURATION_SECONDS - Math.floor(...))` → `Math.max(0, game.settings.turnDurationSeconds - Math.floor(...))`
3. Fallback `: TURN_DURATION_SECONDS` → `: game.settings.turnDurationSeconds`

### Success Criteria

#### Automated
- [x] `pnpm --filter client typecheck` passes
- [x] `pnpm check` passes (full build across all packages)

#### Manual
- [x] Set timer to 10s in lobby; in-game countdown starts from 10 and auto-ends turn at 0

---

## Testing Strategy

### New store tests (Phase 3e)

`describe('updateSettings')` in `InMemoryGameStore.test.ts`:
- All four error guards (NOT_FOUND, INVALID_STATE, FORBIDDEN, SETTINGS_CONFLICT)
- Two success cases: `wordsPerPlayer` update with subscriber notification, `turnDurationSeconds` update
- Settings creation seeding test

### New route tests (Phase 4e)

`describe('PATCH /:joinCode/settings')` in `games.test.ts`:
- Input validation edge cases (boundary values, non-integers, empty patch)
- All HTTP error codes (400, 403, 404, 409)
- Two 200 happy-path cases with `settings` field verified in response
- `/start` gate test using `game.settings.wordsPerPlayer`

### Existing tests — required updates

| File | Change |
|---|---|
| `routes/games.test.ts` | Add `turnDurationSeconds: 45` to `TEST_CONFIG`; add `settings` to all `Game` fixtures; update `buildApp` to remove config arg |
| `store/InMemoryGameStore.test.ts` | Add `turnDurationSeconds: 45` to `TEST_CONFIG`; remove `WORDS_PER_PLAYER` import |

No existing test assertions change meaning — only fixtures gain a new required field and test infrastructure is lightly updated.

---

## References

- Ticket: `meta/tickets/ENG-015-configurable-game-settings.md`
- `shared/src/types.ts`
- `server/src/config.ts`
- `server/src/store/InMemoryGameStore.ts`, `server/src/store/GameStore.ts`
- `server/src/routes/games.ts`, `server/src/routes/games.test.ts`
- `client/src/pages/LobbyPage.tsx`, `client/src/pages/WordEntryPage.tsx`, `client/src/pages/GamePage.tsx`
