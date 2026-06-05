---
type: plan
id: "2026-06-05-e2e-happy-path-test"
title: "E2E Happy Path Test Implementation Plan"
date: "2026-06-05T13:32:51+00:00"
author: "Anthony Scatchell"
producer: create-plan
status: draft
work_item_id: ""
parent: ""
reviewer: ""
tags: ["testing", "e2e", "playwright"]
revision: "aec134ddf50026380ce03328d0b1c9fdf68a670f"
repository: "wordfetti"
last_updated: "2026-06-05T13:32:51+00:00"
last_updated_by: "Anthony Scatchell"
schema_version: 1
---

# E2E Happy Path Test Implementation Plan

## Overview

Add a Playwright end-to-end test that drives four separate browser contexts through one complete game — from lobby join through to the stats page — verifying the core happy path and both turn-end conditions (timer expiry and hat empty).

## Current State Analysis

- No E2E framework exists. The project has unit/integration tests via Vitest (`client/` and `server/`), and a manual bot script (`scripts/test-driver.ts`) for live game exploration.
- Tech stack: React + Vite (port 5173) + Express (port 3000), real-time via SSE (no WebSocket). Sessions are stored in `localStorage` under the key `wordfetti_session` as `{ playerId, joinCode }`.
- The client-side timer fires `POST /end-turn` after `turnDurationSeconds` seconds. This runs inside the browser page (a `setInterval` in `ClueGiverView`), so the clue-giver's Playwright page must remain active during a timed turn.
- The auto word-calculation in `LobbyPage` patches `wordsPerPlayer` when ≥4 players have joined — but only when `wordsPerPlayerManuallySet` is falsy. The test must set `wordsPerPlayerManuallySet: true` **before** any other players join (i.e., immediately after `createGame`), not just before navigating to the lobby. This prevents a race where the host's page renders the lobby and the auto-calc fires in the same render cycle as the 4th player joining.
- Key button text from the current UI: **"Start Game"** (lobby), **"Start Turn"** (ready phase), **"Guessed!"** and **"Skip"** (active phase), **"Start Round N"** (between-rounds host), **"End Game"** (awaiting-extra-round host), **"View stats"** (results page).

## Desired End State

Running `pnpm e2e` (or `pnpm --filter e2e test`) against a locally running dev stack produces a green test that:

1. Creates a game and has 4 players (2 per team) join from separate browser contexts.
2. Starts the game from the lobby UI.
3. Plays through 3 rounds using controlled turn actions — at least one turn ends via timer expiry (`turnEndReason === 'timeout'`) and at least one ends via an empty hat (`turnEndReason === 'round_complete'`).
4. Navigates host through round-transition screens for Rounds 2 and 3.
5. Ends the game from the `awaiting_extra_round_decision` screen.
6. Verifies all four contexts land on the results page showing "Game Over!" and a combined score of 12.
7. Verifies the stats page loads and shows the "Game Stats" heading plus the "Words submitted" section.

### Verification command

```bash
pnpm --filter e2e test
```

## What We're NOT Doing

- **Specific stat assertions** — no checks on word difficulty, best clue giver counts, duplications, or guess timing.
- **Extra/bonus rounds** — the test ends the game after Round 3.
- **Error and edge-case flows** — name conflicts, insufficient players, rejoining after disconnect, etc.
- **Word entry UI** — words are submitted via API in setup to keep the test focused on the game loop.
- **Full score prediction** — starting team is randomly chosen by the server; we assert the total (`team1 + team2 === 12`) not individual team scores.
- **Replacing or modifying existing unit/integration tests.**

## Implementation Approach

**Tool choice: Playwright** (`@playwright/test`). The existing zombie script shows the API shape well and confirms SSE-based state propagation. Playwright gives us four isolated browser contexts (separate `localStorage`), real JavaScript execution (required for the client-side timer), and reliable `page.getByRole` selectors against the existing button text.

**Setup strategy: API-first, UI for game actions.** Joining, settings changes, and word submission are done via direct HTTP calls in the test process (calling `localhost:3000` directly — no proxy needed). This keeps the fragile setup steps fast and deterministic. UI interactions start from the lobby page and cover all in-game actions.

