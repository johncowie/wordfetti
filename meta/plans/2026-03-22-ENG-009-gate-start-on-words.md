# ENG-009: Gate Game Start on Word Submission — Implementation Plan

## Overview

Add a second gate on the Start button and the `/start` route: every player must
have submitted `WORDS_PER_PLAYER` words before the game can begin. The UI
updates in real time via the existing SSE stream.

## Current State Analysis

- `POST /:joinCode/start` (`server/src/routes/games.ts:92-115`) already has one
  validation guard (team size ≥ 2 per team). `WORDS_PER_PLAYER` is already
  imported at line 3 of that file.
- `LobbyPage` (`client/src/pages/LobbyPage.tsx`) already imports
  `WORDS_PER_PLAYER` (line 3) and computes `needsMorePlayers` at line 99. The
  Start button's `disabled` prop is currently `needsMorePlayers` only (line 169).
- Per-player `wordCount` display and `done` indicator already exist from ENG-008
  (`PlayerRow` at `LobbyPage.tsx:248-264`).
- SSE stream fully replaces `game` state on every change, so no additional
  subscription work is needed.
- The "200 valid" test fixture (`baseGame`, `games.test.ts:181-192`) currently
  has all players at `wordCount: 0` — it must be updated to satisfy the new
  word-count guard.

## Desired End State

- `POST /start` returns `422 { error: 'All players must submit their words
  before the game can start' }` when any player has `wordCount < WORDS_PER_PLAYER`.
- Start button is disabled and a hint shows "Waiting for N players to finish
  submitting words" while any player is pending.
- As each player submits their final word the hint count decrements live; when
  the last player finishes the button enables immediately.
- A game with all words submitted starts normally.

## What We're NOT Doing

- No changes to SSE or the store — word-count propagation already works.
- No changes to the non-host "Waiting for more players" message at line 184-188.
- No new UI components — the existing `PlayerRow` done indicators are
  sufficient per the ticket.

---

## Phase 1: Backend — Add Word-Count Validation to `/start`

### Changes Required

#### 1. Route handler

**File**: `server/src/routes/games.ts`

After the team-size 422 check (currently lines 104-108), add:

```ts
const allWordsSubmitted = game.players.every((p) => p.wordCount >= WORDS_PER_PLAYER)
if (!allWordsSubmitted)
  return res.status(422).json({ error: 'All players must submit their words before the game can start' })
```

`WORDS_PER_PLAYER` is already imported — no import change needed.

#### 2. Route tests

**File**: `server/src/routes/games.test.ts`

a. **Update `baseGame` fixture** (line 186-189) — change all four players from
   `wordCount: 0` to `wordCount: 5` so the existing "returns 200" success test
   still passes after the new validation:

```ts
{ id: hostId, name: 'Alice', team: 1 as const, wordCount: 5 },
{ id: 'p2',   name: 'Bob',   team: 1 as const, wordCount: 5 },
{ id: 'p3',   name: 'Carol', team: 2 as const, wordCount: 5 },
{ id: 'p4',   name: 'Dave',  team: 2 as const, wordCount: 5 },
```

b. **Add a new test** after the existing 422 team-size test (line 229):

```ts
it('returns 422 when not all players have submitted their words', async () => {
  const pendingGame = {
    ...baseGame,
    players: [
      { id: hostId, name: 'Alice', team: 1 as const, wordCount: 5 },
      { id: 'p2',   name: 'Bob',   team: 1 as const, wordCount: 3 },
      { id: 'p3',   name: 'Carol', team: 2 as const, wordCount: 5 },
      { id: 'p4',   name: 'Dave',  team: 2 as const, wordCount: 5 },
    ],
  }
  const store = mockStore({ getGameByJoinCode: async () => pendingGame })
  const res = await request(buildApp(store))
    .post('/ABC123/start')
    .send({ playerId: hostId })
  expect(res.status).toBe(422)
  expect(res.body.error).toMatch(/submit their words/)
})
```

### Success Criteria

#### Automated Verification

- [x] Tests pass: `cd server && pnpm test`
- [x] TypeScript compiles: `cd server && pnpm tsc --noEmit`

#### Manual Verification

- [ ] `curl -s -X POST http://localhost:3000/api/games/<joinCode>/start -H 'Content-Type: application/json' -d '{"playerId":"<hostId>"}'` returns `422` with the appropriate message when not all words are submitted

---

## Phase 2: Frontend — Disable Start Button and Show Pending Hint

### Changes Required

**File**: `client/src/pages/LobbyPage.tsx`

#### 1. Compute `allWordsSubmitted` and `pendingCount` alongside existing derived values (line 99)

```ts
const allWordsSubmitted = game.players.every((p) => p.wordCount >= WORDS_PER_PLAYER)
const pendingCount = game.players.filter((p) => p.wordCount < WORDS_PER_PLAYER).length
```

#### 2. Extend the Start button's disabled condition (line 169)

```tsx
disabled={needsMorePlayers || !allWordsSubmitted}
```

#### 3. Replace the existing `needsMorePlayers`-only hint block (lines 174-178) with a two-case hint

When enough players are present but words are still pending, show the word hint
instead of (or after) the player hint:

```tsx
{needsMorePlayers && (
  <p className="text-center text-sm text-gray-400">
    Both teams need at least 2 players to start
  </p>
)}
{!needsMorePlayers && !allWordsSubmitted && (
  <p className="text-center text-sm text-gray-400">
    Waiting for {pendingCount} {pendingCount === 1 ? 'player' : 'players'} to finish submitting words
  </p>
)}
```

### Success Criteria

#### Automated Verification

- [x] TypeScript compiles: `cd client && pnpm tsc --noEmit`
- [ ] Lint passes: `cd client && pnpm lint`

#### Manual Verification

- [ ] With all players present but not all words submitted → Start button is disabled; hint shows correct pending count
- [ ] As each player finishes, the count in the hint decrements in real time (via SSE)
- [ ] When the last player submits their final word → Start button becomes enabled immediately (no page refresh)
- [ ] When all words are submitted and teams are valid → Start button is enabled and starts the game normally
- [ ] Non-host players do not see the hint (the host block is `currentPlayerId === game.hostId`)

---

## Testing Strategy

### Backend

- Existing 404, 403 (×2), and 200 tests continue to pass unchanged (after updating `baseGame` wordCounts).
- Existing 422 team-size test still fires correctly — team-size check runs before word-count check.
- New 422 test covers the word-count path specifically, with one player at `wordCount: 3`.

### Frontend

- All logic is derived from `game.players` which is fully replaced on every SSE event — no extra wiring needed.

## References

- Ticket: `meta/tickets/ENG-009-gate-start-on-words.md`
- Route handler: `server/src/routes/games.ts:92`
- Route tests: `server/src/routes/games.test.ts:179`
- LobbyPage: `client/src/pages/LobbyPage.tsx:97-99`, `165-183`
- Shared constants: `shared/src/types.ts:3`
