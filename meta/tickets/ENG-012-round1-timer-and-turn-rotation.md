# ENG-012: Round 1 — Turn Timer and Turn Rotation

## Goal
Each turn is capped at 60 seconds; when time runs out the turn passes to the other team's next clue giver, who must press "Ready" before their turn begins.

## Key Flows
- Add `turnStartedAt: string | null` (ISO timestamp) to the `Game` type; set it when `POST /ready` transitions `turnPhase` to `'active'`
- Add `POST /:joinCode/end-turn` — body `{ playerId }`; validates caller is the current clue giver; returns `currentWord` (if any) to `hat`, clears `skippedThisTurn`, rotates `activeTeam` to the other team and advances `currentClueGiverId` to the next player on that team (cycling by join order), sets `turnPhase: 'ready'`, clears `currentWord` and `turnStartedAt`; if `hat` is empty after returning the word, sets `status: 'round_over'` instead; broadcasts; add route-level tests (success + error cases)
- Client-side countdown: when `turnPhase === 'active'` and `turnStartedAt` is present, derive remaining seconds as `60 - elapsed`; display a countdown on the clue giver's screen; when it reaches 0, automatically call `POST /end-turn`
- **Between-turns view** (`turnPhase === 'ready'`, after first turn):
  - Next clue giver's device: "It's your turn — press Ready to start" + "Ready" button (calls `POST /ready`)
  - All other devices: "Waiting for [name] to start their turn..."
- Round-over detection: if hat is empty when `POST /end-turn` is called, transition to `status: 'round_over'` and show the score summary (same view from ENG-011)

## User Verification
- During an active turn, clue giver's screen shows a counting-down timer
- When the timer hits 0, the turn ends automatically; the next team's clue giver sees "It's your turn — press Ready"
- Other players see the waiting message with the upcoming clue giver's name
- Next clue giver presses "Ready" → their turn starts with a fresh 60-second timer
- Play until the hat empties at a turn boundary → all devices show the round score summary
