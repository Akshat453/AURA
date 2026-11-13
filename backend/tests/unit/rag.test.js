// Document ingestion and retrieval (port of the Go rag tests).
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {zipSync, strToU8} from 'fflate'
import {Context} from '../../src/utils/context.js'
import {chunk} from '../../src/services/rag/chunk.js'
import {detectType, extract, NeedsOCRError} from '../../src/services/rag/extract.js'
import {ftsQuery} from '../../src/services/rag/store.js'
import {safeName, Service} from '../../src/services/rag/service.js'
import {HashEmbedder} from '../helpers/fakes.js'
import {tmpDir} from '../helpers/env.js'

function newService(t, pdf = null) {
  const emb = new HashEmbedder()
  const s = new Service({dir: tmpDir(), maxUploadBytes: 1 << 20, chunkTokens: 60, chunkOverlap: 10, topK: 3, hybrid: true, minSimilarity: 0.2}, emb, pdf, null)
  const [ctx, cancel] = Context.background().withCancel()
  s.run(ctx)
  t.after(() => {
    cancel()
    s.close()
  })
  return {s, emb}
}

async function waitReady(s, id) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      const d = s.store.document(id)
      if (d.status === 'ready' || d.status === 'error') return d
    } catch {}
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error('document never finished indexing')
}

const syllabus = `# CS-301 Database Management Systems

## Unit 1: Introduction
Data models, schemas and the relational model.

## Unit 3: Normalization
Functional dependencies, 1NF, 2NF, 3NF and BCNF remove redundancy from relations.

## Unit 4: Transactions
ACID properties, concurrency control and recovery.`

test('chunking respects headings, pages and overlap', () => {
  const long = 'Normalization removes redundancy and update anomalies from relational tables. '.repeat(30)
  const chunks = chunk([{page: 1, text: '# Unit 3\n\n' + long}, {page: 2, text: 'Short page two text.'}], 60, 10)
  assert.ok(chunks.length >= 4)
  for (const c of chunks) {
    assert.ok(c.tokens <= 65)
    if (c.page === 1) assert.equal(c.heading, 'Unit 3')
  }
  const last = chunks.at(-1)
  assert.equal(last.page, 2)
  assert.equal(last.text, 'Short page two text.')
  const a = chunks[1].text.split(' ')
  const b = chunks[2].text.split(' ')
  assert.ok(b.slice(0, 12).join(' ').includes(a.slice(-3).join(' ')))
  for (const c of chunks) if (c.page === 1) assert.ok(c.tokens > 10)
})

