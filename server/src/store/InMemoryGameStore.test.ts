import { describe, it, expect } from 'vitest'
import { InMemoryGameStore } from './InMemoryGameStore.js'
import type { Game } from '@wordfetti/shared'

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
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    await store.startGame(game.joinCode)
    await expect(store.joinGame(game.joinCode, 'Alice', 1)).rejects.toMatchObject({
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
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    await store.startGame(game.joinCode)
    const updated = await store.getGameByJoinCode(game.joinCode)
    expect(updated?.status).toBe('in_progress')
  })

  it('notifies subscribers with the updated game', async () => {
    const store = new InMemoryGameStore()
    const game = await store.createGame()
    const updates: Game[] = []
    store.subscribe(game.joinCode, (g) => updates.push(g))
    await store.startGame(game.joinCode)
    expect(updates).toHaveLength(1)
    expect(updates[0].status).toBe('in_progress')
  })

  it('throws NOT_FOUND for an unknown join code', async () => {
    const store = new InMemoryGameStore()
    await expect(store.startGame('XXXXXX')).rejects.toMatchObject({ code: 'NOT_FOUND' })
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
