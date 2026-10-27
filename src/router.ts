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

// A link to the app can open a LibreTexts page: ?page=<library>-<id>, or the
// bare ?<library>-<id>. It becomes the route /page/<value>; Create checks the
// value and looks the page up. Any other query is left alone.
export function pageLinkRoute(search: string): string | null {
  const params = new URLSearchParams(search)
  let value = params.get('page')
  if (value === null) {
    const keys = [...params.keys()]
    if (keys.length !== 1 || search.includes('=') || !/^[a-z0-9]+-\d+$/i.test(keys[0])) return null
    value = keys[0]
  }
  return `/page/${encodeURIComponent(value)}`
}

export function pageLinkFromRoute(route: string): string | undefined {
  const match = route.match(/^\/page\/(.*)$/)
  if (!match) return undefined
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}
