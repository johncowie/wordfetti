export type Team = 1 | 2

export const WORDS_PER_PLAYER = 2
export const TURN_DURATION_SECONDS = 5

export type Word = {
  id: string
  text: string
}

export type Player = {
  id: string
  name: string
  team: Team
  wordCount: number
}

export type Game = {
  id: string
  joinCode: string
  status: 'lobby' | 'in_progress' | 'round_over' | 'finished'
  players: Player[]
  hostId?: string
  activeTeam?: 1 | 2
  currentClueGiverId?: string
  turnPhase?: 'ready' | 'active'
  scores?: { team1: number; team2: number }
  currentWord?: string
  guessedThisTurn?: string[]
  turnStartedAt?: string   // ISO timestamp set when turnPhase transitions to 'active'; intentionally public — client uses it for countdown display
}
