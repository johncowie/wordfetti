# ENG-010: Game State Model for Round 1 & Game Page Routing

## Goal
Starting the game initialises the Round 1 hat and turn state; all players are automatically navigated from the lobby to a role-aware game page.

## Key Flows
- Extend the `Game` type in `shared/src/types.ts`: add `hat: string[]`, `activeTeam: 1|2`, `currentClueGiverId: string`, `turnPhase: 'ready' | 'active'`, `scores: { team1: number, team2: number }` — all optional so existing lobby state stays valid
- Update `startGame` in `InMemoryGameStore`: collect each player's submitted words from the `words` map, shuffle them into `hat`, pick `activeTeam` randomly (1 or 2), set `currentClueGiverId` to the first player on that team (by join order), set `turnPhase: 'ready'`, initialise `scores: { team1: 0, team2: 0 }`
- `LobbyPage`: when the SSE stream delivers a game with `status === 'in_progress'`, navigate to `/game/:joinCode`
- New `GamePage` at route `/game/:joinCode`: reads `currentClueGiverId` from game state and determines the current player's role:
  - **Clue giver** (currentClueGiverId === currentPlayerId): shows "You are describing!" and a disabled "Start Turn" button (made functional in ENG-011)
  - **Guesser** (same team as clue giver, not the clue giver): shows "Get ready to guess — [clue giver name] is about to describe!"
  - **Spectator** (other team): shows "Watch closely — [clue giver name] is describing for [Team N]!"
  - **Observer** (no session / not in game): shows the spectator view

## User Verification
- Start a game with 4 players across two devices → all devices automatically navigate away from the lobby to the game page
- The first clue giver's device shows "You are describing!" with a "Start Turn" button
- A teammate's device shows the guesser view with the clue giver's name
- The opposing team's device shows the spectator view
