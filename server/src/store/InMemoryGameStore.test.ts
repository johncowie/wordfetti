import { describe, it, expect } from 'vitest'
import { InMemoryGameStore } from './InMemoryGameStore.js'
import { WORDS_PER_PLAYER } from '@wordfetti/shared'
import type { Game } from '@wordfetti/shared'

// Creates a game with 2 players per team, each having submitted WORDS_PER_PLAYER words.
// Ready to call startGame on.
async function setupReadyGame() {
  const store = new InMemoryGameStore()
  const { game, player: host } = await store.createGameWithHost('Alice', 1)
  const p2 = await store.joinGame(game.joinCode, 'Bob', 1)
  const p3 = await store.joinGame(game.joinCode, 'Carol', 2)
  const p4 = await store.joinGame(game.joinCode, 'Dave', 2)

  const wordSets: [string, string[]][] = [
    [host.id, ['cat', 'dog', 'fish', 'bird', 'ant']],
    [p2.id,   ['sun', 'moon', 'star', 'sky', 'rain']],
    [p3.id,   ['red', 'blue', 'green', 'yellow', 'pink']],
    [p4.id,   ['one', 'two', 'three', 'four', 'five']],
  ]
  for (const [playerId, words] of wordSets) {
    for (const text of words) {
      await store.addWord(game.joinCode, playerId, text)
    }
  }
  return { store, joinCode: game.joinCode }
}

// Convenience wrapper that also calls startGame, for tests that need an in-progress game.
async function setupStartedGame() {
  const { store, joinCode } = await setupReadyGame()
  const game = await store.startGame(joinCode)
  return { store, joinCode, game }
}

describe('InMemoryGameStore', () => {
  it('creates a game with a 6-character join code using only valid characters', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    expect(game.joinCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/)
  })

  it('join code never contains ambiguous characters', async () => {
    const store = new InMemoryGameStore()
    for (let i = 0; i < 50; i++) {
      const game = await store.createGame()
      expect(game.joinCode).not.toMatch(/[01ILO]/)
    }
  })

  it('retrieves a game by join code', async () => {
    const store = new InMemoryGameStore()
    const created = await store.createGame()
    const found = await store.getGameByJoinCode(created.joinCode)
    expect(found).toEqual(created)
  })

  it('returns null for an unknown join code', async () => {
    const store = new InMemoryGameStore()
    const found = await store.getGameByJoinCode('XXXXXX')
    expect(found).toBeNull()
  })
})

