import React, { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { apiFetch } from '../api'
import { useAuth } from '../auth.jsx'

function Stars({ n }) {
  const v = Math.max(0, Math.min(5, Number(n || 0)))
  return <span>{'★'.repeat(Math.round(v))}{'☆'.repeat(5 - Math.round(v))}</span>
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
  const [booking, setBooking] = useState(false)

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setErr('')
      try {
        const t = await apiFetch(`/api/tutors/${id}`)
        const s = await apiFetch(`/api/slots/available?tutor_user_id=${t.user_id}`)
        const r = await apiFetch(`/api/tutors/${id}/reviews`)
        if (mounted) {
          setTutor(t)
          setSlots(Array.isArray(s) ? s : [])
          setReviews(Array.isArray(r) ? r : [])
        }
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
    if (!token) {
      nav('/login')
      return
    }
    if (me?.role === 'tutor') {
      setErr('Репетитор не может бронировать слоты. Зайди как ученик.')
      return
    }
    setBooking(true)
    setErr('')
    try {
      const b = await apiFetch(`/api/slots/${slotId}/book`, { method: 'POST', token })
      nav(`/room/${b.room_id}`)
    } catch (e) {
      setErr(e.message || 'Ошибка бронирования')
    } finally {
      setBooking(false)
    }
  }

  if (loading) return <div className="card">Загрузка…</div>
  if (err) return <div className="card">{err}</div>
  if (!tutor) return <div className="card">Не найдено</div>

  return (
    <div className="split">
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 26 }}>{tutor.display_name}</div>
            <div className="small">★ {tutor.rating_avg.toFixed(1)} ({tutor.rating_count}) • язык: {tutor.language}</div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Link className="btn" to="/">Назад</Link>
            <Link className="btn btnPrimary" to="/dashboard">Кабинет</Link>
          </div>
        </div>

        <div className="pills" style={{ marginTop: 12 }}>
          {(tutor.subjects || []).map(s => <span className="pill" key={s}>{s}</span>)}
        </div>

        <div className="sub" style={{ marginTop: 12 }}>{tutor.bio || 'Описание пока не заполнено.'}</div>

        <div className="card" style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 800 }}>Стоимость</div>
          <div className="small">{tutor.price_per_hour} ₽/час. В MVP есть пробный баланс: после брони можно «оплатить с баланса» (это тест, без реальных платежей).</div>
        </div>

        {tutor.video_url && (
          <div className="card" style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 800 }}>Видео-визитка</div>
            <a className="btn" href={tutor.video_url} target="_blank" rel="noreferrer">Открыть</a>
          </div>
        )}

        <div className="card" style={{ marginTop: 14 }}>
          <div className="panelTitle">
            <div style={{ fontWeight: 900 }}>Отзывы</div>
            <div className="small">{reviews.length}</div>
          </div>

          {reviews.length === 0 ? (
            <div className="small">Пока нет отзывов. Они появятся после завершённых занятий.</div>
          ) : (
            <div className="grid" style={{ gap: 10 }}>
              {reviews.slice(0, 12).map(r => (
                <div key={r.id} className="card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ fontWeight: 800 }}><Stars n={r.stars} /> <span className="small">{r.stars}★</span></div>
                    <div className="small">{new Date(r.created_at).toLocaleDateString()}</div>
                  </div>
                  <div className="small" style={{ marginTop: 6 }}>{r.student_hint}</div>
                  {r.text ? <div style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{r.text}</div> : <div className="small" style={{ marginTop: 8 }}>Без комментария.</div>}
                </div>
              ))}
            </div>
          )}
        </div>

        {err && <div className="footerNote">{err}</div>}
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
              <div key={s.id} className="card">
                <div style={{ fontWeight: 800 }}>#{s.id} • {new Date(s.starts_at).toLocaleString()}</div>
                <div className="small">до {new Date(s.ends_at).toLocaleString()}</div>
                <button className="btn btnPrimary" style={{ marginTop: 10 }} onClick={() => book(s.id)} disabled={booking}>
                  {booking ? 'Бронируем…' : 'Забронировать'}
                </button>
              </div>
            ))
          )}
        </div>

        <div className="footerNote">
          После брони откроется комната занятия: созвон + доска + чат.
        </div>
      </div>
    </div>
  )
}
