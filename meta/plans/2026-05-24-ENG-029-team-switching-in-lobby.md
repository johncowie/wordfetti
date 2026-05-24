---
date: "2026-05-24T00:00:00Z"
type: plan
skill: create-plan
work-item: ""
status: draft
---

# Team Switching in Lobby Implementation Plan

## Overview

Allow players to switch teams freely while the game is in the lobby. After joining a team, the opposing team's button remains visible (with "Switch to {Team Name}" text) so the player can change their mind. Once the host starts the game, teams are locked and no switching is possible.

## Current State Analysis

When a player joins a team (`POST /api/games/:joinCode/players`), the client sets `session.playerId` in state/localStorage. `LobbyPage.tsx:137` gates the entire join panel behind `!currentPlayerId`, so once a player has joined, both team buttons and the name input all disappear.

The server's `PlayerRoster` stores each player's `team` field as a simple `1 | 2` value on the `Player` object (`PlayerRoster.ts:49`). There is no existing mechanism to mutate this after joining.

### Key Discoveries:

- Join panel rendered at `LobbyPage.tsx:137-170` — a single `{!currentPlayerId && ...}` guard hides everything after joining
- Player's current team is accessible via `game.players.find(p => p.id === currentPlayerId)?.team` from the SSE snapshot
- `GameSession.join()` at `Game.ts:49` already gates on `status !== 'lobby'` — the same pattern applies to switching
- `PlayerRoster.ts` holds `_players: Player[]`; `player.team` is a plain mutable property, so a `switchTeam` method is trivial to add
- Lobby lock is automatic on the client: `useGameState` drives `game.status`, and `LobbyPage.tsx:28-32` navigates to `/game/:joinCode` the moment status becomes `in_progress`, so switch UI never needs to guard against in-progress — it disappears naturally
- The SSE broadcast pattern is uniform across all mutations: call `notifyAndReturn(joinCode, game)` in `InMemoryGameStore` after mutation

## Desired End State

- A player who has already joined can see a "Switch to {Other Team Name}" button in the lobby
- Clicking it moves them to the other team immediately (SSE broadcast updates all clients)
- The button's colour reflects the target team (coral for Team 1, teal for Team 2), matching the existing join button styles
- No name re-entry is needed; the name input stays hidden once joined
- Once the game starts, the lobby page navigates away — no switch UI is ever shown mid-game

### Verification:

- Player joins Team A → button "Switch to Team B" appears; both team columns update live
- Clicking switch → player moves to Team B; button changes to "Switch to Team A"
- Works for the host too (host can switch their own team)
- Game starts → lobby page navigates to `/game/:joinCode`; no switch controls visible on game page
- Another browser tab (spectator/other player) sees the team column update in real time after each switch

## What We're NOT Doing

- No host-only restriction on team switching — any player can switch freely in the lobby
- No limit on how many times a player can switch
- No server-side validation that teams remain balanced after a switch (host already sees the "need 2 players per team" warning before starting)
- No team switching during an active game (enforced at server with a lobby-only guard, matching the pattern used by `addWord`, `updateSettings`, etc.)

## Implementation Approach

Add a minimal new mutation path: `switchTeam` through all four layers (PlayerRoster → GameSession → InMemoryGameStore → route), then update the join panel in `LobbyPage.tsx` to conditionally show a switch button instead of hiding everything after joining.

---

## Phase 1: Server — `switchTeam` mutation

### Overview

Adds a `switchTeam` method through `PlayerRoster`, `GameSession`, `GameStore`, and `InMemoryGameStore`, plus a `PATCH /:joinCode/players/:playerId/team` route.

### Changes Required:

#### 1. `PlayerRoster` — add `switchTeam` method

**File**: `server/src/store/PlayerRoster.ts`

```typescript
switchTeam(playerId: string, newTeam: Team): void {
  const player = this._players.find((p) => p.id === playerId && p.active)
  if (!player) throw new Error('Player not found or not active')
  player.team = newTeam
}
```

Add after the `kick` method (line 58).

#### 2. `GameSession` — add `switchTeam` method

**File**: `server/src/store/Game.ts`

