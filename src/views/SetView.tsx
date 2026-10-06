import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { ItemEditor } from '../components/ItemEditor'
import { ItemPreview, SourceCitations } from '../components/ItemPreview'
import { ITEM_TYPE_LABELS } from '../lib/generation/schema'
import { DEFAULT_VERSIONS, MAX_VERSIONS } from '../lib/math/spec'
import { downloadBlob, exportMathVersions, exportSet } from '../lib/qti/export'
import { db, type ItemStatus, type StoredItem, type StoredSource } from '../lib/storage/db'
import { cancelGeneration, useGeneration } from '../state/generation'
import { navigate } from '../router'

type Filter = 'all' | ItemStatus

export function SetView({ setId }: { setId: string }) {
  const set = useLiveQuery(() => db.sets.get(setId), [setId])
  const items = useLiveQuery(() => db.items.where('setId').equals(setId).sortBy('position'), [setId])
  const source = useLiveQuery(async () => (set ? db.sources.get(set.sourceId) : undefined), [set?.sourceId])
  const exports = useLiveQuery(
    () => db.exports.where('setId').equals(setId).reverse().sortBy('createdAt'),
    [setId],
  )
  const generation = useGeneration()
  const [filter, setFilter] = useState<Filter>('all')
  const [includeDrafts, setIncludeDrafts] = useState(false)
  const [randomizeMath, setRandomizeMath] = useState(false)
  const [versions, setVersions] = useState(DEFAULT_VERSIONS)
  const [exportError, setExportError] = useState<string | null>(null)

  if (set === undefined || items === undefined) return null
  if (set === null) {
    return (
      <div className="page">
        <p>That question set was not found in this browser.</p>
      </div>
    )
  }

  const running = generation.running && generation.setId === setId
  const visible = items.filter((item) => filter === 'all' || item.status === filter)
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
    <div className="page">
      <button type="button" className="link" onClick={() => navigate('/library')}>
        ← All sets
      </button>
      <h1>{set.title}</h1>
      <p className="muted">
        {source?.url ? (
          <a href={source.url} target="_blank" rel="noreferrer">
            {source.title}
          </a>
        ) : (
          source?.title
        )}
        {source?.license && <> · {source.license.label}</>} · {set.provider === 'openai' ? `OpenAI ${set.model}` : `In-browser ${set.model}`}
      </p>

      {running && (
        <div className="card progress" aria-live="polite">
          <div className="row spread">
            <strong>{generation.status}</strong>
            <button type="button" onClick={cancelGeneration}>
              Stop
            </button>
          </div>
          <progress max={generation.total || 1} value={generation.done} />
          <p className="muted">
            {generation.done} of {generation.total} · {generation.detail}
          </p>
        </div>
      )}
      {!running && set.error && <p className={set.status === 'failed' ? 'error' : 'notice'}>{set.error}</p>}

      <section className="card export">
        <div className="row spread">
          <div>
            <h2>Export for ADAPT</h2>
            <p className="muted">
              {approved} approved · {drafts} awaiting review · {items.length - approved - drafts} rejected
            </p>
          </div>
          <div className="export-actions">
            <label className="inline">
              <input type="checkbox" checked={includeDrafts} onChange={(e) => setIncludeDrafts(e.target.checked)} /> Include
              unreviewed drafts
            </label>
            <button
              type="button"
              className="primary"
              disabled={exportable === 0 || running}
              onClick={() => download(() => exportSet(setId, { includeDrafts, randomizeMath }))}
            >
              Download QTI (.zip) · {exportable}
            </button>
          </div>
        </div>
        {exportableMath > 0 && (
          <fieldset className="math-export">
            <legend>Math questions ({exportableMath})</legend>
            <label className="inline">
              <input type="radio" name="math-export" checked={!randomizeMath} onChange={() => setRandomizeMath(false)} /> One
              version each, in the QTI file above
            </label>
            <label className="inline">
              <input type="radio" name="math-export" checked={randomizeMath} onChange={() => setRandomizeMath(true)} />{' '}
              Randomized: a separate file where each math question has several versions and each student gets one
            </label>
            {randomizeMath && (
              <div className="row math-versions">
                <label className="inline">
                  Versions per question
                  <input
                    type="number"
                    min={2}
                    max={MAX_VERSIONS}
                    value={versions}
                    onChange={(e) => setVersions(Math.min(MAX_VERSIONS, Math.max(2, Math.round(Number(e.target.value)) || 2)))}
                  />
                </label>
                <button
                  type="button"
                  disabled={running}
                  onClick={() => download(() => exportMathVersions(setId, includeDrafts, versions))}
                >
                  Download math versions (.zip) · {exportableMath} × {versions}
                </button>
              </div>
            )}
            {randomizeMath && (
              <p className="fine">
                ADAPT turns each math question into its own assignment. Import this file into a course separately from the main
                file, with an assignment template where <strong>Randomizations</strong> is Yes and{' '}
                <strong>Number of randomized assessments</strong> is 1. ADAPT requires “Specify number of points” under Points
                Per Question to turn randomizations on.
              </p>
            )}
          </fieldset>
        )}
        {exportError && <p className="error">{exportError}</p>}
        <details>
          <summary>How to import into ADAPT</summary>
          <ol>
            <li>In ADAPT, open <strong>Question Editor → Bulk Import</strong> (instructor account).</li>
            <li>
              Choose <strong>Canvas QTI</strong> as the import template, pick a folder, author, and license
              {source?.license ? ` (${source.license.label} for this source)` : ''}, and optionally a course and assignment
              template.
            </li>
            <li>Upload the downloaded .zip and press Import. Each question is listed as it is imported.</li>
          </ol>
          <p className="fine">
            The file is Canvas-style QTI 1.2, the format ADAPT imports. It also imports into Canvas and most LMSs that accept
            Canvas quiz exports. In ADAPT, fill-in-the-blank accepts only the first answer, and essays are imported as
            open-ended questions.
          </p>
        </details>
        {exports && exports.length > 0 && (
          <details>
            <summary>Previous downloads ({exports.length})</summary>
            <ul className="exports">
              {exports.map((record) => (
                <li key={record.id}>
                  <button type="button" className="link" onClick={() => downloadBlob(record.zip, record.filename)}>
                    {record.filename}
                  </button>{' '}
                  <span className="muted">
                    {record.itemIds.length} questions · {new Date(record.createdAt).toLocaleString()}
                  </span>{' '}
                  <button type="button" className="danger-link" onClick={() => db.exports.delete(record.id)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <div className="row spread toolbar">
        <div className="tabs" role="tablist">
          {(['all', 'draft', 'approved', 'rejected'] as const).map((value) => (
            <button
              key={value}
              role="tab"
              aria-selected={filter === value}
              className={filter === value ? 'active' : ''}
              onClick={() => setFilter(value)}
            >
              {value === 'all' ? `All (${items.length})` : `${value[0].toUpperCase()}${value.slice(1)} (${items.filter((i) => i.status === value).length})`}
            </button>
          ))}
        </div>
        <div className="row">
          {drafts > 0 && (
            <button
              type="button"
              onClick={() =>
                db.items
                  .where('setId')
                  .equals(setId)
                  .filter((item) => item.status === 'draft')
                  .modify({ status: 'approved', updatedAt: Date.now() })
              }
            >
              Approve all drafts
            </button>
          )}
          {source && !generation.running && (
            <button type="button" onClick={() => navigate(`/new/${source.id}`)}>
              Generate more from this source
            </button>
          )}
        </div>
      </div>

      {visible.length === 0 && !running && <p className="muted">No questions here.</p>}
      <ol className="items">
        {visible.map((item) => (
          <ItemCard key={item.id} item={item} number={items.indexOf(item) + 1} source={source ?? null} />
        ))}
      </ol>
    </div>
  )
}

function ItemCard({ item, number, source }: { item: StoredItem; number: number; source: StoredSource | null }) {
  const [editing, setEditing] = useState(false)
  const [showSource, setShowSource] = useState(false)
  const page = source?.pages[item.sourcePageIndex]
  const setStatus = (status: ItemStatus) => db.items.update(item.id, { status, updatedAt: Date.now() })

  return (
    <li className={`card item ${item.status}`}>
      <header className="row spread">
        <div>
          <span className="number">{number}.</span> <strong>{item.draft.title}</strong>
          <div className="tags">
            <span className="tag">{ITEM_TYPE_LABELS[item.draft.item_type]}</span>
            <span className="tag">{item.draft.bloom}</span>
            <span className="tag">{item.draft.difficulty}</span>
            <span className="tag muted">{item.draft.concept_label}</span>
          </div>
        </div>
        <span className={`badge ${item.status}`}>{item.status}</span>
      </header>
      {editing ? (
        <ItemEditor
          draft={item.draft}
          onCancel={() => setEditing(false)}
          onSave={async (draft) => {
            await db.items.update(item.id, { draft, updatedAt: Date.now() })
            setEditing(false)
          }}
        />
      ) : (
        <ItemPreview draft={item.draft} />
      )}
      {item.critique.length > 0 && (
        <details className="critique">
          <summary>Reviewer notes ({item.critique.length})</summary>
          <ul>
            {item.critique.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </details>
      )}
      {showSource && page && <SourceCitations paragraphs={page.paragraphs} cited={item.draft.citation_paragraphs} />}
      {!editing && (
        <footer className="row actions">
          {item.status !== 'approved' && (
            <button type="button" className="primary" onClick={() => setStatus('approved')}>
              Approve
            </button>
          )}
          {item.status !== 'rejected' && (
            <button type="button" onClick={() => setStatus('rejected')}>
              Reject
            </button>
          )}
          {item.status !== 'draft' && (
            <button type="button" onClick={() => setStatus('draft')}>
              Back to draft
            </button>
          )}
          <button type="button" onClick={() => setEditing(true)}>
            Edit
          </button>
          {page && (
            <button type="button" onClick={() => setShowSource(!showSource)}>
              {showSource ? 'Hide source' : `Show source (${page.title})`}
            </button>
          )}
          <button
            type="button"
            className="danger-link"
            onClick={() => confirm('Delete this question?') && db.items.delete(item.id)}
          >
            Delete
          </button>
        </footer>
      )}
    </li>
  )
}