**State polling:** After each API call or UI action that mutates game state, the test polls `GET /api/games/:joinCode` (from the test process, not the browser) until the expected state predicate is met. This is simpler than attempting to observe SSE events in Node.js test code.

**Designed game flow (controlled, predictable):**

| Turn | Who acts | Action | Expected end reason |
|------|----------|--------|---------------------|
| Round 1, Turn 1 | Team A clue giver | Click Skip once, then wait | `timeout` ✓ |
| Round 1, Turn 2 | Team B clue giver | Guess all 4 words | `round_complete` ✓ |
| Round 2, Turn 1 | Team A clue giver | Guess all 4 words | `round_complete` |
| Round 3, Turn 1 | Team B clue giver | Guess all 4 words | `round_complete` |

`advanceRound()` swaps `activeTeam`, so rounds 2 and 3 each start with one turn finishing the hat.  
Total guesses: 4 + 4 + 4 = **12** — this is the score assertion.

Settings: `wordsPerPlayer=1, turnDurationSeconds=3` (set via API before any page navigates to the lobby).

---

## Phase 1: Infrastructure Setup

### Overview

Add Playwright as a new `e2e` workspace package and wire it into the root scripts.

### Changes Required

#### 1. `pnpm-workspace.yaml`

**File:** `pnpm-workspace.yaml`  
**Change:** add `e2e` to the packages list.

```yaml
packages:
  - client
  - server
  - shared
  - e2e
```

#### 2. `e2e/package.json`

**File:** `e2e/package.json` (new file)

```json
{
  "name": "@wordfetti/e2e",
  "private": true,
  "scripts": {
    "test": "playwright test",
    "test:ui": "playwright test --ui"
  },
  "devDependencies": {
    "@playwright/test": "^1.44.0"
  }
}
```

#### 3. `e2e/playwright.config.ts`

**File:** `e2e/playwright.config.ts` (new file)

```typescript
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
})
```

> **Note:** The config does not use `webServer` — the test requires the dev stack to already be running (`pnpm dev`). CI can start `pnpm dev` in the background before running `pnpm --filter e2e test`.

#### 4. Root `package.json`

**File:** `package.json`  
**Change:** add an `e2e` script alongside the existing `test` script.

```json
"e2e": "pnpm --filter e2e test"
```

### Success Criteria

#### Automated Verification

- [ ] `pnpm install` completes cleanly with `e2e` workspace included
- [ ] `pnpm --filter e2e test -- --list` prints the test file path (no import errors)

---

## Phase 2: Test Helpers

### Overview

Two small helper modules: an API client that calls `localhost:3000` directly, and a session injector that plants `wordfetti_session` into a browser context's localStorage before any page is opened.

### Changes Required

#### 1. `e2e/helpers/api.ts`

**File:** `e2e/helpers/api.ts` (new file)

Typed wrappers around `fetch` against `http://localhost:3000`.

```typescript
import type { GameSnapshot, GameSettings } from '@wordfetti/shared'

const BASE = 'http://localhost:3000'

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${method} ${path} → ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

export async function createGame(hostName: string, team: 1 | 2) {
  return request<{ joinCode: string; player: { id: string; name: string; team: number } }>(
    'POST', '/api/games', { name: hostName, team }
  )
}

export async function joinGame(joinCode: string, name: string, team: 1 | 2) {
  return request<{ player: { id: string; name: string; team: number } }>(
    'POST', `/api/games/${joinCode}/players`, { name, team }
  )
}

export async function patchSettings(joinCode: string, playerId: string, settings: Partial<GameSettings> & { wordsPerPlayerManuallySet?: boolean }) {
  return request('PATCH', `/api/games/${joinCode}/settings`, { playerId, ...settings })
}

export async function submitWord(joinCode: string, playerId: string, text: string) {
  return request('POST', `/api/games/${joinCode}/words`, { playerId, text })
}

export async function getGame(joinCode: string): Promise<GameSnapshot> {
  return request<GameSnapshot>('GET', `/api/games/${joinCode}`)
}

export async function pollGame(
  joinCode: string,
  predicate: (g: GameSnapshot) => boolean,
  timeoutMs = 15_000,
): Promise<GameSnapshot> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const g = await getGame(joinCode)
    if (predicate(g)) return g
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`pollGame timed out after ${timeoutMs}ms`)
}
```

