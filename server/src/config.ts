export type GameConfig = {
  wordsPerPlayer: number
  turnDurationSeconds: number
}

export const DEFAULT_GAME_CONFIG: GameConfig = {
  wordsPerPlayer: 3,
  turnDurationSeconds: 45,
}
