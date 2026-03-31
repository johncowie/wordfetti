---
date: "2026-03-31T00:00:00Z"
type: plan
skill: create-plan
ticket: "meta/tickets/ENG-016-random-and-editable-team-names.md"
status: implemented
---

# ENG-016: Random and Editable Team Names — Implementation Plan

## Overview

Replace the hardcoded "Team 1" / "Team 2" labels with names randomly picked from a static text file at game creation. The host can rename either team via an inline edit UI in the lobby; all clients receive the change instantly through the existing SSE subscriber system. Non-hosts see the name only as text.

## Current State Analysis

- `Game` type (`shared/src/types.ts:1-35`) has no team name concept; teams are the literal numbers `1` and `2`
- `LobbyPage.tsx:109-123` renders two `TeamColumn` components with hardcoded `label="Team 1"` / `label="Team 2"`
- `InMemoryGameStore` constructor (`server/src/store/InMemoryGameStore.ts:33`) accepts only `GameConfig`; instantiated once at startup in `server/src/index.ts:13`
- `GameStore` interface (`server/src/store/GameStore.ts`) has 14 methods; new `updateTeamName` must be added to keep the type system honest
- SSE broadcast pattern is established: every store mutation ends with `this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))`
- Route error mapping convention: `FORBIDDEN` → 403, `INVALID_STATE` → 409, `NOT_FOUND` → 404, validation inline → 400
- `PATCH /settings` (`games.ts:367-405`) is the exact template to follow for the new endpoint
- Route tests (`games.test.ts:13-37`) use a `mockStore()` helper; every `Game` literal uses `as Game` casts, so adding a required `teamNames` field requires updating all those literals
- Store tests (`InMemoryGameStore.test.ts`) instantiate via `new InMemoryGameStore(TEST_CONFIG)` — constructor signature change needs a compatible second parameter

## Desired End State

- New games show two random, distinct team names everywhere "Team 1" / "Team 2" previously appeared
- Host has an inline edit flow (pencil icon → text input) for each team name in the lobby
- Non-hosts see team names as plain text, updating live via SSE
- Players already on a team are unaffected by a rename; game state is unchanged
- API rejects renames from non-hosts (403), after game start (409), for same-as-other-team (409), or invalid lengths (400)

### Key Discoveries

- `server/src/index.ts:13` is the single wiring point for the store — team names pool is loaded here and passed in
- `LobbyPage.tsx` has `currentPlayerId === game.hostId` already computed — host detection is straightforward to thread into `TeamColumn`
- `GameSettingsPanel` in `LobbyPage.tsx:266-368` is the reference for the host/non-host conditional rendering pattern; the team name editing follows the same split
- `games.test.ts:36` has `updateSettings: vi.fn()` — `updateTeamName` must be added to the mock the same way
- `import.meta.url`-based path resolution is already used in `server/src/index.ts:28` for serving static files — use the same pattern for the asset loader

## What We're NOT Doing

- No team rename allowed after the game has started (lobby only)
- No non-host rename capability
- No persistence across server restarts (in-memory store only, consistent with existing architecture)
- No UI for picking from the curated list; free-text entry up to 20 chars
- No change to how teams are represented internally (still `1` and `2`); `teamNames` is display data only

---

## Phase 1: Type + Asset + Server Core

### Overview

Adds `teamNames` to the shared `Game` type, creates the static asset and the loading utility, updates the store constructor and `createGame`, and adds `updateTeamName` to the store and the `GameStore` interface. No route or client changes yet — after this phase the server loads random names and `Game` objects carry them.

### Changes Required

#### 1. Shared type (`shared/src/types.ts`)

Add `teamNames` to `Game`:

```ts
export type Game = {
  // ... existing fields ...
  teamNames: { team1: string; team2: string }
  settings: GameSettings
}
```

`teamNames` is always present (populated at creation), not optional.

#### 2. Static asset (`server/assets/team-names.txt`)

Create the file. ~40 newline-separated names, for example:

```
The Dolphins
Red Dragons
Cosmic Foxes
Silver Wolves
Thunder Hawks
Neon Tigers
Golden Bears
Emerald Vipers
Crimson Eagles
Midnight Owls
Blazing Comets
Iron Giants
Lunar Sharks
Sapphire Lions
Wild Stallions
Arctic Foxes
Shadow Panthers
Solar Falcons
Storm Chasers
Desert Wolves
Jade Serpents
Bronze Titans
Frost Giants
Lava Hawks
Prism Bears
Quantum Foxes
Electric Eels
Obsidian Ravens
Cobalt Sharks
Amber Wolves
Neon Vipers
Crystal Eagles
Dark Horses
Blaze Runners
Tidal Waves
Fire Starters
Star Chasers
Night Owls
Swift Falcons
Roaring Lions
```

