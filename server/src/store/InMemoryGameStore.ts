import { randomUUID } from 'crypto'
import { type BestClueGiver, type Game, type GameSettings, type GameStats, type Player, type Team, type Word } from '@wordfetti/shared'
import type { GameStore, GameStoreStats } from './GameStore.js'
import type { GameConfig } from '../config.js'
import { generateJoinCode } from './joinCode.js'
import { pickTeamNames } from '../teamNames.js'
import { AppError } from '../errors.js'
import { logger } from '../logger.js'
import { PlayerRoster } from './PlayerRoster.js'

const MAX_JOIN_CODE_ATTEMPTS = 10
const STALE_GAME_TTL_MS = 8 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000

export type InternalGame = Omit<Game, 'players'> & {
  roster: PlayerRoster
  hat: Word[]
  originalWords: Word[]          // full word list set at startGame; used to refill hat each round
  skippedThisTurn: string[]  // word IDs skipped this turn
  currentWordId?: string     // ID of the word currently being described
  createdAt: string
  updatedAt: string
}

function shuffle<T>(arr: T[]): T[] {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

function computeBestClueGiver(players: Player[]): BestClueGiver | null {
  const withStats = players.filter((p) => p.stats.clueGiverCount > 0)
  if (withStats.length === 0) return null
  const max = Math.max(...withStats.map((p) => p.stats.clueGiverCount))
  const names = withStats
    .filter((p) => p.stats.clueGiverCount === max)
    .map((p) => p.name)
    .sort((a, b) => a.localeCompare(b))
  return { names, clueCount: max }
}

export function toPublicGame(game: InternalGame): Game {
  const { hat: _hat, skippedThisTurn: _skipped, currentWordId: _id, originalWords: _ow, roster, createdAt: _ca, updatedAt: _ua, ...rest } = game
  return { ...rest, players: roster.getAll() }
}

export class InMemoryGameStore implements GameStore {
  private readonly games = new Map<string, InternalGame>()
  private readonly subscribers = new Map<string, Set<(game: Game) => void>>()
  private readonly words = new Map<string, Word[]>()
  private lastCleanupAt: string | null = null
  private lastCleanupRemovedCount = 0

  constructor(
    private readonly config: GameConfig,
    private readonly teamNamesPool: string[] = ['Team 1', 'Team 2'],
  ) {
    const cleanupTimer = setInterval(() => {
      this.cleanupStaleGames()
    }, CLEANUP_INTERVAL_MS)
    cleanupTimer.unref()
  }

  getTeamNamePreview(): { team1: string; team2: string } {
    return pickTeamNames(this.teamNamesPool)
  }

  getStats(): GameStoreStats {
    let words = 0
    for (const playerWords of this.words.values()) {
      words += playerWords.length
    }

    let subscribers = 0
    for (const gameSubscribers of this.subscribers.values()) {
      subscribers += gameSubscribers.size
    }

    return {
      games: this.games.size,
      words,
      subscribers,
      lastCleanupAt: this.lastCleanupAt,
      lastCleanupRemovedCount: this.lastCleanupRemovedCount,
    }
  }

  private touchGame(game: InternalGame): void {
    game.updatedAt = new Date().toISOString()
  }

  private notifySubscribers(joinCode: string, game: InternalGame): Game {
    this.touchGame(game)
    const publicGame = toPublicGame(game)
    this.subscribers.get(joinCode)?.forEach((cb) => cb(publicGame))
    return publicGame
  }

  private removeGame(joinCode: string, reason: 'stale'): void {
    this.games.delete(joinCode)
    this.subscribers.delete(joinCode)

    for (const key of this.words.keys()) {
      if (key.startsWith(`${joinCode}:`)) {
        this.words.delete(key)
      }
    }

    logger.info('Game removed from in-memory store', {
      joinCode,
      reason,
      ...this.getStats(),
    })
  }

  private cleanupStaleGames(): void {
    const now = Date.now()
    const removedJoinCodes: string[] = []

    for (const [joinCode, game] of this.games.entries()) {
      const updatedAt = Date.parse(game.updatedAt)
      if (Number.isNaN(updatedAt) || now - updatedAt < STALE_GAME_TTL_MS) {
        continue
      }

      removedJoinCodes.push(joinCode)
      this.removeGame(joinCode, 'stale')
    }

    this.lastCleanupAt = new Date().toISOString()
    this.lastCleanupRemovedCount = removedJoinCodes.length

    if (removedJoinCodes.length > 0) {
      logger.info('Stale game cleanup completed', {
        removedGames: removedJoinCodes,
        ...this.getStats(),
      })
    }
  }

  async createGame(teamNames?: { team1: string; team2: string }): Promise<Game> {
    let joinCode: string
    let attempts = 0
    do {
      if (attempts >= MAX_JOIN_CODE_ATTEMPTS) {
        throw new Error('Failed to generate a unique join code')
      }
      joinCode = generateJoinCode()
      attempts++
    } while (this.games.has(joinCode))

    const now = new Date().toISOString()
    const game: InternalGame = {
      id: randomUUID(),
      joinCode,
      createdAt: now,
      updatedAt: now,
      status: 'lobby',
      roster: new PlayerRoster(),
      teamNames: teamNames ?? pickTeamNames(this.teamNamesPool),
      settings: {
        wordsPerPlayer: this.config.wordsPerPlayer,
        turnDurationSeconds: this.config.turnDurationSeconds,
      },
      hat: [],
      originalWords: [],
      skippedThisTurn: [],
    }
    this.games.set(joinCode, game)
    logger.info('Game added to in-memory store', { joinCode, ...this.getStats() })
    return toPublicGame(game)
  }

  async createGameWithHost(name: string, team: Team, teamNames?: { team1: string; team2: string }): Promise<{ game: Game; player: Player }> {
    const game = await this.createGame(teamNames)
    const player = await this.joinGame(game.joinCode, name, team)
    // Record the host on the internal game object
    const internal = this.games.get(game.joinCode)!
    internal.hostId = player.id
    const updated = await this.getGameByJoinCode(game.joinCode)
    return { game: updated!, player }
  }

  async getGameByJoinCode(joinCode: string): Promise<Game | null> {
    const game = this.games.get(joinCode)
    if (!game) return null
    return toPublicGame(game)
  }

  async joinGame(joinCode: string, name: string, team: Team): Promise<Player> {
    const game = this.games.get(joinCode)
    if (!game) throw new AppError('NOT_FOUND', 'Game not found')
    if (game.status !== 'lobby') throw new AppError('GAME_IN_PROGRESS', 'Game has already started')
    const isDuplicate = game.roster.hasDuplicateName(name)
    // Note: no `await` exists between this check and roster.add below,
    // so Node.js's single-threaded event loop guarantees the check-then-act is atomic.
    // If an `await` is ever introduced between these two lines, a mutex will be needed.
    if (isDuplicate) throw new AppError('NAME_TAKEN', 'That name is already taken')
    const player = game.roster.add({ id: randomUUID(), name, team, wordCount: 0 })
    this.notifySubscribers(joinCode, game)
    return { ...player }
  }

  async startGame(joinCode: string): Promise<Game> {
    const game = this.games.get(joinCode)
    if (!game) throw new AppError('NOT_FOUND', 'Game not found')

    const allWords: Word[] = game.roster.getActive().flatMap((p) =>
      this.words.get(`${joinCode}:${p.id}`) ?? []
    )

    const shuffledWords = shuffle(allWords)

    const activeTeam: 1 | 2 = Math.random() < 0.5 ? 1 : 2

    // Reset stats before assigning first clue giver for a clean round 1 baseline
    game.roster.resetStats()

    if (game.roster.getByTeam(activeTeam).length === 0) {
      throw new AppError('INVALID_STATE', 'No players on the active team')
    }
    const firstClueGiver = game.roster.assignNextClueGiver(activeTeam)

    // Commit all mutations in a single step to avoid partial state on future errors
    Object.assign(game, {
      status: 'in_progress',
      round: 1,
      hat: shuffledWords,
      originalWords: [...allWords],   // snapshot of the full word list (unshuffled) for hat refill each round
      activeTeam,
      currentClueGiverId: firstClueGiver.id,
      turnPhase: 'ready',
      scores: { team1: 0, team2: 0 },
      skippedThisTurn: [],
    })

    const snapshot = this.notifySubscribers(joinCode, game)
    return snapshot
  }

  subscribe(joinCode: string, callback: (game: Game) => void): () => void {
    if (!this.subscribers.has(joinCode)) {
      this.subscribers.set(joinCode, new Set())
    }
    this.subscribers.get(joinCode)!.add(callback)
    return () => {
      const subs = this.subscribers.get(joinCode)
      if (!subs) return
      subs.delete(callback)
      // Prune the Set entry once empty to avoid accumulating orphaned map entries
      if (subs.size === 0) this.subscribers.delete(joinCode)
    }
  }

  private resolveRoundEndStatus(round: 1 | 2 | 3): Game['status'] {
    switch (round) {
      case 1: return 'between_rounds'
      case 2: return 'between_rounds'
      case 3: return 'finished'
    }
  }

  private assertClueGiverTurn(joinCode: string, playerId: string): InternalGame {
    const game = this.games.get(joinCode)
    if (!game) throw new AppError('NOT_FOUND', 'Game not found')
    if (game.status !== 'in_progress') throw new AppError('TURN_NOT_ALLOWED', 'Game is not in progress')
    if (game.currentClueGiverId !== playerId) throw new AppError('FORBIDDEN', 'Only the clue giver can do this')
    return game
  }

  private drawNextWord(hat: Word[], current: Word | null, skipped: string[]): Word | null {
    const available = hat.filter((w) => w.id !== current?.id && !skipped.includes(w.id))
    if (available.length > 0) return available[0]
    const fallback = hat.filter((w) => w.id !== current?.id)
    if (fallback.length > 0) return fallback[0]
    return null
  }

  async readyTurn(joinCode: string, playerId: string): Promise<Game> {
    const game = this.assertClueGiverTurn(joinCode, playerId)
    if (game.turnPhase !== 'ready') throw new AppError('TURN_ALREADY_ACTIVE', 'Turn is already active')

    const firstWord = game.hat[0] ?? null
    if (!firstWord) throw new AppError('HAT_EMPTY', 'Hat is empty')

    const turnStartedAt = new Date().toISOString()

    Object.assign(game, {
      turnPhase: 'active',
      currentWord: firstWord.text,
      currentWordId: firstWord.id,
      skippedThisTurn: [],
      guessedThisTurn: [],
      turnStartedAt,
    })

    // Server-side fallback: auto-end the turn if no client calls /end-turn in time.
    // The turnStartedAt guard prevents this from firing against a later turn that
    // happened to reuse the same joinCode slot.
    const { turnDurationSeconds } = game.settings
    setTimeout(async () => {
      const current = this.games.get(joinCode)
      if (current?.turnPhase === 'active' && current?.turnStartedAt === turnStartedAt) {
        await this.endTurn(joinCode, playerId).catch(() => {
          // Client already called end-turn between the check and here — ignore.
        })
      }
    }, turnDurationSeconds * 1000 + 500)

    const clueGiver = game.roster.getById(game.currentClueGiverId ?? '')
    logger.debug('Turn started', {
      joinCode,
      activeTeam: game.activeTeam,
      clueGiver: clueGiver?.name,
      firstWord: firstWord.text,
      wordsRemainingInHat: game.hat.length,
      hat: game.hat.map((w) => w.text),
    })

    const snapshot = this.notifySubscribers(joinCode, game)
    return snapshot
  }

  async endTurn(joinCode: string, playerId: string): Promise<Game> {
    const game = this.assertClueGiverTurn(joinCode, playerId)
    if (game.turnPhase !== 'active') throw new AppError('TURN_NOT_ACTIVE', 'Turn is not active')

    // Current word stays in hat (never removed during an active turn — only guessWord removes words).
    // Defensive guard: this path is unreachable via the public API; guard anyway so a bug surfaces loudly.
    if (game.hat.length === 0) {
      const newStatus = this.resolveRoundEndStatus(game.round as 1 | 2 | 3)
      Object.assign(game, {
        status: newStatus,
        currentWord: undefined,
        currentWordId: undefined,
        currentClueGiverId: undefined,
        turnPhase: undefined,
        turnStartedAt: undefined,
      })
      const snapshot = this.notifySubscribers(joinCode, game)
      return snapshot
    }

    // Guard optional fields before mutation
    if (!game.activeTeam) throw new AppError('INVALID_STATE', 'Active team not set')

    // Rotate to the other team; assignNextClueGiver throws if no active players remain
    const newTeam: 1 | 2 = game.activeTeam === 1 ? 2 : 1
    const nextClueGiver = game.roster.assignNextClueGiver(newTeam)

    Object.assign(game, {
      activeTeam: newTeam,
      currentClueGiverId: nextClueGiver.id,
      turnPhase: 'ready',
      currentWord: undefined,
      currentWordId: undefined,
      skippedThisTurn: [],
      guessedThisTurn: [],
      turnStartedAt: undefined,
    })

    logger.info('Turn ended', { joinCode, newActiveTeam: newTeam, nextClueGiver: nextClueGiver.name })

    const snapshot = this.notifySubscribers(joinCode, game)
    return snapshot
  }

  async advanceRound(joinCode: string, playerId: string): Promise<Game> {
    const game = this.games.get(joinCode)
    if (!game) throw new AppError('NOT_FOUND', 'Game not found')
    if (game.hostId !== playerId) throw new AppError('FORBIDDEN', 'Only the host can advance the round')
    if (game.status !== 'between_rounds') throw new AppError('INVALID_STATE', 'Game is not between rounds')
    if (game.round === 3) throw new AppError('INVALID_STATE', 'Cannot advance beyond round 3')

    // Use the shared shuffle helper — no inline duplication
    const shuffledHat = shuffle(game.originalWords)

    // The round ended mid-turn (guessWord drains the hat without calling endTurn), so activeTeam
    // is still the team that gave the last clue. Mirror endTurn: flip to the OTHER team.
    const newActiveTeam: 1 | 2 = game.activeTeam === 1 ? 2 : 1
    const nextClueGiver = game.roster.assignNextClueGiver(newActiveTeam)

    Object.assign(game, {
      round: (game.round === 1 ? 2 : 3) as 1 | 2 | 3,
      status: 'in_progress',
      hat: shuffledHat,
      turnPhase: 'ready',
      activeTeam: newActiveTeam,
      currentClueGiverId: nextClueGiver.id,
      currentWord: undefined,
      currentWordId: undefined,
      turnStartedAt: undefined,
      guessedThisTurn: [],     // clear stale data from round 1's last turn
      skippedThisTurn: [],
    })

    logger.info('Round advanced', { joinCode, round: game.round })

    const snapshot = this.notifySubscribers(joinCode, game)
    return snapshot
  }

  async guessWord(joinCode: string, playerId: string): Promise<Game> {
    const game = this.assertClueGiverTurn(joinCode, playerId)
    if (game.turnPhase !== 'active') throw new AppError('TURN_NOT_ACTIVE', 'Turn is not active')
    if (!game.currentWordId) throw new AppError('INVALID_STATE', 'No current word set')
    if (!game.scores) throw new AppError('INVALID_STATE', 'Game scores not initialised')
    if (!game.activeTeam) throw new AppError('INVALID_STATE', 'Active team not set')
    if (!game.currentWord) throw new AppError('INVALID_STATE', 'Current word text not set')

    const currentId = game.currentWordId
    const currentText = game.currentWord
    game.hat = game.hat.filter((w) => w.id !== currentId)
    game.scores[game.activeTeam === 1 ? 'team1' : 'team2']++
    game.guessedThisTurn = [...(game.guessedThisTurn ?? []), currentText]

    if (game.currentClueGiverId) {
      game.roster.incrementStat(game.currentClueGiverId)
    }

    if (game.hat.length === 0) {
      const newStatus = this.resolveRoundEndStatus(game.round as 1 | 2 | 3)
      logger.debug('Word guessed — hat empty, round over', {
        joinCode,
        guessedWord: currentText,
        guessedThisTurn: game.guessedThisTurn,
        scores: game.scores,
      })
      Object.assign(game, {
        status: newStatus,
        currentWord: undefined,
        currentWordId: undefined,
        currentClueGiverId: undefined,
        turnPhase: undefined,
        turnStartedAt: undefined,
      })
    } else {
      const next = this.drawNextWord(game.hat, null, game.skippedThisTurn)
      game.currentWord = next?.text
      game.currentWordId = next?.id
      logger.debug('Word guessed', {
        joinCode,
        guessedWord: currentText,
        nextWord: next?.text,
        wordsRemainingInHat: game.hat.length,
        hat: game.hat.map((w) => w.text),
        guessedThisTurn: game.guessedThisTurn,
        scores: game.scores,
      })
    }

    const snapshot = this.notifySubscribers(joinCode, game)
    return snapshot
  }

  async skipWord(joinCode: string, playerId: string): Promise<Game> {
    const game = this.assertClueGiverTurn(joinCode, playerId)
    if (game.turnPhase !== 'active') throw new AppError('TURN_NOT_ACTIVE', 'Turn is not active')
    if (!game.currentWordId) throw new AppError('INVALID_STATE', 'No current word set')

    const current: Word = { id: game.currentWordId, text: game.currentWord! }
    game.skippedThisTurn = [...game.skippedThisTurn, current.id]

    const next = this.drawNextWord(game.hat, current, game.skippedThisTurn)
    if (next) {
      game.currentWord = next.text
      game.currentWordId = next.id
    }
    // else: currentWord stays — only the just-skipped word remains, player must describe it

    logger.debug('Word skipped', {
      joinCode,
      skippedWord: current.text,
      nextWord: next?.text ?? current.text,
      wordsRemainingInHat: game.hat.length,
      hat: game.hat.map((w) => w.text),
      skippedThisTurn: game.skippedThisTurn.map((id) => game.hat.find((w) => w.id === id)?.text ?? id),
      guessedThisTurn: game.guessedThisTurn,
    })

    const snapshot = this.notifySubscribers(joinCode, game)
    return snapshot
  }

  async addWord(joinCode: string, playerId: string, text: string): Promise<Word> {
    const game = this.games.get(joinCode)
    if (!game) throw new AppError('NOT_FOUND', 'Game not found')
    if (game.status !== 'lobby') throw new AppError('GAME_NOT_IN_LOBBY', 'Game is not in lobby')
    const player = game.roster.getById(playerId)
    if (!player) throw new AppError('FORBIDDEN', 'Player not in game')
    const key = `${joinCode}:${playerId}`
    const playerWords = this.words.get(key) ?? []
    if (playerWords.length >= game.settings.wordsPerPlayer) {
      throw new AppError('WORD_LIMIT_REACHED', `You can only submit ${game.settings.wordsPerPlayer} words`)
    }
    const word: Word = { id: randomUUID(), text: text.trim() }
    this.words.set(key, [...playerWords, word])
    game.roster.updateWordCount(playerId, 1)
    this.notifySubscribers(joinCode, game)
    return { ...word }
  }

  async getWords(joinCode: string, playerId: string): Promise<Word[]> {
    const game = this.games.get(joinCode)
    if (!game) throw new AppError('NOT_FOUND', 'Game not found')
    const player = game.roster.getById(playerId)
    if (!player) throw new AppError('FORBIDDEN', 'Player not in game')
    return [...(this.words.get(`${joinCode}:${playerId}`) ?? [])]
  }

  async getGameWords(joinCode: string): Promise<GameStats> {
    const game = this.games.get(joinCode)
    if (!game) throw new AppError('NOT_FOUND', 'Game not found')

    const playerNames = game.roster.getIdToNameMap()
    const prefix = `${joinCode}:`
    const grouped = new Map<string, string[]>()

    for (const [key, words] of this.words.entries()) {
      if (!key.startsWith(prefix)) continue
      const playerId = key.slice(prefix.length)
      const name = playerNames.get(playerId)
      if (!name) continue
      grouped.set(name, words.map((w) => w.text))
    }

    const wordsBySubmitter = [...grouped.entries()]
      .map(([submitterName, words]) => ({
        submitterName,
        words: [...words].sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => a.submitterName.localeCompare(b.submitterName))

    const bestClueGiver = computeBestClueGiver(game.roster.getAll())

    return { wordsBySubmitter, bestClueGiver }
  }

  async deleteWord(joinCode: string, playerId: string, wordId: string): Promise<void> {
    const game = this.games.get(joinCode)
    if (!game) throw new AppError('NOT_FOUND', 'Game not found')
    if (game.status !== 'lobby') throw new AppError('GAME_NOT_IN_LOBBY', 'Words can only be deleted while game is in lobby')
    const player = game.roster.getById(playerId)
    if (!player) throw new AppError('FORBIDDEN', 'Player not in game')
    const key = `${joinCode}:${playerId}`
    const playerWords = this.words.get(key) ?? []
    const wordIndex = playerWords.findIndex((w) => w.id === wordId)
    if (wordIndex === -1) throw new AppError('NOT_FOUND', 'Word not found')
    this.words.set(key, playerWords.filter((w) => w.id !== wordId))
    game.roster.updateWordCount(playerId, -1)
    this.notifySubscribers(joinCode, game)
  }

  async updateSettings(joinCode: string, playerId: string, patch: Partial<GameSettings>): Promise<Game> {
    const game = this.games.get(joinCode)
    if (!game) throw new AppError('NOT_FOUND', 'Game not found')
    if (game.status !== 'lobby') throw new AppError('INVALID_STATE', 'Settings can only be changed while the game is in the lobby')
    if (game.hostId !== playerId) throw new AppError('FORBIDDEN', 'Only the host can change game settings')

    if (patch.wordsPerPlayer !== undefined) {
      const hasConflict = game.roster.anyPlayerExceeds(patch.wordsPerPlayer!)
      if (hasConflict) {
        throw new AppError(
          'SETTINGS_CONFLICT',
          `Cannot reduce to ${patch.wordsPerPlayer} — one or more players have already submitted more words`
        )
      }
    }

    game.settings = { ...game.settings, ...patch }
    const snapshot = this.notifySubscribers(joinCode, game)
    return snapshot
  }

  async updateTeamName(joinCode: string, playerId: string, team: 1 | 2, name: string): Promise<Game> {
    const game = this.games.get(joinCode)
    if (!game) throw new AppError('NOT_FOUND', 'Game not found')
    if (game.hostId !== playerId) throw new AppError('FORBIDDEN', 'Only the host can rename teams')
    if (game.status !== 'lobby') throw new AppError('INVALID_STATE', 'Team names can only be changed while the game is in the lobby')

    const trimmed = name.trim()
    if (trimmed.length === 0 || trimmed.length > 20) {
      throw new AppError('VALIDATION', 'Team name must be between 1 and 20 characters')
    }
    const otherName = team === 1 ? game.teamNames.team2 : game.teamNames.team1
    if (trimmed.toLowerCase() === otherName.toLowerCase()) {
      throw new AppError('TEAM_NAME_CONFLICT', 'Both teams cannot have the same name')
    }

    game.teamNames = team === 1
      ? { team1: trimmed, team2: game.teamNames.team2 }
      : { team1: game.teamNames.team1, team2: trimmed }

    const snapshot = this.notifySubscribers(joinCode, game)
    return snapshot
  }
}
