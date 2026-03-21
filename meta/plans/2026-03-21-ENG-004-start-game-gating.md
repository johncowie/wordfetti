# ENG-004: Start Game Gating Implementation Plan

## Overview

Add a "Start Game" button visible only to the host that is gated on both teams having ≥ 2 players, and close the game to new joiners once it has started.

## Current State Analysis

- `Game` type (`shared/src/types.ts:9`) has `status: 'lobby' | 'in_progress' | 'finished'` but **no `hostId`** — the data model cannot identify who the host is
- `InMemoryGameStore.createGameWithHost` (`server/src/store/InMemoryGameStore.ts:33`) creates the host player but does not record them on the game object
- `InMemoryGameStore.joinGame` (`server/src/store/InMemoryGameStore.ts:46`) has no status check — it accepts new players on in-progress games
- `LobbyPage` (`client/src/pages/LobbyPage.tsx`) already tracks `currentPlayerId` from the session but has nothing to compare it against for host detection
- `JoinPage` (`client/src/pages/JoinPage.tsx:33`) handles 404 but not 409 — any "game already started" response falls through to the generic error handler
- `AppError` (`server/src/errors.ts`) accepts any string code — no registry, new codes can be added freely

## Desired End State

- The lobby shows a "Start Game" button **only to the host** (identified by `game.hostId === session.playerId`)
- The button is **disabled** with an explanation when either team has fewer than 2 players
- The button is **enabled** when both teams have ≥ 2 players; clicking it calls `POST /api/games/:joinCode/start`
- On start, `game.status` transitions to `'in_progress'`; SSE subscribers receive the updated game state automatically
- Any subsequent `POST /api/games/:joinCode/players` request is rejected with 409 and a clear error message
- `JoinPage` shows "This game has already started" for a 409 response

Verification: lobby with 1 player per team → button disabled; add second player to each team → button enabled; host starts → join attempt on another device shows "already started" error.

### Key Discoveries

- `hostId` will be **optional** (`hostId?: string`) so the no-host `createGame()` codepath and existing test mocks don't need changing
- Authorization for `/start` uses `playerId` from the request body (consistent with the rest of the system which has no session-level auth)
- SSE is already wired up from ENG-003 — `startGame` just needs to notify subscribers and the lobby updates propagate automatically
- `createGameWithHost` calls `joinGame` internally (`InMemoryGameStore.ts:35`), so the `GAME_IN_PROGRESS` guard in `joinGame` must only apply when a game already exists in non-lobby state, not during initial creation

## What We're NOT Doing

- No authentication — `playerId` in the request body is trusted (same as the rest of the system)
- No UI transition when the game starts (what existing lobby watchers see after start is future work)
- No `'finished'` status transitions (future work)
- No per-player word submission (future work)

## Implementation Approach

Three sequential phases: (1) extend the data model and store with host tracking, start transition, and join gating; (2) expose start via a new API route and handle the new error on the join route; (3) wire up the UI in LobbyPage and JoinPage.

---

## Phase 1: Data model & store

### Overview

Add `hostId` to the shared `Game` type, record it in `createGameWithHost`, add `startGame` to the store, and gate `joinGame` on lobby status.

### Changes Required

#### 1. Shared `Game` type

**File**: `shared/src/types.ts`

Add optional `hostId` field:

```typescript
export type Game = {
  id: string
  joinCode: string
  status: 'lobby' | 'in_progress' | 'finished'
  players: Player[]
  hostId?: string
}
```

#### 2. `GameStore` interface

**File**: `server/src/store/GameStore.ts`

Add `startGame` signature:

```typescript
export interface GameStore {
  createGame(): Promise<Game>
  createGameWithHost(name: string, team: Team): Promise<{ game: Game; player: Player }>
  getGameByJoinCode(joinCode: string): Promise<Game | null>
  joinGame(joinCode: string, name: string, team: Team): Promise<Player>
  subscribe(joinCode: string, callback: (game: Game) => void): () => void
  startGame(joinCode: string): Promise<Game>
}
```

#### 3. `InMemoryGameStore` implementation

**File**: `server/src/store/InMemoryGameStore.ts`

**3a.** In `createGame`, add `hostId: undefined` (no change needed — optional field defaults to absent).

