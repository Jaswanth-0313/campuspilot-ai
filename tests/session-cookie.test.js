import test from 'node:test'
import assert from 'node:assert/strict'
import { hasAuthSessionCookie } from '../src/api.js'

test('guest mode skips protected auth checks when no session cookie is present', () => {
  assert.equal(hasAuthSessionCookie(''), false)
  assert.equal(hasAuthSessionCookie('theme=dark; locale=en'), false)
  assert.equal(hasAuthSessionCookie('theme=dark; campuspilot_session=abc123'), true)
  assert.equal(hasAuthSessionCookie('campuspilot_session=abc123; theme=dark'), true)
})
