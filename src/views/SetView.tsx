import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState } from 'react'
import { CopyLink } from '../components/CopyLink'
import { Icon } from '../components/Icon'
import { ItemEditor } from '../components/ItemEditor'
import { ItemPreview, SourceCitations } from '../components/ItemPreview'
import { PageHeader } from '../components/Page'
import { TabPanel, Tabs } from '../components/Tabs'
import { withPageNumbers } from '../lib/content/normalize'
import { localModelLabel } from '../lib/llm/local-models'
import { splitNotes } from '../lib/generation/key-notes'
import { ITEM_TYPE_LABELS } from '../lib/generation/schema'
import { DEFAULT_VERSIONS, MAX_VERSIONS } from '../lib/math/spec'
import { downloadBlob, exportMathVersions, exportSet } from '../lib/qti/export'
import {
  db,
  deleteSet,
  getSetting,
  putSetting,
  type ItemStatus,
  type StoredItem,
  type StoredSet,
  type StoredSource,
} from '../lib/storage/db'
import { unlessGenerating, webLocks } from '../lib/storage/set-locks'
import { discardNewVersion, keepNewVersion } from '../lib/storage/versions'
import { createEmbedder, createProvider, useEngineSettings } from '../state/engine'
import { cancelGeneration, markInterruptedOnceReleased, NEW_VERSION_READY, startNewVersion, useGeneration } from '../state/generation'
import { navigate, pageLinkFor } from '../router'

// A set has two destinations: reviewing its questions (#/set/<id>) and
// exporting them (#/set/<id>/export).
export function SetView({ setId, tab }: { setId: string; tab: 'review' | 'export' }) {
  const set = useLiveQuery(async () => (await db.sets.get(setId)) ?? null, [setId])
  const items = useLiveQuery(() => db.items.where('setId').equals(setId).sortBy('position'), [setId])
  const source = useLiveQuery(async () => (set ? db.sources.get(set.sourceId) : undefined), [set?.sourceId])

  if (set === undefined || items === undefined) return null
  if (set === null) {
    return (
      <>
        <PageHeader crumbs={[['Question sets', '#/library']]} title="Set not found" />
        <p className="muted">That question set is not saved in this browser.</p>
      </>
    )
  }
  return tab === 'export' ? (
    <Export set={set} items={items} source={source ?? null} />
  ) : (
    <Review set={set} items={items} source={source ?? null} />
  )
}

// ---------------------------------------------------------------- review

const FILTERS = [
  ['all', 'All'],
  ['draft', 'Needs review'],
  ['approved', 'Approved'],
  ['rejected', 'Rejected'],
] as const

type Filter = 'all' | ItemStatus

