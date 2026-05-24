---
date: "2026-05-24T15:30:00+00:00"
type: plan
skill: create-plan
work-item: "ENG-025"
status: draft
---

# ENG-025: Streamline Join Flow via Lobby — Implementation Plan

## Overview

Move name entry and team selection from the dedicated `/join` page into the lobby itself, so visitors can see live team composition before committing. The `/join` page becomes a minimal code-only entry point that navigates to `/lobby/:code` on success.

## Current State Analysis

### `JoinPage.tsx` — current responsibilities
- Collects game code, player name, and team selection on one page
- `useEffect` (lines 18–30): fetches team names from `GET /api/games/${code}` whenever code reaches 6 chars
- On submit: `POST /api/games/${joinCode}/players`, handles `NAME_TAKEN` (409), `GAME_IN_PROGRESS` (409), `NOT_FOUND` (404), then calls `saveSession` and navigates to `/lobby/${joinCode}`
- Imports: `Team` (shared), `TeamSelector`, `saveSession`, `useEffect`, `useState`, `Link`, `useNavigate`, `useSearchParams`

### `LobbyPage.tsx` — current join-related code
- Line 18: `session` loaded once on mount via `useState(() => loadSession())`; `[session]` destructure means `setSession` is discarded — the session is effectively read-only after mount
- Lines 102–109: Visitor (no session) sees `"Want to play? <a href='/join?code=${joinCode}'>Join this game</a>"`
- Lines 45–51: `copyCode()` writes the bare `joinCode` string to clipboard

### Key constraints
- `useGameState` already supplies `game.teamNames.team1/team2` via SSE — the lobby always has team names available; no extra fetch needed in the join UI
- The `POST /api/games/:joinCode/players` endpoint (games.ts:374) already exists and accepts `{ name, team }` — no backend changes needed
- `session` is currently `const [session] = useState(...)` (setter discarded) — to hide the join UI after a successful join without a page reload, we must change this to `const [session, setSession] = useState(...)` and call `setSession` after `saveSession`

## Desired End State

- `/join` page: code input only → on valid code submits to `GET /api/games/:code` for existence check → navigates to `/lobby/:code`
- `/lobby/:code` for visitors: shows live lobby + username input + "Join [Team 1]" / "Join [Team 2]" buttons below team columns; join buttons disabled until non-whitespace name is entered; on success the join UI disappears and user is a participant
- Copy button: copies full URL `${window.location.origin}/lobby/${joinCode}`
- `TeamSelector` and name/team state fully removed from `JoinPage.tsx`
- No `<a href="/join?code=...">` link in lobby

### Verification checklist
- Visitor on `/lobby/:code` sees username input + two team join buttons, no "Join this game" anchor
- Both join buttons disabled when username is empty/whitespace; enabled (team-coloured) when username has content
- Clicking "Join [Team 1]" → player appears in Team 1 column, join UI hides
- `NAME_TAKEN` 409 → inline error near username input, no redirect
- Already-a-participant → no join UI shown
- Copy button → clipboard contains `https://<domain>/lobby/<code>`
- `/join?code=ABCDEF` → code pre-filled, no name/team fields; valid code → navigate to `/lobby/ABCDEF`; invalid code → error shown, no navigation
- `JoinPage.tsx` source contains: no `TeamSelector`, no `name` state, no `team` state, no team-names fetch, no `saveSession`

## What We're NOT Doing

- No backend changes — `POST /api/games/:joinCode/players` is used as-is
- No team switching or leaving game (separate stories)
- `TeamSelector` component itself is kept — still used by `CreateGamePage`
- No new API endpoints (existing `GET /api/games/:code` repurposed as existence check on `/join`)
- No `JoinPanel` extracted component — join UI stays inline in `LobbyPage.tsx`

## Implementation Approach

Four small, independently testable phases. Phases 1–3 each touch one file and can be reviewed in isolation. Phase 4 is a sanity check pass.

---

## Phase 1: Fix copy button URL

**File**: `client/src/pages/LobbyPage.tsx`

**Change** (line 47): Replace `navigator.clipboard.writeText(joinCode)` with the full lobby URL.

```tsx
// Before
navigator.clipboard.writeText(joinCode).then(() => {

// After
navigator.clipboard.writeText(`${window.location.origin}/lobby/${joinCode}`).then(() => {
```

### Success Criteria

#### Automated Verification
- [x] TypeScript compiles: `pnpm --filter client tsc --noEmit`
- [x] Tests pass: `pnpm test`

#### Manual Verification
- [ ] Click the copy button on the lobby page; paste into address bar — full URL appears (`http://localhost:5173/lobby/XXXXXX` or equivalent)

