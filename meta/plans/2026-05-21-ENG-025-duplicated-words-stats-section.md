---
date: "2026-05-21T00:00:00Z"
type: plan
skill: create-plan
work-item: ""
status: draft
---

# Duplicated Words Stats Section Implementation Plan

## Overview

Add a "Duplications" section to the post-game stats page that surfaces words submitted by more than one player. This section sits between the "Best Clue Giver" prize card and the full player word list. If no duplicates exist, the section is omitted entirely.

## Current State Analysis

- `StatsPage.tsx` fetches `GameStats` (via `GET /api/games/:joinCode/stats`) and renders two sections: `BestClueGiverSection` and a "Words submitted" block grouped by player.
- `GameStats` already contains `wordsBySubmitter: SubmitterWords[]`, where each entry is `{ submitterName: string, words: string[] }`. All the data needed to compute duplicates is already present on the client.
- No server changes, API changes, or shared type changes are required.

## Desired End State

A `DuplicationsSection` component renders between `BestClueGiverSection` and the words-submitted block.

- Each duplicated word appears on one line: **word — N** (e.g. `dog — 2`)
- Directly below that line: a comma-separated list of the player names who submitted that word (e.g. `Alice, Bob`)
- Words are sorted by duplicate count descending, then alphabetically
- If zero words are duplicated, the section does not render at all
- Duplicate detection is case-insensitive and trims whitespace (so `"Dog"` and `" dog "` match `"dog"`)
- The display word is normalised: lowercased and trimmed (consistent across all entries)

### Verification:

- Game with two players both submitting "dog" → "dog — 2" appears with both player names
- Game where all words are unique → Duplications section is absent from the page
- Game where "Dog" and "dog" are submitted by two players → treated as one duplicate
- Leading/trailing whitespace in words does not prevent matching

## What We're NOT Doing

- No server-side computation of duplicates — the existing `wordsBySubmitter` payload is sufficient
- No changes to `GameStats` type or the stats API endpoint
- No sorting or reordering of the existing "Words submitted" section

## Implementation Approach

All changes live in `client/src/pages/StatsPage.tsx`. We add:

1. A pure `computeDuplications` function that derives a sorted list of duplicated words from `wordsBySubmitter`
2. A `DuplicationsSection` component that renders the UI (or nothing if no duplicates)
3. Wire `DuplicationsSection` into the `StatsPage` return tree

---

## Phase 1: Implement Duplications Section in StatsPage

### Overview

Single-file change. Add helper logic and a new component to `StatsPage.tsx`, then insert it into the render tree.

### Changes Required:

#### 1. `client/src/pages/StatsPage.tsx`

Add a `computeDuplications` pure function above the existing components:

```typescript
type Duplication = {
  word: string
  count: number
  players: string[]
}

function computeDuplications(wordsBySubmitter: SubmitterWords[]): Duplication[] {
  const wordToPlayers = new Map<string, string[]>()
  for (const { submitterName, words } of wordsBySubmitter) {
    for (const raw of words) {
      const key = raw.trim().toLowerCase()
      const existing = wordToPlayers.get(key) ?? []
      wordToPlayers.set(key, [...existing, submitterName])
    }
  }
  return [...wordToPlayers.entries()]
    .filter(([, players]) => players.length >= 2)
    .map(([word, players]) => ({ word, count: players.length, players }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
}
```

Add the `DuplicationsSection` component:

```typescript
function DuplicationsSection({ wordsBySubmitter }: { wordsBySubmitter: SubmitterWords[] }) {
  const duplications = computeDuplications(wordsBySubmitter)
  if (duplications.length === 0) return null
  return (
    <section className="w-full max-w-md rounded-2xl bg-brand-muted px-6 py-6">
      <p className="mb-4 text-xs font-semibold uppercase tracking-widest text-gray-400">Duplications</p>
      <div className="flex flex-col gap-4">
        {duplications.map(({ word, count, players }) => (
          <div key={word}>
            <p className="text-sm font-semibold text-gray-900">
              {word} — {count}
            </p>
            <p className="text-xs text-gray-500">{players.join(', ')}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
```

Wire it into `StatsPage` between `BestClueGiverSection` and the words block:

```tsx
<BestClueGiverSection bestClueGiver={stats.bestClueGiver} />

<DuplicationsSection wordsBySubmitter={stats.wordsBySubmitter} />

{stats.wordsBySubmitter.length === 0 ? ( ... ) : ( ... )}
```

The import of `SubmitterWords` must be added to the existing import from `@wordfetti/shared`:

```typescript
import type { BestClueGiver, GameStats, SubmitterWords } from '@wordfetti/shared'
```

### Success Criteria:

#### Automated Verification:

- [x] TypeScript compilation passes: `pnpm --filter client build` (or `pnpm typecheck` if available)
- [x] Existing tests still pass: `pnpm test`

#### Manual Verification:

- [ ] With two or more players sharing a word, "Duplications" section appears between Best Clue Giver and Words Submitted
- [ ] Each duplicated word shows the count and the comma-separated player list on the line below
- [ ] Words that are unique across all players do not appear in the Duplications section
- [ ] With no duplicate words in the game, the Duplications section is entirely absent
- [ ] Case-insensitive matching works: "Dog" from one player matches "dog" from another

---

## Testing Strategy

### Unit Tests (optional but recommended):

The `computeDuplications` function is a pure function and well-suited to unit testing:

- All unique words → returns `[]`
- Two players share one word → returns one entry with count 2 and both player names
- Case and trim normalisation → `"Dog"` and `" dog "` collapse to the same key
- Sorting: higher count entries appear first; ties sorted alphabetically

### Manual Testing Steps:

1. Start a game with ≥2 players
2. Have two players each submit the same word (e.g. "dog")
3. Finish the game and navigate to Stats
4. Confirm "dog — 2" appears under "Duplications" with both player names
5. Confirm words submitted by only one player are not listed in Duplications
6. Run a game where all words are unique; confirm the Duplications section is absent

## References

- Stats page: `client/src/pages/StatsPage.tsx`
- Shared types: `shared/src/types.ts`
- Stats store method: `server/src/store/InMemoryGameStore.ts:233`
- Prior stats plan: `meta/plans/2026-05-16-ENG-019-post-game-stats-page.md`
- Prior best clue giver plan: `meta/plans/2026-05-17-ENG-020-best-clue-giver-stat.md`
