import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { InMemoryGameStore } from './store/InMemoryGameStore.js'
import { createGamesRouter } from './routes/games.js'
import { DEFAULT_GAME_CONFIG } from './config.js'
import { loadTeamNames } from './teamNames.js'
import { logger } from './logger.js'

const app = express()
const store = new InMemoryGameStore(DEFAULT_GAME_CONFIG, loadTeamNames())

const corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:5173'
app.set('trust proxy', 1) // Trust first proxy (reverse proxy in Docker)
app.use(helmet())
app.use(cors({ origin: corsOrigin }))
app.use(express.json())

const apiLimiter = rateLimit({ windowMs: 60_000, max: 500 })
app.use('/api', apiLimiter)
app.use('/api/games', createGamesRouter(store))

app.get('/health', (_req, res) => res.sendStatus(200))

if (process.env.NODE_ENV === 'production') {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../../public')
  app.use((req, _res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api') && req.path !== '/health') {
      logger.info('Page loaded', { path: req.path, ip: req.ip })
    }
    next()
  })
  app.use(express.static(dir))
  app.get('*', (_req, res) => res.sendFile(join(dir, 'index.html')))
}

const PORT = process.env.PORT ?? 3000
app.listen(Number(PORT), '0.0.0.0', () => {
  logger.info('Server listening', { port: Number(PORT), env: process.env.NODE_ENV })
})
