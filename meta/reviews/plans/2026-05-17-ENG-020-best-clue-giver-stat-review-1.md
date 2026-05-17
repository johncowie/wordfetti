---
date: "2026-05-17T15:40:07+00:00"
type: plan-review
skill: review-plan
target: "meta/plans/2026-05-17-ENG-020-best-clue-giver-stat.md"
review_number: 1
verdict: REVISE
lenses: [architecture, correctness, test-coverage, code-quality, standards, compatibility]
review_pass: 1
status: complete
---

## Plan Review: Best Clue Giver Stat — Implementation Plan

**Verdict:** REVISE

The plan is well-structured, correctly scoped, and demonstrates solid understanding of the codebase. The core design decisions — a persistent accumulator on `InternalGame`, stripping via `toPublicGame`, and a dedicated computation helper — are all sound. One critical error will prevent the plan from building as written: `computeBestClueGiver` is called as a free function but defined as a class method. Two major test coverage gaps (cross-round persistence and phase ordering) round out the required revisions.

### Cross-Cutting Themes

- **`computeBestClueGiver` invocation error** (flagged by: Architecture, Correctness, Standards) — Three independent lenses identified that the plan's `getGameWords` snippet calls `computeBestClueGiver(...)` without `this.`, but the helper is declared as a `private` class method. This will not compile. The fix is either `this.computeBestClueGiver(...)` or promoting it to a module-level function (which multiple lenses also recommend for other reasons).

- **Phase ordering / type contract gap** (flagged by: Compatibility, Test Coverage) — Phase 1 adds `bestClueGiver` as a required field on `GameStats`, but the mock stub fix is deferred to Phase 4. This means `pnpm typecheck` — listed as a success criterion for Phases 1 and 2 — will fail the moment Phase 1 lands. The mock update should move to Phase 1.

- **Private method vs module-level function** (flagged by: Architecture, Code Quality) — Both lenses independently recommend that `computeBestClueGiver` should be a module-level unexported function, consistent with the existing `shuffle` helper in the same file. This also fixes the invocation error as a side effect.

### Tradeoff Analysis

- **ID resolution in shared type vs client**: Architecture suggests `BestClueGiver` should expose `playerIds: string[]` rather than `names: string[]` to keep the domain type clean and let clients resolve display. The current approach (names in the type) is simpler for the stated scope. Acceptable for now; worth noting if player profile linking is ever needed.

---

### Findings

#### Critical

- 🔴 **Correctness / Architecture / Standards**: `computeBestClueGiver` called as free function but defined as private class method
  **Location**: Phase 2: Server — Step 4, `getGameWords` and `computeBestClueGiver` helper
  The `getGameWords` snippet calls `computeBestClueGiver(game.clueGiverStats, game.players)` as a free function, but the helper is declared `private computeBestClueGiver(...)` on the class — it must be invoked as `this.computeBestClueGiver(...)`. TypeScript will fail to compile this as written, blocking all downstream phases. Fix: either use `this.`, or declare it as a module-level function outside the class (recommended by multiple lenses, consistent with the existing `shuffle` helper pattern).

#### Major

- 🟡 **Test Coverage**: Cross-round accumulation test must drive the `advanceRound` path
  **Location**: Phase 4: Tests — `clueGiverStats` describe block
  The planned "accumulates across multiple rounds" test uses only `readyTurn / guessWord / endTurn`, but `advanceRound` performs a broad `Object.assign` that could silently reset `clueGiverStats` if the field is omitted from it. No test drives `advanceRound` and then asserts the accumulated count survives. Add an explicit assertion: after `advanceRound`, call `getGameWords` and confirm round-1 clue counts are preserved before any round-2 guesses.

- 🟡 **Test Coverage**: Missing test for player ID fallback in `computeBestClueGiver`
  **Location**: Phase 4: Tests — `getGameWords — bestClueGiver` describe block
  The helper includes `playerNames.get(id) ?? id` as a fallback when a player ID is in `clueGiverStats` but absent from `game.players`. None of the six planned test cases exercise this path. Add a test that injects a `clueGiverStats` entry with an unknown player ID and asserts the raw ID appears in `names`.

- 🟡 **Compatibility**: Phase ordering creates a typecheck-breaking gap between Phase 1 and Phase 4
  **Location**: Phase 1: Shared Types / Phase 4: Tests
  Phase 1 adds `bestClueGiver` as a required field on `GameStats`. The existing `games.test.ts` mock stub (line 37) returns `{ wordsBySubmitter: [] }` with no `bestClueGiver`, which will immediately fail `pnpm typecheck` — a stated success criterion for Phases 1 and 2. Move the mock stub update from Phase 4 into Phase 1 so the type change and its downstream fix land atomically.

