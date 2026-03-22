# ENG-010: Game State Model for Round 1 & Game Page Routing — Implementation Plan

## Overview

Starting the game initialises the Round 1 hat and turn state; all players
automatically navigate from the lobby to a role-aware game page. This ticket
covers the shared type extension, the server-side hat initialisation, a route
restructure (lobby moves to `/lobby/:joinCode`, freeing `/game/:joinCode` for
the new `GamePage`), and the `GamePage` itself with role-based placeholder
views.

---

## Current State Analysis

- `shared/src/types.ts:17-23` — `Game` has `id`, `joinCode`, `status`,
  `players`, `hostId?`. No hat, team, or turn state.
- `InMemoryGameStore.startGame` (`server/src/store/InMemoryGameStore.ts:60-67`)
  only sets `status = 'in_progress'` and broadcasts. Words live in
  `this.words` (private `Map` keyed `"${joinCode}:${playerId}"`) and are
  accessible within the same class.
- `client/src/main.tsx:18` maps `/game/:joinCode` → `LobbyPage`. There is no
  `GamePage`. The lobby must move to `/lobby/:joinCode` to free the semantic
  `/game/:joinCode` URL for the new page.
- `CreateGamePage.tsx:32`, `JoinPage.tsx:45` both `navigate('/game/${joinCode}')` after joining — need updating.
- `WordEntryPage.tsx` has three references to `/game/${joinCode}`: the
  session-guard redirect (line 13), the header back button (line 86), and the
  footer back button (line 173). All need updating.
- `LobbyPage.tsx:158` navigates to `/game/${joinCode}/words` for the Add Words
  button — needs updating.

---

## Desired End State

- `Game` type carries optional `hat`, `activeTeam`, `currentClueGiverId`,
  `turnPhase`, and `scores` fields (optional so lobby-phase objects stay valid).
- Starting a game shuffles all submitted words into `hat`, picks a random
  `activeTeam`, sets `currentClueGiverId` to the first player on that team
  (join order), `turnPhase: 'ready'`, `scores: { team1: 0, team2: 0 }`.
- All devices SSE-receive the updated state and automatically leave
  `/lobby/:joinCode` for `/game/:joinCode`.
- `/game/:joinCode` shows a role-aware view:
  - **Clue giver**: "You are describing!" + disabled "Start Turn" button
  - **Guesser**: "Get ready to guess — [name] is about to describe!"
  - **Spectator**: "Watch closely — [name] is describing for Team N!"
  - **No session / not in game**: redirected to `/join?code=<joinCode>`
  - **Game still in lobby** (e.g. direct URL hit before start): redirected to `/lobby/:joinCode`

---

## What We're NOT Doing

- No `POST /ready`, `POST /guess`, `POST /skip` — those are ENG-011.
- No `turnStartedAt`, timer, or `POST /end-turn` — those are ENG-012.
- No `skippedThisTurn` field — ENG-011.
- No `status: 'round_over'` — ENG-011.
- No server-side shuffle test for distribution uniformity — overkill.
- The "Start Turn" button on `GamePage` is a **disabled placeholder** only; it
  becomes functional in ENG-011.
- `hat` is **never sent to clients** — it is server-internal state only. The
  SSE broadcast and GET response both strip it before delivery. Clients only
  need `hatSize` when that becomes relevant (ENG-011+); for now the field is
  absent from all client-visible payloads.

---

## Phase 1: Extend Shared `Game` Type

### Changes Required

**File**: `shared/src/types.ts`

Add optional fields to `Game`:

```ts
export type Game = {
  id: string
  joinCode: string
  status: 'lobby' | 'in_progress' | 'finished'
  players: Player[]
  hostId?: string
  hat?: string[]
  activeTeam?: 1 | 2
  currentClueGiverId?: string
  turnPhase?: 'ready' | 'active'
  scores?: { team1: number; team2: number }
}
```

All new fields are optional so that existing tests that construct bare `Game`
objects (lobby phase) compile without changes.

### Success Criteria

#### Automated Verification

- [ ] TypeScript compiles: `cd shared && pnpm tsc --noEmit`

---

## Phase 2: Server — `startGame` Implementation and Tests

### Overview

