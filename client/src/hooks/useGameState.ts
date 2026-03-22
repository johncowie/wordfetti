import { useEffect, useState } from 'react'
import type { Game } from '@wordfetti/shared'

export function useGameState(joinCode: string | undefined) {
  const [game, setGame] = useState<Game | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!joinCode) return
    const controller = new AbortController()
    fetch(`/api/games/${joinCode}`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`)
        return res.json() as Promise<Game>
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
    es.onmessage = (event) => {
      setGame(JSON.parse(event.data) as Game)
    }
    es.onerror = (event) => {
      console.warn(`[game] SSE connection error for game ${joinCode}`, event)
      es.close()
    }
    return () => es.close()
  }, [joinCode])

  return { game, error }
}