**3b.** In `createGameWithHost`, record the host's player ID on the game **after** the player is created. Since `createGameWithHost` calls `joinGame` then re-fetches the game, update the internal game object directly:

```typescript
async createGameWithHost(name: string, team: Team): Promise<{ game: Game; player: Player }> {
  const game = await this.createGame()
  const player = await this.joinGame(game.joinCode, name, team)
  // Record the host on the internal game object
  const internal = this.games.get(game.joinCode)!
  internal.hostId = player.id
  const updated = await this.getGameByJoinCode(game.joinCode)
  return { game: updated!, player }
}
```

**3c.** In `joinGame`, add a status guard before pushing the player:

```typescript
async joinGame(joinCode: string, name: string, team: Team): Promise<Player> {
  const game = this.games.get(joinCode)
  if (!game) throw new AppError('NOT_FOUND', 'Game not found')
  if (game.status !== 'lobby') throw new AppError('GAME_IN_PROGRESS', 'Game has already started')
  // ... rest unchanged
}
```

**3d.** Add `startGame` method:

```typescript
async startGame(joinCode: string): Promise<Game> {
  const game = this.games.get(joinCode)
  if (!game) throw new AppError('NOT_FOUND', 'Game not found')
  game.status = 'in_progress'
  const snapshot = { ...game, players: [...game.players] }
  this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))
  return snapshot
}
```

#### 4. `mockStore` in route tests

**File**: `server/src/routes/games.test.ts`

Add a `startGame` stub so the mock satisfies the updated `GameStore` interface:

```typescript
startGame: async () => ({ id: 'test-id', joinCode: 'ABC123', status: 'in_progress' as const, players: [] }),
```

#### 5. Unit tests

**File**: `server/src/store/InMemoryGameStore.test.ts`

Add `describe('createGameWithHost — hostId')`, `describe('startGame')`, and update `joinGame` tests:

```typescript
describe('createGameWithHost — hostId', () => {
  it('records the host player id on the game', async () => {
    const store = new InMemoryGameStore()
    const { game, player } = await store.createGameWithHost('Alice', 1)
    expect(game.hostId).toBe(player.id)
  })
})

describe('startGame', () => {
  it('transitions the game status to in_progress', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    await store.startGame(game.joinCode)
    const updated = await store.getGameByJoinCode(game.joinCode)
    expect(updated?.status).toBe('in_progress')
  })

  it('notifies subscribers with the updated game', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    const updates: Game[] = []
    store.subscribe(game.joinCode, (g) => updates.push(g))
    await store.startGame(game.joinCode)
    expect(updates).toHaveLength(1)
    expect(updates[0].status).toBe('in_progress')
  })

  it('throws NOT_FOUND for an unknown join code', async () => {
    const store = new InMemoryGameStore()
    await expect(store.startGame('XXXXXX')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

// Add to joinGame describe block:
it('throws GAME_IN_PROGRESS when the game has already started', async () => {
  const store = new InMemoryGameStore()
  const game = await store.createGame()
  await store.startGame(game.joinCode)
  await expect(store.joinGame(game.joinCode, 'Alice', 1)).rejects.toMatchObject({
    code: 'GAME_IN_PROGRESS',
  })
})
```

### Success Criteria

#### Automated Verification

- [x] TypeScript compiles: `pnpm --filter shared build && pnpm --filter server build`
- [x] All new store tests pass: `pnpm test`
- [x] All existing store and route tests still pass: `pnpm test`

#### Manual Verification

- [ ] n/a (pure backend logic, covered by unit tests)

---

## Phase 2: API routes

### Overview

Add `POST /api/games/:joinCode/start` with host and team-size validation. Return 409 from the join route when a game has already started.

### Changes Required

#### 1. Start route

**File**: `server/src/routes/games.ts`

Add before the `return router` line:

```typescript
// POST /:joinCode/start — host starts the game
router.post('/:joinCode/start', async (req, res, next) => {
  try {
    const joinCode = req.params.joinCode.toUpperCase()
    const { playerId } = req.body ?? {}

    const game = await store.getGameByJoinCode(joinCode)
    if (!game) return res.status(404).json({ error: 'Game not found' })
    if (game.hostId === undefined || game.hostId !== playerId) {
      return res.status(403).json({ error: 'Only the host can start the game' })
    }

    const team1 = game.players.filter((p) => p.team === 1)
    const team2 = game.players.filter((p) => p.team === 2)
    if (team1.length < 2 || team2.length < 2) {
      return res.status(422).json({ error: 'Both teams need at least 2 players to start' })
    }

    const updated = await store.startGame(joinCode)
    res.json(updated)
  } catch (err) {
    next(err)
  }
})
```

