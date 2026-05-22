import { randomUUID } from 'crypto'
import type { GameSnapshot, GameSettings, Player, Team, Word } from '@wordfetti/shared'
import { AppError } from '../errors.js'
import { logger } from '../logger.js'
import { Hat } from './Hat.js'
import { PlayerRoster } from './PlayerRoster.js'
import { EnteredWords } from './EnteredWords.js'
import { computeWordDifficulty } from '../stats/computeWordDifficulty.js'

export class GameSession {
  readonly id: string
  readonly joinCode: string
  readonly roster: PlayerRoster

  status: GameSnapshot['status']
  hostId?: string
  round?: 1 | 2 | 3
  activeTeam?: 1 | 2
  currentClueGiverId?: string
  turnPhase?: 'ready' | 'active'
  scores?: { team1: number; team2: number }
  guessedThisTurn?: string[]
  turnStartedAt?: string
  teamNames: { team1: string; team2: string }
  settings: GameSettings

  private _hat?: Hat
  private readonly _enteredWords = new EnteredWords()

  /** Exposed for test introspection. Not part of the public game API. */
  get hat(): Hat | undefined { return this._hat }

  get enteredWordCount(): number { return this._enteredWords.total() }

  constructor(params: {
    id: string
    joinCode: string
    teamNames: { team1: string; team2: string }
    settings: GameSettings
  }) {
    this.id = params.id
    this.joinCode = params.joinCode
    this.teamNames = params.teamNames
    this.settings = params.settings
    this.status = 'lobby'
    this.roster = new PlayerRoster()
  }

  join(name: string, team: Team): Player {
    if (this.status !== 'lobby') throw new AppError('GAME_IN_PROGRESS', 'Game has already started')
    if (this.roster.hasDuplicateName(name)) throw new AppError('NAME_TAKEN', 'That name is already taken')
    return this.roster.add({ id: randomUUID(), name, team, wordCount: 0 })
  }

  addWord(playerId: string, text: string): Word {
    if (this.status !== 'lobby') throw new AppError('GAME_NOT_IN_LOBBY', 'Game is not in lobby')
    if (!this.roster.getById(playerId)) throw new AppError('FORBIDDEN', 'Player not in game')
    return this._enteredWords.add(playerId, text, this.settings.wordsPerPlayer)
  }

  deleteWord(playerId: string, wordId: string): void {
    if (this.status !== 'lobby') throw new AppError('GAME_NOT_IN_LOBBY', 'Words can only be deleted while game is in lobby')
    if (!this.roster.getById(playerId)) throw new AppError('FORBIDDEN', 'Player not in game')
    this._enteredWords.delete(playerId, wordId)
  }

  getWords(playerId: string): Word[] {
    if (!this.roster.getById(playerId)) throw new AppError('FORBIDDEN', 'Player not in game')
    return this._enteredWords.get(playerId)
  }

  start(): void {
    const activeTeam: 1 | 2 = Math.random() < 0.5 ? 1 : 2
    this.roster.resetStats()
    if (this.roster.getByTeam(activeTeam).length === 0) {
      throw new AppError('INVALID_STATE', 'No players on the active team')
    }
    const firstClueGiver = this.roster.assignNextClueGiver(activeTeam)
    this._hat = new Hat(this._enteredWords.toWordList())
    this.status = 'in_progress'
    this.round = 1
    this.activeTeam = activeTeam
    this.currentClueGiverId = firstClueGiver.id
    this.turnPhase = 'ready'
    this.scores = { team1: 0, team2: 0 }
    this.guessedThisTurn = []
  }

  readyTurn(playerId: string): { turnStartedAt: string } {
    this._assertClueGiverTurn(playerId)
    if (this.turnPhase !== 'ready') throw new AppError('TURN_ALREADY_ACTIVE', 'Turn is already active')
    if (!this._hat || this._hat.isEmpty) throw new AppError('HAT_EMPTY', 'Hat is empty')

    const firstWord = this._hat.startTurn()
    const turnStartedAt = new Date().toISOString()

    this.turnPhase = 'active'
    this.guessedThisTurn = []
    this.turnStartedAt = turnStartedAt

    logger.debug('Turn started', {
      joinCode: this.joinCode,
      activeTeam: this.activeTeam,
      clueGiver: this.roster.getById(this.currentClueGiverId ?? '')?.name,
      firstWord: firstWord.text,
      wordsRemainingInHat: this._hat.size,
      hat: this._hat.wordTexts(),
    })

    return { turnStartedAt }
  }

