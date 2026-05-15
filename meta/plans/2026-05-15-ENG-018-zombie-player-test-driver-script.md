---
date: "2026-05-15T00:00:00+00:00"
type: plan
skill: create-plan
work-item: "meta/tickets/ENG-018-zombie-player-test-driver-script.md"
status: draft
---

# ENG-018: Zombie Player Test Driver Script

## Overview

A `scripts/test-driver.ts` CLI script that joins a Wordfetti game as three automated "zombie" players, drives them through the full game lifecycle via the existing REST+SSE API, and lets a single developer manually test gameplay features from one browser tab without coordinating real players.

## Current State Analysis

- `scripts/` directory exists at the monorepo root and contains only `deploy.sh`
- No testing script exists today; developers must open 4 browser tabs and coordinate manually
- The API is fully functional REST+SSE — no server changes are required
- `tsx` is available as a devDependency in `server/package.json`; the monorepo root has no devDependencies beyond `concurrently`
- `eventsource` npm package is not yet installed anywhere in the project
- No root-level `tsconfig.json` exists; `tsx` runs TypeScript without one

### Key Discoveries

- `shared/src/types.ts:1-36` — `Game` type has all fields the script needs: `status`, `currentClueGiverId`, `turnPhase`, `currentWord`, `players`, `settings.wordsPerPlayer`
- `server/src/routes/games.ts:363-386` — join endpoint is `POST /api/games/:joinCode/players` with body `{name, team}` → returns `{player: Player}`
- `server/src/routes/games.ts:164-191` — word submission is `POST /api/games/:joinCode/words` with body `{playerId, text}` → returns `{word}`
- `server/src/routes/games.ts:89-130` — SSE stream is `GET /api/games/:joinCode/events`; emits full public `Game` JSON on every state change, plus a keepalive comment every 25s
- `server/src/routes/games.ts:234-255` — ready endpoint `POST /api/games/:joinCode/ready` with body `{playerId}`
- `server/src/routes/games.ts:258-282` — guess endpoint `POST /api/games/:joinCode/guess` with body `{playerId}`
- `server/src/routes/games.ts:285-309` — skip endpoint `POST /api/games/:joinCode/skip` with body `{playerId}`
- Turn ends when `currentWord` becomes `undefined` (hat empty) or `turnPhase` reverts to `'ready'` (timer expired via real player's browser firing `end-turn`)
- `util.parseArgs` (Node 18+ built-in) handles CLI arg parsing with no extra dependency

## Desired End State

Running `npx tsx scripts/test-driver.ts <joinCode>` (or `pnpm zombie <joinCode>`) against a game in lobby state with the real player already joined will:

1. Join 3 bots visible in the lobby within 2 seconds, teams balanced 2v2
2. Each bot automatically submits the required number of words
3. When the host starts the game, bots automatically drive their turns: calling ready, then guessing/skipping words with configurable delay and skip probability
4. Status transitions are logged to stdout so the developer can follow along
5. On game end, a summary is printed and the process exits with code 0

### Verification

- Run `pnpm install` in repo root → succeeds, `eventsource` present in node_modules
- Run `pnpm zombie --help` → prints usage (or `pnpm zombie` with no joinCode → prints error)
- Join a game manually, run script → 3 bots appear in lobby, words submitted, host can start game
- With `--turn-delay 100 --skip-chance 0`: bots empty the hat in a single turn
- With `--skip-chance 100`: bots never guess, turns end via timer
- When game finishes: script prints summary and exits 0

## What We're NOT Doing

- Not modifying any server-side code
- Not implementing host functionality (bots never advance rounds or create games)
- Not adding bot-vs-bot full automation (round advancement is manual by the real player)
- Not adding a test for the script itself (it's a dev tool, not business logic)
- Not supporting custom word list paths via a CLI flag

---

## Phase 1: Dependencies, Word List, and Package Setup

### Overview

Install the `eventsource` package, create the word list, and wire up the root `package.json` script so the tool is discoverable.

### Changes Required

#### 1. Add `eventsource` to root `devDependencies`

Run from the monorepo root:

```bash
pnpm add -D -w eventsource @types/eventsource
```

This adds both the runtime package and its TypeScript types to the workspace root.

#### 2. Add `"zombie"` script to root `package.json`

**File**: `package.json`

```json
{
  "scripts": {
    "dev": "concurrently \"pnpm --filter server dev\" \"pnpm --filter client dev\"",
    "build": "pnpm --filter shared build && pnpm --filter server build && pnpm --filter client build",
    "test": "pnpm --filter server test",
    "typecheck": "pnpm --filter shared typecheck && pnpm --filter server typecheck && pnpm --filter client typecheck",
    "check": "pnpm typecheck && pnpm test && pnpm build",
    "zombie": "tsx scripts/test-driver.ts"
  }
}
```

#### 3. Create `scripts/test-words.txt`

**File**: `scripts/test-words.txt`

One word per line, ~30 hat-game-appropriate words (concrete nouns and well-known proper nouns work best in round 1 and carry through to rounds 2 and 3):

```
elephant
spaghetti
lighthouse
volcano
parachute
submarine
kangaroo
accordion
telescope
cactus
avalanche
flamingo
trampoline
sombrero
quicksand
hamster
escalator
tortoise
thermometer
badminton
jellyfish
catapult
stalagmite
wheelbarrow
rhinoceros
sunflower
tambourine
crocodile
boomerang
dandelion
```

### Success Criteria

#### Automated Verification

- [x] `pnpm install` completes without errors
- [x] `node -e "import('eventsource')"` exits 0 (package resolvable from root)
- [x] `scripts/test-words.txt` exists with at least 30 non-blank lines: `grep -c '\S' scripts/test-words.txt`
- [x] `pnpm zombie 2>&1 | head -5` prints a recognisable error (missing joinCode), confirming the script entry point resolves

---

## Phase 2: Script Implementation

### Overview

Implement `scripts/test-driver.ts` — the full lifecycle driver. The script is a single self-contained TypeScript file with no imports from the monorepo's source packages (it talks to the running server over HTTP).

### Changes Required

#### 1. Create `scripts/test-driver.ts`

**File**: `scripts/test-driver.ts`

```typescript
import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import EventSource from 'eventsource'
import type { Game, Player, Team } from '../shared/src/types.js'

// ── CLI ───────────────────────────────────────────────────────────────────────

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    url:          { type: 'string',  default: 'http://localhost:3000' },
    'turn-delay': { type: 'string',  default: '500' },
    'skip-chance': { type: 'string', default: '10' },
  },
})

const joinCode = positionals[0]?.toUpperCase()
if (!joinCode) {
  console.error('Usage: test-driver.ts <joinCode> [--url <baseUrl>] [--turn-delay <ms>] [--skip-chance <percent>]')
  process.exit(1)
}

const BASE_URL   = (values.url as string).replace(/\/$/, '')
const TURN_DELAY = parseInt(values['turn-delay'] as string, 10)
const SKIP_CHANCE = parseInt(values['skip-chance'] as string, 10)

if (isNaN(TURN_DELAY) || TURN_DELAY < 0) {
  console.error('--turn-delay must be a non-negative integer (ms)')
  process.exit(1)
}
if (isNaN(SKIP_CHANCE) || SKIP_CHANCE < 0 || SKIP_CHANCE > 100) {
  console.error('--skip-chance must be an integer 0–100')
  process.exit(1)
}

// ── Word list ─────────────────────────────────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url))
const WORDS = readFileSync(join(__dir, 'test-words.txt'), 'utf8')
  .split('\n')
  .map(w => w.trim())
  .filter(w => w.length > 0)

if (WORDS.length === 0) {
  console.error('scripts/test-words.txt is empty')
  process.exit(1)
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function apiUrl(path: string) {
  return `${BASE_URL}/api/games/${joinCode}${path}`
}

async function post(path: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`POST ${path} → ${res.status}: ${text}`)
  }
  return res.json()
}

function randomWord(): string {
  return WORDS[Math.floor(Math.random() * WORDS.length)]
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[zombie] Connecting to ${BASE_URL} for game ${joinCode}`)

  // 1. Fetch current game state
  const gameRes = await fetch(apiUrl(''))
  if (!gameRes.ok) {
    console.error(`Failed to fetch game: ${gameRes.status}`)
    process.exit(1)
  }
  const initialGame: Game = await gameRes.json()

  if (initialGame.status !== 'lobby') {
    console.error(`Game is not in lobby state (current: ${initialGame.status})`)
    process.exit(1)
  }

  // 2. Join as 3 bots with greedy team balancing
  const bots: Map<string, Player> = new Map()
  let gamePlayers = initialGame.players

  for (let i = 1; i <= 3; i++) {
    const team1Count = gamePlayers.filter(p => p.team === 1).length
    const team2Count = gamePlayers.filter(p => p.team === 2).length
    const team: Team = team2Count < team1Count ? 2 : 1

    const name = `Bot ${i}`
    const result = await post('/players', { name, team }) as { player: Player }
    const bot = result.player
    bots.set(bot.id, bot)
    gamePlayers = [...gamePlayers, bot]
    console.log(`[zombie] ${name} joined team ${team} (id: ${bot.id})`)
  }

  // 3. Submit words for each bot
  const wordsPerPlayer = initialGame.settings.wordsPerPlayer
  await Promise.all(
    Array.from(bots.values()).map(async bot => {
      for (let w = 0; w < wordsPerPlayer; w++) {
        await post('/words', { playerId: bot.id, text: randomWord() })
      }
      console.log(`[zombie] ${bot.name} submitted ${wordsPerPlayer} word(s)`)
    })
  )

  // 4. Open SSE connection and drive turns reactively
  let currentGame: Game | null = null
  let drivingTurn = false

  const es = new EventSource(apiUrl('/events'))

  es.onmessage = (event: MessageEvent) => {
    const game: Game = JSON.parse(event.data)
    const prev = currentGame
    currentGame = game

    if (game.status === 'finished') {
      console.log(`[zombie] Game finished! Scores — ${game.teamNames.team1}: ${game.scores?.team1 ?? 0}, ${game.teamNames.team2}: ${game.scores?.team2 ?? 0}`)
      es.close()
      process.exit(0)
    }

    if (game.status === 'between_rounds' && prev?.status !== 'between_rounds') {
      console.log(`[zombie] Round ended. Waiting for host to advance...`)
      drivingTurn = false
    }

    if (
      game.status === 'in_progress' &&
      game.turnPhase === 'ready' &&
      game.currentClueGiverId &&
      bots.has(game.currentClueGiverId) &&
      !drivingTurn
    ) {
      const bot = bots.get(game.currentClueGiverId)!
      console.log(`[zombie] ${bot.name}'s turn — starting`)
      drivingTurn = true
      driveTurn(bot).catch(err => {
        console.error(`[zombie] Turn driver error: ${err.message}`)
        drivingTurn = false
      })
    }
  }

  es.onerror = () => {
    console.error('[zombie] SSE connection error')
  }
}

