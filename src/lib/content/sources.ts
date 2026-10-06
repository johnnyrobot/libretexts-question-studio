import { db, newId, type SourcePage, type StoredSource } from '../storage/db'
import {
  bookCoverPath,
  getContentsHtml,
  getPageInfo,
  getTree,
  mapWithConcurrency,
  parseLibreTextsUrl,
  type Library,
  type PageInfo,
  type TocNode,
} from './libretexts'
import { normalizeHtml, normalizePlainText } from './normalize'

// Builds the generation source (one or more normalised pages) from whatever the
// instructor picked: a pasted URL, part of a book's table of contents, or text.

export interface ResolvedUrl {
  page: PageInfo
  tree: TocNode
  book: { id: string; title: string } | null
}

// A pasted URL may point at a page, a chapter, or a whole book; its tree tells
// us which, and lets the instructor narrow the selection.
export async function resolveUrl(input: string, signal?: AbortSignal): Promise<ResolvedUrl> {
  const ref = parseLibreTextsUrl(input)
  const page = await getPageInfo(ref, signal)
  const tree = await getTree(page.library, page.id, signal)
  let book: ResolvedUrl['book'] = null
  const cover = bookCoverPath(page.path)
  if (cover) {
    try {
      const coverInfo = cover === page.path ? page : await getPageInfo({ library: page.library, path: cover }, signal)
      book = { id: `${page.library}-${coverInfo.id}`, title: coverInfo.title }
    } catch {
      book = null
    }
  }
  return { page, tree, book }
}

export async function fetchPageText(
  library: Library,
  node: { id: string; title: string; url: string },
  signal?: AbortSignal,
): Promise<SourcePage> {
  const key = `${library}-${node.id}`
  const cached = await db.pages.get(key)
  if (cached) return { title: cached.title, url: cached.url, pageId: node.id, paragraphs: cached.paragraphs }
  const html = await getContentsHtml(library, node.id, signal)
  const { paragraphs } = normalizeHtml(html)
  await db.pages.put({ key, title: node.title, url: node.url, paragraphs, fetchedAt: Date.now() })
  return { title: node.title, url: node.url, pageId: node.id, paragraphs }
}

export async function buildLibreTextsSource(options: {
  library: Library
  title: string
  url: string
  kind: StoredSource['kind']
  pages: TocNode[]
  license: StoredSource['license']
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}): Promise<StoredSource> {
  let done = 0
  const failures: string[] = []
  const pages = await mapWithConcurrency(
    options.pages,
    async (node) => {
      try {
        return await fetchPageText(options.library, node, options.signal)
      } catch (error) {
        if (options.signal?.aborted) throw error
        failures.push(node.title)
        return null
      } finally {
        options.onProgress?.(++done, options.pages.length)
      }
    },
    options.signal,
  )
  const readable = pages.filter((page): page is SourcePage => page !== null && page.paragraphs.length > 0)
  if (readable.length === 0) {
    throw new Error('None of the selected pages had readable text.')
  }
  const source: StoredSource = {
    id: newId(),
    kind: options.kind,
    title: options.title,
    library: options.library,
    url: options.url,
    license: options.license,
    pages: readable,
    createdAt: Date.now(),
  }
  await db.sources.add(source)
  return source
}

export async function buildPastedSource(title: string, text: string, url: string | null): Promise<StoredSource> {
  const { paragraphs } = normalizePlainText(text)
  const source: StoredSource = {
    id: newId(),
    kind: 'paste',
    title: title.trim() || 'Pasted text',
    library: null,
    url,
    license: null,
    pages: [{ title: title.trim() || 'Pasted text', url, pageId: null, paragraphs }],
    createdAt: Date.now(),
  }
  await db.sources.add(source)
  return source
}

export function sourceCharacterCount(source: StoredSource): number {
  return source.pages.reduce((sum, page) => sum + page.paragraphs.reduce((s, p) => s + p.text.length, 0), 0)
}