#### 3. Team names utility (`server/src/teamNames.ts`)

New file — two exported functions:

```ts
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { logger } from './logger.js'

export function loadTeamNames(): string[] {
  try {
    const filePath = join(dirname(fileURLToPath(import.meta.url)), '../../assets/team-names.txt')
    const raw = readFileSync(filePath, 'utf-8')
    return raw.split('\n').map((l) => l.trim()).filter(Boolean)
  } catch (err) {
    logger.warn('Could not load team-names.txt, falling back to defaults', { error: String(err) })
    return ['Team 1', 'Team 2']
  }
}

export function pickTeamNames(pool: string[]): { team1: string; team2: string } {
  if (pool.length < 2) return { team1: 'Team 1', team2: 'Team 2' }
  const idx1 = Math.floor(Math.random() * pool.length)
  const team1 = pool[idx1]
  const remaining = pool.filter((_, i) => i !== idx1)
  const team2 = remaining[Math.floor(Math.random() * remaining.length)]
  return { team1, team2 }
}
```

Keep it as a pure utility module — no state.

#### 4. `GameStore` interface (`server/src/store/GameStore.ts`)

Add:

```ts
updateTeamName(joinCode: string, playerId: string, team: 1 | 2, name: string): Promise<Game>
```

Import `Team` if not already present.

#### 5. `InMemoryGameStore` (`server/src/store/InMemoryGameStore.ts`)

**Constructor** — accept an optional second argument:

```ts
constructor(
  private readonly config: GameConfig,
  private readonly teamNamesPool: string[] = ['Team 1', 'Team 2'],
) {}
```

**`createGame()`** — add `teamNames` to the initial game object:

```ts
import { pickTeamNames } from '../teamNames.js'

// Inside createGame():
const game: InternalGame = {
  // ... existing fields ...
  teamNames: pickTeamNames(this.teamNamesPool),
  // ...
}
```

**New method `updateTeamName`**:

```ts
async updateTeamName(joinCode: string, playerId: string, team: 1 | 2, name: string): Promise<Game> {
  const game = this.games.get(joinCode)
  if (!game) throw new AppError('NOT_FOUND', 'Game not found')
  if (game.hostId !== playerId) throw new AppError('FORBIDDEN', 'Only the host can rename teams')
  if (game.status !== 'lobby') throw new AppError('INVALID_STATE', 'Team names can only be changed while the game is in the lobby')

  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > 20) {
    throw new AppError('VALIDATION', 'Team name must be between 1 and 20 characters')
  }
  const otherName = team === 1 ? game.teamNames.team2 : game.teamNames.team1
  if (trimmed.toLowerCase() === otherName.toLowerCase()) {
    throw new AppError('TEAM_NAME_CONFLICT', 'Both teams cannot have the same name')
  }

  game.teamNames = team === 1
    ? { team1: trimmed, team2: game.teamNames.team2 }
    : { team1: game.teamNames.team1, team2: trimmed }

  const snapshot = { ...game, players: [...game.players] }
  this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))
  return snapshot
}
```

#### 6. Wiring (`server/src/index.ts`)

```ts
import { loadTeamNames } from './teamNames.js'

const teamNames = loadTeamNames()
const store = new InMemoryGameStore(DEFAULT_GAME_CONFIG, teamNames)
```

### Tests to write first (failing)

**`server/src/store/InMemoryGameStore.test.ts`** — add a new `describe('teamNames')` block:

```ts
describe('teamNames', () => {
  it('creates a game with two distinct team names', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG, ['Alpha', 'Beta', 'Gamma'])
    const game = await store.createGame()
    expect(game.teamNames.team1).not.toBe(game.teamNames.team2)
    expect(['Alpha', 'Beta', 'Gamma']).toContain(game.teamNames.team1)
    expect(['Alpha', 'Beta', 'Gamma']).toContain(game.teamNames.team2)
  })

  it('falls back to Team 1 / Team 2 when pool has fewer than 2 entries', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG, ['Solo'])
    const game = await store.createGame()
    expect(game.teamNames).toEqual({ team1: 'Team 1', team2: 'Team 2' })
  })
})

describe('updateTeamName', () => {
  it('renames team 1 and broadcasts the change', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const { game, player: host } = await store.createGameWithHost('Alice', 1)
    const events: Game[] = []
    store.subscribe(game.joinCode, (g) => events.push(g))

    const updated = await store.updateTeamName(game.joinCode, host.id, 1, 'Red Dragons')
    expect(updated.teamNames.team1).toBe('Red Dragons')
    expect(events.at(-1)?.teamNames.team1).toBe('Red Dragons')
  })

  it('throws FORBIDDEN when caller is not the host', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const { game } = await store.createGameWithHost('Alice', 1)
    const bob = await store.joinGame(game.joinCode, 'Bob', 2)
    await expect(store.updateTeamName(game.joinCode, bob.id, 2, 'New Name')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('throws INVALID_STATE when game is in progress', async () => {
    const { store, joinCode } = await setupReadyGame()
    const startedGame = await store.startGame(joinCode)
    const hostId = startedGame.hostId!
    await expect(store.updateTeamName(joinCode, hostId, 1, 'New Name')).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })

  it('throws TEAM_NAME_CONFLICT when name matches the other team (case-insensitive)', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG, ['Alpha', 'Beta'])
    const { game, player: host } = await store.createGameWithHost('Alice', 1)
    const otherName = game.teamNames.team2
    await expect(store.updateTeamName(game.joinCode, host.id, 1, otherName.toUpperCase())).rejects.toMatchObject({ code: 'TEAM_NAME_CONFLICT' })
  })

  it('throws VALIDATION for an empty name', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const { game, player: host } = await store.createGameWithHost('Alice', 1)
    await expect(store.updateTeamName(game.joinCode, host.id, 1, '   ')).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('throws VALIDATION for a name exceeding 20 characters', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const { game, player: host } = await store.createGameWithHost('Alice', 1)
    await expect(store.updateTeamName(game.joinCode, host.id, 1, 'A'.repeat(21))).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
```

Also add a test for `pickTeamNames` in a dedicated `describe` block or a small separate test file `server/src/teamNames.test.ts`:

```ts
describe('pickTeamNames', () => {
  it('returns two distinct names from the pool', () => {
    const result = pickTeamNames(['Alpha', 'Beta', 'Gamma'])
    expect(result.team1).not.toBe(result.team2)
  })

  it('falls back when pool is too small', () => {
    expect(pickTeamNames(['Solo'])).toEqual({ team1: 'Team 1', team2: 'Team 2' })
    expect(pickTeamNames([])).toEqual({ team1: 'Team 1', team2: 'Team 2' })
  })
})
```

### Success Criteria

#### Automated Verification

- [x] TypeScript compiles: `pnpm --filter @wordfetti/server typecheck`
- [x] New store tests pass: `pnpm --filter @wordfetti/server test`
- [ ] `Game` objects from `createGame()` include `teamNames` with two distinct values from the pool

#### Manual Verification

- [ ] Server starts without error when `server/assets/team-names.txt` exists
- [ ] Server starts and logs a warning (not crash) when the file is deleted

---

## Phase 2: API Endpoint

### Overview