async function driveTurn(bot: Player) {
  await post('/ready', { playerId: bot.id })
  console.log(`[zombie] ${bot.name} is ready`)

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Re-read shared state on each iteration
    const game = (globalThis as unknown as { __currentGame: Game }).__currentGame
    if (!game || game.currentWord === undefined || game.turnPhase === 'ready') break

    const action = Math.random() * 100 < SKIP_CHANCE ? 'skip' : 'guess'
    await post(`/${action}`, { playerId: bot.id })
    console.log(`[zombie] ${bot.name} ${action}ed "${game.currentWord}"`)

    await sleep(TURN_DELAY)
  }

  console.log(`[zombie] ${bot.name}'s turn ended`)
  // drivingTurn reset happens in onmessage when turnPhase returns to 'ready'
}

main().catch(err => {
  console.error(`[zombie] Fatal: ${err.message}`)
  process.exit(1)
})
```

**Implementation note on shared state**: The `driveTurn` loop needs to read the latest SSE-delivered game state on each iteration. Rather than `globalThis`, the cleaner approach is a module-level `let currentGame` variable and a closure — see the refined implementation in the success criteria section below. The pseudocode above illustrates the logic; the actual file should use a closure-based approach where `driveTurn` reads from the outer `currentGame` variable directly (since both `onmessage` and `driveTurn` share the same module scope).

**Refined implementation structure** (module scope, no globalThis):

```typescript
// module-level
let currentGame: Game | null = null
let drivingTurn = false

