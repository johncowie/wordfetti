import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import http from 'http'
import type { AddressInfo } from 'net'
import { createGamesRouter } from './games.js'
import type { GameStore } from '../store/GameStore.js'
import type { Game } from '@wordfetti/shared'
import { AppError } from '../errors.js'

const DEFAULT_SETTINGS = { wordsPerPlayer: 5, turnDurationSeconds: 45 }
const DEFAULT_TEAM_NAMES = { team1: 'Team Alpha', team2: 'Team Beta' }

const mockStore = (overrides?: Partial<GameStore>): GameStore => ({
  createGame: async () => ({ id: 'test-id', joinCode: 'ABC123', status: 'lobby', players: [], settings: DEFAULT_SETTINGS, teamNames: DEFAULT_TEAM_NAMES } as Game),
  createGameWithHost: async () => ({
    game: { id: 'test-id', joinCode: 'ABC123', status: 'lobby', players: [], settings: DEFAULT_SETTINGS, teamNames: DEFAULT_TEAM_NAMES } as Game,
    player: { id: 'p1', name: 'Test', team: 1 as const, wordCount: 0 },
  }),
  getGameByJoinCode: async () => null,
  joinGame: async () => ({ id: 'p1', name: 'Test', team: 1 as const, wordCount: 0 }),
  subscribe: () => () => {},
  startGame: async () => ({ id: 'test-id', joinCode: 'ABC123', status: 'in_progress' as const, players: [], settings: DEFAULT_SETTINGS, teamNames: DEFAULT_TEAM_NAMES }),
  readyTurn: async () => ({ id: 'test-id', joinCode: 'ABC123', status: 'in_progress' as const, players: [], turnPhase: 'active' as const, currentWord: 'cat', settings: DEFAULT_SETTINGS, teamNames: DEFAULT_TEAM_NAMES }),
  guessWord: async () => ({ id: 'test-id', joinCode: 'ABC123', status: 'in_progress' as const, players: [], currentWord: 'dog', settings: DEFAULT_SETTINGS, teamNames: DEFAULT_TEAM_NAMES }),
  skipWord: async () => ({ id: 'test-id', joinCode: 'ABC123', status: 'in_progress' as const, players: [], currentWord: 'fish', settings: DEFAULT_SETTINGS, teamNames: DEFAULT_TEAM_NAMES }),
  endTurn: async () => ({ id: 'test-id', joinCode: 'ABC123', status: 'in_progress' as const, players: [], turnPhase: 'ready' as const, settings: DEFAULT_SETTINGS, teamNames: DEFAULT_TEAM_NAMES }),
  advanceRound: async () => ({
    id: 'test-id', joinCode: 'ABC123', status: 'in_progress' as const, round: 2,
    players: [], turnPhase: 'ready' as const,
    originalWords: [{ id: 'w1', text: 'apple' }],  // must be stripped by toPublicGame
    settings: DEFAULT_SETTINGS,
    teamNames: DEFAULT_TEAM_NAMES,
  } as any),
  addWord: async () => ({ id: 'w1', text: 'banana' }),
  getWords: async () => [],
  deleteWord: async () => undefined,
  getTeamNamePreview: vi.fn().mockReturnValue(DEFAULT_TEAM_NAMES),
  updateSettings: vi.fn(),
  updateTeamName: vi.fn(),
  ...overrides,
})

function buildApp(store: GameStore) {
  const app = express()
  app.use(express.json())
  app.use('/', createGamesRouter(store))
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'internal server error' })
  })
  return app
}

// Starts the app on a random port, runs fn(port), then closes the server.
// Used for SSE tests where supertest's .parse() types the response incorrectly.
function withServer(app: express.Application, fn: (port: number) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app)
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo
      fn(port).finally(() => server.close((err) => (err ? reject(err) : resolve())))
    })
  })
}

describe('POST /api/games', () => {
  it('returns 201 with a joinCode', async () => {
    const res = await request(buildApp(mockStore())).post('/')
    expect(res.status).toBe(201)
    expect(res.body).toHaveProperty('joinCode', 'ABC123')
  })

  it('returns 500 when the store throws', async () => {
    const failStore = mockStore({
      createGame: async () => {
        throw new Error('store error')
      },
    })
    const res = await request(buildApp(failStore)).post('/')
    expect(res.status).toBe(500)
  })
})

