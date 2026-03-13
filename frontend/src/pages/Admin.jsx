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


function adminDateKey(d) {
  const dt = new Date(d)
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  const day = String(dt.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function adminStartOfDay(d) {
  const dt = new Date(d)
  dt.setHours(0, 0, 0, 0)
  return dt
}

function adminEndOfDay(d) {
  const dt = new Date(d)
  dt.setHours(23, 59, 59, 999)
  return dt
}

function adminFormatTime(v) {
  if (!v) return '—'
  try { return new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch { return '—' }
}

function buildAdminMonthCells(monthDate) {
  const first = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1)
  const startWeekday = (first.getDay() + 6) % 7
  const gridStart = new Date(first)
  gridStart.setDate(first.getDate() - startWeekday)
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart)
    d.setDate(gridStart.getDate() + i)
    return d
  })
}

function parseHm(hm) {
  const raw = String(hm || '18:00')
  const [h, m] = raw.split(':')
  return [Number(h || 18), Number(m || 0)]
}

function withHm(date, hm) {
  const [h, m] = parseHm(hm)
  const dt = new Date(date)
  dt.setHours(h, m, 0, 0)
  return dt
}

function weekdayIndexMon(date) {
  return (new Date(date).getDay() + 6) % 7
}

function statusToneFromValue(status) {
  const value = String(status || '').toLowerCase()
  if (['done', 'confirmed', 'active', 'paid'].includes(value)) return 'success'
  if (['cancelled', 'declined'].includes(value)) return 'warn'
  return 'default'
}

function CalendarLegendChip({ tone = 'default', children }) {
  return <span className={`adminCalendarLegendChip ${tone}`}>{children}</span>
}

