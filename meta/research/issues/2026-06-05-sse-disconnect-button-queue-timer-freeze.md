---
type: issue-research
id: "2026-06-05-sse-disconnect-button-queue-timer-freeze"
title: "Investigation: SSE Disconnect Causes Button Queuing and Timer Freeze"
date: "2026-06-05T12:45:04+00:00"
author: "Anthony Scatchell"
producer: research-issue
status: complete
work_item_id: ""
topic: "During gameplay, buttons (Guessed/Skip) become unresponsive then fire all at once; timer pauses on certain devices"
tags: [research, debugging, sse, timer, gameplay, useGameState, TurnTimer, GamePage]
revision: "144308053e3862e32fd70e13836100ba41bda614"
repository: "wordfetti"
last_updated: "2026-06-05T12:45:04+00:00"
last_updated_by: "Anthony Scatchell"
schema_version: 1
---

# Investigation: SSE Disconnect Causes Button Queuing and Timer Freeze

**Date**: 2026-06-05T12:45:04+00:00
**Author**: Anthony Scatchell
**Git Commit**: 144308053e3862e32fd70e13836100ba41bda614
**Branch**: main
**Repository**: wordfetti

## Issue Description

During gameplay several players reported:

1. **Button queuing / all-at-once bursts**: The Guessed and Skip buttons on the clue-giver's device appeared to stop responding — tapping produced no visual feedback. Then suddenly all taps were reflected at once, causing multiple words to be marked guessed simultaneously.

2. **Timer freezing**: The circular countdown timer paused mid-turn. This was rare and device-specific, particularly observed on mobile devices that may have locked their screen or switched apps.

No server-side stacktrace or logs were available. The issue was described as behavioral.

## Input Classification

Vague (behavioral description) — no stacktrace, no logs.

## Affected Components

- `client/src/hooks/useGameState.ts:30-33` — Silent SSE error handler, no reconnect UI
- `client/src/pages/GamePage.tsx:265-283` — `callGameAction`: no optimistic update, buttons re-enable after each HTTP round-trip regardless of SSE health
- `client/src/pages/GamePage.tsx:332,338` — Buttons gated only on `loading || turnEnding`, no SSE staleness check
- `client/src/components/TurnTimer.tsx:11-13` — `initialRemainingTime` ignored after mount by `CountdownCircleTimer`
- `client/src/components/TurnTimer.tsx:19` — `isPlaying` always `true`, no visibility/wake handling
- `server/src/routes/games.ts:100-111` — SSE reconnect sends full authoritative snapshot (causes burst)
- `server/src/store/InMemoryGameStore.ts:60-64` — `notifyAndReturn` pushes SSE before returning HTTP response

## Timeline / Reproduction

