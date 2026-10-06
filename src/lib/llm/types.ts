// One structured-output surface for both the in-browser model and OpenAI, so
// the generation pipeline never knows which one is answering.

export type JsonSchema = Record<string, unknown>

export interface CompletionRequest<T> {
  system: string
  prompt: string
  schemaName: string
  schema: JsonSchema
  // Throws with a short, model-readable message when the value is unusable.
  validate: (value: unknown) => T
  maxOutputTokens?: number
  signal?: AbortSignal
  onProgress?: (event: ProgressEvent) => void
}

export type ProgressEvent =
  | { kind: 'status'; message: string }
  | { kind: 'tokens'; generated: number }
  | { kind: 'reasoning'; text: string }

export interface CompletionUsage {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
}

export interface Completion<T> {
  value: T
  usage: CompletionUsage | null
  attempts: number
}

export interface LLMProvider {
  readonly id: 'local' | 'openai'
  readonly model: string
  complete<T>(request: CompletionRequest<T>): Promise<Completion<T>>
}

export class LLMError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable = false) {
    super(message)
    this.retryable = retryable
  }
}

export class ValidationFailure extends Error {}

const MAX_ATTEMPTS = 3

// Small local models tend to repeat the same mistake verbatim; sampling a bit
// hotter on each retry helps them break out of it.
export function retryTemperature(attempt: number): number {
  return [0.4, 0.7, 0.9][Math.min(attempt, 3) - 1]
}

// Parse, validate, and on failure re-ask with the validation error appended,
// mirroring the bounded correction loop of the server pipeline.
export async function completeWithRetries<T>(
  request: CompletionRequest<T>,
  generate: (prompt: string, attempt: number) => Promise<{ text: string; usage: CompletionUsage | null }>,
): Promise<Completion<T>> {
  let prompt = request.prompt
  let lastError = ''
  let usage: CompletionUsage | null = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    request.signal?.throwIfAborted()
    try {
      const result = await generate(prompt, attempt)
      usage = addUsage(usage, result.usage)
      const parsed = parseJsonResponse(result.text)
      return { value: request.validate(parsed), usage, attempts: attempt }
    } catch (error) {
      // Retryable generation errors (an answer cut off at the output limit)
      // get another attempt; anything else, such as a missing model, does not.
      if (error instanceof LLMError && !error.retryable) throw error
      if (request.signal?.aborted) throw error
      lastError = error instanceof Error ? error.message : String(error)
      request.onProgress?.({
        kind: 'status',
        message: `Response did not validate (attempt ${attempt}/${MAX_ATTEMPTS}): ${lastError}`,
      })
      prompt =
        `${request.prompt}\n\nYour previous response was rejected for this reason:\n` +
        `${lastError}\nReturn a corrected, complete JSON object that fixes it.`
    }
  }
  throw new LLMError(`The model did not return a valid ${request.schemaName}: ${lastError}`)
}

export function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // Small local models sometimes wrap JSON in a code fence or add a preface.
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenced) return JSON.parse(fenced[1])
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1))
    throw new ValidationFailure('Response was not valid JSON.')
  }
}

function addUsage(a: CompletionUsage | null, b: CompletionUsage | null): CompletionUsage | null {
  if (!a) return b
  if (!b) return a
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  }
}
