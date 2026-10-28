import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../storage/db'
import { buildLibreTextsSource, resolveUrl } from './sources'

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
    // A real book that holds one of its parts listed as a book too (LT-93).
    {
      id: 'phys-9867', t: 'Spiral Physics - Calculus Based', a: "Paul D'Alessandris", l: 'phys', s: 'University Physics',
      c: '', lic: 'ccbyncsa', n: 634,
      u: 'https://phys.libretexts.org/Bookshelves/University_Physics/Book%3A_Spiral_Physics_-_Calculus_Based_(DAlessandris)',
    },
    {
      id: 'phys-11499', t: 'Spiral Mechanics (Calculus-Based)', a: "Paul D'Alessandris", l: 'phys', s: 'University Physics',
      c: '', lic: 'ccbyncsa', n: 567,
      u: 'https://phys.libretexts.org/Bookshelves/University_Physics/Book%3A_Spiral_Physics_-_Calculus_Based_(DAlessandris)/Spiral_Mechanics_(Calculus-Based)',
    },
    // Two campuses the catalog titles like books. Each wraps one book that is
    // listed on its own (LT-81).
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
function dekiByPath(path: string, covers: Record<string, { id: string; title: string }>) {
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
  // A cover is tagged coverpage:yes, or coverpage:toc on some books.
  cover?: boolean | 'toc'
}

