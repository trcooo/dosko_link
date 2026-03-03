from __future__ import annotations

import asyncio
import os
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Tuple

from sqlmodel import Session, select
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.constants import ParseMode
from telegram.ext import Application, ApplicationBuilder, CommandHandler, ContextTypes

from db import engine, init_db
from models import Booking, Slot, TelegramDispatchLog, TelegramLinkToken, TutorProfile, User


# -----------------
# Config
# -----------------

def _env_int(name: str, default: int, min_v: Optional[int] = None, max_v: Optional[int] = None) -> int:
    try:
        v = int(os.getenv(name) or default)
    except Exception:
        v = default
    if min_v is not None:
        v = max(min_v, v)
    if max_v is not None:
        v = min(max_v, v)
    return v


def _frontend_base_url() -> str:
    return (os.getenv("DL_FRONTEND_URL") or "").strip().rstrip("/")


def _room_url(room_id: str) -> Optional[str]:
    base = _frontend_base_url()
    if not base:
        return None
    return f"{base}/room/{room_id}"


def _lead_minutes() -> List[int]:
    raw = (os.getenv("DL_TELEGRAM_REMINDER_LEADS") or "1440,120,15").strip()
    out: List[int] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            value = int(part)
        except Exception:
            continue
        if value >= 1:
            out.append(value)
    out = sorted(set(out), reverse=True)
    return out or [1440, 120, 15]


def _poll_sec() -> int:
    return _env_int("DL_TELEGRAM_BOT_POLL_SEC", 30, min_v=5, max_v=300)


def _reminder_grace_min() -> int:
    return _env_int("DL_TELEGRAM_REMINDER_GRACE_MIN", 20, min_v=3, max_v=180)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(dt: Optional[datetime]) -> Optional[datetime]:
    if not dt:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _fmt_dt(dt: datetime) -> str:
    # MVP: display UTC time explicitly to avoid timezone confusion.
    return dt.astimezone(timezone.utc).strftime("%d.%m.%Y %H:%M UTC")


