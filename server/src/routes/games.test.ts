import { describe, it, expect } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createGamesRouter } from './games.js'
import type { GameStore } from '../store/GameStore.js'
import type { Game } from '@wordfetti/shared'

const mockStore = (overrides?: Partial<GameStore>): GameStore => ({
  createGame: async () => ({ id: 'test-id', joinCode: 'ABC123', status: 'lobby' } as Game),
  getGameByJoinCode: async () => null,
  ...overrides,
})

function buildApp(store: GameStore) {
  const app = express()
  app.use(express.json())
  app.use('/', createGamesRouter(store))
  return app
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
    const app = buildApp(failStore)
    app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: 'internal server error' })
    })
    const res = await request(app).post('/')
    expect(res.status).toBe(500)
  })
})
