import { Router } from 'express'
import { db, randomUUID, requireAuth } from './auth.js'

const router = Router()
const priorities = new Set(['low', 'medium', 'high'])
const taskIdPattern = /^[0-9a-f-]{36}$/i

function dateOrNull(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return undefined
  return new Date(value).toISOString()
}

function toTask(row) {
  return {
    id: row.id, title: row.title, subject: row.subject, topic: row.topic,
    estimatedMinutes: row.estimated_minutes, deadline: row.deadline,
    priority: row.priority, completed: Boolean(row.completed_at),
    completedAt: row.completed_at, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

router.use(requireAuth)

router.get('/', (req, res) => {
  const rows = db.prepare(`SELECT * FROM tasks WHERE user_id = ? ORDER BY completed_at IS NOT NULL, deadline IS NULL, deadline, created_at DESC`).all(req.user.id)
  return res.json({ tasks: rows.map(toTask) })
})

router.post('/', (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : ''
  const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : ''
  const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim() : ''
  const estimatedMinutes = Number(req.body?.estimatedMinutes)
  const deadline = dateOrNull(req.body?.deadline)
  const priority = req.body?.priority ?? 'medium'
  if (!title || title.length > 140 || !subject || subject.length > 80 || topic.length > 120) {
    return res.status(400).json({ message: 'Task title, subject and topic must fit their allowed lengths.' })
  }
  if (!Number.isInteger(estimatedMinutes) || estimatedMinutes < 5 || estimatedMinutes > 600) return res.status(400).json({ message: 'Study duration must be 5-600 minutes.' })
  if (deadline === undefined) return res.status(400).json({ message: 'Deadline must be a valid date.' })
  if (!priorities.has(priority)) return res.status(400).json({ message: 'Priority must be low, medium, or high.' })
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO tasks (id, user_id, title, subject, topic, estimated_minutes, deadline, priority, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.user.id, title, subject, topic, estimatedMinutes, deadline, priority, now, now)
  return res.status(201).json({ task: toTask(db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, req.user.id)) })
})

router.patch('/:taskId', (req, res) => {
  if (!taskIdPattern.test(req.params.taskId)) return res.status(400).json({ message: 'Invalid task identifier.' })
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(req.params.taskId, req.user.id)
  if (!existing) return res.status(404).json({ message: 'Study task not found.' })

  const fields = {}
  if (Object.hasOwn(req.body || {}, 'title')) {
    if (typeof req.body.title !== 'string' || !req.body.title.trim() || req.body.title.trim().length > 140) return res.status(400).json({ message: 'Title must be 1-140 characters.' })
    fields.title = req.body.title.trim()
  }
  if (Object.hasOwn(req.body || {}, 'subject')) {
    if (typeof req.body.subject !== 'string' || !req.body.subject.trim() || req.body.subject.trim().length > 80) return res.status(400).json({ message: 'Subject must be 1-80 characters.' })
    fields.subject = req.body.subject.trim()
  }
  if (Object.hasOwn(req.body || {}, 'topic')) {
    if (typeof req.body.topic !== 'string' || req.body.topic.trim().length > 120) return res.status(400).json({ message: 'Topic must be at most 120 characters.' })
    fields.topic = req.body.topic.trim()
  }
  if (Object.hasOwn(req.body || {}, 'estimatedMinutes')) {
    const minutes = Number(req.body.estimatedMinutes)
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 600) return res.status(400).json({ message: 'Study duration must be 5-600 minutes.' })
    fields.estimated_minutes = minutes
  }
  if (Object.hasOwn(req.body || {}, 'deadline')) {
    const deadline = dateOrNull(req.body.deadline)
    if (deadline === undefined) return res.status(400).json({ message: 'Deadline must be a valid date.' })
    fields.deadline = deadline
  }
  if (Object.hasOwn(req.body || {}, 'priority')) {
    if (!priorities.has(req.body.priority)) return res.status(400).json({ message: 'Priority must be low, medium, or high.' })
    fields.priority = req.body.priority
  }
  if (Object.hasOwn(req.body || {}, 'completed')) {
    if (typeof req.body.completed !== 'boolean') return res.status(400).json({ message: 'Completed must be a boolean.' })
    fields.completed_at = req.body.completed ? existing.completed_at || new Date().toISOString() : null
  }
  if (!Object.keys(fields).length) return res.status(400).json({ message: 'No supported task fields were provided.' })
  fields.updated_at = new Date().toISOString()
  const assignments = Object.keys(fields).map((field) => `${field} = ?`).join(', ')
  db.prepare(`UPDATE tasks SET ${assignments} WHERE id = ? AND user_id = ?`).run(...Object.values(fields), req.params.taskId, req.user.id)
  return res.json({ task: toTask(db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(req.params.taskId, req.user.id)) })
})

router.delete('/:taskId', (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ message: 'Confirm task deletion by sending {"confirm":true}.' })
  const result = db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(req.params.taskId, req.user.id)
  if (!result.changes) return res.status(404).json({ message: 'Study task not found.' })
  return res.json({ deleted: true })
})

router.get('/sessions', (req, res) => {
  const sessions = db.prepare(`SELECT id, task_id AS taskId, subject, started_at AS startedAt, duration_minutes AS durationMinutes, notes
    FROM study_sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT 100`).all(req.user.id)
  return res.json({ sessions })
})

router.post('/sessions', (req, res) => {
  const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : ''
  const durationMinutes = Number(req.body?.durationMinutes)
  const startedAt = dateOrNull(req.body?.startedAt) || new Date().toISOString()
  const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : ''
  const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId : null
  if (!subject || subject.length > 80 || !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 600 || notes.length > 1000) {
    return res.status(400).json({ message: 'Provide a subject, a 1-600 minute duration, and at most 1000 note characters.' })
  }
  if (taskId && !db.prepare('SELECT 1 FROM tasks WHERE id = ? AND user_id = ?').get(taskId, req.user.id)) return res.status(404).json({ message: 'Linked task not found.' })
  const id = randomUUID()
  db.prepare(`INSERT INTO study_sessions (id, user_id, task_id, subject, started_at, duration_minutes, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.user.id, taskId, subject, startedAt, durationMinutes, notes)
  return res.status(201).json({ session: db.prepare(`SELECT id, task_id AS taskId, subject, started_at AS startedAt, duration_minutes AS durationMinutes, notes FROM study_sessions WHERE id = ?`).get(id) })
})

export default router