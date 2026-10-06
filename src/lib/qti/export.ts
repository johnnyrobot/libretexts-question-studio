import type { DraftOf } from '../generation/schema'
import { compileMath, MathSpecError } from '../math/spec'
import { db, newId, type StoredExport, type StoredItem } from '../storage/db'
import { buildQuizPackage, mathVersion, type QuizPackageInput } from './canvas'

// Builds the ADAPT-importable QTI zips for a set and keeps a copy in IndexedDB
// so earlier exports can be downloaded again without regenerating anything.
//
// Math questions go one of two ways. Fixed: each exports its first version as
// a numerical question in the main quiz. Randomized: they leave the main quiz
// and exportMathVersions writes one quiz per math question holding every
// version. ADAPT makes each quiz an assignment, and an assignment template
// with Randomizations on (1 randomized assessment) shows each student one.

export interface ExportOptions {
  includeDrafts: boolean
  randomizeMath: boolean
}

export async function exportSet(setId: string, options: ExportOptions): Promise<StoredExport> {
  const { set, description, items } = await load(setId, options.includeDrafts)
  const quizItems = options.randomizeMath ? items.filter((item) => item.draft.item_type !== 'math') : items
  if (quizItems.length === 0) {
    throw new Error('Every question to export is a math question; download them with “Download math versions”.')
  }
  const zip = buildQuizPackage([
    { id: set.id, title: set.title, description, items: quizItems.map((item) => ({ id: item.id, draft: item.draft })) },
  ])
  return save(setId, `${slug(set.title)}-adapt-qti.zip`, quizItems, zip)
}

export async function exportMathVersions(setId: string, includeDrafts: boolean, versions: number): Promise<StoredExport> {
  const { set, description, items } = await load(setId, includeDrafts)
  const math = items.filter((item): item is StoredItem & { draft: DraftOf<'math'> } => item.draft.item_type === 'math')
  if (math.length === 0) throw new Error('There are no math questions to export.')
  const quizzes: QuizPackageInput[] = math.map((item) => {
    let variants
    try {
      variants = compileMath(item.draft, versions).variants
    } catch (error) {
      if (error instanceof MathSpecError) throw new Error(`“${item.draft.title}”: ${error.message}`)
      throw error
    }
    return {
      id: `${set.id}:${item.id}`,
      title: item.draft.title,
      description,
      items: variants.map((variant, index) => ({
        id: index === 0 ? item.id : `${item.id}:v${index + 1}`,
        draft: mathVersion(item.draft, variant, `${item.draft.title} (version ${index + 1})`),
      })),
    }
  })
  return save(setId, `${slug(set.title)}-math-versions-adapt-qti.zip`, math, buildQuizPackage(quizzes))
}

async function load(setId: string, includeDrafts: boolean) {
  const set = await db.sets.get(setId)
  if (!set) throw new Error('That question set no longer exists.')
  const source = await db.sources.get(set.sourceId)
  const items = (await db.items.where('setId').equals(setId).sortBy('position')).filter((item) =>
    includeDrafts ? item.status !== 'rejected' : item.status === 'approved',
  )
  if (items.length === 0) {
    throw new Error(includeDrafts ? 'There are no questions to export.' : 'Approve at least one question to export.')
  }
  const description = source?.url
    ? `Questions generated from ${source.title} (${source.url}). Review before assigning.`
    : `Questions generated from ${source?.title ?? 'a LibreTexts source'}. Review before assigning.`
  return { set, description, items }
}

async function save(setId: string, filename: string, items: StoredItem[], zip: Uint8Array): Promise<StoredExport> {
  const record: StoredExport = {
    id: newId(),
    setId,
    filename,
    itemIds: items.map((item) => item.id),
    zip: new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' }),
    createdAt: Date.now(),
  }
  await db.exports.add(record)
  return record
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function slug(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'questions'
  )
}
