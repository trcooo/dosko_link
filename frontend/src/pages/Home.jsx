import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../api'
import { useAuth } from '../auth.jsx'

function initials(name) {
  const s = (name || '').trim()
  if (!s) return 'DL'
  const parts = s.split(/\s+/).slice(0, 2)
  return parts.map(p => p[0]?.toUpperCase()).join('')
}

function Feature({ title, text }) {
  return (
    <div className="featureCard">
      <div className="featureTitle">{title}</div>
      <div className="small">{text}</div>
    </div>
  )
}

function RoomPreview() {
  return (
    <div className="mockWrap">
      <div className="mockHeader">
        <div style={{ fontWeight: 900 }}>Комната занятия</div>
        <div className="small">Видео • чат • доска • материалы</div>
      </div>
      <div className="mockRoom">
        <div className="mockLeft">
          <div className="mockVideos">
            <div className="mockVideo">
              <div className="mockTag">Преподаватель</div>
            </div>
            <div className="mockVideo">
              <div className="mockTag">Ученик</div>
            </div>
          </div>
          <div className="mockBoard">
            <div className="mockBoardTop">
              <span className="pill">Перо</span>
              <span className="pill">Текст</span>
              <span className="pill">Фото</span>
              <span className="pill">Экспорт</span>
              <span style={{ marginLeft: 'auto' }} className="small">реально работает в MVP</span>
            </div>
            <div className="mockBoardArea">
              <div className="mockStroke" />
              <div className="mockStroke s2" />
              <div className="mockDot" />
              <div className="mockImg" />
            </div>
          </div>
        </div>
        <div className="mockRight">
          <div className="mockChat">
            <div className="mockChatLine" />
            <div className="mockChatLine short" />
            <div className="mockChatLine" />
            <div className="mockChatLine short" />
            <div className="mockChatLine" />
          </div>
          <div className="mockCard">
            <div style={{ fontWeight: 900 }}>Баланс (пробный)</div>
            <div className="small">Тестовая оплата занятия с баланса — без реальных платежей.</div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function Home() {
  const { me } = useAuth()

  const [q, setQ] = useState('')
  const [subject, setSubject] = useState('')
  const [loading, setLoading] = useState(true)
  const [tutors, setTutors] = useState([])
  const [err, setErr] = useState('')

  const subjectOptions = useMemo(() => [
    '', 'математика', 'английский', 'физика', 'химия', 'русский', 'программирование'
  ], [])

  async function load() {
    setLoading(true)
    setErr('')
    try {
      const params = new URLSearchParams()
      if (q.trim()) params.set('q', q.trim())
      if (subject) params.set('subject', subject)
      const data = await apiFetch(`/api/tutors?${params.toString()}`)
      setTutors(Array.isArray(data) ? data : [])
    } catch (e) {
      setErr(e.message || 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const featured = tutors.slice(0, 6)

  return (
    <div className="grid" style={{ gap: 16 }}>
      {!me && (
        <div className="hero">
          <div className="heroInner">
            <div className="heroBadge">DL • ДоскоЛинк</div>
            <h1 className="heroTitle">Репетиторы, доска и созвон — в одной платформе</h1>
            <div className="heroSub">
              Найти → записаться → провести урок (видео/чат/доска) → прогресс и отзывы.
              Сейчас это MVP: баланс и платежи пробные, но занятия проходят прямо здесь.
            </div>

            <div className="heroCtas">
              <Link className="btn btnPrimary" to="/register">Начать бесплатно</Link>
              <Link className="btn" to="/login">Войти</Link>
              <a className="btn btnGhost" href="#search">Посмотреть репетиторов</a>
            </div>

            <div className="heroGrid">
              <Feature title="Встроенный урок" text="WebRTC созвон + чат + доска в реальном времени." />
              <Feature title="Удержание и прогресс" text="План обучения, домашка, мини-тесты и трекер тем." />
              <Feature title="Доверие" text="Отзывы только после занятия и рейтинг репетиторов." />
              <Feature title="Баланс (пробный)" text="Для MVP: пополнение и оплата занятия тестовые." />
            </div>

            <div style={{ marginTop: 16 }}>
              <RoomPreview />
            </div>

            <div className="howRow">
              <div className="howStep"><b>1.</b> Выбираете репетитора</div>
              <div className="howStep"><b>2.</b> Бронируете слот</div>
              <div className="howStep"><b>3.</b> Урок в комнате</div>
              <div className="howStep"><b>4.</b> Прогресс и отзывы</div>
            </div>

            {featured.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <div style={{ fontWeight: 900, fontSize: 18 }}>Популярные репетиторы</div>
                <div className="sub">Быстрый старт: открой профиль и запишись на слот.</div>
                <div className="tutorGrid" style={{ marginTop: 10 }}>
                  {featured.map(t => (
                    <Link key={t.id} to={`/tutor/${t.id}`} className="tutorCard">
                      <div className="avatar">{initials(t.display_name)}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 900 }}>{t.display_name}</div>
                        <div className="small">
                          {(t.subjects || []).join(', ') || '—'} • {t.price_per_hour || 0} ₽/час
                        </div>
                        <div className="small">★ {Number(t.rating_avg || 0).toFixed(1)} ({t.rating_count || 0})</div>
                      </div>
                      <div className="btn btnPrimary">Открыть</div>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="card" id="search">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <div className="h2">Поиск репетиторов</div>
            <div className="sub">Фильтруй по предмету, цели и цене. Слоты показываются в профиле.</div>
          </div>
          {!me && (
            <div className="small">
              Чтобы бронировать слоты, нужно <Link to="/login">войти</Link>.
            </div>
          )}
        </div>

        <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 2, minWidth: 220 }}>
            <div className="label">Поиск</div>
            <input className="input" value={q} onChange={e => setQ(e.target.value)} placeholder="например: ЕГЭ, математика, разговорный" />
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div className="label">Предмет</div>
            <select className="select" value={subject} onChange={e => setSubject(e.target.value)}>
              {subjectOptions.map(s => (
                <option key={s} value={s}>{s || 'любой'}</option>
              ))}
            </select>
          </div>
          <div style={{ alignSelf: 'flex-end' }}>
            <button className="btn btnPrimary" onClick={load} disabled={loading}>{loading ? 'Ищем…' : 'Найти'}</button>
          </div>
        </div>

        {err && <div className="err" style={{ marginTop: 12 }}>{err}</div>}

        <div style={{ marginTop: 12 }} className="tutorGrid">
          {loading ? (
            <div className="small">Загрузка…</div>
          ) : tutors.length === 0 ? (
            <div className="small">Репетиторы не найдены. Попробуй другой запрос.</div>
          ) : (
            tutors.map(t => (
              <Link key={t.id} to={`/tutor/${t.id}`} className="tutorCard">
                <div className="avatar">{initials(t.display_name)}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 900 }}>{t.display_name}</div>
                  <div className="small">
                    {(t.subjects || []).join(', ') || '—'} • {t.price_per_hour || 0} ₽/час
                  </div>
                  <div className="small">★ {Number(t.rating_avg || 0).toFixed(1)} ({t.rating_count || 0})</div>
                </div>
                <div className="btn btnPrimary">Профиль</div>
              </Link>
            ))
          )}
        </div>
      </div>

      {!me && (
        <div className="card">
          <div className="h3">Почему это удобно</div>
          <div className="grid grid3" style={{ marginTop: 12 }}>
            <Feature title="Одно окно" text="Созвон, доска, чат, материалы — всё в комнате занятия." />
            <Feature title="Качество" text="Отзывы после занятия, отчёты в админке, заявки/проблемы." />
            <Feature title="Готово для роста" text="Баланс и выплаты подключаются позже — архитектура готова." />
          </div>

          <div className="split" style={{ marginTop: 14 }}>
            <div className="card">
              <div style={{ fontWeight: 900 }}>Для ученика</div>
              <ul className="ul" style={{ marginTop: 8 }}>
                <li>Поиск по предметам и рейтингу</li>
                <li>Бронь слота и комната урока</li>
                <li>План обучения, домашка, тесты</li>
                <li>Пробная оплата с баланса (в MVP)</li>
              </ul>
            </div>
            <div className="card">
              <div style={{ fontWeight: 900 }}>Для репетитора</div>
              <ul className="ul" style={{ marginTop: 8 }}>
                <li>Профиль, расписание, слоты</li>
                <li>Уроки внутри платформы</li>
                <li>Материалы, прогресс, мини-тест</li>
                <li>Рейтинг и отзывы после занятий</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
