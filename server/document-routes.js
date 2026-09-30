import { Router } from 'express'
import multer from 'multer'
import rateLimit from 'express-rate-limit'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import path from 'node:path'
import { db, randomUUID, requireAuth } from './auth.js'

const router = Router()
const MAX_PDF_BYTES = 10 * 1024 * 1024
const MAX_PAGES = 300
const MAX_EXTRACTED_CHARS = 5_000_000
const CHUNK_LENGTH = 1200
const CHUNK_STEP = 950
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_BYTES, files: 1 } })
const uploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false })
const searchLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false })

function tokenize(text) {
  return (text.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).filter((token) => token.length < 48)
}

async function extractPdf(buffer) {
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: 0,
  })
  const pdf = await task.promise
  if (!pdf.numPages || pdf.numPages > MAX_PAGES) throw new Error(`PDF must contain 1-${MAX_PAGES} pages.`)
  const pages = []
  let totalChars = 0
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const text = content.items.map((item) => 'str' in item ? item.str : '').join(' ').replace(/\s+/g, ' ').trim()
    totalChars += text.length
    if (totalChars > MAX_EXTRACTED_CHARS) throw new Error('Extracted PDF text exceeds the supported size.')
    pages.push({ pageNumber, text })
    page.cleanup()
  }
  await task.destroy()
  return pages
}

function makeChunks(pages) {
  const chunks = []
  for (const page of pages) {
    if (!page.text) continue
    for (let start = 0; start < page.text.length; start += CHUNK_STEP) {
      const content = page.text.slice(start, start + CHUNK_LENGTH).trim()
      if (content) chunks.push({ pageNumber: page.pageNumber, ordinal: chunks.length, content })
      if (start + CHUNK_LENGTH >= page.text.length) break
    }
  }
  return chunks
}

router.use(requireAuth)

router.get('/', (req, res) => {
  const documents = db.prepare(`SELECT id, original_name AS name, mime_type AS mimeType, size_bytes AS sizeBytes,
    page_count AS pageCount, created_at AS createdAt FROM documents WHERE user_id = ? ORDER BY created_at DESC`).all(req.user.id)
  return res.json({ documents })
})

router.post('/', uploadLimiter, (req, res, next) => {
  upload.single('document')(req, res, (error) => {
    if (!error) return next()
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ message: 'PDF exceeds the 10 MB upload limit.' })
    return res.status(400).json({ message: 'Upload one PDF file smaller than 10 MB.' })
  })
}, async (req, res) => {
  const file = req.file
  if (!file) return res.status(400).json({ message: 'Select a PDF to upload.' })
  if (file.mimetype !== 'application/pdf' || path.extname(file.originalname).toLowerCase() !== '.pdf') {
    return res.status(415).json({ message: 'Only PDF files are supported.' })
  }
  if (file.buffer.subarray(0, 5).toString('ascii') !== '%PDF-') return res.status(400).json({ message: 'The uploaded file is not a valid PDF.' })

  let pages
  try {
    pages = await extractPdf(file.buffer)
  } catch (error) {
    const clientMessage = /must contain|exceeds the supported/.test(error.message) ? error.message : 'PDF could not be read. It may be malformed, encrypted, or image-only.'
    return res.status(422).json({ message: clientMessage })
  }
  const chunks = makeChunks(pages)
  if (!chunks.length) return res.status(422).json({ message: 'No selectable text was found. Scanned/image-only PDFs are not supported.' })

  const id = randomUUID()
  const name = path.basename(file.originalname).replace(/[^\p{L}\p{N}._() -]/gu, '').slice(0, 180) || 'notes.pdf'
  const now = new Date().toISOString()
  try {
    const insert = db.transaction(() => {
      db.prepare(`INSERT INTO documents (id, user_id, original_name, stored_name, mime_type, size_bytes, page_count, created_at)
        VALUES (?, ?, ?, ?, 'application/pdf', ?, ?, ?)`)
        .run(id, req.user.id, name, id, file.size, pages.length, now)
      const addChunk = db.prepare(`INSERT INTO document_chunks (id, document_id, user_id, page_number, ordinal, content) VALUES (?, ?, ?, ?, ?, ?)`)
      for (const chunk of chunks) addChunk.run(randomUUID(), id, req.user.id, chunk.pageNumber, chunk.ordinal, chunk.content)
    })
    insert()
  } catch {
    return res.status(500).json({ message: 'Document could not be indexed.' })
  }
  return res.status(201).json({ document: { id, name, mimeType: 'application/pdf', sizeBytes: file.size, pageCount: pages.length, chunkCount: chunks.length, createdAt: now } })
})

router.get('/:documentId', (req, res) => {
  const document = db.prepare(`SELECT id, original_name AS name, page_count AS pageCount, size_bytes AS sizeBytes, created_at AS createdAt
    FROM documents WHERE id = ? AND user_id = ?`).get(req.params.documentId, req.user.id)
  if (!document) return res.status(404).json({ message: 'Document not found.' })
  return res.json({ document })
})

router.post('/search', searchLimiter, (req, res) => {
  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : ''
  const documentId = typeof req.body?.documentId === 'string' ? req.body.documentId : null
  if (query.length < 2 || query.length > 500) return res.status(400).json({ message: 'Question must be 2-500 characters.' })
  const terms = [...new Set(tokenize(query))]
  if (!terms.length) return res.json({ results: [], message: 'No searchable terms were found.' })
  const rows = db.prepare(`SELECT c.id, c.document_id AS documentId, d.original_name AS documentName,
    c.page_number AS pageNumber, c.content, c.ordinal
    FROM document_chunks c JOIN documents d ON d.id = c.document_id
    WHERE c.user_id = ? AND d.user_id = ? AND (? IS NULL OR c.document_id = ?)`)
    .all(req.user.id, req.user.id, documentId, documentId)
  const documents = db.prepare('SELECT 1 FROM documents WHERE id = ? AND user_id = ?').get(documentId, req.user.id)
  if (documentId && !documents) return res.status(404).json({ message: 'Document not found.' })
  const tokenized = rows.map((row) => ({ row, terms: tokenize(row.content) }))
  const averageLength = tokenized.length ? tokenized.reduce((total, item) => total + item.terms.length, 0) / tokenized.length : 0
  const scored = tokenized.map(({ row, terms: documentTerms }) => {
    let score = 0
    for (const term of terms) {
      const frequency = documentTerms.filter((token) => token === term).length
      if (!frequency) continue
      const documentFrequency = tokenized.filter((item) => item.terms.includes(term)).length
      const inverseFrequency = Math.log(1 + (tokenized.length - documentFrequency + 0.5) / (documentFrequency + 0.5))
      const denominator = frequency + 1.2 * (0.25 + 0.75 * documentTerms.length / Math.max(averageLength, 1))
      score += inverseFrequency * (frequency * 2.2 / denominator)
    }
    return { row, score }
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 8)
  return res.json({ results: scored.map(({ row, score }) => ({
    documentId: row.documentId,
    documentName: row.documentName,
    pageNumber: row.pageNumber,
    excerpt: row.content,
    score: Number(score.toFixed(4)),
  })) })
})

router.delete('/:documentId', (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ message: 'Confirm permanent removal by sending {"confirm":true}.' })
  const result = db.prepare('DELETE FROM documents WHERE id = ? AND user_id = ?').run(req.params.documentId, req.user.id)
  if (!result.changes) return res.status(404).json({ message: 'Document not found.' })
  return res.json({ deleted: true })
})

export { makeChunks, tokenize }
export default router