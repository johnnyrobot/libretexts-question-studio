// Plain decimal text for a number: no float noise (0.1 + 0.2 -> "0.3") and no
// exponent notation, which PHP parses but other importers and students may not.
export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  const fixed = Number(value.toPrecision(12))
  const text = String(fixed)
  if (!/e/i.test(text)) return text
  return fixed.toFixed(Math.min(20, Math.max(0, -Math.floor(Math.log10(Math.abs(fixed))) + 11))).replace(/\.?0+$/, '')
}

// A computed value shown to students: exact when it is an integer, otherwise
// four significant figures.
export function formatComputed(value: number): string {
  return Number.isInteger(value) ? formatNumber(value) : formatNumber(Number(value.toPrecision(4)))
}
