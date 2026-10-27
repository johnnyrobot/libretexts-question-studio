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

// LibreTexts' proxy, stubbed: page 378488 in the human library as it answered
// on 2026-10-27 (LT-72), cut down to the fields the app reads.
const PAGE = {
  '@id': '378488',
  title: '4.2: La profecía de la gitana',
  path: { '#text': 'Bookshelves/Languages/Spanish/HOLA_Spanish_3_(Tseng_Rosales_and_Lemari)/04/4.02' },
  'uri.ui': 'https://human.libretexts.org/Bookshelves/Languages/Spanish/HOLA_Spanish_3_(Tseng_Rosales_and_Lemari)/04/4.02',
  tags: { tag: [{ '@value': 'license:ccbyncsa' }, { '@value': 'licenseversion:40' }] },
}
const BOOK = { '@id': '378400', title: 'HOLA Spanish 3 (Tseng Rosales and Lemari)', path: { '#text': 'Bookshelves/Languages/Spanish' } }
const TREE = { page: { '@id': '378488', title: PAGE.title, 'uri.ui': PAGE['uri.ui'], subpages: '' } }

const found = (target: string) => (target.includes('/tree') ? TREE : target.includes('/pages/=') ? BOOK : PAGE)

function libreTexts(answer: (target: string) => unknown = found) {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(await answer(url))))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  vi.unstubAllGlobals()
})

// Lets the stubbed lookups reach the page.
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)))

async function openLink(pageLink: string) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() =>
    root.render(
      <StrictMode>
        <Create pageLink={pageLink} />
      </StrictMode>,
    ),
  )
  cleanup = () => {
    act(() => root.unmount())
    container.remove()
  }
  await settle()
  return {
    selectedTab: () => container.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    link: () => container.querySelector<HTMLInputElement>('input[type="url"]')?.value,
    linkFixed: () => container.querySelector<HTMLInputElement>('input[type="url"]')?.readOnly,
    alert: () => container.querySelector('[role="alert"]')?.textContent,
    lookUp: () => container.querySelector<HTMLButtonElement>('button[type="submit"]'),
    text: () => container.textContent ?? '',
  }
}

describe('opening the app on a page link', () => {
  it('looks the page up on the link tab and offers it in the page picker', async () => {
    const fetch = libreTexts()
    const view = await openLink('human-378488')
    expect(view.selectedTab()).toBe('Paste a link')
    expect(view.link()).toBe('https://human.libretexts.org/@go/page/378488')
    expect(fetch).toHaveBeenCalledWith(
      'https://api.libretexts.org/endpoint/cross-library/https://human.libretexts.org/@api/deki/pages/378488?dream.out.format=json',
      expect.anything(),
    )
    expect(view.text()).toContain('4.2: La profecía de la gitana')
    expect(view.text()).toContain('From “HOLA Spanish 3 (Tseng Rosales and Lemari)” · CC BY-NC-SA 4.0')
    expect(view.alert()).toBeUndefined()
  })

  // The link cannot change under the lookup, so the page shown is always the link's.
  it('keeps Look up busy, and the link fixed, until LibreTexts answers', async () => {
    let answer = () => {}
    const answered = new Promise<void>((resolve) => {
      answer = resolve
    })
    libreTexts(async (target) => {
      await answered
      return found(target)
    })
    const view = await openLink('human-378488')
    expect(view.lookUp()?.textContent).toBe('Looking up…')
    expect(view.lookUp()?.disabled).toBe(true)
    expect(view.linkFixed()).toBe(true)
    answer()
    await settle()
    expect(view.lookUp()?.textContent).toBe('Look up')
    expect(view.lookUp()?.disabled).toBe(false)
    expect(view.linkFixed()).toBe(false)
  })

  it('names the libraries, and looks nothing up, for a library LibreTexts does not have', async () => {
    const fetch = libreTexts()
    const view = await openLink('history-378488')
    expect(view.selectedTab()).toBe('Paste a link')
    expect(view.alert()).toBe(
      '“history” is not a LibreTexts library. Use one of bio, biz, chem, eng, espanol, geo, human, k12, math, med, phys, socialsci, stats, workforce.',
    )
    expect(view.link()).toBe('')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('shows why LibreTexts would not share a page behind its token wall', async () => {
    libreTexts(() => ({
      exception: 'MindTouch.Deki.Auth.Exceptions.TokenValidationFailedException',
      resource: 'System.API.Error.developer-token-validation-failed',
    }))
    const view = await openLink('bio-12345')
    expect(view.alert()).toBe(
      "LibreTexts would not share that page right now (it asked for an access token). This is on LibreTexts' side; try again later.",
    )
  })
})

describe('opening the app with no page link', () => {
  it('starts on book search', async () => {
    libreTexts()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => root.render(<Create />))
    cleanup = () => {
      act(() => root.unmount())
      container.remove()
    }
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Find a book')
  })
})
