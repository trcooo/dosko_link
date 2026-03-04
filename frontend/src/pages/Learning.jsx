import React, { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth.jsx'
import { apiFetch, apiUpload, apiUrl } from '../api'

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

  // Plans
  const [plans, setPlans] = useState([])
  const [planItems, setPlanItems] = useState([])
  const [planStudentId, setPlanStudentId] = useState('')
  const [selectedPlanId, setSelectedPlanId] = useState('')
  const [planTitle, setPlanTitle] = useState('')
  const [planGoal, setPlanGoal] = useState('')
  const [itemTitle, setItemTitle] = useState('')
  const [itemKind, setItemKind] = useState('milestone')
  const [itemStatus, setItemStatus] = useState('todo')
  const [itemDue, setItemDue] = useState('')
  const [itemDesc, setItemDesc] = useState('')

  // Student library
  const [library, setLibrary] = useState([])
  const [libStudentId, setLibStudentId] = useState('')
  const [libLinkTitle, setLibLinkTitle] = useState('')
  const [libLinkUrl, setLibLinkUrl] = useState('')
  const [libNoteTitle, setLibNoteTitle] = useState('')
  const [libNoteText, setLibNoteText] = useState('')
  const [libTags, setLibTags] = useState('')
  const [libFileTitle, setLibFileTitle] = useState('')
  const [libFileTags, setLibFileTags] = useState('')
  const [libFile, setLibFile] = useState(null)

  // Quizzes
  const [quizzes, setQuizzes] = useState([])
  const [quizStudentId, setQuizStudentId] = useState('')
  const [quizTitle, setQuizTitle] = useState('')
  const [quizDesc, setQuizDesc] = useState('')
  const [selectedQuizId, setSelectedQuizId] = useState('')
  const [quizQuestions, setQuizQuestions] = useState([])
  const [quizAttempts, setQuizAttempts] = useState([])

  const [qKind, setQKind] = useState('mcq')
  const [qPrompt, setQPrompt] = useState('')
  const [qOptions, setQOptions] = useState('')
  const [qCorrectIndex, setQCorrectIndex] = useState('0')
  const [qAccepted, setQAccepted] = useState('')
  const [qPoints, setQPoints] = useState('1')

  // Student attempt UI
  const [activeAttempt, setActiveAttempt] = useState(null)
  const [attemptAnswers, setAttemptAnswers] = useState({})
  const [attemptResult, setAttemptResult] = useState(null)

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

  // Tutor retention features: mini-CRM + templates
  const [crmStudentId, setCrmStudentId] = useState('')
  const [crmCard, setCrmCard] = useState({ goal: '', weak_topics: [], notes: '', tags: [] })
  const [crmSummary, setCrmSummary] = useState(null)
  const [tplItems, setTplItems] = useState([])
  const [tplKind, setTplKind] = useState('homework')
  const [tplTitle, setTplTitle] = useState('')
  const [tplBody, setTplBody] = useState('')
  const [tplSendBookingId, setTplSendBookingId] = useState('')

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
        if (!planStudentId && Array.isArray(s) && s[0]?.id) setPlanStudentId(String(s[0].id))
        if (!libStudentId && Array.isArray(s) && s[0]?.id) setLibStudentId(String(s[0].id))
        if (!quizStudentId && Array.isArray(s) && s[0]?.id) setQuizStudentId(String(s[0].id))
        if (!crmStudentId && Array.isArray(s) && s[0]?.id) setCrmStudentId(String(s[0].id))
      }
    } catch (e) {
      setErr(e.message || 'Ошибка загрузки')
    }
  }

  async function loadPlans() {
    if (!token || !me) return
    setErr('')
    try {
      const qs = new URLSearchParams()
      if (isTutor) {
        if (planStudentId) qs.set('student_user_id', planStudentId)
      }
      const rows = await apiFetch(`/api/plans${qs.toString() ? `?${qs.toString()}` : ''}`, { token })
      const arr = Array.isArray(rows) ? rows : []
      setPlans(arr)
      if (!selectedPlanId && arr[0]?.id) setSelectedPlanId(String(arr[0].id))
    } catch (e) {
      setErr(e.message || 'Не удалось загрузить планы')
    }
  }

  async function loadPlanItems(planId) {
    if (!token || !planId) { setPlanItems([]); return }
    setErr('')
    try {
      const rows = await apiFetch(`/api/plans/${Number(planId)}/items`, { token })
      setPlanItems(Array.isArray(rows) ? rows : [])
    } catch (e) {
      setErr(e.message || 'Не удалось загрузить пункты плана')
    }
  }

  async function createPlan() {
    if (!token || !planStudentId) return
    if (!planTitle.trim()) return
    setBusy(true)
    setErr('')
    try {
      await apiFetch('/api/plans', { method: 'POST', token, body: { student_user_id: Number(planStudentId), title: planTitle.trim(), goal: planGoal || '' } })
      setPlanTitle('')
      setPlanGoal('')
      await loadPlans()
    } catch (e) {
      setErr(e.message || 'Не удалось создать план')
    } finally {
      setBusy(false)
    }
  }

  async function addPlanItem() {
    if (!token || !selectedPlanId) return
    if (!itemTitle.trim()) return
    setBusy(true)
    setErr('')
    try {
      const due_at = itemDue ? new Date(itemDue).toISOString() : null
      await apiFetch(`/api/plans/${Number(selectedPlanId)}/items`, {
        method: 'POST',
        token,
        body: { kind: itemKind, title: itemTitle.trim(), description: itemDesc || '', due_at, status: itemStatus }
      })
      setItemTitle('')
      setItemDesc('')
      setItemDue('')
      await loadPlanItems(selectedPlanId)
    } catch (e) {
      setErr(e.message || 'Не удалось добавить пункт')
    } finally {
      setBusy(false)
    }
  }

  async function patchPlanItem(id, patch) {
    setBusy(true)
    setErr('')
    try {
      await apiFetch(`/api/plan-items/${id}`, { method: 'PATCH', token, body: patch })
      await loadPlanItems(selectedPlanId)
    } catch (e) {
      setErr(e.message || 'Не удалось обновить')
    } finally {
      setBusy(false)
    }
  }

  async function deletePlanItem(id) {
    if (!confirm('Удалить пункт плана?')) return
    setBusy(true)
    setErr('')
    try {
      await apiFetch(`/api/plan-items/${id}`, { method: 'DELETE', token })
      await loadPlanItems(selectedPlanId)
    } catch (e) {
      setErr(e.message || 'Не удалось удалить')
    } finally {
      setBusy(false)
    }
  }

  async function loadLibrary() {
    if (!token || !me) return
    setErr('')
    try {
      const sid = isTutor ? libStudentId : String(me.id)
      if (!sid) { setLibrary([]); return }
      const rows = await apiFetch(`/api/students/${Number(sid)}/library`, { token })
      setLibrary(Array.isArray(rows) ? rows : [])
    } catch (e) {
      setErr(e.message || 'Не удалось загрузить библиотеку')
    }
  }

  async function addLink() {
    const sid = isTutor ? libStudentId : String(me.id)
    if (!sid || !libLinkUrl.trim()) return
    setBusy(true)
    setErr('')
    try {
      const tags = libTags.split(',').map(x => x.trim()).filter(Boolean)
      await apiFetch(`/api/students/${Number(sid)}/library`, { method: 'POST', token, body: { kind: 'link', title: libLinkTitle || '', url: libLinkUrl.trim(), tags } })
      setLibLinkTitle(''); setLibLinkUrl(''); setLibTags('')
      await loadLibrary()
    } catch (e) {
      setErr(e.message || 'Не удалось добавить ссылку')
    } finally {
      setBusy(false)
    }
  }

  async function addNote() {
    const sid = isTutor ? libStudentId : String(me.id)
    if (!sid || !libNoteText.trim()) return
    setBusy(true)
    setErr('')
    try {
      const tags = libTags.split(',').map(x => x.trim()).filter(Boolean)
      await apiFetch(`/api/students/${Number(sid)}/library`, { method: 'POST', token, body: { kind: 'note', title: libNoteTitle || '', note: libNoteText.trim(), tags } })
      setLibNoteTitle(''); setLibNoteText(''); setLibTags('')
      await loadLibrary()
    } catch (e) {
      setErr(e.message || 'Не удалось добавить заметку')
    } finally {
      setBusy(false)
    }
  }

  async function uploadLibFile() {
    const sid = isTutor ? libStudentId : String(me.id)
    if (!sid || !libFile) return
    setBusy(true)
    setErr('')
    try {
      const fd = new FormData()
      fd.append('file', libFile)
      if (libFileTitle) fd.append('title', libFileTitle)
      if (libFileTags) fd.append('tags', libFileTags)
      await apiUpload(`/api/students/${Number(sid)}/library/upload`, { token, formData: fd })
      setLibFile(null); setLibFileTitle(''); setLibFileTags('')
      await loadLibrary()
    } catch (e) {
      setErr(e.message || 'Не удалось загрузить файл')
    } finally {
      setBusy(false)
    }
  }

  async function downloadLibraryFile(item) {
    try {
      const res = await fetch(apiUrl(`/api/library/${item.id}`), { headers: { Authorization: `Bearer ${token}` }, credentials: 'include' })
      const ct = res.headers.get('content-type') || ''
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (ct.includes('application/json')) {
        const j = await res.json()
        alert(j.value || '')
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = item.name || `file-${item.id}`
      document.body.appendChild(a)
      a.click(); a.remove(); URL.revokeObjectURL(url)
    } catch (e) {
      setErr(e.message || 'Не удалось открыть')
    }
  }

  async function loadQuizzes() {
    if (!token || !me) return
    setErr('')
    try {
      const qs = new URLSearchParams()
      if (isTutor && quizStudentId) qs.set('student_user_id', quizStudentId)
      const rows = await apiFetch(`/api/quizzes${qs.toString() ? `?${qs.toString()}` : ''}`, { token })
      const arr = Array.isArray(rows) ? rows : []
      setQuizzes(arr)
      if (!selectedQuizId && arr[0]?.id) setSelectedQuizId(String(arr[0].id))
    } catch (e) {
      setErr(e.message || 'Не удалось загрузить тесты')
    }
  }

  async function loadQuizDetails(quizId) {
    if (!token || !quizId) { setQuizQuestions([]); setQuizAttempts([]); return }
    setErr('')
    try {
      const qs = await apiFetch(`/api/quizzes/${Number(quizId)}/questions`, { token })
      setQuizQuestions(Array.isArray(qs) ? qs : [])
      const at = await apiFetch(`/api/quizzes/${Number(quizId)}/attempts`, { token })
      setQuizAttempts(Array.isArray(at) ? at : [])
    } catch (e) {
      setErr(e.message || 'Не удалось загрузить детали теста')
    }
  }

  async function createQuiz() {
    if (!quizStudentId || !quizTitle.trim()) return
    setBusy(true)
    setErr('')
    try {
      await apiFetch('/api/quizzes', { method: 'POST', token, body: { student_user_id: Number(quizStudentId), title: quizTitle.trim(), description: quizDesc || '' } })
      setQuizTitle(''); setQuizDesc('')
      await loadQuizzes()
    } catch (e) {
      setErr(e.message || 'Не удалось создать тест')
    } finally {
      setBusy(false)
    }
  }

  async function patchQuiz(id, patch) {
    setBusy(true)
    setErr('')
    try {
      await apiFetch(`/api/quizzes/${id}`, { method: 'PATCH', token, body: patch })
      await loadQuizzes()
      await loadQuizDetails(selectedQuizId)
    } catch (e) {
      setErr(e.message || 'Не удалось обновить тест')
    } finally {
      setBusy(false)
    }
  }

  async function addQuestion() {
    if (!selectedQuizId || !qPrompt.trim()) return
    setBusy(true)
    setErr('')
    try {
      const body = { kind: qKind, prompt: qPrompt.trim(), points: Number(qPoints || 1) }
      if (qKind === 'mcq') {
        const opts = qOptions.split('\n').map(x => x.trim()).filter(Boolean)
        body.options = opts
        body.correct_index = Number(qCorrectIndex || 0)
      } else {
        body.accepted_answers = qAccepted.split(',').map(x => x.trim()).filter(Boolean)
      }
      const qs = await apiFetch(`/api/quizzes/${Number(selectedQuizId)}/questions`, { method: 'POST', token, body })
      setQuizQuestions(Array.isArray(qs) ? qs : [])
      setQPrompt(''); setQOptions(''); setQAccepted(''); setQCorrectIndex('0'); setQPoints('1')
    } catch (e) {
      setErr(e.message || 'Не удалось добавить вопрос')
    } finally {
      setBusy(false)
    }
  }

  async function startAttempt(quizId) {
    setBusy(true)
    setErr('')
    try {
      const out = await apiFetch(`/api/quizzes/${Number(quizId)}/attempts/start`, { method: 'POST', token })
      setActiveAttempt(out)
      setAttemptAnswers({})
      setAttemptResult(null)
    } catch (e) {
      setErr(e.message || 'Не удалось начать попытку')
    } finally {
      setBusy(false)
    }
  }

  async function submitAttempt() {
    if (!activeAttempt?.attempt_id) return
    setBusy(true)
    setErr('')
    try {
      const answers = (activeAttempt.questions || []).map(q => ({ question_id: q.id, answer: attemptAnswers[q.id] ?? '' }))
      const res = await apiFetch(`/api/attempts/${Number(activeAttempt.attempt_id)}/submit`, { method: 'POST', token, body: { answers } })
      setAttemptResult(res)
      // refresh attempts list
      await loadQuizDetails(activeAttempt.quiz.id)
    } catch (e) {
      setErr(e.message || 'Не удалось отправить')
    } finally {
      setBusy(false)
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
    loadPlans()
    loadLibrary()
    loadQuizzes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, me])

  useEffect(() => {
    if (tab === 'homework') loadHomework()
    if (tab === 'progress') loadProgress()
    if (tab === 'materials') loadMaterials()
    if (tab === 'plan') loadPlans()
    if (tab === 'library') loadLibrary()
    if (tab === 'quizzes') loadQuizzes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  useEffect(() => {
    if (tab === 'progress') loadProgress()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progStudentId])

  useEffect(() => {
    if (tab === 'plan') loadPlans()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planStudentId])

  useEffect(() => {
    loadPlanItems(selectedPlanId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPlanId])

  useEffect(() => {
    if (tab === 'library') loadLibrary()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libStudentId])

  useEffect(() => {
    if (tab === 'quizzes') loadQuizzes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quizStudentId])

  useEffect(() => {
    loadQuizDetails(selectedQuizId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedQuizId])

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

  useEffect(() => {
    if (!isTutor || !token) return
    loadTemplatesMini()
  }, [isTutor, token])

  useEffect(() => {
    if (!isTutor || !token || !crmStudentId) return
    loadCrmMini()
  }, [isTutor, token, crmStudentId])

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


  async function loadTemplatesMini() {
    if (!isTutor) return
    try {
      const out = await apiFetch('/api/templates', { token })
      setTplItems(Array.isArray(out?.items) ? out.items : [])
    } catch (e) { setErr(e.message || 'Не удалось загрузить шаблоны') }
  }

  async function createTemplateMini() {
    if (!isTutor || !tplTitle.trim() || !tplBody.trim()) return
    setBusy(true); setErr('')
    try {
      await apiFetch('/api/templates', { method: 'POST', token, body: { kind: tplKind, title: tplTitle.trim(), body: tplBody, channel: 'email' } })
      setTplTitle(''); setTplBody('')
      await loadTemplatesMini()
    } catch (e) { setErr(e.message || 'Не удалось создать шаблон') }
    finally { setBusy(false) }
  }

  async function sendTemplateMini(templateId) {
    if (!tplSendBookingId) { setErr('Укажи booking_id для отправки шаблона'); return }
    setBusy(true); setErr('')
    try {
      await apiFetch(`/api/templates/${templateId}/send`, { method: 'POST', token, body: { booking_id: Number(tplSendBookingId) } })
      alert('Шаблон отправлен ученику (email/telegram по настройкам)')
    } catch (e) { setErr(e.message || 'Не удалось отправить шаблон') }
    finally { setBusy(false) }
  }

  async function loadCrmMini() {
    if (!isTutor || !crmStudentId) return
    setErr('')
    try {
      const [card, summary] = await Promise.all([
        apiFetch(`/api/crm/student/${Number(crmStudentId)}`, { token }),
        apiFetch(`/api/crm/students/${Number(crmStudentId)}/summary`, { token }),
      ])
      setCrmCard(card?.card || { goal: '', weak_topics: [], notes: '', tags: [] })
      setCrmSummary(summary || null)
    } catch (e) { setErr(e.message || 'Не удалось загрузить mini-CRM') }
  }

  async function saveCrmMini() {
    if (!isTutor || !crmStudentId) return
    setBusy(true); setErr('')
    try {
      const payload = {
        goal: crmCard.goal || '',
        weak_topics: Array.isArray(crmCard.weak_topics) ? crmCard.weak_topics : String(crmCard.weak_topics || '').split(',').map(x => x.trim()).filter(Boolean),
        notes: crmCard.notes || '',
        tags: Array.isArray(crmCard.tags) ? crmCard.tags : String(crmCard.tags || '').split(',').map(x => x.trim()).filter(Boolean),
      }
      await apiFetch(`/api/crm/student/${Number(crmStudentId)}`, { method: 'POST', token, body: payload })
      await loadCrmMini()
    } catch (e) { setErr(e.message || 'Не удалось сохранить mini-CRM') }
    finally { setBusy(false) }
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
          <button className={tab === 'plan' ? 'btn btnPrimary' : 'btn'} onClick={() => setTab('plan')}>План</button>
          <button className={tab === 'library' ? 'btn btnPrimary' : 'btn'} onClick={() => setTab('library')}>Библиотека</button>
          <button className={tab === 'quizzes' ? 'btn btnPrimary' : 'btn'} onClick={() => setTab('quizzes')}>Тесты</button>
        </div>
      </div>

      {isTutor && (
        <div className="grid" style={{ gap: 12 }}>
          <div className="card">
            <div style={{ fontWeight: 900, fontSize: 18 }}>Мини-CRM репетитора</div>
            <div className="sub">Карточка ученика, цель, слабые темы, заметки, история занятий/ДЗ/пульс.</div>
            <div className="row" style={{ gap: 10, alignItems: 'end' }}>
              <div style={{ flex: 1 }}>
                <div className="label">Ученик</div>
                <select className="select" value={crmStudentId} onChange={(e) => setCrmStudentId(e.target.value)}>
                  {studentOptions.length === 0 ? <option value="">Нет учеников</option> : studentOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <button className="btn" onClick={loadCrmMini}>Обновить CRM</button>
            </div>
            <div className="label">Цель</div>
            <input className="input" value={crmCard?.goal || ''} onChange={(e) => setCrmCard(s => ({ ...(s || {}), goal: e.target.value }))} placeholder="Напр.: ЕГЭ 80+, закрыть геометрию" />
            <div className="label">Слабые темы (через запятую)</div>
            <input className="input" value={Array.isArray(crmCard?.weak_topics) ? crmCard.weak_topics.join(', ') : (crmCard?.weak_topics || '')} onChange={(e) => setCrmCard(s => ({ ...(s || {}), weak_topics: e.target.value }))} />
            <div className="label">Заметки по урокам</div>
            <textarea className="textarea" value={crmCard?.notes || ''} onChange={(e) => setCrmCard(s => ({ ...(s || {}), notes: e.target.value }))} />
            <button className="btn btnPrimary" onClick={saveCrmMini} disabled={busy || !crmStudentId}>Сохранить mini-CRM</button>
            {crmSummary && (
              <div className="card" style={{ marginTop: 10 }}>
                <div className="small">Пульс: посещаемость {crmSummary?.pulse?.attendance?.attendance_percent || 0}% • ДЗ {crmSummary?.pulse?.homework?.completion_percent || 0}% • мини-тесты {crmSummary?.pulse?.mini_tests?.avg_score_percent ?? '—'}%</div>
                <div className="small">История занятий: {(crmSummary?.history || []).length} • заметок: {(crmSummary?.lesson_notes || []).length} • ДЗ: {(crmSummary?.homework || []).length}</div>
                {!!(crmSummary?.card?.goal) && <div className="small">Цель: {crmSummary.card.goal}</div>}
              </div>
            )}
          </div>

          <div className="card">
            <div style={{ fontWeight: 900, fontSize: 18 }}>Шаблоны сообщений / ДЗ</div>
            <div className="sub">Напоминание, что повторить, ДЗ, перенос. Можно отправить ученику по booking_id.</div>
            <div className="row" style={{ gap: 10 }}>
              <div style={{ width: 220 }}>
                <div className="label">Тип</div>
                <select className="select" value={tplKind} onChange={(e) => setTplKind(e.target.value)}>
                  <option value="reminder">reminder</option>
                  <option value="homework">homework</option>
                  <option value="reschedule">reschedule</option>
                  <option value="general">general</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <div className="label">Название</div>
                <input className="input" value={tplTitle} onChange={(e) => setTplTitle(e.target.value)} placeholder="Домашнее задание после урока" />
              </div>
            </div>
            <div className="label">Текст (переменные: {{student_mask}}, {{booking_id}}, {{slot_start}})</div>
            <textarea className="textarea" value={tplBody} onChange={(e) => setTplBody(e.target.value)} placeholder="Повтори тему ..., ДЗ: ..." />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btnPrimary" onClick={createTemplateMini} disabled={busy || !tplTitle.trim() || !tplBody.trim()}>Сохранить шаблон</button>
              <button className="btn" onClick={loadTemplatesMini}>Обновить список</button>
            </div>
            <div className="label" style={{ marginTop: 10 }}>booking_id для отправки</div>
            <input className="input" type="number" value={tplSendBookingId} onChange={(e) => setTplSendBookingId(e.target.value)} placeholder="Напр. 123" />
            <div className="grid" style={{ gap: 8, marginTop: 10 }}>
              {(tplItems || []).slice(0, 8).map((tpl) => (
                <div key={tpl.id} className="card">
                  <div style={{ fontWeight: 800 }}>{tpl.title || `Шаблон #${tpl.id}`}</div>
                  <div className="small">{tpl.kind} • {tpl.channel}</div>
                  <div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{String(tpl.body || '').slice(0, 180)}{String(tpl.body || '').length > 180 ? '…' : ''}</div>
                  <button className="btn" style={{ marginTop: 8 }} onClick={() => sendTemplateMini(tpl.id)} disabled={busy}>Отправить по booking_id</button>
                </div>
              ))}
              {(!tplItems || tplItems.length === 0) && <div className="small">Пока нет шаблонов.</div>}
            </div>
          </div>
        </div>
      )}

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

      {tab === 'plan' && (
        <div className="card">
          <div style={{ fontWeight: 900, fontSize: 18 }}>План обучения</div>
          <div className="sub">Цель → пункты → чекпоинты. Репетитор ведёт план, ученик видит и может отмечать статус пунктов.</div>

          {isTutor && (
            <div className="card" style={{ marginTop: 10 }}>
              <div style={{ fontWeight: 800 }}>Выбрать ученика</div>
              <select className="select" value={planStudentId} onChange={(e) => setPlanStudentId(e.target.value)}>
                {studentOptions.length === 0 ? <option value="">Нет учеников</option> : studentOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>

              <div style={{ marginTop: 10, fontWeight: 800 }}>Создать новый план</div>
              <div className="label">Название</div>
              <input className="input" value={planTitle} onChange={(e) => setPlanTitle(e.target.value)} placeholder="Например: ЕГЭ математика — 8 недель" />
              <div className="label">Цель (опционально)</div>
              <textarea className="textarea" value={planGoal} onChange={(e) => setPlanGoal(e.target.value)} placeholder="Цель, формат, критерии результата…" />
              <button className="btn btnPrimary" onClick={createPlan} disabled={busy || !planTitle.trim()}>Создать план</button>
            </div>
          )}

          <div className="row" style={{ gap: 10, marginTop: 10 }}>
            <div style={{ flex: 1 }}>
              <div className="label">План</div>
              <select className="select" value={selectedPlanId} onChange={(e) => setSelectedPlanId(e.target.value)}>
                {plans.length === 0 ? <option value="">Нет планов</option> : plans.map(p => <option key={p.id} value={String(p.id)}>{p.title || `План #${p.id}`} ({p.status})</option>)}
              </select>
            </div>
            <div style={{ width: 220 }}>
              <div className="label">Обновить</div>
              <button className="btn" onClick={() => { loadPlans(); loadPlanItems(selectedPlanId) }} disabled={busy}>Обновить</button>
            </div>
          </div>

          {selectedPlanId && isTutor && (
            <div className="card" style={{ marginTop: 10 }}>
              <div style={{ fontWeight: 800 }}>Добавить пункт</div>
              <div className="row" style={{ gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div className="label">Название</div>
                  <input className="input" value={itemTitle} onChange={(e) => setItemTitle(e.target.value)} placeholder="Например: Тригонометрия — база" />
                </div>
                <div style={{ width: 180 }}>
                  <div className="label">Тип</div>
                  <select className="select" value={itemKind} onChange={(e) => setItemKind(e.target.value)}>
                    <option value="milestone">Чекпоинт</option>
                    <option value="lesson">Урок</option>
                    <option value="task">Задача</option>
                  </select>
                </div>
                <div style={{ width: 180 }}>
                  <div className="label">Статус</div>
                  <select className="select" value={itemStatus} onChange={(e) => setItemStatus(e.target.value)}>
                    <option value="todo">todo</option>
                    <option value="in_progress">in_progress</option>
                    <option value="done">done</option>
                  </select>
                </div>
              </div>
              <div className="row" style={{ gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div className="label">Описание (опционально)</div>
                  <textarea className="textarea" value={itemDesc} onChange={(e) => setItemDesc(e.target.value)} placeholder="Коротко: что делаем, критерии…" />
                </div>
                <div style={{ width: 260 }}>
                  <div className="label">Дедлайн (опционально)</div>
                  <input className="input" type="datetime-local" value={itemDue} onChange={(e) => setItemDue(e.target.value)} />
                </div>
              </div>
              <button className="btn btnPrimary" onClick={addPlanItem} disabled={busy || !itemTitle.trim()}>Добавить</button>
            </div>
          )}

          <div className="card" style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 800 }}>Пункты</div>
            {planItems.length === 0 ? (
              <div className="small">Пока нет пунктов.</div>
            ) : (
              <div className="grid" style={{ gap: 10, marginTop: 8 }}>
                {planItems.map(it => (
                  <div key={it.id} className="card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ fontWeight: 900 }}>{it.title}</div>
                        <div className="small">{it.kind} • статус: <b>{it.status}</b>{it.due_at ? ` • дедлайн: ${fmt(it.due_at)}` : ''}</div>
                        {it.description && <div className="small" style={{ marginTop: 6 }}>{it.description}</div>}
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <select className="select" value={it.status} onChange={(e) => patchPlanItem(it.id, { status: e.target.value })} disabled={busy}>
                          <option value="todo">todo</option>
                          <option value="in_progress">in_progress</option>
                          <option value="done">done</option>
                        </select>
                        {isTutor && <button className="btn" onClick={() => deletePlanItem(it.id)} disabled={busy}>Удалить</button>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'library' && (
        <div className="card">
          <div style={{ fontWeight: 900, fontSize: 18 }}>Библиотека ученика</div>
          <div className="sub">Файлы, ссылки и заметки — не привязаны к конкретному занятию. Удобно хранить “всё по ученику”.</div>

          {isTutor && (
            <div className="card" style={{ marginTop: 10 }}>
              <div style={{ fontWeight: 800 }}>Выбрать ученика</div>
              <select className="select" value={libStudentId} onChange={(e) => setLibStudentId(e.target.value)}>
                {studentOptions.length === 0 ? <option value="">Нет учеников</option> : studentOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          )}

          <div className="split" style={{ marginTop: 10 }}>
            <div className="card">
              <div style={{ fontWeight: 800 }}>Загрузить файл</div>
              <div className="label">Название (опционально)</div>
              <input className="input" value={libFileTitle} onChange={(e) => setLibFileTitle(e.target.value)} placeholder="Например: Таблица формул" />
              <div className="label">Теги (через запятую)</div>
              <input className="input" value={libFileTags} onChange={(e) => setLibFileTags(e.target.value)} placeholder="алгебра, формулы" />
              <input className="input" type="file" onChange={(e) => setLibFile(e.target.files?.[0] || null)} />
              <button className="btn btnPrimary" onClick={uploadLibFile} disabled={busy || !libFile}>Загрузить</button>
            </div>

            <div className="card">
              <div style={{ fontWeight: 800 }}>Ссылка / заметка</div>
              <div className="label">Теги (общие для формы)</div>
              <input className="input" value={libTags} onChange={(e) => setLibTags(e.target.value)} placeholder="геометрия, видео" />

              <div style={{ marginTop: 10, fontWeight: 800 }}>Ссылка</div>
              <div className="label">Название</div>
              <input className="input" value={libLinkTitle} onChange={(e) => setLibLinkTitle(e.target.value)} placeholder="YouTube / статья" />
              <div className="label">URL</div>
              <input className="input" value={libLinkUrl} onChange={(e) => setLibLinkUrl(e.target.value)} placeholder="https://…" />
              <button className="btn" onClick={addLink} disabled={busy || !libLinkUrl.trim()}>Добавить ссылку</button>

              <div style={{ marginTop: 10, fontWeight: 800 }}>Заметка</div>
              <div className="label">Название</div>
              <input className="input" value={libNoteTitle} onChange={(e) => setLibNoteTitle(e.target.value)} placeholder="Что повторить" />
              <div className="label">Текст</div>
              <textarea className="textarea" value={libNoteText} onChange={(e) => setLibNoteText(e.target.value)} placeholder="Короткая заметка…" />
              <button className="btn" onClick={addNote} disabled={busy || !libNoteText.trim()}>Добавить заметку</button>
            </div>
          </div>

          <div className="card" style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ fontWeight: 800 }}>Список</div>
              <button className="btn" onClick={loadLibrary} disabled={busy}>Обновить</button>
            </div>
            {library.length === 0 ? (
              <div className="small">Пока пусто.</div>
            ) : (
              <div className="grid" style={{ gap: 10, marginTop: 8 }}>
                {library.map(it => (
                  <div key={it.id} className="card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ fontWeight: 900 }}>{it.title || it.name}</div>
                        <div className="small">{it.kind} • добавил: {it.uploader_hint} • {fmt(it.created_at)}</div>
                        {it.tags?.length ? <div className="small">Теги: {it.tags.join(', ')}</div> : null}
                        {it.preview ? <div className="small" style={{ marginTop: 6 }}>{it.preview}</div> : null}
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {it.kind === 'link' ? (
                          <a className="btn" href={it.url} target="_blank" rel="noreferrer">Открыть</a>
                        ) : (
                          <button className="btn" onClick={() => downloadLibraryFile(it)}>Открыть</button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'quizzes' && (
        <div className="card">
          <div style={{ fontWeight: 900, fontSize: 18 }}>Тесты</div>
          <div className="sub">Репетитор создаёт тест → публикует → ученик проходит → результат считается автоматически (для MCQ и коротких ответов).</div>

          {isTutor && (
            <div className="card" style={{ marginTop: 10 }}>
              <div style={{ fontWeight: 800 }}>Выбрать ученика</div>
              <select className="select" value={quizStudentId} onChange={(e) => setQuizStudentId(e.target.value)}>
                {studentOptions.length === 0 ? <option value="">Нет учеников</option> : studentOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>

              <div style={{ marginTop: 10, fontWeight: 800 }}>Создать тест</div>
              <div className="label">Название</div>
              <input className="input" value={quizTitle} onChange={(e) => setQuizTitle(e.target.value)} placeholder="Мини-тест: функции" />
              <div className="label">Описание (опционально)</div>
              <textarea className="textarea" value={quizDesc} onChange={(e) => setQuizDesc(e.target.value)} placeholder="Сделай до следующего урока…" />
              <button className="btn btnPrimary" onClick={createQuiz} disabled={busy || !quizTitle.trim()}>Создать</button>
            </div>
          )}

          <div className="row" style={{ gap: 10, marginTop: 10 }}>
            <div style={{ flex: 1 }}>
              <div className="label">Тест</div>
              <select className="select" value={selectedQuizId} onChange={(e) => setSelectedQuizId(e.target.value)}>
                {quizzes.length === 0 ? <option value="">Нет тестов</option> : quizzes.map(q => <option key={q.id} value={String(q.id)}>{q.title} ({q.status})</option>)}
              </select>
            </div>
            <div style={{ width: 220 }}>
              <div className="label">Обновить</div>
              <button className="btn" onClick={() => { loadQuizzes(); loadQuizDetails(selectedQuizId) }} disabled={busy}>Обновить</button>
            </div>
          </div>

          {!isTutor && selectedQuizId && (
            <div className="card" style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 800 }}>Прохождение</div>
                <button className="btn btnPrimary" onClick={() => startAttempt(selectedQuizId)} disabled={busy}>Начать попытку</button>
              </div>
              {activeAttempt && activeAttempt.quiz?.id === Number(selectedQuizId) && (
                <div className="card" style={{ marginTop: 10 }}>
                  <div className="small">Попытка #{activeAttempt.attempt_id}</div>
                  <div className="grid" style={{ gap: 10, marginTop: 8 }}>
                    {(activeAttempt.questions || []).map((q) => (
                      <div key={q.id} className="card">
                        <div style={{ fontWeight: 900 }}>{q.prompt}</div>
                        <div className="small">Тип: {q.kind} • Баллы: {q.points}</div>
                        {q.kind === 'mcq' ? (
                          <select className="select" value={attemptAnswers[q.id] ?? ''} onChange={(e) => setAttemptAnswers(prev => ({ ...prev, [q.id]: e.target.value }))}>
                            <option value="">— выберите —</option>
                            {(q.options || []).map((opt, idx) => <option key={idx} value={String(idx)}>{opt}</option>)}
                          </select>
                        ) : (
                          <input className="input" value={attemptAnswers[q.id] ?? ''} onChange={(e) => setAttemptAnswers(prev => ({ ...prev, [q.id]: e.target.value }))} placeholder="Ответ…" />
                        )}
                      </div>
                    ))}
                  </div>
                  <button className="btn btnPrimary" style={{ marginTop: 10 }} onClick={submitAttempt} disabled={busy}>Отправить</button>
                  {attemptResult && (
                    <div className="footerNote" style={{ marginTop: 10 }}>
                      Результат: {attemptResult.score} / {attemptResult.max_score}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {isTutor && selectedQuizId && (
            <div className="split" style={{ marginTop: 10 }}>
              <div className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontWeight: 800 }}>Вопросы</div>
                    <div className="small">Добавьте вопросы и затем переведите тест в published.</div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="btn" onClick={() => patchQuiz(selectedQuizId, { status: 'draft' })} disabled={busy}>draft</button>
                    <button className="btn btnPrimary" onClick={() => patchQuiz(selectedQuizId, { status: 'published' })} disabled={busy}>published</button>
                    <button className="btn" onClick={() => patchQuiz(selectedQuizId, { status: 'closed' })} disabled={busy}>closed</button>
                  </div>
                </div>

                <div className="card" style={{ marginTop: 10 }}>
                  <div style={{ fontWeight: 800 }}>Добавить вопрос</div>
                  <div className="row" style={{ gap: 10 }}>
                    <div style={{ width: 180 }}>
                      <div className="label">Тип</div>
                      <select className="select" value={qKind} onChange={(e) => setQKind(e.target.value)}>
                        <option value="mcq">MCQ</option>
                        <option value="short">Short</option>
                      </select>
                    </div>
                    <div style={{ width: 140 }}>
                      <div className="label">Баллы</div>
                      <input className="input" value={qPoints} onChange={(e) => setQPoints(e.target.value)} />
                    </div>
                  </div>
                  <div className="label">Вопрос</div>
                  <textarea className="textarea" value={qPrompt} onChange={(e) => setQPrompt(e.target.value)} placeholder="Текст вопроса…" />
                  {qKind === 'mcq' ? (
                    <>
                      <div className="label">Варианты (каждый с новой строки)</div>
                      <textarea className="textarea" value={qOptions} onChange={(e) => setQOptions(e.target.value)} placeholder="A\nB\nC\nD" />
                      <div className="label">Правильный индекс (0..n-1)</div>
                      <input className="input" value={qCorrectIndex} onChange={(e) => setQCorrectIndex(e.target.value)} />
                    </>
                  ) : (
                    <>
                      <div className="label">Допустимые ответы (через запятую)</div>
                      <input className="input" value={qAccepted} onChange={(e) => setQAccepted(e.target.value)} placeholder="sin x, sin(x)" />
                    </>
                  )}
                  <button className="btn btnPrimary" onClick={addQuestion} disabled={busy || !qPrompt.trim()}>Добавить</button>
                </div>

                {quizQuestions.length === 0 ? (
                  <div className="small" style={{ marginTop: 10 }}>Вопросов пока нет.</div>
                ) : (
                  <div className="grid" style={{ gap: 10, marginTop: 10 }}>
                    {quizQuestions.map(q => (
                      <div key={q.id} className="card">
                        <div style={{ fontWeight: 900 }}>{q.prompt}</div>
                        <div className="small">{q.kind} • {q.points} балл(ов)</div>
                        {q.kind === 'mcq' && q.options?.length ? (
                          <div className="small" style={{ marginTop: 6 }}>Варианты: {q.options.join(' | ')}</div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="card">
                <div style={{ fontWeight: 800 }}>Попытки</div>
                {quizAttempts.length === 0 ? (
                  <div className="small">Пока нет попыток.</div>
                ) : (
                  <div className="grid" style={{ gap: 10, marginTop: 8 }}>
                    {quizAttempts.map(a => (
                      <div key={a.id} className="card">
                        <div style={{ fontWeight: 900 }}>Attempt #{a.id}</div>
                        <div className="small">Score: {a.score}/{a.max_score}</div>
                        <div className="small">Started: {fmt(a.started_at)}</div>
                        {a.submitted_at ? <div className="small">Submitted: {fmt(a.submitted_at)}</div> : <div className="small">Not submitted</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {!isTutor && selectedQuizId && (
            <div className="card" style={{ marginTop: 10 }}>
              <div style={{ fontWeight: 800 }}>История попыток</div>
              {quizAttempts.length === 0 ? (
                <div className="small">Пока нет попыток.</div>
              ) : (
                <div className="grid" style={{ gap: 10, marginTop: 8 }}>
                  {quizAttempts.map(a => (
                    <div key={a.id} className="card">
                      <div style={{ fontWeight: 900 }}>Attempt #{a.id}</div>
                      <div className="small">Score: {a.score}/{a.max_score}</div>
                      <div className="small">{fmt(a.started_at)}{a.submitted_at ? ` → ${fmt(a.submitted_at)}` : ''}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
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