#### Minor

- 🔵 **Architecture / Code Quality**: `computeBestClueGiver` should be a module-level function, not a private class method
  **Location**: Phase 2: Server — `computeBestClueGiver` helper
  The function has no dependency on `this` — it is a pure computation on two plain data arguments. Declaring it `private` on `InMemoryGameStore` ties a stateless function to a stateful class, prevents direct unit testing without constructing the store, and is inconsistent with the existing `shuffle` module-level helper in the same file. Declare it as an unexported module-level function above `getGameWords`.

- 🔵 **Architecture / Correctness**: `clueGiverStats` not explicitly reset in `startGame`'s `Object.assign` block
  **Location**: Phase 2: Server — Step 2, `createGame` initialisation
  `clueGiverStats` is initialised in `createGame` and is not mutated before `startGame` is called, so this is harmless in the current flow. However, `startGame` is supposed to be the single atomic commit of initial in-progress state, and not including `clueGiverStats: {}` in its `Object.assign` creates a subtle invariant gap for future refactors (e.g. a `restartGame` path). Add `clueGiverStats: {}` to the `startGame` `Object.assign` block for explicitness.

- 🔵 **Code Quality**: `toPublicGame` type signature is an expanding data clump
  **Location**: Phase 2: Server — Step 5, `toPublicGame` in `games.ts:9`
  The inline intersection type listing every internal field as `unknown` must be manually updated each time a new internal field is added, and TypeScript won't catch a missed optional field. A cleaner long-term fix is to import `InternalGame` in `games.ts` and type the parameter directly. Note as a follow-up rather than a blocker.

- 🔵 **Standards**: `toPublicGame` signature expansion uses multi-line style vs existing single-line style
  **Location**: Phase 2: Server — Step 5, `toPublicGame`
  The plan's replacement reformats the signature as a multi-line type, while the existing file uses a single-line inline union. Retain the single-line style and simply append `clueGiverStats?: unknown` to the existing parameter type to minimise diff noise.

- 🔵 **Test Coverage**: `max === 0` guard branch untested — either test it or remove it
  **Location**: Phase 4: Tests — `getGameWords — bestClueGiver` describe block
  The planned "null when no guesses" test covers `clueGiverStats === {}` but not the `max === 0` branch (entries exist but all counts are zero). This state is unreachable via the public API. Either add a test that directly injects `{ 'p1': 0 }` into the stats map, or remove the `max === 0` guard to eliminate an untestable branch.

- 🔵 **Test Coverage**: Route-level test doesn't assert `bestClueGiver` reaches the HTTP response body
  **Location**: Phase 4: Tests — `games.test.ts` mock update
  The mock update prevents a type error but no route test asserts that `bestClueGiver` is present in the `GET /:joinCode/stats` JSON response. Add a thin route test asserting `res.body.bestClueGiver` exists (e.g. `null`) to verify the field survives HTTP serialisation.

- 🔵 **Compatibility**: Required field addition breaks any other `GameStore` implementations
  **Location**: Phase 1: Shared Types
  Only `InMemoryGameStore` implements `GameStore` today, so risk is low. Noted for completeness — any future test double or alternative implementation must include `bestClueGiver` in its `getGameWords` return shape.

#### Suggestions

- 🔵 **Code Quality**: Extract `game.currentClueGiverId` to a local `const` before the increment expression for readability
  **Location**: Phase 2: Server — Step 3, `guessWord` increment
  `const id = game.currentClueGiverId; game.clueGiverStats[id] = (game.clueGiverStats[id] ?? 0) + 1` reads more cleanly than the repeated property access in the current proposal.

- 🔵 **Standards**: New `<section>` lacks `aria-labelledby` for screen reader navigation
  **Location**: Phase 3: Frontend — `BestClueGiverSection`
  Add `id="best-clue-giver-heading"` to the `<h2>` and `aria-labelledby="best-clue-giver-heading"` to the `<section>` for WCAG 2.1 landmark naming. Same gap exists in the existing submitter sections — could be noted as a follow-up to address consistently.

---

### Strengths