describe('POST /api/games — with host body', () => {
  it('returns 201 with joinCode and player when name+team provided', async () => {
    const res = await request(buildApp(mockStore()))
      .post('/')
      .send({ name: 'Alice', team: 1 })
    expect(res.status).toBe(201)
    expect(res.body).toHaveProperty('joinCode')
    expect(res.body.player).toMatchObject({ name: 'Test', team: 1 })
  })

  it('returns 400 when name is empty in host body', async () => {
    const res = await request(buildApp(mockStore())).post('/').send({ name: '', team: 1 })
    expect(res.status).toBe(400)
  })

  it('returns 400 when team is invalid in host body', async () => {
    const res = await request(buildApp(mockStore())).post('/').send({ name: 'Alice', team: 3 })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/games — with teamNames body', () => {
  it('passes teamNames to createGameWithHost when valid', async () => {
    const createGameWithHost = vi.fn().mockResolvedValue({
      game: { id: 'g1', joinCode: 'ABC123', status: 'lobby', players: [], settings: DEFAULT_SETTINGS, teamNames: { team1: 'Sharks', team2: 'Jets' } } as Game,
      player: { id: 'p1', name: 'Alice', team: 1 as const, wordCount: 0 },
    })
    const store = mockStore({ createGameWithHost })
    const res = await request(buildApp(store))
      .post('/')
      .send({ name: 'Alice', team: 1, teamNames: { team1: 'Sharks', team2: 'Jets' } })
    expect(res.status).toBe(201)
    expect(createGameWithHost).toHaveBeenCalledWith('Alice', 1, { team1: 'Sharks', team2: 'Jets' })
  })

  it('returns 400 when teamNames has a name exceeding 20 characters', async () => {
    const res = await request(buildApp(mockStore()))
      .post('/')
      .send({ name: 'Alice', team: 1, teamNames: { team1: 'A'.repeat(21), team2: 'Jets' } })
    expect(res.status).toBe(400)
  })

  it('returns 400 when both team names are identical (case-insensitive)', async () => {
    const res = await request(buildApp(mockStore()))
      .post('/')
      .send({ name: 'Alice', team: 1, teamNames: { team1: 'Sharks', team2: 'sharks' } })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/games/team-names', () => {
  it('returns random team name preview from the store', async () => {
    const store = mockStore({ getTeamNamePreview: vi.fn().mockReturnValue({ team1: 'Sharks', team2: 'Jets' }) })
    const res = await request(buildApp(store)).get('/team-names')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ team1: 'Sharks', team2: 'Jets' })
  })
})

describe('GET /api/games/:joinCode', () => {
  it('returns 200 with game data when game exists', async () => {
    const game = { id: 'g1', joinCode: 'ABC123', status: 'lobby' as const, players: [], settings: DEFAULT_SETTINGS, teamNames: DEFAULT_TEAM_NAMES }
    const store = mockStore({ getGameByJoinCode: async () => game })
    const res = await request(buildApp(store)).get('/ABC123')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ joinCode: 'ABC123', players: [] })
  })

  it('returns 404 when game is not found', async () => {
    const store = mockStore({ getGameByJoinCode: async () => null })
    const res = await request(buildApp(store)).get('/XXXXXX')
    expect(res.status).toBe(404)
  })

  it('normalises lowercase join code to uppercase', async () => {
    const game = { id: 'g1', joinCode: 'ABC123', status: 'lobby' as const, players: [], settings: DEFAULT_SETTINGS, teamNames: DEFAULT_TEAM_NAMES }
    const store = mockStore({ getGameByJoinCode: async () => game })
    const res = await request(buildApp(store)).get('/abc123')
    expect(res.status).toBe(200)
  })
})

describe('POST /api/games/:joinCode/players', () => {
  it('returns 201 with the new player', async () => {
    const player = { id: 'p1', name: 'Alice', team: 1 as const, wordCount: 0 }
    const store = mockStore({ joinGame: async () => player })
    const res = await request(buildApp(store))
      .post('/ABC123/players')
      .send({ name: 'Alice', team: 1 })
    expect(res.status).toBe(201)
    expect(res.body.player).toMatchObject({ name: 'Alice', team: 1 })
  })

  it('trims whitespace from name before storing', async () => {
    let receivedName = ''
    const store = mockStore({
      joinGame: async (_code, name) => { receivedName = name; return { id: 'p1', name, team: 1 as const, wordCount: 0 } },
    })
    await request(buildApp(store)).post('/ABC123/players').send({ name: '  Alice  ', team: 1 })
    expect(receivedName).toBe('Alice')
  })

  it('returns 400 when name is empty', async () => {
    const res = await request(buildApp(mockStore())).post('/ABC123/players').send({ name: '', team: 1 })
    expect(res.status).toBe(400)
  })

  it('accepts a name exactly 50 characters long', async () => {
    const res = await request(buildApp(mockStore()))
      .post('/ABC123/players')
      .send({ name: 'A'.repeat(50), team: 1 })
    expect(res.status).toBe(201)
  })

  it('returns 400 when name exceeds 50 characters', async () => {
    const res = await request(buildApp(mockStore()))
      .post('/ABC123/players')
      .send({ name: 'A'.repeat(51), team: 1 })
    expect(res.status).toBe(400)
  })

  it('returns 400 when team is invalid', async () => {
    const res = await request(buildApp(mockStore())).post('/ABC123/players').send({ name: 'Bob', team: 3 })
    expect(res.status).toBe(400)
  })

  it('normalises lowercase join code to uppercase', async () => {
    const res = await request(buildApp(mockStore()))
      .post('/abc123/players')
      .send({ name: 'Bob', team: 1 })
    expect(res.status).toBe(201)
  })

  it('returns 404 when join code is unknown', async () => {
    const store = mockStore({ joinGame: async () => { throw new AppError('NOT_FOUND', 'Game not found') } })
    const res = await request(buildApp(store)).post('/XXXXXX/players').send({ name: 'Bob', team: 1 })
    expect(res.status).toBe(404)
  })

  it('returns 409 when the game has already started', async () => {
    const store = mockStore({
      joinGame: async () => { throw new AppError('GAME_IN_PROGRESS', 'Game has already started') },
    })
    const res = await request(buildApp(store))
      .post('/ABC123/players')
      .send({ name: 'Alice', team: 1 })
    expect(res.status).toBe(409)
  })
})

