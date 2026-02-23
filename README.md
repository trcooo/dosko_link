# DL MVP (без оплаты)

Это стартовый каркас MVP платформы для репетиторов:
- маркетплейс профилей репетиторов
- слоты и бронирование
- комната занятия: WebRTC созвон + чат + доска в реальном времени
- отзывы после занятия (UI + API)

## 1) Запуск backend (FastAPI)

```bash
cd backend
python -m venv .venv
# Windows: .venv\\Scripts\\activate
source .venv/bin/activate
pip install -r requirements.txt

# (опционально) переменные окружения
cp .env.example .env
# Linux/macOS
export $(cat .env | xargs)

uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Проверка: http://localhost:8000/health

## 2) Запуск frontend (Vite + React)

```bash
cd frontend
npm i
cp .env.example .env
npm run dev
```

Открыть: http://localhost:5173

## 3) Быстрый сценарий теста

1) Зарегистрируй **репетитора** → зайди в Кабинет → заполни профиль → **Опубликовать** → создай 2–3 слота.
2) Зарегистрируй **ученика** (в другом браузере/инкогнито) → Найти репетитора → открыть профиль → **Забронировать** слот.
3) Откроется комната: протестируй **созвон + доску + чат**.

## 4) Что сделано и что дальше

### Уже в коде
- JWT авторизация
- TutorProfile CRUD + publish
- Slot create/list + booking
- Комната занятия: WebRTC + чат + доска
- Ограничение доступа к комнате только участникам booking
- Завершение/отмена занятия
- Отзывы после завершения (UI + API)

### Следующий логичный шаг (рекомендую)
- Улучшение сигналинга (glare handling, reconnect)
- Экспорт доски (PNG/PDF) ✅
- Уведомления (email/telegram) ✅
- Расписание: показывать booked слоты репетитору ✅
- Перенос занятия на другой слот ✅

### Новое в v1.1
- Экспорт доски в **PNG + PDF** и сохранение в «Материалы занятия»
- Настройки уведомлений в кабинете (email/telegram)
- Endpoint для напоминаний `/api/cron/reminders?key=...` (под Railway Cron)
- Репетитор видит **все слоты** (open + booked)
- Перенос занятия на другой открытый слот

## 5) Структура

- `backend/` — FastAPI + SQLModel (SQLite)
- `frontend/` — Vite React (оранжево-белая тема)

---

# Деплой на Railway (2 сервиса: backend + frontend)

Railway ожидает, что приложение слушает `0.0.0.0:$PORT`.

## A) Backend service

1) Создай новый сервис из репозитория.
2) В настройках сервиса:
   - **Root Directory**: `/backend` (изолированный монорепо)
   - **Config as code path**: `/backend/railway.toml` (опционально, но удобно)
3) Добавь PostgreSQL (плагин/базу) в проект Railway.
4) Переменные окружения (Variables) для backend:
   - `DL_JWT_SECRET` = случайная длинная строка
   - `DL_CORS_ORIGINS` = `https://<твой-frontend-домен>`
   - (опционально) `DL_DB_URL` — если хочешь переопределить `DATABASE_URL`

### Уведомления и напоминания (опционально)
- Email (SMTP): `DL_SMTP_HOST`, `DL_SMTP_PORT`, `DL_SMTP_USER`, `DL_SMTP_PASS`, `DL_SMTP_FROM`
- Telegram: `DL_TELEGRAM_BOT_TOKEN` + включить Telegram в кабинете и указать `chat_id`
- Напоминания: установи `DL_CRON_KEY` и создай Railway Cron, который вызывает:
  `POST https://<backend-domain>/api/cron/reminders?key=<DL_CRON_KEY>`

Рекомендуемая частота Cron: раз в 5 минут.

Backend автоматически подхватит `DATABASE_URL` (Railway Postgres) и создаст таблицы на старте.

## B) Frontend service

1) Создай второй сервис из того же репозитория.
2) В настройках сервиса:
   - **Root Directory**: `/frontend`
   - **Config as code path**: `/frontend/railway.toml`
3) Переменные окружения (Variables) для frontend:
   - `VITE_API_BASE` = `https://<твой-backend-домен>`

Важно: у Vite переменные `VITE_...` подставляются **на этапе сборки**, поэтому `VITE_API_BASE` должен быть задан в Railway до деплоя.

## C) Проверка

- Открой frontend домен → регистрация/логин
- Создай репетитора, опубликуй профиль, создай слоты
- Под учеником забронируй слот → зайди в комнату → проверь **видео + чат + доску**
