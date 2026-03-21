import { randomUUID } from 'crypto'
import type { Game } from '@wordfetti/shared'
import type { GameStore } from './GameStore.js'
import { generateJoinCode } from './joinCode.js'

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
    }
    this.games.set(joinCode, game)
    return game
  }

  async getGameByJoinCode(joinCode: string): Promise<Game | null> {
    return this.games.get(joinCode) ?? null
  }
}