#### 2. Update join route to handle `GAME_IN_PROGRESS`

**File**: `server/src/routes/games.ts`

In the `POST /:joinCode/players` handler, add a 409 case alongside the existing NOT_FOUND handler:

```typescript
  } catch (err: unknown) {
    if (err instanceof AppError && err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Game not found' })
    }
    if (err instanceof AppError && err.code === 'GAME_IN_PROGRESS') {
      return res.status(409).json({ error: 'This game has already started' })
    }
    next(err)
  }
```

#### 3. Route integration tests

**File**: `server/src/routes/games.test.ts`

Add `describe('POST /api/games/:joinCode/start')` and a new case to the join tests:

```typescript
describe('POST /api/games/:joinCode/start', () => {
  const hostId = 'host-player-id'
  const baseGame = {
    id: 'g1',
    joinCode: 'ABC123',
    status: 'lobby' as const,
    players: [
      { id: hostId, name: 'Alice', team: 1 as const },
      { id: 'p2', name: 'Bob', team: 1 as const },
      { id: 'p3', name: 'Carol', team: 2 as const },
      { id: 'p4', name: 'Dave', team: 2 as const },
    ],
    hostId,
  }

  it('returns 404 when the game is not found', async () => {
    const store = mockStore({ getGameByJoinCode: async () => null })
    const res = await request(buildApp(store))
      .post('/ABC123/start')
      .send({ playerId: hostId })
    expect(res.status).toBe(404)
  })

  it('returns 403 when the caller is not the host', async () => {
    const store = mockStore({ getGameByJoinCode: async () => baseGame })
    const res = await request(buildApp(store))
      .post('/ABC123/start')
      .send({ playerId: 'not-the-host' })
    expect(res.status).toBe(403)
  })

  it('returns 403 when no playerId is provided', async () => {
    const store = mockStore({ getGameByJoinCode: async () => baseGame })
    const res = await request(buildApp(store)).post('/ABC123/start').send({})
    expect(res.status).toBe(403)
  })

  it('returns 422 when a team has fewer than 2 players', async () => {
    const shortGame = {
      ...baseGame,
      players: [
        { id: hostId, name: 'Alice', team: 1 as const },
        { id: 'p3', name: 'Carol', team: 2 as const },
      ],
    }
    const store = mockStore({ getGameByJoinCode: async () => shortGame })
    const res = await request(buildApp(store))
      .post('/ABC123/start')
      .send({ playerId: hostId })
    expect(res.status).toBe(422)
  })

  it('returns 200 with the updated game when valid', async () => {
    const started = { ...baseGame, status: 'in_progress' as const }
    const store = mockStore({
      getGameByJoinCode: async () => baseGame,
      startGame: async () => started,
    })
    const res = await request(buildApp(store))
      .post('/ABC123/start')
      .send({ playerId: hostId })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('in_progress')
  })
})

// Add to 'POST /api/games/:joinCode/players' describe block:
it('returns 409 when the game has already started', async () => {
  const store = mockStore({
    joinGame: async () => { throw new AppError('GAME_IN_PROGRESS', 'Game has already started') },
  })
  const res = await request(buildApp(store))
    .post('/ABC123/players')
    .send({ name: 'Alice', team: 1 })
  expect(res.status).toBe(409)
})
```

### Success Criteria

#### Automated Verification

- [x] TypeScript compiles: `pnpm --filter server build`
- [x] All new route tests pass: `pnpm test`
- [x] All existing tests still pass: `pnpm test`

#### Manual Verification

- [ ] `POST /api/games/:joinCode/start` with valid host and ≥2 per team → 200
- [ ] `POST /api/games/:joinCode/start` with wrong playerId → 403
- [ ] `POST /api/games/:joinCode/start` with too few players → 422
- [ ] `POST /api/games/:joinCode/players` on a started game → 409

---

## Phase 3: UI

