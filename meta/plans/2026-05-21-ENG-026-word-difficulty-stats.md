---
date: "2026-05-21T00:00:00Z"
type: plan
skill: create-plan
work-item: ""
status: draft
---

# Word Difficulty Stats Implementation Plan

## Overview

Track how long each word takes to be guessed (ignoring skips) and surface the top 3 easiest and top 3 hardest words — with average guess times — on the post-game stats page, between the Duplications section and the full player word list.

## Current State Analysis

- `Hat` (`server/src/store/Hat.ts`) manages word flow during gameplay. It holds two separate fields `_currentWordId: string | undefined` and `_currentWord: string | undefined` that together track the active word. Timing data is not currently captured anywhere.
- `GameSession.guessWord()` (`server/src/store/Game.ts:138`) is where a guess is confirmed, but it has no concept of when the current word was shown.
- `GameSession.readyTurn()` (`server/src/store/Game.ts:67`) calls `this._hat.startTurn()` to show the first word of a turn.
- `GameSession.skipWord()` (`server/src/store/Game.ts:179`) calls `this._hat.skip()` — skips must not count toward timing.
- `InMemoryGameStore.getGameWords()` (`server/src/store/InMemoryGameStore.ts:233`) is the stat assembler — it already reads player roster data and is the natural place to pull timing data from the hat.
- `GameStats` (`shared/src/types.ts:24`) currently has `wordsBySubmitter` and `bestClueGiver`. It needs a new `wordDifficulty` field.
- `StatsPage.tsx` fetches `GameStats` and renders `BestClueGiverSection` then `DuplicationsSection` then the player word list. The new section slots between `DuplicationsSection` and the word list.
- Tests for `Hat` live in `server/src/store/Hat.test.ts` and follow the `vitest` pattern with a `w(id, text)` helper.

## Desired End State

After playing a complete game:

- The stats endpoint returns a `wordDifficulty` field containing up to 3 `easiest` words and up to 3 `hardest` words, each with the word text and its average guess time in milliseconds.
- The stats page renders a "Word Difficulty" card between the Duplications section and the Words Submitted list.
- Each entry in easiest/hardest shows the word and its average time formatted as e.g. `3.4 seconds` or `28.6 seconds`.
- If no words were ever successfully guessed (all skipped, or game abandoned before any guess), the section is omitted.
- Times accumulate correctly across all three rounds — a word guessed in rounds 1, 2, and 3 has 3 time entries, and the average reflects all of them.

### Key Discoveries

- `Hat._currentWordId` and `Hat._currentWord` are redundant parallel fields tracking the same word — the `HatWord` refactor eliminates this smell.
- `Hat.refill()` shuffles `[...this._originalWords]` — using shared object references means mutations to `guessTimes` survive the refill automatically, no extra bookkeeping needed.
- `GameSession.readyTurn()` logs `firstWord.text` — the `HatWord` return type is a superset of `Word`, so no call-site changes are needed there.
- `GameSession.snapshot()` accesses `this._hat?.current?.text` — the `current` getter returning `HatWord | undefined` is backwards-compatible since callers only read `.id` and `.text`.
- `game.hat` is exposed via a getter on `GameSession` (line 28) — `InMemoryGameStore` can already access it.
- Test commands: `pnpm test` (all), `pnpm typecheck` (all), `pnpm --filter server test` (server only).

## What We're NOT Doing

- Not moving `getBestClueGiver()` out of `PlayerRoster` — that refactor is a separate concern.
- Not creating a `StatsCalculator` class — pure functions serve the same purpose with less ceremony.
- Not showing timing data for skipped-only words (words never guessed have no timing data and are excluded).
- Not adding per-round breakdowns — only overall averages across all rounds.
- Not deduplicating overlapping easiest/hardest lists — in small games with ≤3 words, overlap is acceptable and the correct output.

## Implementation Approach

Four phases, each independently verifiable:

1. Refactor `Hat` to use `HatWord` — introduces the type, removes the dual `_currentWordId`/`_currentWord` fields, adds clock injection, and records timing on `guess()`.
2. Add a pure `computeWordDifficulty` function in `server/src/stats/` — testable in isolation with no dependencies.
3. Wire timing data into `GameStats` — update the shared type and `getGameWords()`.
4. Render the new section in `StatsPage.tsx`.

---

## Phase 1: Refactor `Hat` to use `HatWord` with Timing

### Overview

