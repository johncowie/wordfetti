import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import type { Game } from '@wordfetti/shared'

export function ResultsPage() {
  const { joinCode } = useParams<{ joinCode: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const [game, setGame] = useState<Game | null>(
    (location.state as { game?: Game } | null)?.game ?? null
  )
  const [error, setError] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  // One-shot fetch fallback for direct URL hits
  useEffect(() => {
    if (game || !joinCode) return
    const controller = new AbortController()
    fetch(`/api/games/${joinCode}`, { signal: controller.signal })
      .then((res) => { if (!res.ok) throw new Error(`${res.status}`); return res.json() as Promise<Game> })
      .then(setGame)
      .catch((err) => { if (err.name === 'AbortError') return; setError('Could not load results.') })
    return () => controller.abort()
  }, [joinCode, game])

  // Guard: redirect if the game is not finished (e.g. direct URL hit mid-game)
  useEffect(() => {
    if (game && game.status !== 'finished') {
      navigate(`/game/${joinCode}`)
    }
  }, [game, joinCode, navigate])

  // Move focus to heading on mount so screen readers announce the result
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  if (error) return <p className="text-red-600 text-center mt-8">{error}</p>
  if (!game || !game.scores) return <p className="text-center mt-8">Loading results...</p>

  const { team1, team2 } = game.scores
  const winner =
    team1 > team2 ? 'Team 1 wins!'
    : team2 > team1 ? 'Team 2 wins!'
    : "It's a draw!"

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-4">
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="text-3xl font-bold text-gray-900 outline-none"
      >
        Game Over!
      </h1>
      <p className="text-2xl font-semibold text-brand-coral">{winner}</p>
      <div className="flex gap-12">
        <div className="text-center">
          <p className="text-sm font-medium text-gray-500 uppercase">Team 1</p>
          <p aria-label={`Team 1 score: ${team1}`} className="text-5xl font-bold text-gray-900">{team1}</p>
        </div>
        <div className="text-center">
          <p className="text-sm font-medium text-gray-500 uppercase">Team 2</p>
          <p aria-label={`Team 2 score: ${team2}`} className="text-5xl font-bold text-gray-900">{team2}</p>
        </div>
      </div>
    </main>
  )
}
