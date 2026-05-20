export type WordDifficultyStat = {
  word: string
  avgMs: number
}

export type WordDifficultyResult = {
  easiest: WordDifficultyStat[]
  hardest: WordDifficultyStat[]
}

export function computeWordDifficulty(
  wordStats: ReadonlyArray<{ text: string; guessTimes: number[] }>,
): WordDifficultyResult | null {
  const withTimes = wordStats
    .filter((w) => w.guessTimes.length > 0)
    .map((w) => ({
      word: w.text,
      avgMs: w.guessTimes.reduce((sum, t) => sum + t, 0) / w.guessTimes.length,
    }))

  if (withTimes.length === 0) return null

  const sorted = [...withTimes].sort((a, b) => a.avgMs - b.avgMs)

  return {
    easiest: sorted.slice(0, 3),
    hardest: sorted.slice(-3).reverse(),
  }
}
