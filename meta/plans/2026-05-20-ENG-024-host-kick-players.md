---
date: "2026-05-20T12:59:39+00:00"
type: plan
skill: create-plan
work-item: "ENG-024"
status: draft
---

# ENG-024: Host Kick Players Implementation Plan

## Overview

Add a host-only "kick player" feature so the host can remove any player during the lobby or an active game. Gives the host a manual escape hatch when a player disconnects and stalls the game.

## Prerequisite

**REFACTOR-001 must be merged first.** This plan assumes `PlayerRoster` exists, `InternalGame` carries `roster: PlayerRoster` instead of `players`/`clueGiverIndices`/`clueGiverStats`, and `Player` has `active: boolean` and `stats: { clueGiverCount: number }`.

## Current State Analysis (post REFACTOR-001)

- `InMemoryGameStore` has no `kickPlayer` method; the `GameStore` interface has no corresponding signature.
- `roster.kick(playerId)` sets `active: false` and leaves the player in the roster — their stats are preserved and their slot in the rotation is skipped naturally by `assignNextClueGiver`.
- `roster.getByTeam(team)` returns only active players, so the "0 active players → end game" guard is a simple length check.
- No `DELETE /:joinCode/players/:targetPlayerId` route exists. `DELETE /:joinCode/words/:wordId` (`games.ts:229`) is the structural template to follow.
- No shared modal component exists. The only overlay is `RoundSplashOverlay` in `GamePage.tsx:417` — a `fixed inset-0 z-50` div with `role="dialog"`. We'll follow this pattern.
- Host is identified client-side as `currentPlayerId === game.hostId`, derived inline in each page.
- `game.players` (post-refactor: `roster.getAll()`) includes both active and inactive players. Client-side rendering doesn't filter by `active` yet — ENG-024 adds that filtering as part of the UI work.

## Desired End State

- A host on any screen (lobby, active game, between-rounds) can open a "Manage Players" modal listing all non-host players, click a kick icon, confirm, and the player is immediately removed for all connected clients.
- A kicked clue giver ends the current turn and passes to the other team (normal rotation).
- Kicking the last active player from either team transitions the game to `finished`.
- Non-host API attempts return HTTP 403; self-kick attempts return HTTP 403.
- Kicked players' words remain in the hat; their `stats.clueGiverCount` is preserved on their (now inactive) player object.
- The lobby and game player lists reflect the updated `active` state immediately via SSE.

### Key Discoveries

- `PlayerRoster.kick(playerId)` — sets `active: false`. No index repair needed; `assignNextClueGiver` skips inactive players naturally.
- `PlayerRoster.assignNextClueGiver(team)` — atomically finds the next active player after `_lastClueGiverId[team]`, advances the pointer, returns the player. Used directly in the turn-advancement logic inside `kickPlayer`.
- `PlayerRoster.getByTeam(team)` — returns active players only. The "0 players → finish" guard is `roster.getByTeam(team).length === 0`.
- `games.ts:229–245` — `DELETE /:joinCode/words/:wordId` is the template for the new route.
- `GamePage.tsx:417–443` — `RoundSplashOverlay` is the template for the new modal.
- `LobbyPage.tsx:159` — host-only "Start Game" button is the placement reference for the lobby "Manage Players" button.
- `GamePage.tsx:399` — host-only "Start Round N" in `BetweenRoundsView` is the placement reference for the game-screen button.

## What We're NOT Doing

- Automatic disconnection detection — kick is intentional/manual only.
- Removing kicked players' words from the hat.
- Changing `stats.clueGiverCount` on kick (preserved automatically since the player object stays in the roster).
- Enforcing minimum team size during an active game (the only hard guard is "0 active players → end game").

---

## Phase 1: Store — `kickPlayer` Method

### Overview

Add `kickPlayer` to the `GameStore` interface and implement it in `InMemoryGameStore`. All business logic lives here — the roster handles the complexity.

### Changes Required

#### 1. `GameStore` interface

**File**: `server/src/store/GameStore.ts`  
**Change**: Add method signature after `updateTeamName`.

```ts
kickPlayer(joinCode: string, hostPlayerId: string, targetPlayerId: string): Promise<Game>
```

#### 2. `InMemoryGameStore` implementation

**File**: `server/src/store/InMemoryGameStore.ts`  
**Change**: Add `kickPlayer` method after `updateTeamName`.

