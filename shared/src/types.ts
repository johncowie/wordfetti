export type Team = 1 | 2

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
