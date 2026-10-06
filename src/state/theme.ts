import { useSyncExternalStore } from 'react'

// Light by default; dark is an opt-in remembered per device. index.html reads
// the same key before the first paint so a dark page never flashes light.

export type Theme = 'light' | 'dark'

const KEY = 'question-studio-theme'
const listeners = new Set<() => void>()

function stored(): Theme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

let current: Theme = stored()

export function setTheme(theme: Theme): void {
  current = theme
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // Storage blocked (private window): the choice lasts for this visit.
  }
  listeners.forEach((listener) => listener())
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
  )
}
