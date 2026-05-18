import { describe, it, expect } from 'vitest'
import { calculateDefaultWordsPerPlayer } from './gameSettings'

describe('calculateDefaultWordsPerPlayer', () => {
  it('returns target result for normal player count (6 players → 5)', () => {
    expect(calculateDefaultWordsPerPlayer(6)).toBe(5)
  })

  it('clamps to min (12 players → 3)', () => {
    expect(calculateDefaultWordsPerPlayer(12)).toBe(3)
  })

  it('clamps to max (2 players → 10)', () => {
    expect(calculateDefaultWordsPerPlayer(2)).toBe(10)
  })

  it('rounds to nearest integer (7 players → 4, i.e. round(30/7) = round(4.28) = 4)', () => {
    expect(calculateDefaultWordsPerPlayer(7)).toBe(4)
  })

  it('floors correctly (5 players → 6, i.e. floor(30/5) = 6)', () => {
    expect(calculateDefaultWordsPerPlayer(5)).toBe(6)
  })

  it('floors down at .5 (4 players → 7, i.e. floor(30/4) = 7)', () => {
    expect(calculateDefaultWordsPerPlayer(4)).toBe(7)
  })

  it('respects custom targetTotal override', () => {
    expect(calculateDefaultWordsPerPlayer(5, 50)).toBe(10)
  })

  it('handles 0 players without throwing (returns MIN)', () => {
    expect(calculateDefaultWordsPerPlayer(0)).toBe(3)
  })
})
