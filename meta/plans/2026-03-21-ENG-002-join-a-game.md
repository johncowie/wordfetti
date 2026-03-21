# ENG-002: Join a Game — Implementation Plan

## Overview

Add player registration to the create and join flows, persist the player's
identity in `localStorage`, and render a static lobby showing players grouped
by team. The host registers their name and team as part of creating a game and
becomes the first player. Other players join via a join-code form.

## Current State Analysis

- `Game` type has `{ id, joinCode, status }` — no players yet
- `GameStore` exposes `createGame()` and `getGameByJoinCode()` — no join method
- `POST /api/games` is the only API endpoint
- `HomePage` has a permanently-disabled "Join Game" stub
- `/game/:joinCode` (`GameCodePage`) just displays the join code — no player data
- No session/identity concept exists anywhere

## Desired End State

After this ticket:

1. Clicking "Create Game" navigates to `/create` where the host enters their
   name and team. Submitting creates the game AND registers the host as the
   first player. The session is stored in `localStorage`.
2. Clicking "Join Game" navigates to `/join` where any player enters the code,
   their name, and a team. On success the session is stored and they land in
   the lobby.
3. `/game/:joinCode` is a lobby page showing the join code, players grouped
   by team, and "(you)" next to the current player.

### Key Discoveries

- `InMemoryGameStore` stores games in `Map<string, Game>` keyed by `joinCode` —
  adding players is a map mutation with no structural changes needed
- `createGamesRouter` is a factory injected with a `GameStore` — additional
  routes follow the same pattern (`server/src/routes/games.ts`)
- `Logo` component is already extracted and reused across pages
  (`client/src/components/Logo.tsx`)
- Design screens provide exact styling: coral/pink for Team 1, teal/mint for
  Team 2, small pill badges for player count, "Need N more player" hint text

## What We're NOT Doing

- Real-time lobby updates — that is ENG-003 (WebSocket/SSE)
- Start game gating (minimum 2 per team, Start button) — that is ENG-004
- Word submission button/flow — future epic
- Rejecting joins after the game starts — ENG-004
- Name uniqueness enforcement — not required (per earlier decision)
- Word count display per player — future epic

---

## Phase 1: Data Model & Store

### Overview

Extend the shared types with `Team` and `Player`, add `players` to `Game`, add
`joinGame` and `createGameWithHost` to the `GameStore` interface, and implement
them in `InMemoryGameStore`. Introduce an `AppError` class for typed error
discrimination. No API or UI yet — this phase is complete when unit tests pass.

### Changes Required

#### 1. Shared types

**File**: `shared/src/types.ts`

```typescript
export type Team = 1 | 2

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
}
```

#### 2. AppError class

**File**: `server/src/errors.ts`

A typed error class used for domain errors so route handlers can discriminate
by code without fragile casts:

```typescript
export class AppError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'AppError'
  }
}
```

#### 3. GameStore interface

**File**: `server/src/store/GameStore.ts`

Add two methods — `joinGame` for players joining by code, and
`createGameWithHost` which atomically creates a game and registers the host
as the first player (eliminating the two-step partial-failure window):

```typescript
import type { Game, Player, Team } from '@wordfetti/shared'

export interface GameStore {
  createGame(): Promise<Game>
  createGameWithHost(name: string, team: Team): Promise<{ game: Game; player: Player }>
  getGameByJoinCode(joinCode: string): Promise<Game | null>
  joinGame(joinCode: string, name: string, team: Team): Promise<Player>
}
```

#### 4. InMemoryGameStore — initialise players and implement new methods

**File**: `server/src/store/InMemoryGameStore.ts`

Update `createGame` to include `players: []`. Add `createGameWithHost` (atomic
create + register) and `joinGame`. Both return copies rather than live
references to prevent mutation aliasing. `getGameByJoinCode` also returns a
snapshot:

