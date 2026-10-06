// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QuestionDraft } from '../lib/generation/schema'
import { SAMPLE_DRAFTS } from '../lib/qti/fixtures'
import { ItemEditor } from './ItemEditor'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let cleanup: (() => void) | null = null
afterEach(() => cleanup?.())

function render(draft: QuestionDraft) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const onSave = vi.fn()
  act(() => root.render(<ItemEditor draft={draft} onSave={onSave} onCancel={() => {}} />))
  cleanup = () => {
    act(() => root.unmount())
    container.remove()
  }
  const field = <T extends HTMLElement>(label: string) =>
    [...container.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label))!.querySelector<T>('input, textarea')!
  const save = () => act(() => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  return { field, save, onSave }
}

// One keystroke at a time, the way React sees a person typing.
function type(element: HTMLInputElement | HTMLTextAreaElement, text: string, { clear = true } = {}) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setValue = (value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
  if (clear) setValue('')
  for (const character of text) {
    setValue(element.value + character)
  }
}

describe('ItemEditor list fields', () => {
  it('keeps commas and spaces while a comma-separated list is typed', () => {
    const { field, save, onSave } = render(SAMPLE_DRAFTS.find((d) => d.item_type === 'fill_in_blank')!)
    const input = field<HTMLInputElement>('Also accept')
    type(input, 'chlorophyll a, chlorophyll b')
    expect(input.value).toBe('chlorophyll a, chlorophyll b')
    save()
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ alternates: ['chlorophyll a', 'chlorophyll b'] }))
  })

  it('keeps new lines while constraints are typed', () => {
    const { field, save, onSave } = render(SAMPLE_DRAFTS.find((d) => d.item_type === 'math')!)
    const textarea = field<HTMLTextAreaElement>('Constraints')
    type(textarea, 'v < t\nv > 2')
    expect(textarea.value).toBe('v < t\nv > 2')
    save()
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ constraints: ['v < t', 'v > 2'] }))
  })
})
