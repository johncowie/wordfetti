import { useEffect, useState } from 'react'

const PING_COUNT = 5

async function singlePing(): Promise<{ offset: number; rtt: number }> {
  const t0 = Date.now()
  const res = await fetch('/api/time', { signal: AbortSignal.timeout(2000) })
  const t1 = Date.now()  // captured before JSON parsing to exclude parse time from RTT
  const { now: serverTime } = await res.json()
  if (typeof serverTime !== 'number' || !Number.isFinite(serverTime)) {
    throw new Error('unexpected /api/time response shape')
  }
  return { offset: serverTime - (t0 + t1) / 2, rtt: t1 - t0 }
}

async function measureClockOffset(): Promise<number> {
  const results = await Promise.allSettled(
    Array.from({ length: PING_COUNT }, singlePing)
  )
  const samples = results
    .filter((r): r is PromiseFulfilledResult<{ offset: number; rtt: number }> => r.status === 'fulfilled')
    .map(r => r.value)
  if (samples.length === 0) throw new Error('all pings failed')
  // Pick the sample with the minimum RTT — it had the least queueing delay so
  // the symmetric-latency midpoint assumption is most accurate. Max error = RTT/2.
  return samples.reduce((best, s) => s.rtt < best.rtt ? s : best).offset
}

export function useClockOffset(): { clockOffset: number; clockOffsetReady: boolean } {
  const [clockOffset, setClockOffset] = useState(0)
  const [clockOffsetReady, setClockOffsetReady] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function sync() {
      try {
        const offset = await measureClockOffset()
        if (!cancelled) {
          setClockOffset(offset)
          setClockOffsetReady(true)
        }
      } catch (err) {
        console.warn('[useClockOffset] clock sync failed, using offset 0:', err)
        // fall back to 0 — current behaviour; clockOffsetReady remains false
      }
    }

    sync()
    const interval = setInterval(sync, 2 * 60 * 1000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  return { clockOffset, clockOffsetReady }
}
