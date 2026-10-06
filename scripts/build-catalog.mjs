// Snapshots the LibreTexts Commons book catalog into public/catalog.json.
//
// Commons only allows *.libretexts.org origins, so a browser app hosted
// anywhere else cannot search it directly. Node has no CORS, so we fetch the
// public master catalog at build time and ship a trimmed copy with the app;
// the PWA can then browse every book offline.
import { writeFile } from 'node:fs/promises'

const SOURCE = 'https://commons.libretexts.org/api/v1/commons/mastercatalog/v2'
const OUT = new URL('../public/catalog.json', import.meta.url)

const response = await fetch(SOURCE, { headers: { Accept: 'application/json' } })
if (!response.ok) throw new Error(`Commons catalog request failed: HTTP ${response.status}`)
const body = await response.json()
if (body.err || !Array.isArray(body.libraries)) throw new Error('Unexpected catalog shape')

const books = new Map()
for (const library of body.libraries) {
  for (const group of [...(library.subjects ?? []), ...(library.courses ?? [])]) {
    for (const book of group.books ?? []) {
      if (!book.bookID || !book.title || !book.links?.online) continue
      if (!/^[a-z0-9]+-\d+$/.test(book.bookID)) continue
      const existing = books.get(book.bookID)
      const entry = existing ?? {
        id: book.bookID,
        t: book.title.trim(),
        a: (book.author ?? '').trim(),
        l: book.library,
        s: (book.subject ?? '').trim(),
        c: (book.course ?? '').trim(),
        lic: (book.license ?? '').trim(),
        u: book.links.online,
        n: book.exportInfo?.contentPageCount ?? null,
      }
      if (!entry.s && group.subject) entry.s = group.subject
      if (!entry.c && group.course) entry.c = group.course
      books.set(book.bookID, entry)
    }
  }
}

const catalog = {
  generatedAt: new Date().toISOString(),
  source: SOURCE,
  books: [...books.values()].sort((x, y) => x.t.localeCompare(y.t)),
}
await writeFile(OUT, JSON.stringify(catalog))
console.log(`Wrote ${catalog.books.length} books to ${OUT.pathname}`)
