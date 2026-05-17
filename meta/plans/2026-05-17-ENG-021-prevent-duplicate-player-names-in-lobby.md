---
date: "2026-05-17T16:15:32+00:00"
type: plan
skill: create-plan
work-item: "ENG-021"
status: draft
---

# ENG-021: Prevent Duplicate Player Names in Lobby — Implementation Plan

## Overview

Add server-side duplicate name detection to the lobby join flow, surface it as
a `409 { code: 'NAME_TAKEN' }` response, and display an inline form error on
the client. Name equality ignores casing, leading/trailing whitespace, and
runs of internal whitespace.

## Current State Analysis

- `InMemoryGameStore.joinGame` (`server/src/store/InMemoryGameStore.ts:196-204`)
  pushes a new player with no uniqueness check whatsoever.
- The route catch block (`server/src/routes/games.ts:391-398`) maps `NOT_FOUND`
  → 404 and `GAME_IN_PROGRESS` → 409, but has no `NAME_TAKEN` branch.
- `JoinPage.handleSubmit` (`client/src/pages/JoinPage.tsx:49-56`) branches on
  HTTP status only — `409` is hard-coded to "This game has already started."
  The client never reads the response body on error.
- `AppError` (`server/src/errors.ts`) is a plain `Error` subclass with a bare
  `code: string` field — no shared enum or registry exists.

## Desired End State

- Joining with a name that normalises to the same value as an existing lobby
  player returns `409 { code: 'NAME_TAKEN', error: '...' }`.
- The client distinguishes `NAME_TAKEN` from `GAME_IN_PROGRESS` by reading the
  `code` field in the 409 body, and shows an inline form error:
  "That name is already taken — please choose another."
- The `GAME_IN_PROGRESS` 409 response gains a `code: 'GAME_IN_PROGRESS'` field
  for consistency (one-line change).
- All new code paths have unit/route tests.

### Key Discoveries

- `normaliseName` must be applied to both the incoming name **and** every
  existing player's stored name at check time
  (`InMemoryGameStore.ts:200` — `name` is already trimmed by the route before
  reaching the store, but stored names may have been trimmed without full
  normalisation).
- Two separate `409` responses exist in the same route handler; the only safe
  disambiguation is a `code` field in the body — not a different HTTP status.
- The client does not currently call `res.json()` on error responses; the 409
  branch must be updated to await the body before branching on `code`.
- Tests use Vitest (not Jest). Run via `pnpm --filter @wordfetti/server test`.
- Client has no automated test suite — client changes are verified manually.

## What We're NOT Doing

- No client-side pre-validation before the POST (server is the source of truth
  for concurrency safety).
- No name uniqueness enforcement after the lobby phase.
- No mid-game name changes.
- No name reservation for players who have left — their name is freed immediately.
- No changes to the shared `types.ts` or the `GameStore` interface signature.

## Implementation Approach

Three small, sequential phases: store → route → client. Each phase is
independently testable and leaves the system in a working state. The store
change is the only true behaviour change; the route and client phases are
purely about surfacing that change.

---

## Phase 1: Server Store — Duplicate Name Check

### Overview

Add a `normaliseName` helper and a uniqueness check in `joinGame` before the
player is constructed and pushed.

### Changes Required

#### 1. `server/src/store/InMemoryGameStore.ts`

Add a module-level normalisation helper (above the class):

```ts
function normaliseName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}
```

In `joinGame`, after the `GAME_IN_PROGRESS` check (line 199) and before the
player construction (line 200), insert:

```ts
const isDuplicate = game.players.some(
  (p) => normaliseName(p.name) === normaliseName(name)
)
if (isDuplicate) throw new AppError('NAME_TAKEN', 'That name is already taken')
// Note: no `await` exists between this check and game.players.push below,
// so Node.js's single-threaded event loop guarantees the check-then-act is atomic.
// If an `await` is ever introduced between these two lines, a mutex will be needed.
```

#### 2. `server/src/store/InMemoryGameStore.test.ts`

Add a new `describe` block (or extend the existing `joinGame` block) with the
following cases. Note: `createGameWithHost` calls `joinGame` internally, so the
host's name is already in `game.players` — these tests exercise collision
against the host.

```ts
it('rejects a name that matches an existing player name case-insensitively', async () => {
  const store = new InMemoryGameStore(TEST_CONFIG)
  const { game } = await store.createGameWithHost('Alice', 1)
  await expect(store.joinGame(game.joinCode, 'alice', 2)).rejects.toMatchObject({
    code: 'NAME_TAKEN',
  })
})

it('rejects a name with differing outer whitespace', async () => {
  const store = new InMemoryGameStore(TEST_CONFIG)
  const { game } = await store.createGameWithHost('Alice', 1)
  await expect(store.joinGame(game.joinCode, '  alice  ', 2)).rejects.toMatchObject({
    code: 'NAME_TAKEN',
  })
})

it('rejects a name with collapsed internal whitespace', async () => {
  const store = new InMemoryGameStore(TEST_CONFIG)
  const { game } = await store.createGameWithHost('Alice Smith', 1)
  await expect(store.joinGame(game.joinCode, 'alice  smith', 2)).rejects.toMatchObject({
    code: 'NAME_TAKEN',
  })
})

it('allows a genuinely different name', async () => {
  const store = new InMemoryGameStore(TEST_CONFIG)
  const { game } = await store.createGameWithHost('Alice', 1)
  const player = await store.joinGame(game.joinCode, 'Bob', 2)
  expect(player.name).toBe('Bob')
})
```

Note: a "freed name after leave" test is out of scope for this plan — no
player-removal method exists in `InMemoryGameStore`. This scenario will become
testable once a leave/removal mechanism is introduced.


### Success Criteria

#### Automated Verification

