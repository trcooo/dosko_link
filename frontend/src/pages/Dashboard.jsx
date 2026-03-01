import React, { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth.jsx'
import { apiFetch, changePassword } from '../api'
import ReviewModal from '../components/ReviewModal'
import RescheduleModal from '../components/RescheduleModal'

function toLocalInputValue(d) {
  const pad = (n) => String(n).padStart(2, '0')
  const dt = new Date(d)
  return `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`
}

export default function Dashboard() {
  const { me, token, loading: authLoading, logout, balanceInfo, payBooking, refreshBalance } = useAuth()
  const nav = useNavigate()

  const [profile, setProfile] = useState(null)
  const [bookings, setBookings] = useState([])
  const [slots, setSlots] = useState([])
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  const [settings, setSettings] = useState(null)

  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [newPw2, setNewPw2] = useState('')
  const [pwMsg, setPwMsg] = useState('')

  const [slotStart, setSlotStart] = useState(() => toLocalInputValue(Date.now() + 3600_000))
  const [slotEnd, setSlotEnd] = useState(() => toLocalInputValue(Date.now() + 5400_000))

  const [reviewBookingId, setReviewBookingId] = useState(null)
  const [rescheduleBooking, setRescheduleBooking] = useState(null)

  const subjectOptions = useMemo(() => [
    'математика', 'английский', 'физика', 'химия', 'русский', 'программирование'
  ], [])

  useEffect(() => {
    if (authLoading) return
    if (!me) nav('/login')
  }, [authLoading, me, nav])


  async function payBookingNow(bookingId) {
    setErr('')
    setSaving(true)
    try {
      await payBooking(bookingId)
      await refreshBalance?.()
      await load()
    } catch (e) {
      setErr(e.message || 'Ошибка оплаты')
    } finally {
      setSaving(false)
    }
  }

  async function load() {
    if (!token || !me) return
    setErr('')
    try {
      const b = await apiFetch('/api/bookings', { token })
      setBookings(Array.isArray(b) ? b : [])

      const st = await apiFetch('/api/me/settings', { token })
      setSettings(st || null)

      if (me.role === 'tutor') {
        const p = await apiFetch('/api/tutors/me', { token })
        setProfile(p)

        const s = await apiFetch(`/api/slots/me`, { token })
        setSlots(Array.isArray(s) ? s : [])
      } else {
        const s = await apiFetch('/api/slots/available', { token })
        setSlots(Array.isArray(s) ? s : [])
      }
    } catch (e) {
      setErr(e.message || 'Ошибка загрузки')
    }
  }

  useEffect(() => { load() }, [token, me])

  async function saveProfile() {
    setSaving(true)
    setErr('')
    try {
      const payload = {
        display_name: profile.display_name,
        subjects: profile.subjects,
        levels: profile.levels,
        goals: profile.goals,
        price_per_hour: Number(profile.price_per_hour || 0),
        language: profile.language,
        bio: profile.bio,
        video_url: profile.video_url
      }
      const updated = await apiFetch('/api/tutors/me', { method: 'PUT', token, body: payload })
      setProfile(updated)
    } catch (e) {
      setErr(e.message || 'Ошибка сохранения')
    } finally {
      setSaving(false)
    }
  }

  async function publishProfile() {
    setSaving(true)
    setErr('')
    try {
      const updated = await apiFetch('/api/tutors/me/publish', { method: 'POST', token })
      setProfile(updated)
    } catch (e) {
      setErr(e.message || 'Ошибка публикации')
    } finally {
      setSaving(false)
    }
  }

  async function createSlot() {
    setSaving(true)
    setErr('')
    try {
      const starts_at = new Date(slotStart)
      const ends_at = new Date(slotEnd)
      await apiFetch('/api/slots', {
        method: 'POST',
        token,
        body: { starts_at: starts_at.toISOString(), ends_at: ends_at.toISOString() }
      })
      await load()
    } catch (e) {
      setErr(e.message || 'Ошибка создания слота')
    } finally {
      setSaving(false)
    }
  }

  async function completeBooking(id) {
    setSaving(true)
    setErr('')
    try {
      await apiFetch(`/api/bookings/${id}/complete`, { method: 'POST', token })
      await load()
    } catch (e) {
      setErr(e.message || 'Не удалось завершить')
    } finally {
      setSaving(false)
    }
  }

  async function cancelBooking(id) {
    if (!confirm('Отменить занятие?')) return
    setSaving(true)
    setErr('')
    try {
      await apiFetch(`/api/bookings/${id}/cancel`, { method: 'POST', token })
      await load()
    } catch (e) {
      setErr(e.message || 'Не удалось отменить')
    } finally {
      setSaving(false)
    }
  }

  async function rescheduleBookingTo(id, newSlotId) {
    setSaving(true)
    setErr('')
    try {
      await apiFetch(`/api/bookings/${id}/reschedule`, { method: 'POST', token, body: { new_slot_id: Number(newSlotId) } })
      await load()
    } catch (e) {
      setErr(e.message || 'Не удалось перенести')
    } finally {
      setSaving(false)
    }
  }

  async function saveSettings() {
    if (!settings) return
    setSaving(true)
    setErr('')
    try {
      const updated = await apiFetch('/api/me/settings', {
        method: 'PUT',
        token,
        body: {
          telegram_chat_id: settings.telegram_chat_id || null,
          notify_email: Boolean(settings.notify_email),
          notify_telegram: Boolean(settings.notify_telegram)
        }
      })
      setSettings(updated)
    } catch (e) {
      setErr(e.message || 'Не удалось сохранить настройки')
    } finally {
      setSaving(false)
    }
  }

  async function doChangePassword() {
    setErr('')
    setPwMsg('')
    if (!oldPw || !newPw) { setErr('Заполни текущий и новый пароль'); return }
    if (newPw !== newPw2) { setErr('Новые пароли не совпадают'); return }
    setSaving(true)
    try {
      await changePassword(token, oldPw, newPw)
      setPwMsg('Пароль изменён. Войди заново.')
      setOldPw(''); setNewPw(''); setNewPw2('')
      await logout()
      nav('/login')
    } catch (e) {
      setErr(e.message || 'Не удалось сменить пароль')
    } finally {
      setSaving(false)
    }
  }

  if (!me) return null

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 22 }}>Кабинет</div>
            <div className="small">{me.email} • роль: {me.role}</div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn" onClick={load}>Обновить</button>
            <Link className="btn btnPrimary" to="/">Перейти к поиску</Link>
          </div>
        </div>
        {err && <div className="footerNote">{err}</div>}
      </div>

      {me.role === 'tutor' && profile && (
        <div className="split">
          <div className="card">
            <div style={{ fontWeight: 900, fontSize: 18 }}>Профиль репетитора</div>
            <div className="sub">Заполни и опубликуй профиль — тогда он появится в поиске.</div>

            <div className="label">Имя</div>
            <input className="input" value={profile.display_name || ''} onChange={e => setProfile({ ...profile, display_name: e.target.value })} />

            <div className="row">
              <div style={{ flex: 1 }}>
                <div className="label">Предметы (выбери несколько)</div>
                <select className="select" multiple value={profile.subjects || []} onChange={e => {
                  const vals = Array.from(e.target.selectedOptions).map(o => o.value)
                  setProfile({ ...profile, subjects: vals })
                }}>
                  {subjectOptions.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <div className="small" style={{ marginTop: 6 }}>Ctrl/⌘ + клик — мультивыбор</div>
              </div>
              <div style={{ width: 220 }}>
                <div className="label">Цена / час</div>
                <input className="input" type="number" value={profile.price_per_hour || 0} onChange={e => setProfile({ ...profile, price_per_hour: e.target.value })} />

                <div className="label">Язык</div>
                <select className="select" value={profile.language || 'ru'} onChange={e => setProfile({ ...profile, language: e.target.value })}>
                  <option value="ru">ru</option>
                  <option value="en">en</option>
                </select>
              </div>
            </div>

            <div className="label">О себе</div>
            <textarea className="textarea" value={profile.bio || ''} onChange={e => setProfile({ ...profile, bio: e.target.value })} placeholder="Коротко: опыт, результаты, методика…" />

            <div className="label">Видео-визитка (URL)</div>
            <input className="input" value={profile.video_url || ''} onChange={e => setProfile({ ...profile, video_url: e.target.value })} placeholder="https://…" />

            <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
              <button className="btn btnPrimary" onClick={saveProfile} disabled={saving}>{saving ? 'Сохраняем…' : 'Сохранить'}</button>
              <button className="btn" onClick={publishProfile} disabled={saving}>{profile.is_published ? 'Опубликовано' : 'Опубликовать'}</button>
              <div className="small" style={{ alignSelf: 'center' }}>Рейтинг: ★ {Number(profile.rating_avg || 0).toFixed(1)} ({profile.rating_count || 0})</div>
            </div>
          </div>

          <div className="card">
            <div style={{ fontWeight: 900, fontSize: 18 }}>Расписание (слоты)</div>
            <div className="sub">Создай слоты — ученики смогут бронировать.</div>

            <div className="label">Начало</div>
            <input className="input" type="datetime-local" value={slotStart} onChange={e => setSlotStart(e.target.value)} />

            <div className="label">Конец</div>
            <input className="input" type="datetime-local" value={slotEnd} onChange={e => setSlotEnd(e.target.value)} />

            <button className="btn btnPrimary" style={{ marginTop: 12 }} onClick={createSlot} disabled={saving}>{saving ? 'Создаём…' : 'Создать слот'}</button>

            <div className="label">Мои слоты</div>
            <div className="grid" style={{ gap: 10 }}>
              {slots.length === 0 ? (
                <div className="small">Пока нет открытых слотов.</div>
              ) : (
                slots.slice(0, 10).map(s => (
                  <div key={s.id} className="card">
                    <div style={{ fontWeight: 800 }}>#{s.id} • {new Date(s.starts_at).toLocaleString()}</div>
                    <div className="small">до {new Date(s.ends_at).toLocaleString()} • статус: {s.status}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {settings && (
        <div className="card">
          <div style={{ fontWeight: 900, fontSize: 18 }}>Уведомления</div>
          <div className="sub">В MVP уведомления приходят по email (если настроен SMTP) и/или в Telegram (если привязать chat_id).</div>

          <div className="row" style={{ alignItems: 'center' }}>
            <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={Boolean(settings.notify_email)} onChange={(e) => setSettings({ ...settings, notify_email: e.target.checked })} />
              Email
            </label>
            <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={Boolean(settings.notify_telegram)} onChange={(e) => setSettings({ ...settings, notify_telegram: e.target.checked })} />
              Telegram
            </label>
          </div>

          <div className="label">Telegram chat_id (если включён Telegram)</div>
          <input className="input" value={settings.telegram_chat_id || ''} onChange={(e) => setSettings({ ...settings, telegram_chat_id: e.target.value })} placeholder="например, 123456789" />

          <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
            <button className="btn btnPrimary" onClick={saveSettings} disabled={saving}>{saving ? 'Сохраняем…' : 'Сохранить настройки'}</button>
          </div>
          <div className="footerNote">Для напоминаний за ~10 минут можно настроить Railway Cron на вызов /api/cron/reminders?key=DL_CRON_KEY.</div>
        </div>
      )}


      <div className="card">
        <div style={{ fontWeight: 900, fontSize: 18 }}>Безопасность</div>
        <div className="sub">Смена пароля завершит все активные сессии.</div>
        {pwMsg && <div className="footerNote">{pwMsg}</div>}
        <div className="label">Текущий пароль</div>
        <input className="input" type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
        <div className="label">Новый пароль (8+ символов, буквы и цифры)</div>
        <input className="input" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
        <div className="label">Повтори новый пароль</div>
        <input className="input" type="password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} />
        <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
          <button className="btn btnPrimary" onClick={doChangePassword} disabled={saving}>{saving ? 'Сохраняем…' : 'Сменить пароль'}</button>
        </div>
      </div>

      {me.role !== 'tutor' && (
        <div className="card">
          <div style={{ fontWeight: 900, fontSize: 18 }}>Доступные слоты</div>
          <div className="sub">Выбери репетитора на странице профиля и забронируй слот. После брони появится комната урока.</div>
          <div className="grid" style={{ gap: 10 }}>
            {slots.length === 0 ? (
              <div className="small">Пока нет доступных слотов.</div>
            ) : (
              slots.slice(0, 12).map(s => (
                <div key={s.id} className="card">
                  <div style={{ fontWeight: 800 }}>Слот #{s.id}</div>
                  <div className="small">Начало: {new Date(s.starts_at).toLocaleString()}</div>
                  <div className="small">Конец: {new Date(s.ends_at).toLocaleString()}</div>
                  <div className="small">Репетитор user_id: {s.tutor_user_id}</div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <div className="card">
        <div style={{ fontWeight: 900, fontSize: 18 }}>Мои занятия (бронирования)</div>
        <div className="sub">Открой комнату — внутри созвон + доска + чат. Можно завершить или отменить занятие. Ученик оставляет отзыв после завершения.</div>

        <div className="grid" style={{ gap: 10 }}>
          {bookings.length === 0 ? (
            <div className="small">Пока нет бронирований.</div>
          ) : (
            bookings.map(b => {
              const isDone = ['done', 'completed'].includes(String(b.status))
              const isCancelled = String(b.status) === 'cancelled'
              const starts = b.slot_starts_at ? new Date(b.slot_starts_at).toLocaleString() : null
              const ends = b.slot_ends_at ? new Date(b.slot_ends_at).toLocaleString() : null

              return (
                <div key={b.id} className="card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>Бронь #{b.id} • {b.status}</div>
                      <div className="small">Слот #{b.slot_id} • комната: {b.room_id}</div>
                      {starts && <div className="small">Время: {starts}{ends ? ` — ${ends}` : ''}</div>}
                      <div className="small">Создано: {new Date(b.created_at).toLocaleString()}</div>
                      <div className="small">Стоимость: {b.price || 0} ₽ • оплата: {b.payment_status || 'unpaid'}</div>
                    </div>

                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                      <Link className="btn btnPrimary" to={`/room/${b.room_id}`}>Открыть комнату</Link>

                      {me.role === 'student' && (b.payment_status !== 'paid') && !isCancelled && (
                        <button className="btn btnPrimary" onClick={() => payBookingNow(b.id)} disabled={saving}>Оплатить</button>
                      )}

                      {!isCancelled && !isDone && (
                        <>
                          <button className="btn" onClick={() => cancelBooking(b.id)} disabled={saving}>Отменить</button>
                          <button className="btn" onClick={() => setRescheduleBooking(b)} disabled={saving}>Перенести</button>
                          <button className="btn" onClick={() => completeBooking(b.id)} disabled={saving}>Завершить</button>
                        </>
                      )}

                      {!isCancelled && isDone && me.role !== 'tutor' && (
                        <button className="btn" onClick={() => setReviewBookingId(b.id)}>Оставить отзыв</button>
                      )}

                      {isCancelled && <div className="small">Отменено</div>}
                      {isDone && <div className="small">Завершено</div>}
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

      <ReviewModal
        open={Boolean(reviewBookingId)}
        bookingId={reviewBookingId}
        token={token}
        onClose={() => setReviewBookingId(null)}
        onSubmitted={() => load()}
      />

      <RescheduleModal
        open={Boolean(rescheduleBooking)}
        booking={rescheduleBooking}
        token={token}
        onClose={() => setRescheduleBooking(null)}
        onSubmitted={() => load()}
      />
    </div>
  )
}
