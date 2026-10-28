// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../lib/storage/db'
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

const CONTENTS = { body: '<p>Melquíades llegó a Macondo con una tribu de gitanos que vendían imanes y lupas.</p>' }
// The bundled catalog, cut down to the book above, a book listed under
// "mixed", a code that is not a license, and one under CK-12's own license.
// The app loads it once per test file.
const CATALOG = {
  generatedAt: '2026-10-06T03:25:33.782Z',
  books: [
    {
      id: 'human-378400',
      t: '¡HOLA! Spanish 3 (Tseng, Rosales, and Lemari)',
      a: 'Beatrice Tseng, Karla Lemari, Lisbeth Rosales',
      l: 'human',
      s: 'Languages',
      c: '',
      lic: 'ccbyncsa',
      u: 'https://human.libretexts.org/Bookshelves/Languages/Spanish',
      n: 1,
    },
    { id: 'human-378401', t: 'Lecturas mixtas', a: '', l: 'human', s: '', c: '', lic: 'mixed', u: 'https://human.libretexts.org/Lecturas', n: 1 },
    { id: 'human-378402', t: 'Álgebra básica', a: 'CK12', l: 'human', s: '', c: '', lic: 'ck12', u: 'https://human.libretexts.org/Algebra', n: 1 },
  ],
}

const found = (target: string) =>
  target.endsWith('catalog.json')
    ? CATALOG
    : target.includes('/contents')
      ? CONTENTS
      : target.includes('/tree')
        ? TREE
        : target.includes('/pages/=')
          ? BOOK
          : PAGE

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

beforeEach(async () => {
  await db.sources.clear()
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
    button: (label: string) => [...container.querySelectorAll('button')].find((button) => button.textContent === label),
    copied: () => container.querySelector('[role="status"]')?.textContent,
    shownLink: () => container.querySelector<HTMLInputElement>('input[readonly][aria-label="Link to this page"]'),
  }
}

// The browser's clipboard, or none at all where the Clipboard API is missing.
function clipboard(available = true) {
  const writeText = vi.fn(async (_text: string) => {})
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: available ? { writeText } : undefined })
  return writeText
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

  it('copies a link that opens the app on the page, and says so for a moment', async () => {
    libreTexts()
    const writeText = clipboard()
    vi.useFakeTimers({ toFake: ['setTimeout'], shouldAdvanceTime: true })
    try {
      const view = await openLink('human-378488')
      await act(async () => view.button('Copy link')!.click())
      expect(writeText).toHaveBeenCalledWith(`${location.origin}/?page=human-378488`)
      expect(view.copied()).toBe('Link copied')
      await act(async () => vi.advanceTimersByTime(2100))
      expect(view.copied() ?? '').toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the link, selected, where the browser cannot copy', async () => {
    libreTexts()
    clipboard(false)
    const view = await openLink('human-378488')
    await act(async () => view.button('Copy link')!.click())
    const shown = view.shownLink()!
    expect(shown.value).toBe(`${location.origin}/?page=human-378488`)
    expect(document.activeElement).toBe(shown)
    expect([shown.selectionStart, shown.selectionEnd]).toEqual([0, shown.value.length])
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

const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)

// Ticks one chapter, section or page in the page picker.
const tick = (title: string) =>
  act(async () =>
    [...document.querySelectorAll('.toc-label')]
      .find((label) => label.querySelector('span')?.firstChild?.textContent === title)!
      .querySelector('input')!
      .click(),
  )

// Finds the book in book search, ticks its content pages (or just the part
// named) and continues.
async function chooseInBookSearch(
  continueLabel: string,
  title = '¡HOLA! Spanish 3 (Tseng, Rosales, and Lemari)',
  part?: string,
) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(<Create />))
  cleanup = () => {
    act(() => root.unmount())
    container.remove()
  }
  await settle()
  const search = container.querySelector<HTMLInputElement>('input[type="search"]')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, title)
  await act(async () => search.dispatchEvent(new Event('input', { bubbles: true })))
  const result = container.querySelector<HTMLButtonElement>('.result-list button')!
  expect(result.querySelector('strong')?.textContent).toBe(title)
  await act(async () => result.click())
  await settle()
  if (part) await tick(part)
  else await act(async () => button('Select all content')!.click())
  await act(async () => button(continueLabel)!.click())
  await settle()
}

