import { useSyncExternalStore } from 'react'
import {
  runGeneration,
  writeNewVersion,
  type GenerationPlan,
  type GenerationResult,
  type QuestionChecks,
} from '../lib/generation/pipeline'
import { GpuLost, type Embedder, type LLMProvider, type ProgressEvent } from '../lib/llm/types'
import { db, type StoredSource } from '../lib/storage/db'
import { generationLockName, webLocks, withGenerationLock } from '../lib/storage/set-locks'

// Generation outlives any one screen: the instructor can browse the library
// while questions are written. One run at a time (the local GPU model is a
// single engine anyway).

export interface GenerationState {
  running: boolean
  setId: string | null
  // Set while a new version of this one question is written, and kept after,
  // so its card can say how the run ended (startNewVersion).
  itemId: string | null
  status: string
  // Questions finished, written or left out; written counts only the first.
  done: number
  written: number
  total: number
  detail: string
}

let state: GenerationState = { running: false, setId: null, itemId: null, status: '', done: 0, written: 0, total: 0, detail: '' }
let controller: AbortController | null = null
const listeners = new Set<() => void>()

function update(patch: Partial<GenerationState>) {
  state = { ...state, ...patch }
  listeners.forEach((listener) => listener())
}

export function useGeneration(): GenerationState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
  )
}

export async function startGeneration(
  setId: string,
  source: StoredSource,
  plan: GenerationPlan,
  provider: LLMProvider,
  embedder: Embedder | null = null,
): Promise<void> {
  if (state.running) throw new Error('A generation is already running.')
  controller = new AbortController()
  update({ running: true, setId, itemId: null, status: 'Starting…', done: 0, written: 0, total: 0, detail: '' })
  const { signal } = controller
  const run = async () => {
    // Marked again now the lock is held, in case another tab took the set for
    // interrupted in the moment before. Another tab may have deleted it then.
    if (!(await db.sets.update(setId, { status: 'generating', error: null, updatedAt: Date.now() }))) {
      controller = null
      update({ running: false, status: 'Stopped: the set was deleted.' })
      return
    }
    try {
      const result = await runGeneration(setId, source, plan, provider, signal, {
        onStatus: (status) => update({ status, detail: '' }),
        onItem: () => update({ written: state.written + 1 }),
        onProgress: (done, total) => update({ done, total }),
        onModelEvent: showModelEvent,
      }, embedder)
      await db.sets.update(setId, {
        status: result.created === 0 && (result.skipped || result.errors.length) ? 'failed' : 'complete',
        error: resultError(result),
        updatedAt: Date.now(),
      })
      update({ running: false, status: `Done — ${result.created} question(s) written.` })
    } catch (error) {
      const cancelled = signal.aborted
      const message = failureMessage(error, state.written)
      await db.sets.update(setId, {
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? 'Stopped before finishing. Questions written so far were kept.' : message,
        updatedAt: Date.now(),
      })
      update({ running: false, status: cancelled ? 'Stopped.' : `Failed: ${message}` })
    } finally {
      controller = null
    }
  }
  await withGenerationLock(setId, {}, run, run)
}

export const NEW_VERSION_READY = 'A new version is ready. Compare it with the current one, then keep one.'

