import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../api'
import { useAuth } from '../auth.jsx'

function initials(name) {
  const s = (name || '').trim()
  if (!s) return 'DL'
  return s.split(/\s+/).slice(0, 2).map(x => x[0]?.toUpperCase()).join('') || 'DL'
}

function Chip({ active, onClick, children }) {
  return (
    <button className={active ? 'btn btnPrimary' : 'btn'} onClick={onClick} type="button">
      {children}
    </button>
  )
}

function TutorCard({ t, why = [] }) {
  return (
    <Link to={`/tutor/${t.id}`} className="tutorCard tutorCardRich">
      {t.photo_url ? (
        <img className="avatar avatarImg" src={t.photo_url} alt={t.display_name} />
      ) : (
        <div className="avatar">{initials(t.display_name)}</div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 900 }}>{t.display_name}</div>
          {t.founding_tutor ? <span className="pill badgeGold">Founding tutor</span> : null}
          {t.is_verified ? <span className="pill badgeGreen">Проверен</span> : null}
        </div>
        <div className="small" style={{ marginTop: 4 }}>
          {(t.subjects || []).join(', ') || '—'} • {t.price_per_hour || 0} ₽/час • {t.language || 'ru'}
        </div>
        <div className="small">★ {Number(t.rating_avg || 0).toFixed(1)} ({t.rating_count || 0}) • занятий: {t.lessons_count || 0}</div>
        {!!(t.goals || []).length && (
          <div className="pills" style={{ marginTop: 6 }}>
            {(t.goals || []).slice(0, 3).map(g => <span key={g} className="pill">{g}</span>)}
          </div>
        )}
        {Array.isArray(why) && why.length > 0 && (
          <div className="small" style={{ marginTop: 6 }}>
            <b>Почему подходит:</b> {why.slice(0, 3).join(' · ')}
          </div>
        )}
      </div>
      <div className="btn btnPrimary">Профиль</div>
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
  const [minRating, setMinRating] = useState('') // client-side filter
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
        // fallback silently
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
      <div className="hero">
        <div className="heroInner">
          <div className="heroBadge">DoskoLink • MVP v0 • без встроенных оплат</div>
          <div className="heroTitle">Найдите репетитора и проведите урок прямо на платформе</div>
          <div className="heroSub">
            Маркетплейс репетиторов → бронирование слота → комната урока (видео/чат/доска) → отзыв и рейтинг.
          </div>

          {!me && (
            <div className="heroCtas">
              <Link className="btn btnPrimary" to="/register">Регистрация</Link>
              <Link className="btn" to="/login">Войти</Link>
              <a className="btn btnGhost" href="#search">Выбрать репетитора</a>
            </div>
          )}

          <div style={{ marginTop: 16 }} className="grid" id="search">
            <div className="card" style={{ background: 'rgba(255,255,255,.92)' }}>
              <div style={{ fontWeight: 900, fontSize: 18 }}>1) Выбор предмета</div>
              <div className="pills" style={{ marginTop: 10 }}>
                {featuredSubjects.map(s => (
                  <Chip key={s} active={subject === s} onClick={() => setSubject(subject === s ? '' : s)}>{s}</Chip>
                ))}
              </div>

              <div style={{ fontWeight: 900, fontSize: 18, marginTop: 14 }}>2) Класс / экзамен</div>
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

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <div className="h2">Каталог репетиторов</div>
            <div className="sub">Сначала лучшие. Фильтры: предмет, цель, уровень, цена, рейтинг, язык и свободное время.</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={resetFilters}>Сбросить</button>
            <button className="btn btnPrimary" onClick={loadTutors} disabled={loading}>{loading ? 'Ищем…' : 'Найти'}</button>
          </div>
        </div>

        <div className="grid filtersGrid" style={{ marginTop: 12 }}>
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

        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={hasFreeSlots} onChange={e => setHasFreeSlots(e.target.checked)} />
            Только со свободными слотами
          </label>
          {!me && <span className="small">Чтобы бронировать, нужно войти как ученик.</span>}
        </div>

        {err && <div className="footerNote">{err}</div>}

        {Array.isArray(recommended) && recommended.length > 0 && (
          <div className="card" style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 900 }}>Рекомендуемые репетиторы (почему)</div>
            <div className="small">Подбор по совпадению цели/уровня/бюджета/свободных слотов и удержанию.</div>
            <div className="grid" style={{ gap: 10, marginTop: 10 }}>
              {recommended.map((it, idx) => <TutorCard key={`rec-${it?.tutor?.id || idx}`} t={it.tutor || {}} why={it.why || []} />)}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 900 }}>Результаты</div>
          <div className="small">{loading ? 'Загрузка…' : `${visibleTutors.length} репетиторов`}</div>
        </div>

        <div className="tutorGrid" style={{ marginTop: 10 }}>
          {loading ? (
            <div className="small">Загрузка…</div>
          ) : visibleTutors.length === 0 ? (
            <div className="small">Репетиторы не найдены. Попробуй ослабить фильтры.</div>
          ) : (
            visibleTutors.map(t => <TutorCard key={t.id} t={t} />)
          )}
        </div>
      </div>
    </div>
  )
}
