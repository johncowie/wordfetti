import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import type { GameSnapshot } from '@wordfetti/shared'
import { Logo } from '../components/Logo'
import { ManagePlayersModal } from '../components/ManagePlayersModal'
import { TurnTimer } from '../components/TurnTimer'
import { loadSession } from '../session'
import { useAlarmSound } from '../hooks/useAlarmSound'
import { useGameState } from '../hooks/useGameState'
import { useClockOffset } from '../hooks/useClockOffset'

function roundRuleText(round: number): string {
  if (round > 3) return ''
  if (round === 1) return 'Describe the concept by saying anything except the word itself! No Rhymes, "starts with _", or other obvious cheats.'
  if (round === 2) return 'Charades! Act out the concept to get people to guess the word or phrase without saying anything or making any noises.'
  return 'One word only - use one word to get the players to guess the correct answer'
}

export function GamePage() {
  const { joinCode } = useParams<{ joinCode: string }>()
  const navigate = useNavigate()
  const [session] = useState(() => loadSession())
  const { game, error } = useGameState(joinCode)
  const { clockOffset, clockOffsetReady } = useClockOffset()

  const currentPlayerId =
    session !== null && session.joinCode === joinCode?.toUpperCase()
      ? session.playerId
      : null

  const isHost = currentPlayerId !== null && currentPlayerId === game?.hostId
  const { isPlaying: alarmPlaying, stop: stopAlarm } = useAlarmSound(isHost, game?.turnPhase)

  const prevStatusRef = useRef<string | undefined>(undefined)
  const [showRoundSplash, setShowRoundSplash] = useState(false)
  const [showManagePlayers, setShowManagePlayers] = useState(false)

  // Redirect if no session for this game
  useEffect(() => {
    if (!currentPlayerId) {
      navigate(`/join?code=${joinCode?.toUpperCase()}`, { replace: true })
    }
  }, [currentPlayerId, joinCode, navigate])

  // Redirect to lobby if game has not started yet (e.g. direct URL hit before start).
  // Gated on currentPlayerId so it doesn't race with the no-session redirect above.
  useEffect(() => {
    if (game && game.status === 'lobby' && currentPlayerId) {
      navigate(`/lobby/${joinCode}`, { replace: true })
    }
  }, [game, joinCode, navigate, currentPlayerId])

  // Navigate to results when game finishes; pass game state to avoid a second fetch.
  useEffect(() => {
    if (game && game.status === 'finished') {
      navigate(`/game/${joinCode}/results`, { state: { game } })
    }
  }, [game, joinCode, navigate])

  // Detect between_rounds → in_progress transition to show round-start splash.
  useEffect(() => {
    if (prevStatusRef.current === 'between_rounds' && game?.status === 'in_progress') {
      setShowRoundSplash(true)
      const timer = setTimeout(() => setShowRoundSplash(false), 2500)
      // Update ref here too — must always reflect the latest status so future transitions are detected correctly.
      // Without this, ref stays 'between_rounds' and could re-trigger the splash on any subsequent status change.
      prevStatusRef.current = game.status
      return () => clearTimeout(timer)
    }
    // Always update the ref, even when no transition fires, so it's ready for the next check.
    // Guard against undefined (null game on SSE reconnect) to avoid losing the previous known status.
    if (game?.status !== undefined) prevStatusRef.current = game.status
  }, [game?.status])

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

  if (game.status === 'awaiting_extra_round_decision') {
    return (
      <div className="flex min-h-screen flex-col items-center bg-brand-cream px-4 py-8">
        <div className="w-full max-w-lg">
          <Logo />
          <AwaitingExtraRoundDecisionView
            isHost={isHost}
            joinCode={joinCode!}
            playerId={currentPlayerId!}
          />
        </div>
      </div>
    )
  }

  // between_rounds check must come before the currentClueGiverId guard because
  // guessWord clears currentClueGiverId when the hat empties.
  if (game.status === 'between_rounds') {
    return (
      <div className="flex min-h-screen flex-col items-center bg-brand-cream px-4 py-8">
        <div className="w-full max-w-lg">
          <Logo />
          {alarmPlaying && (
            <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50">
              <button
                onClick={stopAlarm}
                className="rounded-full bg-red-600 px-6 py-3 text-white font-semibold shadow-lg hover:bg-red-700 active:scale-95 transition-all"
              >
                Stop alarm
              </button>
            </div>
          )}
          <BetweenRoundsView
            round={game.round ?? 1}
            isHost={isHost}
            joinCode={joinCode!}
            playerId={currentPlayerId!}
            onManagePlayers={isHost ? () => setShowManagePlayers(true) : undefined}
          />
        </div>
        {showManagePlayers && currentPlayerId && (
          <ManagePlayersModal
            joinCode={joinCode!}
            players={game.players}
            hostPlayerId={currentPlayerId}
            onClose={() => setShowManagePlayers(false)}
          />
        )}
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
        {alarmPlaying && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50">
            <button
              onClick={stopAlarm}
              className="rounded-full bg-red-600 px-6 py-3 text-white font-semibold shadow-lg hover:bg-red-700 active:scale-95 transition-all"
            >
              Stop alarm
            </button>
          </div>
        )}
        {showRoundSplash && game.round && (
          <RoundSplashOverlay round={game.round!} onDismiss={() => setShowRoundSplash(false)} />
        )}
        {isClueGiver && (
          <ClueGiverView game={game} joinCode={joinCode!} playerId={currentPlayerId!} clockOffset={clockOffset} clockOffsetReady={clockOffsetReady} />
        )}
        {!isClueGiver && game.turnPhase === 'ready' && (
          <WaitingView
            clueGiverName={clueGiver.name}
            onManagePlayers={isHost ? () => setShowManagePlayers(true) : undefined}
          />
        )}
        {!isClueGiver && game.turnPhase === 'active' && isGuesser && (
          <GuesserView clueGiverName={clueGiver.name} game={game} clockOffset={clockOffset} clockOffsetReady={clockOffsetReady} />
        )}
        {!isClueGiver && game.turnPhase === 'active' && !isGuesser && (
          <SpectatorView
            clueGiverName={clueGiver.name}
            team={clueGiver.team}
            game={game}
            clockOffset={clockOffset}
            clockOffsetReady={clockOffsetReady}
            onManagePlayers={isHost ? () => setShowManagePlayers(true) : undefined}
          />
        )}
        {!isClueGiver && game.turnPhase !== 'ready' && game.turnPhase !== 'active' && (
          <p role="status" className="text-gray-400">Loading...</p>
        )}
      </div>
      {showManagePlayers && currentPlayerId && (
        <ManagePlayersModal
          joinCode={joinCode!}
          players={game.players}
          hostPlayerId={currentPlayerId}
          onClose={() => setShowManagePlayers(false)}
        />
      )}
    </div>
  )
}