Update `InMemoryGameStore.startGame` to collect every player's submitted words
from `this.words`, shuffle them into `hat`, pick a random `activeTeam`, find
the first player on that team by join order, and initialise turn state.

Add a new test file that exercises this logic directly against a real store
instance (no mocks) to catch regressions in the business logic.

### Changes Required

#### 1. `InMemoryGameStore.startGame`

**File**: `server/src/store/InMemoryGameStore.ts`

Replace the current `startGame` body (lines 61-67) with:

```ts
async startGame(joinCode: string): Promise<Game> {
  const game = this.games.get(joinCode)
  if (!game) throw new AppError('NOT_FOUND', 'Game not found')

  const allWords = game.players.flatMap((p) =>
    (this.words.get(`${joinCode}:${p.id}`) ?? []).map((w) => w.text),
  )

  for (let i = allWords.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[allWords[i], allWords[j]] = [allWords[j], allWords[i]]
  }

  const activeTeam: 1 | 2 = Math.random() < 0.5 ? 1 : 2
  const firstClueGiver = game.players.find((p) => p.team === activeTeam)
  if (!firstClueGiver) throw new AppError('INVALID_STATE', 'No players on the active team')

  // Commit all mutations in a single step to avoid partial state on future errors
  Object.assign(game, {
    status: 'in_progress',
    hat: allWords,
    activeTeam,
    currentClueGiverId: firstClueGiver.id,
    turnPhase: 'ready',
    scores: { team1: 0, team2: 0 },
  })

  const snapshot = { ...game, players: [...game.players] }
  this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))
  return snapshot
}
```

#### 2. Strip `hat` from public endpoints

**File**: `server/src/routes/games.ts`

`hat` is internal server state. Destructure it out before any response that
reaches the client: the SSE callback, the SSE initial snapshot, and the GET
single-game response. The underscore prefix signals the variable is
intentionally unused.

**GET `/:joinCode`** (replace `res.json(game)` with):
```ts
const { hat: _hat, ...publicGame } = game
res.json(publicGame)
```

**GET `/:joinCode/events` — SSE subscribe callback** (replace the subscribe call):
```ts
const unsubscribe = store.subscribe(joinCode, (updatedGame) => {
  const { hat: _hat, ...publicGame } = updatedGame
  res.write(`data: ${JSON.stringify(publicGame)}\n\n`)
})
```

**GET `/:joinCode/events` — initial snapshot write** (replace the snapshot write):
```ts
const snapshot = (await store.getGameByJoinCode(joinCode))!
const { hat: _hat, ...publicSnapshot } = snapshot
res.write(`data: ${JSON.stringify(publicSnapshot)}\n\n`)
```

#### 3. New store unit test file

**File**: `server/src/store/InMemoryGameStore.test.ts` *(new)*

