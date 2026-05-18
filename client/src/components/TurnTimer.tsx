import { CountdownCircleTimer } from 'react-countdown-circle-timer'

interface TurnTimerProps {
  duration: number
  turnStartedAt: string
  label: string
  clockOffset: number
}

export function TurnTimer({ duration, turnStartedAt, label, clockOffset }: TurnTimerProps) {
  const initialRemainingTime = Math.max(
    0,
    duration - (Date.now() + clockOffset - Date.parse(turnStartedAt)) / 1000,
  )

  return (
    <div className="flex flex-col items-center gap-3">
      <p className="text-sm font-medium text-gray-600">{label}</p>
      <CountdownCircleTimer
        isPlaying
        duration={duration}
        initialRemainingTime={initialRemainingTime}
        colors={['#22c55e', '#eab308', '#ef4444']}
        colorsTime={[duration, Math.floor(duration / 2), 0]}
        size={200}
        strokeWidth={12}
      >
        {({ remainingTime }) => (
          <span className="text-5xl font-bold text-gray-900">{remainingTime}</span>
        )}
      </CountdownCircleTimer>
    </div>
  )
}