```typescript
switchTeam(playerId: string, newTeam: Team): void {
  if (this.status !== 'lobby') throw new AppError('GAME_NOT_IN_LOBBY', 'Teams can only be changed while the game is in the lobby')
  const player = this.roster.getById(playerId)
  if (!player || !player.active) throw new AppError('FORBIDDEN', 'Player not in game')
  this.roster.switchTeam(playerId, newTeam)
}
```

Add after the `join` method (line 53).

#### 3. `GameStore` interface — add `switchTeam`

**File**: `server/src/store/GameStore.ts`

```typescript
/**
 * @throws AppError('NOT_FOUND') if the game does not exist
 * @throws AppError('GAME_NOT_IN_LOBBY') if the game has already started
 * @throws AppError('FORBIDDEN') if the player is not an active participant
 */
switchTeam(joinCode: string, playerId: string, newTeam: Team): Promise<GameSnapshot>
```

Add after the `joinGame` entry.

#### 4. `InMemoryGameStore` — implement `switchTeam`

**File**: `server/src/store/InMemoryGameStore.ts`

```typescript
async switchTeam(joinCode: string, playerId: string, newTeam: Team): Promise<GameSnapshot> {
  const game = this.requireGame(joinCode)
  game.switchTeam(playerId, newTeam)
  this.touch(joinCode)
  return this.notifyAndReturn(joinCode, game)
}
```

Add after `joinGame` (around line 135).

#### 5. Route — `PATCH /:joinCode/players/:playerId/team`

**File**: `server/src/routes/games.ts`

Add this route after the `POST /:joinCode/players` route (after line 399):

```typescript
// PATCH /:joinCode/players/:playerId/team — switch a player's team (lobby only)
router.patch('/:joinCode/players/:playerId/team', async (req, res, next) => {
  try {
    const joinCode = req.params.joinCode.toUpperCase()
    const { playerId } = req.params
    const { team } = req.body ?? {}
    if (!isValidTeam(team)) {
      return res.status(400).json({ error: 'Team must be 1 or 2' })
    }
    const updated = await store.switchTeam(joinCode, playerId, team)
    return res.json(updated)
  } catch (err: unknown) {
    if (err instanceof AppError && err.code === 'NOT_FOUND') return res.status(404).json({ error: 'Game not found' })
    if (err instanceof AppError && err.code === 'FORBIDDEN') return res.status(403).json({ error: err.message })
    if (err instanceof AppError && err.code === 'GAME_NOT_IN_LOBBY') return res.status(409).json({ error: err.message })
    next(err)
  }
})
```

### Success Criteria:

#### Automated Verification:

- [ ] TypeScript compiles: `pnpm --filter server build`
- [ ] All server tests pass: `pnpm test`
- [ ] Manual curl: join a game, then `PATCH /api/games/:joinCode/players/:playerId/team` with `{ "team": 2 }` returns the updated snapshot with the player on the new team
- [ ] Manual curl: calling the route with `in_progress` game returns 409

---

## Phase 2: Client — Switch Team UI in `LobbyPage`

### Overview

Restructure the join panel in `LobbyPage.tsx` so that after joining, the name input disappears but the opposing team's button remains as a "Switch to {Team Name}" action.

### Changes Required:

#### 1. New state and handler in `LobbyPage`

**File**: `client/src/pages/LobbyPage.tsx`

Add two new state variables after the existing `joinLoading`/`joinError` pair:

```typescript
const [switchLoading, setSwitchLoading] = useState(false)
const [switchError, setSwitchError] = useState<string | null>(null)
```

Add a new `handleSwitchTeam` function after `handleJoin`:

```typescript
async function handleSwitchTeam(newTeam: Team) {
  if (!joinCode || !session) return
  setSwitchLoading(true)
  setSwitchError(null)
  try {
    const res = await fetch(`/api/games/${joinCode}/players/${session.playerId}/team`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team: newTeam }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setSwitchError(data.error ?? 'Could not switch teams.')
    }
    // On success, SSE push updates team columns automatically
  } catch {
    setSwitchError('Something went wrong. Please try again.')
  } finally {
    setSwitchLoading(false)
  }
}
```

#### 2. Restructure the join panel JSX

**File**: `client/src/pages/LobbyPage.tsx:136-170`