```ts
import { describe, it, expect } from 'vitest'
import { InMemoryGameStore } from './InMemoryGameStore.js'

describe('InMemoryGameStore.startGame', () => {
  async function setupReadyGame() {
    const store = new InMemoryGameStore()
    const { game, player: host } = await store.createGameWithHost('Alice', 1)
    const p2 = await store.joinGame(game.joinCode, 'Bob', 1)
    const p3 = await store.joinGame(game.joinCode, 'Carol', 2)
    const p4 = await store.joinGame(game.joinCode, 'Dave', 2)

    const wordSets: [string, string[]][] = [
      [host.id, ['cat', 'dog', 'fish', 'bird', 'ant']],
      [p2.id,   ['sun', 'moon', 'star', 'sky', 'rain']],
      [p3.id,   ['red', 'blue', 'green', 'yellow', 'pink']],
      [p4.id,   ['one', 'two', 'three', 'four', 'five']],
    ]
    for (const [playerId, words] of wordSets) {
      for (const text of words) {
        await store.addWord(game.joinCode, playerId, text)
      }
    }
    return { store, joinCode: game.joinCode }
  }

  it('hat contains exactly all submitted words', async () => {
    const { store, joinCode } = await setupReadyGame()
    const game = await store.startGame(joinCode)
    expect(game.hat).toHaveLength(20)
    expect([...game.hat!].sort()).toEqual([
      'ant', 'bird', 'blue', 'cat', 'dog', 'fish', 'five', 'four', 'green',
      'moon', 'one', 'pink', 'rain', 'red', 'sky', 'star', 'sun', 'three', 'two', 'yellow',
    ])
  })

  it('sets activeTeam to 1 or 2, and both values are reachable', async () => {
    // Run enough iterations to confirm both teams can be chosen — the
    // probability of the same team appearing 20 times in a row is < 1 in 10^6.
    const seen = new Set<number>()
    for (let i = 0; i < 20 && seen.size < 2; i++) {
      const { store, joinCode } = await setupReadyGame()
      const game = await store.startGame(joinCode)
      seen.add(game.activeTeam!)
    }
    expect(seen).toContain(1)
    expect(seen).toContain(2)
  })

  it('sets currentClueGiverId to the first player on activeTeam by join order', async () => {
    const { store, joinCode } = await setupReadyGame()
    const game = await store.startGame(joinCode)
    const firstOnTeam = game.players.find((p) => p.team === game.activeTeam)!
    expect(game.currentClueGiverId).toBe(firstOnTeam.id)
  })

  it('sets turnPhase to ready', async () => {
    const { store, joinCode } = await setupReadyGame()
    const game = await store.startGame(joinCode)
    expect(game.turnPhase).toBe('ready')
  })

  it('initialises scores to zero', async () => {
    const { store, joinCode } = await setupReadyGame()
    const game = await store.startGame(joinCode)
    expect(game.scores).toEqual({ team1: 0, team2: 0 })
  })

  it('broadcasts the updated game to subscribers', async () => {
    const { store, joinCode } = await setupReadyGame()
    const received: unknown[] = []
    store.subscribe(joinCode, (g) => received.push(g))
    await store.startGame(joinCode)
    expect(received).toHaveLength(1)
    expect((received[0] as { status: string }).status).toBe('in_progress')
  })

  it('throws INVALID_STATE when no players exist on the selected team', async () => {
    // All players on team 1 — if Math.random picks team 2 the guard must fire.
    // We force the scenario by putting everyone on team 1 and checking that
    // startGame either succeeds (team 1 chosen) or throws INVALID_STATE (team 2).
    // To make the test deterministic we create a game with only team-1 players
    // and call startGame repeatedly until it throws, or accept a team-1 success.
    const store = new InMemoryGameStore()
    const { game, player: host } = await store.createGameWithHost('Alice', 1)
    const p2 = await store.joinGame(game.joinCode, 'Bob', 1)
    for (const [pid, words] of [[host.id, ['a','b','c','d','e']], [p2.id, ['f','g','h','i','j']]] as [string,string[]][]) {
      for (const text of words) await store.addWord(game.joinCode, pid, text)
    }
    // Run enough times to hit team 2 selection with high confidence
    let threwInvalidState = false
    for (let i = 0; i < 20; i++) {
      const freshStore = new InMemoryGameStore()
      const { game: g, player: h } = await freshStore.createGameWithHost('Alice', 1)
      const q2 = await freshStore.joinGame(g.joinCode, 'Bob', 1)
      for (const [pid, words] of [[h.id, ['a','b','c','d','e']], [q2.id, ['f','g','h','i','j']]] as [string,string[]][]) {
        for (const text of words) await freshStore.addWord(g.joinCode, pid, text)
      }
      try {
        await freshStore.startGame(g.joinCode)
      } catch (err: unknown) {
        expect((err as { code: string }).code).toBe('INVALID_STATE')
        threwInvalidState = true
        break
      }
    }
    expect(threwInvalidState).toBe(true)
  })

  it('throws NOT_FOUND for an unknown join code', async () => {
    const store = new InMemoryGameStore()
    await expect(store.startGame('XXXXXX')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
```

### Success Criteria

#### Automated Verification

- [ ] New store tests pass: `cd server && pnpm test`
- [ ] TypeScript compiles: `cd server && pnpm tsc --noEmit`

---

## Phase 3: Client — Route Restructuring

### Overview

Move the lobby to `/lobby/:joinCode` (and its word-entry child to
`/lobby/:joinCode/words`) to free `/game/:joinCode` for the new `GamePage`.
Update every existing `navigate` and redirect that pointed at the old
`/game/...` paths.

### Changes Required

