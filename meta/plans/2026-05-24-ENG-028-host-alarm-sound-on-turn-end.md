---
date: "2026-05-24T00:00:00Z"
type: plan
skill: create-plan
work-item: ""
status: draft
---

# Host Alarm Sound on Turn End Implementation Plan

## Overview

Play a short alarm sound effect on the host's device whenever any player's turn ends. The host can stop the sound early by pressing a "Stop" button that appears only while the sound is playing. This avoids requiring every player to configure sound settings — only one device (the host's) needs to signal turn end.

## Current State Analysis

- Game state is broadcast to all clients via SSE. Every connected browser receives the full `GameSnapshot` on each change.
- `game.turnPhase` transitions from `'active'` → `'ready'` (normal turn end) or `'active'` → `undefined` (hat empties mid-turn, triggering a round end). Both are valid turn-end signals.
- Host detection: `currentPlayerId === game.hostId`. `hostId` is included in every `GameSnapshot`.
- `GamePage.tsx` already uses the ref-based previous-value pattern to detect transitions (`prevStatusRef`, lines 29 and 56–68). The same pattern applies here.
- The sound file `alarm-clock-sound-effect.mp3` currently lives in `client/dist/assets/sounds/`. Vite serves the `public/` directory during development and copies it into `dist/` on build — so the file must live in `client/public/assets/sounds/` to be accessible in both dev and prod.

## Desired End State

When any player's turn ends (timer expires or hat empties mid-turn), the host's browser:
1. Plays the alarm sound.
2. Shows a "Stop" button for the duration of playback.
3. Stops the sound (and hides the button) when the host clicks Stop OR when the audio finishes naturally.

Non-host players' devices are unaffected.

Verify by:
1. Starting a game as host.
2. Letting the turn timer run out — alarm plays on the host's browser; a Stop button appears.
3. Pressing Stop — sound halts immediately, button disappears.
4. Letting the alarm play to completion without pressing Stop — button disappears automatically.
5. Guessing the last word in the hat mid-turn — alarm plays on the host's browser.
6. Confirming the alarm does NOT play on a second browser logged in as a non-host player.

## Key Discoveries

- `GamePage.tsx:29` — `prevStatusRef` pattern is the established way to detect state transitions.
- `GamePage.tsx:128` — `isHost` computed inline; needs to be computed early (before early returns) so it can be passed to an unconditionally-called hook.
- `GamePage.tsx:200–226` — `ClueGiverView` handles the client-side turn timer; we do NOT hook into this for sound because the host may not be the clue giver.
- `shared/src/types.ts:51–67` — `GameSnapshot.turnPhase` is `'ready' | 'active' | undefined`.
- `client/vite.config.ts` — no `public` dir yet; Vite's default static asset dir is `public/` at the project root.

## What We're NOT Doing

- No per-player sound settings or mute toggles (enhancement for later).
- No volume control.
- No different sounds for different events (round end, hat empty, etc.).
- No sound on non-host devices.
- No preloading or Web Audio API — `new Audio(...).play()` is sufficient for a 6-second clip.
- Stop button is not visible to non-host players.

## Implementation Approach

1. Move the sound file into Vite's `public/` directory so it is served correctly in dev and prod.
2. Create a focused `useAlarmSound` hook that:
   - Detects the `turnPhase` transition and plays audio only on the host device.
   - Returns an `isPlaying` boolean and a `stop()` function so the caller can render a Stop button and wire it up.
   - Cleans up the `Audio` object on stop or natural end.
3. Wire the hook into `GamePage` — one call before all early returns; render the Stop button conditionally on `isHost && isPlaying`.

---

## Phase 1: Move Sound Asset to Correct Location

### Overview

Vite serves `client/public/` at the site root during dev and copies it to `dist/` on build. The file must live there, not directly in `dist/`.

### Changes Required

#### 1. Create `client/public/assets/sounds/` and move the file

```bash
mkdir -p client/public/assets/sounds
mv client/dist/assets/sounds/alarm-clock-sound-effect.mp3 client/public/assets/sounds/
```

The file will then be reachable at `/assets/sounds/alarm-clock-sound-effect.mp3`.

### Success Criteria

#### Automated Verification

- [x] `ls client/public/assets/sounds/alarm-clock-sound-effect.mp3` exits 0
- [x] `ls client/dist/assets/sounds/` does not contain the mp3 (no stale copy)

#### Manual Verification

- [ ] `pnpm dev` → navigate to `/assets/sounds/alarm-clock-sound-effect.mp3` in browser → audio file downloads/plays

---

## Phase 2: `useAlarmSound` Hook

### Overview

A hook that watches `turnPhase`, keeps a ref of the previous value, and on a valid turn-end transition plays the sound file and exposes `isPlaying` + `stop` to the caller.

### Changes Required

#### 1. Create `client/src/hooks/useAlarmSound.ts`

**File**: `client/src/hooks/useAlarmSound.ts`

```typescript
import { useCallback, useEffect, useRef, useState } from 'react'

export function useAlarmSound(isHost: boolean, turnPhase: string | undefined) {
  const prevTurnPhaseRef = useRef<string | undefined>(undefined)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    setIsPlaying(false)
  }, [])

  useEffect(() => {
    if (isHost && prevTurnPhaseRef.current === 'active' && turnPhase !== 'active') {
      const audio = new Audio('/assets/sounds/alarm-clock-sound-effect.mp3')
      audioRef.current = audio
      setIsPlaying(true)
      audio.play().catch(() => {
        audioRef.current = null
        setIsPlaying(false)
      })
      audio.addEventListener('ended', () => {
        audioRef.current = null
        setIsPlaying(false)
      })
    }
    if (turnPhase !== undefined) {
      prevTurnPhaseRef.current = turnPhase
    }
  }, [isHost, turnPhase])

  // Clean up if the component unmounts while audio is playing
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
    }
  }, [])

  return { isPlaying, stop }
}
```

**Notes on the logic:**
- `prevTurnPhaseRef` starts as `undefined`, so no false positive on initial render.
- `turnPhase !== undefined` guard on the ref update prevents a reconnect/null-game moment from clearing the ref and masking a future transition.
- `.catch(() => {})` silences browser autoplay policy errors.
- `'ended'` event ensures `isPlaying` goes false when audio finishes naturally.
- Unmount cleanup prevents a dangling audio source if the user navigates away mid-alarm.

### Success Criteria

#### Automated Verification

- [x] TypeScript compiles: `pnpm --filter client build` (or `pnpm typecheck`)
- [x] Existing tests pass: `pnpm test`

#### Manual Verification

- [x] Hook file exists at `client/src/hooks/useAlarmSound.ts`

---

## Phase 3: Wire Hook into `GamePage` with Stop Button

### Overview

Call `useAlarmSound` unconditionally in `GamePage` (React requires hooks to be called in the same order on every render — before any early returns). Render a Stop button overlay whenever `isHost && isPlaying`.

### Changes Required

#### 1. Update `client/src/pages/GamePage.tsx`

**Import the hook** (add to existing imports at top of file):

```typescript
import { useAlarmSound } from '../hooks/useAlarmSound'
```

**Compute `isHost` early** — add directly after the `currentPlayerId` computation (around line 27), before `prevStatusRef`:

```typescript
const isHost = currentPlayerId !== null && currentPlayerId === game?.hostId
```

Remove or consolidate the two inline `const isHost = ...` declarations at lines 89 and 128 — replace each with just `isHost` (the variable is now in scope from the top of the component).

**Call the hook** — add after the `isHost` declaration, before any `useEffect` calls:

```typescript
const { isPlaying: alarmPlaying, stop: stopAlarm } = useAlarmSound(isHost, game?.turnPhase)
```

**Render the Stop button** — add a fixed-position overlay inside the outermost `<div>` of both the `between_rounds` return and the main in-progress return, after the `<Logo />`:

```tsx
{alarmPlaying && (
  <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50">
    <button
      onClick={stopAlarm}
      className="rounded-full bg-red-600 px-6 py-3 text-white font-semibold shadow-lg hover:bg-red-700 active:scale-95 transition-all"
    >
      Stop alarm
    </button>
  </div>
)}
```

Position this as a fixed overlay so it floats above all game UI regardless of which view (clue giver, guesser, spectator, between rounds) is currently showing.

### Success Criteria

#### Automated Verification

- [x] TypeScript compiles without errors: `pnpm --filter client build`
- [x] Tests pass: `pnpm test`

#### Manual Verification

- [ ] Host device: alarm plays when the clue-giver's timer runs out (host is clue giver)
- [ ] Host device: alarm plays when the clue-giver's timer runs out (host is NOT clue giver — spectator or guesser role)
- [ ] Host device: alarm plays when the hat empties mid-turn
- [ ] Host device: Stop button appears while alarm is playing
- [ ] Host device: pressing Stop halts audio immediately and hides the button
- [ ] Host device: letting alarm finish naturally hides the button without pressing Stop
- [ ] Non-host device: no sound and no Stop button in any of the above scenarios
- [ ] No console errors related to audio

---

## Testing Strategy

### Manual Testing Steps

1. Open two browser tabs: Tab A = host, Tab B = a second player on a different team.
2. Start a game. Note Tab A is the host.
3. Let a turn run to natural timer expiry — confirm alarm sound and Stop button appear only in Tab A.
4. Press Stop in Tab A — confirm audio halts and button disappears immediately.
5. Let the next turn's alarm play to completion without pressing Stop — confirm button disappears on its own.
6. Guess enough words to empty the hat mid-turn — confirm alarm plays in Tab A.
7. Confirm Tab B has no sound and no Stop button throughout.

## Performance Considerations

`new Audio(...)` is created on each turn end (roughly once per 60 seconds of gameplay). This is negligible — no preloading or pooling needed for a 6-second clip.

## References

- Sound file: `client/public/assets/sounds/alarm-clock-sound-effect.mp3` (after move)
- Turn phase transitions: `server/src/store/Game.ts:113` (`endTurn`), `Game.ts:175` (`guessWord` hat-empty path)
- Existing transition detection pattern: `GamePage.tsx:29–68` (`prevStatusRef`)
- Host detection: `GamePage.tsx:128`, `shared/src/types.ts:57` (`hostId`)