  endTurn(playerId: string): void {
    this._assertClueGiverTurn(playerId)
    if (this.turnPhase !== 'active') throw new AppError('TURN_NOT_ACTIVE', 'Turn is not active')

    if (!this._hat || this._hat.isEmpty) {
      this.status = this._resolveRoundEndStatus(this.round as 1 | 2 | 3)
      this.currentClueGiverId = undefined
      this.turnPhase = undefined
      this.turnStartedAt = undefined
      return
    }

    if (!this.activeTeam) throw new AppError('INVALID_STATE', 'Active team not set')

    const newTeam: 1 | 2 = this.activeTeam === 1 ? 2 : 1
    const nextClueGiver = this.roster.assignNextClueGiver(newTeam)

    this.activeTeam = newTeam
    this.currentClueGiverId = nextClueGiver.id
    this.turnPhase = 'ready'
    this.guessedThisTurn = []
    this.turnStartedAt = undefined

    logger.info('Turn ended', { joinCode: this.joinCode, newActiveTeam: newTeam, nextClueGiver: nextClueGiver.name })
  }

  advanceRound(playerId: string): void {
    if (this.hostId !== playerId) throw new AppError('FORBIDDEN', 'Only the host can advance the round')
    if (this.status !== 'between_rounds') throw new AppError('INVALID_STATE', 'Game is not between rounds')
    if (this.round === 3) throw new AppError('INVALID_STATE', 'Cannot advance beyond round 3')

    this._hat!.refill()

    const newActiveTeam: 1 | 2 = this.activeTeam === 1 ? 2 : 1
    const nextClueGiver = this.roster.assignNextClueGiver(newActiveTeam)

    this.round = (this.round === 1 ? 2 : 3) as 2 | 3
    this.status = 'in_progress'
    this.turnPhase = 'ready'
    this.activeTeam = newActiveTeam
    this.currentClueGiverId = nextClueGiver.id
    this.turnStartedAt = undefined
    this.guessedThisTurn = []

    logger.info('Round advanced', { joinCode: this.joinCode, round: this.round })
  }

  guessWord(playerId: string): void {
    this._assertClueGiverTurn(playerId)
    if (this.turnPhase !== 'active') throw new AppError('TURN_NOT_ACTIVE', 'Turn is not active')
    if (!this._hat?.current) throw new AppError('INVALID_STATE', 'No current word set')
    if (!this.scores) throw new AppError('INVALID_STATE', 'Game scores not initialised')
    if (!this.activeTeam) throw new AppError('INVALID_STATE', 'Active team not set')

    const guessedText = this._hat.current.text
    this.scores[this.activeTeam === 1 ? 'team1' : 'team2']++
    this.guessedThisTurn = [...(this.guessedThisTurn ?? []), guessedText]

    if (this.currentClueGiverId) {
      this.roster.incrementStat(this.currentClueGiverId)
    }

    const empty = this._hat.guess()

    if (empty) {
      logger.debug('Word guessed — hat empty, round over', {
        joinCode: this.joinCode,
        guessedWord: guessedText,
        guessedThisTurn: this.guessedThisTurn,
        scores: this.scores,
      })
      this.status = this._resolveRoundEndStatus(this.round as 1 | 2 | 3)
      this.currentClueGiverId = undefined
      this.turnPhase = undefined
      this.turnStartedAt = undefined
    } else {
      logger.debug('Word guessed', {
        joinCode: this.joinCode,
        guessedWord: guessedText,
        nextWord: this._hat.current?.text,
        wordsRemainingInHat: this._hat.size,
        hat: this._hat.wordTexts(),
        guessedThisTurn: this.guessedThisTurn,
        scores: this.scores,
      })
    }
  }

