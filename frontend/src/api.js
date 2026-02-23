const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000'

export function apiUrl(path) {
  return `${API_BASE}${path}`
}

export async function apiFetch(path, { method = 'GET', token, body, headers } = {}) {
  const res = await fetch(apiUrl(path), {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {})
    },
    body: body ? JSON.stringify(body) : undefined
  })

  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = text }

  if (!res.ok) {
    const msg = (data && (data.detail || data.message)) || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return data
}

// For multipart uploads (FormData). No JSON encoding.
export async function apiUpload(path, { method = 'POST', token, formData, headers } = {}) {
  const res = await fetch(apiUrl(path), {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {})
    },
    body: formData
  })

  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!res.ok) {
    const msg = (data && (data.detail || data.message)) || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return data
}

export async function login(email, password) {
  // OAuth2PasswordRequestForm expects x-www-form-urlencoded
  const res = await fetch(apiUrl('/api/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: email, password })
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.detail || 'Login failed')
  return data
}
