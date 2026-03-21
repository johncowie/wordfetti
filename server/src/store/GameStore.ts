import type { Game } from '@wordfetti/shared'

export interface GameStore {
  createGame(): Promise<Game>
  getGameByJoinCode(joinCode: string): Promise<Game | null>
}
