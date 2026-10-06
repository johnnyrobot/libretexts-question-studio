import { useSyncExternalStore } from 'react'
import { runGeneration, type GenerationPlan } from '../lib/generation/pipeline'
import type { LLMProvider } from '../lib/llm/types'
import { db, type StoredSource } from '../lib/storage/db'

// Generation outlives any one screen: the instructor can browse the library
// while questions are written. One run at a time (the local GPU model is a
// single engine anyway).

export interface GenerationState {
  running: boolean
  setId: string | null
  status: string
  done: number
  total: number
  failures: string[]
  detail: string
}

let state: GenerationState = { running: false, setId: null, status: '', done: 0, total: 0, failures: [], detail: '' }
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
): Promise<void> {
  if (state.running) throw new Error('A generation is already running.')
  controller = new AbortController()
  update({ running: true, setId, status: 'Starting…', done: 0, total: 0, failures: [], detail: '' })
  await db.sets.update(setId, { status: 'generating', error: null, updatedAt: Date.now() })
  try {
    const result = await runGeneration(setId, source, plan, provider, controller.signal, {
      onStatus: (status) => update({ status, detail: '' }),
      onItem: () => undefined,
      onProgress: (done, total) => update({ done, total }),
      onModelEvent: (event) => {
        if (event.kind === 'status') update({ detail: event.message })
        else if (event.kind === 'reasoning') update({ detail: event.text })
        else update({ detail: `${event.generated} chunks generated…` })
      },
    })
    const error = result.failures.length
      ? `${result.failures.length} question(s) could not be generated: ${result.failures.slice(0, 3).join(' · ')}`
      : null
    await db.sets.update(setId, {
      status: result.created === 0 && result.failures.length ? 'failed' : 'complete',
      error,
      updatedAt: Date.now(),
    })
    update({ running: false, status: `Done — ${result.created} question(s) written.`, failures: result.failures })
  } catch (error) {
    const cancelled = controller?.signal.aborted
    const message = error instanceof Error ? error.message : String(error)
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

export function cancelGeneration(): void {
  controller?.abort(new DOMException('Generation cancelled', 'AbortError'))
}

// A set still marked "generating" when the app starts was cut off by a closed
// tab or reload; finished questions were saved as they were written.
export async function markInterruptedSets(): Promise<void> {
  const stale = await db.sets.filter((set) => set.status === 'generating').toArray()
  await Promise.all(
    stale.map((set) =>
      db.sets.update(set.id, {
        status: 'cancelled',
        error: 'Interrupted when the app was closed. Questions written before that were kept.',
      }),
    ),
  )
}
