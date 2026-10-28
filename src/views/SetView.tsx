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
import { cancelGeneration, markInterruptedOnceReleased, useGeneration } from '../state/generation'
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
  const running = generation.running && generation.setId === set.id
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
  const drafts = items.filter((item) => item.status === 'draft').length
  const countOf = (value: Filter) => (value === 'all' ? items.length : items.filter((i) => i.status === value).length)

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
          {drafts > 1 && (
            <button
              type="button"
              onClick={async () => {
                await db.items
                  .where('setId')
                  .equals(set.id)
                  .filter((item) => item.status === 'draft')
                  .modify({ status: 'approved', updatedAt: Date.now() })
                // This button is gone once nothing needs review.
                focusSelectedTab()
              }}
            >
              Approve all {drafts}
            </button>
          )}
        </div>
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
        <button
          type="button"
          className="danger-link"
          disabled={running || elsewhere}
          title={elsewhere ? 'Being written in another tab' : undefined}
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
  // the app on that page (LT-87).
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
  number,
  source,
  leavesView,
  focusNext,
}: {
  item: StoredItem
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
  const { draft } = item

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
        </div>
        <span className={`status ${item.status}`}>
          {item.status === 'approved' && <Icon name="check" size={18} />}
          {item.status === 'rejected' && <Icon name="x" size={18} />}
          {STATUS_LABELS[item.status]}
        </span>
      </header>
      {editing ? (
        <ItemEditor
          draft={draft}
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
        <ItemPreview draft={draft} />
      )}
      {item.critique.length > 0 && !editing && (
        <details className="critique">
          <summary>Reviewer notes ({item.critique.length})</summary>
          <ul>
            {item.critique.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </details>
      )}
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

  const running = generation.running && generation.setId === set.id
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
