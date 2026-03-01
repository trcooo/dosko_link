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

<div style={{ marginTop: 14 }}>
  <DemoAccounts
    onPick={(e, p) => {
      setEmail(e)
      setPassword(p)
      setErr('')
    }}
  />
</div>
    </div>
  )
}


function DemoAccounts({ onPick }) {
  const [open, setOpen] = useState(false)
  const password = 'DemoPass123!'
  const tutors = [
    { email: 'tutor1@demo.dl', label: 'Репетитор (математика)' },
    { email: 'tutor2@demo.dl', label: 'Репетитор (английский)' },
    { email: 'tutor3@demo.dl', label: 'Репетитор (физика)' },
  ]
  const students = [
    { email: 'student1@demo.dl', label: 'Ученик' },
    { email: 'student2@demo.dl', label: 'Ученик' },
  ]
  const admin = { email: 'admin@demo.dl', label: 'Админ (если включён seed)' }

  return (
    <div className="card" style={{ background: 'rgba(255,255,255,0.65)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <div>
          <div style={{ fontWeight: 900 }}>Демо-аккаунты</div>
          <div className="small">Работают, если в Railway включён <b>DL_SEED_DEMO=true</b>. Пароль: <b>{password}</b></div>
        </div>
        <button className="btn" type="button" onClick={() => setOpen(v => !v)}>{open ? 'Скрыть' : 'Показать'}</button>
      </div>

      {open && (
        <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
          <div className="small" style={{ opacity: 0.8 }}>Репетиторы</div>
          {tutors.map(t => (
            <div key={t.email} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div className="small"><b>{t.email}</b> — {t.label}</div>
              <button className="btn btnPrimary" type="button" onClick={() => onPick?.(t.email, password)}>Вставить</button>
            </div>
          ))}

          <div className="small" style={{ opacity: 0.8, marginTop: 8 }}>Ученики</div>
          {students.map(s => (
            <div key={s.email} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div className="small"><b>{s.email}</b> — {s.label}</div>
              <button className="btn btnPrimary" type="button" onClick={() => onPick?.(s.email, password)}>Вставить</button>
            </div>
          ))}

          <div className="small" style={{ opacity: 0.8, marginTop: 8 }}>Админ</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div className="small"><b>{admin.email}</b> — {admin.label}</div>
            <button className="btn btnPrimary" type="button" onClick={() => onPick?.(admin.email, password)}>Вставить</button>
          </div>
        </div>
      )}
    </div>
  )
}
