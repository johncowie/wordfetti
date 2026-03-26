export type Team = 1 | 2

export type GameSettings = {
  wordsPerPlayer: number
  turnDurationSeconds: number
}

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
  status: 'lobby' | 'in_progress' | 'between_rounds' | 'finished'
  round?: 1 | 2 | 3   // undefined before game starts; 1 after startGame
  players: Player[]
  hostId?: string
  activeTeam?: 1 | 2
  currentClueGiverId?: string
  turnPhase?: 'ready' | 'active'
  scores?: { team1: number; team2: number }
  currentWord?: string
  guessedThisTurn?: string[]
  turnStartedAt?: string   // ISO timestamp set when turnPhase transitions to 'active'; intentionally public — client uses it for countdown display
  settings: GameSettings
}
