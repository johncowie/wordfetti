# ENG-014: Round 3, Game End & Simple Score Display — Implementation Plan

## Overview

Extend the existing round-transition pattern to cover a third round (mime, no words or sounds), then cap the game: when the hat empties in round 3 the game transitions to `'finished'` and all clients navigate to a results screen showing cumulative scores and a winner declaration.

## Current State Analysis

- `shared/src/types.ts`: `round` typed as `1 | 2`; `status` union already includes `'finished'` but no code ever sets it
- `InMemoryGameStore.ts` — `guessWord` and `endTurn` both have a `TODO(ENG-014)` noting that round 2 hat-empty currently emits `'round_over'` instead of `'between_rounds'`
- `advanceRound` hard-blocks on `round === 1` only; the `round === 2 → 3` path is completely missing
- Frontend `roundRuleText` typed as `(round: 1 | 2)` — will need extending
- `ClueGiverView` casts round as `1 | 2` in two places
- `BetweenRoundsView` renders "Start Round {round + 1}" — works for 2 → 3 naturally, but needs a `round === 3` guard after the type is widened (to avoid showing "Start Round 4" on stale/malformed state)
- No results/game-over screen exists; the `'finished'` status branch is absent from `GamePage`
- Router has no `/game/:joinCode/results` route

### Key Discoveries

- `guessWord` at `InMemoryGameStore.ts:291-308` is the real hat-emptying path; `endTurn`'s hat-empty branch is defensive/unreachable — both need the same fix
- Scores at `game.scores.team1 / team2` are cumulative across all rounds already; no reset logic to worry about
- `RoundSplashOverlay` is triggered by the `between_rounds → in_progress` status transition in `GamePage.tsx:44-57`; the same mechanism will automatically fire for round 3 once `advanceRound` is fixed
- `BetweenRoundsView` POSTs to `/api/games/${joinCode}/advance-round` — the route is reused for both 1→2 and 2→3
- The frontend already has a `navigate()` call pattern for status changes (e.g. redirecting to lobby on `lobby` status) — same pattern for `finished → /game/:joinCode/results`

## Desired End State

- After round 2 ends, host sees "Start Round 3"; pressing it shows the mime splash and the game continues
- Round 3 clue giver sees "Mime — no words or sounds!" in both the ready and active phases
- When round 3 hat empties, all devices navigate to `/game/:joinCode/results`
- Results page shows team 1 and team 2 cumulative scores and declares the winner (or "It's a draw!")

## What We're NOT Doing

- No per-round score breakdown (Epic 5)
- No "play again" / rematch button
- No persistent game storage; results are only visible while clients remain on the page
- No round 4 or beyond

---

## Phase 1: Types & Backend

### Overview

Extend the shared type, fix the hat-emptying round transitions, and unlock `advanceRound` for round 2 → 3.

### Changes Required

#### 1. Shared types — `shared/src/types.ts`

Extend `round` to `1 | 2 | 3`.

```typescript
// before
round?: 1 | 2

// after
round?: 1 | 2 | 3
```

`status` already includes `'finished'` — no change needed there. Also update the stale inline comment on the `round` field (currently reads `// extended to 3 in ENG-014`) to remove the forward-reference language after applying the change.

#### 2. Hat-emptying logic — `server/src/store/InMemoryGameStore.ts`

There are **two places** with the same ternary (once in `guessWord`, once in the defensive branch of `endTurn`). The existing TODO comment already suggests extracting a helper — do it now to eliminate the duplication and make the logic exhaustively typed:

```typescript
// Add as a private method on InMemoryGameStore (or module-level function):
private resolveRoundEndStatus(round: 1 | 2 | 3): Game['status'] {
  switch (round) {
    case 1: return 'between_rounds'
    case 2: return 'between_rounds'
    case 3: return 'finished'
  }
}

// Replace the ternary at both call sites (guessWord and endTurn) with:
const newStatus = this.resolveRoundEndStatus(game.round as 1 | 2 | 3)
```

The `switch` is exhaustive over `1 | 2 | 3` so TypeScript will catch any future round additions at compile time. The `as 1 | 2 | 3` cast is safe here because hat-emptying is only reachable while a round is in progress.

#### 3. `advanceRound` — `server/src/store/InMemoryGameStore.ts`

Remove the `round === 1` guard; allow round 1 → 2 and round 2 → 3; reject round 3. The `Object.assign` already collects all state mutations — include the round increment inside it to keep the mutation atomic:

