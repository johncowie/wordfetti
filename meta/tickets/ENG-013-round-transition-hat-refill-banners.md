# ENG-013: Round 1→2 Transition — State Model, Hat Refill & Round Banners

## Goal
When round 1 ends the host can advance to round 2; the hat refills with the original words, clue giver rotation carries over, and all players see a round-start splash with the new rule. The clue giver view also gains a round-specific banner so every round's constraint is front and centre.

## Key Flows
- Extend `Game` type in `shared/src/types.ts`: add `round: 1 | 2` (extended to 3 in ENG-014), `originalWords: string[]`; add `'between_rounds'` to the `status` union
- When `POST /end-turn` empties the hat and `round === 1`, transition to `status: 'between_rounds'` (instead of `'round_over'`); broadcast; store remains unchanged otherwise
- Add `POST /:joinCode/advance-round` — body `{ playerId }`, validated as host; refills `hat` by shuffling `originalWords`, increments `round` to 2, sets `status: 'in_progress'`, sets `turnPhase: 'ready'` (clue giver rotation is unchanged — pick up from wherever it left off); broadcasts; add route-level tests (success + auth error)
- **Between-rounds view** (all clients when `status === 'between_rounds'`):
  - Host device: "Round 1 is over! Press to start Round 2" + "Start Round 2" button (calls `POST /advance-round`)
  - All other devices: "Round 1 is over — waiting for the host to start Round 2..."
- **Round-start splash**: when a client receives an SSE update that transitions from `between_rounds` → `in_progress`, briefly show a full-screen splash (2–3 seconds, or tap to dismiss) with the round number and its rule before showing the normal game view:
  - Round 2: "Round 2 — One word only!"
- **Round banner on clue giver view**: add a small persistent banner below the word showing the active round's rule:
  - Round 1: "Describe using anything — charades style!"
  - Round 2: "One word only!"

## User Verification
- Play until the hat empties at end of round 1 → all devices show the between-rounds screen; host sees "Start Round 2" button, others see the waiting message
- Host presses "Start Round 2" → all devices show the round 2 splash briefly, then the game view
- The clue giver's screen shows the "One word only!" banner during round 2 turns
- Scores from round 1 remain visible/correct going into round 2
- A non-host player pressing "Start Round 2" is rejected
