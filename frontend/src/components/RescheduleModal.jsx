import React, { useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../api'

export default function RescheduleModal({ open, booking, token, onClose, onSubmitted }) {
  const [slots, setSlots] = useState([])
  const [newSlotId, setNewSlotId] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [template, setTemplate] = useState('')
  const [note, setNote] = useState('')

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
    setTemplate('')
    setNote('')

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

  async function submitWith({ slotId, tpl = '', noteText = '' } = {}) {
    if (!booking?.id) return
    const targetSlotId = Number(slotId || newSlotId)
    if (!targetSlotId) return
    setLoading(true)
    setErr('')
    try {
      await apiFetch(`/api/bookings/${booking.id}/reschedule`, {
        method: 'POST',
        token,
        body: {
          new_slot_id: targetSlotId,
          template: tpl || template || null,
          note: (noteText || note || '').trim() || null,
        }
      })
      onSubmitted?.()
      onClose?.()
    } catch (e) {
      setErr(e.message || 'Не удалось перенести')
    } finally {
      setLoading(false)
    }
  }

  function findQuickSlot(kind) {
    if (!Array.isArray(options) || options.length === 0) return null
    const src = booking?.slot_starts_at ? new Date(booking.slot_starts_at) : null
    if (!src || Number.isNaN(src.getTime())) return options[0] || null

    const srcMinutes = src.getHours() * 60 + src.getMinutes()
    const tomorrow = new Date(src)
    tomorrow.setDate(src.getDate() + 1)

    const ranked = options
      .map(s => ({ ...s, _d: new Date(s.starts_at) }))
      .filter(s => !Number.isNaN(s._d.getTime()))
      .sort((a, b) => a._d - b._d)

    if (kind === 'tomorrow') {
      const next = ranked
        .filter(s => s._d.toDateString() === tomorrow.toDateString())
        .sort((a, b) => {
          const am = Math.abs((a._d.getHours() * 60 + a._d.getMinutes()) - srcMinutes)
          const bm = Math.abs((b._d.getHours() * 60 + b._d.getMinutes()) - srcMinutes)
          return am - bm
        })[0]
      return next || null
    }

    if (kind === 'cant_today') {
      const todayStr = src.toDateString()
      return ranked.find(s => s._d.toDateString() !== todayStr) || ranked[0] || null
    }

    return ranked[0] || null
  }

  async function quickAction(kind) {
    const labels = {
      tomorrow: 'Перенести на завтра',
      propose_other_time: 'Предложить другое время',
      cant_today: 'Не могу сегодня',
    }
    const defaultNotes = {
      tomorrow: 'Предлагаю перенести занятие на завтра.',
      propose_other_time: 'Могу в другое время, выберите удобный слот.',
      cant_today: 'Не могу сегодня, прошу перенос.',
    }
    setTemplate(kind)
    if (!note) setNote(defaultNotes[kind] || '')

    if (kind === 'propose_other_time') return

    const slot = findQuickSlot(kind)
    if (!slot) {
      setErr('Нет подходящего слота для быстрого переноса. Выберите слот вручную.')
      return
    }
    setNewSlotId(String(slot.id))
    await submitWith({ slotId: slot.id, tpl: kind, noteText: note || defaultNotes[kind] || '' })
  }

  async function submit() {
    await submitWith()
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
            <div className="label">Быстрые шаблоны переноса</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn" onClick={() => quickAction('tomorrow')} disabled={loading || options.length === 0}>Перенести на завтра</button>
              <button className="btn" onClick={() => quickAction('propose_other_time')} disabled={loading}>Предложить другое время</button>
              <button className="btn" onClick={() => quickAction('cant_today')} disabled={loading || options.length === 0}>Не могу сегодня</button>
            </div>

            <div className="label">Комментарий / сообщение</div>
            <input
              className="input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Опционально: короткий комментарий для ученика/репетитора"
            />

            <div className="label">Новый слот</div>
            {options.length === 0 ? (
              <div className="small">Нет доступных слотов для переноса. Репетитору нужно создать новый слот.</div>
            ) : (
              <select className="select" value={newSlotId} onChange={(e) => { setTemplate(template || 'propose_other_time'); setNewSlotId(e.target.value) }}>
                <option value="">— выбрать —</option>
                {options.map(s => (
                  <option key={s.id} value={s.id}>
                    #{s.id} • {new Date(s.starts_at).toLocaleString()} — {new Date(s.ends_at).toLocaleString()}
                  </option>
                ))}
              </select>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
              <button className="btn btnPrimary" onClick={submit} disabled={loading || !newSlotId}>{template === 'propose_other_time' ? 'Отправить предложение' : 'Перенести'}</button>
              <button className="btn" onClick={onClose} disabled={loading}>Отмена</button>
            </div>

            <div className="footerNote">
              Перенос возвращает текущий слот в статус open, бронирует новый слот и сбрасывает подтверждение занятия (нужно подтвердить заново).
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