Replace `Word[]` internal storage with `HatWord[]`. Each word carries its own `shownAt` timestamp and `guessTimes` history. Inject a clock function for testability. The public API surface of `Hat` remains compatible — callers that read `.id` and `.text` from `current` continue to work unchanged.

### Changes Required:

#### 1. `server/src/store/Hat.ts`

**Changes**: Define `HatWord`, replace dual `_currentWordId`/`_currentWord` with `_current: HatWord | undefined`, add `_clock`, record timing in `guess()`, set `shownAt` on word transitions, reset `shownAt` in `refill()`, add `wordStats` getter.

```typescript
import type { Word } from '@wordfetti/shared'

type HatWord = {
  id: string
  text: string
  shownAt?: number
  guessTimes: number[]
}

function shuffle<T>(arr: T[]): T[] {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

export class Hat {
  private _words: HatWord[]
  private readonly _originalWords: HatWord[]
  private _skippedThisTurn: string[]
  private _current: HatWord | undefined
  private readonly _clock: () => number

  constructor(words: Word[], clock: () => number = Date.now) {
    this._clock = clock
    this._originalWords = words.map(w => ({ ...w, guessTimes: [] }))
    this._words = shuffle([...this._originalWords])
    this._skippedThisTurn = []
  }

  get current(): { id: string; text: string } | undefined {
    return this._current ? { id: this._current.id, text: this._current.text } : undefined
  }

  get isEmpty(): boolean {
    return this._words.length === 0
  }

  get size(): number {
    return this._words.length
  }

  wordTexts(): string[] {
    return this._words.map((w) => w.text)
  }

  get originalWords(): Word[] {
    return this._originalWords.map(({ id, text }) => ({ id, text }))
  }

  /** Returns per-word timing data accumulated across all rounds. */
  get wordStats(): ReadonlyArray<{ id: string; text: string; guessTimes: number[] }> {
    return this._originalWords.map(({ id, text, guessTimes }) => ({
      id,
      text,
      guessTimes: [...guessTimes],
    }))
  }

  startTurn(): Word {
    if (this._words.length === 0) throw new Error('Hat is empty')
    this._skippedThisTurn = []
    const first = this._words[0]
    first.shownAt = this._clock()
    this._current = first
    return { id: first.id, text: first.text }
  }

  guess(): boolean {
    if (!this._current) throw new Error('No current word')
    if (this._current.shownAt !== undefined) {
      this._current.guessTimes.push(this._clock() - this._current.shownAt)
    }
    this._words = this._words.filter((w) => w.id !== this._current!.id)
    if (this._words.length === 0) {
      this._current = undefined
      return true
    }
    const next = this._drawNext(this._current)
    next.shownAt = this._clock()
    this._current = next
    return false
  }

  skip(): Word {
    if (!this._current) throw new Error('No current word')
    const currentId = this._current.id
    this._skippedThisTurn = [...this._skippedThisTurn, currentId]
    const next = this._drawNext(this._current)
    next.shownAt = this._clock()
    this._current = next
    return { id: next.id, text: next.text }
  }

  refill(): void {
    for (const word of this._originalWords) word.shownAt = undefined
    this._words = shuffle([...this._originalWords])
    this._skippedThisTurn = []
    this._current = undefined
  }

  private _drawNext(current: HatWord): HatWord {
    const available = this._words.filter(
      (w) => w.id !== current.id && !this._skippedThisTurn.includes(w.id),
    )
    if (available.length > 0) return available[0]
    const fallback = this._words.filter((w) => w.id !== current.id)
    if (fallback.length > 0) return fallback[0]
    return this._words[0]
  }
}
```

**Note on `_drawNext`**: the parameter type changes from `Word | null` to `HatWord` — callers within `Hat` always pass a defined `HatWord` so the `null` case was unused.

#### 2. `server/src/store/Hat.test.ts`

Add a new `describe('wordStats')` block testing timing behaviour. Use a fake clock for determinism:

