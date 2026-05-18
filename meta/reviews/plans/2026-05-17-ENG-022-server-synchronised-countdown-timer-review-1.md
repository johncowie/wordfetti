---
date: "2026-05-18T07:35:26+00:00"
type: plan-review
skill: review-plan
target: "meta/plans/2026-05-17-ENG-022-server-synchronised-countdown-timer.md"
review_number: 1
verdict: REVISE
lenses: [architecture, code-quality, correctness, performance, security, standards, test-coverage, safety]
review_pass: 1
status: complete
---

## Plan Review: ENG-022 Server-Synchronised Countdown Timer

**Verdict:** REVISE

The plan is well-scoped, the NTP-style DIY approach is sound, and the three-phase decomposition is clean. However several issues undermine the feature's correctness and completeness: most critically, the plan only wires `clockOffset` into `ClueGiverView` while two other `TurnTimer` render sites (`GuesserView`, `SpectatorView`) are left with raw `Date.now()`, defeating the goal for 2/3 of players on any given turn. The plan also doesn't address how `CountdownCircleTimer` ignores `initialRemainingTime` updates after mount, meaning the display fix may silently be a no-op. Several other major issues — a missing fetch timeout, biased RTT midpoint capture, and absent automated tests for the new code — need plan-level additions before implementation begins.

### Cross-Cutting Themes

- **GuesserView and SpectatorView omission** (flagged by 7/8 lenses) — `TurnTimer` is rendered in three places in `GamePage.tsx` but the plan only updates one of them. Every lens independently identified this as the most significant gap.
- **`CountdownCircleTimer` mount-only initialisation** (Code Quality + Correctness) — the library ignores `initialRemainingTime` prop changes after mount, so a late-resolving offset update is silently dropped. The display timer fix will not work in the common case without a remount strategy.
- **Unvalidated JSON response / NaN propagation** (Code Quality + Security) — `serverTime` from `.json()` is not type-checked; a non-JSON error response from a proxy would propagate `NaN` into all elapsed-time calculations without triggering the `catch` block.
- **Rate limit budget** (Performance + Security + Safety) — 5 sequential pings per mount, multiplied across players sharing a NAT IP, eats into the shared 500-req/min budget that also covers gameplay actions.
- **No automated tests** (Test Coverage) — the existing project has solid route and store coverage; the plan proposes zero automated tests for all new code (endpoint, hook, algorithm).

### Tradeoff Analysis

- **Sequential vs parallel pings**: Sequential is standard NTP practice but adds 5× RTT of latency before offset is set. Parallel (`Promise.all`) reduces this to 1× RTT at the cost of a burst. Given the mount-timing issue with `CountdownCircleTimer`, parallel pings would reduce the window where the timer starts from offset=0.
- **Remount on offset change**: Using a React `key` to force `TurnTimer` remount when the offset first resolves gives a correct initial time but causes a visible timer reset. Acceptable for a game context where precision matters more than visual continuity.

---

### Findings

#### Critical

- 🔴 **Architecture / Code Quality / Correctness / Test Coverage / Safety**: `clockOffset` not threaded into `GuesserView` or `SpectatorView`
  **Location**: Phase 3: Wire `clockOffset` into Timer Calculations
  The plan only passes `clockOffset` to `ClueGiverView` and updates that `TurnTimer` call. `GamePage.tsx` also renders `<TurnTimer>` inside `GuesserView` (line 283) and `SpectatorView` (line 311/313), neither of which is mentioned in Phase 3. After the plan is implemented, those two views will still use raw `Date.now()` — displaying drifted timers for the guesser and spectator roles. The acceptance criterion ("both devices display a timer value within 500 ms of each other") will not be met for 2/3 of players on any turn. If `clockOffset` is made a required prop on `TurnTimerProps`, this will be a TypeScript compile error; if optional with default 0, it silently regresses.

#### Major

- 🟡 **Code Quality / Correctness**: `CountdownCircleTimer` only reads `initialRemainingTime` at mount — late-resolving `clockOffset` is silently ignored
  **Location**: Phase 3: Wire `clockOffset` into Timer Calculations — TurnTimer.tsx
  `useClockOffset` initialises to 0 and resolves ~50–250 ms after mount. `CountdownCircleTimer` treats `initialRemainingTime` as a mount-time-only prop — subsequent prop changes are ignored. So `TurnTimer` will mount with offset=0, the corrected offset will update React state, `GamePage` re-renders, the new `initialRemainingTime` is passed to `TurnTimer`, but `CountdownCircleTimer` ignores it. The display timer fix is therefore a no-op in the common case. Suggested fix: add `key={clockOffset !== 0 ? 'synced' : 'unsynced'}` to `TurnTimer` at render sites to force a remount once the offset first resolves.