  skipWord(playerId: string): void {
    this._assertClueGiverTurn(playerId)
    if (this.turnPhase !== 'active') throw new AppError('TURN_NOT_ACTIVE', 'Turn is not active')
    if (!this._hat?.current) throw new AppError('INVALID_STATE', 'No current word set')

    const skippedText = this._hat.current.text
    const next = this._hat.skip()

    logger.debug('Word skipped', {
      joinCode: this.joinCode,
      skippedWord: skippedText,
      nextWord: next.text,
      wordsRemainingInHat: this._hat.size,
      hat: this._hat.wordTexts(),
      guessedThisTurn: this.guessedThisTurn,
    })
  }

  updateSettings(playerId: string, patch: Partial<GameSettings>): void {
    if (this.status !== 'lobby') throw new AppError('INVALID_STATE', 'Settings can only be changed while the game is in the lobby')
    if (this.hostId !== playerId) throw new AppError('FORBIDDEN', 'Only the host can change game settings')
    if (patch.wordsPerPlayer !== undefined && this._enteredWords.anyExceedsLimit(patch.wordsPerPlayer)) {
      throw new AppError(
        'SETTINGS_CONFLICT',
        `Cannot reduce to ${patch.wordsPerPlayer} — one or more players have already submitted more words`,
      )
    }
    this.settings = { ...this.settings, ...patch }
  }

  updateTeamName(playerId: string, team: 1 | 2, name: string): void {
    if (this.hostId !== playerId) throw new AppError('FORBIDDEN', 'Only the host can rename teams')
    if (this.status !== 'lobby') throw new AppError('INVALID_STATE', 'Team names can only be changed while the game is in the lobby')
    const trimmed = name.trim()
    if (trimmed.length === 0 || trimmed.length > 20) {
      throw new AppError('VALIDATION', 'Team name must be between 1 and 20 characters')
    }
    const otherName = team === 1 ? this.teamNames.team2 : this.teamNames.team1
    if (trimmed.toLowerCase() === otherName.toLowerCase()) {
      throw new AppError('TEAM_NAME_CONFLICT', 'Both teams cannot have the same name')
    }
    this.teamNames = team === 1
      ? { team1: trimmed, team2: this.teamNames.team2 }
      : { team1: this.teamNames.team1, team2: trimmed }
  }

  wordStats(): { wordsBySubmitter: Array<{ submitterName: string; words: string[] }>; wordDifficulty: ReturnType<typeof computeWordDifficulty> } {
    const playerNames = this.roster.getIdToNameMap()
    const wordsBySubmitter = this._enteredWords.groupedByPlayer(playerNames)
    const wordDifficulty = computeWordDifficulty(this._hat?.wordStats ?? [])
    return { wordsBySubmitter, wordDifficulty }
  }

  snapshot(): GameSnapshot {
    return {
      id: this.id,
      joinCode: this.joinCode,
      status: this.status,
      players: this.roster.getAll().map((p) => ({
        ...p,
        wordCount: this._enteredWords.getCount(p.id),
      })),
      hostId: this.hostId,
      teamNames: this.teamNames,
      settings: this.settings,
      round: this.round,
      activeTeam: this.activeTeam,
      currentClueGiverId: this.currentClueGiverId,
      turnPhase: this.turnPhase,
      scores: this.scores,
      currentWord: this.turnPhase === 'active' ? this._hat?.current?.text : undefined,
      guessedThisTurn: this.guessedThisTurn,
      turnStartedAt: this.turnStartedAt,
    }
  }

  private _assertClueGiverTurn(playerId: string): void {
    if (this.status !== 'in_progress') throw new AppError('TURN_NOT_ALLOWED', 'Game is not in progress')
    if (this.currentClueGiverId !== playerId) throw new AppError('FORBIDDEN', 'Only the clue giver can do this')
  }

  private _resolveRoundEndStatus(round: 1 | 2 | 3): GameSnapshot['status'] {
    return round === 3 ? 'finished' : 'between_rounds'
  }
}