```typescript
describe('wordStats', () => {
  it('returns empty guessTimes before any guesses', () => {
    const hat = new Hat([w('a', 'apple'), w('b', 'banana')])
    hat.wordStats.forEach(ws => expect(ws.guessTimes).toEqual([]))
  })

  it('records elapsed time when a word is guessed', () => {
    let time = 0
    const clock = () => time
    const hat = new Hat([w('a', 'apple'), w('b', 'banana')], clock)
    hat.startTurn()
    time = 3000
    hat.guess()
    const stats = hat.wordStats.find(ws => ws.guessTimes.length > 0)
    expect(stats?.guessTimes[0]).toBe(3000)
  })

  it('does not record time when a word is skipped', () => {
    let time = 0
    const clock = () => time
    const hat = new Hat([w('a', 'apple'), w('b', 'banana')], clock)
    hat.startTurn()
    time = 5000
    hat.skip()
    hat.wordStats.forEach(ws => expect(ws.guessTimes).toEqual([]))
  })

  it('accumulates guess times across rounds via refill', () => {
    let time = 0
    const clock = () => time
    const hat = new Hat([w('a', 'apple')], clock)
    // Round 1
    hat.startTurn()
    time = 2000
    hat.guess()
    hat.refill()
    // Round 2
    hat.startTurn()
    time = 5000
    hat.guess()
    const stats = hat.wordStats.find(ws => ws.id === 'a')
    expect(stats?.guessTimes).toHaveLength(2)
    expect(stats?.guessTimes[0]).toBe(2000)
    expect(stats?.guessTimes[1]).toBe(3000) // 5000 - 2000 (shownAt reset by refill then startTurn)
  })

  it('refill resets shownAt so times are measured fresh each round', () => {
    let time = 1000
    const clock = () => time
    const hat = new Hat([w('a', 'apple')], clock)
    hat.startTurn()     // shownAt = 1000
    time = 4000
    hat.guess()         // records 3000ms, hat empty
    hat.refill()
    time = 10000
    hat.startTurn()     // shownAt = 10000 (not 1000)
    time = 12000
    hat.guess()         // records 2000ms
    const stats = hat.wordStats.find(ws => ws.id === 'a')
    expect(stats?.guessTimes).toEqual([3000, 2000])
  })
})
```

### Success Criteria:

#### Automated Verification:

- [ ] Server tests pass: `pnpm --filter server test`
- [ ] TypeScript compiles: `pnpm typecheck`

#### Manual Verification:

- [ ] No regressions in existing Hat test suite (all pre-existing tests still pass)

---

## Phase 2: Pure `computeWordDifficulty` Function

### Overview

A pure, dependency-free function that takes the word stats array from `Hat.wordStats` and returns the top-3 easiest and top-3 hardest words by average guess time. Returns `null` when no timing data exists.

### Changes Required:

#### 1. `server/src/stats/computeWordDifficulty.ts` (new file)

```typescript
export type WordDifficultyStat = {
  word: string
  avgMs: number
}

export type WordDifficultyResult = {
  easiest: WordDifficultyStat[]
  hardest: WordDifficultyStat[]
}

export function computeWordDifficulty(
  wordStats: ReadonlyArray<{ text: string; guessTimes: number[] }>,
): WordDifficultyResult | null {
  const withTimes = wordStats
    .filter((w) => w.guessTimes.length > 0)
    .map((w) => ({
      word: w.text,
      avgMs: w.guessTimes.reduce((sum, t) => sum + t, 0) / w.guessTimes.length,
    }))

  if (withTimes.length === 0) return null

  const sorted = [...withTimes].sort((a, b) => a.avgMs - b.avgMs)

  return {
    easiest: sorted.slice(0, 3),
    hardest: sorted.slice(-3).reverse(),
  }
}
```

#### 2. `server/src/stats/computeWordDifficulty.test.ts` (new file)

