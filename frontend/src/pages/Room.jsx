import React, { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth'
import { apiFetch, apiUrl, apiUpload } from '../api'

import VideoCall from '../components/VideoCall'
import Whiteboard from '../components/Whiteboard'
import Chat from '../components/Chat'
import ReviewModal from '../components/ReviewModal'

export default function Room() {
  const { roomId } = useParams()
  const { token, me } = useAuth()
  const nav = useNavigate()

  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)

  const wbRef = useRef(null)
  const [artifacts, setArtifacts] = useState([])
  const [savingBoard, setSavingBoard] = useState(false)

  const [materials, setMaterials] = useState([])
  const [uploadingFile, setUploadingFile] = useState(false)
  const fileInputRef = useRef(null)

  const [checkin, setCheckin] = useState(null)
  const [savingCheckin, setSavingCheckin] = useState(false)

  async function loadInfo() {
    if (!token) return
    setLoading(true)
    setErr('')
    try {
      const data = await apiFetch(`/api/rooms/${encodeURIComponent(roomId)}`, { token })
      setInfo(data)
      if (data?.booking?.id) {
        try {
          const arts = await apiFetch(`/api/bookings/${data.booking.id}/artifacts`, { token })
          setArtifacts(Array.isArray(arts) ? arts : [])
        } catch {
          setArtifacts([])
        }

        try {
          const mats = await apiFetch(`/api/bookings/${data.booking.id}/materials`, { token })
          setMaterials(Array.isArray(mats) ? mats : [])
        } catch {
          setMaterials([])
        }

        try {
          const c = await apiFetch(`/api/bookings/${data.booking.id}/checkin`, { token })
          setCheckin(c || null)
        } catch {
          setCheckin(null)
        }
      }
    } catch (e) {
      setErr(e.message || 'Нет доступа к комнате')
      setInfo(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!token) return
    loadInfo()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, roomId])

  async function completeLesson() {
    if (!info?.booking?.id) return
    setBusy(true)
    setErr('')
    try {
      await apiFetch(`/api/bookings/${info.booking.id}/complete`, { method: 'POST', token })
      await loadInfo()
    } catch (e) {
      setErr(e.message || 'Не удалось завершить')
    } finally {
      setBusy(false)
    }
  }

  async function cancelLesson() {
    if (!info?.booking?.id) return
    if (!confirm('Отменить занятие?')) return
    setBusy(true)
    setErr('')
    try {
      await apiFetch(`/api/bookings/${info.booking.id}/cancel`, { method: 'POST', token })
      nav('/dashboard')
    } catch (e) {
      setErr(e.message || 'Не удалось отменить')
    } finally {
      setBusy(false)
    }
  }

  async function saveWhiteboard() {
    if (!info?.booking?.id) return
    const dataUrl = wbRef.current?.exportPngDataUrl?.()
    if (!dataUrl) return
    const base64 = String(dataUrl).split(',')[1] || ''
    if (!base64) return

    setSavingBoard(true)
    setErr('')
    try {
      const arts = await apiFetch(`/api/bookings/${info.booking.id}/artifacts/whiteboard`, {
        method: 'POST',
        token,
        body: { png_base64: base64 }
      })
      setArtifacts(Array.isArray(arts) ? arts : [])
    } catch (e) {
      setErr(e.message || 'Не удалось сохранить доску')
    } finally {
      setSavingBoard(false)
    }
  }

  async function downloadArtifact(a) {
    try {
      const res = await fetch(apiUrl(`/api/artifacts/${a.id}`), {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const ext = a.mime === 'application/pdf' ? 'pdf' : (a.mime === 'image/png' ? 'png' : 'bin')
      const name = `booking-${a.booking_id}-${a.kind}-${a.id}.${ext}`
      const link = document.createElement('a')
      link.href = url
      link.download = name
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setErr(e.message || 'Не удалось скачать')
    }
  }

  async function uploadMaterial() {
    if (!info?.booking?.id) return
    const el = fileInputRef.current
    const file = el?.files?.[0]
    if (!file) return
    setUploadingFile(true)
    setErr('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      const mats = await apiUpload(`/api/bookings/${info.booking.id}/materials`, { token, formData: fd })
      setMaterials(Array.isArray(mats) ? mats : [])
      if (el) el.value = ''
    } catch (e) {
      setErr(e.message || 'Не удалось загрузить файл')
    } finally {
      setUploadingFile(false)
    }
  }

  async function downloadMaterial(m) {
    try {
      const res = await fetch(apiUrl(`/api/materials/${m.id}`), {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = m.name || `material-${m.id}`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      setErr(e.message || 'Не удалось скачать')
    }
  }

  async function saveCheckinQuestions(questions) {
    if (!info?.booking?.id) return
    setSavingCheckin(true)
    setErr('')
    try {
      const c = await apiFetch(`/api/bookings/${info.booking.id}/checkin`, {
        method: 'POST',
        token,
        body: { questions }
      })
      setCheckin(c)
    } catch (e) {
      setErr(e.message || 'Не удалось сохранить мини-тест')
    } finally {
      setSavingCheckin(false)
    }
  }

  async function submitCheckinAnswers(answers) {
    if (!info?.booking?.id) return
    setSavingCheckin(true)
    setErr('')
    try {
      const c = await apiFetch(`/api/bookings/${info.booking.id}/checkin/submit`, {
        method: 'POST',
        token,
        body: { answers }
      })
      setCheckin(c)
    } catch (e) {
      setErr(e.message || 'Не удалось отправить')
    } finally {
      setSavingCheckin(false)
    }
  }

  if (!token) {
    return (
      <div className="card">
        <div style={{ fontWeight: 900, fontSize: 20 }}>Нужен вход</div>
        <div className="sub">Чтобы войти в комнату, сначала авторизуйся.</div>
        <Link className="btn btnPrimary" to="/login">Войти</Link>
      </div>
    )
  }

  if (loading) return <div className="card">Проверяем доступ…</div>

  if (err || !info) {
    return (
      <div className="card">
        <div style={{ fontWeight: 900, fontSize: 20 }}>Комната недоступна</div>
        <div className="sub">{err || 'Нет доступа'}</div>
        <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
          <Link className="btn" to="/dashboard">В кабинет</Link>
          <Link className="btn btnPrimary" to="/">К поиску</Link>
        </div>
      </div>
    )
  }

  const b = info.booking
  const starts = b.slot_starts_at ? new Date(b.slot_starts_at).toLocaleString() : ''
  const ends = b.slot_ends_at ? new Date(b.slot_ends_at).toLocaleString() : ''
  const isDone = ['done', 'completed'].includes(String(b.status))
  const isCancelled = String(b.status) === 'cancelled'
  const canAct = !isCancelled

  const counterpart = me?.role === 'tutor' ? info.student_email_masked : info.tutor_email_masked

  const canUseLearning = !isCancelled

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 20 }}>Комната урока</div>
            <div className="small">
              room_id: {roomId} • статус: <b>{b.status}</b> • вы: {me?.email} • второй участник: {counterpart}
            </div>
            {(starts || ends) && (
              <div className="small">Время: {starts}{ends ? ` — ${ends}` : ''}</div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Link className="btn" to="/dashboard">В кабинет</Link>
            <Link className="btn" to="/">К поиску</Link>
            {canAct && !isDone && (
              <button className="btn" onClick={cancelLesson} disabled={busy}>Отменить</button>
            )}
            {canAct && !isDone && (
              <button className="btn btnPrimary" onClick={completeLesson} disabled={busy}>Завершить занятие</button>
            )}
            {isDone && me?.role !== 'tutor' && (
              <button className="btn btnPrimary" onClick={() => setReviewOpen(true)}>Оставить отзыв</button>
            )}
          </div>
        </div>
        {err && <div className="footerNote">{err}</div>}
      </div>

      {isCancelled && (
        <div className="card">
          <div style={{ fontWeight: 900 }}>Занятие отменено</div>
          <div className="small">Комната остаётся доступной участникам, но созвон/доску лучше не использовать для отменённого слота.</div>
        </div>
      )}

      <div className="room">
        <div className="card">
          <div className="panelTitle">
            <div style={{ fontWeight: 900 }}>Мини-тест перед уроком</div>
            <div className="small">Вопросы от репетитора → ответы ученика</div>
          </div>
          {!canUseLearning ? (
            <div className="small">Недоступно для отменённого занятия.</div>
          ) : (
            <CheckinPanel
              me={me}
              checkin={checkin}
              saving={savingCheckin}
              onSaveQuestions={saveCheckinQuestions}
              onSubmitAnswers={submitCheckinAnswers}
            />
          )}
        </div>

        <div className="card">
          <div className="panelTitle">
            <div style={{ fontWeight: 900 }}>Созвон</div>
            <div className="small">1:1 WebRTC</div>
          </div>
          <VideoCall roomId={roomId} token={token} />
        </div>

        <div className="card">
          <div className="panelTitle">
            <div style={{ fontWeight: 900 }}>Чат</div>
            <div className="small">/ws/chat</div>
          </div>
          <Chat roomId={roomId} token={token} me={me} />
        </div>

        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="panelTitle">
            <div style={{ fontWeight: 900 }}>Доска</div>
            <div className="small" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>/ws/whiteboard</span>
              <button className="btn" onClick={saveWhiteboard} disabled={savingBoard}>{savingBoard ? 'Сохраняем…' : 'Сохранить доску (PNG+PDF)'}</button>
            </div>
          </div>
          <Whiteboard ref={wbRef} roomId={roomId} token={token} />

          <div style={{ marginTop: 10 }}>
            <div className="label">Материалы занятия</div>
            <div className="sub">Экспорт доски создаёт PNG+PDF. Файлы можно прикрепить ниже.</div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', margin: '10px 0' }}>
              <input ref={fileInputRef} type="file" />
              <button className="btn" onClick={uploadMaterial} disabled={uploadingFile || !canUseLearning}>
                {uploadingFile ? 'Загружаем…' : 'Прикрепить файл'}
              </button>
              <span className="small">(до 7MB)</span>
            </div>

            {(artifacts.length === 0 && materials.length === 0) ? (
              <div className="small">Пока нет материалов.</div>
            ) : (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {artifacts.map(a => (
                  <button key={`a-${a.id}`} className="btn" onClick={() => downloadArtifact(a)}>
                    {a.kind} • {new Date(a.created_at).toLocaleString()}
                  </button>
                ))}
                {materials.map(m => (
                  <button key={`m-${m.id}`} className="btn" onClick={() => downloadMaterial(m)}>
                    файл: {m.name} • {new Date(m.created_at).toLocaleString()}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="footerNote">
        Подсказка: открой эту комнату на втором устройстве/в другом браузере под другим аккаунтом, чтобы протестировать созвон и доску.
      </div>

      <ReviewModal
        open={reviewOpen}
        bookingId={b.id}
        token={token}
        onClose={() => setReviewOpen(false)}
        onSubmitted={() => loadInfo()}
      />
    </div>
  )
}

function CheckinPanel({ me, checkin, saving, onSaveQuestions, onSubmitAnswers }) {
  const isTutor = me?.role === 'tutor'
  const [qs, setQs] = useState(['', '', ''])
  const [ans, setAns] = useState([])

  useEffect(() => {
    if (!checkin) return
    const q = Array.isArray(checkin.questions) ? checkin.questions : []
    const a = Array.isArray(checkin.answers) ? checkin.answers : []
    if (q.length > 0) {
      const q3 = [...q]
      while (q3.length < 3) q3.push('')
      setQs(q3.slice(0, 10))
    }
    setAns(a)
  }, [checkin])

  if (!checkin) return <div className="small">Загружаем…</div>

  const questions = Array.isArray(checkin.questions) ? checkin.questions : []
  const answers = Array.isArray(checkin.answers) ? checkin.answers : []
  const hasQuestions = questions.length > 0 && String(questions[0] || '').trim()

  return (
    <div className="grid" style={{ gap: 10 }}>
      {isTutor ? (
        <>
          <div className="small">Заполни 3–5 вопросов. После сохранения ученик увидит их и сможет отправить ответы.</div>
          {(qs || []).map((v, idx) => (
            <div key={idx}>
              <div className="label">Вопрос {idx + 1}</div>
              <input className="input" value={v} onChange={(e) => {
                const next = [...qs]
                next[idx] = e.target.value
                setQs(next)
              }} placeholder="Например: Реши 2x+3=11" />
            </div>
          ))}
          <button className="btn btnPrimary" onClick={() => onSaveQuestions(qs.filter(x => String(x).trim()))} disabled={saving}>
            {saving ? 'Сохраняем…' : 'Сохранить вопросы'}
          </button>
          {checkin.submitted_at && (
            <div className="card">
              <div style={{ fontWeight: 800 }}>Ответы ученика</div>
              {questions.map((q, i) => (
                <div key={i} className="small" style={{ marginTop: 8 }}>
                  <div><b>Q{i + 1}:</b> {q}</div>
                  <div><b>A{i + 1}:</b> {answers[i] || ''}</div>
                </div>
              ))}
              <div className="small" style={{ marginTop: 8 }}>Отправлено: {new Date(checkin.submitted_at).toLocaleString()}</div>
            </div>
          )}
        </>
      ) : (
        <>
          {!hasQuestions ? (
            <div className="small">Репетитор ещё не добавил вопросы.</div>
          ) : (
            <>
              <div className="small">Ответь кратко — репетитор увидит ответы до занятия.</div>
              {questions.map((q, i) => (
                <div key={i}>
                  <div className="label">{q}</div>
                  <textarea className="textarea" value={ans[i] || ''} onChange={(e) => {
                    const next = [...ans]
                    next[i] = e.target.value
                    setAns(next)
                  }} placeholder="Твой ответ…" />
                </div>
              ))}
              <button className="btn btnPrimary" onClick={() => onSubmitAnswers(ans)} disabled={saving}>
                {saving ? 'Отправляем…' : (checkin.submitted_at ? 'Обновить ответы' : 'Отправить ответы')}
              </button>
              {checkin.submitted_at && <div className="small">Последняя отправка: {new Date(checkin.submitted_at).toLocaleString()}</div>}
            </>
          )}
        </>
      )}
    </div>
  )
}