1. Player's device loses SSE connection (screen lock, brief WiFi drop, app backgrounding).
2. `useGameState.ts:30-33` — `onerror` fires, silently logs to console. `game` state is left frozen at the last known snapshot. No UI change is visible.
3. Clue-giver taps "Guessed!" — `callGameAction` fires an HTTP POST. The server processes the guess and advances the hat word. The server broadcasts an SSE update, but the client isn't listening.
4. The POST response returns, `loading=false`, buttons re-enable. The screen still shows the old word (SSE hasn't reconnected yet), no visible feedback.
5. Player taps again (and again). Each tap is processed server-side.
6. SSE reconnects. `games.ts:110-111` sends a fresh full `GameSnapshot` reflecting all accumulated mutations.
7. Client receives single SSE message: word list jumps forward by 3, score increments by 3. From the user's perspective, "suddenly all guessed".

## Hypotheses

### Hypothesis 1: SSE Disconnect Causes Silent Button Queuing
- **Evidence for**:
  - `useGameState.ts:30-33`: `onerror` only calls `console.warn`, no state change, no UI error.
  - `GamePage.tsx:265-283`: `callGameAction` sets `loading=false` in `finally` after every HTTP response, re-enabling buttons regardless of SSE health.
  - `GamePage.tsx:274-277`: The HTTP response body (which contains the updated `GameSnapshot`) is discarded on success — state only updates via SSE.
  - `games.ts:110-111`: On reconnect, the server writes a fresh full snapshot — all accumulated changes arrive in one message.
  - `Game.ts:171-211`: `guessWord`/`skipWord` are pure mutations with no idempotency mechanism.
  - No debounce, no SSE-staleness gate on buttons, no request ID or deduplication.
- **Evidence against**:
  - The `loading` guard does block a second tap while the first fetch is in-flight, so two taps cannot be sent simultaneously — there must be one round-trip between duplicate taps.
  - On very brief drops (under one HTTP round-trip, ~100ms), the user may not even notice.
- **Verdict**: **Confirmed** — primary root cause of button queuing.

### Hypothesis 2: Timer Freezes Due to Device Sleep / Tab Backgrounding
- **Evidence for**:
  - `TurnTimer.tsx:19`: `isPlaying={true}` unconditionally; no pause/resume, no Page Visibility API hook.
  - `react-countdown-circle-timer` only reads `initialRemainingTime` at mount; subsequent prop updates are ignored.
  - The `key` prop (`clockOffsetReady ? 'synced' : 'unsynced'`) transitions exactly once per session — no mechanism to remount on wake.
  - No `visibilitychange` listener, no `document.hidden` usage anywhere in the codebase.
  - The plan doc `meta/plans/2026-05-17-ENG-022-server-synchronised-countdown-timer.md:34` explicitly acknowledges `CountdownCircleTimer` only reads `initialRemainingTime` at mount.
- **Evidence against**:
  - The `setInterval` expiry poller in `ClueGiverView` (`GamePage.tsx:242-262`) uses `Date.now()` wall-clock arithmetic — so turn-end _detection_ self-corrects on wake within 500ms. The turn will end correctly.
  - This is a visual display bug only; game logic (server-side turn end via `setTimeout` in `InMemoryGameStore.ts:168-175`) is not affected.
- **Verdict**: **Confirmed** — secondary cause, explains device-specific timer freezing.

### Hypothesis 3: Loading State Race — New Word Shown but Buttons Disabled
- **Evidence for**:
  - `InMemoryGameStore.ts:60-64`: `notifyAndReturn` pushes the SSE broadcast synchronously before returning the updated snapshot, so SSE bytes are in the TCP send buffer before the HTTP POST response bytes are.
  - `GamePage.tsx:227`: `loading` is local component state — React preserves it across re-renders triggered by new `game` props, so new word can appear while `loading=true`.
  - `GamePage.tsx:332,338`: Buttons are `disabled={loading || turnEnding}` — new word is shown but buttons remain disabled until `finally` fires.
- **Evidence against**:
  - The window is bounded by HTTP response latency. On LAN this may be imperceptible (<20ms). On mobile cellular it could reach 200–500ms.
  - This does not cause incorrect word counts or duplicated guesses — it is a UX freeze, not data corruption.
- **Verdict**: **Confirmed** — minor contributor; explains brief unresponsive moments even on healthy connections.

## Root Cause

**Primary (Hypothesis 1)**: The SSE and HTTP action layers are fully decoupled with no staleness guard. When SSE drops, `game` state silently freezes (no UI indicator), buttons re-enable after every HTTP round-trip, and each tap is independently processed by the server. On SSE reconnect the server sends one authoritative snapshot that collapses all accumulated changes — appearing as an instant multi-word jump.

**Secondary (Hypothesis 2)**: `TurnTimer` uses `react-countdown-circle-timer` with `isPlaying={true}` and no Page Visibility awareness. When a device sleeps or backgrounds the tab, the animation pauses and does not catch up on wake — the visual countdown is frozen at a stale value until the turn ends.

## Causal Chain

**For button queuing:**
1. Mobile device locks screen / WiFi drops momentarily — SSE TCP connection interrupted.
2. Browser `EventSource` enters reconnecting state. `onerror` fires, silently logged.
3. `game` state frozen at last known snapshot. UI unchanged (no indicator).
4. User taps "Guessed!" → HTTP POST fires → server advances hat word → SSE broadcast → client not connected.
5. POST response returns → `loading=false` → buttons re-enabled. Screen still shows old word.
6. User taps again (N times total), each processed server-side.
7. Browser reconnects SSE → server writes fresh `GameSnapshot` → all N guesses now visible at once.

**For timer freezing:**
1. Device screen locks or tab backgrounded mid-turn.
2. `requestAnimationFrame` (used by `CountdownCircleTimer`) pauses.
3. Device wakes — `CountdownCircleTimer` resumes from paused position, showing stale remaining time.
4. `setInterval` expiry poller wakes within 500ms, detects elapsed > duration, calls `POST /end-turn`.
5. Turn ends correctly; visual timer was wrong during the sleep window.

## Contributing Factors

- The HTTP response body from `/guess` and `/skip` contains the updated `GameSnapshot` but `callGameAction` discards it on success — so the client has a second path to fresh state it never uses.
- `CountdownCircleTimer`'s `initialRemainingTime` prop is computed correctly on every render, but the library ignores it after first mount — this is a known upstream limitation.
- The server-side fallback `setTimeout` in `InMemoryGameStore.ts:168-175` ensures turns end even if the client's interval poller fails, which is correct — but it means turn timing is resilient while the visual representation is not.

## Fix Options

| Option | Description | Risk | Effort |
|--------|-------------|------|--------|
| A | Apply HTTP response state directly in `callGameAction` | Low | Low |
| B | Add SSE reconnect indicator + disable buttons while stale | Low | Low |
| C | Add idempotency / dedup key per turn on guess/skip requests | Low | Med |
| D | Fix timer: use Page Visibility API to remount `TurnTimer` on wake | Low | Low |
| E | Fix timer: replace `CountdownCircleTimer` with a wall-clock interval | Low | Med |
| F | Switch from SSE to WebSockets with explicit ack and connection state | Med | High |

## Recommended Fix

**Ship Options A + B + D together** — they are independent, low-risk, and together address all three confirmed issues. Option C is deferred; A+B eliminate the motivation for duplicate taps, making C unnecessary unless future testing reveals edge cases.

**A — Apply HTTP response state in `callGameAction`** (`GamePage.tsx:274-277`):
After a successful POST, call `setGame(await response.json())` directly. The server already returns the full updated `GameSnapshot` in the HTTP response body for every guess/skip — currently `callGameAction` discards it on success and waits for SSE to deliver state. With this change, the HTTP channel itself carries the state update.

This helps even when SSE is completely dead: each tap produces an HTTP response containing the new game state (next word, updated scores), which is applied immediately. The user sees their action registered and the word change — they have no reason to tap again. When SSE reconnects it sends the authoritative snapshot, which will already be in sync.

```ts
const updated = await response.json() as GameSnapshot
setGame(updated)
```

This also eliminates the HTTP/SSE race (Hypothesis 3): state is applied from the HTTP response directly, so the new word and re-enabled buttons arrive together rather than in two separate events.

**B — Surface SSE disconnect and gate all actions on connectivity** (`useGameState.ts`, `GamePage.tsx`):
Add a `connected: boolean` derived from `onerror` / `onopen` events on the `EventSource`. Expose it from `useGameState`. In `GamePage.tsx`, when `connected` is `false`:
- Show a "Reconnecting..." banner
- Disable all action buttons (Guessed, Skip, Start Turn)

Additionally, gate the "Start Turn" button on connectivity: even when `turnPhase === 'ready'`, the clue-giver should not be able to begin a turn if their SSE connection is not confirmed live. Showing "Reconnecting..." in place of the Start Turn button prevents a player from entering a turn they cannot interact with or see the timer for — the scenario where they tap through a frozen screen with no feedback.

**D — Remount TurnTimer on page visibility change** (`GamePage.tsx`):
The Page Visibility API (`document.visibilitychange` event + `document.hidden` boolean) fires when the user switches apps, locks their screen, or returns to the tab. Browsers throttle or pause `requestAnimationFrame` (which `CountdownCircleTimer` uses internally) for invisible tabs, causing the visual timer to freeze during the hidden period and resume from the wrong position.

Hooking `visibilitychange` to increment a sequence counter forces `TurnTimer` to remount when the device returns to the foreground. The remount recomputes `initialRemainingTime` using wall-clock `Date.now()` against `turnStartedAt`, snapping the timer back to the correct remaining value:
```ts
// in GamePage, alongside clockOffsetReady key:
const [visibilitySeq, setVisibilitySeq] = useState(0)
useEffect(() => {
  const handler = () => { if (!document.hidden) setVisibilitySeq(s => s + 1) }
  document.addEventListener('visibilitychange', handler)
  return () => document.removeEventListener('visibilitychange', handler)
}, [])
// then: key={`${clockOffsetReady ? 'synced' : 'unsynced'}-${visibilitySeq}`}
```

**Option C (idempotency/dedup)**: Deferred. A+B remove the conditions that lead to duplicate taps, making C low priority. Revisit only if testing reveals server-side duplicate mutations slipping through.

**Option F (WebSockets)** would be a larger rearchitecture. The current SSE model is inherently one-way push, making it impossible to distinguish "SSE dropped" from "no events happening". WebSockets with explicit acks and a ping/pong health check would solve this more robustly, but the cost is high and Options A+B solve the primary problem for now.

## Prevention

- In real-time game UIs, **never** leave action buttons active during an undetected connection outage. Always surface reconnection state.
- When HTTP POST responses return the mutated resource, **apply them directly** to local state rather than waiting for the push channel — this removes the push channel as a single point of feedback.
- Timer components that depend on wall-clock accuracy must hook into the Page Visibility API to self-correct after device wake.
- Consider testing with Chrome DevTools Network throttling (Offline / Slow 3G) and the Page Visibility simulation to catch these classes of bug during development.

## Recent Changes

Relevant recent commits on affected files:

```
1443080 Separating timer out vs round end - end turn reasons - allows for differentiation
4a60a32 Allowing host to continue to additional rounds in the game, not just 3
0a0d93b Adding alarm sound to round end only on host device
6e548f7 Ensuring a server side fallback to end the turn if client doesn't
2b5f7b7 [ENG-022] Synchronise clocks across devices
```

Commit `6e548f7` added the server-side `setTimeout` fallback in `InMemoryGameStore.ts:168-175`, which addresses turn-end reliability but not the visual timer freeze. Commit `2b5f7b7` added clock sync and the `key` strategy for `TurnTimer`, which addressed initial clock drift but not wake-from-sleep drift.

## Open Questions

- Option C (idempotency/dedup) is deferred. If future testing shows duplicate guesses reaching the server despite A+B, a `turnStartedAt` echo from the client would let the server reject stale-turn requests cheaply.
- Is the server-side `setTimeout` fallback in `InMemoryGameStore.ts:168-175` sufficient for all turn-end scenarios, or could there be edge cases where both the client interval and the server timeout fire around the same time and cause a double `endTurn` call? (The server already guards this with the `turnPhase === 'active'` check, but worth a test.)
