export type Team = 1 | 2

export const WORDS_PER_PLAYER = 5

export type Word = {
  id: string
  text: string
}

export type Player = {
  id: string
  name: string
  team: Team
}

export type Game = {
  id: string
  joinCode: string
  status: 'lobby' | 'in_progress' | 'finished'
  players: Player[]
  hostId?: string
}
