import { randomUUID } from 'crypto'
import type { Word } from '@wordfetti/shared'
import { AppError } from '../errors.js'

export class EnteredWords {
  private readonly _words = new Map<string, Word[]>()

  add(playerId: string, text: string, limit: number): Word {
    const current = this._words.get(playerId) ?? []
    if (current.length >= limit) {
      throw new AppError('WORD_LIMIT_REACHED', `You can only submit ${limit} words`)
    }
    const word: Word = { id: randomUUID(), text: text.trim() }
    this._words.set(playerId, [...current, word])
    return word
  }

  delete(playerId: string, wordId: string): void {
    const current = this._words.get(playerId) ?? []
    const filtered = current.filter((w) => w.id !== wordId)
    if (filtered.length === current.length) throw new AppError('NOT_FOUND', 'Word not found')
    this._words.set(playerId, filtered)
  }

  get(playerId: string): Word[] {
    return [...(this._words.get(playerId) ?? [])]
  }

  getCount(playerId: string): number {
    return this._words.get(playerId)?.length ?? 0
  }

  anyExceedsLimit(limit: number): boolean {
    for (const words of this._words.values()) {
      if (words.length > limit) return true
    }
    return false
  }

  total(): number {
    let count = 0
    for (const words of this._words.values()) count += words.length
    return count
  }

  toWordList(): Word[] {
    return [...this._words.values()].flat()
  }

  groupedByPlayer(playerNames: Map<string, string>): Array<{ submitterName: string; words: string[] }> {
    return [...this._words.entries()]
      .filter(([id]) => playerNames.has(id))
      .map(([id, words]) => ({
        submitterName: playerNames.get(id)!,
        words: words.map((w) => w.text).sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => a.submitterName.localeCompare(b.submitterName))
  }
}