test('FTS queries are injection-safe and normalise course codes', () => {
  const q = ftsQuery('What does CS301 cover? "drop" OR NEAR(x) *')
  assert.ok(!q.includes('NEAR(') && (q.match(/"/g) ?? []).length % 2 === 0)
  for (const want of ['"cs"', '"301"', '"cover"']) assert.ok(q.includes(want), q)
  assert.equal(ftsQuery('what is the'), '')
})

test('safe names strip paths and control characters', () => {
  for (const [input, want] of [['../../etc/passwd', 'passwd'], ['C:\\\\Users\\\\x\\\\notes.md', 'notes.md'], ['..', 'document'], ['a\x00b.txt', 'ab.txt']]) assert.equal(safeName(input), want)
})

test('DOCX and PPTX extraction (headings, slide order, title placeholders)', async () => {
  const docx = Buffer.from(zipSync({'word/document.xml': strToU8(`<w:document xmlns:w="w"><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Unit 3</w:t></w:r></w:p>
    <w:p><w:r><w:t>Normalization</w:t></w:r><w:r><w:tab/><w:t>removes redundancy.</w:t></w:r></w:p></w:body></w:document>`)}))
  let s = await extract(null, 'docx', docx, null)
  assert.ok(s[0].text.includes('# Unit 3') && s[0].text.includes('Normalization removes redundancy.'), s[0].text)
  const pptx = Buffer.from(zipSync({
    'ppt/slides/slide2.xml': strToU8('<p:sld xmlns:p="p" xmlns:a="a"><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Transactions</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>ACID properties</a:t></a:r></a:p></p:txBody></p:sp></p:sld>'),
    'ppt/slides/slide10.xml': strToU8('<p:sld xmlns:p="p" xmlns:a="a"><p:sp><p:txBody><a:p><a:r><a:t>Last slide</a:t></a:r></a:p></p:txBody></p:sp></p:sld>'),
  }))
  s = await extract(null, 'pptx', pptx, null)
  assert.equal(s.length, 2)
  assert.equal(s[0].page, 2)
  assert.equal(s[0].heading, 'Transactions')
  assert.equal(s[1].page, 10)
})

test('zip bombs are refused (decompressed size cap, independent of the header)', async () => {
  const big = Buffer.from(zipSync({'word/document.xml': new Uint8Array(21 << 20)}, {level: 9}))
  assert.ok(big.length < 1 << 20)
  await assert.rejects(extract(null, 'docx', big, null), /too large/)
})

test('scanned PDFs need OCR; mismatched content is rejected', async () => {
  await assert.rejects(extract(null, 'pdf', Buffer.from('%PDF-1.7'), {extractPDF: async () => [{page: 1, text: ' '}, {page: 2, text: '3'}]}), e => e instanceof NeedsOCRError)
  assert.throws(() => detectType('notes.pdf', Buffer.from('not a pdf')))
  assert.throws(() => detectType('tool.exe', Buffer.from('MZ')))
  assert.throws(() => detectType('x.txt', Buffer.from([0xff, 0xfe, 0x00])))
  assert.equal(detectType('x.docx', Buffer.from('PK\x03\x04', 'latin1')), 'docx')
})

test('upload → hybrid search → duplicate → replace (cached embeddings) → delete', async t => {
  const {s, emb} = newService(t)
  const up = await s.upload(null, '../syllabus.md', Buffer.from(syllabus))
  assert.equal(up.document.name, 'syllabus.md')
  const d = await waitReady(s, up.document.id)
  assert.ok(d.status === 'ready' && d.chunks > 0, JSON.stringify(d))
  let res = await s.search(Context.background(), 'What does CS301 Unit 3 cover?', '', 3)
  assert.ok(res.hits.length && res.hits[0].text.includes('Normalization') && res.hits[0].keyword_rank, JSON.stringify(res))
  const again = await s.upload(null, 'copy.md', Buffer.from(syllabus))
  assert.ok(again.duplicate && again.document.id === d.id)
  const before = emb.calls
  const edited = syllabus.replace('ACID properties, concurrency control and recovery.', 'Serializability, two-phase locking and deadlock handling.')
  const rep = await s.upload(null, 'syllabus.md', Buffer.from(edited))
  assert.ok(rep.replaced && rep.document.id === d.id)
  await new Promise(r => setTimeout(r, 20))
  await waitReady(s, d.id)
  assert.ok(emb.calls - before < d.chunks, `unchanged chunks were re-embedded: ${emb.calls - before}`)
  res = await s.search(Context.background(), 'two-phase locking', '', 3)
  assert.ok(res.hits[0].text.includes('two-phase'))
  res = await s.search(Context.background(), 'ACID properties recovery', '', 3)
  assert.ok(!(res.hits?.length && res.hits[0].text.includes('ACID')))
  s.delete(null, d.id)
  assert.deepEqual(s.store.countChunks(''), {chunks: 0, fts: 0, vectors: 0})
  assert.equal((await s.search(Context.background(), 'normalization', '', 3)).hits, null)
})

test('search falls back to keywords when the embedder is down; oversized uploads refused', async t => {
  const {s, emb} = newService(t)
  const up = await s.upload(null, 's.md', Buffer.from(syllabus))
  await waitReady(s, up.document.id)
  emb.fail = true
  const res = await s.search(Context.background(), 'BCNF', '', 3)
  assert.ok(res.method === 'keyword' && res.warning && res.hits.length)
  await assert.rejects(s.upload(null, 'big.txt', Buffer.alloc(2 << 20, 'a')), /larger than/)
})
