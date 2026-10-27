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
// bare ?<library>-<id> next to any other parameters. It gives the same address
// with no query and the route /page/<page> as its hash, or null when the link
// names no page. Create checks the page and looks it up.
export function pageLinkAddress(href: string): string | null {
  const url = new URL(href)
  let page = url.searchParams.get('page')
  if (page === null) {
    const bare = [...url.searchParams].filter(([key, value]) => value === '' && PAGE_LINK.test(key))
    if (bare.length !== 1) return null
    page = bare[0][0]
  }
  url.search = ''
  url.hash = `/page/${encodeURIComponent(page)}`
  return url.href
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
