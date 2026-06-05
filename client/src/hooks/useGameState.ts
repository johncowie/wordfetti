import { useEffect, useState } from 'react'
import type { GameSnapshot } from '@wordfetti/shared'

export function useGameState(joinCode: string | undefined) {
  const [game, setGame] = useState<GameSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!joinCode) return
    const controller = new AbortController()
    fetch(`/api/games/${joinCode}`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`)
        return res.json() as Promise<GameSnapshot>
      })
      .then(setGame)
      .catch((err) => {
        if (err.name === 'AbortError') return
        setError('Could not load the game.')
      })
    return () => controller.abort()
  }, [joinCode])

  useEffect(() => {
    if (!joinCode) return
    const es = new EventSource(`/api/games/${joinCode}/events`)
    es.onopen = () => setConnected(true)
    es.onmessage = (event) => {
      setGame(JSON.parse(event.data) as GameSnapshot)
    }
    es.onerror = () => {
      console.warn(`[game] SSE connection error for game ${joinCode}`)
      setConnected(false)
    }
    return () => {
      es.close()
      setConnected(false)
    }
  }, [joinCode])

  return { game, setGame, error, connected }
}
