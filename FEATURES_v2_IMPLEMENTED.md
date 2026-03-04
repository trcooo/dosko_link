# DL MVP — Growth & Retention Pack (v2)

Реализовано (MVP-версия):

## A. Быстрый рост
- Attendance confirmation (уже было, сохранено)
- Быстрый перенос через шаблоны (уже было, сохранено)
- Повторная запись в 1 клик (уже было, сохранено)
- Домашка: cron-напоминания (`/api/cron/homework-reminders`) + уведомления о проверке
- Родительские уведомления:
  - контакт родителя (`/api/me/parent-contact`)
  - cron по урокам (`/api/cron/parent-notifications`)
  - комментарий репетитора после урока (`/api/bookings/{id}/tutor-comment`)

## B. Конверсия
- Рекомендуемые репетиторы с объяснением `почему` (`/api/tutors/recommended`) + блок на главной
- Структурированная методика профиля (`/api/tutors/*/methodology`) + отображение в профиле
- Пробный урок отдельным сценарием (`/api/slots/{id}/book-trial`) + follow-up план 4 недели (`/api/bookings/{id}/trial-followup`)

## C. Удержание репетиторов
- Мини-CRM (карточка ученика + summary/pulse/history) (`/api/crm/...`) + базовый UI в Learning
- Шаблоны сообщений/ДЗ (`/api/templates`) + отправка по booking_id (`/api/templates/{id}/send`) + UI в Learning
- Weekly digest (preview `/api/me/weekly-digest`, cron `/api/cron/weekly-digest`)

## D. Качество платформы
- Отзывы с критериями (доп. детали) (`/api/bookings/{id}/review/details`, `/api/tutors/{id}/reviews/extended`) + UI в ReviewModal/профиле
- Флаг риска срыва (уже был, сохранен)
- Анти-обход через ценность: добавлены/усилены scheduling+notifications+history+pulse+reviews (`/api/platform/value-features`)

## Фишки под продукт
- Режим экзамена (`/api/exam-mode`) + UI в Dashboard
- Пульс ученика (`/api/pulse/mine`, `/api/pulse/student/{id}`) + UI (student+tutor)
- Last-minute booking / «Слоты горят» (`/api/alerts/last-minute`, cron `/api/cron/marketplace-alerts`)
- Waitlist (`/api/waitlist`, cron `/api/cron/marketplace-alerts`)
- Серии занятий / recurring booking (`/api/recurring/bookings`) + UI в Dashboard

## Важно: cron на Railway
Рекомендуется добавить cron-вызовы (с `?key=<DL_CRON_KEY>`):
- `/api/cron/reminders` — уроки (существующий)
- `/api/cron/homework-reminders`
- `/api/cron/parent-notifications`
- `/api/cron/marketplace-alerts` (часто, например каждые 5-10 минут)
- `/api/cron/weekly-digest` (1 раз в неделю)

