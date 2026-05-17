---
date: "2026-05-17T16:19:54+00:00"
type: plan-review
skill: review-plan
target: "meta/plans/2026-05-17-ENG-021-prevent-duplicate-player-names-in-lobby.md"
review_number: 1
verdict: REVISE
lenses: [architecture, correctness, test-coverage, code-quality, security, standards, usability, compatibility]
review_pass: 1
status: complete
---

## Plan Review: ENG-021 — Prevent Duplicate Player Names in Lobby

**Verdict:** REVISE

The plan is well-scoped, correctly locates the uniqueness constraint at the store layer, and the three-phase sequencing is sound. The 409 disambiguation via a `code` body field is the right architectural call, and the normalisation approach is technically correct. However, six major findings across the eight lenses require the plan to be revised before implementation: a referenced test case is unimplementable as written, the `res.json()` call on the 409 error path is unguarded and flagged by four separate lenses, the join endpoint has no rate limiting creating a new observable side-channel, and the deployment ordering dependency between server and client phases is not documented. Addressing these will make the plan unambiguously ready to implement.

---

### Cross-Cutting Themes

- **Unguarded `res.json()` on error path** (flagged by: Correctness, Code Quality, Security, Usability) — The client Phase 3 change calls `await res.json()` on a 409 response with no fallback if the body is not valid JSON. All four lenses independently identified this as a risk: a proxy or WAF returning a non-JSON 409 will cause `res.json()` to throw, fall into the outer `catch`, and display "Something went wrong." instead of a contextual message. Fix: `const data = await res.json().catch(() => ({}))` before branching on `data.code`.

- **Error code contract undocumented at interface boundary** (flagged by: Architecture, Standards, Compatibility) — The `AppError` codes that `joinGame` may throw (`NOT_FOUND`, `GAME_IN_PROGRESS`, `NAME_TAKEN`) are not documented anywhere at the `GameStore` interface level. Three lenses flagged this from different angles: Architecture notes a second store implementation would silently miss the check; Compatibility notes the implicit contract is invisible to mock implementations; Standards notes the `code` field is only partially adopted across 409 responses in the codebase. The minimal fix is a JSDoc comment on `GameStore.joinGame` enumerating the possible codes.

- **Freed-name-after-leave test is unimplementable** (flagged by: Correctness, Test Coverage) — The plan specifies a store unit test and a manual verification step for the scenario where a player leaves and their name becomes available. No `leaveGame` or player-removal method exists in `InMemoryGameStore`. Both lenses recommend removing this from the plan's scope since it cannot be tested without first implementing removal.

---

### Findings

#### Major

- 🟡 **Correctness + Test Coverage**: Freed-name-after-leave test cannot be written
  **Location**: Testing Strategy section — Store Unit Tests; Phase 1 success criteria; Phase 3 manual verification
  No `leaveGame` or player-removal method exists in `InMemoryGameStore`. The test case and corresponding manual verification step will hit a dead end during implementation. Both should be removed from this plan's scope.

- 🟡 **Code Quality + Correctness + Security + Usability**: `res.json()` unguarded on 409 error path
  **Location**: Phase 3: Client — Surface Error in Join Form
  `await res.json()` is called inside the 409 branch with no fallback. A non-JSON 409 body (proxy, WAF, future rate limiter) will throw a `SyntaxError` caught by the outer `catch`, showing "Something went wrong." instead of the contextual message. Fix with `.catch(() => ({}))`.

- 🟡 **Security**: No rate limiting on the join endpoint enables lobby flooding and name enumeration
  **Location**: Phase 2: Server Route — Expose NAME_TAKEN as 409
  The `POST /:joinCode/players` route has no rate limiter. After this plan ships, the `NAME_TAKEN` vs `NOT_FOUND` response distinction becomes an observable side-channel for enumerating lobby membership. A `settingsLimiter`-style rate limiter already exists in the codebase and should be applied to this route alongside the changes in this plan.

- 🟡 **Architecture**: `normaliseName` placed in concrete store module, not at domain boundary
  **Location**: Phase 1: Server Store — Duplicate Name Check
  `normaliseName` is a module-level private function inside `InMemoryGameStore.ts`. A second store implementation has no signal from the `GameStore` interface that it must apply the same normalisation semantics. Minimum fix: move to a shared utility or add a JSDoc note on `GameStore.joinGame`.

- 🟡 **Correctness**: TOCTOU race condition — reasoning should be documented
  **Location**: Phase 1: Server Store — Duplicate Name Check
  The check-then-act pattern is safe in the current implementation because Node.js is single-threaded and there is no `await` between the `isDuplicate` check and `game.players.push`. However, the plan does not state this reasoning, so a future refactor that introduces an `await` between check and push would silently reintroduce the race. The plan should document why the current approach is safe.

