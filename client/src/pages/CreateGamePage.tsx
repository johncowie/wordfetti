import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Team } from '@wordfetti/shared'
import { Logo } from '../components/Logo'
import { TeamSelector } from '../components/TeamSelector'
import { saveSession } from '../session'

export function CreateGamePage() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [team, setTeam] = useState<Team | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) return setError('Please enter your name.')
    if (!team) return setError('Please pick a team.')

    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, team }),
      })
      if (!res.ok) throw new Error(`Unexpected response: ${res.status}`)
      const { joinCode, player } = await res.json()
      saveSession({ playerId: player.id, joinCode })
      navigate(`/game/${joinCode}`)
    } catch (err) {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-brand-cream px-4">
      <Logo />

      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold text-gray-900">Create a Game</h1>
          <p className="mt-1 text-sm text-gray-500">You'll be the host</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="create-name" className="text-sm font-medium text-gray-700">
              Your Name
            </label>
            <input
              id="create-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter your name"
              maxLength={50}
              className="rounded-lg border border-gray-200 px-4 py-3 text-sm outline-none focus:border-brand-coral focus:ring-1 focus:ring-brand-coral"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span id="create-team-label" className="text-sm font-medium text-gray-700">
              Pick Your Team
            </span>
            <TeamSelector id="create-team-label" value={team} onChange={setTeam} />
          </div>

          {error && (
            <p role="alert" className="text-center text-sm text-red-600">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            aria-busy={loading}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-coral px-6 py-3.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {loading ? 'Creating...' : 'Create Game →'}
          </button>
        </form>
      </div>

      <Link to="/" className="text-sm text-gray-500 hover:text-gray-700">
        Go Back
      </Link>

      <p className="text-sm text-gray-400">Play the classic Hat Game digitally</p>
    </div>
  )
}
