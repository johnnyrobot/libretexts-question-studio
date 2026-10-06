import {
  completeWithRetries,
  LLMError,
  type Completion,
  type CompletionRequest,
  type CompletionUsage,
  type LLMProvider,
} from './types'

// Bring-your-own-key OpenAI provider. The key goes from this browser straight
// to api.openai.com (which allows CORS); nothing is proxied or stored remotely.

const API_BASE = 'https://api.openai.com/v1'

export const OPENAI_MODELS = [
  { id: 'gpt-6-luna', label: 'GPT-6 Luna (recommended)' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna (previous generation)' },
] as const

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

export interface OpenAIOptions {
  apiKey: string
  model: string
  effort: ReasoningEffort
}

export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai' as const
  readonly model: string
  private readonly options: OpenAIOptions

  constructor(options: OpenAIOptions) {
    this.options = options
    this.model = options.model
  }

  complete<T>(request: CompletionRequest<T>): Promise<Completion<T>> {
    return completeWithRetries(request, (prompt) => this.respond(request, prompt))
  }

  private async respond<T>(
    request: CompletionRequest<T>,
    prompt: string,
  ): Promise<{ text: string; usage: CompletionUsage | null }> {
    const response = await fetchWithBackoff(
      `${API_BASE}/responses`,
      {
        method: 'POST',
        signal: request.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model,
          instructions: request.system,
          input: prompt,
          reasoning: { effort: this.options.effort, summary: 'auto' },
          text: {
            format: {
              type: 'json_schema',
              name: request.schemaName,
              strict: true,
              schema: request.schema,
            },
          },
          // Covers hidden reasoning plus the visible JSON; high effort needs headroom.
          max_output_tokens: request.maxOutputTokens ?? 32_000,
          store: false,
          stream: true,
        }),
      },
      request,
    )
    return readStream(response, request)
  }
}

async function fetchWithBackoff<T>(
  url: string,
  init: RequestInit,
  request: CompletionRequest<T>,
): Promise<Response> {
  // Rate-limit headers are not CORS-exposed, so back off on 429/5xx blindly.
  const delays = [2_000, 8_000, 20_000]
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init)
    if (response.ok) return response
    const retryable = response.status === 429 || response.status >= 500
    if (!retryable || attempt >= delays.length) {
      throw new LLMError(await errorMessage(response), retryable)
    }
    request.onProgress?.({
      kind: 'status',
      message: `OpenAI returned ${response.status}; retrying in ${delays[attempt] / 1000}s…`,
    })
    await sleep(delays[attempt], request.signal)
  }
}

async function readStream<T>(
  response: Response,
  request: CompletionRequest<T>,
): Promise<{ text: string; usage: CompletionUsage | null }> {
  if (!response.body) throw new LLMError('OpenAI returned an empty response stream.')
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  let text = ''
  let deltas = 0
  let final: Record<string, any> | null = null

  const handle = (data: string) => {
    if (!data || data === '[DONE]') return
    const event = JSON.parse(data)
    switch (event.type) {
      case 'response.output_text.delta':
        text += event.delta
        deltas++
        if (deltas % 20 === 0) request.onProgress?.({ kind: 'tokens', generated: deltas })
        break
      case 'response.reasoning_summary_text.done':
        request.onProgress?.({ kind: 'reasoning', text: event.text })
        break
      case 'response.refusal.done':
        throw new LLMError(`OpenAI refused the request: ${event.refusal}`)
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed':
        final = event.response
        break
      case 'error':
        throw new LLMError(event.message ?? 'OpenAI reported a streaming error.', true)
    }
  }

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    let boundary: number
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      handle(data)
    }
  }

  const finished = final as Record<string, any> | null
  if (!finished) throw new LLMError('OpenAI closed the stream before the response finished.', true)
  if (finished.status === 'incomplete') {
    const reason = finished.incomplete_details?.reason ?? 'unknown'
    throw new LLMError(
      reason === 'max_output_tokens'
        ? 'OpenAI ran out of output tokens before finishing. Try a lower reasoning effort or a smaller source.'
        : `OpenAI stopped early (${reason}).`,
    )
  }
  if (finished.status === 'failed') {
    throw new LLMError(finished.error?.message ?? 'OpenAI reported the response failed.', true)
  }
  const usage = finished.usage
  return {
    text,
    usage: usage
      ? {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
        }
      : null,
  }
}

// Confirms the key works and reports which Luna models it can reach.
export async function checkOpenAIKey(apiKey: string): Promise<{ ok: boolean; models: string[]; message: string }> {
  try {
    const response = await fetch(`${API_BASE}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (response.status === 401) return { ok: false, models: [], message: 'OpenAI rejected this key.' }
    if (!response.ok) {
      // Restricted keys may lack "Models: Read" yet still be able to generate.
      return { ok: true, models: [], message: 'Key accepted, but it cannot list models (restricted key).' }
    }
    const body = await response.json()
    const models: string[] = (body.data ?? [])
      .map((m: { id: string }) => m.id)
      .filter((id: string) => id.includes('luna'))
      .sort()
    return {
      ok: true,
      models,
      message: models.length ? `Key works. Luna models available: ${models.join(', ')}` : 'Key works, but no Luna models are listed for it.',
    }
  } catch {
    return { ok: false, models: [], message: 'Could not reach api.openai.com.' }
  }
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json()
    if (body?.error?.message) return `OpenAI error ${response.status}: ${body.error.message}`
  } catch {
    // fall through
  }
  return `OpenAI error ${response.status}.`
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    })
  })
}