const tocNode = (id: string, title: string, children: object[] = []) => ({
  '@id': id,
  title,
  'uri.ui': `https://human.libretexts.org/Bookshelves/Languages/Spanish/HOLA/${id}`,
  subpages: children.length > 0 ? { page: children } : '',
})
// A book with two chapters, the first holding two pages.
const BOOK_TREE = {
  page: tocNode('378400', BOOK.title, [
    tocNode('1', '1: Saludos', [tocNode('1.1', '1.1: Hola'), tocNode('1.2', '1.2: Adiós')]),
    tocNode('2', '2: La familia', [tocNode('2.1', '2.1: Mi familia')]),
  ]),
}
// The book's cover page, for a link to the whole book.
const COVER = {
  '@id': '378400',
  title: BOOK.title,
  path: { '#text': 'Bookshelves/Languages/Spanish' },
  'uri.ui': 'https://human.libretexts.org/Bookshelves/Languages/Spanish',
  tags: PAGE.tags,
}
const bookTree = (target: string) =>
  target.includes('/tree') ? BOOK_TREE : target.includes('/pages/378400?') ? COVER : found(target)

describe('opening one book after another in book search', () => {
  it('shows and saves the pages of the book open now when an earlier book’s contents arrive late', async () => {
    // 378401 is "Lecturas mixtas", with a page of its own.
    const OTHER_TREE = { page: tocNode('378401', 'Lecturas mixtas', [tocNode('9.1', '9.1: Lectura')]) }
    let answerFirstBook = () => {}
    const firstBookAnswered = new Promise<void>((resolve) => (answerFirstBook = resolve))
    const fetch = libreTexts(async (target) => {
      if (target.includes('/378400/tree')) {
        await firstBookAnswered
        return BOOK_TREE
      }
      if (target.includes('/378401/tree')) return OTHER_TREE
      return found(target)
    })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => root.render(<Create />))
    cleanup = () => {
      act(() => root.unmount())
      container.remove()
    }
    await settle()
    // Going back draws the search field again, so it is looked up each time.
    const openBook = async (title: string) => {
      const search = container.querySelector<HTMLInputElement>('input[type="search"]')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, title)
      await act(async () => search.dispatchEvent(new Event('input', { bubbles: true })))
      await act(async () => container.querySelector<HTMLButtonElement>('.result-list button')!.click())
    }
    await openBook('¡HOLA! Spanish 3 (Tseng, Rosales, and Lemari)')
    await act(async () => button('Back to search results')!.click())
    await openBook('Lecturas mixtas')
    await settle()
    const firstBookLoad = fetch.mock.calls.find(([url]) => url.includes('/378400/tree')) as unknown as [string, RequestInit]
    expect(firstBookLoad[1].signal?.aborted).toBe(true)
    await act(async () => answerFirstBook())
    await settle()

    expect(container.querySelector('h2')?.textContent).toBe('Lecturas mixtas')
    const shown = [...container.querySelectorAll('.toc-label span')].map((span) => span.firstChild?.textContent)
    expect(shown).toContain('9.1: Lectura')
    expect(shown).not.toContain('1: Saludos')
    await act(async () => button('Select all content')!.click())
    await act(async () => button('Continue with 1 page')!.click())
    await settle()
    const [source] = await db.sources.toArray()
    expect(source.pages.map((page) => page.title)).toEqual(['9.1: Lectura'])
    expect(source.book?.title).toBe('Lecturas mixtas')
  })
})