describe('POST /api/games/:joinCode/start', () => {
  const hostId = 'host-player-id'
  const baseGame = {
    id: 'g1',
    joinCode: 'ABC123',
    status: 'lobby' as const,
    players: [
      { id: hostId, name: 'Alice', team: 1 as const, wordCount: 5 },
      { id: 'p2', name: 'Bob', team: 1 as const, wordCount: 5 },
      { id: 'p3', name: 'Carol', team: 2 as const, wordCount: 5 },
      { id: 'p4', name: 'Dave', team: 2 as const, wordCount: 5 },
    ],
    hostId,
    settings: DEFAULT_SETTINGS,
    teamNames: DEFAULT_TEAM_NAMES,
  }

  it('returns 404 when the game is not found', async () => {
    const store = mockStore({ getGameByJoinCode: async () => null })
    const res = await request(buildApp(store))
      .post('/ABC123/start')
      .send({ playerId: hostId })
    expect(res.status).toBe(404)
  })

  it('returns 403 when the caller is not the host', async () => {
    const store = mockStore({ getGameByJoinCode: async () => baseGame })
    const res = await request(buildApp(store))
      .post('/ABC123/start')
      .send({ playerId: 'not-the-host' })
    expect(res.status).toBe(403)
  })

  it('returns 403 when no playerId is provided', async () => {
    const store = mockStore({ getGameByJoinCode: async () => baseGame })
    const res = await request(buildApp(store)).post('/ABC123/start').send({})
    expect(res.status).toBe(403)
  })

  it('returns 422 when a team has fewer than 2 players', async () => {
    const shortGame = {
      ...baseGame,
      players: [
        { id: hostId, name: 'Alice', team: 1 as const, wordCount: 0 },
        { id: 'p3', name: 'Carol', team: 2 as const, wordCount: 0 },
      ],
    }
    const store = mockStore({ getGameByJoinCode: async () => shortGame })
    const res = await request(buildApp(store))
      .post('/ABC123/start')
      .send({ playerId: hostId })
    expect(res.status).toBe(422)
  })

  it('returns 422 when not all players have submitted their words', async () => {
    const pendingGame = {
      ...baseGame,
      players: [
        { id: hostId, name: 'Alice', team: 1 as const, wordCount: 5 },
        { id: 'p2',   name: 'Bob',   team: 1 as const, wordCount: 3 },
        { id: 'p3',   name: 'Carol', team: 2 as const, wordCount: 5 },
        { id: 'p4',   name: 'Dave',  team: 2 as const, wordCount: 5 },
      ],
    }
    const store = mockStore({ getGameByJoinCode: async () => pendingGame })
    const res = await request(buildApp(store))
      .post('/ABC123/start')
      .send({ playerId: hostId })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/submit their words/)
  })

  it('returns 200 with the updated game when valid', async () => {
    const started = { ...baseGame, status: 'in_progress' as const }
    const store = mockStore({
      getGameByJoinCode: async () => baseGame,
      startGame: async () => started,
    })
    const res = await request(buildApp(store))
      .post('/ABC123/start')
      .send({ playerId: hostId })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('in_progress')
  })
})

// SSE tests require careful stream handling: the endpoint never terminates the
// connection server-side, so tests must destroy the response after receiving
// the data they need in order to avoid hanging the test runner.
describe('GET /api/games/:joinCode/events', () => {
  it('returns 404 for an unknown join code', async () => {
    // Short-lived non-streaming response — no special handling needed
    const store = mockStore({ getGameByJoinCode: async () => null })
    const res = await request(buildApp(store)).get('/XXXXXX/events')
    expect(res.status).toBe(404)
  })

  it('returns text/event-stream content type for a known join code', async () => {
    const game = { id: 'g1', joinCode: 'ABC123', status: 'lobby' as const, players: [], settings: DEFAULT_SETTINGS, teamNames: DEFAULT_TEAM_NAMES }
    const store = mockStore({ getGameByJoinCode: async () => game })
    await withServer(buildApp(store), (port) =>
      new Promise<void>((resolve, reject) => {
        const req = http.get(`http://localhost:${port}/ABC123/events`, (res) => {
          expect(res.headers['content-type']).toMatch(/text\/event-stream/)
          req.destroy()
          resolve()
        })
        req.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code !== 'ECONNRESET') reject(err)
        })
      })
    )
  })

  it('sends the current game state as the first data line', async () => {
    const game = { id: 'g1', joinCode: 'ABC123', status: 'lobby' as const, players: [], settings: DEFAULT_SETTINGS, teamNames: DEFAULT_TEAM_NAMES }
    const store = mockStore({ getGameByJoinCode: async () => game })
    await withServer(buildApp(store), (port) =>
      new Promise<void>((resolve, reject) => {
        const req = http.get(`http://localhost:${port}/ABC123/events`, (res) => {
          let buffer = ''
          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString()
            // Destroy after receiving the first complete SSE event (ends with \n\n)
            if (buffer.includes('\n\n')) {
              req.destroy()
              expect(buffer).toContain(`data: ${JSON.stringify(game)}`)
              resolve()
            }
          })
        })
        req.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code !== 'ECONNRESET') reject(err)
        })
      })
    )
  })

  it('calls the unsubscribe function when the connection closes', async () => {
    const game = { id: 'g1', joinCode: 'ABC123', status: 'lobby' as const, players: [], settings: DEFAULT_SETTINGS, teamNames: DEFAULT_TEAM_NAMES }
    // The server-side req.on('close') fires asynchronously after the client destroys
    // the socket. Use a Promise so we wait for it rather than checking immediately.
    let resolveUnsubscribed!: () => void
    const unsubscribed = new Promise<void>((resolve) => { resolveUnsubscribed = resolve })
    const unsubscribe = vi.fn(resolveUnsubscribed)
    const store = mockStore({
      getGameByJoinCode: async () => game,
      subscribe: () => unsubscribe,
    })
    await withServer(buildApp(store), (port) => {
      const req = http.get(`http://localhost:${port}/ABC123/events`, (res) => {
        res.on('data', () => req.destroy())
      })
      req.on('error', () => {})
      return unsubscribed
    })
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})

