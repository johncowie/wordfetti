import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { logger } from './logger.js'

export function loadTeamNames(): string[] {
  try {
    const filePath = join(dirname(fileURLToPath(import.meta.url)), '../assets/team-names.txt')
    const raw = readFileSync(filePath, 'utf-8')
    return raw.split('\n').map((l) => l.trim()).filter(Boolean)
  } catch (err) {
    logger.warn('Could not load team-names.txt, falling back to defaults', { error: String(err) })
    return ['Team 1', 'Team 2']
  }
}

export function pickTeamNames(pool: string[]): { team1: string; team2: string } {
  if (pool.length < 2) return { team1: 'Team 1', team2: 'Team 2' }
  const idx1 = Math.floor(Math.random() * pool.length)
  const team1 = pool[idx1]
  const remaining = pool.filter((_, i) => i !== idx1)
  const team2 = remaining[Math.floor(Math.random() * remaining.length)]
  return { team1, team2 }
}
