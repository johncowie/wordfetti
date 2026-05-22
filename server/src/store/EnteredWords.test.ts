import { describe, it, expect } from 'vitest'
import { EnteredWords } from './EnteredWords.js'

describe('EnteredWords', () => {
  describe('add', () => {
    it('returns the created word with trimmed text and a generated id', () => {
      const ew = new EnteredWords()
      const word = ew.add('p1', '  apple  ', 5)
      expect(word.text).toBe('apple')
      expect(typeof word.id).toBe('string')
      expect(word.id.length).toBeGreaterThan(0)
    })

    it('allows adding words up to the limit', () => {
      const ew = new EnteredWords()
      ew.add('p1', 'a', 3)
      ew.add('p1', 'b', 3)
      expect(() => ew.add('p1', 'c', 3)).not.toThrow()
    })

    it('throws WORD_LIMIT_REACHED when the limit is reached', () => {
      const ew = new EnteredWords()
      ew.add('p1', 'a', 2)
      ew.add('p1', 'b', 2)
      expect(() => ew.add('p1', 'c', 2)).toThrow(expect.objectContaining({ code: 'WORD_LIMIT_REACHED' }))
    })

    it('enforces limits per player independently', () => {
      const ew = new EnteredWords()
      ew.add('p1', 'a', 1)
      expect(() => ew.add('p1', 'b', 1)).toThrow()
      expect(() => ew.add('p2', 'b', 1)).not.toThrow()
    })
  })

  describe('delete', () => {
    it('removes the word so get no longer returns it', () => {
      const ew = new EnteredWords()
      const word = ew.add('p1', 'apple', 5)
      ew.delete('p1', word.id)
      expect(ew.get('p1')).toHaveLength(0)
    })

    it('only removes the matching word when a player has multiple', () => {
      const ew = new EnteredWords()
      ew.add('p1', 'apple', 5)
      const banana = ew.add('p1', 'banana', 5)
      ew.delete('p1', banana.id)
      const remaining = ew.get('p1')
      expect(remaining).toHaveLength(1)
      expect(remaining[0].text).toBe('apple')
    })

    it('throws NOT_FOUND when the word id does not exist', () => {
      const ew = new EnteredWords()
      ew.add('p1', 'apple', 5)
      expect(() => ew.delete('p1', 'nonexistent-id')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    })
  })

  describe('get', () => {
    it('returns an empty array for a player with no words', () => {
      const ew = new EnteredWords()
      expect(ew.get('p1')).toEqual([])
    })

    it('returns only the words for the requested player', () => {
      const ew = new EnteredWords()
      ew.add('p1', 'apple', 5)
      ew.add('p2', 'banana', 5)
      expect(ew.get('p1').map((w) => w.text)).toEqual(['apple'])
    })

    it('returns a copy — mutating the result does not affect internal state', () => {
      const ew = new EnteredWords()
      ew.add('p1', 'apple', 5)
      const result = ew.get('p1')
      result.pop()
      expect(ew.get('p1')).toHaveLength(1)
    })
  })

  describe('getCount', () => {
    it('returns 0 for a player with no words', () => {
      expect(new EnteredWords().getCount('p1')).toBe(0)
    })

    it('returns the correct count after add and delete', () => {
      const ew = new EnteredWords()
      ew.add('p1', 'a', 5)
      ew.add('p1', 'b', 5)
      expect(ew.getCount('p1')).toBe(2)
      const word = ew.get('p1')[0]
      ew.delete('p1', word.id)
      expect(ew.getCount('p1')).toBe(1)
    })
  })

  describe('anyExceedsLimit', () => {
    it('returns false when no player has more words than the limit', () => {
      const ew = new EnteredWords()
      ew.add('p1', 'a', 5)
      ew.add('p1', 'b', 5)
      expect(ew.anyExceedsLimit(2)).toBe(false)
    })

    it('returns true when any player exceeds the limit', () => {
      const ew = new EnteredWords()
      ew.add('p1', 'a', 5)
      ew.add('p1', 'b', 5)
      ew.add('p1', 'c', 5)
      expect(ew.anyExceedsLimit(2)).toBe(true)
    })

    it('returns false when collection is empty', () => {
      expect(new EnteredWords().anyExceedsLimit(0)).toBe(false)
    })
  })

  describe('total', () => {
    it('returns 0 when empty', () => {
      expect(new EnteredWords().total()).toBe(0)
    })

    it('sums words across all players', () => {
      const ew = new EnteredWords()
      ew.add('p1', 'a', 5)
      ew.add('p1', 'b', 5)
      ew.add('p2', 'c', 5)
      expect(ew.total()).toBe(3)
    })
  })

  describe('toWordList', () => {
    it('returns a flat list of all words across all players', () => {
      const ew = new EnteredWords()
      ew.add('p1', 'apple', 5)
      ew.add('p2', 'banana', 5)
      const list = ew.toWordList()
      expect(list).toHaveLength(2)
      expect(list.map((w) => w.text).sort()).toEqual(['apple', 'banana'])
    })

    it('returns an empty array when no words have been added', () => {
      expect(new EnteredWords().toWordList()).toEqual([])
    })
  })

  describe('groupedByPlayer', () => {
    it('groups words by player name, sorted alphabetically by name and by word', () => {
      const ew = new EnteredWords()
      ew.add('p1', 'zebra', 5)
      ew.add('p1', 'apple', 5)
      ew.add('p2', 'mango', 5)
      const names = new Map([['p1', 'Charlie'], ['p2', 'Alice']])
      const result = ew.groupedByPlayer(names)
      expect(result).toEqual([
        { submitterName: 'Alice', words: ['mango'] },
        { submitterName: 'Charlie', words: ['apple', 'zebra'] },
      ])
    })

    it('excludes players whose id is not in the name map', () => {
      const ew = new EnteredWords()
      ew.add('p1', 'apple', 5)
      ew.add('p2', 'banana', 5)
      const result = ew.groupedByPlayer(new Map([['p1', 'Alice']]))
      expect(result).toHaveLength(1)
      expect(result[0].submitterName).toBe('Alice')
    })

    it('returns empty array when no words have been added', () => {
      const result = new EnteredWords().groupedByPlayer(new Map([['p1', 'Alice']]))
      expect(result).toEqual([])
    })
  })
})