#### 1. Route definitions

**File**: `client/src/main.tsx`

- Add `import { GamePage } from './pages/GamePage'` to the **existing import
  block at the top of the file** (lines 4–8), alongside the other page imports.
  Do not place it adjacent to the `<Routes>` JSX.
- Change `/game/:joinCode` → `/lobby/:joinCode` for `LobbyPage`.
- Change `/game/:joinCode/words` → `/lobby/:joinCode/words` for `WordEntryPage`.
- Add `/game/:joinCode` → `GamePage`.

```tsx
// top-level import block (add alongside existing page imports):
import { GamePage } from './pages/GamePage'

// inside <Routes>:
<Route path="/" element={<HomePage />} />
<Route path="/create" element={<CreateGamePage />} />
<Route path="/join" element={<JoinPage />} />
<Route path="/lobby/:joinCode" element={<LobbyPage />} />
<Route path="/lobby/:joinCode/words" element={<WordEntryPage />} />
<Route path="/game/:joinCode" element={<GamePage />} />
```

#### 2. `CreateGamePage` — navigate after create

**File**: `client/src/pages/CreateGamePage.tsx:32`

```ts
// before
navigate(`/game/${joinCode}`)
// after
navigate(`/lobby/${joinCode}`)
```

#### 3. `JoinPage` — navigate after join

**File**: `client/src/pages/JoinPage.tsx:45`

```ts
// before
navigate(`/game/${joinCode}`)
// after
navigate(`/lobby/${joinCode}`)
```

#### 4. `WordEntryPage` — three navigate references

**File**: `client/src/pages/WordEntryPage.tsx`

| Line | Before | After |
|------|--------|-------|
| 13 | `navigate(\`/game/${joinCode}\`, { replace: true })` | `navigate(\`/lobby/${joinCode}\`, { replace: true })` |
| 86 | `navigate(\`/game/${joinCode}\`)` | `navigate(\`/lobby/${joinCode}\`)` |
| 173 | `navigate(\`/game/${joinCode}\`)` | `navigate(\`/lobby/${joinCode}\`)` |

#### 5. `LobbyPage` — Add Words button

**File**: `client/src/pages/LobbyPage.tsx:158`

```ts
// before
onClick={() => navigate(`/game/${joinCode}/words`)
// after
onClick={() => navigate(`/lobby/${joinCode}/words`)
```

### Success Criteria

#### Automated Verification

- [ ] TypeScript compiles: `cd client && pnpm tsc --noEmit`

#### Manual Verification

- [ ] Creating a game navigates to `/lobby/<code>` (not `/game/<code>`)
- [ ] Joining a game navigates to `/lobby/<code>`
- [ ] "Add Words" button in lobby navigates to `/lobby/<code>/words`
- [ ] Both back buttons in `WordEntryPage` return to `/lobby/<code>`

---

## Phase 4: Client — LobbyPage Auto-Navigation + New GamePage

### Overview

`LobbyPage` gains a status-watching effect that navigates to `/game/:joinCode`
the moment SSE delivers `status === 'in_progress'`. The new `GamePage` connects
to the same SSE stream, determines the current player's role, and renders a
role-appropriate placeholder view.

### Changes Required

#### 1. New `useGameState` hook

**File**: `client/src/hooks/useGameState.ts` *(new)*

Both `LobbyPage` and `GamePage` need the identical initial-fetch + SSE pattern.
Extract it into a shared hook so any future game-phase page gets it for free and
error-handling changes propagate everywhere at once.

```ts
import { useEffect, useState } from 'react'
import type { Game } from '@wordfetti/shared'

export function useGameState(joinCode: string | undefined) {
  const [game, setGame] = useState<Game | null>(null)
  const [error, setError] = useState<string | null>(null)

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
        setError('Could not load the game.')
      })
    return () => controller.abort()
  }, [joinCode])

  useEffect(() => {
    if (!joinCode) return
    const es = new EventSource(`/api/games/${joinCode}/events`)
    es.onmessage = (event) => {
      setGame(JSON.parse(event.data) as Game)
    }
    es.onerror = (event) => {
      console.warn(`[game] SSE connection error for game ${joinCode}`, event)
      es.close()
    }
    return () => es.close()
  }, [joinCode])

  return { game, error }
}
```