function Review({ set, items, source }: { set: StoredSet; items: StoredItem[]; source: StoredSource | null }) {
  const generation = useGeneration()
  const [filter, setFilter] = useState<Filter>('all')
  // A run writing the whole set, or one writing a new version of a question
  // in it (shown on that question's card).
  const running = generation.running && generation.setId === set.id && !generation.itemId
  const rewriting = generation.running && generation.setId === set.id && !!generation.itemId
  // Still marked generating though this tab isn't writing it: another tab is,
  // as a set left so by a closed tab is marked interrupted when the app opens.
  // This tab's own run keeps its setId once over, until the status arrives.
  // Without Web Locks no tab can tell, so the page stays as it was.
  const elsewhere = set.status === 'generating' && generation.setId !== set.id && webLocks() !== undefined
  // That tab may be closed before it finishes.
  useEffect(() => {
    if (!elsewhere) return
    const watching = new AbortController()
    markInterruptedOnceReleased(set.id, watching.signal)
    return () => watching.abort()
  }, [elsewhere, set.id])
  const [deleteRefused, setDeleteRefused] = useState<string | null>(null)
  // The notice above says so while the run lasts, and Delete works after it.
  const [refusedAt, setRefusedAt] = useState(set.status)
  if (refusedAt !== set.status) {
    setRefusedAt(set.status)
    setDeleteRefused(null)
  }
  const visible = items.filter((item) => filter === 'all' || item.status === filter)
  const countOf = (value: Filter) => (value === 'all' ? items.length : items.filter((i) => i.status === value).length)
  const isMarked = (item: StoredItem) => splitNotes(item, set.provider).keyChecks.length > 0
  // Approved questions are already cleared by splitNotes; rejected ones won't be exported (LT-141).
  const draftItems = items.filter((item) => item.status === 'draft')
  const markedDrafts = draftItems.filter(isMarked).length
  // Approving all would clear every mark unread, so marked questions are
  // approved one by one (LT-145).
  const unmarkedDrafts = draftItems.length - markedDrafts

  return (
    <>
      <PageHeader
        crumbs={[['Question sets', '#/library'], [set.title]]}
        title={set.title}
        lede={<SourceLine set={set} source={source} />}
        action={
          <a href={`#/set/${set.id}/export`} className="button">
            <Icon name="download" /> Export to ADAPT
          </a>
        }
      />

      {running && (
        <section className="card run-card">
          <div className="run-head">
            <div role="status">
              <strong>{generation.status}</strong>
              <p className="muted">
                {generation.written} of {generation.total || '…'} questions written
              </p>
            </div>
            <button type="button" onClick={cancelGeneration}>
              Stop
            </button>
          </div>
          <progress max={generation.total || 1} value={generation.done} aria-label="Generation progress" />
          {generation.detail && (
            <details className="run-detail">
              <summary>Show model activity</summary>
              <p className="fine">{generation.detail}</p>
            </details>
          )}
        </section>
      )}
      {elsewhere && (
        <p className="notice" role="status">
          Questions are being written in another tab. They appear here as each one is written.
        </p>
      )}
      {!running && set.error && (
        <div className={`${set.status === 'failed' ? 'error' : 'notice'} dismissible`}>
          <p role="status">{set.error}</p>
          <button
            type="button"
            className="link"
            onClick={async () => {
              await db.sets.update(set.id, { error: null })
              focusMain()
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {items.length > 0 && (
        <div className="review-toolbar">
          <Tabs
            label="Show questions"
            tabs={FILTERS.map(([value, label]) => [value, `${label} (${countOf(value)})`] as const)}
            selected={filter}
            onSelect={setFilter}
            panelId="question-list"
          />
          {unmarkedDrafts > 1 && (
            <button
              type="button"
              onClick={async () => {
                await db.items
                  .where('setId')
                  .equals(set.id)
                  .filter((item) => item.status === 'draft' && !isMarked(item))
                  .modify({ status: 'approved', updatedAt: Date.now() })
                // This button is gone once no unmarked question needs review.
                focusSelectedTab()
              }}
            >
              {markedDrafts > 0 ? `Approve ${unmarkedDrafts} unmarked` : `Approve all ${unmarkedDrafts}`}
            </button>
          )}
        </div>
      )}
      {/* About half the wrong keys in testing had no such mark (LT-136). */}
      {markedDrafts > 0 && (
        <p className="key-check-count">
          <Icon name="alert" size={18} />
          <span>
            {markedDrafts} {markedDrafts === 1 ? 'question that needs review is' : 'questions that need review are'} marked “Check the answer key”:
            these are the answer keys most likely to be wrong. Unmarked keys can be wrong too, so check every answer key
            before you export.
          </span>
        </p>
      )}

      {items.length === 0 && !running && !elsewhere && <p className="muted">This set has no questions.</p>}
      {items.length > 0 && (
        <TabPanel panelId="question-list" selected={filter}>
          {visible.length === 0 && <p className="muted">No questions here.</p>}
          <ol className="items">
            {visible.map((item, index) => (
              <ItemCard
                key={item.id}
                item={item}
                set={set}
                number={items.indexOf(item) + 1}
                source={source}
                leavesView={(status) => filter !== 'all' && status !== filter}
                focusNext={() => {
                  const next = visible[index + 1] ?? visible[index - 1]
                  const target = next ? document.getElementById(`item-${next.id}`) : null
                  if (target) target.focus()
                  else focusSelectedTab()
                }}
              />
            ))}
          </ol>
        </TabPanel>
      )}

      <footer className="page-foot">
        {source && !generation.running ? (
          <a href={`#/new/${source.id}`} className="text-link">
            <Icon name="plus" size={18} /> Write more questions from these pages
          </a>
        ) : (
          <span />
        )}
        <div className="foot-action">
          <button
            type="button"
            className="danger-link"
            disabled={running || rewriting || elsewhere}
            aria-describedby={running || rewriting || elsewhere ? 'delete-wait' : undefined}
            onClick={async () => {
              if (!confirm(`Delete “${set.title}” and its ${items.length} questions from this browser?`)) return
              if (await unlessGenerating([set.id], () => deleteSet(set.id))) {
                setDeleteRefused(`“${set.title}” is being written in another tab. Delete it once its questions are written.`)
                return
              }
              navigate('/library')
            }}
          >
            Delete this set
          </button>
          {(running || rewriting || elsewhere) && (
            <p className="fine" id="delete-wait">
              {elsewhere && 'Being written in another tab. '}
              {rewriting ? 'Delete it once the new version is written.' : 'Delete it once its questions are written.'}
            </p>
          )}
        </div>
      </footer>
      {deleteRefused && (
        <p className="notice" role="status">
          {deleteRefused}
        </p>
      )}
    </>
  )
}

// For a control that disappears once used.
function focusMain() {
  document.getElementById('main')?.focus({ preventScroll: true })
}

function focusSelectedTab() {
  document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
}

function SourceLine({ set, source }: { set: StoredSet; source: StoredSource | null }) {
  const engine = set.provider === 'openai' ? `OpenAI ${set.model}` : `In-browser ${localModelLabel(set.model)}`
  // A set made from one LibreTexts page can be shared as a link that opens
  // the app on that page.
  const pageId = source?.kind === 'page' && source.pages.length === 1 ? source.pages[0].pageId : null
  return (
    <>
      {source?.url ? (
        <a href={source.url} target="_blank" rel="noreferrer">
          {source.title}
        </a>
      ) : (
        source?.title
      )}
      {source?.license && <> · {source.license.label}</>} · {engine}
      {source?.library && pageId && (
        <>
          {' '}
          <CopyLink href={pageLinkFor(source.library, pageId)} />
        </>
      )}
    </>
  )
}

const STATUS_LABELS: Record<ItemStatus, string> = { draft: 'Needs review', approved: 'Approved', rejected: 'Rejected' }

function ItemCard({
  item,
  set,
  number,
  source,
  leavesView,
  focusNext,
}: {
  item: StoredItem
  set: StoredSet
  number: number
  source: StoredSource | null
  leavesView: (status: ItemStatus) => boolean
  focusNext: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [showSource, setShowSource] = useState(false)
  const editButton = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef(false)
  const page = source?.pages[item.sourcePageIndex]
  const { draft, newVersion } = item
  const { keyChecks, notes } = splitNotes(item, set.provider)
  // Shown while editing too, above the fields: fixing a key starts from why
  // it was marked (LT-145).
  const keyCheckNoticeId = `key-check-notice-${item.id}`
  const keyCheckNotice = keyChecks.length > 0 && (
    <KeyCheckNotice id={keyCheckNoticeId} headingId={`key-check-${item.id}`} keyChecks={keyChecks} />
  )
  const versions = useNewVersion(item, set, source)

  // Closing the editor puts focus back on the Edit button that opened it.
  useEffect(() => {
    if (editing || !returnFocus.current) return
    returnFocus.current = false
    editButton.current?.focus()
  }, [editing])

  const closeEditor = () => {
    returnFocus.current = true
    setEditing(false)
  }

  // Approve and Reject are toggles: pressing the active one again returns the
  // question to review. A question that drops out of the current filter hands
  // focus to its neighbour.
  const toggle = async (status: Exclude<ItemStatus, 'draft'>) => {
    const next = item.status === status ? 'draft' : status
    await db.items.update(item.id, { status: next, updatedAt: Date.now() })
    if (leavesView(next)) focusNext()
  }

  return (
    <li className={`card item ${item.status}`}>
      <header className="item-head">
        <span className="item-number" aria-hidden="true">
          {number}
        </span>
        <div>
          <h2 id={`item-${item.id}`} tabIndex={-1}>
            <span className="sr-only">Question {number}: </span>
            {draft.title}
          </h2>
          <p>
            {ITEM_TYPE_LABELS[draft.item_type]} · {capitalize(draft.bloom)} · {capitalize(draft.difficulty)}
          </p>
          {keyChecks.length > 0 && (
            <p className="key-check-badge">
              <Icon name="alert" size={16} /> Check the answer key
            </p>
          )}
        </div>
        <span className={`status ${item.status}`}>
          {item.status === 'approved' && <Icon name="check" size={18} />}
          {item.status === 'rejected' && <Icon name="x" size={18} />}
          {STATUS_LABELS[item.status]}
        </span>
      </header>
      {editing && keyCheckNotice}
      {editing ? (
        <ItemEditor
          draft={draft}
          titleDescribedBy={keyCheckNotice ? keyCheckNoticeId : undefined}
          onCancel={closeEditor}
          onSave={async (next) => {
            await db.items.update(item.id, { draft: next, updatedAt: Date.now() })
            closeEditor()
          }}
          onDelete={async () => {
            if (!confirm('Delete this question?')) return
            focusNext()
            await db.items.delete(item.id)
          }}
        />
      ) : (
        <>
          {newVersion && <h3 className="label">Current version</h3>}
          <ItemPreview draft={draft} />
        </>
      )}
      {!editing && keyCheckNotice}
      <Notes notes={notes} />
      {newVersion && !editing && (
        <NewVersion
          item={item}
          provider={set.provider}
          onKeep={async () => {
            await keepNewVersion(item.id)
            // Kept, it needs review again.
            versions.chose('Kept the new version. Review it before you export.', leavesView('draft'))
          }}
          onDiscard={async () => {
            await discardNewVersion(item.id)
            versions.chose('Kept the current version.', false)
          }}
        />
      )}
      {versions.writing && (
        <div className="new-version-run">
          {/* One question has no steps to count, so its bar just moves. */}
          <progress aria-label="Writing a new version" />
          <button type="button" onFocus={versions.cancelFocused} onBlur={versions.cancelBlurred} onClick={versions.cancel}>
            Cancel
          </button>
          {versions.detail && (
            <details className="run-detail">
              <summary>Show model activity</summary>
              <p className="fine">{versions.detail}</p>
            </details>
          )}
        </div>
      )}
      {/* Always in the page, so what it says next is announced. */}
      <p className="new-version-status fine" role="status">
        {versions.message}
      </p>
      {showSource && page && !editing && (
        <div className="source-text">
          <h3 className="label">From “{page.title}”</h3>
          <p className="fine">Concept: {draft.concept_label}</p>
          <SourceCitations paragraphs={withPageNumbers(page.paragraphs, page.title)} cited={draft.citation_paragraphs} />
        </div>
      )}
      {!editing && (
        <footer className="item-actions">
          <div className="actions">
            <button
              type="button"
              className={item.status === 'approved' ? 'toggle-on approve' : 'primary'}
              aria-pressed={item.status === 'approved'}
              onClick={() => toggle('approved')}
            >
              {item.status === 'approved' && <Icon name="check" size={18} />}
              Approve
            </button>
            <button
              type="button"
              className={item.status === 'rejected' ? 'toggle-on reject' : undefined}
              aria-pressed={item.status === 'rejected'}
              onClick={() => toggle('rejected')}
            >
              {item.status === 'rejected' && <Icon name="x" size={18} />}
              Reject
            </button>
            <button type="button" ref={editButton} onClick={() => setEditing(true)}>
              Edit
            </button>
            {/* With a new version waiting, the choice comes first. */}
            {page && !newVersion && (
              <button type="button" disabled={versions.busy} onClick={versions.write}>
                Write a new version
              </button>
            )}
          </div>
          {page && (
            <div className="quiet">
              <button type="button" className="link" aria-expanded={showSource} onClick={() => setShowSource(!showSource)}>
                {showSource ? 'Hide source text' : 'Show source text'}
              </button>
            </div>
          )}
        </footer>
      )}
    </li>
  )
}

function KeyCheckNotice({ id, headingId, keyChecks }: { id?: string; headingId: string; keyChecks: string[] }) {
  return (
    <section id={id} className="notice key-check" aria-labelledby={headingId}>
      <h3 id={headingId} className="label">
        Check the answer key
      </h3>
      <ul>
        {keyChecks.map((note, index) => (
          <li key={index}>{note}</li>
        ))}
      </ul>
    </section>
  )
}

function Notes({ notes }: { notes: string[] }) {
  if (!notes.length) return null
  return (
    <details className="critique">
      <summary>Notes ({notes.length})</summary>
      <ul>
        {notes.map((note, index) => (
          <li key={index}>{note}</li>
        ))}
      </ul>
    </details>
  )
}

// A new version waits beside the current one, with its own notes, until the
// instructor keeps one of them (LT-201). It has not been reviewed yet.
function NewVersion({
  item,
  provider,
  onKeep,
  onDiscard,
}: {
  item: StoredItem
  provider: StoredSet['provider'] | undefined
  onKeep: () => void
  onDiscard: () => void
}) {
  const pending = item.newVersion!
  const { keyChecks, notes } = splitNotes({ ...pending, status: 'draft' }, provider)
  const headingId = `new-version-${item.id}`
  return (
    <section className="new-version" aria-labelledby={headingId}>
      <h3 id={headingId} className="label" tabIndex={-1}>
        New version
      </h3>
      <p className="new-version-title">{pending.draft.title}</p>
      <ItemPreview draft={pending.draft} />
      {keyChecks.length > 0 && <KeyCheckNotice headingId={`new-version-key-check-${item.id}`} keyChecks={keyChecks} />}
      <Notes notes={notes} />
      <div className="actions">
        <button type="button" className="primary" onClick={onKeep}>
          Keep the new version
        </button>
        <button type="button" onClick={onDiscard}>
          Keep the current version
        </button>
      </div>
    </section>
  )
}

// Writing a new version of one question: starting it with the engine set
// now, checked as the set's first draft was (pipeline.ts, writeNewVersion),
// and what the card says about it. The run itself is the app's one run, so
// it carries on if the instructor leaves the page.
function useNewVersion(item: StoredItem, set: StoredSet, source: StoredSource | null) {
  const engine = useEngineSettings()
  const generation = useGeneration()
  const thisRun = generation.itemId === item.id && generation.setId === item.setId
  const writing = thisRun && generation.running
  // What the card last said in its own right: the engine wasn't ready, or
  // which version was kept. A run's own status is said once it starts.
  const [said, setSaid] = useState<{ message: string; at: number } | null>(null)
  const [startedAt, setStartedAt] = useState(0)
  // Only a run this card has seen has anything to say on it: the run's last
  // status outlives it, and a card shown afresh would repeat it.
  const [followed, setFollowed] = useState(writing)
  if (writing && !followed) setFollowed(true)
  // Focus would be lost with the Cancel button once the run ends, so it goes
  // to the new version, which can show a moment after the run ends, or back
  // to the question when there is none. A button taken out of the page sends
  // no blur, so this stays set then.
  const cancelHadFocus = useRef(false)
  const written = thisRun && generation.status === NEW_VERSION_READY
  useEffect(() => {
    if (writing || !cancelHadFocus.current) return
    const pending = document.getElementById(`new-version-${item.id}`)
    if (written && !pending) return
    cancelHadFocus.current = false
    const target = pending ?? document.getElementById(`item-${item.id}`)
    target?.focus()
  }, [writing, written, item.id, item.newVersion])

  const write = async () => {
    setSaid(null)
    cancelHadFocus.current = false
    if (!source) return
    const provider = await createProvider(engine)
    if (typeof provider === 'string') {
      setSaid({ message: provider, at: Date.now() })
      return
    }
    const embedder = await createEmbedder(engine)
    // Sets saved before LT-201 were written with the review on.
    const checks = { reviewPass: set.requested.reviewPass ?? true, answerCheck: provider.id === 'local' || engine.answerCheck }
    setStartedAt(Date.now())
    try {
      await startNewVersion(item.id, item.setId, source, checks, provider, embedder)
    } catch (error) {
      // Another run started in the moment before.
      setSaid({ message: error instanceof Error ? error.message : String(error), at: Date.now() })
    }
  }

  const cancel = () => {
    cancelHadFocus.current = false
    document.getElementById(`item-${item.id}`)?.focus()
    cancelGeneration()
  }

  // Focus moves to the question, or to its neighbour when it leaves the filter.
  const chose = (message: string, leaves: boolean) => {
    setSaid({ message, at: Date.now() })
    if (!leaves) document.getElementById(`item-${item.id}`)?.focus()
  }

  const runMessage = thisRun && followed && (said === null || said.at < startedAt) ? generation.status : null
  return {
    writing,
    busy: generation.running,
    detail: writing ? generation.detail : '',
    message: runMessage ?? said?.message ?? '',
    cancelFocused: () => (cancelHadFocus.current = true),
    cancelBlurred: () => (cancelHadFocus.current = false),
    write,
    cancel,
    chose,
  }
}

function capitalize(value: string): string {
  return value[0].toUpperCase() + value.slice(1)
}

// ---------------------------------------------------------------- export

// The author name typed at export, kept in this browser for the next export.
const EXPORT_AUTHOR = 'exportAuthor'

function Export({ set, items, source }: { set: StoredSet; items: StoredItem[]; source: StoredSource | null }) {
  const exports = useLiveQuery(() => db.exports.where('setId').equals(set.id).reverse().sortBy('createdAt'), [set.id])
  const generation = useGeneration()
  const [includeDrafts, setIncludeDrafts] = useState(false)
  const [randomizeMath, setRandomizeMath] = useState(false)
  const [versions, setVersions] = useState(DEFAULT_VERSIONS)
  const [exportError, setExportError] = useState<string | null>(null)
  // null until the remembered name has loaded.
  const [author, setAuthor] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // An unreadable setting names no one, rather than keeping downloads waiting.
    getSetting(EXPORT_AUTHOR, '')
      .catch(() => '')
      .then((saved) => {
        if (!cancelled) setAuthor((typed) => typed ?? saved)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const changeAuthor = (value: string) => {
    setAuthor(value)
    void putSetting(EXPORT_AUTHOR, value)
  }
  const authorName = author ?? ''
  // A download before the remembered name loads would leave the author out.
  const authorLoading = author === null

  // A new version waiting to be chosen is not exported, so it doesn't hold export up.
  const running = generation.running && generation.setId === set.id && !generation.itemId
  const approved = items.filter((item) => item.status === 'approved').length
  const drafts = items.filter((item) => item.status === 'draft').length
  const exportableItems = items.filter((i) => (includeDrafts ? i.status !== 'rejected' : i.status === 'approved'))
  const exportableMath = exportableItems.filter((i) => i.draft.item_type === 'math').length
  const exportable = exportableItems.length - (randomizeMath ? exportableMath : 0)

  const download = async (build: () => Promise<{ zip: Blob; filename: string }>) => {
    setExportError(null)
    try {
      const record = await build()
      downloadBlob(record.zip, record.filename)
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <PageHeader
        crumbs={[['Question sets', '#/library'], [set.title, `#/set/${set.id}`], ['Export']]}
        title="Export to ADAPT"
        lede="Download a QTI file, then upload it with ADAPT’s Bulk Import."
      />

      {running && <p className="notice">Questions are still being written. Export when the run finishes.</p>}

      <div className="export-layout">
        <div>
          <section className="card download-card">
            <div className="download-main">
              <Icon name="file" size={36} />
              <div>
                <strong>QTI file (.zip)</strong>
                <span className="muted">
                  {exportable} question{exportable === 1 ? '' : 's'}
                  {randomizeMath && exportableMath > 0 && ', not counting randomized math'}
                </span>
              </div>
              <button
                type="button"
                className="primary"
                disabled={exportable === 0 || running || authorLoading}
                onClick={() => download(() => exportSet(set.id, { includeDrafts, randomizeMath, author: authorName }))}
              >
                <Icon name="download" /> Download
              </button>
            </div>
            <label>
              Author name <small>(optional)</small>
              <input value={authorName} onChange={(e) => changeAuthor(e.target.value)} autoComplete="name" />
              <small>
                Named as the questions’ author in the file and in each quiz’s instructions, which students see. Remembered in
                this browser only.
              </small>
            </label>
            {drafts > 0 && (
              <label className="inline">
                <input type="checkbox" checked={includeDrafts} onChange={(e) => setIncludeDrafts(e.target.checked)} />
                Also include the {drafts} question{drafts === 1 ? ' that still needs' : 's that still need'} review
              </label>
            )}
            {approved === 0 && !includeDrafts && (
              <p className="muted">
                No questions are approved yet. <a href={`#/set/${set.id}`}>Review questions</a>
              </p>
            )}
            {exportError && (
              <p className="error" role="alert">
                {exportError}
              </p>
            )}
          </section>

          {exportableMath > 0 && (
            <section className="section-gap">
              <h2>Math questions ({exportableMath})</h2>
              <fieldset className="choice-cards">
                <legend className="sr-only">How to export math questions</legend>
                <label className="option">
                  <input type="radio" name="math-export" checked={!randomizeMath} onChange={() => setRandomizeMath(false)} />
                  <span>
                    <strong>One version each</strong>
                    <span className="muted">Included in the file above. Every student sees the same numbers.</span>
                  </span>
                </label>
                <label className="option">
                  <input type="radio" name="math-export" checked={randomizeMath} onChange={() => setRandomizeMath(true)} />
                  <span>
                    <strong>Randomized</strong>
                    <span className="muted">A separate file. Each student gets one of several versions.</span>
                  </span>
                </label>
              </fieldset>
              {randomizeMath && (
                <div className="card mt">
                  <div className="search-row">
                    <label className="narrow-field">
                      Versions per question
                      <input
                        type="number"
                        min={2}
                        max={MAX_VERSIONS}
                        value={versions}
                        onChange={(e) => setVersions(Math.min(MAX_VERSIONS, Math.max(2, Math.round(Number(e.target.value)) || 2)))}
                      />
                    </label>
                    <button type="button" disabled={running || authorLoading} onClick={() => download(() => exportMathVersions(set.id, includeDrafts, versions, authorName))}>
                      <Icon name="download" /> Download math versions
                    </button>
                  </div>
                  <p className="fine mt">
                    ADAPT turns each math question into its own assignment. Import this file into a course on its own, with an
                    assignment template whose Dynamic Questioning settings are <strong>Random sampling</strong>: Yes and{' '}
                    <strong>Number of randomized assessments</strong>: 1. Leave Points Per Question on “Specify the points for
                    each question individually” (the default).
                  </p>
                </div>
              )}
            </section>
          )}
        </div>

        <div>
          <section className="section-gap">
            <h2>Import into ADAPT</h2>
            <ol className="steps">
              <li>
                In ADAPT (instructor account), open <strong>Dashboard → My Questions</strong>, then the <strong>Bulk Import</strong> tab.
              </li>
              <li>
                Choose <strong>Canvas QTI</strong> as the import template. Pick a folder, author, and license
                {source?.license ? ` (${source.license.label} for this source)` : ''}, and optionally a course and assignment
                template.
              </li>
              <li>Upload the .zip and press Import. Each question is listed as it is imported.</li>
            </ol>
            <p className="fine">
              The file is Canvas-style QTI 1.2, so it also imports into Canvas and most LMSs that accept Canvas quiz exports. In
              ADAPT, fill-in-the-blank accepts only the first answer, and essays become open-ended questions.
            </p>
            {exportableItems.some((i) => i.draft.item_type === 'essay') && (
              <p className="fine">
                Essays take the assignment’s <strong>Default Open-ended Submission Type</strong>. If you import into a
                course, choose an assignment template where it is Rich Text; with None, ADAPT gives students nothing to submit
                until you change it on each essay.
              </p>
            )}
          </section>

          {exports && exports.length > 0 && (
            <section className="section-gap">
              <h2>Earlier downloads</h2>
              <ul className="downloads">
                {exports.map((record) => (
                  <li key={record.id}>
                    <span className="filename">
                      <button type="button" className="link" onClick={() => downloadBlob(record.zip, record.filename)}>
                        {record.filename}
                      </button>
                      <br />
                      <span className="fine">
                        {record.itemIds.length} questions ·{' '}
                        {new Date(record.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                      </span>
                    </span>
                    <button type="button" className="danger-link" onClick={() => db.exports.delete(record.id)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </>
  )
}