```typescript
async createGame(): Promise<Game> {
  // ... existing join-code collision loop unchanged ...
  const game: Game = {
    id: randomUUID(),
    joinCode,
    status: 'lobby',
    players: [],
  }
  this.games.set(joinCode, game)
  return { ...game, players: [...game.players] }
}

async createGameWithHost(name: string, team: Team): Promise<{ game: Game; player: Player }> {
  // reuse createGame for join-code generation and storage
  const game = await this.createGame()  // returns snapshot
  const player = await this.joinGame(game.joinCode, name, team)
  const updated = await this.getGameByJoinCode(game.joinCode)
  return { game: updated!, player }
}

async getGameByJoinCode(joinCode: string): Promise<Game | null> {
  const game = this.games.get(joinCode)
  if (!game) return null
  return { ...game, players: [...game.players] }
}

async joinGame(joinCode: string, name: string, team: Team): Promise<Player> {
  const game = this.games.get(joinCode)
  if (!game) throw new AppError('NOT_FOUND', 'Game not found')
  const player: Player = { id: randomUUID(), name, team }
  game.players.push(player)
  return { ...player }
}
```

Import `AppError` from `'../errors.js'`.

#### 5. Unit tests

**File**: `server/src/store/InMemoryGameStore.test.ts`

Add to the existing describe block:

```typescript
describe('joinGame', () => {
  it('adds a player to an existing game and returns the player', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    const player = await store.joinGame(game.joinCode, 'Alice', 1)
    expect(player.name).toBe('Alice')
    expect(player.team).toBe(1)
    expect(typeof player.id).toBe('string')
    const updated = await store.getGameByJoinCode(game.joinCode)
    expect(updated?.players).toHaveLength(1)
    expect(updated?.players[0]).toEqual(player)
  })

  it('adds multiple players to the same game', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    await store.joinGame(game.joinCode, 'Alice', 1)
    await store.joinGame(game.joinCode, 'Bob', 2)
    const updated = await store.getGameByJoinCode(game.joinCode)
    expect(updated?.players).toHaveLength(2)
    expect(updated?.players.map((p) => p.name)).toEqual(['Alice', 'Bob'])
  })

  it('throws NOT_FOUND for an unknown join code', async () => {
    const store = new InMemoryGameStore()
    await expect(store.joinGame('XXXXXX', 'Alice', 1)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})

describe('createGameWithHost', () => {
  it('creates a game and registers the host as the first player atomically', async () => {
    const store = new InMemoryGameStore()
    const { game, player } = await store.createGameWithHost('Alice', 1)
    expect(typeof game.joinCode).toBe('string')
    expect(player.name).toBe('Alice')
    expect(player.team).toBe(1)
    const fetched = await store.getGameByJoinCode(game.joinCode)
    expect(fetched?.players).toHaveLength(1)
    expect(fetched?.players[0].name).toBe('Alice')
  })
})
```

### Success Criteria

#### Automated Verification
- [x] `pnpm test` — all store tests pass (including the 4 new store tests)

---

## Phase 2: API Endpoints

### Overview

Add `POST /api/games/:joinCode/players` and `GET /api/games/:joinCode` to the
games router. Update `POST /api/games` to accept an optional `{ name, team }`
body so the host can be registered atomically in a single request (eliminating
the two-step partial-failure window). Route error handling uses `AppError`
`instanceof` checks rather than fragile casts.

### Changes Required

#### 1. Games router

**File**: `server/src/routes/games.ts`

