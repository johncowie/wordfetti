import type { Word } from '@wordfetti/shared'

type HatWord = {
  id: string
  text: string
  shownAt?: number
  guessTimes: number[]
}

function shuffle<T>(arr: T[]): T[] {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

export class Hat {
  private _words: HatWord[]
  private readonly _originalWords: HatWord[]
  private _skippedThisTurn: string[]
  private _current: HatWord | undefined
  private readonly _clock: () => number

  constructor(words: Word[], clock: () => number = Date.now) {
    this._clock = clock
    this._originalWords = words.map(w => ({ ...w, guessTimes: [] }))
    this._words = shuffle([...this._originalWords])
    this._skippedThisTurn = []
  }

  get current(): { id: string; text: string } | undefined {
    return this._current ? { id: this._current.id, text: this._current.text } : undefined
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

  /** Returns per-word timing data accumulated across all rounds. */
  get wordStats(): ReadonlyArray<{ id: string; text: string; guessTimes: number[] }> {
    return this._originalWords.map(({ id, text, guessTimes }) => ({
      id,
      text,
      guessTimes: [...guessTimes],
    }))
  }

  /** Reset skipped list and set the first word as current. Throws if hat is empty. */
  startTurn(): Word {
    if (this._words.length === 0) throw new Error('Hat is empty')
    this._skippedThisTurn = []
    const first = this._words[0]
    first.shownAt = this._clock()
    this._current = first
    return { id: first.id, text: first.text }
  }

  /**
   * Remove the current word from the hat, advance to the next word.
   * Returns true if the hat is now empty.
   */
  guess(): boolean {
    if (!this._current) throw new Error('No current word')
    if (this._current.shownAt !== undefined) {
      this._current.guessTimes.push(this._clock() - this._current.shownAt)
    }
    this._words = this._words.filter((w) => w.id !== this._current!.id)
    if (this._words.length === 0) {
      this._current = undefined
      return true
    }
    const next = this._drawNext(this._current)
    next.shownAt = this._clock()
    this._current = next
    return false
  }

  /**
   * Mark the current word as skipped and advance to the next word.
   * Returns the word now being described (may be the same word if it's the only one left).
   */
  skip(): Word {
    if (!this._current) throw new Error('No current word')
    const currentId = this._current.id
    this._skippedThisTurn = [...this._skippedThisTurn, currentId]
    const next = this._drawNext(this._current)
    next.shownAt = this._clock()
    this._current = next
    return { id: next.id, text: next.text }
  }

  /** Reshuffle the original word list back into the hat for the next round. */
  refill(): void {
    for (const word of this._originalWords) word.shownAt = undefined
    this._words = shuffle([...this._originalWords])
    this._skippedThisTurn = []
    this._current = undefined
  }

  private _drawNext(current: HatWord): HatWord {
    const available = this._words.filter(
      (w) => w.id !== current.id && !this._skippedThisTurn.includes(w.id),
    )
    if (available.length > 0) return available[0]
    const fallback = this._words.filter((w) => w.id !== current.id)
    if (fallback.length > 0) return fallback[0]
    return this._words[0]
  }
}
