import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveUrl } from './sources'

// The bundled catalog, cut down to the books these tests need. The app loads
// it once per test file, so every test shares it.
const CATALOG = {
  generatedAt: '2026-10-06T03:25:33.782Z',
  books: [
    {
      id: 'human-309694',
      t: '¡HOLA! Spanish 3 (Tseng, Rosales, and Lemari)',
      a: 'Beatrice Tseng, Karla Lemari, Lisbeth Rosales',
      l: 'human', s: '', c: 'Irvine Valley College', lic: 'ccbyncsa',
      u: 'https://human.libretexts.org/Courses/Irvine_Valley_College/HOLA_Spanish_3_(Tseng_Rosales_and_Lemari)',
      n: 666,
    },
    // A book filed on a sub-shelf, four segments deep.
    {
      id: 'human-120001', t: 'On y va! French I', a: 'Ana Ruiz', l: 'human', s: '', c: '', lic: 'ccby',
      u: 'https://human.libretexts.org/Bookshelves/Languages/French/On_y_va%3A_French_I', n: 210,
    },
    // A book with one of its own pages listed as a book too.
    {
      id: 'human-130001', t: 'Critical Thinking Through Literature', a: 'Heather Ringo', l: 'human', s: '', c: '',
      lic: 'ccby', u: 'https://human.libretexts.org/Courses/Butte_College/Critical_Thinking', n: 880,
    },
    {
      id: 'human-130555', t: '5.9: Wilde, Oscar', a: 'Heather Ringo', l: 'human', s: '', c: '', lic: 'ccby',
      u: 'https://human.libretexts.org/Courses/Butte_College/Critical_Thinking/05/5.09%3A_Wilde', n: null,
    },
  ],
}
const HOLA = 'Courses/Irvine_Valley_College/HOLA_Spanish_3_(Tseng_Rosales_and_Lemari)'

// LibreTexts' proxy answering for one page (any id) and, by path, for the
// pages above it: its tree, and each ancestor as a possible book cover.
function libreTexts(path: string, covers: Record<string, { id: string; title: string }>) {
  const page = { '@id': '378488', title: path.split('/').pop(), path: { '#text': path } }
  const tree = { page: { '@id': '378488', title: page.title, subpages: '' } }
  const answer = (url: string) => {
    if (url.endsWith('catalog.json')) return CATALOG
    if (url.includes('/tree')) return tree
    const byPath = /\/pages\/=([^?]+)/.exec(url)
    if (!byPath) return page
    const cover = covers[decodeURIComponent(decodeURIComponent(byPath[1]))]
    return cover ? { '@id': cover.id, title: cover.title, path: { '#text': '' } } : { error: 'not found', status: 404 }
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(answer(url)))))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('looking up a pasted link', () => {
  it('names the book’s authors from the catalog', async () => {
    libreTexts(`${HOLA}/04/4.02`, { [HOLA]: { id: '309694', title: 'HOLA Spanish 3 (Tseng Rosales and Lemari)' } })
    const { book } = await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(book).toEqual({
      id: 'human-309694',
      title: 'HOLA Spanish 3 (Tseng Rosales and Lemari)',
      author: 'Beatrice Tseng, Karla Lemari, Lisbeth Rosales',
    })
  })

  // A book missing from the catalog may sit at any depth, so a guess could name
  // its shelf; the page is credited on its own instead (LT-75).
  it.each([
    ['filed on a shelf', 'Bookshelves/Languages/Spanish', 'Bookshelves/Languages/Spanish/Lecturas_nuevas/01:_Uno/1.01:_Hola'],
    ['at the usual depth', 'Courses/Irvine_Valley_College/HOLA_Spanish_4', 'Courses/Irvine_Valley_College/HOLA_Spanish_4/04/4.02'],
  ])('names no book for a page the catalog lists no book above, %s', async (_, above, path) => {
    libreTexts(path, { [above]: { id: '400000', title: above.split('/').pop()! } })
    const { book } = await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(book).toBeNull()
  })

  it('finds a book filed deeper than a shelf, not the shelf', async () => {
    libreTexts('Bookshelves/Languages/French/On_y_va:_French_I/01:_Salut/1.01:_Bonjour', {
      'Bookshelves/Languages/French': { id: '120000', title: 'French' },
      'Bookshelves/Languages/French/On_y_va:_French_I': { id: '120001', title: 'On y va: French I' },
    })
    const { book } = await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'human-120001', title: 'On y va: French I', author: 'Ana Ruiz' })
  })

  it('names the book, not one of its pages the catalog also lists', async () => {
    libreTexts('Courses/Butte_College/Critical_Thinking/05/5.09:_Wilde', {
      'Courses/Butte_College/Critical_Thinking': { id: '130001', title: 'Critical Thinking Through Literature' },
      'Courses/Butte_College/Critical_Thinking/05/5.09:_Wilde': { id: '130555', title: '5.9: Wilde, Oscar' },
    })
    const { book } = await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'human-130001', title: 'Critical Thinking Through Literature', author: 'Heather Ringo' })
  })
})
