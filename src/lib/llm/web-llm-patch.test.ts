import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { patchWebLlm } from '../../../scripts/patch-web-llm.mjs'

// WebLLM 0.2.85 keeps the logits of every prefill chunk but the last, about
// 121 MB each on the tuned 9B, until the model is unloaded (LT-242). The
// fixtures are typed out here, not imported, so the test checks the script.

const LEAKY = `            this.tvm.beginScope();
            let logits;
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                const chunkLen = chunkLens[i];
                const prevFilledLen = this.filledKVCacheLength;
                logits = this.tvm.detachFromCurrentScope(yield this.embedAndForward(chunk, chunkLen));
                if (this.filledKVCacheLength !== prevFilledLen + chunkLen) {
                    throw new Error("Internal Error: filledKVCacheLength does not match expected value.");
                }
            }
            this.imageDataCache.clear();
            this.tvm.endScope();`

const FIXED = `            this.tvm.beginScope();
            let logits;
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                const chunkLen = chunkLens[i];
                const prevFilledLen = this.filledKVCacheLength;
                // Keep only the last chunk's logits; endScope frees the others (LT-242).
                const chunkLogits = yield this.embedAndForward(chunk, chunkLen);
                if (this.filledKVCacheLength !== prevFilledLen + chunkLen) {
                    throw new Error("Internal Error: filledKVCacheLength does not match expected value.");
                }
                if (i === chunks.length - 1) {
                    logits = this.tvm.detachFromCurrentScope(chunkLogits);
                }
            }
            this.imageDataCache.clear();
            this.tvm.endScope();`

describe('patchWebLlm', () => {
  it('keeps only the last prefill chunk’s logits out of the scope', () => {
    expect(patchWebLlm(`before\n${LEAKY}\nafter`)).toBe(`before\n${FIXED}\nafter`)
  })

  it('leaves an already patched WebLLM as it is', () => {
    expect(patchWebLlm(`before\n${FIXED}\nafter`)).toBe(`before\n${FIXED}\nafter`)
  })

  it('refuses a WebLLM whose prefill loop it does not know', () => {
    expect(() => patchWebLlm('a different WebLLM')).toThrow(/prefill loop/)
  })
})

describe('the installed WebLLM', () => {
  it('has the prefill fix (npm install runs scripts/patch-web-llm.mjs)', () => {
    const lib = createRequire(import.meta.url).resolve('@mlc-ai/web-llm')
    const source = readFileSync(lib, 'latin1')
    expect(source).toContain(FIXED)
  })
})
