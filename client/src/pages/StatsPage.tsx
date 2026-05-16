import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { GameStats } from '@wordfetti/shared'

export function StatsPage() {
  const { joinCode } = useParams<{ joinCode: string }>()
  const [stats, setStats] = useState<GameStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!joinCode) return
    const controller = new AbortController()
    fetch(`/api/games/${joinCode}/stats`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`)
        return res.json() as Promise<GameStats>
      })
      .then(setStats)
      .catch((err) => {
        if (err.name === 'AbortError') return
        setError('Could not load stats.')
      })
    return () => controller.abort()
  }, [joinCode])

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-cream">
        <p role="alert" className="text-gray-600">{error}</p>
      </div>
    )
  }

  if (!stats) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-cream">
        <p role="status" className="text-gray-400">Loading stats...</p>
      </div>
    )
  }

  return (
    <main className="flex min-h-screen flex-col items-center gap-8 bg-brand-cream px-4 py-12">
      <h1 className="text-3xl font-bold text-gray-900">Game Stats</h1>

      {stats.wordsBySubmitter.length === 0 ? (
        <p className="text-gray-400">No words were submitted for this game.</p>
      ) : (
        <div className="flex w-full max-w-md flex-col gap-6">
          {stats.wordsBySubmitter.map(({ submitterName, words }) => (
            <section key={submitterName}>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
                {submitterName}
              </h2>
              <ul className="flex flex-col gap-2">
                {words.map((word) => (
                  <li
                    key={word}
                    className="rounded-xl bg-white px-4 py-3 text-sm text-gray-900 shadow-sm"
                  >
                    {word}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </main>
  )
}