```ts
async kickPlayer(joinCode: string, hostPlayerId: string, targetPlayerId: string): Promise<Game> {
  const game = this.games.get(joinCode)
  if (!game) throw new AppError('NOT_FOUND', 'Game not found')
  if (!game.hostId || game.hostId !== hostPlayerId)
    throw new AppError('FORBIDDEN', 'Only the host can kick players')

  const target = game.roster.getById(targetPlayerId)
  if (!target) throw new AppError('NOT_FOUND', 'Player not found')
  if (targetPlayerId === game.hostId)
    throw new AppError('FORBIDDEN', 'Cannot kick the host')

  game.roster.kick(targetPlayerId)

  // End game if either team now has 0 active players.
  if (game.status === 'in_progress' || game.status === 'between_rounds') {
    const t1Active = game.roster.getByTeam(1).length
    const t2Active = game.roster.getByTeam(2).length
    if (t1Active === 0 || t2Active === 0) {
      game.status = 'finished'
      return this.notifySubscribers(joinCode, game)
    }
  }

  // If the kicked player was the active clue giver, advance the turn to the other team.
  if (game.status === 'in_progress' && targetPlayerId === game.currentClueGiverId) {
    const newActiveTeam: 1 | 2 = game.activeTeam === 1 ? 2 : 1
    const nextClueGiver = game.roster.assignNextClueGiver(newActiveTeam)
    Object.assign(game, {
      activeTeam: newActiveTeam,
      currentClueGiverId: nextClueGiver.id,
      turnPhase: 'ready',
      currentWord: undefined,
      currentWordId: undefined,
      skippedThisTurn: [],
      guessedThisTurn: [],
      turnStartedAt: undefined,
    })
    logger.info('Clue giver kicked; turn advanced', { joinCode, newActiveTeam, nextClueGiver: nextClueGiver.name })
  }

  logger.info('Player kicked', { joinCode, targetPlayerId })
  return this.notifySubscribers(joinCode, game)
}
```

### Success Criteria

#### Automated Verification

- [ ] TypeScript compiles: `pnpm --filter server build`
- [ ] Store unit tests pass: `pnpm test` — new tests in `InMemoryGameStore.test.ts` covering:
  - Non-host caller → throws `FORBIDDEN`
  - Self-kick attempt → throws `FORBIDDEN`
  - Unknown target → throws `NOT_FOUND`
  - Lobby kick: player has `active: false`, other players unaffected
  - Active-game kick of non-clue-giver: turn unaffected, `game.currentClueGiverId` unchanged
  - Active-game kick of clue giver: turn advances to the other team, new clue giver set
  - Active-game kick leaving a team with 0 active players: `game.status === 'finished'`
  - Kicked player's `stats.clueGiverCount` is preserved after kick
  - Kicked player still appears in `game.players` with `active: false`

---

## Phase 2: HTTP Route — `DELETE /:joinCode/players/:targetPlayerId`

### Overview

Wire `kickPlayer` to a new `DELETE` endpoint following the exact pattern of `DELETE /:joinCode/words/:wordId` (`games.ts:229`).

### Changes Required

**File**: `server/src/routes/games.ts`  
**Change**: Add after the existing `POST /:joinCode/players` route (~line 403).

```ts
router.delete('/:joinCode/players/:targetPlayerId', async (req, res, next) => {
  const joinCode = req.params.joinCode.toUpperCase()
  const { targetPlayerId } = req.params
  const { playerId } = req.body ?? {}
  if (!playerId || typeof playerId !== 'string') {
    return res.status(400).json({ error: 'playerId is required' })
  }
  try {
    const game = await store.kickPlayer(joinCode, playerId, targetPlayerId)
    return res.status(200).json(game)
  } catch (err: unknown) {
    if (err instanceof AppError && err.code === 'NOT_FOUND')
      return res.status(404).json({ error: err.message })
    if (err instanceof AppError && err.code === 'FORBIDDEN')
      return res.status(403).json({ error: err.message })
    return next(err)
  }
})
```

### Success Criteria

#### Automated Verification

- [ ] TypeScript compiles: `pnpm --filter server build`
- [ ] Route integration tests pass: `pnpm test` — new tests in `games.test.ts` covering:
  - Valid host kick → 200, response includes player with `active: false`
  - Non-host caller → 403
  - Self-kick → 403
  - Unknown player → 404
  - Missing `playerId` body field → 400

---

## Phase 3: UI — `ManagePlayersModal` Component

### Overview

Create a reusable `ManagePlayersModal` following the `RoundSplashOverlay` overlay pattern. The modal renders all non-host players regardless of `active` state — kicked players appear greyed out so the host can see the full picture. Only active players have a kick button.

### Changes Required

