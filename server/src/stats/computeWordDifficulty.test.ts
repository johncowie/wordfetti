import { describe, it, expect } from 'vitest'
import { computeWordDifficulty } from './computeWordDifficulty.js'

describe('computeWordDifficulty', () => {
  it('returns null when no words have been guessed', () => {
    expect(computeWordDifficulty([{ text: 'dog', guessTimes: [] }])).toBeNull()
  })

  it('returns null for an empty word list', () => {
    expect(computeWordDifficulty([])).toBeNull()
  })

  it('sorts easiest by lowest average ms', () => {
    const result = computeWordDifficulty([
      { text: 'dog', guessTimes: [5000] },
      { text: 'cat', guessTimes: [1000] },
      { text: 'elephant', guessTimes: [9000] },
    ])
    expect(result?.easiest[0].word).toBe('cat')
    expect(result?.easiest[1].word).toBe('dog')
    expect(result?.easiest[2].word).toBe('elephant')
  })

  it('sorts hardest by highest average ms', () => {
    const result = computeWordDifficulty([
      { text: 'dog', guessTimes: [5000] },
      { text: 'cat', guessTimes: [1000] },
      { text: 'elephant', guessTimes: [9000] },
    ])
    expect(result?.hardest[0].word).toBe('elephant')
    expect(result?.hardest[1].word).toBe('dog')
    expect(result?.hardest[2].word).toBe('cat')
  })

  it('returns at most 3 entries per list', () => {
    const words = Array.from({ length: 10 }, (_, i) => ({
      text: `word${i}`,
      guessTimes: [(i + 1) * 1000],
    }))
    const result = computeWordDifficulty(words)
    expect(result?.easiest).toHaveLength(3)
    expect(result?.hardest).toHaveLength(3)
  })

  it('averages multiple guess times correctly', () => {
    const result = computeWordDifficulty([
      { text: 'dog', guessTimes: [2000, 4000, 6000] },
    ])
    expect(result?.easiest[0].avgMs).toBe(4000)
  })

  it('excludes words with no guess times', () => {
    const result = computeWordDifficulty([
      { text: 'skipped', guessTimes: [] },
      { text: 'guessed', guessTimes: [3000] },
    ])
    expect(result?.easiest).toHaveLength(1)
    expect(result?.easiest[0].word).toBe('guessed')
  })

  it('returns fewer than 3 entries when fewer words were guessed', () => {
    const result = computeWordDifficulty([
      { text: 'only', guessTimes: [1000] },
    ])
    expect(result?.easiest).toHaveLength(1)
    expect(result?.hardest).toHaveLength(1)
  })
})
