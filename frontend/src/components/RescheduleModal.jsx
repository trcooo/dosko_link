import React, { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../api'

export default function RescheduleModal({ open, booking, token, onClose, onSubmitted }) {
  const [slots, setSlots] = useState([])
  const [newSlotId, setNewSlotId] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const tutorId = booking?.tutor_user_id
  const currentSlotId = booking?.slot_id

  const options = useMemo(() => {
    return (slots || []).filter(s => String(s.id) !== String(currentSlotId))
  }, [slots, currentSlotId])

  useEffect(() => {
    if (!open || !tutorId) return
    let mounted = true
    setErr('')
    setSlots([])
    setNewSlotId('')

    async function load() {
      setLoading(true)
      try {
        const data = await apiFetch(`/api/slots/available?tutor_user_id=${tutorId}`, { token })
        if (!mounted) return
        setSlots(Array.isArray(data) ? data : [])
      } catch (e) {
        if (mounted) setErr(e.message || 'Не удалось загрузить слоты')
      } finally {
        if (mounted) setLoading(false)
      }
    }

    load()
    return () => { mounted = false }
  }, [open, tutorId, token])

  async function submit() {
    if (!booking?.id) return
    if (!newSlotId) return
    setLoading(true)
    setErr('')
    try {
      await apiFetch(`/api/bookings/${booking.id}/reschedule`, {
        method: 'POST',
        token,
        body: { new_slot_id: Number(newSlotId) }
      })
      onSubmitted?.()
      onClose?.()
    } catch (e) {
      setErr(e.message || 'Не удалось перенести')
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
            <div style={{ fontWeight: 900, fontSize: 18 }}>Перенос занятия</div>
            <div className="small">Бронь #{booking?.id}</div>
          </div>
          <button className="btn" onClick={onClose}>Закрыть</button>
        </div>

        {loading && <div className="small" style={{ marginTop: 12 }}>Загрузка…</div>}
        {err && <div className="footerNote">{err}</div>}

        {!loading && (
          <div style={{ marginTop: 12 }}>
            <div className="label">Новый слот</div>
            {options.length === 0 ? (
              <div className="small">Нет доступных слотов для переноса. Репетитору нужно создать новый слот.</div>
            ) : (
              <select className="select" value={newSlotId} onChange={(e) => setNewSlotId(e.target.value)}>
                <option value="">— выбрать —</option>
                {options.map(s => (
                  <option key={s.id} value={s.id}>
                    #{s.id} • {new Date(s.starts_at).toLocaleString()} — {new Date(s.ends_at).toLocaleString()}
                  </option>
                ))}
              </select>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
              <button className="btn btnPrimary" onClick={submit} disabled={loading || !newSlotId}>Перенести</button>
              <button className="btn" onClick={onClose} disabled={loading}>Отмена</button>
            </div>

            <div className="footerNote">
              Перенос возвращает текущий слот в статус open и бронирует выбранный новый слот.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
