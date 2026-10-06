import { isLibrary, type Library } from './libretexts'

// Book search runs over a snapshot of the LibreTexts Commons catalog that is
// bundled with the app (scripts/build-catalog.mjs), because Commons only
// accepts requests from *.libretexts.org origins. The snapshot is precached
// by the service worker, so browsing works offline.

export interface CatalogBook {
  id: string
  title: string
  author: string
  library: Library
  subject: string
  course: string
  license: string
  url: string
  pages: number | null
}

interface RawBook {
  id: string
  t: string
  a: string
  l: string
  s: string
  c: string
  lic: string
  u: string
  n: number | null
}

let catalog: Promise<{ books: CatalogBook[]; generatedAt: string }> | null = null

export function loadCatalog(): Promise<{ books: CatalogBook[]; generatedAt: string }> {
  catalog ??= fetch(`${import.meta.env.BASE_URL}catalog.json`)
    .then((response) => {
      if (!response.ok) throw new Error('The book catalog could not be loaded.')
      return response.json() as Promise<{ generatedAt: string; books: RawBook[] }>
    })
    .then((raw) => ({
      generatedAt: raw.generatedAt,
      books: raw.books
        .filter((b) => isLibrary(b.l))
        .map((b) => ({
          id: b.id,
          title: b.t,
          author: b.a,
          library: b.l as Library,
          subject: b.s,
          course: b.c,
          license: b.lic,
          url: b.u,
          pages: b.n,
        })),
    }))
    .catch((error) => {
      catalog = null
      throw error
    })
  return catalog
}

const fold = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

// Every query word must appear somewhere; title hits rank above author/subject.
export function searchCatalog(
  books: CatalogBook[],
  query: string,
  library: Library | '' = '',
  limit = 50,
): CatalogBook[] {
  const words = fold(query).split(/[^a-z0-9]+/).filter(Boolean)
  const scored: [number, CatalogBook][] = []
  for (const book of books) {
    if (library && book.library !== library) continue
    if (words.length === 0) {
      scored.push([0, book])
      continue
    }
    const title = fold(book.title)
    const rest = fold(`${book.author} ${book.subject} ${book.course} ${book.id}`)
    let score = 0
    let matched = true
    for (const word of words) {
      if (title.includes(word)) score += title.split(/[^a-z0-9]+/).includes(word) ? 3 : 2
      else if (rest.includes(word)) score += 1
      else {
        matched = false
        break
      }
    }
    if (matched) scored.push([score, book])
  }
  return scored
    .sort((a, b) => b[0] - a[0] || a[1].title.localeCompare(b[1].title))
    .slice(0, limit)
    .map(([, book]) => book)
}
