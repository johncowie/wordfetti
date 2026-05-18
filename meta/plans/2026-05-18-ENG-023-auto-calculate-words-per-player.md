---
date: "2026-05-18T21:09:59+00:00"
type: plan
skill: create-plan
work-item: "ENG-023"
status: draft
---

# ENG-023: Auto-Calculate Words-Per-Player Default Implementation Plan

## Overview

Add a dynamic words-per-player default to the host lobby that targets ~30 total words. The value recalculates as players join, but locks once the host manually edits the input. This is a pure client-side UX change — no server logic is altered.

## Current State Analysis

- `GameSettingsPanel` (`client/src/pages/LobbyPage.tsx:351`) owns `wordsInput` as local string state, initialised from `settings.wordsPerPlayer`.
- Two `useEffect` hooks (lines 362–363) sync `wordsInput` from SSE-pushed `settings.wordsPerPlayer` changes.
- Save is triggered on `onBlur` via `saveField()` which calls `PATCH /api/games/:joinCode/settings`.
- `game.players` is available in the parent `LobbyPage` but is **not** currently passed to `GameSettingsPanel`.
- Each `Player` has a `wordCount: number` field (`shared/src/types.ts:28–33`).
- `client/src/utils/` does **not** exist yet.
- `client/src/config.ts` does **not** exist yet.
- Test pattern: pure Vitest with `describe`/`it`/`expect`, no render harness needed for a pure utility function.
- `DEFAULT_GAME_CONFIG.wordsPerPlayer` is `3` in `server/src/config.ts:6` — this stays unchanged.

### Key Discoveries

- `GameSettingsPanel` call site is `LobbyPage.tsx:147–154` — `game.players` is available there and can be passed as a new prop.
- The existing SSE-sync `useEffect` at line 362 will fire after a successful auto-calc save (server broadcasts back), but it will set `wordsInput` to the same value — harmless no-op.
- To avoid a feedback loop, the auto-calc `useEffect` must watch `game.players.length` (player count), not `settings.wordsPerPlayer`.
- The floor check mirrors the server guard in `InMemoryGameStore.updateSettings()`: skip auto-update if any player has already submitted **strictly more** words than the new computed value.

## Desired End State

- `client/src/config.ts` exports `DEFAULT_TARGET_WORD_COUNT = 30`, `MIN_WORDS_PER_PLAYER = 3`, `MAX_WORDS_PER_PLAYER = 10`.
- `client/src/utils/gameSettings.ts` exports `calculateDefaultWordsPerPlayer(playerCount, targetTotal?)`.
- `client/src/utils/gameSettings.test.ts` has unit tests covering all specified cases.
- `GameSettingsPanel` accepts a `players: Player[]` prop and tracks `hasManuallyEdited` state.
- When `hasManuallyEdited` is false and a player joins, the input and server value auto-update (subject to the floor check).
- A hint below the words input reads either "Auto-calculated based on N players" or "Manually set — auto-calculation paused".

### Key Verifications:

- 6 players → input shows 5 and hint says "Auto-calculated based on 6 players".
- Host edits to 7, then a new player joins → input stays at 7 and hint says "Manually set — auto-calculation paused".
- Player with 4 submitted words present, formula yields 3 → input is NOT auto-updated.
- 2 players → input shows 10 (clamped max).
- 12 players → input shows 3 (clamped min).

## What We're NOT Doing

- Not changing `server/src/config.ts` or `DEFAULT_GAME_CONFIG.wordsPerPlayer`.
- Not adding a "reset to auto" button or affordance.
- Not persisting `hasManuallyEdited` across page refreshes (intentional — refresh re-derives from player count).
- Not changing the floor protection on the server side.
- Not auto-recalculating on player **leave** (open question in the work item; leaving it out for now — the behavior is safe either way and can be added trivially later since the same `useEffect` dependency would cover it).

## Implementation Approach

Three discrete, independently testable steps: (1) extract constants and utility, (2) wire the utility into `GameSettingsPanel`, (3) add unit tests. The changes are additive — no existing behavior is removed until `hasManuallyEdited` is introduced.

---

## Phase 1: Constants and Utility Function

### Overview

Create `client/src/config.ts` with the target-word-count constant and clamp bounds, then create `client/src/utils/gameSettings.ts` with the pure `calculateDefaultWordsPerPlayer` function.

### Changes Required

#### 1. `client/src/config.ts` (new file)

```typescript
export const DEFAULT_TARGET_WORD_COUNT = 30
export const MIN_WORDS_PER_PLAYER = 3
export const MAX_WORDS_PER_PLAYER = 10
```