- 🟡 **Correctness**: Adding `clockOffset` to `ClueGiverView` `useEffect` dependency array resets `timerFiredRef` on every re-sync
  **Location**: Phase 3 — `GamePage.tsx`, `useEffect` dependency array change
  When `clockOffset` changes (once at mount after pings complete, then every 2 minutes), React tears down and re-runs the effect. The effect body starts with `timerFiredRef.current = false` and `setTurnEnding(false)`. If the offset re-sync fires while a turn is active, the guard flag is cleared, a new 500 ms interval starts, and `setTurnEnding(false)` briefly re-enables the guess/skip buttons (visible UI glitch). In the narrow race where the old interval fires `end-turn` and the new interval starts within the same 500 ms window, a duplicate `POST /end-turn` could be dispatched. Suggested fix: capture `clockOffset` in a `useRef` updated by a separate `useEffect`, read `clockOffsetRef.current` inside the interval callback, and leave the original dependency array unchanged.

- 🟡 **Safety**: No timeout on fetch pings — network stall can block sync indefinitely
  **Location**: Phase 2: useClockOffset Hook — `measureClockOffset` function
  `fetch('/api/time')` has no `AbortSignal`. On a flaky mobile connection (common for a party game) a single stalled ping can delay offset correction for 60–300 s (the browser's default connection timeout). During that window the next 2-minute interval may fire a second concurrent `sync()`. Suggested fix: wrap each fetch with `AbortController` + `setTimeout(ctrl.abort, 2000)`.

- 🟡 **Performance / Safety**: `Date.now()` captured after `r.json()` resolution, biasing the RTT midpoint
  **Location**: Phase 2: useClockOffset Hook — `measureClockOffset` function
  The midpoint formula is `serverTime - (t0 + Date.now()) / 2`, where `Date.now()` is evaluated after the `.then(r => r.json())` chain resolves — meaning it includes JSON parsing time in the RTT measurement, inflating the measured midpoint. Suggested fix: capture `const t1 = Date.now()` immediately after `await fetch(...)` resolves (before `.json()`), then use the explicit variable: `const res = await fetch(...); const t1 = Date.now(); const { now: serverTime } = await res.json(); offsets.push(serverTime - (t0 + t1) / 2)`.

- 🟡 **Test Coverage**: No automated test specified for the `/api/time` endpoint
  **Location**: Phase 1: Add `GET /api/time` Endpoint — Success Criteria
  The plan's automated verification for Phase 1 lists `pnpm test` (all existing tests) and a manual `curl` command — no new test is specified. The project has solid `supertest`-based route tests in `games.test.ts`. Without a test, a key name typo (e.g. `{ timestamp: ... }` instead of `{ now: ... }`) would break all clients silently. Suggested fix: add a minimal test asserting `GET /api/time` returns 200 with a body shape `{ now: <number> }`.

- 🟡 **Test Coverage**: No automated tests specified for `useClockOffset` or `measureClockOffset`
  **Location**: Phase 2: `useClockOffset` Hook — Success Criteria
  The plan's automated verification for Phase 2 is TypeScript compilation only. The median-filter algorithm, the offset formula, the fallback-to-0 path, and the 2-minute re-sync interval are all untested. `measureClockOffset` is a free-standing async function, trivially testable with a mocked `fetch`. Suggested fix: add Vitest unit tests covering (1) correct median from 5 samples, (2) fallback to 0 on `fetch` rejection, (3) re-sync fires at 2-minute interval using `vi.useFakeTimers()`.

- 🟡 **Security / Safety / Performance**: Rate limit budget pressure under shared NAT
  **Location**: Phase 1: `GET /api/time` — Rate Limiting; Phase 2: `measureClockOffset`
  5 sequential pings at mount + 5 every 2 minutes. Players on the same Wi-Fi share one IP bucket (500 req/min). 10 players mounting simultaneously fire 50 requests against the shared budget, and the game-critical endpoints (`/end-turn`, `/guess`, `/skip`) share the same budget. A 429 on `/api/time` silently falls back to offset=0, but a 429 on a game action breaks gameplay. Suggested fix: either reduce sample count from 5 to 3 (adequate for median), or register a separate, more generous rate limiter for `/api/time` before the shared `apiLimiter`.

#### Minor

- 🔵 **Code Quality / Security**: Unvalidated JSON response — `serverTime` can be `undefined`/`NaN`
  **Location**: Phase 2: `useClockOffset` Hook — `measureClockOffset`
  `fetch('/api/time').then(r => r.json())` returns `any`. If the server returns a non-JSON body (e.g. a 429 HTML page from a proxy), `serverTime` is `undefined`, the offset arithmetic produces `NaN`, and `setClockOffset(NaN)` silently corrupts all elapsed-time calculations. The `catch` block only catches thrown errors, not NaN propagation. Suggested fix: add `if (typeof serverTime !== 'number' || !Number.isFinite(serverTime)) throw new Error(...)` after destructuring, so the existing `catch` correctly resets to 0.

- 🔵 **Correctness**: Verification `curl` commands reference port 3001, server defaults to port 3000
  **Location**: Phase 1: Success Criteria — Manual Verification
  `server/src/index.ts` uses `process.env.PORT ?? 3000`. The plan's curl examples use `localhost:3001`. Developer following the plan will get a connection refused. Suggested fix: update to `localhost:3000`.

- 🔵 **Standards**: No `Cache-Control: no-store` header on `/api/time`
  **Location**: Phase 1: Add `GET /api/time` Endpoint
  Without an explicit Cache-Control header, a CDN or reverse proxy may cache the epoch timestamp. The existing SSE endpoint sets `Cache-Control: no-cache` explicitly. Suggested fix: add `res.set('Cache-Control', 'no-store')` before `res.json(...)`.

- 🔵 **Standards**: New route placed in `index.ts` rather than a router module
  **Location**: Phase 1: Add `GET /api/time` Endpoint
  All other API routes live under `server/src/routes/`. A developer looking for the time endpoint would check that directory first. Suggested fix: create `server/src/routes/time.ts` (or add to a `system.ts` router) and register via `app.use('/api', createTimeRouter())`.

- 🔵 **Correctness / Safety**: Concurrent `sync()` calls if ping cycle exceeds 2 minutes
  **Location**: Phase 2: `useClockOffset` Hook — re-sync `setInterval`
  `setInterval` fires `sync()` every 2 minutes regardless of whether the previous call has completed. On a slow connection with no timeout, two concurrent sync calls can race to `setClockOffset`. Mitigated by adding per-ping timeouts (see the Safety major finding); if timeouts are added, this becomes a non-issue.

- 🔵 **Architecture**: React Strict Mode fires the `useEffect` twice in development, producing 10 pings instead of 5
  **Location**: Phase 2: Manual Verification
  This is development-only noise. The `cancelled` flag is already correctly handled, so no code change is needed. Worth noting in the manual verification step so the developer isn't confused.

- 🔵 **Test Coverage**: Success criteria rely on `curl` rather than an automated assertion for Phase 1
  **Location**: Phase 1: Success Criteria — Automated Verification
  The `curl` command is listed alongside `pnpm test` but is a manual step and won't run in CI. Replace with a Vitest/supertest integration test (see the major test-coverage finding above).

---

### Strengths

- ✅ The DIY NTP approach is technically sound; the median-filter formula `offsets[Math.floor(offsets.length / 2)]` correctly selects the true median for a 5-element array.
- ✅ The `cancelled` flag in `useClockOffset` correctly prevents stale `setClockOffset` calls after unmount.
- ✅ Fallback to `clockOffset = 0` on any error preserves current behaviour — the game page is never broken by a sync failure.
- ✅ The `/api/time` endpoint is a pure `Date.now()` call with no I/O, making it trivially cheap on the server.
- ✅ The existing `apiLimiter` is correctly identified as covering `/api/time` for free.
- ✅ Phase decomposition is clean and each phase is independently shippable.
- ✅ The plan correctly identifies the `ClueGiverView` polling loop as the functional enforcement point, not just a display concern.
- ✅ The 2-minute re-sync interval is proportionate to clock drift rates on consumer devices.

---

### Recommended Changes

1. **Thread `clockOffset` into `GuesserView` and `SpectatorView`** (addresses: critical finding) — Add `clockOffset: number` to both component prop interfaces, pass it from `GamePage`, and forward it to their `TurnTimer` renders. This is the same pattern already described for `ClueGiverView`.

2. **Address `CountdownCircleTimer` mount-only initialisation** (addresses: major CQ/Correctness) — Add a `key` prop to `TurnTimer` at all three call sites tied to a sentinel that changes once when `clockOffset` first becomes non-zero, e.g. `key={clockOffset !== 0 ? 'synced' : 'unsynced'}`. Document this in Phase 3.

3. **Use a `clockOffsetRef` instead of adding `clockOffset` to the `useEffect` dependency array** (addresses: major Correctness) — Capture offset in a `useRef`, update it via a separate one-line `useEffect`, and read `clockOffsetRef.current` inside the interval. Document the `timerFiredRef` reset risk this avoids.

4. **Add per-ping `AbortController` timeout** (addresses: major Safety) — `AbortSignal.timeout(2000)` (or equivalent) per fetch. Document the ~10 s worst-case sync time in Phase 2.

5. **Capture `t1 = Date.now()` before `r.json()`** (addresses: major Performance/Safety) — Change the inner fetch body to `const res = await fetch(...); const t1 = Date.now(); const { now: serverTime } = await res.json(); offsets.push(serverTime - (t0 + t1) / 2)`.

6. **Add automated tests** (addresses: major Test Coverage x2) — (a) `GET /api/time` route test asserting `200 + { now: number }`. (b) `measureClockOffset` unit tests with mocked `fetch` covering: correct median, outlier rejection, fallback on rejection. Include these in Phase 1 and Phase 2 success criteria.

7. **Add runtime type guard for `serverTime`** (addresses: minor Code Quality/Security) — `if (typeof serverTime !== 'number' || !Number.isFinite(serverTime)) throw new Error(...)` before pushing to `offsets`.

8. **Fix curl port in verification steps** (addresses: minor Correctness) — Change `localhost:3001` → `localhost:3000` in Phase 1 success criteria.

9. **Add `Cache-Control: no-store` to `/api/time`** (addresses: minor Standards) — One line in the route handler.

10. **Address rate limit budget** (addresses: major Security/Safety/Performance) — Either reduce sample count to 3, add a separate limiter for `/api/time`, or document the budget analysis explicitly in Phase 1.

---
*Review generated by /review-plan*

---

## Per-Lens Results

### Architecture

**Summary**: The plan is well-scoped and the three-phase decomposition is sound. One major gap: `clockOffset` is not threaded into `GuesserView` or `SpectatorView`, which also render `TurnTimer`. Two minor concerns: sequential pings add latency before offset is valid, and React Strict Mode causes double-invocation in development.

**Strengths**:
- Clean three-phase decomposition with each phase independently shippable
- `clockOffset` correctly computed at `GamePage` level and passed down
- Rate-limiting inheritance via existing `apiLimiter` correctly identified

**Findings**:
- Major (high confidence) — `clockOffset` not threaded into `GuesserView` and `SpectatorView` `TurnTimer` renders
- Minor (medium confidence) — Sequential pings mean `clockOffset` is 0 for the first ~5 RTTs after mount
- Minor (medium confidence) — React Strict Mode double-invocation in development will fire 10 pings instead of 5

---

### Code Quality

**Summary**: The server endpoint and hook skeleton are clean and low-risk. Two major correctness gaps: `clockOffset` is not threaded into `GuesserView`/`SpectatorView`, and `CountdownCircleTimer` ignores `initialRemainingTime` after mount — meaning the display-side fix is a no-op in the common case.

**Strengths**:
- `measureClockOffset` is a free-standing async function, trivially unit-testable by mocking `fetch`
- `cancelled` flag pattern is correct for preventing stale state updates

**Findings**:
- Major (high) — `clockOffset` not threaded into `GuesserView`/`SpectatorView`
- Major (high) — `CountdownCircleTimer` only reads `initialRemainingTime` at mount
- Minor (high) — `measureClockOffset` fetches untyped JSON with no response validation
- Minor (medium) — Sequential pings block `clockOffset` resolution
- Minor (low) — Rate limit budget not explicitly documented

---

### Correctness

**Summary**: The NTP midpoint formula and median index are mathematically correct. Two major issues: adding `clockOffset` to the `useEffect` dependency array resets `timerFiredRef` on every re-sync; and `CountdownCircleTimer` ignores `initialRemainingTime` after mount. The GuesserView/SpectatorView omission is the most critical gap.

**Strengths**:
- NTP midpoint formula is mathematically correct
- Median index `Math.floor(offsets.length / 2)` is correct for a 5-element array
- `cancelled` flag correctly prevents stale setState calls
- Rate-limiting coverage of `/api/time` is correctly identified

**Findings**:
- Critical (high) — `clockOffset` not threaded to `GuesserView` or `SpectatorView`
- Major (high) — Adding `clockOffset` to `useEffect` deps resets `timerFiredRef` on every re-sync
- Major (high) — `TurnTimer` `initialRemainingTime` computed once at mount; late offset resolution may have no effect
- Minor (high) — Verification curl commands reference port 3001, server defaults to 3000
- Minor (medium) — Concurrent `sync()` calls possible if measurement takes longer than 2 minutes

---

### Performance

**Summary**: The dominant concern is 5 sequential pings at page mount, adding up to 5× RTT of latency. Parallel pings with `Promise.all` would reduce this to 1× RTT. The `Date.now()` sampling after `r.json()` marginally biases the RTT measurement.

**Strengths**:
- `/api/time` is a pure `Date.now()` call — negligible server cost per ping
- 2-minute re-sync interval is sensible for the session length
- `cancelled` flag prevents unnecessary re-renders from stale in-flight requests
- Fallback to 0 never blocks the game page from rendering

**Findings**:
- Major (high) — 5 sequential fetches serialise latency at page mount
- Major (high) — Sequential pings produce biased NTP midpoint (`Date.now()` sampled after `.json()`)
- Minor (high) — `/api/time` shares rate-limit budget with game-critical endpoints
- Minor (medium) — Re-sync on unmount/remount creates redundant ping bursts (dev-only noise)
- Suggestion (high) — `clockOffset` not threaded into `GuesserView`/`SpectatorView` timers

---

### Security

**Summary**: The new endpoint is low-risk: pure read-only, no user input, no sensitive data, and already rate-limited. The main concern is that 5 sequential pings per client amplify rate-limit pressure under shared NAT, which could affect game-critical endpoints sharing the same budget.

**Strengths**:
- `/api/time` is purely read-only with no sensitive data exposure
- Existing `apiLimiter` on `/api` provides baseline DoS protection
- `measureClockOffset` has no user-controlled input that flows into the fetch URL
- `Date.now()` response cannot be used to fingerprint the runtime beyond what the HTTP Date header already reveals

**Findings**:
- Major (medium) — 5 sequential pings per mount amplify rate-limit pressure across concurrent players
- Minor (high) — Unvalidated JSON response passed directly into arithmetic (NaN risk)
- Minor (low) — `/api/time` exposes millisecond-precision server time to unauthenticated callers

---

### Standards

**Summary**: Naming, file placement, and export conventions match the existing codebase well. Two minor deviations: the new route is placed inline in `index.ts` rather than a router module, and no `Cache-Control` header is set on the highly-volatile time response.

**Strengths**:
- `useClockOffset.ts` naming and placement matches `useGameState.ts` convention exactly
- `/api/time` URL follows flat, lowercase, noun-style resource naming used elsewhere
- `apiLimiter` coverage identified correctly

**Findings**:
- Minor (high) — New route added to `index.ts` rather than a dedicated router module
- Minor (high) — No `Cache-Control: no-store` header on `/api/time` response
- Suggestion (medium) — `GuesserView` and `SpectatorView` render `TurnTimer` without `clockOffset`

---

### Test Coverage

**Summary**: The plan adds meaningful new behaviour across all three phases but specifies zero automated tests for any of it. The existing project has solid route and store test coverage; the omission here is a meaningful regression. The `measureClockOffset` function is trivially testable with mocked `fetch`.

**Strengths**:
- Existing tests still pass after Phase 1, providing a baseline regression check
- Manual verification steps in Phase 3 are specific and could be mechanically translated to automated tests
- `measureClockOffset` is designed as a free-standing function, making it trivially unit-testable

**Findings**:
- Major (high) — No automated test for `/api/time` endpoint
- Major (high) — No automated tests for `useClockOffset` — core algorithm is untested
- Major (high) — `clockOffset` wiring to `GuesserView`/`SpectatorView` not covered by plan
- Minor (high) — Fallback to offset=0 on fetch failure not verified
- Minor (medium) — Median index behaviour on even-length `samples` parameter undocumented
- Minor (high) — Phase 1 success criteria rely on `curl` rather than automated assertion

---

### Safety

**Summary**: The plan fails safely by defaulting to offset=0 and cleaning up the interval on unmount. Three major gaps: no fetch timeout (network stall blocks sync indefinitely), `Date.now()` captured after JSON parsing (biased RTT), and the shared rate limit budget. The `timerFiredRef` guard and `cancelled` flag are correctly implemented.

**Strengths**:
- Fail-safe default: `clockOffset` initialised to 0 — broken sync degrades to current behaviour
- `cancelled` flag prevents setState after unmount
- Rate-limiting inheritance from existing `apiLimiter`
- `setInterval` cleanup on unmount prevents runaway background work
- `timerFiredRef` prevents duplicate `end-turn` POST requests

**Findings**:
- Major (high) — No timeout on fetch pings — network stall can block sync indefinitely
- Major (high) — Offset arithmetic: `Date.now()` captured after `r.json()` resolution
- Major (medium) — 5-ping burst consumes shared rate-limit budget under NAT
- Minor (high) — Overlapping `sync()` executions possible without an in-flight guard
- Minor (medium) — `clockOffset` not threaded into `GuesserView`/`SpectatorView`

---
---

## Review Pass 2 — 2026-05-18

**Verdict:** REVISE

The revised plan has addressed all findings from Review 1: GuesserView and SpectatorView now receive `clockOffset`, the binary `key` remount strategy is documented, `clockOffsetRef` replaces the unsafe dep-array approach, `AbortSignal.timeout(2000)` guards every ping, `t1` is captured before `res.json()`, `Number.isFinite` validates the response, `Cache-Control: no-store` is added, the router module pattern is used, pings are reduced to 3 parallel, and both `time.test.ts` and `useClockOffset.test.ts` are now in the plan. These are meaningful, comprehensive improvements.

However, three new concerns emerged from the revisions and one pre-existing gap remains:

### Cross-Cutting Themes

- **Binary key `clockOffset !== 0` is fragile** (flagged by Architecture, Code Quality, Correctness, Performance) — the key strategy introduced to fix Review 1's `CountdownCircleTimer` finding has a correctness hole: if the true offset is genuinely 0 (server and client clocks agree), the key never transitions from `'unsynced'` and the timer is never remounted with the authoritative offset. A separate `clockOffsetReady` boolean (or generation counter) would be more robust.
- **Overview text not updated** (Architecture, Standards, Correctness) — the Overview paragraph still says "5 sequential pings" despite the implementation using 3 parallel pings. All three lens agents independently flagged the same stale sentence.
- **Phase 3 has no automated tests** (Test Coverage — critical) — the most complex phase (ref vs value props, key remount, timerFiredRef non-reset) has zero automated coverage.

### Tradeoff Analysis

- **Promise.all vs Promise.allSettled** (Safety + Performance): `Promise.all` means a single slow server response blocks all three pings for up to 2000 ms before fallback. `Promise.allSettled` would let the two fast responses produce a usable median while the slow one times out. For a party game this is a minor degradation concern rather than a correctness issue.
- **Symmetric vs asymmetric prop interface**: Passing `clockOffsetRef` to `ClueGiverView` and `clockOffset` to the other two views is functionally correct but inconsistent. Moving the `clockOffsetRef` construction into `ClueGiverView` itself (accepting `clockOffset: number` like the others) would make GamePage simpler and the interfaces symmetric, at the cost of slightly more prop-drilling in the future if other consumers need a ref.

---

### Findings

#### Critical

- 🔴 **Test Coverage**: Phase 3 has no automated tests despite containing the most complex and risky logic
  **Location**: Phase 3: Wire clockOffset into Timer Calculations — Testing Strategy
  Phase 3 introduces the ref/value prop split, the `timerFiredRef` non-reset guarantee, and the `key` remount strategy — the three most subtle correctness properties in the whole change. The plan's automated test section covers only Phase 1 (`time.test.ts`) and Phase 2 (`useClockOffset.test.ts`). No automated test verifies: (a) TurnTimer displays corrected remaining time with a non-zero `clockOffset`, (b) changing `clockOffset` does not reset `timerFiredRef` or trigger a duplicate `end-turn` POST, (c) the `key` remount fires exactly once per sync resolution. These are the properties most likely to regress in future.
  **Suggestion**: Add at minimum two Phase 3 tests: (1) render `TurnTimer` with `clockOffset=200` and assert `initialRemainingTime` is reduced by 0.2 s; (2) render `ClueGiverView` with an active turn, let it expire, simulate an offset update, and assert only one `end-turn` fetch was made.

#### Major

- 🟡 **Code Quality / Correctness**: Binary key `clockOffset !== 0` is fragile — zero offset is overloaded
  **Location**: Phase 3: Wire clockOffset — `key` prop strategy
  `key={clockOffset !== 0 ? 'synced' : 'unsynced'}` conflates two distinct states: "offset not yet measured" (should use 0 as fallback) and "offset genuinely equals 0" (server and client clocks agree — no remount needed but this case is now identical to the not-yet-measured state). The key never transitions for players with agreeing clocks, so TurnTimer is never remounted with the authoritative offset. Additionally, if a re-sync fails and falls back to 0 mid-turn, the key transitions back to `'unsynced'`, causing an unexpected remount.
  **Suggestion**: Track readiness with a separate boolean: `const [clockOffsetReady, setClockOffsetReady] = useState(false)` in `useClockOffset`, set to `true` after the first successful sync (even if the offset is 0), and use `key={clockOffsetReady ? 'synced' : 'unsynced'}`. This separates "not yet measured" from "measured to be zero."

- 🟡 **Correctness / Standards**: Overview paragraph still says "5 sequential pings"
  **Location**: Overview (second paragraph)
  The overview reads "fires 5 sequential pings to a new `GET /api/time` endpoint". The implementation in Phase 2 fires 3 parallel pings with `Promise.all`. The discrepancy persists in two places: the Overview paragraph and the Phase 2 `measureClockOffset(samples = 3)` note that references a parameter defaulting to 3. A developer reading the overview before implementation will have a wrong mental model.
  **Suggestion**: Update the Overview to "fires 3 parallel pings." Also remove the `samples = 3` default parameter from `measureClockOffset` or replace it with a named constant — the parameter is never passed from `useClockOffset`, making it dead interface surface.

- 🟡 **Architecture / Code Quality**: Asymmetric prop interface — `ClueGiverView` receives a ref, others receive a value
  **Location**: Phase 3: ClueGiverView props vs GuesserView/SpectatorView props
  `ClueGiverView` receives `clockOffsetRef: React.RefObject<number>` while `GuesserView` and `SpectatorView` receive `clockOffset: number`. The reason for the asymmetry (avoiding `timerFiredRef` reset) is sound, but it creates a surprising interface: GamePage must manage a `useRef` and a dedicated `useEffect` to keep it in sync, and any future consumer needs to know this distinction. A reader looking at the three call sites will not immediately understand why one uses a ref.
  **Suggestion**: Consider moving `clockOffsetRef` construction inside `ClueGiverView` — the view accepts `clockOffset: number` (like its siblings), creates `const clockOffsetRef = useRef(clockOffset)` and the sync effect locally, and the interval reads `clockOffsetRef.current`. This makes all three interfaces symmetric and keeps the ref as a private implementation detail of ClueGiverView.

- 🟡 **Safety**: `Promise.all` means a single slow /api/time response stalls the entire sync
  **Location**: Phase 2: useClockOffset Hook — measureClockOffset
  Three pings are fired in parallel with `Promise.all`. If the server is slow or partially degraded (not failing, just slow), all three pings will wait the full 2000 ms AbortSignal timeout before `Promise.all` rejects and the hook falls back to 0. `Promise.allSettled` would let the two fast responses produce a usable median while the slow one completes or times out.
  **Suggestion**: Replace `Promise.all` with `Promise.allSettled` and filter to fulfilled results. If at least one ping succeeds, compute the median from the available samples; if all fail (or fewer than 1 succeed), fall back to 0.

- 🟡 **Test Coverage**: No test for invalid/malformed `/api/time` response shape
  **Location**: Phase 2: useClockOffset hook tests
  The `Number.isFinite` guard in `singlePing` is the primary defence against proxy error pages corrupting arithmetic. The test suite has no case where `mockFetch` resolves successfully but returns `{ now: 'bad' }` or `{}`. If the guard were removed or the condition flipped, no test would catch it — and the consequence is silent NaN propagation into all elapsed-time calculations.
  **Suggestion**: Add `it('falls back to 0 when /api/time returns a non-numeric now', ...)` where `mockFetch` resolves with `{ json: () => Promise.resolve({ now: 'bad' }) }` and assert `result.current` stays `0`.

- 🟡 **Test Coverage**: No test for the `AbortSignal.timeout` path
  **Location**: Phase 2: useClockOffset hook tests
  `AbortSignal.timeout(2000)` is the primary resilience mechanism for stalled pings. The existing "fetch rejects" test covers network errors but not the abort-on-timeout code path. If the timeout were removed or set to an absurdly high value, no test would catch it.
  **Suggestion**: Add a test where one `mockFetch` call returns a promise that never settles, advance fake timers by 2001 ms, and assert the hook still produces a defined result within that window.

#### Minor

- 🔵 **Code Quality**: Silent `catch` block with no logging
  **Location**: Phase 2: useClockOffset Hook — `sync()` catch block
  The catch is empty (`// fall back to 0 — current behaviour`). In development and test environments this makes it hard to detect unexpected failures. A `console.warn` when the sync fails would surface issues without alarming users.
  **Suggestion**: Add `console.warn('[useClockOffset] clock sync failed, using offset 0:', err)` inside the catch block.

- 🔵 **Code Quality**: `measureClockOffset(samples = 3)` default parameter is never used
  **Location**: Phase 2: useClockOffset Hook — `measureClockOffset` signature
  `useClockOffset` calls `measureClockOffset()` with no argument, always using the default of 3. The parameter exists as dead interface surface — it suggests callers can vary the sample count, but none do. This adds complexity for readers and allows accidental miscalling.
  **Suggestion**: Either remove the parameter and hardcode 3 (or use a module-level `const PING_COUNT = 3`), or document it as an intentional extension point.

- 🔵 **Test Coverage**: Re-sync test asserts inequality, not the specific new value
  **Location**: Phase 2: useClockOffset hook tests — re-sync test
  `expect(result.current).not.toBe(first)` checks that some change happened but not that the correct offset was computed. A mutation that changed the re-sync to return a random number would still pass.
  **Suggestion**: Change to `expect(result.current).toBeCloseTo(300, -1)` to match the `call > 3 ? 300 : 100` mock already defined in the test.

- 🔵 **Safety**: In-flight pings not aborted on component unmount
  **Location**: Phase 2: useClockOffset Hook — cleanup function
  The cleanup sets `cancelled = true` and clears the interval, but in-flight fetch promises from a sync cycle that started just before unmount are not aborted. The `cancelled` guard prevents `setClockOffset` from being called, but the fetches themselves complete unnecessarily.
  **Suggestion**: Store the AbortControllers created during a sync cycle and call `.abort()` on them in the cleanup function. This is a polish item — the `cancelled` guard is sufficient for correctness.

- 🔵 **Test Coverage**: No test verifying `now` is an integer, not a float
  **Location**: Phase 1: GET /api/time tests
  The test asserts `typeof res.body.now === 'number'`, which would pass if the server returned a float. `Date.now()` always returns an integer but a future processing change could break this.
  **Suggestion**: Add `expect(Number.isInteger(res.body.now)).toBe(true)` alongside the shape assertion.

---

### Strengths

- ✅ All critical and major findings from Review 1 have been addressed — the GuesserView/SpectatorView omission is fixed, `clockOffsetRef` replaces the dep-array approach, `AbortSignal.timeout` guards pings, `t1` is captured before `res.json()`, `Number.isFinite` validates the response, and both test files are now in the plan.
- ✅ The `createTimeRouter()` pattern correctly follows the existing router module convention.
- ✅ `Cache-Control: no-store` is explicitly set, preventing proxy or CDN caching of timestamps.
- ✅ The four `useClockOffset` test cases cover the most important observable behaviours (initial state, happy path, rejection fallback, re-sync interval).
- ✅ The plan explicitly calls out React Strict Mode double-invocation in the manual verification notes.
- ✅ The `clockOffsetRef` pattern and its motivation (avoiding `timerFiredRef` reset) is well-documented.
- ✅ The rate-limit budget analysis is now documented with arithmetic (3 pings at mount + 3 every 2 minutes = ~4.5 req/min per player).

---

### Recommended Changes

1. **Replace binary key with `clockOffsetReady` boolean** (addresses: major Code Quality/Correctness) — Export `{ clockOffset, clockOffsetReady }` from `useClockOffset`, set `clockOffsetReady = true` after the first successful measurement, use `key={clockOffsetReady ? 'synced' : 'unsynced'}`. Update the hook signature, tests, and Phase 3 key strategy documentation.

2. **Fix Overview text: 5 sequential → 3 parallel** (addresses: major Correctness/Standards) — Update the Overview paragraph and remove the dead `samples = 3` parameter from `measureClockOffset` (replace with a module-level constant or hardcode).

3. **Add Phase 3 automated tests** (addresses: critical Test Coverage) — Two tests: (1) `TurnTimer` renders with corrected remaining time when `clockOffset` is non-zero; (2) `ClueGiverView` does not fire a second `end-turn` POST after an offset update.

4. **Move `clockOffsetRef` inside `ClueGiverView`** (addresses: major Architecture/Code Quality) — Accept `clockOffset: number` in all three role-views; construct `clockOffsetRef` and the sync effect locally inside `ClueGiverView`. Remove the `clockOffsetRef` and its `useEffect` from `GamePage`.

5. **Switch `Promise.all` to `Promise.allSettled`** (addresses: major Safety) — Filter fulfilled results; fall back to 0 only if all fail. Reduces the blast radius of a slow server on mount-time sync.

6. **Add test for invalid response shape** (addresses: major Test Coverage) — `mockFetch` resolves with `{ now: 'bad' }` and assert `result.current` stays `0`.

7. **Add test for AbortSignal timeout path** (addresses: major Test Coverage) — One never-settling `mockFetch`, advance fake timers 2001 ms, assert hook produces a result.

8. **Strengthen re-sync test assertion** (addresses: minor Code Quality/Test Coverage) — `toBeCloseTo(300, -1)` instead of `not.toBe(first)`.

9. **Add `console.warn` in catch block** (addresses: minor Code Quality) — Surface sync failures in development without alarming production users.

---
*Review generated by /review-plan — pass 2*
