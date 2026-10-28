// Read-only access to public LibreTexts pages from the browser.
//
// Deki's own API sends no CORS headers, so every page, tree, and contents call
// goes through LibreTexts' public `cross-library` read proxy, which echoes the
// caller's origin. Its rules (verified against the live service):
//   - plain GET with no custom headers (a preflight is answered with 406);
//   - the target Deki URL is appended *unencoded* after the endpoint;
//   - only https://{library}.libretexts.org/@api/deki/pages/... targets pass;
//   - it answers 200 before calling Deki, so the body must be checked.

export const LIBRARIES = {
  bio: 'Biology',
  biz: 'Business',
  chem: 'Chemistry',
  eng: 'Engineering',
  espanol: 'Español',
  geo: 'Geosciences',
  human: 'Humanities',
  k12: 'K12 Education',
  math: 'Mathematics',
  med: 'Medicine',
  phys: 'Physics',
  socialsci: 'Social Sciences',
  stats: 'Statistics',
  workforce: 'Workforce',
} as const

export type Library = keyof typeof LIBRARIES

const CROSS_LIBRARY = 'https://api.libretexts.org/endpoint/cross-library/'
const MAX_CONCURRENCY = 4

export class LibreTextsError extends Error {}

export function isLibrary(value: string): value is Library {
  return Object.hasOwn(LIBRARIES, value)
}

export type PageRef = { library: Library; id: string } | { library: Library; path: string }

// Accepts any public LibreTexts page URL, including /@go/page/{id} short links.
export function parseLibreTextsUrl(input: string): PageRef {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new LibreTextsError('That is not a valid URL.')
  }
  const match = url.hostname.match(/^([a-z0-9]+)\.libretexts\.org$/)
  if (url.protocol !== 'https:' || !match || !isLibrary(match[1])) {
    throw new LibreTextsError(
      `Only LibreTexts textbook URLs are supported (https://<library>.libretexts.org/…). Libraries: ${Object.keys(LIBRARIES).join(', ')}.`,
    )
  }
  const library = match[1]
  const pathname = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '')
  const goLink = pathname.match(/^@go\/page\/(\d+)$/)
  if (goLink) return { library, id: goLink[1] }
  const apiLink = pathname.match(/^@api\/deki\/pages\/(\d+)/)
  if (apiLink) return { library, id: apiLink[1] }
  if (!pathname || pathname.startsWith('@') || pathname.startsWith('Special:')) {
    throw new LibreTextsError('Paste the URL of a textbook page, chapter, or book.')
  }
  return { library, path: pathname }
}

// A page as a link to the app names it: <library>-<page id>, e.g. human-378488.
export const PAGE_LINK = /^([a-z0-9]+)-(\d+)$/i

// The page a link names, or a LibreTextsError saying what is wrong with it.
export function parsePageLink(input: string): Extract<PageRef, { id: string }> {
  const match = input.trim().toLowerCase().match(PAGE_LINK)
  if (!match) {
    throw new LibreTextsError(
      'That link does not name a LibreTexts page. A page link ends in ?page=<library>-<page number>, such as ?page=human-378488.',
    )
  }
  if (!isLibrary(match[1])) {
    throw new LibreTextsError(
      `“${match[1]}” is not a LibreTexts library. Use one of ${Object.keys(LIBRARIES).join(', ')}.`,
    )
  }
  return { library: match[1], id: match[2] }
}

function pageSegment(ref: PageRef): string {
  if ('id' in ref) return ref.id
  // Deki wants the path percent-encoded twice behind a leading "=".
  return '=' + encodeURIComponent(encodeURIComponent(ref.path))
}

