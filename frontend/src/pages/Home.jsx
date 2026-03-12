import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../api'
import { useAuth } from '../auth.jsx'

function initials(name) {
  const s = (name || '').trim()
  if (!s) return 'DL'
  return s.split(/\s+/).slice(0, 2).map(x => x[0]?.toUpperCase()).join('') || 'DL'
}

function fmtPrice(v) {
  const n = Number(v || 0)
  return `${n} ₽/ч`
}

function Chip({ active, onClick, children }) {
  return (
    <button className={active ? 'btn btnPrimary' : 'btn'} onClick={onClick} type="button">
      {children}
    </button>
  )
}

function SortChip({ active, onClick, children }) {
  return (
    <button type="button" className={active ? 'btn btnPrimary searchSortChip' : 'btn searchSortChip'} onClick={onClick}>
      {children}
    </button>
  )
}

function ResultMetric({ label, value, helper }) {
  return (
    <div className="resultMetricCard">
      <div className="small">{label}</div>
      <div className="resultMetricValue">{value}</div>
      {helper ? <div className="small">{helper}</div> : null}
    </div>
  )
}

function ActiveFilterChip({ label, onClear }) {
  return (
    <button type="button" className="filterChip" onClick={onClear}>
      <span>{label}</span>
      <b>×</b>
    </button>
  )
}

function TutorCard({ t, why = [], featured = false }) {
  const goals = Array.isArray(t?.goals) ? t.goals.slice(0, 3) : []
  const subjects = Array.isArray(t?.subjects) ? t.subjects.slice(0, 3) : []
  const bio = String(t?.bio || '').trim()
  const reasons = Array.isArray(why) ? why.slice(0, 4) : []

  return (
    <Link to={`/tutor/${t.id}`} className={`tutorVisualCard ${featured ? 'featured' : ''}`}>
      <div className="tutorVisualTop">
        <div className="tutorIdentityWrap">
          {t.photo_url ? (
            <img className="tutorVisualAvatar" src={t.photo_url} alt={t.display_name} />
          ) : (
            <div className="tutorVisualAvatar tutorVisualAvatarFallback">{initials(t.display_name)}</div>
          )}

          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="tutorIdentityRow">
              <div className="tutorName">{t.display_name}</div>
              {t.founding_tutor ? <span className="pill badgeGold">Founding tutor</span> : null}
              {t.is_verified ? <span className="pill badgeGreen">Проверен</span> : null}
            </div>
            <div className="small" style={{ marginTop: 4 }}>
              {subjects.join(', ') || 'Предметы не указаны'} • {t.language || 'ru'}
            </div>
            <div className="tutorScoreRow">
              <div className="tutorMetricPill">★ {Number(t.rating_avg || 0).toFixed(1)}</div>
              <div className="tutorMetricPill">{t.rating_count || 0} отзывов</div>
              <div className="tutorMetricPill">{t.lessons_count || 0} занятий</div>
              <div className="tutorMetricPill tutorMetricPillStrong">{fmtPrice(t.price_per_hour)}</div>
            </div>
          </div>
        </div>

        <div className="tutorCTACol">
          <div className="matchBadge">{featured ? 'Top match' : 'Профиль'}</div>
          <div className="btn btnPrimary">Выбрать</div>
        </div>
      </div>

      {bio ? <div className="tutorBio">{bio.slice(0, 165)}{bio.length > 165 ? '…' : ''}</div> : null}

      {!!goals.length && (
        <div className="tutorTagRow">
          {goals.map(g => <span key={g} className="pill">{g}</span>)}
        </div>
      )}

      {!!reasons.length && (
        <div className="tutorReasonBox">
          <div className="small" style={{ fontWeight: 800 }}>Почему подходит</div>
          <div className="tutorReasonRow">
            {reasons.map((item) => <span key={item} className="tutorReasonChip">{item}</span>)}
          </div>
        </div>
      )}
    </Link>
  )
}