def _fmt_countdown(delta: timedelta) -> str:
    total_min = max(0, int(delta.total_seconds() // 60))
    if total_min >= 60:
        h = total_min // 60
        m = total_min % 60
        if m:
            return f"{h}ч {m}м"
        return f"{h}ч"
    return f"{total_min} мин"


def _user_label(u: Optional[User]) -> str:
    if not u:
        return "Пользователь"
    email = (u.email or "").strip()
    return email or f"User #{u.id}"


def _tutor_label(tutor: Optional[User], tutor_profile: Optional[TutorProfile]) -> str:
    if tutor_profile and (tutor_profile.display_name or "").strip():
        return tutor_profile.display_name.strip()
    return _user_label(tutor)


# -----------------
# DB helpers
# -----------------

def _find_linked_user_by_chat(chat_id: int) -> Optional[User]:
    with Session(engine) as session:
        return session.exec(select(User).where(User.telegram_chat_id == str(chat_id))).first()


def _link_chat_by_token(chat_id: int, token: str) -> Tuple[bool, str]:
    now = _utcnow()
    token = (token or "").strip()
    if not token:
        return False, "Пустой токен. Открой ссылку из личного кабинета ещё раз."

    with Session(engine) as session:
        row = session.exec(select(TelegramLinkToken).where(TelegramLinkToken.token == token)).first()
        if not row:
            return False, "Токен не найден. Сгенерируйте новую ссылку в личном кабинете."
        if row.used_at is not None:
            return False, "Этот токен уже использован. Сгенерируйте новый токен."
        if _as_utc(row.expires_at) and _as_utc(row.expires_at) < now:
            return False, "Токен истёк. Сгенерируйте новую ссылку в личном кабинете."

        user = session.get(User, row.user_id)
        if not user:
            return False, "Пользователь не найден."

        # If this chat was linked to another account earlier, unlink that account first (best effort).
        existing = session.exec(select(User).where(User.telegram_chat_id == str(chat_id))).all()
        for u in existing:
            if u.id != user.id:
                u.telegram_chat_id = None
                u.notify_telegram = False
                session.add(u)

        user.telegram_chat_id = str(chat_id)
        user.notify_telegram = True
        row.used_at = now.replace(tzinfo=None) if (row.used_at and row.used_at.tzinfo is None) else now
        # To keep consistency with existing naive DB fields in SQLite, store naive UTC timestamps.
        if getattr(row, 'used_at', None) and getattr(row.used_at, 'tzinfo', None) is not None:
            row.used_at = row.used_at.astimezone(timezone.utc).replace(tzinfo=None)

        session.add(user)
        session.add(row)
        session.commit()

        role_ru = {
            "student": "ученик",
            "tutor": "репетитор",
            "admin": "админ",
        }.get((user.role or "").lower(), user.role or "user")
        return True, f"✅ Telegram подключён к аккаунту ({role_ru}: {user.email}).\nУведомления включены."


def _list_upcoming_bookings_for_user(user: User, limit: int = 10) -> List[Tuple[Booking, Slot, Optional[User], Optional[TutorProfile]]]:
    with Session(engine) as session:
        if user.role == "tutor":
            bookings = session.exec(
                select(Booking)
                .where(Booking.tutor_user_id == user.id)
                .where(Booking.status == "confirmed")
                .order_by(Booking.created_at.desc())
            ).all()
        elif user.role == "student":
            bookings = session.exec(
                select(Booking)
                .where(Booking.student_user_id == user.id)
                .where(Booking.status == "confirmed")
                .order_by(Booking.created_at.desc())
            ).all()
        else:
            bookings = []

        rows: List[Tuple[Booking, Slot, Optional[User], Optional[TutorProfile]]] = []
        now = _utcnow()
        for b in bookings:
            slot = session.get(Slot, b.slot_id)
            if not slot:
                continue
            starts_at = _as_utc(slot.starts_at)
            if not starts_at:
                continue
            if starts_at < now - timedelta(minutes=5):
                continue

            counterpart_user = None
            tutor_profile = None
            if user.role == "student":
                counterpart_user = session.get(User, b.tutor_user_id)
                tutor_profile = session.exec(select(TutorProfile).where(TutorProfile.user_id == b.tutor_user_id)).first()
            elif user.role == "tutor":
                counterpart_user = session.get(User, b.student_user_id)
                tutor_profile = session.exec(select(TutorProfile).where(TutorProfile.user_id == b.tutor_user_id)).first()

            rows.append((b, slot, counterpart_user, tutor_profile))

        rows.sort(key=lambda x: _as_utc(x[1].starts_at) or _utcnow())
        return rows[:limit]


def _render_booking_line(current_user: User, b: Booking, slot: Slot, counterpart: Optional[User], tutor_profile: Optional[TutorProfile]) -> str:
    starts = _as_utc(slot.starts_at)
    ends = _as_utc(slot.ends_at)
    if not starts:
        starts_text = str(slot.starts_at)
    else:
        starts_text = _fmt_dt(starts)
    duration_min = "?"
    if starts and ends:
        duration_min = str(max(1, int((ends - starts).total_seconds() // 60)))

    if current_user.role == "student":
        who = _tutor_label(counterpart, tutor_profile)
        prefix = "Репетитор"
    elif current_user.role == "tutor":
        who = _user_label(counterpart)
        prefix = "Ученик"
    else:
        who = _user_label(counterpart)
        prefix = "Участник"

    room_id = f"booking-{b.id}"
    room_url = _room_url(room_id)
    room_text = f"Комната: {room_id}"
    if room_url:
        room_text += f"\n🔗 {room_url}"

    return (
        f"• <b>{starts_text}</b> ({duration_min} мин)\n"
        f"  {prefix}: {who}\n"
        f"  {room_text}"
    )


def _schedule_text(current_user: User, rows: List[Tuple[Booking, Slot, Optional[User], Optional[TutorProfile]]], title: str) -> str:
    if not rows:
        return f"{title}\n\nПока нет ближайших подтверждённых занятий."
    parts = [title, ""]
    for item in rows:
        parts.append(_render_booking_line(current_user, *item))
    return "\n\n".join(parts)


# -----------------
# Telegram command handlers
# -----------------

async def _require_linked_user(update: Update) -> Optional[User]:
    chat = update.effective_chat
    if not chat:
        return None
    user = _find_linked_user_by_chat(chat.id)
    if user:
        return user
    if update.message:
        await update.message.reply_text(
            "Этот Telegram ещё не привязан к аккаунту.\n"
            "Откройте личный кабинет платформы → подключение Telegram → сгенерируйте ссылку и нажмите её."
        )
    return None


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if not msg:
        return

    args = context.args or []
    if args:
        ok, text = _link_chat_by_token(update.effective_chat.id, args[0])
        await msg.reply_text(text)
        if ok:
            await msg.reply_text(
                "Доступные команды:\n"
                "/today — занятия сегодня\n"
                "/tomorrow — занятия завтра\n"
                "/next — ближайшее занятие\n"
                "/schedule — ближайшие 5 занятий\n"
                "/help — помощь"
            )
        return

    user = _find_linked_user_by_chat(update.effective_chat.id)
    if user:
        await msg.reply_text(
            f"Привет! Telegram уже подключён к аккаунту {user.email}.\n"
            "Используйте /today, /next, /schedule"
        )
    else:
        await msg.reply_text(
            "Привет! Я бот-ассистент DoskoLink.\n"
            "Чтобы подключить уведомления, откройте личный кабинет и нажмите 'Подключить Telegram'."
        )


async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if not msg:
        return
    await msg.reply_text(
        "Команды:\n"
        "/today — занятия на сегодня\n"
        "/tomorrow — занятия на завтра\n"
        "/next — ближайшее занятие\n"
        "/schedule — ближайшие 5 занятий\n"
        "/help — помощь\n\n"
        "Время пока показывается в UTC (в следующих версиях можно добавить персональный часовой пояс)."
    )


async def _cmd_list(update: Update, title: str, mode: str) -> None:
    msg = update.message
    if not msg:
        return
    user = await _require_linked_user(update)
    if not user:
        return

    rows = _list_upcoming_bookings_for_user(user, limit=10)
    now = _utcnow()

    filtered: List[Tuple[Booking, Slot, Optional[User], Optional[TutorProfile]]] = []
    for row in rows:
        _, slot, _, _ = row
        starts = _as_utc(slot.starts_at)
        if not starts:
            continue
        if mode == "today":
            if starts.date() == now.date():
                filtered.append(row)
        elif mode == "tomorrow":
            if starts.date() == (now + timedelta(days=1)).date():
                filtered.append(row)
        elif mode == "next":
            filtered.append(row)
            break
        elif mode == "schedule":
            filtered.append(row)

    if mode == "schedule":
        filtered = filtered[:5]

    text = _schedule_text(user, filtered, title)

    reply_markup = None
    if filtered:
        b, _, _, _ = filtered[0]
        room_url = _room_url(f"booking-{b.id}")
        if room_url:
            reply_markup = InlineKeyboardMarkup(
                [[InlineKeyboardButton("Открыть ближайшее занятие", url=room_url)]]
            )

    await msg.reply_text(text, parse_mode=ParseMode.HTML, disable_web_page_preview=True, reply_markup=reply_markup)


async def cmd_today(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await _cmd_list(update, "📅 Занятия на сегодня", "today")


async def cmd_tomorrow(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await _cmd_list(update, "📅 Занятия на завтра", "tomorrow")


async def cmd_next(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await _cmd_list(update, "⏭ Ближайшее занятие", "next")


async def cmd_schedule(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await _cmd_list(update, "🗓 Ближайшие занятия", "schedule")


# -----------------
# Reminder loop
# -----------------

def _already_sent(session: Session, unique_key: str) -> bool:
    row = session.exec(select(TelegramDispatchLog).where(TelegramDispatchLog.unique_key == unique_key)).first()
    return bool(row)


def _save_dispatch_log(
    session: Session,
    unique_key: str,
    kind: str,
    booking_id: int,
    user_id: int,
    scheduled_for: datetime,
    sent_at: Optional[datetime],
    status: str,
    error: str = "",
) -> None:
    row = TelegramDispatchLog(
        unique_key=unique_key,
        kind=kind,
        booking_id=booking_id,
        user_id=user_id,
        scheduled_for=scheduled_for.astimezone(timezone.utc).replace(tzinfo=None),
        sent_at=(sent_at.astimezone(timezone.utc).replace(tzinfo=None) if sent_at else None),
        status=status,
        error=(error or "")[:500],
    )
    session.add(row)


def _booking_participants_and_labels(session: Session, booking: Booking):
    tutor = session.get(User, booking.tutor_user_id)
    student = session.get(User, booking.student_user_id)
    tutor_profile = session.exec(select(TutorProfile).where(TutorProfile.user_id == booking.tutor_user_id)).first()
    return tutor, student, tutor_profile


def _build_reminder_message(
    recipient: User,
    booking: Booking,
    slot: Slot,
    tutor: Optional[User],
    student: Optional[User],
    tutor_profile: Optional[TutorProfile],
    lead_min: int,
    now: datetime,
) -> Tuple[str, Optional[InlineKeyboardMarkup]]:
    starts = _as_utc(slot.starts_at) or now
    ends = _as_utc(slot.ends_at)
    duration_min = 60
    if ends:
        duration_min = max(1, int((ends - starts).total_seconds() // 60))
    countdown = _fmt_countdown(starts - now)

    if recipient.id == booking.student_user_id:
        counterpart = _tutor_label(tutor, tutor_profile)
        who_line = f"👩‍🏫 Репетитор: {counterpart}"
    else:
        counterpart = _user_label(student)
        who_line = f"🧑‍🎓 Ученик: {counterpart}"

    room_id = f"booking-{booking.id}"
    room_url = _room_url(room_id)

    lead_text = {
        1440: "за 24 часа",
        120: "за 2 часа",
        15: "за 15 минут",
    }.get(lead_min, f"за {lead_min} мин")

    text = (
        f"⏰ Напоминание о занятии ({lead_text})\n\n"
        f"🕒 Начало: {_fmt_dt(starts)}\n"
        f"⏳ До старта: {countdown}\n"
        f"⌛ Длительность: {duration_min} мин\n"
        f"{who_line}\n"
        f"🏷 Комната: {room_id}"
    )
    if room_url:
        text += f"\n🔗 {room_url}"

    markup = None
    if room_url:
        markup = InlineKeyboardMarkup(
            [[InlineKeyboardButton("Открыть занятие", url=room_url)]]
        )
    return text, markup


async def _send_due_reminders(app: Application) -> None:
    now = _utcnow()
    leads = _lead_minutes()
    grace = timedelta(minutes=_reminder_grace_min())
    lookahead = timedelta(minutes=max(leads) + 5)

    sent = 0
    checked = 0
    with Session(engine) as session:
        bookings = session.exec(
            select(Booking).where(Booking.status == "confirmed")
        ).all()

        for booking in bookings:
            slot = session.get(Slot, booking.slot_id)
            if not slot:
                continue
            starts = _as_utc(slot.starts_at)
            if not starts:
                continue
            if starts < now - timedelta(minutes=5):
                continue
            if starts > now + lookahead:
                continue

            tutor, student, tutor_profile = _booking_participants_and_labels(session, booking)
            recipients = [u for u in [tutor, student] if u and getattr(u, "notify_telegram", False) and getattr(u, "telegram_chat_id", None)]
            if not recipients:
                continue

            for lead in leads:
                scheduled_for = starts - timedelta(minutes=lead)
                if scheduled_for > now:
                    continue
                if now - scheduled_for > grace:
                    continue

                for recipient in recipients:
                    checked += 1
                    unique_key = f"tg:reminder:booking:{booking.id}:user:{recipient.id}:lead:{lead}"
                    if _already_sent(session, unique_key):
                        continue

                    text, markup = _build_reminder_message(recipient, booking, slot, tutor, student, tutor_profile, lead, now)
                    try:
                        await app.bot.send_message(
                            chat_id=str(recipient.telegram_chat_id),
                            text=text,
                            disable_web_page_preview=True,
                            reply_markup=markup,
                        )
                        _save_dispatch_log(
                            session,
                            unique_key=unique_key,
                            kind="reminder",
                            booking_id=booking.id,
                            user_id=recipient.id,
                            scheduled_for=scheduled_for,
                            sent_at=now,
                            status="sent",
                        )
                        sent += 1
                    except Exception as e:
                        _save_dispatch_log(
                            session,
                            unique_key=unique_key,
                            kind="reminder",
                            booking_id=booking.id,
                            user_id=recipient.id,
                            scheduled_for=scheduled_for,
                            sent_at=None,
                            status="error",
                            error=str(e),
                        )
            session.commit()

    if sent or checked:
        print(f"[tg-reminders] checked={checked} sent={sent} at={now.isoformat()}")


async def _reminder_loop(app: Application) -> None:
    print("[tg-reminders] loop started")
    while True:
        try:
            await _send_due_reminders(app)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[tg-reminders] error: {e}")
        await asyncio.sleep(_poll_sec())


async def _post_init(app: Application) -> None:
    app.bot_data["reminder_task"] = asyncio.create_task(_reminder_loop(app))


async def _post_shutdown(app: Application) -> None:
    task = app.bot_data.get("reminder_task")
    if task:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


# -----------------
# Bootstrap
# -----------------

def main() -> None:
    token = (os.getenv("DL_TELEGRAM_BOT_TOKEN") or "").strip()
    if not token:
        raise RuntimeError("DL_TELEGRAM_BOT_TOKEN is required")

    # Ensure DB and new tables exist before polling starts.
    init_db()

    app = (
        ApplicationBuilder()
        .token(token)
        .post_init(_post_init)
        .post_shutdown(_post_shutdown)
        .build()
    )
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_help))
    app.add_handler(CommandHandler("today", cmd_today))
    app.add_handler(CommandHandler("tomorrow", cmd_tomorrow))
    app.add_handler(CommandHandler("next", cmd_next))
    app.add_handler(CommandHandler("schedule", cmd_schedule))

    print("[tg-bot] starting polling")
    app.run_polling(allowed_updates=["message"])


if __name__ == "__main__":
    main()
