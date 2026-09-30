import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import { db } from './db.js'

export const SESSION_COOKIE = 'campuspilot_session'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function getAuthSecret() {
  const secret = process.env.AUTH_SECRET?.trim()
  if (secret && secret !== 'REPLACE_WITH_A_LONG_RANDOM_SECRET') return secret
  if (process.env.NODE_ENV !== 'production') return 'local-development-only-change-before-deploy'
  return null
}

export function requireAuth(req, res, next) {
  const secret = getAuthSecret()
  const cookie = req.cookies?.[SESSION_COOKIE]
  if (!secret || !cookie) return res.status(401).json({ message: 'Sign in is required for this action.' })
  try {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5174').split(',').map((origin) => origin.trim())
      if (req.get('X-CampusPilot-Request') !== '1' || !allowedOrigins.includes(req.get('origin'))) {
        return res.status(403).json({ message: 'This request could not be verified. Reload CampusPilot and try again.' })
      }
    }
    const payload = jwt.verify(cookie, secret)
    const user = db.prepare(`SELECT u.id, u.email FROM auth_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?`)
      .get(payload.sid, payload.sub, new Date().toISOString())
    if (!user) return res.status(401).json({ message: 'Your session is no longer valid. Please sign in again.' })
    req.user = user
    next()
  } catch {
    return res.status(401).json({ message: 'Your session is invalid or expired. Please sign in again.' })
  }
}

export function setSessionCookie(res, userId) {
  const secret = getAuthSecret()
  if (!secret) throw new Error('AUTH_SECRET is required in production.')
  const sessionId = randomUUID()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString()
  db.prepare('INSERT INTO auth_sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sessionId, userId, now.toISOString(), expiresAt)
  const token = jwt.sign({ sub: userId, sid: sessionId }, secret, { expiresIn: '7d', issuer: 'campuspilot' })
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  })
}

export function revokeSession(req) {
  const secret = getAuthSecret()
  const cookie = req.cookies?.[SESSION_COOKIE]
  if (!secret || !cookie) return
  try {
    const payload = jwt.verify(cookie, secret, { issuer: 'campuspilot' })
    if (payload.sid) db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), payload.sid, payload.sub)
  } catch { /* Expired or invalid sessions are already unusable. */ }
}

export function createUser({ email, password, displayName }) {
  const id = randomUUID()
  const now = new Date().toISOString()
  const passwordHash = bcrypt.hashSync(password, 12)
  const create = db.transaction(() => {
    db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run(id, email, passwordHash, now)
    db.prepare('INSERT INTO profiles (user_id, display_name, updated_at) VALUES (?, ?, ?)').run(id, displayName, now)
  })
  create()
  return { id, email, displayName }
}

export function publicProfile(userId) {
  return db.prepare(`
    SELECT u.id, u.email, p.display_name AS displayName, p.department,
      p.preferences_json AS preferencesJson
    FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = ?
  `).get(userId)
}

export function cookieOptions() {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', path: '/' }
}

export { bcrypt, db, randomUUID }