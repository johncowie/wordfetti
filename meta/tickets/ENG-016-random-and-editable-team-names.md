# ENG-016: Random and Editable Team Names

## Goal
Replace the hardcoded "Team 1" / "Team 2" labels with randomly selected names drawn from a static word file at game creation time. The host can rename either team from the lobby; all other players see the name change instantly via SSE but cannot edit it themselves.

## Key Flows

### Static asset (`server/assets/team-names.txt`)
- Create `server/assets/team-names.txt` — a newline-separated list of potential team names (e.g. "The Dolphins", "Red Dragons", "Cosmic Foxes", etc.)
- The file is the only place names need to be maintained; aim for a meaningful starter set (30–50 names)
- When parsing: trim each line, skip blank lines silently; do not crash on whitespace-only entries
- On server startup, load this file once and hold the list in memory
- If the file is missing or unreadable at startup, fall back silently to `["Team 1", "Team 2"]` — log a warning, do not crash

### Shared types (`shared/src/types.ts`)
- Add `teamNames: { team1: string; team2: string }` to the `Game` type — always present

### Server: name loading utility (`server/src/assets.ts` or similar)
- Export a `loadTeamNames(): string[]` function that reads `server/assets/team-names.txt` synchronously at startup relative to `import.meta.url` (i.e. `../../assets/team-names.txt` from within `dist/`)
- Returns the parsed list, or `["Team 1", "Team 2"]` on any error
- Export a `pickTeamNames(pool: string[]): { team1: string; team2: string }` helper that picks two distinct names at random; falls back to `"Team 1"` / `"Team 2"` if the pool has fewer than two distinct entries

### Store (`InMemoryGameStore`)
- Accept the loaded `teamNames` pool via the constructor (or as a module-level singleton passed in alongside `GameConfig`) so it can be injected in tests
- In `createGame()`, call `pickTeamNames(pool)` and set `game.teamNames` on the new `InternalGame`
- Add `updateTeamName(joinCode, playerId, team: 1 | 2, name: string): Promise<Game>` method:
  - Throws `NOT_FOUND` if game missing
  - Throws `FORBIDDEN` if `playerId !== game.hostId`
  - Throws `INVALID_STATE` if `game.status !== 'lobby'`
  - Throws `CONFLICT` (400) if the new name (trimmed) matches the other team's current name (case-insensitive)
  - Throws `VALIDATION` (400) if `name.trim()` is empty or longer than 20 characters
  - Applies the change and broadcasts the updated snapshot to all SSE subscribers

### New endpoint: `PATCH /api/games/:joinCode/team-name`
- Body: `{ playerId: string; team: 1 | 2; name: string }`
- Delegates entirely to `store.updateTeamName()`; error codes map to HTTP status as with existing routes
- Returns the full updated `Game` snapshot

### Client: Lobby team name display (all players)
- Wherever each team's name/header is rendered in the lobby, display `game.teamNames.team1` / `game.teamNames.team2` instead of any hardcoded strings
- **Host view only** — render a small inline edit icon (pencil) next to each team name; clicking it replaces the label with a text input pre-filled with the current name:
  - `maxLength={20}`
  - On blur or Enter: trim and submit via `PATCH .../team-name`; on Escape: cancel and restore the label without calling the API
  - While the input is open, show a simple inline validation message if the trimmed value is empty, exceeds 20 chars, or matches the other team's name (case-insensitive) — do not call the API in these cases
  - After a successful API response, close the input and display the new name (the SSE event will also propagate the change but the local update from the response is fine)
- **Non-host view** — team name is read-only text; it updates in real time as the host renames via the incoming SSE game state

### Dockerfile
- `pnpm deploy` copies the whole package directory (including `server/assets/`) into the deploy artifact, so the runtime image should receive the file automatically via the existing `COPY --from=build /app/deploy ./server` line
- Verify this holds after implementation; if `server/assets/team-names.txt` is absent in the final image, add an explicit layer:
  ```dockerfile
  COPY --from=build /app/server/assets ./server/assets
  ```
  Place it after the existing `COPY --from=build /app/deploy ./server` line in the `runtime` stage

## User Verification
- A freshly created game lobby shows two randomly chosen, distinct team names (not "Team 1" / "Team 2") for all players
- Refreshing or creating a new game picks different names each time (within normal randomness)
- Host clicks the pencil icon next to a team name, types a new name, and presses Enter → the name updates for all connected devices without refresh
- Host cannot save a name longer than 20 characters (input is capped) or one that matches the other team's name (inline error shown)
- A non-host player sees no edit icon and cannot interact with the team name label
- Players who are already assigned to a team when the host renames it see the new name immediately; their team assignment and word submissions are unaffected
- Attempting `PATCH .../team-name` as a non-host returns `403`; attempting it after the game has started returns `409`
