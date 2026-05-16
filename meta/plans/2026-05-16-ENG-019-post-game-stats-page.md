---
date: "2026-05-16T14:07:30+00:00"
type: plan
skill: create-plan
work-item: "ENG-019"
status: draft
---

# Post-Game Stats Page Implementation Plan

## Overview

Add a "View stats" button to the existing end-of-game screen (`ResultsPage`) that navigates to a new `/game/:joinCode/stats` route. The stats page shows all submitted words grouped by submitter (alphabetical groups, alphabetical words within), styled to match the existing game UI theme.

## Current State Analysis

- `Word` is `{ id: string, text: string }` — no submitter field (`shared/src/types.ts:8`)
- Submitter association is stored only in `InMemoryGameStore.words: Map<string, Word[]>`, keyed `"${joinCode}:${playerId}"` — never exposed to the client (`InMemoryGameStore.ts:36`)
- The only word API endpoint, `GET /:joinCode/words`, requires a `playerId` and returns that player's own words only (`routes/games.ts:194`) — no all-game word endpoint exists
- `ResultsPage.tsx` shows scores and win/lose result only — no word data, no stats link
- Games persist in memory for 8 hours after last activity; the `words` Map is cleaned up at the same time as the game (`InMemoryGameStore.ts:85-99`)
- UI conventions: `bg-brand-cream` page background, `rounded-xl bg-white px-4 py-3 shadow-sm` card rows, `bg-brand-coral` primary buttons, `role="status"` loading / `role="alert"` error

## Desired End State

A player who has just finished a game sees a "View stats" button on the results screen. Clicking it takes them to `/game/<code>/stats`, which shows all submitted words grouped by the submitter's name (groups and words within each group in alphabetical order). The page can also be reached by direct URL for the lifetime of the game (up to 8 hours).

### Verification

1. Start a game with multiple players, each submitting words
2. Complete all three rounds
3. On the results screen, a "View stats" button is visible
4. Clicking it navigates to `/game/<code>/stats`
5. All words appear, grouped by submitter name, alphabetically within each group
6. Pasting the stats URL directly in a new tab loads successfully
7. Visual design matches the existing page theme

## What We're NOT Doing

- Changing the game cleanup / data retention process
- Adding any stats beyond the word-by-submitter list (guess times, skips, leaderboards — future stories)
- Requiring any authentication or playerId to view the stats
- Adding a back button to the stats page (browser back is sufficient)

## Key Discoveries

- `InMemoryGameStore.words` Map still holds all word-submitter associations after game start; they are not erased when the hat is built (`startGame` at `InMemoryGameStore.ts:191`) — the data is available post-game without any structural change
- Player names are on `game.players: Player[]` (`shared/src/types.ts:13`) — the store can join words to names in `getGameWords` by iterating the map keys for a given joinCode and looking up `game.players.find(p => p.id === playerId)`
- No shared type exists for the stats response — a small addition to `shared/src/types.ts` is needed
- `GET /:joinCode/stats` must be registered **before** the existing `GET /:joinCode/words` route so Express doesn't try to treat `"stats"` as a wordId segment — actually `words` is a separate path segment so there's no conflict; register it at the same level as other `/:joinCode/*` routes
- The client uses one-shot `fetch` (not SSE) for static post-game data — `ResultsPage` does this already; `StatsPage` should follow the same pattern

---

## Phase 1: Backend — Shared Types, Store Method, and API Endpoint

### Overview

Add a `GameStats` response type to the shared package, add a `getGameWords` method to the store, implement it in `InMemoryGameStore`, and expose a new `GET /:joinCode/stats` endpoint.

### Changes Required

#### 1. Shared types

**File**: `shared/src/types.ts`

Add after the existing `Word` type:

```ts
export type SubmitterWords = {
  submitterName: string
  words: string[]
}

export type GameStats = {
  wordsBySubmitter: SubmitterWords[]
}
```

No existing types are modified.

#### 2. GameStore interface

**File**: `server/src/store/GameStore.ts`

