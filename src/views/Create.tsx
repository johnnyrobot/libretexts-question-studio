import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useRef, useState } from 'react'
import { CopyLink } from '../components/CopyLink'
import { Icon } from '../components/Icon'
import { PageHeader } from '../components/Page'
import { TabPanel, Tabs } from '../components/Tabs'
import { TocPicker } from '../components/TocPicker'
import { loadCatalog, searchCatalog, type CatalogBook } from '../lib/content/catalog'
import { getTree, LIBRARIES, licenseLabel, parsePageLink, partHolding, type Library, type TocNode } from '../lib/content/libretexts'
import {
  buildLibreTextsSource,
  buildPastedSource,
  resolveUrl,
  type ResolvedUrl,
} from '../lib/content/sources'
import { ITEM_TYPE_LABELS, ITEM_TYPES, type ItemType } from '../lib/generation/schema'
import { localModel } from '../lib/llm/local-models'
import { db, newId, type StoredSource } from '../lib/storage/db'
import { createEmbedder, createProvider, useEngineSettings } from '../state/engine'
import { startGeneration, useGeneration } from '../state/generation'
import { navigate, pageLinkFor } from '../router'

type SourceTab = 'search' | 'url' | 'paste'

// Step 1 lives at #/, step 2 at #/new/<sourceId>, so Back returns to the
// source choice and a saved source can be reused for a fresh set. A link to
// the app that names a page (#/page/<library>-<id>) opens step 1 on that page.
export function Create({ sourceId, pageLink }: { sourceId?: string; pageLink?: string }) {
  return sourceId ? <ConfigureStep sourceId={sourceId} /> : <SourceStep pageLink={pageLink} />
}

// ---------------------------------------------------------------- step 1

const SOURCE_TABS = [
  ['search', 'Find a book'],
  ['url', 'Paste a link'],
  ['paste', 'Paste text'],
] as const

function SourceStep({ pageLink }: { pageLink?: string }) {
  const [tab, setTab] = useState<SourceTab>(pageLink === undefined ? 'search' : 'url')
  // Focus starts in the search box, but arrowing back to its tab later must
  // leave focus on the tab.
  const [switched, setSwitched] = useState(false)
  const onSource = (source: StoredSource) => navigate(`/new/${source.id}`)
  return (
    <>
      <PageHeader
        eyebrow="New question set · Step 1 of 2"
        title="Choose textbook pages"
        lede="Questions are written only from the pages you choose."
      />
      <Tabs
        label="How to choose pages"
        tabs={SOURCE_TABS}
        selected={tab}
        onSelect={(next) => {
          setTab(next)
          setSwitched(true)
        }}
        panelId="source-panel"
      />
      <TabPanel className="tab-panel" panelId="source-panel" selected={tab}>
        {tab === 'search' && <BookSearch onSource={onSource} autoFocus={!switched} />}
        {tab === 'url' && <UrlSource onSource={onSource} pageLink={pageLink} />}
        {tab === 'paste' && <PasteSource onSource={onSource} />}
      </TabPanel>
    </>
  )
}