```typescript
import { describe, it, expect } from 'vitest'
import { computeWordDifficulty } from './computeWordDifficulty.js'

describe('computeWordDifficulty', () => {
  it('returns null when no words have been guessed', () => {
    expect(computeWordDifficulty([{ text: 'dog', guessTimes: [] }])).toBeNull()
  })

  it('returns null for an empty word list', () => {
    expect(computeWordDifficulty([])).toBeNull()
  })

  it('sorts easiest by lowest average ms', () => {
    const result = computeWordDifficulty([
      { text: 'dog', guessTimes: [5000] },
      { text: 'cat', guessTimes: [1000] },
      { text: 'elephant', guessTimes: [9000] },
    ])
    expect(result?.easiest[0].word).toBe('cat')
    expect(result?.easiest[1].word).toBe('dog')
    expect(result?.easiest[2].word).toBe('elephant')
  })

  it('sorts hardest by highest average ms', () => {
    const result = computeWordDifficulty([
      { text: 'dog', guessTimes: [5000] },
      { text: 'cat', guessTimes: [1000] },
      { text: 'elephant', guessTimes: [9000] },
    ])
    expect(result?.hardest[0].word).toBe('elephant')
    expect(result?.hardest[1].word).toBe('dog')
    expect(result?.hardest[2].word).toBe('cat')
  })

  it('returns at most 3 entries per list', () => {
    const words = Array.from({ length: 10 }, (_, i) => ({
      text: `word${i}`,
      guessTimes: [(i + 1) * 1000],
    }))
    const result = computeWordDifficulty(words)
    expect(result?.easiest).toHaveLength(3)
    expect(result?.hardest).toHaveLength(3)
  })

  it('averages multiple guess times correctly', () => {
    const result = computeWordDifficulty([
      { text: 'dog', guessTimes: [2000, 4000, 6000] },
    ])
    expect(result?.easiest[0].avgMs).toBe(4000)
  })

  it('excludes words with no guess times', () => {
    const result = computeWordDifficulty([
      { text: 'skipped', guessTimes: [] },
      { text: 'guessed', guessTimes: [3000] },
    ])
    expect(result?.easiest).toHaveLength(1)
    expect(result?.easiest[0].word).toBe('guessed')
  })

  it('returns fewer than 3 entries when fewer words were guessed', () => {
    const result = computeWordDifficulty([
      { text: 'only', guessTimes: [1000] },
    ])
    expect(result?.easiest).toHaveLength(1)
    expect(result?.hardest).toHaveLength(1)
  })
})
```

### Success Criteria:

#### Automated Verification:

- [ ] Server tests pass: `pnpm --filter server test`
- [ ] TypeScript compiles: `pnpm typecheck`

---

## Phase 3: Wire Timing into `GameStats` Type and Store

### Overview

Update the shared `GameStats` type to include `wordDifficulty`, update `getGameWords()` to read `hat.wordStats` and call `computeWordDifficulty`, and update the corresponding type in `shared/`.

### Changes Required:

#### 1. `shared/src/types.ts`

Add two new types and extend `GameStats`:

```typescript
export type WordDifficultyStat = {
  word: string
  avgMs: number
}

export type WordDifficultyStats = {
  easiest: WordDifficultyStat[]
  hardest: WordDifficultyStat[]
}

export type GameStats = {
  wordsBySubmitter: SubmitterWords[]
  bestClueGiver: BestClueGiver | null
  wordDifficulty: WordDifficultyStats | null
}
```

#### 2. `server/src/store/InMemoryGameStore.ts`

In `getGameWords()`, add the import and call:

```typescript
import { computeWordDifficulty } from '../stats/computeWordDifficulty.js'

// inside getGameWords(), after wordsBySubmitter is assembled:
const hatWordStats = game.hat?.wordStats ?? []
const wordDifficulty = computeWordDifficulty(hatWordStats)

return { wordsBySubmitter, bestClueGiver: game.roster.getBestClueGiver(), wordDifficulty }
```

### Success Criteria:

#### Automated Verification:

- [ ] All tests pass: `pnpm test`
- [ ] TypeScript compiles: `pnpm typecheck`

#### Manual Verification:

- [ ] `GET /api/games/:joinCode/stats` response includes `wordDifficulty: null` before any words are guessed
- [ ] After a completed game, response includes `wordDifficulty.easiest` and `wordDifficulty.hardest` arrays

---

## Phase 4: Render Word Difficulty Section in `StatsPage.tsx`

### Overview

Add a `WordDifficultySection` component that renders between `DuplicationsSection` and the "Words Submitted" block. Each easiest/hardest entry shows the word and its average time formatted to one decimal place.

### Changes Required:

#### 1. `client/src/pages/StatsPage.tsx`

Update the import to include the new shared types:

```typescript
import type { BestClueGiver, GameStats, SubmitterWords, WordDifficultyStats } from '@wordfetti/shared'
```

Add the formatter and component above `StatsPage`:

```typescript
function formatAvgTime(ms: number): string {
  return `${(ms / 1000).toFixed(1)} seconds`
}

function WordDifficultySection({ wordDifficulty }: { wordDifficulty: WordDifficultyStats | null }) {
  if (!wordDifficulty) return null
  return (
    <section className="w-full max-w-md rounded-2xl bg-brand-muted px-6 py-6">
      <p className="mb-4 text-xs font-semibold uppercase tracking-widest text-gray-400">Word Difficulty</p>
      <div className="flex flex-col gap-6">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Easiest</p>
          <div className="flex flex-col gap-2">
            {wordDifficulty.easiest.map(({ word, avgMs }) => (
              <div key={word} className="flex justify-between rounded-xl bg-white px-4 py-3 text-sm shadow-sm">
                <span className="text-gray-900">{word}</span>
                <span className="text-gray-400">{formatAvgTime(avgMs)}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Hardest</p>
          <div className="flex flex-col gap-2">
            {wordDifficulty.hardest.map(({ word, avgMs }) => (
              <div key={word} className="flex justify-between rounded-xl bg-white px-4 py-3 text-sm shadow-sm">
                <span className="text-gray-900">{word}</span>
                <span className="text-gray-400">{formatAvgTime(avgMs)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
```

Wire it in between `DuplicationsSection` and the words block:

```tsx
<BestClueGiverSection bestClueGiver={stats.bestClueGiver} />
<DuplicationsSection wordsBySubmitter={stats.wordsBySubmitter} />
<WordDifficultySection wordDifficulty={stats.wordDifficulty} />

{stats.wordsBySubmitter.length === 0 ? ( ... ) : ( ... )}
```

### Success Criteria:

#### Automated Verification:

- [ ] All tests pass: `pnpm test`
- [ ] TypeScript compiles: `pnpm typecheck`

#### Manual Verification:

- [ ] "Word Difficulty" card appears below Duplications and above Words Submitted
- [ ] Easiest words show the lowest average times; hardest show the highest
- [ ] Times are formatted as e.g. `3.4 seconds`, not `3400ms` or `3 seconds`
- [ ] Section is absent entirely when no words were ever guessed (e.g. stats page loaded after a lobby-only game)
- [ ] Times accumulate correctly across rounds — a word guessed in all 3 rounds reflects all 3 timings in its average

---

## Testing Strategy

### Unit Tests

**`Hat` timing tests** (`Hat.test.ts`):
- Empty `guessTimes` before any guesses
- Correct elapsed time recorded on `guess()`
- No time recorded on `skip()`
- Times accumulate across `refill()` cycles (cross-round)
- `refill()` resets `shownAt` so round-2 timing starts fresh

**`computeWordDifficulty` tests** (`computeWordDifficulty.test.ts`):
- Returns `null` with no guessed words
- Correct sorting for easiest (lowest avg) and hardest (highest avg)
- Caps at 3 entries per list
- Correct average across multiple guess times
- Excludes words with empty `guessTimes`
- Handles fewer than 3 guessed words gracefully

### Manual Testing Steps

1. Start a game with 4+ players, each submitting 3–5 words
2. Play at least one full round — guess some words quickly and hesitate on others
3. Navigate to the stats page
4. Confirm "Word Difficulty" appears between Duplications and Words Submitted
5. Confirm the easiest words are ones that were guessed quickly
6. Confirm times are displayed as `X.X seconds`
7. If the game goes to round 2 or 3, confirm the times reflect accumulated averages (a word that was fast in round 1 but slow in round 2 should show a blended average)
8. Run a game and navigate to stats without completing any guesses — confirm the section is absent

## Edge Cases

- **Hat is undefined at stats time**: `game.hat` is only set after `game.start()`. If stats are requested for a lobby-only game, `game.hat?.wordStats ?? []` returns `[]`, `computeWordDifficulty` returns `null`, section is hidden. ✓
- **All words skipped**: `guessTimes` arrays all empty, `computeWordDifficulty` returns `null`. ✓
- **Single word game**: Both `easiest` and `hardest` contain the same word — acceptable for degenerate game sizes.
- **Ties**: Words with the same average time are not explicitly sorted — insertion order from the sort is deterministic enough for this display.

## References

- Hat: `server/src/store/Hat.ts`
- Hat tests: `server/src/store/Hat.test.ts`
- GameSession: `server/src/store/Game.ts`
- Store assembler: `server/src/store/InMemoryGameStore.ts:233`
- Shared types: `shared/src/types.ts`
- Stats route: `server/src/routes/games.ts:211`
- Stats page: `client/src/pages/StatsPage.tsx`
- Prior stats plan: `meta/plans/2026-05-16-ENG-019-post-game-stats-page.md`
- Duplications plan: `meta/plans/2026-05-21-duplicated-words-stats-section.md`
