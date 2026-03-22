# ENG-011: Round 1 — Guess, Skip, and Round End

## Goal
The clue giver can work through words — marking them as guessed or skipping them — and when the hat empties all players see a round score summary.

## Key Flows
- `POST /:joinCode/ready` — body `{ playerId }`; validates caller is the current clue giver and `turnPhase === 'ready'`; sets `turnPhase: 'active'` and `currentWord` to the first word drawn from `hat`; broadcasts; returns `422` if turn already active or game not `in_progress`
- `POST /:joinCode/guess` — body `{ playerId }`; validates caller is current clue giver and `turnPhase === 'active'`; removes `currentWord` from `hat`, increments `scores[activeTeam]`, draws next word into `currentWord`; if hat is now empty, sets `status: 'round_over'` and `currentWord: null`; broadcasts; returns `422` if not active
- `POST /:joinCode/skip` — body `{ playerId }`; validates caller is current clue giver and `turnPhase === 'active'`; appends `currentWord` to a `skippedThisTurn: string[]` field on game state; draws next word that is not in `skippedThisTurn`; if no non-skipped words remain, falls back to a skipped word; if hat is fully empty, ends round; broadcasts; returns `422` if not active
- Add route-level tests for all three endpoints (success + each error case)
- **Clue giver view** (`turnPhase === 'active'`): shows `currentWord` prominently + "Guessed!" button + "Skip" button
- **Clue giver view** (`turnPhase === 'ready'`): "Start Turn" button (calls `POST /ready`)
- **Guesser view** (same team, not clue giver): "Your team is guessing — [name] is describing!"
- **Spectator view** (other team): list of words guessed this turn (incrementing live) + both team scores
- **Round over view** (`status === 'round_over'`): score summary card showing Team 1 and Team 2 scores, shown to all players

## User Verification
- Clue giver presses "Start Turn" → sees first word; teammates see guesser view; other team sees spectator view
- "Guessed!" → score increments on all screens in real time via SSE; next word appears for clue giver
- "Skip" → new word appears immediately; the skipped word does not reappear while other words remain
- Keep guessing until hat empties → all devices simultaneously show the round score summary
