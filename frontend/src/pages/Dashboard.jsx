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

function linesToList(v) {
  return String(v || '')
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean)
}

function listHas(arr) {
  return Array.isArray(arr) && arr.some(v => String(v || '').trim())
}

function buildTutorChecklist(profile, backgroundsText, certLinksText) {
  const certs = linesToList(certLinksText)
  const items = [
    { key: 'name', label: 'Имя', ok: Boolean(String(profile?.display_name || '').trim()) },
    { key: 'subjects', label: 'Предметы', ok: listHas(profile?.subjects) },
    { key: 'grades', label: 'Классы', ok: listHas(profile?.grades) },
    { key: 'price', label: 'Цена / час', ok: Number(profile?.price_per_hour || 0) > 0 },
    { key: 'education', label: 'Образование', ok: Boolean(String(profile?.education || '').trim()) },
    { key: 'bio', label: 'О себе', ok: Boolean(String(profile?.bio || '').trim()) },
    { key: 'exp', label: 'Опыт / бекграунд', ok: linesToList(backgroundsText).length > 0 },
    { key: 'docs', label: 'Ссылки на дипломы/сертификаты', ok: certs.length > 0 },
  ]
  const done = items.filter(i => i.ok).length
  return { items, done, total: items.length, percent: Math.round((done / Math.max(1, items.length)) * 100) }
}

