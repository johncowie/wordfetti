import cors from 'cors'
import express, { type NextFunction, type Request, type Response } from 'express'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import v8 from 'v8'
import { DEFAULT_GAME_CONFIG } from './config.js'
import { logger } from './logger.js'
import { createGamesRouter } from './routes/games.js'
import { InMemoryGameStore } from './store/InMemoryGameStore.js'
import { loadTeamNames } from './teamNames.js'

const app = express()
const store = new InMemoryGameStore(DEFAULT_GAME_CONFIG, loadTeamNames())

function roundDurationMs(durationMs: number): number {
  return Math.round(durationMs * 100) / 100
}

function bytesToMb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100
}

const corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:5173'
app.set('trust proxy', 1) // Trust first proxy (reverse proxy in Docker)
app.use(helmet())
app.use(cors({ origin: corsOrigin }))
app.use(express.json())
app.use((req: Request, res: Response, next: NextFunction) => {
  const startedAt = process.hrtime.bigint()

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
    const data = {
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: roundDurationMs(durationMs),
      ip: req.ip,
    }

    if (res.statusCode >= 500) {
      logger.error('Request failed', data)
      return
    }

    if (req.path.startsWith('/api') || req.path === '/health') {
      logger.info('Request handled', data)
      return
    }

    if (res.statusCode >= 400) {
      logger.warn('Request completed with client error', data)
    }
  })

  next()
})

const apiLimiter = rateLimit({ windowMs: 60_000, max: 500 })
app.use('/api', apiLimiter)
app.use('/api/games', createGamesRouter(store))

app.get('/health', (_req, res) => {
  const memoryUsage = process.memoryUsage()
  const heapLimit = v8.getHeapStatistics().heap_size_limit
  const heapUsedPercent = heapLimit > 0
    ? Math.round((memoryUsage.heapUsed / heapLimit) * 10_000) / 100
    : null
  const heapUsedOfAllocatedPercent = memoryUsage.heapTotal > 0
    ? Math.round((memoryUsage.heapUsed / memoryUsage.heapTotal) * 10_000) / 100
    : null

  res.json({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    memory: {
      rssMb: bytesToMb(memoryUsage.rss),
      heapUsedPercent,
      heapUsedOfAllocatedPercent,
    },
    store: store.getStats(),
  })
})

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

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled request error', {
    method: req.method,
    path: req.originalUrl,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  })

  if (res.headersSent) {
    return
  }

  res.status(500).json({ error: 'Internal server error' })
})

const PORT = process.env.PORT ?? 3000
const server = app.listen(Number(PORT), '0.0.0.0', () => {
  logger.info('Server listening', {
    port: Number(PORT),
    env: process.env.NODE_ENV,
    corsOrigin,
    ...store.getStats(),
  })
})

const statsLogger = setInterval(() => {
  const memoryUsage = process.memoryUsage()
  logger.info('Runtime stats', {
    uptimeSeconds: Math.round(process.uptime()),
    rss: memoryUsage.rss,
    heapUsed: memoryUsage.heapUsed,
    heapTotal: memoryUsage.heapTotal,
    ...store.getStats(),
  })
}, 15 * 60 * 1000)
statsLogger.unref()

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  })
})

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack })
})

function shutdown(signal: string): void {
  logger.info('Shutdown signal received', { signal })
  server.close((error) => {
    if (error) {
      logger.error('Server shutdown failed', { signal, error: error.message, stack: error.stack })
      process.exit(1)
    }

    logger.info('Server shutdown completed', { signal })
    process.exit(0)
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
