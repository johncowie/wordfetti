import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TurnTimer } from './TurnTimer'

// Expose initialRemainingTime as a data attribute so tests can assert on its value.
vi.mock('react-countdown-circle-timer', () => ({
  CountdownCircleTimer: ({ initialRemainingTime, children }: {
    initialRemainingTime: number
    children: (props: { remainingTime: number }) => React.ReactNode
  }) => (
    <div data-testid="timer" data-initial-remaining={initialRemainingTime}>
      {children({ remainingTime: Math.round(initialRemainingTime) })}
    </div>
  ),
}))

describe('TurnTimer', () => {
  it('applies clockOffset when computing initialRemainingTime', () => {
    const duration = 60
    // Turn started 10 real seconds ago; server clock is 5s ahead of client
    const turnStartedAt = new Date(Date.now() - 10_000).toISOString()
    const clockOffset = 5_000

    render(
      <TurnTimer
        duration={duration}
        turnStartedAt={turnStartedAt}
        label="Time"
        clockOffset={clockOffset}
      />
    )
    // elapsed = (Date.now() + 5000 - (Date.now() - 10000)) / 1000 = 15s
    // initialRemainingTime = 60 - 15 = 45
    expect(screen.getByText('45')).toBeTruthy()
  })

  it('applies clockOffset = 0 correctly (no change to remaining time)', () => {
    const duration = 60
    const turnStartedAt = new Date(Date.now() - 10_000).toISOString()

    render(
      <TurnTimer
        duration={duration}
        turnStartedAt={turnStartedAt}
        label="Time"
        clockOffset={0}
      />
    )
    expect(screen.getByText('50')).toBeTruthy()
  })

  it('passes fractional initialRemainingTime so two devices stay in sync', () => {
    const duration = 60
    // Turn started 10.5s ago. With Math.floor this would be floor(10.5)=10 → 50s remaining,
    // causing two devices that mounted at e.g. 10.2s and 10.7s to both get 50 and then drift
    // by 0.5s. Without Math.floor each device gets ~49.5 and they stay locked together.
    const turnStartedAt = new Date(Date.now() - 10_500).toISOString()

    render(
      <TurnTimer duration={duration} turnStartedAt={turnStartedAt} label="Time" clockOffset={0} />
    )

    const initialRemainingTime = parseFloat(
      screen.getByTestId('timer').getAttribute('data-initial-remaining')!
    )
    // With Math.floor present this would be 50.0. Without it, it's ~49.5.
    expect(initialRemainingTime).toBeLessThan(50)
    expect(initialRemainingTime).toBeGreaterThan(49)
  })
})