#### 2. `client/src/utils/gameSettings.ts` (new file)

```typescript
import { DEFAULT_TARGET_WORD_COUNT, MAX_WORDS_PER_PLAYER, MIN_WORDS_PER_PLAYER } from '../config'

export function calculateDefaultWordsPerPlayer(
  playerCount: number,
  targetTotal: number = DEFAULT_TARGET_WORD_COUNT,
): number {
  if (playerCount <= 0) return MIN_WORDS_PER_PLAYER
  return Math.min(MAX_WORDS_PER_PLAYER, Math.max(MIN_WORDS_PER_PLAYER, Math.round(targetTotal / playerCount)))
}
```

### Success Criteria

#### Automated Verification

- [x] TypeScript compiles with no errors: `npm run typecheck` (from `client/`) — pre-existing vitest type errors unrelated to this change
- [ ] Lint passes: `npm run lint` (from `client/`)

#### Manual Verification

- [x] `calculateDefaultWordsPerPlayer(6)` returns `5`
- [x] `calculateDefaultWordsPerPlayer(2)` returns `10`
- [x] `calculateDefaultWordsPerPlayer(12)` returns `3`

---

## Phase 2: Wire Auto-Calculation into GameSettingsPanel

### Overview

Add `players` prop to `GameSettingsPanel`, add `hasManuallyEdited` state, set it on `onChange`, add the auto-calc `useEffect`, and render the hint text.

### Changes Required

#### 1. `GameSettingsPanelProps` — add `players` prop (`LobbyPage.tsx:343–349`)

```typescript
type GameSettingsPanelProps = {
  settings: GameSettings
  players: Player[]       // <-- add
  isHost: boolean
  joinCode: string
  playerId: string
  onValidityChange: (valid: boolean) => void
}
```

The `Player` type is already imported from `@wordfetti/shared` in `LobbyPage.tsx`.

#### 2. `GameSettingsPanel` function signature and new state (`LobbyPage.tsx:351`)

Destructure the new prop and add `hasManuallyEdited` state:

```typescript
function GameSettingsPanel({ settings, players, isHost, joinCode, playerId, onValidityChange }: GameSettingsPanelProps) {
  const [wordsInput, setWordsInput] = useState(String(settings.wordsPerPlayer))
  const [timerInput, setTimerInput] = useState(String(settings.turnDurationSeconds))
  const [wordsError, setWordsError] = useState<string | null>(null)
  const [timerError, setTimerError] = useState<string | null>(null)
  const [hasManuallyEdited, setHasManuallyEdited] = useState(false)
  // ... rest unchanged
```

#### 3. Auto-calc `useEffect` — add after the existing sync effects (after `LobbyPage.tsx:363`)

```typescript
// Auto-calculate words-per-player when player count changes (unless host has manually edited)
useEffect(() => {
  if (hasManuallyEdited) return
  const newValue = calculateDefaultWordsPerPlayer(players.length)
  const maxSubmitted = players.reduce((max, p) => Math.max(max, p.wordCount), 0)
  if (newValue <= maxSubmitted) return
  if (newValue === settings.wordsPerPlayer) return
  setWordsInput(String(newValue))
  saveField('wordsPerPlayer', newValue)
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [players.length])
```

Note: `saveField` is defined inside the component. The `eslint-disable` comment is needed because `saveField` is not in the dep array — including it would recreate the effect on every render. An alternative is to hoist `saveField` to a `useCallback` (see Technical Notes).

#### 4. Mark `hasManuallyEdited` on user input change (`LobbyPage.tsx:431`)

```typescript
onChange={(e) => {
  setWordsInput(e.target.value)
  setHasManuallyEdited(true)
}}
```

#### 5. Hint text below the words input (after `LobbyPage.tsx:435`)

```tsx
{wordsError
  ? <p className="text-xs text-red-500">{wordsError}</p>
  : <p className="text-xs text-gray-400">
      {hasManuallyEdited
        ? 'Manually set — auto-calculation paused'
        : `Auto-calculated based on ${players.length} players`}
    </p>
}
```

#### 6. Pass `players` at the call site (`LobbyPage.tsx:147–154`)

```tsx
<GameSettingsPanel
  settings={game.settings}
  players={game.players}    // <-- add
  isHost={currentPlayerId === game.hostId}
  joinCode={joinCode!}
  playerId={currentPlayerId}
  onValidityChange={setSettingsValid}
/>
```

#### 7. Add import for `calculateDefaultWordsPerPlayer` at the top of `LobbyPage.tsx`

