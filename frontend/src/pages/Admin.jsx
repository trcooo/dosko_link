import React, { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth.jsx'
import { apiFetch } from '../api'

const TABS = [
  { id: 'overview', title: 'Сводка', searchable: false, hint: 'Главные метрики, пульс платформы и быстрые действия.' },
  { id: 'telegram', title: 'Telegram', searchable: false, hint: 'Подключение, webhook, команды и диагностика бота.' },
  { id: 'moderation', title: 'Модерация', searchable: true, hint: 'Проверка профилей репетиторов, документов и публикации.' },
  { id: 'catalog', title: 'Категории', searchable: true, hint: 'Предметы, цели, уровни, экзамены и словари платформы.' },
  { id: 'reports', title: 'Репорты', searchable: true, hint: 'Жалобы пользователей и спорные ситуации по урокам.' },
  { id: 'bookings', title: 'Занятия', searchable: true, hint: 'Статусы уроков, переносы и быстрый переход в комнату.' },
  { id: 'reviews', title: 'Отзывы', searchable: true, hint: 'Модерация отзывов и контроль качества выдачи.' },
  { id: 'users', title: 'Пользователи', searchable: true, hint: 'Поиск пользователей, роли, блокировки и баланс.' },
]

const CATALOG_KINDS = [
  { value: 'subject', label: 'Предметы' },
  { value: 'goal', label: 'Цели' },
  { value: 'level', label: 'Уровни' },
  { value: 'grade', label: 'Классы' },
  { value: 'language', label: 'Языки' },
  { value: 'exam', label: 'Экзамены' },
]

const TELEGRAM_BOT_FALLBACK = 'doskolink_bot'

function AdminStat({ label, value, helper = '', tone = 'default' }) {
  return (
    <div className={`adminStat adminStatTone-${tone}`}>
      <div className="small">{label}</div>
      <div className="adminStatValue">{value ?? 0}</div>
      {helper ? <div className="small">{helper}</div> : null}
    </div>
  )
}

function StatusPill({ children, tone = 'default' }) {
  return <span className={`pill statusPill statusPill-${tone}`}>{children}</span>
}

function boolMark(v) {
  return v ? '✓' : '—'
}

function formatDateTimeShort(v) {
  if (!v) return '—'
  try { return new Date(v).toLocaleString() } catch { return String(v) }
}

function telegramBotUsername(link, status) {
  return String(status?.bot_username || link?.bot_username || TELEGRAM_BOT_FALLBACK || '').trim().replace(/^@+/, '')
}

function telegramConnectUrl(link) {
  const direct = String(link?.deep_link_url || '').trim()
  if (direct) return direct
  const token = String(link?.token || '').trim()
  const username = telegramBotUsername(link)
  if (username && token) return `https://t.me/${username}?start=${encodeURIComponent(token)}`
  if (username) return `https://t.me/${username}`
  return ''
}

function telegramAppUrl(link) {
  const token = String(link?.token || '').trim()
  const username = telegramBotUsername(link)
  if (username && token) return `tg://resolve?domain=${username}&start=${encodeURIComponent(token)}`
  if (username) return `tg://resolve?domain=${username}`
  return ''
}

function telegramStartCommand(link) {
  const direct = String(link?.start_command || '').trim()
  if (direct) return direct
  const token = String(link?.token || '').trim()
  return token ? `/start ${token}` : '/start'
}

function telegramShortStartCommand(link) {
  const shortDirect = String(link?.short_start_command || '').trim()
  if (shortDirect) return shortDirect
  return telegramStartCommand(link)
}

function telegramFeatureBullets() {
  return ['Сводка платформы', 'Role-based команды', 'Клавиатура быстрых действий', 'Webhook + bot profile sync', 'Уведомления on/off', 'Связка аккаунта по deep link']
}

function telegramCommandChips(status) {
  const fromStatus = Array.isArray(status?.configured_commands) ? status.configured_commands.filter(Boolean).map(cmd => `/${String(cmd).replace(/^\/+/, '')}`) : []
  if (fromStatus.length) return fromStatus
  return ['/menu', '/today', '/tomorrow', '/next', '/schedule', '/homework', '/progress', '/balance', '/notifications', '/stats', '/tgstatus', '/help']
}

async function copyTextSafe(text) {
  const value = String(text || '').trim()
  if (!value) return false
  try {
    if (window.isSecureContext && navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {}
  try {
    const ta = document.createElement('textarea')
    ta.value = value
    ta.setAttribute('readonly', 'readonly')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    ta.setSelectionRange(0, ta.value.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return Boolean(ok)
  } catch {
    return false
  }
}

function openExternalUrl(url) {
  const target = String(url || '').trim()
  if (!target) return false
  try {
    const w = window.open(target, '_blank', 'noopener,noreferrer')
    if (w) return true
  } catch {}
  try {
    window.location.href = target
    return true
  } catch {
    return false
  }
}

function listCountLabel(count, one, many) {
  return `${count} ${count === 1 ? one : many}`
}

export default function Admin() {
  const { me, token, loading } = useAuth()
  const nav = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const requestedTab = searchParams.get('tab')
  const initialTab = TABS.some(t => t.id === requestedTab) ? requestedTab : 'overview'

  const [tab, setTab] = useState(initialTab)
  const [q, setQ] = useState('')
  const [err, setErr] = useState('')
  const [tgNotice, setTgNotice] = useState('')
  const [saving, setSaving] = useState(false)

  const [overview, setOverview] = useState(null)
  const [users, setUsers] = useState([])
  const [tutors, setTutors] = useState([])
  const [bookings, setBookings] = useState([])
  const [reviews, setReviews] = useState([])
  const [reports, setReports] = useState([])
  const [catalog, setCatalog] = useState([])
  const [telegramSettings, setTelegramSettings] = useState(null)
  const [telegramLink, setTelegramLink] = useState(null)
  const [telegramStatus, setTelegramStatus] = useState(null)

  const [tutorStatusFilter, setTutorStatusFilter] = useState('pending')
  const [bookingStatus, setBookingStatus] = useState('')
  const [reviewStars, setReviewStars] = useState('')
  const [reportStatus, setReportStatus] = useState('open')
  const [catalogKind, setCatalogKind] = useState('subject')
  const [catalogValue, setCatalogValue] = useState('')
  const [catalogOrder, setCatalogOrder] = useState('0')

  const activeTab = useMemo(() => TABS.find(t => t.id === tab) || TABS[0], [tab])
  const canLoad = useMemo(() => Boolean(token && me?.role === 'admin'), [token, me])

  useEffect(() => {
    if (loading) return
    if (!me) nav('/login')
    else if (me.role !== 'admin') nav('/')
  }, [loading, me, nav])

  useEffect(() => {
    const next = TABS.some(t => t.id === requestedTab) ? requestedTab : 'overview'
    if (next !== tab) setTab(next)
  }, [requestedTab])

  function goTab(nextTab) {
    setTab(nextTab)
    const nextParams = new URLSearchParams(searchParams)
    if (nextTab === 'overview') nextParams.delete('tab')
    else nextParams.set('tab', nextTab)
    setSearchParams(nextParams, { replace: true })
  }

  async function loadTelegramPanel() {
    if (!canLoad) return
    try {
      const results = await Promise.allSettled([
        apiFetch('/api/me/settings', { token }),
        apiFetch('/api/me/telegram-link', { token }),
        apiFetch('/api/admin/integrations/telegram/status', { token }),
      ])

      if (results[0].status === 'fulfilled') setTelegramSettings(results[0].value || null)
      if (results[1].status === 'fulfilled') setTelegramLink(results[1].value || null)
      if (results[2].status === 'fulfilled') setTelegramStatus(results[2].value || null)
    } catch (e) {
      setErr(e.message || 'Не удалось загрузить Telegram-настройки')
    }
  }

  async function syncTelegramInfra() {
    if (!canLoad) return
    setSaving(true)
    setErr('')
    setTgNotice('')
    try {
      const data = await apiFetch('/api/admin/integrations/telegram/sync', { method: 'POST', token })
      setTelegramStatus(data || null)
      setTgNotice(data?.summary || 'Webhook и команды Telegram обновлены.')
      await loadTelegramPanel()
    } catch (e) {
      setErr(e.message || 'Не удалось синхронизировать Telegram')
    } finally {
      setSaving(false)
    }
  }

  async function copyTelegramStart(linkObj = telegramLink) {
    const cmd = telegramStartCommand(linkObj)
    if (!cmd || cmd === '/start') {
      setErr('Сначала нажми «Новая ссылка», чтобы получить команду подключения.')
      return false
    }
    const ok = await copyTextSafe(cmd)
    if (ok) {
      setErr('')
      setTgNotice(`Команда скопирована: ${cmd}`)
      return true
    }
    setTgNotice('')
    setErr(`Не удалось скопировать автоматически. Отправь боту вручную: ${cmd}`)
    return false
  }

  async function goToTelegram(linkObj) {
    const webUrl = telegramConnectUrl(linkObj)
    const appUrl = telegramAppUrl(linkObj)
    if (!webUrl) {
      setErr('Не удалось собрать Telegram-ссылку. Нажми «Новая ссылка».')
      return false
    }
    setErr('')
    await copyTelegramStart(linkObj)
    const opened = openExternalUrl(webUrl)
    if (appUrl) {
      window.setTimeout(() => {
        try { window.location.href = appUrl } catch {}
      }, 250)
    }
    if (!opened) {
      setErr('Не удалось открыть Telegram автоматически. Скопируй команду ниже и открой бота вручную.')
      return false
    }
    return true
  }

  function openTelegramConnect() {
    refreshTelegramConnect(true)
  }

  async function refreshTelegramConnect(openAfter = true) {
    if (!canLoad) return
    setSaving(true)
    setErr('')
    setTgNotice('')
    try {
      const data = await apiFetch('/api/me/telegram-link', { method: 'POST', token })
      setTelegramLink(data || null)
      if (openAfter) await goToTelegram(data)
    } catch (e) {
      setErr(e.message || 'Не удалось обновить Telegram-ссылку')
    } finally {
      setSaving(false)
    }
  }

  async function unlinkTelegramConnect() {
    if (!canLoad) return
    setSaving(true)
    setErr('')
    try {
      const st = await apiFetch('/api/me/telegram-unlink', { method: 'POST', token })
      setTelegramSettings(prev => ({ ...(prev || {}), ...(st || {}) }))
      const linkRes = await apiFetch('/api/me/telegram-link', { token })
      setTelegramLink(linkRes || null)
      await loadTelegramPanel()
    } catch (e) {
      setErr(e.message || 'Не удалось отвязать Telegram')
    } finally {
      setSaving(false)
    }
  }

  async function loadActive() {
    if (!canLoad) return
    setErr('')
    try {
      if (tab === 'overview') {
        setOverview(await apiFetch('/api/admin/overview', { token }))
        return
      }
      if (tab === 'telegram') {
        await loadTelegramPanel()
        return
      }
      if (tab === 'users') {
        const data = await apiFetch(`/api/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`, { token })
        setUsers(Array.isArray(data) ? data : [])
        return
      }
      if (tab === 'moderation') {
        const params = new URLSearchParams()
        if (tutorStatusFilter) params.set('status', tutorStatusFilter)
        const data = await apiFetch(`/api/admin/tutors?${params.toString()}`, { token })
        setTutors(Array.isArray(data) ? data : [])
        return
      }
      if (tab === 'catalog') {
        const params = new URLSearchParams()
        if (catalogKind) params.set('kind', catalogKind)
        const data = await apiFetch(`/api/admin/catalog?${params.toString()}`, { token })
        setCatalog(Array.isArray(data) ? data : [])
        return
      }
      if (tab === 'reports') {
        const params = new URLSearchParams()
        if (reportStatus) params.set('status', reportStatus)
        params.set('limit', '200')
        const data = await apiFetch(`/api/admin/reports?${params.toString()}`, { token })
        setReports(Array.isArray(data) ? data : [])
        return
      }
      if (tab === 'bookings') {
        const params = new URLSearchParams()
        if (q) params.set('q', q)
        if (bookingStatus) params.set('status', bookingStatus)
        params.set('limit', '200')
        const data = await apiFetch(`/api/admin/bookings?${params.toString()}`, { token })
        setBookings(Array.isArray(data) ? data : [])
        return
      }
      if (tab === 'reviews') {
        const params = new URLSearchParams()
        if (q) params.set('q', q)
        if (reviewStars) params.set('stars', reviewStars)
        params.set('limit', '200')
        const data = await apiFetch(`/api/admin/reviews?${params.toString()}`, { token })
        setReviews(Array.isArray(data) ? data : [])
        return
      }
    } catch (e) {
      setErr(e.message || 'Ошибка загрузки')
    }
  }

  useEffect(() => {
    if (!canLoad) return
    loadActive()
  }, [tab, token, canLoad])

  async function refreshCurrent() {
    await loadActive()
  }

  async function updateTutor(p, patch) {
    setSaving(true)
    setErr('')
    try {
      await apiFetch(`/api/admin/tutors/${p.id}`, { method: 'PATCH', token, body: patch })
      await loadActive()
    } catch (e) {
      setErr(e.message || 'Не удалось обновить профиль')
    } finally {
      setSaving(false)
    }
  }

  async function updateUser(u, patch) {
    setSaving(true)
    setErr('')
    try {
      await apiFetch(`/api/admin/users/${u.id}`, { method: 'PATCH', token, body: patch })
      await loadActive()
    } catch (e) {
      setErr(e.message || 'Не удалось обновить пользователя')
    } finally {
      setSaving(false)
    }
  }

  async function adjustBalance(user, target) {
    const raw = prompt(`Сумма для ${target} (может быть отрицательной)`)
    if (!raw) return
    const amount = Number(raw)
    if (!Number.isFinite(amount) || Math.abs(amount) < 1) return
    const note = prompt('Комментарий (опционально):') || ''
    setSaving(true)
    setErr('')
    try {
      await apiFetch(`/api/admin/users/${user.id}/balance-adjust`, {
        method: 'POST', token, body: { target, amount: Math.trunc(amount), note }
      })
      await loadActive()
    } catch (e) {
      setErr(e.message || 'Ошибка изменения баланса')
    } finally {
      setSaving(false)
    }
  }

  async function patchBooking(b, patch) {
    setSaving(true)
    setErr('')
    try {
      await apiFetch(`/api/admin/bookings/${b.id}`, { method: 'PATCH', token, body: patch })
      await loadActive()
    } catch (e) {
      setErr(e.message || 'Не удалось обновить занятие')
    } finally {
      setSaving(false)
    }
  }

  async function deleteReview(r) {
    if (!window.confirm('Удалить отзыв?')) return
    setSaving(true)
    setErr('')
    try {
      await apiFetch(`/api/admin/reviews/${r.id}`, { method: 'DELETE', token })
      await loadActive()
    } catch (e) {
      setErr(e.message || 'Не удалось удалить отзыв')
    } finally {
      setSaving(false)
    }
  }

  async function patchReport(r, patch) {
    setSaving(true)
    setErr('')
    try {
      await apiFetch(`/api/admin/reports/${r.id}`, { method: 'PATCH', token, body: patch })
      await loadActive()
    } catch (e) {
      setErr(e.message || 'Не удалось обновить репорт')
    } finally {
      setSaving(false)
    }
  }

  async function createCatalogItem() {
    if (!catalogValue.trim()) return
    setSaving(true)
    setErr('')
    try {
      await apiFetch('/api/admin/catalog', {
        method: 'POST', token,
        body: { kind: catalogKind, value: catalogValue.trim(), is_active: true, order_index: Number(catalogOrder || 0) }
      })
      setCatalogValue('')
      await loadActive()
    } catch (e) {
      setErr(e.message || 'Не удалось создать категорию')
    } finally {
      setSaving(false)
    }
  }

  async function patchCatalogItem(item, patch) {
    setSaving(true)
    setErr('')
    try {
      await apiFetch(`/api/admin/catalog/${item.id}`, { method: 'PATCH', token, body: patch })
      await loadActive()
    } catch (e) {
      setErr(e.message || 'Не удалось обновить элемент')
    } finally {
      setSaving(false)
    }
  }

  async function deleteCatalogItem(item) {
    if (!window.confirm(`Удалить «${item.value}»?`)) return
    setSaving(true)
    setErr('')
    try {
      await apiFetch(`/api/admin/catalog/${item.id}`, { method: 'DELETE', token })
      await loadActive()
    } catch (e) {
      setErr(e.message || 'Не удалось удалить элемент')
    } finally {
      setSaving(false)
    }
  }

  const visibleTutors = useMemo(() => {
    if (!q.trim()) return tutors
    const needle = q.trim().toLowerCase()
    return tutors.filter((p) => {
      const hay = [p.display_name, p.email, ...(p.subjects || []), ...(p.goals || [])].join(' ').toLowerCase()
      return hay.includes(needle)
    })
  }, [tutors, q])

  const visibleCatalog = useMemo(() => {
    if (!q.trim()) return catalog
    const needle = q.trim().toLowerCase()
    return catalog.filter((item) => `${item.value || ''}`.toLowerCase().includes(needle))
  }, [catalog, q])

  const visibleReports = useMemo(() => {
    if (!q.trim()) return reports
    const needle = q.trim().toLowerCase()
    return reports.filter((r) => [r.category, r.message, r.reporter_email, r.reported_email].join(' ').toLowerCase().includes(needle))
  }, [reports, q])

  const overviewMetrics = useMemo(() => {
    const o = overview || {}
    const publicationRate = o.profiles ? Math.round((Number(o.published_profiles || 0) / Math.max(1, Number(o.profiles || 0))) * 100) : 0
    const completionRate = o.bookings ? Math.round((Number(o.bookings_done || 0) / Math.max(1, Number(o.bookings || 0))) * 100) : 0
    const reviewCoverage = o.bookings_done ? Math.round((Number(o.reviews || 0) / Math.max(1, Number(o.bookings_done || 0))) * 100) : 0
    const reportLoad = o.users ? Math.round((Number(o.open_reports || 0) / Math.max(1, Number(o.users || 0))) * 100) : 0
    return { publicationRate, completionRate, reviewCoverage, reportLoad }
  }, [overview])

  const moderationMetrics = useMemo(() => {
    const arr = Array.isArray(visibleTutors) ? visibleTutors : []
    return {
      total: arr.length,
      approved: arr.filter(x => x.documents_status === 'approved').length,
      pending: arr.filter(x => x.documents_status === 'pending').length,
      rejected: arr.filter(x => x.documents_status === 'rejected').length,
      published: arr.filter(x => x.is_published).length,
    }
  }, [visibleTutors])

  const usersMetrics = useMemo(() => {
    const arr = Array.isArray(users) ? users : []
    return {
      total: arr.length,
      admins: arr.filter(x => x.role === 'admin').length,
      tutors: arr.filter(x => x.role === 'tutor').length,
      students: arr.filter(x => x.role === 'student').length,
      blocked: arr.filter(x => !x.is_active).length,
    }
  }, [users])

  const telegramReady = Boolean(telegramStatus?.token_configured && telegramStatus?.public_app_url && telegramStatus?.desired_webhook_url)
  const telegramWebhookLive = Boolean(telegramStatus?.webhook_matches)

  if (!me || me.role !== 'admin') return null

  return (
    <div className="adminShell productPage adminDesignSet">
      <div className="adminSidebar card productSidebarCard">
        <div className="productPageTitle">Admin</div>
        <div className="small">Операции, модерация, Telegram и качество платформы</div>
        <div className="adminMenu">
          {TABS.map(t => (
            <button key={t.id} className={tab === t.id ? 'btn btnPrimary adminMenuBtn' : 'btn adminMenuBtn'} onClick={() => goTab(t.id)}>
              {t.title}
            </button>
          ))}
        </div>
        <div className="adminSidebarFooter">
          <StatusPill tone={telegramWebhookLive ? 'success' : 'warn'}>{telegramWebhookLive ? 'Telegram live' : 'Telegram требует sync'}</StatusPill>
          <div className="small">Роль: {me.role}</div>
        </div>
      </div>

      <div className="grid" style={{ gap: 12 }}>
        <div className="card productHeroCard">
          <div className="productHeroTop">
            <div>
              <div className="productPageTitle">{activeTab.title}</div>
              <div className="small">{activeTab.hint}</div>
            </div>
            <div className="productActionBar adminActionBarWrap">
              {activeTab.searchable ? (
                <input
                  className="input adminSearchInput"
                  value={q}
                  onChange={e => setQ(e.target.value)}
                  placeholder={tab === 'users' ? 'Поиск по email' : tab === 'moderation' ? 'Поиск по имени, email, предмету' : 'Поиск по тексту'}
                />
              ) : null}
              <button className="btn" onClick={refreshCurrent} disabled={saving}>Обновить</button>
              <button className="btn" onClick={() => goTab('telegram')}>Telegram</button>
              <Link className="btn" to="/">На сайт</Link>
            </div>
          </div>
          <div className="adminHeroStatsRow">
            <StatusPill tone="default">Раздел: {activeTab.title}</StatusPill>
            {tab === 'moderation' ? <StatusPill tone="warn">{listCountLabel(moderationMetrics.pending, 'pending', 'pending')}</StatusPill> : null}
            {tab === 'users' ? <StatusPill tone="default">Пользователей: {usersMetrics.total}</StatusPill> : null}
            <StatusPill tone={telegramReady ? 'success' : 'warn'}>{telegramReady ? 'Конфиг Telegram готов' : 'Проверь env Telegram'}</StatusPill>
          </div>
          {err && <div className="footerNote">{err}</div>}
          {tgNotice && <div className="footerNote">{tgNotice}</div>}
        </div>

        {tab === 'overview' && overview && (
          <>
            <div className="adminStatsGrid">
              <AdminStat label="Пользователи" value={overview.users} helper={`${overview.students || 0} students`} />
              <AdminStat label="Репетиторы" value={overview.tutors} helper={`${overview.admins || 0} admins`} />
              <AdminStat label="Профили" value={overview.profiles} helper={`${overview.published_profiles || 0} опубликовано`} tone="accent" />
              <AdminStat label="Занятия" value={overview.bookings} helper={`${overview.bookings_done || 0} done`} />
              <AdminStat label="Отзывы" value={overview.reviews} helper={`${overview.open_reports || 0} open reports`} />
              <AdminStat label="ДЗ" value={overview.homework} helper={`${overview.topics || 0} topics`} />
              <AdminStat label="Планы" value={overview.plans} helper={`${overview.plan_items || 0} items`} />
              <AdminStat label="Квизы" value={overview.quizzes} helper={`${overview.quiz_attempts || 0} attempts`} />
            </div>

            <div className="adminOverviewGrid">
              <div className="card adminInsightCard">
                <div className="panelTitle">
                  <div>
                    <div className="h3">Пульс платформы</div>
                    <div className="small">Быстрые операционные коэффициенты по текущим данным.</div>
                  </div>
                </div>
                <div className="adminMiniGrid">
                  <AdminStat label="Publication rate" value={`${overviewMetrics.publicationRate}%`} tone="success" />
                  <AdminStat label="Completion rate" value={`${overviewMetrics.completionRate}%`} tone="accent" />
                  <AdminStat label="Review coverage" value={`${overviewMetrics.reviewCoverage}%`} tone="default" />
                  <AdminStat label="Report load" value={`${overviewMetrics.reportLoad}%`} tone="warn" />
                </div>
                <div className="adminQuickLinks">
                  <button className="btn" onClick={() => goTab('moderation')}>Проверить модерацию</button>
                  <button className="btn" onClick={() => goTab('reports')}>Открыть жалобы</button>
                  <button className="btn" onClick={() => goTab('telegram')}>Проверить Telegram</button>
                </div>
              </div>

              <div className="card adminInsightCard">
                <div className="panelTitle">
                  <div>
                    <div className="h3">Attendance / show-rate</div>
                    <div className="small">Статусы присутствия и качество связи на уроках.</div>
                  </div>
                </div>
                <div className="adminMiniGrid">
                  <AdminStat label="Show-rate" value={`${overview.attendance?.participant_show_rate_percent ?? 0}%`} tone="success" />
                  <AdminStat label="Оба участника" value={overview.attendance?.joined_both ?? 0} />
                  <AdminStat label="Опозданий" value={overview.attendance?.late_entries ?? 0} tone="warn" />
                  <AdminStat label="Не пришли" value={overview.attendance?.lessons_with_absent ?? 0} tone="warn" />
                  <AdminStat label="Слабая сеть" value={overview.attendance?.weak_network_events ?? 0} tone="warn" />
                  <AdminStat label="Audio fallback" value={overview.attendance?.audio_only_events ?? 0} />
                </div>
              </div>
            </div>
          </>
        )}

        {tab === 'telegram' && (
          <div className="grid" style={{ gap: 12 }}>
            <div className="telegramAssistantCard productSectionCard">
              <div className="telegramAssistantHeader">
                <div className="telegramAssistantMeta">
                  <img className="telegramAvatar" src="/telegram-assistant-avatar.png" alt="DoskoLink Assistant" />
                  <div>
                    <div className="telegramEyebrow">Admin control</div>
                    <div className="telegramTitle">Telegram для админа</div>
                    <div className="small" style={{ marginTop: 6 }}>
                      {telegramLink?.connected
                        ? `Подключено: ${telegramSettings?.telegram_username ? '@' + telegramSettings.telegram_username : (telegramSettings?.telegram_chat_id || 'Telegram')} • связано ${formatDateTimeShort(telegramSettings?.telegram_linked_at)}`
                        : 'Подключи Telegram из этого раздела. Здесь же виден статус webhook и команды бота.'}
                    </div>
                  </div>
                </div>
                <div className="telegramBadgeWrap">
                  <div className="telegramRoleBadge">Роль: админ</div>
                  <div className="telegramBotBadge">@{telegramBotUsername(telegramLink, telegramStatus)}</div>
                </div>
              </div>

              <div className="telegramFeatureGrid">
                {telegramFeatureBullets().map((item) => (
                  <div key={item} className="telegramFeatureItem">{item}</div>
                ))}
              </div>

              <div className="telegramCommandRow">
                {telegramCommandChips(telegramStatus).slice(0, 18).map((cmd) => (
                  <span key={cmd} className="telegramCommandChip">{cmd}</span>
                ))}
              </div>

              <div className="telegramActionRow">
                <button className="btn btnPrimary" onClick={openTelegramConnect} disabled={saving}>Подключить Telegram</button>
                <button className="btn" onClick={() => copyTelegramStart(telegramLink)} disabled={saving || !telegramLink?.token}>Скопировать команду</button>
                <button className="btn" onClick={() => refreshTelegramConnect(true)} disabled={saving}>Новая ссылка</button>
                <button className="btn" onClick={syncTelegramInfra} disabled={saving}>Sync webhook</button>
                <button className="btn" onClick={unlinkTelegramConnect} disabled={saving || !telegramLink?.connected}>Отвязать</button>
              </div>

              {telegramLink?.token ? (
                <div className="telegramCodeGroup">
                  <div className="label">Короткая команда для ручного запуска</div>
                  <input className="input telegramCodeInput" value={telegramShortStartCommand(telegramLink)} readOnly onFocus={(e) => e.target.select()} />
                  <div className="footerNote">Скопируй эту строку целиком и вставь её в чат с ботом. Просто /start без кода не подключит аккаунт.</div>
                  <div className="label" style={{ marginTop: 10 }}>Полная команда</div>
                  <input className="input telegramCodeInput" value={telegramStartCommand(telegramLink)} readOnly onFocus={(e) => e.target.select()} />
                </div>
              ) : null}
            </div>

            <div className="telegramStatusGrid">
              <AdminStat label="Bot token" value={telegramStatus?.token_configured ? 'OK' : 'Нет'} tone={telegramStatus?.token_configured ? 'success' : 'warn'} helper="DL_TELEGRAM_BOT_TOKEN" />
              <AdminStat label="Public app URL" value={telegramStatus?.public_app_url ? 'OK' : 'Нет'} tone={telegramStatus?.public_app_url ? 'success' : 'warn'} helper={telegramStatus?.public_app_url || 'DL_PUBLIC_APP_URL'} />
              <AdminStat label="Webhook" value={telegramWebhookLive ? 'Live' : 'Не совпадает'} tone={telegramWebhookLive ? 'success' : 'warn'} helper={telegramStatus?.desired_webhook_url || 'endpoint не собран'} />
              <AdminStat label="Pending updates" value={telegramStatus?.webhook_info?.pending_update_count ?? 0} helper="очередь Telegram" />
              <AdminStat label="Команды" value={telegramStatus?.commands_count ?? 0} helper={telegramStatus?.menu_button_type || 'menu button'} />
            </div>

            <div className="card adminInsightCard">
              <div className="panelTitle">
                <div>
                  <div className="h3">Диагностика бота</div>
                  <div className="small">Если бот не реагирует на команды, сначала смотри на webhook и последний текст ошибки.</div>
                </div>
              </div>
              <div className="telegramDebugList">
                <div className="adminListRow"><b>Webhook URL:</b> <span>{telegramStatus?.webhook_info?.url || 'не установлен'}</span></div>
                <div className="adminListRow"><b>Ожидаемый URL:</b> <span>{telegramStatus?.desired_webhook_url || 'не сформирован'}</span></div>
                <div className="adminListRow"><b>Последняя ошибка:</b> <span>{telegramStatus?.webhook_info?.last_error_message || 'нет'}</span></div>
                <div className="adminListRow"><b>Последняя ошибка UTC:</b> <span>{telegramStatus?.webhook_info?.last_error_date ? formatDateTimeShort(new Date(Number(telegramStatus.webhook_info.last_error_date) * 1000)) : '—'}</span></div>
                <div className="adminListRow"><b>Secret token:</b> <span>{telegramStatus?.secret_configured ? 'задан' : 'не задан'}</span></div>
                <div className="adminListRow"><b>Команды:</b> <span>После sync бот получает setWebhook + setMyCommands + setMyDescription + setMyShortDescription + setChatMenuButton.</span></div>
                <div className="adminListRow"><b>Short description:</b> <span>{telegramStatus?.bot_short_description || '—'}</span></div>
                <div className="adminListRow"><b>Description:</b> <span>{telegramStatus?.bot_description || '—'}</span></div>
                <div className="adminListRow"><b>Menu button:</b> <span>{telegramStatus?.menu_button_type || '—'}</span></div>
              </div>
            </div>
          </div>
        )}

        {tab === 'moderation' && (
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 18 }}>Модерация профилей репетиторов</div>
                <div className="sub">Проверка документов, публикации и качества карточек.</div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <select className="select" value={tutorStatusFilter} onChange={e => setTutorStatusFilter(e.target.value)}>
                  <option value="pending">pending</option>
                  <option value="approved">approved</option>
                  <option value="rejected">rejected</option>
                  <option value="draft">draft</option>
                  <option value="">all</option>
                </select>
                <button className="btn" onClick={loadActive}>Применить</button>
              </div>
            </div>

            <div className="adminMiniGrid" style={{ marginTop: 12 }}>
              <AdminStat label="Всего" value={moderationMetrics.total} />
              <AdminStat label="Pending" value={moderationMetrics.pending} tone="warn" />
              <AdminStat label="Approved" value={moderationMetrics.approved} tone="success" />
              <AdminStat label="Rejected" value={moderationMetrics.rejected} tone="warn" />
              <AdminStat label="Published" value={moderationMetrics.published} tone="accent" />
            </div>

            <div className="grid" style={{ gap: 10, marginTop: 12 }}>
              {visibleTutors.length === 0 ? <div className="small">Нет профилей.</div> : visibleTutors.map(p => (
                <div key={p.id} className="card adminDataCard">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 260 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <div style={{ fontWeight: 900 }}>{p.display_name}</div>
                        {p.founding_tutor ? <span className="pill badgeGold">Founding tutor</span> : null}
                        <StatusPill tone={p.documents_status === 'approved' ? 'success' : p.documents_status === 'pending' ? 'warn' : 'default'}>docs: {p.documents_status || 'draft'}</StatusPill>
                        <StatusPill tone={p.is_published ? 'success' : 'default'}>published: {boolMark(p.is_published)}</StatusPill>
                      </div>
                      <div className="small">{p.email} • {p.language} • {p.price_per_hour || 0} ₽/час</div>
                      <div className="small">Рейтинг: {Number(p.rating_avg || 0).toFixed(1)} ({p.rating_count || 0}) • занятий: {p.lessons_count || 0}</div>
                      <div className="small">Предметы: {(p.subjects || []).join(', ') || '—'}</div>
                      <div className="small">Цели: {(p.goals || []).join(', ') || '—'}</div>
                      {p.documents_note ? <div className="small" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>Комментарий: {p.documents_note}</div> : null}

                      <div className="label">Ссылки на документы</div>
                      <div className="pills">
                        {(p.certificate_links || []).length ? (p.certificate_links || []).map((u, i) => (
                          <a key={`${p.id}-${i}`} className="btn" href={u} target="_blank" rel="noreferrer">Документ {i + 1}</a>
                        )) : <span className="small">Ссылок нет</span>}
                      </div>
                    </div>

                    <div className="grid adminActionGrid">
                      <button className="btn btnPrimary" disabled={saving} onClick={() => updateTutor(p, { documents_status: 'approved', is_published: true })}>Одобрить</button>
                      <button className="btn" disabled={saving} onClick={() => {
                        const note = prompt('Причина отклонения (покажем репетитору):', p.documents_note || '')
                        if (note === null) return
                        updateTutor(p, { documents_status: 'rejected', documents_note: note, is_published: false })
                      }}>Отклонить</button>
                      <button className="btn" disabled={saving} onClick={() => updateTutor(p, { is_published: !p.is_published })}>{p.is_published ? 'Снять с публикации' : 'Опубликовать'}</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'catalog' && (
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 18 }}>Категории</div>
                <div className="sub">Управление предметами, целями, уровнями и экзаменами.</div>
              </div>
              <div className="small">Найдено: {visibleCatalog.length}</div>
            </div>

            <div className="grid filtersGrid" style={{ marginTop: 12 }}>
              <div>
                <div className="label">Тип</div>
                <select className="select" value={catalogKind} onChange={e => setCatalogKind(e.target.value)}>
                  {CATALOG_KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
                </select>
              </div>
              <div>
                <div className="label">Новое значение</div>
                <input className="input" value={catalogValue} onChange={e => setCatalogValue(e.target.value)} placeholder="Например, физика" />
              </div>
              <div>
                <div className="label">Порядок</div>
                <input className="input" type="number" value={catalogOrder} onChange={e => setCatalogOrder(e.target.value)} />
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
                <button className="btn btnPrimary" disabled={saving} onClick={createCatalogItem}>Добавить</button>
                <button className="btn" onClick={loadActive}>Обновить</button>
              </div>
            </div>

            <div className="grid" style={{ gap: 10, marginTop: 12 }}>
              {visibleCatalog.length === 0 ? <div className="small">Нет элементов.</div> : visibleCatalog.map(item => (
                <div key={item.id} className="card adminDataCard">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>{item.value}</div>
                      <div className="small">kind: {item.kind} • order: {item.order_index} • active: {String(item.is_active)}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button className="btn" onClick={() => {
                        const next = prompt('Новое значение', item.value)
                        if (next === null) return
                        patchCatalogItem(item, { value: next })
                      }}>Переименовать</button>
                      <button className="btn" onClick={() => patchCatalogItem(item, { is_active: !item.is_active })}>{item.is_active ? 'Выключить' : 'Включить'}</button>
                      <button className="btn" onClick={() => deleteCatalogItem(item)}>Удалить</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'reports' && (
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 18 }}>Жалобы / репорты</div>
                <div className="sub">Просмотр и обработка жалоб пользователей и уроков.</div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <select className="select" value={reportStatus} onChange={e => setReportStatus(e.target.value)}>
                  <option value="open">open</option>
                  <option value="resolved">resolved</option>
                  <option value="">all</option>
                </select>
                <button className="btn" onClick={loadActive}>Применить</button>
              </div>
            </div>
            <div className="grid" style={{ gap: 10, marginTop: 10 }}>
              {visibleReports.length === 0 ? <div className="small">Нет репортов.</div> : visibleReports.map(r => (
                <div key={r.id} className="card adminDataCard">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>#{r.id} • {r.status} • {r.category}</div>
                      <div className="small">Reporter: {r.reporter_email}{r.reported_email ? ` • Reported: ${r.reported_email}` : ''}</div>
                      <div className="small">{new Date(r.created_at).toLocaleString()}</div>
                      {r.booking_id ? <div className="small">booking_id: {r.booking_id}</div> : null}
                      <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{r.message}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      {r.booking_id ? <button className="btn" onClick={() => nav(`/room/booking-${r.booking_id}`)}>Комната</button> : null}
                      {r.status !== 'resolved'
                        ? <button className="btn btnPrimary" onClick={() => patchReport(r, { status: 'resolved' })}>Закрыть</button>
                        : <button className="btn" onClick={() => patchReport(r, { status: 'open' })}>Открыть снова</button>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'bookings' && (
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 18 }}>Занятия</div>
                <div className="sub">Отмена, done, перенос и быстрый переход в комнату.</div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <select className="select" value={bookingStatus} onChange={e => setBookingStatus(e.target.value)}>
                  <option value="">все</option>
                  <option value="confirmed">confirmed</option>
                  <option value="cancelled">cancelled</option>
                  <option value="done">done</option>
                </select>
                <button className="btn" onClick={loadActive}>Применить</button>
              </div>
            </div>
            <div className="grid" style={{ gap: 10, marginTop: 10 }}>
              {bookings.length === 0 ? <div className="small">Нет занятий.</div> : bookings.map(b => (
                <div key={b.id} className="card adminDataCard">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>#{b.id} • {b.status}</div>
                      <div className="small">Tutor: {b.tutor_email} • Student: {b.student_email}</div>
                      <div className="small">Time: {b.starts_at ? new Date(b.starts_at).toLocaleString() : '—'} {b.ends_at ? `— ${new Date(b.ends_at).toLocaleString()}` : ''}</div>
                      <div className="small">slot_id: {b.slot_id}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <button className="btn" onClick={() => nav(`/room/booking-${b.id}`)}>Комната</button>
                      <button className="btn" onClick={() => patchBooking(b, { status: 'cancelled' })}>Отменить</button>
                      <button className="btn btnPrimary" onClick={() => patchBooking(b, { status: 'done' })}>Done</button>
                      <button className="btn" onClick={() => {
                        const sid = prompt('Новый slot_id')
                        if (!sid) return
                        patchBooking(b, { slot_id: Number(sid) })
                      }}>Перенести</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'reviews' && (
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 18 }}>Отзывы</div>
                <div className="sub">Удаление проблемных отзывов с пересчётом рейтинга.</div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <select className="select" value={reviewStars} onChange={e => setReviewStars(e.target.value)}>
                  <option value="">все оценки</option>
                  {[5,4,3,2,1].map(s => <option key={s} value={String(s)}>{s}★</option>)}
                </select>
                <button className="btn" onClick={loadActive}>Применить</button>
              </div>
            </div>
            <div className="grid" style={{ gap: 10, marginTop: 10 }}>
              {reviews.length === 0 ? <div className="small">Нет отзывов.</div> : reviews.map(r => (
                <div key={r.id} className="card adminDataCard">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>#{r.id} • {r.stars}★</div>
                      <div className="small">Tutor: {r.tutor_email} • Student: {r.student_email} • booking_id: {r.booking_id}</div>
                      <div className="small">{new Date(r.created_at).toLocaleString()}</div>
                      <div style={{ marginTop: 6 }}>{r.text || <span className="small">(без текста)</span>}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <button className="btn" onClick={() => nav(`/room/booking-${r.booking_id}`)}>Комната</button>
                      <button className="btn" onClick={() => deleteReview(r)}>Удалить</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'users' && (
          <div className="card">
            <div style={{ fontWeight: 900, fontSize: 18 }}>Пользователи</div>
            <div className="sub">Роли, блокировка, баланс и быстрые админ-действия.</div>
            <div className="adminMiniGrid" style={{ marginTop: 12 }}>
              <AdminStat label="Всего" value={usersMetrics.total} />
              <AdminStat label="Tutors" value={usersMetrics.tutors} tone="accent" />
              <AdminStat label="Students" value={usersMetrics.students} />
              <AdminStat label="Admins" value={usersMetrics.admins} tone="success" />
              <AdminStat label="Blocked" value={usersMetrics.blocked} tone="warn" />
            </div>
            <div className="grid" style={{ gap: 10, marginTop: 10 }}>
              {users.length === 0 ? <div className="small">Нет пользователей.</div> : users.map(u => (
                <div key={u.id} className="card adminDataCard">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>#{u.id} • {u.email}</div>
                      <div className="small">role: {u.role} • active: {String(u.is_active)} • last login: {u.last_login_at ? formatDateTimeShort(u.last_login_at) : '—'}</div>
                      <div className="small">баланс: {u.balance ?? 0} ₽ • доход: {u.earnings ?? 0} ₽</div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <select className="select" value={u.role} onChange={(e) => updateUser(u, { role: e.target.value })}>
                        <option value="student">student</option>
                        <option value="tutor">tutor</option>
                        <option value="admin">admin</option>
                      </select>
                      <button className="btn" onClick={() => updateUser(u, { is_active: !u.is_active })}>{u.is_active ? 'Заблокировать' : 'Разблокировать'}</button>
                      <button className="btn" onClick={() => adjustBalance(u, 'balance')}>Баланс ±</button>
                      <button className="btn" onClick={() => adjustBalance(u, 'earnings')}>Доход ±</button>
                      <button className="btn" onClick={() => {
                        const pw = prompt('Новый пароль (8+ символов):')
                        if (!pw) return
                        updateUser(u, { reset_password: pw })
                      }}>Сбросить пароль</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
