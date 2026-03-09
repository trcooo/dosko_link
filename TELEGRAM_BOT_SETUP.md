# Telegram bot setup for DoskoLink

## What is already implemented

- Secure account linking from the dashboard via one-time deep link token.
- Role-aware bot behavior: student, tutor, and admin are identified automatically from the linked DoskoLink account.
- Telegram webhook endpoint: `/api/integrations/telegram/webhook`.
- Commands:
  - `/start`
  - `/help`
  - `/today`
  - `/tomorrow`
  - `/next`
  - `/schedule`
  - `/link`
  - `/unlink`
- Dashboard controls for:
  - connect Telegram
  - regenerate link token
  - unlink Telegram
  - fallback manual `chat_id`

## Environment variables

Set these in Railway backend service:

- `DL_TELEGRAM_BOT_TOKEN`
- `DL_TELEGRAM_BOT_USERNAME`
- `DL_PUBLIC_APP_URL`
- `DL_TELEGRAM_WEBHOOK_SECRET`
- `DL_TELEGRAM_LINK_TTL_MIN=30`

Optional existing vars:

- `DL_CRON_KEY`
- `DL_ATTENDANCE_FOLLOWUP_MIN`
- `DL_ATTENDANCE_FOLLOWUP_MAX`

## BotFather

Recommended command list:

```text
start - подключить аккаунт DoskoLink
help - список команд
whoami - показать подключённый аккаунт и роль
next - ближайшее занятие
today - занятия на сегодня
tomorrow - занятия на завтра
schedule - ближайшие 5 занятий
stats - сводка платформы для админа
link - открыть личный кабинет
unlink - отвязать Telegram
```

## Webhook

Example command to register webhook:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<YOUR_BACKEND_DOMAIN>/api/integrations/telegram/webhook",
    "secret_token": "<YOUR_DL_TELEGRAM_WEBHOOK_SECRET>",
    "allowed_updates": ["message"]
  }'
```

Check webhook status:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
```

## Linking flow

1. User logs into DoskoLink dashboard.
2. User clicks **Подключить Telegram**.
3. Backend generates one-time token and deep link.
4. Telegram opens the bot with `/start <token>`.
5. Backend verifies token, links `telegram_chat_id` to the DoskoLink user and enables Telegram notifications.
6. User role is taken from the DoskoLink account, so the bot automatically switches between student, tutor, and admin behavior.

## Current product rules

- One Telegram chat = one linked DoskoLink account.
- If the same chat is linked to another account, the old link is removed.
- Tokens expire automatically.
- Re-linking is done only from the authenticated dashboard.


## Inline-кнопки под карточками уроков

Бот теперь поддерживает inline-кнопки под сообщениями с уроками:
- ✅ Подтверждаю
- ❌ Не смогу
- 🔗 Открыть занятие
- 🏠 Открыть кабинет

Чтобы Telegram присылал на backend нажатия по inline-кнопкам, webhook должен принимать не только `message`, но и `callback_query`.
Если вы раньше настраивали webhook только с `allowed_updates: ["message"]`, обновите его так:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook"   -H "Content-Type: application/json"   -d '{
    "url": "https://<YOUR_BACKEND_DOMAIN>/api/integrations/telegram/webhook",
    "secret_token": "<YOUR_DL_TELEGRAM_WEBHOOK_SECRET>",
    "allowed_updates": ["message", "callback_query"]
  }'
```
