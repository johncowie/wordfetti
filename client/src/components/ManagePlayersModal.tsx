import { useState } from 'react'
import type { Player } from '@wordfetti/shared'

interface Props {
  joinCode: string
  players: Player[]
  hostPlayerId: string
  onClose: () => void
}

export function ManagePlayersModal({ joinCode, players, hostPlayerId, onClose }: Props) {
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const nonHostPlayers = players.filter((p) => p.id !== hostPlayerId)
  const confirmTarget = nonHostPlayers.find((p) => p.id === confirmId)

  async function kick(targetPlayerId: string) {
    setError(null)
    const res = await fetch(`/api/games/${joinCode}/players/${targetPlayerId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: hostPlayerId }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError((body as { error?: string }).error ?? 'Failed to kick player')
    }
    setConfirmId(null)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-label="Manage Players"
    >
      <div className="bg-brand-cream rounded-2xl p-6 w-full max-w-sm mx-4 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">Manage Players</h2>
          <button onClick={onClose} aria-label="Close" className="text-2xl leading-none">×</button>
        </div>

        {confirmTarget ? (
          <div>
            <p className="mb-4">
              Are you sure you want to kick <strong>{confirmTarget.name}</strong> out of the game?
            </p>
            <div className="flex gap-3">
              <button
                className="flex-1 bg-brand-coral text-white rounded-xl py-2 font-semibold"
                onClick={() => kick(confirmTarget.id)}
              >
                Kick
              </button>
              <button
                className="flex-1 border border-gray-300 rounded-xl py-2"
                onClick={() => setConfirmId(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <ul className="space-y-2">
            {nonHostPlayers.map((p) => (
              <li
                key={p.id}
                className={`flex items-center justify-between py-2 border-b last:border-0 ${!p.active ? 'opacity-40' : ''}`}
              >
                <span>
                  {p.name}{' '}
                  <span className="text-sm text-gray-500">Team {p.team}</span>
                  {!p.active && <span className="ml-2 text-xs text-gray-400">(kicked)</span>}
                </span>
                {p.active && (
                  <button
                    aria-label={`Kick ${p.name}`}
                    onClick={() => setConfirmId(p.id)}
                    className="text-brand-coral hover:text-red-600"
                  >
                    <BootIcon />
                  </button>
                )}
              </li>
            ))}
            {nonHostPlayers.length === 0 && (
              <li className="text-gray-500 text-sm">No other players in the game.</li>
            )}
          </ul>
        )}

        {error && <p role="alert" className="mt-3 text-red-600 text-sm">{error}</p>}
      </div>
    </div>
  )
}

function BootIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 20h14" />
      <path d="M6 20V8l4-4h2v6h4a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H6" />
    </svg>
  )
}