describe('POST /api/games/:joinCode/words', () => {
  it('returns 201 with the new word', async () => {
    const res = await request(buildApp(mockStore()))
      .post('/ABC123/words')
      .send({ playerId: 'p1', text: 'banana' })
    expect(res.status).toBe(201)
    expect(res.body.word).toMatchObject({ id: 'w1', text: 'banana' })
  })

  it('returns 400 when playerId is missing', async () => {
    const res = await request(buildApp(mockStore()))
      .post('/ABC123/words')
      .send({ text: 'banana' })
    expect(res.status).toBe(400)
  })

  it('returns 400 when text is empty', async () => {
    const res = await request(buildApp(mockStore()))
      .post('/ABC123/words')
      .send({ playerId: 'p1', text: '' })
    expect(res.status).toBe(400)
  })

  it('accepts a word exactly 50 characters long', async () => {
    const res = await request(buildApp(mockStore()))
      .post('/ABC123/words')
      .send({ playerId: 'p1', text: 'A'.repeat(50) })
    expect(res.status).toBe(201)
  })

  it('returns 400 when text exceeds 50 characters', async () => {
    const res = await request(buildApp(mockStore()))
      .post('/ABC123/words')
      .send({ playerId: 'p1', text: 'A'.repeat(51) })
    expect(res.status).toBe(400)
  })

  it('returns 403 when store throws FORBIDDEN', async () => {
    const store = mockStore({ addWord: async () => { throw new AppError('FORBIDDEN', 'Player not in game') } })
    const res = await request(buildApp(store)).post('/ABC123/words').send({ playerId: 'p1', text: 'banana' })
    expect(res.status).toBe(403)
  })

  it('returns 404 when store throws NOT_FOUND', async () => {
    const store = mockStore({ addWord: async () => { throw new AppError('NOT_FOUND', 'Game not found') } })
    const res = await request(buildApp(store)).post('/ABC123/words').send({ playerId: 'p1', text: 'banana' })
    expect(res.status).toBe(404)
  })

  it('returns 409 when store throws WORD_LIMIT_REACHED', async () => {
    const store = mockStore({ addWord: async () => { throw new AppError('WORD_LIMIT_REACHED', 'Limit reached') } })
    const res = await request(buildApp(store)).post('/ABC123/words').send({ playerId: 'p1', text: 'banana' })
    expect(res.status).toBe(409)
  })

  it('returns 422 when store throws GAME_NOT_IN_LOBBY', async () => {
    const store = mockStore({ addWord: async () => { throw new AppError('GAME_NOT_IN_LOBBY', 'Not in lobby') } })
    const res = await request(buildApp(store)).post('/ABC123/words').send({ playerId: 'p1', text: 'banana' })
    expect(res.status).toBe(422)
  })
})

describe('DELETE /api/games/:joinCode/words/:wordId', () => {
  it('returns 204 on success', async () => {
    const res = await request(buildApp(mockStore()))
      .delete('/ABC123/words/w1')
      .send({ playerId: 'p1' })
    expect(res.status).toBe(204)
  })

  it('returns 400 when playerId is missing', async () => {
    const res = await request(buildApp(mockStore())).delete('/ABC123/words/w1').send({})
    expect(res.status).toBe(400)
  })

  it('returns 403 when store throws FORBIDDEN', async () => {
    const store = mockStore({ deleteWord: async () => { throw new AppError('FORBIDDEN', 'Player not in game') } })
    const res = await request(buildApp(store)).delete('/ABC123/words/w1').send({ playerId: 'p1' })
    expect(res.status).toBe(403)
  })

  it('returns 404 when store throws NOT_FOUND', async () => {
    const store = mockStore({ deleteWord: async () => { throw new AppError('NOT_FOUND', 'Word not found') } })
    const res = await request(buildApp(store)).delete('/ABC123/words/w1').send({ playerId: 'p1' })
    expect(res.status).toBe(404)
  })

  it('returns 422 when store throws GAME_NOT_IN_LOBBY', async () => {
    const store = mockStore({ deleteWord: async () => { throw new AppError('GAME_NOT_IN_LOBBY', 'Not in lobby') } })
    const res = await request(buildApp(store)).delete('/ABC123/words/w1').send({ playerId: 'p1' })
    expect(res.status).toBe(422)
  })
})

describe('POST /api/games/:joinCode/ready', () => {
  it('returns 200 with updated game', async () => {
    const res = await request(buildApp(mockStore()))
      .post('/ABC123/ready')
      .send({ playerId: 'p1' })
    expect(res.status).toBe(200)
    expect(res.body.turnPhase).toBe('active')
    expect(res.body.currentWord).toBe('cat')
  })

  it('response body does not contain hat, skippedThisTurn, or currentWordId', async () => {
    const store = mockStore({
      readyTurn: async () => ({
        id: 'test-id', joinCode: 'ABC123', status: 'in_progress' as const, players: [], settings: DEFAULT_SETTINGS, teamNames: DEFAULT_TEAM_NAMES,
        hat: [{ id: 'w1', text: 'cat' }], skippedThisTurn: [], currentWordId: 'w1',
      } as Game & { hat: unknown; skippedThisTurn: unknown; currentWordId: unknown }),
    })
    const res = await request(buildApp(store)).post('/ABC123/ready').send({ playerId: 'p1' })
    expect(res.body).not.toHaveProperty('hat')
    expect(res.body).not.toHaveProperty('skippedThisTurn')
    expect(res.body).not.toHaveProperty('currentWordId')
  })

  it('returns 400 when playerId is missing', async () => {
    const res = await request(buildApp(mockStore())).post('/ABC123/ready').send({})
    expect(res.status).toBe(400)
  })

  it('returns 404 when store throws NOT_FOUND', async () => {
    const store = mockStore({ readyTurn: async () => { throw new AppError('NOT_FOUND', 'Game not found') } })
    const res = await request(buildApp(store)).post('/ABC123/ready').send({ playerId: 'p1' })
    expect(res.status).toBe(404)
  })

  it('returns 403 when store throws FORBIDDEN', async () => {
    const store = mockStore({ readyTurn: async () => { throw new AppError('FORBIDDEN', 'Not clue giver') } })
    const res = await request(buildApp(store)).post('/ABC123/ready').send({ playerId: 'p1' })
    expect(res.status).toBe(403)
  })

  it('returns 422 when store throws TURN_ALREADY_ACTIVE', async () => {
    const store = mockStore({ readyTurn: async () => { throw new AppError('TURN_ALREADY_ACTIVE', 'Already active') } })
    const res = await request(buildApp(store)).post('/ABC123/ready').send({ playerId: 'p1' })
    expect(res.status).toBe(422)
  })

  it('returns 422 when store throws TURN_NOT_ALLOWED', async () => {
    const store = mockStore({ readyTurn: async () => { throw new AppError('TURN_NOT_ALLOWED', 'Not in progress') } })
    const res = await request(buildApp(store)).post('/ABC123/ready').send({ playerId: 'p1' })
    expect(res.status).toBe(422)
  })

  it('returns 422 when store throws HAT_EMPTY', async () => {
    const store = mockStore({ readyTurn: async () => { throw new AppError('HAT_EMPTY', 'Hat is empty') } })
    const res = await request(buildApp(store)).post('/ABC123/ready').send({ playerId: 'p1' })
    expect(res.status).toBe(422)
  })
})

