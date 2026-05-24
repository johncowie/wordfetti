import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Logo } from '../components/Logo'

export function JoinPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [code, setCode] = useState(() => (searchParams.get('code') ?? '').toUpperCase())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const joinCode = code.trim().toUpperCase()
    if (!joinCode) return setError('Please enter the game code.')
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/games/${joinCode}`)
      if (!res.ok) {
        setError('Game not found. Check the code and try again.')
        return
      }
      navigate(`/lobby/${joinCode}`)
    } catch {
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
            {loading ? 'Checking...' : 'Find Game →'}
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
