import { useLiveQuery } from 'dexie-react-hooks'
import { db, deleteSet } from '../lib/storage/db'
import { navigate } from '../router'

export function Library() {
  const sets = useLiveQuery(() => db.sets.orderBy('createdAt').reverse().toArray(), [])
  const counts = useLiveQuery(async () => {
    const all = await db.items.toArray()
    const tally: Record<string, { total: number; approved: number }> = {}
    for (const item of all) {
      tally[item.setId] ??= { total: 0, approved: 0 }
      tally[item.setId].total++
      if (item.status === 'approved') tally[item.setId].approved++
    }
    return tally
  }, [])

  if (!sets) return null
  return (
    <div className="page">
      <h1>Your question sets</h1>
      <p className="lede">Everything here is stored only in this browser. Nothing is uploaded and no account is needed.</p>
      {sets.length === 0 ? (
        <div className="card empty">
          <p>No question sets yet.</p>
          <button type="button" className="primary" onClick={() => navigate('/')}>
            Create your first set
          </button>
        </div>
      ) : (
        <ul className="set-list">
          {sets.map((set) => {
            const tally = counts?.[set.id] ?? { total: 0, approved: 0 }
            return (
              <li key={set.id} className="card">
                <a href={`#/set/${set.id}`} className="set-link">
                  <strong>{set.title}</strong>
                  <span className="muted">
                    {tally.total} question{tally.total === 1 ? '' : 's'} · {tally.approved} approved ·{' '}
                    {new Date(set.createdAt).toLocaleDateString()} · {set.provider === 'openai' ? set.model : 'in-browser'}
                  </span>
                </a>
                <span className={`badge ${set.status}`}>{set.status}</span>
                <button
                  type="button"
                  className="danger-link"
                  onClick={() => {
                    if (confirm(`Delete “${set.title}” and its ${tally.total} questions from this browser?`)) {
                      void deleteSet(set.id)
                    }
                  }}
                >
                  Delete
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