- 🟡 **Compatibility**: Phase 2 must deploy before Phase 3 — not documented
  **Location**: Phase 3: Client — Surface Error in Join Form
  If Phase 3 (client reads `data.code`) ships before Phase 2 (server adds `code` to `GAME_IN_PROGRESS` body), the client falls through to the `else` branch for all 409s — no user-visible breakage, but the dependency is implicit. The plan should note that Phase 2 must be deployed first (or simultaneously).

#### Minor

- 🔵 **Architecture**: `GameStore` interface does not document possible `AppError` codes
  **Location**: Phase 2: Server Route / GameStore interface
  `joinGame` can now throw three distinct codes but none are documented at the interface boundary.

- 🔵 **Architecture**: Normalisation applied at check time but not enforced at storage time
  **Location**: Phase 1: Server Store — Key Discoveries
  Stored names retain original casing/spacing; downstream comparisons must rediscover `normaliseName`. A brief comment at `players.push` would make this explicit.

- 🔵 **Standards**: Partial adoption of `code` field across 409 responses creates inconsistency
  **Location**: Phase 2: Server Route — Expose NAME_TAKEN as 409
  Five other 409 responses in `games.ts` continue to omit `code`. The plan should note this is intentionally scoped to the `/players` endpoint, or raise a follow-up to retrofit the other handlers.

- 🔵 **Usability**: `NOT_FOUND` 404 response not given a `code` field
  **Location**: Phase 2: Server Route — Expose NAME_TAKEN as 409
  Adding `code: 'NOT_FOUND'` to the 404 would make all three error responses from this route follow the same `{ code, error }` shape — a one-line change.

- 🔵 **Compatibility**: Updated `GAME_IN_PROGRESS` test should assert both `code` and `error` fields
  **Location**: Phase 2: Server Route — changes to `games.test.ts`
  The test update plan mentions asserting `res.body.code` but not `res.body.error`. Asserting both locks in the full body contract.

- 🔵 **Test Coverage**: No concrete test body provided for updated `GAME_IN_PROGRESS` assertion
  **Location**: Phase 2: Server Route — changes to `games.test.ts`
  The `NAME_TAKEN` test has a full code snippet; the `GAME_IN_PROGRESS` update is mentioned in prose only. Providing an explicit assertion makes it as easy to implement.

- 🔵 **Code Quality**: `AppError` codes remain untyped magic strings across store, route, and client
  **Location**: Phase 2: Server Route; Phase 3: Client
  A const object in `errors.ts` would give compile-time safety across all three layers. This plan is a natural opportunity to introduce it.

#### Suggestions

- 🔵 **Usability**: Re-focus the name input after a `NAME_TAKEN` error for keyboard/screen-reader users
  **Location**: Phase 3: Client — Surface Error in Join Form

- 🔵 **Code Quality**: Consider a comment at `players.push` noting that stored names retain original casing
  **Location**: Phase 1: Server Store — Duplicate Name Check

- 🔵 **Test Coverage**: `normaliseName` has no direct unit tests — only tested indirectly via `joinGame`
  **Location**: Phase 1: Server Store — normaliseName helper

---

### Strengths

- ✅ Constraint enforcement is placed at the correct architectural layer (store), ensuring any future route calling `joinGame` gets the protection automatically.
- ✅ Using a `code` field in the 409 body for disambiguation is the only safe approach given two distinct 409 conditions in the same handler — correctly identified and reasoned in Key Discoveries.
- ✅ The three-phase sequencing (store → route → client) leaves the system in a working, testable state after each phase.
- ✅ `normaliseName` is a pure function with no side effects — easy to reason about and test.
- ✅ The plan explicitly documents what is NOT being done, which is good constraint communication.
- ✅ Applying `normaliseName` to both the incoming and every stored name at check time correctly handles the trimmed-only asymmetry in stored names.
- ✅ The plan adds `code` to `GAME_IN_PROGRESS` alongside `NAME_TAKEN` — a good DRY move that avoids leaving one 409 code-less.
- ✅ Reusing the existing `<p role="alert">` element for the inline error is consistent with established patterns and requires no new UI components.
- ✅ Error code strings follow existing UPPER_SNAKE_CASE convention throughout.

---

### Recommended Changes

1. **Remove freed-name-after-leave test and manual step** (addresses: Correctness + Test Coverage major)
   Delete the "Name freed after player leaves" entry from the Testing Strategy store test list and the corresponding manual verification step in Phase 3. Note that this scenario is untestable until a player-removal mechanism exists.

