import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import type { Game } from '@wordfetti/shared'
import { Logo } from '../components/Logo'
import { loadSession } from '../session'
import { useGameState } from '../hooks/useGameState'

export function GamePage() {
  const { joinCode } = useParams<{ joinCode: string }>()
  const navigate = useNavigate()
  const [session] = useState(() => loadSession())
  const { game, error } = useGameState(joinCode)

  const currentPlayerId =
    session !== null && session.joinCode === joinCode?.toUpperCase()
      ? session.playerId
      : null

  // Redirect if no session for this game
  useEffect(() => {
    if (!currentPlayerId) {
      navigate(`/join?code=${joinCode?.toUpperCase()}`, { replace: true })
    }
  }, [currentPlayerId, joinCode, navigate])

  // Redirect to lobby if game has not started yet (e.g. direct URL hit before start).
  // Condition is '=== lobby' (not '!== in_progress') so 'finished' does not redirect here.
  // Gated on currentPlayerId so it doesn't race with the no-session redirect above.
  useEffect(() => {
    if (game && game.status === 'lobby' && currentPlayerId) {
      navigate(`/lobby/${joinCode}`, { replace: true })
    }
  }, [game, joinCode, navigate, currentPlayerId])

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-cream">
        <p role="alert" className="text-gray-600">{error}</p>
      </div>
    )
  }

  if (!game) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-cream">
        <p role="status" className="text-gray-400">Loading...</p>
      </div>
    )
  }

  // Round over check must come before the currentClueGiverId guard because
  // ENG-012 will clear currentClueGiverId when the round ends.
  if (game.status === 'round_over') {
    return (
      <div className="flex min-h-screen flex-col items-center bg-brand-cream px-4 py-8">
        <div className="w-full max-w-lg">
          <Logo />
          {game.scores
            ? <RoundOverView scores={game.scores} />
            : <p role="status" className="text-gray-400">Loading scores...</p>
          }
        </div>
      </div>
    )
  }

  const clueGiver = game.players.find((p) => p.id === game.currentClueGiverId)
  if (!clueGiver) {
    // currentClueGiverId set but player not in list — transient state, show loading
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-cream">
        <p role="status" className="text-gray-400">Loading...</p>
      </div>
    )
  }

  const currentPlayer = game.players.find((p) => p.id === currentPlayerId)
  const isClueGiver = currentPlayerId === game.currentClueGiverId
  const isGuesser = !isClueGiver && currentPlayer?.team === clueGiver.team

  return (
    <div className="flex min-h-screen flex-col items-center bg-brand-cream px-4 py-8">
      <div className="w-full max-w-lg">
        <Logo />
        {isClueGiver && (
          <ClueGiverView game={game} joinCode={joinCode!} playerId={currentPlayerId!} />
        )}
        {isGuesser && <GuesserView clueGiverName={clueGiver.name} />}
        {!isClueGiver && !isGuesser && (
          <SpectatorView clueGiverName={clueGiver.name} team={clueGiver.team} game={game} />
        )}
      </div>
    </div>
  )
}

// -- private role views --

function ClueGiverView({
  game,
  joinCode,
  playerId,
}: {
  game: Game
  joinCode: string
  playerId: string
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function callGameAction(action: 'ready' | 'guess' | 'skip') {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(`/api/games/${joinCode}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        setError((body as { error?: string }).error ?? 'Something went wrong — please try again')
      }
    } catch {
      setError('Something went wrong — please try again')
    } finally {
      setLoading(false)
    }
  }

  const handleReady = () => callGameAction('ready')
  const handleGuess = () => callGameAction('guess')
  const handleSkip = () => callGameAction('skip')

  if (game.turnPhase === 'ready') {
    return (
      <div className="mt-8 flex flex-col items-center gap-6 text-center">
        <p className="text-xl font-semibold text-gray-900">You are describing!</p>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <button
          onClick={handleReady}
          disabled={loading}
          className="rounded-xl bg-brand-coral px-8 py-3 text-sm font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Start Turn
        </button>
      </div>
    )
  }

  return (
    <div className="mt-8 flex flex-col items-center gap-6 text-center">
      <p className="text-sm font-medium uppercase tracking-wide text-gray-500">Describe this word</p>
      <p className="text-4xl font-bold text-gray-900">{game.currentWord}</p>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-4">
        <button
          onClick={handleGuess}
          disabled={loading}
          className="rounded-xl bg-brand-coral px-8 py-3 text-sm font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Guessed!
        </button>
        <button
          onClick={handleSkip}
          disabled={loading}
          className="rounded-xl bg-gray-200 px-8 py-3 text-sm font-semibold text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Skip
        </button>
      </div>
    </div>
  )
}

function GuesserView({ clueGiverName }: { clueGiverName: string }) {
  return (
    <div className="mt-8 text-center">
      <p className="text-xl font-semibold text-gray-900">
        Your team is guessing —{' '}
        <span className="text-brand-coral">{clueGiverName}</span> is describing!
      </p>
    </div>
  )
}

function SpectatorView({
  clueGiverName,
  team,
  game,
}: {
  clueGiverName: string
  team: 1 | 2
  game: Game
}) {
  const guessed = game.guessedThisTurn ?? []
  return (
    <div className="mt-8 flex flex-col gap-6 text-center">
      <p className="text-xl font-semibold text-gray-900">
        Watch closely —{' '}
        <span className="text-brand-teal">{clueGiverName}</span> is describing
        for Team {team}!
      </p>
      {game.scores && (
        <div className="flex justify-center gap-8 text-lg font-medium text-gray-700">
          <span>Team 1: {game.scores.team1}</span>
          <span>Team 2: {game.scores.team2}</span>
        </div>
      )}
      {guessed.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium uppercase tracking-wide text-gray-500">
            Guessed this turn
          </p>
          <ul className="space-y-1">
            {guessed.map((w, i) => (
              <li key={`${i}-${w}`} className="text-gray-800">{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function RoundOverView({ scores }: { scores: { team1: number; team2: number } }) {
  return (
    <div className="mt-8 flex flex-col items-center gap-6 text-center">
      <p className="text-2xl font-bold text-gray-900">Round Over!</p>
      <div className="flex gap-8 text-xl font-semibold">
        <div className="flex flex-col items-center gap-1">
          <span className="text-sm font-medium uppercase tracking-wide text-gray-500">Team 1</span>
          <span className="text-4xl text-brand-coral">{scores.team1}</span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <span className="text-sm font-medium uppercase tracking-wide text-gray-500">Team 2</span>
          <span className="text-4xl text-brand-teal">{scores.team2}</span>
        </div>
      </div>
    </div>
  )
}