#### 2. `LobbyPage` — switch to hook + add status-watching effect

**File**: `client/src/pages/LobbyPage.tsx`

**Replace the existing fetch and SSE effects with the hook:**

Remove the `game` and `error` `useState` declarations and their two `useEffect`
blocks (initial fetch + SSE), and replace with:

```ts
import { useGameState } from '../hooks/useGameState'

// inside the component, after session setup:
const { game, error } = useGameState(joinCode)
```

**Then add the status-watching effect** directly after:

Add a `useEffect` directly after the SSE effect (after line 56):

```ts
useEffect(() => {
  if (game?.status === 'in_progress') {
    navigate(`/game/${joinCode}`)
  }
}, [game?.status, joinCode, navigate])
```

`navigate` is already imported from `react-router-dom`. This handles both the
real-time SSE push (when the host starts the game) and a page refresh where the
SSE connect immediately returns an `in_progress` snapshot.

#### 3. New `GamePage`

**File**: `client/src/pages/GamePage.tsx` *(new)*

Key fixes vs. the first draft:
- Uses `useGameState` hook — no inline fetch/SSE effects.
- SSE `onerror` with `console.warn` is inside the hook (consistent with LobbyPage).
- Lobby-redirect condition narrowed to `=== 'lobby'` so `'finished'` doesn't redirect.
- Lobby-redirect gated on `currentPlayerId` to avoid racing with the no-session redirect.
- No-session redirect uppercases `joinCode` before passing to query param.
- `clueGiver` guarded explicitly (no non-null assertion).
- `Start Turn` uses `aria-disabled` + `onClick` no-op to stay focusable.

```tsx
import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Logo } from '../components/Logo'
import { loadSession } from '../session'
import { useGameState } from '../hooks/useGameState'

export function GamePage() {
  const { joinCode } = useParams<{ joinCode: string }>()
  const navigate = useNavigate()
  const [session] = useState(() => loadSession())
  const { game, error } = useGameState(joinCode)

  const currentPlayerId =
    session !== null && session.joinCode === joinCode?.toUpperCase()
      ? session.playerId
      : null

  // Redirect if no session for this game
  useEffect(() => {
    if (!currentPlayerId) {
      navigate(`/join?code=${joinCode?.toUpperCase()}`, { replace: true })
    }
  }, [currentPlayerId, joinCode, navigate])

  // Redirect to lobby if game has not started yet (e.g. direct URL hit before start).
  // Condition is '=== lobby' (not '!== in_progress') so 'finished' does not redirect here.
  // Gated on currentPlayerId so it doesn't race with the no-session redirect above.
  useEffect(() => {
    if (game && game.status === 'lobby' && currentPlayerId) {
      navigate(`/lobby/${joinCode}`, { replace: true })
    }
  }, [game, joinCode, navigate, currentPlayerId])

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-cream">
        <p role="alert" className="text-gray-600">{error}</p>
      </div>
    )
  }

  if (!game || !game.currentClueGiverId) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-cream">
        <p role="status" className="text-gray-400">Loading...</p>
      </div>
    )
  }

  const clueGiver = game.players.find((p) => p.id === game.currentClueGiverId)
  if (!clueGiver) {
    // currentClueGiverId set but player not in list — transient state, show loading
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-cream">
        <p role="status" className="text-gray-400">Loading...</p>
      </div>
    )
  }

  const currentPlayer = game.players.find((p) => p.id === currentPlayerId)
  const isClueGiver = currentPlayerId === game.currentClueGiverId
  const isGuesser = !isClueGiver && currentPlayer?.team === clueGiver.team

  return (
    <div className="flex min-h-screen flex-col items-center bg-brand-cream px-4 py-8">
      <div className="w-full max-w-lg">
        <Logo />
        {isClueGiver && <ClueGiverView />}
        {isGuesser && <GuesserView clueGiverName={clueGiver.name} />}
        {!isClueGiver && !isGuesser && (
          <SpectatorView clueGiverName={clueGiver.name} team={clueGiver.team} />
        )}
      </div>
    </div>
  )
}

// -- private role views --

function ClueGiverView() {
  return (
    <div className="mt-8 flex flex-col items-center gap-6 text-center">
      <p className="text-xl font-semibold text-gray-900">You are describing!</p>
      <button
        aria-disabled="true"
        aria-label="Start Turn (not yet available)"
        onClick={(e) => e.preventDefault()}
        className="rounded-xl bg-brand-coral px-8 py-3 text-sm font-semibold text-white opacity-40 cursor-not-allowed"
      >
        Start Turn
      </button>
    </div>
  )
}

function GuesserView({ clueGiverName }: { clueGiverName: string }) {
  return (
    <div className="mt-8 text-center">
      <p className="text-xl font-semibold text-gray-900">
        Get ready to guess — <span className="text-brand-coral">{clueGiverName}</span> is about to describe!
      </p>
    </div>
  )
}

function SpectatorView({ clueGiverName, team }: { clueGiverName: string; team: 1 | 2 }) {
  return (
    <div className="mt-8 text-center">
      <p className="text-xl font-semibold text-gray-900">
        Watch closely — <span className="text-brand-teal">{clueGiverName}</span> is describing for Team {team}!
      </p>
    </div>
  )
}
```

