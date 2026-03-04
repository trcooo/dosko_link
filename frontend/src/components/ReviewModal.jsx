import React, { useEffect, useState } from 'react'
import { apiFetch } from '../api'

function StarsPicker({ value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      {[1,2,3,4,5].map(n => (
        <button
          key={n}
          className={`btn ${value === n ? 'btnPrimary' : ''}`}
          type="button"
          onClick={() => onChange(n)}
          aria-label={`${n} звезд`}
        >
          {n}★
        </button>
      ))}
      <div className="small" style={{ marginLeft: 6 }}>Выбрано: {value}★</div>
    </div>
  )
}

export default function ReviewModal({ open, bookingId, token, onClose, onSubmitted }) {
  const [loading, setLoading] = useState(false)
  const [existing, setExisting] = useState(null)
  const [stars, setStars] = useState(5)
  const [text, setText] = useState('')
  const [criteria, setCriteria] = useState({ explains_rating: 5, punctuality_rating: 5, materials_rating: 5, result_rating: 5 })
  const [existingDetail, setExistingDetail] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!open || !bookingId) return
    let mounted = true
    setErr('')
    setExisting(null)
    setText('')
    setStars(5)
    setCriteria({ explains_rating: 5, punctuality_rating: 5, materials_rating: 5, result_rating: 5 })
    setExistingDetail(null)

    async function load() {
      setLoading(true)
      try {
        const data = await apiFetch(`/api/bookings/${bookingId}/review`, { token })
        let detail = null
        try { detail = await apiFetch(`/api/bookings/${bookingId}/review/details`, { token }) } catch {}
        if (!mounted) return
        setExisting(data?.review || null)
        setExistingDetail(detail?.detail || null)
      } catch (e) {
        if (mounted) setErr(e.message || 'Ошибка загрузки')
      } finally {
        if (mounted) setLoading(false)
      }
    }

    load()
    return () => { mounted = false }
  }, [open, bookingId, token])

  async function submit() {
    setLoading(true)
    setErr('')
    try {
      await apiFetch(`/api/bookings/${bookingId}/review`, {
        method: 'POST',
        token,
        body: { stars, text }
      })
      try {
        await apiFetch(`/api/bookings/${bookingId}/review/details`, { method: 'POST', token, body: criteria })
      } catch {}
      onSubmitted?.()
      onClose?.()
    } catch (e) {
      setErr(e.message || 'Не удалось отправить отзыв')
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null

  return (
    <div className="modalOverlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className="modalCard">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 18 }}>Отзыв о занятии</div>
            <div className="small">Бронь #{bookingId}</div>
          </div>
          <button className="btn" onClick={onClose}>Закрыть</button>
        </div>

        {loading && <div className="small" style={{ marginTop: 12 }}>Загрузка…</div>}
        {err && <div className="footerNote">{err}</div>}

        {!loading && existing && (
          <div className="card" style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 800 }}>Отзыв уже оставлен</div>
            <div className="small">{existing.stars}★ • {new Date(existing.created_at).toLocaleString()}</div>
            {existingDetail ? (
              <div className="small" style={{ marginTop: 8 }}>
                Критерии: объясняет {existingDetail.explains_rating || '—'}★ • пунктуальность {existingDetail.punctuality_rating || '—'}★ • материалы {existingDetail.materials_rating || '—'}★ • результат {existingDetail.result_rating || '—'}★
                {existingDetail.long_term_student ? ' • долгосрочный ученик' : ''}
              </div>
            ) : null}
            {existing.text ? <div style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{existing.text}</div> : <div className="small" style={{ marginTop: 8 }}>Без текста.</div>}
          </div>
        )}

        {!loading && !existing && (
          <div style={{ marginTop: 12 }}>
            <div className="label">Оценка</div>
            <StarsPicker value={stars} onChange={setStars} />

            <div className="label">Критерии</div>
            <div className="grid" style={{ gap: 10 }}>
              <div>
                <div className="small">Понятно объясняет</div>
                <StarsPicker value={criteria.explains_rating} onChange={(v) => setCriteria(s => ({ ...s, explains_rating: v }))} />
              </div>
              <div>
                <div className="small">Пунктуальность</div>
                <StarsPicker value={criteria.punctuality_rating} onChange={(v) => setCriteria(s => ({ ...s, punctuality_rating: v }))} />
              </div>
              <div>
                <div className="small">Материалы</div>
                <StarsPicker value={criteria.materials_rating} onChange={(v) => setCriteria(s => ({ ...s, materials_rating: v }))} />
              </div>
              <div>
                <div className="small">Результат</div>
                <StarsPicker value={criteria.result_rating} onChange={(v) => setCriteria(s => ({ ...s, result_rating: v }))} />
              </div>
            </div>

            <div className="label">Комментарий (необязательно)</div>
            <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} placeholder="Что было полезно? Что улучшить?" />

            <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
              <button className="btn btnPrimary" onClick={submit} disabled={loading}>Отправить</button>
              <button className="btn" onClick={onClose} disabled={loading}>Отмена</button>
            </div>
            <div className="footerNote">Отзыв можно оставить только после завершения занятия.</div>
          </div>
        )}
      </div>
    </div>
  )
}