2. **Guard `res.json()` with a fallback** (addresses: Code Quality + Correctness + Security + Usability major)
   Replace `const data = await res.json()` with `const data = await res.json().catch(() => ({}))` in the Phase 3 client snippet.

3. **Document Node.js single-thread safety of the duplicate check** (addresses: Correctness major)
   Add a sentence to Phase 1 noting that the check is safe from races because there is no `await` between the `isDuplicate` check and `game.players.push`, and that this assumption must hold for any future refactor.

4. **Add rate limiting to the join route** (addresses: Security major)
   Add a Phase 2 change item applying a rate limiter (e.g. 20 req/min per IP, mirroring `settingsLimiter`) to `POST /:joinCode/players`.

5. **Document deployment ordering** (addresses: Compatibility major)
   Add a note to Phase 3 (or an "Implementation Notes" section) stating that Phase 2 (server) must be deployed before or simultaneously with Phase 3 (client).

6. **Document `normaliseName` at the `GameStore` interface** (addresses: Architecture major)
   Add a JSDoc comment on `GameStore.joinGame` enumerating the `AppError` codes it may throw, including `NAME_TAKEN`.

7. **Provide complete `GAME_IN_PROGRESS` test snippet** (addresses: Test Coverage minor + Compatibility minor)
   Add a concrete test assertion block to Phase 2 that asserts both `res.body.code === 'GAME_IN_PROGRESS'` and `res.body.error === 'This game has already started'`.

8. **Add `code: 'NOT_FOUND'` to the 404 response** (addresses: Usability minor)
   One-line addition to Phase 2's route changes to give all three error responses the same `{ code, error }` shape.

---

*Review generated by /review-plan*

## Per-Lens Results

### Architecture

**Summary**: The plan is a well-scoped, three-phase change that correctly locates the uniqueness constraint in the store layer. The dependency direction is sound and consistent with the existing architectural pattern. Notable gap: `normaliseName` is placed in the concrete store module rather than a shared domain layer, and the `GameStore` interface contract is not updated to document the new error.

**Strengths**:
- Constraint enforcement at the correct architectural layer
- Correct identification that 409 disambiguation must rely on a `code` field
- Three-phase sequencing ensures each intermediate state is deployable
- Explicit documentation of what is NOT being done
- `normaliseName` as a pure function with no side effects

**Findings**:
- 🟡 Major (high): `normaliseName` defined inside concrete store module, not at domain boundary — Location: Phase 1: Server Store
- 🔵 Minor (high): `GameStore` interface contract not updated to document new error code — Location: Phase 2: Server Route / GameStore interface
- 🔵 Minor (medium): Normalisation applied at check time but not enforced at storage time — Location: Phase 1: Key Discoveries

---

### Correctness

**Summary**: The normalisation approach is correct and the HTTP 409 disambiguation is the right call. Two correctness issues stand out: a TOCTOU race that is actually safe in Node.js (but the plan should document why), and a freed-name-after-leave test that references a non-existent `leaveGame` method. A third issue exists in the unguarded `res.json()` call.

**Strengths**:
- `normaliseName` applied to both sides of the comparison correctly handles stored-name asymmetry
- Using a `code` field rather than a different HTTP status is the correct disambiguation strategy
- The plan correctly identifies the need to await the body before branching
- Sequential phasing leaves the system in a working state

**Findings**:
- 🟡 Major (high): TOCTOU race condition — safe in Node.js but reasoning undocumented — Location: Phase 1: Server Store
- 🟡 Major (high): Freed-name-after-leave test cannot be written — `leaveGame` does not exist — Location: Testing Strategy; Phase 1; Phase 3 manual verification
- 🔵 Minor (high): `res.json()` in 409 branch can throw and produce the wrong error message — Location: Phase 3: Client

---

### Test Coverage

**Summary**: Solid unit test coverage for the core normalisation logic. The route-level test is correctly specified. Main gap: the freed-name-after-leave test is unimplementable without a player-removal method.

**Strengths**:
- Four store tests directly cover the three normalisation dimensions plus a control
- Route test asserts both status and `code` body field
- Correctly identifies the `GAME_IN_PROGRESS` test needs updating
- Manual checklist is thorough and covers all normalisation variants
- Fresh store instances per test ensure full isolation

**Findings**:
- 🟡 Major (high): Freed-name-after-leave test deferred without a concrete plan — Location: Testing Strategy; Phase 1
- 🔵 Minor (high): No concrete test body for updated `GAME_IN_PROGRESS` assertion — Location: Phase 2: route tests
- 🔵 Minor (medium): No test explicitly labelled as collision against host player — Location: Phase 1: Store tests
- 🔵 Suggestion (medium): `normaliseName` has no direct unit tests — Location: Phase 1: normaliseName helper

