# ENG-015: Configurable Game Settings

## Goal
Allow the host to configure words-per-player and round timer duration before the game starts. All players see the current config (read-only) in the lobby; only the host can edit it. Once the game begins the config is locked and applied for the whole game.

## Key Flows

### Shared types (`shared/src/types.ts`)
- Add a `GameSettings` type: `{ wordsPerPlayer: number; turnDurationSeconds: number }`
- Add `settings: GameSettings` to the `Game` type — always present (populated at game creation with defaults)
- The existing `WORDS_PER_PLAYER` and `TURN_DURATION_SECONDS` constants remain as the canonical defaults; `GameSettings` defaults are derived from them

### Server config (`server/src/config.ts`)
- Extend `GameConfig` to include `turnDurationSeconds: number`, seeded from `TURN_DURATION_SECONDS`
- Update `DEFAULT_GAME_CONFIG` accordingly

### New endpoint: `PATCH /api/games/:joinCode/settings`
- Body: `{ playerId: string; wordsPerPlayer?: number; turnDurationSeconds?: number }`
- Rejects with `403` if `playerId !== game.hostId`
- Rejects with `409` if `game.status !== 'lobby'` (config locked once game starts)
- Validates `wordsPerPlayer` is an integer between 1 and 20 (inclusive); returns `400` with a descriptive error if not
- Validates `turnDurationSeconds` is an integer between 5 and 600 (inclusive); returns `400` with a descriptive error if not
- Merges valid fields into `game.settings` (partial update — only provided fields change)
- Broadcasts updated game state via SSE so all clients see the change immediately

### Store (`InMemoryGameStore`)
- Populate `game.settings` at game creation using the server `GameConfig` defaults
- Add `updateSettings(joinCode, partial)` method (or similar) used by the route

### Client: Lobby config panel (all players)
- Rendered below the "Add Words" button for every connected player
- Appears as a visually distinct section labelled "Game Settings" (or similar), fitting the existing card/rounded-panel design language
- Displays two values: **Words per player** and **Round timer**
- **Host view** — two labelled number inputs, pre-filled with the current `game.settings` values (which start as the shared-constant defaults):
  - Words per player: `<input type="number" min="1" max="20">`; invalid if empty or outside 1–20
  - Round timer: `<input type="number" min="5" max="600">`; invalid if empty or outside 5–600; display in seconds (e.g. "60 s")
  - On blur / onChange (debounced or on blur), call `PATCH .../settings` with the new value; show inline validation error on invalid input without calling the API
  - While a field is invalid the "Start Game" button remains disabled (in addition to existing guards)
- **Non-host view** — same section, same labels, but rendered as static text (not inputs); updates in real time as the host changes values via SSE

### Client: downstream consumers of the constants
- `LobbyPage` currently reads `WORDS_PER_PLAYER` directly to gate start and show word-count progress; update these to read from `game.settings.wordsPerPlayer` instead
- `GamePage` currently reads `TURN_DURATION_SECONDS` directly for the countdown timer and end-turn trigger; update to read from `game.settings.turnDurationSeconds` instead
- The shared constants themselves are not removed — they remain as default seeds

## User Verification
- A freshly created game lobby shows the default values (3 words, 45 s) pre-filled in the host's inputs and in the read-only panel for other players
- Host changes "Words per player" to 5; all other connected devices update to show "5" immediately without refresh
- Entering 0 or 21 into either host input shows a validation error and disables "Start Game"
- Clearing an input shows a validation error and disables "Start Game"; restoring a valid value re-enables the button (assuming all other guards pass)
- Non-host players cannot interact with the settings fields (inputs are not rendered for them)
- After the game starts, the configured values are in effect: word-submission gate uses the configured words-per-player, and the round timer counts down from the configured duration
- Attempting `PATCH .../settings` after the game has started returns `409`
