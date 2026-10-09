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

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻', '−': '⁻',
}

// Units as a student reads them, since ADAPT shows the text as typed:
// "m/s^2" -> "m/s²", "s^{-1}" -> "s⁻¹".
export function formatUnits(units: string): string {
  return units.replace(/\^\{?([-−]?\d+)\}?/g, (_, power: string) => [...power].map((c) => SUPERSCRIPT[c]).join(''))
}