describe('POST /api/games/:joinCode/guess', () => {
  it('returns 200 with updated game', async () => {
    const res = await request(buildApp(mockStore()))
      .post('/ABC123/guess')
      .send({ playerId: 'p1' })
    expect(res.status).toBe(200)
    expect(res.body.currentWord).toBe('dog')
  })

  it('response body does not contain hat, skippedThisTurn, or currentWordId', async () => {
    const store = mockStore({
      guessWord: async () => ({
        id: 'test-id', joinCode: 'ABC123', status: 'in_progress' as const, players: [], settings: DEFAULT_SETTINGS, teamNames: DEFAULT_TEAM_NAMES,
        hat: [{ id: 'w2', text: 'dog' }], skippedThisTurn: [], currentWordId: 'w2',
      } as Game & { hat: unknown; skippedThisTurn: unknown; currentWordId: unknown }),
    })
    const res = await request(buildApp(store)).post('/ABC123/guess').send({ playerId: 'p1' })
    expect(res.body).not.toHaveProperty('hat')
    expect(res.body).not.toHaveProperty('skippedThisTurn')
    expect(res.body).not.toHaveProperty('currentWordId')
  })

  it('returns 400 when playerId is missing', async () => {
    const res = await request(buildApp(mockStore())).post('/ABC123/guess').send({})
    expect(res.status).toBe(400)
  })

  it('returns 404 when store throws NOT_FOUND', async () => {
    const store = mockStore({ guessWord: async () => { throw new AppError('NOT_FOUND', 'Game not found') } })
    const res = await request(buildApp(store)).post('/ABC123/guess').send({ playerId: 'p1' })
    expect(res.status).toBe(404)
  })

  it('returns 403 when store throws FORBIDDEN', async () => {
    const store = mockStore({ guessWord: async () => { throw new AppError('FORBIDDEN', 'Not clue giver') } })
    const res = await request(buildApp(store)).post('/ABC123/guess').send({ playerId: 'p1' })
    expect(res.status).toBe(403)
  })

  it('returns 422 when store throws TURN_NOT_ACTIVE', async () => {
    const store = mockStore({ guessWord: async () => { throw new AppError('TURN_NOT_ACTIVE', 'Not active') } })
    const res = await request(buildApp(store)).post('/ABC123/guess').send({ playerId: 'p1' })
    expect(res.status).toBe(422)
  })

  it('returns 422 when store throws TURN_NOT_ALLOWED', async () => {
    const store = mockStore({ guessWord: async () => { throw new AppError('TURN_NOT_ALLOWED', 'Not in progress') } })
    const res = await request(buildApp(store)).post('/ABC123/guess').send({ playerId: 'p1' })
    expect(res.status).toBe(422)
  })

  it('returns 500 when store throws INVALID_STATE', async () => {
    const store = mockStore({ guessWord: async () => { throw new AppError('INVALID_STATE', 'Bad state') } })
    const res = await request(buildApp(store)).post('/ABC123/guess').send({ playerId: 'p1' })
    expect(res.status).toBe(500)
  })

  it('returns between_rounds status and scores when hat empties in round 1 or 2', async () => {
    const store = mockStore({
      guessWord: async () => ({
        id: 'test-id', joinCode: 'ABC123', status: 'between_rounds' as const, players: [], settings: DEFAULT_SETTINGS, teamNames: DEFAULT_TEAM_NAMES,
        scores: { team1: 3, team2: 2 },
      }),
    })
    const res = await request(buildApp(store)).post('/ABC123/guess').send({ playerId: 'p1' })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('between_rounds')
    expect(res.body.scores).toEqual({ team1: 3, team2: 2 })
  })

  it('returns finished status and scores when hat empties in round 3', async () => {
    const store = mockStore({
      guessWord: async () => ({
        id: 'test-id', joinCode: 'ABC123', status: 'finished' as const, players: [], settings: DEFAULT_SETTINGS, teamNames: DEFAULT_TEAM_NAMES,
        scores: { team1: 5, team2: 4 },
      }),
    })
    const res = await request(buildApp(store)).post('/ABC123/guess').send({ playerId: 'p1' })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('finished')
    expect(res.body.scores).toEqual({ team1: 5, team2: 4 })
  })
})

describe('POST /api/games/:joinCode/skip', () => {
  it('returns 200 with updated game', async () => {
    const res = await request(buildApp(mockStore()))
      .post('/ABC123/skip')
      .send({ playerId: 'p1' })
    expect(res.status).toBe(200)
    expect(res.body.currentWord).toBe('fish')
  })

  it('response body does not contain hat, skippedThisTurn, or currentWordId', async () => {
    const store = mockStore({
      skipWord: async () => ({
        id: 'test-id', joinCode: 'ABC123', status: 'in_progress' as const, players: [], settings: DEFAULT_SETTINGS, teamNames: DEFAULT_TEAM_NAMES,
        hat: [{ id: 'w3', text: 'fish' }], skippedThisTurn: ['w1'], currentWordId: 'w3',
      } as Game & { hat: unknown; skippedThisTurn: unknown; currentWordId: unknown }),
    })
    const res = await request(buildApp(store)).post('/ABC123/skip').send({ playerId: 'p1' })
    expect(res.body).not.toHaveProperty('hat')
    expect(res.body).not.toHaveProperty('skippedThisTurn')
    expect(res.body).not.toHaveProperty('currentWordId')
  })

  it('returns 400 when playerId is missing', async () => {
    const res = await request(buildApp(mockStore())).post('/ABC123/skip').send({})
    expect(res.status).toBe(400)
  })

  it('returns 404 when store throws NOT_FOUND', async () => {
    const store = mockStore({ skipWord: async () => { throw new AppError('NOT_FOUND', 'Game not found') } })
    const res = await request(buildApp(store)).post('/ABC123/skip').send({ playerId: 'p1' })
    expect(res.status).toBe(404)
  })

  it('returns 403 when store throws FORBIDDEN', async () => {
    const store = mockStore({ skipWord: async () => { throw new AppError('FORBIDDEN', 'Not clue giver') } })
    const res = await request(buildApp(store)).post('/ABC123/skip').send({ playerId: 'p1' })
    expect(res.status).toBe(403)
  })

  it('returns 422 when store throws TURN_NOT_ACTIVE', async () => {
    const store = mockStore({ skipWord: async () => { throw new AppError('TURN_NOT_ACTIVE', 'Not active') } })
    const res = await request(buildApp(store)).post('/ABC123/skip').send({ playerId: 'p1' })
    expect(res.status).toBe(422)
  })

  it('returns 422 when store throws TURN_NOT_ALLOWED', async () => {
    const store = mockStore({ skipWord: async () => { throw new AppError('TURN_NOT_ALLOWED', 'Not in progress') } })
    const res = await request(buildApp(store)).post('/ABC123/skip').send({ playerId: 'p1' })
    expect(res.status).toBe(422)
  })

  it('returns 500 when store throws INVALID_STATE', async () => {
    const store = mockStore({ skipWord: async () => { throw new AppError('INVALID_STATE', 'Bad state') } })
    const res = await request(buildApp(store)).post('/ABC123/skip').send({ playerId: 'p1' })
    expect(res.status).toBe(500)
  })
})

