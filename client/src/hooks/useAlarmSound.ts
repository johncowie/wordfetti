import { useCallback, useEffect, useRef, useState } from 'react'

export function useAlarmSound(isHost: boolean, turnPhase: string | undefined) {
  const prevTurnPhaseRef = useRef<string | undefined>(undefined)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    setIsPlaying(false)
  }, [])

  useEffect(() => {
    if (turnPhase === 'active' && audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
      setIsPlaying(false)
    } else if (isHost && prevTurnPhaseRef.current === 'active' && turnPhase !== 'active') {
      const audio = new Audio('/assets/sounds/alarm-clock-sound-effect.mp3')
      audioRef.current = audio
      setIsPlaying(true)
      audio.play().catch(() => {
        audioRef.current = null
        setIsPlaying(false)
      })
      audio.addEventListener('ended', () => {
        audioRef.current = null
        setIsPlaying(false)
      })
    }
    if (turnPhase !== undefined) {
      prevTurnPhaseRef.current = turnPhase
    }
  }, [isHost, turnPhase])

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
    }
  }, [])

  return { isPlaying, stop }
}
