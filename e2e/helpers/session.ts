import type { BrowserContext } from '@playwright/test'

export async function injectSession(
  context: BrowserContext,
  joinCode: string,
  playerId: string,
): Promise<void> {
  await context.addInitScript(
    ({ key, value }: { key: string; value: string }) => localStorage.setItem(key, value),
    { key: 'wordfetti_session', value: JSON.stringify({ joinCode, playerId }) },
  )
}