describe('POST /api/games/:joinCode/end-turn', () => {
  it('returns 200 with updated game', async () => {
    const res = await request(buildApp(mockStore()))
      .post('/ABC123/end-turn')
      .send({ playerId: 'p1' })
    expect(res.status).toBe(200)
    expect(res.body.turnPhase).toBe('ready')
  })

  it('response body does not contain clueGiverIndices', async () => {
    const store = mockStore({
      endTurn: async () => ({
        id: 'test-id', joinCode: 'ABC123', status: 'in_progress' as const, players: [], settings: DEFAULT_SETTINGS, teamNames: DEFAULT_TEAM_NAMES,
        turnPhase: 'ready' as const,
        clueGiverIndices: { 1: 1, 2: 0 },
      } as Game & { clueGiverIndices: unknown }),
    })
    const res = await request(buildApp(store)).post('/ABC123/end-turn').send({ playerId: 'p1' })
    expect(res.status).toBe(200)
    expect(res.body).not.toHaveProperty('clueGiverIndices')
  })

  it('returns 400 when playerId is missing', async () => {
    const res = await request(buildApp(mockStore())).post('/ABC123/end-turn').send({})
    expect(res.status).toBe(400)
  })

  it('returns 404 when store throws NOT_FOUND', async () => {
    const store = mockStore({ endTurn: async () => { throw new AppError('NOT_FOUND', 'Game not found') } })
    const res = await request(buildApp(store)).post('/ABC123/end-turn').send({ playerId: 'p1' })
    expect(res.status).toBe(404)
  })

  it('returns 403 when store throws FORBIDDEN', async () => {
    const store = mockStore({ endTurn: async () => { throw new AppError('FORBIDDEN', 'Not clue giver') } })
    const res = await request(buildApp(store)).post('/ABC123/end-turn').send({ playerId: 'p1' })
    expect(res.status).toBe(403)
  })

  it('returns 422 when store throws TURN_NOT_ACTIVE', async () => {
    const store = mockStore({ endTurn: async () => { throw new AppError('TURN_NOT_ACTIVE', 'Not active') } })
    const res = await request(buildApp(store)).post('/ABC123/end-turn').send({ playerId: 'p1' })
    expect(res.status).toBe(422)
  })

  it('returns 422 when store throws TURN_NOT_ALLOWED', async () => {
    const store = mockStore({ endTurn: async () => { throw new AppError('TURN_NOT_ALLOWED', 'Not in progress') } })
    const res = await request(buildApp(store)).post('/ABC123/end-turn').send({ playerId: 'p1' })
    expect(res.status).toBe(422)
  })

  it('returns 500 when store throws INVALID_STATE', async () => {
    const store = mockStore({ endTurn: async () => { throw new AppError('INVALID_STATE', 'Bad state') } })
    const res = await request(buildApp(store)).post('/ABC123/end-turn').send({ playerId: 'p1' })
    expect(res.status).toBe(500)
  })

  it('returns between_rounds status and scores when the hat empties', async () => {
    const store = mockStore({
      endTurn: async () => ({
        id: 'test-id', joinCode: 'ABC123', status: 'between_rounds' as const, players: [], settings: DEFAULT_SETTINGS, teamNames: DEFAULT_TEAM_NAMES,
        scores: { team1: 2, team2: 3 },
      }),
    })
    const res = await request(buildApp(store)).post('/ABC123/end-turn').send({ playerId: 'p1' })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('between_rounds')
    expect(res.body.scores).toEqual({ team1: 2, team2: 3 })
  })
})

describe('GET /api/games/:joinCode/words', () => {
  it('returns 200 with the player\'s word list', async () => {
    const words = [{ id: 'w1', text: 'apple' }, { id: 'w2', text: 'banana' }]
    const store = mockStore({ getWords: async () => words })
    const res = await request(buildApp(store)).get('/ABC123/words?playerId=p1')
    expect(res.status).toBe(200)
    expect(res.body.words).toEqual(words)
  })

  it('returns 400 when playerId query param is missing', async () => {
    const res = await request(buildApp(mockStore())).get('/ABC123/words')
    expect(res.status).toBe(400)
  })

  it('returns 403 when store throws FORBIDDEN', async () => {
    const store = mockStore({ getWords: async () => { throw new AppError('FORBIDDEN', 'Player not in game') } })
    const res = await request(buildApp(store)).get('/ABC123/words?playerId=p1')
    expect(res.status).toBe(403)
  })

  it('returns 404 when store throws NOT_FOUND', async () => {
    const store = mockStore({ getWords: async () => { throw new AppError('NOT_FOUND', 'Game not found') } })
    const res = await request(buildApp(store)).get('/ABC123/words?playerId=p1')
    expect(res.status).toBe(404)
  })
})