describe('joinGame', () => {
  it('adds a player to an existing game and returns the player', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    const player = await store.joinGame(game.joinCode, 'Alice', 1)
    expect(player.name).toBe('Alice')
    expect(player.team).toBe(1)
    expect(typeof player.id).toBe('string')
    const updated = await store.getGameByJoinCode(game.joinCode)
    expect(updated?.players).toHaveLength(1)
    expect(updated?.players[0]).toEqual(player)
  })

  it('adds multiple players to the same game', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    await store.joinGame(game.joinCode, 'Alice', 1)
    await store.joinGame(game.joinCode, 'Bob', 2)
    const updated = await store.getGameByJoinCode(game.joinCode)
    expect(updated?.players).toHaveLength(2)
    expect(updated?.players.map((p) => p.name)).toEqual(['Alice', 'Bob'])
  })

  it('throws NOT_FOUND for an unknown join code', async () => {
    const store = new InMemoryGameStore()
    await expect(store.joinGame('XXXXXX', 'Alice', 1)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('throws GAME_IN_PROGRESS when the game has already started', async () => {
    const { store, joinCode } = await setupStartedGame()
    await expect(store.joinGame(joinCode, 'Alice', 1)).rejects.toMatchObject({
      code: 'GAME_IN_PROGRESS',
    })
  })
})

describe('createGameWithHost', () => {
  it('creates a game and registers the host as the first player atomically', async () => {
    const store = new InMemoryGameStore()
    const { game, player } = await store.createGameWithHost('Alice', 1)
    expect(typeof game.joinCode).toBe('string')
    expect(player.name).toBe('Alice')
    expect(player.team).toBe(1)
    const fetched = await store.getGameByJoinCode(game.joinCode)
    expect(fetched?.players).toHaveLength(1)
    expect(fetched?.players[0].name).toBe('Alice')
  })

  it('records the host player id on the game', async () => {
    const store = new InMemoryGameStore()
    const { game, player } = await store.createGameWithHost('Alice', 1)
    expect(game.hostId).toBe(player.id)
  })
})

describe('startGame', () => {
  it('transitions the game status to in_progress', async () => {
    const { store, joinCode } = await setupReadyGame()
    await store.startGame(joinCode)
    const updated = await store.getGameByJoinCode(joinCode)
    expect(updated?.status).toBe('in_progress')
  })

  it('notifies subscribers with the updated game', async () => {
    const { store, joinCode } = await setupReadyGame()
    const updates: Game[] = []
    store.subscribe(joinCode, (g) => updates.push(g))
    await store.startGame(joinCode)
    expect(updates).toHaveLength(1)
    expect(updates[0].status).toBe('in_progress')
  })

  it('throws NOT_FOUND for an unknown join code', async () => {
    const store = new InMemoryGameStore()
    await expect(store.startGame('XXXXXX')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('hat contains exactly all submitted words', async () => {
    const { store, joinCode } = await setupReadyGame()
    const game = await store.startGame(joinCode)
    expect(game.hat).toHaveLength(20)
    expect([...game.hat!].sort()).toEqual([
      'ant', 'bird', 'blue', 'cat', 'dog', 'fish', 'five', 'four', 'green',
      'moon', 'one', 'pink', 'rain', 'red', 'sky', 'star', 'sun', 'three', 'two', 'yellow',
    ])
  })

  it('sets activeTeam to 1 or 2, and both values are reachable', async () => {
    // Run enough iterations to confirm both teams can be chosen — the
    // probability of the same team appearing 20 times in a row is < 1 in 10^6.
    const seen = new Set<number>()
    for (let i = 0; i < 20 && seen.size < 2; i++) {
      const { store, joinCode } = await setupReadyGame()
      const game = await store.startGame(joinCode)
      seen.add(game.activeTeam!)
    }
    expect(seen).toContain(1)
    expect(seen).toContain(2)
  })

  it('sets currentClueGiverId to the first player on activeTeam by join order', async () => {
    const { store, joinCode } = await setupReadyGame()
    const game = await store.startGame(joinCode)
    const firstOnTeam = game.players.find((p) => p.team === game.activeTeam)!
    expect(game.currentClueGiverId).toBe(firstOnTeam.id)
  })

  it('sets turnPhase to ready', async () => {
    const { store, joinCode } = await setupReadyGame()
    const game = await store.startGame(joinCode)
    expect(game.turnPhase).toBe('ready')
  })

  it('initialises scores to zero', async () => {
    const { store, joinCode } = await setupReadyGame()
    const game = await store.startGame(joinCode)
    expect(game.scores).toEqual({ team1: 0, team2: 0 })
  })

  it('throws INVALID_STATE when no players exist on the selected team', async () => {
    // All players on team 1 — if Math.random picks team 2 the guard must fire.
    // Run up to 20 times to hit team 2 selection with high confidence.
    let threwInvalidState = false
    for (let i = 0; i < 20; i++) {
      const freshStore = new InMemoryGameStore()
      const { game: g, player: h } = await freshStore.createGameWithHost('Alice', 1)
      const q2 = await freshStore.joinGame(g.joinCode, 'Bob', 1)
      for (const [pid, words] of [[h.id, ['a', 'b', 'c', 'd', 'e']], [q2.id, ['f', 'g', 'h', 'i', 'j']]] as [string, string[]][]) {
        for (const text of words) await freshStore.addWord(g.joinCode, pid, text)
      }
      try {
        await freshStore.startGame(g.joinCode)
      } catch (err: unknown) {
        expect((err as { code: string }).code).toBe('INVALID_STATE')
        threwInvalidState = true
        break
      }
    }
    expect(threwInvalidState).toBe(true)
  })
})

describe('addWord', () => {
  it('notifies subscribers with updated wordCount after addWord', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    const player = await store.joinGame(game.joinCode, 'Alice', 1)
    const updates: Game[] = []
    store.subscribe(game.joinCode, (g) => updates.push(g))
    await store.addWord(game.joinCode, player.id, 'apple')
    expect(updates).toHaveLength(1)
    expect(updates[0].players.find((p) => p.id === player.id)?.wordCount).toBe(1)
  })

  it('adds a word and returns it', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    const player = await store.joinGame(game.joinCode, 'Alice', 1)
    const word = await store.addWord(game.joinCode, player.id, 'banana')
    expect(word.text).toBe('banana')
    expect(typeof word.id).toBe('string')
  })

  it('accepts the 5th word and rejects the 6th with WORD_LIMIT_REACHED', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    const player = await store.joinGame(game.joinCode, 'Alice', 1)
    for (let i = 1; i < WORDS_PER_PLAYER; i++) {
      await store.addWord(game.joinCode, player.id, `word${i}`)
    }
    // 5th word must succeed
    await expect(store.addWord(game.joinCode, player.id, 'fifth')).resolves.toMatchObject({ text: 'fifth' })
    // 6th must be rejected
    await expect(store.addWord(game.joinCode, player.id, 'sixth')).rejects.toMatchObject({
      code: 'WORD_LIMIT_REACHED',
    })
  })

  it('throws NOT_FOUND when game does not exist', async () => {
    const store = new InMemoryGameStore()
    await expect(store.addWord('XXXXXX', 'p1', 'banana')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('throws FORBIDDEN when player not in game', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    await expect(store.addWord(game.joinCode, 'unknown-player', 'banana')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('throws GAME_NOT_IN_LOBBY when game is in_progress', async () => {
    const { store, joinCode, game } = await setupStartedGame()
    const player = game.players[0]
    await expect(store.addWord(joinCode, player.id, 'banana')).rejects.toMatchObject({
      code: 'GAME_NOT_IN_LOBBY',
    })
  })
})

describe('getWords', () => {
  it('returns only that player\'s words', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    const alice = await store.joinGame(game.joinCode, 'Alice', 1)
    const bob = await store.joinGame(game.joinCode, 'Bob', 2)
    await store.addWord(game.joinCode, alice.id, 'apple')
    await store.addWord(game.joinCode, alice.id, 'banana')
    await store.addWord(game.joinCode, bob.id, 'cherry')
    const aliceWords = await store.getWords(game.joinCode, alice.id)
    expect(aliceWords).toHaveLength(2)
    expect(aliceWords.map((w) => w.text)).toEqual(['apple', 'banana'])
  })

  it('throws FORBIDDEN when player not in game', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    await expect(store.getWords(game.joinCode, 'unknown-player')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })
})

describe('deleteWord', () => {
  it('removes the word so subsequent getWords does not include it', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    const player = await store.joinGame(game.joinCode, 'Alice', 1)
    const word = await store.addWord(game.joinCode, player.id, 'banana')
    await store.deleteWord(game.joinCode, player.id, word.id)
    const words = await store.getWords(game.joinCode, player.id)
    expect(words).toHaveLength(0)
  })

  it('throws NOT_FOUND when game does not exist', async () => {
    const store = new InMemoryGameStore()
    await expect(store.deleteWord('XXXXXX', 'p1', 'w1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('throws GAME_NOT_IN_LOBBY when game is in_progress', async () => {
    const { store, joinCode, game } = await setupStartedGame()
    const player = game.players[0]
    // We need a word id — get it from the store's words. Since we can't get words after
    // the game starts (that method works regardless of status), look up via getWords.
    const words = await store.getWords(joinCode, player.id)
    await expect(store.deleteWord(joinCode, player.id, words[0].id)).rejects.toMatchObject({ code: 'GAME_NOT_IN_LOBBY' })
  })

  it('throws FORBIDDEN when player not in game', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    await expect(store.deleteWord(game.joinCode, 'unknown-player', 'w1')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('throws NOT_FOUND when word id does not exist', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    const player = await store.joinGame(game.joinCode, 'Alice', 1)
    await expect(store.deleteWord(game.joinCode, player.id, 'nonexistent-id')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('subscribe', () => {
  it('calls the callback with the updated game when a player joins', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    const updates: Game[] = []
    store.subscribe(game.joinCode, (g) => updates.push(g))
    await store.joinGame(game.joinCode, 'Alice', 1)
    expect(updates).toHaveLength(1)
    expect(updates[0].players[0].name).toBe('Alice')
  })

  it('does not call the callback after unsubscribe', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    const updates: Game[] = []
    const unsub = store.subscribe(game.joinCode, (g) => updates.push(g))
    unsub()
    await store.joinGame(game.joinCode, 'Alice', 1)
    expect(updates).toHaveLength(0)
  })

  it('does not call callbacks for a different game', async () => {
    const store = new InMemoryGameStore()
    const game1 = await store.createGame()
    const game2 = await store.createGame()
    const updates: Game[] = []
    store.subscribe(game1.joinCode, (g) => updates.push(g))
    await store.joinGame(game2.joinCode, 'Alice', 1)
    expect(updates).toHaveLength(0)
  })

  it('delivered snapshot is not mutated by a subsequent join', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    const updates: Game[] = []
    store.subscribe(game.joinCode, (g) => updates.push(g))
    await store.joinGame(game.joinCode, 'Alice', 1)
    await store.joinGame(game.joinCode, 'Bob', 2)
    // First snapshot must still reflect only Alice
    expect(updates[0].players).toHaveLength(1)
    expect(updates[0].players[0].name).toBe('Alice')
  })
})
