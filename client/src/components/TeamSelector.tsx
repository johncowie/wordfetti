import type { Team } from '@wordfetti/shared'

type Props = {
  id: string
  value: Team | null
  onChange: (team: Team) => void
  team1Label?: string
  team2Label?: string
}

export function TeamSelector({ id, value, onChange, team1Label = 'Team 1', team2Label = 'Team 2' }: Props) {
  return (
    <div role="radiogroup" aria-labelledby={id} className="flex gap-3">
      <button
        type="button"
        role="radio"
        aria-checked={value === 1}
        onClick={() => onChange(1)}
        className={`flex-1 rounded-xl py-3 text-sm font-semibold transition-colors ${
          value === 1
            ? 'bg-brand-coral text-white'
            : 'bg-brand-muted text-gray-600 hover:bg-red-100'
        }`}
      >
        {team1Label}
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={value === 2}
        onClick={() => onChange(2)}
        className={`flex-1 rounded-xl py-3 text-sm font-semibold transition-colors ${
          value === 2
            ? 'bg-brand-teal text-white'
            : 'bg-brand-muted text-gray-600 hover:bg-teal-100'
        }`}
      >
        {team2Label}
      </button>
    </div>
  )
}
