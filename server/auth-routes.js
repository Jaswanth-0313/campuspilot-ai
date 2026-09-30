import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { bcrypt, cookieOptions, createUser, db, getAuthSecret, publicProfile, requireAuth, revokeSession, setSessionCookie, SESSION_COOKIE } from './auth.js'

const router = Router()
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false })

function validateEmail(value) {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

router.post('/signup', authLimiter, async (req, res) => {
  if (!getAuthSecret()) return res.status(503).json({ message: 'Configure AUTH_SECRET in CampusPilot/.env before enabling accounts.' })
  const email = validateEmail(req.body?.email)
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : ''
  if (!email || displayName.length < 2 || displayName.length > 80) {
    return res.status(400).json({ message: 'Enter a valid email and a display name between 2 and 80 characters.' })
  }
  if (password.length < 10 || Buffer.byteLength(password, 'utf8') > 72) {
    return res.status(400).json({ message: 'Password must be at least 10 characters and no more than 72 UTF-8 bytes.' })
  }
  try {
    const user = createUser({ email, password, displayName })
    setSessionCookie(res, user.id)
    return res.status(201).json({ user })
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ message: 'An account with that email already exists.' })
    return res.status(500).json({ message: 'Account could not be created.' })
  }
})

router.post('/login', authLimiter, async (req, res) => {
  if (!getAuthSecret()) return res.status(503).json({ message: 'Configure AUTH_SECRET in CampusPilot/.env before enabling accounts.' })
  const email = validateEmail(req.body?.email)
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  if (!email || !password || Buffer.byteLength(password, 'utf8') > 72) {
    return res.status(400).json({ message: 'Enter a valid email and password.' })
  }
  const user = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(email)
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ message: 'Email or password is incorrect.' })
  }
  setSessionCookie(res, user.id)
  return res.json({ user: publicProfile(user.id) })
})

router.post('/logout', (req, res) => {
  revokeSession(req)
  res.clearCookie(SESSION_COOKIE, cookieOptions())
  return res.json({ ok: true })
})

router.get('/me', requireAuth, (req, res) => res.json({ user: publicProfile(req.user.id) }))

router.get('/profile', requireAuth, (req, res) => res.json({ profile: publicProfile(req.user.id) }))

router.put('/profile', requireAuth, (req, res) => {
  const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : ''
  const department = typeof req.body?.department === 'string' ? req.body.department.trim() : ''
  const preferences = req.body?.preferences ?? {}
  if (displayName.length < 2 || displayName.length > 80 || department.length > 120) {
    return res.status(400).json({ message: 'Display name must be 2-80 characters and department up to 120 characters.' })
  }
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences) || JSON.stringify(preferences).length > 4000) {
    return res.status(400).json({ message: 'Preferences must be a small JSON object.' })
  }
  db.prepare(`UPDATE profiles SET display_name = ?, department = ?, preferences_json = ?, updated_at = ? WHERE user_id = ?`)
    .run(displayName, department, JSON.stringify(preferences), new Date().toISOString(), req.user.id)
  return res.json({ profile: publicProfile(req.user.id) })
})

export default router