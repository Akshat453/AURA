// Document type detection and text extraction (TXT, Markdown, DOCX, PPTX in
// Node; PDF through the Python sidecar).
import {SaxesParser} from 'saxes'
import {clean} from './chunk.js'
import * as zip from './zip.js'
import {runeLen, trimSpace} from '../../utils/gotext.js'

// Supported document types, keyed by lower-case extension.
const documentTypes = {'.pdf': 'pdf', '.txt': 'txt', '.md': 'markdown', '.markdown': 'markdown', '.docx': 'docx', '.pptx': 'pptx'}

export class NeedsOCRError extends Error {
  constructor() {
    super('no extractable text: the PDF appears to be scanned images; OCR is required and not enabled')
    this.name = 'NeedsOCRError'
  }
}

// ext returns the extension like Go's path.Ext ("" when none).
export function ext(name) {
  const base = name.slice(name.lastIndexOf('/') + 1)
  const i = base.lastIndexOf('.')
  return i < 0 ? '' : base.slice(i)
}

const utf8Decoder = new TextDecoder('utf-8', {fatal: true})
export function validUTF8(data) {
  try {
    utf8Decoder.decode(data)
    return true
  } catch {
    return false
  }
}

// detectType validates the extension and the file signature.
export function detectType(name, data) {
  const kind = documentTypes[ext(name).toLowerCase()]
  if (!kind) throw new Error(`unsupported file type ${JSON.stringify(ext(name))} (supported: PDF, TXT, Markdown, DOCX, PPTX)`)
  const b = Buffer.from(data)
  if (kind === 'pdf') {
    if (b.toString('latin1', 0, 5) !== '%PDF-') throw new Error('file does not look like a PDF')
  } else if (kind === 'docx' || kind === 'pptx') {
    if (!(b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04)) throw new Error(`file does not look like a ${kind.toUpperCase()} document`)
  } else if (!validUTF8(b)) {
    throw new Error('text file is not valid UTF-8')
  }
  return kind
}

// extract turns a document into cleaned sections [{page, heading, text}].
export async function extract(ctx, kind, data, pdf) {
  let sections
  switch (kind) {
    case 'pdf':
      if (!pdf) throw new Error('PDF extraction needs the RAG sidecar, which is not running')
      sections = await pdf.extractPDF(ctx, data)
      break
    case 'txt':
    case 'markdown':
      sections = [{page: 0, heading: '', text: Buffer.from(data).toString('utf8')}]
      break
    case 'docx':
      sections = extractDOCX(data)
      break
    case 'pptx':
      sections = extractPPTX(data)
      break
    default:
      throw new Error(`unsupported type ${kind}`)
  }
  let chars = 0
  let pages = 0
  for (const s of sections) {
    s.text = clean(s.text)
    chars += runeLen(s.text)
    pages++
  }
  if (kind === 'pdf' && chars < 25 * Math.max(1, pages)) throw new NeedsOCRError()
  if (chars === 0) throw new Error('document contains no text')
  return sections
}

// Office documents are zip archives; read only the entries needed and cap
// their decompressed size to defeat zip bombs.
const maxXMLBytes = 20 << 20

function openZip(data) {
  try {
    return zip.entries(Buffer.from(data))
  } catch (e) {
    throw new Error(`invalid Office file: ${e.message}`, {cause: e})
  }
}

const local = name => name.slice(name.indexOf(':') + 1)

// xmlEvents parses XML into a flat list of open/close/text events (local names).
function parseXML(text, handlers) {
  const p = new SaxesParser({xmlns: false, position: false})
  p.on('opentag', t => handlers.open(local(t.name), Object.fromEntries(Object.entries(t.attributes).map(([k, v]) => [local(k), v]))))
  p.on('closetag', t => handlers.close(local(t.name)))
  p.on('text', t => handlers.text(t))
  p.on('cdata', t => handlers.text(t))
  p.write(text).close()
}

// xmlParagraphs walks WordprocessingML paragraphs and reports whether each
// paragraph's style marks it as a heading.
function xmlParagraphs(data, para, textEl, styleEl, headingStyle) {
  const out = []
  let cur = ''
  let inText = false
  let heading = false
  parseXML(data.toString('utf8'), {
    open(name, attrs) {
      if (name === para) {
        cur = ''
        heading = false
      } else if (name === textEl) inText = true
      else if (name === 'tab') cur += ' '
      else if (name === 'br') cur += '\n'
      else if (name === styleEl && headingStyle(attrs.val ?? '')) heading = true
    },
    close(name) {
      if (name === textEl) inText = false
      else if (name === para) {
        const s = trimSpace(cur)
        if (s !== '') out.push([s, heading ? 'heading' : ''])
      }
    },
    text(t) {
      if (inText) cur += t
    },
  })
  return out
}

const wordHeading = /^(heading\d*|title)$/i

export function extractDOCX(data) {
  const b = Buffer.from(data)
  const list = openZip(b)
  for (const f of list) {
    if (f.name !== 'word/document.xml') continue
    const xml = zip.read(b, f, maxXMLBytes)
    let paras
    try {
      paras = xmlParagraphs(xml, 'p', 't', 'pStyle', v => wordHeading.test(v))
    } catch (e) {
      throw new Error(`invalid DOCX XML: ${e.message}`, {cause: e})
    }
    return [{page: 0, heading: '', text: joinParagraphs(paras)}]
  }
  throw new Error('DOCX has no word/document.xml')
}

const slideName = /^ppt\/slides\/slide(\d+)\.xml$/

export function extractPPTX(data) {
  const b = Buffer.from(data)
  const list = openZip(b)
  const slides = []
  for (const f of list) {
    const m = slideName.exec(f.name)
    if (m) slides.push({n: Number(m[1]), f})
  }
  if (slides.length === 0) throw new Error('PPTX has no slides')
  if (slides.length > 2000) throw new Error('PPTX has too many slides')
  slides.sort((a, b2) => a.n - b2.n)
  const sections = []
  for (const s of slides) {
    const xml = zip.read(b, s.f, maxXMLBytes)
    let paras
    try {
      paras = slideParagraphs(xml)
    } catch (e) {
      throw new Error(`slide ${s.n}: ${e.message}`, {cause: e})
    }
    const sec = {page: s.n, heading: '', text: joinParagraphs(paras)}
    const h = paras.find(p => p[1] === 'heading')
    if (h) sec.heading = h[0]
    sections.push(sec)
  }
  return sections
}

// slideParagraphs marks paragraphs inside a title placeholder as headings.
function slideParagraphs(data) {
  const out = []
  let cur = ''
  let depth = 0
  let titleDepth = -1
  let inText = false
  parseXML(data.toString('utf8'), {
    open(name, attrs) {
      depth++
      if (name === 'sp') titleDepth = -1
      else if (name === 'ph' && (attrs.type === 'title' || attrs.type === 'ctrTitle')) titleDepth = depth
      else if (name === 'p') cur = ''
      else if (name === 't') inText = true
      else if (name === 'br') cur += '\n'
    },
    close(name) {
      if (name === 't') inText = false
      else if (name === 'p') {
        const s = trimSpace(cur)
        if (s !== '') out.push([s, titleDepth >= 0 ? 'heading' : ''])
      } else if (name === 'sp') titleDepth = -1
      depth--
    },
    text(t) {
      if (inText) cur += t
    },
  })
  return out
}

function joinParagraphs(paras) {
  let b = ''
  for (const [text, kind] of paras) {
    if (kind === 'heading') b += '# '
    b += text + '\n\n'
  }
  return b
}
