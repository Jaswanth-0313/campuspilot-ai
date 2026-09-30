import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import Database from 'better-sqlite3'
import { once } from 'node:events'

async function freePort() {
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address()
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}

async function waitForApi(baseUrl, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`CampusPilot test server exited with ${child.exitCode}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch { /* The server is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('CampusPilot test server did not become ready.')
}

function makePdf(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  return Buffer.from(pdf, 'ascii')
}

test('auth, owner-scoped APIs, scoring, malformed PDF and demo token boundaries', async () => {
  const fixtureTask = pdfjs.getDocument({ data: new Uint8Array(makePdf('KVL test text')), isEvalSupported: false, useSystemFonts: true, verbosity: 0 })
  const fixturePdf = await fixtureTask.promise
  assert.equal(fixturePdf.numPages, 1)
  await fixtureTask.destroy()
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campuspilot-api-'))
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const serverEnv = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'test',
    AUTH_SECRET: 'campuspilot-test-only-secret-0123456789',
    ASSEMBLYAI_API_KEY: 'YOUR_ASSEMBLYAI_API_KEY_HERE',
    FRONTEND_URL: 'http://localhost:5174',
    CAMPUSPILOT_DB_PATH: path.join(tempDir, 'test.sqlite'),
  }
  const startServer = () => spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(), env: serverEnv, stdio: 'ignore', windowsHide: true,
  })
  let child = startServer()

  try {
    await waitForApi(baseUrl, child)
    const request = async (route, { method = 'GET', body, cookie, headers = {} } = {}) => {
      const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
      const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: {
          Origin: 'http://localhost:5174',
          ...(write ? { 'X-CampusPilot-Request': '1' } : {}),
          ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      })
      const data = await response.json().catch(() => ({}))
      const setCookieHeader = response.headers.getSetCookie?.()[0]
      const setCookie = setCookieHeader?.split(';')[0]
      return { response, data, setCookie, setCookieHeader }
    }
    const signup = async (email, displayName) => {
      const result = await request('/api/auth/signup', { method: 'POST', body: { email, displayName, password: 'CorrectHorseBatteryStaple!42' } })
      assert.equal(result.response.status, 201, JSON.stringify(result.data))
      assert.ok(result.setCookie)
      assert.match(result.setCookieHeader, /HttpOnly/i)
      assert.match(result.setCookieHeader, /SameSite=Lax/i)
      assert.match(result.setCookieHeader, /Max-Age=604800/i)
      return result.setCookie
    }

    const unauthenticatedTasks = await request('/api/tasks')
    assert.equal(unauthenticatedTasks.response.status, 401)
    const missingApi = await request('/api/not-a-campus-pilot-route')
    assert.equal(missingApi.response.status, 404)
    assert.match(missingApi.response.headers.get('content-type'), /application\/json/)
    const blockedOrigin = await request('/api/health', { headers: { Origin: 'https://untrusted.example' } })
    assert.equal(blockedOrigin.response.status, 403)
    assert.match(blockedOrigin.response.headers.get('content-type'), /application\/json/)
    const status = await request('/api/status')
    assert.equal(status.data.mode, 'demo')
    const untrustedToken = await request('/api/voice-token', { method: 'POST' })
    assert.equal(untrustedToken.response.status, 401)

    const firstEmail = `one-${Date.now()}@example.test`
    const firstCookie = await signup(firstEmail, 'Student One')
    const secondCookie = await signup(`two-${Date.now()}@example.test`, 'Student Two')
    const invalidLogin = await request('/api/auth/login', { method: 'POST', body: { email: firstEmail, password: 'incorrect-password' } })
    assert.equal(invalidLogin.response.status, 401)
    const profile = await request('/api/auth/me', { cookie: firstCookie })
    assert.equal(profile.data.user.displayName, 'Student One')
    const login = await request('/api/auth/login', { method: 'POST', body: { email: firstEmail, password: 'CorrectHorseBatteryStaple!42' } })
    assert.equal(login.response.status, 200)
    assert.ok(login.setCookie)
    const profileUpdate = await request('/api/auth/profile', { method: 'PUT', cookie: login.setCookie, body: { displayName: 'Student One Updated', department: 'Engineering', preferences: { studyGoalMinutes: 90 } } })
    assert.equal(profileUpdate.data.profile.displayName, 'Student One Updated')
    assert.equal(profileUpdate.data.profile.department, 'Engineering')
    const auditDb = new Database(path.join(tempDir, 'test.sqlite'), { readonly: true })
    const storedPassword = auditDb.prepare('SELECT password_hash FROM users WHERE email = ?').get(firstEmail).password_hash
    assert.notEqual(storedPassword, 'CorrectHorseBatteryStaple!42')
    assert.match(storedPassword, /^\$2[ab]\$/)
    auditDb.close()
    assert.equal((await request('/api/auth/profile', { cookie: secondCookie })).data.profile.displayName, 'Student Two')
    const csrfFailure = await request('/api/tasks', {
      method: 'POST', cookie: firstCookie, headers: { 'X-CampusPilot-Request': '' },
      body: { title: 'Should be rejected', subject: 'Circuits', estimatedMinutes: 20 },
    })
    assert.equal(csrfFailure.response.status, 403)

    const createdTask = await request('/api/tasks', {
      method: 'POST', cookie: firstCookie,
      body: { title: 'Review KVL', subject: 'Circuits', topic: 'Loops', estimatedMinutes: 40, priority: 'high' },
    })
    assert.equal(createdTask.response.status, 201, JSON.stringify(createdTask.data))
    const taskId = createdTask.data.task.id
    const taskUpdate = await request(`/api/tasks/${taskId}`, { method: 'PATCH', cookie: firstCookie, body: { title: 'Review KVL revised', topic: 'Loop analysis', estimatedMinutes: 45, priority: 'low' } })
    assert.equal(taskUpdate.data.task.title, 'Review KVL revised')
    assert.equal(taskUpdate.data.task.topic, 'Loop analysis')
    assert.equal(taskUpdate.data.task.estimatedMinutes, 45)
    assert.equal((await request('/api/tasks', { cookie: secondCookie })).data.tasks.length, 0)
    assert.equal((await request(`/api/tasks/${taskId}`, { method: 'PATCH', cookie: secondCookie, body: { completed: true } })).response.status, 404)
    assert.equal((await request(`/api/tasks/${taskId}`, { method: 'PATCH', cookie: firstCookie, body: { completed: true } })).data.task.completed, true)
    assert.equal((await request(`/api/tasks/${taskId}`, { method: 'DELETE', cookie: firstCookie, body: {} })).response.status, 400)
    const taskDeleted = await request(`/api/tasks/${taskId}`, { method: 'DELETE', cookie: firstCookie, body: { confirm: true } })
    assert.equal(taskDeleted.data.deleted, true)
    assert.equal((await request(`/api/tasks/${taskId}`, { method: 'PATCH', cookie: firstCookie, body: { completed: false } })).response.status, 404)
    const studySession = await request('/api/tasks/sessions', { method: 'POST', cookie: firstCookie, body: { subject: 'Circuits', durationMinutes: 35 } })
    assert.equal(studySession.response.status, 201)
    assert.equal((await request('/api/tasks/sessions', { cookie: secondCookie })).data.sessions.length, 0)

    const conversation = await request('/api/conversations', { method: 'POST', cookie: firstCookie, body: { title: 'Exam revision' } })
    assert.equal(conversation.response.status, 201)
    const conversationId = conversation.data.conversation.id
    assert.equal((await request(`/api/conversations/${conversationId}/messages`, { cookie: secondCookie })).response.status, 404)
    const savedMessage = await request(`/api/conversations/${conversationId}/messages`, { method: 'POST', cookie: firstCookie, body: { role: 'user', content: 'Explain Kirchhoff laws.' } })
    assert.equal(savedMessage.response.status, 201)
    assert.equal((await request(`/api/conversations/${conversationId}/messages`, { cookie: firstCookie })).data.messages.length, 1)
    assert.equal((await request(`/api/conversations/${conversationId}`, { method: 'DELETE', cookie: secondCookie, body: { confirm: true } })).response.status, 404)
    assert.equal((await request(`/api/conversations/${conversationId}`, { method: 'DELETE', cookie: firstCookie, body: { confirm: true } })).data.deleted, true)

    const quiz = await request('/api/quizzes', {
      method: 'POST', cookie: firstCookie,
      body: {
        topic: 'Circuit laws', difficulty: 'beginner', source: 'assemblyai-live',
        questions: [
          { prompt: 'KVL sum?', options: ['zero', 'one'], answerIndex: 0, explanation: 'Closed-loop voltage sums to zero.' },
          { prompt: 'Ohm law?', options: ['V=IR', 'V=I/R'], answerIndex: 0, explanation: 'Voltage equals current times resistance.' },
        ],
      },
    })
    assert.equal(quiz.response.status, 201, JSON.stringify(quiz.data))
    const quizId = quiz.data.quiz.id
    assert.equal((await request(`/api/quizzes/${quizId}`, { cookie: secondCookie })).response.status, 404)
    assert.equal((await request(`/api/quizzes/${quizId}/attempts`, { method: 'POST', cookie: secondCookie, body: { answers: [0, 0] } })).response.status, 404)
    const attempt = await request(`/api/quizzes/${quizId}/attempts`, { method: 'POST', cookie: firstCookie, body: { answers: [0, 1] } })
    assert.equal(attempt.data.attempt.score, 1)
    assert.equal(attempt.data.attempt.total, 2)

    const validPdf = new FormData()
    validPdf.append('document', new Blob([makePdf('Kirchhoff voltage law: loop voltage rises and drops sum to zero.')], { type: 'application/pdf' }), 'engineering.pdf')
    const uploaded = await request('/api/documents', { method: 'POST', cookie: firstCookie, body: validPdf })
    assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.data))
    assert.equal(uploaded.data.document.pageCount, 1)
    const retrieved = await request('/api/documents/search', { method: 'POST', cookie: firstCookie, body: { query: 'Kirchhoff voltage loop' } })
    assert.equal(retrieved.response.status, 200, JSON.stringify(retrieved.data))
    assert.equal(retrieved.data.results[0].documentName, 'engineering.pdf')
    assert.equal(retrieved.data.results[0].pageNumber, 1)
    assert.match(retrieved.data.results[0].excerpt, /Kirchhoff voltage law/)
    const crossUserSearch = await request('/api/documents/search', { method: 'POST', cookie: secondCookie, body: { query: 'Kirchhoff voltage', documentId: uploaded.data.document.id } })
    assert.equal(crossUserSearch.response.status, 404)
    assert.equal((await request('/api/documents', { cookie: secondCookie })).data.documents.length, 0)

    const form = new FormData()
    form.append('document', new Blob(['%PDF-not-a-real-document'], { type: 'application/pdf' }), 'notes.pdf')
    const malformedPdf = await request('/api/documents', { method: 'POST', cookie: firstCookie, body: form })
    assert.equal(malformedPdf.response.status, 422)
    assert.equal((await request('/api/documents', { cookie: secondCookie })).data.documents.length, 0)

    const persistentTask = await request('/api/tasks', { method: 'POST', cookie: firstCookie, body: { title: 'Survive restart', subject: 'Testing', estimatedMinutes: 25 } })
    assert.equal(persistentTask.response.status, 201)
    child.kill('SIGTERM')
    await once(child, 'exit')
    child = startServer()
    await waitForApi(baseUrl, child)
    const persistedTask = await request('/api/tasks', { cookie: firstCookie })
    assert.equal(persistedTask.data.tasks.length, 1)
    assert.equal(persistedTask.data.tasks[0].title, 'Survive restart')
    assert.equal((await request('/api/documents', { cookie: firstCookie })).data.documents.length, 1)
    assert.equal((await request('/api/quizzes', { cookie: firstCookie })).data.quizzes.length, 1)

    const logout = await request('/api/auth/logout', { method: 'POST', cookie: firstCookie })
    assert.equal(logout.response.status, 200)
    assert.match(logout.setCookieHeader, /Expires=Thu, 01 Jan 1970/i)
    assert.equal((await request('/api/tasks', { cookie: firstCookie })).response.status, 401)
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))])
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
