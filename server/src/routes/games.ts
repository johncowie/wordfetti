import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import type { Game, GameSettings } from '@wordfetti/shared'
import { type Team } from '@wordfetti/shared'
import type { GameStore } from '../store/GameStore.js'
import { AppError } from '../errors.js'
import { logger } from '../logger.js'

function toPublicGame(game: Game & { hat?: unknown; skippedThisTurn?: unknown; currentWordId?: unknown; clueGiverIndices?: unknown; originalWords?: unknown }) {
  const { hat: _hat, skippedThisTurn: _skipped, currentWordId: _id, clueGiverIndices: _ci, originalWords: _ow, ...publicGame } = game
  return publicGame
}

function isValidTeam(value: unknown): value is Team {
  return value === 1 || value === 2
}

function isValidName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 50
}

function isValidWordText(value: unknown): value is string {
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
        logger.info('Game created', { joinCode: game.joinCode, hasHost: true })
        res.set('Location', `/api/games/${game.joinCode}`)
        return res.status(201).json({ joinCode: game.joinCode, player })
      }
      // No-body path (kept for backward compatibility with tests)
      const game = await store.createGame()
      logger.info('Game created', { joinCode: game.joinCode, hasHost: false })
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
      res.json(toPublicGame(game))
    } catch (err) {
      next(err)
    }
  })

  // GET /:joinCode/events — SSE stream of game state updates
  router.get('/:joinCode/events', async (req, res, next) => {
    try {
      const joinCode = req.params.joinCode.toUpperCase()

      // Existence check before committing to SSE (can still return a normal 404)
      if (!await store.getGameByJoinCode(joinCode)) {
        return res.status(404).json({ error: 'Game not found' })
      }

      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders()

      logger.info('SSE client connected', { joinCode })

      // Subscribe BEFORE fetching the snapshot so any player join that occurs
      // in the gap between the two store calls is not silently missed.
      const unsubscribe = store.subscribe(joinCode, (updatedGame) => {
        res.write(`data: ${JSON.stringify(toPublicGame(updatedGame))}\n\n`)
      })

      // Fetch a fresh snapshot after subscribing; any concurrent join is now
      // either captured by the callback above or already in this snapshot.
      const snapshot = (await store.getGameByJoinCode(joinCode))!
      res.write(`data: ${JSON.stringify(toPublicGame(snapshot))}\n\n`)

      req.on('close', () => {
        unsubscribe()
        logger.info('SSE client disconnected', { joinCode })
      })
    } catch (err) {
      next(err)
    }
  })

  // POST /:joinCode/start — host starts the game
  router.post('/:joinCode/start', async (req, res, next) => {
    try {
      const joinCode = req.params.joinCode.toUpperCase()
      const { playerId } = req.body ?? {}

      const game = await store.getGameByJoinCode(joinCode)
      if (!game) return res.status(404).json({ error: 'Game not found' })
      if (game.hostId === undefined || game.hostId !== playerId) {
        return res.status(403).json({ error: 'Only the host can start the game' })
      }

      const team1 = game.players.filter((p) => p.team === 1)
      const team2 = game.players.filter((p) => p.team === 2)
      if (team1.length < 2 || team2.length < 2) {
        return res.status(422).json({ error: 'Both teams need at least 2 players to start' })
      }

      const allWordsSubmitted = game.players.every((p) => p.wordCount >= game.settings.wordsPerPlayer)
      if (!allWordsSubmitted) {
        return res.status(422).json({ error: 'All players must submit their words before the game can start' })
      }

      const updated = await store.startGame(joinCode)
      logger.info('Game started', { joinCode, playerCount: game.players.length, totalWords: game.players.reduce((sum, p) => sum + p.wordCount, 0) })
      res.json(toPublicGame(updated))
    } catch (err) {
      next(err)
    }
  })

  // POST /:joinCode/words — submit a word for the current player
  router.post('/:joinCode/words', async (req, res, next) => {
    try {
      const joinCode = req.params.joinCode.toUpperCase()
      const { playerId, text } = req.body ?? {}
      if (typeof playerId !== 'string' || !playerId) {
        return res.status(400).json({ error: 'playerId is required' })
      }
      if (!isValidWordText(text)) {
        return res.status(400).json({ error: 'Word must be between 1 and 50 characters' })
      }
      const word = await store.addWord(joinCode, playerId, text)
      return res.status(201).json({ word })
    } catch (err: unknown) {
      if (err instanceof AppError && err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: 'Game not found' })
      }
      if (err instanceof AppError && err.code === 'FORBIDDEN') {
        return res.status(403).json({ error: 'Player not in game' })
      }
      if (err instanceof AppError && err.code === 'WORD_LIMIT_REACHED') {
        return res.status(409).json({ error: err.message })
      }
      if (err instanceof AppError && err.code === 'GAME_NOT_IN_LOBBY') {
        return res.status(422).json({ error: 'Words can only be submitted while game is in lobby' })
      }
      next(err)
    }
  })

  // GET /:joinCode/words — list a player's submitted words
  router.get('/:joinCode/words', async (req, res, next) => {
    try {
      const joinCode = req.params.joinCode.toUpperCase()
      const { playerId } = req.query
      if (typeof playerId !== 'string') {
        return res.status(400).json({ error: 'playerId query param is required' })
      }
      const words = await store.getWords(joinCode, playerId)
      return res.json({ words })
    } catch (err: unknown) {
      if (err instanceof AppError && err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: 'Game not found' })
      }
      if (err instanceof AppError && err.code === 'FORBIDDEN') {
        return res.status(403).json({ error: 'Player not in game' })
      }
      next(err)
    }
  })

  // DELETE /:joinCode/words/:wordId — remove a player's submitted word
  router.delete('/:joinCode/words/:wordId', async (req, res, next) => {
    const joinCode = req.params.joinCode.toUpperCase()
    const { wordId } = req.params
    const { playerId } = req.body
    if (!playerId || typeof playerId !== 'string') {
      return res.status(400).json({ error: 'playerId is required' })
    }
    try {
      await store.deleteWord(joinCode, playerId, wordId)
      return res.status(204).send()
    } catch (err: unknown) {
      if (err instanceof AppError && err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message })
      if (err instanceof AppError && err.code === 'FORBIDDEN') return res.status(403).json({ error: 'Player not in game' })
      if (err instanceof AppError && err.code === 'GAME_NOT_IN_LOBBY') return res.status(422).json({ error: 'Words can only be deleted while game is in lobby' })
      return next(err)
    }
  })

  // POST /:joinCode/ready — clue giver starts their turn
  router.post('/:joinCode/ready', async (req, res, next) => {
    try {
      const joinCode = req.params.joinCode.toUpperCase()
      const { playerId } = req.body ?? {}
      if (typeof playerId !== 'string' || !playerId) {
        return res.status(400).json({ error: 'playerId is required' })
      }
      const updated = await store.readyTurn(joinCode, playerId)
      return res.json(toPublicGame(updated))
    } catch (err: unknown) {
      if (err instanceof AppError && err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message })
      if (err instanceof AppError && err.code === 'FORBIDDEN') {
        logger.warn('Forbidden action attempted', { route: 'ready', joinCode: req.params.joinCode.toUpperCase(), error: err.message })
        return res.status(403).json({ error: err.message })
      }
      if (err instanceof AppError && err.code === 'TURN_ALREADY_ACTIVE') return res.status(422).json({ error: err.message })
      if (err instanceof AppError && err.code === 'TURN_NOT_ALLOWED') return res.status(422).json({ error: err.message })
      if (err instanceof AppError && err.code === 'HAT_EMPTY') return res.status(422).json({ error: err.message })
      logger.error('Unexpected error in route', { route: 'ready', error: err instanceof Error ? err.message : String(err) })
      next(err)
    }
  })

  // POST /:joinCode/guess — clue giver marks current word as guessed
  router.post('/:joinCode/guess', async (req, res, next) => {
    try {
      const joinCode = req.params.joinCode.toUpperCase()
      const { playerId } = req.body ?? {}
      if (typeof playerId !== 'string' || !playerId) {
        return res.status(400).json({ error: 'playerId is required' })
      }
      const updated = await store.guessWord(joinCode, playerId)
      return res.json(toPublicGame(updated))
    } catch (err: unknown) {
      if (err instanceof AppError && err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message })
      if (err instanceof AppError && err.code === 'FORBIDDEN') {
        logger.warn('Forbidden action attempted', { route: 'guess', joinCode: req.params.joinCode.toUpperCase(), error: err.message })
        return res.status(403).json({ error: err.message })
      }
      if (err instanceof AppError && err.code === 'TURN_NOT_ACTIVE') return res.status(422).json({ error: err.message })
      if (err instanceof AppError && err.code === 'TURN_NOT_ALLOWED') return res.status(422).json({ error: err.message })
      if (err instanceof AppError && err.code === 'INVALID_STATE') {
        logger.warn('Invalid game state encountered', { route: 'guess', joinCode: req.params.joinCode.toUpperCase(), error: err.message })
        return res.status(500).json({ error: err.message })
      }
      logger.error('Unexpected error in route', { route: 'guess', error: err instanceof Error ? err.message : String(err) })
      next(err)
    }
  })

  // POST /:joinCode/skip — clue giver skips current word
  router.post('/:joinCode/skip', async (req, res, next) => {
    try {
      const joinCode = req.params.joinCode.toUpperCase()
      const { playerId } = req.body ?? {}
      if (typeof playerId !== 'string' || !playerId) {
        return res.status(400).json({ error: 'playerId is required' })
      }
      const updated = await store.skipWord(joinCode, playerId)
      return res.json(toPublicGame(updated))
    } catch (err: unknown) {
      if (err instanceof AppError && err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message })
      if (err instanceof AppError && err.code === 'FORBIDDEN') {
        logger.warn('Forbidden action attempted', { route: 'skip', joinCode: req.params.joinCode.toUpperCase(), error: err.message })
        return res.status(403).json({ error: err.message })
      }
      if (err instanceof AppError && err.code === 'TURN_NOT_ACTIVE') return res.status(422).json({ error: err.message })
      if (err instanceof AppError && err.code === 'TURN_NOT_ALLOWED') return res.status(422).json({ error: err.message })
      if (err instanceof AppError && err.code === 'INVALID_STATE') {
        logger.warn('Invalid game state encountered', { route: 'skip', joinCode: req.params.joinCode.toUpperCase(), error: err.message })
        return res.status(500).json({ error: err.message })
      }
      logger.error('Unexpected error in route', { route: 'skip', error: err instanceof Error ? err.message : String(err) })
      next(err)
    }
  })

  // POST /:joinCode/end-turn — clue giver ends their turn early (timer expired or manual)
  router.post('/:joinCode/end-turn', async (req, res, next) => {
    try {
      const joinCode = req.params.joinCode.toUpperCase()
      const { playerId } = req.body ?? {}
      if (typeof playerId !== 'string' || !playerId) {
        return res.status(400).json({ error: 'playerId is required' })
      }
      const updated = await store.endTurn(joinCode, playerId)
      return res.json(toPublicGame(updated))
    } catch (err: unknown) {
      if (err instanceof AppError && err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message })
      if (err instanceof AppError && err.code === 'FORBIDDEN') {
        logger.warn('Forbidden action attempted', { route: 'end-turn', joinCode: req.params.joinCode.toUpperCase(), error: err.message })
        return res.status(403).json({ error: err.message })
      }
      if (err instanceof AppError && err.code === 'TURN_NOT_ACTIVE') return res.status(422).json({ error: err.message })
      if (err instanceof AppError && err.code === 'TURN_NOT_ALLOWED') return res.status(422).json({ error: err.message })
      if (err instanceof AppError && err.code === 'INVALID_STATE') {
        logger.warn('Invalid game state encountered', { route: 'end-turn', joinCode: req.params.joinCode.toUpperCase(), error: err.message })
        return res.status(500).json({ error: err.message })
      }
      logger.error('Unexpected error in route', { route: 'end-turn', error: err instanceof Error ? err.message : String(err) })
      next(err)
    }
  })

  // POST /:joinCode/advance-round — host advances from between_rounds to next round
  router.post('/:joinCode/advance-round', async (req, res, next) => {
    try {
      const joinCode = req.params.joinCode.toUpperCase()
      const { playerId } = req.body ?? {}
      if (typeof playerId !== 'string' || !playerId) {
        return res.status(400).json({ error: 'playerId is required' })
      }
      const updated = await store.advanceRound(joinCode, playerId)
      return res.json(toPublicGame(updated))
    } catch (err: unknown) {
      if (err instanceof AppError && err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message })
      if (err instanceof AppError && err.code === 'FORBIDDEN') {
        logger.warn('Forbidden action attempted', { route: 'advance-round', joinCode: req.params.joinCode.toUpperCase(), error: err.message })
        return res.status(403).json({ error: err.message })
      }
      if (err instanceof AppError && err.code === 'INVALID_STATE') {
        // 409 Conflict: game exists but is in the wrong state for this operation (client timing error, not server fault)
        return res.status(409).json({ error: err.message })
      }
      logger.error('Unexpected error in route', { route: 'advance-round', error: err instanceof Error ? err.message : String(err) })
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
      logger.info('Player joined', { joinCode, name: name.trim(), team })
      res.status(201).json({ player })
    } catch (err: unknown) {
      if (err instanceof AppError && err.code === 'NOT_FOUND') {
        return res.status(404).json({ error: 'Game not found' })
      }
      if (err instanceof AppError && err.code === 'GAME_IN_PROGRESS') {
        return res.status(409).json({ error: 'This game has already started' })
      }
      next(err)
    }
  })

  // Per-route limiter: settings changes broadcast to all connected clients via SSE.
  // 100 req per 30s is generous for legitimate use (a human can barely trigger 10)
  // but keeps the recovery window short if somehow hit during testing.
  const settingsLimiter = rateLimit({ windowMs: 30_000, max: 100 })

  // PATCH /:joinCode/settings — host updates game settings (lobby only)
  router.patch('/:joinCode/settings', settingsLimiter, async (req, res, next) => {
    try {
      const joinCode = req.params.joinCode.toUpperCase()
      const { playerId, wordsPerPlayer, turnDurationSeconds } = req.body ?? {}

      if (typeof playerId !== 'string' || !playerId) {
        return res.status(400).json({ error: 'playerId is required' })
      }

      const patch: Partial<GameSettings> = {}

      if (wordsPerPlayer !== undefined) {
        if (!Number.isInteger(wordsPerPlayer) || wordsPerPlayer < 1 || wordsPerPlayer > 20) {
          return res.status(400).json({ error: 'wordsPerPlayer must be an integer between 1 and 20' })
        }
        patch.wordsPerPlayer = wordsPerPlayer
      }

      if (turnDurationSeconds !== undefined) {
        if (!Number.isInteger(turnDurationSeconds) || turnDurationSeconds < 5 || turnDurationSeconds > 600) {
          return res.status(400).json({ error: 'turnDurationSeconds must be an integer between 5 and 600' })
        }
        patch.turnDurationSeconds = turnDurationSeconds
      }

      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'At least one setting field must be provided' })
      }

      const updated = await store.updateSettings(joinCode, playerId, patch)
      return res.json(toPublicGame(updated))
    } catch (err: unknown) {
      if (err instanceof AppError && err.code === 'NOT_FOUND') return res.status(404).json({ error: 'Game not found' })
      if (err instanceof AppError && err.code === 'FORBIDDEN') return res.status(403).json({ error: 'Only the host can change game settings' })
      if (err instanceof AppError && err.code === 'INVALID_STATE') return res.status(409).json({ error: err.message })
      if (err instanceof AppError && err.code === 'SETTINGS_CONFLICT') return res.status(409).json({ error: err.message })
      next(err)
    }
  })

  // PATCH /:joinCode/team-name — host renames a team (lobby only)
  router.patch('/:joinCode/team-name', settingsLimiter, async (req, res, next) => {
    try {
      const joinCode = req.params.joinCode.toUpperCase()
      const { playerId, team, name } = req.body ?? {}

      if (typeof playerId !== 'string' || !playerId) {
        return res.status(400).json({ error: 'playerId is required' })
      }
      if (team !== 1 && team !== 2) {
        return res.status(400).json({ error: 'team must be 1 or 2' })
      }
      if (typeof name !== 'string') {
        return res.status(400).json({ error: 'name is required' })
      }

      const updated = await store.updateTeamName(joinCode, playerId, team, name)
      return res.json(toPublicGame(updated))
    } catch (err: unknown) {
      if (err instanceof AppError && err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message })
      if (err instanceof AppError && err.code === 'FORBIDDEN') return res.status(403).json({ error: err.message })
      if (err instanceof AppError && err.code === 'INVALID_STATE') return res.status(409).json({ error: err.message })
      if (err instanceof AppError && err.code === 'TEAM_NAME_CONFLICT') return res.status(409).json({ error: err.message })
      if (err instanceof AppError && err.code === 'VALIDATION') return res.status(400).json({ error: err.message })
      next(err)
    }
  })

  return router
}
