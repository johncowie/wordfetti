import { randomUUID } from 'crypto'
import { type Game, type Player, type Team, type Word } from '@wordfetti/shared'
import type { GameStore } from './GameStore.js'
import type { GameConfig } from '../config.js'
import { generateJoinCode } from './joinCode.js'
import { AppError } from '../errors.js'
import { logger } from '../logger.js'

const MAX_JOIN_CODE_ATTEMPTS = 10

export type InternalGame = Game & {
  hat: Word[]
  skippedThisTurn: string[]  // word IDs skipped this turn
  currentWordId?: string     // ID of the word currently being described
  clueGiverIndices: Record<Team, number>  // next index to use per team; advanced at endTurn, not readyTurn
}

export class InMemoryGameStore implements GameStore {
  private readonly games = new Map<string, InternalGame>()
  private readonly subscribers = new Map<string, Set<(game: Game) => void>>()
  private readonly words = new Map<string, Word[]>()

  constructor(private readonly config: GameConfig) {}

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

    const game: InternalGame = {
      id: randomUUID(),
      joinCode,
      status: 'lobby',
      players: [],
      hat: [],
      skippedThisTurn: [],
      clueGiverIndices: { 1: 0, 2: 0 },
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
    const player: Player = { id: randomUUID(), name, team, wordCount: 0 }
    game.players.push(player)
    const snapshot = { ...game, players: [...game.players] }
    this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))
    return { ...player }
  }

  async startGame(joinCode: string): Promise<Game> {
    const game = this.games.get(joinCode)
    if (!game) throw new AppError('NOT_FOUND', 'Game not found')

    const allWords: Word[] = game.players.flatMap((p) =>
      this.words.get(`${joinCode}:${p.id}`) ?? []
    )

    for (let i = allWords.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[allWords[i], allWords[j]] = [allWords[j], allWords[i]]
    }

    const activeTeam: 1 | 2 = Math.random() < 0.5 ? 1 : 2
    const activeTeamPlayers = game.players.filter((p) => p.team === activeTeam)
    const firstClueGiver = activeTeamPlayers[0]
    if (!firstClueGiver) throw new AppError('INVALID_STATE', 'No players on the active team')

    // Commit all mutations in a single step to avoid partial state on future errors
    Object.assign(game, {
      status: 'in_progress',
      hat: allWords,
      activeTeam,
      currentClueGiverId: firstClueGiver.id,
      turnPhase: 'ready',
      scores: { team1: 0, team2: 0 },
      skippedThisTurn: [],
      // Index for starting team advances past player[0] (already assigned); other team starts at 0.
      // activeTeamPlayers.length is always ≥2 (route validates before calling startGame).
      clueGiverIndices: {
        1: activeTeam === 1 ? 1 % activeTeamPlayers.length : 0,
        2: activeTeam === 2 ? 1 % activeTeamPlayers.length : 0,
      } as Record<Team, number>,
    })

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

    Object.assign(game, {
      turnPhase: 'active',
      currentWord: firstWord.text,
      currentWordId: firstWord.id,
      skippedThisTurn: [],
      guessedThisTurn: [],
      turnStartedAt: new Date().toISOString(),
    })

    const clueGiver = game.players.find((p) => p.id === playerId)
    logger.debug('Turn started', {
      joinCode,
      activeTeam: game.activeTeam,
      clueGiver: clueGiver?.name,
      firstWord: firstWord.text,
      wordsRemainingInHat: game.hat.length,
      hat: game.hat.map((w) => w.text),
    })

    const snapshot = { ...game, players: [...game.players] }
    this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))
    return snapshot
  }

  async endTurn(joinCode: string, playerId: string): Promise<Game> {
    const game = this.assertClueGiverTurn(joinCode, playerId)
    if (game.turnPhase !== 'active') throw new AppError('TURN_NOT_ACTIVE', 'Turn is not active')
    if (!game.clueGiverIndices) throw new AppError('INVALID_STATE', 'clueGiverIndices not initialised')

    // Current word stays in hat (never removed during an active turn — only guessWord removes words).
    // Defensive guard: this path is unreachable via the public API; guard anyway so a bug surfaces loudly.
    if (game.hat.length === 0) {
      Object.assign(game, {
        status: 'round_over',
        currentWord: undefined,
        currentWordId: undefined,
        currentClueGiverId: undefined,
        turnPhase: undefined,
        turnStartedAt: undefined,
      })
      const snapshot = { ...game, players: [...game.players] }
      this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))
      return snapshot
    }

    // Guard optional fields before mutation
    if (!game.activeTeam) throw new AppError('INVALID_STATE', 'Active team not set')

    // Rotate team
    const newTeam: 1 | 2 = game.activeTeam === 1 ? 2 : 1
    const newTeamPlayers = game.players.filter((p) => p.team === newTeam)
    if (!newTeamPlayers.length) throw new AppError('INVALID_STATE', 'No players on the next team')

    const nextIndex = game.clueGiverIndices[newTeam]
    const nextClueGiver = newTeamPlayers[nextIndex % newTeamPlayers.length]

    // Pre-advance the index so the *next* endTurn for this team picks the correct successor.
    // Convention: clueGiverIndices[team] always holds the index of the player who goes after
    // the one just assigned — it is advanced here (at turn end), not at readyTurn.
    game.clueGiverIndices[newTeam] = (nextIndex + 1) % newTeamPlayers.length

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

    const snapshot = { ...game, players: [...game.players] }
    this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))
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

    if (game.hat.length === 0) {
      logger.debug('Word guessed — hat empty, round over', {
        joinCode,
        guessedWord: currentText,
        guessedThisTurn: game.guessedThisTurn,
        scores: game.scores,
      })
      Object.assign(game, {
        status: 'round_over',
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

    const snapshot = { ...game, players: [...game.players] }
    this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))
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

    const snapshot = { ...game, players: [...game.players] }
    this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))
    return snapshot
  }

  async addWord(joinCode: string, playerId: string, text: string): Promise<Word> {
    const game = this.games.get(joinCode)
    if (!game) throw new AppError('NOT_FOUND', 'Game not found')
    if (game.status !== 'lobby') throw new AppError('GAME_NOT_IN_LOBBY', 'Game is not in lobby')
    const player = game.players.find((p) => p.id === playerId)
    if (!player) throw new AppError('FORBIDDEN', 'Player not in game')
    const key = `${joinCode}:${playerId}`
    const playerWords = this.words.get(key) ?? []
    if (playerWords.length >= this.config.wordsPerPlayer) {
      throw new AppError('WORD_LIMIT_REACHED', 'Word limit reached')
    }
    const word: Word = { id: randomUUID(), text: text.trim() }
    this.words.set(key, [...playerWords, word])
    player.wordCount = playerWords.length + 1
    const snapshot = { ...game, players: [...game.players] }
    this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))
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
    player.wordCount = playerWords.length - 1
    const snapshot = { ...game, players: [...game.players] }
    this.subscribers.get(joinCode)?.forEach((cb) => cb(snapshot))
  }
}
