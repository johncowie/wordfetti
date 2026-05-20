import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { BestClueGiver, GameStats, SubmitterWords } from '@wordfetti/shared'

type Duplication = {
  word: string
  count: number
  players: string[]
}

function computeDuplications(wordsBySubmitter: SubmitterWords[]): Duplication[] {
  const wordToPlayers = new Map<string, string[]>()
  const wordToDisplay = new Map<string, string>()
  for (const { submitterName, words } of wordsBySubmitter) {
    for (const raw of words) {
      const key = raw.trim().toLowerCase()
      const existing = wordToPlayers.get(key) ?? []
      wordToPlayers.set(key, [...existing, submitterName])
      if (!wordToDisplay.has(key)) wordToDisplay.set(key, raw.trim())
    }
  }
  return [...wordToPlayers.entries()]
    .filter(([, players]) => players.length >= 2)
    .map(([key, players]) => ({ word: wordToDisplay.get(key)!, count: players.length, players }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
}

function DuplicationsSection({ wordsBySubmitter }: { wordsBySubmitter: SubmitterWords[] }) {
  const duplications = computeDuplications(wordsBySubmitter)
  if (duplications.length === 0) return null
  return (
    <section className="w-full max-w-md rounded-2xl bg-brand-muted px-6 py-6">
      <p className="mb-4 text-xs font-semibold uppercase tracking-widest text-gray-400">Duplications</p>
      <div className="flex flex-col gap-4">
        {duplications.map(({ word, count, players }) => (
          <div key={word}>
            <p className="text-sm font-semibold text-gray-900">
              {word} — {count}
            </p>
            <p className="text-xs text-gray-500">{players.join(', ')}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function BestClueGiverSection({ bestClueGiver }: { bestClueGiver: BestClueGiver | null }) {
  if (!bestClueGiver) return null
  const label = bestClueGiver.names.length === 1 ? 'Best clue giver' : 'Best clue givers'
  const names = bestClueGiver.names.join(', ')
  return (
    <section className="w-full max-w-md rounded-2xl bg-brand-coral px-6 py-5 text-white shadow-md">
      <p className="mb-1 text-xs font-semibold uppercase tracking-widest opacity-80">{label}</p>
      <p className="text-2xl font-bold">{names}</p>
      <p className="mt-1 text-sm opacity-80">
        <span className="font-bold">{bestClueGiver.clueCount}</span> of their {bestClueGiver.clueCount === 1 ? 'clue was' : 'clues were'} guessed correctly
      </p>
    </section>
  )
}

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

      <BestClueGiverSection bestClueGiver={stats.bestClueGiver} />

      <DuplicationsSection wordsBySubmitter={stats.wordsBySubmitter} />

      {stats.wordsBySubmitter.length === 0 ? (
        <p className="text-gray-400">No words were submitted for this game.</p>
      ) : (
        <div className="w-full max-w-md rounded-2xl bg-brand-muted px-6 py-6">
          <p className="mb-4 text-xs font-semibold uppercase tracking-widest text-gray-400">Words submitted</p>
          <div className="flex flex-col gap-6">
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
        </div>
      )}
    </main>
  )
}
