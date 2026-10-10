// The structured-output package lets a JSON string spell any character as
// \uXXXX. Where Gemma 4 E4B meant the LaTeX \( (JSON has no such escape), it
// often wrote \u and four hex digits instead, which decode to an unrelated
// symbol: "The weight (Å) of an object … its mass (ℕ)", "a ∈ F_net" for a ∝
// F_net, "(←)" for a position, in 75 of 1,991 saved drafts (2026-10-09). What
// was meant cannot be read back. JSON strings may hold any character as it
// is, so the model never needs the escape: inside a string it is masked out,
// and after a backslash the model picks \\ or a letter escape, which the LaTeX
// repairs read back (repairLatexEscapes, and controlsToBackslashes in the
// pipeline). On a concept whose explanations quote the textbook's math, 25 of
// 30 drafts garbled it before and 0 of 30 after, 26 writing it as LaTeX.

export interface EscapeTokens {
  // Tokens that begin with "u": right after a backslash they start \u.
  afterBackslash: number[]
  // Tokens that hold a backslash and a "u" of their own.
  within: number[]
}

export function escapeTokens(texts: readonly string[]): EscapeTokens {
  const afterBackslash: number[] = []
  const within: number[] = []
  texts.forEach((text, id) => {
    if (text.startsWith('u')) afterBackslash.push(id)
    if (text.includes('\\') && opensUnicodeEscape(text)) within.push(id)
  })
  return { afterBackslash, within }
}

// Whether `text`, read inside a string with no backslash pending, writes \u.
function opensUnicodeEscape(text: string): boolean {
  let escaped = false
  for (const char of text) {
    if (escaped) {
      if (char === 'u') return true
      escaped = false
    } else if (char === '\\') {
      escaped = true
    } else if (char === '"') {
      return false
    }
  }
  return false
}

// Follows the generated JSON text: whether it is inside a string, and whether
// a backslash there waits for the character it escapes.
export class JsonStringState {
  inString = false
  escaped = false

  feed(text: string): void {
    for (const char of text) {
      if (!this.inString) {
        if (char === '"') this.inString = true
      } else if (this.escaped) {
        this.escaped = false
      } else if (char === '\\') {
        this.escaped = true
      } else if (char === '"') {
        this.inString = false
      }
    }
  }

  // The tokens to mask next.
  blocked(tokens: EscapeTokens): number[] {
    if (!this.inString) return []
    return this.escaped ? tokens.afterBackslash : tokens.within
  }
}
