import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import type { GameSettings, Player, Team } from '@wordfetti/shared'
import { Logo } from '../components/Logo'
import { ManagePlayersModal } from '../components/ManagePlayersModal'
import { loadSession, saveSession } from '../session'
import { useGameState } from '../hooks/useGameState'
import { calculateDefaultWordsPerPlayer } from '../utils/gameSettings'

export function LobbyPage() {
  const { joinCode } = useParams<{ joinCode: string }>()
  const navigate = useNavigate()
  const [copied, setCopied] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [settingsValid, setSettingsValid] = useState(true)
  const [showManagePlayers, setShowManagePlayers] = useState(false)
  // useState initialiser avoids calling loadSession on every render
  const [session, setSession] = useState(() => loadSession())
  const currentPlayerId =
    session !== null && session.joinCode === joinCode?.toUpperCase() ? session.playerId : null

  const [joinName, setJoinName] = useState('')
  const [joinLoading, setJoinLoading] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)

  const { game, error } = useGameState(joinCode)

  useEffect(() => {
    if (game?.status === 'in_progress') {
      navigate(`/game/${joinCode}`)
    }
  }, [game?.status, joinCode, navigate])

  async function handleJoin(team: Team) {
    if (!joinCode) return
    const trimmedName = joinName.trim()
    setJoinLoading(true)
    setJoinError(null)
    try {
      const res = await fetch(`/api/games/${joinCode}/players`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, team }),
      })
      if (res.status === 409) {
        const data = await res.json().catch(() => ({}))
        if (data.code === 'NAME_TAKEN') {
          setJoinError('That name is already taken — please choose another.')
        } else {
          setJoinError('This game has already started.')
        }
        return
      }
      if (!res.ok) throw new Error(`Unexpected response: ${res.status}`)
      const { player } = await res.json()
      saveSession({ playerId: player.id, joinCode })
      setSession({ playerId: player.id, joinCode })
    } catch {
      setJoinError('Something went wrong. Please try again.')
    } finally {
      setJoinLoading(false)
    }
  }

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
    navigator.clipboard.writeText(`${window.location.origin}/lobby/${joinCode}`).then(() => {
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

  const activePlayers = game.players.filter((p) => p.active)
  const team1 = activePlayers.filter((p) => p.team === 1)
  const team2 = activePlayers.filter((p) => p.team === 2)
  const needsMorePlayers = team1.length < 2 || team2.length < 2
  const allWordsSubmitted = activePlayers.every((p) => p.wordCount >= game.settings.wordsPerPlayer)
  const pendingCount = activePlayers.filter((p) => p.wordCount < game.settings.wordsPerPlayer).length

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

        {/* Inline join UI for visitors */}
        {!currentPlayerId && (
          <div className="mt-4 rounded-2xl bg-white p-5 shadow-sm">
            <p className="mb-3 text-sm font-semibold text-gray-700">Want to play?</p>
            <div className="flex flex-col gap-3">
              <input
                type="text"
                value={joinName}
                onChange={(e) => { setJoinName(e.target.value); setJoinError(null) }}
                placeholder="Enter your name"
                maxLength={50}
                className="rounded-lg border border-gray-200 px-4 py-3 text-sm outline-none focus:border-brand-coral focus:ring-1 focus:ring-brand-coral"
              />
              {joinError && (
                <p role="alert" className="text-sm text-red-600">{joinError}</p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => handleJoin(1)}
                  disabled={joinName.trim().length === 0 || joinLoading}
                  className="rounded-xl bg-brand-coral px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  Join {game.teamNames.team1}
                </button>
                <button
                  onClick={() => handleJoin(2)}
                  disabled={joinName.trim().length === 0 || joinLoading}
                  className="rounded-xl bg-brand-teal px-4 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  Join {game.teamNames.team2}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Team columns */}
        <div className="mt-6 grid grid-cols-2 gap-4">
          <TeamColumn
            teamName={game.teamNames.team1}
            otherTeamName={game.teamNames.team2}
            players={team1}
            currentPlayerId={currentPlayerId}
            colorScheme="coral"
            wordsPerPlayer={game.settings.wordsPerPlayer}
            isHost={currentPlayerId === game.hostId}
            joinCode={joinCode!}
            playerId={currentPlayerId ?? ''}
          />
          <TeamColumn
            teamName={game.teamNames.team2}
            otherTeamName={game.teamNames.team1}
            players={team2}
            currentPlayerId={currentPlayerId}
            colorScheme="teal"
            wordsPerPlayer={game.settings.wordsPerPlayer}
            isHost={currentPlayerId === game.hostId}
            joinCode={joinCode!}
            playerId={currentPlayerId ?? ''}
          />
        </div>

        {/* Add Words button for current player */}
        {currentPlayerId && (
          <div className="mt-4">
            <button
              onClick={() => navigate(`/lobby/${joinCode}/words`)}
              className="w-full rounded-xl bg-brand-teal px-6 py-3.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
            >
              Add Words
            </button>
          </div>
        )}

        {/* Game settings panel */}
        {currentPlayerId && (
          <GameSettingsPanel
            settings={game.settings}
            players={activePlayers}
            isHost={currentPlayerId === game.hostId}
            joinCode={joinCode!}
            playerId={currentPlayerId}
            onValidityChange={setSettingsValid}
          />
        )}

        {/* Context-aware footer */}
        {currentPlayerId === game.hostId && (
          <div className="mt-6 flex flex-col items-center gap-2">
            <button
              onClick={handleStartGame}
              disabled={needsMorePlayers || !allWordsSubmitted || !settingsValid}
              className="rounded-xl bg-brand-coral px-8 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              Start Game
            </button>
            <button
              onClick={() => setShowManagePlayers(true)}
              className="text-sm underline text-gray-600 hover:text-gray-900"
            >
              Manage Players
            </button>
            {needsMorePlayers && (
              <p className="text-center text-sm text-gray-400">
                Both teams need at least 2 players to start
              </p>
            )}
            {!needsMorePlayers && !allWordsSubmitted && (
              <p className="text-center text-sm text-gray-400">
                Waiting for {pendingCount} {pendingCount === 1 ? 'player' : 'players'} to finish submitting words
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

const SCHEME = {
  coral: { bg: 'bg-red-50', labelColor: 'text-brand-coral', badgeBg: 'bg-brand-coral', needColor: 'text-red-400' },
  teal:  { bg: 'bg-teal-50', labelColor: 'text-brand-teal', badgeBg: 'bg-brand-teal', needColor: 'text-teal-400' },
} as const

type TeamColumnProps = {
  teamName: string
  otherTeamName: string
  players: Player[]
  currentPlayerId: string | null
  colorScheme: keyof typeof SCHEME
  wordsPerPlayer: number
  isHost: boolean
  joinCode: string
  playerId: string
}

function TeamColumn({ teamName, otherTeamName, players, currentPlayerId, colorScheme, wordsPerPlayer, isHost, joinCode, playerId }: TeamColumnProps) {
  const { bg, labelColor, badgeBg, needColor } = SCHEME[colorScheme]
  const needMore = Math.max(0, 2 - players.length)
  const headingId = `team-heading-${colorScheme}`
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(teamName)
  const [editError, setEditError] = useState<string | null>(null)

  useEffect(() => {
    if (!editing) setEditValue(teamName)
  }, [teamName, editing])

  async function handleSave() {
    const trimmed = editValue.trim()
    if (trimmed.length === 0 || trimmed.length > 20) {
      setEditError('Name must be 1–20 characters')
      return
    }
    if (trimmed.toLowerCase() === otherTeamName.toLowerCase()) {
      setEditError('Both teams cannot have the same name')
      return
    }
    if (trimmed === teamName) {
      setEditing(false)
      return
    }
    setEditError(null)
    const team = colorScheme === 'coral' ? 1 : 2
    const res = await fetch(`/api/games/${joinCode}/team-name`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, team, name: trimmed }),
    })
    if (res.ok) {
      setEditing(false)
    } else {
      const body = await res.json().catch(() => ({}))
      setEditError(body.error ?? 'Could not save team name')
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') handleSave()
    if (e.key === 'Escape') {
      setEditing(false)
      setEditValue(teamName)
      setEditError(null)
    }
  }

  return (
    <section aria-labelledby={headingId} className={`rounded-2xl ${bg} p-4`}>
      <div className="mb-3 flex items-center justify-between gap-1">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {editing ? (
            <div className="flex flex-1 flex-col gap-1">
              <input
                autoFocus
                maxLength={20}
                value={editValue}
                onChange={(e) => { setEditValue(e.target.value); setEditError(null) }}
                onBlur={handleSave}
                onKeyDown={handleKeyDown}
                className={`w-full bg-transparent text-sm font-semibold ${labelColor} border-b border-current focus:outline-none`}
              />
              {editError && <p className="text-xs text-red-500">{editError}</p>}
            </div>
          ) : (
            <>
              <h2 id={headingId} className={`truncate text-sm font-semibold ${labelColor}`}>{teamName}</h2>
              {isHost && (
                <button
                  onClick={() => { setEditing(true); setEditValue(teamName) }}
                  aria-label="Edit team name"
                  className={`shrink-0 ${labelColor} opacity-60 hover:opacity-100`}
                >
                  <PencilIcon />
                </button>
              )}
            </>
          )}
        </div>
        <span className={`shrink-0 rounded-full ${badgeBg} px-2 py-0.5 text-xs font-bold text-white`}>
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
              wordsPerPlayer={wordsPerPlayer}
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
  wordsPerPlayer: number
}

function PlayerRow({ player, isCurrentPlayer, wordsPerPlayer }: PlayerRowProps) {
  const done = player.wordCount >= wordsPerPlayer
  return (
    <li className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm">
      <span aria-hidden="true">{done ? '✅' : '⭐'}</span>
      <span className="flex-1 font-medium text-gray-800">
        {player.name}
        {isCurrentPlayer && (
          <span className="ml-1 text-xs text-gray-400">(you)</span>
        )}
      </span>
      <span className={`text-xs font-medium ${done ? 'text-green-600' : 'text-gray-400'}`}>
        {player.wordCount} / {wordsPerPlayer}
      </span>
    </li>
  )
}

type GameSettingsPanelProps = {
  settings: GameSettings
  players: Player[]
  isHost: boolean
  joinCode: string
  playerId: string
  onValidityChange: (valid: boolean) => void
}

function GameSettingsPanel({ settings, players, isHost, joinCode, playerId, onValidityChange }: GameSettingsPanelProps) {
  const [wordsInput, setWordsInput] = useState(String(settings.wordsPerPlayer))
  const [timerInput, setTimerInput] = useState(String(settings.turnDurationSeconds))
  const [wordsError, setWordsError] = useState<string | null>(null)
  const [timerError, setTimerError] = useState<string | null>(null)
  const [hasManuallyEdited, setHasManuallyEdited] = useState(settings.wordsPerPlayerManuallySet ?? false)

  // Track latest settings in a ref so async handlers always revert to the current server value
  const settingsRef = useRef(settings)
  useEffect(() => { settingsRef.current = settings }, [settings])

  // Keep local inputs in sync with SSE updates
  useEffect(() => { setWordsInput(String(settings.wordsPerPlayer)) }, [settings.wordsPerPlayer])
  useEffect(() => { setTimerInput(String(settings.turnDurationSeconds)) }, [settings.turnDurationSeconds])
  useEffect(() => { setHasManuallyEdited(settings.wordsPerPlayerManuallySet ?? false) }, [settings.wordsPerPlayerManuallySet])

  // Auto-calculate words-per-player when player count changes (unless host has manually edited).
  // Only kicks in once 4+ players have joined — the minimum required to start a game.
  useEffect(() => {
    if (hasManuallyEdited) return
    if (players.length < 4) return
    const newValue = calculateDefaultWordsPerPlayer(players.length)
    const maxSubmitted = players.reduce((max, p) => Math.max(max, p.wordCount), 0)
    if (newValue <= maxSubmitted) return
    if (newValue === settings.wordsPerPlayer) return
    setWordsInput(String(newValue))
    saveField('wordsPerPlayer', newValue)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players.length])

  // Propagate validity to parent so Start Game can be gated
  useEffect(() => {
    onValidityChange(wordsError === null && timerError === null)
  }, [wordsError, timerError, onValidityChange])

  async function saveField(field: 'wordsPerPlayer' | 'turnDurationSeconds', value: number, extra?: Partial<GameSettings>) {
    const res = await fetch(`/api/games/${joinCode}/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, [field]: value, ...extra }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      // Use the ref to get the authoritative server value at the time the response arrives
      const revertValue = settingsRef.current[field]
      if (field === 'wordsPerPlayer') {
        setWordsError(body.error ?? 'Could not save setting')
        setWordsInput(String(revertValue))
      } else {
        setTimerError(body.error ?? 'Could not save setting')
        setTimerInput(String(revertValue))
      }
    }
  }

  function handleWordsBlur() {
    const n = Number(wordsInput)
    if (!Number.isInteger(n) || n < 1 || n > 20) {
      setWordsError('Must be a whole number between 1 and 20')
      return
    }
    setWordsError(null)
    if (n !== settings.wordsPerPlayer) saveField('wordsPerPlayer', n, { wordsPerPlayerManuallySet: true })
  }

  function handleTimerBlur() {
    const n = Number(timerInput)
    if (!Number.isInteger(n) || n < 5 || n > 600) {
      setTimerError('Must be a whole number between 5 and 600')
      return
    }
    setTimerError(null)
    if (n !== settings.turnDurationSeconds) saveField('turnDurationSeconds', n)
  }

  if (!isHost) {
    return (
      <div className="mt-4 rounded-xl bg-white px-4 py-3 text-sm text-gray-600">
        <p className="mb-2 font-semibold text-gray-700">Game Settings</p>
        <p>Words per player: <span className="font-medium">{settings.wordsPerPlayer}</span></p>
        <p>Round timer: <span className="font-medium">{settings.turnDurationSeconds}s</span></p>
      </div>
    )
  }

  return (
    <div className="mt-4 rounded-xl bg-white px-4 py-3 text-sm">
      <p className="mb-3 font-semibold text-gray-700">Game Settings</p>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-gray-600">Words per player (1–20)</span>
          <input
            type="number"
            min={1}
            max={20}
            value={wordsInput}
            onChange={(e) => {
              setWordsInput(e.target.value)
              setHasManuallyEdited(true)
            }}
            onBlur={handleWordsBlur}
            className="rounded-lg border border-gray-200 px-3 py-2 text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-coral"
          />
          {wordsError
            ? <p className="text-xs text-red-500">{wordsError}</p>
            : <p className="text-xs text-gray-400">
                {hasManuallyEdited
                  ? 'Manually set — auto-calculation paused'
                  : players.length < 4
                    ? 'Auto-calculation starts once 4+ players have joined'
                    : `Auto-calculated based on ${players.length} players`}
              </p>
          }
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-gray-600">Round timer in seconds (5–600)</span>
          <input
            type="number"
            min={5}
            max={600}
            value={timerInput}
            onChange={(e) => setTimerInput(e.target.value)}
            onBlur={handleTimerBlur}
            className="rounded-lg border border-gray-200 px-3 py-2 text-gray-900 focus:outline-none focus:ring-2 focus:ring-brand-coral"
          />
          {timerError && <p className="text-xs text-red-500">{timerError}</p>}
        </label>
      </div>
    </div>
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

function PencilIcon() {
  return (
    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  )
}
