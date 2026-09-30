const TOKEN_ENDPOINT = 'https://agents.assemblyai.com/v1/token'
const PLACEHOLDER = 'YOUR_ASSEMBLYAI_API_KEY_HERE'

export function getAssemblyAIKey(env = process.env) {
  const value = env.ASSEMBLYAI_API_KEY?.trim()
  return value && value !== PLACEHOLDER ? value : null
}

export async function requestVoiceToken({ apiKey = getAssemblyAIKey(), fetchImpl = fetch } = {}) {
  if (!apiKey) {
    const error = new Error('Demo mode is active. Add an AssemblyAI key to the CampusPilot backend environment.')
    error.status = 503
    throw error
  }

  const url = new URL(TOKEN_ENDPOINT)
  url.searchParams.set('expires_in_seconds', '300')
  url.searchParams.set('max_session_duration_seconds', '1800')

  let response
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    })
  } catch {
    const error = new Error('AssemblyAI could not be reached. Check the backend network and try again.')
    error.status = 502
    throw error
  }

  if (!response.ok) {
    const error = new Error(
      response.status === 401 || response.status === 403
        ? 'AssemblyAI rejected the configured backend key.'
        : 'AssemblyAI could not issue a voice session token.'
    )
    error.status = response.status === 401 || response.status === 403 ? 503 : 502
    throw error
  }

  let result
  try {
    result = await response.json()
  } catch {
    const error = new Error('AssemblyAI returned an unreadable token response.')
    error.status = 502
    throw error
  }
  if (typeof result.token !== 'string' || !result.token) {
    const error = new Error('AssemblyAI returned an invalid voice session token response.')
    error.status = 502
    throw error
  }
  return result.token
}