describe('POST /api/games/:joinCode/advance-round', () => {
  it('returns 200 with updated game in_progress round 2', async () => {
    const res = await request(buildApp(mockStore()))
      .post('/ABC123/advance-round')
      .send({ playerId: 'p1' })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('in_progress')
    expect(res.body.round).toBe(2)
  })

  it('response body does not contain originalWords', async () => {
    const res = await request(buildApp(mockStore()))
      .post('/ABC123/advance-round')
      .send({ playerId: 'p1' })
    expect(res.status).toBe(200)
    expect(res.body).not.toHaveProperty('originalWords')
  })

  it('returns 400 when playerId is missing', async () => {
    const res = await request(buildApp(mockStore())).post('/ABC123/advance-round').send({})
    expect(res.status).toBe(400)
  })

  it('returns 404 when store throws NOT_FOUND', async () => {
    const store = mockStore({ advanceRound: async () => { throw new AppError('NOT_FOUND', 'Game not found') } })
    const res = await request(buildApp(store)).post('/ABC123/advance-round').send({ playerId: 'p1' })
    expect(res.status).toBe(404)
  })

  it('returns 403 when store throws FORBIDDEN', async () => {
    const store = mockStore({ advanceRound: async () => { throw new AppError('FORBIDDEN', 'Only the host can advance the round') } })
    const res = await request(buildApp(store)).post('/ABC123/advance-round').send({ playerId: 'p1' })
    expect(res.status).toBe(403)
  })

  it('returns 409 when store throws INVALID_STATE', async () => {
    const store = mockStore({ advanceRound: async () => { throw new AppError('INVALID_STATE', 'Game is not between rounds') } })
    const res = await request(buildApp(store)).post('/ABC123/advance-round').send({ playerId: 'p1' })
    expect(res.status).toBe(409)
  })

  it('returns 200 with round 3 in_progress when advancing from round 2 game', async () => {
    const store = mockStore({
      advanceRound: async () => ({
        id: 'test-id', joinCode: 'ABC123', status: 'in_progress' as const, round: 3 as const, players: [], settings: DEFAULT_SETTINGS, teamNames: DEFAULT_TEAM_NAMES,
      }),
    })
    const res = await request(buildApp(store)).post('/ABC123/advance-round').send({ playerId: 'p1' })
    expect(res.status).toBe(200)
    expect(res.body.round).toBe(3)
    expect(res.body.status).toBe('in_progress')
  })

  it('returns 409 when advance-round is called on a round 3 game', async () => {
    const store = mockStore({ advanceRound: async () => { throw new AppError('INVALID_STATE', 'Cannot advance beyond round 3') } })
    const res = await request(buildApp(store)).post('/ABC123/advance-round').send({ playerId: 'p1' })
    expect(res.status).toBe(409)
  })
})

describe('PATCH /api/games/:joinCode/settings', () => {
  const hostId = 'host-player-id'
  const updatedGame = { id: 'g1', joinCode: 'ABC123', status: 'lobby' as const, players: [], settings: DEFAULT_SETTINGS, hostId }

  it('returns 400 when playerId is missing', async () => {
    const res = await request(buildApp(mockStore())).patch('/ABC123/settings').send({ wordsPerPlayer: 5 })
    expect(res.status).toBe(400)
  })

  it('returns 400 when no setting fields are provided', async () => {
    const res = await request(buildApp(mockStore())).patch('/ABC123/settings').send({ playerId: hostId })
    expect(res.status).toBe(400)
  })

  it('returns 400 when wordsPerPlayer is 0', async () => {
    const res = await request(buildApp(mockStore())).patch('/ABC123/settings').send({ playerId: hostId, wordsPerPlayer: 0 })
    expect(res.status).toBe(400)
  })

  it('returns 400 when wordsPerPlayer is 21', async () => {
    const res = await request(buildApp(mockStore())).patch('/ABC123/settings').send({ playerId: hostId, wordsPerPlayer: 21 })
    expect(res.status).toBe(400)
  })

  it('returns 400 when wordsPerPlayer is a non-integer', async () => {
    const res = await request(buildApp(mockStore())).patch('/ABC123/settings').send({ playerId: hostId, wordsPerPlayer: 1.5 })
    expect(res.status).toBe(400)
  })

  it('returns 400 when turnDurationSeconds is 4', async () => {
    const res = await request(buildApp(mockStore())).patch('/ABC123/settings').send({ playerId: hostId, turnDurationSeconds: 4 })
    expect(res.status).toBe(400)
  })

  it('returns 400 when turnDurationSeconds is 601', async () => {
    const res = await request(buildApp(mockStore())).patch('/ABC123/settings').send({ playerId: hostId, turnDurationSeconds: 601 })
    expect(res.status).toBe(400)
  })

  it('returns 400 when turnDurationSeconds is a non-integer', async () => {
    const res = await request(buildApp(mockStore())).patch('/ABC123/settings').send({ playerId: hostId, turnDurationSeconds: 0.5 })
    expect(res.status).toBe(400)
  })

  it('returns 403 when caller is not the host', async () => {
    const store = mockStore({ updateSettings: vi.fn().mockRejectedValue(new AppError('FORBIDDEN', 'Only the host')) })
    const res = await request(buildApp(store)).patch('/ABC123/settings').send({ playerId: 'not-host', wordsPerPlayer: 5 })
    expect(res.status).toBe(403)
  })

  it('returns 409 when game is not in lobby', async () => {
    const store = mockStore({ updateSettings: vi.fn().mockRejectedValue(new AppError('INVALID_STATE', 'Game already started')) })
    const res = await request(buildApp(store)).patch('/ABC123/settings').send({ playerId: hostId, wordsPerPlayer: 5 })
    expect(res.status).toBe(409)
  })

  it('returns 409 with error message when settings conflict with existing word counts', async () => {
    const msg = 'Cannot reduce to 2 — one or more players have already submitted more words'
    const store = mockStore({ updateSettings: vi.fn().mockRejectedValue(new AppError('SETTINGS_CONFLICT', msg)) })
    const res = await request(buildApp(store)).patch('/ABC123/settings').send({ playerId: hostId, wordsPerPlayer: 2 })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(msg)
  })

  it('returns 404 when join code is unknown', async () => {
    const store = mockStore({ updateSettings: vi.fn().mockRejectedValue(new AppError('NOT_FOUND', 'Game not found')) })
    const res = await request(buildApp(store)).patch('/XXXXXX/settings').send({ playerId: hostId, wordsPerPlayer: 5 })
    expect(res.status).toBe(404)
  })

  it('returns 200 with updated settings.wordsPerPlayer', async () => {
    const returned = { ...updatedGame, settings: { wordsPerPlayer: 5, turnDurationSeconds: 45 } }
    const store = mockStore({ updateSettings: vi.fn().mockResolvedValue(returned) })
    const res = await request(buildApp(store)).patch('/ABC123/settings').send({ playerId: hostId, wordsPerPlayer: 5 })
    expect(res.status).toBe(200)
    expect(res.body.settings.wordsPerPlayer).toBe(5)
  })

  it('returns 200 with updated settings.turnDurationSeconds', async () => {
    const returned = { ...updatedGame, settings: { wordsPerPlayer: 5, turnDurationSeconds: 60 } }
    const store = mockStore({ updateSettings: vi.fn().mockResolvedValue(returned) })
    const res = await request(buildApp(store)).patch('/ABC123/settings').send({ playerId: hostId, turnDurationSeconds: 60 })
    expect(res.status).toBe(200)
    expect(res.body.settings.turnDurationSeconds).toBe(60)
  })

  it('uses game.settings.wordsPerPlayer (not global config) for the all-words-submitted gate', async () => {
    const hostId2 = 'host-id-2'
    const game = {
      ...updatedGame,
      hostId: hostId2,
      settings: { wordsPerPlayer: 2, turnDurationSeconds: 45 },
      players: [
        { id: hostId2, name: 'Alice', team: 1 as const, wordCount: 2 },
        { id: 'p2', name: 'Bob', team: 1 as const, wordCount: 2 },
        { id: 'p3', name: 'Carol', team: 2 as const, wordCount: 2 },
        { id: 'p4', name: 'Dave', team: 2 as const, wordCount: 2 },
      ],
    }
    const started = { ...game, status: 'in_progress' as const }
    const store = mockStore({
      getGameByJoinCode: vi.fn().mockResolvedValue(game),
      startGame: vi.fn().mockResolvedValue(started),
    })
    const res = await request(buildApp(store)).post('/ABC123/start').send({ playerId: hostId2 })
    expect(res.status).toBe(200)
  })
})