// One question drafted again beside the one it may replace (LT-201), under
// the set's lock like a whole run, so the set cannot be written, deleted or
// written again elsewhere meanwhile. The set's own status stays the first
// run's. Every way it ends leaves the current version as it was.
export async function startNewVersion(
  itemId: string,
  setId: string,
  source: StoredSource,
  checks: QuestionChecks,
  provider: LLMProvider,
  embedder: Embedder | null = null,
): Promise<void> {
  if (state.running) throw new Error('A generation is already running.')
  controller = new AbortController()
  update({ running: true, setId, itemId, status: 'Writing a new version…', done: 0, written: 0, total: 1, detail: '' })
  const { signal } = controller
  const kept = 'The current version is kept.'
  const run = async () => {
    try {
      await writeNewVersion(itemId, source, checks, provider, signal, {
        onStatus: (status) => update({ status, detail: '' }),
        onModelEvent: showModelEvent,
      }, embedder)
      update({ running: false, done: 1, written: 1, status: NEW_VERSION_READY })
    } catch (error) {
      const message = failureMessage(error, 0)
      update({ running: false, status: signal.aborted ? `Stopped. ${kept}` : `Couldn’t write a new version: ${message} ${kept}` })
    } finally {
      controller = null
    }
  }
  await withGenerationLock(
    setId,
    { ifAvailable: true },
    async (lock) => {
      if (lock) return run()
      controller = null
      update({ running: false, status: `This set is being written in another tab, so no new version was written. ${kept}` })
    },
    run,
  )
}

// Questions whose answers never passed the checks were already started over
// automatically, so a set missing a few of them gets no notice. The instructor
// hears about engine errors, which they can fix, and about a set left empty.
function resultError({ created, skipped, errors }: GenerationResult): string | null {
  if (errors.length) {
    const count = errors.length
    return `${count} question${count === 1 ? '' : 's'} could not be written: ${[...new Set(errors)].join(' · ')}`
  }
  if (created === 0 && skipped) return 'No questions could be written: the model’s answers did not pass the app’s checks.'
  return null
}

// What the model is doing, shown under the run's status.
function showModelEvent(event: ProgressEvent): void {
  if (event.kind === 'status') update({ detail: event.message })
  else if (event.kind === 'reasoning') update({ detail: event.text })
  else update({ detail: `${event.generated} chunks generated…` })
}

function failureMessage(error: unknown, written: number): string {
  return error instanceof GpuLost ? gpuLostMessage(written) : error instanceof Error ? error.message : String(error)
}

// A whole run loads the model again once where the engine can (pipeline.ts),
// so by now it is the instructor's turn. A new version of one question isn't
// worth the reload: the instructor tries again once the model is back.
function gpuLostMessage(written: number): string {
  const kept = written ? ' The questions written so far were kept.' : ''
  return `The GPU stopped responding while writing questions.${kept} Reload the model in Settings, or close other GPU-heavy tabs, and try again.`
}

export function cancelGeneration(): void {
  controller?.abort(new DOMException('Generation cancelled', 'AbortError'))
}

// A set still marked "generating" when the app starts was cut off by a closed
// tab or reload, unless another tab holds its lock and is writing it still;
// finished questions were saved as they were written. A set another tab holds
// is marked once that tab lets go of it, if it is still generating then: the
// tab was closed mid-run. Without Web Locks no tab can tell, so every such set
// is taken as cut off.
export async function markInterruptedSets(): Promise<void> {
  const generating = await db.sets.filter((set) => set.status === 'generating').toArray()
  const locks = webLocks()
  await Promise.all(
    generating.map((set) =>
      locks
        ? locks.request(generationLockName(set.id), { ifAvailable: true }, async (lock) => {
            if (lock) return markInterrupted(set.id)
            // Not awaited: the app waits for this function before its first
            // render (main.tsx), and the other tab may write for minutes.
            markInterruptedOnceReleased(set.id)
          })
        : markInterrupted(set.id),
    ),
  )
}

// Waits for the tab writing a set to let go of its lock, then marks the set
// interrupted if it is still generating: that tab was closed mid-run.
export function markInterruptedOnceReleased(setId: string, signal?: AbortSignal): void {
  void webLocks()
    ?.request(generationLockName(setId), { signal }, () => markInterrupted(setId))
    .catch(() => undefined)
}

// Checks the status again in the same transaction: the tab that held the
// lock may have finished the set just before letting go of it.
async function markInterrupted(setId: string): Promise<void> {
  await db.sets
    .where('id')
    .equals(setId)
    .and((set) => set.status === 'generating')
    .modify({ status: 'cancelled', error: 'Interrupted when the app was closed. Questions written before that were kept.' })
}
