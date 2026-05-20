import { randomUUID } from 'crypto'
import type { GameSnapshot, GameSettings, GameStats, Player, Team, Word } from '@wordfetti/shared'
import type { GameStore, GameStoreStats } from './GameStore.js'
import type { GameConfig } from '../config.js'
import { generateJoinCode } from './joinCode.js'
import { pickTeamNames } from '../teamNames.js'
import { AppError } from '../errors.js'
import { logger } from '../logger.js'
import { GameSession } from './Game.js'

const MAX_JOIN_CODE_ATTEMPTS = 10
const STALE_GAME_TTL_MS = 8 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000

export class InMemoryGameStore implements GameStore {
  private readonly games = new Map<string, GameSession>()
  private readonly subscribers = new Map<string, Set<(game: GameSnapshot) => void>>()
  private readonly words = new Map<string, Word[]>()
  private readonly gameUpdatedAt = new Map<string, number>()
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
    for (const playerWords of this.words.values()) words += playerWords.length
    let subscribers = 0
    for (const gameSubscribers of this.subscribers.values()) subscribers += gameSubscribers.size
    return {
      games: this.games.size,
      words,
      subscribers,
      lastCleanupAt: this.lastCleanupAt,
      lastCleanupRemovedCount: this.lastCleanupRemovedCount,
    }
  }

  private requireGame(joinCode: string): GameSession {
    const game = this.games.get(joinCode)
    if (!game) throw new AppError('NOT_FOUND', 'Game not found')
    return game
  }

  private touch(joinCode: string): void {
    this.gameUpdatedAt.set(joinCode, Date.now())
  }

  private notifyAndReturn(joinCode: string, game: GameSession): GameSnapshot {
    const publicGame = game.snapshot()
    this.subscribers.get(joinCode)?.forEach((cb) => cb(publicGame))
    return publicGame
  }

  private removeGame(joinCode: string, reason: 'stale'): void {
    this.games.delete(joinCode)
    this.subscribers.delete(joinCode)
    this.gameUpdatedAt.delete(joinCode)
    for (const key of this.words.keys()) {
      if (key.startsWith(`${joinCode}:`)) this.words.delete(key)
    }
    logger.info('Game removed from in-memory store', { joinCode, reason, ...this.getStats() })
  }

  private cleanupStaleGames(): void {
    const now = Date.now()
    const removedJoinCodes: string[] = []
    for (const joinCode of this.games.keys()) {
      const updatedAt = this.gameUpdatedAt.get(joinCode) ?? 0
      if (now - updatedAt < STALE_GAME_TTL_MS) continue
      removedJoinCodes.push(joinCode)
      this.removeGame(joinCode, 'stale')
    }
    this.lastCleanupAt = new Date().toISOString()
    this.lastCleanupRemovedCount = removedJoinCodes.length
    if (removedJoinCodes.length > 0) {
      logger.info('Stale game cleanup completed', { removedGames: removedJoinCodes, ...this.getStats() })
    }
  }

  async createGame(teamNames?: { team1: string; team2: string }): Promise<GameSnapshot> {
    let joinCode: string
    let attempts = 0
    do {
      if (attempts >= MAX_JOIN_CODE_ATTEMPTS) throw new Error('Failed to generate a unique join code')
      joinCode = generateJoinCode()
      attempts++
    } while (this.games.has(joinCode))

    const game = new GameSession({
      id: randomUUID(),
      joinCode,
      teamNames: teamNames ?? pickTeamNames(this.teamNamesPool),
      settings: {
        wordsPerPlayer: this.config.wordsPerPlayer,
        turnDurationSeconds: this.config.turnDurationSeconds,
      },
    })
    this.games.set(joinCode, game)
    this.touch(joinCode)
    logger.info('Game added to in-memory store', { joinCode, ...this.getStats() })
    return game.snapshot()
  }

  async createGameWithHost(name: string, team: Team, teamNames?: { team1: string; team2: string }): Promise<{ game: GameSnapshot; player: Player }> {
    const publicGame = await this.createGame(teamNames)
    const player = await this.joinGame(publicGame.joinCode, name, team)
    const game = this.games.get(publicGame.joinCode)!
    game.hostId = player.id
    const updated = await this.getGameByJoinCode(publicGame.joinCode)
    return { game: updated!, player }
  }

  async getGameByJoinCode(joinCode: string): Promise<GameSnapshot | null> {
    const game = this.games.get(joinCode)
    if (!game) return null
    return game.snapshot()
  }

  async joinGame(joinCode: string, name: string, team: Team): Promise<Player> {
    const game = this.requireGame(joinCode)
    // No `await` between game.join() check and add — atomic under Node's event loop.
    const player = game.join(name, team)
    this.touch(joinCode)
    this.notifyAndReturn(joinCode, game)
    return { ...player }
  }

  async startGame(joinCode: string): Promise<GameSnapshot> {
    const game = this.requireGame(joinCode)
    const allWords: Word[] = game.roster.getActive().flatMap((p) =>
      this.words.get(`${joinCode}:${p.id}`) ?? []
    )
    game.start(allWords)
    this.touch(joinCode)
    return this.notifyAndReturn(joinCode, game)
  }

  subscribe(joinCode: string, callback: (game: GameSnapshot) => void): () => void {
    if (!this.subscribers.has(joinCode)) this.subscribers.set(joinCode, new Set())
    this.subscribers.get(joinCode)!.add(callback)
    return () => {
      const subs = this.subscribers.get(joinCode)
      if (!subs) return
      subs.delete(callback)
      if (subs.size === 0) this.subscribers.delete(joinCode)
    }
  }

  async readyTurn(joinCode: string, playerId: string): Promise<GameSnapshot> {
    const game = this.requireGame(joinCode)
    const { turnStartedAt } = game.readyTurn(playerId)
    this.touch(joinCode)

    const { turnDurationSeconds } = game.settings
    setTimeout(async () => {
      const current = this.games.get(joinCode)
      if (current?.turnPhase === 'active' && current?.turnStartedAt === turnStartedAt) {
        await this.endTurn(joinCode, playerId).catch(() => {
          // Client already called end-turn between the check and here — ignore.
        })
      }
    }, turnDurationSeconds * 1000 + 500)

    return this.notifyAndReturn(joinCode, game)
  }

  async endTurn(joinCode: string, playerId: string): Promise<GameSnapshot> {
    const game = this.requireGame(joinCode)
    game.endTurn(playerId)
    this.touch(joinCode)
    return this.notifyAndReturn(joinCode, game)
  }

  async advanceRound(joinCode: string, playerId: string): Promise<GameSnapshot> {
    const game = this.requireGame(joinCode)
    game.advanceRound(playerId)
    this.touch(joinCode)
    return this.notifyAndReturn(joinCode, game)
  }

  async guessWord(joinCode: string, playerId: string): Promise<GameSnapshot> {
    const game = this.requireGame(joinCode)
    game.guessWord(playerId)
    this.touch(joinCode)
    return this.notifyAndReturn(joinCode, game)
  }

  async skipWord(joinCode: string, playerId: string): Promise<GameSnapshot> {
    const game = this.requireGame(joinCode)
    game.skipWord(playerId)
    this.touch(joinCode)
    return this.notifyAndReturn(joinCode, game)
  }

  async addWord(joinCode: string, playerId: string, text: string): Promise<Word> {
    const game = this.requireGame(joinCode)
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
    this.touch(joinCode)
    this.notifyAndReturn(joinCode, game)
    return { ...word }
  }

  async getWords(joinCode: string, playerId: string): Promise<Word[]> {
    const game = this.requireGame(joinCode)
    const player = game.roster.getById(playerId)
    if (!player) throw new AppError('FORBIDDEN', 'Player not in game')
    return [...(this.words.get(`${joinCode}:${playerId}`) ?? [])]
  }

  async getGameWords(joinCode: string): Promise<GameStats> {
    const game = this.requireGame(joinCode)
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

    return { wordsBySubmitter, bestClueGiver: game.roster.getBestClueGiver() }
  }

  async deleteWord(joinCode: string, playerId: string, wordId: string): Promise<void> {
    const game = this.requireGame(joinCode)
    if (game.status !== 'lobby') throw new AppError('GAME_NOT_IN_LOBBY', 'Words can only be deleted while game is in lobby')
    const player = game.roster.getById(playerId)
    if (!player) throw new AppError('FORBIDDEN', 'Player not in game')
    const key = `${joinCode}:${playerId}`
    const playerWords = this.words.get(key) ?? []
    const wordIndex = playerWords.findIndex((w) => w.id === wordId)
    if (wordIndex === -1) throw new AppError('NOT_FOUND', 'Word not found')
    this.words.set(key, playerWords.filter((w) => w.id !== wordId))
    game.roster.updateWordCount(playerId, -1)
    this.touch(joinCode)
    this.notifyAndReturn(joinCode, game)
  }

  async updateSettings(joinCode: string, playerId: string, patch: Partial<GameSettings>): Promise<GameSnapshot> {
    const game = this.requireGame(joinCode)
    game.updateSettings(playerId, patch)
    this.touch(joinCode)
    return this.notifyAndReturn(joinCode, game)
  }

  async updateTeamName(joinCode: string, playerId: string, team: 1 | 2, name: string): Promise<GameSnapshot> {
    const game = this.requireGame(joinCode)
    game.updateTeamName(playerId, team, name)
    this.touch(joinCode)
    return this.notifyAndReturn(joinCode, game)
  }
}
