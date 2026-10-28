// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { Create } from './Create'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Its own file because the app loads the book list once per file: here that
// one load fails (LT-97).

// LibreTexts' proxy, stubbed: the cover page of ¡HOLA! Spanish 3, cut down to
// the fields the app reads.
const COVER = {
  '@id': '378400',
  title: 'HOLA Spanish 3 (Tseng Rosales and Lemari)',
  path: { '#text': 'Bookshelves/Languages/Spanish/HOLA_Spanish_3_(Tseng_Rosales_and_Lemari)' },
  'uri.ui': 'https://human.libretexts.org/Bookshelves/Languages/Spanish/HOLA_Spanish_3_(Tseng_Rosales_and_Lemari)',
  tags: { tag: [{ '@value': 'license:ccbyncsa' }, { '@value': 'licenseversion:40' }] },
}
const TREE = { page: { '@id': '378400', title: COVER.title, 'uri.ui': COVER['uri.ui'], subpages: '' } }

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  vi.unstubAllGlobals()
})

it('looks up a linked book on Paste a link, by its cover page, when the book list cannot load', async () => {
  const fetch = vi.fn(async (url: string) =>
    url.endsWith('catalog.json')
      ? new Response('Service Unavailable', { status: 503 })
      : new Response(JSON.stringify(url.includes('/tree') ? TREE : COVER)),
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
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)))

  expect(fetch.mock.calls.some(([url]) => url.endsWith('catalog.json'))).toBe(true)
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Paste a link')
  expect(container.querySelector<HTMLInputElement>('input[type="url"]')?.value).toBe(
    'https://human.libretexts.org/@go/page/378400',
  )
  expect(container.textContent).toContain(COVER.title)
})
