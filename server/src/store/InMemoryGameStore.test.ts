import { describe, it, expect } from 'vitest'
import { InMemoryGameStore } from './InMemoryGameStore.js'
import { pickTeamNames } from '../teamNames.js'
import type { GameSnapshot } from '@wordfetti/shared'
import type { GameConfig } from '../config.js'

const TEST_CONFIG: GameConfig = { wordsPerPlayer: 5, turnDurationSeconds: 45 }

// Creates a game with 2 players per team, each having submitted TEST_CONFIG.wordsPerPlayer words.
// Ready to call startGame on.
async function setupReadyGame() {
  const store = new InMemoryGameStore(TEST_CONFIG)
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
    const store = new InMemoryGameStore(TEST_CONFIG)
    const game = await store.createGame()
    expect(game.joinCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/)
  })

  it('join code never contains ambiguous characters', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    for (let i = 0; i < 50; i++) {
      const game = await store.createGame()
      expect(game.joinCode).not.toMatch(/[01ILO]/)
    }
  })

  it('retrieves a game by join code', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const created = await store.createGame()
    const found = await store.getGameByJoinCode(created.joinCode)
    expect(found).toEqual(created)
  })

  it('returns null for an unknown join code', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const found = await store.getGameByJoinCode('XXXXXX')
    expect(found).toBeNull()
  })
})

describe('joinGame', () => {
  it('adds a player to an existing game and returns the player', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
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
    const store = new InMemoryGameStore(TEST_CONFIG)
    const game = await store.createGame()
    await store.joinGame(game.joinCode, 'Alice', 1)
    await store.joinGame(game.joinCode, 'Bob', 2)
    const updated = await store.getGameByJoinCode(game.joinCode)
    expect(updated?.players).toHaveLength(2)
    expect(updated?.players.map((p) => p.name)).toEqual(['Alice', 'Bob'])
  })

  it('throws NOT_FOUND for an unknown join code', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
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

  it('throws NAME_TAKEN when the normalised name matches an existing player case-insensitively', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const { game } = await store.createGameWithHost('Alice', 1)
    await expect(store.joinGame(game.joinCode, 'alice', 2)).rejects.toMatchObject({
      code: 'NAME_TAKEN',
    })
  })

  it('throws NAME_TAKEN when the name matches with differing outer whitespace', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const { game } = await store.createGameWithHost('Alice', 1)
    await expect(store.joinGame(game.joinCode, '  alice  ', 2)).rejects.toMatchObject({
      code: 'NAME_TAKEN',
    })
  })

  it('throws NAME_TAKEN when the name matches with collapsed internal whitespace', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const { game } = await store.createGameWithHost('Alice Smith', 1)
    await expect(store.joinGame(game.joinCode, 'alice  smith', 2)).rejects.toMatchObject({
      code: 'NAME_TAKEN',
    })
  })

  it('allows a genuinely different name', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const { game } = await store.createGameWithHost('Alice', 1)
    const player = await store.joinGame(game.joinCode, 'Bob', 2)
    expect(player.name).toBe('Bob')
  })
})

