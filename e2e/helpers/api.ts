import type { GameSnapshot, GameSettings } from '@wordfetti/shared'

const BASE = process.env.API_BASE_URL ?? 'http://localhost:3000'

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${method} ${path} → ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

export async function createGame(hostName: string, team: 1 | 2) {
  return request<{ joinCode: string; player: { id: string; name: string; team: number } }>(
    'POST', '/api/games', { name: hostName, team }
  )
}

export async function joinGame(joinCode: string, name: string, team: 1 | 2) {
  return request<{ player: { id: string; name: string; team: number } }>(
    'POST', `/api/games/${joinCode}/players`, { name, team }
  )
}

export async function patchSettings(joinCode: string, playerId: string, settings: Partial<GameSettings> & { wordsPerPlayerManuallySet?: boolean }) {
  return request('PATCH', `/api/games/${joinCode}/settings`, { playerId, ...settings })
}

export async function submitWord(joinCode: string, playerId: string, text: string) {
  return request('POST', `/api/games/${joinCode}/words`, { playerId, text })
}

export async function getGame(joinCode: string): Promise<GameSnapshot> {
  return request<GameSnapshot>('GET', `/api/games/${joinCode}`)
}

export async function pollGame(
  joinCode: string,
  predicate: (g: GameSnapshot) => boolean,
  timeoutMs = 15_000,
): Promise<GameSnapshot> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const g = await getGame(joinCode)
    if (predicate(g)) return g
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`pollGame timed out after ${timeoutMs}ms`)
}
