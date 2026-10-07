// Port of assessment-ai/app/content.py::_normalize_html. Textbook HTML becomes
// numbered paragraphs with stable offsets so every generated item can cite the
// exact source text it was grounded in.

export interface Paragraph {
  index: number
  text: string
  start: number
  end: number
}

export interface NormalizedText {
  plaintext: string
  paragraphs: Paragraph[]
}

const NON_CONTENT_TAGS = ['script', 'style', 'noscript', 'template', 'svg']

// LibreTexts chrome that is rendered into page bodies but is not textbook prose.
const NON_CONTENT_SELECTORS = [
  '.mt-guide-tabs-container',
  '.mt-content-footer',
  '.autoattribution',
  '#autoattribution',
  '.mt-section .mt-icon-hierarchy',
]

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4',
  'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
  'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
])

export class EmptySourceError extends Error {}

export function normalizeHtml(html: string): NormalizedText {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const body = doc.body
  for (const tag of NON_CONTENT_TAGS) {
    body.querySelectorAll(tag).forEach((el) => el.remove())
  }
  for (const selector of NON_CONTENT_SELECTORS) {
    body.querySelectorAll(selector).forEach((el) => el.remove())
  }
  body.querySelectorAll('img').forEach((img) => {
    const alt = (img.getAttribute('alt') ?? '').split(/\s+/).filter(Boolean).join(' ')
    img.replaceWith(doc.createTextNode(alt ? ` [Image: ${alt}] ` : ' '))
  })
  body.querySelectorAll('br').forEach((br) => br.replaceWith(doc.createTextNode('\n')))
  body.querySelectorAll('*').forEach((el) => {
    if (BLOCK_TAGS.has(el.tagName)) {
      el.before(doc.createTextNode('\n'))
      el.after(doc.createTextNode('\n'))
    }
  })
  return normalizePlainText(body.textContent ?? '')
}

export function normalizePlainText(text: string): NormalizedText {
  const lines = text
    .replace(/ /g, ' ')
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/).filter(Boolean).join(' '))
    .filter(Boolean)
  if (lines.length === 0) {
    throw new EmptySourceError('The source did not contain readable text.')
  }
  const paragraphs: Paragraph[] = []
  let cursor = 0
  lines.forEach((line, index) => {
    paragraphs.push({ index, text: line, start: cursor, end: cursor + line.length })
    cursor += line.length + 2
  })
  return { plaintext: lines.join('\n\n'), paragraphs }
}

// LibreTexts numbers figures, tables and examples with a MathJax macro of its
// own: "Figure \(\PageIndex{2}\)" shows on the page as the page's number plus
// the argument, "Figure 4.4.2". KaTeX and the model know nothing of it.
const PAGE_INDEX_MATH = /\\\(\s*\\PageIndex\s*\{\s*([^{}]*?)\s*\}\s*\\\)/g
const PAGE_INDEX = /\\PageIndex\s*\{\s*([^{}]*?)\s*\}/g
const PAGE_NUMBER = /^\s*((?:\d+|[A-Z])(?:\.(?:\d+|[A-Z]))*)\s*:/

export function expandPageIndex(text: string, pageTitle: string): string {
  if (!text.includes('\\PageIndex')) return text
  const prefix = PAGE_NUMBER.exec(pageTitle)?.[1]
  const number = (_: string, n: string) => (prefix ? `${prefix}.${n}` : n)
  return text.replace(PAGE_INDEX_MATH, number).replace(PAGE_INDEX, number)
}

// The page's paragraphs with \PageIndex expanded and offsets kept in step.
export function withPageNumbers(paragraphs: Paragraph[], pageTitle: string): Paragraph[] {
  if (!paragraphs.some((p) => p.text.includes('\\PageIndex'))) return paragraphs
  let cursor = 0
  return paragraphs.map((paragraph) => {
    const text = expandPageIndex(paragraph.text, pageTitle)
    const next = { ...paragraph, text, start: cursor, end: cursor + text.length }
    cursor += text.length + 2
    return next
  })
}
