import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAssemblyAIKey, requestVoiceToken } from './voice.js'
import { requireAuth } from './auth.js'
import authRoutes from './auth-routes.js'
import taskRoutes from './task-routes.js'
import conversationRoutes from './conversation-routes.js'
import documentRoutes from './document-routes.js'
import quizRoutes from './quiz-routes.js'

const app = express()
const port = Number(process.env.PORT || 5001)
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5174'
const currentDir = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(currentDir, '../dist')

app.disable('x-powered-by')
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'connect-src': ["'self'", 'wss://agents.assemblyai.com'],
      'img-src': ["'self'", 'data:'],
    },
  },
}))
const allowedOrigins = frontendUrl.split(',').map((origin) => origin.trim())
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true)
    const error = new Error('Origin is not allowed.')
    error.status = 403
    return callback(error)
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-CampusPilot-Request'],
}))
app.use(express.json({ limit: '20kb' }))
app.use(cookieParser())

const statusLimit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false })
const tokenLimit = rateLimit({ windowMs: 60 * 1000, limit: 4, standardHeaders: 'draft-8', legacyHeaders: false })

app.get('/api/health', (_req, res) => res.json({ ok: true }))
app.use('/api/auth', authRoutes)
app.use('/api/tasks', taskRoutes)
app.use('/api/conversations', conversationRoutes)
app.use('/api/documents', documentRoutes)
app.use('/api/quizzes', quizRoutes)

app.get('/api/status', statusLimit, async (_req, res) => {
  if (!getAssemblyAIKey()) {
    return res.json({
      mode: 'demo',
      message: 'Demo mode - add your AssemblyAI API key to CampusPilot/.env to enable live voice.',
    })
  }
  try {
    await requestVoiceToken()
    return res.json({ mode: 'live', message: 'AssemblyAI accepted the backend configuration.' })
  } catch (error) {
    return res.json({ mode: 'unavailable', message: error.message })
  }
})

app.post('/api/voice-token', requireAuth, tokenLimit, async (_req, res) => {
  res.set('Cache-Control', 'no-store')
  try {
    const token = await requestVoiceToken()
    return res.json({ token })
  } catch (error) {
    return res.status(error.status || 502).json({ message: error.message })
  }
})

app.use('/api', (_req, res) => res.status(404).json({ message: 'CampusPilot API endpoint not found.' }))
app.use(express.static(distDir))
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next()
  return res.sendFile(path.join(distDir, 'index.html'), (error) => {
    if (error) res.status(404).json({ message: 'CampusPilot frontend is not built yet.' })
  })
})

app.use((error, _req, res, _next) => {
  if (res.headersSent) return
  const status = Number(error.status || error.statusCode)
  if (status === 400) return res.status(400).json({ message: 'Request could not be parsed.' })
  if (status === 403) return res.status(403).json({ message: 'This request origin is not allowed.' })
  if (status === 413) return res.status(413).json({ message: 'Request body is too large.' })
  return res.status(500).json({ message: 'CampusPilot could not process this request.' })
})

app.listen(port, '127.0.0.1', () => {
  console.log(`CampusPilot API listening on http://127.0.0.1:${port}`)
})