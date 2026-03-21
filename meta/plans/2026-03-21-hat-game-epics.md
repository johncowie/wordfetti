# Wordfetti: Hat Game — High-Level Project Plan

## Overview

Wordfetti is a web app that replaces paper slips in the Hat Game. Players use their own devices to submit words and take on roles (clue giver, guesser, spectator) across a multi-round party game.

---

## What We're NOT Doing (initial scope)

- No user accounts or persistent profiles
- No game history or statistics
- No customisable rules (fixed 3-round format, hardcoded timer, hardcoded word count per player)
- No spectator-only audience beyond the two teams
- No custom team names (teams are "Team 1" and "Team 2")
- No joining a game that has already started
- No starting a game before all players have submitted their required words

---

## Epics

### Epic 1 (MVP): Game Lobby & Player Registration

**Goal**: A host creates a game and all players can join from their own devices, pick a team, and see who else is in the lobby.

**Key flows:**
- Host creates a new game and receives a short join code; the host is a regular player in one of the teams
- Players navigate to the site, enter the join code + their name + their team (player names do not need to be unique)
- Lobby screen shows all joined players grouped by team, with a word submission count per player
- Start button is blocked until both teams have at least 2 players
- Once the game starts, it is closed to new joiners

**User verification:**
- Open the app on multiple devices; each person enters the code, name, and team
- All players are listed on every device's lobby screen in real time, grouped by team
- Confirm the start button is disabled with fewer than 2 players on either team

---

### Epic 2 (MVP): Word Submission

**Goal**: Every player submits words/phrases to the shared hat before the game begins.

**Key flows:**
- After joining the lobby, each player sees a word-submission screen
- Each player submits a fixed number of words (hardcoded for MVP; structured to be made configurable later)
- Players can see only their own submitted words and edit/delete them before the game starts
- The lobby shows a per-player word submission count so everyone can see who is still pending (actual words are not visible to other players)
- Host can start the game only once every player has submitted the required number of words

**User verification:**
- Each player submits their words; the lobby shows all players as having submitted
- Host presses "Start Game" and the game transitions to round 1

---

### Epic 3 (MVP): Round 1 — Describe It

**Goal**: A full first round of the Hat Game can be played end-to-end, with each device showing the correct role view.

**Key flows:**
- The first team to go is chosen randomly; within that team, the first clue giver is the first player in join order, cycling through teammates on each subsequent turn
- **Clue giver's screen**: shows the current word; can mark it as guessed (→ draws next word automatically) or skip (word returns to hat immediately but will not reappear to this clue giver during the same turn unless no other words remain)
- **Guessers' screens** (rest of active team): show a neutral "your team is guessing" view (no word visible)
- **Spectators' screen** (other team): shows words guessed so far this turn and current team scores
- A countdown timer (hardcoded at 1 minute) runs per turn; when it expires, the current word returns to the hat unscored and the turn ends automatically
- After the timer expires, the next clue giver (other team, next in their join-order rotation) must press "Ready" before their turn begins
- Round ends when the hat is empty; a basic score summary is shown

**User verification:**
- Start the game on multiple devices; each device shows the correct role
- Play through until the hat is empty; verify scores update correctly after each guess
- Confirm turn-passing works when the timer expires and that the next clue giver must press "Ready"
- Confirm skipped words do not reappear to the same clue giver mid-turn (unless hat is otherwise empty)

---

### Epic 4: Rounds 2 & 3 — One Word & Mime

**Goal**: The same word list cycles through a second round (one word only) and a third round (mime/act), completing a full 3-round game.

**Key flows:**
- After round 1 ends, the host presses to advance to round 2; a splash screen shows the new round rules
- The hat is refilled with the same words; clue giver rotation continues from where round 1 left off
- The clue giver interface for round 2 shows the word but reminds them: one word only
- For round 3, same flow but the reminder is: mime/act, no words
- Scores accumulate across rounds

**User verification:**
- Play through all 3 rounds; confirm the hat refills each time and rotation carries over
- Confirm round-specific instruction is shown to the clue giver
- Confirm the host must press to advance between rounds
- Confirm cumulative scores update correctly across rounds

---

### Epic 5: Scoring & Results

**Goal**: A clear scoreboard after each round and a final results screen at game end.

**Key flows:**
- After each round, an interim scoreboard shows per-team scores for that round and cumulative totals
- After round 3, a final results screen declares the winner (a draw is a valid outcome — no tiebreaker)
- (Optional) ability to start a new game from the results screen

**User verification:**
- After completing all 3 rounds, the final screen clearly shows which team won (or declares a draw)
- Scores per round are visible and add up correctly to the cumulative total

---

### Epic 6 (Post-MVP): Polish & Robustness

**Goal**: Improve the experience for real-world play sessions.

**Includes:**
- Handling players disconnecting and reconnecting mid-game
- Mobile-optimised UI / large tap targets for party-room use
- Sound or visual cues for timer warnings, correct guesses, turn changes
- Host controls: remove a player, reassign teams, add more words mid-game
- Shareable game link (instead of manually typing a code)
- Configurable rounds: ability to add extra rounds or edit existing round constraints (e.g. change the clue-giving rule for each round)
- Configurable game settings: timer duration, words per player
- Custom team names

---

## MVP Definition

Epics 1–3 constitute the MVP: a group of people on separate devices can create a game, submit words, and play through a complete first round with correct role assignment, turn-passing, and scoring.

Epics 4–5 complete the full game experience. Epic 6 is post-MVP polish.
