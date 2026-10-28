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
    // A campus listed as a book, with a book of its own listed inside it whose
    // page count the catalog does not know.
    {
      id: 'human-140000', t: 'University of the Pacific', a: '', l: 'human', s: '', c: '', lic: 'ccby',
      u: 'https://human.libretexts.org/Courses/University_of_the_Pacific', n: 644,
    },
    {
      id: 'human-140001', t: 'Reading Poetry', a: 'Lia Moreno', l: 'human', s: '', c: '', lic: 'ccby',
      u: 'https://human.libretexts.org/Courses/University_of_the_Pacific/Reading_Poetry', n: null,
    },
    // A book with one of its parts listed as a book too.
    {
      id: 'human-150000', t: 'Spiral Physics', a: 'Paul D’Alessandris', l: 'human', s: '', c: '', lic: 'ccbyncsa',
      u: 'https://human.libretexts.org/Bookshelves/Physics/Spiral_Physics', n: 634,
    },
    {
      id: 'human-150001', t: 'Spiral Mechanics', a: 'Paul D’Alessandris', l: 'human', s: '', c: '', lic: 'ccbyncsa',
      u: 'https://human.libretexts.org/Bookshelves/Physics/Spiral_Physics/Spiral_Mechanics', n: 567,
    },
    // A collection of books, with one of them listed too (LT-81).
    {
      id: 'bio-114696', t: 'BT', a: '', l: 'bio', s: '', c: 'San Diego State University', lic: '',
      u: 'https://bio.libretexts.org/Courses/San_Diego_State_University/bt%40sdsu', n: 864,
    },
    {
      id: 'bio-114717', t: '2.1: Bio-OER (CUNY)', a: 'Malgorzata Kopacz', l: 'bio', s: '', c: '', lic: 'ccby',
      u: 'https://bio.libretexts.org/Courses/San_Diego_State_University/bt%40sdsu/2.1%3A_Bio-OER', n: 120,
    },
    // Two campuses listed as books that are books (LT-81).
    {
      id: 'math-125057', t: 'HiSetMatematicas', a: 'Saul Lopez', l: 'math', s: '', c: 'Santiago Canyon College', lic: '',
      u: 'https://math.libretexts.org/Courses/Santiago_Canyon_College', n: 1926,
    },
    {
      id: 'stats-8942', t: 'Support Course for Elementary Statistics', a: 'Montgomery College', l: 'stats', s: '',
      c: 'Montgomery College', lic: '', u: 'https://stats.libretexts.org/Courses/Montgomery_College', n: 100,
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

interface Above {
  id: string
  title: string
  cover?: boolean
}

// LibreTexts' proxy answering for a page whose catalog book is not certain:
// the page by its id (378488), with the pages above it, nearest first, by
// theirs. A page tagged coverpage:yes is a book's cover. Returns the ids
// asked for, in order.
function deki(path: string, above: Above[], options: { cover?: boolean; failing?: string } = {}) {
  const tags = (cover?: boolean) => ({ tag: [{ '@value': 'article:topic' }, ...(cover ? [{ '@value': 'coverpage:yes' }] : [])] })
  const parents = above.reduceRight<object | undefined>(
    (parent, { id }) => ({ '@id': id, ...(parent && { 'page.parent': parent }) }),
    undefined,
  )
  const pages = new Map<string, object>([
    ['378488', { '@id': '378488', title: path.split('/').pop(), path: { '#text': path }, tags: tags(options.cover), 'page.parent': parents }],
    ...above.map(({ id, title, cover }) => [id, { '@id': id, title, path: { '#text': '' }, tags: tags(cover) }] as [string, object]),
  ])
  const asked: string[] = []
  const answer = (url: string) => {
    if (url.endsWith('catalog.json')) return CATALOG
    if (url.includes('/tree')) return { page: { '@id': '378488', title: 'Page', subpages: '' } }
    const id = /\/pages\/(\d+)\?/.exec(url)?.[1] ?? 'by path'
    asked.push(id)
    if (id === options.failing) return { exception: 'MindTouch.Deki.Exceptions.InternalError', status: 500 }
    return pages.get(id) ?? { error: 'not found', status: 404 }
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(answer(url)))))
  return asked
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
  // its shelf or campus; the page is credited on its own instead (LT-75).
  it.each([
    ['filed on a shelf', 'Bookshelves/Languages/Spanish', 'Bookshelves/Languages/Spanish/Lecturas_nuevas/01:_Uno/1.01:_Hola'],
    ['at the usual depth', 'Courses/Irvine_Valley_College/HOLA_Spanish_4', 'Courses/Irvine_Valley_College/HOLA_Spanish_4/04/4.02'],
    ['in a campus the catalog lists as a book', 'Courses/University_of_the_Pacific', 'Courses/University_of_the_Pacific/Drama/01/1.01'],
  ])('names no book for a page the catalog lists no book above for certain, %s', async (_, guess, path) => {
    libreTexts(path, { [guess]: { id: '400000', title: guess.split('/').pop()! } })
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

  it('finds a book listed inside a campus the catalog lists as a book', async () => {
    libreTexts('Courses/University_of_the_Pacific/Reading_Poetry/01/1.01', {
      'Courses/University_of_the_Pacific': { id: '140000', title: 'University of the Pacific' },
      'Courses/University_of_the_Pacific/Reading_Poetry': { id: '140001', title: 'Reading Poetry' },
    })
    const { book } = await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'human-140001', title: 'Reading Poetry', author: 'Lia Moreno' })
  })

  it('names the book, not one of its pages the catalog also lists', async () => {
    libreTexts('Courses/Butte_College/Critical_Thinking/05/5.09:_Wilde', {
      'Courses/Butte_College/Critical_Thinking': { id: '130001', title: 'Critical Thinking Through Literature' },
      'Courses/Butte_College/Critical_Thinking/05/5.09:_Wilde': { id: '130555', title: '5.9: Wilde, Oscar' },
    })
    const { book } = await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'human-130001', title: 'Critical Thinking Through Literature', author: 'Heather Ringo' })
  })

  // Deki tags a book's cover page; a page the catalog cannot place for certain
  // is credited to the nearest cover at or up to two pages above it (LT-81).
  it('names a campus the catalog lists that is a book, from its cover tag', async () => {
    const asked = deki('Courses/Santiago_Canyon_College/Unidad_1/1.01', [
      { id: '125100', title: 'Unidad 1' },
      { id: '125057', title: 'Santiago Canyon College', cover: true },
    ])
    const { book } = await resolveUrl('https://math.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'math-125057', title: 'Santiago Canyon College', author: 'Saul Lopez' })
    expect(asked).toEqual(['378488', '125100', '125057'])
  })

  it('names the campus book a page sits right under', async () => {
    deki('Courses/Montgomery_College/01:_Fractions', [
      { id: '8942', title: 'Montgomery College', cover: true },
      { id: '252', title: 'Courses' },
    ])
    const { book } = await resolveUrl('https://stats.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'stats-8942', title: 'Montgomery College', author: 'Montgomery College' })
  })

  it('names the nearest cover when a book sits inside another', async () => {
    deki('Courses/Irvine_Valley_College/HOLA_Spanish_4/04/4.02', [
      { id: '400100', title: '4: Unidad 4' },
      { id: '400000', title: 'HOLA Spanish 4', cover: true },
      { id: '300000', title: 'Irvine Valley College', cover: true },
    ])
    const { book } = await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'human-400000', title: 'HOLA Spanish 4', author: null })
  })

  it('names a pasted cover page as the book without asking for more', async () => {
    const asked = deki('Courses/Irvine_Valley_College/HOLA_Spanish_4', [{ id: '300000', title: 'Irvine Valley College', cover: true }], {
      cover: true,
    })
    const { book } = await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'human-378488', title: 'HOLA_Spanish_4', author: null })
    expect(asked).toEqual(['378488'])
  })

  it('looks no more than two pages up', async () => {
    const asked = deki('Courses/Irvine_Valley_College/HOLA_Spanish_4/04/4.02/Notes', [
      { id: '400200', title: '4.2' },
      { id: '400100', title: '4: Unidad 4' },
      { id: '400000', title: 'HOLA Spanish 4', cover: true },
    ])
    const { book } = await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(book).toBeNull()
    expect(asked).toEqual(['378488', '400200', '400100'])
  })

  it('credits the page on its own when LibreTexts fails on a page above', async () => {
    deki('Courses/Irvine_Valley_College/HOLA_Spanish_4/04/4.02', [
      { id: '400100', title: '4: Unidad 4' },
      { id: '400000', title: 'HOLA Spanish 4', cover: true },
    ], { failing: '400100' })
    const { book } = await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(book).toBeNull()
  })

  it('asks for nothing above a page in a book the catalog lists for certain', async () => {
    const asked = deki(`${HOLA}/04/4.02`, [{ id: '309700', title: '4: Unidad 4' }])
    await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(asked).toEqual(['378488', 'by path'])
  })

  // A catalog entry holding another listed book may be a book with a part
  // listed too, or a collection of books; both carry the cover tag, so the
  // nearest cover is the book (LT-81).
  it('names the book a page is in, not the collection the catalog lists above it', async () => {
    deki('Courses/San_Diego_State_University/bt@sdsu/3.1:_Genetics/01/1.01', [
      { id: '114900', title: '1: Genes' },
      { id: '114800', title: '3.1: Genetics', cover: true },
      { id: '114696', title: 'Biotech Scholars at San Diego State University', cover: true },
    ])
    const { book } = await resolveUrl('https://bio.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'bio-114800', title: '3.1: Genetics', author: null })
  })

  it('names the book for a page outside a part of it the catalog also lists', async () => {
    deki('Bookshelves/Physics/Spiral_Physics/Spiral_Waves/1.01', [
      { id: '150100', title: 'Spiral Waves' },
      { id: '150000', title: 'Spiral Physics', cover: true },
    ])
    const { book } = await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'human-150000', title: 'Spiral Physics', author: 'Paul D’Alessandris' })
  })

  it('names no book for a page further below a possible collection than it looks', async () => {
    deki('Courses/San_Diego_State_University/bt@sdsu/3.1:_Genetics/01/1.01/Notes', [
      { id: '114901', title: '1.1: Genes' },
      { id: '114900', title: '1: Genes' },
      { id: '114800', title: '3.1: Genetics', cover: true },
    ])
    const { book } = await resolveUrl('https://bio.libretexts.org/@go/page/378488')
    expect(book).toBeNull()
  })

  it('names the listed book inside a collection', async () => {
    libreTexts('Courses/San_Diego_State_University/bt@sdsu/2.1:_Bio-OER/01/1.01', {
      'Courses/San_Diego_State_University/bt@sdsu/2.1:_Bio-OER': { id: '114717', title: '2.1: Bio-OER (CUNY)' },
    })
    const { book } = await resolveUrl('https://bio.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'bio-114717', title: '2.1: Bio-OER (CUNY)', author: 'Malgorzata Kopacz' })
  })
})