```typescript
// Guard change: was round !== 1, now round === 3
if (game.round === 3) return { ok: false, error: 'INVALID_STATE' }

// Inside the existing Object.assign, replace the hardcoded round: 2 with:
Object.assign(game, {
  round: (game.round === 1 ? 2 : 3) as 1 | 2 | 3,
  status: 'in_progress',
  hat: shuffledHat,
  turnPhase: 'ready',
  currentClueGiverId: nextClueGiver.id,
  currentWord: undefined,
  currentWordId: undefined,
  turnStartedAt: undefined,
  guessedThisTurn: [],
  skippedThisTurn: [],
})
```

Note: the existing `advanceRound` test at `InMemoryGameStore.test.ts:763` — titled `'throws INVALID_STATE when round is already 2 (no round 3 in ENG-013)'` — asserts the opposite of the new behaviour and **must be deleted or rewritten** before implementing the guard change. It becomes the new round 2→3 happy-path test (item 3 below).

### Tests to Write First (failing, then implement)

**Before writing any new tests:** delete or rewrite the existing test at `InMemoryGameStore.test.ts:763` (`'throws INVALID_STATE when round is already 2 (no round 3 in ENG-013)'`). This test now asserts the wrong behaviour and will produce a confusing unexpected failure when the guard changes. It is superseded by test 3 below.

All in `InMemoryGameStore.test.ts`:

1. `guessWord` with `round = 2`, hat empties → `status === 'between_rounds'` (not `'round_over'`)
2. `guessWord` with `round = 3`, hat empties → `status === 'finished'`, `currentClueGiverId` / `turnPhase` / `currentWord` all cleared
3. `advanceRound` from between-rounds with `round = 2` → `status === 'in_progress'`, `round === 3`, hat refilled; capture scores at the between-rounds boundary and assert exact equality after advance (same pattern as existing test at `InMemoryGameStore.test.ts:833-848`)
4. `advanceRound` rejected when `round === 3` → `INVALID_STATE`
5. `endTurn` with hat force-emptied and `round = 3` → `status === 'finished'`, `currentClueGiverId` cleared (mirrors the existing pattern at `InMemoryGameStore.test.ts:706-726`)

And in `routes/games.test.ts`:

6. `POST /advance-round` with round-2 game → 200, round 3 + in_progress in response
7. `POST /advance-round` with round-3 game → 409 INVALID_STATE
8. `POST /guess` where guessing the last word with `round = 3` returns `status: 'finished'` and `scores` in the response body (mirrors the existing `round_over` pattern at `games.test.ts:559`)

### Success Criteria

#### Automated Verification
- [x] New tests written and failing before implementation: `cd server && npm test -- --testPathPattern=InMemoryGameStore`
- [x] All store + route tests pass after implementation: `cd server && npm test`
- [x] TypeScript compiles: `cd server && npm run build` and `cd shared && npm run build`

---

## Phase 2: Frontend Round 3 Support

### Overview

Update `roundRuleText`, remove the `1 | 2` type casts, and ensure the mime rule appears in all the right places. The splash overlay and between-rounds screen work automatically once the backend emits the right transitions.

### Changes Required

#### 1. `roundRuleText` helper — `client/src/pages/GamePage.tsx` (lines ~9-12)

```typescript
// before
export function roundRuleText(round: 1 | 2): string {
  if (round === 1) return 'Describe using anything — charades style!'
  return 'One word only!'
}

// after
function roundRuleText(round: 1 | 2 | 3): string {
  if (round === 1) return 'Describe using anything — charades style!'
  if (round === 2) return 'One word only!'
  return 'Mime — no words or sounds!'
}
```

#### 2. Remove casts in `ClueGiverView` — `GamePage.tsx` (~lines 235, 258)

Once `roundRuleText` accepts `1 | 2 | 3` and the shared `round` type is widened, TypeScript narrows `game.round` to `1 | 2 | 3` inside a truthy `&&` check. Remove the casts entirely:

```typescript
// before
roundRuleText(game.round as 1 | 2)

// after (two occurrences) — cast removed, truthy guard provides the narrowing
{game.round && (
  <p className="text-sm font-medium italic text-gray-500">
    {roundRuleText(game.round)}
  </p>
)}
```

#### 3. `RoundSplashOverlay` prop type and call site — `GamePage.tsx`

Update both the component signature **and** the call site at line ~129:

```typescript
// Component signature — before
function RoundSplashOverlay({ round, onDismiss }: { round: 1 | 2; ... })

// Component signature — after
function RoundSplashOverlay({ round, onDismiss }: { round: 1 | 2 | 3; ... })

// Call site (~line 129) — before
<RoundSplashOverlay round={game.round as 1 | 2} ... />

// Call site — after (cast removed; showRoundSplash is only set when game.round is defined)
<RoundSplashOverlay round={game.round!} ... />
```

