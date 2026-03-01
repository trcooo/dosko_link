import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth.jsx'

export default function Login() {
  const { login } = useAuth()
  const nav = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setErr('')
    setLoading(true)
    try {
      await login(email, password)
      nav('/dashboard')
    } catch (e2) {
      setErr(e2.message || 'Ошибка входа')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="card" style={{ maxWidth: 520, margin: '0 auto' }}>
      <div style={{ fontWeight: 900, fontSize: 22 }}>Войти</div>
      <div className="sub">Используется email + пароль. Подтверждения почты в MVP нет.</div>

      <form onSubmit={submit}>
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