async function crossLibrary<T>(library: Library, suffix: string, signal?: AbortSignal): Promise<T> {
  const target = `https://${library}.libretexts.org/@api/deki/pages/${suffix}`
  let response: Response
  try {
    response = await fetch(CROSS_LIBRARY + target, { signal })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new LibreTextsError('Could not reach LibreTexts. Check your connection and try again.')
  }
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const refusal = refusalOf(response.status, record)
  if (refusal) throw new LibreTextsError(refusal)
  if (body === undefined) throw new LibreTextsError('LibreTexts returned an unreadable response for that page.')
  if (!response.ok || !body || typeof body !== 'object') {
    throw new LibreTextsError('LibreTexts could not find that page.')
  }
  if (record.error || record.exception || record.status === 404) {
    throw new LibreTextsError('LibreTexts could not find that page.')
  }
  return body as T
}

// A refusal is not a missing page: the page may well exist. Deki names its
// token, auth and permission checks in the exception and resource it answers
// with, such as MindTouch.Deki.Auth.Exceptions.TokenValidationFailedException
// and System.API.Error.developer-token-validation-failed.
function refusalOf(status: number, record: Record<string, unknown>): string | null {
  const named = [record.exception, record.resource].filter((part) => typeof part === 'string').join(' ')
  if (/token/i.test(named)) {
    return "LibreTexts would not share that page right now (it asked for an access token). This is on LibreTexts' side; try again later."
  }
  if (status === 401 || status === 403 || /\bauth\b|authori[sz]|authenticat|permission|access.?denied/i.test(named)) {
    return 'LibreTexts would not share that page (it needs permission to read it). The page may not be public; if it is, try again later.'
  }
  return null
}

export interface PageInfo {
  library: Library
  id: string
  title: string
  path: string
  url: string
  license: { code: string; label: string; version: string | null } | null
  // Whether the page is a book's cover, as Deki tags it (coverpage:yes).
  cover: boolean
  // The ids of the pages above it, nearest first.
  ancestors: string[]
}

interface DekiParent {
  '@id'?: string
  'page.parent'?: DekiParent
}

interface DekiPage {
  '@id': string
  title?: string
  path?: { '#text'?: string } | string
  'uri.ui'?: string
  tags?: { tag?: DekiTag | DekiTag[] }
  'page.parent'?: DekiParent
  subpages?: { page?: DekiPage | DekiPage[] } | ''
}