function BookingsCalendarPanel({ token, nav, q, bookingStatus, refreshSignal = 0 }) {
  const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
  const baseMonth = useMemo(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  }, [])
  const [monthOffset, setMonthOffset] = useState(0)
  const [selectedDayKey, setSelectedDayKey] = useState(adminDateKey(new Date()))
  const [calendarBookings, setCalendarBookings] = useState([])
  const [calendarSlots, setCalendarSlots] = useState([])
  const [recurringSeries, setRecurringSeries] = useState([])
  const [users, setUsers] = useState([])
  const [localErr, setLocalErr] = useState('')
  const [localNote, setLocalNote] = useState('')
  const [loadingCalendar, setLoadingCalendar] = useState(false)
  const [busyAction, setBusyAction] = useState(false)
  const [seriesForm, setSeriesForm] = useState({
    student_user_id: '',
    tutor_user_id: '',
    weekdays: [1, 3],
    time_hm: '18:00',
    duration_minutes: 60,
    weeks_ahead: 8,
    auto_attendance_confirm: true,
  })

  const monthDate = useMemo(() => new Date(baseMonth.getFullYear(), baseMonth.getMonth() + monthOffset, 1), [baseMonth, monthOffset])
  const monthCells = useMemo(() => buildAdminMonthCells(monthDate), [monthDate])
  const rangeStart = useMemo(() => adminStartOfDay(monthCells[0]), [monthCells])
  const rangeEnd = useMemo(() => adminEndOfDay(monthCells[monthCells.length - 1]), [monthCells])

  const userById = useMemo(() => {
    const map = new Map()
    for (const u of users) map.set(Number(u.id), u)
    return map
  }, [users])

  const searchNeedle = String(q || '').trim().toLowerCase()

  const filteredSeries = useMemo(() => {
    const arr = Array.isArray(recurringSeries) ? recurringSeries : []
    if (!searchNeedle) return arr
    return arr.filter((item) => [item.tutor_email, item.student_email, item.id].join(' ').toLowerCase().includes(searchNeedle))
  }, [recurringSeries, searchNeedle])

  const filteredSlots = useMemo(() => {
    const arr = Array.isArray(calendarSlots) ? calendarSlots : []
    if (!searchNeedle) return arr
    return arr.filter((slot) => {
      const tutor = userById.get(Number(slot.tutor_user_id))
      return [slot.id, slot.status, tutor?.email || ''].join(' ').toLowerCase().includes(searchNeedle)
    })
  }, [calendarSlots, searchNeedle, userById])

  const filteredBookings = useMemo(() => {
    const arr = Array.isArray(calendarBookings) ? calendarBookings : []
    if (!searchNeedle) return arr
    return arr.filter((item) => [item.tutor_email, item.student_email, item.id, item.status].join(' ').toLowerCase().includes(searchNeedle))
  }, [calendarBookings, searchNeedle])

  useEffect(() => {
    const todayKey = adminDateKey(new Date())
    const availableKeys = new Set(monthCells.map(adminDateKey))
    if (!availableKeys.has(selectedDayKey)) {
      setSelectedDayKey(availableKeys.has(todayKey) ? todayKey : adminDateKey(monthDate))
    }
  }, [monthCells, monthDate, selectedDayKey])

  async function loadCalendarData() {
    setLoadingCalendar(true)
    setLocalErr('')
    try {
      const bookingParams = new URLSearchParams()
      bookingParams.set('limit', '500')
      bookingParams.set('date_from', rangeStart.toISOString())
      bookingParams.set('date_to', rangeEnd.toISOString())
      if (bookingStatus) bookingParams.set('status', bookingStatus)
      if (q) bookingParams.set('q', q)

      const slotParams = new URLSearchParams()
      slotParams.set('date_from', rangeStart.toISOString())
      slotParams.set('date_to', rangeEnd.toISOString())

      const [bookingData, slotData, recurringData, usersData] = await Promise.all([
        apiFetch(`/api/admin/bookings?${bookingParams.toString()}`, { token }),
        apiFetch(`/api/slots/me?${slotParams.toString()}`, { token }),
        apiFetch('/api/recurring/bookings', { token }),
        apiFetch('/api/admin/users', { token }),
      ])

      setCalendarBookings(Array.isArray(bookingData) ? bookingData : [])
      setCalendarSlots(Array.isArray(slotData) ? slotData : [])
      setRecurringSeries(Array.isArray(recurringData?.items) ? recurringData.items : [])
      setUsers(Array.isArray(usersData) ? usersData : [])
    } catch (e) {
      setLocalErr(e.message || 'Не удалось загрузить календарь занятий')
    } finally {
      setLoadingCalendar(false)
    }
  }

  useEffect(() => {
    if (!token) return
    loadCalendarData()
  }, [token, monthDate, bookingStatus, q, refreshSignal])

  async function patchLocalBooking(booking, patch) {
    setBusyAction(true)
    setLocalErr('')
    setLocalNote('')
    try {
      await apiFetch(`/api/admin/bookings/${booking.id}`, { method: 'PATCH', token, body: patch })
      setLocalNote(`Занятие #${booking.id} обновлено.`)
      await loadCalendarData()
    } catch (e) {
      setLocalErr(e.message || 'Не удалось обновить занятие')
    } finally {
      setBusyAction(false)
    }
  }

  async function createSeries() {
    if (!seriesForm.student_user_id || !seriesForm.tutor_user_id) {
      setLocalErr('Выбери ученика и репетитора для серии.')
      return
    }
    if (!Array.isArray(seriesForm.weekdays) || seriesForm.weekdays.length === 0) {
      setLocalErr('Выбери хотя бы один день недели.')
      return
    }
    setBusyAction(true)
    setLocalErr('')
    setLocalNote('')
    try {
      const body = {
        student_user_id: Number(seriesForm.student_user_id),
        tutor_user_id: Number(seriesForm.tutor_user_id),
        weekdays: (seriesForm.weekdays || []).map(Number),
        time_hm: seriesForm.time_hm || '18:00',
        duration_minutes: Number(seriesForm.duration_minutes || 60),
        weeks_ahead: Number(seriesForm.weeks_ahead || 8),
        auto_attendance_confirm: Boolean(seriesForm.auto_attendance_confirm),
      }
      const out = await apiFetch('/api/recurring/bookings', { method: 'POST', token, body })
      const bookedCount = Array.isArray(out?.booked_booking_ids) ? out.booked_booking_ids.length : 0
      setLocalNote(`Серия создана. Забронировано занятий: ${bookedCount}.`)
      await loadCalendarData()
    } catch (e) {
      setLocalErr(e.message || 'Не удалось создать recurring-серию')
    } finally {
      setBusyAction(false)
    }
  }

  async function patchSeries(seriesId, patch, successText) {
    setBusyAction(true)
    setLocalErr('')
    setLocalNote('')
    try {
      const out = await apiFetch(`/api/recurring/bookings/${seriesId}`, { method: 'PATCH', token, body: patch })
      const bookedCount = Array.isArray(out?.booked_booking_ids) ? out.booked_booking_ids.length : 0
      setLocalNote(successText || (bookedCount ? `Серия обновлена. Добавлено занятий: ${bookedCount}.` : 'Серия обновлена.'))
      await loadCalendarData()
    } catch (e) {
      setLocalErr(e.message || 'Не удалось обновить серию')
    } finally {
      setBusyAction(false)
    }
  }

  const monthBookingCount = filteredBookings.length
  const openSlotsCount = filteredSlots.filter(x => String(x.status || '').toLowerCase() === 'open').length
  const activeSeriesCount = filteredSeries.filter(x => String(x.status || '').toLowerCase() === 'active').length
  const pendingAttendanceCount = filteredBookings.filter(x => String(x.student_attendance_status || '') === 'pending' || String(x.tutor_attendance_status || '') === 'pending').length

  const recurringOccurrences = useMemo(() => {
    const out = []
    const start = adminStartOfDay(rangeStart)
    const end = adminEndOfDay(rangeEnd)
    for (const series of filteredSeries) {
      if (String(series.status || '').toLowerCase() === 'cancelled') continue
      const weekdaysSet = new Set(Array.isArray(series.weekdays) ? series.weekdays.map(Number) : [])
      let cursor = new Date(start)
      while (cursor <= end) {
        if (weekdaysSet.has(weekdayIndexMon(cursor))) {
          const startsAt = withHm(cursor, series.time_hm || '18:00')
          const createdAt = series.created_at ? new Date(series.created_at) : null
          if (!createdAt || startsAt >= createdAt) {
            out.push({
              key: `${series.id}-${adminDateKey(cursor)}`,
              series_id: series.id,
              date_key: adminDateKey(cursor),
              starts_at: startsAt.toISOString(),
              time_hm: series.time_hm || '18:00',
              status: series.status || 'active',
              tutor_email: series.tutor_email || '',
              student_email: series.student_email || '',
              duration_minutes: Number(series.duration_minutes || 60),
            })
          }
        }
        cursor.setDate(cursor.getDate() + 1)
      }
    }
    return out
  }, [filteredSeries, rangeStart, rangeEnd])

  const bookingsByDay = useMemo(() => {
    const map = new Map()
    for (const booking of filteredBookings) {
      const key = adminDateKey(booking.starts_at || booking.created_at)
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(booking)
    }
    for (const list of map.values()) {
      list.sort((a, b) => new Date(a.starts_at || a.created_at) - new Date(b.starts_at || b.created_at))
    }
    return map
  }, [filteredBookings])

  const slotsByDay = useMemo(() => {
    const map = new Map()
    for (const slot of filteredSlots) {
      const key = adminDateKey(slot.starts_at)
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(slot)
    }
    for (const list of map.values()) {
      list.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))
    }
    return map
  }, [filteredSlots])

  const recurringByDay = useMemo(() => {
    const map = new Map()
    for (const item of recurringOccurrences) {
      const key = item.date_key
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(item)
    }
    for (const list of map.values()) {
      list.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))
    }
    return map
  }, [recurringOccurrences])

  const selectedDayBookings = bookingsByDay.get(selectedDayKey) || []
  const selectedDaySlots = slotsByDay.get(selectedDayKey) || []
  const selectedDayRecurring = recurringByDay.get(selectedDayKey) || []

  const studentOptions = useMemo(() => users.filter(u => u.role === 'student'), [users])
  const tutorOptions = useMemo(() => users.filter(u => u.role === 'tutor' || u.role === 'admin'), [users])

  function toggleWeekday(day) {
    setSeriesForm((prev) => {
      const set = new Set((prev.weekdays || []).map(Number))
      if (set.has(day)) set.delete(day)
      else set.add(day)
      return { ...prev, weekdays: Array.from(set).sort((a, b) => a - b) }
    })
  }

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card adminCalendarSummaryCard">
        <div className="panelTitle">
          <div>
            <div className="h3">Календарь занятий и recurring-уроков</div>
            <div className="small">Полный обзор месяца: реальные уроки, открытые слоты, ожидаемые повторяющиеся занятия и быстрые действия без ручного поиска по карточкам.</div>
          </div>
          <div className="adminQuickLinks">
            <button className="btn" onClick={() => setMonthOffset(v => v - 1)}>← Месяц назад</button>
            <button className="btn" onClick={() => setMonthOffset(0)}>Текущий месяц</button>
            <button className="btn" onClick={() => setMonthOffset(v => v + 1)}>Следующий →</button>
          </div>
        </div>
        <div className="adminCalendarStatsRow">
          <AdminStat label="Занятия в окне" value={monthBookingCount} helper={`${bookingStatus || 'all'} • ${monthDate.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}`} tone="accent" />
          <AdminStat label="Open slots" value={openSlotsCount} helper="свободные окна репетиторов" />
          <AdminStat label="Recurring series" value={activeSeriesCount} helper="активные серии" tone="success" />
          <AdminStat label="Pending attendance" value={pendingAttendanceCount} helper="нужны подтверждения" tone="warn" />
        </div>
        <div className="adminCalendarLegendRow">
          <CalendarLegendChip tone="booked">Урок</CalendarLegendChip>
          <CalendarLegendChip tone="slot">Свободный слот</CalendarLegendChip>
          <CalendarLegendChip tone="recurring">Recurring</CalendarLegendChip>
          <CalendarLegendChip tone="done">Done / оплачено</CalendarLegendChip>
        </div>
        {localErr ? <div className="footerNote">{localErr}</div> : null}
        {localNote ? <div className="footerNote">{localNote}</div> : null}
      </div>

      <div className="adminCalendarWorkspace">
        <div className="card adminCalendarMainCard">
          <div className="calendarToolbar adminCalendarToolbarWide">
            <div className="adminCalendarToolbarTitle">
              {monthDate.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}
            </div>
            <div className="adminCalendarToolbarActions">
              <button className="btn" onClick={loadCalendarData} disabled={loadingCalendar || busyAction}>Обновить сетку</button>
              <StatusPill tone={loadingCalendar ? 'warn' : 'success'}>{loadingCalendar ? 'загрузка…' : 'календарь синхронизирован'}</StatusPill>
            </div>
          </div>

          <div className="adminCalendarMonthGrid">
            {weekdays.map((day) => <div key={day} className="adminCalendarHeadCell">{day}</div>)}
            {monthCells.map((day) => {
              const key = adminDateKey(day)
              const dayBookings = bookingsByDay.get(key) || []
              const daySlots = slotsByDay.get(key) || []
              const dayRecurring = recurringByDay.get(key) || []
              const inMonth = day.getMonth() === monthDate.getMonth()
              const isToday = key === adminDateKey(new Date())
              const isSelected = key === selectedDayKey
              return (
                <button
                  type="button"
                  key={key}
                  onClick={() => setSelectedDayKey(key)}
                  className={`adminCalendarCell ${inMonth ? '' : 'out'} ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}`}
                >
                  <div className="adminCalendarCellTop">
                    <span className="adminCalendarDateNum">{day.getDate()}</span>
                    <span className="small">{dayBookings.length + daySlots.length + dayRecurring.length}</span>
                  </div>
                  <div className="adminCalendarCellBody">
                    {dayBookings.slice(0, 2).map((item) => (
                      <div key={`booking-${item.id}`} className={`adminCalendarItem booking ${item.status === 'done' || item.payment_status === 'paid' ? 'done' : item.status === 'cancelled' ? 'warn' : ''}`}>
                        <span>{adminFormatTime(item.starts_at)}</span>
                        <span>#{item.id}</span>
                      </div>
                    ))}
                    {dayRecurring.slice(0, Math.max(0, 3 - Math.min(dayBookings.length, 2))).map((item) => (
                      <div key={`series-${item.key}`} className={`adminCalendarItem recurring ${String(item.status || '') === 'paused' ? 'muted' : ''}`}>
                        <span>{item.time_hm}</span>
                        <span>серия</span>
                      </div>
                    ))}
                    {daySlots.slice(0, dayBookings.length ? 0 : 1).map((item) => (
                      <div key={`slot-${item.id}`} className="adminCalendarItem slot">
                        <span>{adminFormatTime(item.starts_at)}</span>
                        <span>slot</span>
                      </div>
                    ))}
                    {(dayBookings.length + daySlots.length + dayRecurring.length) > 3 ? <div className="lessonMore">+{dayBookings.length + daySlots.length + dayRecurring.length - 3}</div> : null}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        <div className="adminCalendarSidebar">
          <div className="card adminCalendarSideCard">
            <div className="panelTitle">
              <div>
                <div className="h3">День: {selectedDayKey}</div>
                <div className="small">Повестка дня, свободные окна и повторяющиеся уроки.</div>
              </div>
            </div>
            <div className="adminAgendaList">
              {selectedDayBookings.length === 0 && selectedDaySlots.length === 0 && selectedDayRecurring.length === 0 ? <div className="small">На выбранный день событий нет.</div> : null}

              {selectedDayBookings.map((item) => (
                <div key={`agenda-booking-${item.id}`} className="adminAgendaItem booking">
                  <div>
                    <div className="adminAgendaTitle">Урок #{item.id} • {adminFormatTime(item.starts_at)}–{adminFormatTime(item.ends_at)}</div>
                    <div className="small">{item.tutor_email} → {item.student_email}</div>
                    <div className="adminAgendaMetaRow">
                      <StatusPill tone={statusToneFromValue(item.status)}>{item.status}</StatusPill>
                      <StatusPill tone={statusToneFromValue(item.payment_status)}>{item.payment_status}</StatusPill>
                      {item.recurring_series_id ? <StatusPill tone="default">Series #{item.recurring_series_id}</StatusPill> : null}
                    </div>
                  </div>
                  <div className="adminAgendaActions">
                    <button className="btn" onClick={() => nav(`/room/booking-${item.id}`)}>Комната</button>
                    {item.status !== 'cancelled' ? <button className="btn" onClick={() => patchLocalBooking(item, { status: 'cancelled' })} disabled={busyAction}>Отменить</button> : null}
                    {item.status !== 'done' ? <button className="btn btnPrimary" onClick={() => patchLocalBooking(item, { status: 'done' })} disabled={busyAction}>Done</button> : null}
                  </div>
                </div>
              ))}

              {selectedDayRecurring.map((item) => (
                <div key={`agenda-recurring-${item.key}`} className="adminAgendaItem recurring">
                  <div>
                    <div className="adminAgendaTitle">Recurring • {item.time_hm}</div>
                    <div className="small">{item.tutor_email} → {item.student_email}</div>
                    <div className="adminAgendaMetaRow">
                      <StatusPill tone={statusToneFromValue(item.status)}>{item.status}</StatusPill>
                      <StatusPill tone="default">{item.duration_minutes} мин</StatusPill>
                    </div>
                  </div>
                </div>
              ))}

              {selectedDaySlots.map((item) => (
                <div key={`agenda-slot-${item.id}`} className="adminAgendaItem slot">
                  <div>
                    <div className="adminAgendaTitle">Open slot #{item.id} • {adminFormatTime(item.starts_at)}–{adminFormatTime(item.ends_at)}</div>
                    <div className="small">Репетитор: {userById.get(Number(item.tutor_user_id))?.email || `user #${item.tutor_user_id}`}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card adminCalendarSideCard">
            <div className="panelTitle">
              <div>
                <div className="h3">Recurring lessons</div>
                <div className="small">Управление сериями: refresh, пауза, отмена и контроль следующего урока.</div>
              </div>
            </div>
            <div className="adminSeriesList">
              {filteredSeries.length === 0 ? <div className="small">Серий пока нет.</div> : filteredSeries.map((series) => (
                <div key={series.id} className="adminSeriesItem">
                  <div className="adminSeriesHeader">
                    <div>
                      <div className="adminAgendaTitle">Series #{series.id}</div>
                      <div className="small">{series.tutor_email} → {series.student_email}</div>
                    </div>
                    <StatusPill tone={statusToneFromValue(series.status)}>{series.status}</StatusPill>
                  </div>
                  <div className="small">{(series.weekdays || []).map((d) => weekdays[d] || d).join(' • ')} • {series.time_hm} • {series.duration_minutes} мин</div>
                  <div className="small">Вперёд: {series.weeks_ahead} нед. • Забронировано: {series.booked_count || 0} • Следующее: {formatDateTimeShort(series.next_booking_at)}</div>
                  <div className="adminAgendaActions" style={{ marginTop: 10 }}>
                    <button className="btn" onClick={() => patchSeries(series.id, { refresh_now: true }, 'Серия синхронизирована со слотами.')} disabled={busyAction}>Refresh</button>
                    {String(series.status) !== 'paused' ? <button className="btn" onClick={() => patchSeries(series.id, { status: 'paused' }, 'Серия поставлена на паузу.')} disabled={busyAction}>Пауза</button> : <button className="btn" onClick={() => patchSeries(series.id, { status: 'active', refresh_now: true }, 'Серия снова активна.')} disabled={busyAction}>Возобновить</button>}
                    {String(series.status) !== 'cancelled' ? <button className="btn" onClick={() => patchSeries(series.id, { status: 'cancelled' }, 'Серия отменена.')} disabled={busyAction}>Отменить</button> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card adminCalendarSideCard">
            <div className="panelTitle">
              <div>
                <div className="h3">Новая серия занятий</div>
                <div className="small">Полноценный recurring-конструктор для админа: выбери участника, репетитора, дни недели и горизонт бронирования.</div>
              </div>
            </div>
            <div className="grid" style={{ gap: 10 }}>
              <div>
                <div className="label">Ученик</div>
                <select className="select" value={seriesForm.student_user_id} onChange={(e) => setSeriesForm(s => ({ ...s, student_user_id: e.target.value }))}>
                  <option value="">Выбери ученика</option>
                  {studentOptions.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
                </select>
              </div>
              <div>
                <div className="label">Репетитор</div>
                <select className="select" value={seriesForm.tutor_user_id} onChange={(e) => setSeriesForm(s => ({ ...s, tutor_user_id: e.target.value }))}>
                  <option value="">Выбери репетитора</option>
                  {tutorOptions.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
                </select>
              </div>
              <div>
                <div className="label">Дни недели</div>
                <div className="adminWeekdayPicker">
                  {weekdays.map((day, idx) => {
                    const active = (seriesForm.weekdays || []).map(Number).includes(idx)
                    return (
                      <button key={day} type="button" className={`btn ${active ? 'btnPrimary' : ''}`} onClick={() => toggleWeekday(idx)}>
                        {day}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div className="adminSeriesFormGrid">
                <div>
                  <div className="label">Время</div>
                  <input className="input" value={seriesForm.time_hm} onChange={(e) => setSeriesForm(s => ({ ...s, time_hm: e.target.value }))} placeholder="18:00" />
                </div>
                <div>
                  <div className="label">Длительность</div>
                  <input className="input" type="number" min="20" max="180" value={seriesForm.duration_minutes} onChange={(e) => setSeriesForm(s => ({ ...s, duration_minutes: e.target.value }))} />
                </div>
                <div>
                  <div className="label">Горизонт, недель</div>
                  <input className="input" type="number" min="1" max="16" value={seriesForm.weeks_ahead} onChange={(e) => setSeriesForm(s => ({ ...s, weeks_ahead: e.target.value }))} />
                </div>
              </div>
              <label className="small"><input type="checkbox" checked={Boolean(seriesForm.auto_attendance_confirm)} onChange={(e) => setSeriesForm(s => ({ ...s, auto_attendance_confirm: e.target.checked }))} /> автоподтверждение attendance для ученика</label>
              <button className="btn btnPrimary" onClick={createSeries} disabled={busyAction}>Создать recurring series</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
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
  const [bookingsRefreshSignal, setBookingsRefreshSignal] = useState(0)

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
    if (tab === 'bookings') {
      setBookingsRefreshSignal(v => v + 1)
      return
    }
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

              <div className="card adminInsightCard adminInsightCardWide">
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
                  <div className="small">Если бот не реагирует на команды, здесь видно webhook, последний runtime-статус и недавние входящие апдейты.</div>
                </div>
              </div>
              <div className="telegramDebugList">
                <div className="adminListRow"><b>Webhook URL:</b> <span>{telegramStatus?.webhook_info?.url || 'не установлен'}</span></div>
                <div className="adminListRow"><b>Ожидаемый URL:</b> <span>{telegramStatus?.desired_webhook_url || 'не сформирован'}</span></div>
                <div className="adminListRow"><b>Последняя ошибка Telegram:</b> <span>{telegramStatus?.webhook_info?.last_error_message || 'нет'}</span></div>
                <div className="adminListRow"><b>Последняя ошибка UTC:</b> <span>{telegramStatus?.webhook_info?.last_error_date ? formatDateTimeShort(new Date(Number(telegramStatus.webhook_info.last_error_date) * 1000)) : '—'}</span></div>
                <div className="adminListRow"><b>Runtime mode:</b> <span>{telegramStatus?.processing_mode || '—'}</span></div>
                <div className="adminListRow"><b>Последний inbound:</b> <span>{telegramStatus?.runtime?.last_update_at ? `${formatDateTimeShort(telegramStatus.runtime.last_update_at)} • ${telegramStatus?.runtime?.last_update_kind || 'update'}` : '—'}</span></div>
                <div className="adminListRow"><b>Последняя команда:</b> <span>{telegramStatus?.runtime?.last_command || '—'}</span></div>
                <div className="adminListRow"><b>Последний chat id:</b> <span>{telegramStatus?.runtime?.last_chat_id || '—'}</span></div>
                <div className="adminListRow"><b>Runtime error:</b> <span>{telegramStatus?.runtime?.last_error || 'нет'}</span></div>
                <div className="adminListRow"><b>Secret token:</b> <span>{telegramStatus?.secret_configured ? 'задан' : 'не задан'}</span></div>
                <div className="adminListRow"><b>Команды:</b> <span>После sync бот получает setWebhook + setMyCommands + setMyDescription + setMyShortDescription + setChatMenuButton.</span></div>
                <div className="adminListRow"><b>Short description:</b> <span>{telegramStatus?.bot_short_description || '—'}</span></div>
                <div className="adminListRow"><b>Description:</b> <span>{telegramStatus?.bot_description || '—'}</span></div>
                <div className="adminListRow"><b>Menu button:</b> <span>{telegramStatus?.menu_button_type || '—'}</span></div>
              </div>
            </div>

            <div className="card adminInsightCard">
              <div className="panelTitle">
                <div>
                  <div className="h3">Последние события Telegram</div>
                  <div className="small">Живой хвост inbound/outbound событий. Если здесь пусто после команды, webhook до сервиса не доходит.</div>
                </div>
              </div>
              <div className="telegramEventList">
                {Array.isArray(telegramStatus?.recent_events) && telegramStatus.recent_events.length > 0 ? telegramStatus.recent_events.map((item, idx) => (
                  <div key={`${item?.ts || 'evt'}-${idx}`} className="telegramEventItem">
                    <div className="telegramEventMeta">
                      <span className="pill">{item?.event || 'event'}</span>
                      <span className="small">{formatDateTimeShort(item?.ts)}</span>
                    </div>
                    <div className="telegramEventMessage">{item?.message || '—'}</div>
                    {item?.meta ? (
                      <div className="telegramEventTags">
                        {Object.entries(item.meta).map(([k, v]) => (
                          <span key={`${idx}-${k}`} className="telegramEventTag">{k}: {String(v)}</span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )) : <div className="small">Пока нет событий. Отправь боту /menu и нажми «Обновить».</div>}
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
          <div className="grid" style={{ gap: 12 }}>
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontWeight: 900, fontSize: 18 }}>Фильтры календаря</div>
                  <div className="sub">Оставь общий статус, а ниже используй полноценный календарный обзор, recurring-серии и agenda по дням.</div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <select className="select" value={bookingStatus} onChange={e => setBookingStatus(e.target.value)}>
                    <option value="">все</option>
                    <option value="confirmed">confirmed</option>
                    <option value="cancelled">cancelled</option>
                    <option value="done">done</option>
                  </select>
                  <button className="btn" onClick={() => setBookingsRefreshSignal(v => v + 1)}>Применить</button>
                </div>
              </div>
            </div>
            <BookingsCalendarPanel token={token} nav={nav} q={q} bookingStatus={bookingStatus} refreshSignal={bookingsRefreshSignal} />
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
