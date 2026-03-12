import React, { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth.jsx'
import { apiFetch, apiUrl, apiUpload } from '../api'

import VideoCall from '../components/VideoCall'
import Whiteboard from '../components/Whiteboard'
import Chat from '../components/Chat'
import ReviewModal from '../components/ReviewModal'
import RescheduleModal from '../components/RescheduleModal'

export default function Room() {
  const { roomId } = useParams()
  const { token, me, balanceInfo, payBooking, refreshBalance } = useAuth()
  const nav = useNavigate()

  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [rescheduleOpen, setRescheduleOpen] = useState(false)
  const [paying, setPaying] = useState(false)

  const wbRef = useRef(null)
  const [artifacts, setArtifacts] = useState([])
  const [savingBoard, setSavingBoard] = useState(false)

  const [materials, setMaterials] = useState([])
  const [uploadingFile, setUploadingFile] = useState(false)
  const fileInputRef = useRef(null)

  const [checkin, setCheckin] = useState(null)
  const [savingCheckin, setSavingCheckin] = useState(false)
  const [noteDraft, setNoteDraft] = useState({
    lesson_summary: '',
    covered_topics: '',
    repeat_topics: '',
    weak_topics: [],
    homework_assigned: '',
    homework_checked: '',
    tutor_comment_for_parent: '',
  })
  const [attendanceSummary, setAttendanceSummary] = useState(null)
  const [workspaceSnapshots, setWorkspaceSnapshots] = useState([])
  const [autosaveStatus, setAutosaveStatus] = useState('Черновик ещё не сохранён')
  const [autosaveEverySec, setAutosaveEverySec] = useState(30)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [restoringSnapshotId, setRestoringSnapshotId] = useState(null)
  const lastSavedWorkspaceSignatureRef = useRef('')
  const savingWorkspaceRef = useRef(false)
  const workspaceBootstrappedRef = useRef(false)

  function normalizeNoteDraft(raw) {
    return {
      lesson_summary: String(raw?.lesson_summary || ''),
      covered_topics: String(raw?.covered_topics || raw?.lesson_summary || ''),
      repeat_topics: String(raw?.repeat_topics || raw?.homework_checked || ''),
      weak_topics: Array.isArray(raw?.weak_topics) ? raw.weak_topics.map((x) => String(x || '')).filter(Boolean).slice(0, 20) : [],
      homework_assigned: String(raw?.homework_assigned || ''),
      homework_checked: String(raw?.homework_checked || ''),
      tutor_comment_for_parent: String(raw?.tutor_comment_for_parent || ''),
    }
  }

  function workspaceSignature(nextState = null, nextDraft = null) {
    const boardState = nextState ?? (wbRef.current?.exportState?.() || [])
    const notePayload = me?.role === 'student' ? {} : normalizeNoteDraft(nextDraft ?? noteDraft)
    try {
      return JSON.stringify({ boardState, notePayload })
    } catch {
      return `${Array.isArray(boardState) ? boardState.length : 0}:${Object.values(notePayload).join('|')}`
    }
  }

  async function doPay() {
    if (!info?.booking?.id) return
    setErr('')
    setPaying(true)
    try {
      const res = await payBooking(info.booking.id)
      // reload room info to update status
      await loadInfo()
      await refreshBalance?.()
      return res
    } catch (e) {
      setErr(e.message || 'Ошибка оплаты')
    } finally {
      setPaying(false)
    }
  }

  async function setAttendance(status, note = '') {
    if (!info?.booking?.id) return
    setSavingCheckin(true)
    setErr('')
    try {
      await apiFetch(`/api/bookings/${info.booking.id}/attendance`, {
        method: 'POST',
        token,
        body: { status, note: note || null },
      })
      await loadInfo()
    } catch (e) {
      setErr(e.message || 'Не удалось обновить подтверждение')
    } finally {
      setSavingCheckin(false)
    }
  }

  function openLessonInNewTab() {
    const href = `${window.location.origin}/room/${encodeURIComponent(roomId)}`
    window.open(href, '_blank', 'noopener,noreferrer')
  }

  function openHomeworkFlow() {
    nav(`/learning?tab=homework&booking=${info?.booking?.id || ''}`)
  }

  async function copyLessonLink() {
    try {
      const href = `${window.location.origin}/room/${encodeURIComponent(roomId)}`
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(href)
      }
      alert('Ссылка на урок скопирована.')
    } catch {
      alert('Открыл урок в новой вкладке. Скопировать ссылку не удалось автоматически.')
      openLessonInNewTab()
    }
  }

  async function loadInfo() {
    if (!token) return
    setLoading(true)
    setErr('')
    try {
      const data = await apiFetch(`/api/rooms/${encodeURIComponent(roomId)}`, { token })
      setInfo(data)
      setAttendanceSummary(data?.attendance_summary || null)
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

        await loadWorkspace(data.booking.id)
      }
    } catch (e) {
      setErr(e.message || 'Нет доступа к комнате')
      setInfo(null)
    } finally {
      setLoading(false)
    }
  }

  async function refreshAttendanceSummary(bookingId = info?.booking?.id) {
    if (!bookingId || !token) return
    try {
      const data = await apiFetch(`/api/bookings/${bookingId}/room-attendance`, { token })
      setAttendanceSummary(data || null)
    } catch {
      // ignore polling issues
    }
  }

  async function loadWorkspace(bookingId, { preserveDraft = false } = {}) {
    if (!bookingId || !token) return
    try {
      const ws = await apiFetch(`/api/bookings/${bookingId}/lesson-workspace`, { token })
      const nextDraft = normalizeNoteDraft(ws?.note || {})
      const latestSnapshot = ws?.latest_snapshot || null
      setWorkspaceSnapshots(Array.isArray(ws?.snapshots) ? ws.snapshots : [])
      setAutosaveEverySec(Math.max(10, Number(ws?.autosave_interval_sec || 30)))
      if (!preserveDraft) setNoteDraft(nextDraft)
      if (latestSnapshot?.whiteboard_state && !workspaceBootstrappedRef.current) {
        setTimeout(() => {
          try { wbRef.current?.importState?.(latestSnapshot.whiteboard_state || []) } catch {}
        }, 120)
        workspaceBootstrappedRef.current = true
      }
      lastSavedWorkspaceSignatureRef.current = workspaceSignature(latestSnapshot?.whiteboard_state || [], nextDraft)
      setAutosaveStatus(ws?.snapshots?.length ? 'Черновик загружен' : 'История ещё пустая')
    } catch {
      setWorkspaceSnapshots([])
      setAutosaveStatus('История недоступна')
    }
  }

  async function saveWorkspace(kind = 'autosave', { silent = false } = {}) {
    if (!info?.booking?.id || savingWorkspaceRef.current) return null
    const boardState = wbRef.current?.exportState?.() || []
    const draft = normalizeNoteDraft(noteDraft)
    const signature = workspaceSignature(boardState, draft)
    if (kind === 'autosave' && signature === lastSavedWorkspaceSignatureRef.current) return null
    savingWorkspaceRef.current = true
    if (!silent) setAutosaveStatus(kind === 'final' ? 'Сохраняем итог урока…' : 'Сохраняем черновик…')
    try {
      const res = await apiFetch(`/api/bookings/${info.booking.id}/lesson-workspace/autosave`, {
        method: 'POST',
        token,
        body: {
          snapshot_kind: kind,
          whiteboard_state: boardState,
          ...(me?.role === 'student' ? {} : draft),
        }
      })
      lastSavedWorkspaceSignatureRef.current = signature
      if (res?.snapshot) {
        setWorkspaceSnapshots((prev) => [res.snapshot, ...prev.filter((item) => item.id !== res.snapshot.id)].slice(0, 20))
      }
      if (res?.note && me?.role !== 'student') {
        setNoteDraft(normalizeNoteDraft(res.note))
      }
      if (!silent) {
        const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        setAutosaveStatus(kind === 'final' ? `Итог урока сохранён в ${stamp}` : `Черновик сохранён в ${stamp}`)
      }
      return res
    } catch (e) {
      if (!silent) setAutosaveStatus(e.message || 'Не удалось сохранить черновик')
      return null
    } finally {
      savingWorkspaceRef.current = false
    }
  }

  async function restoreWorkspaceSnapshot(snapshotId) {
    if (!snapshotId) return
    setRestoringSnapshotId(snapshotId)
    setErr('')
    try {
      const res = await apiFetch(`/api/lesson-workspace-snapshots/${snapshotId}`, { token })
      const item = res?.item
      if (!item) throw new Error('Снимок не найден')
      if (item.whiteboard_state) wbRef.current?.importState?.(item.whiteboard_state)
      if (me?.role !== 'student') setNoteDraft(normalizeNoteDraft(item))
      lastSavedWorkspaceSignatureRef.current = workspaceSignature(item.whiteboard_state || [], item)
      setAutosaveStatus('Снимок восстановлен. Можно продолжать урок.')
    } catch (e) {
      setErr(e.message || 'Не удалось восстановить снимок')
    } finally {
      setRestoringSnapshotId(null)
    }
  }

  useEffect(() => {
    if (!token) return
    workspaceBootstrappedRef.current = false
    loadInfo()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, roomId])

  async function completeLesson() {
    if (!info?.booking?.id) return
    setBusy(true)
    setErr('')
    try {
      await saveWorkspace('manual', { silent: true })
      await apiFetch(`/api/bookings/${info.booking.id}/complete`, { method: 'POST', token })
      await loadInfo()
      await saveWorkspace('final', { silent: false })
      setSummaryOpen(true)
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



  async function reportIssue() {
    if (!info?.booking?.id) return
    const msg = prompt('Опиши проблему (кратко). Заявка уйдёт админу:')
    if (!msg) return
    setBusy(true)
    setErr('')
    try {
      await apiFetch('/api/reports', {
        method: 'POST',
        token,
        body: { booking_id: info.booking.id, category: 'lesson', message: msg }
      })
      alert('Заявка отправлена админу.')
    } catch (e) {
      setErr(e.message || 'Не удалось отправить')
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

  useEffect(() => {
    if (!token || !info?.booking?.id) return undefined
    refreshAttendanceSummary(info.booking.id)
    const timer = window.setInterval(() => refreshAttendanceSummary(info.booking.id), 15000)
    return () => window.clearInterval(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, info?.booking?.id])

  useEffect(() => {
    if (!token || !info?.booking?.id) return undefined
    const intervalMs = Math.max(10, Number(autosaveEverySec || 30)) * 1000
    const timer = window.setInterval(() => {
      saveWorkspace('autosave', { silent: false })
    }, intervalMs)
    return () => window.clearInterval(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, info?.booking?.id, autosaveEverySec, noteDraft, me?.role])

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
  const canEditLessonNotes = me?.role === 'tutor' || me?.role === 'admin'
  const attendanceReady = me?.role === 'tutor' ? b.tutor_attendance_status : b.student_attendance_status
  const lessonFiles = [
    ...artifacts.map((a) => ({ ...a, previewKind: a.mime === 'application/pdf' ? 'pdf' : (String(a.mime || '').startsWith('image/') ? 'image' : 'file'), sourceKind: 'artifact', title: a.kind })),
    ...materials.map((m) => ({ ...m, previewKind: m.mime === 'application/pdf' ? 'pdf' : (String(m.mime || '').startsWith('image/') ? 'image' : 'file'), sourceKind: 'material', title: m.name })),
  ]
  const lessonHealth = [
    { label: 'Статус урока', value: String(b.status || 'unknown'), tone: isCancelled ? 'bad' : (isDone ? 'ok' : 'neutral') },
    { label: 'Оплата', value: String(b.payment_status || 'unpaid'), tone: b.payment_status === 'paid' ? 'ok' : 'warn' },
    { label: 'Подтверждение', value: String(attendanceReady || 'pending'), tone: attendanceReady === 'confirmed' ? 'ok' : (attendanceReady === 'declined' ? 'bad' : 'warn') },
    { label: 'Материалы', value: `${artifacts.length + materials.length}`, tone: (artifacts.length + materials.length) > 0 ? 'ok' : 'neutral' },
  ]

  return (
    <div className="grid productPage lessonDesignSet" style={{ gap: 12 }}>
      <div className="lessonHeroCard productHeroCard">
        <div className="lessonHeroTop">
          <div>
            <div className="lessonHeroEyebrow">Lesson room</div>
            <div className="lessonHeroTitle">Комната урока</div>
            <div className="small">ID комнаты: {roomId} • вы: {me?.email} • второй участник: {counterpart}</div>
            {(starts || ends) && (
              <div className="small">Время: {starts}{ends ? ` — ${ends}` : ''}</div>
            )}
          </div>
          <div className="lessonHeroActions">
            <Link className="btn" to="/dashboard">В кабинет</Link>
            <Link className="btn" to="/">К поиску</Link>
            <button className="btn" onClick={reportIssue} disabled={busy}>Проблема</button>
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

        <div className="lessonHeroStats">
          {lessonHealth.map((item) => (
            <div key={item.label} className={`lessonStatCard ${item.tone || ''}`}>
              <div className="small">{item.label}</div>
              <div className="lessonStatValue">{item.value}</div>
            </div>
          ))}
        </div>

        <div className="lessonChecklist">
          <div className="lessonChecklistItem"><span>1</span>Проверь камеру и микрофон перед началом.</div>
          <div className="lessonChecklistItem"><span>2</span>Заполни мини-тест перед разбором новой темы.</div>
          <div className="lessonChecklistItem"><span>3</span>Сохрани доску и прикрепи материалы к уроку или домашке.</div>
        </div>

        <div className="lessonPresencePanel">
          <div className="panelTitle">
            <div>
              <div style={{ fontWeight: 900 }}>Attendance / show-rate</div>
              <div className="small">Кто вошёл в комнату, кто опоздал, кто ещё не подключился.</div>
            </div>
            <button className="btn btnGhost" onClick={() => refreshAttendanceSummary()}>Обновить</button>
          </div>
          <div className="lessonPresenceStats">
            <div className="lessonSummaryMiniCard"><div className="small">Show-rate</div><div style={{ fontWeight: 900 }}>{attendanceSummary?.show_rate_percent ?? 0}%</div></div>
            <div className="lessonSummaryMiniCard"><div className="small">Опозданий</div><div style={{ fontWeight: 900 }}>{attendanceSummary?.late_count ?? 0}</div></div>
            <div className="lessonSummaryMiniCard"><div className="small">Слабая сеть</div><div style={{ fontWeight: 900 }}>{attendanceSummary?.weak_network_count ?? 0}</div></div>
            <div className="lessonSummaryMiniCard"><div className="small">Audio fallback</div><div style={{ fontWeight: 900 }}>{attendanceSummary?.audio_only_count ?? 0}</div></div>
          </div>
          <div className="lessonPresenceGrid">
            {(attendanceSummary?.participants || []).map((participant) => (
              <div key={participant.role} className={`lessonPresenceItem ${participant.status || ''}`}>
                <div>
                  <div style={{ fontWeight: 900 }}>{participant.role === 'tutor' ? 'Репетитор' : 'Ученик'}</div>
                  <div className="small">
                    {participant.joined ? `Вошёл: ${participant.first_join_at ? new Date(participant.first_join_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'да'}` : 'Ещё не вошёл'}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="lessonPresenceBadge">{participant.status === 'late' ? 'Опоздал' : participant.status === 'absent' ? 'Не пришёл' : participant.status === 'on_time' ? 'Вовремя' : participant.status === 'not_joined_yet' ? 'Ждём' : 'Ожидание'}</div>
                  <div className="small">late: {participant.lateness_min ?? 0} мин • reconnect: {participant.reconnect_count ?? 0}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="lessonInlineActionBar productActionBar">
          {!isCancelled && !isDone && (me?.role === 'student' || me?.role === 'tutor') && (
            <button className="btn btnPrimary" onClick={() => setAttendance('confirmed')} disabled={savingCheckin}>
              {savingCheckin ? 'Сохраняем…' : '✅ Подтвердить участие'}
            </button>
          )}
          <button className="btn" onClick={openLessonInNewTab}>🔗 Открыть урок</button>
          <button className="btn" onClick={openHomeworkFlow} disabled={!canUseLearning}>📚 Отправить ДЗ</button>
          {!isCancelled && !isDone && (
            <button className="btn" onClick={() => setRescheduleOpen(true)} disabled={busy}>🕒 Запросить перенос</button>
          )}
          <button className="btn" onClick={copyLessonLink}>📎 Скопировать ссылку</button>
        </div>

        {err && <div className="footerNote">{err}</div>}
      </div>

      {isCancelled && (
        <div className="card">
          <div style={{ fontWeight: 900 }}>Занятие отменено</div>
          <div className="small">Комната остаётся доступной участникам, но созвон/доску лучше не использовать для отменённого слота.</div>
        </div>
      )}


      <div className="card productSectionCard">
        <div className="panelTitle">
          <div style={{ fontWeight: 900 }}>Оплата занятия (пробно)</div>
          <div className="small">Реальных платежей пока нет — это тестовый баланс для MVP.</div>
        </div>

        {info?.booking ? (
          <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="kpi">
              <div className="small">Стоимость</div>
              <div style={{ fontWeight: 900, fontSize: 18 }}>{info.booking.price || 0} ₽</div>
            </div>
            <div className="kpi">
              <div className="small">Статус</div>
              <div style={{ fontWeight: 900, fontSize: 18 }}>{info.booking.payment_status || 'unpaid'}</div>
            </div>
            {me?.role === 'student' && (
              <div className="kpi">
                <div className="small">Ваш баланс</div>
                <div style={{ fontWeight: 900, fontSize: 18 }}>{balanceInfo?.balance ?? '—'} ₽</div>
              </div>
            )}

            <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {me?.role === 'student' && (info.booking.payment_status !== 'paid') && (
                <button className="btn btnPrimary" disabled={paying || !canUseLearning} onClick={doPay}>
                  {paying ? 'Оплачиваем…' : 'Оплатить с баланса'}
                </button>
              )}
              {info.booking.payment_status === 'paid' && (
                <div className="small">Оплачено ✔</div>
              )}
              <Link className="btn" to="/wallet">Баланс</Link>
            </div>
          </div>
        ) : (
          <div className="small">Нет данных по бронированию.</div>
        )}
      </div>

      {me?.role === 'student' && info?.tutor_payment_method && (
        <div className="card">
          <div className="panelTitle">
            <div style={{ fontWeight: 900 }}>Оплата напрямую репетитору</div>
            <div className="small">MVP без встроенных оплат</div>
          </div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{info.tutor_payment_method}</div>
          <div className="footerNote">Показывается только после бронирования (в комнате занятия).</div>
        </div>
      )}

      <div className="room lessonRoomGrid">
        <div className="card lessonPanelCard productSectionCard">
          <div className="panelTitle">
            <div>
              <div style={{ fontWeight: 900 }}>Мини-тест перед уроком</div>
              <div className="small">Вопросы от репетитора → ответы ученика</div>
            </div>
            <div className="lessonPanelBadge">Разогрев</div>
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

        <div className="card lessonPanelCard productSectionCard">
          <div className="panelTitle">
            <div>
              <div style={{ fontWeight: 900 }}>Созвон</div>
              <div className="small">1:1 WebRTC • переключение устройств • индикатор микрофона</div>
            </div>
            <div className="lessonPanelBadge">Live</div>
          </div>
          <VideoCall roomId={roomId} token={token} observerMode={me?.role === 'admin'} />
        </div>

        <div className="card lessonPanelCard productSectionCard">
          <div className="panelTitle">
            <div>
              <div style={{ fontWeight: 900 }}>Чат урока</div>
              <div className="small">Быстрые сообщения и заметки по ходу урока</div>
            </div>
            <div className="lessonPanelBadge">Sync</div>
          </div>
          <Chat roomId={roomId} token={token} me={me} />
        </div>

        <div className="card lessonPanelCard productSectionCard" style={{ gridColumn: '1 / -1' }}>
          <div className="panelTitle">
            <div>
              <div style={{ fontWeight: 900 }}>Интерактивная доска</div>
              <div className="small">Цвета, фото, фон, сетка и быстрый экспорт в материалы урока</div>
            </div>
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

            {lessonFiles.length === 0 ? (
              <div className="small">Пока нет материалов.</div>
            ) : (
              <FilePreviewGallery
                items={lessonFiles}
                token={token}
                onDownload={(item) => item.sourceKind === 'artifact' ? downloadArtifact(item) : downloadMaterial(item)}
              />
            )}
          </div>
        </div>
      </div>

      <div className="card lessonPanelCard lessonWorkspaceCard productSectionCard">
        <div className="panelTitle">
          <div>
            <div style={{ fontWeight: 900 }}>Автосохранение доски и заметок</div>
            <div className="small">Черновик обновляется каждые {autosaveEverySec} сек. Можно восстановить любой сохранённый снимок урока.</div>
          </div>
          <div className="lessonWorkspaceHeaderRight">
            <span className="lessonPanelBadge">Autosave</span>
            <span className="small">{autosaveStatus}</span>
          </div>
        </div>

        <div className="lessonWorkspaceGrid">
          <div className="lessonWorkspaceEditor">
            {canEditLessonNotes ? (
              <>
                <label className="label">Главный итог урока</label>
                <textarea className="textarea" value={noteDraft.lesson_summary} onChange={(e) => setNoteDraft((prev) => ({ ...prev, lesson_summary: e.target.value }))} placeholder="Короткая сводка урока одним абзацем" />
                <label className="label">Что прошли</label>
                <textarea className="textarea" value={noteDraft.covered_topics} onChange={(e) => setNoteDraft((prev) => ({ ...prev, covered_topics: e.target.value }))} placeholder="Темы, упражнения, какие задачи разобрали" />
                <label className="label">Что повторить</label>
                <textarea className="textarea" value={noteDraft.repeat_topics} onChange={(e) => setNoteDraft((prev) => ({ ...prev, repeat_topics: e.target.value }))} placeholder="Что проседает и что повторить до следующего урока" />
                <label className="label">Слабые темы (через запятую)</label>
                <input className="input" value={Array.isArray(noteDraft.weak_topics) ? noteDraft.weak_topics.join(', ') : ''} onChange={(e) => setNoteDraft((prev) => ({ ...prev, weak_topics: String(e.target.value || '').split(',').map((item) => item.trim()).filter(Boolean).slice(0, 20) }))} placeholder="дроби, квадратные уравнения, грамматика" />
                <label className="label">Что задано домой</label>
                <textarea className="textarea" value={noteDraft.homework_assigned} onChange={(e) => setNoteDraft((prev) => ({ ...prev, homework_assigned: e.target.value }))} placeholder="Упражнения, конспект, видео, дедлайн" />
                <label className="label">Внутренняя заметка репетитора</label>
                <textarea className="textarea" value={noteDraft.homework_checked} onChange={(e) => setNoteDraft((prev) => ({ ...prev, homework_checked: e.target.value }))} placeholder="Ошибки, прогресс, комментарии по выполнению" />
                <label className="label">Комментарий для родителя / ученика</label>
                <textarea className="textarea" value={noteDraft.tutor_comment_for_parent} onChange={(e) => setNoteDraft((prev) => ({ ...prev, tutor_comment_for_parent: e.target.value }))} placeholder="Короткий понятный комментарий для внешней коммуникации" />
                <div className="lessonWorkspaceActions">
                  <button className="btn" onClick={() => saveWorkspace('manual')} disabled={busy}>Сохранить сейчас</button>
                  <button className="btn btnPrimary" onClick={() => setSummaryOpen(true)} disabled={busy}>Открыть итог урока</button>
                </div>
              </>
            ) : (
              <div className="lessonSummaryReadonly">
                <div className="small">Репетиторские заметки доступны в режиме чтения. После завершения урока здесь появится финальная сводка.</div>
                <div className="lessonSummaryBlock"><div className="label">Итог урока</div><div>{noteDraft.lesson_summary || 'Пока пусто'}</div></div>
                <div className="lessonSummaryBlock"><div className="label">Что прошли</div><div>{noteDraft.covered_topics || 'Пока не заполнено'}</div></div>
                <div className="lessonSummaryBlock"><div className="label">Что повторить</div><div>{noteDraft.repeat_topics || 'Пока не заполнено'}</div></div>
                <div className="lessonSummaryBlock"><div className="label">Домашка</div><div>{noteDraft.homework_assigned || 'Пока не заполнено'}</div></div>
                <div className="lessonSummaryBlock"><div className="label">Комментарий</div><div>{noteDraft.tutor_comment_for_parent || 'Комментарий появится после сохранения репетитором'}</div></div>
              </div>
            )}
          </div>

          <div className="lessonWorkspaceHistory">
            <div className="label">История сохранений</div>
            {workspaceSnapshots.length === 0 ? (
              <div className="small">Пока нет снимков. Первый снимок появится после автосохранения или ручного сохранения.</div>
            ) : (
              <div className="lessonWorkspaceHistoryList">
                {workspaceSnapshots.map((snapshot) => (
                  <button key={snapshot.id} type="button" className="lessonSnapshotItem" onClick={() => restoreWorkspaceSnapshot(snapshot.id)} disabled={restoringSnapshotId === snapshot.id}>
                    <div>
                      <div className="lessonSnapshotTitle">{snapshot.snapshot_kind === 'final' ? 'Итог урока' : snapshot.snapshot_kind === 'manual' ? 'Ручное сохранение' : 'Автосохранение'}</div>
                      <div className="small">{new Date(snapshot.created_at).toLocaleString()} • {snapshot.whiteboard_events_count || 0} событий на доске</div>
                    </div>
                    <span className="lessonSnapshotAction">{restoringSnapshotId === snapshot.id ? '...' : 'Восстановить'}</span>
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

      <RescheduleModal
        open={rescheduleOpen}
        booking={info?.booking}
        token={token}
        onClose={() => setRescheduleOpen(false)}
        onSubmitted={() => { setRescheduleOpen(false); loadInfo() }}
      />

      <ReviewModal
        open={reviewOpen}
        bookingId={b.id}
        token={token}
        onClose={() => setReviewOpen(false)}
        onSubmitted={() => loadInfo()}
      />

      <LessonSummaryModal
        open={summaryOpen}
        canEdit={canEditLessonNotes}
        draft={noteDraft}
        booking={b}
        autosaveStatus={autosaveStatus}
        onClose={() => setSummaryOpen(false)}
        onChange={setNoteDraft}
        onSaveFinal={() => saveWorkspace('final')}
        onOpenHomework={openHomeworkFlow}
      />
    </div>
  )
}

function LessonSummaryModal({ open, canEdit, draft, booking, autosaveStatus, onClose, onChange, onSaveFinal, onOpenHomework }) {
  if (!open) return null
  const starts = booking?.slot_starts_at ? new Date(booking.slot_starts_at).toLocaleString() : ''
  return (
    <div className="modalOverlay" onClick={onClose}>
      <div className="modalCard lessonSummaryModal" onClick={(e) => e.stopPropagation()}>
        <div className="panelTitle">
          <div>
            <div style={{ fontWeight: 900, fontSize: 22 }}>Итог урока</div>
            <div className="small">Сохрани финальную сводку урока, домашку и комментарии. Урок #{booking?.id} {starts ? `• ${starts}` : ''}</div>
          </div>
          <button className="btn" onClick={onClose}>Закрыть</button>
        </div>
        <div className="lessonSummaryHero">
          <div className="lessonSummaryMiniCard"><div className="small">Статус сохранения</div><div style={{ fontWeight: 900 }}>{autosaveStatus}</div></div>
          <div className="lessonSummaryMiniCard"><div className="small">Следующий шаг</div><div style={{ fontWeight: 900 }}>Сохранить итог и открыть ДЗ</div></div>
        </div>
        {canEdit ? (
          <div className="grid" style={{ gap: 10 }}>
            <div><div className="label">Главный итог урока</div><textarea className="textarea" value={draft.lesson_summary} onChange={(e) => onChange((prev) => ({ ...prev, lesson_summary: e.target.value }))} placeholder="Коротко опиши, что сделали на уроке" /></div>
            <div><div className="label">Что прошли</div><textarea className="textarea" value={draft.covered_topics} onChange={(e) => onChange((prev) => ({ ...prev, covered_topics: e.target.value }))} placeholder="Какие темы и задания закрыли" /></div>
            <div><div className="label">Что повторить</div><textarea className="textarea" value={draft.repeat_topics} onChange={(e) => onChange((prev) => ({ ...prev, repeat_topics: e.target.value }))} placeholder="Что надо повторить до следующего урока" /></div>
            <div><div className="label">Слабые темы</div><input className="input" value={Array.isArray(draft.weak_topics) ? draft.weak_topics.join(', ') : ''} onChange={(e) => onChange((prev) => ({ ...prev, weak_topics: String(e.target.value || '').split(',').map((item) => item.trim()).filter(Boolean).slice(0, 20) }))} placeholder="Темы через запятую" /></div>
            <div><div className="label">Что задано домой</div><textarea className="textarea" value={draft.homework_assigned} onChange={(e) => onChange((prev) => ({ ...prev, homework_assigned: e.target.value }))} placeholder="Что нужно сделать до следующего урока" /></div>
            <div><div className="label">Внутренняя заметка</div><textarea className="textarea" value={draft.homework_checked} onChange={(e) => onChange((prev) => ({ ...prev, homework_checked: e.target.value }))} placeholder="Что уже проверили и что ещё нужно дожать" /></div>
            <div><div className="label">Комментарий для родителя / ученика</div><textarea className="textarea" value={draft.tutor_comment_for_parent} onChange={(e) => onChange((prev) => ({ ...prev, tutor_comment_for_parent: e.target.value }))} placeholder="Понятный комментарий без внутренней кухни" /></div>
          </div>
        ) : (
          <div className="grid" style={{ gap: 10 }}>
            <div className="lessonSummaryBlock"><div className="label">Итог урока</div><div>{draft.lesson_summary || 'Пока не заполнено'}</div></div>
            <div className="lessonSummaryBlock"><div className="label">Что прошли</div><div>{draft.covered_topics || 'Пока не заполнено'}</div></div>
            <div className="lessonSummaryBlock"><div className="label">Что повторить</div><div>{draft.repeat_topics || 'Пока не заполнено'}</div></div>
            <div className="lessonSummaryBlock"><div className="label">Домашка</div><div>{draft.homework_assigned || 'Пока не заполнено'}</div></div>
            <div className="lessonSummaryBlock"><div className="label">Комментарий</div><div>{draft.tutor_comment_for_parent || 'Комментарий появится после сохранения репетитором'}</div></div>
          </div>
        )}
        <div className="lessonWorkspaceActions" style={{ marginTop: 14 }}>
          {canEdit && <button className="btn btnPrimary" onClick={onSaveFinal}>Сохранить итог урока</button>}
          <button className="btn" onClick={onOpenHomework}>Открыть ДЗ</button>
          <button className="btn" onClick={onClose}>Готово</button>
        </div>
      </div>
    </div>
  )
}

function FilePreviewGallery({ items, token, onDownload }) {
  const [previews, setPreviews] = useState({})

  useEffect(() => {
    let cancelled = false
    const created = []

    async function load() {
      const next = {}
      for (const item of items || []) {
        if (!item?.id || !['image', 'pdf'].includes(String(item.previewKind || ''))) continue
        const path = item.sourceKind === 'artifact' ? `/api/artifacts/${item.id}` : `/api/materials/${item.id}`
        try {
          const res = await fetch(apiUrl(path), { headers: { Authorization: `Bearer ${token}` } })
          if (!res.ok) continue
          const blob = await res.blob()
          const url = URL.createObjectURL(blob)
          created.push(url)
          next[item.id] = url
        } catch {
          // ignore preview failures
        }
      }
      if (!cancelled) setPreviews(next)
    }

    load()
    return () => {
      cancelled = true
      created.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [items, token])

  return (
    <div className="filePreviewGallery">
      {(items || []).map((item) => {
        const previewUrl = previews[item.id]
        return (
          <div key={`${item.sourceKind}-${item.id}`} className="filePreviewCard">
            <div className="filePreviewThumb">
              {item.previewKind === 'image' && previewUrl ? (
                <img src={previewUrl} alt={item.title || item.name || 'preview'} />
              ) : item.previewKind === 'pdf' && previewUrl ? (
                <iframe title={`pdf-${item.id}`} src={previewUrl} />
              ) : (
                <div className="filePreviewFallback">{item.previewKind === 'pdf' ? 'PDF' : 'FILE'}</div>
              )}
            </div>
            <div className="filePreviewMeta">
              <div style={{ fontWeight: 800 }}>{item.title || item.name || `Файл #${item.id}`}</div>
              <div className="small">{item.mime || 'file'} • {new Date(item.created_at).toLocaleString()}</div>
              <div className="small">{item.sourceKind === 'artifact' ? 'Экспорт доски' : 'Материал урока'}</div>
            </div>
            <div className="filePreviewActions">
              <button className="btn btnGhost" onClick={() => onDownload(item)}>Скачать</button>
            </div>
          </div>
        )
      })}
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
