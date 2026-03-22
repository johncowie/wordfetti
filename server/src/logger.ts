const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 } as const
type Level = keyof typeof LEVELS

const configured = (process.env.LOG_LEVEL?.toUpperCase() ?? 'INFO') as Level
const threshold = LEVELS[configured] ?? LEVELS.INFO

function log(level: Level, message: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return
  const entry = data
    ? `[${level}] ${message} ${JSON.stringify(data)}`
    : `[${level}] ${message}`
  if (level === 'ERROR' || level === 'WARN') {
    console.error(entry)
  } else {
    console.log(entry)
  }
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => log('DEBUG', msg, data),
  info:  (msg: string, data?: Record<string, unknown>) => log('INFO',  msg, data),
  warn:  (msg: string, data?: Record<string, unknown>) => log('WARN',  msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log('ERROR', msg, data),
}