```typescript
import { Router } from 'express'
import type { GameStore } from '../store/GameStore.js'
import type { Team } from '@wordfetti/shared'
import { AppError } from '../errors.js'

function isValidTeam(value: unknown): value is Team {
  return value === 1 || value === 2
}

function isValidName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 50
}

export function createGamesRouter(store: GameStore): Router {
  const router = Router()

  // POST / — creates a game. If { name, team } are provided in the body,
  // atomically registers the host as the first player.
  router.post('/', async (req, res, next) => {
    try {
      const { name, team } = req.body ?? {}
      if (name !== undefined || team !== undefined) {
        // Host registration path
        if (!isValidName(name)) {
          return res.status(400).json({ error: 'Name must be between 1 and 50 characters' })
        }
        if (!isValidTeam(team)) {
          return res.status(400).json({ error: 'Team must be 1 or 2' })
        }
        const { game, player } = await store.createGameWithHost(name.trim(), team)
        res.set('Location', `/api/games/${game.joinCode}`)
        return res.status(201).json({ joinCode: game.joinCode, player })
      }
      // No-body path (kept for backward compatibility with tests)
      const game = await store.createGame()
      res.set('Location', `/api/games/${game.joinCode}`)
      res.status(201).json({ joinCode: game.joinCode })
    } catch (err) {
      next(err)
    }
  })

  // GET /:joinCode — fetch game state (players grouped by team)
  router.get('/:joinCode', async (req, res, next) => {
    try {
      const game = await store.getGameByJoinCode(req.params.joinCode.toUpperCase())
      if (!game) return res.status(404).json({ error: 'Game not found' })
      res.json(game)
    } catch (err) {
      next(err)
    }
  })

  // POST /:joinCode/players — join an existing game
  router.post('/:joinCode/players', async (req, res, next) => {
    try {
      const { name, team } = req.body
      if (!isValidName(name)) {
        return res.status(400).json({ error: 'Name must be between 1 and 50 characters' })
      }
      if (!isValidTeam(team)) {
        return res.status(400).json({ error: 'Team must be 1 or 2' })
      }
      const joinCode = req.params.joinCode.toUpperCase()
      const player = await store.joinGame(joinCode, name.trim(), team)
      res.status(201).json({ player })
    } catch (err: unknown) {
      if (err instanceof AppError && err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: 'Game not found' })
      }
      next(err)
    }
  })

  return router
}
```

#### 2. Route tests

**File**: `server/src/routes/games.test.ts`

Update `mockStore` and add new describe blocks (existing tests remain):