// in onmessage:
currentGame = game   // updated on every SSE event

// in driveTurn (reads `currentGame` from enclosing module scope):
while (true) {
  if (!currentGame || currentGame.currentWord === undefined || currentGame.turnPhase === 'ready') break
  // ...
}
```

### Success Criteria

#### Automated Verification

- [x] TypeScript compiles without errors: `cd server && npx tsc --noEmit --skipLibCheck ../scripts/test-driver.ts` (or `pnpm typecheck` if root tsconfig added)
- [x] Script file exists: `ls scripts/test-driver.ts`
- [x] Script exits with code 1 and prints usage when no joinCode given: `pnpm zombie; echo "exit: $?"`

#### Manual Verification

- [ ] Start dev server (`pnpm dev`), create a game in the browser, copy the join code
- [ ] Run `pnpm zombie <joinCode>` — 3 bots appear in the lobby within 2 seconds
- [ ] Lobby shows Bot 1, Bot 2, Bot 3 with correct teams (2 per team including the real player)
- [ ] Words submitted count matches `settings.wordsPerPlayer` for each bot; start button becomes active
- [ ] Host clicks Start — bots automatically call ready and begin guessing/skipping
- [ ] Run with `--turn-delay 100 --skip-chance 0` — bots rapidly guess all words, emptying hat in one turn
- [ ] Run with `--skip-chance 100` — bots only skip; turns end via timer
- [ ] After 3 complete rounds, script prints score summary and exits 0
- [ ] Run with `--url http://localhost:3000` — all requests target that host (verify in server logs)

---

## Testing Strategy

This is a developer tooling script. No unit or integration tests are required. Manual verification against a running dev server (per the success criteria above) is sufficient.

## References

- Work item: `meta/tickets/ENG-018-zombie-player-test-driver-script.md`
- Related: `meta/plans/2026-03-22-ENG-012-round1-timer-and-turn-rotation.md` (timer logic the script reacts to)
- Related: `meta/plans/2026-03-22-ENG-011-round1-guess-skip-round-end.md` (guess/skip mechanics)
- API routes: `server/src/routes/games.ts`
- Shared types: `shared/src/types.ts`