- ✅ Correctly identifies the only write path for successful guesses (`guessWord`) and places the accumulator increment there — matches how `scores` is already handled
- ✅ `bestClueGiver: BestClueGiver | null` is the right nullability choice — avoids a `Math.max(...[])` = `-Infinity` bug on empty input and handles the frontend gracefully
- ✅ Alphabetical sort on tied names ensures deterministic display order without over-engineering
- ✅ `toPublicGame` stripping is explicitly planned and not forgotten — consistent with how `hat`, `originalWords`, `clueGiverIndices`, and `currentWordId` are already stripped
- ✅ Phases are correctly sequenced: shared types before server before client — the TypeScript contract is established before either side depends on it
- ✅ The plan explicitly acknowledges the pre-existing `createdAt`/`updatedAt` leak in `toPublicGame` and correctly marks it out of scope
- ✅ `BestClueGiverSection` returns `null` on `bestClueGiver === null` rather than rendering an empty section — clean and correct
- ✅ `id ?? id` fallback in `computeBestClueGiver` is documented in the plan's own comments, showing awareness of the defensive code path

---

### Recommended Changes

1. **Fix `computeBestClueGiver` invocation and promote to module-level function** (addresses: Critical finding — free function call)
   Declare `computeBestClueGiver` as an unexported module-level function above `getGameWords` in `InMemoryGameStore.ts` (consistent with `shuffle`). Update the `getGameWords` body to call it as a plain function rather than `this.`. Remove the `private` declaration.

2. **Move mock stub update from Phase 4 into Phase 1** (addresses: Major — typecheck gap)
   Add the `games.test.ts` mock update (`getGameWords: async () => ({ wordsBySubmitter: [], bestClueGiver: null })`) to Phase 1's "Changes Required" section so that `pnpm typecheck` passes immediately after Phase 1.

3. **Strengthen cross-round test to drive `advanceRound`** (addresses: Major — cross-round test gap)
   In Phase 4, update the "accumulates across multiple rounds" test specification to explicitly drive `advanceRound` and assert the accumulated clue count from round 1 is preserved before any round 2 guesses.

4. **Add fallback ID test to `getGameWords` describe block** (addresses: Major — missing fallback test)
   Add a test case: inject a `clueGiverStats` entry with a player ID not in `game.players` and assert the raw ID appears in `bestClueGiver.names`.

5. **Add `clueGiverStats: {}` to `startGame`'s `Object.assign` block** (addresses: Minor — startGame gap)
   Update Phase 2, Step 2 to also note initialisation in `startGame`, making the invariant explicit.

6. **Retain single-line style for `toPublicGame` signature** (addresses: Minor — standards)
   In Phase 2, Step 5, simplify the example to show `clueGiverStats?: unknown` appended to the existing single-line union rather than reformatting as multi-line.

---
*Review generated by /review-plan*

## Per-Lens Results

### Architecture

**Summary**: The plan is well-scoped and follows the established layered architecture cleanly. One structural concern: `computeBestClueGiver` is declared as a private method rather than a module-level function, and its call site in the plan uses free-function syntax that will not compile.

**Strengths**:
- `toPublicGame` correctly extended to strip `clueGiverStats`
- Accumulation placed in `guessWord` — the single write path, consistent with `scores`
- `computeBestClueGiver` extracted as a helper rather than inlined
- Phases sequenced correctly (shared types first)
- Null-safety explicitly designed in

**Findings**:
- 🟡 **Major** (high confidence): Private method call site uses bare function call syntax, not `this.computeBestClueGiver` — Phase 2: Server — Step 4
- 🔵 **Minor** (high confidence): Pure computation placed on store class rather than as module-level function — Phase 2: Server — Step 4
- 🔵 **Minor** (medium confidence): `clueGiverStats` not initialised in `startGame`'s `Object.assign` block — Phase 2: Server — Step 1
- 🔵 **Suggestion** (low confidence): `BestClueGiver` type uses `names[]` — consider `playerIds[]` for future flexibility — Phase 1: Shared Types

---

### Correctness

**Summary**: Logically sound for the happy path. The critical compile error (free function call) and the `startGame` initialisation gap are the two actionable issues. Edge-case handling (zero guesses, ties, final word of a round) is correctly designed.

**Strengths**:
- `entries.length === 0` guard prevents `Math.max(...[])` = `-Infinity`
- `max === 0` guard handles degenerate all-zero entries
- Alphabetical sort for deterministic tie display
- `?? id` fallback for missing player
- `toPublicGame` stripping prevents field leak