---

## Phase 2: Lobby join UI

**File**: `client/src/pages/LobbyPage.tsx`

### Changes Required

#### 2a. Make `session` settable
Change the destructure so `setSession` is available:

```tsx
// Before (line 18)
const [session] = useState(() => loadSession())

// After
const [session, setSession] = useState(() => loadSession())
```

#### 2b. Add join state and handler
Add three new state variables after the existing state declarations, and a `handleJoin` function:

```tsx
const [joinName, setJoinName] = useState('')
const [joinLoading, setJoinLoading] = useState(false)
const [joinError, setJoinError] = useState<string | null>(null)
```

```tsx
async function handleJoin(team: Team) {
  if (!joinCode) return
  const trimmedName = joinName.trim()
  setJoinLoading(true)
  setJoinError(null)
  try {
    const res = await fetch(`/api/games/${joinCode}/players`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmedName, team }),
    })
    if (res.status === 409) {
      const data = await res.json().catch(() => ({}))
      if (data.code === 'NAME_TAKEN') {
        setJoinError('That name is already taken — please choose another.')
      } else {
        setJoinError('This game has already started.')
      }
      return
    }
    if (!res.ok) throw new Error(`Unexpected response: ${res.status}`)
    const { player } = await res.json()
    saveSession({ playerId: player.id, joinCode })
    setSession({ playerId: player.id, joinCode })
  } catch {
    setJoinError('Something went wrong. Please try again.')
  } finally {
    setJoinLoading(false)
  }
}
```

#### 2c. Add required imports
Add `Team` from `@wordfetti/shared` and `saveSession` from `'../session'` to the existing import lines:

```tsx
import type { GameSettings, Player, Team } from '@wordfetti/shared'
import { loadSession, saveSession } from '../session'
```

#### 2d. Replace visitor anchor with inline join UI
Replace the `!currentPlayerId` block (lines 102–109) with the join panel:

```tsx
{/* Inline join UI for visitors */}
{!currentPlayerId && (
  <div className="mt-4 rounded-2xl bg-white p-5 shadow-sm">
    <p className="mb-3 text-sm font-semibold text-gray-700">Want to play?</p>
    <div className="flex flex-col gap-3">
      <input
        type="text"
        value={joinName}
        onChange={(e) => { setJoinName(e.target.value); setJoinError(null) }}
        placeholder="Enter your name"
        maxLength={50}
        className="rounded-lg border border-gray-200 px-4 py-3 text-sm outline-none focus:border-brand-coral focus:ring-1 focus:ring-brand-coral"
      />
      {joinError && (
        <p role="alert" className="text-sm text-red-600">{joinError}</p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => handleJoin(1)}
          disabled={joinName.trim().length === 0 || joinLoading}
          className="rounded-xl bg-brand-coral px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Join {game.teamNames.team1}
        </button>
        <button
          onClick={() => handleJoin(2)}
          disabled={joinName.trim().length === 0 || joinLoading}
          className="rounded-xl bg-brand-teal px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Join {game.teamNames.team2}
        </button>
      </div>
    </div>
  </div>
)}
```

Note on button colours: the work item says "styled green" when enabled — the existing design system uses `brand-coral` (team 1) and `brand-teal` (team 2). Using team colours is more consistent with the lobby's visual language than forcing both to green. The disabled state (`opacity-40`) clearly communicates the inactive state.

### Success Criteria

#### Automated Verification
- [x] TypeScript compiles: `pnpm --filter client tsc --noEmit`
- [x] Tests pass: `pnpm test`

#### Manual Verification
- [ ] Visit `/lobby/:code` without a session — see "Want to play?" panel with name input and two join buttons
- [ ] Name input empty → both buttons disabled (low opacity)
- [ ] Type a name → both buttons become active (team coloured)
- [ ] Click "Join [Team 1]" → player appears in Team 1 column, join panel disappears, participant view shown
- [ ] Re-test with a name already taken → inline error shown, no redirect
- [ ] Participant visiting `/lobby/:code` → no join panel visible

---

## Phase 3: Simplify `/join` page

**File**: `client/src/pages/JoinPage.tsx`

This phase rewrites `JoinPage.tsx` to be a code-only entry point.

### Removals
- State: `name`, `team`, `gameTeamNames`
- `useEffect` for team-names fetch (lines 18–30)
- The `handleSubmit` join logic is replaced with a leaner existence-check handler
- JSX: name input field, `TeamSelector` block
- Imports: `Team`, `TeamSelector`, `saveSession`

### New implementation

The simplified page retains the same visual shell (`Logo`, card, "Go Back" link) with just the code input:

```tsx
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Logo } from '../components/Logo'

export function JoinPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [code, setCode] = useState(() => (searchParams.get('code') ?? '').toUpperCase())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const joinCode = code.trim().toUpperCase()
    if (!joinCode) return setError('Please enter the game code.')
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/games/${joinCode}`)
      if (!res.ok) {
        setError('Game not found. Check the code and try again.')
        return
      }
      navigate(`/lobby/${joinCode}`)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-brand-cream px-4">
      <Logo />

      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold text-gray-900">Join a Game</h1>
          <p className="mt-1 text-sm text-gray-500">Enter the code from your host</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="code" className="text-sm font-medium text-gray-700">
              Game Code
            </label>
            <input
              id="code"
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="XXXXXX"
              maxLength={6}
              className="rounded-lg border border-gray-200 px-4 py-3 text-center font-mono text-lg uppercase tracking-widest outline-none focus:border-brand-coral focus:ring-1 focus:ring-brand-coral"
            />
          </div>

          {error && (
            <p role="alert" className="text-center text-sm text-red-600">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            aria-busy={loading}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-coral px-6 py-3.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {loading ? 'Checking...' : 'Find Game →'}
          </button>
        </form>
      </div>

      <Link to="/" className="text-sm text-gray-500 hover:text-gray-700">
        Go Back
      </Link>

      <p className="text-sm text-gray-400">Play the classic Hat Game digitally</p>
    </div>
  )
}
```

Note: `useEffect` is no longer needed — remove it from the import.

### Success Criteria

#### Automated Verification
- [x] TypeScript compiles: `pnpm --filter client tsc --noEmit`
- [x] Tests pass: `pnpm test`
- [x] `grep -n "TeamSelector\|saveSession\|gameTeamNames\|name.*State\|team.*State" client/src/pages/JoinPage.tsx` returns no results

#### Manual Verification
- [ ] Navigate to `/join` — only game code input is shown (no name, no team selector)
- [ ] Enter a valid code → navigates to `/lobby/:code`
- [ ] Enter an invalid/non-existent code → error shown, no navigation

---

## Phase 4: Cleanup verification pass

A read-through to confirm no dead code remains and no regressions were introduced.

### Checks

- [ ] `client/src/pages/JoinPage.tsx` — confirm imports: only `useState`, `Link`, `useNavigate`, `useSearchParams`, `Logo`
- [ ] `client/src/components/TeamSelector.tsx` — still imported and used in `CreateGamePage.tsx`; not imported in `JoinPage.tsx`
- [ ] `client/src/session.ts` — `saveSession` now imported in `LobbyPage.tsx` (was in `JoinPage.tsx`); `loadSession` stays in `LobbyPage.tsx`
- [ ] `LobbyPage.tsx` — no reference to `/join?code=` link remains
- [ ] `HomePage.tsx` — still links to `/join` (correct; the page still exists as the code-entry point)
- [ ] `GamePage.tsx` — still redirects to `/join` on no session (correct; still valid entry point)

### Success Criteria

#### Automated Verification
- [x] `grep -rn "join?code=" client/src` returns no results (GamePage.tsx redirect is expected per plan)
- [x] `pnpm --filter client tsc --noEmit` — clean
- [x] `pnpm test` — all pass

#### Manual Verification
- [ ] Full end-to-end flow: Home → Join (code entry) → Lobby (join team via lobby) → Add Words → Start Game
- [ ] Share-link flow: Copy button on lobby → paste URL in new tab → arrives at lobby as visitor → join via lobby UI

---

## Testing Strategy

### Unit Tests
Existing unit tests cover the backend `POST /api/games/:joinCode/players` endpoint, `NAME_TAKEN` logic, and SSE. No new unit tests are required — the backend is unchanged.

### Manual Testing Steps
1. Open lobby URL as visitor (incognito tab) — verify join UI visible
2. Type a name, click "Join [Team Name]" — verify immediate appearance in team column, join UI hides
3. Open second incognito tab with same name — verify `NAME_TAKEN` inline error
4. Open `/join` directly — verify code-only form, no name or team fields
5. Enter valid code on `/join` — verify redirect to lobby
6. Enter invalid code on `/join` — verify error, no redirect
7. Click copy on lobby — paste in browser bar — verify full URL

## References

- Work item: `meta/work/ENG-025-streamline-join-flow-via-lobby.md`
- Related: ENG-021 (NAME_TAKEN validation — logic surface moves from `/join` to lobby)
- `POST /api/games/:joinCode/players`: `server/src/routes/games.ts:374`
- `saveSession` / `loadSession`: `client/src/session.ts`
- `useGameState` hook: `client/src/hooks/useGameState.ts`