```typescript
import { AppError } from '../errors.js'

const mockStore = (overrides?: Partial<GameStore>): GameStore => ({
  createGame: async () => ({ id: 'test-id', joinCode: 'ABC123', status: 'lobby', players: [] } as Game),
  createGameWithHost: async () => ({
    game: { id: 'test-id', joinCode: 'ABC123', status: 'lobby', players: [] } as Game,
    player: { id: 'p1', name: 'Test', team: 1 as const },
  }),
  getGameByJoinCode: async () => null,
  joinGame: async () => ({ id: 'p1', name: 'Test', team: 1 as const }),
  ...overrides,
})

describe('POST /api/games — with host body', () => {
  it('returns 201 with joinCode and player when name+team provided', async () => {
    const res = await request(buildApp(mockStore()))
      .post('/')
      .send({ name: 'Alice', team: 1 })
    expect(res.status).toBe(201)
    expect(res.body).toHaveProperty('joinCode')
    expect(res.body.player).toMatchObject({ name: 'Test', team: 1 })
  })

  it('returns 400 when name is empty in host body', async () => {
    const res = await request(buildApp(mockStore())).post('/').send({ name: '', team: 1 })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/games/:joinCode', () => {
  it('returns 200 with game data when game exists', async () => {
    const game = { id: 'g1', joinCode: 'ABC123', status: 'lobby' as const, players: [] }
    const store = mockStore({ getGameByJoinCode: async () => game })
    const res = await request(buildApp(store)).get('/ABC123')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ joinCode: 'ABC123', players: [] })
  })

  it('returns 404 when game is not found', async () => {
    const store = mockStore({ getGameByJoinCode: async () => null })
    const res = await request(buildApp(store)).get('/XXXXXX')
    expect(res.status).toBe(404)
  })

  it('normalises lowercase join code to uppercase', async () => {
    const game = { id: 'g1', joinCode: 'ABC123', status: 'lobby' as const, players: [] }
    const store = mockStore({ getGameByJoinCode: async () => game })
    const res = await request(buildApp(store)).get('/abc123')
    expect(res.status).toBe(200)
  })
})

describe('POST /api/games/:joinCode/players', () => {
  it('returns 201 with the new player', async () => {
    const player = { id: 'p1', name: 'Alice', team: 1 as const }
    const store = mockStore({ joinGame: async () => player })
    const res = await request(buildApp(store))
      .post('/ABC123/players')
      .send({ name: 'Alice', team: 1 })
    expect(res.status).toBe(201)
    expect(res.body.player).toMatchObject({ name: 'Alice', team: 1 })
  })

  it('trims whitespace from name before storing', async () => {
    let receivedName = ''
    const store = mockStore({
      joinGame: async (_code, name) => { receivedName = name; return { id: 'p1', name, team: 1 as const } },
    })
    await request(buildApp(store)).post('/ABC123/players').send({ name: '  Alice  ', team: 1 })
    expect(receivedName).toBe('Alice')
  })

  it('returns 400 when name is empty', async () => {
    const res = await request(buildApp(mockStore())).post('/ABC123/players').send({ name: '', team: 1 })
    expect(res.status).toBe(400)
  })

  it('accepts a name exactly 50 characters long', async () => {
    const res = await request(buildApp(mockStore()))
      .post('/ABC123/players')
      .send({ name: 'A'.repeat(50), team: 1 })
    expect(res.status).toBe(201)
  })

  it('returns 400 when name exceeds 50 characters', async () => {
    const res = await request(buildApp(mockStore()))
      .post('/ABC123/players')
      .send({ name: 'A'.repeat(51), team: 1 })
    expect(res.status).toBe(400)
  })

  it('returns 400 when team is invalid', async () => {
    const res = await request(buildApp(mockStore())).post('/ABC123/players').send({ name: 'Bob', team: 3 })
    expect(res.status).toBe(400)
  })

  it('normalises lowercase join code to uppercase', async () => {
    const res = await request(buildApp(mockStore()))
      .post('/abc123/players')
      .send({ name: 'Bob', team: 1 })
    expect(res.status).toBe(201)
  })

  it('returns 404 when join code is unknown', async () => {
    const store = mockStore({ joinGame: async () => { throw new AppError('NOT_FOUND', 'Game not found') } })
    const res = await request(buildApp(store)).post('/XXXXXX/players').send({ name: 'Bob', team: 1 })
    expect(res.status).toBe(404)
  })
})
```

### Success Criteria

#### Automated Verification
- [x] `pnpm test` — all route tests pass (2 existing + 14 new)

---

## Phase 3: Create Game Form

### Overview

New `CreateGamePage` at `/create` where the host enters their name and team.
On submit it calls `POST /api/games` with `{ name, team }` in the body — a
single atomic request that creates the game and registers the host — then
stores the session in `localStorage` and navigates to the lobby.

The `TeamSelector` component is extracted here and reused in Phase 4.

### Changes Required

#### 1. Session utility

**File**: `client/src/session.ts`

```typescript
const SESSION_KEY = 'wordfetti_session'

export type Session = {
  playerId: string
  joinCode: string
}

export function saveSession(session: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as Session) : null
  } catch {
    return null
  }
}
```

#### 2. TeamSelector component

**File**: `client/src/components/TeamSelector.tsx`

Uses `role="radiogroup"` + `role="radio"` + `aria-checked` so screen readers
correctly announce the mutual-exclusion relationship:

```tsx
import type { Team } from '@wordfetti/shared'

type Props = {
  id: string          // used as the labelledby target from the parent <label>
  value: Team | null
  onChange: (team: Team) => void
}

export function TeamSelector({ id, value, onChange }: Props) {
  return (
    <div role="radiogroup" aria-labelledby={id} className="flex gap-3">
      <button
        type="button"
        role="radio"
        aria-checked={value === 1}
        onClick={() => onChange(1)}
        className={`flex-1 rounded-xl py-3 text-sm font-semibold transition-colors ${
          value === 1
            ? 'bg-brand-coral text-white'
            : 'bg-brand-muted text-gray-600 hover:bg-red-100'
        }`}
      >
        Team 1
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={value === 2}
        onClick={() => onChange(2)}
        className={`flex-1 rounded-xl py-3 text-sm font-semibold transition-colors ${
          value === 2
            ? 'bg-brand-teal text-white'
            : 'bg-brand-muted text-gray-600 hover:bg-teal-100'
        }`}
      >
        Team 2
      </button>
    </div>
  )
}
```

#### 3. CreateGamePage

**File**: `client/src/pages/CreateGamePage.tsx`

Matches `create-game-screen.png`. Calls `POST /api/games` with `{ name, team }`
in the body — a single atomic request. Validation order matches visual field
order (name before team). `TeamSelector` receives an `id` for its group label.

```tsx
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Team } from '@wordfetti/shared'
import { Logo } from '../components/Logo'
import { TeamSelector } from '../components/TeamSelector'
import { saveSession } from '../session'

export function CreateGamePage() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [team, setTeam] = useState<Team | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) return setError('Please enter your name.')
    if (!team) return setError('Please pick a team.')

    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, team }),
      })
      if (!res.ok) throw new Error(`Unexpected response: ${res.status}`)
      const { joinCode, player } = await res.json()
      saveSession({ playerId: player.id, joinCode })
      navigate(`/game/${joinCode}`)
    } catch (err) {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-brand-cream px-4">
      <Logo />

      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold text-gray-900">Create a Game</h1>
          <p className="mt-1 text-sm text-gray-500">You'll be the host</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="create-name" className="text-sm font-medium text-gray-700">
              Your Name
            </label>
            <input
              id="create-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter your name"
              maxLength={50}
              className="rounded-lg border border-gray-200 px-4 py-3 text-sm outline-none focus:border-brand-coral focus:ring-1 focus:ring-brand-coral"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span id="create-team-label" className="text-sm font-medium text-gray-700">
              Pick Your Team
            </span>
            <TeamSelector id="create-team-label" value={team} onChange={setTeam} />
          </div>

          {error && (
            <p role="alert" className="text-center text-sm text-red-600">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            aria-busy={loading}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-coral px-6 py-3.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {loading ? 'Creating...' : 'Create Game →'}
          </button>
        </form>
      </div>

      <Link to="/" className="text-sm text-gray-500 hover:text-gray-700">
        Go Back
      </Link>

      <p className="text-sm text-gray-400">Play the classic Hat Game digitally</p>
    </div>
  )
}
```

#### 4. Update HomePage

**File**: `client/src/pages/HomePage.tsx`

Change the "Create Game" button: remove the `handleCreateGame` API call and
replace with `navigate('/create')`. The "Join Game" button navigates to `/join`.

```tsx
// Remove: loading state, error state, handleCreateGame, fetch call
// Change: onClick={() => navigate('/create')} on Create Game button
// Change: onClick={() => navigate('/join')} on Join Game button, remove disabled
```

#### 5. Wire new routes in main.tsx

**File**: `client/src/main.tsx`

```tsx
import { CreateGamePage } from './pages/CreateGamePage'
import { JoinPage } from './pages/JoinPage'
// add:
<Route path="/create" element={<CreateGamePage />} />
<Route path="/join" element={<JoinPage />} />
```

### Success Criteria

#### Automated Verification
- [x] `pnpm --filter client build` completes without TypeScript errors

