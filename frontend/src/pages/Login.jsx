import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth.jsx'

export default function Login() {
  const { login } = useAuth()
  const nav = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  const [health, setHealth] = useState({ status: 'checking', detail: '' })
  const healthUrl = useMemo(() => `${window.location.origin}/health`, [])

  useEffect(() => {
    let cancelled = false
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 5000)
    fetch('/health', { signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const j = await r.json().catch(() => ({}))
        if (cancelled) return
        setHealth({ status: 'ok', detail: j?.ts ? `ts: ${j.ts}` : '' })
      })
      .catch((e) => {
        if (cancelled) return
        const msg = (e && e.name === 'AbortError') ? 'timeout' : (e?.message || 'network error')
        setHealth({ status: 'fail', detail: msg })
      })
      .finally(() => clearTimeout(t))

    return () => {
      cancelled = true
      clearTimeout(t)
      ctrl.abort()
    }
  }, [])

  async function submit(e) {
    e.preventDefault()
    setErr('')
    setLoading(true)
    try {
      const data = await login(email, password)
      if (!data?.access_token) throw new Error('Не удалось войти: токен не получен')
      if (data?.me?.role === 'admin') nav('/admin')
      else nav('/dashboard')
    } catch (e2) {
      setErr(e2.message || 'Ошибка входа')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="card" style={{ maxWidth: 560, margin: '0 auto' }}>
      <div style={{ fontWeight: 900, fontSize: 22 }}>Войти</div>
      <div className="sub">Используется email + пароль. Подтверждения почты в MVP нет.</div>

      <div
        style={{
          marginTop: 10,
          padding: '10px 12px',
          borderRadius: 12,
          border: '1px solid rgba(0,0,0,0.08)',
          background: 'rgba(255,255,255,0.7)'
        }}
      >
        <div style={{ fontWeight: 800, marginBottom: 6 }}>Проверка сервера</div>
        {health.status === 'checking' && (
          <div className="sub">Проверяем доступность API: <b>{healthUrl}</b></div>
        )}
        {health.status === 'ok' && (
          <div className="sub">✅ Сервер доступен. {health.detail}</div>
        )}
        {health.status === 'fail' && (
          <div className="sub">
            ⚠️ API недоступно на текущем домене (<b>{healthUrl}</b>). Если домен <b>.com</b> ещё не привязан через DNS, откройте приложение по домену Railway вида <b>https://&lt;service&gt;.up.railway.app</b> (Railway → Networking → Domains).
            <div style={{ opacity: 0.8, marginTop: 6 }}>Детали: {health.detail}</div>
          </div>
        )}
      </div>

      <form onSubmit={submit} style={{ marginTop: 12 }}>
        <div className="label">Email</div>
        <input className="input" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" />

        <div className="label">Пароль</div>
        <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••" />

        {err && <div className="footerNote">{err}</div>}

        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button className="btn btnPrimary" type="submit" disabled={loading}>{loading ? 'Входим…' : 'Войти'}</button>
          <button className="btn" type="button" onClick={() => nav('/register')}>Регистрация</button>
        </div>
      </form>
    </div>
  )
}
