import { describe, it, expect } from 'vitest'
import { Hat } from './Hat.js'
import type { Word } from '@wordfetti/shared'

function w(id: string, text: string): Word {
  return { id, text }
}

describe('Hat', () => {
  describe('construction', () => {
    it('has correct size after construction', () => {
      const hat = new Hat([w('a', 'apple'), w('b', 'banana'), w('c', 'cherry')])
      expect(hat.size).toBe(3)
      expect(hat.isEmpty).toBe(false)
    })

    it('has no current word before startTurn', () => {
      const hat = new Hat([w('a', 'apple')])
      expect(hat.current).toBeUndefined()
    })

    it('is empty with no words', () => {
      const hat = new Hat([])
      expect(hat.isEmpty).toBe(true)
    })
  })

  describe('startTurn', () => {
    it('returns a word and sets it as current', () => {
      const hat = new Hat([w('a', 'apple'), w('b', 'banana')])
      const word = hat.startTurn()
      expect(word).toBeDefined()
      expect(hat.current?.id).toBe(word.id)
    })

    it('resets skipped list from a previous turn', () => {
      const hat = new Hat([w('a', 'apple'), w('b', 'banana'), w('c', 'cherry')])
      hat.startTurn()
      hat.skip()
      hat.startTurn()
      // after startTurn, skipped is cleared — skip should be able to advance again
      expect(() => hat.skip()).not.toThrow()
    })

    it('throws when hat is empty', () => {
      const hat = new Hat([])
      expect(() => hat.startTurn()).toThrow('Hat is empty')
    })
  })

  describe('guess', () => {
    it('removes the current word and reduces size', () => {
      const hat = new Hat([w('a', 'apple'), w('b', 'banana'), w('c', 'cherry')])
      hat.startTurn()
      hat.guess()
      expect(hat.size).toBe(2)
    })

    it('returns false when words remain', () => {
      const hat = new Hat([w('a', 'apple'), w('b', 'banana')])
      hat.startTurn()
      expect(hat.guess()).toBe(false)
      expect(hat.size).toBe(1)
    })

    it('returns true and clears current when hat becomes empty', () => {
      const hat = new Hat([w('a', 'apple')])
      hat.startTurn()
      expect(hat.guess()).toBe(true)
      expect(hat.isEmpty).toBe(true)
      expect(hat.current).toBeUndefined()
    })

    it('advances to a new current word after guess', () => {
      const hat = new Hat([w('a', 'apple'), w('b', 'banana')])
      hat.startTurn()
      const firstId = hat.current!.id
      hat.guess()
      expect(hat.current!.id).not.toBe(firstId)
    })

    it('throws when no current word', () => {
      const hat = new Hat([w('a', 'apple')])
      expect(() => hat.guess()).toThrow('No current word')
    })
  })

  describe('skip', () => {
    it('does not remove the word from the hat', () => {
      const hat = new Hat([w('a', 'apple'), w('b', 'banana')])
      hat.startTurn()
      hat.skip()
      expect(hat.size).toBe(2)
    })

    it('advances to a different word when one is available', () => {
      const hat = new Hat([w('a', 'apple'), w('b', 'banana'), w('c', 'cherry')])
      hat.startTurn()
      const firstId = hat.current!.id
      hat.skip()
      expect(hat.current!.id).not.toBe(firstId)
    })

    it('cycles back to a skipped word when all others are also skipped', () => {
      const hat = new Hat([w('a', 'apple'), w('b', 'banana')])
      hat.startTurn()
      const firstId = hat.current!.id
      hat.skip() // skip first, move to second
      const second = hat.current!
      hat.skip() // skip second — only skipped words remain, must return one
      expect([firstId, second.id]).toContain(hat.current!.id)
    })

    it('stays on the same word when it is the only word in the hat', () => {
      const hat = new Hat([w('a', 'apple')])
      hat.startTurn()
      const result = hat.skip()
      expect(result.id).toBe('a')
      expect(hat.current!.id).toBe('a')
    })

    it('throws when no current word', () => {
      const hat = new Hat([w('a', 'apple')])
      expect(() => hat.skip()).toThrow('No current word')
    })
  })

  describe('refill', () => {
    it('restores all original words', () => {
      const hat = new Hat([w('a', 'apple'), w('b', 'banana'), w('c', 'cherry')])
      hat.startTurn()
      hat.guess()
      hat.guess()
      expect(hat.size).toBe(1)
      hat.refill()
      expect(hat.size).toBe(3)
    })

    it('clears current word after refill', () => {
      const hat = new Hat([w('a', 'apple'), w('b', 'banana')])
      hat.startTurn()
      hat.refill()
      expect(hat.current).toBeUndefined()
    })

    it('allows startTurn again after refill', () => {
      const hat = new Hat([w('a', 'apple')])
      hat.startTurn()
      hat.guess()
      hat.refill()
      expect(() => hat.startTurn()).not.toThrow()
    })
  })

  describe('wordTexts', () => {
    it('returns the text of all remaining words', () => {
      const hat = new Hat([w('a', 'apple'), w('b', 'banana')])
      hat.startTurn()
      hat.guess()
      expect(hat.wordTexts()).toHaveLength(1)
    })
  })
})
