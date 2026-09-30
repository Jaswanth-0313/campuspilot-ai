import { Router } from 'express'
import { db, randomUUID, requireAuth } from './auth.js'

const router = Router()
router.use(requireAuth)

router.get('/', (req, res) => {
  const conversations = db.prepare(`SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
    FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50`).all(req.user.id)
  return res.json({ conversations })
})

router.post('/', (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : 'Study conversation'
  if (title.length > 120) return res.status(400).json({ message: 'Conversation title must be at most 120 characters.' })
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare('INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.user.id, title || 'Study conversation', now, now)
  return res.status(201).json({ conversation: { id, title: title || 'Study conversation', createdAt: now, updatedAt: now } })
})

router.get('/:conversationId/messages', (req, res) => {
  const ownsConversation = db.prepare('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?').get(req.params.conversationId, req.user.id)
  if (!ownsConversation) return res.status(404).json({ message: 'Conversation not found.' })
  const messages = db.prepare(`SELECT id, role, content, source_json AS sourceJson, created_at AS createdAt
    FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY created_at LIMIT 500`).all(req.params.conversationId, req.user.id)
    .map((message) => ({ ...message, sources: JSON.parse(message.sourceJson), sourceJson: undefined }))
  return res.json({ messages })
})

router.post('/:conversationId/messages', (req, res) => {
  const ownsConversation = db.prepare('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?').get(req.params.conversationId, req.user.id)
  if (!ownsConversation) return res.status(404).json({ message: 'Conversation not found.' })
  const role = req.body?.role
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : ''
  const sources = Array.isArray(req.body?.sources) ? req.body.sources.slice(0, 10) : []
  if (!['user', 'assistant'].includes(role) || !content || content.length > 20000) {
    return res.status(400).json({ message: 'Message role or content is invalid.' })
  }
  const id = randomUUID()
  const now = new Date().toISOString()
  const insert = db.transaction(() => {
    db.prepare(`INSERT INTO messages (id, conversation_id, user_id, role, content, source_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.params.conversationId, req.user.id, role, content, JSON.stringify(sources), now)
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?').run(now, req.params.conversationId, req.user.id)
  })
  insert()
  return res.status(201).json({ message: { id, role, content, sources, createdAt: now } })
})

router.delete('/:conversationId', (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ message: 'Confirm permanent conversation removal by sending {"confirm":true}.' })
  const result = db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(req.params.conversationId, req.user.id)
  if (!result.changes) return res.status(404).json({ message: 'Conversation not found.' })
  return res.json({ deleted: true })
})

export default router