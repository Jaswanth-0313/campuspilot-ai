import 'dotenv/config'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'

const placeholder = 'YOUR_ASSEMBLYAI_API_KEY_HERE'
if (!process.env.ASSEMBLYAI_API_KEY?.trim() || process.env.ASSEMBLYAI_API_KEY.trim() === placeholder) {
  console.error('Live check skipped: set a real ASSEMBLYAI_API_KEY in CampusPilot/.env.')
  process.exitCode = 2
} else {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campuspilot-live-'))
  const portProbe = net.createServer()
  let child
  let socket

  try {
    portProbe.listen(0, '127.0.0.1')
    await once(portProbe, 'listening')
    const { port } = portProbe.address()
    await new Promise((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()))

    child = spawn(process.execPath, ['server/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(port),
        FRONTEND_URL: 'http://localhost:5174',
        AUTH_SECRET: randomBytes(32).toString('hex'),
        CAMPUSPILOT_DB_PATH: path.join(temporaryDir, 'smoke.sqlite'),
      },
      stdio: 'ignore',
      windowsHide: true,
    })

    const baseUrl = `http://127.0.0.1:${port}`
    let ready = false
    for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
      if (child.exitCode !== null) throw new Error('Temporary CampusPilot API exited before startup.')
      try { ready = (await fetch(`${baseUrl}/api/health`)).ok } catch { /* Wait for local startup. */ }
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (!ready) throw new Error('Temporary CampusPilot API did not start.')

    const origin = 'http://localhost:5174'
    const signupResponse = await fetch(`${baseUrl}/api/auth/signup`, {
      method: 'POST',
      headers: { Origin: origin, 'X-CampusPilot-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `voice-check-${randomBytes(6).toString('hex')}@example.test`, displayName: 'Voice Check', password: 'TemporaryTestPassword!572' }),
    })
    if (!signupResponse.ok) throw new Error('Temporary account setup failed.')
    const cookie = signupResponse.headers.getSetCookie?.()[0]?.split(';')[0]
    if (!cookie) throw new Error('Temporary session cookie was not issued.')

    const tokenResponse = await fetch(`${baseUrl}/api/voice-token`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie, 'X-CampusPilot-Request': '1', 'Content-Type': 'application/json' },
      body: '{}',
    })
    const tokenBody = await tokenResponse.json().catch(() => ({}))
    if (!tokenResponse.ok || !tokenBody.token) throw new Error(tokenBody.message || 'Temporary voice token was not issued.')

    const url = new URL('wss://agents.assemblyai.com/v1/ws')
    url.searchParams.set('token', tokenBody.token)
    socket = new WebSocket(url)
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for the Voice Agent reply.')), 35000)
      let readyEvent = false
      let textReceived = false
      let audioChunks = 0
      let endSent = false
      const finish = (error, value) => {
        clearTimeout(timeout)
        if (error) reject(error)
        else resolve(value)
      }

      socket.addEventListener('open', () => socket.send(JSON.stringify({
        type: 'session.update',
        session: {
          system_prompt: 'You are a concise academic test assistant. Reply with exactly: CampusPilot live voice test confirmed.',
          input: { format: { encoding: 'audio/pcm' } },
          output: { voice: 'alba', format: { encoding: 'audio/pcm' } },
        },
      })))
      socket.addEventListener('message', (message) => {
        let event
        try { event = JSON.parse(message.data) } catch { return }
        if (event.type === 'session.error') return finish(new Error(event.message || 'AssemblyAI session failed.'))
        if (event.type === 'session.ready') {
          readyEvent = true
          socket.send(JSON.stringify({ type: 'conversation.message', role: 'user', content: 'Say the exact confirmation sentence now.' }))
          socket.send(JSON.stringify({ type: 'reply.create' }))
        } else if (event.type === 'transcript.agent') {
          textReceived = Boolean(event.text)
        } else if (event.type === 'reply.audio') {
          audioChunks += 1
        } else if (event.type === 'reply.done' && event.status === 'completed' && !endSent) {
          endSent = true
          socket.send(JSON.stringify({ type: 'session.end' }))
        } else if (event.type === 'session.ended') {
          finish(null, { readyEvent, textReceived, audioChunks, cleanEnd: true })
        }
      })
      socket.addEventListener('error', () => finish(new Error('AssemblyAI WebSocket connection failed.')))
      socket.addEventListener('close', () => {
        if (!endSent) finish(new Error('Voice session closed before completing the smoke test.'))
      })
    })

    if (!result.readyEvent || !result.textReceived || result.audioChunks < 1 || !result.cleanEnd) {
      throw new Error(`Live checks did not all pass (ready=${result.readyEvent}, text=${result.textReceived}, audioChunks=${result.audioChunks}, cleanEnd=${result.cleanEnd}).`)
    }
    console.log(`Live AssemblyAI check passed: session ready, assistant transcript received, ${result.audioChunks} audio chunk(s), clean session end.`)
  } catch (error) {
    console.error(`Live AssemblyAI check failed: ${error.message}`)
    process.exitCode = 1
  } finally {
    if (socket?.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify({ type: 'session.end' })) } catch { /* Session already closed. */ }
      socket.close()
    }
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))])
    }
    fs.rmSync(temporaryDir, { recursive: true, force: true })
  }
}