export default function Home() {
  const { me } = useAuth()

  const [catalog, setCatalog] = useState({ subjects: [], goals: [], levels: [], grades: [], exams: [], languages: ['ru', 'en'] })
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [tutors, setTutors] = useState([])
  const [recommended, setRecommended] = useState([])

  const [q, setQ] = useState('')
  const [subject, setSubject] = useState('')
  const [goal, setGoal] = useState('')
  const [level, setLevel] = useState('')
  const [grade, setGrade] = useState('')
  const [language, setLanguage] = useState('')
  const [minPrice, setMinPrice] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const [minRating, setMinRating] = useState('')
  const [hasFreeSlots, setHasFreeSlots] = useState(false)
  const [availableFrom, setAvailableFrom] = useState('')
  const [availableTo, setAvailableTo] = useState('')
  const [sort, setSort] = useState('best')

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const c = await apiFetch('/api/catalog')
        if (alive && c) setCatalog(c)
      } catch {
        // ignore catalog fallback for MVP
      }
    })()
    return () => { alive = false }
  }, [])

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
      if (hasFreeSlots) params.set('has_free_slots', 'true')
      if (availableFrom) params.set('available_from', new Date(availableFrom).toISOString())
      if (availableTo) params.set('available_to', new Date(availableTo).toISOString())
      if (sort) params.set('sort', sort)
      const data = await apiFetch(`/api/tutors?${params.toString()}`)
      setTutors(Array.isArray(data) ? data : [])

      try {
        const recParams = new URLSearchParams()
        if (q.trim()) recParams.set('q', q.trim())
        if (subject) recParams.set('subject', subject)
        if (goal) recParams.set('goal', goal)
        if (level) recParams.set('level', level)
        if (grade) recParams.set('grade', grade)
        if (maxPrice !== '') recParams.set('budget', String(Number(maxPrice || 0)))
        recParams.set('has_free_slots', hasFreeSlots ? 'true' : 'true')
        recParams.set('limit', '6')
        const rec = await apiFetch(`/api/tutors/recommended?${recParams.toString()}`)
        setRecommended(Array.isArray(rec?.items) ? rec.items : [])
      } catch {
        setRecommended([])
      }
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
    return arr
  }, [tutors, minRating])

  const featuredSubjects = (catalog.subjects || []).slice(0, 6)
  const featuredExams = (catalog.exams || catalog.goals || []).slice(0, 6)
  const featuredGrades = (catalog.grades || []).slice(0, 6)

  const summary = useMemo(() => {
    const arr = Array.isArray(visibleTutors) ? visibleTutors : []
    const count = arr.length
    const avgPrice = count ? Math.round(arr.reduce((s, t) => s + Number(t.price_per_hour || 0), 0) / count) : 0
    const avgRating = count ? (arr.reduce((s, t) => s + Number(t.rating_avg || 0), 0) / count).toFixed(1) : '0.0'
    const verified = arr.filter(t => t?.is_verified).length
    return { count, avgPrice, avgRating, verified }
  }, [visibleTutors])

  const activeFilters = useMemo(() => {
    const items = []
    if (q) items.push({ label: `Запрос: ${q}`, clear: () => setQ('') })
    if (subject) items.push({ label: `Предмет: ${subject}`, clear: () => setSubject('') })
    if (goal) items.push({ label: `Цель: ${goal}`, clear: () => setGoal('') })
    if (level) items.push({ label: `Уровень: ${level}`, clear: () => setLevel('') })
    if (grade) items.push({ label: `Класс: ${grade}`, clear: () => setGrade('') })
    if (language) items.push({ label: `Язык: ${language}`, clear: () => setLanguage('') })
    if (minPrice) items.push({ label: `Цена от ${minPrice}`, clear: () => setMinPrice('') })
    if (maxPrice) items.push({ label: `Цена до ${maxPrice}`, clear: () => setMaxPrice('') })
    if (minRating) items.push({ label: `Рейтинг ${minRating}+`, clear: () => setMinRating('') })
    if (hasFreeSlots) items.push({ label: 'Только со слотами', clear: () => setHasFreeSlots(false) })
    if (availableFrom) items.push({ label: 'Время: от', clear: () => setAvailableFrom('') })
    if (availableTo) items.push({ label: 'Время: до', clear: () => setAvailableTo('') })
    return items
  }, [q, subject, goal, level, grade, language, minPrice, maxPrice, minRating, hasFreeSlots, availableFrom, availableTo])

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
    setHasFreeSlots(false)
    setAvailableFrom('')
    setAvailableTo('')
    setSort('best')
  }

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="hero searchHeroWrap">
        <div className="heroInner">
          <div className="heroBadge">DoskoLink • подбор репетитора • уроки и Telegram в одной системе</div>
          <div className="heroTitle">Найди репетитора быстрее и выбери по реальным критериям</div>
          <div className="heroSub">
            Удобный поиск, визуальные карточки, рекомендации по совпадению цели и быстрый переход к профилю, слоту и уроку.
          </div>

          {!me && (
            <div className="heroCtas">
              <Link className="btn btnPrimary" to="/register">Регистрация</Link>
              <Link className="btn" to="/login">Войти</Link>
              <a className="btn btnGhost" href="#search">Перейти к подбору</a>
            </div>
          )}

          <div className="searchHeroPanel" id="search">
            <div className="searchStepsGrid">
              <div className="searchStepCard">
                <div className="searchStepNum">1</div>
                <div>
                  <div className="searchStepTitle">Выбери предмет</div>
                  <div className="small">Сразу отфильтруй каталог по ключевой дисциплине.</div>
                </div>
              </div>
              <div className="searchStepCard">
                <div className="searchStepNum">2</div>
                <div>
                  <div className="searchStepTitle">Уточни класс или экзамен</div>
                  <div className="small">ЕГЭ, ОГЭ, школьная программа или разговорная практика.</div>
                </div>
              </div>
              <div className="searchStepCard">
                <div className="searchStepNum">3</div>
                <div>
                  <div className="searchStepTitle">Смотри top matches</div>
                  <div className="small">Платформа покажет лучших кандидатов и причины совпадения.</div>
                </div>
              </div>
            </div>

            <div className="searchQuickGrid">
              <div className="searchQuickBlock">
                <div className="searchQuickTitle">Быстрый старт по предметам</div>
                <div className="pills" style={{ marginTop: 10 }}>
                  {featuredSubjects.map(s => (
                    <Chip key={s} active={subject === s} onClick={() => setSubject(subject === s ? '' : s)}>{s}</Chip>
                  ))}
                </div>
              </div>

              <div className="searchQuickBlock">
                <div className="searchQuickTitle">Класс и экзамен</div>
                <div className="pills" style={{ marginTop: 10 }}>
                  {featuredGrades.map(g => (
                    <Chip key={`g-${g}`} active={grade === g} onClick={() => setGrade(grade === g ? '' : g)}>{g} класс</Chip>
                  ))}
                  {featuredExams.map(x => (
                    <Chip key={`e-${x}`} active={goal === x} onClick={() => setGoal(goal === x ? '' : x)}>{x}</Chip>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="card searchCatalogCard">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <div className="h2">Подбор репетиторов</div>
            <div className="sub">Фильтруй по предмету, цели, бюджету, рейтингу, языку и свободным слотам.</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={resetFilters}>Сбросить</button>
            <button className="btn btnPrimary" onClick={loadTutors} disabled={loading}>{loading ? 'Ищем…' : 'Обновить подбор'}</button>
          </div>
        </div>

        <div className="grid filtersGrid searchFiltersGrid" style={{ marginTop: 12 }}>
          <div>
            <div className="label">Поиск</div>
            <input className="input" value={q} onChange={e => setQ(e.target.value)} placeholder="имя, предмет, ЕГЭ, разговорный…" />
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
            <div className="label">Свободное время: от</div>
            <input className="input" type="datetime-local" value={availableFrom} onChange={e => setAvailableFrom(e.target.value)} />
          </div>
          <div>
            <div className="label">Свободное время: до</div>
            <input className="input" type="datetime-local" value={availableTo} onChange={e => setAvailableTo(e.target.value)} />
          </div>
          <div>
            <div className="label">Свободные слоты</div>
            <label className="searchToggleLabel">
              <input type="checkbox" checked={hasFreeSlots} onChange={e => setHasFreeSlots(e.target.checked)} />
              <span>Только со свободными слотами</span>
            </label>
          </div>
        </div>

        <div className="searchSortRow">
          <div className="small" style={{ fontWeight: 800 }}>Сортировка</div>
          <div className="searchSortChips">
            <SortChip active={sort === 'best'} onClick={() => setSort('best')}>Лучшие</SortChip>
            <SortChip active={sort === 'price_asc'} onClick={() => setSort('price_asc')}>Цена ↑</SortChip>
            <SortChip active={sort === 'price_desc'} onClick={() => setSort('price_desc')}>Цена ↓</SortChip>
            <SortChip active={sort === 'newest'} onClick={() => setSort('newest')}>Новые</SortChip>
          </div>
        </div>

        {!!activeFilters.length && (
          <div className="activeFilterRow">
            {activeFilters.map((item) => <ActiveFilterChip key={item.label} label={item.label} onClear={item.clear} />)}
          </div>
        )}

        {err && <div className="footerNote">{err}</div>}

        <div className="resultsMetricsGrid">
          <ResultMetric label="Найдено" value={loading ? '…' : summary.count} helper="актуально по фильтрам" />
          <ResultMetric label="Средняя цена" value={loading ? '…' : `${summary.avgPrice} ₽`} helper="по текущей выдаче" />
          <ResultMetric label="Средний рейтинг" value={loading ? '…' : summary.avgRating} helper="среднее по списку" />
          <ResultMetric label="Проверенные" value={loading ? '…' : summary.verified} helper="с подтверждённым профилем" />
        </div>

        {Array.isArray(recommended) && recommended.length > 0 && (
          <div className="recommendedPanel">
            <div className="panelTitle">
              <div>
                <div className="h3">Лучшие совпадения</div>
                <div className="small">Подбор по цели, бюджету, рейтингу и наличию свободных слотов.</div>
              </div>
            </div>
            <div className="recommendedGrid">
              {recommended.slice(0, 3).map((it, idx) => (
                <TutorCard key={`rec-${it?.tutor?.id || idx}`} t={it.tutor || {}} why={it.why || []} featured />
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 18 }}>Все результаты</div>
            <div className="small">{!me ? 'Чтобы бронировать занятия, войди как ученик.' : 'Открой профиль, чтобы посмотреть слоты и детали преподавателя.'}</div>
          </div>
          <div className="small">{loading ? 'Загрузка…' : `${visibleTutors.length} карточек`}</div>
        </div>

        <div className="tutorGrid enhancedTutorGrid" style={{ marginTop: 10 }}>
          {loading ? (
            <div className="small">Загрузка…</div>
          ) : visibleTutors.length === 0 ? (
            <div className="searchEmptyState">
              <div className="h3">Репетиторы не найдены</div>
              <div className="small">Ослабь фильтры или сбрось ограничения по цене, рейтингу и времени.</div>
            </div>
          ) : (
            visibleTutors.map(t => <TutorCard key={t.id} t={t} />)
          )}
        </div>
      </div>
    </div>
  )
}
