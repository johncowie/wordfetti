import { Router } from 'express'

export function createTimeRouter(): Router {
  const router = Router()

  router.get('/', (_req, res) => {
    res.set('Cache-Control', 'no-store')
    res.json({ now: Date.now() })
  })

  return router
}
