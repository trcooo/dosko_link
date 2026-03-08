import React, { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth.jsx'
import { apiFetch } from '../api'

const TABS = [
  { id: 'overview', title: 'Сводка' },
  { id: 'moderation', title: 'Модерация репетиторов' },
  { id: 'catalog', title: 'Категории' },
  { id: 'reports', title: 'Жалобы/репорты' },
  { id: 'bookings', title: 'Занятия' },
  { id: 'reviews', title: 'Отзывы' },
  { id: 'users', title: 'Пользователи' },
]

const CATALOG_KINDS = [
  { value: 'subject', label: 'Предметы' },
  { value: 'goal', label: 'Цели' },
  { value: 'level', label: 'Уровни' },
  { value: 'grade', label: 'Классы' },
  { value: 'language', label: 'Языки' },
  { value: 'exam', label: 'Экзамены' },
]

function AdminStat({ label, value }) {
  return (
    <div className="adminStat">
      <div className="small">{label}</div>
      <div style={{ fontWeight: 900, fontSize: 20 }}>{value ?? 0}</div>
    </div>
  )
}

function boolMark(v) {
  return v ? '✓' : '—'
}

const TELEGRAM_BOT_FALLBACK = 'doskolink_bot'

function telegramBotUsername(link) {
  return String(link?.bot_username || TELEGRAM_BOT_FALLBACK || '').trim().replace(/^@+/, '')
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

function formatDateTimeShort(v) {
  if (!v) return '—'
  try { return new Date(v).toLocaleString() } catch { return String(v) }
}

export default function Admin() {
  const { me, token, loading } = useAuth()
  const nav = useNavigate()

  const [tab, setTab] = useState('overview')
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

  const [tutorStatusFilter, setTutorStatusFilter] = useState('pending')
  const [bookingStatus, setBookingStatus] = useState('')
  const [reviewStars, setReviewStars] = useState('')
  const [reportStatus, setReportStatus] = useState('open')
  const [catalogKind, setCatalogKind] = useState('subject')
  const [catalogValue, setCatalogValue] = useState('')
  const [catalogOrder, setCatalogOrder] = useState('0')

  useEffect(() => {
    if (loading) return
    if (!me) nav('/login')
    else if (me.role !== 'admin') nav('/')
  }, [loading, me, nav])

  const canLoad = useMemo(() => Boolean(token && me?.role === 'admin'), [token, me])

  async function loadTelegramPanel() {
    if (!canLoad) return
    try {
      const [settingsRes, linkRes] = await Promise.all([
        apiFetch('/api/me/settings', { token }),
        apiFetch('/api/me/telegram-link', { token }),
      ])
      setTelegramSettings(settingsRes || null)
      setTelegramLink(linkRes || null)
    } catch (e) {
      setErr(e.message || 'Не удалось загрузить Telegram-настройки')
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

  useEffect(() => { loadActive() }, [tab, token, canLoad])
  useEffect(() => { if (canLoad) loadTelegramPanel() }, [canLoad, token])

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
    if (!confirm('Удалить отзыв?')) return
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
    if (!confirm(`Удалить «${item.value}»?`)) return
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

  if (!me || me.role !== 'admin') return null

  return (
    <div className="adminShell">
      <div className="adminSidebar card">
        <div style={{ fontWeight: 900, fontSize: 22 }}>Admin</div>
        <div className="small">Education Dashboard style (MVP)</div>
        <div className="adminMenu">
          {TABS.map(t => (
            <button key={t.id} className={tab === t.id ? 'btn btnPrimary adminMenuBtn' : 'btn adminMenuBtn'} onClick={() => setTab(t.id)}>
              {t.title}
            </button>
          ))}
        </div>
        <div className="small" style={{ marginTop: 'auto' }}>Роль: {me.role}</div>
      </div>

      <div className="grid" style={{ gap: 12 }}>
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 900, fontSize: 20 }}>
                {TABS.find(x => x.id === tab)?.title || 'Админка'}
              </div>
              <div className="small">Модерация профилей, документы, жалобы и категории предметов/целей.</div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input className="input" style={{ minWidth: 220 }} value={q} onChange={e => setQ(e.target.value)} placeholder="Поиск (email / текст)" />
              <button className="btn" onClick={refreshCurrent} disabled={saving}>Обновить</button>
              <Link className="btn" to="/">На сайт</Link>
            </div>
          </div>
          {err && <div className="footerNote">{err}</div>}
          {tgNotice && <div className="footerNote">{tgNotice}</div>}
        </div>

        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 900, fontSize: 18 }}>Telegram для админа</div>
              <div className="small" style={{ marginTop: 6 }}>
                {telegramLink?.connected
                  ? `Подключено: ${telegramSettings?.telegram_username ? '@' + telegramSettings.telegram_username : (telegramSettings?.telegram_chat_id || 'Telegram')} • связано ${formatDateTimeShort(telegramSettings?.telegram_linked_at)}`
                  : 'Подключи Telegram прямо из админ-панели: кнопка откроет бота с готовой командой /start.'}
              </div>
              <div className="footerNote" style={{ marginTop: 8 }}>Роль определяется автоматически: <b>админ</b>. Доступны /whoami, /today, /next, /schedule и /stats.</div>
              <div className="footerNote" style={{ marginTop: 8 }}>Бот: @{telegramBotUsername(telegramLink)}</div>
              <div className="footerNote" style={{ marginTop: 8 }}>Если Telegram не привяжется автоматически после перехода, просто нажми «Скопировать команду» и вставь её в чат бота.</div>
              {tgNotice ? <div className="footerNote" style={{ marginTop: 8 }}><b>{tgNotice}</b></div> : null}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btnPrimary" onClick={openTelegramConnect} disabled={saving}>Подключить Telegram</button>
              <button className="btn" onClick={() => copyTelegramStart(telegramLink)} disabled={saving || !telegramLink?.token}>Скопировать команду</button>
              <button className="btn" onClick={() => refreshTelegramConnect(true)} disabled={saving}>Новая ссылка</button>
              <button className="btn" onClick={unlinkTelegramConnect} disabled={saving || !telegramLink?.connected}>Отвязать</button>
            </div>
          </div>
          {telegramLink?.token ? (
            <div style={{ marginTop: 12 }}>
              <div className="label">Короткая команда для ручного запуска</div>
              <input className="input" value={telegramShortStartCommand(telegramLink)} readOnly onFocus={(e) => e.target.select()} />
              <div className="footerNote">Скопируй эту строку целиком и вставь её в чат с ботом. Это безопасный короткий код подключения. Просто /start без кода не подключит аккаунт.</div>
              <div className="label" style={{ marginTop: 10 }}>Полная команда</div>
              <input className="input" value={telegramStartCommand(telegramLink)} readOnly onFocus={(e) => e.target.select()} />
            </div>
          ) : null}
        </div>

        {tab === 'overview' && overview && (
          <>
            <div className="adminStatsGrid">
              <AdminStat label="Пользователи" value={overview.users} />
              <AdminStat label="Репетиторы" value={overview.tutors} />
              <AdminStat label="Профили" value={overview.profiles} />
              <AdminStat label="Опубликованные" value={overview.published_profiles} />
              <AdminStat label="Занятия" value={overview.bookings} />
              <AdminStat label="Done" value={overview.bookings_done} />
              <AdminStat label="Отзывы" value={overview.reviews} />
              <AdminStat label="Открытые репорты" value={overview.open_reports} />
            </div>
            <div className="card">
              <div className="small">Быстрый запуск MVP:</div>
              <div className="pills" style={{ marginTop: 8 }}>
                <button className="btn" onClick={() => setTab('moderation')}>Проверить документы репетиторов</button>
                <button className="btn" onClick={() => setTab('catalog')}>Обновить предметы/цели</button>
                <button className="btn" onClick={() => setTab('reports')}>Открыть жалобы</button>
              </div>
            </div>
          </>
        )}

        {tab === 'moderation' && (
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 18 }}>Модерация профилей репетиторов</div>
                <div className="sub">Проверка сертификатов и дипломов по ссылкам (Google Drive / облако).</div>
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

            <div className="grid" style={{ gap: 10, marginTop: 10 }}>
              {tutors.length === 0 ? <div className="small">Нет профилей.</div> : tutors.map(p => (
                <div key={p.id} className="card" style={{ border: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 260 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <div style={{ fontWeight: 900 }}>{p.display_name}</div>
                        {p.founding_tutor ? <span className="pill badgeGold">Founding tutor</span> : null}
                        <span className="pill">docs: {p.documents_status || 'draft'}</span>
                        <span className="pill">published: {boolMark(p.is_published)}</span>
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

                    <div className="grid" style={{ gap: 8, alignContent: 'start' }}>
                      <button className="btn btnPrimary" disabled={saving} onClick={() => updateTutor(p, { documents_status: 'approved', is_published: true })}>Одобрить</button>
                      <button className="btn" disabled={saving} onClick={() => {
                        const note = prompt('Причина отклонения (покажем репетитору):', p.documents_note || '')
                        updateTutor(p, { documents_status: 'rejected', documents_note: note || '' })
                      }}>Отклонить</button>
                      <button className="btn" disabled={saving} onClick={() => updateTutor(p, { is_published: !p.is_published })}>{p.is_published ? 'Снять с публикации' : 'Опубликовать'}</button>
                      <button className="btn" disabled={saving} onClick={() => updateTutor(p, { founding_tutor: !p.founding_tutor })}>{p.founding_tutor ? 'Убрать Founding' : 'Дать Founding'}</button>
                      <button className="btn" disabled={saving} onClick={() => {
                        const note = prompt('Комментарий для репетитора:', p.documents_note || '')
                        if (note === null) return
                        updateTutor(p, { documents_note: note })
                      }}>Комментарий</button>
                      <Link className="btn" to={`/tutor/${p.id}`}>Открыть карточку</Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'catalog' && (
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 18 }}>Управление категориями</div>
                <div className="sub">Предметы, цели, уровни, классы, языки и экзамены для фильтров и формы профиля.</div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <select className="select" value={catalogKind} onChange={e => setCatalogKind(e.target.value)}>
                  {CATALOG_KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
                </select>
                <button className="btn" onClick={loadActive}>Показать</button>
              </div>
            </div>

            <div className="row" style={{ marginTop: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div className="label">Новый элемент</div>
                <input className="input" value={catalogValue} onChange={e => setCatalogValue(e.target.value)} placeholder="Например: Математика" />
              </div>
              <div style={{ width: 120 }}>
                <div className="label">Порядок</div>
                <input className="input" type="number" value={catalogOrder} onChange={e => setCatalogOrder(e.target.value)} />
              </div>
              <button className="btn btnPrimary" onClick={createCatalogItem} disabled={saving}>Добавить</button>
            </div>

            <div className="grid" style={{ gap: 8, marginTop: 12 }}>
              {catalog.length === 0 ? <div className="small">Нет элементов.</div> : catalog.map(item => (
                <div key={item.id} className="card" style={{ border: '1px solid var(--border)', padding: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
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
                      <button className="btn" onClick={() => {
                        const next = prompt('Новый order_index', String(item.order_index ?? 0))
                        if (next === null) return
                        patchCatalogItem(item, { order_index: Number(next || 0) })
                      }}>Порядок</button>
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
                <div className="sub">Просмотр и обработка жалоб пользователей/уроков.</div>
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
              {reports.length === 0 ? <div className="small">Нет репортов.</div> : reports.map(r => (
                <div key={r.id} className="card" style={{ border: '1px solid var(--border)' }}>
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
                <div className="sub">Отмена / done / перенос по slot_id.</div>
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
                <div key={b.id} className="card" style={{ border: '1px solid var(--border)' }}>
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
                <div className="sub">Удаление проблемных отзывов с пересчетом рейтинга.</div>
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
                <div key={r.id} className="card" style={{ border: '1px solid var(--border)' }}>
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
            <div className="sub">Роли, блокировка, баланс (тестовый), сброс пароля.</div>
            <div className="grid" style={{ gap: 10, marginTop: 10 }}>
              {users.length === 0 ? <div className="small">Нет пользователей.</div> : users.map(u => (
                <div key={u.id} className="card" style={{ border: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>#{u.id} • {u.email}</div>
                      <div className="small">role: {u.role} • active: {String(u.is_active)}</div>
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
