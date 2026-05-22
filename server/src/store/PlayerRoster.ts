import type { BestClueGiver, Player, Team } from '@wordfetti/shared'

export function normaliseName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

export class PlayerRoster {
  private _players: Player[]
  private _lastClueGiverId: Record<Team, string | undefined>

  constructor(
    players: Player[] = [],
    lastClueGiverId: Record<Team, string | undefined> = { 1: undefined, 2: undefined },
  ) {
    this._players = [...players]
    this._lastClueGiverId = { ...lastClueGiverId }
  }

  getAll(): Player[] {
    return [...this._players]
  }

  getActive(): Player[] {
    return this._players.filter((p) => p.active)
  }

  getById(id: string): Player | undefined {
    return this._players.find((p) => p.id === id)
  }

  getByTeam(team: Team): Player[] {
    return this._players.filter((p) => p.team === team && p.active)
  }

  some(predicate: (p: Player) => boolean): boolean {
    return this._players.some(predicate)
  }

  hasDuplicateName(name: string): boolean {
    const normalised = normaliseName(name)
    return this._players.some((p) => normaliseName(p.name) === normalised)
  }

  getIdToNameMap(): Map<string, string> {
    return new Map(this._players.map((p) => [p.id, p.name]))
  }

  /** Add a new player with active: true and zeroed stats. Returns the created Player. */
  add(player: Omit<Player, 'active' | 'stats'>): Player {
    const full: Player = { ...player, active: true, stats: { clueGiverCount: 0 } }
    this._players.push(full)
    return full
  }

  kick(playerId: string): void {
    const player = this._players.find((p) => p.id === playerId)
    if (player) player.active = false
  }

  incrementStat(playerId: string): void {
    const player = this._players.find((p) => p.id === playerId)
    if (player) player.stats.clueGiverCount++
  }

  resetStats(): void {
    for (const player of this._players) player.stats.clueGiverCount = 0
  }

  getBestClueGiver(): BestClueGiver | null {
    const withStats = this._players.filter((p) => p.stats.clueGiverCount > 0)
    if (withStats.length === 0) return null
    const max = Math.max(...withStats.map((p) => p.stats.clueGiverCount))
    const names = withStats
      .filter((p) => p.stats.clueGiverCount === max)
      .map((p) => p.name)
      .sort((a, b) => a.localeCompare(b))
    return { names, clueCount: max }
  }

  /**
   * Find the next active player on `team` after the last assigned clue giver,
   * advance the pointer, and return that player.
   *
   * Active players are evaluated in join order. If the last assigned player is
   * no longer active (kicked), findIndex returns -1 and the method wraps to
   * index 0 — correct because a kicked clue giver sits at the end of their
   * rotation slot.
   */
  assignNextClueGiver(team: Team): Player {
    const activePlayers = this.getByTeam(team)
    if (activePlayers.length === 0) throw new Error(`No active players on team ${team}`)
    const lastId = this._lastClueGiverId[team]
    const lastIdx = lastId !== undefined ? activePlayers.findIndex((p) => p.id === lastId) : -1
    const nextIdx = (lastIdx + 1) % activePlayers.length
    const next = activePlayers[nextIdx]
    this._lastClueGiverId[team] = next.id
    return next
  }
}
