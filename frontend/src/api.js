const ENV_API_BASE = (import.meta.env.VITE_API_BASE || '').trim()

// MVP single-service (Railway):
// - dev: can call local backend or VITE_API_BASE
// - prod: ALWAYS same origin (avoid misconfig / CORS)
const API_BASE = import.meta.env.DEV
  ? (ENV_API_BASE || 'http://localhost:8000')
  : ''

export function apiUrl(path) {
  return `${API_BASE}${path}`
}

function prettyNetworkError(err) {
  const msg = (err && err.message) ? String(err.message) : ''
  if (/Failed to fetch|NetworkError|ECONN|ENOTFOUND|ERR_NETWORK|CORS/i.test(msg)) {
    return 'Не удалось подключиться к серверу. Проверьте, что бэкенд запущен и домен открывает именно этот сервис. Если вы открыли приложение по кастомному домену (.com) до настройки DNS, временно используйте домен Railway вида https://<service>.up.railway.app (Railway → Networking → Domains).'
  }
  return msg || 'Network error'
}

let _tokenUpdater = null
export function registerTokenUpdater(fn) {
  _tokenUpdater = fn
}

async function parseJsonSafe(res) {
  const text = await res.text()
  try { return text ? JSON.parse(text) : null } catch { return text }
}

async function fetchSafe(url, init) {
  try {
    return await fetch(url, init)
  } catch (err) {
    // Include URL so we can instantly see if frontend is calling the wrong host (e.g., localhost).
    throw new Error(`${prettyNetworkError(err)} (URL: ${url})`)
  }
}

async function refreshToken() {
  const res = await fetchSafe(apiUrl('/api/auth/refresh'), {
    method: 'POST',
    credentials: 'include'
  })
  const data = await parseJsonSafe(res)
  if (!res.ok) throw new Error((data && (data.detail || data.message)) || 'Refresh failed')

  if (data && data.access_token) {
    localStorage.setItem('dl_token', data.access_token)
    if (typeof _tokenUpdater === 'function') _tokenUpdater(data.access_token)
  }
  return data
}

export async function apiFetch(path, { method = 'GET', token, body, headers, _retried } = {}) {
  const res = await fetchSafe(apiUrl(path), {
    method,
    credentials: 'include',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {})
    },
    body: body ? JSON.stringify(body) : undefined
  })

  // If token expired, try refresh once and retry.
  if (res.status === 401 && token && !_retried) {
    try {
      const r = await refreshToken()
      const newToken = r?.access_token
      if (newToken) {
        return apiFetch(path, { method, token: newToken, body, headers, _retried: true })
      }
    } catch {
      // fallthrough to error
    }
  }

  const data = await parseJsonSafe(res)
  if (!res.ok) {
    const msg = (data && (data.detail || data.message)) || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return data
}

// For multipart uploads (FormData). No JSON encoding.
export async function apiUpload(path, { method = 'POST', token, formData, headers, _retried } = {}) {
  const res = await fetchSafe(apiUrl(path), {
    method,
    credentials: 'include',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {})
    },
    body: formData
  })

  if (res.status === 401 && token && !_retried) {
    try {
      const r = await refreshToken()
      const newToken = r?.access_token
      if (newToken) {
        return apiUpload(path, { method, token: newToken, formData, headers, _retried: true })
      }
    } catch {
      // fallthrough
    }
  }

  const data = await parseJsonSafe(res)
  if (!res.ok) {
    const msg = (data && (data.detail || data.message)) || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return data
}

export async function login(email, password) {
  const res = await fetchSafe(apiUrl('/api/auth/login'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: email, password })
  })
  const data = await parseJsonSafe(res)
  if (!res.ok) throw new Error((data && (data.detail || data.message)) || 'Login failed')

  if (data && data.access_token) {
    localStorage.setItem('dl_token', data.access_token)
    if (typeof _tokenUpdater === 'function') _tokenUpdater(data.access_token)
  }
  return data
}

export async function logout(token) {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST', token })
  } catch {
    // ignore
  }
  localStorage.removeItem('dl_token')
  if (typeof _tokenUpdater === 'function') _tokenUpdater('')
}

export async function changePassword(token, oldPassword, newPassword) {
  return apiFetch('/api/auth/change-password', {
    method: 'POST',
    token,
    body: { old_password: oldPassword, new_password: newPassword }
  })
}