**Findings**:
- 🔴 **Critical** (high confidence): Private method called as free function — will not compile — Phase 2: Server — computeBestClueGiver and getGameWords
- 🔵 **Minor** (high confidence): `clueGiverStats` not reset in `startGame` — survives if `createGame` initialises it — Phase 2: Server — startGame
- 🔵 **Minor** (high confidence): Increment must be placed before `if (game.hat.length === 0)` branch — confirm in implementation — Phase 2: Server — guessWord

---

### Test Coverage

**Summary**: Well-structured testing strategy matching existing conventions. Key gaps: cross-round test must drive `advanceRound`, the fallback ID path is unexercised, the zero-count branch is untestable as written, and no route-level assertion on the new response field.

**Strengths**:
- `getGameWords` test gap explicitly acknowledged and addressed
- Test cases map directly onto the Testing Strategy section
- Tests drive public API rather than internal state
- Alphabetical sort assertion planned for ties
- Mock update correctly scoped

**Findings**:
- 🟡 **Major** (high confidence): Cross-round accumulation test must drive `advanceRound` path — Phase 4: Tests
- 🟡 **Major** (high confidence): Missing test for player ID fallback (`?? id`) — Phase 4: Tests
- 🔵 **Minor** (high confidence): `max === 0` branch untested — test it or remove it — Phase 4: Tests
- 🔵 **Minor** (high confidence): Route test update doesn't assert `bestClueGiver` in HTTP response — Phase 4: Tests
- 🔵 **Minor** (medium confidence): Frontend component has no tests — Phase 3: Frontend

---

### Code Quality

**Summary**: Well-structured and proportional to scope. Key design decisions are sound. Two minor quality issues: pure helper on stateful class, and `toPublicGame` type signature pattern is becoming a maintenance liability.

**Strengths**:
- `computeBestClueGiver` named and extracted rather than inlined
- `null` return is explicit and documented
- Alphabetical sort is simple and deterministic
- `if (game.currentClueGiverId)` guard acknowledged as belt-and-suspenders
- `BestClueGiverSection` follows existing page component conventions

**Findings**:
- 🔵 **Minor** (high confidence): Pure helper placed as private method on stateful class — Phase 2: Server — computeBestClueGiver
- 🔵 **Minor** (high confidence): `toPublicGame` type signature is an expanding data clump — Phase 2: Server — toPublicGame
- 🔵 **Suggestion** (medium confidence): Inline increment expression slightly noisy — extract id to local const — Phase 2: Server — guessWord
- 🔵 **Suggestion** (low confidence): `BestClueGiverSection` above conditional block creates minor edge-case layout oddity — Phase 3: Frontend

---

### Standards

**Summary**: Broadly consistent with project conventions. Naming, placement, imports all follow established patterns. Two minor deviations: free-function call on a class method, and multi-line signature style differs from existing single-line style.

**Strengths**:
- `BestClueGiver` and `GameStats` extension follow existing `shared/src/types.ts` conventions
- `clueGiverStats` follows camelCase noun-phrase naming convention
- Correct identification of `toPublicGame` stripping requirement
- No new API routes
- Mock stub matches existing pattern
- `BestClueGiverSection` is correctly named in PascalCase
- `import type { BestClueGiver }` follows existing client import pattern

**Findings**:
- 🔵 **Minor** (high confidence): Helper called as free function but defined as private class method — Phase 2: Server — computeBestClueGiver
- 🔵 **Minor** (medium confidence): `toPublicGame` signature expansion uses multi-line style vs existing single-line — Phase 2: Server — toPublicGame
- 🔵 **Suggestion** (medium confidence): New `<section>` lacks `aria-labelledby` for screen reader navigation — Phase 3: Frontend

---

### Compatibility

**Summary**: Additive change to shared type is handled correctly with `| null`. One major sequencing issue: the mock update must move to Phase 1 to avoid a typecheck-breaking gap. No external API versioning concerns.

**Strengths**:
- `bestClueGiver: BestClueGiver | null` is forward-compatible
- Phase 4 mock update explicitly planned
- `toPublicGame` stripping prevents internal state leakage
- `GameStore` interface change will enforce implementation update via TypeScript

**Findings**:
- 🟡 **Major** (high confidence): Phase ordering creates typecheck-breaking gap between Phase 1 and Phase 4 — Phase 1 / Phase 4
- 🔵 **Minor** (high confidence): Required field addition breaks any other `GameStore` implementations (only one exists today) — Phase 1: Shared Types
