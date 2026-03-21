import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Team } from '@wordfetti/shared'
import { Logo } from '../components/Logo'
import { TeamSelector } from '../components/TeamSelector'
import { saveSession } from '../session'

export function JoinPage() {
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [team, setTeam] = useState<Team | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const joinCode = code.trim().toUpperCase()
    const trimmedName = name.trim()

    if (!joinCode) return setError('Please enter the game code.')
    if (!trimmedName) return setError('Please enter your name.')
    if (!team) return setError('Please pick a team.')

    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/games/${joinCode}/players`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, team }),
      })
      if (res.status === 404) {
        setError('Game not found. Check the code and try again.')
        return
      }
      if (!res.ok) throw new Error(`Unexpected response: ${res.status}`)
      const { player } = await res.json()
      saveSession({ playerId: player.id, joinCode })
      navigate(`/game/${joinCode}`)
    } catch (err) {
      console.error('Failed to join game:', err)
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
          <h1 className="text-xl font-semibold text-gray-900">Join a Game</h1>
          <p className="mt-1 text-sm text-gray-500">Enter the code from your host</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="code" className="text-sm font-medium text-gray-700">
              Game Code
            </label>
            <input
              id="code"
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="XXXXXX"
              maxLength={6}
              className="rounded-lg border border-gray-200 px-4 py-3 text-center font-mono text-lg uppercase tracking-widest outline-none focus:border-brand-coral focus:ring-1 focus:ring-brand-coral"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="name" className="text-sm font-medium text-gray-700">
              Your Name
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter your name"
              maxLength={50}
              className="rounded-lg border border-gray-200 px-4 py-3 text-sm outline-none focus:border-brand-coral focus:ring-1 focus:ring-brand-coral"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span id="join-team-label" className="text-sm font-medium text-gray-700">Pick Your Team</span>
            <TeamSelector id="join-team-label" value={team} onChange={setTeam} />
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
            {loading ? 'Joining...' : 'Join Game →'}
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
