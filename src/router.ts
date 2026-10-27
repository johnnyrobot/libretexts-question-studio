import { useSyncExternalStore } from 'react'
import { PAGE_LINK } from './lib/content/libretexts'

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
// bare ?<library>-<id> next to any other parameters. The address it should
// have instead is the route /page/<value>, with no query and in place of any
// hash; Create checks the value and looks the page up. A link that names no
// page gives null.
export function pageLinkAddress(href: string): string | null {
  const url = new URL(href)
  let value = url.searchParams.get('page')
  if (value === null) {
    const bare = [...url.searchParams].filter(([key, rest]) => rest === '' && PAGE_LINK.test(key))
    if (bare.length !== 1) return null
    value = bare[0][0]
  }
  return `${url.pathname}#/page/${encodeURIComponent(value)}`
}

// The page a /page/<value> route names, or undefined for any other route.
export function pageLinkFromRoute(route: string): string | undefined {
  const match = route.match(/^\/page\/(.*)$/)
  if (!match) return undefined
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}