// LibreTexts' proxy answering for a page under a catalog entry that is not
// certain to be its book: the page by its id (378488), and the pages above it,
// nearest first, by theirs. A page tagged coverpage:yes or coverpage:toc is a
// book's cover. Any of them can be asked for by its path too.
// Returns the pages asked for, in order.
function dekiById(path: string, above: Above[], options: { cover?: Above['cover']; failing?: string } = {}) {
  const tags = (cover?: Above['cover']) => ({
    tag: [{ '@value': 'article:topic' }, ...(cover ? [{ '@value': cover === 'toc' ? 'coverpage:toc' : 'coverpage:yes' }] : [])],
  })
  const parents = above.reduceRight<object | undefined>(
    (parent, { id }) => ({ '@id': id, ...(parent && { 'page.parent': parent }) }),
    undefined,
  )
  const segments = path.split('/')
  const pages = new Map<string, object>([
    ['378488', { '@id': '378488', title: segments.at(-1), path: { '#text': path }, tags: tags(options.cover), 'page.parent': parents }],
    ...above.map(({ id, title, cover }, index): [string, object] => [
      id,
      { '@id': id, title, path: { '#text': segments.slice(0, -(index + 1)).join('/') }, tags: tags(cover) },
    ]),
  ])
  const asked: string[] = []
  const answer = (url: string) => {
    if (url.endsWith('catalog.json')) return CATALOG
    if (url.includes('/tree')) return { page: { '@id': '378488', title: 'Page', subpages: '' } }
    const id = /\/pages\/(\d+)\?/.exec(url)?.[1] ?? 'by path'
    asked.push(id)
    if (id === options.failing) return { exception: 'MindTouch.Deki.Exceptions.InternalError', status: 500 }
    const byPath = /\/pages\/=([^?]+)/.exec(url)
    if (byPath) {
      const wanted = decodeURIComponent(decodeURIComponent(byPath[1])).toLowerCase()
      return [...pages.values()].find((page) => (page as { path: { '#text': string } }).path['#text'].toLowerCase() === wanted)
        ?? { error: 'not found', status: 404 }
    }
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
    dekiByPath(`${HOLA}/04/4.02`, { [HOLA]: { id: '309694', title: 'HOLA Spanish 3 (Tseng Rosales and Lemari)' } })
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
    dekiByPath(path, { [guess]: { id: '400000', title: guess.split('/').pop()! } })
    const { book } = await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(book).toBeNull()
  })

  it('finds a book filed deeper than a shelf, not the shelf', async () => {
    dekiByPath('Bookshelves/Languages/French/On_y_va:_French_I/01:_Salut/1.01:_Bonjour', {
      'Bookshelves/Languages/French': { id: '120000', title: 'French' },
      'Bookshelves/Languages/French/On_y_va:_French_I': { id: '120001', title: 'On y va: French I' },
    })
    const { book } = await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'human-120001', title: 'On y va: French I', author: 'Ana Ruiz' })
  })

  it('finds a book listed inside a campus the catalog lists as a book', async () => {
    dekiByPath('Courses/University_of_the_Pacific/Reading_Poetry/01/1.01', {
      'Courses/University_of_the_Pacific': { id: '140000', title: 'University of the Pacific' },
      'Courses/University_of_the_Pacific/Reading_Poetry': { id: '140001', title: 'Reading Poetry' },
    })
    const { book } = await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'human-140001', title: 'Reading Poetry', author: 'Lia Moreno' })
  })

  it('names the book, not one of its pages the catalog also lists', async () => {
    dekiByPath('Courses/Butte_College/Critical_Thinking/05/5.09:_Wilde', {
      'Courses/Butte_College/Critical_Thinking': { id: '130001', title: 'Critical Thinking Through Literature' },
      'Courses/Butte_College/Critical_Thinking/05/5.09:_Wilde': { id: '130555', title: '5.9: Wilde, Oscar' },
    })
    const { book } = await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'human-130001', title: 'Critical Thinking Through Literature', author: 'Heather Ringo' })
  })

  // Under a catalog entry that may be a collection of books, or a campus, the
  // nearest page Deki tags as a book's cover, at or up to two pages above the
  // pasted one, is the book (LT-81).
  const BT = 'Courses/San_Diego_State_University/bt@sdsu'

  it('names the book a page is in, not the collection the catalog lists above it', async () => {
    const asked = dekiById(`${BT}/3.1:_Genetics/01/1.01`, [
      { id: '114900', title: '1: Genes' },
      { id: '114800', title: '3.1: Genetics', cover: true },
      { id: '114696', title: 'Biotech Scholars at San Diego State University', cover: true },
    ])
    const { book } = await resolveUrl('https://bio.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'bio-114800', title: '3.1: Genetics', author: null })
    expect(asked).toEqual(['378488', '114900', '114800'])
  })

  it('names a pasted cover page as the book without asking for more', async () => {
    const asked = dekiById(`${BT}/3.1:_Genetics`, [{ id: '114696', title: 'BT', cover: true }], { cover: true })
    const { book } = await resolveUrl('https://bio.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'bio-378488', title: '3.1:_Genetics', author: null })
    expect(asked).toEqual(['378488'])
  })

  it('names the book for a page outside a part of it the catalog also lists', async () => {
    dekiById('Bookshelves/Physics/Spiral_Physics/Spiral_Waves/1.01', [
      { id: '150100', title: 'Spiral Waves' },
      { id: '150000', title: 'Spiral Physics', cover: true },
    ])
    const { book } = await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'human-150000', title: 'Spiral Physics', author: 'Paul D’Alessandris' })
  })

  it('names a book whose cover is tagged coverpage:toc', async () => {
    dekiById('Bookshelves/Physics/Spiral_Physics/Spiral_Waves/1.01', [
      { id: '150100', title: 'Spiral Waves' },
      { id: '150000', title: 'Spiral Physics', cover: 'toc' },
    ])
    const { book } = await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'human-150000', title: 'Spiral Physics', author: 'Paul D’Alessandris' })
  })

  it('names the catalog entry, not a cover above it', async () => {
    const asked = dekiById('Bookshelves/Physics/Spiral_Physics/1.01', [
      { id: '150000', title: 'Spiral Physics' },
      { id: '149000', title: 'Physics', cover: true },
    ])
    const { book } = await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'human-150000', title: 'Spiral Physics', author: 'Paul D’Alessandris' })
    expect(asked).toEqual(['378488', '150000', '149000'])
  })

  it('finds a book the catalog does not list inside a campus it lists', async () => {
    dekiById('Courses/University_of_the_Pacific/Drama/01/1.01', [
      { id: '140500', title: '1: Acts' },
      { id: '140400', title: 'Drama', cover: true },
    ])
    const { book } = await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'human-140400', title: 'Drama', author: null })
  })

  // Santiago Canyon and Montgomery wrap one listed book each, whose pages the
  // catalog credits for certain; their own pages are the campus.
  it.each([
    ['math', 'Courses/Santiago_Canyon_College/Front_Matter/TitlePage', 'Santiago Canyon College'],
    ['stats', 'Courses/Montgomery_College/00:_Front_Matter/01:_TitlePage', 'Montgomery College'],
  ])('names no campus as the book, even one Deki tags as a cover: %s %s', async (library, path, campus) => {
    const asked = dekiById(path, [
      { id: '125100', title: 'Front Matter' },
      { id: '125057', title: campus, cover: true },
    ])
    const { book } = await resolveUrl(`https://${library}.libretexts.org/@go/page/378488`)
    expect(book).toBeNull()
    expect(asked).toEqual(['378488', '125100', '125057'])
  })

  // The catalog's own credit, as before LT-81, when Deki names no cover (LT-93).
  it('names the catalog entry when no cover is within two pages up', async () => {
    const asked = dekiById(`${BT}/3.1:_Genetics/01/1.01/Notes`, [
      { id: '114901', title: '1.1: Genes' },
      { id: '114900', title: '1: Genes' },
      { id: '114800', title: '3.1: Genetics', cover: true },
      { id: '114696', title: 'BT' },
    ])
    const { book } = await resolveUrl('https://bio.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'bio-114696', title: 'BT', author: null })
    expect(asked).toEqual(['378488', '114901', '114900', 'by path'])
  })

  it('names the real Spiral Physics for a page outside Spiral Mechanics with no cover near it', async () => {
    const spiral = 'Bookshelves/University_Physics/Book:_Spiral_Physics_-_Calculus_Based_(DAlessandris)'
    const asked = dekiById(`${spiral}/Spiral_Electricity_and_Magnetism/01:_Electric_Charge/1.01:_Charge`, [
      { id: '9901', title: '1: Electric Charge' },
      { id: '9900', title: 'Spiral Electricity and Magnetism' },
      { id: '9867', title: 'Spiral Physics - Calculus Based' },
    ])
    const { book } = await resolveUrl('https://phys.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'phys-9867', title: 'Spiral Physics - Calculus Based', author: "Paul D'Alessandris" })
    expect(asked).toEqual(['378488', '9901', '9900', 'by path'])
  })

  it('names a pasted catalog entry as the book without asking for it again', async () => {
    // The pasted page is always 378488 here, so it stands in for BT's own id.
    const asked = dekiById(BT, [{ id: '114000', title: 'San Diego State University' }])
    const { book } = await resolveUrl('https://bio.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'bio-378488', title: 'bt@sdsu', author: null })
    expect(asked).toEqual(['378488'])
  })

  it('names the catalog entry when LibreTexts fails on a page above', async () => {
    dekiById(`${BT}/3.1:_Genetics/01`, [
      { id: '114800', title: '3.1: Genetics', cover: true },
      { id: '114696', title: 'BT' },
    ], { failing: '114800' })
    const { book } = await resolveUrl('https://bio.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'bio-114696', title: 'BT', author: null })
  })

  it('asks for nothing above a page in a book the catalog lists for certain', async () => {
    const asked = dekiById(`${HOLA}/04/4.02`, [{ id: '309700', title: '4: Unidad 4' }])
    await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(asked).toEqual(['378488', 'by path'])
  })

  it('asks for nothing above a page the catalog lists nothing above', async () => {
    const asked = dekiById('Bookshelves/Languages/Spanish/Lecturas/01/1.01', [
      { id: '200100', title: '1: Uno' },
      { id: '200000', title: 'Lecturas', cover: true },
    ])
    const { book } = await resolveUrl('https://human.libretexts.org/@go/page/378488')
    expect(book).toBeNull()
    expect(asked).toEqual(['378488'])
  })

  it('names the listed book inside a collection', async () => {
    dekiByPath(`${BT}/2.1:_Bio-OER/01/1.01`, {
      [`${BT}/2.1:_Bio-OER`]: { id: '114717', title: '2.1: Bio-OER (CUNY)' },
    })
    const { book } = await resolveUrl('https://bio.libretexts.org/@go/page/378488')
    expect(book).toEqual({ id: 'bio-114717', title: '2.1: Bio-OER (CUNY)', author: 'Malgorzata Kopacz' })
  })
})

describe('cancelling a source while it is being written', () => {
  it('takes the source back out and reports the cancel', async () => {
    const node = { id: '378488', title: 'Capítulo 1', url: 'https://human.libretexts.org/x', children: [] }
    const paragraphs = [{ index: 0, text: 'Hola.', start: 0, end: 5 }]
    await db.pages.put({ key: 'human-378488', title: node.title, url: node.url, paragraphs, fetchedAt: 0 })
    const back = new AbortController()
    const add = db.sources.add.bind(db.sources)
    const writing = vi.spyOn(db.sources, 'add').mockImplementation((source) =>
      add(source).then((key) => {
        back.abort()
        return key
      }),
    )
    const build = buildLibreTextsSource({
      library: 'human',
      title: node.title,
      url: node.url,
      kind: 'page',
      pages: [node],
      license: null,
      signal: back.signal,
    })
    await expect(build).rejects.toThrow()
    writing.mockRestore()
    expect(await db.sources.count()).toBe(0)
  })
})