```typescript
import { calculateDefaultWordsPerPlayer } from '../utils/gameSettings'
```

### Success Criteria

#### Automated Verification

- [ ] TypeScript compiles with no errors: `npm run typecheck` (from `client/`)
- [ ] Lint passes: `npm run lint` (from `client/`)

#### Manual Verification

- [ ] Open lobby as host with 1 player — hint shows "Auto-calculated based on 1 players" and input shows 10
- [ ] Join a second player — input updates to 10 (still clamped) and hint remains auto
- [ ] Join players until count reaches 6 — input updates to 5
- [ ] Manually change input to 7 — hint immediately switches to "Manually set — auto-calculation paused"
- [ ] Join another player — input stays at 7, hint stays "Manually set"
- [ ] Refresh page — hint resets to "Auto-calculated" with the re-derived value
- [ ] In a lobby where one player has submitted 4 words, with a player count that would yield 3 — input is NOT auto-updated

---

## Phase 3: Unit Tests

### Overview

Create `client/src/utils/gameSettings.test.ts` covering all acceptance-criteria cases for `calculateDefaultWordsPerPlayer`.

### Changes Required

#### `client/src/utils/gameSettings.test.ts` (new file)

```typescript
import { describe, it, expect } from 'vitest'
import { calculateDefaultWordsPerPlayer } from './gameSettings'

describe('calculateDefaultWordsPerPlayer', () => {
  it('returns target result for normal player count (6 players → 5)', () => {
    expect(calculateDefaultWordsPerPlayer(6)).toBe(5)
  })

  it('clamps to min (12 players → 3)', () => {
    expect(calculateDefaultWordsPerPlayer(12)).toBe(3)
  })

  it('clamps to max (2 players → 10)', () => {
    expect(calculateDefaultWordsPerPlayer(2)).toBe(10)
  })

  it('rounds to nearest integer (7 players → 4, i.e. round(30/7) = round(4.28) = 4)', () => {
    expect(calculateDefaultWordsPerPlayer(7)).toBe(4)
  })

  it('rounds up at .5 (5 players → 6, i.e. round(30/5) = 6)', () => {
    expect(calculateDefaultWordsPerPlayer(5)).toBe(6)
  })

  it('respects custom targetTotal override', () => {
    expect(calculateDefaultWordsPerPlayer(5, 50)).toBe(10)
  })

  it('handles 0 players without throwing (returns MIN)', () => {
    expect(calculateDefaultWordsPerPlayer(0)).toBe(3)
  })
})
```

### Success Criteria

#### Automated Verification

- [ ] All unit tests pass: `npm run test` (from `client/`) — blocked by pre-existing missing dev deps (happy-dom, @testing-library/jest-dom)
- [x] TypeScript compiles with no errors: `npm run typecheck` (from `client/`) — pre-existing vitest type errors unrelated to this change

---

## Technical Notes

### Avoiding the `useEffect` dep-array lint warning

`saveField` is recreated on every render (it's a plain `async function` inside the component body). If included in the dep array of the auto-calc effect, the effect would fire on every render, not just on player-count changes. Two clean options:

**Option A (simpler)**: Keep the `eslint-disable-line` comment and document why.

**Option B (cleaner)**: Wrap `saveField` in `useCallback` with its own dep array (`[joinCode, playerId]`). The auto-calc effect can then include `saveField` in its deps without the lint escape. This is the preferred approach if the codebase ever enables the `exhaustive-deps` lint rule strictly.

For this implementation, Option A is fine given the current codebase conventions.

### SSE feedback loop is not a risk

The auto-calc effect calls `saveField`, which on success triggers a server SSE broadcast, which fires the sync `useEffect` at line 362 and sets `wordsInput` to `String(settings.wordsPerPlayer)`. Because the saved value is the same as what the auto-calc just set, this is a pure no-op with no visible side effect.

### The guard `if (newValue === settings.wordsPerPlayer) return`

This prevents a redundant PATCH when the player count changes but the rounded/clamped result happens to be the same number already stored on the server (e.g., going from 5 to 6 players when both yield the same clamped value). Without this guard, a PATCH would fire but no SSE would be broadcast (server would still 200, but it's wasted work).

## References

- Original work item: `meta/work/ENG-023-auto-calculate-words-per-player-default.md`
- `GameSettingsPanel` implementation: `client/src/pages/LobbyPage.tsx:351–453`
- Player type: `shared/src/types.ts:28–33`
- Server config (unchanged): `server/src/config.ts:6–9`
- Test pattern example: `client/src/hooks/useClockOffset.test.ts`
