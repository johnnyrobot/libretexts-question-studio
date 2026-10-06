import { useEffect, useMemo, useState } from 'react'
import { TocPicker } from '../components/TocPicker'
import { loadCatalog, searchCatalog, type CatalogBook } from '../lib/content/catalog'
import { getTree, LIBRARIES, type Library, type TocNode } from '../lib/content/libretexts'
import {
  buildLibreTextsSource,
  buildPastedSource,
  resolveUrl,
  sourceCharacterCount,
  type ResolvedUrl,
} from '../lib/content/sources'
import { ITEM_TYPE_LABELS, ITEM_TYPES, type ItemType } from '../lib/generation/schema'
import { db, newId, type StoredSource } from '../lib/storage/db'
import { createProvider, useEngineSettings } from '../state/engine'
import { startGeneration, useGeneration } from '../state/generation'
import { navigate } from '../router'

type SourceTab = 'search' | 'url' | 'paste'

export function Create({ reuseSourceId }: { reuseSourceId?: string }) {
  const [source, setSource] = useState<StoredSource | null>(null)

  useEffect(() => {
    if (reuseSourceId) db.sources.get(reuseSourceId).then((found) => found && setSource(found))
  }, [reuseSourceId])

  return (
    <div className="page">
      <h1>Create a question set</h1>
      <p className="lede">
        Pick LibreTexts content, choose question types, and generate. Questions are saved in this browser as they are
        written; review them, then download a QTI file to import into ADAPT.
      </p>
      {source ? (
        <Configure source={source} onBack={() => setSource(null)} />
      ) : (
        <SourceStep onSource={setSource} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- step 1

function SourceStep({ onSource }: { onSource: (source: StoredSource) => void }) {
  const [tab, setTab] = useState<SourceTab>('search')
  return (
    <section className="card">
      <h2>1. Choose the source</h2>
      <div className="tabs" role="tablist">
        {(
          [
            ['search', 'Find a book'],
            ['url', 'Paste a LibreTexts link'],
            ['paste', 'Paste text'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'search' && <BookSearch onSource={onSource} />}
      {tab === 'url' && <UrlSource onSource={onSource} />}
      {tab === 'paste' && <PasteSource onSource={onSource} />}
    </section>
  )
}

function BookSearch({ onSource }: { onSource: (source: StoredSource) => void }) {
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

  const open = async (choice: CatalogBook) => {
    setBook(choice)
    setTree(null)
    setError(null)
    setBusy(true)
    try {
      const coverId = choice.id.slice(choice.id.indexOf('-') + 1)
      setTree(await getTree(choice.library, coverId))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const confirm = async (pages: TocNode[]) => {
    if (!book) return
    setBusy(true)
    setError(null)
    try {
      onSource(
        await buildLibreTextsSource({
          library: book.library,
          title: pages.length === 1 ? pages[0].title : (tree?.title ?? book.title),
          url: pages.length === 1 ? pages[0].url : book.url,
          kind: pages.length === 1 ? 'page' : 'section',
          pages,
          license: licenseFromCatalog(book.license),
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
        <button type="button" className="link" onClick={() => setBook(null)}>
          ← Back to results
        </button>
        <h3>{book.title}</h3>
        <p className="muted">
          {book.author && `${book.author} · `}
          {LIBRARIES[book.library]} · <a href={book.url} target="_blank" rel="noreferrer">Open on LibreTexts</a>
        </p>
        {error && <p className="error">{error}</p>}
        {!tree && busy && <p>Loading table of contents…</p>}
        {tree && <TocPicker tree={tree} selectAll={false} busy={busy} onConfirm={confirm} />}
        {progress && <p className="muted">{progress}</p>}
      </div>
    )
  }

  return (
    <div>
      <div className="row">
        <label className="grow">
          Search {books ? `${books.length.toLocaleString()} LibreTexts books` : 'LibreTexts books'}
          <input
            type="search"
            placeholder="e.g. general chemistry, anatomy, calculus"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
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
      {error && <p className="error">{error}</p>}
      {!books && !error && <p className="muted">Loading catalog…</p>}
      <ul className="results">
        {results.map((result) => (
          <li key={result.id}>
            <button type="button" onClick={() => open(result)}>
              <strong>{result.title}</strong>
              <span className="muted">
                {[result.author, LIBRARIES[result.library], result.subject || result.course].filter(Boolean).join(' · ')}
                {result.pages ? ` · ${result.pages} pages` : ''}
              </span>
              <span className="fine">{bookPathHint(result.url)}</span>
            </button>
          </li>
        ))}
      </ul>
      {books && (query.trim() || library) && results.length === 0 && <p className="muted">No books match.</p>}
      {snapshot && <p className="fine">Catalog snapshot from {snapshot}. Paste a link to use any newer book.</p>}
    </div>
  )
}

function UrlSource({ onSource }: { onSource: (source: StoredSource) => void }) {
  const [url, setUrl] = useState('')
  const [resolved, setResolved] = useState<ResolvedUrl | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState('')

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
      const isBook = resolved.book && `${resolved.page.library}-${resolved.page.id}` === resolved.book.id
      onSource(
        await buildLibreTextsSource({
          library: resolved.page.library,
          title: pages.length === 1 ? pages[0].title : resolved.page.title,
          url: pages.length === 1 ? pages[0].url : resolved.page.url,
          kind: resolved.tree.children.length === 0 ? 'page' : isBook ? 'book' : 'section',
          pages,
          license: resolved.page.license,
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
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          lookUp()
        }}
      >
        <label className="grow">
          A LibreTexts page, chapter, or book URL
          <input
            type="url"
            required
            placeholder="https://chem.libretexts.org/Bookshelves/…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <button type="submit" className="primary" disabled={busy}>
          {busy && !resolved ? 'Looking up…' : 'Look up'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {resolved && (
        <>
          {resolved.book && resolved.book.title !== resolved.page.title && (
            <p className="muted">From the book “{resolved.book.title}”.</p>
          )}
          {resolved.page.license && <p className="muted">License: {resolved.page.license.label}</p>}
          <TocPicker key={resolved.page.id} tree={resolved.tree} selectAll busy={busy} onConfirm={confirm} />
          {progress && <p className="muted">{progress}</p>}
        </>
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
      onSubmit={async (e) => {
        e.preventDefault()
        try {
          onSource(await buildPastedSource(title, text, url.trim() || null))
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }}
    >
      <p className="muted">
        Copy text from a LibreTexts page (or several) and paste it here. Paragraphs separated by line breaks are kept
        so each question can cite them.
      </p>
      <div className="row">
        <label className="grow">
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. 2.3: Evolution of Atomic Theory" />
        </label>
        <label className="grow">
          Source URL (optional)
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…libretexts.org/…" />
        </label>
      </div>
      <label>
        Textbook text
        <textarea required rows={12} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button type="submit" className="primary" disabled={!text.trim()}>
          Use this text
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------- step 2

const DEFAULT_TYPES: ItemType[] = ['multiple_choice', 'true_false', 'multiple_answers', 'fill_in_blank']

function Configure({ source, onBack }: { source: StoredSource; onBack: () => void }) {
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
  const characters = sourceCharacterCount(source)
  const calls = total * (reviewPass ? 2 : 1) + source.pages.length

  const start = async () => {
    setError(null)
    const provider = await createProvider(engine)
    if (typeof provider === 'string') {
      setError(provider)
      return
    }
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
    void startGeneration(setId, source, { itemTypes: types, perPage, reviewPass }, provider)
    navigate(`/set/${setId}`)
  }

  return (
    <section className="card">
      <h2>2. Configure questions</h2>
      <p>
        <strong>{source.title}</strong> · {source.pages.length} page{source.pages.length === 1 ? '' : 's'} ·{' '}
        {characters.toLocaleString()} characters
        {source.license && <> · {source.license.label}</>}{' '}
        <button type="button" className="link" onClick={onBack}>
          Change source
        </button>
      </p>
      <label>
        Set title (becomes the assignment name if you import into an ADAPT course)
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <fieldset>
        <legend>Question types (rotated across questions)</legend>
        <div className="checks">
          {ITEM_TYPES.map((type) => (
            <label key={type} className="inline">
              <input
                type="checkbox"
                checked={types.includes(type)}
                onChange={(e) =>
                  setTypes((current) => (e.target.checked ? [...current, type] : current.filter((t) => t !== type)))
                }
              />{' '}
              {ITEM_TYPE_LABELS[type]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="row">
        <label>
          {source.pages.length === 1 ? 'Number of questions' : 'Questions per page'}
          <input type="number" min={1} max={20} value={perPage} onChange={(e) => setPerPage(clamp(Number(e.target.value), 1, 20))} />
        </label>
        <label className="inline toggle">
          <input type="checkbox" checked={reviewPass} onChange={(e) => setReview(e.target.checked)} /> Second-pass review
          (critique and revise each question; about twice the time)
        </label>
      </div>
      <p className="summary">
        {total} question{total === 1 ? '' : 's'} · about {calls} model calls with{' '}
        {engine.provider === 'openai' ? `OpenAI ${engine.openaiModel} (${engine.effort} reasoning)` : 'the in-browser model'}
        {engine.provider === 'local' && total > 30 && ' — large sets can take a long time on the in-browser model.'}
      </p>
      {error && (
        <p className="error">
          {error} <a href="#/settings">Open Settings</a>
        </p>
      )}
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={types.length === 0 || generation.running}
          onClick={start}
        >
          {generation.running ? 'Another set is generating…' : `Generate ${total} question${total === 1 ? '' : 's'}`}
        </button>
      </div>
    </section>
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

function licenseFromCatalog(code: string): StoredSource['license'] {
  if (!code) return null
  const labels: Record<string, string> = {
    ccby: 'CC BY',
    ccbysa: 'CC BY-SA',
    ccbync: 'CC BY-NC',
    ccbyncsa: 'CC BY-NC-SA',
    ccbynd: 'CC BY-ND',
    ccbyncnd: 'CC BY-NC-ND',
    publicdomain: 'Public domain',
    gnu: 'GNU GPL',
    gnufdl: 'GNU FDL',
    arr: 'All rights reserved',
  }
  return { code, label: labels[code] ?? code, version: null }
}
