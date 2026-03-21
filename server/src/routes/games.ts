import { Router } from 'express'
import type { GameStore } from '../store/GameStore.js'

export function createGamesRouter(store: GameStore): Router {
  const router = Router()

  router.post('/', async (_req, res, next) => {
    try {
      const game = await store.createGame()
      res.set('Location', `/api/games/${game.joinCode}`)
      res.status(201).json({ joinCode: game.joinCode })
    } catch (err) {
      next(err)
    }
  })

  return router
}