#### 2. `e2e/helpers/session.ts`

**File:** `e2e/helpers/session.ts` (new file)

```typescript
import type { BrowserContext } from '@playwright/test'

export async function injectSession(
  context: BrowserContext,
  joinCode: string,
  playerId: string,
): Promise<void> {
  await context.addInitScript(
    ({ key, value }) => localStorage.setItem(key, value),
    { key: 'wordfetti_session', value: JSON.stringify({ joinCode, playerId }) },
  )
}
```

### Success Criteria

#### Automated Verification

- [ ] TypeScript compiles without errors: `cd e2e && npx tsc --noEmit`

---

## Phase 3: Happy Path Test

### Overview

A single Playwright test that drives four browser contexts through a complete 3-round game. The test is the source of truth for the game flow described in the Implementation Approach section.

### Changes Required

#### 1. `e2e/tests/happy-path.spec.ts`

**File:** `e2e/tests/happy-path.spec.ts` (new file)

```typescript
import { test, expect, Browser, BrowserContext, Page } from '@playwright/test'
import {
  createGame,
  joinGame,
  patchSettings,
  submitWord,
  getGame,
  pollGame,
} from '../helpers/api'
import { injectSession } from '../helpers/session'
import type { GameSnapshot } from '@wordfetti/shared'

// Maps playerId → { context, page } so the test can find the right page to act on.
type PlayerHandle = { context: BrowserContext; page: Page; id: string }

async function makeContext(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext()
  const page = await context.newPage()
  return { context, page }
}

// Drive one full turn: click Start Turn on the clue-giver's page, optionally skip
// or guess-all, then wait for the turn phase to leave 'active'.
async function playTurn(
  joinCode: string,
  handles: PlayerHandle[],
  action: 'skip-wait-timer' | 'guess-all',
): Promise<GameSnapshot> {
  const game = await getGame(joinCode)
  const cgId = game.currentClueGiverId!
  const cg = handles.find(h => h.id === cgId)!

  // Bring the clue-giver's page to front so JavaScript timers aren't throttled.
  await cg.page.bringToFront()

  // Click Start Turn on the clue-giver's page.
  await cg.page.getByRole('button', { name: 'Start Turn' }).click()
  await pollGame(joinCode, g => g.turnPhase === 'active')

  if (action === 'skip-wait-timer') {
    // Click Skip once to exercise that path, then let the timer fire end-turn.
    await cg.page.getByRole('button', { name: 'Skip' }).click()
    // Timer is 3 s; poll with generous timeout.
    return pollGame(joinCode, g => g.turnPhase === 'ready' || g.status === 'between_rounds', 12_000)
  }

  // guess-all: click Guessed! until the turn ends.
  while (true) {
    const g = await getGame(joinCode)
    if (g.turnPhase !== 'active' || !g.currentWord) break
    await cg.page.getByRole('button', { name: 'Guessed!' }).click()
    await new Promise(r => setTimeout(r, 150))
  }
  return pollGame(joinCode, g => g.status === 'between_rounds' || g.status === 'awaiting_extra_round_decision', 8_000)
}

test('4-player happy path — 3 rounds, results and stats', async ({ browser }) => {
  // ── Setup: create 4 contexts ──────────────────────────────────────────────
  const h1 = await makeContext(browser) // host (team 1)
  const h2 = await makeContext(browser) // player 2 (team 1)
  const h3 = await makeContext(browser) // player 3 (team 2)
  const h4 = await makeContext(browser) // player 4 (team 2)

  try {
    // ── Create game and lock settings BEFORE other players join ─────────────
    // Critical ordering: patchSettings (with wordsPerPlayerManuallySet: true) must
    // happen before players 2-4 join. The lobby's auto-calc useEffect fires when
    // players.length reaches 4 and hasManuallyEdited is false. If the host's page
    // is on the lobby when that SSE arrives, it would override wordsPerPlayer back
    // to 7. Marking it manually-edited first — when only 1 player exists — ensures
    // the guard is in place for every subsequent player join, regardless of when
    // any browser context navigates to the lobby.
    const { joinCode, player: p1 } = await createGame('Alice', 1)
    await patchSettings(joinCode, p1.id, {
      wordsPerPlayer: 1,
      turnDurationSeconds: 3,
      wordsPerPlayerManuallySet: true,
    })

    const { player: p2 } = await joinGame(joinCode, 'Bob', 1)
    const { player: p3 } = await joinGame(joinCode, 'Carol', 2)
    const { player: p4 } = await joinGame(joinCode, 'Dave', 2)

    const handles: PlayerHandle[] = [
      { ...h1, id: p1.id },
      { ...h2, id: p2.id },
      { ...h3, id: p3.id },
      { ...h4, id: p4.id },
    ]

    // Inject sessions before any page navigation.
    await injectSession(h1.context, joinCode, p1.id)
    await injectSession(h2.context, joinCode, p2.id)
    await injectSession(h3.context, joinCode, p3.id)
    await injectSession(h4.context, joinCode, p4.id)

    // ── Word submission via API ───────────────────────────────────────────────
    await submitWord(joinCode, p1.id, 'apple')
    await submitWord(joinCode, p2.id, 'banana')
    await submitWord(joinCode, p3.id, 'cherry')
    await submitWord(joinCode, p4.id, 'dragon')

    // ── Lobby: navigate all pages, then host starts the game ──────────────────
    await Promise.all(handles.map(h => h.page.goto(`/lobby/${joinCode}`)))

    // All 4 players visible in the lobby
    await expect(h1.page.getByText('Alice')).toBeVisible()
    await expect(h1.page.getByText('Bob')).toBeVisible()
    await expect(h1.page.getByText('Carol')).toBeVisible()
    await expect(h1.page.getByText('Dave')).toBeVisible()

    // Host starts the game
    await h1.page.getByRole('button', { name: 'Start Game' }).click()
    await pollGame(joinCode, g => g.status === 'in_progress')

    // Navigate all pages to the game route
    await Promise.all(handles.map(h => h.page.goto(`/game/${joinCode}`)))

    // ── Round 1: Turn 1 — skip once then wait for timer ───────────────────────
    await playTurn(joinCode, handles, 'skip-wait-timer')
    const afterT1 = await getGame(joinCode)
    expect(afterT1.turnEndReason).toBe('timeout')
    expect(afterT1.status).toBe('in_progress')
    expect(afterT1.round).toBe(1)

    // ── Round 1: Turn 2 — guess all words (hat empties, round ends) ───────────
    await playTurn(joinCode, handles, 'guess-all')
    const afterR1 = await getGame(joinCode)
    expect(afterR1.status).toBe('between_rounds')
    expect(afterR1.turnEndReason).toBe('round_complete')
    expect(afterR1.round).toBe(1)

    // Non-host sees waiting message
    await expect(h2.page.getByText(/waiting for the host/i)).toBeVisible()

    // ── Round transition 1 → 2 ────────────────────────────────────────────────
    // Ensure host page is on the game route showing between_rounds UI.
    await h1.page.goto(`/game/${joinCode}`)
    await expect(h1.page.getByText('Round 1 is over!')).toBeVisible()
    await h1.page.getByRole('button', { name: 'Start Round 2' }).click()
    await pollGame(joinCode, g => g.status === 'in_progress' && g.round === 2)

    // ── Round 2: one turn guesses all words ────────────────────────────────────
    await playTurn(joinCode, handles, 'guess-all')
    const afterR2 = await getGame(joinCode)
    expect(afterR2.status).toBe('between_rounds')
    expect(afterR2.round).toBe(2)

    // ── Round transition 2 → 3 ────────────────────────────────────────────────
    await h1.page.goto(`/game/${joinCode}`)
    await h1.page.getByRole('button', { name: 'Start Round 3' }).click()
    await pollGame(joinCode, g => g.status === 'in_progress' && g.round === 3)

    // ── Round 3: one turn guesses all words, game ends ────────────────────────
    await playTurn(joinCode, handles, 'guess-all')
    await pollGame(joinCode, g => g.status === 'awaiting_extra_round_decision')

    // Host ends the game (no extra round)
    await h1.page.goto(`/game/${joinCode}`)
    await h1.page.getByRole('button', { name: 'End Game' }).click()
    await pollGame(joinCode, g => g.status === 'finished')

    // ── Results page ──────────────────────────────────────────────────────────
    await Promise.all(handles.map(h => h.page.goto(`/game/${joinCode}/results`)))
    for (const h of handles) {
      await expect(h.page.getByText('Game Over!')).toBeVisible()
    }

    // 1 word × 4 players × 3 rounds = 12 total points
    const finalGame = await getGame(joinCode)
    const { team1, team2 } = finalGame.scores!
    expect(team1 + team2).toBe(12)
    expect(team1).toBeGreaterThan(0)
    expect(team2).toBeGreaterThan(0)

    // ── Stats page ────────────────────────────────────────────────────────────
    await h1.page.getByRole('button', { name: 'View stats' }).click()
    await expect(h1.page.getByText('Game Stats')).toBeVisible()
    // Words submitted section shows each player's submitted word
    await expect(h1.page.getByText('Alice')).toBeVisible()
    await expect(h1.page.getByText('apple')).toBeVisible()

  } finally {
    await Promise.all([h1.context.close(), h2.context.close(), h3.context.close(), h4.context.close()])
  }
})
```

