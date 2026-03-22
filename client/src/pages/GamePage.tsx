import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
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

  if (!game || !game.currentClueGiverId) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-cream">
        <p role="status" className="text-gray-400">Loading...</p>
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
        {isClueGiver && <ClueGiverView />}
        {isGuesser && <GuesserView clueGiverName={clueGiver.name} />}
        {!isClueGiver && !isGuesser && (
          <SpectatorView clueGiverName={clueGiver.name} team={clueGiver.team} />
        )}
      </div>
    </div>
  )
}

// -- private role views --

function ClueGiverView() {
  return (
    <div className="mt-8 flex flex-col items-center gap-6 text-center">
      <p className="text-xl font-semibold text-gray-900">You are describing!</p>
      <button
        aria-disabled="true"
        aria-label="Start Turn (not yet available)"
        onClick={(e) => e.preventDefault()}
        className="rounded-xl bg-brand-coral px-8 py-3 text-sm font-semibold text-white opacity-40 cursor-not-allowed"
      >
        Start Turn
      </button>
    </div>
  )
}

function GuesserView({ clueGiverName }: { clueGiverName: string }) {
  return (
    <div className="mt-8 text-center">
      <p className="text-xl font-semibold text-gray-900">
        Get ready to guess — <span className="text-brand-coral">{clueGiverName}</span> is about to describe!
      </p>
    </div>
  )
}

function SpectatorView({ clueGiverName, team }: { clueGiverName: string; team: 1 | 2 }) {
  return (
    <div className="mt-8 text-center">
      <p className="text-xl font-semibold text-gray-900">
        Watch closely — <span className="text-brand-teal">{clueGiverName}</span> is describing for Team {team}!
      </p>
    </div>
  )
}