---

### Code Quality

**Summary**: Well-scoped, proportionate, respects existing conventions. One major concern: `res.json()` on the 409 error path is unguarded. Minor concern: the new code adds a third untyped magic-string dependency chain for error codes.

**Strengths**:
- `normaliseName` is a pure function
- Guard-clause pattern mirrors existing `joinGame` structure
- Adding `code` to `GAME_IN_PROGRESS` is a good consistency move
- Three-phase sequencing is sound incremental delivery

**Findings**:
- 🟡 Major (high): `res.json()` on 409 can throw with no inline catch — Location: Phase 3: Client
- 🔵 Minor (high): `normaliseName` in concrete store module creates silent inconsistency with `updateTeamName` inline check — Location: Phase 1: Server Store
- 🔵 Minor (medium): `AppError` codes remain untyped magic strings across all three layers — Location: Phase 2: Route; Phase 3: Client
- 🔵 Suggestion (high): Comment noting stored names retain original casing would prevent confusion — Location: Phase 1: Server Store

---

### Security

**Summary**: The change does not introduce new authentication surface. Server-side authority for uniqueness is maintained. Two concerns: the join endpoint has no rate limiting (creating a new name-enumeration side-channel), and `res.json()` is unguarded on the error path.

**Strengths**:
- Uniqueness check is server-side only — client pre-validation explicitly declined
- `NAME_TAKEN` 409 carries a neutral, structured error message
- `normaliseName` reduces whitespace-trick homoglyph collisions
- Player IDs remain server-generated UUIDs
- No new endpoints or widened trust boundary

**Findings**:
- 🟡 Major (high): No rate limiting on join endpoint enables lobby flooding and name enumeration — Location: Phase 2: Server Route
- 🔵 Minor (medium): Unguarded `res.json()` on 409 body can throw on non-JSON intermediary responses — Location: Phase 3: Client

---

### Standards

**Summary**: Generally consistent with existing project conventions. `normaliseName` naming uses British English consistent with the codebase. Main concern: partial adoption of `code` field across 409 responses creates an inconsistent API contract.

**Strengths**:
- `NAME_TAKEN` follows UPPER_SNAKE_CASE error code convention
- Module-level helper placement consistent with existing `shuffle` and `computeBestClueGiver` helpers
- Client disambiguation approach is correct given two 409 conditions in one handler
- Reusing `<p role="alert">` is consistent with existing HTML semantics
- HTTP 409 for name conflict is correct RESTful convention

**Findings**:
- 🔵 Minor (high): Partial `code` field introduction across 409 responses creates route-level inconsistency — Location: Phase 2: Server Route

---

### Usability

**Summary**: Error condition surfaces cleanly and improves the API's error discrimination story. One inconsistency: the 404 NOT_FOUND response is not given a `code` field while both 409s are.

**Strengths**:
- Adding `code` to both 409s creates consistent discrimination pattern
- Reuses existing `<p role="alert">` — no new UI primitives needed
- Error message "That name is already taken — please choose another." is actionable
- Error state clears at start of each submission — no stale messages
- `res.json()` correctly awaited before branching on `code`

**Findings**:
- 🔵 Minor (high): `NOT_FOUND` 404 lacks `code` field, breaking the emerging pattern — Location: Phase 2: Server Route
- 🔵 Minor (medium): `res.json()` unguarded — non-JSON 409 shows confusing generic error — Location: Phase 3: Client
- 🔵 Suggestion (medium): Re-focus name input after `NAME_TAKEN` error for keyboard users — Location: Phase 3: Client

---

### Compatibility

**Summary**: Server-side change is purely additive and safe. Client upgrade is mandatory and must follow server. Deployment ordering dependency is not documented.

**Strengths**:
- Adding `code` to `GAME_IN_PROGRESS` 409 is purely additive — no existing consumer breaks
- HTTP 409 with body discriminant is a sound, interoperable protocol decision
- `GameStore` interface signature left unchanged — all existing mocks unaffected
- Plan correctly identifies client must await body before branching

**Findings**:
- 🟡 Major (high): Phase ordering dependency undocumented — client Phase 3 must deploy after server Phase 2 — Location: Phase 3: Client
- 🔵 Minor (high): Updated `GAME_IN_PROGRESS` test should assert both `code` and `error` fields — Location: Phase 2: route tests
- 🔵 Minor (medium): `createGameWithHost` calls `joinGame` — implicit contract not visible at `GameStore` interface — Location: Phase 1: Key Discoveries
