import { useSyncExternalStore } from 'react'
import { runGeneration, type GenerationPlan, type GenerationResult } from '../lib/generation/pipeline'
import { GpuLost, type Embedder, type LLMProvider } from '../lib/llm/types'
import { db, type StoredSource } from '../lib/storage/db'

// Generation outlives any one screen: the instructor can browse the library
// while questions are written. One run at a time (the local GPU model is a
// single engine anyway).

export interface GenerationState {
  running: boolean
  setId: string | null
  status: string
  // Questions finished, written or left out; written counts only the first.
  done: number
  written: number
  total: number
  detail: string
}

let state: GenerationState = { running: false, setId: null, status: '', done: 0, written: 0, total: 0, detail: '' }
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
  update({ running: true, setId, status: 'Starting…', done: 0, written: 0, total: 0, detail: '' })
  const { signal } = controller
  await whileGenerating(setId, async () => {
    // Marked again now the lock is held, in case another tab took the set for
    // interrupted in the moment before.
    await db.sets.update(setId, { status: 'generating', error: null, updatedAt: Date.now() })
    try {
      const result = await runGeneration(setId, source, plan, provider, signal, {
        onStatus: (status) => update({ status, detail: '' }),
        onItem: () => update({ written: state.written + 1 }),
        onProgress: (done, total) => update({ done, total }),
        onModelEvent: (event) => {
          if (event.kind === 'status') update({ detail: event.message })
          else if (event.kind === 'reasoning') update({ detail: event.text })
          else update({ detail: `${event.generated} chunks generated…` })
        },
      }, embedder)
      await db.sets.update(setId, {
        status: result.created === 0 && (result.skipped || result.errors.length) ? 'failed' : 'complete',
        error: resultError(result),
        updatedAt: Date.now(),
      })
      update({ running: false, status: `Done — ${result.created} question(s) written.` })
    } catch (error) {
      const cancelled = signal.aborted
      const message = error instanceof GpuLost ? gpuLostMessage(state.written) : error instanceof Error ? error.message : String(error)
      await db.sets.update(setId, {
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? 'Stopped before finishing. Questions written so far were kept.' : message,
        updatedAt: Date.now(),
      })
      update({ running: false, status: cancelled ? 'Stopped.' : `Failed: ${message}` })
    } finally {
      controller = null
    }
  })
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

// The run loads the model again once where the engine can (pipeline.ts), so
// by now it is the instructor's turn.
function gpuLostMessage(written: number): string {
  const kept = written ? ' The questions written so far were kept.' : ''
  return `The GPU stopped responding while writing questions.${kept} Reload the model in Settings, or close other GPU-heavy tabs, and try again.`
}

export function cancelGeneration(): void {
  controller?.abort(new DOMException('Generation cancelled', 'AbortError'))
}

// A set's generation holds this lock from start to finish, in whichever tab
// runs it: Web Locks are shared by every tab of the app. Browsers offer them
// only on https and localhost.
const generationLockName = (setId: string) => `generation:${setId}`
const webLocks = (): LockManager | undefined => navigator.locks ?? undefined

// A browser can refuse the lock outright (a document that isn't fully active,
// say); the run then goes on unlocked, as without Web Locks.
async function whileGenerating(setId: string, run: () => Promise<void>): Promise<void> {
  const locks = webLocks()
  if (!locks) return run()
  let began = false
  try {
    await locks.request(generationLockName(setId), () => {
      began = true
      return run()
    })
  } catch (error) {
    if (began) throw error
    await run()
  }
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
            void locks.request(generationLockName(set.id), () => markInterrupted(set.id)).catch(() => undefined)
          })
        : markInterrupted(set.id),
    ),
  )
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