function BookSearch({ onSource, autoFocus }: { onSource: (source: StoredSource) => void; autoFocus: boolean }) {
  const [books, setBooks] = useState<CatalogBook[] | null>(null)
  const [snapshot, setSnapshot] = useState('')
  const [query, setQuery] = useState('')
  const [library, setLibrary] = useState<Library | ''>('')
  const [book, setBook] = useState<CatalogBook | null>(null)
  const [tree, setTree] = useState<TocNode | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')

  useEffect(() => {
    loadCatalog()
      .then((catalog) => {
        setBooks(catalog.books)
        setSnapshot(new Date(catalog.generatedAt).toLocaleDateString())
      })
      .catch((e) => setError(e.message))
  }, [])

  const results = useMemo(
    () => (books && (query.trim() || library) ? searchCatalog(books, query, library) : []),
    [books, query, library],
  )

  // Going back, opening another book or leaving cancels the contents still
  // loading, so they never land under a book they don't belong to.
  const loading = useRef<AbortController | null>(null)
  useEffect(() => () => loading.current?.abort(), [])
  const open = async (choice: CatalogBook) => {
    loading.current?.abort()
    const { signal } = (loading.current = new AbortController())
    setBook(choice)
    setTree(null)
    setError(null)
    setBusy(true)
    try {
      const coverId = choice.id.slice(choice.id.indexOf('-') + 1)
      const contents = await getTree(choice.library, coverId, signal)
      if (!signal.aborted) setTree(contents)
    } catch (e) {
      if (!signal.aborted) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }
  const back = () => {
    loading.current?.abort()
    setBook(null)
    setBusy(false)
  }

  const confirm = async (pages: TocNode[]) => {
    if (!book || !tree) return
    setBusy(true)
    setError(null)
    try {
      onSource(
        await buildLibreTextsSource({
          library: book.library,
          // Pages from across the book are credited to it under the title the
          // catalog gives it.
          ...creditFor(tree, pages, { title: book.title, url: book.url, isBook: true }),
          pages,
          license: licenseFromCatalog(book.license),
          book: { title: book.title, author: book.author || null },
          onProgress: (done, total) => setProgress(`Loading page ${done} of ${total}…`),
        }),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  if (book) {
    return (
      <div>
        <button type="button" className="link back-link text-link" onClick={back}>
          <Icon name="arrow-left" size={18} /> Back to search results
        </button>
        <h2>{book.title}</h2>
        <p className="muted">
          {book.author && `${book.author} · `}
          {LIBRARIES[book.library]} ·{' '}
          <a href={book.url} target="_blank" rel="noreferrer">
            Open on LibreTexts
          </a>
        </p>
        {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
        {!tree && busy && <p className="muted">Loading the table of contents…</p>}
        {tree && <TocPicker tree={tree} selectAll={false} busy={busy} progress={progress} onConfirm={confirm} />}
      </div>
    )
  }

  // Two books can share a title (e.g. two editions); only then is the URL's
  // last segment worth showing to tell them apart.
  const titles = new Map<string, number>()
  for (const result of results) titles.set(result.title, (titles.get(result.title) ?? 0) + 1)

  return (
    <div>
      <div className="search-row">
        <label>
          Search {books ? `${books.length.toLocaleString()} LibreTexts books` : 'LibreTexts books'}
          <span className="search-field">
            <Icon name="search" />
            <input
              type="search"
              placeholder="Title, subject, or author"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus={autoFocus}
            />
          </span>
        </label>
        <label>
          Library
          <select value={library} onChange={(e) => setLibrary(e.target.value as Library | '')}>
            <option value="">All libraries</option>
            {Object.entries(LIBRARIES).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!books && !error && <p className="muted">Loading the catalog…</p>}
      {results.length > 0 && (
        <ul className="result-list">
          {results.map((result) => (
            <li key={result.id}>
              <button type="button" onClick={() => open(result)}>
                <span>
                  <strong>{result.title}</strong>
                  <span className="muted">
                    {[result.author, LIBRARIES[result.library]].filter(Boolean).join(' · ')}
                    {result.pages ? ` · ${result.pages} pages` : ''}
                  </span>
                  {titles.get(result.title)! > 1 && <span className="fine">{bookPathHint(result.url)}</span>}
                </span>
                <Icon name="chevron-right" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {books && (query.trim() || library) && results.length === 0 && <p className="muted">No books match.</p>}
      {snapshot && (
        <p className="fine mt">
          Book list from {snapshot}. For a newer book, use Paste a link.
        </p>
      )}
    </div>
  )
}

// The page a link to the app names, as the URL the link tab looks up.
function linkedPage(pageLink: string): { url: string } | { error: string } {
  try {
    const { library, id } = parsePageLink(pageLink)
    return { url: `https://${library}.libretexts.org/@go/page/${id}` }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

function UrlSource({ onSource, pageLink }: { onSource: (source: StoredSource) => void; pageLink?: string }) {
  const [linked] = useState(() => (pageLink === undefined ? null : linkedPage(pageLink)))
  const [url, setUrl] = useState(linked && 'url' in linked ? linked.url : '')
  const [resolved, setResolved] = useState<ResolvedUrl | null>(null)
  // A linked page is looked up as soon as the tab opens, so the tab starts busy.
  const [busy, setBusy] = useState(linked !== null && 'url' in linked)
  const [error, setError] = useState<string | null>(linked && 'error' in linked ? linked.error : null)
  const [progress, setProgress] = useState('')

  useEffect(() => {
    if (!linked || !('url' in linked)) return
    const controller = new AbortController()
    const { signal } = controller
    resolveUrl(linked.url, signal)
      .then((result) => {
        if (!signal.aborted) setResolved(result)
      })
      .catch((e) => {
        if (!signal.aborted) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!signal.aborted) setBusy(false)
      })
    return () => controller.abort()
  }, [linked])

  const lookUp = async () => {
    setBusy(true)
    setError(null)
    setResolved(null)
    try {
      setResolved(await resolveUrl(url))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const confirm = async (pages: TocNode[]) => {
    if (!resolved) return
    setBusy(true)
    setError(null)
    try {
      const isBook = resolved.book?.id === `${resolved.page.library}-${resolved.page.id}`
      onSource(
        await buildLibreTextsSource({
          library: resolved.page.library,
          ...creditFor(resolved.tree, pages, { title: resolved.page.title, url: resolved.page.url, isBook }),
          pages,
          license: resolved.page.license,
          book: resolved.book ? { title: resolved.book.title, author: resolved.book.author } : undefined,
          onProgress: (done, total) => setProgress(`Loading page ${done} of ${total}…`),
        }),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  return (
    <div>
      <form
        className="search-row"
        onSubmit={(e) => {
          e.preventDefault()
          lookUp()
        }}
      >
        <label>
          Link to a LibreTexts page, chapter, or book
          <input
            type="url"
            required
            placeholder="https://chem.libretexts.org/Bookshelves/…"
            value={url}
            // Fixed while busy, so the page found is always the one this link names.
            readOnly={busy}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <button type="submit" className={resolved ? undefined : 'primary'} disabled={busy}>
          {busy && !resolved ? 'Looking up…' : 'Look up'}
        </button>
      </form>
      {error && (
        <p className="error mt" role="alert">
          {error}
        </p>
      )}
      {resolved && (
        <div className="mt-lg">
          <p className="muted">
            {[
              resolved.book && resolved.book.title !== resolved.page.title && `From “${resolved.book.title}”`,
              resolved.page.license?.label,
            ]
              .filter(Boolean)
              .join(' · ')}{' '}
            <CopyLink href={pageLinkFor(resolved.page.library, resolved.page.id)} />
          </p>
          <TocPicker key={resolved.page.id} tree={resolved.tree} selectAll busy={busy} progress={progress} onConfirm={confirm} />
        </div>
      )}
    </div>
  )
}

function PasteSource({ onSource }: { onSource: (source: StoredSource) => void }) {
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  return (
    <form
      className="form-stack"
      onSubmit={async (e) => {
        e.preventDefault()
        try {
          onSource(await buildPastedSource(title, text, url.trim() || null))
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }}
    >
      <label>
        Textbook text
        <small>Copy from one or more LibreTexts pages. Keep the line breaks between paragraphs so questions can cite them.</small>
        <textarea required rows={12} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="field-row">
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. 2.3: Evolution of Atomic Theory" />
        </label>
        <label>
          Link to the page <small>(optional)</small>
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…libretexts.org/…" />
        </label>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="primary" disabled={!text.trim()}>
          Continue with this text
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------- step 2

const DEFAULT_TYPES: ItemType[] = ['multiple_choice', 'true_false', 'multiple_answers', 'fill_in_blank']
const CHECKED_TYPES = new Set<ItemType>(['multiple_choice', 'multiple_answers', 'true_false', 'fill_in_blank', 'matching', 'dropdowns'])

function ConfigureStep({ sourceId }: { sourceId: string }) {
  const source = useLiveQuery(async () => (await db.sources.get(sourceId)) ?? null, [sourceId])
  if (source === undefined) return null
  if (source === null) {
    return (
      <>
        <PageHeader eyebrow="New question set · Step 2 of 2" title="Choose the questions" />
        <p className="notice">
          Those pages are no longer saved in this browser. <a href="#/">Choose pages again</a>
        </p>
      </>
    )
  }
  return <Configure source={source} />
}

function Configure({ source }: { source: StoredSource }) {
  const engine = useEngineSettings()
  const generation = useGeneration()
  const [title, setTitle] = useState(`${source.title} — questions`)
  const [types, setTypes] = useState<ItemType[]>(DEFAULT_TYPES)
  const [perPage, setPerPage] = useState(source.pages.length === 1 ? 5 : 2)
  const [review, setReview] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  // On by default: in testing it is what catches a wrong answer key, which no
  // schema check can.
  const reviewPass = review ?? true
  const total = source.pages.length * perPage
  // The in-browser model does not review math questions (see pipeline.ts).
  const skipsReview = engine.provider === 'local' && types.includes('math')
  const reviews = reviewPass ? Math.round(total * (skipsReview ? 1 - 1 / types.length : 1)) : 0
  // An answer check answers every multiple-choice, select-all, true/false,
  // fill-in-the-blank, matching and dropdowns question again: always on the
  // in-browser model, and on OpenAI unless it is turned off in Settings.
  const answerCheck = engine.provider === 'local' || engine.answerCheck
  const keyChecks =
    answerCheck && types.length ? Math.round((total * types.filter((t) => CHECKED_TYPES.has(t)).length) / types.length) : 0
  const calls = total + reviews + keyChecks + source.pages.length

  const start = async () => {
    setError(null)
    const provider = await createProvider(engine)
    if (typeof provider === 'string') {
      setError(provider)
      return
    }
    // Ready before the set is saved as generating, so the generation can take
    // the set's lock straight after (see markInterruptedSets).
    const embedder = await createEmbedder(engine)
    const setId = newId()
    const now = Date.now()
    await db.sets.add({
      id: setId,
      title: title.trim() || source.title,
      sourceId: source.id,
      provider: provider.id,
      model: provider.model,
      status: 'generating',
      error: null,
      requested: { itemTypes: types, count: total },
      createdAt: now,
      updatedAt: now,
    })
    void startGeneration(setId, source, { itemTypes: types, perPage, reviewPass, answerCheck }, provider, embedder)
    navigate(`/set/${setId}`)
  }

  const pages = `${source.pages.length} page${source.pages.length === 1 ? '' : 's'}`
  return (
    <>
      <PageHeader
        eyebrow="New question set · Step 2 of 2"
        title="Choose the questions"
        lede="Pick question types and how many to write. You review every question before exporting."
      />
      <div className="configure-layout">
        <div className="source-card">
          <div>
            <span className="fine">Pages</span>
            <strong>{source.title}</strong>
            <span className="muted">{[pages, source.license?.label].filter(Boolean).join(' · ')}</span>
          </div>
          <a href="#/" className="button">
            Change pages
          </a>
        </div>
        <div className="form-stack">
          <label>
            Set name
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
            <small>Becomes the assignment name if you import into an ADAPT course.</small>
          </label>
          <fieldset>
            <legend>Question types</legend>
            <p className="hint">Questions take turns among the types you tick.</p>
            <div className="check-grid">
              {ITEM_TYPES.map((type) => (
                <label key={type} className="inline">
                  <input
                    type="checkbox"
                    checked={types.includes(type)}
                    onChange={(e) =>
                      setTypes((current) => (e.target.checked ? [...current, type] : current.filter((t) => t !== type)))
                    }
                  />
                  {ITEM_TYPE_LABELS[type]}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="narrow-field">
            {source.pages.length === 1 ? 'Number of questions' : 'Questions per page'}
            <input type="number" min={1} max={20} value={perPage} onChange={(e) => setPerPage(clamp(Number(e.target.value), 1, 20))} />
          </label>
          <label className="inline">
            <input type="checkbox" checked={reviewPass} onChange={(e) => setReview(e.target.checked)} />
            <span>
              <strong>Second-pass review</strong>
              <small>
                The model checks and revises each question, which catches wrong answer keys. Takes about twice as long.
                {skipsReview && ' Math questions are checked by the app instead.'}
              </small>
            </span>
          </label>
        </div>
        <div className="action-bar">
          <p className="muted">
            About {calls} model calls with{' '}
            {engine.provider === 'openai' ? `OpenAI ${engine.openaiModel}` : localModel(engine.localModel).label}
            {engine.provider === 'local' && total > 30 && '. Large sets take a long time in the browser.'}
          </p>
          <button type="button" className="primary" disabled={types.length === 0 || generation.running} onClick={start}>
            {generation.running ? 'Another set is being written…' : `Write ${total} question${total === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
      {error && (
        <p className="error mt" role="alert">
          {error} <a href="#/settings">Open Settings</a>
        </p>
      )}
    </>
  )
}

// Two books can share a title (e.g. first and second editions); the last URL
// segment tells them apart.
function bookPathHint(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname).split('/').filter(Boolean).pop() ?? ''
    return last.replace(/_/g, ' ')
  } catch {
    return ''
  }
}

function clamp(value: number, min: number, max: number) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min
}

// A source is credited to the part of the tree holding every page picked; the
// whole tree goes by the title and link the caller gives it.
function creditFor(
  tree: TocNode,
  pages: TocNode[],
  whole: { title: string; url: string; isBook: boolean },
): { title: string; url: string; kind: StoredSource['kind'] } {
  const part = partHolding(tree, pages)
  const kind = part.children.length === 0 ? 'page' : part === tree && whole.isBook ? 'book' : 'section'
  return part === tree ? { title: whole.title, url: whole.url, kind } : { title: part.title, url: part.url, kind }
}

function licenseFromCatalog(code: string): StoredSource['license'] {
  // Like a page's license tags, a code with no label (such as "mixed") names
  // no one license, so it is left for the instructor to fill in.
  const label = licenseLabel(code)
  return label ? { code, label, version: null } : null
}
