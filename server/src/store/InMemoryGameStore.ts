import { randomUUID } from 'crypto'
import type { Game, Player, Team } from '@wordfetti/shared'
import type { GameStore } from './GameStore.js'
import { generateJoinCode } from './joinCode.js'
import { AppError } from '../errors.js'

const MAX_JOIN_CODE_ATTEMPTS = 10

export class InMemoryGameStore implements GameStore {
  private readonly games = new Map<string, Game>()

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
    const player: Player = { id: randomUUID(), name, team }
    game.players.push(player)
    return { ...player }
  }
}