describe('PATCH /api/games/:joinCode/team-name', () => {
  const hostId = 'host-player-id'
  const updatedGame: Game = {
    id: 'test-id', joinCode: 'ABC123', status: 'lobby', players: [],
    settings: DEFAULT_SETTINGS, teamNames: { team1: 'Red Dragons', team2: 'Team Beta' },
  }

  it('returns 200 with updated teamNames on success', async () => {
    const store = mockStore({ updateTeamName: vi.fn().mockResolvedValue(updatedGame) })
    const res = await request(buildApp(store)).patch('/ABC123/team-name').send({ playerId: hostId, team: 1, name: 'Red Dragons' })
    expect(res.status).toBe(200)
    expect(res.body.teamNames.team1).toBe('Red Dragons')
  })

  it('returns 400 when playerId is missing', async () => {
    const res = await request(buildApp(mockStore())).patch('/ABC123/team-name').send({ team: 1, name: 'Red Dragons' })
    expect(res.status).toBe(400)
  })

  it('returns 400 when team is invalid', async () => {
    const res = await request(buildApp(mockStore())).patch('/ABC123/team-name').send({ playerId: hostId, team: 3, name: 'Red Dragons' })
    expect(res.status).toBe(400)
  })

  it('returns 400 when name is missing', async () => {
    const res = await request(buildApp(mockStore())).patch('/ABC123/team-name').send({ playerId: hostId, team: 1 })
    expect(res.status).toBe(400)
  })

  it('returns 404 when store throws NOT_FOUND', async () => {
    const store = mockStore({ updateTeamName: vi.fn().mockRejectedValue(new AppError('NOT_FOUND', 'Game not found')) })
    const res = await request(buildApp(store)).patch('/ABC123/team-name').send({ playerId: hostId, team: 1, name: 'Red Dragons' })
    expect(res.status).toBe(404)
  })

  it('returns 403 when store throws FORBIDDEN', async () => {
    const store = mockStore({ updateTeamName: vi.fn().mockRejectedValue(new AppError('FORBIDDEN', 'Only the host can rename teams')) })
    const res = await request(buildApp(store)).patch('/ABC123/team-name').send({ playerId: 'not-host', team: 1, name: 'Red Dragons' })
    expect(res.status).toBe(403)
  })

  it('returns 409 when store throws INVALID_STATE', async () => {
    const store = mockStore({ updateTeamName: vi.fn().mockRejectedValue(new AppError('INVALID_STATE', 'lobby only')) })
    const res = await request(buildApp(store)).patch('/ABC123/team-name').send({ playerId: hostId, team: 1, name: 'Red Dragons' })
    expect(res.status).toBe(409)
  })

  it('returns 409 when store throws TEAM_NAME_CONFLICT', async () => {
    const store = mockStore({ updateTeamName: vi.fn().mockRejectedValue(new AppError('TEAM_NAME_CONFLICT', 'Both teams cannot have the same name')) })
    const res = await request(buildApp(store)).patch('/ABC123/team-name').send({ playerId: hostId, team: 1, name: 'Team Beta' })
    expect(res.status).toBe(409)
  })

  it('returns 400 when store throws VALIDATION', async () => {
    const store = mockStore({ updateTeamName: vi.fn().mockRejectedValue(new AppError('VALIDATION', 'Team name must be between 1 and 20 characters')) })
    const res = await request(buildApp(store)).patch('/ABC123/team-name').send({ playerId: hostId, team: 1, name: '' })
    expect(res.status).toBe(400)
  })
})