interface DekiTag {
  '@value'?: string
  title?: string
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function pathText(page: DekiPage): string {
  return typeof page.path === 'string' ? page.path : (page.path?.['#text'] ?? '')
}

export async function getPageInfo(ref: PageRef, signal?: AbortSignal): Promise<PageInfo> {
  const page = await crossLibrary<DekiPage>(ref.library, `${pageSegment(ref)}?dream.out.format=json`, signal)
  if (!page['@id']) throw new LibreTextsError('LibreTexts could not find that page.')
  const path = pathText(page)
  const tags = asArray(page.tags?.tag)
  const ancestors: string[] = []
  for (let parent = page['page.parent']; parent?.['@id']; parent = parent['page.parent']) {
    ancestors.push(String(parent['@id']))
  }
  return {
    library: ref.library,
    id: String(page['@id']),
    title: page.title ?? path.split('/').pop() ?? 'Untitled page',
    path,
    url: page['uri.ui'] ?? `https://${ref.library}.libretexts.org/${path}`,
    license: licenseFromTags(tags),
    cover: tags.some((tag) => (tag['@value'] ?? tag.title ?? '').trim().toLowerCase() === 'coverpage:yes'),
    ancestors,
  }
}

export interface TocNode {
  id: string
  title: string
  url: string
  children: TocNode[]
}

export async function getTree(library: Library, id: string, signal?: AbortSignal): Promise<TocNode> {
  const body = await crossLibrary<{ page?: DekiPage }>(library, `${id}/tree?dream.out.format=json`, signal)
  if (!body.page) throw new LibreTextsError('LibreTexts returned no table of contents for that page.')
  const build = (page: DekiPage): TocNode => ({
    id: String(page['@id']),
    title: page.title ?? 'Untitled',
    url: page['uri.ui'] ?? '',
    children: asArray(page.subpages === '' ? undefined : page.subpages?.page).map(build),
  })
  return build(body.page)
}

export async function getContentsHtml(library: Library, id: string, signal?: AbortSignal): Promise<string> {
  const body = await crossLibrary<{ body?: unknown }>(
    library,
    `${id}/contents?mode=view&dream.out.format=json`,
    signal,
  )
  // String parts are the rendered page; object parts are side data such as the
  // auto-generated table of contents, which is not prose.
  const parts = asArray(body.body as unknown).filter((part): part is string => typeof part === 'string')
  return parts.join('')
}

export function leafPages(node: TocNode): TocNode[] {
  if (node.children.length === 0) return [node]
  return node.children.flatMap(leafPages)
}

// The smallest part of a tree (the tree itself, a chapter, a section or one
// page) that holds every page picked from it, so a source can be credited for
// what was picked.
export function partHolding(tree: TocNode, pages: TocNode[]): TocNode {
  const picked = new Set(pages.map((page) => page.id))
  let part = tree
  for (;;) {
    const holding = part.children.filter((child) => leafPages(child).some((leaf) => picked.has(leaf.id)))
    if (holding.length !== 1) return part
    part = holding[0]
  }
}

// Front/back matter, exercise sets, summaries, and glossary-style pages rarely
// make good sources (exercise pages would just be paraphrased), so they start
// unticked. Titles look like "1.11: Exercises" or "2.E: Atoms (Exercises)".
const NON_CONTENT_TITLE =
  /^(front matter|back matter|titlepage|infopage|table of contents|index|glossary|detailed licensing|licensing|donors|about the authors?|preface|key terms|key equations|key concepts and summary|summary|chapter summary|review questions|exercises|homework|problems|answers?( to selected exercises)?|references|additional resources)$/i

export function isLikelyContentPage(node: TocNode): boolean {
  const title = node.title.trim().replace(/^[\w.]+:\s*/, '')
  return !NON_CONTENT_TITLE.test(title) && !/\((exercises|homework|problems)\)$/i.test(title)
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
  limit = MAX_CONCURRENCY,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const run = async () => {
    while (next < items.length) {
      signal?.throwIfAborted()
      const index = next++
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}

const LICENSE_LABELS: Record<string, string> = {
  publicdomain: 'Public domain',
  ccby: 'CC BY',
  ccbync: 'CC BY-NC',
  ccbyncsa: 'CC BY-NC-SA',
  ccbysa: 'CC BY-SA',
  ccbynd: 'CC BY-ND',
  ccbyncnd: 'CC BY-NC-ND',
  gnu: 'GNU GPL',
  gnufdl: 'GNU FDL',
  arr: 'All rights reserved',
  // Named as LibreTexts' own pages name them.
  ck12: 'CK-12 License',
  caltech: 'Caltech License',
}

// The name of a LibreTexts license code, or null for a code that names no one
// license (such as "mixed") or that the app does not know.
export function licenseLabel(code: string): string | null {
  return LICENSE_LABELS[code] ?? null
}

// Port of content.py::_source_license_from_tags: only an unambiguous license
// tag is reported; anything else is left for the instructor to fill in.
export function licenseFromTags(tags: DekiTag[]): PageInfo['license'] {
  const values = new Set(
    tags
      .map((tag) => (tag['@value'] ?? tag.title ?? '').trim().toLowerCase())
      .filter(Boolean),
  )
  const codes = [...values].filter((v) => v.startsWith('license:')).map((v) => v.slice('license:'.length))
  const versions = [...values]
    .filter((v) => v.startsWith('licenseversion:'))
    .map((v) => v.slice('licenseversion:'.length))
  if (codes.length !== 1 || versions.length > 1) return null
  const code = codes[0]
  const label = LICENSE_LABELS[code]
  if (!label) return null
  let version: string | null = null
  if (versions.length === 1) {
    const raw = versions[0]
    if (/^\d{2}$/.test(raw)) version = `${raw[0]}.${raw[1]}`
    else if (/^\d+(\.\d+)+$/.test(raw)) version = raw
    else return null
  }
  if (code.startsWith('cc') && version === null) return null
  return { code, label: version && code.startsWith('cc') ? `${label} ${version}` : label, version }
}