**File**: `client/src/components/ManagePlayersModal.tsx` (new file)

```tsx
import { useState } from 'react'
import type { Player } from '@wordfetti/shared'

interface Props {
  joinCode: string
  players: Player[]
  hostPlayerId: string
  onClose: () => void
}

export function ManagePlayersModal({ joinCode, players, hostPlayerId, onClose }: Props) {
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const nonHostPlayers = players.filter((p) => p.id !== hostPlayerId)
  const confirmTarget = nonHostPlayers.find((p) => p.id === confirmId)

  async function kick(targetPlayerId: string) {
    setError(null)
    const res = await fetch(`/api/games/${joinCode}/players/${targetPlayerId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: hostPlayerId }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError(body.error ?? 'Failed to kick player')
    }
    setConfirmId(null)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-label="Manage Players"
    >
      <div className="bg-brand-cream rounded-2xl p-6 w-full max-w-sm mx-4 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">Manage Players</h2>
          <button onClick={onClose} aria-label="Close" className="text-2xl leading-none">×</button>
        </div>

        {confirmTarget ? (
          <div>
            <p className="mb-4">
              Are you sure you want to kick <strong>{confirmTarget.name}</strong> out of the game?
            </p>
            <div className="flex gap-3">
              <button
                className="flex-1 bg-brand-coral text-white rounded-xl py-2 font-semibold"
                onClick={() => kick(confirmTarget.id)}
              >
                Kick
              </button>
              <button
                className="flex-1 border border-gray-300 rounded-xl py-2"
                onClick={() => setConfirmId(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <ul className="space-y-2">
            {nonHostPlayers.map((p) => (
              <li
                key={p.id}
                className={`flex items-center justify-between py-2 border-b last:border-0 ${!p.active ? 'opacity-40' : ''}`}
              >
                <span>
                  {p.name}{' '}
                  <span className="text-sm text-gray-500">Team {p.team}</span>
                  {!p.active && <span className="ml-2 text-xs text-gray-400">(kicked)</span>}
                </span>
                {p.active && (
                  <button
                    aria-label={`Kick ${p.name}`}
                    onClick={() => setConfirmId(p.id)}
                    className="text-brand-coral hover:text-red-600 text-lg"
                  >
                    ✕
                  </button>
                )}
              </li>
            ))}
            {nonHostPlayers.length === 0 && (
              <li className="text-gray-500 text-sm">No other players in the game.</li>
            )}
          </ul>
        )}

        {error && <p role="alert" className="mt-3 text-red-600 text-sm">{error}</p>}
      </div>
    </div>
  )
}
```

### Success Criteria

#### Automated Verification

- [ ] TypeScript compiles: `pnpm --filter client build`

#### Manual Verification

- [ ] Modal lists all non-host players; active players have a kick button; already-kicked players appear greyed out with no kick button
- [ ] Clicking kick shows confirmation with player name; cancelling returns to the list
- [ ] Confirming sends the DELETE request; the player's row updates to greyed-out immediately via SSE
- [ ] Error message appears if the request fails
- [ ] Close button dismisses the modal

---

## Phase 4: UI Integration — Host "Manage Players" Button

### Overview

Add a "Manage Players" button to the host view in `LobbyPage` and `GamePage`. The button opens `ManagePlayersModal`. Because `game.players` includes all players (active + inactive) and the modal handles rendering both states, no special filtering is needed at the integration points.

### Changes Required

#### 1. `LobbyPage.tsx`

**File**: `client/src/pages/LobbyPage.tsx`

- Import `ManagePlayersModal`
- Add `showManagePlayers` state
- Render button in the host-only section alongside "Start Game" (`~line 159`)
- Render modal at the bottom of the return

The existing `TeamColumn` player list currently renders `game.players` directly — update to filter by `p.active` so only active players appear in the lobby columns. Inactive (kicked) players should not count toward team size display or word submission badges.

```tsx
import { ManagePlayersModal } from '../components/ManagePlayersModal'

// state:
const [showManagePlayers, setShowManagePlayers] = useState(false)

// in host-only section:
{isHost && (
  <button
    onClick={() => setShowManagePlayers(true)}
    className="text-sm underline text-gray-600 hover:text-gray-900"
  >
    Manage Players
  </button>
)}

