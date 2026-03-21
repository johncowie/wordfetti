# ENG-004: Start Game Gating

## Goal
The host cannot start the game until both teams have at least 2 players, and once started the game is closed to new joiners.

## Key Flows
- The lobby shows a "Start Game" button visible only to the host
- Button is disabled (with a clear explanation) if either team has fewer than 2 players
- Button becomes enabled only when both teams have ≥2 players
- Once the host starts the game, any subsequent attempt to join with the same code is rejected with a clear message

## User Verification
- In the lobby with 1 player per team → Start button is disabled
- Add a second player to each team → Start button becomes enabled
- Host starts the game → on another device, attempting to join with the same code shows a "game already in progress" error
