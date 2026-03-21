import { useParams } from 'react-router-dom'
import { Logo } from '../components/Logo'

export function GameCodePage() {
  const { joinCode } = useParams<{ joinCode: string }>()

  if (!joinCode) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-cream">
        <p className="text-gray-600">Invalid game link.</p>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-brand-cream px-4">
      <Logo />

      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-sm">
        <div className="flex flex-col items-center gap-4 text-center">
          <h1 className="text-xl font-semibold text-gray-800">Game Created!</h1>
          <p className="text-sm text-gray-500">Share this code with your players</p>

          <figure aria-label={`Join code: ${joinCode}`} className="mt-2 w-full">
            <div className="rounded-xl bg-brand-cream px-6 py-6">
              <span className="font-mono text-5xl font-bold tracking-widest text-gray-900">
                {joinCode}
              </span>
            </div>
          </figure>

          <p className="text-xs text-gray-400">Read it out loud or write it on the board</p>
        </div>
      </div>

      <p className="text-sm text-gray-400">Play the classic Hat Game digitally</p>
    </div>
  )
}
