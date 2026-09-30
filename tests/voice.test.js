import test from 'node:test'
import assert from 'node:assert/strict'
import { getAssemblyAIKey, requestVoiceToken } from '../server/voice.js'

test('missing and placeholder keys stay in demo mode', async () => {
  assert.equal(getAssemblyAIKey({}), null)
  assert.equal(getAssemblyAIKey({ ASSEMBLYAI_API_KEY: 'YOUR_ASSEMBLYAI_API_KEY_HERE' }), null)
  assert.equal(getAssemblyAIKey({ ASSEMBLYAI_API_KEY: '  YOUR_ASSEMBLYAI_API_KEY_HERE  ' }), null)

  let called = false
  await assert.rejects(requestVoiceToken({ apiKey: null, fetchImpl: async () => { called = true } }), { status: 503 })
  assert.equal(called, false)
})

test('valid key uses the official short-lived voice token endpoint', async () => {
  let requestUrl
  let requestOptions
  const token = await requestVoiceToken({
    apiKey: 'test-secret',
    fetchImpl: async (url, options) => {
      requestUrl = url
      requestOptions = options
      return { ok: true, json: async () => ({ token: 'single-use-token' }) }
    },
  })

  assert.equal(token, 'single-use-token')
  assert.equal(requestUrl.origin, 'https://agents.assemblyai.com')
  assert.equal(requestUrl.pathname, '/v1/token')
  assert.equal(requestUrl.searchParams.get('expires_in_seconds'), '300')
  assert.equal(requestUrl.searchParams.get('max_session_duration_seconds'), '1800')
  assert.equal(requestOptions.headers.Authorization, 'Bearer test-secret')
  assert.equal(requestOptions.signal.aborted, false)
})

test('provider failures return a sanitized message', async () => {
  await assert.rejects(requestVoiceToken({
    apiKey: 'test-secret',
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'private provider response' }),
  }), (error) => {
    assert.equal(error.status, 503)
    assert.equal(error.message.includes('test-secret'), false)
    assert.equal(error.message.includes('private provider response'), false)
    return true
  })
})