Replace the single `{!currentPlayerId && (...)}` block with two conditional blocks:

```tsx
{/* Join UI — shown only to visitors who haven't joined yet */}
{!currentPlayerId && (
  <div className="mt-4 rounded-2xl bg-white p-5 shadow-sm">
    <p className="mb-3 text-sm font-semibold text-gray-700">Want to play?</p>
    <div className="flex flex-col gap-3">
      <input
        type="text"
        value={joinName}
        onChange={(e) => { setJoinName(e.target.value); setJoinError(null) }}
        placeholder="Enter your name"
        maxLength={50}
        className="rounded-lg border border-gray-200 px-4 py-3 text-sm outline-none focus:border-brand-coral focus:ring-1 focus:ring-brand-coral"
      />
      {joinError && (
        <p role="alert" className="text-sm text-red-600">{joinError}</p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => handleJoin(1)}
          disabled={joinName.trim().length === 0 || joinLoading}
          className="rounded-xl bg-brand-coral px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Join {game.teamNames.team1}
        </button>
        <button
          onClick={() => handleJoin(2)}
          disabled={joinName.trim().length === 0 || joinLoading}
          className="rounded-xl bg-brand-teal px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Join {game.teamNames.team2}
        </button>
      </div>
    </div>
  </div>
)}

{/* Switch team UI — shown only to joined players while game is still in lobby */}
{currentPlayerId && (() => {
  const currentPlayer = game.players.find((p) => p.id === currentPlayerId)
  if (!currentPlayer) return null
  const oppositeTeam: Team = currentPlayer.team === 1 ? 2 : 1
  const oppositeTeamName = oppositeTeam === 1 ? game.teamNames.team1 : game.teamNames.team2
  const btnClass = oppositeTeam === 1
    ? 'rounded-xl bg-brand-coral px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40'
    : 'rounded-xl bg-brand-teal px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40'
  return (
    <div className="mt-4 rounded-2xl bg-white p-5 shadow-sm">
      <button
        onClick={() => handleSwitchTeam(oppositeTeam)}
        disabled={switchLoading}
        className={`w-full ${btnClass}`}
      >
        Switch to {oppositeTeamName}
      </button>
      {switchError && (
        <p role="alert" className="mt-2 text-sm text-red-600">{switchError}</p>
      )}
    </div>
  )
})()}
```

Note: The IIFE pattern above can be extracted into a small component or a computed variable if preferred, but it keeps all logic co-located.

### Success Criteria:

#### Automated Verification:

- [ ] TypeScript compiles: `pnpm --filter client build`
- [ ] All tests pass: `pnpm test`

#### Manual Verification:

- [ ] Open two browser windows for the same game
- [ ] Window 1 joins Team A → join panel collapses to just "Switch to Team B" button
- [ ] Clicking "Switch to Team B" → player moves to Team B column in both windows; button changes to "Switch to Team A"
- [ ] Clicking "Switch to Team A" → player moves back; button changes again
- [ ] Name input is not visible after joining
- [ ] Host can also switch their own team
- [ ] Game starts → lobby page navigates to `/game/:joinCode`; no switch button appears on game page
- [ ] A second player joining from another device sees the switching player's team update in real time

---

## Testing Strategy

### Unit Tests:

- `PlayerRoster.switchTeam` — moves player to new team; throws if player not found or inactive
- `GameSession.switchTeam` — throws `GAME_NOT_IN_LOBBY` if status is not `lobby`; delegates to roster otherwise
- Route integration test: `PATCH /players/:playerId/team` — happy path returns 200 with updated snapshot; 409 when in progress; 403 for unknown player; 400 for invalid team value

### Manual Testing Steps:

1. Create a game, join as host on Team 1, join another player on Team 2 in a second tab
2. Switch host to Team 2 — verify both team columns update live in both tabs
3. Switch back — verify player count badges update correctly
4. Start the game — confirm neither player sees a switch button on the game page

## References

- Join route pattern: `server/src/routes/games.ts:373`
- Existing lobby gate pattern: `server/src/store/Game.ts:50`
- Roster mutation pattern: `server/src/store/PlayerRoster.ts:55`
- LobbyPage join panel: `client/src/pages/LobbyPage.tsx:136`
