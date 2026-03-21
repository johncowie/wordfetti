import type { Game, Player, Team } from '@wordfetti/shared'

export interface GameStore {
  createGame(): Promise<Game>
  createGameWithHost(name: string, team: Team): Promise<{ game: Game; player: Player }>
  getGameByJoinCode(joinCode: string): Promise<Game | null>
  joinGame(joinCode: string, name: string, team: Team): Promise<Player>
  subscribe(joinCode: string, callback: (game: Game) => void): () => void
  startGame(joinCode: string): Promise<Game>
}