Adds the `PATCH /:joinCode/team-name` route and updates route tests. The mock store in `games.test.ts` needs `updateTeamName` added; all `Game` literal objects need `teamNames` added to keep the type correct (they use `as Game` so TypeScript won't error, but the field should be present for completeness).

### Changes Required

#### 1. Update mock in `games.test.ts`

Add to `DEFAULT_SETTINGS` companion constant:

```ts
const DEFAULT_TEAM_NAMES = { team1: 'Team Alpha', team2: 'Team Beta' }
```

Update every inline `Game` literal in the mock to include `teamNames: DEFAULT_TEAM_NAMES`.

Add to the `mockStore()` definition:

```ts
updateTeamName: vi.fn(),
```

#### 2. New route in `games.ts`

Apply the same `settingsLimiter` already declared at line 364. Add after the `PATCH /settings` block:

```ts
// PATCH /:joinCode/team-name — host renames a team (lobby only)
router.patch('/:joinCode/team-name', settingsLimiter, async (req, res, next) => {
  try {
    const joinCode = req.params.joinCode.toUpperCase()
    const { playerId, team, name } = req.body ?? {}

    if (typeof playerId !== 'string' || !playerId) {
      return res.status(400).json({ error: 'playerId is required' })
    }
    if (team !== 1 && team !== 2) {
      return res.status(400).json({ error: 'team must be 1 or 2' })
    }
    if (typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' })
    }

    const updated = await store.updateTeamName(joinCode, playerId, team, name)
    return res.json(toPublicGame(updated))
  } catch (err: unknown) {
    if (err instanceof AppError && err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message })
    if (err instanceof AppError && err.code === 'FORBIDDEN') return res.status(403).json({ error: err.message })
    if (err instanceof AppError && err.code === 'INVALID_STATE') return res.status(409).json({ error: err.message })
    if (err instanceof AppError && err.code === 'TEAM_NAME_CONFLICT') return res.status(409).json({ error: err.message })
    if (err instanceof AppError && err.code === 'VALIDATION') return res.status(400).json({ error: err.message })
    next(err)
  }
})
```

Note: body-level validation (empty string, length) is intentionally delegated to the store — the route only checks structural correctness (type of `name`), consistent with how the settings route delegates numeric range validation.

#### 3. Route tests (`games.test.ts`)

Write tests first:

```ts
describe('PATCH /api/games/:joinCode/team-name', () => {
  it('returns 200 with updated game on success', async () => {
    const updatedGame = { id: 'test-id', joinCode: 'ABC123', status: 'lobby' as const, players: [], settings: DEFAULT_SETTINGS, teamNames: { team1: 'Red Dragons', team2: 'Team Beta' } }
    const store = mockStore({ updateTeamName: vi.fn().mockResolvedValue(updatedGame) })
    const res = await request(buildApp(store)).patch('/ABC123/team-name').send({ playerId: 'p1', team: 1, name: 'Red Dragons' })
    expect(res.status).toBe(200)
    expect(res.body.teamNames.team1).toBe('Red Dragons')
  })

  it('returns 400 when playerId is missing', async () => {
    const res = await request(buildApp(mockStore())).patch('/ABC123/team-name').send({ team: 1, name: 'Red Dragons' })
    expect(res.status).toBe(400)
  })

  it('returns 400 when team is invalid', async () => {
    const res = await request(buildApp(mockStore())).patch('/ABC123/team-name').send({ playerId: 'p1', team: 3, name: 'Red Dragons' })
    expect(res.status).toBe(400)
  })

  it('returns 403 when store throws FORBIDDEN', async () => {
    const store = mockStore({ updateTeamName: vi.fn().mockRejectedValue(new AppError('FORBIDDEN', 'Only the host can rename teams')) })
    const res = await request(buildApp(store)).patch('/ABC123/team-name').send({ playerId: 'p1', team: 1, name: 'Red Dragons' })
    expect(res.status).toBe(403)
  })

  it('returns 409 when store throws INVALID_STATE', async () => {
    const store = mockStore({ updateTeamName: vi.fn().mockRejectedValue(new AppError('INVALID_STATE', 'lobby only')) })
    const res = await request(buildApp(store)).patch('/ABC123/team-name').send({ playerId: 'p1', team: 1, name: 'Red Dragons' })
    expect(res.status).toBe(409)
  })

  it('returns 409 when store throws TEAM_NAME_CONFLICT', async () => {
    const store = mockStore({ updateTeamName: vi.fn().mockRejectedValue(new AppError('TEAM_NAME_CONFLICT', 'same name')) })
    const res = await request(buildApp(store)).patch('/ABC123/team-name').send({ playerId: 'p1', team: 1, name: 'Red Dragons' })
    expect(res.status).toBe(409)
  })

  it('returns 400 when store throws VALIDATION', async () => {
    const store = mockStore({ updateTeamName: vi.fn().mockRejectedValue(new AppError('VALIDATION', 'too long')) })
    const res = await request(buildApp(store)).patch('/ABC123/team-name').send({ playerId: 'p1', team: 1, name: 'A'.repeat(21) })
    expect(res.status).toBe(400)
  })
})
```

### Success Criteria

#### Automated Verification

- [x] All route tests pass: `pnpm --filter @wordfetti/server test`
- [x] TypeScript compiles: `pnpm --filter @wordfetti/server typecheck`

#### Manual Verification

- [ ] `curl -X PATCH /api/games/XXXX/team-name -d '{"playerId":"...","team":1,"name":"Red Dragons"}'` returns 200 and updated game
- [ ] Same request with wrong playerId returns 403
- [ ] Same request after game starts returns 409

---

## Phase 3: Client

### Overview

Updates `LobbyPage.tsx` to drive team names from `game.teamNames`, and adds inline edit capability (pencil icon → text input) for the host inside `TeamColumn`. The SSE flow already delivers game updates — no new subscription logic needed.

### Changes Required

#### 1. `LobbyPage.tsx` — thread team names into `TeamColumn`

Update the two `TeamColumn` usages (currently lines 109–122):

```tsx
<TeamColumn
  teamName={game.teamNames.team1}
  otherTeamName={game.teamNames.team2}
  players={team1}
  currentPlayerId={currentPlayerId}
  colorScheme="coral"
  wordsPerPlayer={game.settings.wordsPerPlayer}
  isHost={currentPlayerId === game.hostId}
  joinCode={joinCode!}
  playerId={currentPlayerId ?? ''}
/>
<TeamColumn
  teamName={game.teamNames.team2}
  otherTeamName={game.teamNames.team1}
  players={team2}
  currentPlayerId={currentPlayerId}
  colorScheme="teal"
  wordsPerPlayer={game.settings.wordsPerPlayer}
  isHost={currentPlayerId === game.hostId}
  joinCode={joinCode!}
  playerId={currentPlayerId ?? ''}
/>
```

#### 2. `TeamColumn` — rename `label` prop and add editing

Update the `TeamColumnProps` type:

```ts
type TeamColumnProps = {
  teamName: string
  otherTeamName: string
  players: Player[]
  currentPlayerId: string | null
  colorScheme: keyof typeof SCHEME
  wordsPerPlayer: number
  isHost: boolean
  joinCode: string
  playerId: string
}
```

Add editing state and handler inside `TeamColumn`:

```tsx
function TeamColumn({ teamName, otherTeamName, players, currentPlayerId, colorScheme, wordsPerPlayer, isHost, joinCode, playerId }: TeamColumnProps) {
  const { bg, labelColor, badgeBg, needColor } = SCHEME[colorScheme]
  const needMore = Math.max(0, 2 - players.length)
  const headingId = `team-heading-${colorScheme}`
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(teamName)
  const [editError, setEditError] = useState<string | null>(null)

  // Keep editValue in sync with SSE-delivered teamName while not editing
  useEffect(() => {
    if (!editing) setEditValue(teamName)
  }, [teamName, editing])

  async function handleSave() {
    const trimmed = editValue.trim()
    if (trimmed.length === 0 || trimmed.length > 20) {
      setEditError('Name must be 1–20 characters')
      return
    }
    if (trimmed.toLowerCase() === otherTeamName.toLowerCase()) {
      setEditError('Both teams cannot have the same name')
      return
    }
    if (trimmed === teamName) {
      setEditing(false)
      return
    }
    setEditError(null)
    const team = colorScheme === 'coral' ? 1 : 2
    const res = await fetch(`/api/games/${joinCode}/team-name`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, team, name: trimmed }),
    })
    if (res.ok) {
      setEditing(false)
    } else {
      const body = await res.json().catch(() => ({}))
      setEditError(body.error ?? 'Could not save team name')
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') handleSave()
    if (e.key === 'Escape') {
      setEditing(false)
      setEditValue(teamName)
      setEditError(null)
    }
  }

  const nameDisplay = editing ? (
    <div className="flex flex-col gap-1 flex-1">
      <input
        autoFocus
        maxLength={20}
        value={editValue}
        onChange={(e) => { setEditValue(e.target.value); setEditError(null) }}
        onBlur={handleSave}
        onKeyDown={handleKeyDown}
        className={`text-sm font-semibold ${labelColor} bg-transparent border-b border-current focus:outline-none w-full`}
      />
      {editError && <p className="text-xs text-red-500">{editError}</p>}
    </div>
  ) : (
    <h2 id={headingId} className={`text-sm font-semibold ${labelColor}`}>{teamName}</h2>
  )

  return (
    <section aria-labelledby={headingId} className={`rounded-2xl ${bg} p-4`}>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-1 flex-1 min-w-0">
          {nameDisplay}
          {isHost && !editing && (
            <button
              onClick={() => { setEditing(true); setEditValue(teamName) }}
              aria-label={`Edit team name`}
              className={`${labelColor} opacity-60 hover:opacity-100 shrink-0`}
            >
              <PencilIcon />
            </button>
          )}
        </div>
        <span className={`rounded-full ${badgeBg} px-2 py-0.5 text-xs font-bold text-white shrink-0`}>
          {players.length}
        </span>
      </div>
      {/* ... rest of TeamColumn unchanged ... */}
    </section>
  )
}
```

Note: `colorScheme === 'coral'` maps to team 1 and `'teal'` maps to team 2 — this avoids needing to pass an explicit `team` number prop since the mapping is already established by `SCHEME`.

#### 3. Add `PencilIcon` component at bottom of `LobbyPage.tsx`

Alongside the existing `CopyIcon`:

```tsx
function PencilIcon() {
  return (
    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  )
}
```

#### 4. Update `useGameState.ts` import

No changes needed — `game.teamNames` is automatically available since `Game` type now includes it and SSE already delivers the full game snapshot.

### Success Criteria

#### Automated Verification

- [ ] TypeScript compiles: `pnpm --filter @wordfetti/client typecheck` (or equivalent)
- [ ] No new TS errors introduced

#### Manual Verification

- [ ] Lobby shows randomly picked team names (not "Team 1" / "Team 2") for all players
- [ ] Host sees a pencil icon next to each team name
- [ ] Clicking pencil replaces the heading with an editable input pre-filled with the current name
- [ ] Pressing Enter or blurring saves; all other connected devices see the change without refresh
- [ ] Pressing Escape cancels and restores the previous name without an API call
- [ ] Entering a name > 20 chars (auto-capped by `maxLength`) or matching the other team shows an inline error; no API call is made
- [ ] Non-host sees only plain text; no pencil icon
- [ ] Player who is on Team 1 when the host renames it sees the new name instantly; their word count and team assignment are unchanged

---

## Phase 4: Dockerfile Verification

### Overview

Confirm that `server/assets/` is included in the Docker image via `pnpm deploy`. If not, add an explicit COPY.

### Changes Required

#### 1. Build and inspect

After implementation, build the image locally and verify the file is present:

```bash
docker build -t wordfetti-test .
docker run --rm wordfetti-test ls server/assets/
```

#### 2. If `team-names.txt` is missing — add to `Dockerfile`

In the `runtime` stage, after the existing `COPY --from=build /app/deploy ./server` line:

```dockerfile
COPY --from=build /app/server/assets ./server/assets
```

This is a fallback only. `pnpm deploy` should copy the whole package directory (including `assets/`) since there is no `files` field in `server/package.json` restricting the output.

### Success Criteria

#### Automated Verification

- [ ] Docker image builds successfully: `docker build -t wordfetti-test .`
- [ ] File exists in image: `docker run --rm wordfetti-test ls server/assets/team-names.txt`

#### Manual Verification

- [ ] Server inside the container starts and picks non-default team names (confirming the file loaded)

---

## Testing Strategy

### Unit Tests

- `pickTeamNames`: two distinct names from pool; fallback when pool < 2
- `InMemoryGameStore.createGame`: result has `teamNames` with two distinct values from injected pool
- `InMemoryGameStore.updateTeamName`: happy path + all error codes (FORBIDDEN, INVALID_STATE, TEAM_NAME_CONFLICT, VALIDATION for empty and too-long)

### Integration / Route Tests

- `PATCH /team-name`: 200 happy path, 400 for missing/invalid body fields, 403/409/400 mapped from store errors

### Manual Testing Steps

1. Create a game → lobby shows two random team names different from "Team 1" / "Team 2"
2. Open lobby on two devices; host edits team 1 name → second device updates without refresh
3. Non-host device: confirm no pencil icon, confirm name updates live
4. Host tries to set team 1 name = team 2 name → inline error, no API call
5. Host tries 21-character name → `maxLength` caps at 20 client-side
6. Start the game; attempt `PATCH /team-name` via curl → 409

## Migration Notes

None — all state is in-memory and no data needs to be migrated.

## References

- Original ticket: `meta/tickets/ENG-016-random-and-editable-team-names.md`
- Pattern reference (PATCH settings): `server/src/routes/games.ts:367-405`
- Pattern reference (store broadcast): `server/src/store/InMemoryGameStore.ts:86-88`
- Pattern reference (host/non-host conditional UI): `client/src/pages/LobbyPage.tsx:266-333`
- Static file path resolution: `server/src/index.ts:28`
