import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth.jsx'
import { apiFetch } from '../api'

export default function Admin() {
  const { me, token, loading } = useAuth()
  const nav = useNavigate()

  const [overview, setOverview] = useState(null)
  const [users, setUsers] = useState([])
  const [tutors, setTutors] = useState([])
  const [q, setQ] = useState('')
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (loading) return
    if (!me) nav('/login')
    else if (me.role !== 'admin') nav('/')
  }, [loading, me, nav])

  async function load() {
    if (!token || !me || me.role !== 'admin') return
    setErr('')
    try {
      const o = await apiFetch('/api/admin/overview', { token })
      setOverview(o)
      const u = await apiFetch(`/api/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`, { token })
      setUsers(Array.isArray(u) ? u : [])
      const t = await apiFetch('/api/admin/tutors', { token })
      setTutors(Array.isArray(t) ? t : [])
    } catch (e) {
      setErr(e.message || 'Ошибка загрузки')
    }
  }

  useEffect(() => { load() }, [token, me])

  async function updateUser(u, patch) {
    setSaving(true)
    setErr('')
    try {
      await apiFetch(`/api/admin/users/${u.id}`, { method: 'PATCH', token, body: patch })
      await load()
    } catch (e) {
      setErr(e.message || 'Не удалось обновить пользователя')
    } finally {
      setSaving(false)
    }
  }

  async function updateTutor(p, patch) {
    setSaving(true)
    setErr('')
    try {
      await apiFetch(`/api/admin/tutors/${p.id}`, { method: 'PATCH', token, body: patch })
      await load()
    } catch (e) {
      setErr(e.message || 'Не удалось обновить профиль')
    } finally {
      setSaving(false)
    }
  }

  if (!me || me.role !== 'admin') return null

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 22 }}>Админ-панель</div>
            <div className="small">Управление пользователями и публикацией репетиторов</div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <input className="input" style={{ minWidth: 240 }} placeholder="Поиск по email" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn" onClick={load} disabled={saving}>Обновить</button>
          </div>
        </div>
        {err && <div className="footerNote">{err}</div>}
      </div>

      {overview && (
        <div className="split">
          <div className="card">
            <div style={{ fontWeight: 900, fontSize: 18 }}>Сводка</div>
            <div className="grid" style={{ gap: 6, marginTop: 10 }}>
              <div className="small">Users: {overview.users}</div>
              <div className="small">Students: {overview.students}</div>
              <div className="small">Tutors: {overview.tutors}</div>
              <div className="small">Admins: {overview.admins}</div>
              <div className="small">Profiles: {overview.profiles}</div>
              <div className="small">Published profiles: {overview.published_profiles}</div>
              <div className="small">Bookings: {overview.bookings}</div>
            </div>
          </div>

          <div className="card">
            <div style={{ fontWeight: 900, fontSize: 18 }}>Публикация репетиторов</div>
            <div className="sub">Быстро включай/выключай профили в выдаче.</div>
            <div className="grid" style={{ gap: 10 }}>
              {tutors.slice(0, 12).map(p => (
                <div key={p.id} className="card" style={{ border: '1px solid var(--border)' }}>
                  <div style={{ fontWeight: 800 }}>{p.display_name} <span className="small">({p.email})</span></div>
                  <div className="small">Рейтинг: {p.rating_avg} ({p.rating_count}) • updated: {new Date(p.updated_at).toLocaleString()}</div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
                    <button
                      className={p.is_published ? 'btn' : 'btn btnPrimary'}
                      disabled={saving}
                      onClick={() => updateTutor(p, { is_published: !p.is_published })}
                    >
                      {p.is_published ? 'Снять с публикации' : 'Опубликовать'}
                    </button>
                  </div>
                </div>
              ))}
              {tutors.length === 0 && <div className="small">Нет профилей.</div>}
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div style={{ fontWeight: 900, fontSize: 18 }}>Пользователи</div>
        <div className="sub">Меняй роль, блокируй аккаунты, сбрасывай пароль.</div>
        <div className="grid" style={{ gap: 10 }}>
          {users.slice(0, 20).map(u => (
            <div key={u.id} className="card" style={{ border: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontWeight: 800 }}>#{u.id} • {u.email}</div>
                  <div className="small">role: {u.role} • active: {String(u.is_active)} • created: {new Date(u.created_at).toLocaleString()}</div>
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <select className="select" value={u.role} onChange={(e) => updateUser(u, { role: e.target.value })} disabled={saving}>
                    <option value="student">student</option>
                    <option value="tutor">tutor</option>
                    <option value="admin">admin</option>
                  </select>
                  <button className="btn" disabled={saving} onClick={() => updateUser(u, { is_active: !u.is_active })}>
                    {u.is_active ? 'Заблокировать' : 'Разблокировать'}
                  </button>
                  <button className="btn" disabled={saving} onClick={() => {
                    const pw = prompt('Новый пароль (8+):')
                    if (!pw) return
                    updateUser(u, { reset_password: pw })
                  }}>Сбросить пароль</button>
                </div>
              </div>
            </div>
          ))}
          {users.length === 0 && <div className="small">Нет пользователей.</div>}
        </div>
      </div>
    </div>
  )
}