Add one method to the `GameStore` interface:

```ts
getGameWords(joinCode: string): Promise<GameStats>
```

Import `GameStats` from `@wordfetti/shared`.

Full updated interface signature list (existing methods unchanged):

```ts
import type { Game, GameSettings, GameStats, Player, Team, Word } from '@wordfetti/shared'
// ...
getGameWords(joinCode: string): Promise<GameStats>
```

#### 3. InMemoryGameStore implementation

**File**: `server/src/store/InMemoryGameStore.ts`

Add import for `GameStats` alongside existing shared imports (line 2).

Add the following method to the class (after `getWords`, around line 489):

```ts
async getGameWords(joinCode: string): Promise<GameStats> {
  const game = this.games.get(joinCode)
  if (!game) throw new AppError('NOT_FOUND', 'Game not found')

  // Build a map from playerId -> submitterName for fast lookup
  const playerNames = new Map(game.players.map((p) => [p.id, p.name]))

  // Collect all word entries for this joinCode from the words map
  const prefix = `${joinCode}:`
  const grouped = new Map<string, string[]>()

  for (const [key, words] of this.words.entries()) {
    if (!key.startsWith(prefix)) continue
    const playerId = key.slice(prefix.length)
    const name = playerNames.get(playerId)
    if (!name) continue  // player left between submission and game end — skip gracefully
    grouped.set(name, words.map((w) => w.text))
  }

  const wordsBySubmitter = [...grouped.entries()]
    .map(([submitterName, words]) => ({
      submitterName,
      words: [...words].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.submitterName.localeCompare(b.submitterName))

  return { wordsBySubmitter }
}
```

#### 4. API endpoint

**File**: `server/src/routes/games.ts`

Add `GameStats` to the import from `@wordfetti/shared` (line 3).

Add the following route after the existing `GET /:joinCode/words` handler (around line 212), before the `DELETE /:joinCode/words/:wordId` handler:

```ts
// GET /:joinCode/stats — returns all words grouped by submitter for the post-game stats page
router.get('/:joinCode/stats', async (req, res, next) => {
  try {
    const joinCode = req.params.joinCode.toUpperCase()
    const stats = await store.getGameWords(joinCode)
    return res.json(stats)
  } catch (err: unknown) {
    if (err instanceof AppError && err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Game not found' })
    }
    next(err)
  }
})
```

No playerId or auth required — the game code is the only access control, consistent with all other read endpoints.

### Success Criteria

#### Automated Verification

- [ ] TypeScript compiles without errors: `pnpm --filter server build` (or `pnpm typecheck` if available)
- [ ] `GET /api/games/:joinCode/stats` returns 200 with `{ wordsBySubmitter: [...] }` for a finished game
- [ ] `GET /api/games/:joinCode/stats` returns 404 for an unknown joinCode
- [ ] Existing tests still pass: `pnpm --filter server test`

#### Manual Verification

- [ ] Start a game, submit words as multiple players, finish all rounds
- [ ] `curl http://localhost:3000/api/games/<code>/stats` returns words grouped correctly by submitter, alphabetically sorted

---

## Phase 2: Frontend — Stats Page and Results Button

### Overview

Add the `StatsPage` component, register its route, and add the "View stats" button to `ResultsPage`.

### Changes Required

#### 1. New StatsPage component

**File**: `client/src/pages/StatsPage.tsx` (new file)

