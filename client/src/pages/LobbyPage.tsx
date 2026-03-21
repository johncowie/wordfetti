import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { Game, Player } from '@wordfetti/shared'
import { Logo } from '../components/Logo'
import { loadSession } from '../session'

export function LobbyPage() {
  const { joinCode } = useParams<{ joinCode: string }>()
  const [game, setGame] = useState<Game | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  // useState initialiser avoids calling loadSession on every render
  const [session] = useState(() => loadSession())
  const currentPlayerId =
    session !== null && session.joinCode === joinCode?.toUpperCase() ? session.playerId : null

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
        setError('Could not load the game. Check the code and try again.')
      })
    return () => controller.abort()
  }, [joinCode])

  // The initial fetch effect (above) is the authority for error display (404 etc.)
  // and provides the first render of game state. This effect opens the live SSE
  // stream for real-time updates. The SSE endpoint also sends the current game
  // state immediately on connect, so any staleness from the initial fetch is
  // self-corrected without a separate round-trip.
  useEffect(() => {
    if (!joinCode) return
    const es = new EventSource(`/api/games/${joinCode}/events`)
    es.onmessage = (event) => {
      setGame(JSON.parse(event.data) as Game)
    }
    es.onerror = (event) => {
      // Close the connection to stop EventSource's automatic retry loop.
      // Without this, a 404 or server error causes the browser to hammer the
      // /events endpoint repeatedly, exhausting the shared rate limiter.
      // The initial fetch effect already shows the appropriate error state.
      console.warn(`[lobby] SSE connection error for game ${joinCode}`, event)
      es.close()
    }
    return () => es.close()
  }, [joinCode])

  async function handleStartGame() {
    if (!joinCode || !session) return
    setStartError(null)
    const res = await fetch(`/api/games/${joinCode}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: session.playerId }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setStartError(body.error ?? 'Something went wrong. Please try again.')
    }
    // On success, SSE pushes the updated game status automatically
  }

  function copyCode() {
    if (!joinCode) return
    navigator.clipboard.writeText(joinCode).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

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

  const team1 = game.players.filter((p) => p.team === 1)
  const team2 = game.players.filter((p) => p.team === 2)
  const needsMorePlayers = team1.length < 2 || team2.length < 2

  return (
    <div className="flex min-h-screen flex-col items-center bg-brand-cream px-4 py-8">
      <div className="w-full max-w-lg">
        <Logo />

        <h1 className="mt-6 text-center text-xl font-bold text-gray-900">Game Lobby</h1>

        {/* Join code badge with clipboard feedback */}
        <div className="mt-2 flex justify-center">
          <button
            onClick={copyCode}
            aria-label="Copy join code"
            className="flex items-center gap-2 rounded-full border border-gray-200 bg-white px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
          >
            <span>
              Code: <span className="font-mono font-semibold tracking-wider">{joinCode}</span>
            </span>
            <CopyIcon />
          </button>
        </div>
        {/* aria-live region for clipboard feedback */}
        <p aria-live="polite" className="mt-1 text-center text-xs text-gray-400">
          {copied ? 'Copied!' : '\u00A0'}
        </p>

        {/* Prompt for visitors without a session */}
        {!currentPlayerId && (
          <p className="mt-2 text-center text-sm text-gray-500">
            Want to play?{' '}
            <a href={`/join?code=${joinCode}`} className="font-medium text-brand-coral hover:underline">
              Join this game
            </a>
          </p>
        )}

        {/* Team columns */}
        <div className="mt-6 grid grid-cols-2 gap-4">
          <TeamColumn
            label="Team 1"
            players={team1}
            currentPlayerId={currentPlayerId}
            colorScheme="coral"
          />
          <TeamColumn
            label="Team 2"
            players={team2}
            currentPlayerId={currentPlayerId}
            colorScheme="teal"
          />
        </div>

        {/* Context-aware footer */}
        {currentPlayerId === game.hostId && (
          <div className="mt-6 flex flex-col items-center gap-2">
            <button
              onClick={handleStartGame}
              disabled={needsMorePlayers}
              className="rounded-xl bg-brand-coral px-8 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              Start Game
            </button>
            {needsMorePlayers && (
              <p className="text-center text-sm text-gray-400">
                Both teams need at least 2 players to start
              </p>
            )}
            {startError && (
              <p role="alert" className="text-center text-sm text-red-500">{startError}</p>
            )}
          </div>
        )}
        {currentPlayerId !== game.hostId && needsMorePlayers && (
          <p className="mt-6 text-center text-sm text-gray-400">
            Waiting for more players...
          </p>
        )}
      </div>
    </div>
  )
}

const SCHEME = {
  coral: { bg: 'bg-red-50', labelColor: 'text-brand-coral', badgeBg: 'bg-brand-coral', needColor: 'text-red-400' },
  teal:  { bg: 'bg-teal-50', labelColor: 'text-brand-teal', badgeBg: 'bg-brand-teal', needColor: 'text-teal-400' },
} as const

type TeamColumnProps = {
  label: string
  players: Player[]
  currentPlayerId: string | null
  colorScheme: keyof typeof SCHEME
}

function TeamColumn({ label, players, currentPlayerId, colorScheme }: TeamColumnProps) {
  const { bg, labelColor, badgeBg, needColor } = SCHEME[colorScheme]
  const needMore = Math.max(0, 2 - players.length)
  const headingId = `team-heading-${colorScheme}`

  return (
    <section aria-labelledby={headingId} className={`rounded-2xl ${bg} p-4`}>
      <div className="mb-3 flex items-center justify-between">
        <h2 id={headingId} className={`text-sm font-semibold ${labelColor}`}>{label}</h2>
        <span className={`rounded-full ${badgeBg} px-2 py-0.5 text-xs font-bold text-white`}>
          {players.length}
        </span>
      </div>

      {players.length === 0 ? (
        <p className="text-center text-xs text-gray-400">No players yet</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {players.map((player) => (
            <PlayerRow
              key={player.id}
              player={player}
              isCurrentPlayer={player.id === currentPlayerId}
            />
          ))}
        </ul>
      )}

      {needMore > 0 && (
        <p className={`mt-2 text-center text-xs ${needColor}`}>
          Need {needMore} more player{needMore > 1 ? 's' : ''}
        </p>
      )}
    </section>
  )
}

type PlayerRowProps = {
  player: Player
  isCurrentPlayer: boolean
}

function PlayerRow({ player, isCurrentPlayer }: PlayerRowProps) {
  return (
    <li className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm">
      <span aria-hidden="true">⭐</span>
      <span className="flex-1 font-medium text-gray-800">
        {player.name}
        {isCurrentPlayer && (
          <span className="ml-1 text-xs text-gray-400">(you)</span>
        )}
      </span>
    </li>
  )
}

function CopyIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}