// modal:
{showManagePlayers && currentPlayerId && (
  <ManagePlayersModal
    joinCode={joinCode}
    players={game.players}
    hostPlayerId={currentPlayerId}
    onClose={() => setShowManagePlayers(false)}
  />
)}
```

**Also update `TeamColumn`** to filter `players.filter(p => p.active)` when rendering the player list and calculating counts. The word submission progress check in start-game gating (`allWordsSubmitted`) must also filter to active players.

#### 2. `GamePage.tsx`

**File**: `client/src/pages/GamePage.tsx`

Same pattern — import, state, button, modal. Place the button:
- In `BetweenRoundsView` alongside "Start Round N" (`~line 399`)
- In `WaitingView` and `SpectatorView` (small text link) so the host can access it during an active turn without interrupting the clue giver

```tsx
import { ManagePlayersModal } from '../components/ManagePlayersModal'

// state:
const [showManagePlayers, setShowManagePlayers] = useState(false)

// in BetweenRoundsView host section:
{isHost && (
  <button onClick={() => setShowManagePlayers(true)} className="text-sm underline text-gray-500">
    Manage Players
  </button>
)}

// modal:
{showManagePlayers && currentPlayerId && (
  <ManagePlayersModal
    joinCode={joinCode}
    players={game.players}
    hostPlayerId={currentPlayerId}
    onClose={() => setShowManagePlayers(false)}
  />
)}
```

**Also update game screen player-count logic** — any check that iterates `game.players` to determine team sizes or active player counts should filter by `p.active`.

### Success Criteria

#### Automated Verification

- [ ] TypeScript compiles: `pnpm --filter client build`
- [ ] All tests pass: `pnpm test`

#### Manual Verification

- [ ] Lobby: host sees "Manage Players" button; non-host does not
- [ ] Lobby player columns show only active players; kicked player's row disappears from the columns and reappears greyed-out inside the modal
- [ ] Game can still be started after a lobby kick (validation uses active players only)
- [ ] Active game (between-rounds): host sees "Manage Players" button alongside "Start Round N"
- [ ] Active game (waiting/spectating): host can access "Manage Players"; non-host cannot
- [ ] Kicking a non-active-clue-giver mid-game: current turn continues uninterrupted, kicked player's row updates for all clients
- [ ] Kicking the active clue giver mid-game: turn advances to the other team
- [ ] Kicking the last active player from a team during an active game: all clients navigate to the finished screen
- [ ] Kicked player on another device sees their `active` status change in the SSE-delivered player list (their own entry shows `active: false`)

---

## Testing Strategy

### Unit Tests (`InMemoryGameStore.test.ts`)

Use the existing `setupReadyGame` / `setupStartedGame` helpers.

- Non-host caller → `FORBIDDEN`
- Self-kick → `FORBIDDEN`
- Unknown `targetPlayerId` → `NOT_FOUND`
- Lobby kick: `game.players` still contains the player; player has `active: false`; `stats.clueGiverCount` unchanged
- Active game: kick non-clue-giver → `game.currentClueGiverId` unchanged, turn continues
- Active game: kick clue giver (turnPhase `'ready'`) → new clue giver is on the other team
- Active game: kick clue giver (turnPhase `'active'`) → same; turn state cleared
- 0-active-player guard: kick the last active player on team 2 during `'in_progress'` → `game.status === 'finished'`
- 0-active-player guard during `'between_rounds'` → same
- Rotation after kick: kick a player who hasn't had their turn yet → next `assignNextClueGiver` call on their team skips them

### Integration Tests (`games.test.ts`)

- `DELETE /:joinCode/players/:id` with valid host → 200, player in response has `active: false`
- Non-host → 403
- Self-kick → 403
- Unknown player → 404
- Missing `playerId` body → 400

### Manual Testing Steps

1. Start a local game with 4+ players (use the zombie script).
2. Kick a lobby player — verify the lobby columns update for all clients.
3. Start the game, kick a non-active player — verify the current turn continues.
4. Kick the current clue giver — verify the turn advances to the other team.
5. Reduce a team to 0 active players — verify the finished screen appears for all clients.
6. Send a `DELETE` request as a non-host — verify HTTP 403.
7. Check the stats page after a game with a kick — verify the kicked player's clue count is included in best-clue-giver calculation if applicable.

---

## References

- Original work item: `meta/work/ENG-024-host-kick-players-from-lobby-and-game.md`
- Prerequisite plan: `meta/plans/2026-05-20-REFACTOR-001-player-roster-object.md`
- Store implementation: `server/src/store/InMemoryGameStore.ts`
- Route layer: `server/src/routes/games.ts`
- Lobby screen: `client/src/pages/LobbyPage.tsx`
- Game screen: `client/src/pages/GamePage.tsx`
- Overlay pattern: `GamePage.tsx:417` (`RoundSplashOverlay`)
