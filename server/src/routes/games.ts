import { Router } from 'express'
import type { GameStore } from '../store/GameStore.js'
import { WORDS_PER_PLAYER, type Team } from '@wordfetti/shared'
import { AppError } from '../errors.js'

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

      // Subscribe BEFORE fetching the snapshot so any player join that occurs
      // in the gap between the two store calls is not silently missed.
      const unsubscribe = store.subscribe(joinCode, (updatedGame) => {
        res.write(`data: ${JSON.stringify(updatedGame)}\n\n`)
      })

      // Fetch a fresh snapshot after subscribing; any concurrent join is now
      // either captured by the callback above or already in this snapshot.
      const snapshot = (await store.getGameByJoinCode(joinCode))!
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`)

      req.on('close', () => {
        unsubscribe()
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

      const allWordsSubmitted = game.players.every((p) => p.wordCount >= WORDS_PER_PLAYER)
      if (!allWordsSubmitted) {
        return res.status(422).json({ error: 'All players must submit their words before the game can start' })
      }

      const updated = await store.startGame(joinCode)
      res.json(updated)
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
        return res.status(409).json({ error: `You can only submit ${WORDS_PER_PLAYER} words` })
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
      if (err instanceof AppError && err.code === 'GAME_IN_PROGRESS') {
        return res.status(409).json({ error: 'This game has already started' })
      }
      next(err)
    }
  })

  return router
}