describe('createGameWithHost', () => {
  it('creates a game and registers the host as the first player atomically', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const { game, player } = await store.createGameWithHost('Alice', 1)
    expect(typeof game.joinCode).toBe('string')
    expect(player.name).toBe('Alice')
    expect(player.team).toBe(1)
    const fetched = await store.getGameByJoinCode(game.joinCode)
    expect(fetched?.players).toHaveLength(1)
    expect(fetched?.players[0].name).toBe('Alice')
  })

  it('records the host player id on the game', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
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
    const updates: GameSnapshot[] = []
    store.subscribe(joinCode, (g) => updates.push(g))
    await store.startGame(joinCode)
    expect(updates).toHaveLength(1)
    expect(updates[0].status).toBe('in_progress')
  })

  it('throws NOT_FOUND for an unknown join code', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    await expect(store.startGame('XXXXXX')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('hat contains exactly all submitted words', async () => {
    const { store, joinCode } = await setupReadyGame()
    await store.startGame(joinCode)
    const internal = store['games'].get(joinCode)!
    expect(internal.hat!.size).toBe(20)
    expect(internal.hat!.wordTexts().sort()).toEqual([
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

  it('sets round to 1', async () => {
    const { store, joinCode } = await setupReadyGame()
    const game = await store.startGame(joinCode)
    expect(game.round).toBe(1)
  })

  it('throws INVALID_STATE when no players exist on the selected team', async () => {
    // All players on team 1 — if Math.random picks team 2 the guard must fire.
    // Run up to 20 times to hit team 2 selection with high confidence.
    let threwInvalidState = false
    for (let i = 0; i < 20; i++) {
      const freshStore = new InMemoryGameStore(TEST_CONFIG)
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
    const store = new InMemoryGameStore(TEST_CONFIG)
    const game = await store.createGame()
    const player = await store.joinGame(game.joinCode, 'Alice', 1)
    const updates: GameSnapshot[] = []
    store.subscribe(game.joinCode, (g) => updates.push(g))
    await store.addWord(game.joinCode, player.id, 'apple')
    expect(updates).toHaveLength(1)
    expect(updates[0].players.find((p) => p.id === player.id)?.wordCount).toBe(1)
  })

  it('adds a word and returns it', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const game = await store.createGame()
    const player = await store.joinGame(game.joinCode, 'Alice', 1)
    const word = await store.addWord(game.joinCode, player.id, 'banana')
    expect(word.text).toBe('banana')
    expect(typeof word.id).toBe('string')
  })

  it('accepts the last word and rejects the next with WORD_LIMIT_REACHED', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const game = await store.createGame()
    const player = await store.joinGame(game.joinCode, 'Alice', 1)
    for (let i = 1; i < TEST_CONFIG.wordsPerPlayer; i++) {
      await store.addWord(game.joinCode, player.id, `word${i}`)
    }
    // last allowed word must succeed
    await expect(store.addWord(game.joinCode, player.id, 'last')).resolves.toMatchObject({ text: 'last' })
    // one over the limit must be rejected
    await expect(store.addWord(game.joinCode, player.id, 'over')).rejects.toMatchObject({
      code: 'WORD_LIMIT_REACHED',
    })
  })

  it('throws NOT_FOUND when game does not exist', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    await expect(store.addWord('XXXXXX', 'p1', 'banana')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('throws FORBIDDEN when player not in game', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
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
    const store = new InMemoryGameStore(TEST_CONFIG)
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
    const store = new InMemoryGameStore(TEST_CONFIG)
    const game = await store.createGame()
    await expect(store.getWords(game.joinCode, 'unknown-player')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })
})

describe('deleteWord', () => {
  it('removes the word so subsequent getWords does not include it', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const game = await store.createGame()
    const player = await store.joinGame(game.joinCode, 'Alice', 1)
    const word = await store.addWord(game.joinCode, player.id, 'banana')
    await store.deleteWord(game.joinCode, player.id, word.id)
    const words = await store.getWords(game.joinCode, player.id)
    expect(words).toHaveLength(0)
  })

  it('throws NOT_FOUND when game does not exist', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
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
    const store = new InMemoryGameStore(TEST_CONFIG)
    const game = await store.createGame()
    await expect(store.deleteWord(game.joinCode, 'unknown-player', 'w1')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('throws NOT_FOUND when word id does not exist', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const game = await store.createGame()
    const player = await store.joinGame(game.joinCode, 'Alice', 1)
    await expect(store.deleteWord(game.joinCode, player.id, 'nonexistent-id')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('subscribe', () => {
  it('calls the callback with the updated game when a player joins', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const game = await store.createGame()
    const updates: GameSnapshot[] = []
    store.subscribe(game.joinCode, (g) => updates.push(g))
    await store.joinGame(game.joinCode, 'Alice', 1)
    expect(updates).toHaveLength(1)
    expect(updates[0].players[0].name).toBe('Alice')
  })

  it('does not call the callback after unsubscribe', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const game = await store.createGame()
    const updates: GameSnapshot[] = []
    const unsub = store.subscribe(game.joinCode, (g) => updates.push(g))
    unsub()
    await store.joinGame(game.joinCode, 'Alice', 1)
    expect(updates).toHaveLength(0)
  })

  it('does not call callbacks for a different game', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const game1 = await store.createGame()
    const game2 = await store.createGame()
    const updates: GameSnapshot[] = []
    store.subscribe(game1.joinCode, (g) => updates.push(g))
    await store.joinGame(game2.joinCode, 'Alice', 1)
    expect(updates).toHaveLength(0)
  })

  it('delivered snapshot is not mutated by a subsequent join', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const game = await store.createGame()
    const updates: GameSnapshot[] = []
    store.subscribe(game.joinCode, (g) => updates.push(g))
    await store.joinGame(game.joinCode, 'Alice', 1)
    await store.joinGame(game.joinCode, 'Bob', 2)
    // First snapshot must still reflect only Alice
    expect(updates[0].players).toHaveLength(1)
    expect(updates[0].players[0].name).toBe('Alice')
  })
})

// Builds a started game and calls readyTurn to put it in the 'active' turn phase.
async function setupActiveGame() {
  const { store, joinCode, game: started } = await setupStartedGame()
  const clueGiverId = started.currentClueGiverId!
  const game = await store.readyTurn(joinCode, clueGiverId)
  return { store, joinCode, clueGiverId, game }
}

describe('readyTurn', () => {
  it('sets turnPhase to active and currentWord to the first word in hat', async () => {
    const { store, joinCode, game: started } = await setupStartedGame()
    const clueGiverId = started.currentClueGiverId!
    const game = await store.readyTurn(joinCode, clueGiverId)
    expect(game.turnPhase).toBe('active')
    expect(typeof game.currentWord).toBe('string')
    expect(game.currentWord!.length).toBeGreaterThan(0)
  })

  it('resets guessedThisTurn to []', async () => {
    const { store, joinCode, game: started } = await setupStartedGame()
    const clueGiverId = started.currentClueGiverId!
    const game = await store.readyTurn(joinCode, clueGiverId)
    expect(game.guessedThisTurn).toEqual([])
  })

  it('broadcasts the updated game to subscribers', async () => {
    const { store, joinCode, game: started } = await setupStartedGame()
    const clueGiverId = started.currentClueGiverId!
    const updates: GameSnapshot[] = []
    store.subscribe(joinCode, (g) => updates.push(g))
    await store.readyTurn(joinCode, clueGiverId)
    expect(updates).toHaveLength(1)
    expect(updates[0].turnPhase).toBe('active')
  })

  it('throws FORBIDDEN when caller is not the clue giver', async () => {
    const { store, joinCode, game: started } = await setupStartedGame()
    const nonClueGiver = started.players.find((p) => p.id !== started.currentClueGiverId)!
    await expect(store.readyTurn(joinCode, nonClueGiver.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('throws TURN_ALREADY_ACTIVE when turnPhase is already active', async () => {
    const { store, joinCode, clueGiverId } = await setupActiveGame()
    await expect(store.readyTurn(joinCode, clueGiverId)).rejects.toMatchObject({ code: 'TURN_ALREADY_ACTIVE' })
  })

  it('throws TURN_NOT_ALLOWED when game is not in_progress', async () => {
    const { store, joinCode } = await setupReadyGame()
    const game = await store.getGameByJoinCode(joinCode)
    const playerId = game!.players[0].id
    await expect(store.readyTurn(joinCode, playerId)).rejects.toMatchObject({ code: 'TURN_NOT_ALLOWED' })
  })
})

describe('guessWord', () => {
  it('removes only the guessed word by ID when two words share the same text', async () => {
    // Build a minimal game with two identical-text words
    const store = new InMemoryGameStore(TEST_CONFIG)
    const { game, player: host } = await store.createGameWithHost('Alice', 1)
    const p2 = await store.joinGame(game.joinCode, 'Bob', 2)
    // Add 5 words each so startGame can proceed, but we need control over hat content.
    // We submit identical text ('dup') for two players.
    for (let i = 0; i < 5; i++) {
      await store.addWord(game.joinCode, host.id, i === 0 ? 'dup' : `a${i}`)
      await store.addWord(game.joinCode, p2.id, i === 0 ? 'dup' : `b${i}`)
    }
    const started = await store.startGame(game.joinCode)
    const clueGiverId = started.currentClueGiverId!
    await store.readyTurn(game.joinCode, clueGiverId)
    await store.guessWord(game.joinCode, clueGiverId)
    // Hat had 10 words; after one guess it must have 9 (only one 'dup' removed)
    expect(store['games'].get(game.joinCode)!.hat!.size).toBe(9)
  })

  it('increments only the active team score, leaves other score unchanged', async () => {
    const { store, joinCode, clueGiverId, game: active } = await setupActiveGame()
    const team = active.players.find((p) => p.id === clueGiverId)!.team
    const afterGuess = await store.guessWord(joinCode, clueGiverId)
    if (team === 1) {
      expect(afterGuess.scores).toEqual({ team1: 1, team2: 0 })
    } else {
      expect(afterGuess.scores).toEqual({ team1: 0, team2: 1 })
    }
  })

  it('accumulates guessedThisTurn across consecutive guesses', async () => {
    const { store, joinCode, clueGiverId } = await setupActiveGame()
    const first = await store.guessWord(joinCode, clueGiverId)
    const firstWord = first.guessedThisTurn![0]
    expect(first.guessedThisTurn).toHaveLength(1)
    const second = await store.guessWord(joinCode, clueGiverId)
    expect(second.guessedThisTurn).toHaveLength(2)
    expect(second.guessedThisTurn![0]).toBe(firstWord)
  })

  it('advances currentWord to the next word after a guess', async () => {
    const { store, joinCode, clueGiverId, game: active } = await setupActiveGame()
    const wordBefore = active.currentWord
    const afterGuess = await store.guessWord(joinCode, clueGiverId)
    expect(afterGuess.currentWord).not.toBe(wordBefore)
  })

  it('transitions to between_rounds when hat empties and round is 1', async () => {
    const { store, joinCode, clueGiverId, game: active } = await setupActiveGame()
    // Guess all 20 words
    let current = active
    while (current.status === 'in_progress') {
      current = await store.guessWord(joinCode, clueGiverId)
    }
    expect(current.status).toBe('between_rounds')
    expect(current.currentWord).toBeUndefined()
    expect(current.turnPhase).toBeUndefined()
  })

  it('transitions to between_rounds when hat empties and round is 2', async () => {
    const { store, joinCode, clueGiverId, game: active } = await setupActiveGame()
    store['games'].get(joinCode)!.round = 2
    let current = active
    while (current.status === 'in_progress') {
      current = await store.guessWord(joinCode, clueGiverId)
    }
    expect(current.status).toBe('between_rounds')
    expect(current.currentWord).toBeUndefined()
    expect(current.turnPhase).toBeUndefined()
  })

  it('transitions to finished when hat empties and round is 3', async () => {
    const { store, joinCode, clueGiverId, game: active } = await setupActiveGame()
    store['games'].get(joinCode)!.round = 3
    let current = active
    while (current.status === 'in_progress') {
      current = await store.guessWord(joinCode, clueGiverId)
    }
    expect(current.status).toBe('finished')
    expect(current.currentWord).toBeUndefined()
    expect(current.turnPhase).toBeUndefined()
    expect(current.currentClueGiverId).toBeUndefined()
  })

  it('throws TURN_NOT_ALLOWED after status becomes between_rounds', async () => {
    const { store, joinCode, clueGiverId, game: active } = await setupActiveGame()
    let current = active
    while (current.status === 'in_progress') {
      current = await store.guessWord(joinCode, clueGiverId)
    }
    await expect(store.guessWord(joinCode, clueGiverId)).rejects.toMatchObject({ code: 'TURN_NOT_ALLOWED' })
  })

  it('broadcasts the updated game', async () => {
    const { store, joinCode, clueGiverId } = await setupActiveGame()
    const updates: GameSnapshot[] = []
    store.subscribe(joinCode, (g) => updates.push(g))
    await store.guessWord(joinCode, clueGiverId)
    expect(updates).toHaveLength(1)
    expect(updates[0].guessedThisTurn).toHaveLength(1)
  })

  it('throws FORBIDDEN when caller is not the clue giver', async () => {
    const { store, joinCode, clueGiverId, game } = await setupActiveGame()
    const other = game.players.find((p) => p.id !== clueGiverId)!
    await expect(store.guessWord(joinCode, other.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('throws TURN_NOT_ACTIVE when turnPhase is ready', async () => {
    const { store, joinCode, game: started } = await setupStartedGame()
    const clueGiverId = started.currentClueGiverId!
    await expect(store.guessWord(joinCode, clueGiverId)).rejects.toMatchObject({ code: 'TURN_NOT_ACTIVE' })
  })
})

describe('skipWord', () => {
  it('advances to a non-skipped word; skipped word does not reappear while others remain', async () => {
    const { store, joinCode, clueGiverId, game: active } = await setupActiveGame()
    const skippedWord = active.currentWord
    const afterSkip = await store.skipWord(joinCode, clueGiverId)
    expect(afterSkip.currentWord).not.toBe(skippedWord)
    // Skip several more times; the original skipped word must not reappear
    let current = afterSkip
    for (let i = 0; i < 5 && store['games'].get(joinCode)!.hat!.size > 2; i++) {
      current = await store.skipWord(joinCode, clueGiverId)
      expect(current.currentWord).not.toBe(skippedWord)
    }
  })

  it('falls back to a previously-skipped word when all remaining words are skipped', async () => {
    const { store, joinCode, clueGiverId, game: active } = await setupActiveGame()
    const hatLength = store['games'].get(joinCode)!.hat!.size
    // Skip all words — after the first N-1 skips it must fall back to a previously-skipped word
    let current = active
    const wordsSeen = new Set<string>()
    for (let i = 0; i < hatLength; i++) {
      wordsSeen.add(current.currentWord!)
      current = await store.skipWord(joinCode, clueGiverId)
    }
    // After skipping all, currentWord must be one of the skipped words (fallback)
    expect(wordsSeen.has(current.currentWord!)).toBe(true)
  })

  it('when only one word remains and is skipped, currentWord stays and status stays in_progress', async () => {
    const { store, joinCode, clueGiverId } = await setupActiveGame()
    // Guess all but one word
    const getHatSize = () => store['games'].get(joinCode)!.hat!.size
    while (getHatSize() > 1) {
      await store.guessWord(joinCode, clueGiverId)
    }
    expect(getHatSize()).toBe(1)
    const lastWord = store['games'].get(joinCode)!.hat!.current?.text
    const afterSkip = await store.skipWord(joinCode, clueGiverId)
    expect(afterSkip.currentWord).toBe(lastWord)
    expect(afterSkip.status).toBe('in_progress')
  })

  it('broadcasts the updated game', async () => {
    const { store, joinCode, clueGiverId } = await setupActiveGame()
    const updates: GameSnapshot[] = []
    store.subscribe(joinCode, (g) => updates.push(g))
    await store.skipWord(joinCode, clueGiverId)
    expect(updates).toHaveLength(1)
  })

  it('throws FORBIDDEN when caller is not the clue giver', async () => {
    const { store, joinCode, clueGiverId, game } = await setupActiveGame()
    const other = game.players.find((p) => p.id !== clueGiverId)!
    await expect(store.skipWord(joinCode, other.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('throws TURN_NOT_ACTIVE when turnPhase is ready', async () => {
    const { store, joinCode, game: started } = await setupStartedGame()
    const clueGiverId = started.currentClueGiverId!
    await expect(store.skipWord(joinCode, clueGiverId)).rejects.toMatchObject({ code: 'TURN_NOT_ACTIVE' })
  })

  it('throws TURN_NOT_ALLOWED after round ends (status no longer in_progress)', async () => {
    const { store, joinCode, clueGiverId, game: active } = await setupActiveGame()
    let current = active
    while (current.status === 'in_progress') {
      current = await store.guessWord(joinCode, clueGiverId)
    }
    await expect(store.skipWord(joinCode, clueGiverId)).rejects.toMatchObject({ code: 'TURN_NOT_ALLOWED' })
  })
})

describe('readyTurn — turnStartedAt', () => {
  it('sets turnStartedAt to a valid ISO timestamp within 2 seconds of now', async () => {
    const { store, joinCode, game: started } = await setupStartedGame()
    const before = Date.now()
    const game = await store.readyTurn(joinCode, started.currentClueGiverId!)
    expect(typeof game.turnStartedAt).toBe('string')
    const parsed = Date.parse(game.turnStartedAt!)
    expect(parsed).not.toBeNaN()
    expect(Math.abs(Date.now() - parsed)).toBeLessThan(2000)
    expect(parsed).toBeGreaterThanOrEqual(before)
  })
})

describe('endTurn', () => {
  it('throws FORBIDDEN when caller is not the clue giver', async () => {
    const { store, joinCode, clueGiverId, game } = await setupActiveGame()
    const other = game.players.find((p) => p.id !== clueGiverId)!
    await expect(store.endTurn(joinCode, other.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('throws TURN_NOT_ACTIVE when turnPhase is ready (not yet started)', async () => {
    const { store, joinCode, game: started } = await setupStartedGame()
    await expect(store.endTurn(joinCode, started.currentClueGiverId!)).rejects.toMatchObject({ code: 'TURN_NOT_ACTIVE' })
  })

  it('rotates to the other team, picks first player on that team, and resets turn state', async () => {
    const { store, joinCode, clueGiverId, game: active } = await setupActiveGame()
    const startingTeam = active.activeTeam as 1 | 2
    const otherTeamPlayers = active.players.filter((p) => p.team !== startingTeam)

    const after = await store.endTurn(joinCode, clueGiverId)

    expect(after.activeTeam).toBe(startingTeam === 1 ? 2 : 1)
    expect(after.currentClueGiverId).toBe(otherTeamPlayers[0].id)
    expect(after.turnPhase).toBe('ready')
    expect(after.currentWord).toBeUndefined()
    expect(after.turnStartedAt).toBeUndefined()
    // endTurn must not drain the hat (only guessWord removes words)
    const hatAfter = store['games'].get(joinCode)!.hat!.size
    expect(hatAfter).toBeGreaterThan(0)
  })

  it('first endTurn assigns first player on the other team — verifies startGame seed is correct', async () => {
    const { store, joinCode, game: started } = await setupStartedGame()
    const clueGiverId = started.currentClueGiverId!
    const startingTeam = started.activeTeam as 1 | 2
    const otherTeamPlayers = started.players.filter((p) => p.team !== startingTeam)

    await store.readyTurn(joinCode, clueGiverId)
    const after = await store.endTurn(joinCode, clueGiverId)

    expect(after.currentClueGiverId).toBe(otherTeamPlayers[0].id)
  })

  it('rotates clue giver correctly through a full 4-turn cycle', async () => {
    const { store, joinCode, game: started } = await setupStartedGame()
    const clueGiverId = started.currentClueGiverId!
    const startingTeam = started.activeTeam as 1 | 2
    const startingTeamPlayers = started.players.filter((p) => p.team === startingTeam)
    const otherTeamPlayers = started.players.filter((p) => p.team !== startingTeam)

    // Verify initial clue giver is first player on starting team
    expect(clueGiverId).toBe(startingTeamPlayers[0].id)

    // Turn 1: starting team p[0] → endTurn → other team p[0]
    await store.readyTurn(joinCode, clueGiverId)
    const after1 = await store.endTurn(joinCode, clueGiverId)
    expect(after1.currentClueGiverId).toBe(otherTeamPlayers[0].id)

    // Turn 2: other team p[0] → endTurn → starting team p[1]
    await store.readyTurn(joinCode, otherTeamPlayers[0].id)
    const after2 = await store.endTurn(joinCode, otherTeamPlayers[0].id)
    expect(after2.currentClueGiverId).toBe(startingTeamPlayers[1].id)

    // Turn 3: starting team p[1] → endTurn → other team p[1]
    await store.readyTurn(joinCode, startingTeamPlayers[1].id)
    const after3 = await store.endTurn(joinCode, startingTeamPlayers[1].id)
    expect(after3.currentClueGiverId).toBe(otherTeamPlayers[1].id)

    // Turn 4: other team p[1] → endTurn → starting team p[0] (wraps back)
    await store.readyTurn(joinCode, otherTeamPlayers[1].id)
    const after4 = await store.endTurn(joinCode, otherTeamPlayers[1].id)
    expect(after4.currentClueGiverId).toBe(startingTeamPlayers[0].id)
  })

  it('broadcasts updated game to subscribers', async () => {
    const { store, joinCode, clueGiverId } = await setupActiveGame()
    const updates: GameSnapshot[] = []
    store.subscribe(joinCode, (g) => updates.push(g))
    await store.endTurn(joinCode, clueGiverId)
    expect(updates).toHaveLength(1)
    expect(updates[0].turnPhase).toBe('ready')
  })

  it('transitions to between_rounds when hat is empty (defensive guard) and round is 1', async () => {
    const { store, joinCode, clueGiverId } = await setupActiveGame()
    // Force-empty the hat — this state is not reachable via the public API
    ;(store['games'].get(joinCode)!.hat as any)._words = []

    const after = await store.endTurn(joinCode, clueGiverId)
    expect(after.status).toBe('between_rounds')
    expect(after.currentClueGiverId).toBeUndefined()
  })

  it('transitions to finished when hat is empty (defensive guard) and round is 3', async () => {
    const { store, joinCode, clueGiverId } = await setupActiveGame()
    const game = store['games'].get(joinCode)!
    ;(game.hat as any)._words = []
    game.round = 3

    const after = await store.endTurn(joinCode, clueGiverId)
    expect(after.status).toBe('finished')
    expect(after.currentClueGiverId).toBeUndefined()
  })
})

// Builds a game that has completed round 1 and is now in 'between_rounds'.
// Returns the store, joinCode, and the hostId for calling advanceRound.
async function setupBetweenRoundsGame() {
  const { store, joinCode } = await setupReadyGame()
  const started = await store.startGame(joinCode)
  const hostId = started.hostId!
  const clueGiverId = started.currentClueGiverId!
  await store.readyTurn(joinCode, clueGiverId)
  let current = started
  while (current.status === 'in_progress') {
    current = await store.guessWord(joinCode, clueGiverId)
  }
  return { store, joinCode, hostId }
}

describe('advanceRound', () => {
  it('throws NOT_FOUND when game does not exist', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    await expect(store.advanceRound('XXXXXX', 'p1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('throws FORBIDDEN when caller is not the host', async () => {
    const { store, joinCode, hostId } = await setupBetweenRoundsGame()
    const game = await store.getGameByJoinCode(joinCode)
    const nonHost = game!.players.find((p) => p.id !== hostId)!
    await expect(store.advanceRound(joinCode, nonHost.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('throws INVALID_STATE when status is not between_rounds', async () => {
    const { store, joinCode, game: started } = await setupStartedGame()
    const hostId = started.hostId!
    await expect(store.advanceRound(joinCode, hostId)).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })

  it('sets round to 3 and status to in_progress when advancing from round 2', async () => {
    const { store, joinCode, hostId } = await setupBetweenRoundsGame()
    store['games'].get(joinCode)!.round = 2
    const after = await store.advanceRound(joinCode, hostId)
    expect(after.round).toBe(3)
    expect(after.status).toBe('in_progress')
  })

  it('throws INVALID_STATE when round is already 3', async () => {
    const { store, joinCode, hostId } = await setupBetweenRoundsGame()
    store['games'].get(joinCode)!.round = 3
    await expect(store.advanceRound(joinCode, hostId)).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })

  it('sets round to 2 and status to in_progress', async () => {
    const { store, joinCode, hostId } = await setupBetweenRoundsGame()
    const after = await store.advanceRound(joinCode, hostId)
    expect(after.round).toBe(2)
    expect(after.status).toBe('in_progress')
  })

  it('refills the hat with the original word count', async () => {
    const { store, joinCode, hostId } = await setupBetweenRoundsGame()
    await store.advanceRound(joinCode, hostId)
    expect(store['games'].get(joinCode)!.hat!.size).toBe(20)
  })

  it('hat words after refill are shuffled (order differs from originalWords)', async () => {
    // Probabilistic test: with 20 words the chance of identical order is 1/20! ≈ 0
    const { store, joinCode, hostId } = await setupBetweenRoundsGame()
    const originalTexts = store['games'].get(joinCode)!.hat!.originalWords.map((w) => w.text).sort()
    await store.advanceRound(joinCode, hostId)
    const hatTexts = store['games'].get(joinCode)!.hat!.wordTexts().sort()
    expect(hatTexts).toEqual(originalTexts)
    expect(hatTexts).toHaveLength(originalTexts.length)
  })

  it('assigns first clue giver of new round from the OTHER team (strict alternation)', async () => {
    const { store, joinCode, hostId } = await setupBetweenRoundsGame()
    const game = store['games'].get(joinCode)!
    const teamThatEndedRound1 = game.activeTeam as 1 | 2
    const teamForRound2: 1 | 2 = teamThatEndedRound1 === 1 ? 2 : 1
    // Other team had no turns in round 1 — _lastClueGiverId is undefined → first player in join order
    const expectedClueGiver = game.roster.getByTeam(teamForRound2)[0]

    const after = await store.advanceRound(joinCode, hostId)
    expect(after.activeTeam).toBe(teamForRound2)
    expect(after.currentClueGiverId).toBe(expectedClueGiver.id)
  })

  it('flips activeTeam and assigns a player from the new team', async () => {
    const { store, joinCode, hostId } = await setupBetweenRoundsGame()
    const before = store['games'].get(joinCode)!
    const oldActiveTeam = before.activeTeam as 1 | 2
    const newActiveTeam: 1 | 2 = oldActiveTeam === 1 ? 2 : 1

    await store.advanceRound(joinCode, hostId)
    const after = store['games'].get(joinCode)!

    expect(after.activeTeam).toBe(newActiveTeam)
    const newTeamPlayers = after.roster.getByTeam(newActiveTeam)
    expect(newTeamPlayers.some((p) => p.id === after.currentClueGiverId)).toBe(true)
  })

  it('clears guessedThisTurn', async () => {
    const { store, joinCode, hostId } = await setupBetweenRoundsGame()
    const after = await store.advanceRound(joinCode, hostId)
    expect(after.guessedThisTurn).toEqual([])
  })

  it('sets turnPhase to ready', async () => {
    const { store, joinCode, hostId } = await setupBetweenRoundsGame()
    const after = await store.advanceRound(joinCode, hostId)
    expect(after.turnPhase).toBe('ready')
  })

  it('preserves scores from round 1', async () => {
    const { store, joinCode } = await setupReadyGame()
    const started = await store.startGame(joinCode)
    const hostId = started.hostId!
    const clueGiverId = started.currentClueGiverId!
    await store.readyTurn(joinCode, clueGiverId)
    // Guess all words to reach between_rounds
    let current = started
    while (current.status === 'in_progress') {
      current = await store.guessWord(joinCode, clueGiverId)
    }
    // Capture scores at the between_rounds boundary, then verify advanceRound preserves them
    const scoresAtBoundary = { ...current.scores! }
    const after = await store.advanceRound(joinCode, hostId)
    expect(after.scores).toEqual(scoresAtBoundary)
  })

  it('broadcasts updated game to subscribers with round 2 and status in_progress', async () => {
    const { store, joinCode, hostId } = await setupBetweenRoundsGame()
    const updates: GameSnapshot[] = []
    store.subscribe(joinCode, (g) => updates.push(g))
    await store.advanceRound(joinCode, hostId)
    expect(updates).toHaveLength(1)
    expect(updates[0].round).toBe(2)
    expect(updates[0].status).toBe('in_progress')
  })

  it('round 2 rotation: correct player sequence across multiple turns', async () => {
    // Round 1: only the starting clue giver goes (hat drained without endTurn)
    // Round 2 should: start with the OTHER team, continue round-robin without repeating
    const { store, joinCode, hostId } = await setupBetweenRoundsGame()
    const internal = store['games'].get(joinCode)!
    const startingTeam = internal.activeTeam as 1 | 2
    const otherTeam: 1 | 2 = startingTeam === 1 ? 2 : 1
    const startingTeamPlayers = internal.roster.getByTeam(startingTeam)
    const otherTeamPlayers = internal.roster.getByTeam(otherTeam)

    // Round 2 must start with the OTHER team (team alternation rule)
    const round2 = await store.advanceRound(joinCode, hostId)
    expect(round2.activeTeam).toBe(otherTeam)
    expect(round2.currentClueGiverId).toBe(otherTeamPlayers[0].id)

    // Turn 1 of R2: otherTeam[0] → startingTeam[1] (not [0] — Bug 2 regression)
    await store.readyTurn(joinCode, otherTeamPlayers[0].id)
    const r2t1 = await store.endTurn(joinCode, otherTeamPlayers[0].id)
    expect(r2t1.activeTeam).toBe(startingTeam)
    expect(r2t1.currentClueGiverId).toBe(startingTeamPlayers[1].id)

    // Turn 2 of R2: startingTeam[1] → otherTeam[1]
    await store.readyTurn(joinCode, startingTeamPlayers[1].id)
    const r2t2 = await store.endTurn(joinCode, startingTeamPlayers[1].id)
    expect(r2t2.activeTeam).toBe(otherTeam)
    expect(r2t2.currentClueGiverId).toBe(otherTeamPlayers[1].id)

    // Turn 3 of R2: otherTeam[1] → startingTeam[0] (wraps back to [0])
    await store.readyTurn(joinCode, otherTeamPlayers[1].id)
    const r2t3 = await store.endTurn(joinCode, otherTeamPlayers[1].id)
    expect(r2t3.activeTeam).toBe(startingTeam)
    expect(r2t3.currentClueGiverId).toBe(startingTeamPlayers[0].id)
  })

  it('cross-round rotation continues from mid-rotation state when round ended mid-turn', async () => {
    // Round 1: A[0] goes, then B[0] goes, then A[1] starts but round ends mid-turn.
    // Round 2 should: B[1], A[0], B[0], A[1], ...
    const { store, joinCode } = await setupReadyGame()
    const started = await store.startGame(joinCode)
    const hostId = started.hostId!
    const startingTeam = started.activeTeam as 1 | 2
    const otherTeam: 1 | 2 = startingTeam === 1 ? 2 : 1
    const startingTeamPlayers = started.players.filter((p) => p.team === startingTeam)
    const otherTeamPlayers = started.players.filter((p) => p.team === otherTeam)

    // R1 Turn 1: A[0]
    await store.readyTurn(joinCode, startingTeamPlayers[0].id)
    await store.endTurn(joinCode, startingTeamPlayers[0].id)
    // R1 Turn 2: B[0]
    await store.readyTurn(joinCode, otherTeamPlayers[0].id)
    await store.endTurn(joinCode, otherTeamPlayers[0].id)
    // R1 Turn 3: A[1] starts, then round ends mid-turn (simulate hat emptying)
    await store.readyTurn(joinCode, startingTeamPlayers[1].id)
    Object.assign(store['games'].get(joinCode)!, {
      status: 'between_rounds',
      currentClueGiverId: undefined,
      turnPhase: undefined,
      turnStartedAt: undefined,
    })

    // advanceRound: should flip to B, pick B[1] (next in B's rotation), advance to 0
    const round2 = await store.advanceRound(joinCode, hostId)
    expect(round2.activeTeam).toBe(otherTeam)
    expect(round2.currentClueGiverId).toBe(otherTeamPlayers[1].id)

    // R2 Turn 1: B[1] → A[0] (A's index wraps back to 0)
    await store.readyTurn(joinCode, otherTeamPlayers[1].id)
    const r2t1 = await store.endTurn(joinCode, otherTeamPlayers[1].id)
    expect(r2t1.activeTeam).toBe(startingTeam)
    expect(r2t1.currentClueGiverId).toBe(startingTeamPlayers[0].id)

    // R2 Turn 2: A[0] → B[0]
    await store.readyTurn(joinCode, startingTeamPlayers[0].id)
    const r2t2 = await store.endTurn(joinCode, startingTeamPlayers[0].id)
    expect(r2t2.activeTeam).toBe(otherTeam)
    expect(r2t2.currentClueGiverId).toBe(otherTeamPlayers[0].id)
  })
})

describe('updateSettings', () => {
  it('seeds settings from config at game creation', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const { game } = await store.createGameWithHost('Alice', 1)
    expect(game.settings.wordsPerPlayer).toBe(TEST_CONFIG.wordsPerPlayer)
    expect(game.settings.turnDurationSeconds).toBe(TEST_CONFIG.turnDurationSeconds)
  })

  it('throws NOT_FOUND for an unknown joinCode', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    await expect(store.updateSettings('XXXXXX', 'p1', { wordsPerPlayer: 3 }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('throws INVALID_STATE when game is not in lobby', async () => {
    const { store, joinCode, game } = await setupStartedGame()
    await expect(store.updateSettings(joinCode, game.hostId!, { wordsPerPlayer: 3 }))
      .rejects.toMatchObject({ code: 'INVALID_STATE' })
  })

  it('throws FORBIDDEN when caller is not the host', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const { game } = await store.createGameWithHost('Alice', 1)
    const nonHost = await store.joinGame(game.joinCode, 'Bob', 2)
    await expect(store.updateSettings(game.joinCode, nonHost.id, { wordsPerPlayer: 3 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('throws SETTINGS_CONFLICT when a player has more words than the new wordsPerPlayer', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const { game, player: host } = await store.createGameWithHost('Alice', 1)
    await store.addWord(game.joinCode, host.id, 'cat')
    await store.addWord(game.joinCode, host.id, 'dog')
    await store.addWord(game.joinCode, host.id, 'fish')
    await expect(store.updateSettings(game.joinCode, host.id, { wordsPerPlayer: 2 }))
      .rejects.toMatchObject({ code: 'SETTINGS_CONFLICT' })
  })

  it('updates wordsPerPlayer and notifies subscribers', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const { game, player: host } = await store.createGameWithHost('Alice', 1)
    const updates: GameSnapshot[] = []
    store.subscribe(game.joinCode, (g) => updates.push(g))
    const result = await store.updateSettings(game.joinCode, host.id, { wordsPerPlayer: 10 })
    expect(result.settings.wordsPerPlayer).toBe(10)
    expect(updates).toHaveLength(1)
    expect(updates[0].settings.wordsPerPlayer).toBe(10)
  })

  it('updates turnDurationSeconds independently', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const { game, player: host } = await store.createGameWithHost('Alice', 1)
    const result = await store.updateSettings(game.joinCode, host.id, { turnDurationSeconds: 120 })
    expect(result.settings.turnDurationSeconds).toBe(120)
    expect(result.settings.wordsPerPlayer).toBe(TEST_CONFIG.wordsPerPlayer)
  })
})

describe('clueGiverStats', () => {
  it('increments the clue giver count on each successful guess', async () => {
    const { store, joinCode, game } = await setupStartedGame()
    const clueGiverId = game.currentClueGiverId!
    await store.readyTurn(joinCode, clueGiverId)
    await store.guessWord(joinCode, clueGiverId)

    const internal = store['games'].get(joinCode)!
    expect(internal.roster.getById(clueGiverId)!.stats.clueGiverCount).toBe(1)

    await store.guessWord(joinCode, clueGiverId)
    expect(internal.roster.getById(clueGiverId)!.stats.clueGiverCount).toBe(2)
  })

  it('persists the count across endTurn — does not reset', async () => {
    const { store, joinCode, game } = await setupStartedGame()
    const clueGiverId = game.currentClueGiverId!
    await store.readyTurn(joinCode, clueGiverId)
    await store.guessWord(joinCode, clueGiverId)
    await store.guessWord(joinCode, clueGiverId)
    await store.endTurn(joinCode, clueGiverId)

    expect(store['games'].get(joinCode)!.roster.getById(clueGiverId)!.stats.clueGiverCount).toBe(2)
  })

  it('accumulates across multiple rounds — count from round 1 survives advanceRound', async () => {
    const { store, joinCode, game } = await setupStartedGame()
    const hostId = game.hostId!
    const clueGiverId = game.currentClueGiverId!

    await store.readyTurn(joinCode, clueGiverId)
    await store.guessWord(joinCode, clueGiverId)
    await store.guessWord(joinCode, clueGiverId)

    const gameBefore = store['games'].get(joinCode)!
    const r1Count = gameBefore.roster.getById(clueGiverId)!.stats.clueGiverCount
    expect(r1Count).toBe(2)

    // Force game into between_rounds state (simulates hat drain without calling endTurn)
    Object.assign(gameBefore, {
      status: 'between_rounds',
      currentClueGiverId: undefined,
      turnPhase: undefined,
      turnStartedAt: undefined,
    })

    await store.advanceRound(joinCode, hostId)

    expect(store['games'].get(joinCode)!.roster.getById(clueGiverId)!.stats.clueGiverCount).toBe(r1Count)
  })
})

describe('getGameWords — bestClueGiver', () => {
  it('returns null when no guesses have been made', async () => {
    const { store, joinCode } = await setupStartedGame()
    const stats = await store.getGameWords(joinCode)
    expect(stats.bestClueGiver).toBeNull()
  })

  it('returns the player with the most guesses as bestClueGiver', async () => {
    const { store, joinCode, game } = await setupStartedGame()
    const clueGiverId = game.currentClueGiverId!
    const clueGiverName = game.players.find((p) => p.id === clueGiverId)!.name

    await store.readyTurn(joinCode, clueGiverId)
    await store.guessWord(joinCode, clueGiverId)
    await store.guessWord(joinCode, clueGiverId)
    await store.guessWord(joinCode, clueGiverId)

    const stats = await store.getGameWords(joinCode)
    expect(stats.bestClueGiver).toEqual({ names: [clueGiverName], clueCount: 3 })
  })

  it('returns all tied players sorted alphabetically', async () => {
    const { store, joinCode, game } = await setupStartedGame()
    const firstClueGiverId = game.currentClueGiverId!

    await store.readyTurn(joinCode, firstClueGiverId)
    await store.guessWord(joinCode, firstClueGiverId)
    await store.endTurn(joinCode, firstClueGiverId)

    const afterFirst = await store.getGameByJoinCode(joinCode)
    const secondClueGiverId = afterFirst!.currentClueGiverId!
    await store.readyTurn(joinCode, secondClueGiverId)
    await store.guessWord(joinCode, secondClueGiverId)

    const stats = await store.getGameWords(joinCode)
    expect(stats.bestClueGiver!.clueCount).toBe(1)
    expect(stats.bestClueGiver!.names).toHaveLength(2)
    const names = stats.bestClueGiver!.names
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
  })

  it('ignores players with zero clueGiverCount — only active guessers appear in result', async () => {
    const { store, joinCode, game } = await setupStartedGame()
    const clueGiverId = game.currentClueGiverId!
    await store.readyTurn(joinCode, clueGiverId)
    await store.guessWord(joinCode, clueGiverId)

    const stats = await store.getGameWords(joinCode)
    // Only the one clue giver has guesses; all other players have clueGiverCount = 0
    expect(stats.bestClueGiver!.names).toHaveLength(1)
    expect(stats.bestClueGiver!.clueCount).toBe(1)
  })
})

describe('pickTeamNames', () => {
  it('returns two distinct names from the pool', () => {
    const result = pickTeamNames(['Alpha', 'Beta', 'Gamma'])
    expect(result.team1).not.toBe(result.team2)
    expect(['Alpha', 'Beta', 'Gamma']).toContain(result.team1)
    expect(['Alpha', 'Beta', 'Gamma']).toContain(result.team2)
  })

  it('falls back when pool has only one entry', () => {
    expect(pickTeamNames(['Solo'])).toEqual({ team1: 'Team 1', team2: 'Team 2' })
  })

  it('falls back when pool is empty', () => {
    expect(pickTeamNames([])).toEqual({ team1: 'Team 1', team2: 'Team 2' })
  })
})

describe('teamNames on createGame', () => {
  it('creates a game with two distinct team names from the injected pool', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG, ['Alpha', 'Beta', 'Gamma'])
    const game = await store.createGame()
    expect(game.teamNames.team1).not.toBe(game.teamNames.team2)
    expect(['Alpha', 'Beta', 'Gamma']).toContain(game.teamNames.team1)
    expect(['Alpha', 'Beta', 'Gamma']).toContain(game.teamNames.team2)
  })

  it('falls back to Team 1 / Team 2 when pool has fewer than 2 entries', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG, ['Solo'])
    const game = await store.createGame()
    expect(game.teamNames).toEqual({ team1: 'Team 1', team2: 'Team 2' })
  })

  it('uses provided teamNames instead of picking from the pool', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG, ['Alpha', 'Beta', 'Gamma'])
    const game = await store.createGame({ team1: 'Sharks', team2: 'Jets' })
    expect(game.teamNames).toEqual({ team1: 'Sharks', team2: 'Jets' })
  })
})

describe('getTeamNamePreview', () => {
  it('returns two distinct names from the pool', () => {
    const store = new InMemoryGameStore(TEST_CONFIG, ['Alpha', 'Beta', 'Gamma'])
    const result = store.getTeamNamePreview()
    expect(result.team1).not.toBe(result.team2)
    expect(['Alpha', 'Beta', 'Gamma']).toContain(result.team1)
    expect(['Alpha', 'Beta', 'Gamma']).toContain(result.team2)
  })

  it('falls back to Team 1 / Team 2 when pool has fewer than 2 entries', () => {
    const store = new InMemoryGameStore(TEST_CONFIG, ['Solo'])
    expect(store.getTeamNamePreview()).toEqual({ team1: 'Team 1', team2: 'Team 2' })
  })
})

describe('createGameWithHost — with teamNames', () => {
  it('uses provided teamNames when creating game with host', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG, ['Alpha', 'Beta'])
    const { game } = await store.createGameWithHost('Alice', 1, { team1: 'Sharks', team2: 'Jets' })
    expect(game.teamNames).toEqual({ team1: 'Sharks', team2: 'Jets' })
  })
})

describe('updateTeamName', () => {
  it('renames team 1 and broadcasts the change', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG, ['Alpha', 'Beta'])
    const { game, player: host } = await store.createGameWithHost('Alice', 1)
    const events: GameSnapshot[] = []
    store.subscribe(game.joinCode, (g) => events.push(g))

    const updated = await store.updateTeamName(game.joinCode, host.id, 1, 'Red Dragons')
    expect(updated.teamNames.team1).toBe('Red Dragons')
    expect(events.at(-1)?.teamNames.team1).toBe('Red Dragons')
  })

  it('renames team 2 and broadcasts the change', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG, ['Alpha', 'Beta'])
    const { game, player: host } = await store.createGameWithHost('Alice', 1)
    const events: GameSnapshot[] = []
    store.subscribe(game.joinCode, (g) => events.push(g))

    const updated = await store.updateTeamName(game.joinCode, host.id, 2, 'Blue Tigers')
    expect(updated.teamNames.team2).toBe('Blue Tigers')
    expect(events.at(-1)?.teamNames.team2).toBe('Blue Tigers')
  })

  it('throws FORBIDDEN when caller is not the host', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const { game } = await store.createGameWithHost('Alice', 1)
    const bob = await store.joinGame(game.joinCode, 'Bob', 2)
    await expect(store.updateTeamName(game.joinCode, bob.id, 2, 'New Name')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('throws INVALID_STATE when game is in progress', async () => {
    const { store, joinCode } = await setupReadyGame()
    const startedGame = await store.startGame(joinCode)
    const hostId = startedGame.hostId!
    await expect(store.updateTeamName(joinCode, hostId, 1, 'New Name')).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })

  it('throws TEAM_NAME_CONFLICT when name matches the other team (case-insensitive)', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG, ['Alpha', 'Beta'])
    const { game, player: host } = await store.createGameWithHost('Alice', 1)
    const otherName = game.teamNames.team2
    await expect(store.updateTeamName(game.joinCode, host.id, 1, otherName.toUpperCase())).rejects.toMatchObject({ code: 'TEAM_NAME_CONFLICT' })
  })

  it('throws VALIDATION for an empty name', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const { game, player: host } = await store.createGameWithHost('Alice', 1)
    await expect(store.updateTeamName(game.joinCode, host.id, 1, '   ')).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('throws VALIDATION for a name exceeding 20 characters', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    const { game, player: host } = await store.createGameWithHost('Alice', 1)
    await expect(store.updateTeamName(game.joinCode, host.id, 1, 'A'.repeat(21))).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('throws NOT_FOUND for an unknown join code', async () => {
    const store = new InMemoryGameStore(TEST_CONFIG)
    await expect(store.updateTeamName('XXXXXX', 'player1', 1, 'Test')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
