import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useGameState } from './useGameState'
import type { GameSnapshot } from '@wordfetti/shared'

const mockFetch = vi.fn()
global.fetch = mockFetch

type MockEventSource = {
  onopen: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onerror: (() => void) | null
  close: () => void
}

let mockES: MockEventSource

vi.stubGlobal('EventSource', vi.fn().mockImplementation(() => {
  mockES = { onopen: null, onmessage: null, onerror: null, close: vi.fn() }
  return mockES
}))

const fakeGame: GameSnapshot = {
  id: 'game-1',
  joinCode: 'TEST',
  status: 'in_progress',
  players: [],
  turnPhase: 'ready',
  guessedThisTurn: [],
  scores: { team1: 0, team2: 0 },
  teamNames: { team1: 'Red', team2: 'Blue' },
  round: 1,
  hostId: 'p1',
  settings: { turnDurationSeconds: 60, wordsPerPlayer: 5 },
}

beforeEach(() => {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(fakeGame),
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useGameState', () => {
  it('starts with connected false', () => {
    const { result } = renderHook(() => useGameState('TEST'))
    expect(result.current.connected).toBe(false)
  })

  it('sets connected to true when SSE opens', () => {
    const { result } = renderHook(() => useGameState('TEST'))
    act(() => { mockES.onopen?.() })
    expect(result.current.connected).toBe(true)
  })

  it('sets connected to false when SSE errors', () => {
    const { result } = renderHook(() => useGameState('TEST'))
    act(() => { mockES.onopen?.() })
    expect(result.current.connected).toBe(true)
    act(() => { mockES.onerror?.() })
    expect(result.current.connected).toBe(false)
  })

  it('applies SSE message updates to game state', () => {
    const { result } = renderHook(() => useGameState('TEST'))
    const updated = { ...fakeGame, scores: { team1: 3, team2: 1 } }
    act(() => { mockES.onmessage?.({ data: JSON.stringify(updated) }) })
    expect(result.current.game?.scores?.team1).toBe(3)
  })

  it('exposes setGame so callers can apply HTTP response state directly', async () => {
    const { result } = renderHook(() => useGameState('TEST'))
    await act(async () => {})
    const updated = { ...fakeGame, currentWord: 'elephant' }
    act(() => { result.current.setGame(updated) })
    expect(result.current.game?.currentWord).toBe('elephant')
  })
})