```tsx
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { GameStats } from '@wordfetti/shared'

export function StatsPage() {
  const { joinCode } = useParams<{ joinCode: string }>()
  const [stats, setStats] = useState<GameStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!joinCode) return
    const controller = new AbortController()
    fetch(`/api/games/${joinCode}/stats`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`)
        return res.json() as Promise<GameStats>
      })
      .then(setStats)
      .catch((err) => {
        if (err.name === 'AbortError') return
        setError('Could not load stats.')
      })
    return () => controller.abort()
  }, [joinCode])

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-cream">
        <p role="alert" className="text-gray-600">{error}</p>
      </div>
    )
  }

  if (!stats) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-cream">
        <p role="status" className="text-gray-400">Loading stats...</p>
      </div>
    )
  }

  return (
    <main className="flex min-h-screen flex-col items-center gap-8 bg-brand-cream px-4 py-12">
      <h1 className="text-3xl font-bold text-gray-900">Game Stats</h1>

      {stats.wordsBySubmitter.length === 0 ? (
        <p className="text-gray-400">No words were submitted for this game.</p>
      ) : (
        <div className="flex w-full max-w-md flex-col gap-6">
          {stats.wordsBySubmitter.map(({ submitterName, words }) => (
            <section key={submitterName}>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
                {submitterName}
              </h2>
              <ul className="flex flex-col gap-2">
                {words.map((word) => (
                  <li
                    key={word}
                    className="rounded-xl bg-white px-4 py-3 text-sm text-gray-900 shadow-sm"
                  >
                    {word}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </main>
  )
}
```

#### 2. Register route

**File**: `client/src/main.tsx`

Add import alongside existing page imports:

```ts
import { StatsPage } from './pages/StatsPage'
```

Add route inside `<Routes>`, after the existing results route (line 23):

```tsx
<Route path="/game/:joinCode/stats" element={<StatsPage />} />
```

#### 3. "View stats" button on ResultsPage

**File**: `client/src/pages/ResultsPage.tsx`

Add `useNavigate` to the existing `react-router-dom` import (line 2):

```ts
import { useLocation, useNavigate, useParams } from 'react-router-dom'
```

(`useNavigate` is already imported — no change needed if it's already there. Check line 2.)

Add the button inside the `<main>` element, after the scores `<div className="flex gap-12">` block (around line 71):

```tsx
<button
  onClick={() => navigate(`/game/${joinCode}/stats`)}
  className="rounded-xl bg-brand-coral px-8 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
>
  View stats
</button>
```

Note: `useNavigate` is already destructured on line 9 of `ResultsPage.tsx` — no hook change needed.

### Success Criteria

#### Automated Verification

- [ ] TypeScript compiles without errors: `pnpm --filter client build` (or `pnpm typecheck`)
- [ ] No new lint errors: `pnpm lint` (if configured)

#### Manual Verification

- [ ] "View stats" button is visible on the results screen after completing a game
- [ ] Clicking the button navigates to `/game/<code>/stats`
- [ ] Stats page shows each submitter as a labelled section with their words listed alphabetically
- [ ] Submitter sections are ordered alphabetically by name
- [ ] Pasting the stats URL directly in a new tab loads the page correctly
- [ ] Empty state is shown when no words exist (edge case — hard to trigger in normal play)
- [ ] Page background and card styling visually match the existing game pages

---

## Testing Strategy

### Manual Testing Steps

1. Run `pnpm dev` and create a game with 2+ players per team
2. Have each player submit different words (use the zombie script if testing solo: `pnpm zombie <code>`)
3. Play through all three rounds to reach the results screen
4. Confirm "View stats" button is present and navigates correctly
5. Confirm words are grouped by submitter name, alphabetically sorted within each group
6. Copy the stats URL and open in a fresh tab — page should load without error
7. Check visual consistency: background, card style, typography match other game pages

### Edge Cases to Check

- A player who submitted words but is no longer tracked in `game.players` — the store skips them gracefully (the `if (!name) continue` guard)
- Zero words submitted (shouldn't happen in a real game but the empty state handles it)

## Performance Considerations

No performance concerns — the stats page is a one-shot read over an in-memory data structure with at most a few hundred words. No pagination or caching needed.

## Migration Notes

No migration needed — all state is in-memory. The new endpoint and store method are purely additive.

## References

- Original work item: `meta/tickets/ENG-019-post-game-stats-page-words-by-submitter.md`
- Related: `meta/tickets/ENG-014-round3-game-end-score-display.md` (the results screen being modified)
- Related plan: `meta/plans/2026-03-24-ENG-014-round3-game-end-score-display.md`