### Overview

Add the "Start Game" button to `LobbyPage` (host-only, gated on team size) and display a clear message on `JoinPage` for a 409 response.

### Changes Required

#### 1. LobbyPage — Start Game button

**File**: `client/src/pages/LobbyPage.tsx`

Add `startError` state and a `startGame` handler. Show the button section below the team columns — only when `currentPlayerId === game.hostId`:

```typescript
const [startError, setStartError] = useState<string | null>(null)

async function startGame() {
  if (!joinCode || !session) return
  setStartError(null)
  const res = await fetch(`/api/games/${joinCode}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: session.playerId }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    setStartError(body.error ?? 'Something went wrong. Please try again.')
  }
  // On success, SSE will push the updated status automatically — no state change needed here
}
```

In the JSX, replace the "Waiting for more players..." footer with a section that handles both host and non-host views:

```tsx
{/* Host controls */}
{currentPlayerId === game.hostId && (
  <div className="mt-6 flex flex-col items-center gap-2">
    <button
      onClick={startGame}
      disabled={needsMorePlayers}
      className="rounded-xl bg-brand-coral px-8 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
    >
      Start Game
    </button>
    {needsMorePlayers && (
      <p className="text-center text-sm text-gray-400">
        Both teams need at least 2 players to start
      </p>
    )}
    {startError && (
      <p role="alert" className="text-center text-sm text-red-500">{startError}</p>
    )}
  </div>
)}

{/* Non-host waiting message */}
{currentPlayerId !== game.hostId && needsMorePlayers && (
  <p className="mt-6 text-center text-sm text-gray-400">
    Waiting for more players...
  </p>
)}
```

Note: Remove the existing `{needsMorePlayers && <p>Waiting for more players...</p>}` block that was previously unconditional.

#### 2. JoinPage — 409 handling

**File**: `client/src/pages/JoinPage.tsx`

Add a 409 case alongside the existing 404 handler:

```typescript
if (res.status === 404) {
  setError('Game not found. Check the code and try again.')
  return
}
if (res.status === 409) {
  setError('This game has already started.')
  return
}
```

### Success Criteria

#### Automated Verification

- [x] TypeScript compiles: `pnpm --filter client build`

#### Manual Verification

- [ ] In the lobby as the host with 1 player per team → "Start Game" button is visible but disabled; "Both teams need at least 2 players to start" explanation is shown
- [ ] Add a second player to each team → button becomes enabled
- [ ] Host clicks "Start Game" → button action sends correctly; SSE pushes updated status to all connected clients
- [ ] Non-host players in the lobby do not see the "Start Game" button
- [ ] On a second device, attempt to join the started game → JoinPage shows "This game has already started."
- [ ] A player with no session viewing the lobby does not see the "Start Game" button

---

## Testing Strategy

### Unit Tests (store)

- `createGameWithHost` records `hostId = player.id` on the returned game
- `startGame` transitions status to `'in_progress'`
- `startGame` notifies SSE subscribers with the updated game
- `startGame` throws `NOT_FOUND` for unknown join code
- `joinGame` throws `GAME_IN_PROGRESS` when game status is not `'lobby'`

### Integration Tests (routes)

- `POST /start` → 404 game not found
- `POST /start` → 403 wrong player
- `POST /start` → 403 no playerId
- `POST /start` → 422 teams too small
- `POST /start` → 200 valid start
- `POST /players` → 409 game in progress

### Manual Testing Steps

1. `pnpm dev`
2. Create a game (Tab A) — note only 1 player per team → Start button disabled
3. Join on Tab B (Team 1) and Tab C (Team 2) to fill both teams to 2 → Start button on Tab A enables
4. Host clicks Start → verify all tabs' SSE updates (status changes in real time)
5. On Tab D, attempt to join the game code → should see "This game has already started."

## References

- Original ticket: `meta/tickets/ENG-004-start-game-gating.md`
- Shared types: `shared/src/types.ts`
- GameStore interface: `server/src/store/GameStore.ts`
- InMemoryGameStore: `server/src/store/InMemoryGameStore.ts`
- Games router: `server/src/routes/games.ts`
- LobbyPage: `client/src/pages/LobbyPage.tsx`
- JoinPage: `client/src/pages/JoinPage.tsx`
