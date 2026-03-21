import { useNavigate } from 'react-router-dom'
import { Logo } from '../components/Logo'

export function HomePage() {
  const navigate = useNavigate()

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-brand-cream px-4">
      <Logo />

      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-sm">
        <div className="flex flex-col gap-3">
          <button
            onClick={() => navigate('/create')}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-coral px-6 py-4 text-base font-semibold text-white transition-opacity hover:opacity-90"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z" />
            </svg>
            Create Game
          </button>

          <button
            onClick={() => navigate('/join')}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-muted px-6 py-4 text-base font-semibold text-gray-700 transition-opacity hover:opacity-90"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
            </svg>
            Join Game
          </button>
        </div>
      </div>

      <p className="text-sm text-gray-400">Play the classic Hat Game digitally</p>
    </div>
  )
}
