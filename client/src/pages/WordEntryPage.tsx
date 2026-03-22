import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { WORDS_PER_PLAYER, type Word } from '@wordfetti/shared'
import { loadSession } from '../session'

export function WordEntryPage() {
  const { joinCode } = useParams<{ joinCode: string }>()
  const navigate = useNavigate()
  const [session] = useState(() => loadSession())

  useEffect(() => {
    if (!session || session.joinCode !== joinCode) {
      navigate(`/game/${joinCode}`, { replace: true })
    }
  }, [session, joinCode, navigate])

  const [words, setWords] = useState<Word[]>([])
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!session) return
    fetch(`/api/games/${joinCode}/words?playerId=${session.playerId}`)
      .then((res) => res.json())
      .then((data) => {
        setWords(data.words)
        setLoading(false)
      })
      .catch(() => {
        setError('Could not load your words. Please refresh.')
        setLoading(false)
      })
  }, [joinCode, session])

  const atLimit = words.length >= WORDS_PER_PLAYER
  const remaining = WORDS_PER_PLAYER - words.length

  async function handleAdd() {
    if (!session || !input.trim()) return
    setError(null)
    const res = await fetch(`/api/games/${joinCode}/words`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: session.playerId, text: input.trim() }),
    })
    if (res.ok) {
      const { word } = await res.json()
      setWords((prev) => [...prev, word])
      setInput('')
    } else {
      const body = await res.json().catch(() => ({}))
      setError(body.error ?? 'Failed to add word')
    }
  }

  async function handleDelete(wordId: string) {
    if (!session) return
    setError(null)
    const res = await fetch(`/api/games/${joinCode}/words/${wordId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: session.playerId }),
    })
    if (res.ok) {
      setWords((prev) => prev.filter((w) => w.id !== wordId))
    } else {
      const body = await res.json().catch(() => ({}))
      setError(body.error ?? 'Failed to delete word')
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-cream">
        <p role="status" className="text-gray-500">Loading…</p>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-brand-cream">
      {/* Header */}
      <div className="relative flex items-center px-4 pt-6 pb-4">
        <button
          onClick={() => navigate(`/game/${joinCode}`)}
          className="absolute left-4 text-gray-500 hover:text-gray-700"
          aria-label="Back to lobby"
        >
          ←
        </button>
        <div className="mx-auto text-center">
          <h1 className="text-xl font-bold text-gray-900">Your Words</h1>
          <p className="text-sm text-gray-500">Add words for others to guess</p>
        </div>
        <span className="absolute right-4 rounded-full bg-brand-coral px-2.5 py-1 text-xs font-semibold text-white">
          {words.length}/{WORDS_PER_PLAYER}
        </span>
      </div>

      {/* Progress bar */}
      <div className="mx-4 h-2 overflow-hidden rounded-full bg-gray-200">
        <div
          className="h-full rounded-full bg-brand-coral transition-all"
          style={{ width: `${(words.length / WORDS_PER_PLAYER) * 100}%` }}
        />
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-4 p-4">
        {!atLimit && (
          <p className="text-sm text-gray-600">
            Add {remaining} more word{remaining === 1 ? '' : 's'}
          </p>
        )}

        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            disabled={atLimit}
            placeholder="Enter a word or phrase"
            className="flex-1 rounded-lg border border-gray-200 px-4 py-3 outline-none focus:border-brand-coral focus:ring-1 focus:ring-brand-coral disabled:opacity-50"
          />
          <button
            onClick={handleAdd}
            disabled={atLimit || !input.trim()}
            className="rounded-xl bg-brand-coral px-4 py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            +
          </button>
        </div>

        <p className="text-xs text-gray-400">
          Think of words, names, phrases, or pop culture references!
        </p>

        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        {words.length > 0 && (
          <ol className="flex flex-col gap-2">
            {words.map((word, i) => (
              <li
                key={word.id}
                className="flex items-center justify-between rounded-xl bg-white px-4 py-3 shadow-sm"
              >
                <div className="flex items-center">
                  <span className="mr-3 text-sm font-semibold text-gray-400">{i + 1}</span>
                  <span className="text-sm text-gray-900">{word.text}</span>
                </div>
                <button
                  onClick={() => handleDelete(word.id)}
                  className="text-gray-400 transition-colors hover:text-red-500"
                  aria-label={`Delete ${word.text}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Back to Lobby button */}
      <div className="p-4">
        <button
          onClick={() => navigate(`/game/${joinCode}`)}
          className="w-full rounded-xl border border-gray-200 bg-white px-6 py-3.5 text-sm font-semibold text-gray-700 transition-opacity hover:opacity-90"
        >
          Back to Lobby ({words.length}/{WORDS_PER_PLAYER})
        </button>
      </div>
    </div>
  )
}
