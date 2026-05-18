import { DEFAULT_TARGET_WORD_COUNT, MAX_WORDS_PER_PLAYER, MIN_WORDS_PER_PLAYER } from '../config'

export function calculateDefaultWordsPerPlayer(
  playerCount: number,
  targetTotal: number = DEFAULT_TARGET_WORD_COUNT,
): number {
  if (playerCount <= 0) return MIN_WORDS_PER_PLAYER
  return Math.min(MAX_WORDS_PER_PLAYER, Math.max(MIN_WORDS_PER_PLAYER, Math.floor(targetTotal / playerCount)))
}
