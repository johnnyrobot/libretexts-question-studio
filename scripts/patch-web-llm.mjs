// WebLLM 0.2.85 detaches the logits of every chunked-prefill chunk from the
// TVM scope but disposes only the last, so each prompt over 1024 tokens leaves
// about 121 MB of GPU memory per extra chunk until the worker ends (LT-242).
// WebLLM 0.2.86 fixes it, but needs model libraries built for it, so npm
// install applies the same fix to 0.2.85.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const LEAKY = `                logits = this.tvm.detachFromCurrentScope(yield this.embedAndForward(chunk, chunkLen));
                if (this.filledKVCacheLength !== prevFilledLen + chunkLen) {
                    throw new Error("Internal Error: filledKVCacheLength does not match expected value.");
                }
            }`

const FIXED = `                // Keep only the last chunk's logits; endScope frees the others (LT-242).
                const chunkLogits = yield this.embedAndForward(chunk, chunkLen);
                if (this.filledKVCacheLength !== prevFilledLen + chunkLen) {
                    throw new Error("Internal Error: filledKVCacheLength does not match expected value.");
                }
                if (i === chunks.length - 1) {
                    logits = this.tvm.detachFromCurrentScope(chunkLogits);
                }
            }`

/** Returns WebLLM's bundle with the chunked-prefill leak fixed. */
export function patchWebLlm(source) {
  if (source.includes(FIXED)) return source
  const at = source.indexOf(LEAKY)
  if (at < 0 || source.indexOf(LEAKY, at + 1) >= 0) {
    throw new Error('patch-web-llm: WebLLM’s chunked-prefill loop is not the 0.2.85 one; check LT-242 before upgrading.')
  }
  return source.slice(0, at) + FIXED + source.slice(at + LEAKY.length)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = createRequire(import.meta.url).resolve('@mlc-ai/web-llm')
  // latin1 keeps every byte (the bundle mixes line endings) as it is.
  const source = readFileSync(file, 'latin1')
  const patched = patchWebLlm(source)
  if (patched !== source) writeFileSync(file, patched, 'latin1')
  console.log(`patch-web-llm: ${patched === source ? 'already patched' : 'patched'} ${file}`)
}
