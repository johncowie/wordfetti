# ENG-003: Live Lobby Updates Implementation Plan

## Overview

Add real-time lobby updates using Server-Sent Events (SSE) so all connected players see new joiners instantly without refreshing.

## Current State Analysis

- `LobbyPage.tsx` does a one-time `fetch` on mount — no polling or live updates
- `InMemoryGameStore` has no pub/sub mechanism — callers cannot subscribe to state changes
- No real-time infrastructure exists (no WebSockets, no SSE, no polling)
- Rate limiter: 20 req/60 s on all `/api` routes — this bounds the rate of new SSE connection attempts but does **not** cap concurrent open connections; a client that establishes 20 connections per minute can accumulate many simultaneous streams (accepted MVP risk — see "What We're NOT Doing")

## Desired End State

When any player calls `POST /api/games/:joinCode/players`, all clients subscribed to `GET /api/games/:joinCode/events` instantly receive the updated game state and their lobby refreshes.

Verification: two browser tabs open on the same lobby; a third tab joins → both existing tabs update within ~1 s, no page refresh required.

### Key Discoveries

- `GameStore` interface: `server/src/store/GameStore.ts:1`
- `InMemoryGameStore.joinGame`: `server/src/store/InMemoryGameStore.ts:46` — this is the mutation point where we notify subscribers
- Games router factory: `server/src/routes/games.ts:14` — already receives the store, so the SSE endpoint can use it directly
- LobbyPage fetch effect: `client/src/pages/LobbyPage.tsx:17` — we keep this for error handling (404 etc.) and add a second effect for SSE

## What We're NOT Doing

- No WebSockets (SSE is one-directional and sufficient)
- No persistence / database
- No polling fallback
- No broadcasting of other game-state changes beyond player joins (status changes etc. are future work)
- No authentication on the SSE endpoint — the join code is the access mechanism (accepted MVP tradeoff; a future ticket should require session validation before streaming)
- No per-game SSE connection cap — acceptable for a small party game; at scale this becomes a DoS vector and a connection ceiling (per-game and per-IP) should be added
- No reconnect-after-transient-failure — the `onerror` handler closes the connection permanently; a server restart mid-session leaves the lobby frozen with no indication to the user. A capped-retry strategy (e.g., 3 attempts with exponential backoff) can be added in a follow-up

## Implementation Approach

Use SSE: the server pushes `Game` snapshots to subscribed clients whenever the player list changes. The store gains a lightweight pub/sub layer (`subscribe`/`unsubscribe`). The SSE route immediately sends the current game state on connect, then streams updates. The client opens an `EventSource` connection after the initial load succeeds.

---

## Phase 1: Add pub/sub to the store

### Overview

Extend `GameStore` with a `subscribe` method and implement it in `InMemoryGameStore`. Notify subscribers inside `joinGame`.

### Changes Required

#### 1. `GameStore` interface

**File**: `server/src/store/GameStore.ts`

Add method signature:

```typescript
subscribe(joinCode: string, callback: (game: Game) => void): () => void
```

#### 2. `InMemoryGameStore` implementation

**File**: `server/src/store/InMemoryGameStore.ts`

Add a private subscribers map and implement the method:

```typescript
private readonly subscribers = new Map<string, Set<(game: Game) => void>>()

subscribe(joinCode: string, callback: (game: Game) => void): () => void {
  if (!this.subscribers.has(joinCode)) {
    this.subscribers.set(joinCode, new Set())
  }
  this.subscribers.get(joinCode)!.add(callback)
  return () => {
    const subs = this.subscribers.get(joinCode)
    if (!subs) return
    subs.delete(callback)
    // Prune the Set entry once empty to avoid accumulating orphaned map entries
    if (subs.size === 0) this.subscribers.delete(joinCode)
  }
}
```

In `joinGame`, after `game.players.push(player)`, broadcast the updated snapshot:

```typescript
const snapshot = { ...game, players: [...game.players] }
this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))
```

#### 3. Unit tests for subscribe

**File**: `server/src/store/InMemoryGameStore.test.ts`

Add a `describe('subscribe')` block:

```typescript
describe('subscribe', () => {
  it('calls the callback with the updated game when a player joins', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    const updates: Game[] = []
    store.subscribe(game.joinCode, (g) => updates.push(g))
    await store.joinGame(game.joinCode, 'Alice', 1)
    expect(updates).toHaveLength(1)
    expect(updates[0].players[0].name).toBe('Alice')
  })

  it('does not call the callback after unsubscribe', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    const updates: Game[] = []
    const unsub = store.subscribe(game.joinCode, (g) => updates.push(g))
    unsub()
    await store.joinGame(game.joinCode, 'Alice', 1)
    expect(updates).toHaveLength(0)
  })

  it('does not call callbacks for a different game', async () => {
    const store = new InMemoryGameStore()
    const game1 = await store.createGame()
    const game2 = await store.createGame()
    const updates: Game[] = []
    store.subscribe(game1.joinCode, (g) => updates.push(g))
    await store.joinGame(game2.joinCode, 'Alice', 1)
    expect(updates).toHaveLength(0)
  })

  it('delivered snapshot is not mutated by a subsequent join', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    const updates: Game[] = []
    store.subscribe(game.joinCode, (g) => updates.push(g))
    await store.joinGame(game.joinCode, 'Alice', 1)
    await store.joinGame(game.joinCode, 'Bob', 2)
    // First snapshot must still reflect only Alice
    expect(updates[0].players).toHaveLength(1)
    expect(updates[0].players[0].name).toBe('Alice')
  })
})
```

#### 4. Update `mockStore` in route tests

**File**: `server/src/routes/games.test.ts`

Adding `subscribe` to the `GameStore` interface makes it a required method. The existing `mockStore` helper must be updated or the route test file will fail to compile. Add a no-op stub:

```typescript
const mockStore = (overrides?: Partial<GameStore>): GameStore => ({
  createGame: async () => ({ ... }),
  createGameWithHost: async () => ({ ... }),
  getGameByJoinCode: async () => null,
  joinGame: async () => ({ ... }),
  subscribe: () => () => {},   // ← add this
  ...overrides,
})
```

### Success Criteria

#### Automated Verification

- [x] TypeScript compiles: `pnpm --filter server build` (or `pnpm --filter server tsc --noEmit`)
- [x] New subscribe tests pass: `pnpm test`
- [x] All existing route and store tests still pass: `pnpm test`

#### Manual Verification

- [ ] n/a (pure backend logic, covered by unit tests)

---

## Phase 2: Add SSE endpoint

### Overview

Add `GET /api/games/:joinCode/events` to the games router. It streams `Game` updates as SSE `data:` lines.

### Changes Required

#### 1. New route in games router

**File**: `server/src/routes/games.ts`

Add before the `return router` line:

```typescript
// GET /:joinCode/events — SSE stream of game state updates
router.get('/:joinCode/events', async (req, res, next) => {
  try {
    const joinCode = req.params.joinCode.toUpperCase()

    // Existence check before committing to SSE (can still return a normal 404)
    if (!await store.getGameByJoinCode(joinCode)) {
      return res.status(404).json({ error: 'Game not found' })
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    // Subscribe BEFORE fetching the snapshot so any player join that occurs
    // in the gap between the two store calls is not silently missed.
    const unsubscribe = store.subscribe(joinCode, (updatedGame) => {
      res.write(`data: ${JSON.stringify(updatedGame)}\n\n`)
    })

    // Fetch a fresh snapshot after subscribing; any concurrent join is now
    // either captured by the callback above or already in this snapshot.
    const snapshot = (await store.getGameByJoinCode(joinCode))!
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`)

    req.on('close', () => {
      unsubscribe()
    })
  } catch (err) {
    next(err)
  }
})
```

#### 2. Route integration tests for SSE endpoint

**File**: `server/src/routes/games.test.ts`

Add a `describe('GET /api/games/:joinCode/events')` block. Use supertest to verify headers and the initial data line, and a spy on `store.subscribe` to verify the unsubscribe path:

```typescript
// SSE tests require careful stream handling: the endpoint never terminates the
// connection server-side, so tests must destroy the response after receiving
// the data they need in order to avoid hanging the test runner.
describe('GET /api/games/:joinCode/events', () => {
  it('returns 404 for an unknown join code', async () => {
    // Short-lived non-streaming response — no special handling needed
    const store = mockStore({ getGameByJoinCode: async () => null })
    const res = await request(buildApp(store)).get('/XXXXXX/events')
    expect(res.status).toBe(404)
  })

  it('returns text/event-stream content type for a known join code', async () => {
    const game = { id: 'g1', joinCode: 'ABC123', status: 'lobby' as const, players: [] }
    const store = mockStore({ getGameByJoinCode: async () => game })
    const res = await request(buildApp(store))
      .get('/ABC123/events')
      .parse((res, callback) => {
        // Destroy immediately — we only need headers, not body
        res.destroy()
        callback(null, null)
      })
    expect(res.headers['content-type']).toMatch(/text\/event-stream/)
  })

  it('sends the current game state as the first data line', async () => {
    const game = { id: 'g1', joinCode: 'ABC123', status: 'lobby' as const, players: [] }
    const store = mockStore({ getGameByJoinCode: async () => game })
    const res = await request(buildApp(store))
      .get('/ABC123/events')
      .parse((res, callback) => {
        let buffer = ''
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
          // Destroy after receiving the first complete SSE event (ends with \n\n)
          if (buffer.includes('\n\n')) res.destroy()
        })
        res.on('close', () => callback(null, buffer))
      })
    expect(res.text).toContain(`data: ${JSON.stringify(game)}`)
  })

  it('calls the unsubscribe function when the connection closes', async () => {
    const game = { id: 'g1', joinCode: 'ABC123', status: 'lobby' as const, players: [] }
    const unsubscribe = vi.fn()
    const store = mockStore({
      getGameByJoinCode: async () => game,
      subscribe: () => unsubscribe,
    })
    await request(buildApp(store))
      .get('/ABC123/events')
      .parse((res, callback) => {
        // Destroy after the first data chunk so req.on('close') fires on the server
        res.on('data', () => res.destroy())
        res.on('close', () => callback(null, null))
      })
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
```

### Success Criteria

#### Automated Verification

- [x] TypeScript compiles: `pnpm --filter server build`
- [x] New SSE route tests pass: `pnpm test`
- [x] All existing API tests still pass: `pnpm test`

#### Manual Verification

- [ ] `curl -N http://localhost:3000/api/games/<code>/events` streams the initial game state as a `data:` line
- [ ] After a second player joins via `POST /api/games/<code>/players`, the curl stream receives a new `data:` line with the updated player list
- [ ] `GET /api/games/XXXXXX/events` returns 404

---

## Phase 3: Update LobbyPage to subscribe to SSE

### Overview

After the initial fetch succeeds, open an `EventSource` connection. Each `message` event carries a full `Game` snapshot — apply it with `setGame`. Close the connection on unmount.

### Changes Required

#### 1. Add SSE subscription effect

**File**: `client/src/pages/LobbyPage.tsx`

Add a second `useEffect` after the existing fetch effect:

```typescript
// The initial fetch effect (above) is the authority for error display (404 etc.)
// and provides the first render of game state. This effect opens the live SSE
// stream for real-time updates. The SSE endpoint also sends the current game
// state immediately on connect, so any staleness from the initial fetch is
// self-corrected without a separate round-trip.
useEffect(() => {
  if (!joinCode) return
  const es = new EventSource(`/api/games/${joinCode}/events`)
  es.onmessage = (event) => {
    setGame(JSON.parse(event.data) as Game)
  }
  es.onerror = (event) => {
    // Close the connection to stop EventSource's automatic retry loop.
    // Without this, a 404 or server error causes the browser to hammer the
    // /events endpoint repeatedly, exhausting the shared rate limiter.
    // The initial fetch effect already shows the appropriate error state.
    console.warn(`[lobby] SSE connection error for game ${joinCode}`, event)
    es.close()
  }
  return () => es.close()
}, [joinCode])
```

### Success Criteria

#### Automated Verification

- [x] TypeScript compiles: `pnpm --filter client build`

#### Manual Verification

- [ ] Open the lobby on two browser tabs for the same game
- [ ] On a third tab / device, navigate to `/join` and join the game
- [ ] Both existing lobby tabs show the new player within ~1 second without refreshing
- [ ] Players are correctly grouped by team
- [ ] Closing one tab does not break the other tab's updates
- [ ] Hard-refreshing a lobby tab re-establishes the connection and shows correct state
- [ ] Navigating away from the lobby and back does not create duplicate SSE connections (verify in browser DevTools → Network)
- [ ] Opening a lobby for a non-existent join code shows the error state and does not repeatedly retry the `/events` endpoint (verify in Network tab — no repeated requests)

---

## Testing Strategy

### Unit Tests (store)

- Subscribe notifies callback when a player joins
- Unsubscribe stops further notifications
- Subscribe for one game does not fire for a different game
- Delivered snapshot is not mutated by a subsequent join (immutability)

### Integration Tests (SSE route)

- 404 returned for unknown join code
- `text/event-stream` content-type set for known join code
- Current game state sent as first `data:` line on connect
- `unsubscribe` called when HTTP connection closes

### Manual Testing Steps

1. Start dev servers: `pnpm dev`
2. Create a game on Tab A → land in lobby
3. Open the same lobby URL on Tab B
4. On Tab C, join the game with a name and team selection
5. Verify Tabs A and B both update instantly

## References

- Original ticket: `meta/tickets/ENG-003-live-lobby-updates.md`
- Games router: `server/src/routes/games.ts`
- InMemoryGameStore: `server/src/store/InMemoryGameStore.ts`
- LobbyPage: `client/src/pages/LobbyPage.tsx`
