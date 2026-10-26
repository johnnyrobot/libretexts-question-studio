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
  // Loads the model afresh after the GPU was lost. Only in-browser engines can.
  recover?(onProgress?: (progress: { value: number; text: string }) => void): Promise<void>
}

// Turns texts into unit vectors whose dot product is their similarity.
export interface Embedder {
  readonly model: string
  load(onProgress?: (progress: { value: number; text: string }) => void): Promise<void>
  embed(texts: string[]): Promise<Float32Array[]>
}

// Grammar-constrained JSON still needs the model told to answer in JSON,
// otherwise it can stall emitting whitespace.
export function schemaInstruction(prompt: string, schema: JsonSchema): string {
  return `${prompt}\n\nRespond ONLY with a JSON object that matches this JSON schema:\n${JSON.stringify(schema)}`
}

export class LLMError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable = false) {
    super(message)
    this.retryable = retryable
  }
}

export class ValidationFailure extends Error {}

// WebGPU lost the device (a driver reset, the GPU process restarting, memory
// running out). Nothing on it survives, so asking again cannot help until the
// model is loaded afresh. `detail` keeps what the engine reported.
export class GpuLost extends LLMError {
  readonly detail: string

  constructor(detail: string) {
    super('The GPU stopped responding.')
    this.detail = detail
  }
}

// How ONNX Runtime Web and Chrome word a lost device, as the worker passes
// them on: "[Device] is lost", or a failed OrtRun inside the WebGPU provider,
// which ends the same way: the model has to be loaded again.
export function isGpuLost(message: string): boolean {
  return /\bdevice\]? (?:was |is )?lost/i.test(message) || (/OrtRun/.test(message) && /webgpu|wgpu|GPUBuffer/i.test(message))
}

// Every attempt was answered, but none passed the checks. Unlike other
// LLMErrors this says nothing about the engine, so starting afresh can help.
export class NoValidResponse extends LLMError {}

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
      const result = await generate(prompt, attempt).catch(asGpuLost)
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
  throw new NoValidResponse(`The model did not return a valid ${request.schemaName}: ${lastError}`)
}

// Only what the engine throws is read this way: the checks quote the model's
// own words, which can say anything.
function asGpuLost(error: unknown): never {
  throw error instanceof Error && !(error instanceof LLMError) && isGpuLost(error.message) ? new GpuLost(error.message) : error
}

export function parseJsonResponse(text: string): unknown {
  const trimmed = repairLatexEscapes(text.trim())
  try {
    return JSON.parse(trimmed)
  } catch {
    // Small local models sometimes wrap JSON in a code fence or add a preface,
    // and Transformers.js's structured output lets a trailing comma through.
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    const body = fenced ? fenced[1] : start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed
    for (const candidate of [body, dropTrailingCommas(body)]) {
      try {
        return JSON.parse(candidate)
      } catch {
        // try the next repair
      }
    }
    throw new ValidationFailure('Response was not valid JSON.')
  }
}

// LaTeX commands whose backslash and first letter make a JSON escape: a model
// that writes "\frac" in JSON means \frac, not a form feed and "rac". Escaped
// strings that read as text ("\nu" after a line break, "\ne", "\to") are left;
// inside math, controlsToBackslashes (generation/pipeline.ts) restores them.
// Gemma 4 E4B also writes the text-mode spellings \textsubscript{net},
// \textsuperscript{2}, \textunderscore and \textasciicircum{}, which arrived
// as a tab and "extsubscript{net}" (46 of the 52 lost commands in the saved
// runs, 2026-10-09).
const LATEX_AFTER_ESCAPE =
  /^(?:b(?:ar|eta|inom|oldsymbol|ullet|egin|igg?|f)|f(?:rac|orall|lat)|n(?:abla|eq|ot|eg|ewline|onumber|mid)|r(?:ho|ight(?:arrow)?|angle|floor|ceil|m)|t(?:heta|au|imes|ext(?:bf|it|rm|subscript|superscript|underscore|asciicircum|asciitilde|backslash)?|anh?|riangle|ilde|frac|herefore|op))(?![a-zA-Z])/

// Doubles the backslash of each such escape inside JSON strings.
export function repairLatexEscapes(json: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < json.length; i++) {
    const char = json[i]
    if (!inString) {
      if (char === '"') inString = true
      out += char
      continue
    }
    if (char === '"') {
      inString = false
      out += char
    } else if (char === '\\') {
      const next = json[++i] ?? ''
      const latex = next !== '' && 'bfnrt'.includes(next) && LATEX_AFTER_ESCAPE.test(json.slice(i, i + 16))
      out += `${latex ? '\\\\' : '\\'}${next}`
    } else {
      out += char
    }
  }
  return out
}

// Removes commas before a closing bracket or brace, outside strings.
export function dropTrailingCommas(json: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < json.length; i++) {
    const char = json[i]
    if (inString) {
      if (char === '\\') {
        out += char + (json[++i] ?? '')
        continue
      }
      if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
    } else if (char === ',' && /^\s*[\]}]/.test(json.slice(i + 1))) {
      continue
    }
    out += char
  }
  return out
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