- [ ] All store tests pass: `pnpm --filter @wordfetti/server test`

#### Manual Verification

- N/A — fully covered by unit tests.

---

## Phase 2: Server Route — Expose NAME_TAKEN as 409

### Overview

Add a `NAME_TAKEN` branch to the route catch block and add a `code` field to
the existing `GAME_IN_PROGRESS` 409 response.

### Changes Required

#### 1. `server/src/store/GameStore.ts`

Add a JSDoc comment to the `joinGame` signature documenting the `AppError`
codes it may throw:

```ts
/**
 * @throws AppError('NOT_FOUND') if the game does not exist
 * @throws AppError('GAME_IN_PROGRESS') if the game has already started
 * @throws AppError('NAME_TAKEN') if a player with the same normalised name
 *   already exists in the lobby (normalised = trimmed, lowercased,
 *   internal whitespace collapsed to a single space)
 */
joinGame(joinCode: string, name: string, team: Team): Promise<Player>
```

#### 2. `server/src/routes/games.ts` (catch block, ~lines 391-398)

Before change:
```ts
if (err instanceof AppError && err.code === 'NOT_FOUND') {
  return res.status(404).json({ error: 'Game not found' })
}
if (err instanceof AppError && err.code === 'GAME_IN_PROGRESS') {
  return res.status(409).json({ error: 'This game has already started' })
}
```

After change:
```ts
if (err instanceof AppError && err.code === 'NOT_FOUND') {
  return res.status(404).json({ code: 'NOT_FOUND', error: 'Game not found' })
}
if (err instanceof AppError && err.code === 'GAME_IN_PROGRESS') {
  return res.status(409).json({ code: 'GAME_IN_PROGRESS', error: 'This game has already started' })
}
if (err instanceof AppError && err.code === 'NAME_TAKEN') {
  return res.status(409).json({ code: 'NAME_TAKEN', error: 'That name is already taken — please choose another.' })
}
```

All three error responses now follow the same `{ code, error }` shape.

#### 2. `server/src/routes/games.test.ts`

Add a new test for the `NAME_TAKEN` case:

```ts
it('returns 409 with code NAME_TAKEN when the name is already taken', async () => {
  const store = mockStore({
    joinGame: async () => { throw new AppError('NAME_TAKEN', 'That name is already taken') },
  })
  const res = await request(buildApp(store))
    .post('/ABC123/players')
    .send({ name: 'Alice', team: 1 })
  expect(res.status).toBe(409)
  expect(res.body.code).toBe('NAME_TAKEN')
})
```

Update the existing `GAME_IN_PROGRESS` test to assert both the `code` and
`error` fields to lock in the full body contract:

```ts
expect(res.status).toBe(409)
expect(res.body.code).toBe('GAME_IN_PROGRESS')
expect(res.body.error).toBe('This game has already started')
```

### Success Criteria

#### Automated Verification

- [ ] All route tests pass: `pnpm --filter @wordfetti/server test`

#### Manual Verification

- N/A — fully covered by route tests.

---

## Phase 3: Client — Surface Error in Join Form

### Overview

Update `JoinPage.handleSubmit` to read the response body on 409 and branch on
`code` to display the correct error message.

### Changes Required

#### 1. `client/src/pages/JoinPage.tsx` (~lines 49-56)

Before change:
```ts
if (res.status === 409) {
  setError('This game has already started.')
  return
}
```

After change:
```ts
if (res.status === 409) {
  const data = await res.json().catch(() => ({}))
  if (data.code === 'NAME_TAKEN') {
    setError('That name is already taken — please choose another.')
  } else {
    setError('This game has already started.')
  }
  return
}
```

No other changes needed — the error display JSX (`<p role="alert">` at
lines 123-127) already renders `error` state; no new UI element required.

**Deployment note**: Phase 2 (server) must be deployed before or at the same
time as Phase 3 (client). The server change is safe to deploy independently
since adding the `code` field to existing responses is purely additive. If
Phase 3 were deployed without Phase 2, `data.code` would be `undefined` for
`GAME_IN_PROGRESS` responses and the `else` branch would fire — no
user-visible breakage, but the phases should not ship in reverse order.

### Success Criteria

#### Automated Verification

- N/A — client has no automated test suite.

#### Manual Verification

- [ ] Join with an existing player's exact name → form stays open, shows
  "That name is already taken — please choose another."
- [ ] Join with the same name in different casing (e.g. "alice" vs "Alice") →
  rejected with the same error.
- [ ] Join with the same name with leading/trailing spaces → rejected.
- [ ] Join with the same name with multiple internal spaces → rejected.
- [ ] Join with a genuinely different name → succeeds, navigates to lobby.
- [ ] Attempt to join a game that has already started → still shows
  "This game has already started." (regression check).

---

## Testing Strategy

### Store Unit Tests

File: `server/src/store/InMemoryGameStore.test.ts`

- Casing collision
- Outer whitespace collision
- Internal whitespace collision
- Unique name succeeds

### Route Tests

File: `server/src/routes/games.test.ts`

- `NAME_TAKEN` → 409 with `code: 'NAME_TAKEN'`
- Existing `GAME_IN_PROGRESS` test updated to assert both `code: 'GAME_IN_PROGRESS'` and `error` string
- `NOT_FOUND` 404 now returns `{ code: 'NOT_FOUND', error: '...' }`

### Manual Testing

See Phase 3 success criteria above.

## References

- Work item: `meta/work/ENG-021-prevent-duplicate-player-names-in-lobby.md`
- Join flow: `server/src/routes/games.ts:378-400`
- Store: `server/src/store/InMemoryGameStore.ts:196-204`
- Client form: `client/src/pages/JoinPage.tsx:32-67`
- AppError: `server/src/errors.ts`