describe('crediting the book a source comes from', () => {
  it('keeps the book and its authors for a page from a link', async () => {
    libreTexts()
    await openLink('human-378488')
    await act(async () => button('Continue with 1 page')!.click())
    await settle()
    const [source] = await db.sources.toArray()
    expect(source).toMatchObject({ title: PAGE.title, url: PAGE['uri.ui'], kind: 'page' })
    expect(source.book).toEqual({
      title: 'HOLA Spanish 3 (Tseng Rosales and Lemari)',
      author: 'Beatrice Tseng, Karla Lemari, Lisbeth Rosales',
    })
  })

  it('credits a linked page on its own when the catalog lists no book above it', async () => {
    const path = 'Bookshelves/Languages/French/Nouveau/01/1.01'
    const url = `https://human.libretexts.org/${path}`
    const page = { ...PAGE, path: { '#text': path }, 'uri.ui': url }
    libreTexts((target) =>
      target.includes('/tree') ? { page: { ...TREE.page, 'uri.ui': url } } : target.includes('/pages/378488?') ? page : found(target),
    )
    const view = await openLink('human-378488')
    expect(view.text()).not.toContain('From “')
    await act(async () => button('Continue with 1 page')!.click())
    await settle()
    const [source] = await db.sources.toArray()
    expect(source).toMatchObject({ title: PAGE.title, url, license: { code: 'ccbyncsa', label: 'CC BY-NC-SA 4.0', version: '4.0' } })
    expect(source.book).toBeUndefined()
  })

  it('keeps the book and its authors for pages chosen in book search', async () => {
    libreTexts()
    await chooseInBookSearch('Continue with 1 page')
    const [source] = await db.sources.toArray()
    expect(source.book).toEqual({
      title: '¡HOLA! Spanish 3 (Tseng, Rosales, and Lemari)',
      author: 'Beatrice Tseng, Karla Lemari, Lisbeth Rosales',
    })
  })

  it('names pages from one chapter in book search by the chapter, from the book', async () => {
    libreTexts(bookTree)
    await chooseInBookSearch('Continue with 2 pages', undefined, '1: Saludos')
    const [source] = await db.sources.toArray()
    expect(source).toMatchObject({
      title: '1: Saludos',
      url: 'https://human.libretexts.org/Bookshelves/Languages/Spanish/HOLA/1',
      kind: 'section',
      book: { title: '¡HOLA! Spanish 3 (Tseng, Rosales, and Lemari)', author: 'Beatrice Tseng, Karla Lemari, Lisbeth Rosales' },
    })
  })

  it('names pages from across chapters in book search by the book’s own title', async () => {
    libreTexts(bookTree)
    await chooseInBookSearch('Continue with 3 pages')
    const [source] = await db.sources.toArray()
    expect(source).toMatchObject({ title: '¡HOLA! Spanish 3 (Tseng, Rosales, and Lemari)', url: CATALOG.books[0].u, kind: 'book' })
    expect(source.title).toBe(source.book?.title)
  })

  it('names pages from one chapter of a linked book by the chapter, from the book', async () => {
    libreTexts(bookTree)
    await openLink('human-378400')
    await act(async () => button('Clear')!.click())
    await tick('1: Saludos')
    await act(async () => button('Continue with 2 pages')!.click())
    await settle()
    const [source] = await db.sources.toArray()
    expect(source).toMatchObject({
      title: '1: Saludos',
      url: 'https://human.libretexts.org/Bookshelves/Languages/Spanish/HOLA/1',
      kind: 'section',
      book: { title: 'HOLA Spanish 3 (Tseng Rosales and Lemari)' },
    })
  })

  it('names no license for a book the catalog lists under a code that is not a license', async () => {
    libreTexts()
    await chooseInBookSearch('Continue with 1 page', 'Lecturas mixtas')
    const [source] = await db.sources.toArray()
    expect(source.license).toBeNull()
  })

  it('names CK-12’s own license for a book the catalog lists under it', async () => {
    libreTexts()
    await chooseInBookSearch('Continue with 1 page', 'Álgebra básica')
    const [source] = await db.sources.toArray()
    expect(source.license).toEqual({ code: 'ck12', label: 'CK-12 License', version: null })
  })
})