#### Manual Verification
- [ ] Home page → "Create Game" navigates to `/create` (no longer calls API directly)
- [ ] Fill in name + team → submit → redirected to `/game/:joinCode`
- [ ] Omitting name shows inline error; not picking a team shows inline error
- [ ] `localStorage` contains `wordfetti_session` with `playerId` and `joinCode` after submit

---

## Phase 4: Join Game Form

### Overview

New `JoinPage` at `/join` matching `join-screen.png`. Enables the "Join Game"
button on the home page.

### Changes Required

#### 1. JoinPage

**File**: `client/src/pages/JoinPage.tsx`

```tsx
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Team } from '@wordfetti/shared'
import { Logo } from '../components/Logo'
import { TeamSelector } from '../components/TeamSelector'
import { saveSession } from '../session'

export function JoinPage() {
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [team, setTeam] = useState<Team | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const joinCode = code.trim().toUpperCase()
    const trimmedName = name.trim()

    if (!joinCode) return setError('Please enter the game code.')
    if (!trimmedName) return setError('Please enter your name.')
    if (!team) return setError('Please pick a team.')

    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/games/${joinCode}/players`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, team }),
      })
      if (res.status === 404) {
        setError('Game not found. Check the code and try again.')
        return
      }
      if (!res.ok) throw new Error(`Unexpected response: ${res.status}`)
      const { player } = await res.json()
      saveSession({ playerId: player.id, joinCode })
      navigate(`/game/${joinCode}`)
    } catch (err) {
      console.error('Failed to join game:', err)
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-brand-cream px-4">
      <Logo />

      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold text-gray-900">Join a Game</h1>
          <p className="mt-1 text-sm text-gray-500">Enter the code from your host</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="code" className="text-sm font-medium text-gray-700">
              Game Code
            </label>
            <input
              id="code"
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="XXXXXX"
              maxLength={6}
              className="rounded-lg border border-gray-200 px-4 py-3 text-center font-mono text-lg uppercase tracking-widest outline-none focus:border-brand-coral focus:ring-1 focus:ring-brand-coral"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="name" className="text-sm font-medium text-gray-700">
              Your Name
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter your name"
              maxLength={50}
              className="rounded-lg border border-gray-200 px-4 py-3 text-sm outline-none focus:border-brand-coral focus:ring-1 focus:ring-brand-coral"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span id="join-team-label" className="text-sm font-medium text-gray-700">Pick Your Team</span>
            <TeamSelector id="join-team-label" value={team} onChange={setTeam} />
          </div>

          {error && (
            <p role="alert" className="text-sm text-center text-red-600">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            aria-busy={loading}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-coral px-6 py-3.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {loading ? 'Joining...' : 'Join Game →'}
          </button>
        </form>
      </div>

      <Link to="/" className="text-sm text-gray-500 hover:text-gray-700">
        Go Back
      </Link>

      <p className="text-sm text-gray-400">Play the classic Hat Game digitally</p>
    </div>
  )
}
```

### Success Criteria

#### Automated Verification
- [x] `pnpm --filter client build` completes without TypeScript errors

#### Manual Verification
- [ ] Home page → "Join Game" navigates to `/join`
- [ ] Submit with a valid code + name + team → redirected to `/game/:joinCode`
- [ ] Submit with invalid/unknown code → shows "Game not found" error (not a generic error)
- [ ] Omitting any field shows the relevant inline error

---

## Phase 5: Lobby Page

### Overview

Extend `GameCodePage` (renamed to `LobbyPage`) at `/game/:joinCode`. It fetches
game state from `GET /api/games/:joinCode` on mount and renders the two-column
team layout matching `game-lobby-screen.png`.

### Changes Required

#### 1. Rename and rewrite GameCodePage → LobbyPage

**File**: `client/src/pages/LobbyPage.tsx` (replaces `GameCodePage.tsx`)

```tsx
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { Game, Player } from '@wordfetti/shared'
import { Logo } from '../components/Logo'
import { loadSession } from '../session'

export function LobbyPage() {
  const { joinCode } = useParams<{ joinCode: string }>()
  const [game, setGame] = useState<Game | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // useState initialiser avoids calling loadSession on every render
  const [session] = useState(() => loadSession())
  const currentPlayerId =
    session?.joinCode === joinCode?.toUpperCase() ? session.playerId : null

  useEffect(() => {
    if (!joinCode) return
    const controller = new AbortController()
    fetch(`/api/games/${joinCode}`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`)
        return res.json() as Promise<Game>
      })
      .then(setGame)
      .catch((err) => {
        if (err.name === 'AbortError') return
        setError('Could not load the game. Check the code and try again.')
      })
    return () => controller.abort()
  }, [joinCode])

  function copyCode() {
    if (!joinCode) return
    navigator.clipboard.writeText(joinCode).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-cream">
        <p role="alert" className="text-gray-600">{error}</p>
      </div>
    )
  }

  if (!game) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-cream">
        <p role="status" className="text-gray-400">Loading...</p>
      </div>
    )
  }

  const team1 = game.players.filter((p) => p.team === 1)
  const team2 = game.players.filter((p) => p.team === 2)
  const needsMorePlayers = team1.length < 2 || team2.length < 2

  return (
    <div className="flex min-h-screen flex-col items-center bg-brand-cream px-4 py-8">
      <div className="w-full max-w-lg">
        <Logo />

        <h1 className="mt-6 text-center text-xl font-bold text-gray-900">Game Lobby</h1>

        {/* Join code badge with clipboard feedback */}
        <div className="mt-2 flex justify-center">
          <button
            onClick={copyCode}
            aria-label="Copy join code"
            className="flex items-center gap-2 rounded-full border border-gray-200 bg-white px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
          >
            <span>
              Code: <span className="font-mono font-semibold tracking-wider">{joinCode}</span>
            </span>
            <CopyIcon />
          </button>
        </div>
        {/* aria-live region for clipboard feedback */}
        <p aria-live="polite" className="mt-1 text-center text-xs text-gray-400">
          {copied ? 'Copied!' : '\u00A0'}
        </p>

        {/* Prompt for visitors without a session */}
        {!currentPlayerId && (
          <p className="mt-2 text-center text-sm text-gray-500">
            Want to play?{' '}
            <a href={`/join?code=${joinCode}`} className="font-medium text-brand-coral hover:underline">
              Join this game
            </a>
          </p>
        )}

        {/* Team columns */}
        <div className="mt-6 grid grid-cols-2 gap-4">
          <TeamColumn
            label="Team 1"
            players={team1}
            currentPlayerId={currentPlayerId}
            colorScheme="coral"
          />
          <TeamColumn
            label="Team 2"
            players={team2}
            currentPlayerId={currentPlayerId}
            colorScheme="teal"
          />
        </div>

        {/* Context-aware footer */}
        {needsMorePlayers && (
          <p className="mt-6 text-center text-sm text-gray-400">
            Waiting for more players...
          </p>
        )}
      </div>
    </div>
  )
}

const SCHEME = {
  coral: { bg: 'bg-red-50', labelColor: 'text-brand-coral', badgeBg: 'bg-brand-coral', needColor: 'text-red-400' },
  teal:  { bg: 'bg-teal-50', labelColor: 'text-brand-teal', badgeBg: 'bg-brand-teal', needColor: 'text-teal-400' },
} as const

type TeamColumnProps = {
  label: string
  players: Player[]
  currentPlayerId: string | null
  colorScheme: keyof typeof SCHEME
}

function TeamColumn({ label, players, currentPlayerId, colorScheme }: TeamColumnProps) {
  const { bg, labelColor, badgeBg, needColor } = SCHEME[colorScheme]
  const needMore = Math.max(0, 2 - players.length)
  const headingId = `team-heading-${colorScheme}`

  return (
    <section aria-labelledby={headingId} className={`rounded-2xl ${bg} p-4`}>
      <div className="mb-3 flex items-center justify-between">
        <h2 id={headingId} className={`text-sm font-semibold ${labelColor}`}>{label}</h2>
        <span className={`rounded-full ${badgeBg} px-2 py-0.5 text-xs font-bold text-white`}>
          {players.length}
        </span>
      </div>

      {players.length === 0 ? (
        <p className="text-center text-xs text-gray-400">No players yet</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {players.map((player) => (
            <PlayerRow
              key={player.id}
              player={player}
              isCurrentPlayer={player.id === currentPlayerId}
            />
          ))}
        </ul>
      )}

      {needMore > 0 && (
        <p className={`mt-2 text-center text-xs ${needColor}`}>
          Need {needMore} more player{needMore > 1 ? 's' : ''}
        </p>
      )}
    </section>
  )
}

type PlayerRowProps = {
  player: Player
  isCurrentPlayer: boolean
}

function PlayerRow({ player, isCurrentPlayer }: PlayerRowProps) {
  return (
    <li className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm">
      <span aria-hidden="true">⭐</span>
      <span className="flex-1 font-medium text-gray-800">
        {player.name}
        {isCurrentPlayer && (
          <span className="ml-1 text-xs text-gray-400">(you)</span>
        )}
      </span>
    </li>
  )
}

function CopyIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}
```

#### 2. Update main.tsx

**File**: `client/src/main.tsx`

Replace `GameCodePage` import/usage with `LobbyPage`:

```tsx
import { LobbyPage } from './pages/LobbyPage'
// route stays the same:
<Route path="/game/:joinCode" element={<LobbyPage />} />
```

Delete `client/src/pages/GameCodePage.tsx`.

### Success Criteria

#### Automated Verification
- [x] `pnpm --filter client build` completes without TypeScript errors

#### Manual Verification
- [ ] Host flow: Create → form → submit → lobby shows host under correct team with "(you)"
- [ ] Join flow: Join → form → valid code → lobby shows self under correct team with "(you)"
- [ ] Join flow: invalid code → "Game not found" error shown (does not navigate)
- [ ] Two devices in the same game: each sees "(you)" next to their own name only
- [ ] Empty team shows "No players yet"
- [ ] Team with 1 player shows "Need 1 more player"
- [ ] Team with ≥ 2 players shows no "Need more" hint
- [ ] Clicking the code badge copies it to clipboard

---

## Testing Strategy

### Unit Tests
- `InMemoryGameStore.joinGame` — happy path, NOT_FOUND error (Phase 1)
- `GET /api/games/:joinCode` route — 200 with game, 404 for unknown (Phase 2)
- `POST /api/games/:joinCode/players` route — 201, 400 (invalid name), 400 (invalid team), 404 (unknown code) (Phase 2)

### Client-Side Tests

There are no automated client tests in this ticket — the client components
are thin wrappers around fetch calls and navigation. Manual verification
covers the observable behaviour. Future tickets may introduce component tests
(e.g. React Testing Library) once patterns are established.

### Manual Testing Steps
1. Full create-game flow: home → `/create` → submit → lobby shows host
2. Full join flow (second device/tab): home → `/join` → code → submit → lobby shows both players
3. Invalid join code: enter unknown code → "Game not found" error, stays on join page
4. Refresh lobby page: still shows correct player list and "(you)" is correct
5. `localStorage` in DevTools contains `wordfetti_session` after both flows

## References

- Ticket: `meta/tickets/ENG-002-join-a-game.md`
- ENG-001 plan: `meta/plans/2026-03-21-ENG-001-create-a-game.md`
- Epic plan: `meta/plans/2026-03-21-hat-game-epics.md`
- Design screens: `screens/join-screen.png`, `screens/create-game-screen.png`, `screens/game-lobby-screen.png`