// -- private role views --

function ClueGiverView({
  game,
  joinCode,
  playerId,
  clockOffset,
  clockOffsetReady,
}: {
  game: GameSnapshot
  joinCode: string
  playerId: string
  clockOffset: number
  clockOffsetReady: boolean
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timerFiredRef = useRef(false)
  const [, setTick] = useState(0)
  const [turnEnding, setTurnEnding] = useState(false)
  // Kept in sync so the interval reads the latest offset without adding clockOffset
  // to the useEffect deps (which would reset timerFiredRef on every re-sync).
  const clockOffsetRef = useRef(clockOffset)
  useEffect(() => { clockOffsetRef.current = clockOffset }, [clockOffset])

  useEffect(() => {
    if (game.turnPhase !== 'active' || !game.turnStartedAt) return
    timerFiredRef.current = false
    setTurnEnding(false)

    const interval = setInterval(async () => {
      setTick((t) => t + 1)

      const elapsed = Math.floor((Date.now() + clockOffsetRef.current - Date.parse(game.turnStartedAt!)) / 1000)
      if (elapsed >= game.settings.turnDurationSeconds && !timerFiredRef.current) {
        timerFiredRef.current = true
        clearInterval(interval)
        setTurnEnding(true)
        try {
          await fetch(`/api/games/${joinCode}/end-turn`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playerId }),
          })
        } catch {
          setTurnEnding(false)
        }
      }
    }, 500)

    return () => clearInterval(interval)
  }, [game.turnPhase, game.turnStartedAt, joinCode, playerId])

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
        {game.round && (
          <p className="text-sm font-medium italic text-gray-500">
            {roundRuleText(game.round)}
          </p>
        )}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <button
          onClick={handleReady}
          disabled={loading || turnEnding}
          className="rounded-xl bg-brand-coral px-8 py-3 text-sm font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Start Turn
        </button>
      </div>
    )
  }

  return (
    <div className="mt-8 flex flex-col items-center gap-6 text-center">
      {game.turnPhase === 'active' && game.turnStartedAt && (
        <TurnTimer
          key={clockOffsetReady ? 'synced' : 'unsynced'}
          duration={game.settings.turnDurationSeconds}
          turnStartedAt={game.turnStartedAt}
          label="You're giving clues"
          clockOffset={clockOffset}
        />
      )}
      <p className="text-sm font-medium uppercase tracking-wide text-gray-500">Describe this word</p>
      <p className="text-4xl font-bold text-gray-900">{game.currentWord}</p>
      {game.round && (
        <p className="text-sm font-medium italic text-gray-500">
          {roundRuleText(game.round)}
        </p>
      )}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-4">
        <button
          onClick={handleGuess}
          disabled={loading || turnEnding}
          className="rounded-xl bg-brand-coral px-8 py-3 text-sm font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Guessed!
        </button>
        <button
          onClick={handleSkip}
          disabled={loading || turnEnding}
          className="rounded-xl bg-gray-200 px-8 py-3 text-sm font-semibold text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Skip
        </button>
      </div>
    </div>
  )
}

