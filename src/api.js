class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export function hasAuthSessionCookie(cookieString = typeof document === 'undefined' ? '' : document.cookie) {
  return cookieString.split(';').some((part) => part.trim().startsWith('campuspilot_session='))
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
  const headers = {}
  if (write) headers['X-CampusPilot-Request'] = '1'
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json'
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers,
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    signal,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiError(data.message || 'CampusPilot request failed.', response.status)
  return data
}

export const api = {
  voiceToken: () => request('/voice-token', { method: 'POST', body: {} }),
  auth: {
    me: () => request('/auth/me'),
    signup: (body) => request('/auth/signup', { method: 'POST', body }),
    login: (body) => request('/auth/login', { method: 'POST', body }),
    logout: () => request('/auth/logout', { method: 'POST', body: {} }),
    profile: () => request('/auth/profile'),
    updateProfile: (body) => request('/auth/profile', { method: 'PUT', body }),
  },
  tasks: {
    list: () => request('/tasks'),
    create: (body) => request('/tasks', { method: 'POST', body }),
    update: (id, body) => request(`/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    remove: (id) => request(`/tasks/${encodeURIComponent(id)}`, { method: 'DELETE', body: { confirm: true } }),
    sessions: () => request('/tasks/sessions'),
    createSession: (body) => request('/tasks/sessions', { method: 'POST', body }),
  },
  conversations: {
    list: () => request('/conversations'),
    create: (body) => request('/conversations', { method: 'POST', body }),
    messages: (id) => request(`/conversations/${encodeURIComponent(id)}/messages`),
    addMessage: (id, body) => request(`/conversations/${encodeURIComponent(id)}/messages`, { method: 'POST', body }),
    remove: (id) => request(`/conversations/${encodeURIComponent(id)}`, { method: 'DELETE', body: { confirm: true } }),
  },
  documents: {
    list: () => request('/documents'),
    upload: (file) => {
      const form = new FormData()
      form.append('document', file)
      return request('/documents', { method: 'POST', body: form })
    },
    search: (body) => request('/documents/search', { method: 'POST', body }),
    remove: (id) => request(`/documents/${encodeURIComponent(id)}`, { method: 'DELETE', body: { confirm: true } }),
  },
  quizzes: {
    list: () => request('/quizzes'),
    create: (body) => request('/quizzes', { method: 'POST', body }),
    get: (id) => request(`/quizzes/${encodeURIComponent(id)}`),
    attempts: (id) => request(`/quizzes/${encodeURIComponent(id)}/attempts`),
    submit: (id, body) => request(`/quizzes/${encodeURIComponent(id)}/attempts`, { method: 'POST', body }),
  },
}

export { ApiError }