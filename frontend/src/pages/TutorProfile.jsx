import React, { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { apiFetch } from '../api'
import { useAuth } from '../auth.jsx'

function Stars({ n }) {
  const v = Math.max(0, Math.min(5, Number(n || 0)))
  return <span>{'★'.repeat(Math.round(v))}{'☆'.repeat(5 - Math.round(v))}</span>
}

function initials(name) {
  const s = (name || '').trim()
  if (!s) return 'DL'
  return s.split(/\s+/).slice(0, 2).map(x => x[0]?.toUpperCase()).join('') || 'DL'
}

function dateKey(d) {
  const x = new Date(d)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

function buildMonthCells(monthDate) {
  const first = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1)
  const startWeekday = (first.getDay() + 6) % 7
  const gridStart = new Date(first)
  gridStart.setDate(first.getDate() - startWeekday)
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart)
    d.setDate(gridStart.getDate() + i)
    return d
  })
}

function PublicSlotsCalendar({ slots = [], onBook, bookingId }) {
  const [monthOffset, setMonthOffset] = useState(0)
  const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

  const normalized = useMemo(() => (Array.isArray(slots) ? slots : [])
    .map(s => {
      const start = new Date(s.starts_at)
      const end = new Date(s.ends_at)
      if (Number.isNaN(start.getTime())) return null
      return { ...s, _start: start, _end: Number.isNaN(end.getTime()) ? null : end }
    })
    .filter(Boolean)
    .sort((a, b) => a._start - b._start), [slots])

  const baseMonth = useMemo(() => {
    const firstSlot = normalized.find(Boolean)?._start
    const d = firstSlot || new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  }, [normalized])

  const monthDate = useMemo(() => new Date(baseMonth.getFullYear(), baseMonth.getMonth() + monthOffset, 1), [baseMonth, monthOffset])
  const monthCells = useMemo(() => buildMonthCells(monthDate), [monthDate])

  const slotsByDay = useMemo(() => {
    const m = new Map()
    for (const s of normalized) {
      const k = dateKey(s._start)
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(s)
    }
    return m
  }, [normalized])

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="panelTitle">
        <div style={{ fontWeight: 800 }}>Публичный календарь слотов</div>
        <div className="small">Кликни на время, чтобы записаться</div>
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
          const key = dateKey(d)
          const daySlots = slotsByDay.get(key) || []
          const inMonth = d.getMonth() === monthDate.getMonth()
          const isToday = key === dateKey(new Date())
          return (
            <div key={key} className={`lessonCalendarCell ${inMonth ? '' : 'out'} ${isToday ? 'today' : ''}`}>
              <div className="lessonCalendarDate">{d.getDate()}</div>
              <div className="lessonCalendarEvents">
                {daySlots.slice(0, 3).map(s => (
                  <button
                    key={s.id}
                    type="button"
                    className="lessonEvent"
                    title={`${s._start.toLocaleString()}${s._end ? ` — ${s._end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`}
                    onClick={() => onBook?.(s.id)}
                    disabled={bookingId === s.id}
                    style={{ cursor: 'pointer' }}
                  >
                    <span>{s._start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </button>
                ))}
                {daySlots.length > 3 && <div className="lessonMore">+{daySlots.length - 3}</div>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function TutorProfile() {
  const { id } = useParams()
  const nav = useNavigate()
  const { token, me } = useAuth()

  const [tutor, setTutor] = useState(null)
  const [slots, setSlots] = useState([])
  const [reviews, setReviews] = useState([])
  const [reviewsExtended, setReviewsExtended] = useState([])
  const [methodology, setMethodology] = useState(null)
  const [loading, setLoading] = useState(true)
  const [trialBusyId, setTrialBusyId] = useState(null)
  const [waitlistBusy, setWaitlistBusy] = useState(false)
  const [lastMinuteBusy, setLastMinuteBusy] = useState(false)
  const [err, setErr] = useState('')
  const [bookingId, setBookingId] = useState(null)
  const [bookingSuccess, setBookingSuccess] = useState(null)

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setErr('')
      try {
        const t = await apiFetch(`/api/tutors/${id}`)
        const s = await apiFetch(`/api/slots/available?tutor_user_id=${t.user_id}`)
        const r = await apiFetch(`/api/tutors/${id}/reviews`)
        let rx = null
        let m = null
        try { rx = await apiFetch(`/api/tutors/${id}/reviews/extended`) } catch {}
        try { m = await apiFetch(`/api/tutors/${id}/methodology`) } catch {}
        if (!mounted) return
        setTutor(t)
        setSlots(Array.isArray(s) ? s : [])
        setReviews(Array.isArray(r) ? r : [])
        setReviewsExtended(Array.isArray(rx?.items) ? rx.items : [])
        setMethodology(m?.methodology || null)
      } catch (e) {
        if (mounted) setErr(e.message || 'Ошибка загрузки')
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [id])

  async function book(slotId) {
    if (!token) return nav('/login')
    if (me?.role === 'tutor') return setErr('Репетитор не может бронировать слоты. Войдите как ученик.')
    setBookingId(slotId)
    setErr('')
    setBookingSuccess(null)
    try {
      const b = await apiFetch(`/api/slots/${slotId}/book`, { method: 'POST', token })
      setSlots(prev => (Array.isArray(prev) ? prev.filter(s => s.id !== slotId) : prev))
      setBookingSuccess({
        id: b.id,
        room_id: b.room_id,
        message: 'Бронь создана. Мы больше не перекидываем сразу в конференцию — зайди в “Кабинет → Занятия” и открой комнату в нужное время.'
      })
      // Переводим в кабинет, а не сразу в комнату урока.
      nav('/dashboard')
    } catch (e) {
      setErr(e.message || 'Ошибка бронирования')
    } finally {
      setBookingId(null)
    }
  }


  async function bookTrial(slotId) {
    if (!token) return nav('/login')
    if (me?.role === 'tutor') return setErr('Репетитор не может бронировать слоты.')
    setTrialBusyId(slotId)
    setErr('')
    try {
      await apiFetch(`/api/slots/${slotId}/book-trial`, { method: 'POST', token })
      nav('/dashboard')
    } catch (e) {
      setErr(e.message || 'Ошибка записи на пробный урок')
    } finally {
      setTrialBusyId(null)
    }
  }

  async function joinWaitlist() {
    if (!token) return nav('/login')
    setWaitlistBusy(true)
    setErr('')
    try {
      await apiFetch('/api/waitlist', {
        method: 'POST',
        token,
        body: {
          tutor_user_id: tutor?.user_id,
          subject: (tutor?.subjects || [])[0] || '',
          note: 'Жду освободившийся слот',
        }
      })
      alert('Добавили в лист ожидания. При отмене/освобождении слота придет уведомление.')
    } catch (e) {
      setErr(e.message || 'Не удалось добавить в лист ожидания')
    } finally {
      setWaitlistBusy(false)
    }
  }

  async function subscribeLastMinute() {
    if (!token) return nav('/login')
    setLastMinuteBusy(true)
    setErr('')
    try {
      await apiFetch('/api/alerts/last-minute', {
        method: 'POST',
        token,
        body: { tutor_user_id: tutor?.user_id, subject: (tutor?.subjects || [])[0] || '', only_today: true }
      })
      alert('Подписка на last-minute слоты включена.')
    } catch (e) {
      setErr(e.message || 'Не удалось оформить подписку')
    } finally {
      setLastMinuteBusy(false)
    }
  }

  const reviewsToRender = Array.isArray(reviewsExtended) && reviewsExtended.length ? reviewsExtended : reviews

  if (loading) return <div className="card">Загрузка…</div>
  if (err && !tutor) return <div className="card">{err}</div>
  if (!tutor) return <div className="card">Не найдено</div>

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="card">
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {tutor.photo_url ? (
            <img className="profilePhoto" src={tutor.photo_url} alt={tutor.display_name} />
          ) : (
            <div className="profilePhoto profilePhotoFallback">{initials(tutor.display_name)}</div>
          )}

          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 28 }}>{tutor.display_name}</div>
                <div className="small">
                  <Stars n={tutor.rating_avg} /> {Number(tutor.rating_avg || 0).toFixed(1)} ({tutor.rating_count || 0}) • занятий: {tutor.lessons_count || 0}
                  {tutor.age ? ` • ${tutor.age} лет` : ''}
                  {tutor.language ? ` • язык: ${tutor.language}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Link className="btn" to="/">Назад</Link>
                <Link className="btn btnPrimary" to="/dashboard">Кабинет</Link>
              </div>
            </div>

            <div className="pills" style={{ marginTop: 10 }}>
              {tutor.founding_tutor ? <span className="pill badgeGold">Founding tutor</span> : null}
              {tutor.is_verified ? <span className="pill badgeGreen">Профиль и документы проверены</span> : null}
              {(tutor.subjects || []).map(s => <span className="pill" key={s}>{s}</span>)}
            </div>

            {!!(tutor.goals || []).length && (
              <div style={{ marginTop: 10 }}>
                <div className="small">Цели</div>
                <div className="pills">{tutor.goals.map(x => <span key={x} className="pill">{x}</span>)}</div>
              </div>
            )}
            {!!(tutor.levels || []).length && (
              <div style={{ marginTop: 10 }}>
                <div className="small">Уровни</div>
                <div className="pills">{tutor.levels.map(x => <span key={x} className="pill">{x}</span>)}</div>
              </div>
            )}
            {!!(tutor.grades || []).length && (
              <div style={{ marginTop: 10 }}>
                <div className="small">С какими классами работает</div>
                <div className="pills">{tutor.grades.map(x => <span key={x} className="pill">{x}</span>)}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="split">
        <div className="card">
          <div style={{ fontWeight: 900, fontSize: 18 }}>О репетиторе</div>
          <div className="sub" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{tutor.bio || 'Описание пока не заполнено.'}</div>

          {methodology && (methodology.fit_for || methodology.lesson_flow || methodology.homework_load || methodology.first_month_plan || methodology.avg_results) ? (
            <div className="card" style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 800 }}>Структурированная методика</div>
              {methodology.fit_for ? <div style={{ marginTop: 8 }}><b>Для кого подходит:</b><div className="small" style={{ whiteSpace: 'pre-wrap' }}>{methodology.fit_for}</div></div> : null}
              {methodology.lesson_flow ? <div style={{ marginTop: 8 }}><b>Как проходит урок:</b><div className="small" style={{ whiteSpace: 'pre-wrap' }}>{methodology.lesson_flow}</div></div> : null}
              {methodology.homework_load ? <div style={{ marginTop: 8 }}><b>Сколько ДЗ:</b><div className="small" style={{ whiteSpace: 'pre-wrap' }}>{methodology.homework_load}</div></div> : null}
              {methodology.first_month_plan ? <div style={{ marginTop: 8 }}><b>План на первый месяц:</b><div className="small" style={{ whiteSpace: 'pre-wrap' }}>{methodology.first_month_plan}</div></div> : null}
              {methodology.avg_results ? <div style={{ marginTop: 8 }}><b>Средний результат учеников:</b><div className="small" style={{ whiteSpace: 'pre-wrap' }}>{methodology.avg_results}</div></div> : null}
            </div>
          ) : null}

          {tutor.education && (
            <div className="card" style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 800 }}>Образование</div>
              <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{tutor.education}</div>
            </div>
          )}

          {!!(tutor.backgrounds || []).length && (
            <div className="card" style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 800 }}>Бекграунд / опыт</div>
              <ul className="ul">
                {tutor.backgrounds.map((x, i) => <li key={`${x}-${i}`}>{x}</li>)}
              </ul>
            </div>
          )}

          <div className="card" style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 800 }}>Стоимость занятия</div>
            <div className="small">{tutor.price_per_hour || 0} ₽/час</div>
            <div className="small" style={{ marginTop: 6 }}>
              В MVP оплата проходит напрямую репетитору. После бронирования реквизиты/способ оплаты можно показать в комнате занятия.
            </div>
          </div>

          {tutor.video_url && (
            <div className="card" style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 800 }}>Видео-визитка</div>
              <a className="btn" href={tutor.video_url} target="_blank" rel="noreferrer">Открыть видео</a>
            </div>
          )}
        </div>

        <div className="card">
          <div className="panelTitle">
            <div style={{ fontWeight: 900, fontSize: 18 }}>Свободные слоты и календарь</div>
            <div className="small">{slots.length} доступно</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <button className="btn" onClick={subscribeLastMinute} disabled={lastMinuteBusy}>{lastMinuteBusy ? 'Подписываем…' : 'Слоты горят: подписаться'}</button>
            <button className="btn" onClick={joinWaitlist} disabled={waitlistBusy}>{waitlistBusy ? 'Добавляем…' : 'В лист ожидания'}</button>
          </div>

          {tutor.public_schedule_note ? (
            <div className="card" style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 800 }}>Ближайшие окна / пожелания по времени</div>
              <div className="small" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{tutor.public_schedule_note}</div>
            </div>
          ) : null}

          <PublicSlotsCalendar slots={slots} onBook={book} bookingId={bookingId} />

          <div className="grid" style={{ gap: 10, marginTop: 12 }}>
            {slots.length === 0 ? (
              <div className="small">Пока нет открытых слотов.</div>
            ) : (
              slots.map(s => (
                <div key={s.id} className="card" style={{ border: '1px solid var(--border)' }}>
                  <div style={{ fontWeight: 800 }}>{new Date(s.starts_at).toLocaleString()}</div>
                  <div className="small">до {new Date(s.ends_at).toLocaleString()}</div>
                  <button className="btn btnPrimary" style={{ marginTop: 10 }} onClick={() => book(s.id)} disabled={bookingId === s.id}>
                    {bookingId === s.id ? 'Бронируем…' : 'Записаться'}
                  </button>
                  {(() => {
                    const mins = Math.max(1, Math.round((new Date(s.ends_at) - new Date(s.starts_at)) / 60000))
                    if (mins < 15 || mins > 45) return null
                    return (
                      <button className="btn" style={{ marginTop: 8 }} onClick={() => bookTrial(s.id)} disabled={trialBusyId === s.id}>
                        {trialBusyId === s.id ? 'Запись…' : 'Пробный урок (20–30 мин)'}
                      </button>
                    )
                  })()}
                </div>
              ))
            )}
          </div>

          <div className="footerNote">После брони комната урока создаётся, но вход в неё лучше делать из раздела “Занятия” в нужное время.</div>
          {bookingSuccess && (
            <div className="footerNote" style={{ color: 'var(--success)' }}>
              {bookingSuccess.message}
            </div>
          )}
          {err && <div className="footerNote">{err}</div>}
        </div>
      </div>

      <div className="card">
        <div className="panelTitle">
          <div style={{ fontWeight: 900, fontSize: 18 }}>Отзывы</div>
          <div className="small">{reviewsToRender.length}</div>
        </div>
        {reviewsToRender.length === 0 ? (
          <div className="small">Пока нет отзывов. Они появляются после завершённого занятия.</div>
        ) : (
          <div className="grid" style={{ gap: 10 }}>
            {reviewsToRender.slice(0, 20).map(r => (
              <div key={r.id} className="card" style={{ border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ fontWeight: 800 }}><Stars n={r.stars} /> {r.stars}★</div>
                  <div className="small">{new Date(r.created_at).toLocaleDateString()}</div>
                </div>
                <div className="small" style={{ marginTop: 4 }}>{r.student_hint}</div>
                {r.long_term_student ? <div className="small" style={{ color: 'var(--success)', marginTop: 4 }}>Бейдж: долгосрочный ученик (10+ занятий)</div> : null}
                {r.lessons_before_review ? <div className="small">Отзыв после {r.lessons_before_review} занятий</div> : null}
                {r.criteria && (r.criteria.explains_rating || r.criteria.punctuality_rating || r.criteria.materials_rating || r.criteria.result_rating) ? (
                  <div className="small" style={{ marginTop: 4 }}>
                    Критерии: объясняет {r.criteria.explains_rating || '—'}★ • пунктуальность {r.criteria.punctuality_rating || '—'}★ • материалы {r.criteria.materials_rating || '—'}★ • результат {r.criteria.result_rating || '—'}★
                  </div>
                ) : null}
                <div style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{r.text || 'Без комментария.'}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
