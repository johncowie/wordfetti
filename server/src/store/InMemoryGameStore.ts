import { randomUUID } from 'crypto'
import { WORDS_PER_PLAYER, type Game, type Player, type Team, type Word } from '@wordfetti/shared'
import type { GameStore } from './GameStore.js'
import { generateJoinCode } from './joinCode.js'
import { AppError } from '../errors.js'

const MAX_JOIN_CODE_ATTEMPTS = 10

export class InMemoryGameStore implements GameStore {
  private readonly games = new Map<string, Game>()
  private readonly subscribers = new Map<string, Set<(game: Game) => void>>()
  private readonly words = new Map<string, Word[]>()

  async createGame(): Promise<Game> {
    let joinCode: string
    let attempts = 0
    do {
      if (attempts >= MAX_JOIN_CODE_ATTEMPTS) {
        throw new Error('Failed to generate a unique join code')
      }
      joinCode = generateJoinCode()
      attempts++
    } while (this.games.has(joinCode))

    const game: Game = {
      id: randomUUID(),
      joinCode,
      status: 'lobby',
      players: [],
    }
    this.games.set(joinCode, game)
    return { ...game, players: [...game.players] }
  }

  async createGameWithHost(name: string, team: Team): Promise<{ game: Game; player: Player }> {
    const game = await this.createGame()
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
    return { ...game, players: [...game.players] }
  }

  async joinGame(joinCode: string, name: string, team: Team): Promise<Player> {
    const game = this.games.get(joinCode)
    if (!game) throw new AppError('NOT_FOUND', 'Game not found')
    if (game.status !== 'lobby') throw new AppError('GAME_IN_PROGRESS', 'Game has already started')
    const player: Player = { id: randomUUID(), name, team }
    game.players.push(player)
    const snapshot = { ...game, players: [...game.players] }
    this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))
    return { ...player }
  }

  async startGame(joinCode: string): Promise<Game> {
    const game = this.games.get(joinCode)
    if (!game) throw new AppError('NOT_FOUND', 'Game not found')
    game.status = 'in_progress'
    const snapshot = { ...game, players: [...game.players] }
    this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))
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

  async addWord(joinCode: string, playerId: string, text: string): Promise<Word> {
    const game = this.games.get(joinCode)
    if (!game) throw new AppError('NOT_FOUND', 'Game not found')
    if (game.status !== 'lobby') throw new AppError('GAME_NOT_IN_LOBBY', 'Game is not in lobby')
    const player = game.players.find((p) => p.id === playerId)
    if (!player) throw new AppError('FORBIDDEN', 'Player not in game')
    const key = `${joinCode}:${playerId}`
    const playerWords = this.words.get(key) ?? []
    if (playerWords.length >= WORDS_PER_PLAYER) {
      throw new AppError('WORD_LIMIT_REACHED', 'Word limit reached')
    }
    const word: Word = { id: randomUUID(), text: text.trim() }
    this.words.set(key, [...playerWords, word])
    return { ...word }
  }

  async getWords(joinCode: string, playerId: string): Promise<Word[]> {
    const game = this.games.get(joinCode)
    if (!game) throw new AppError('NOT_FOUND', 'Game not found')
    const player = game.players.find((p) => p.id === playerId)
    if (!player) throw new AppError('FORBIDDEN', 'Player not in game')
    return [...(this.words.get(`${joinCode}:${playerId}`) ?? [])]
  }

  async deleteWord(joinCode: string, playerId: string, wordId: string): Promise<void> {
    const game = this.games.get(joinCode)
    if (!game) throw new AppError('NOT_FOUND', 'Game not found')
    if (game.status !== 'lobby') throw new AppError('GAME_NOT_IN_LOBBY', 'Words can only be deleted while game is in lobby')
    const player = game.players.find((p) => p.id === playerId)
    if (!player) throw new AppError('FORBIDDEN', 'Player not in game')
    const key = `${joinCode}:${playerId}`
    const playerWords = this.words.get(key) ?? []
    const wordIndex = playerWords.findIndex((w) => w.id === wordId)
    if (wordIndex === -1) throw new AppError('NOT_FOUND', 'Word not found')
    this.words.set(key, playerWords.filter((w) => w.id !== wordId))
  }
}
