import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../api'
import { useAuth } from '../auth.jsx'

const FILTERS_KEY = 'dl_market_filters_v3'
const FAVS_KEY = 'dl_favorite_tutors_v1'

function initials(name) {
  const s = (name || '').trim()
  if (!s) return 'DL'
  return s.split(/\s+/).slice(0, 2).map(x => x[0]?.toUpperCase()).join('') || 'DL'
}

function safeParse(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function readStoredFilters() {
  if (typeof window === 'undefined') return {}
  return safeParse(FILTERS_KEY, {}) || {}
}

function readFavorites() {
  if (typeof window === 'undefined') return []
  const v = safeParse(FAVS_KEY, [])
  return Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : []
}

function saveFavorites(ids) {
  try { localStorage.setItem(FAVS_KEY, JSON.stringify(ids)) } catch {}
}

function Chip({ active, onClick, children, small = false }) {
  return (
    <button className={active ? `btn btnPrimary ${small ? 'btnXs' : ''}` : `btn ${small ? 'btnXs' : ''}`} onClick={onClick} type="button">
      {children}
    </button>
  )
}

function ActiveFilter({ label, onRemove }) {
  return (
    <button type="button" className="activeFilterPill" onClick={onRemove}>
      <span>{label}</span>
      <span aria-hidden>×</span>
    </button>
  )
}

function scoreTag(t) {
  const rating = Number(t?.rating_avg || 0)
  const rc = Number(t?.rating_count || 0)
  const lc = Number(t?.lessons_count || 0)
  if (rating >= 4.8 && rc >= 5) return { text: 'Топ по отзывам', kind: 'green' }
  if (lc >= 20) return { text: 'Много практики', kind: 'blue' }
  if (t?.is_verified) return { text: 'Проверенный', kind: 'green' }
  if (t?.founding_tutor) return { text: 'Founding tutor', kind: 'gold' }
  return { text: 'Новый в каталоге', kind: 'muted' }
}

function buildMatchTags(t, criteria) {
  const tags = []
  const subjects = Array.isArray(t?.subjects) ? t.subjects : []
  const goals = Array.isArray(t?.goals) ? t.goals : []
  const grades = Array.isArray(t?.grades) ? t.grades : []
  const levels = Array.isArray(t?.levels) ? t.levels : []

  if (criteria.subject && subjects.includes(criteria.subject)) tags.push(`Предмет: ${criteria.subject}`)
  if (criteria.goal && goals.includes(criteria.goal)) tags.push(`Цель: ${criteria.goal}`)
  if (criteria.grade && grades.includes(criteria.grade)) tags.push(`${criteria.grade} класс`)
  if (criteria.level && levels.includes(criteria.level)) tags.push(`Уровень: ${criteria.level}`)
  if (criteria.language && (t?.language || '').toLowerCase() === String(criteria.language).toLowerCase()) tags.push(`Язык: ${t.language}`)
  if (criteria.minRating && Number(t?.rating_avg || 0) >= Number(criteria.minRating)) tags.push(`Рейтинг ${criteria.minRating}+`)
  if (criteria.minReviews && Number(t?.rating_count || 0) >= Number(criteria.minReviews)) tags.push(`Отзывы ${criteria.minReviews}+`)
  if (criteria.verifiedOnly && t?.is_verified) tags.push('Документы проверены')

  return tags.slice(0, 4)
}

function TutorCard({ t, criteria, isFav, onToggleFav }) {
  const badge = scoreTag(t)
  const matchTags = buildMatchTags(t, criteria)

  return (
    <div className="tutorCardSurface">
      <button
        type="button"
        className={`favoriteBtn ${isFav ? 'active' : ''}`}
        onClick={() => onToggleFav?.(t.id)}
        aria-label={isFav ? 'Убрать из избранного' : 'Добавить в избранное'}
        title={isFav ? 'Убрать из избранного' : 'Добавить в избранное'}
      >
        {isFav ? '★' : '☆'}
      </button>

      <Link to={`/tutor/${t.id}`} className="tutorCard tutorCardRich tutorCardPremium">
        {t.photo_url ? (
          <img className="avatar avatarImg tutorAvatarLg" src={t.photo_url} alt={t.display_name} />
        ) : (
          <div className="avatar tutorAvatarLg">{initials(t.display_name)}</div>
        )}

        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="tutorCardTopRow">
            <div style={{ minWidth: 0 }}>
              <div className="tutorNameLine">
                <div className="tutorName">{t.display_name}</div>
                {t.founding_tutor ? <span className="pill badgeGold">Founding tutor</span> : null}
                {t.is_verified ? <span className="pill badgeGreen">Проверен</span> : null}
              </div>
              <div className="small" style={{ marginTop: 4 }}>
                {(t.subjects || []).join(', ') || '—'}
                {t.language ? ` • ${String(t.language).toUpperCase()}` : ''}
                {t.age ? ` • ${t.age} лет` : ''}
              </div>
            </div>

            <div className="tutorPriceBox">
              <div className="tutorPrice">{t.price_per_hour || 0} ₽</div>
              <div className="small">за 60 минут</div>
            </div>
          </div>

          <div className="tutorMetricsRow">
            <span className="metricPill">★ {Number(t.rating_avg || 0).toFixed(1)}</span>
            <span className="metricPill">Отзывы: {t.rating_count || 0}</span>
            <span className="metricPill">Занятий: {t.lessons_count || 0}</span>
            {!!(t.grades || []).length && <span className="metricPill">Классы: {(t.grades || []).slice(0, 2).join(', ')}</span>}
          </div>

          <div className="pills" style={{ marginTop: 8 }}>
            <span className={`pill ${badge.kind === 'green' ? 'badgeGreen' : badge.kind === 'gold' ? 'badgeGold' : badge.kind === 'blue' ? 'badgeBlue' : ''}`}>{badge.text}</span>
            {(t.goals || []).slice(0, 2).map(g => <span key={g} className="pill">{g}</span>)}
            {(t.levels || []).slice(0, 1).map(l => <span key={l} className="pill">{l}</span>)}
          </div>

          {matchTags.length > 0 && (
            <div className="matchTagsRow">
              {matchTags.map(tag => <span key={tag} className="matchTag">{tag}</span>)}
            </div>
          )}

          <div className="tutorCardFooterRow">
            <div className="small" style={{ maxWidth: 520 }}>
              {t.bio ? `${String(t.bio).slice(0, 120)}${String(t.bio).length > 120 ? '…' : ''}` : 'Профиль готов к бронированию и проведению уроков в комнате платформы.'}
            </div>
            <div className="btn btnPrimary">Открыть профиль</div>
          </div>
        </div>
      </Link>
    </div>
  )
}

export default function Home() {
  const { me } = useAuth()
  const stored = readStoredFilters()

  const [catalog, setCatalog] = useState({ subjects: [], goals: [], levels: [], grades: [], exams: [], languages: ['ru', 'en'] })
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [tutors, setTutors] = useState([])

  const [q, setQ] = useState(stored.q || '')
  const [subject, setSubject] = useState(stored.subject || '')
  const [goal, setGoal] = useState(stored.goal || '')
  const [level, setLevel] = useState(stored.level || '')
  const [grade, setGrade] = useState(stored.grade || '')
  const [language, setLanguage] = useState(stored.language || '')
  const [minPrice, setMinPrice] = useState(stored.minPrice || '')
  const [maxPrice, setMaxPrice] = useState(stored.maxPrice || '')
  const [minRating, setMinRating] = useState(stored.minRating || '')
  const [minReviews, setMinReviews] = useState(stored.minReviews || '')
  const [verifiedOnly, setVerifiedOnly] = useState(Boolean(stored.verifiedOnly))
  const [hasFreeSlots, setHasFreeSlots] = useState(Boolean(stored.hasFreeSlots))
  const [availableFrom, setAvailableFrom] = useState(stored.availableFrom || '')
  const [availableTo, setAvailableTo] = useState(stored.availableTo || '')
  const [sort, setSort] = useState(stored.sort || 'best')
  const [onlyFavorites, setOnlyFavorites] = useState(Boolean(stored.onlyFavorites))
  const [favorites, setFavorites] = useState(readFavorites)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const c = await apiFetch('/api/catalog')
        if (alive && c) setCatalog(c)
      } catch {
        // fallback silently
      }
    })()
    return () => { alive = false }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify({
        q, subject, goal, level, grade, language,
        minPrice, maxPrice, minRating, minReviews,
        verifiedOnly, hasFreeSlots, availableFrom, availableTo,
        sort, onlyFavorites
      }))
    } catch {
      // ignore
    }
  }, [q, subject, goal, level, grade, language, minPrice, maxPrice, minRating, minReviews, verifiedOnly, hasFreeSlots, availableFrom, availableTo, sort, onlyFavorites])

  function toggleFavorite(id) {
    setFavorites(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
      saveFavorites(next)
      return next
    })
  }

  async function loadTutors() {
    setLoading(true)
    setErr('')
    try {
      const params = new URLSearchParams()
      if (q.trim()) params.set('q', q.trim())
      if (subject) params.set('subject', subject)
      if (goal) params.set('goal', goal)
      if (level) params.set('level', level)
      if (grade) params.set('grade', grade)
      if (language) params.set('language', language)
      if (minPrice !== '') params.set('min_price', String(Number(minPrice || 0)))
      if (maxPrice !== '') params.set('max_price', String(Number(maxPrice || 0)))
      if (minReviews !== '') params.set('min_reviews', String(Number(minReviews || 0)))
      if (verifiedOnly) params.set('verified_only', 'true')
      if (hasFreeSlots) params.set('has_free_slots', 'true')
      if (availableFrom) params.set('available_from', new Date(availableFrom).toISOString())
      if (availableTo) params.set('available_to', new Date(availableTo).toISOString())
      if (sort) params.set('sort', sort)
      const data = await apiFetch(`/api/tutors?${params.toString()}`)
      setTutors(Array.isArray(data) ? data : [])
    } catch (e) {
      setErr(e.message || 'Ошибка загрузки')
      setTutors([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadTutors() }, [])

  const visibleTutors = useMemo(() => {
    let arr = Array.isArray(tutors) ? [...tutors] : []
    if (minRating) {
      const v = Number(minRating)
      if (Number.isFinite(v)) arr = arr.filter(t => Number(t.rating_avg || 0) >= v)
    }
    if (onlyFavorites) arr = arr.filter(t => favorites.includes(t.id))
    // In any list mode keep favorites slightly prioritized for a better UX.
    arr.sort((a, b) => Number(favorites.includes(b.id)) - Number(favorites.includes(a.id)))
    return arr
  }, [tutors, minRating, onlyFavorites, favorites])

  const featuredSubjects = (catalog.subjects || []).slice(0, 6)
  const featuredExams = (catalog.exams || catalog.goals || []).slice(0, 6)
  const featuredGrades = (catalog.grades || []).slice(0, 6)

  const selectionSummary = useMemo(() => {
    const bits = []
    if (subject) bits.push(subject)
    if (goal) bits.push(goal)
    if (grade) bits.push(`${grade} класс`)
    if (level) bits.push(level)
    if (language) bits.push(String(language).toUpperCase())
    if (minPrice || maxPrice) bits.push(`цена ${minPrice || 0}–${maxPrice || '∞'} ₽`)
    return bits
  }, [subject, goal, grade, level, language, minPrice, maxPrice])

  const activeFilters = useMemo(() => {
    const rows = []
    if (q) rows.push({ key: 'q', label: `Поиск: ${q}`, clear: () => setQ('') })
    if (subject) rows.push({ key: 'subject', label: `Предмет: ${subject}`, clear: () => setSubject('') })
    if (goal) rows.push({ key: 'goal', label: `Цель: ${goal}`, clear: () => setGoal('') })
    if (level) rows.push({ key: 'level', label: `Уровень: ${level}`, clear: () => setLevel('') })
    if (grade) rows.push({ key: 'grade', label: `Класс: ${grade}`, clear: () => setGrade('') })
    if (language) rows.push({ key: 'language', label: `Язык: ${language}`, clear: () => setLanguage('') })
    if (minPrice !== '') rows.push({ key: 'minPrice', label: `Цена от ${minPrice}`, clear: () => setMinPrice('') })
    if (maxPrice !== '') rows.push({ key: 'maxPrice', label: `Цена до ${maxPrice}`, clear: () => setMaxPrice('') })
    if (minRating !== '') rows.push({ key: 'minRating', label: `Рейтинг ${minRating}+`, clear: () => setMinRating('') })
    if (minReviews !== '') rows.push({ key: 'minReviews', label: `Отзывы ${minReviews}+`, clear: () => setMinReviews('') })
    if (verifiedOnly) rows.push({ key: 'verifiedOnly', label: 'Только проверенные', clear: () => setVerifiedOnly(false) })
    if (hasFreeSlots) rows.push({ key: 'hasFreeSlots', label: 'Только со слотами', clear: () => setHasFreeSlots(false) })
    if (onlyFavorites) rows.push({ key: 'onlyFavorites', label: 'Только избранные', clear: () => setOnlyFavorites(false) })
    return rows
  }, [q, subject, goal, level, grade, language, minPrice, maxPrice, minRating, minReviews, verifiedOnly, hasFreeSlots, onlyFavorites])

  const topRatedCount = visibleTutors.filter(t => Number(t.rating_avg || 0) >= 4.5).length
  const verifiedCount = visibleTutors.filter(t => t.is_verified).length

  function resetFilters() {
    setQ('')
    setSubject('')
    setGoal('')
    setLevel('')
    setGrade('')
    setLanguage('')
    setMinPrice('')
    setMaxPrice('')
    setMinRating('')
    setMinReviews('')
    setVerifiedOnly(false)
    setHasFreeSlots(false)
    setAvailableFrom('')
    setAvailableTo('')
    setSort('best')
    setOnlyFavorites(false)
  }

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="hero heroUpgrade">
        <div className="heroInner">
          <div className="heroBadge">DL MVP • marketplace + booking + lesson room</div>
          <div className="heroTitle">Подбор репетитора за 2 шага — и урок прямо в DoskoLink</div>
          <div className="heroSub">
            Фокус на MVP из твоего плана: выбор предмета/экзамена, фильтры, бронирование слота, урок внутри платформы и отзывы после занятия.
          </div>

          <div className="heroStatsRow">
            <div className="heroStatTile"><div className="small">Сценарий</div><div className="heroStatValue">Поиск → Бронь → Урок</div></div>
            <div className="heroStatTile"><div className="small">Доверие</div><div className="heroStatValue">Проверка профилей и документов</div></div>
            <div className="heroStatTile"><div className="small">MVP</div><div className="heroStatValue">Без встроенных оплат</div></div>
          </div>

          {!me && (
            <div className="heroCtas">
              <Link className="btn btnPrimary" to="/register">Старт как ученик</Link>
              <Link className="btn" to="/register">Стать репетитором</Link>
              <a className="btn btnGhost" href="#search">Выбрать репетитора</a>
            </div>
          )}

          <div style={{ marginTop: 16 }} className="grid" id="search">
            <div className="card searchWizardCard">
              <div className="wizardHead">
                <div>
                  <div className="h3">Быстрый подбор</div>
                  <div className="small">Как ты и просил: предмет → класс/экзамен → список лучших репетиторов</div>
                </div>
                <div className="small">{selectionSummary.length ? `Выбрано: ${selectionSummary.join(' • ')}` : 'Выбери параметры'}</div>
              </div>

              <div style={{ fontWeight: 900, fontSize: 16, marginTop: 10 }}>1) Выбор предмета</div>
              <div className="pills" style={{ marginTop: 10 }}>
                {featuredSubjects.map(s => (
                  <Chip key={s} active={subject === s} onClick={() => setSubject(subject === s ? '' : s)}>{s}</Chip>
                ))}
              </div>

              <div style={{ fontWeight: 900, fontSize: 16, marginTop: 14 }}>2) Класс / подготовка к экзамену</div>
              <div className="pills" style={{ marginTop: 10 }}>
                {featuredGrades.map(g => (
                  <Chip key={`g-${g}`} active={grade === g} onClick={() => setGrade(grade === g ? '' : g)}>{g} класс</Chip>
                ))}
                {featuredExams.map(x => (
                  <Chip key={`e-${x}`} active={goal === x} onClick={() => setGoal(goal === x ? '' : x)}>{x}</Chip>
                ))}
              </div>

              <div className="quickIntentRow">
                <span className="small">Быстрые сценарии:</span>
                <Chip small active={goal === 'ЕГЭ' && subject === 'Математика'} onClick={() => { setGoal('ЕГЭ'); setSubject('Математика'); setGrade('11') }}>ЕГЭ математика</Chip>
                <Chip small active={goal === 'ОГЭ'} onClick={() => { setGoal(goal === 'ОГЭ' ? '' : 'ОГЭ') }}>ОГЭ</Chip>
                <Chip small active={goal === 'Разговорный'} onClick={() => { setGoal(goal === 'Разговорный' ? '' : 'Разговорный'); if (!subject) setSubject('Английский') }}>Разговорный английский</Chip>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="catalogHeaderRow">
          <div>
            <div className="h2">Каталог репетиторов</div>
            <div className="sub">Сортировка “Лучшие сначала”, фильтры по цене/рейтингу/отзывам/языку и наличие свободных слотов.</div>
          </div>
          <div className="catalogHeaderActions">
            <button className="btn" onClick={resetFilters}>Сбросить</button>
            <button className="btn btnPrimary" onClick={loadTutors} disabled={loading}>{loading ? 'Ищем…' : 'Обновить выдачу'}</button>
          </div>
        </div>

        <div className="marketHighlights">
          <div className="marketHighlight"><div className="small">В выдаче</div><div className="h3">{loading ? '…' : visibleTutors.length}</div><div className="small">репетиторов</div></div>
          <div className="marketHighlight"><div className="small">Проверенные</div><div className="h3">{loading ? '…' : verifiedCount}</div><div className="small">с документами</div></div>
          <div className="marketHighlight"><div className="small">С рейтингом 4.5+</div><div className="h3">{loading ? '…' : topRatedCount}</div><div className="small">в текущей выборке</div></div>
          <div className="marketHighlight"><div className="small">Избранные</div><div className="h3">{favorites.length}</div><div className="small">сохранено локально</div></div>
        </div>

        <div className="grid filtersGrid" style={{ marginTop: 12 }}>
          <div>
            <div className="label">Поиск</div>
            <input className="input" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && loadTutors()} placeholder="имя, предмет, ЕГЭ, разговорный…" />
          </div>
          <div>
            <div className="label">Предмет</div>
            <select className="select" value={subject} onChange={e => setSubject(e.target.value)}>
              <option value="">Любой</option>
              {(catalog.subjects || []).map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <div className="label">Цель / экзамен</div>
            <select className="select" value={goal} onChange={e => setGoal(e.target.value)}>
              <option value="">Любая</option>
              {[...(catalog.goals || []), ...((catalog.exams || []).filter(x => !(catalog.goals || []).includes(x)))]
                .map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <div className="label">Уровень</div>
            <select className="select" value={level} onChange={e => setLevel(e.target.value)}>
              <option value="">Любой</option>
              {(catalog.levels || []).map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <div className="label">Класс</div>
            <select className="select" value={grade} onChange={e => setGrade(e.target.value)}>
              <option value="">Любой</option>
              {(catalog.grades || []).map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <div className="label">Язык</div>
            <select className="select" value={language} onChange={e => setLanguage(e.target.value)}>
              <option value="">Любой</option>
              {(catalog.languages || ['ru', 'en']).map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <div className="label">Цена от</div>
            <input className="input" type="number" min="0" value={minPrice} onChange={e => setMinPrice(e.target.value)} placeholder="0" />
          </div>
          <div>
            <div className="label">Цена до</div>
            <input className="input" type="number" min="0" value={maxPrice} onChange={e => setMaxPrice(e.target.value)} placeholder="5000" />
          </div>
          <div>
            <div className="label">Мин. рейтинг</div>
            <select className="select" value={minRating} onChange={e => setMinRating(e.target.value)}>
              <option value="">Любой</option>
              <option value="4">4.0+</option>
              <option value="4.5">4.5+</option>
              <option value="5">5.0</option>
            </select>
          </div>
          <div>
            <div className="label">Мин. отзывов</div>
            <select className="select" value={minReviews} onChange={e => setMinReviews(e.target.value)}>
              <option value="">Любое</option>
              <option value="1">1+</option>
              <option value="3">3+</option>
              <option value="5">5+</option>
              <option value="10">10+</option>
            </select>
          </div>
          <div>
            <div className="label">Сортировка</div>
            <select className="select" value={sort} onChange={e => setSort(e.target.value)}>
              <option value="best">Лучшие сначала</option>
              <option value="price_asc">Цена ↑</option>
              <option value="price_desc">Цена ↓</option>
              <option value="newest">Новые</option>
            </select>
          </div>
          <div>
            <div className="label">Свободное время: от</div>
            <input className="input" type="datetime-local" value={availableFrom} onChange={e => setAvailableFrom(e.target.value)} />
          </div>
          <div>
            <div className="label">Свободное время: до</div>
            <input className="input" type="datetime-local" value={availableTo} onChange={e => setAvailableTo(e.target.value)} />
          </div>
        </div>

        <div className="filtersFooterBar">
          <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={hasFreeSlots} onChange={e => setHasFreeSlots(e.target.checked)} />
            Только со свободными слотами
          </label>
          <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={verifiedOnly} onChange={e => setVerifiedOnly(e.target.checked)} />
            Только проверенные профили
          </label>
          <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={onlyFavorites} onChange={e => setOnlyFavorites(e.target.checked)} />
            Только избранные
          </label>
          {!me && <span className="small">Чтобы бронировать, нужно войти как ученик.</span>}
        </div>

        {activeFilters.length > 0 && (
          <div className="activeFiltersRow">
            {activeFilters.map(item => <ActiveFilter key={item.key} label={item.label} onRemove={item.clear} />)}
          </div>
        )}

        {err && <div className="footerNote">{err}</div>}

        <div className="resultsHeaderRow">
          <div>
            <div style={{ fontWeight: 900 }}>Результаты поиска</div>
            <div className="small">
              {loading ? 'Загрузка…' : `${visibleTutors.length} репетиторов`}
              {favorites.length ? ` • избранных: ${favorites.length}` : ''}
            </div>
          </div>
          <div className="small">* В избранное можно сохранить локально, чтобы быстро вернуться к профилям.</div>
        </div>

        <div className="tutorGrid tutorGridWide" style={{ marginTop: 10 }}>
          {loading ? (
            <div className="small">Загрузка…</div>
          ) : visibleTutors.length === 0 ? (
            <div className="emptyMarketState">
              <div className="h3">Репетиторы не найдены</div>
              <div className="small">Попробуй ослабить фильтры (например, убрать ограничение по времени/отзывам) или сбросить их полностью.</div>
              <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn" onClick={resetFilters}>Сбросить фильтры</button>
                <button className="btn btnPrimary" onClick={loadTutors}>Повторить поиск</button>
              </div>
            </div>
          ) : (
            visibleTutors.map(t => (
              <TutorCard
                key={t.id}
                t={t}
                criteria={{ subject, goal, grade, level, language, minRating, minReviews, verifiedOnly }}
                isFav={favorites.includes(t.id)}
                onToggleFav={toggleFavorite}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
