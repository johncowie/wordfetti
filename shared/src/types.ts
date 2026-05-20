export type Team = 1 | 2

export type GameSettings = {
  wordsPerPlayer: number
  turnDurationSeconds: number
  wordsPerPlayerManuallySet?: boolean
}

export type Word = {
  id: string
  text: string
}

export type SubmitterWords = {
  submitterName: string
  words: string[]
}

export type BestClueGiver = {
  names: string[]
  clueCount: number
}

export type WordDifficultyStat = {
  word: string
  avgMs: number
}

export type WordDifficultyStats = {
  easiest: WordDifficultyStat[]
  hardest: WordDifficultyStat[]
}

export type GameStats = {
  wordsBySubmitter: SubmitterWords[]
  bestClueGiver: BestClueGiver | null
  wordDifficulty: WordDifficultyStats | null
}

export type Player = {
  id: string
  name: string
  team: Team
  wordCount: number
  active: boolean
  stats: {
    clueGiverCount: number
  }
}

export type GameSnapshot = {
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
  teamNames: { team1: string; team2: string }
  settings: GameSettings
}
