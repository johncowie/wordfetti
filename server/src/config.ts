import { WORDS_PER_PLAYER } from '@wordfetti/shared'

export type GameConfig = {
  wordsPerPlayer: number
}

// Production default — reads from the shared constant so client and server stay in sync.
// Change WORDS_PER_PLAYER in shared/src/types.ts to update both.
export const DEFAULT_GAME_CONFIG: GameConfig = {
  wordsPerPlayer: WORDS_PER_PLAYER,
}
