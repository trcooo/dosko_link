import React, { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth.jsx'
import { apiFetch } from '../api'

const TABS = [
  { id: 'overview', title: 'Сводка' },
  { id: 'users', title: 'Пользователи' },
  { id: 'tutors', title: 'Репетиторы' },
  { id: 'bookings', title: 'Занятия' },
  { id: 'reviews', title: 'Отзывы' },
  { id: 'reports', title: 'Заявки' },
]

export default function Admin() {
  const { me, token, loading } = useAuth()
  const nav = useNavigate()

  const [tab, setTab] = useState('overview')
  const [q, setQ] = useState('')
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  const [overview, setOverview] = useState(null)
  const [users, setUsers] = useState([])
  const [tutors, setTutors] = useState([])
  const [bookings, setBookings] = useState([])
  const [reviews, setReviews] = useState([])
  const [reports, setReports] = useState([])

  const [bookingStatus, setBookingStatus] = useState('')
  const [reviewStars, setReviewStars] = useState('')
  const [reportStatus, setReportStatus] = useState('open')

  useEffect(() => {
    if (loading) return
    if (!me) nav('/login')
    else if (me.role !== 'admin') nav('/')
  }, [loading, me, nav])

  const canLoad = useMemo(() => Boolean(token && me && me.role === 'admin'), [token, me])

  async function loadActive() {
    if (!canLoad) return
    setErr('')
    try {
      if (tab === 'overview') {
        const o = await apiFetch('/api/admin/overview', { token })
        setOverview(o)
        return
      }
      if (tab === 'users') {
        const u = await apiFetch(`/api/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`, { token })
        setUsers(Array.isArray(u) ? u : [])
        return
      }
      if (tab === 'tutors') {
        const t = await apiFetch('/api/admin/tutors', { token })
        setTutors(Array.isArray(t) ? t : [])
        return
      }
      if (tab === 'bookings') {
        const params = new URLSearchParams()
        if (q) params.set('q', q)
        if (bookingStatus) params.set('status', bookingStatus)
        params.set('limit', '200')
        const b = await apiFetch(`/api/admin/bookings?${params.toString()}`, { token })
        setBookings(Array.isArray(b) ? b : [])
        return
      }
      if (tab === 'reviews') {
        const params = new URLSearchParams()
        if (q) params.set('q', q)
        if (reviewStars) params.set('stars', reviewStars)
        params.set('limit', '200')
        const r = await apiFetch(`/api/admin/reviews?${params.toString()}`, { token })
        setReviews(Array.isArray(r) ? r : [])
        return
      }
      if (tab === 'reports') {
        const params = new URLSearchParams()
        if (reportStatus) params.set('status', reportStatus)
        params.set('limit', '200')
        const r = await apiFetch(`/api/admin/reports?${params.toString()}`, { token })
        setReports(Array.isArray(r) ? r : [])
        return
      }
    } catch (e) {
      setErr(e.message || 'Ошибка загрузки')
    }
  }

  useEffect(() => { loadActive() }, [tab, token, canLoad])

  
  async function adjustBalance(user, target) {
    const raw = prompt(`Сумма для ${target} (может быть отрицательной). Например: 500 или -200`)
    if (!raw) return
    const amount = Number(raw)
    if (!Number.isFinite(amount) || Math.abs(amount) < 1) return
    const note = prompt('Комментарий (опционально):') || ''
    setSaving(true)
    setErr('')
    try {
      await apiFetch(`/api/admin/users/${user.id}/balance-adjust`, {
        method: 'POST',
        token,
        body: { target, amount: Math.trunc(amount), note }
      })
      await loadAll()
    } catch (e) {
      setErr(e.message || 'Ошибка изменения баланса')
    } finally {
      setSaving(false)
    }
  }

async function updateUser(u, patch) {
    setSaving(true)
    setErr('')
    try {
      await apiFetch(`/api/admin/users/${u.id}`, { method: 'PATCH', token, body: patch })
      await loadActive()
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
      await loadActive()
    } catch (e) {
      setErr(e.message || 'Не удалось обновить профиль')
    } finally {
      setSaving(false)
    }
  }

  async function patchBooking(b, patch) {
    setSaving(true)
    setErr('')
    try {
      await apiFetch(`/api/admin/bookings/${b.id}`, { method: 'PATCH', token, body: patch })
      await loadActive()
    } catch (e) {
      setErr(e.message || 'Не удалось обновить занятие')
    } finally {
      setSaving(false)
    }
  }

  async function deleteReview(r) {
    if (!confirm('Удалить отзыв? Рейтинг репетитора будет пересчитан.')) return
    setSaving(true)
    setErr('')
    try {
      await apiFetch(`/api/admin/reviews/${r.id}`, { method: 'DELETE', token })
      await loadActive()
    } catch (e) {
      setErr(e.message || 'Не удалось удалить отзыв')
    } finally {
      setSaving(false)
    }
  }

  async function patchReport(r, patch) {
    setSaving(true)
    setErr('')
    try {
      await apiFetch(`/api/admin/reports/${r.id}`, { method: 'PATCH', token, body: patch })
      await loadActive()
    } catch (e) {
      setErr(e.message || 'Не удалось обновить заявку')
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
            <div className="small">Управление пользователями, репетиторами, занятиями и заявками.</div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <input
              className="input"
              style={{ minWidth: 260 }}
              placeholder="Поиск (email/текст)"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <button className="btn" onClick={loadActive} disabled={saving}>Обновить</button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {TABS.map(t => (
            <button
              key={t.id}
              className={tab === t.id ? 'btn btnPrimary' : 'btn'}
              onClick={() => setTab(t.id)}
              disabled={saving}
            >
              {t.title}
            </button>
          ))}
        </div>

        {err && <div className="footerNote" style={{ marginTop: 10 }}>{err}</div>}
      </div>

      {tab === 'overview' && overview && (
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
              <div className="small">Bookings confirmed: {overview.bookings_confirmed}</div>
              <div className="small">Bookings cancelled: {overview.bookings_cancelled}</div>
              <div className="small">Bookings done: {overview.bookings_done}</div>
              <div className="small">Reviews: {overview.reviews}</div>
              <div className="small">Open reports: {overview.open_reports}</div>
              <div className="small">Plans: {overview.plans}</div>
              <div className="small">Plan items: {overview.plan_items}</div>
              <div className="small">Homework: {overview.homework}</div>
              <div className="small">Topics: {overview.topics}</div>
              <div className="small">Student library: {overview.student_library_items}</div>
              <div className="small">Quizzes: {overview.quizzes}</div>
              <div className="small">Quiz questions: {overview.quiz_questions}</div>
              <div className="small">Quiz attempts: {overview.quiz_attempts}</div>
            </div>
          </div>

          <div className="card">
            <div style={{ fontWeight: 900, fontSize: 18 }}>Быстрые действия</div>
            <div className="sub">Открой заявки или занятия одним кликом.</div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn" onClick={() => setTab('reports')}>Заявки</button>
              <button className="btn" onClick={() => setTab('bookings')}>Занятия</button>
              <button className="btn" onClick={() => setTab('tutors')}>Репетиторы</button>
              <button className="btn" onClick={() => setTab('users')}>Пользователи</button>
            </div>
          </div>
        </div>
      )}

      {tab === 'users' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontWeight: 900, fontSize: 18 }}>Пользователи</div>
              <div className="sub">Меняй роль, блокируй аккаунты, сбрасывай пароль.</div>
            </div>
          </div>

          <div className="grid" style={{ gap: 10, marginTop: 10 }}>
            {users.slice(0, 200).map(u => (
              <div key={u.id} className="card" style={{ border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontWeight: 800 }}>#{u.id} • {u.email}</div>
                    <div className="small">role: {u.role} • active: {String(u.is_active)} • created: {new Date(u.created_at).toLocaleString()}</div>
                    <div className="small">баланс: {u.balance ?? 0} ₽ • доход: {u.earnings ?? 0} ₽</div>
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
                    <button className="btn" disabled={saving} onClick={() => adjustBalance(u, 'balance')}>Баланс ±</button>
                    <button className="btn" disabled={saving} onClick={() => adjustBalance(u, 'earnings')}>Доход ±</button>
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
      )}

      {tab === 'tutors' && (
        <div className="card">
          <div style={{ fontWeight: 900, fontSize: 18 }}>Репетиторы</div>
          <div className="sub">Управляй публикацией и именем в выдаче.</div>

          <div className="grid" style={{ gap: 10, marginTop: 10 }}>
            {tutors.slice(0, 200).map(p => (
              <div key={p.id} className="card" style={{ border: '1px solid var(--border)' }}>
                <div style={{ fontWeight: 800 }}>{p.display_name} <span className="small">({p.email})</span></div>
                <div className="small">Рейтинг: {p.rating_avg} ({p.rating_count}) • updated: {new Date(p.updated_at).toLocaleString()}</div>

                <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button
                    className={p.is_published ? 'btn' : 'btn btnPrimary'}
                    disabled={saving}
                    onClick={() => updateTutor(p, { is_published: !p.is_published })}
                  >
                    {p.is_published ? 'Снять с публикации' : 'Опубликовать'}
                  </button>

                  <button className="btn" disabled={saving} onClick={() => {
                    const dn = prompt('Новое отображаемое имя:', p.display_name)
                    if (dn === null) return
                    updateTutor(p, { display_name: dn })
                  }}>Переименовать</button>

                  <Link className="btn" to={`/tutor/${p.id}`}>Открыть карточку</Link>
                </div>
              </div>
            ))}
            {tutors.length === 0 && <div className="small">Нет профилей.</div>}
          </div>
        </div>
      )}

      {tab === 'bookings' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 900, fontSize: 18 }}>Занятия</div>
              <div className="sub">Поиск по email ученика/репетитора. Действия: отмена/завершение/перенос.</div>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <select className="select" value={bookingStatus} onChange={(e) => setBookingStatus(e.target.value)}>
                <option value="">все статусы</option>
                <option value="confirmed">confirmed</option>
                <option value="cancelled">cancelled</option>
                <option value="done">done</option>
              </select>
              <button className="btn" onClick={loadActive} disabled={saving}>Применить</button>
            </div>
          </div>

          <div className="grid" style={{ gap: 10, marginTop: 10 }}>
            {bookings.slice(0, 200).map(b => (
              <div key={b.id} className="card" style={{ border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontWeight: 800 }}>#{b.id} • {b.status}</div>
                    <div className="small">Tutor: {b.tutor_email} • Student: {b.student_email}</div>
                    <div className="small">Time: {b.starts_at ? new Date(b.starts_at).toLocaleString() : '—'} {b.ends_at ? `— ${new Date(b.ends_at).toLocaleString()}` : ''}</div>
                    <div className="small">slot_id: {b.slot_id}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                    <button className="btn" onClick={() => nav(`/room/booking-${b.id}`)}>Комната</button>
                    <button className="btn" disabled={saving} onClick={() => patchBooking(b, { status: 'cancelled' })}>Отменить</button>
                    <button className="btn btnPrimary" disabled={saving} onClick={() => patchBooking(b, { status: 'done' })}>Пометить done</button>
                    <button className="btn" disabled={saving} onClick={() => {
                      const sid = prompt('Новый slot_id (open, того же репетитора):')
                      if (!sid) return
                      patchBooking(b, { slot_id: Number(sid) })
                    }}>Перенести</button>
                  </div>
                </div>
              </div>
            ))}
            {bookings.length === 0 && <div className="small">Нет занятий.</div>}
          </div>
        </div>
      )}

      {tab === 'reviews' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 900, fontSize: 18 }}>Отзывы</div>
              <div className="sub">Поиск по email/тексту. Можно удалять токсичные/фейковые отзывы (рейтинг пересчитается).</div>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <select className="select" value={reviewStars} onChange={(e) => setReviewStars(e.target.value)}>
                <option value="">все оценки</option>
                {[5,4,3,2,1].map(s => <option key={s} value={String(s)}>{s}★</option>)}
              </select>
              <button className="btn" onClick={loadActive} disabled={saving}>Применить</button>
            </div>
          </div>

          <div className="grid" style={{ gap: 10, marginTop: 10 }}>
            {reviews.slice(0, 200).map(r => (
              <div key={r.id} className="card" style={{ border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontWeight: 800 }}>#{r.id} • {r.stars}★</div>
                    <div className="small">Tutor: {r.tutor_email} • Student: {r.student_email} • booking_id: {r.booking_id}</div>
                    <div className="small">{new Date(r.created_at).toLocaleString()}</div>
                    <div style={{ marginTop: 6 }}>{r.text || <span className="small">(без текста)</span>}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                    <button className="btn" onClick={() => nav(`/room/booking-${r.booking_id}`)}>Комната</button>
                    <button className="btn" disabled={saving} onClick={() => deleteReview(r)}>Удалить</button>
                  </div>
                </div>
              </div>
            ))}
            {reviews.length === 0 && <div className="small">Нет отзывов.</div>}
          </div>
        </div>
      )}

      {tab === 'reports' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 900, fontSize: 18 }}>Заявки / проблемы</div>
              <div className="sub">Заявки создаются кнопкой “Проблема” в комнате урока.</div>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <select className="select" value={reportStatus} onChange={(e) => setReportStatus(e.target.value)}>
                <option value="open">open</option>
                <option value="resolved">resolved</option>
                <option value="">all</option>
              </select>
              <button className="btn" onClick={loadActive} disabled={saving}>Применить</button>
            </div>
          </div>

          <div className="grid" style={{ gap: 10, marginTop: 10 }}>
            {reports.slice(0, 200).map(r => (
              <div key={r.id} className="card" style={{ border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontWeight: 800 }}>#{r.id} • {r.status} • {r.category}</div>
                    <div className="small">Reporter: {r.reporter_email}{r.reported_email ? ` • Reported: ${r.reported_email}` : ''}</div>
                    <div className="small">{new Date(r.created_at).toLocaleString()}</div>
                    {r.booking_id && <div className="small">booking_id: {r.booking_id}</div>}
                    <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{r.message}</div>
                    {r.resolved_at && <div className="small" style={{ marginTop: 6 }}>Resolved: {new Date(r.resolved_at).toLocaleString()} • by {r.resolved_by_email || r.resolved_by_user_id}</div>}
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                    {r.booking_id && <button className="btn" onClick={() => nav(`/room/booking-${r.booking_id}`)}>Комната</button>}
                    {r.status !== 'resolved' ? (
                      <button className="btn btnPrimary" disabled={saving} onClick={() => patchReport(r, { status: 'resolved' })}>Закрыть</button>
                    ) : (
                      <button className="btn" disabled={saving} onClick={() => patchReport(r, { status: 'open' })}>Открыть снова</button>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {reports.length === 0 && <div className="small">Нет заявок.</div>}
          </div>
        </div>
      )}

      <div className="footerNote">
        Совет: для single-service MVP в Railway не задавай <b>VITE_API_BASE</b>. В проде API и WS работают на этом же домене автоматически; <b>VITE_API_BASE</b> используется только для локальной разработки.
      </div>
    </div>
  )
}