### Success Criteria

#### Automated Verification

- [ ] TypeScript compiles: `cd client && pnpm tsc --noEmit`
- [ ] Lint passes: `cd client && pnpm lint`
- [ ] Component tests pass: `cd client && pnpm test`

#### Manual Verification

- [ ] Start a ready game → all devices automatically leave `/lobby/<code>` and arrive at `/game/<code>`
- [ ] The clue giver's device shows "You are describing!" with the Start Turn button visible but not activatable
- [ ] A teammate's device shows the guesser view with the clue giver's name
- [ ] The opposing team's device shows the spectator view with the correct team number
- [ ] Navigating directly to `/game/<code>` before the game starts redirects to `/lobby/<code>`
- [ ] Navigating to `/game/<code>` without a session redirects to `/join?code=<CODE>`

---

## Testing Strategy

### Unit Tests (`InMemoryGameStore.test.ts`)

Tests call the public store API directly (create → join × 3 → addWord × 20 →
startGame) to verify hat-building and turn-init logic without HTTP overhead.
Assertions: hat contents (sorted equality), both teams reachable over 20 runs,
clue giver identity, turnPhase, scores, broadcast, INVALID_STATE guard (all
players on one team), NOT_FOUND guard.

### Route Tests (`games.test.ts`)

No changes needed. The `startGame` mock at line 20 returns a minimal object
(`status: 'in_progress', players: []`); since the new fields are optional the
mock satisfies the updated `Game` type without modification.

### Component Tests (`GamePage.test.tsx`)

New test file using Vitest + React Testing Library with `MemoryRouter`.
Mock `loadSession` and `useGameState` (or provide a game state fixture via
`MemoryRouter` initial entries).

Scenarios to cover:

- **Clue giver view**: given `currentClueGiverId === currentPlayerId`, renders
  "You are describing!" and the Start Turn button with `aria-disabled="true"`.
- **Guesser view**: given `currentPlayerId` on the same team as the clue giver
  but not the clue giver, renders "Get ready to guess — [name]…".
- **Spectator view**: given `currentPlayerId` on the opposing team, renders
  "Watch closely — [name] is describing for Team N!".
- **No-session redirect**: given `loadSession()` returns `null`, asserts
  `navigate` is called with `/join?code=<CODE>` and `{ replace: true }`.
- **Pre-start redirect**: given `game.status === 'lobby'` and a valid
  `currentPlayerId`, asserts `navigate` is called with `/lobby/<code>` and
  `{ replace: true }`.

---

## References

- Ticket: `meta/tickets/ENG-010-round1-game-state-and-routing.md`
- Shared types: `shared/src/types.ts`
- Store implementation: `server/src/store/InMemoryGameStore.ts:60`
- Route handler (hat stripping): `server/src/routes/games.ts:48,75,82`
- Route tests: `server/src/routes/games.test.ts:249`
- Client router: `client/src/main.tsx:14`
- Shared game state hook: `client/src/hooks/useGameState.ts` *(new)*
- LobbyPage: `client/src/pages/LobbyPage.tsx`
- WordEntryPage: `client/src/pages/WordEntryPage.tsx`
