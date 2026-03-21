import type { Team } from '@wordfetti/shared'

type Props = {
  id: string
  value: Team | null
  onChange: (team: Team) => void
}

export function TeamSelector({ id, value, onChange }: Props) {
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
        Team 1
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
        Team 2
      </button>
    </div>
  )
}
