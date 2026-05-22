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
    for (const game of this.games.values()) words += game.enteredWordCount
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
    game.start()
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
    const word = game.addWord(playerId, text)
    this.touch(joinCode)
    this.notifyAndReturn(joinCode, game)
    return { ...word }
  }

  async getWords(joinCode: string, playerId: string): Promise<Word[]> {
    const game = this.requireGame(joinCode)
    return game.getWords(playerId)
  }

  async getGameWords(joinCode: string): Promise<GameStats> {
    const game = this.requireGame(joinCode)
    const { wordsBySubmitter, wordDifficulty } = game.wordStats()
    return { wordsBySubmitter, bestClueGiver: game.roster.getBestClueGiver(), wordDifficulty }
  }

  async deleteWord(joinCode: string, playerId: string, wordId: string): Promise<void> {
    const game = this.requireGame(joinCode)
    game.deleteWord(playerId, wordId)
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

  async kickPlayer(joinCode: string, hostPlayerId: string, targetPlayerId: string): Promise<GameSnapshot> {
    const game = this.requireGame(joinCode)
    if (!game.hostId || game.hostId !== hostPlayerId)
      throw new AppError('FORBIDDEN', 'Only the host can kick players')

    const target = game.roster.getById(targetPlayerId)
    if (!target) throw new AppError('NOT_FOUND', 'Player not found')
    if (targetPlayerId === game.hostId)
      throw new AppError('FORBIDDEN', 'Cannot kick the host')

    game.roster.kick(targetPlayerId)

    if (game.status === 'in_progress' || game.status === 'between_rounds') {
      const t1Active = game.roster.getByTeam(1).length
      const t2Active = game.roster.getByTeam(2).length
      if (t1Active === 0 || t2Active === 0) {
        game.status = 'finished'
        this.touch(joinCode)
        return this.notifyAndReturn(joinCode, game)
      }
    }

    if (game.status === 'in_progress' && targetPlayerId === game.currentClueGiverId) {
      const newActiveTeam: 1 | 2 = game.activeTeam === 1 ? 2 : 1
      const nextClueGiver = game.roster.assignNextClueGiver(newActiveTeam)
      game.activeTeam = newActiveTeam
      game.currentClueGiverId = nextClueGiver.id
      game.turnPhase = 'ready'
      game.guessedThisTurn = []
      game.turnStartedAt = undefined
      logger.info('Clue giver kicked; turn advanced', { joinCode, newActiveTeam, nextClueGiver: nextClueGiver.name })
    }

    logger.info('Player kicked', { joinCode, targetPlayerId })
    this.touch(joinCode)
    return this.notifyAndReturn(joinCode, game)
  }
}
