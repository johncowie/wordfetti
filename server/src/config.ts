export type GameConfig = {
  wordsPerPlayer: number
  turnDurationSeconds: number
}

export const DEFAULT_GAME_CONFIG: GameConfig = {
  wordsPerPlayer: 5,
  turnDurationSeconds: 45,
}
