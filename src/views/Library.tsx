import { useLiveQuery } from 'dexie-react-hooks'
import { Icon } from '../components/Icon'
import { PageHeader } from '../components/Page'
import { db, type StoredSet } from '../lib/storage/db'

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
    <>
      <PageHeader
        title="Question sets"
        lede="Saved in this browser only. Nothing is uploaded and no account is needed."
        action={
          sets.length > 0 && (
            <a href="#/" className="button primary">
              <Icon name="plus" /> New question set
            </a>
          )
        }
      />
      {sets.length === 0 ? (
        <div className="card empty">
          <p>No question sets yet.</p>
          <a href="#/" className="button primary">
            Create your first set
          </a>
        </div>
      ) : (
        <ul className="set-rows">
          {sets.map((set) => {
            const tally = counts?.[set.id] ?? { total: 0, approved: 0 }
            return (
              <li key={set.id}>
                <a href={`#/set/${set.id}`} className="row-link">
                  <span>
                    <strong>{set.title}</strong>
                    <span className="muted">
                      {new Date(set.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })} · {tally.total}{' '}
                      question{tally.total === 1 ? '' : 's'}
                    </span>
                  </span>
                  <SetProgress set={set} {...tally} />
                  <Icon name="chevron-right" />
                </a>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

const UNFINISHED: Partial<Record<StoredSet['status'], string>> = {
  generating: 'Being written',
  cancelled: 'Stopped early',
  failed: 'Failed',
}

function SetProgress({ set, total, approved }: { set: StoredSet; total: number; approved: number }) {
  const unfinished = UNFINISHED[set.status]
  return (
    <span className="set-progress">
      {total > 0 &&
        (approved === total ? (
          <span className="status approved">
            <Icon name="check" size={18} /> All approved
          </span>
        ) : (
          <span>
            {approved} of {total} approved
          </span>
        ))}
      {unfinished && <span className={`status ${set.status}`}>{unfinished}</span>}
    </span>
  )
}
