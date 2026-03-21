import { Router } from 'express'
import type { GameStore } from '../store/GameStore.js'
import type { Team } from '@wordfetti/shared'
import { AppError } from '../errors.js'

function isValidTeam(value: unknown): value is Team {
  return value === 1 || value === 2
}

function isValidName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 50
}

export function createGamesRouter(store: GameStore): Router {
  const router = Router()

  // POST / — creates a game. If { name, team } are provided in the body,
  // atomically registers the host as the first player.
  router.post('/', async (req, res, next) => {
    try {
      const { name, team } = req.body ?? {}
      if (name !== undefined || team !== undefined) {
        // Host registration path
        if (!isValidName(name)) {
          return res.status(400).json({ error: 'Name must be between 1 and 50 characters' })
        }
        if (!isValidTeam(team)) {
          return res.status(400).json({ error: 'Team must be 1 or 2' })
        }
        const { game, player } = await store.createGameWithHost(name.trim(), team)
        res.set('Location', `/api/games/${game.joinCode}`)
        return res.status(201).json({ joinCode: game.joinCode, player })
      }
      // No-body path (kept for backward compatibility with tests)
      const game = await store.createGame()
      res.set('Location', `/api/games/${game.joinCode}`)
      res.status(201).json({ joinCode: game.joinCode })
    } catch (err) {
      next(err)
    }
  })

  // GET /:joinCode — fetch game state (players grouped by team)
  router.get('/:joinCode', async (req, res, next) => {
    try {
      const game = await store.getGameByJoinCode(req.params.joinCode.toUpperCase())
      if (!game) return res.status(404).json({ error: 'Game not found' })
      res.json(game)
    } catch (err) {
      next(err)
    }
  })

  // POST /:joinCode/players — join an existing game
  router.post('/:joinCode/players', async (req, res, next) => {
    try {
      const { name, team } = req.body
      if (!isValidName(name)) {
        return res.status(400).json({ error: 'Name must be between 1 and 50 characters' })
      }
      if (!isValidTeam(team)) {
        return res.status(400).json({ error: 'Team must be 1 or 2' })
      }
      const joinCode = req.params.joinCode.toUpperCase()
      const player = await store.joinGame(joinCode, name.trim(), team)
      res.status(201).json({ player })
    } catch (err: unknown) {
      if (err instanceof AppError && err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: 'Game not found' })
      }
      next(err)
    }
  })

  return router
}
