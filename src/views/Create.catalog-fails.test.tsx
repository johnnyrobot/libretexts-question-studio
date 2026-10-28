// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Create } from './Create'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Its own file because the app keeps the book list it loaded for the rest of a
// file, so the book list in Create.test.tsx always arrives; here it never does
// (LT-97).

// LibreTexts' proxy, stubbed: the cover page of ¡HOLA! Spanish 3, cut down to
// the fields the app reads.
const BOOK_COVER = {
  '@id': '378400',
  title: 'HOLA Spanish 3 (Tseng Rosales and Lemari)',
  path: { '#text': 'Bookshelves/Languages/Spanish/HOLA_Spanish_3_(Tseng_Rosales_and_Lemari)' },
  'uri.ui': 'https://human.libretexts.org/Bookshelves/Languages/Spanish/HOLA_Spanish_3_(Tseng_Rosales_and_Lemari)',
  tags: { tag: [{ '@value': 'license:ccbyncsa' }, { '@value': 'licenseversion:40' }] },
}
const BOOK_TREE = { page: { '@id': '378400', title: BOOK_COVER.title, 'uri.ui': BOOK_COVER['uri.ui'], subpages: '' } }

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  vi.unstubAllGlobals()
})

// Lets the stubbed lookups reach the page.
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)))

describe('opening the app on a book link when the book list cannot load', () => {
  it('looks the book up on Paste a link, by its cover page', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('catalog.json')
        ? new Response('Service Unavailable', { status: 503 })
        : new Response(JSON.stringify(url.includes('/tree') ? BOOK_TREE : BOOK_COVER)),
    )
    vi.stubGlobal('fetch', fetch)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() =>
      root.render(
        <StrictMode>
          <Create bookLink="human-378400" />
        </StrictMode>,
      ),
    )
    cleanup = () => {
      act(() => root.unmount())
      container.remove()
    }
    await settle()

    expect(fetch.mock.calls.some(([url]) => url.endsWith('catalog.json'))).toBe(true)
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Paste a link')
    expect(container.querySelector<HTMLInputElement>('input[type="url"]')?.value).toBe(
      'https://human.libretexts.org/@go/page/378400',
    )
    expect(fetch.mock.calls.some(([url]) => url.includes('/pages/378400'))).toBe(true)
    expect(container.textContent).toContain(BOOK_COVER.title)
  })
})
