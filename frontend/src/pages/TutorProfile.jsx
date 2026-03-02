import React, { useEffect, useState } from 'react'
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

  async function book(slotId) {
    if (!token) return nav('/login')
    if (me?.role === 'tutor') return setErr('Репетитор не может бронировать слоты. Войдите как ученик.')
    setBookingId(slotId)
    setErr('')
    try {
      const b = await apiFetch(`/api/slots/${slotId}/book`, { method: 'POST', token })
      nav(`/room/${b.room_id}`)
    } catch (e) {
      setErr(e.message || 'Ошибка бронирования')
    } finally {
      setBookingId(null)
    }
  }

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
            <div style={{ fontWeight: 900, fontSize: 18 }}>Свободные слоты</div>
            <div className="small">{slots.length} доступно</div>
          </div>

          <div className="grid" style={{ gap: 10 }}>
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
                </div>
              ))
            )}
          </div>

          <div className="footerNote">После брони откроется комната урока: созвон, чат и доска.</div>
          {err && <div className="footerNote">{err}</div>}
        </div>
      </div>

      <div className="card">
        <div className="panelTitle">
          <div style={{ fontWeight: 900, fontSize: 18 }}>Отзывы</div>
          <div className="small">{reviews.length}</div>
        </div>
        {reviews.length === 0 ? (
          <div className="small">Пока нет отзывов. Они появляются после завершённого занятия.</div>
        ) : (
          <div className="grid" style={{ gap: 10 }}>
            {reviews.slice(0, 20).map(r => (
              <div key={r.id} className="card" style={{ border: '1px solid var(--border)' }}>
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
