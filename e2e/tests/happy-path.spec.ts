import { test, expect, Browser, BrowserContext, Page } from '@playwright/test'
import {
  createGame,
  joinGame,
  patchSettings,
  submitWord,
  getGame,
  pollGame,
} from '../helpers/api'
import { injectSession } from '../helpers/session'
import type { GameSnapshot } from '@wordfetti/shared'

type PlayerHandle = { context: BrowserContext; page: Page; id: string }

async function makeContext(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext()
  const page = await context.newPage()
  return { context, page }
}

async function playTurn(
  joinCode: string,
  handles: PlayerHandle[],
  action: 'skip-wait-timer' | 'guess-all',
): Promise<GameSnapshot> {
  const game = await getGame(joinCode)
  const cgId = game.currentClueGiverId!
  const cg = handles.find(h => h.id === cgId)!

  await cg.page.bringToFront()

  await cg.page.getByRole('button', { name: 'Start Turn' }).click()
  await pollGame(joinCode, g => g.turnPhase === 'active')

  if (action === 'skip-wait-timer') {
    await cg.page.getByRole('button', { name: 'Skip' }).click()
    return pollGame(joinCode, g => g.turnPhase === 'ready' || g.status === 'between_rounds', 12_000)
  }

  while (true) {
    const g = await getGame(joinCode)
    if (g.turnPhase !== 'active' || !g.currentWord) break
    await cg.page.getByRole('button', { name: 'Guessed!' }).click()
    await new Promise(r => setTimeout(r, 150))
  }
  return pollGame(joinCode, g => g.status === 'between_rounds' || g.status === 'awaiting_extra_round_decision', 8_000)
}

test('4-player happy path — 3 rounds, results and stats', async ({ browser }) => {
  const h1 = await makeContext(browser) // host (team 1)
  const h2 = await makeContext(browser) // player 2 (team 1)
  const h3 = await makeContext(browser) // player 3 (team 2)
  const h4 = await makeContext(browser) // player 4 (team 2)

  try {
    const { joinCode, player: p1 } = await createGame('Alice', 1)
    await patchSettings(joinCode, p1.id, {
      wordsPerPlayer: 1,
      turnDurationSeconds: 5,
      wordsPerPlayerManuallySet: true,
    })

    const { player: p2 } = await joinGame(joinCode, 'Bob', 1)
    const { player: p3 } = await joinGame(joinCode, 'Carol', 2)
    const { player: p4 } = await joinGame(joinCode, 'Dave', 2)

    const handles: PlayerHandle[] = [
      { ...h1, id: p1.id },
      { ...h2, id: p2.id },
      { ...h3, id: p3.id },
      { ...h4, id: p4.id },
    ]

    await injectSession(h1.context, joinCode, p1.id)
    await injectSession(h2.context, joinCode, p2.id)
    await injectSession(h3.context, joinCode, p3.id)
    await injectSession(h4.context, joinCode, p4.id)

    await submitWord(joinCode, p1.id, 'apple')
    await submitWord(joinCode, p2.id, 'banana')
    await submitWord(joinCode, p3.id, 'cherry')
    await submitWord(joinCode, p4.id, 'dragon')

    await Promise.all(handles.map(h => h.page.goto(`/lobby/${joinCode}`)))

    await expect(h1.page.getByText('Alice')).toBeVisible()
    await expect(h1.page.getByText('Bob')).toBeVisible()
    await expect(h1.page.getByText('Carol')).toBeVisible()
    await expect(h1.page.getByText('Dave')).toBeVisible()

    await h1.page.getByRole('button', { name: 'Start Game' }).click()
    await pollGame(joinCode, g => g.status === 'in_progress')

    await Promise.all(handles.map(h => h.page.goto(`/game/${joinCode}`)))

    // Round 1, Turn 1: skip once then wait for timer
    await playTurn(joinCode, handles, 'skip-wait-timer')
    const afterT1 = await getGame(joinCode)
    expect(afterT1.turnEndReason).toBe('timeout')
    expect(afterT1.status).toBe('in_progress')
    expect(afterT1.round).toBe(1)

    // Round 1, Turn 2: guess all words (hat empties, round ends)
    await playTurn(joinCode, handles, 'guess-all')
    const afterR1 = await getGame(joinCode)
    expect(afterR1.status).toBe('between_rounds')
    expect(afterR1.turnEndReason).toBe('round_complete')
    expect(afterR1.round).toBe(1)

    await expect(h2.page.getByText(/waiting for the host/i)).toBeVisible()

    // Round transition 1 → 2
    await h1.page.goto(`/game/${joinCode}`)
    await expect(h1.page.getByText('Round 1 is over!')).toBeVisible()
    await h1.page.getByRole('button', { name: 'Start Round 2' }).click()
    await pollGame(joinCode, g => g.status === 'in_progress' && g.round === 2)

    // Round 2: one turn guesses all words
    await playTurn(joinCode, handles, 'guess-all')
    const afterR2 = await getGame(joinCode)
    expect(afterR2.status).toBe('between_rounds')
    expect(afterR2.round).toBe(2)

    // Round transition 2 → 3
    await h1.page.goto(`/game/${joinCode}`)
    await h1.page.getByRole('button', { name: 'Start Round 3' }).click()
    await pollGame(joinCode, g => g.status === 'in_progress' && g.round === 3)

    // Round 3: one turn guesses all words, game ends
    await playTurn(joinCode, handles, 'guess-all')
    await pollGame(joinCode, g => g.status === 'awaiting_extra_round_decision')

    // Host ends the game (no extra round)
    await h1.page.goto(`/game/${joinCode}`)
    await h1.page.getByRole('button', { name: 'End Game' }).click()
    await pollGame(joinCode, g => g.status === 'finished')

    // Results page
    await Promise.all(handles.map(h => h.page.goto(`/game/${joinCode}/results`)))
    for (const h of handles) {
      await expect(h.page.getByText('Game Over!')).toBeVisible()
    }

    // 1 word × 4 players × 3 rounds = 12 total points
    const finalGame = await getGame(joinCode)
    const { team1, team2 } = finalGame.scores!
    expect(team1 + team2).toBe(12)
    expect(team1).toBeGreaterThan(0)
    expect(team2).toBeGreaterThan(0)

    // Stats page
    await h1.page.getByRole('button', { name: 'View stats' }).click()
    await expect(h1.page.getByText('Game Stats')).toBeVisible()
    await expect(h1.page.getByRole('heading', { name: 'Alice' })).toBeVisible()
    await expect(h1.page.getByText('apple').first()).toBeVisible()

  } finally {
    await Promise.all([h1.context.close(), h2.context.close(), h3.context.close(), h4.context.close()])
  }
})
