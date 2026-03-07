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

function listToLines(arr) {
  return Array.isArray(arr) ? arr.filter(Boolean).join('\n') : ''
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

function attendanceStatusLabel(v) {
  const s = String(v || 'pending')
  if (s === 'confirmed') return 'подтверждено'
  if (s === 'declined') return 'не подтверждено'
  return 'ожидает подтверждения'
}

function riskLabel(v) {
  if (v === 'high') return 'Высокий риск срыва'
  if (v === 'medium') return 'Средний риск срыва'
  return 'Низкий риск'
}

function bookingNeedsMyConfirmation(booking, role) {
  if (role === 'student') return String(booking?.student_attendance_status || 'pending') === 'pending'
  if (role === 'tutor') return String(booking?.tutor_attendance_status || 'pending') === 'pending'
  return false
}

function bookingWaitingOtherSide(booking, role) {
  if (role === 'student') return String(booking?.tutor_attendance_status || 'pending') === 'pending'
  if (role === 'tutor') return String(booking?.student_attendance_status || 'pending') === 'pending'
  return false
}

function bookingToCalendarEvent(b, meRole) {
  const startsIso = b?.slot_starts_at
  const endsIso = b?.slot_ends_at
  if (!startsIso) return null
  const start = new Date(startsIso)
  if (Number.isNaN(start.getTime())) return null
  const end = endsIso ? new Date(endsIso) : null
  const counterpart = meRole === 'tutor' ? (b.student_user_email || `Ученик #${b.student_user_id || ''}`) : (b.tutor_name || b.tutor_user_email || `Репетитор #${b.tutor_user_id || ''}`)
  return {
    id: b.id,
    roomId: b.room_id,
    slotId: b.slot_id,
    start,
    end: end && !Number.isNaN(end.getTime()) ? end : null,
    status: String(b.status || ''),
    paymentStatus: String(b.payment_status || 'unpaid'),
    counterpart,
    raw: b
  }
}

function formatDateKey(d) {
  const dt = new Date(d)
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  const day = String(dt.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatTime(dt) {
  return new Date(dt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function buildMonthCells(monthDate) {
  const first = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1)
  const startWeekday = (first.getDay() + 6) % 7 // Mon=0
  const gridStart = new Date(first)
  gridStart.setDate(first.getDate() - startWeekday)
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart)
    d.setDate(gridStart.getDate() + i)
    return d
  })
}

function LessonsCalendarCard({ bookings, role, settings, balanceInfo }) {
  const [monthOffset, setMonthOffset] = useState(0)

  const events = useMemo(() => (Array.isArray(bookings) ? bookings : [])
    .map(b => bookingToCalendarEvent(b, role))
    .filter(Boolean)
    .sort((a, b) => a.start - b.start), [bookings, role])

  const baseMonth = useMemo(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  }, [])

  const monthDate = useMemo(() => new Date(baseMonth.getFullYear(), baseMonth.getMonth() + monthOffset, 1), [baseMonth, monthOffset])

  const eventsByDay = useMemo(() => {
    const map = new Map()
    for (const e of events) {
      const key = formatDateKey(e.start)
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(e)
    }
    return map
  }, [events])

  const monthCells = useMemo(() => buildMonthCells(monthDate), [monthDate])

  const upcoming = useMemo(() => {
    const now = Date.now()
    return events.filter(e => e.start.getTime() >= now).slice(0, 8)
  }, [events])

  const paidEvents = useMemo(() => events.filter(e => e.paymentStatus === 'paid' && e.status !== 'cancelled'), [events])
  const paidUntilDerived = useMemo(() => {
    if (!paidEvents.length) return null
    let latest = null
    for (const e of paidEvents) {
      const point = e.end || e.start
      if (!latest || point > latest) latest = point
    }
    return latest
  }, [paidEvents])

  const paidUntil = settings?.paid_until || balanceInfo?.paid_until || (paidUntilDerived ? paidUntilDerived.toISOString() : null)
  const paidUntilDate = paidUntil ? new Date(paidUntil) : null
  const paidExpired = paidUntilDate ? paidUntilDate.getTime() < Date.now() : false

  const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: 18 }}>Занятия · календарь</div>
          <div className="sub">Время занятий и оплаченный период {role === 'tutor' ? 'по бронированиям ученика' : 'по твоим оплаченным бронированиям'}.</div>
        </div>
        <div className={`paidUntilPill ${paidUntil ? '' : 'muted'} ${paidExpired ? 'expired' : ''}`}>
          <span>Оплачено до:</span>
          <b>{paidUntilDate && !Number.isNaN(paidUntilDate.getTime()) ? paidUntilDate.toLocaleString() : '—'}</b>
        </div>
      </div>

      <div className="calendarToolbar">
        <button className="btn" onClick={() => setMonthOffset(v => v - 1)}>←</button>
        <div style={{ fontWeight: 800 }}>
          {monthDate.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}
        </div>
        <button className="btn" onClick={() => setMonthOffset(v => v + 1)}>→</button>
      </div>

      <div className="lessonCalendarGrid">
        {weekdays.map(d => <div key={d} className="lessonCalendarHead">{d}</div>)}
        {monthCells.map((d) => {
          const key = formatDateKey(d)
          const dayEvents = eventsByDay.get(key) || []
          const inMonth = d.getMonth() === monthDate.getMonth()
          const isToday = formatDateKey(d) === formatDateKey(new Date())
          return (
            <div key={key} className={`lessonCalendarCell ${inMonth ? '' : 'out'} ${isToday ? 'today' : ''}`}>
              <div className="lessonCalendarDate">{d.getDate()}</div>
              <div className="lessonCalendarEvents">
                {dayEvents.slice(0, 3).map(ev => (
                  <Link key={ev.id} to={`/room/${ev.roomId}`} className={`lessonEvent ${ev.paymentStatus === 'paid' ? 'paid' : ''} ${ev.status === 'cancelled' ? 'cancelled' : ''}`} title={`${formatTime(ev.start)} ${ev.counterpart || ''}`}>
                    <span>{formatTime(ev.start)}</span>
                  </Link>
                ))}
                {dayEvents.length > 3 && <div className="lessonMore">+{dayEvents.length - 3}</div>}
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ marginTop: 12 }}>
        <div className="label">Ближайшие занятия</div>
        <div className="grid" style={{ gap: 8 }}>
          {upcoming.length === 0 ? (
            <div className="small">Нет ближайших занятий.</div>
          ) : upcoming.map(ev => (
            <div key={ev.id} className="lessonAgendaItem">
              <div>
                <div style={{ fontWeight: 800 }}>#{ev.id} • {ev.start.toLocaleDateString()} {formatTime(ev.start)}{ev.end ? `—${formatTime(ev.end)}` : ''}</div>
                <div className="small">{ev.counterpart || 'Участник'} • статус: {ev.status} • оплата: {ev.paymentStatus}</div>
              </div>
              <Link className="btn" to={`/room/${ev.roomId}`}>Комната</Link>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
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
  const [parentContact, setParentContact] = useState(null)
  const [pulseMine, setPulseMine] = useState(null)
  const [examMode, setExamMode] = useState(null)
  const [weeklyDigest, setWeeklyDigest] = useState(null)
  const [bookingMetaMap, setBookingMetaMap] = useState({})
  const [waitlistItems, setWaitlistItems] = useState([])
  const [lastMinuteSubs, setLastMinuteSubs] = useState([])
  const [recurringForm, setRecurringForm] = useState({ tutor_user_id: '', weekdays: ['1','3'], time_hm: '18:00', duration_minutes: 60, weeks_ahead: 4, auto_attendance_confirm: true })

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
      const bookingsArr = Array.isArray(b) ? b : []
      setBookings(bookingsArr)
      try {
        if (bookingsArr.length) {
          const metaRes = await apiFetch(`/api/bookings/meta?ids=${bookingsArr.map(x => x.id).join(',')}`, { token })
          const mm = {}
          for (const it of (metaRes?.items || [])) mm[it.booking_id] = it
          setBookingMetaMap(mm)
        } else {
          setBookingMetaMap({})
        }
      } catch { setBookingMetaMap({}) }

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
        try {
          const wd = await apiFetch('/api/me/weekly-digest', { token })
          setWeeklyDigest(wd?.digest || null)
        } catch { setWeeklyDigest(null) }
        try {
          const pulse = await apiFetch('/api/pulse/mine', { token })
          setPulseMine(pulse || null)
        } catch { setPulseMine(null) }
      } else {
        const s = await apiFetch('/api/slots/available', { token })
        setSlots(Array.isArray(s) ? s : [])
        try {
          const pc = await apiFetch('/api/me/parent-contact', { token })
          setParentContact(pc?.contact || { parent_name:'', relationship:'parent', parent_email:'', parent_telegram_chat_id:'', notify_lessons:true, notify_homework:true, notify_comments:true, is_active:true })
        } catch { setParentContact(null) }
        try {
          const pulse = await apiFetch('/api/pulse/mine', { token })
          setPulseMine(pulse?.pulse || null)
        } catch { setPulseMine(null) }
        try {
          const ex = await apiFetch('/api/exam-mode', { token })
          setExamMode(ex?.exam || { exam_kind:'ЕГЭ', exam_subject:'', exam_date:'', target_score:80, current_score:0, readiness_percent:0, weak_topics:[], plan_by_weeks:[] })
        } catch { setExamMode(null) }
        try {
          const wl = await apiFetch('/api/waitlist', { token })
          setWaitlistItems(Array.isArray(wl?.items) ? wl.items : [])
        } catch { setWaitlistItems([]) }
        try {
          const lm = await apiFetch('/api/alerts/last-minute', { token })
          setLastMinuteSubs(Array.isArray(lm?.items) ? lm.items : [])
        } catch { setLastMinuteSubs([]) }
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
        payment_method: profile.payment_method || '',
        public_schedule_note: profile.public_schedule_note || ''
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

  async function setAttendanceStatus(bookingId, status, note = '') {
    setSaving(true)
    setErr('')
    try {
      await apiFetch(`/api/bookings/${bookingId}/attendance`, {
        method: 'POST',
        token,
        body: { status, note: note || null }
      })
      await load()
    } catch (e) {
      setErr(e.message || 'Не удалось обновить подтверждение')
    } finally {
      setSaving(false)
    }
  }

  async function repeatBookingOneClick(bookingId) {
    setSaving(true)
    setErr('')
    try {
      const res = await apiFetch(`/api/bookings/${bookingId}/repeat`, { method: 'POST', token })
      await load()
      const bid = res?.booking?.id
      const mt = res?.match_type || 'matched'
      alert(`Создана новая бронь #${bid}. Тип совпадения: ${mt}`)
    } catch (e) {
      setErr(e.message || 'Не удалось повторить запись')
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


  async function saveParentContact() {
    if (!parentContact) return
    setSaving(true); setErr('')
    try {
      const out = await apiFetch('/api/me/parent-contact', { method: 'PUT', token, body: parentContact })
      setParentContact(out?.contact || parentContact)
    } catch (e) { setErr(e.message || 'Не удалось сохранить контакт родителя') }
    finally { setSaving(false) }
  }

  async function saveExamMode() {
    if (!examMode) return
    setSaving(true); setErr('')
    try {
      const payload = {
        exam_kind: examMode.exam_kind || 'ЕГЭ',
        exam_subject: examMode.exam_subject || '',
        exam_date: examMode.exam_date ? new Date(examMode.exam_date).toISOString() : null,
        target_score: Number(examMode.target_score || 0),
        current_score: Number(examMode.current_score || 0),
        readiness_percent: Number(examMode.readiness_percent || 0),
        weak_topics: Array.isArray(examMode.weak_topics) ? examMode.weak_topics : String(examMode.weak_topics || '').split(',').map(x => x.trim()).filter(Boolean),
        plan_by_weeks: Array.isArray(examMode.plan_by_weeks) ? examMode.plan_by_weeks : String(examMode.plan_by_weeks || '').split('\n').map(x => x.trim()).filter(Boolean),
      }
      const out = await apiFetch('/api/exam-mode', { method: 'PUT', token, body: payload })
      setExamMode(out?.exam || examMode)
    } catch (e) { setErr(e.message || 'Не удалось сохранить exam mode') }
    finally { setSaving(false) }
  }

  async function createRecurringSeries() {
    setSaving(true); setErr('')
    try {
      const body = {
        tutor_user_id: Number(recurringForm.tutor_user_id || 0),
        weekdays: (recurringForm.weekdays || []).map(x => Number(x)),
        time_hm: recurringForm.time_hm || '18:00',
        duration_minutes: Number(recurringForm.duration_minutes || 60),
        weeks_ahead: Number(recurringForm.weeks_ahead || 4),
        auto_attendance_confirm: Boolean(recurringForm.auto_attendance_confirm),
      }
      const out = await apiFetch('/api/recurring/bookings', { method: 'POST', token, body })
      alert(`Серия создана. Забронировано занятий: ${(out?.booked_booking_ids || []).length}`)
      await load()
    } catch (e) { setErr(e.message || 'Не удалось создать серию') }
    finally { setSaving(false) }
  }

  async function addLastMinuteSub() {
    setSaving(true); setErr('')
    try {
      const tutorId = Number(recurringForm.tutor_user_id || 0) || undefined
      await apiFetch('/api/alerts/last-minute', { method: 'POST', token, body: { tutor_user_id: tutorId, only_today: true } })
      const lm = await apiFetch('/api/alerts/last-minute', { token })
      setLastMinuteSubs(Array.isArray(lm?.items) ? lm.items : [])
    } catch (e) { setErr(e.message || 'Не удалось подписаться на last-minute') }
    finally { setSaving(false) }
  }

  async function sendTutorCommentPrompt(bookingId) {
    if (me.role === 'student') return
    const comment = prompt('Короткий комментарий для ученика/родителя после урока:')
    if (comment == null) return
    setSaving(true); setErr('')
    try {
      await apiFetch(`/api/bookings/${bookingId}/tutor-comment`, { method: 'POST', token, body: { comment, send_to_parent: true } })
      const metaRes = await apiFetch(`/api/bookings/meta?ids=${bookings.map(x => x.id).join(',')}`, { token })
      const mm = {}
      for (const it of (metaRes?.items || [])) mm[it.booking_id] = it
      setBookingMetaMap(mm)
    } catch (e) { setErr(e.message || 'Не удалось отправить комментарий') }
    finally { setSaving(false) }
  }

  async function showTrialFollowup(bookingId) {
    try {
      const out = await apiFetch(`/api/bookings/${bookingId}/trial-followup`, { token })
      const f = out?.followup
      if (!f) return
      alert(`План на 4 недели:
- ${(f.plan_4_weeks || []).join('\n- ')}

CTA: ${f?.cta?.primary || 'Купить пакет'}`)
    } catch (e) { setErr(e.message || 'Не удалось загрузить follow-up пробного урока') }
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

            <div className="label">Публичная заметка по ближайшим окнам / времени (видна в профиле)</div>
            <textarea className="textarea" value={profile.public_schedule_note || ''} onChange={e => setProfile({ ...profile, public_schedule_note: e.target.value })} placeholder={`Например:
Будни после 18:00, выходные — утром.
Можно писать в чат для согласования времени.`} />

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
        <div style={{ fontWeight: 900, fontSize: 18 }}>Новые фичи роста и удержания</div>
        <div className="sub">Родительские уведомления, exam mode / pulse, recurring booking, last-minute и waitlist.</div>

        {me.role === 'student' && (
          <div className="grid" style={{ gap: 12, marginTop: 12 }}>
            <div className="card">
              <div style={{ fontWeight: 800 }}>Родительские уведомления</div>
              <div className="small">Напоминание о занятии, факт урока, комментарий репетитора, ДЗ и дедлайн.</div>
              <div className="label">Имя</div>
              <input className="input" value={parentContact?.parent_name || ''} onChange={(e) => setParentContact(s => ({ ...(s || {}), parent_name: e.target.value }))} />
              <div className="label">Email родителя</div>
              <input className="input" value={parentContact?.parent_email || ''} onChange={(e) => setParentContact(s => ({ ...(s || {}), parent_email: e.target.value }))} placeholder="parent@example.com" />
              <div className="label">Telegram chat id (опц.)</div>
              <input className="input" value={parentContact?.parent_telegram_chat_id || ''} onChange={(e) => setParentContact(s => ({ ...(s || {}), parent_telegram_chat_id: e.target.value }))} placeholder="123456789" />
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
                <label className="small"><input type="checkbox" checked={Boolean(parentContact?.notify_lessons)} onChange={(e) => setParentContact(s => ({ ...(s || {}), notify_lessons: e.target.checked }))} /> уроки</label>
                <label className="small"><input type="checkbox" checked={Boolean(parentContact?.notify_homework)} onChange={(e) => setParentContact(s => ({ ...(s || {}), notify_homework: e.target.checked }))} /> ДЗ</label>
                <label className="small"><input type="checkbox" checked={Boolean(parentContact?.notify_comments)} onChange={(e) => setParentContact(s => ({ ...(s || {}), notify_comments: e.target.checked }))} /> комментарии</label>
              </div>
              <button className="btn btnPrimary" style={{ marginTop: 10 }} onClick={saveParentContact} disabled={saving}>Сохранить контакт</button>
            </div>

            <div className="card">
              <div style={{ fontWeight: 800 }}>Режим экзамена + пульс ученика</div>
              {pulseMine && (
                <div className="small" style={{ marginTop: 6 }}>
                  Пульс: посещаемость {pulseMine?.attendance?.attendance_percent || 0}% • ДЗ {pulseMine?.homework?.completion_percent || 0}% • мини-тесты {pulseMine?.mini_tests?.avg_score_percent ?? '—'}% • пробелы: {pulseMine?.gaps?.count || 0}
                </div>
              )}
              <div className="grid" style={{ gap: 8, marginTop: 10 }}>
                <div className="label">Экзамен / формат</div>
                <input className="input" value={examMode?.exam_kind || ''} onChange={(e) => setExamMode(s => ({ ...(s || {}), exam_kind: e.target.value }))} placeholder="ЕГЭ / ОГЭ / ЦТ / ЦЭ" />
                <div className="label">Предмет</div>
                <input className="input" value={examMode?.exam_subject || ''} onChange={(e) => setExamMode(s => ({ ...(s || {}), exam_subject: e.target.value }))} placeholder="Математика" />
                <div className="label">Дата экзамена</div>
                <input className="input" type="datetime-local" value={examMode?.exam_date ? toLocalInputValue(examMode.exam_date) : ''} onChange={(e) => setExamMode(s => ({ ...(s || {}), exam_date: e.target.value }))} />
                <div className="grid" style={{ gap: 8 }}>
                  <input className="input" type="number" value={examMode?.target_score || 0} onChange={(e) => setExamMode(s => ({ ...(s || {}), target_score: e.target.value }))} placeholder="Цель по баллам" />
                  <input className="input" type="number" value={examMode?.current_score || 0} onChange={(e) => setExamMode(s => ({ ...(s || {}), current_score: e.target.value }))} placeholder="Текущий результат" />
                  <input className="input" type="number" min="0" max="100" value={examMode?.readiness_percent || 0} onChange={(e) => setExamMode(s => ({ ...(s || {}), readiness_percent: e.target.value }))} placeholder="Готовность %" />
                </div>
                <div className="label">Слабые темы (через запятую)</div>
                <input className="input" value={Array.isArray(examMode?.weak_topics) ? examMode.weak_topics.join(', ') : (examMode?.weak_topics || '')} onChange={(e) => setExamMode(s => ({ ...(s || {}), weak_topics: e.target.value }))} />
                <div className="label">План по неделям (каждая строка)</div>
                <textarea className="textarea" value={Array.isArray(examMode?.plan_by_weeks) ? examMode.plan_by_weeks.join('\n') : (examMode?.plan_by_weeks || '')} onChange={(e) => setExamMode(s => ({ ...(s || {}), plan_by_weeks: e.target.value }))} />
                <button className="btn btnPrimary" onClick={saveExamMode} disabled={saving}>Сохранить exam mode</button>
              </div>
            </div>

            <div className="card">
              <div style={{ fontWeight: 800 }}>Серии занятий (recurring booking)</div>
              <div className="small">Например: каждый вт/чт в 18:00. Система забронирует подходящие открытые слоты и включит автоподтверждение.</div>
              <div className="label">Tutor user_id</div>
              <input className="input" type="number" value={recurringForm.tutor_user_id} onChange={(e) => setRecurringForm(s => ({ ...s, tutor_user_id: e.target.value }))} placeholder="ID репетитора" />
              <div className="label">Дни недели (0=Пн…6=Вс, через запятую)</div>
              <input className="input" value={(recurringForm.weekdays || []).join(',')} onChange={(e) => setRecurringForm(s => ({ ...s, weekdays: e.target.value.split(',').map(x => x.trim()).filter(Boolean) }))} placeholder="1,3" />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input className="input" style={{ flex: 1, minWidth: 140 }} value={recurringForm.time_hm} onChange={(e) => setRecurringForm(s => ({ ...s, time_hm: e.target.value }))} placeholder="18:00" />
                <input className="input" style={{ flex: 1, minWidth: 140 }} type="number" value={recurringForm.duration_minutes} onChange={(e) => setRecurringForm(s => ({ ...s, duration_minutes: e.target.value }))} placeholder="60 мин" />
                <input className="input" style={{ flex: 1, minWidth: 140 }} type="number" value={recurringForm.weeks_ahead} onChange={(e) => setRecurringForm(s => ({ ...s, weeks_ahead: e.target.value }))} placeholder="4 недели" />
              </div>
              <label className="small" style={{ display: 'block', marginTop: 8 }}><input type="checkbox" checked={Boolean(recurringForm.auto_attendance_confirm)} onChange={(e) => setRecurringForm(s => ({ ...s, auto_attendance_confirm: e.target.checked }))} /> автоподтверждение ученика</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                <button className="btn btnPrimary" onClick={createRecurringSeries} disabled={saving}>Создать серию</button>
                <button className="btn" onClick={addLastMinuteSub} disabled={saving}>Подписаться на last-minute</button>
              </div>
              <div className="small" style={{ marginTop: 8 }}>Waitlist: {waitlistItems.length} • Last-minute подписки: {lastMinuteSubs.length}</div>
            </div>
          </div>
        )}

        {me.role === 'tutor' && (
          <div className="grid" style={{ gap: 12, marginTop: 12 }}>
            <div className="card">
              <div style={{ fontWeight: 800 }}>Weekly digest (preview)</div>
              {!weeklyDigest ? <div className="small">Нет данных.</div> : (
                <div className="small" style={{ whiteSpace: 'pre-wrap' }}>
                  Проведено: {weeklyDigest.lessons_done} • Отмены: {weeklyDigest.cancelled}
                  {'\n'}Новые ученики: {weeklyDigest.new_students} • Давно не записывались: {(weeklyDigest.dormant_students || []).length}
                  {'\n'}Выручка (trial): {weeklyDigest.earnings_7d}
                </div>
              )}
            </div>
            {pulseMine?.items ? (
              <div className="card">
                <div style={{ fontWeight: 800 }}>Пульс учеников</div>
                <div className="grid" style={{ gap: 8, marginTop: 8 }}>
                  {pulseMine.items.slice(0, 8).map((x) => (
                    <div key={x.student_user_id} className="small">#{x.student_user_id} {x.student_hint}: посещаемость {x.attendance?.attendance_percent || 0}% • ДЗ {x.homework?.completion_percent || 0}% • пробелы {x.gaps?.count || 0}</div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <LessonsCalendarCard bookings={bookings} role={me.role} settings={settings} balanceInfo={balanceInfo} />

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
              const needMyConfirmation = !isCancelled && !isDone && bookingNeedsMyConfirmation(b, me.role)
              const waitingOtherConfirmation = !isCancelled && !isDone && bookingWaitingOtherSide(b, me.role)

              return (
                <div key={b.id} className={`card bookingCard${needMyConfirmation ? ' bookingCardPending' : ''}`}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>Бронь #{b.id} • {b.status}{bookingMetaMap?.[b.id]?.booking_type === 'trial' ? ' • пробный урок' : ''}</div>
                      <div className="small">Слот #{b.slot_id} • комната: {b.room_id}</div>
                      {starts && <div className="small">Время: {starts}{ends ? ` — ${ends}` : ''}</div>}
                      <div className="small">Создано: {new Date(b.created_at).toLocaleString()}</div>
                      <div className="small">Стоимость: {b.price || 0} ₽ • оплата: {b.payment_status || 'unpaid'}</div>
                      <div className="small">Подтверждение: ученик — {attendanceStatusLabel(b.student_attendance_status)} • репетитор — {attendanceStatusLabel(b.tutor_attendance_status)}</div>
                      {(needMyConfirmation || waitingOtherConfirmation) && (
                        <div className="pills" style={{ marginTop: 8 }}>
                          {needMyConfirmation && <span className="pill pillWarning">Нужно ваше подтверждение</span>}
                          {waitingOtherConfirmation && <span className="pill pillSoft">Ждём вторую сторону</span>}
                        </div>
                      )}
                      {Number(b.reschedule_count || 0) > 0 && <div className="small">Переносов: {b.reschedule_count}{b.last_reschedule_reason ? ` • ${b.last_reschedule_reason}` : ''}</div>}
                      {!!b.risk_status && b.risk_status !== 'low' && (
                        <div className="footerNote" style={{ marginTop: 6 }}>
                          <b>{riskLabel(b.risk_status)}</b>{Array.isArray(b.risk_reasons) && b.risk_reasons.length ? `: ${b.risk_reasons.join('; ')}` : ''}
                        </div>
                      )}
                    </div>

                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                      <Link className="btn btnPrimary" to={`/room/${b.room_id}`}>Открыть комнату</Link>

                      {!isCancelled && !isDone && (me.role === 'student' || me.role === 'tutor') && (
                        <>
                          <button className="btn" onClick={() => setAttendanceStatus(b.id, 'confirmed')} disabled={saving}>Подтверждаю</button>
                          <button className="btn" onClick={() => setAttendanceStatus(b.id, 'declined', me.role === 'student' ? 'Не могу сегодня' : 'Нужно перенести / не смогу провести')} disabled={saving}>Не подтверждаю</button>
                        </>
                      )}

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
                        <>
                          <button className="btn" onClick={() => setReviewBookingId(b.id)}>Оставить отзыв</button>
                          {me.role === 'student' && <button className="btn" onClick={() => repeatBookingOneClick(b.id)} disabled={saving}>Повторить слот</button>}
                          {me.role === 'student' && bookingMetaMap?.[b.id]?.booking_type === 'trial' && <button className="btn" onClick={() => showTrialFollowup(b.id)}>План после пробного</button>}
                        </>
                      )}

                      {isCancelled && <div className="small">Отменено</div>}
                      {isDone && <div className="small">Завершено</div>}
                      {isDone && (me.role === 'tutor' || me.role === 'admin') && <button className="btn" onClick={() => sendTutorCommentPrompt(b.id)} disabled={saving}>Комментарий родителю</button>}
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
