import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth.jsx'

export default function Register() {
  const { register } = useAuth()
  const nav = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('student')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setErr('')
    setLoading(true)
    try {
      await register({ email, password, role })
      nav('/dashboard')
    } catch (e2) {
      setErr(e2.message || 'Ошибка регистрации')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="card" style={{ maxWidth: 560, margin: '0 auto' }}>
      <div style={{ fontWeight: 900, fontSize: 22 }}>Регистрация</div>
      <div className="sub">Выбери роль: ученик или репетитор. Репетитору будет доступно создание слотов и публикация профиля.</div>

      <form onSubmit={submit}>
        <div className="label">Email</div>
        <input className="input" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" />

        <div className="label">Пароль (минимум 6 символов)</div>
        <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••" />

        <div className="label">Роль</div>
        <select className="select" value={role} onChange={e => setRole(e.target.value)}>
          <option value="student">Ученик / родитель</option>
          <option value="tutor">Репетитор</option>
        </select>

        {err && <div className="footerNote">{err}</div>}

        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button className="btn btnPrimary" type="submit" disabled={loading}>{loading ? 'Создаём…' : 'Создать аккаунт'}</button>
          <button className="btn" type="button" onClick={() => nav('/login')}>Уже есть аккаунт</button>
        </div>
      </form>
    </div>
  )
}
