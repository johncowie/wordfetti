import { randomInt } from 'crypto'

// Excludes visually ambiguous characters: 0, O, 1, I, L
const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function generateJoinCode(): string {
  return Array.from({ length: 6 }, () => CHARS[randomInt(CHARS.length)]).join('')
}
