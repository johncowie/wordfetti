import type { Word } from '@wordfetti/shared'

function shuffle<T>(arr: T[]): T[] {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

export class Hat {
  private _words: Word[]
  private readonly _originalWords: Word[]
  private _skippedThisTurn: string[]
  private _currentWordId: string | undefined
  private _currentWord: string | undefined

  constructor(words: Word[]) {
    this._originalWords = [...words]
    this._words = shuffle([...words])
    this._skippedThisTurn = []
  }

  get current(): { id: string; text: string } | undefined {
    if (!this._currentWordId || !this._currentWord) return undefined
    return { id: this._currentWordId, text: this._currentWord }
  }

  get isEmpty(): boolean {
    return this._words.length === 0
  }

  get size(): number {
    return this._words.length
  }

  wordTexts(): string[] {
    return this._words.map((w) => w.text)
  }

  get originalWords(): Word[] {
    return [...this._originalWords]
  }

  /** Reset skipped list and set the first word as current. Throws if hat is empty. */
  startTurn(): Word {
    if (this._words.length === 0) throw new Error('Hat is empty')
    this._skippedThisTurn = []
    const first = this._words[0]
    this._currentWordId = first.id
    this._currentWord = first.text
    return first
  }

  /**
   * Remove the current word from the hat, advance to the next word.
   * Returns true if the hat is now empty.
   */
  guess(): boolean {
    if (!this._currentWordId) throw new Error('No current word')
    this._words = this._words.filter((w) => w.id !== this._currentWordId)
    if (this._words.length === 0) {
      this._currentWordId = undefined
      this._currentWord = undefined
      return true
    }
    const next = this._drawNext(null)
    this._currentWordId = next.id
    this._currentWord = next.text
    return false
  }

  /**
   * Mark the current word as skipped and advance to the next word.
   * Returns the word now being described (may be the same word if it's the only one left).
   */
  skip(): Word {
    if (!this._currentWordId) throw new Error('No current word')
    const currentId = this._currentWordId
    const current: Word = { id: currentId, text: this._currentWord! }
    this._skippedThisTurn = [...this._skippedThisTurn, currentId]
    const next = this._drawNext(current)
    this._currentWordId = next.id
    this._currentWord = next.text
    return next
  }

  /** Reshuffle the original word list back into the hat for the next round. */
  refill(): void {
    this._words = shuffle([...this._originalWords])
    this._skippedThisTurn = []
    this._currentWordId = undefined
    this._currentWord = undefined
  }

  private _drawNext(current: Word | null): Word {
    const available = this._words.filter(
      (w) => w.id !== current?.id && !this._skippedThisTurn.includes(w.id),
    )
    if (available.length > 0) return available[0]
    const fallback = this._words.filter((w) => w.id !== current?.id)
    if (fallback.length > 0) return fallback[0]
    return this._words[0]
  }
}