### Success Criteria

#### Automated Verification

- [ ] `pnpm install` resolves `@playwright/test` in the `e2e` workspace
- [ ] `pnpm --filter e2e exec playwright install chromium` installs the browser binary
- [ ] With `pnpm dev` running in another terminal: `pnpm --filter e2e test` exits 0
- [ ] Test output shows all 4 players in the lobby, correct `turnEndReason` assertions, and `team1 + team2 === 12`

#### Manual Verification

- [ ] Run with `--headed` flag (`pnpm --filter e2e test -- --headed`) and visually confirm lobby shows all players before start
- [ ] Confirm the "Skip" click in Round 1 Turn 1 is visible in browser, and ~3 seconds later the turn advances
- [ ] Confirm "Start Round 2" and "Start Round 3" buttons appear and advance the round
- [ ] Confirm results page shows "Game Over!" with non-zero scores for both teams
- [ ] Confirm stats page shows all 4 player names and their words

---

## Testing Strategy

### Notes on Timer Reliability

The client-side timer (`ClueGiverView`'s `setInterval`) runs in the clue-giver's browser page. Playwright runs real Chromium — the timer fires naturally. The `bringToFront()` call before starting a timed turn prevents the browser's background tab throttling from delaying the 500ms interval.

With `turnDurationSeconds=3` and a server-side fallback timer (`turnDurationSeconds * 1000 + 500ms`), the worst case for the skip-turn is roughly 4 seconds before the turn advances.

The `pollGame` calls in `playTurn` use a 12-second timeout for the skip-wait-timer case specifically, and 8 seconds for guess-all cases.

### Adding Tests Later

When adding non-happy-path tests (disconnect recovery, insufficient players, name conflicts), the API helpers in `e2e/helpers/api.ts` are reusable. New test files can live under `e2e/tests/`.

## Migration Notes

No database or persistent state to migrate. The in-memory server is reset on each server restart, so test isolation is guaranteed by running each test against a fresh server process.

## References

- Zombie bot script (game flow reference): `scripts/test-driver.ts`
- Client-side timer logic: `client/src/pages/GamePage.tsx:263-289`
- Session storage format: `client/src/session.ts`
- Auto word-calc (wordsPerPlayerManuallySet guard): `client/src/pages/LobbyPage.tsx:498-510`
- Server settings PATCH handler: `server/src/routes/games.ts:482-522`
- Turn end reason type: `shared/src/types.ts` (`turnEndReason?: 'timeout' | 'round_complete'`)
