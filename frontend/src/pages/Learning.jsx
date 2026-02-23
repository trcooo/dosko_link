import React, { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth'
import { apiFetch, apiUrl } from '../api'

function fmt(dt) {
  if (!dt) return ''
  try { return new Date(dt).toLocaleString() } catch { return String(dt) }
}

export default function Learning() {
  const { me, token, loading: authLoading } = useAuth()
  const nav = useNavigate()

  const [tab, setTab] = useState('homework')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const [students, setStudents] = useState([])
  const [homework, setHomework] = useState([])
  const [progress, setProgress] = useState([])
  const [materials, setMaterials] = useState([])

  // Create homework (tutor)
  const [hwStudentId, setHwStudentId] = useState('')
  const [hwTitle, setHwTitle] = useState('')
  const [hwDesc, setHwDesc] = useState('')
  const [hwDue, setHwDue] = useState('')

  // Progress management (tutor)
  const [progStudentId, setProgStudentId] = useState('')
  const [topic, setTopic] = useState('')
  const [topicStatus, setTopicStatus] = useState('todo')
  const [topicNote, setTopicNote] = useState('')

  useEffect(() => {
    if (authLoading) return
    if (!me) nav('/login')
  }, [authLoading, me, nav])

  const isTutor = me?.role === 'tutor'

  async function loadBase() {
    if (!token || !me) return
    setErr('')
    try {
      if (isTutor) {
        const s = await apiFetch('/api/progress/students', { token })
        setStudents(Array.isArray(s) ? s : [])
        if (!hwStudentId && Array.isArray(s) && s[0]?.id) setHwStudentId(String(s[0].id))
        if (!progStudentId && Array.isArray(s) && s[0]?.id) setProgStudentId(String(s[0].id))
      }
    } catch (e) {
      setErr(e.message || 'Ошибка загрузки')
    }
  }

  async function loadHomework() {
    if (!token) return
    setErr('')
    try {
      const rows = await apiFetch('/api/homework', { token })
      setHomework(Array.isArray(rows) ? rows : [])
    } catch (e) {
      setErr(e.message || 'Не удалось загрузить домашку')
    }
  }

  async function loadProgress() {
    if (!token || !me) return
    setErr('')
    try {
      if (isTutor) {
        if (!progStudentId) { setProgress([]); return }
        const rows = await apiFetch(`/api/progress/student/${Number(progStudentId)}`, { token })
        setProgress(Array.isArray(rows) ? rows : [])
      } else {
        const rows = await apiFetch('/api/progress/mine', { token })
        setProgress(Array.isArray(rows) ? rows : [])
      }
    } catch (e) {
      setErr(e.message || 'Не удалось загрузить прогресс')
    }
  }

  async function loadMaterials() {
    if (!token) return
    setErr('')
    try {
      const rows = await apiFetch('/api/materials', { token })
      setMaterials(Array.isArray(rows) ? rows : [])
    } catch (e) {
      setErr(e.message || 'Не удалось загрузить материалы')
    }
  }

  useEffect(() => {
    if (!token || !me) return
    loadBase()
    loadHomework()
    loadProgress()
    loadMaterials()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, me])

  useEffect(() => {
    if (tab === 'homework') loadHomework()
    if (tab === 'progress') loadProgress()
    if (tab === 'materials') loadMaterials()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  useEffect(() => {
    if (tab === 'progress') loadProgress()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progStudentId])

  const studentOptions = useMemo(() => {
    return (students || []).map(s => ({ value: String(s.id), label: `${s.hint} (#${s.id})` }))
  }, [students])

  async function createHw() {
    if (!hwStudentId || !hwTitle.trim()) return
    setBusy(true)
    setErr('')
    try {
      const due_at = hwDue ? new Date(hwDue).toISOString() : null
      await apiFetch('/api/homework', {
        method: 'POST',
        token,
        body: {
          student_user_id: Number(hwStudentId),
          title: hwTitle.trim(),
          description: hwDesc || '',
          due_at
        }
      })
      setHwTitle('')
      setHwDesc('')
      setHwDue('')
      await loadHomework()
    } catch (e) {
      setErr(e.message || 'Не удалось создать')
    } finally {
      setBusy(false)
    }
  }

  async function submitHw(id, text) {
    setBusy(true)
    setErr('')
    try {
      await apiFetch(`/api/homework/${id}/submit`, { method: 'POST', token, body: { submission_text: text || '' } })
      await loadHomework()
    } catch (e) {
      setErr(e.message || 'Не удалось сдать')
    } finally {
      setBusy(false)
    }
  }

  async function checkHw(id, text) {
    setBusy(true)
    setErr('')
    try {
      await apiFetch(`/api/homework/${id}/check`, { method: 'POST', token, body: { feedback_text: text || '' } })
      await loadHomework()
    } catch (e) {
      setErr(e.message || 'Не удалось проверить')
    } finally {
      setBusy(false)
    }
  }

  async function saveTopic() {
    if (!progStudentId || !topic.trim()) return
    setBusy(true)
    setErr('')
    try {
      await apiFetch(`/api/progress/student/${Number(progStudentId)}`, {
        method: 'POST',
        token,
        body: { topic: topic.trim(), status: topicStatus, note: topicNote || '' }
      })
      setTopic('')
      setTopicNote('')
      await loadProgress()
    } catch (e) {
      setErr(e.message || 'Не удалось сохранить')
    } finally {
      setBusy(false)
    }
  }

  async function downloadMaterial(m) {
    try {
      const res = await fetch(apiUrl(`/api/materials/${m.id}`), { headers: { Authorization: `Bearer ${token}` } })
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

  if (!me) return null

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 22 }}>Учёба</div>
            <div className="small">Домашка • прогресс по темам • материалы</div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Link className="btn" to="/dashboard">В кабинет</Link>
            <button className="btn" onClick={() => { loadHomework(); loadProgress(); loadMaterials(); }}>Обновить</button>
          </div>
        </div>
        {err && <div className="footerNote">{err}</div>}

        <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
          <button className={tab === 'homework' ? 'btn btnPrimary' : 'btn'} onClick={() => setTab('homework')}>Домашка</button>
          <button className={tab === 'progress' ? 'btn btnPrimary' : 'btn'} onClick={() => setTab('progress')}>Прогресс</button>
          <button className={tab === 'materials' ? 'btn btnPrimary' : 'btn'} onClick={() => setTab('materials')}>Материалы</button>
        </div>
      </div>

      {tab === 'homework' && (
        <div className="card">
          <div style={{ fontWeight: 900, fontSize: 18 }}>Домашка</div>
          <div className="sub">В MVP — текстовая сдача и проверка. Файлы можно прикреплять в комнате урока (Материалы занятия).</div>

          {isTutor && (
            <div className="card" style={{ marginTop: 10 }}>
              <div style={{ fontWeight: 800 }}>Выдать домашку</div>
              <div className="row" style={{ gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div className="label">Ученик</div>
                  <select className="select" value={hwStudentId} onChange={(e) => setHwStudentId(e.target.value)}>
                    {studentOptions.length === 0 ? <option value="">Нет учеников</option> : studentOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div style={{ width: 260 }}>
                  <div className="label">Дедлайн (опционально)</div>
                  <input className="input" type="datetime-local" value={hwDue} onChange={(e) => setHwDue(e.target.value)} />
                </div>
              </div>
              <div className="label">Заголовок</div>
              <input className="input" value={hwTitle} onChange={(e) => setHwTitle(e.target.value)} placeholder="Например: Уравнения — 10 задач" />
              <div className="label">Описание</div>
              <textarea className="textarea" value={hwDesc} onChange={(e) => setHwDesc(e.target.value)} placeholder="Что сделать, как оформить, на что обратить внимание…" />
              <button className="btn btnPrimary" onClick={createHw} disabled={busy || studentOptions.length === 0}>
                {busy ? 'Сохраняем…' : 'Выдать'}
              </button>
            </div>
          )}

          <div className="label" style={{ marginTop: 12 }}>Список</div>
          {homework.length === 0 ? (
            <div className="small">Пока нет заданий.</div>
          ) : (
            <div className="grid" style={{ gap: 10 }}>
              {homework.map(h => (
                <HomeworkCard key={h.id} h={h} me={me} onSubmit={submitHw} onCheck={checkHw} busy={busy} />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'progress' && (
        <div className="card">
          <div style={{ fontWeight: 900, fontSize: 18 }}>Прогресс по темам</div>
          <div className="sub">Статусы: todo → in_progress → done. Репетитор ведёт прогресс по ученику.</div>

          {isTutor && (
            <div className="card" style={{ marginTop: 10 }}>
              <div style={{ fontWeight: 800 }}>Ученик</div>
              <select className="select" value={progStudentId} onChange={(e) => setProgStudentId(e.target.value)}>
                {studentOptions.length === 0 ? <option value="">Нет учеников</option> : studentOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>

              <div style={{ marginTop: 10, fontWeight: 800 }}>Добавить / обновить тему</div>
              <div className="row" style={{ gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div className="label">Тема</div>
                  <input className="input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Например: Квадратные уравнения" />
                </div>
                <div style={{ width: 220 }}>
                  <div className="label">Статус</div>
                  <select className="select" value={topicStatus} onChange={(e) => setTopicStatus(e.target.value)}>
                    <option value="todo">todo</option>
                    <option value="in_progress">in_progress</option>
                    <option value="done">done</option>
                  </select>
                </div>
              </div>
              <div className="label">Заметка</div>
              <input className="input" value={topicNote} onChange={(e) => setTopicNote(e.target.value)} placeholder="Коротко: что получается/что повторить" />
              <button className="btn btnPrimary" onClick={saveTopic} disabled={busy || !progStudentId}>{busy ? 'Сохраняем…' : 'Сохранить'} </button>
            </div>
          )}

          <div className="label" style={{ marginTop: 12 }}>Темы</div>
          {progress.length === 0 ? (
            <div className="small">Пока пусто.</div>
          ) : (
            <div className="grid" style={{ gap: 10 }}>
              {progress.map(t => (
                <div key={t.id} className="card">
                  <div style={{ fontWeight: 800 }}>{t.topic}</div>
                  <div className="small">Статус: <b>{t.status}</b> • обновлено: {fmt(t.updated_at)}</div>
                  {t.note && <div className="small">Заметка: {t.note}</div>}
                  {!isTutor && <div className="small">Репетитор: {t.tutor_hint}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'materials' && (
        <div className="card">
          <div style={{ fontWeight: 900, fontSize: 18 }}>Материалы</div>
          <div className="sub">Здесь — файлы, которые вы прикрепляли в комнатах уроков. Экспорт доски (PNG/PDF) остаётся в “Материалы занятия” внутри комнаты.</div>

          {materials.length === 0 ? (
            <div className="small">Пока нет файлов.</div>
          ) : (
            <div className="grid" style={{ gap: 10 }}>
              {materials.map(m => (
                <div key={m.id} className="card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>{m.name}</div>
                      <div className="small">mime: {m.mime} • {Math.round((m.size_bytes || 0) / 1024)} KB</div>
                      <div className="small">booking: #{m.booking_id} • загружено: {fmt(m.created_at)} • {m.uploader_hint}</div>
                    </div>
                    <button className="btn" onClick={() => downloadMaterial(m)}>Скачать</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="footerNote">Загрузка файлов делается внутри комнаты урока (кнопка “Прикрепить файл”).</div>
        </div>
      )}
    </div>
  )
}

function HomeworkCard({ h, me, onSubmit, onCheck, busy }) {
  const isTutor = me?.role === 'tutor'
  const [submission, setSubmission] = useState(h.submission_text || '')
  const [feedback, setFeedback] = useState(h.feedback_text || '')

  const canSubmit = !isTutor && (h.status === 'assigned' || h.status === 'submitted')
  const canCheck = isTutor && (h.status === 'submitted' || h.status === 'assigned')

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 900 }}>{h.title}</div>
          <div className="small">#{h.id} • статус: <b>{h.status}</b> • создано: {fmt(h.created_at)}{h.due_at ? ` • дедлайн: ${fmt(h.due_at)}` : ''}</div>
          <div className="small">репетитор: {h.tutor_hint} • ученик: {h.student_hint}</div>
        </div>
        {h.booking_id && <div className="small">booking: #{h.booking_id}</div>}
      </div>

      {h.description && (
        <div className="small" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
          {h.description}
        </div>
      )}

      <div className="row" style={{ gap: 12, marginTop: 10, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div className="label">Сдача</div>
          <textarea className="textarea" value={submission} onChange={(e) => setSubmission(e.target.value)} placeholder="Решение/ответ…" disabled={isTutor} />
          <div className="small">submitted_at: {fmt(h.submitted_at)}</div>
          {canSubmit && (
            <button className="btn btnPrimary" onClick={() => onSubmit(h.id, submission)} disabled={busy}>
              {busy ? 'Отправляем…' : 'Сдать'}
            </button>
          )}
        </div>

        <div style={{ flex: 1 }}>
          <div className="label">Проверка</div>
          <textarea className="textarea" value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Комментарий/проверка…" disabled={!isTutor} />
          <div className="small">checked_at: {fmt(h.checked_at)}</div>
          {canCheck && (
            <button className="btn" onClick={() => onCheck(h.id, feedback)} disabled={busy}>
              {busy ? 'Сохраняем…' : 'Отметить проверенным'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