function WaitingView({ clueGiverName, onManagePlayers }: { clueGiverName: string; onManagePlayers?: () => void }) {
  return (
    <div className="mt-8 text-center">
      <p className="text-xl font-semibold text-gray-900">
        Waiting for <span className="text-brand-coral">{clueGiverName}</span> to start their turn...
      </p>
      {onManagePlayers && (
        <button onClick={onManagePlayers} className="mt-4 text-sm underline text-gray-500 hover:text-gray-800">
          Manage Players
        </button>
      )}
    </div>
  )
}

function GuesserView({ clueGiverName, game, clockOffset, clockOffsetReady }: { clueGiverName: string; game: GameSnapshot; clockOffset: number; clockOffsetReady: boolean }) {
  return (
    <div className="mt-8 flex flex-col items-center gap-6 text-center">
      {game.turnStartedAt && (
        <TurnTimer
          key={clockOffsetReady ? 'synced' : 'unsynced'}
          duration={game.settings.turnDurationSeconds}
          turnStartedAt={game.turnStartedAt}
          label="Guess the word!"
          clockOffset={clockOffset}
        />
      )}
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
  clockOffset,
  clockOffsetReady,
  onManagePlayers,
}: {
  clueGiverName: string
  team: 1 | 2
  game: GameSnapshot
  clockOffset: number
  clockOffsetReady: boolean
  onManagePlayers?: () => void
}) {
  const guessed = game.guessedThisTurn ?? []
  const activeTeamName = team === 1 ? game.teamNames.team1 : game.teamNames.team2
  return (
    <div className="mt-8 flex flex-col gap-6 text-center">
      {game.turnStartedAt && (
        <TurnTimer
          key={clockOffsetReady ? 'synced' : 'unsynced'}
          duration={game.settings.turnDurationSeconds}
          turnStartedAt={game.turnStartedAt}
          label={`${activeTeamName} is playing, don't guess!`}
          clockOffset={clockOffset}
        />
      )}
      <p className="text-xl font-semibold text-gray-900">
        Watch closely —{' '}
        <span className="text-brand-teal">{clueGiverName}</span> is describing
        for {activeTeamName}!
      </p>
      {game.scores && (
        <div className="flex justify-center gap-8 text-lg font-medium text-gray-700">
          <span>{game.teamNames.team1}: {game.scores.team1}</span>
          <span>{game.teamNames.team2}: {game.scores.team2}</span>
        </div>
      )}
      {onManagePlayers && (
        <button onClick={onManagePlayers} className="text-sm underline text-gray-500 hover:text-gray-800">
          Manage Players
        </button>
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

function AwaitingExtraRoundDecisionView({ isHost, joinCode, playerId }: {
  isHost: boolean; joinCode: string; playerId: string
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleEndGame() {
    setLoading(true)
    setError(null)
    const res = await fetch(`/api/games/${joinCode}/end-game`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError((body as { error?: string }).error ?? 'Something went wrong')
    }
    setLoading(false)
  }

  async function handlePlayExtraRound() {
    setLoading(true)
    setError(null)
    const res = await fetch(`/api/games/${joinCode}/play-extra-round`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError((body as { error?: string }).error ?? 'Something went wrong')
    }
    setLoading(false)
  }

  return (
    <div className="mt-8 flex flex-col items-center gap-6 text-center">
      <p className="text-xl font-semibold text-gray-900">The host is choosing whether to end the game or play another round</p>
      {isHost && (
        <>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <button
            onClick={handleEndGame}
            disabled={loading}
            className="rounded-xl bg-gray-200 px-8 py-3 text-sm font-semibold text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            End Game
          </button>
          <button
            onClick={handlePlayExtraRound}
            disabled={loading}
            className="rounded-xl bg-brand-coral px-8 py-3 text-sm font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Play another round
          </button>
        </>
      )}
    </div>
  )
}

function BetweenRoundsView({ round, isHost, joinCode, playerId, onManagePlayers }: {
  round: number; isHost: boolean; joinCode: string; playerId: string; onManagePlayers?: () => void
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleAdvance() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/games/${joinCode}/advance-round`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as { error?: string }).error ?? 'Something went wrong')
      }
    } catch {
      setError('Something went wrong — please try again')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mt-8 flex flex-col items-center gap-6 text-center">
      <p className="text-2xl font-bold text-gray-900">Round {round} is over!</p>
      {isHost ? (
        <>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          <button
            onClick={handleAdvance}
            disabled={loading}
            className="rounded-xl bg-brand-coral px-8 py-3 text-sm font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Start Round {round + 1}
          </button>
          {onManagePlayers && (
            <button onClick={onManagePlayers} className="text-sm underline text-gray-500 hover:text-gray-800">
              Manage Players
            </button>
          )}
        </>
      ) : (
        <p className="text-gray-600">Waiting for the host to start Round {round + 1}...</p>
      )}
    </div>
  )
}

function RoundSplashOverlay({ round, onDismiss }: { round: number; onDismiss: () => void }) {
  const overlayRef = useRef<HTMLDivElement>(null)

  // Move focus into the overlay on mount so keyboard users can dismiss it immediately.
  useEffect(() => {
    overlayRef.current?.focus()
  }, [])

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Round ${round} starting`}
      tabIndex={0}
      className="fixed inset-0 z-50 flex items-center justify-center bg-brand-coral cursor-pointer outline-none"
      onClick={onDismiss}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onDismiss() }}
    >
      <div className="text-center text-white px-8">
        <p className="text-4xl font-bold mb-4">Round {round}</p>
        <p className="text-xl">{roundRuleText(round)}</p>
        <p className="mt-8 text-sm opacity-70">Tap or press Enter to continue</p>
      </div>
    </div>
  )
}