#### 4. `BetweenRoundsView` prop type and guard — `GamePage.tsx`

Widen the prop type and add a defensive guard that prevents "Start Round 4" if the component ever receives `round === 3` due to stale or malformed state:

```typescript
// before
function BetweenRoundsView({ round, ... }: { round: 1 | 2; ... })

// after
function BetweenRoundsView({ round, ... }: { round: 1 | 2 | 3; ... }) {
  // round === 3 should never reach between_rounds (goes straight to finished),
  // but guard against stale/malformed state
  if (round === 3) {
    return <p className="text-2xl font-bold text-gray-900">Game over!</p>
  }
  // ... rest of component unchanged
}
```

The "Start Round {round + 1}" button text will correctly say "Start Round 3" for round 2.

### Success Criteria

#### Automated Verification
- [x] TypeScript compiles with no errors: `cd client && npm run build`

#### Manual Verification
- [ ] After round 2 ends, host sees "Start Round 3" button in the between-rounds screen
- [ ] Non-host sees "Waiting for the host to start Round 3..."
- [ ] Pressing "Start Round 3" shows the mime splash ("Mime — no words or sounds!")
- [ ] Clue giver sees "Mime — no words or sounds!" in both ready and active phases

---

## Phase 3: Results / Game-Over Screen

### Overview

Add a `/game/:joinCode/results` route and `ResultsPage` component. `GamePage` navigates there when `status === 'finished'`.

### Changes Required

#### 1. Navigate on `finished` — `client/src/pages/GamePage.tsx`

In the existing `useEffect` that watches `game.status` (lines ~38-42), add a `finished` branch. Pass the game state through `navigate` so `ResultsPage` can render immediately without a second fetch:

```typescript
if (game.status === 'finished') {
  navigate(`/game/${joinCode}/results`, { state: { game } })
  return
}
```

#### 2. New `ResultsPage` — `client/src/pages/ResultsPage.tsx`

Uses a **named export** (matching every other page in the project). Reads game state from `navigate` state first (set in step 1) to avoid a round-trip; falls back to a plain one-shot `fetch` for direct URL visits. Does **not** use `useGameState` — the game is finished and no live SSE updates will ever arrive.

Includes a `status` guard (redirects to the game page if the game is not yet finished), focus management on mount (matching existing splash/overlay patterns), and `aria-label` attributes on score values:

```typescript
import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { Game } from '../../../shared/src/types'

export function ResultsPage() {
  const { joinCode } = useParams<{ joinCode: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const [game, setGame] = useState<Game | null>(
    (location.state as { game?: Game } | null)?.game ?? null
  )
  const [error, setError] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  // One-shot fetch fallback for direct URL hits
  useEffect(() => {
    if (game || !joinCode) return
    const controller = new AbortController()
    fetch(`/api/games/${joinCode}`, { signal: controller.signal })
      .then((res) => { if (!res.ok) throw new Error(`${res.status}`); return res.json() as Promise<Game> })
      .then(setGame)
      .catch((err) => { if (err.name === 'AbortError') return; setError('Could not load results.') })
    return () => controller.abort()
  }, [joinCode, game])

  // Guard: redirect if the game is not finished (e.g. direct URL hit mid-game)
  useEffect(() => {
    if (game && game.status !== 'finished') {
      navigate(`/game/${joinCode}`)
    }
  }, [game, joinCode, navigate])

  // Move focus to the heading on mount so screen readers announce the result
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  if (error) return <p className="text-red-600 text-center mt-8">{error}</p>
  if (!game || !game.scores) return <p className="text-center mt-8">Loading results...</p>

  const { team1, team2 } = game.scores
  const winner =
    team1 > team2 ? 'Team 1 wins!'
    : team2 > team1 ? 'Team 2 wins!'
    : "It's a draw!"

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-4">
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="text-3xl font-bold text-gray-900 outline-none"
      >
        Game Over!
      </h1>
      <p className="text-2xl font-semibold text-brand-coral">{winner}</p>
      <div className="flex gap-12">
        <div className="text-center">
          <p className="text-sm font-medium text-gray-500 uppercase">Team 1</p>
          <p aria-label={`Team 1 score: ${team1}`} className="text-5xl font-bold text-gray-900">{team1}</p>
        </div>
        <div className="text-center">
          <p className="text-sm font-medium text-gray-500 uppercase">Team 2</p>
          <p aria-label={`Team 2 score: ${team2}`} className="text-5xl font-bold text-gray-900">{team2}</p>
        </div>
      </div>
    </main>
  )
}
```

