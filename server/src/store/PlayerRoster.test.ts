import { describe, it, expect } from 'vitest'
import { PlayerRoster, normaliseName } from './PlayerRoster.js'

function makePlayer(id: string, team: 1 | 2) {
  return { id, name: id, team, wordCount: 0 }
}

describe('normaliseName', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normaliseName('  Alice  ')).toBe('alice')
  })

  it('lowercases the name', () => {
    expect(normaliseName('ALICE')).toBe('alice')
  })

  it('collapses internal whitespace to a single space', () => {
    expect(normaliseName('alice  smith')).toBe('alice smith')
  })
})

describe('PlayerRoster', () => {
  describe('hasDuplicateName', () => {
    it('returns true when a player with the same name exists', () => {
      const roster = new PlayerRoster()
      roster.add(makePlayer('a', 1))
      expect(roster.hasDuplicateName('a')).toBe(true)
    })

    it('is case-insensitive', () => {
      const roster = new PlayerRoster()
      roster.add({ ...makePlayer('a', 1), name: 'Alice' })
      expect(roster.hasDuplicateName('alice')).toBe(true)
      expect(roster.hasDuplicateName('ALICE')).toBe(true)
    })

    it('ignores leading/trailing whitespace', () => {
      const roster = new PlayerRoster()
      roster.add({ ...makePlayer('a', 1), name: 'Alice' })
      expect(roster.hasDuplicateName('  Alice  ')).toBe(true)
    })

    it('collapses internal whitespace for comparison', () => {
      const roster = new PlayerRoster()
      roster.add({ ...makePlayer('a', 1), name: 'Alice Smith' })
      expect(roster.hasDuplicateName('alice  smith')).toBe(true)
    })

    it('returns false when no player matches', () => {
      const roster = new PlayerRoster()
      roster.add({ ...makePlayer('a', 1), name: 'Alice' })
      expect(roster.hasDuplicateName('Bob')).toBe(false)
    })
  })

  describe('anyPlayerExceeds', () => {
    it('returns false when no player exceeds the limit', () => {
      const roster = new PlayerRoster()
      const p = roster.add(makePlayer('a', 1))
      p.wordCount = 3
      expect(roster.anyPlayerExceeds(3)).toBe(false)
    })

    it('returns true when a player has more words than the limit', () => {
      const roster = new PlayerRoster()
      const p = roster.add(makePlayer('a', 1))
      p.wordCount = 4
      expect(roster.anyPlayerExceeds(3)).toBe(true)
    })
  })

  describe('getIdToNameMap', () => {
    it('returns a map of all player IDs to names', () => {
      const roster = new PlayerRoster()
      roster.add({ ...makePlayer('a', 1), name: 'Alice' })
      roster.add({ ...makePlayer('b', 2), name: 'Bob' })
      const map = roster.getIdToNameMap()
      expect(map.get('a')).toBe('Alice')
      expect(map.get('b')).toBe('Bob')
      expect(map.size).toBe(2)
    })
  })

  describe('add', () => {
    it('initialises active: true and zeroed stats', () => {
      const roster = new PlayerRoster()
      const player = roster.add(makePlayer('a', 1))
      expect(player.active).toBe(true)
      expect(player.stats).toEqual({ clueGiverCount: 0 })
    })

    it('returns the created player', () => {
      const roster = new PlayerRoster()
      const player = roster.add(makePlayer('a', 1))
      expect(player.id).toBe('a')
      expect(player.name).toBe('a')
      expect(player.team).toBe(1)
    })

    it('player appears in getAll() and getByTeam()', () => {
      const roster = new PlayerRoster()
      roster.add(makePlayer('a', 1))
      expect(roster.getAll()).toHaveLength(1)
      expect(roster.getByTeam(1)).toHaveLength(1)
    })
  })

  describe('kick', () => {
    it('sets active: false on the target player', () => {
      const roster = new PlayerRoster()
      roster.add(makePlayer('a', 1))
      roster.kick('a')
      expect(roster.getById('a')!.active).toBe(false)
    })

    it('preserves the player in getAll() but excludes them from getByTeam()', () => {
      const roster = new PlayerRoster()
      roster.add(makePlayer('a', 1))
      roster.kick('a')
      expect(roster.getAll()).toHaveLength(1)
      expect(roster.getByTeam(1)).toHaveLength(0)
    })

    it('preserves stats.clueGiverCount after kick', () => {
      const roster = new PlayerRoster()
      roster.add(makePlayer('a', 1))
      roster.incrementStat('a')
      roster.incrementStat('a')
      roster.kick('a')
      expect(roster.getById('a')!.stats.clueGiverCount).toBe(2)
    })

    it('is a no-op for an unknown id', () => {
      const roster = new PlayerRoster()
      roster.add(makePlayer('a', 1))
      expect(() => roster.kick('unknown')).not.toThrow()
      expect(roster.getByTeam(1)).toHaveLength(1)
    })
  })

  describe('incrementStat', () => {
    it('increments count on an active player', () => {
      const roster = new PlayerRoster()
      roster.add(makePlayer('a', 1))
      roster.incrementStat('a')
      expect(roster.getById('a')!.stats.clueGiverCount).toBe(1)
    })

    it('increments count on an inactive player — stats are preserved through kick', () => {
      const roster = new PlayerRoster()
      roster.add(makePlayer('a', 1))
      roster.incrementStat('a')
      roster.kick('a')
      roster.incrementStat('a')
      expect(roster.getById('a')!.stats.clueGiverCount).toBe(2)
    })
  })

  describe('resetStats', () => {
    it('zeroes clueGiverCount for all players', () => {
      const roster = new PlayerRoster()
      roster.add(makePlayer('a', 1))
      roster.add(makePlayer('b', 2))
      roster.incrementStat('a')
      roster.incrementStat('b')
      roster.resetStats()
      expect(roster.getById('a')!.stats.clueGiverCount).toBe(0)
      expect(roster.getById('b')!.stats.clueGiverCount).toBe(0)
    })
  })

  describe('assignNextClueGiver', () => {
    it('returns players in join order on first rotation', () => {
      const roster = new PlayerRoster()
      roster.add(makePlayer('a', 1))
      roster.add(makePlayer('b', 1))
      roster.add(makePlayer('c', 2))
      expect(roster.assignNextClueGiver(1).id).toBe('a')
      expect(roster.assignNextClueGiver(1).id).toBe('b')
    })

    it('wraps around after the last player on the team', () => {
      const roster = new PlayerRoster()
      roster.add(makePlayer('a', 1))
      roster.add(makePlayer('b', 1))
      roster.assignNextClueGiver(1) // a
      roster.assignNextClueGiver(1) // b
      expect(roster.assignNextClueGiver(1).id).toBe('a')
    })

    it('skips inactive players and continues rotation', () => {
      const roster = new PlayerRoster()
      roster.add(makePlayer('a', 1))
      roster.add(makePlayer('b', 1))
      roster.add(makePlayer('c', 1))
      roster.add(makePlayer('d', 1))
      roster.assignNextClueGiver(1) // a
      roster.assignNextClueGiver(1) // b
      roster.assignNextClueGiver(1) // c → lastClueGiverId = c
      roster.kick('d')              // d is next but now inactive
      // active players: [a, b, c]; last = c → nextIdx = (2+1)%3 = 0 → a
      expect(roster.assignNextClueGiver(1).id).toBe('a')
    })

    it('wraps correctly when the last-assigned player was kicked', () => {
      // A→B was the last assigned; B is kicked; active=[A,C]; findIndex(B)=-1 → nextIdx=0 → A
      // Known trade-off: this wraps to A rather than C. Documented in plan for ENG-024 review.
      const roster = new PlayerRoster()
      roster.add(makePlayer('a', 1))
      roster.add(makePlayer('b', 1))
      roster.add(makePlayer('c', 1))
      roster.assignNextClueGiver(1) // a
      roster.assignNextClueGiver(1) // b → lastClueGiverId = b
      roster.kick('b')              // b is now inactive
      // active=[a,c]; findIndex(b)=-1; nextIdx=(−1+1)%2=0 → a
      expect(roster.assignNextClueGiver(1).id).toBe('a')
    })

    it('handles a team where all but one player are kicked', () => {
      const roster = new PlayerRoster()
      roster.add(makePlayer('a', 1))
      roster.add(makePlayer('b', 1))
      roster.add(makePlayer('c', 1))
      roster.kick('b')
      roster.kick('c')
      expect(roster.assignNextClueGiver(1).id).toBe('a')
      expect(roster.assignNextClueGiver(1).id).toBe('a')
    })

    it('throws when all players on the team are inactive', () => {
      const roster = new PlayerRoster()
      roster.add(makePlayer('a', 1))
      roster.kick('a')
      expect(() => roster.assignNextClueGiver(1)).toThrow('No active players on team 1')
    })

    it('throws when team has no players at all', () => {
      const roster = new PlayerRoster()
      roster.add(makePlayer('a', 2))
      expect(() => roster.assignNextClueGiver(1)).toThrow('No active players on team 1')
    })

    it('team 2 rotation is independent of team 1', () => {
      const roster = new PlayerRoster()
      roster.add(makePlayer('a', 1))
      roster.add(makePlayer('b', 1))
      roster.add(makePlayer('x', 2))
      roster.add(makePlayer('y', 2))
      roster.assignNextClueGiver(1) // a
      roster.assignNextClueGiver(2) // x
      roster.assignNextClueGiver(1) // b
      expect(roster.assignNextClueGiver(2).id).toBe('y')
    })
  })
})
