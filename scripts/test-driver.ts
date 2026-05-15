import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { EventSource } from 'eventsource'
import type { Game, Player, Team } from '../shared/src/types.js'

// ── CLI ───────────────────────────────────────────────────────────────────────

const HELP = `
Usage: pnpm zombie <joinCode> [options]

Joins a Wordfetti game as 3 automated bot players and drives them through
the full game lifecycle. The game must already be in lobby state.

Arguments:
  joinCode              The join code shown in the lobby (required)

Options:
  --url <baseUrl>       Base URL of the running server
                        (default: http://localhost:5173)
  --turn-delay <ms>     Milliseconds to wait between each guess/skip action
                        (default: 500)
  --skip-chance <%>     Probability (0–100) that a bot skips instead of guessing
                        (default: 10)
  -h, --help            Print this help message

Examples:
  pnpm zombie ABC123
  pnpm zombie ABC123 --turn-delay 100 --skip-chance 0   # empty hat fast
  pnpm zombie ABC123 --skip-chance 100                  # only skips, turns end via timer
  pnpm zombie ABC123 --url http://localhost:3000
`.trim()

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    url:           { type: 'string',  default: 'http://localhost:5173' },
    'turn-delay':  { type: 'string',  default: '500' },
    'skip-chance': { type: 'string',  default: '10' },
    help:          { type: 'boolean', short: 'h', default: false },
  },
})

if (values.help) {
  console.log(HELP)
  process.exit(0)
}

const joinCode = positionals[0]?.toUpperCase()
if (!joinCode) {
  console.error('Error: <joinCode> is required.\n')
  console.error(HELP)
  process.exit(1)
}

const BASE_URL    = (values.url as string).replace(/\/$/, '')
const TURN_DELAY  = parseInt(values['turn-delay'] as string, 10)
const SKIP_CHANCE = parseInt(values['skip-chance'] as string, 10)

if (isNaN(TURN_DELAY) || TURN_DELAY < 0) {
  console.error('Error: --turn-delay must be a non-negative integer (milliseconds)\n')
  console.error(HELP)
  process.exit(1)
}
if (isNaN(SKIP_CHANCE) || SKIP_CHANCE < 0 || SKIP_CHANCE > 100) {
  console.error('Error: --skip-chance must be an integer between 0 and 100\n')
  console.error(HELP)
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

// ── Shared state (read by both onmessage and driveTurn) ───────────────────────

let currentGame: Game | null = null
let drivingTurn = false
const bots: Map<string, Player> = new Map()

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[zombie] Connecting to ${BASE_URL} for game ${joinCode}`)

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

  // Join as 3 bots with greedy team balancing
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

  // Submit words for each bot
  const wordsPerPlayer = initialGame.settings.wordsPerPlayer
  await Promise.all(
    Array.from(bots.values()).map(async bot => {
      for (let w = 0; w < wordsPerPlayer; w++) {
        await post('/words', { playerId: bot.id, text: randomWord() })
      }
      console.log(`[zombie] ${bot.name} submitted ${wordsPerPlayer} word(s)`)
    })
  )

  // Open SSE connection and drive turns reactively
  const { turnDurationSeconds } = initialGame.settings
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

    // Reset flag whenever a human player's turn starts (no bot to drive it)
    if (
      game.status === 'in_progress' &&
      game.turnPhase === 'ready' &&
      game.currentClueGiverId &&
      !bots.has(game.currentClueGiverId)
    ) {
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
      driveTurn(bot, turnDurationSeconds).catch(err => {
        console.error(`[zombie] Turn driver error: ${err.message}`)
        drivingTurn = false
      })
    }
  }

  es.onerror = () => {
    console.error('[zombie] SSE connection error')
  }
}

async function driveTurn(bot: Player, turnDurationSeconds: number) {
  await post('/ready', { playerId: bot.id })
  console.log(`[zombie] ${bot.name} is ready`)

  // Wait for the SSE to deliver turnPhase:'active' before starting the loop.
  // Without this, currentGame still reflects the pre-ready state, the loop
  // exits immediately on the turnPhase==='ready' check, and nothing happens.
  const activationDeadline = Date.now() + 5000
  while (Date.now() < activationDeadline) {
    if (currentGame?.turnPhase === 'active' && currentGame?.currentClueGiverId === bot.id) break
    await sleep(50)
  }

  if (currentGame?.turnPhase !== 'active' || currentGame?.currentClueGiverId !== bot.id) {
    console.error(`[zombie] ${bot.name}'s turn never became active — giving up`)
    drivingTurn = false
    return
  }

  // Use turnStartedAt from the SSE payload so the timer is accurate even if
  // the polling above took a few hundred milliseconds to confirm activation.
  const startedAt = currentGame.turnStartedAt
    ? new Date(currentGame.turnStartedAt).getTime()
    : Date.now()
  const msRemaining = startedAt + turnDurationSeconds * 1000 - Date.now()

  let turnEnded = false

  // The server never auto-ends a turn — the client must call end-turn when the
  // timer expires. Schedule it here so the game progresses when time runs out.
  const timerHandle = setTimeout(async () => {
    if (turnEnded) return
    console.log(`[zombie] ${bot.name}'s timer expired — calling end-turn`)
    await post('/end-turn', { playerId: bot.id }).catch(err => {
      console.error(`[zombie] end-turn (timer) error: ${err.message}`)
    })
  }, Math.max(0, msRemaining) + 300)

  try {
    while (true) {
      if (!currentGame || currentGame.currentWord === undefined || currentGame.turnPhase !== 'active') break

      const action = Math.random() * 100 < SKIP_CHANCE ? 'skip' : 'guess'
      await post(`/${action}`, { playerId: bot.id })
      console.log(`[zombie] ${bot.name} ${action}ed "${currentGame.currentWord}"`)

      await sleep(TURN_DELAY)
    }

    // Hat emptied mid-turn: turnPhase is still 'active' but no words remain.
    // Call end-turn so the server advances to the next player.
    if (currentGame?.turnPhase === 'active') {
      console.log(`[zombie] ${bot.name} hat empty — calling end-turn`)
      await post('/end-turn', { playerId: bot.id }).catch(err => {
        console.error(`[zombie] end-turn (hat empty) error: ${err.message}`)
      })
    }
  } finally {
    turnEnded = true
    clearTimeout(timerHandle)
    drivingTurn = false
  }

  console.log(`[zombie] ${bot.name}'s turn ended`)

  // The SSE event for the next player's turn may have arrived while drivingTurn
  // was still true (timer callback and the while loop are concurrent), causing
  // onmessage to skip it. Check now that the flag is clear and catch up.
  const pending = currentGame
  if (
    pending?.status === 'in_progress' &&
    pending?.turnPhase === 'ready' &&
    pending?.currentClueGiverId &&
    bots.has(pending.currentClueGiverId)
  ) {
    const nextBot = bots.get(pending.currentClueGiverId)!
    console.log(`[zombie] ${nextBot.name}'s turn — starting (caught missed SSE)`)
    drivingTurn = true
    driveTurn(nextBot, turnDurationSeconds).catch(err => {
      console.error(`[zombie] Turn driver error: ${err.message}`)
      drivingTurn = false
    })
  }
}

main().catch(err => {
  console.error(`[zombie] Fatal: ${err.message}`)
  process.exit(1)
})
