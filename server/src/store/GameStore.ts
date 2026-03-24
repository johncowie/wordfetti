import type { Game, Player, Team, Word } from '@wordfetti/shared'

export interface GameStore {
  createGame(): Promise<Game>
  createGameWithHost(name: string, team: Team): Promise<{ game: Game; player: Player }>
  getGameByJoinCode(joinCode: string): Promise<Game | null>
  joinGame(joinCode: string, name: string, team: Team): Promise<Player>
  subscribe(joinCode: string, callback: (game: Game) => void): () => void
  startGame(joinCode: string): Promise<Game>
  readyTurn(joinCode: string, playerId: string): Promise<Game>
  endTurn(joinCode: string, playerId: string): Promise<Game>
  advanceRound(joinCode: string, playerId: string): Promise<Game>
  guessWord(joinCode: string, playerId: string): Promise<Game>
  skipWord(joinCode: string, playerId: string): Promise<Game>
  addWord(joinCode: string, playerId: string, text: string): Promise<Word>
  getWords(joinCode: string, playerId: string): Promise<Word[]>
  deleteWord(joinCode: string, playerId: string, wordId: string): Promise<void>
}
