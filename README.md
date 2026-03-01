# DL MVP (без оплаты) — единый деплой на Railway (1 сервис)

Этот репозиторий — MVP платформы для репетиторов:
- маркетплейс репетиторов + профили
- слоты и бронирование
- комната занятия: WebRTC созвон + чат + доска в реальном времени
- отзывы после занятия
- домашка + прогресс по темам + мини‑тест перед уроком
- уведомления (email/telegram) и напоминания (cron endpoint)

**Важно для MVP:** деплой сделан так, чтобы **не париться** — один сервис на Railway, один домен:
- Dockerfile в корне собирает **frontend** и кладёт `dist/` в `backend/static`
- FastAPI в рантайме отдаёт SPA и обслуживает `/api/*` + `/ws/*`

---

## Важно про домен

Пока вы не привязали свой `.com` через DNS, **используйте домен Railway**, который создаётся кнопкой **Generate Domain** (он выглядит как `https://<service>.up.railway.app`).

Если открыть сайт по `.com` до настройки DNS — вы увидите ошибки входа, потому что запросы `/api/*` не доходят до бэкенда.

---

## Локальный запуск

### Backend
```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# секрет для JWT (локально можно так)
export DL_JWT_SECRET="dev-secret"

uvicorn main:app --reload --host 0.0.0.0 --port 8000
```
Проверка: http://localhost:8000/health

### Frontend
```bash
cd frontend
npm i
npm run dev
```
Открыть: http://localhost:5173

---

## Качественная авторизация (что сделано)

- Пароли хешируются `bcrypt`.
- Access token (JWT) **короткоживущий** (по умолчанию 15 минут).
- Refresh token (JWT) хранится в **HttpOnly cookie** и **ротируется** при обновлении.
- Server‑side logout: у пользователя есть `token_version`. При logout/смене пароля `token_version` увеличивается и **все старые токены становятся недействительными**.
- Роль пользователя: `student | tutor | admin`.

### Админ‑режим
- Включается ролями + endpoint’ами `/api/admin/*`.
- Есть веб‑страница `/admin` (доступ только `admin`).

### Bootstrap admin (чтобы не застрять на деплое)
Если задать переменные:
- `DL_BOOTSTRAP_ADMIN_EMAIL`
- `DL_BOOTSTRAP_ADMIN_PASSWORD`

то при старте приложения админ будет создан (или будет поднята роль до admin).

---

# ✅ Деплой на Railway одним сервисом (самый простой путь)

## 1) Подготовь GitHub
1) Убедись, что **в корне репозитория** лежит `Dockerfile` (в этом проекте он уже есть).
2) Закоммить и запушь всё в GitHub.

## 2) Создай проект в Railway
1) Railway → **New Project** → **Deploy from GitHub Repo** → выбери репозиторий.
2) Railway должен увидеть Dockerfile.
   - Если Railway всё равно пытается билдить через Nixpacks/Railpack и пишет "start.sh not found" —
     зайди в сервис → **Settings** → **Build** и выбери **Builder: Dockerfile**.

## 3) Переменные окружения (Variables) — обязательные
В сервисе Railway → **Variables**:
- `DL_JWT_SECRET` = длинная случайная строка (обязательно)

Рекомендуется для прод‑cookie:
- `DL_COOKIE_SECURE=true`

Чтобы сразу иметь админа:
- `DL_BOOTSTRAP_ADMIN_EMAIL=you@example.com`
- `DL_BOOTSTRAP_ADMIN_PASSWORD=AdminPass123`  (8+ символов, буквы+цифры)

## 4) База данных (рекомендуется)
Для MVP можно жить на SQLite внутри контейнера, но на Railway лучше Postgres:
1) В Railway проекте нажми **Add Service** → **Database** → **PostgreSQL**.
2) Railway создаст `DATABASE_URL` автоматически.
3) Backend сам подхватит `DATABASE_URL`.

## 5) Домен
1) Сервис → **Networking / Domains** → **Generate Domain**.
2) Проверь:
- `https://<domain>/health`
- `https://<domain>/` (должен открыться фронт)

## 6) Проверка сценария
1) Зарегистрируй репетитора → Кабинет → заполни профиль → Опубликовать → создай слоты.
2) Зарегистрируй ученика → забронируй слот.
3) Открой комнату: видео/чат/доска.
4) Заверши занятие → оставь отзыв.

---

## Опционально: уведомления и напоминания

### Email (SMTP)
Variables:
- `DL_SMTP_HOST`
- `DL_SMTP_PORT` (обычно 587)
- `DL_SMTP_USER`
- `DL_SMTP_PASS`
- `DL_SMTP_FROM` (опционально)

### Telegram
Variables:
- `DL_TELEGRAM_BOT_TOKEN`

Пользователь включает Telegram и вводит `chat_id` в Кабинете.

### Напоминания за ~10 минут
Есть endpoint:
- `POST /api/cron/reminders?key=<DL_CRON_KEY>`

Variables:
- `DL_CRON_KEY=любая_секретная_строка`

Как запускать по расписанию (MVP‑варианты):
1) **GitHub Actions** по cron (самый простой).
2) Отдельный маленький worker‑service на Railway.

---

## Переменные окружения (сводка)

**Обязательные:**
- `DL_JWT_SECRET`

**Рекомендуемые:**
- `DL_COOKIE_SECURE=true`
- `DL_BOOTSTRAP_ADMIN_EMAIL`
- `DL_BOOTSTRAP_ADMIN_PASSWORD`

**Опционально:**
- `DATABASE_URL` (автоматически от Railway Postgres)
- `DL_CORS_ORIGINS` (если выносишь фронт отдельно)
- SMTP/Telegram/Cron variables



## Демо-данные (тестовые репетиторы и ученики)

Чтобы быстро показать маркетплейс и комнату урока, можно включить автоматическое создание тестовых пользователей, профилей, слотов и пары занятий.

В Railway → Variables добавьте:

- `DL_SEED_DEMO=true`
- (опционально) `DL_DEMO_PASSWORD=DemoPass123!`
- (опционально) `DL_DEMO_ADMIN_EMAIL=admin@demo.dl`

После этого сделайте **Redeploy**.

### Демо-логины (по умолчанию пароль `DemoPass123!`)
Репетиторы:
- `tutor1@demo.dl` (математика)
- `tutor2@demo.dl` (английский)
- `tutor3@demo.dl` (физика)
- `tutor4@demo.dl` (информатика)
- `tutor5@demo.dl` (русский)
- `tutor6@demo.dl` (химия)

Ученики:
- `student1@demo.dl`
- `student2@demo.dl`
- `student3@demo.dl`
- `student4@demo.dl`
- `student5@demo.dl`
- `student6@demo.dl`

Админ:
- `admin@demo.dl` (создаётся при `DL_SEED_DEMO=true`)
