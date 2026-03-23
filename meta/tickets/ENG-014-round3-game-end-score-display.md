# ENG-014: Round 3, Game End & Simple Score Display

## Goal
Extend the round transition pattern to cover round 3, and cap the game: when round 3 ends all players land on a simple game-over screen showing the final scores.

## Key Flows
- Extend `round` type in `shared/src/types.ts` from `1 | 2` to `1 | 2 | 3`; add `'finished'` to the `status` union
- Update `POST /end-turn`: when hat empties and `round === 2`, transition to `'between_rounds'` (same as round 1→2); when hat empties and `round === 3`, transition to `status: 'finished'` instead; broadcast
- Update `POST /advance-round`: when called from round 2, refills hat, sets `round: 3`, sets `status: 'in_progress'`; rejects if `round` is already 3 (no round 4)
- **Round-start splash** for round 3: "Round 3 — Mime! No words or sounds!"
- **Round banner** for round 3 clue giver view: "Mime — no words or sounds!"
- **Game-over screen** (all clients when `status === 'finished'`): navigate to `/game/:joinCode/results`; display team 1 and team 2 cumulative scores from `game.scores`; declare the higher-scoring team the winner, or "It's a draw!" if equal; no per-round breakdown (that's Epic 5)

## User Verification
- After round 2 ends, host sees "Start Round 3"; pressing it shows the mime splash and game continues
- Round 3 clue giver sees "Mime — no words or sounds!" banner
- After round 3 hat empties, all devices navigate to the game-over screen
- Game-over screen shows the correct cumulative scores for both teams and names the winner (or declares a draw)
- Scores are the sum of all three rounds combined
