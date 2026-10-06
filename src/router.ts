import { useSyncExternalStore } from 'react'

// Hash routing: the app is a static PWA and must work from any host path.

export function navigate(path: string): void {
  window.location.hash = path
}

function currentPath(): string {
  return window.location.hash.replace(/^#/, '') || '/'
}

export function useRoute(): string {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener('hashchange', listener)
      return () => window.removeEventListener('hashchange', listener)
    },
    currentPath,
  )
}