#### 3. Register route — `client/src/main.tsx`

```typescript
// Add below the /game/:joinCode route:
<Route path="/game/:joinCode/results" element={<ResultsPage />} />
```

Add the import at the top of the file (named import, matching all other pages):
```typescript
import { ResultsPage } from './pages/ResultsPage'
```

### Success Criteria

#### Automated Verification
- [x] TypeScript compiles: `cd client && npm run build`

#### Manual Verification
- [ ] After round 3 hat empties, all connected devices navigate to `/game/:joinCode/results`
- [ ] Results page shows correct cumulative totals for both teams (sum of all 3 rounds)
- [ ] The higher-scoring team is named winner; equal scores show "It's a draw!"
- [ ] Navigating directly to `/game/:joinCode/results` on a finished game shows correct scores
- [ ] Refreshing `/game/:joinCode` after the game ends redirects to the results page
- [ ] Navigating directly to `/game/:joinCode/results` while the game is still in progress redirects back to `/game/:joinCode`

---

## Phase 4: Remove Dead `round_over` Code

### Overview

Now that all rounds transition to either `between_rounds` or `finished`, `round_over` is unreachable. Remove it entirely rather than leaving zombie code.

### Changes Required

#### 1. `shared/src/types.ts`

```typescript
// before
status: 'lobby' | 'in_progress' | 'round_over' | 'between_rounds' | 'finished'

// after
status: 'lobby' | 'in_progress' | 'between_rounds' | 'finished'
```

#### 2. `client/src/pages/GamePage.tsx`

Delete the `RoundOverView` component (currently lines ~336-352) and its render branch (currently lines ~96-108):

```typescript
// Delete the render branch:
if (game.status === 'round_over') {
  return <RoundOverView ... />
}

// Delete the RoundOverView component definition entirely
```

#### 3. Test cleanup

- `InMemoryGameStore.test.ts:717-725` — the test `'transitions to round_over when round is 2'` is superseded by test 1 from Phase 1 (`guessWord` round 2 → `between_rounds`). Delete it (don't leave it alongside the new test).
- `routes/games.test.ts` — remove any assertion that checks for `round_over` in a response body (the route test for the `endTurn`/`guessWord` path that currently asserts `status: 'round_over'`).

### Success Criteria

#### Automated Verification
- [x] TypeScript compiles with no errors after removing `'round_over'` from the union: `cd shared && npm run build && cd ../server && npm run build && cd ../client && npm run build`
- [x] All tests pass: `cd server && npm test`

---

## Testing Strategy

### Unit/Integration Tests (backend)

**First:** delete/rewrite `InMemoryGameStore.test.ts:763` (the stale ENG-013 round-2 guard test).

Write in this order (failing first, then implement):

1. `guessWord` round 2 hat-empty → `between_rounds`
2. `guessWord` round 3 hat-empty → `finished`, state cleared
3. `endTurn` with hat force-emptied, `round = 3` → `status === 'finished'` (mirrors pattern at lines 706-726)
4. `advanceRound` round 2 → round 3: hat refilled, scores preserved (capture and assert exact score equality), `status: 'in_progress'`
5. `advanceRound` round 3 → `INVALID_STATE`
6. Route: `POST /advance-round` round-2 game → 200 + round 3 response
7. Route: `POST /advance-round` round-3 game → 409
8. Route: `POST /guess` last word with `round = 3` → response includes `status: 'finished'` and `scores`

### Manual Testing Steps

1. Start a game, complete round 1 (guess all words) → between-rounds screen appears
2. Host presses "Start Round 2" → round 2 splash, game continues
3. Complete round 2 → between-rounds screen appears with "Start Round 3"
4. Host presses "Start Round 3" → mime splash appears → game continues
5. Complete round 3 → all devices navigate to results page
6. Verify scores match the total guessed across all 3 rounds
7. Refresh `/game/:joinCode` after game ends → redirects to results page
8. Navigate directly to `/game/:joinCode/results` mid-game → redirects back to `/game/:joinCode`

## References

- Original ticket: `meta/tickets/ENG-014-round3-game-end-score-display.md`
- Previous round-transition plan: `meta/plans/2026-03-23-ENG-013-round-transition-hat-refill-banners.md`
- Hat-emptying logic: `server/src/store/InMemoryGameStore.ts:291-308` (guessWord)
- Round transition UI: `client/src/pages/GamePage.tsx:44-57` (status effect), `354-427` (BetweenRoundsView, RoundSplashOverlay)
- Router: `client/src/main.tsx:15-24`
