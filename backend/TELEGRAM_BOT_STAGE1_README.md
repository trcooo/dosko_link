# Telegram Bot Stage 1 (DoskoLink)

Что входит в этап 1:
- привязка Telegram к аккаунту через одноразовый токен (`/api/telegram/link-token`)
- команды бота: `/today`, `/tomorrow`, `/next`, `/schedule`, `/help`
- напоминания за `24ч`, `2ч`, `15м`
- кнопка `Открыть занятие` в напоминаниях (если задан `DL_FRONTEND_URL`)
- существующие уведомления backend о брони/переносе/отмене продолжают работать в Telegram (если `notify_telegram=true`)

## Быстрый запуск локально (dev)

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

В другом терминале:

```bash
cd backend
python telegram_bot_worker.py
```

## Переменные окружения (важные)

- `DL_TELEGRAM_BOT_TOKEN` — токен от BotFather
- `DL_TELEGRAM_BOT_USERNAME` — username бота без `@` (нужен для deep-link)
- `DL_FRONTEND_URL` — публичный URL фронтенда, чтобы кнопка вела в комнату урока
- `DL_TELEGRAM_REMINDER_LEADS` — список минут через запятую (по умолчанию `1440,120,15`)
- `DL_TELEGRAM_REMINDER_GRACE_MIN` — окно догоняющей отправки, если worker был перезапущен
- `DL_TELEGRAM_BOT_POLL_SEC` — частота проверки напоминаний (по умолчанию `30`)

## Привязка Telegram (через API)

1. Пользователь логинится в платформе и получает access token.
2. Вызывает `POST /api/telegram/link-token` с `Authorization: Bearer <token>`.
3. Берёт `deep_link` из ответа и открывает его.
4. Бот получает `/start <token>` и автоматически связывает `telegram_chat_id` с пользователем.

## Что можно добавить следующим этапом

- подтверждение участия (`✅ Подтверждаю`)
- персональные таймзоны пользователей
- недельный дайджест
- домашка и дедлайны в боте
