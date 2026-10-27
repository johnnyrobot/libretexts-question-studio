import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveUrl } from './sources'

// The bundled catalog, cut down to one book, and LibreTexts' proxy answering
// for a page of that book and its cover page.
const CATALOG = {
  generatedAt: '2026-10-06T03:25:33.782Z',
  books: [
    {
      id: 'human-309694',
      t: '¡HOLA! Spanish 3 (Tseng, Rosales, and Lemari)',
      a: 'Beatrice Tseng, Karla Lemari, Lisbeth Rosales',
      l: 'human',
      s: '',
      c: 'Irvine Valley College',
      lic: 'ccbyncsa',
      u: 'https://human.libretexts.org/Courses/Irvine_Valley_College/HOLA_Spanish_3_(Tseng_Rosales_and_Lemari)',
      n: 666,
    },
  ],
}
const COVER = 'Courses/Irvine_Valley_College/HOLA_Spanish_3_(Tseng_Rosales_and_Lemari)'

function libreTexts(coverId: string) {
  const page = { '@id': '378488', title: '4.2: La profecía de la gitana', path: { '#text': `${COVER}/04/4.02` } }
  const cover = { '@id': coverId, title: 'HOLA Spanish 3 (Tseng Rosales and Lemari)', path: { '#text': COVER } }
  const tree = { page: { '@id': '378488', title: page.title, subpages: '' } }
  const answer = (url: string) =>
    url.endsWith('catalog.json') ? CATALOG : url.includes('/tree') ? tree : url.includes('/pages/=') ? cover : page
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(answer(url)))))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('looking up a pasted link', () => {
  it('names the book’s authors from the catalog', async () => {
    libreTexts('309694')
    const { book } = await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(book).toEqual({
      id: 'human-309694',
      title: 'HOLA Spanish 3 (Tseng Rosales and Lemari)',
      author: 'Beatrice Tseng, Karla Lemari, Lisbeth Rosales',
    })
  })

  it('names no author for a book the catalog does not have', async () => {
    libreTexts('400000')
    const { book } = await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'human-400000', title: 'HOLA Spanish 3 (Tseng Rosales and Lemari)', author: null })
  })
})
