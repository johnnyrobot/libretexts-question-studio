import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SAMPLE_DRAFTS } from '../qti/fixtures'
import { createBackup, restoreBackup } from './backup'
import { db, type StoredSet } from './db'
import { FakeLocks } from './fixtures'

describe('backup', () => {
  it('round-trips sets and questions and rejects other files', async () => {
    await db.sources.put({ id: 's', kind: 'paste', title: 'T', library: null, url: null, license: null, pages: [], createdAt: 1 })
    await db.sets.put({
      id: 'set', title: 'Set', sourceId: 's', provider: 'local', model: 'm', status: 'complete', error: null,
      requested: { itemTypes: [], count: 1 }, createdAt: 1, updatedAt: 1,
    })
    await db.items.put({
      id: 'i', setId: 'set', position: 0, status: 'approved', draft: SAMPLE_DRAFTS[0], sourcePageIndex: 0, critique: [],
      createdAt: 1, updatedAt: 1,
    })
    // Written before the rule against figure references, which applies only to model output.
    const older = { ...SAMPLE_DRAFTS[0], stem: 'In Figure 4.3.1, which gas do plants absorb?' }
    await db.items.put({
      id: 'old', setId: 'set', position: 1, status: 'draft', draft: older, sourcePageIndex: 0, critique: [],
      createdAt: 1, updatedAt: 1,
    })
    const blob = await createBackup()
    await Promise.all([db.items.clear(), db.sets.clear(), db.sources.clear()])
    const file = new File([await blob.text()], 'backup.json')
    expect(await restoreBackup(file)).toEqual({ sets: 1, items: 2 })
    expect((await db.items.get('i'))?.draft.stem).toBe(SAMPLE_DRAFTS[0].stem)
    expect((await db.items.get('old'))?.draft.stem).toBe(older.stem)
    await expect(restoreBackup(new File(['{"x":1}'], 'other.json'))).rejects.toThrow(/not a Question Studio backup/)
  })
})

describe('backing up a question with a new version waiting', () => {
  const concept = { label: 'Inputs', description: 'What plants take in', source_paragraphs: [0], quantitative: false }
  const question = (newVersion: unknown) => ({
    id: 'i', setId: 'set', position: 0, status: 'approved', draft: SAMPLE_DRAFTS[0], sourcePageIndex: 0, critique: [],
    concept, newVersion, createdAt: 1, updatedAt: 1,
  })
  const restore = async (newVersion: unknown) => {
    await db.items.clear()
    const backup = { format: 'libretexts-question-studio-backup', version: 1, createdAt: '', sources: [], sets: [], items: [question(newVersion)] }
    await restoreBackup(new File([JSON.stringify(backup)], 'backup.json'))
    return (await db.items.get('i'))!
  }

  it('keeps the new version, checked like the current one', async () => {
    // Spaces the schema trims show it was checked.
    const newVersion = { draft: { ...SAMPLE_DRAFTS[1], stem: `  ${SAMPLE_DRAFTS[1].stem}  ` }, critique: ['A note'], concept, createdAt: 2 }
    const restored = await restore(newVersion)
    expect(restored.concept).toEqual(concept)
    expect(restored.newVersion).toEqual({ ...newVersion, draft: SAMPLE_DRAFTS[1] })
  })

  it('drops a new version that is no longer a valid question, keeping the question', async () => {
    const restored = await restore({ draft: { item_type: 'multiple_choice', stem: 'Broken' }, critique: [], concept, createdAt: 2 })
    expect(restored.draft).toEqual(SAMPLE_DRAFTS[0])
    expect(restored.newVersion).toBeUndefined()
  })
})

describe('restoring while a set is being written', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const set = (status: StoredSet['status']): StoredSet => ({
    id: 'set', title: 'Leaf quiz', sourceId: 's', provider: 'local', model: 'm', status, error: null,
    requested: { itemTypes: [], count: 1 }, createdAt: 1, updatedAt: 1,
  })

  // Another tab, or this one, holds a set's lock for as long as it writes the
  // set's questions (LT-74), so a restore would undo what it writes (LT-82).
  it('refuses, changing nothing, while a tab writes a set in the backup', async () => {
    await Promise.all([db.items.clear(), db.sets.clear(), db.sources.clear()])
    await db.sources.put({ id: 's', kind: 'paste', title: 'T', library: null, url: null, license: null, pages: [], createdAt: 1 })
    await db.sets.put({ ...set('complete'), id: 'first', title: 'Stems' })
    await db.sets.put(set('complete'))
    const file = new File([await (await createBackup()).text()], 'backup.json')
    await db.sets.update('first', { title: 'Stems, renamed' })
    await db.sets.put(set('generating'))
    const locks = new FakeLocks()
    vi.stubGlobal('navigator', { locks })
    void locks.request('generation:set', () => new Promise(() => {}))

    await expect(restoreBackup(file)).rejects.toThrow(
      '“Leaf quiz” is still being written. Restore the backup once its questions are written.',
    )
    expect((await db.sets.get('set'))?.status).toBe('generating')
    expect((await db.sets.get('first'))?.title).toBe('Stems, renamed')

    // The run ends, or its tab closes.
    locks.closeTab()
    expect(await restoreBackup(file)).toEqual({ sets: 2, items: 0 })
    expect((await db.sets.get('set'))?.status).toBe('complete')
  })
})
