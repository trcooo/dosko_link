import React, { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { apiFetch } from '../api'
import { useAuth } from '../auth.jsx'

const FAVS_KEY = 'dl_favorite_tutors_v1'

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

function readFavorites() {
  try {
    const raw = localStorage.getItem(FAVS_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.map(Number).filter(Number.isFinite) : []
  } catch {
    return []
  }
}

function writeFavorites(arr) {
  try { localStorage.setItem(FAVS_KEY, JSON.stringify(arr)) } catch {}
}

function ReviewSummary({ reviews = [], tutor }) {
  const dist = useMemo(() => {
    const base = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
    for (const r of reviews || []) {
      const s = Number(r?.stars || 0)
      if (base[s] != null) base[s] += 1
    }
    return base
  }, [reviews])

  const total = reviews.length || Number(tutor?.rating_count || 0) || 0
  const avg = Number(tutor?.rating_avg || 0)

  return (
    <div className="reviewSummaryGrid">
      <div className="reviewSummaryMain">
        <div className="small">Средняя оценка</div>
        <div className="reviewBigScore">{avg.toFixed(1)}</div>
        <div className="small"><Stars n={avg} /> • {total} отзывов</div>
      </div>
      <div className="reviewBars">
        {[5, 4, 3, 2, 1].map(star => {
          const count = dist[star] || 0
          const width = total ? Math.round((count / total) * 100) : 0
          return (
            <div key={star} className="reviewBarRow">
              <div className="small" style={{ width: 36 }}>{star}★</div>
              <div className="reviewBarTrack"><span style={{ width: `${width}%` }} /></div>
              <div className="small" style={{ width: 28, textAlign: 'right' }}>{count}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
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
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [bookingId, setBookingId] = useState(null)
  const [bookingSuccess, setBookingSuccess] = useState(null)
  const [favorites, setFavorites] = useState(() => (typeof window !== 'undefined' ? readFavorites() : []))

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setErr('')
      try {
        const t = await apiFetch(`/api/tutors/${id}`)
        const s = await apiFetch(`/api/slots/available?tutor_user_id=${t.user_id}`)
        const r = await apiFetch(`/api/tutors/${id}/reviews`)
        if (!mounted) return
        setTutor(t)
        setSlots(Array.isArray(s) ? s : [])
        setReviews(Array.isArray(r) ? r : [])
      } catch (e) {
        if (mounted) setErr(e.message || 'Ошибка загрузки')
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [id])

  function toggleFavorite(profileId) {
    setFavorites(prev => {
      const next = prev.includes(profileId) ? prev.filter(x => x !== profileId) : [...prev, profileId]
      writeFavorites(next)
      return next
    })
  }

  async function copyProfileLink() {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setBookingSuccess({ message: 'Ссылка на профиль скопирована.' })
    } catch {
      setBookingSuccess({ message: 'Не удалось скопировать ссылку. Скопируй URL вручную.' })
    }
  }

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
        message: 'Бронь создана. Зайди в “Кабинет → Занятия” и открой комнату в нужное время.'
      })
      nav('/dashboard')
    } catch (e) {
      setErr(e.message || 'Ошибка бронирования')
    } finally {
      setBookingId(null)
    }
  }

  const nextSlot = useMemo(() => {
    return (slots || [])
      .map(s => ({ ...s, _start: new Date(s.starts_at) }))
      .filter(s => !Number.isNaN(s._start.getTime()))
      .sort((a, b) => a._start - b._start)[0] || null
  }, [slots])

  const slotsStats = useMemo(() => {
    const now = new Date()
    const weekEnd = new Date(now)
    weekEnd.setDate(now.getDate() + 7)
    let week = 0
    let evenings = 0
    for (const s of slots || []) {
      const d = new Date(s.starts_at)
      if (Number.isNaN(d.getTime())) continue
      if (d >= now && d <= weekEnd) week += 1
      if (d.getHours() >= 17) evenings += 1
    }
    return { week, evenings, total: slots.length }
  }, [slots])

  const isFavorite = tutor ? favorites.includes(tutor.id) : false

  if (loading) return <div className="card">Загрузка…</div>
  if (err && !tutor) return <div className="card">{err}</div>
  if (!tutor) return <div className="card">Не найдено</div>

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="card tutorHeroCard">
        <div className="tutorHeroLayout">
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {tutor.photo_url ? (
              <img className="profilePhoto tutorProfileHeroPhoto" src={tutor.photo_url} alt={tutor.display_name} />
            ) : (
              <div className="profilePhoto profilePhotoFallback tutorProfileHeroPhoto">{initials(tutor.display_name)}</div>
            )}

            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontWeight: 900, fontSize: 30 }}>{tutor.display_name}</div>
                  <div className="small" style={{ marginTop: 4 }}>
                    <Stars n={tutor.rating_avg} /> {Number(tutor.rating_avg || 0).toFixed(1)} ({tutor.rating_count || 0}) • занятий: {tutor.lessons_count || 0}
                    {tutor.age ? ` • ${tutor.age} лет` : ''}
                    {tutor.language ? ` • язык: ${String(tutor.language).toUpperCase()}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn" type="button" onClick={copyProfileLink}>Поделиться</button>
                  <button className={`btn ${isFavorite ? 'btnPrimary' : ''}`} type="button" onClick={() => toggleFavorite(tutor.id)}>
                    {isFavorite ? '★ В избранном' : '☆ В избранное'}
                  </button>
                  <Link className="btn" to="/">Назад</Link>
                </div>
              </div>

              <div className="pills" style={{ marginTop: 10 }}>
                {tutor.founding_tutor ? <span className="pill badgeGold">Founding tutor</span> : null}
                {tutor.is_verified ? <span className="pill badgeGreen">Профиль и документы проверены</span> : <span className="pill">Без отметки верификации</span>}
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

          <div className="bookingSummaryCard stickyCard">
            <div className="small">Стоимость занятия</div>
            <div className="bookingPriceMain">{tutor.price_per_hour || 0} ₽ / 60 мин</div>

            <div className="bookingStatList">
              <div className="bookingStatRow"><span>Свободных слотов</span><strong>{slotsStats.total}</strong></div>
              <div className="bookingStatRow"><span>На ближайшие 7 дней</span><strong>{slotsStats.week}</strong></div>
              <div className="bookingStatRow"><span>Вечерние окна</span><strong>{slotsStats.evenings}</strong></div>
              <div className="bookingStatRow"><span>Ближайший слот</span><strong>{nextSlot ? new Date(nextSlot.starts_at).toLocaleString() : 'нет'}</strong></div>
            </div>

            <div className="bookingChecklist">
              <div className="small" style={{ fontWeight: 700, color: 'var(--text)' }}>Как проходит MVP-сценарий</div>
              <div className="small">1. Бронируешь слот</div>
              <div className="small">2. Заходишь в комнату урока (видео/чат/доска)</div>
              <div className="small">3. После занятия оставляешь отзыв</div>
            </div>

            <div className="small" style={{ marginTop: 10 }}>
              В этом MVP оплата проходит напрямую репетитору после бронирования/подтверждения.
            </div>
          </div>
        </div>
      </div>

      <div className="split tutorProfileSplit">
        <div className="grid" style={{ gap: 12 }}>
          <div className="card">
            <div style={{ fontWeight: 900, fontSize: 18 }}>О репетиторе</div>
            <div className="sub" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{tutor.bio || 'Описание пока не заполнено.'}</div>
          </div>

          {tutor.education && (
            <div className="card">
              <div style={{ fontWeight: 800 }}>Образование</div>
              <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{tutor.education}</div>
            </div>
          )}

          {!!(tutor.backgrounds || []).length && (
            <div className="card">
              <div style={{ fontWeight: 800 }}>Бекграунд / опыт</div>
              <ul className="ul">
                {tutor.backgrounds.map((x, i) => <li key={`${x}-${i}`}>{x}</li>)}
              </ul>
            </div>
          )}

          <div className="card">
            <div style={{ fontWeight: 800 }}>Что получает ученик на платформе</div>
            <div className="benefitsGrid" style={{ marginTop: 10 }}>
              <div className="benefitTile"><div className="benefitTitle">Бронь слота</div><div className="small">Без переходов в мессенджеры на этапе записи</div></div>
              <div className="benefitTile"><div className="benefitTitle">Комната урока</div><div className="small">Видео / аудио / чат / доска в одном месте</div></div>
              <div className="benefitTile"><div className="benefitTitle">Материалы</div><div className="small">Можно сохранять артефакты и файлы урока</div></div>
              <div className="benefitTile"><div className="benefitTitle">Отзывы</div><div className="small">После завершённого занятия для прозрачного рейтинга</div></div>
            </div>
          </div>

          {tutor.video_url && (
            <div className="card">
              <div style={{ fontWeight: 800 }}>Видео-визитка</div>
              <div className="small" style={{ marginTop: 6 }}>Помогает быстро понять стиль преподавателя до брони.</div>
              <a className="btn" style={{ marginTop: 10 }} href={tutor.video_url} target="_blank" rel="noreferrer">Открыть видео</a>
            </div>
          )}
        </div>

        <div className="grid" style={{ gap: 12 }}>
          <div className="card stickyCard">
            <div className="panelTitle">
              <div style={{ fontWeight: 900, fontSize: 18 }}>Свободные слоты и календарь</div>
              <div className="small">{slots.length} доступно</div>
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
                slots.slice(0, 12).map(s => (
                  <div key={s.id} className="slotListItem">
                    <div>
                      <div style={{ fontWeight: 800 }}>{new Date(s.starts_at).toLocaleString()}</div>
                      <div className="small">до {new Date(s.ends_at).toLocaleString()}</div>
                    </div>
                    <button className="btn btnPrimary" onClick={() => book(s.id)} disabled={bookingId === s.id}>
                      {bookingId === s.id ? 'Бронируем…' : 'Записаться'}
                    </button>
                  </div>
                ))
              )}
            </div>

            {slots.length > 12 && <div className="footerNote">Показаны первые 12 слотов. Остальные доступны в календаре выше.</div>}
            <div className="footerNote">После брони комната урока создаётся, но вход лучше делать из раздела “Занятия” в нужное время.</div>
            {bookingSuccess && <div className="footerNote" style={{ color: 'var(--success, #166534)' }}>{bookingSuccess.message}</div>}
            {err && <div className="footerNote">{err}</div>}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="panelTitle">
          <div style={{ fontWeight: 900, fontSize: 18 }}>Отзывы</div>
          <div className="small">{reviews.length}</div>
        </div>

        <ReviewSummary reviews={reviews} tutor={tutor} />

        {reviews.length === 0 ? (
          <div className="small" style={{ marginTop: 12 }}>Пока нет отзывов. Они появляются после завершённого занятия.</div>
        ) : (
          <div className="grid" style={{ gap: 10, marginTop: 12 }}>
            {reviews.slice(0, 20).map(r => (
              <div key={r.id} className="reviewCard">
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ fontWeight: 800 }}><Stars n={r.stars} /> {r.stars}★</div>
                  <div className="small">{new Date(r.created_at).toLocaleDateString()}</div>
                </div>
                <div className="small" style={{ marginTop: 4 }}>{r.student_hint}</div>
                <div style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{r.text || 'Без комментария.'}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
