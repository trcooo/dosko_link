import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../api'

function initials(name) {
  const s = (name || '').trim()
  if (!s) return 'DL'
  const parts = s.split(/\s+/).slice(0,2)
  return parts.map(p => p[0]?.toUpperCase()).join('')
}

export default function Home() {
  const [q, setQ] = useState('')
  const [subject, setSubject] = useState('')
  const [loading, setLoading] = useState(true)
  const [tutors, setTutors] = useState([])
  const [err, setErr] = useState('')

  const subjectOptions = useMemo(() => [
    '', 'математика', 'английский', 'физика', 'химия', 'русский', 'программирование'
  ], [])

  async function load() {
    setLoading(true)
    setErr('')
    try {
      const params = new URLSearchParams()
      if (q.trim()) params.set('q', q.trim())
      if (subject) params.set('subject', subject)
      const data = await apiFetch(`/api/tutors?${params.toString()}`)
      setTutors(Array.isArray(data) ? data : [])
    } catch (e) {
      setErr(e.message || 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  return (
    <div className="grid grid2">
      <div className="card">
        <h1 className="h1">Репетитор + доска + созвон — в одной платформе</h1>
        <div className="sub">Найти → записаться → провести занятие (видео/чат/доска) → отзыв. В MVP оплаты нет, но уроки проходят прямо здесь.</div>
        <div className="kpiRow">
          <div className="kpi">WebRTC созвон</div>
          <div className="kpi">Доска в реальном времени</div>
          <div className="kpi">Слоты и бронирование</div>
          <div className="kpi">Отзывы после занятия</div>
        </div>

        <div style={{ marginTop: 16 }} className="card">
          <div className="row">
            <div style={{ flex: 1 }}>
              <div className="label">Поиск</div>
              <input className="input" value={q} onChange={e => setQ(e.target.value)} placeholder="Например: ЕГЭ математика, разговорный, олимпиада" />
            </div>
            <div style={{ width: 260 }}>
              <div className="label">Предмет</div>
              <select className="select" value={subject} onChange={e => setSubject(e.target.value)}>
                {subjectOptions.map(s => (
                  <option key={s} value={s}>{s ? s : 'Любой'}</option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button className="btn btnPrimary" onClick={load}>Найти репетитора</button>
            <button className="btn" onClick={() => { setQ(''); setSubject(''); setTimeout(load, 0) }}>Сбросить</button>
          </div>
          {err && <div className="footerNote">{err}</div>}
        </div>
      </div>

      <div className="card">
        <div className="panelTitle">
          <div style={{ fontWeight: 800 }}>Репетиторы</div>
          <div className="small">{loading ? 'загрузка…' : `${tutors.length} найдено`}</div>
        </div>

        <div className="grid" style={{ gap: 12 }}>
          {loading ? (
            <div className="small">Загрузка списка…</div>
          ) : tutors.length === 0 ? (
            <div className="small">Пока нет опубликованных профилей. Зайди как репетитор и опубликуй профиль.</div>
          ) : (
            tutors.map(t => (
              <Link key={t.id} to={`/tutor/${t.id}`} className="card">
                <div className="tutorCard">
                  <div className="avatar">{initials(t.display_name)}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ fontWeight: 800 }}>{t.display_name}</div>
                      <div className="small">★ {t.rating_avg.toFixed(1)} ({t.rating_count})</div>
                    </div>
                    <div className="small">Язык: {t.language} • Стоимость: {t.price_per_hour} / час (пока без оплат)</div>
                    <div className="pills">
                      {(t.subjects || []).slice(0, 6).map(s => <span key={s} className="pill">{s}</span>)}
                    </div>
                    {t.bio && <div className="small" style={{ marginTop: 8 }}>{t.bio.slice(0, 110)}{t.bio.length > 110 ? '…' : ''}</div>}
                  </div>
                </div>
              </Link>
            ))
          )}
        </div>

        <div className="footerNote">
          Подсказка: репетитору нужно заполнить профиль и нажать “Опубликовать”, чтобы появиться в поиске.
        </div>
      </div>
    </div>
  )
}
