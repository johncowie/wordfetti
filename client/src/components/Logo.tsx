export function Logo() {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative inline-block">
        <span className="text-4xl font-extrabold text-gray-900">Word</span>
        <span className="text-4xl font-extrabold text-brand-coral">fetti</span>
        <svg
          className="absolute -right-5 -top-2 h-5 w-5 text-brand-teal"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z" />
        </svg>
      </div>
      <p className="text-sm text-gray-500">The Digital Hat Game</p>
    </div>
  )
}
