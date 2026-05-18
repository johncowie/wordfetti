import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useClockOffset } from './useClockOffset'

const mockFetch = vi.fn()
global.fetch = mockFetch

function makeFetchResponse(serverTime: number) {
  return Promise.resolve({
    json: () => Promise.resolve({ now: serverTime }),
  })
}

// Advance just enough for in-flight promises to resolve without triggering the
// 2-minute re-sync interval.
async function flushAsync() {
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
}

describe('useClockOffset', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

  it('initialises to 0 with clockOffsetReady false', () => {
    mockFetch.mockReturnValue(new Promise(() => {})) // never resolves
    const { result } = renderHook(() => useClockOffset())
    expect(result.current.clockOffset).toBe(0)
    expect(result.current.clockOffsetReady).toBe(false)
  })

  it('updates to the computed offset after pings resolve', async () => {
    // Simulate server 200ms ahead of client
    mockFetch.mockImplementation(() => {
      const now = Date.now()
      return makeFetchResponse(now + 200)
    })
    const { result } = renderHook(() => useClockOffset())
    await flushAsync()
    expect(result.current.clockOffset).toBeCloseTo(200, -1)
    expect(result.current.clockOffsetReady).toBe(true)
  })

  it('falls back to 0 when all fetches reject', async () => {
    mockFetch.mockRejectedValue(new Error('network error'))
    const { result } = renderHook(() => useClockOffset())
    await flushAsync()
    expect(result.current.clockOffset).toBe(0)
    expect(result.current.clockOffsetReady).toBe(false)
  })

  it('falls back to 0 when /api/time returns a non-numeric now', async () => {
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ now: 'bad' }),
    })
    const { result } = renderHook(() => useClockOffset())
    await flushAsync()
    expect(result.current.clockOffset).toBe(0)
    expect(result.current.clockOffsetReady).toBe(false)
  })

  it('produces a result from the pings that succeed when one rejects', async () => {
    // One ping rejects (simulates a timed-out/failed ping reaching Promise.allSettled).
    // Other four succeed with server 200ms ahead.
    let call = 0
    mockFetch.mockImplementation(() => {
      call++
      if (call === 1) return Promise.reject(new Error('connection refused'))
      return makeFetchResponse(Date.now() + 200)
    })
    const { result } = renderHook(() => useClockOffset())
    await flushAsync()
    // 4 of 5 pings fulfilled — minimum-RTT selection picks ~200ms offset
    expect(result.current.clockOffset).toBeCloseTo(200, -1)
    expect(result.current.clockOffsetReady).toBe(true)
  })

  it('re-syncs after 2 minutes with updated offset', async () => {
    let call = 0
    mockFetch.mockImplementation(() => {
      call++
      return makeFetchResponse(Date.now() + (call <= 5 ? 100 : 300))
    })
    const { result } = renderHook(() => useClockOffset())
    await flushAsync()
    expect(result.current.clockOffset).toBeCloseTo(100, -1)
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 100) })
    expect(result.current.clockOffset).toBeCloseTo(300, -1)
  })
})
