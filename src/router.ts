import { useSyncExternalStore } from 'react'
import { PAGE_LINK } from './lib/content/libretexts'

// Hash routing: every route is the one index.html, so a static host needs no
// rewrite rules.

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
// names no page. Create checks the page and looks it up. A link to a book in
// book search, ?book=<catalog id>, gives the route /book/<id> instead (LT-94).
export function pageLinkAddress(href: string): string | null {
  const url = new URL(href)
  const book = url.searchParams.get('book')
  if (book !== null) {
    url.search = ''
    url.hash = `/book/${encodeURIComponent(book)}`
    return url.href
  }
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

// A link that opens the app, at the address it runs from now, on a
// LibreTexts page: ?page=<library>-<id>, which pageLinkAddress reads back.
export function pageLinkFor(library: string, pageId: string, here = window.location.href): string {
  const url = new URL(here)
  url.search = ''
  url.hash = ''
  url.searchParams.set('page', `${library}-${pageId}`)
  return url.href
}

// A link that opens the app, at the address it runs from now, on a book in
// book search: ?book=<catalog id>, which pageLinkAddress reads back.
export function bookLinkFor(bookId: string, here = window.location.href): string {
  const url = new URL(here)
  url.search = ''
  url.hash = ''
  url.searchParams.set('book', bookId)
  return url.href
}

// The page a /page/<value> route names, or undefined for any other route.
export const pageLinkFromRoute = (route: string) => linkFromRoute('page', route)

// The catalog book a /book/<value> route names, or undefined for any other route.
export const bookLinkFromRoute = (route: string) => linkFromRoute('book', route)

function linkFromRoute(kind: 'page' | 'book', route: string): string | undefined {
  if (!route.startsWith(`/${kind}/`)) return undefined
  const value = route.slice(kind.length + 2)
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