function roleTitle(role) {
  if (role === 'tutor') return 'Кабинет репетитора'
  if (role === 'student') return 'Кабинет ученика'
  if (role === 'admin') return 'Кабинет администратора'
  return 'Кабинет'
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

  const [catalog, setCatalog] = useState({ subjects: [], goals: [], levels: [], grades: [], languages: ['ru', 'en'] })
  const [backgroundsText, setBackgroundsText] = useState('')
  const [certLinksText, setCertLinksText] = useState('')

  const subjectOptions = useMemo(() => (catalog.subjects?.length ? catalog.subjects : [
    'Математика', 'Английский', 'Физика', 'Химия', 'Русский язык', 'Программирование'
  ]), [catalog])
  const goalOptions = useMemo(() => catalog.goals || [], [catalog])
  const levelOptions = useMemo(() => catalog.levels || [], [catalog])
  const gradeOptions = useMemo(() => catalog.grades || [], [catalog])

  const tutorChecklist = useMemo(
    () => buildTutorChecklist(profile, backgroundsText, certLinksText),
    [profile, backgroundsText, certLinksText]
  )
  const tutorMissingLabels = useMemo(
    () => tutorChecklist.items.filter(i => !i.ok).map(i => i.label),
    [tutorChecklist]
  )
  const canSubmitTutorProfile = me?.role === 'tutor' ? tutorMissingLabels.length === 0 : true

  useEffect(() => {
    if (authLoading) return
    if (!me) { nav('/login'); return }
    if (me.role === 'admin') { nav('/admin'); return }
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

      try {
        const c = await apiFetch('/api/catalog')
        setCatalog(c || { subjects: [], goals: [], levels: [], grades: [], languages: ['ru', 'en'] })
      } catch {}

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

  useEffect(() => {
    if (!profile) return
    setBackgroundsText(listToLines(profile.backgrounds || []))
    setCertLinksText(listToLines(profile.certificate_links || []))
  }, [profile?.id, JSON.stringify(profile?.backgrounds || []), JSON.stringify(profile?.certificate_links || [])])

  async function saveProfile() {
    setSaving(true)
    setErr('')
    try {
      const payload = {
        display_name: profile.display_name,
        photo_url: profile.photo_url || '',
        age: profile.age ? Number(profile.age) : null,
        education: profile.education || '',
        backgrounds: linesToList(backgroundsText),
        grades: profile.grades || [],
        subjects: profile.subjects || [],
        levels: profile.levels || [],
        goals: profile.goals || [],
        price_per_hour: Number(profile.price_per_hour || 0),
        language: profile.language || 'ru',
        bio: profile.bio || '',
        video_url: profile.video_url || '',
        certificate_links: linesToList(certLinksText),
        payment_method: profile.payment_method || ''
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

  async function submitForModeration() {
    setSaving(true)
    setErr('')
    try {
      const updated = await apiFetch('/api/tutors/me/submit', { method: 'POST', token })
      setProfile(updated)
    } catch (e) {
      setErr(e.message || 'Ошибка отправки на модерацию')
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
      <div className="card roleHeaderCard">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 22 }}>{roleTitle(me.role)}</div>
            <div className="small">{me.email} • роль: {me.role}</div>
            {me.role === 'tutor' && <div className="sub" style={{ marginTop: 6 }}>Заполни профиль → отправь на модерацию → после одобрения профиль появится в выдаче.</div>}
            {me.role === 'student' && <div className="sub" style={{ marginTop: 6 }}>Управляй бронями, комнатами уроков, оплатой и отзывами в одном месте.</div>}
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn" onClick={load}>Обновить</button>
            {me.role === 'tutor' ? (
              <Link className="btn btnPrimary" to="/">Открыть маркетплейс</Link>
            ) : (
              <Link className="btn btnPrimary" to="/">Перейти к поиску</Link>
            )}
          </div>
        </div>

        {me.role === 'tutor' && profile && (
          <div className="roleHeroGrid" style={{ marginTop: 12 }}>
            <div className="roleStat">
              <div className="small">Готовность профиля</div>
              <div style={{ fontWeight: 900, fontSize: 22 }}>{tutorChecklist.percent}%</div>
              <div className="progressBar"><span style={{ width: `${tutorChecklist.percent}%` }} /></div>
            </div>
            <div className="roleStat">
              <div className="small">Модерация</div>
              <div style={{ fontWeight: 900 }}>{profile.documents_status || 'draft'}</div>
              <div className="small">{profile.documents_status === 'approved' ? 'Документы проверены' : 'Проверь чеклист ниже и отправь профиль'}</div>
            </div>
            <div className="roleStat">
              <div className="small">Публикация</div>
              <div style={{ fontWeight: 900 }}>{profile.is_published ? 'Включена' : 'Не опубликован'}</div>
              <div className="small">В списке виден только после модерации</div>
            </div>
          </div>
        )}

        {me.role === 'student' && (
          <div className="roleHeroGrid" style={{ marginTop: 12 }}>
            <div className="roleStat"><div className="small">Занятий</div><div style={{ fontWeight: 900, fontSize: 22 }}>{bookings.length}</div></div>
            <div className="roleStat"><div className="small">Баланс</div><div style={{ fontWeight: 900, fontSize: 22 }}>{Number(balanceInfo?.balance || 0)} ₽</div></div>
            <div className="roleStat"><div className="small">Действие</div><div style={{ fontWeight: 900 }}>Выбери репетитора</div><div className="small">Фильтры и бронирование — на главной</div></div>
          </div>
        )}

        {err && <div className="footerNote">{err}</div>}
      </div>

      {me.role === 'tutor' && profile && (
        <div className="split">
          <div className="card">
            <div style={{ fontWeight: 900, fontSize: 18 }}>Профиль репетитора</div>
            <div className="sub">Фото, предметы, классы, сертификаты (ссылки на Google Drive/облако) и реквизиты для оплаты напрямую.</div>

            <div className="onboardingBox">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ fontWeight: 800 }}>Создание профиля репетитора</div>
                <div className="small">{tutorChecklist.done}/{tutorChecklist.total} обязательных пунктов</div>
              </div>
              <div className="progressBar" style={{ marginTop: 8 }}><span style={{ width: `${tutorChecklist.percent}%` }} /></div>
              <div className="checkGrid" style={{ marginTop: 10 }}>
                {tutorChecklist.items.map(it => (
                  <div key={it.key} className={`checkItem ${it.ok ? 'ok' : ''}`}>
                    <span>{it.ok ? '✓' : '•'}</span>
                    <span>{it.label}</span>
                  </div>
                ))}
              </div>
              {tutorMissingLabels.length > 0 && (
                <div className="small" style={{ marginTop: 8 }}>Для отправки на модерацию заполни: {tutorMissingLabels.join(', ')}.</div>
              )}
            </div>

            <div className="tutorProfilePreviewCard">
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                {profile.photo_url ? (
                  <img className="profilePhoto" src={profile.photo_url} alt="Фото репетитора" />
                ) : (
                  <div className="profilePhoto profilePhotoFallback">{(profile.display_name || 'R').slice(0,1).toUpperCase()}</div>
                )}
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontWeight: 900 }}>{profile.display_name || 'Имя репетитора'}</div>
                  <div className="small">{listHas(profile.subjects) ? profile.subjects.join(', ') : 'Укажи предметы'} • {Number(profile.price_per_hour || 0) > 0 ? `${profile.price_per_hour} ₽/ч` : 'Цена не указана'}</div>
                  <div className="small">Классы: {listHas(profile.grades) ? profile.grades.join(', ') : 'не указаны'} • Язык: {profile.language || 'ru'}</div>
                </div>
              </div>
            </div>

            <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <div className="label">Имя</div>
                <input className="input" value={profile.display_name || ''} onChange={e => setProfile({ ...profile, display_name: e.target.value })} />
              </div>
              <div style={{ width: 150 }}>
                <div className="label">Возраст</div>
                <input className="input" type="number" min="14" max="99" value={profile.age || ''} onChange={e => setProfile({ ...profile, age: e.target.value })} />
              </div>
            </div>

            <div className="label">Фото (URL)</div>
            <input className="input" value={profile.photo_url || ''} onChange={e => setProfile({ ...profile, photo_url: e.target.value })} placeholder="https://..." />

            <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <div className="label">Предметы (multi-select)</div>
                <select className="select" multiple value={profile.subjects || []} onChange={e => setProfile({ ...profile, subjects: Array.from(e.target.selectedOptions).map(o => o.value) })}>
                  {subjectOptions.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 240 }}>
                <div className="label">Цели (multi-select)</div>
                <select className="select" multiple value={profile.goals || []} onChange={e => setProfile({ ...profile, goals: Array.from(e.target.selectedOptions).map(o => o.value) })}>
                  {goalOptions.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>

            <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <div className="label">Уровни (multi-select)</div>
                <select className="select" multiple value={profile.levels || []} onChange={e => setProfile({ ...profile, levels: Array.from(e.target.selectedOptions).map(o => o.value) })}>
                  {levelOptions.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 240 }}>
                <div className="label">С какими классами работает (multi-select)</div>
                <select className="select" multiple value={profile.grades || []} onChange={e => setProfile({ ...profile, grades: Array.from(e.target.selectedOptions).map(o => o.value) })}>
                  {gradeOptions.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
            <div className="small" style={{ marginTop: 6 }}>Ctrl/⌘ + клик — мультивыбор.</div>

            <div className="row">
              <div style={{ flex: 1 }}>
                <div className="label">Цена / час</div>
                <input className="input" type="number" value={profile.price_per_hour || 0} onChange={e => setProfile({ ...profile, price_per_hour: e.target.value })} />
              </div>
              <div style={{ width: 180 }}>
                <div className="label">Язык</div>
                <select className="select" value={profile.language || 'ru'} onChange={e => setProfile({ ...profile, language: e.target.value })}>
                  {(catalog.languages?.length ? catalog.languages : ['ru', 'en']).map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
            </div>

            <div className="label">Образование</div>
            <textarea className="textarea" value={profile.education || ''} onChange={e => setProfile({ ...profile, education: e.target.value })} placeholder="ВУЗ, факультет, курсы, сертификаты" />

            <div className="label">О себе</div>
            <textarea className="textarea" value={profile.bio || ''} onChange={e => setProfile({ ...profile, bio: e.target.value })} placeholder="Опыт, подход, результаты учеников…" />

            <div className="label">Бекграунды / опыт (каждый пункт с новой строки)</div>
            <textarea className="textarea" value={backgroundsText} onChange={e => setBackgroundsText(e.target.value)} placeholder={'5 лет подготовки к ЕГЭ\n100+ учеников\nПреподавал в ...'} />

            <div className="label">Видео-визитка (URL)</div>
            <input className="input" value={profile.video_url || ''} onChange={e => setProfile({ ...profile, video_url: e.target.value })} placeholder="https://…" />

            <div className="label">Ссылки на сертификаты/дипломы (Google Drive/облако, по одной на строку)</div>
            <textarea className="textarea" value={certLinksText} onChange={e => setCertLinksText(e.target.value)} placeholder={'https://drive.google.com/...\nhttps://dropbox.com/...'} />

            <div className="label">Способ оплаты (показывается ученику только после брони — в комнате занятия)</div>
            <textarea className="textarea" value={profile.payment_method || ''} onChange={e => setProfile({ ...profile, payment_method: e.target.value })} placeholder="Оплата переводом на карту ... / ЕРИП / СБП..." />

            <div className="card" style={{ marginTop: 12 }}>
              <div className="small">Статус модерации документов: <b>{profile.documents_status || 'draft'}</b></div>
              {profile.documents_note ? <div className="small" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>Комментарий админа: {profile.documents_note}</div> : null}
              <div className="small" style={{ marginTop: 6 }}>
                {profile.founding_tutor ? 'Founding tutor активен.' : 'Founding tutor может выдать админ.'} Рейтинг: ★ {Number(profile.rating_avg || 0).toFixed(1)} ({profile.rating_count || 0}) • занятий: {profile.lessons_count || 0}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
              <button className="btn btnPrimary" onClick={saveProfile} disabled={saving}>{saving ? 'Сохраняем…' : 'Сохранить профиль'}</button>
              <button className="btn" onClick={submitForModeration} disabled={saving || !canSubmitTutorProfile}>Отправить на модерацию</button>
              <button className="btn" onClick={publishProfile} disabled={saving || !canSubmitTutorProfile}>{profile.is_published ? 'Переотправить на публикацию' : 'Опубликовать профиль'}</button>
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
                slots.slice(0, 20).map(s => (
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
          <div style={{ fontWeight: 900, fontSize: 18 }}>Подбор и доступные слоты</div>
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
                          {(me.role === 'tutor' || me.role === 'admin') && <button className="btn" onClick={() => completeBooking(b.id)} disabled={saving}>Завершить</button>}
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
