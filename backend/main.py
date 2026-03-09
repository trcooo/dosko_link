from __future__ import annotations

import base64
import io
import json
import os
import re
import secrets
import smtplib
import ssl
import time
import urllib.parse
import urllib.request
from pathlib import Path
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordRequestForm
from fastapi.responses import Response, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from auth import (
    create_access_token,
    create_refresh_token,
    decode_and_get_user,
    get_current_user,
    hash_password,
    require_role,
    verify_password,
)
from db import get_session
from models import (
    Booking,
    Homework,
    LessonArtifact,
    LessonMaterial,
    PreLessonCheckin,
    IssueReport,
    Review,
    Slot,
    TopicProgress,
    TutorProfile,
    PlatformCatalog,
    User,
    StudyPlan,
    PlanItem,
    StudentLibraryItem,
    BalanceTx,
    Quiz,
    QuizQuestion,
    QuizAttempt,
    ParentContact,
    TutorMethodology,
    TutorStudentCRMCard,
    LessonNote,
    TutorMessageTemplate,
    WaitlistEntry,
    LastMinuteAlertSubscription,
    RecurringBookingSeries,
    RecurringBookingSeriesItem,
    ExamTrack,
    BookingMeta,
    NotificationLog,
    ReviewDetail,
    TelegramLinkToken,
)

app = FastAPI(title="DL MVP API", version="0.9.0")

# -----------------
# CORS
# -----------------
# In Railway, set DL_CORS_ORIGINS to your frontend domain(s), comma-separated.
_default_origins = "http://localhost:5173,http://127.0.0.1:5173"
origins = [o.strip() for o in (os.getenv("DL_CORS_ORIGINS") or _default_origins).split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup():
    # Create tables (no migrations in MVP) and bootstrap admin if configured.
    from db import init_db, engine

    init_db()

    admin_email = (os.getenv('DL_BOOTSTRAP_ADMIN_EMAIL') or '').strip().lower()
    admin_password = os.getenv('DL_BOOTSTRAP_ADMIN_PASSWORD') or ''
    if admin_email and admin_password:
        with Session(engine) as session:
            u = session.exec(select(User).where(User.email == admin_email)).first()
            if not u:
                u = User(email=admin_email, password_hash=hash_password(admin_password), role='admin')
                session.add(u)
                session.commit()
                session.refresh(u)
                print(f'[bootstrap] created admin user: {admin_email}')
            else:
                changed = False
                if u.role != 'admin':
                    u.role = 'admin'
                    changed = True
                if not getattr(u, 'is_active', True):
                    u.is_active = True
                    changed = True
                if changed:
                    session.add(u)
                    session.commit()
                    print(f'[bootstrap] updated admin user: {admin_email}')
    # Seed demo accounts for quick testing (optional)
    try:
        from seed import seed_demo
        with Session(engine) as session:
            seed_demo(session)
    except Exception as e:
        print(f'[seed] failed: {e}')
@app.get("/health")
def health():
    return {"ok": True, "ts": datetime.utcnow().isoformat()}


# -----------------
# Helpers
# -----------------

def _loads_list(s: str) -> List[str]:
    try:
        return list(json.loads(s or "[]"))
    except Exception:
        return []


def _mask_email(email: str) -> str:
    e = (email or "").strip()
    if "@" not in e:
        return "user"
    name, dom = e.split("@", 1)
    if len(name) <= 2:
        name_m = name[0] + "*"
    else:
        name_m = name[0] + "*" * (len(name) - 2) + name[-1]
    dom_parts = dom.split(".")
    dom_short = dom_parts[0][:1] + "***" if dom_parts else "***"
    return f"{name_m}@{dom_short}"


def _room_booking_id(room_id: str) -> Optional[int]:
    # Expected: booking-<int>
    if not room_id.startswith("booking-"):
        return None
    tail = room_id.split("booking-", 1)[1]
    try:
        return int(tail)
    except Exception:
        return None


def _require_room_access(room_id: str, user: User, session: Session) -> Booking:
    bid = _room_booking_id(room_id)
    if bid is None:
        raise HTTPException(404, "room not found")

    booking = session.get(Booking, bid)
    if not booking:
        raise HTTPException(404, "booking not found")

    if user.role == "admin":
        return booking

    if user.id not in {booking.student_user_id, booking.tutor_user_id}:
        raise HTTPException(403, "no access to this room")

    return booking


def _slot_for_booking(booking: Booking, session: Session) -> Optional[Slot]:
    try:
        return session.get(Slot, booking.slot_id)
    except Exception:
        return None


def _as_utc(dt: Optional[datetime]) -> Optional[datetime]:
    if not dt:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _smtp_cfg() -> Dict[str, Any]:
    return {
        "host": os.getenv("DL_SMTP_HOST"),
        "port": int(os.getenv("DL_SMTP_PORT") or "587"),
        "user": os.getenv("DL_SMTP_USER"),
        "password": os.getenv("DL_SMTP_PASS"),
        "from": os.getenv("DL_SMTP_FROM") or os.getenv("DL_SMTP_USER"),
    }


def _send_email(to_email: str, subject: str, text_body: str) -> None:
    cfg = _smtp_cfg()
    if not (cfg.get("host") and cfg.get("from") and to_email):
        # MVP: if SMTP not configured, just log.
        print(f"[notify/email] to={to_email} subject={subject} body={text_body[:180]}")
        return

    msg = (
        "From: {from_addr}\r\n"
        "To: {to_addr}\r\n"
        "Subject: {subject}\r\n"
        "Content-Type: text/plain; charset=utf-8\r\n"
        "\r\n"
        "{body}\r\n"
    ).format(from_addr=cfg["from"], to_addr=to_email, subject=subject, body=text_body)

    context = ssl.create_default_context()
    with smtplib.SMTP(cfg["host"], cfg["port"]) as server:
        server.ehlo()
        try:
            server.starttls(context=context)
        except Exception:
            pass
        if cfg.get("user") and cfg.get("password"):
            server.login(cfg["user"], cfg["password"])
        server.sendmail(cfg["from"], [to_email], msg.encode("utf-8"))



_TELEGRAM_BOT_USERNAME_CACHE: Dict[str, Any] = {"token": "", "username": "", "checked_at": 0.0}


def _telegram_bot_username() -> str:
    configured = str(os.getenv("DL_TELEGRAM_BOT_USERNAME") or "").strip().lstrip("@")
    if configured:
        _TELEGRAM_BOT_USERNAME_CACHE.update({"token": "", "username": configured, "checked_at": time.time()})
        return configured

    token = str(os.getenv("DL_TELEGRAM_BOT_TOKEN") or "").strip()
    if not token:
        return ""

    now = time.time()
    cached_token = str(_TELEGRAM_BOT_USERNAME_CACHE.get("token") or "")
    cached_name = str(_TELEGRAM_BOT_USERNAME_CACHE.get("username") or "")
    checked_at = float(_TELEGRAM_BOT_USERNAME_CACHE.get("checked_at") or 0.0)
    if cached_token == token and cached_name and (now - checked_at) < 3600:
        return cached_name

    try:
        req = urllib.request.Request(f"https://api.telegram.org/bot{token}/getMe")
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8") or "{}")
        username = str((((data or {}).get("result") or {}).get("username")) or "").strip().lstrip("@")
        if username:
            _TELEGRAM_BOT_USERNAME_CACHE.update({"token": token, "username": username, "checked_at": now})
            return username
    except Exception as e:
        print(f"[telegram/getMe/error] {e}")

    if cached_token == token and cached_name:
        return cached_name
    return ""


def _public_app_url() -> str:
    return str(os.getenv("DL_PUBLIC_APP_URL") or "").strip().rstrip("/")


def _telegram_deep_link(token: str) -> str:
    bot_username = _telegram_bot_username()
    if not bot_username or not token:
        return ""
    return f"https://t.me/{bot_username}?start={urllib.parse.quote(token)}"


def _telegram_api_call(method: str, payload: Dict[str, Any]) -> None:
    token = str(os.getenv("DL_TELEGRAM_BOT_TOKEN") or "").strip()
    if not token:
        return
    url = f"https://api.telegram.org/bot{token}/{method}"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            resp.read()
    except Exception as e:
        print(f"[telegram/{method}/error] {e}")


def _send_telegram(chat_id: str, text_body: str, reply_markup: Optional[Dict[str, Any]] = None) -> None:
    if not chat_id:
        print(f"[notify/telegram] chat_id={chat_id} body={text_body[:180]}")
        return
    payload: Dict[str, Any] = {
        "chat_id": chat_id,
        "text": text_body,
        "disable_web_page_preview": True,
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
    _telegram_api_call("sendMessage", payload)


def _telegram_answer_callback(callback_query_id: str, text: str = '', show_alert: bool = False) -> None:
    if not callback_query_id:
        return
    payload: Dict[str, Any] = {
        "callback_query_id": callback_query_id,
    }
    if text:
        payload["text"] = text[:180]
    if show_alert:
        payload["show_alert"] = True
    _telegram_api_call("answerCallbackQuery", payload)


def _notify_user_direct(u: Optional[User], subject: str, text_body: str) -> None:
    if not u:
        return
    if getattr(u, "notify_email", True):
        _send_email(u.email, subject, text_body)
    if getattr(u, "notify_telegram", False) and getattr(u, "telegram_chat_id", None):
        _send_telegram(u.telegram_chat_id, text_body)


def _notify_booking_event(
    kind: str,
    booking: Booking,
    session: Session,
    extra: Optional[str] = None,
) -> None:
    """Send best-effort notifications to both participants (email/telegram)."""
    tutor = session.get(User, booking.tutor_user_id)
    student = session.get(User, booking.student_user_id)
    slot = _slot_for_booking(booking, session)

    when = ""
    if slot:
        s = _as_utc(slot.starts_at)
        when = f"\nВремя: {s.isoformat() if s else slot.starts_at}"

    subj = {
        "booked": "DL: новое занятие",
        "cancelled": "DL: занятие отменено",
        "completed": "DL: занятие завершено",
        "rescheduled": "DL: занятие перенесено",
        "reminder": "DL: напоминание о занятии",
        "attendance_confirmed": "DL: подтверждение занятия",
        "attendance_declined": "DL: риск по занятию",
    }.get(kind, "DL: уведомление")

    base = f"Событие: {kind}\nКомната: booking-{booking.id}{when}"
    if extra:
        base += f"\n{extra}"

    for u in [tutor, student]:
        _notify_user_direct(u, subj, base)


# -----------------
# Auth
# -----------------

from fastapi import Cookie


class RegisterIn(BaseModel):
    email: str
    password: str
    role: str = "student"  # student|tutor


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    me: Dict[str, Any]


def _password_ok(pw: str) -> bool:
    pw = pw or ""
    if len(pw) < 8:
        return False
    has_letter = any(c.isalpha() for c in pw)
    has_digit = any(c.isdigit() for c in pw)
    return has_letter and has_digit


def _cookie_secure() -> bool:
    v = (os.getenv("DL_COOKIE_SECURE") or "").strip().lower()
    return v in {"1", "true", "yes"}


def _set_refresh_cookie(resp: Response, refresh_token: str) -> None:
    resp.set_cookie(
        key="dl_refresh",
        value=refresh_token,
        httponly=True,
        samesite="lax",
        secure=_cookie_secure(),
        path="/api/auth",
        max_age=60 * 60 * 24 * int(os.getenv("DL_REFRESH_EXPIRE_DAYS", "30")),
    )


def _clear_refresh_cookie(resp: Response) -> None:
    resp.delete_cookie(key="dl_refresh", path="/api/auth")


def _me_payload(user: User) -> Dict[str, Any]:
    return {
        "id": user.id,
        "email": user.email,
        "role": user.role,
        "is_active": getattr(user, "is_active", True),
        "telegram_chat_id": getattr(user, "telegram_chat_id", None),
        "telegram_username": getattr(user, "telegram_username", None),
        "telegram_first_name": getattr(user, "telegram_first_name", None),
        "telegram_linked_at": getattr(user, "telegram_linked_at", None),
        "notify_email": getattr(user, "notify_email", True),
        "notify_telegram": getattr(user, "notify_telegram", False),
    }


def _issue_tokens(user: User, session: Session, resp: Response) -> TokenOut:
    # Update last_login_at best-effort
    try:
        user.last_login_at = datetime.utcnow()
        session.add(user)
        session.commit()
        session.refresh(user)
    except Exception:
        pass

    access = create_access_token(user)
    refresh = create_refresh_token(user)
    _set_refresh_cookie(resp, refresh)

    return TokenOut(
        access_token=access,
        expires_in=int(os.getenv("DL_ACCESS_EXPIRE_MIN", "15")) * 60,
        me=_me_payload(user),
    )


@app.post("/api/auth/register", response_model=TokenOut)
def register(payload: RegisterIn, response: Response, session: Session = Depends(get_session)):
    email = (payload.email or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(400, "invalid email")
    if payload.role not in {"student", "tutor"}:
        raise HTTPException(400, "role must be student or tutor")
    if not _password_ok(payload.password):
        raise HTTPException(400, "password must be 8+ chars and contain letters + digits")

    existing = session.exec(select(User).where(User.email == email)).first()
    if existing:
        raise HTTPException(400, "email already registered")

    user = User(email=email, password_hash=hash_password(payload.password), role=payload.role)
    session.add(user)
    session.commit()
    session.refresh(user)

    if user.role == "tutor":
        profile = TutorProfile(user_id=user.id, display_name=email.split("@")[0])
        session.add(profile)
        session.commit()

    return _issue_tokens(user, session, response)


@app.post("/api/auth/login", response_model=TokenOut)
def login(
    response: Response,
    form: OAuth2PasswordRequestForm = Depends(),
    session: Session = Depends(get_session),
):
    email = (form.username or "").strip().lower()
    user = session.exec(select(User).where(User.email == email)).first()
    if not user or not verify_password(form.password, user.password_hash):
        raise HTTPException(401, "invalid credentials")
    if not getattr(user, "is_active", True):
        raise HTTPException(403, "account disabled")

    return _issue_tokens(user, session, response)


@app.post("/api/auth/refresh", response_model=TokenOut)
def refresh(
    response: Response,
    session: Session = Depends(get_session),
    dl_refresh: Optional[str] = Cookie(default=None, alias="dl_refresh"),
):
    if not dl_refresh:
        raise HTTPException(401, "missing refresh token")
    _, user = decode_and_get_user(dl_refresh, session, expected_typ="refresh")
    if not getattr(user, "is_active", True):
        raise HTTPException(403, "account disabled")

    # Rotate refresh token by re-issuing.
    return _issue_tokens(user, session, response)


@app.post("/api/auth/logout")
def logout(
    response: Response,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    # Invalidate all tokens by bumping token_version.
    user.token_version = int(getattr(user, "token_version", 0)) + 1
    session.add(user)
    session.commit()
    _clear_refresh_cookie(response)
    return {"ok": True}


class ChangePasswordIn(BaseModel):
    old_password: str
    new_password: str


@app.post("/api/auth/change-password")
def change_password(
    payload: ChangePasswordIn,
    response: Response,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if not verify_password(payload.old_password, user.password_hash):
        raise HTTPException(400, "wrong password")
    if not _password_ok(payload.new_password):
        raise HTTPException(400, "password must be 8+ chars and contain letters + digits")

    user.password_hash = hash_password(payload.new_password)
    user.token_version = int(getattr(user, "token_version", 0)) + 1
    session.add(user)
    session.commit()
    _clear_refresh_cookie(response)
    return {"ok": True}


@app.get("/api/me")
def me(user: User = Depends(get_current_user)):
    return _me_payload(user)


class MeSettingsIn(BaseModel):
    telegram_chat_id: Optional[str] = None
    notify_email: Optional[bool] = None
    notify_telegram: Optional[bool] = None


@app.get("/api/me/settings")
def me_settings(user: User = Depends(get_current_user)):
    return {
        "telegram_chat_id": getattr(user, "telegram_chat_id", None),
        "telegram_username": getattr(user, "telegram_username", None),
        "telegram_first_name": getattr(user, "telegram_first_name", None),
        "telegram_linked_at": getattr(user, "telegram_linked_at", None),
        "notify_email": getattr(user, "notify_email", True),
        "notify_telegram": getattr(user, "notify_telegram", False),
    }



# -----------------
# Trial balance (no real payments)
# -----------------


class TopUpIn(BaseModel):
    amount: int = Field(ge=10, le=500000)  # RUB (trial)


class BalanceOut(BaseModel):
    balance: int
    earnings: int
    tx: List[Dict[str, Any]]


@app.get("/api/balance", response_model=BalanceOut)
def get_balance(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    txs = session.exec(select(BalanceTx).where(BalanceTx.user_id == user.id).order_by(BalanceTx.created_at.desc()).limit(25)).all()
    return BalanceOut(
        balance=getattr(user, "balance", 0) or 0,
        earnings=getattr(user, "earnings", 0) or 0,
        tx=[{"id": t.id, "amount": t.amount, "kind": t.kind, "booking_id": t.booking_id, "note": t.note, "created_at": t.created_at} for t in txs],
    )


@app.post("/api/balance/topup", response_model=BalanceOut)
def topup_balance(payload: TopUpIn, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    # Trial top-up: just adds internal balance.
    user.balance = int(getattr(user, "balance", 0) or 0) + int(payload.amount)
    session.add(user)
    session.add(BalanceTx(user_id=user.id, amount=int(payload.amount), kind="topup", note="trial topup"))
    session.commit()
    session.refresh(user)
    return get_balance(user=user, session=session)


class PayOut(BaseModel):
    ok: bool = True
    booking: Dict[str, Any]
    balance: int
    earnings: int


@app.post("/api/bookings/{booking_id}/pay", response_model=PayOut)
def pay_booking_with_balance(
    booking_id: int,
    user: User = Depends(require_role("student", "admin")),
    session: Session = Depends(get_session),
):
    b = session.get(Booking, booking_id)
    if not b:
        raise HTTPException(404, "booking not found")
    _ensure_participant(b, user)
    if user.role != "admin" and b.student_user_id != user.id:
        raise HTTPException(403, "only student can pay")
    if b.status != "confirmed":
        raise HTTPException(400, "booking not active")
    if getattr(b, "payment_status", "unpaid") == "paid":
        raise HTTPException(400, "already paid")

    price = int(getattr(b, "price", 0) or 0)
    if price <= 0:
        # allow free booking
        b.payment_status = "paid"
        b.paid_at = datetime.utcnow()
        session.add(b)
        session.commit()
        session.refresh(b)
        return PayOut(booking=_booking_to_out(b, session), balance=getattr(user, "balance", 0) or 0, earnings=getattr(user, "earnings", 0) or 0)

    bal = int(getattr(user, "balance", 0) or 0)
    if bal < price and user.role != "admin":
        raise HTTPException(400, "insufficient balance")

    # Deduct student balance
    if user.role != "admin":
        user.balance = bal - price
        session.add(user)
        session.add(BalanceTx(user_id=user.id, amount=-price, kind="pay", booking_id=b.id, note="lesson payment (trial)"))

    # Credit tutor earnings (trial)
    tutor = session.get(User, b.tutor_user_id)
    if tutor:
        tutor.earnings = int(getattr(tutor, "earnings", 0) or 0) + price
        session.add(tutor)
        session.add(BalanceTx(user_id=tutor.id, amount=price, kind="earn", booking_id=b.id, note="lesson earnings (trial)"))

    b.payment_status = "paid"
    b.paid_at = datetime.utcnow()
    session.add(b)
    session.commit()
    session.refresh(b)

    session.refresh(user)
    return PayOut(ok=True, booking=_booking_to_out(b, session), balance=getattr(user, "balance", 0) or 0, earnings=getattr(user, "earnings", 0) or 0)


class BalanceAdjustIn(BaseModel):
    target: str = Field(default="balance")  # balance | earnings
    amount: int
    note: str = ""


@app.post("/api/admin/users/{user_id}/balance-adjust", response_model=BalanceOut)
def admin_balance_adjust(
    user_id: int,
    payload: BalanceAdjustIn,
    admin: User = Depends(require_role("admin")),
    session: Session = Depends(get_session),
):
    u = session.get(User, user_id)
    if not u:
        raise HTTPException(404, "user not found")
    target = (payload.target or "balance").strip().lower()
    amt = int(payload.amount)
    if target not in {"balance", "earnings"}:
        raise HTTPException(400, "invalid target")
    if target == "balance":
        u.balance = int(getattr(u, "balance", 0) or 0) + amt
    else:
        u.earnings = int(getattr(u, "earnings", 0) or 0) + amt
    session.add(u)
    session.add(BalanceTx(user_id=u.id, amount=amt, kind="adjust", note=(payload.note or "")[:200]))
    session.commit()
    session.refresh(u)
    return get_balance(user=u, session=session)



@app.put("/api/me/settings")
def update_me_settings(
    payload: MeSettingsIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    data = payload.model_dump(exclude_unset=True)
    if "telegram_chat_id" in data:
        chat = (data["telegram_chat_id"] or "").strip()
        user.telegram_chat_id = chat or None
    if "notify_email" in data:
        user.notify_email = bool(data["notify_email"])
    if "notify_telegram" in data:
        user.notify_telegram = bool(data["notify_telegram"])

    session.add(user)
    session.commit()
    session.refresh(user)
    return {
        "ok": True,
        "telegram_chat_id": getattr(user, "telegram_chat_id", None),
        "telegram_username": getattr(user, "telegram_username", None),
        "telegram_first_name": getattr(user, "telegram_first_name", None),
        "telegram_linked_at": getattr(user, "telegram_linked_at", None),
        "notify_email": getattr(user, "notify_email", True),
        "notify_telegram": getattr(user, "notify_telegram", False),
    }



class TelegramLinkOut(BaseModel):
    connected: bool = False
    role: str
    bot_username: str = ""
    deep_link_url: str = ""
    token: str = ""
    short_code: str = ""
    start_command: str = ""
    short_start_command: str = ""
    expires_at: Optional[datetime] = None
    linked_chat_id: Optional[str] = None
    linked_username: Optional[str] = None
    linked_at: Optional[datetime] = None


def _telegram_role_key(role_or_user: Any) -> str:
    if isinstance(role_or_user, User):
        role = str(getattr(role_or_user, 'role', 'student') or 'student').strip().lower()
    else:
        role = str(role_or_user or 'student').strip().lower()
    if role not in {'student', 'tutor', 'admin'}:
        return 'student'
    return role


def _telegram_role_label(role_or_user: Any) -> str:
    role = _telegram_role_key(role_or_user)
    if role == 'tutor':
        return 'репетитор'
    if role == 'admin':
        return 'админ'
    return 'ученик'


def _telegram_status_label(v: str) -> str:
    s = str(v or 'pending').strip().lower()
    if s == 'confirmed':
        return 'подтверждено'
    if s == 'declined':
        return 'не подтверждено'
    return 'ожидает подтверждения'


def _user_label_for_telegram(u: Optional[User], session: Session) -> str:
    if not u:
        return 'Пользователь'
    if _telegram_role_key(u) == 'tutor':
        prof = session.exec(select(TutorProfile).where(TutorProfile.user_id == u.id)).first()
        if prof and str(getattr(prof, 'display_name', '') or '').strip():
            return str(prof.display_name).strip()
    first = str(getattr(u, 'telegram_first_name', '') or '').strip()
    if first:
        return first
    email = str(getattr(u, 'email', '') or '').strip()
    if email and '@' in email:
        base = email.split('@', 1)[0].replace('.', ' ').replace('_', ' ').strip()
        if base:
            return base
    return f'Пользователь #{getattr(u, "id", "")}'


def _room_url_for_booking(booking_id: int) -> str:
    app_url = _public_app_url()
    if not app_url:
        return ''
    return f"{app_url}/room/booking-{int(booking_id)}"


def _dashboard_url(user: Optional[User] = None) -> str:
    app_url = _public_app_url()
    if not app_url:
        return ''
    role = _telegram_role_key(user) if user is not None else 'student'
    path = '/admin' if role == 'admin' else '/dashboard'
    return f"{app_url}{path}"


def _telegram_link_token_ttl_minutes() -> int:
    return max(5, int(os.getenv('DL_TELEGRAM_LINK_TTL_MIN', '30') or '30'))


def _deactivate_telegram_tokens_for_user(session: Session, user_id: int) -> None:
    rows = session.exec(
        select(TelegramLinkToken).where(TelegramLinkToken.user_id == int(user_id)).where(TelegramLinkToken.is_active == True)
    ).all()
    for row in rows:
        row.is_active = False
        session.add(row)


def _get_or_create_telegram_link_token(session: Session, user: User, force_new: bool = False) -> TelegramLinkToken:
    now = datetime.utcnow()
    if force_new:
        _deactivate_telegram_tokens_for_user(session, user.id)
        session.commit()
    else:
        existing = session.exec(
            select(TelegramLinkToken)
            .where(TelegramLinkToken.user_id == int(user.id))
            .where(TelegramLinkToken.is_active == True)
            .where(TelegramLinkToken.used_at == None)
            .order_by(TelegramLinkToken.created_at.desc())
        ).first()
        if existing and existing.expires_at > now:
            return existing

    token_value = f"dl_{user.id}_{secrets.token_urlsafe(18)}"
    row = TelegramLinkToken(
        user_id=int(user.id),
        token=token_value,
        role_snapshot=str(getattr(user, 'role', 'student') or 'student'),
        expires_at=now + timedelta(minutes=_telegram_link_token_ttl_minutes()),
        is_active=True,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


def _telegram_link_payload(session: Session, user: User, force_new: bool = False) -> TelegramLinkOut:
    row = _get_or_create_telegram_link_token(session, user, force_new=force_new)
    short_code = _telegram_short_code_for_token(session, row.token)
    return TelegramLinkOut(
        connected=bool(getattr(user, 'telegram_chat_id', None)),
        role=str(getattr(user, 'role', 'student') or 'student'),
        bot_username=_telegram_bot_username(),
        deep_link_url=_telegram_deep_link(row.token),
        token=row.token,
        short_code=short_code,
        start_command=f'/start {row.token}',
        short_start_command=f'/start {short_code}' if short_code else '',
        expires_at=row.expires_at,
        linked_chat_id=getattr(user, 'telegram_chat_id', None),
        linked_username=getattr(user, 'telegram_username', None),
        linked_at=getattr(user, 'telegram_linked_at', None),
    )


def _telegram_upcoming_bookings_for_user(
    user: User,
    session: Session,
    *,
    window_start: Optional[datetime] = None,
    window_end: Optional[datetime] = None,
    upcoming_only: bool = False,
    limit: int = 5,
) -> List[Tuple[Booking, Slot, datetime]]:
    stmt = select(Booking).where(Booking.status == 'confirmed')
    role = _telegram_role_key(user)
    if role == 'tutor':
        stmt = stmt.where(Booking.tutor_user_id == int(user.id or 0))
    elif role == 'student':
        stmt = stmt.where(Booking.student_user_id == int(user.id or 0))
    rows = session.exec(stmt).all()
    items: List[Tuple[Booking, Slot, datetime]] = []
    now = _utcnow()
    for b in rows:
        slot = _slot_for_booking(b, session)
        if not slot:
            continue
        start_at = _as_utc(getattr(slot, 'starts_at', None))
        if not start_at:
            continue
        if upcoming_only and start_at < now:
            continue
        if window_start and start_at < window_start:
            continue
        if window_end and start_at > window_end:
            continue
        items.append((b, slot, start_at))
    items.sort(key=lambda x: x[2])
    return items[:max(1, int(limit))]


def _telegram_participants_label(booking: Booking, session: Session) -> Tuple[str, str]:
    tutor = session.get(User, booking.tutor_user_id)
    student = session.get(User, booking.student_user_id)
    return _user_label_for_telegram(tutor, session), _user_label_for_telegram(student, session)


def _telegram_counterpart_label(viewer: User, booking: Booking, session: Session) -> str:
    role = _telegram_role_key(viewer)
    if role == 'tutor':
        other = session.get(User, booking.student_user_id)
        return _user_label_for_telegram(other, session)
    other = session.get(User, booking.tutor_user_id)
    return _user_label_for_telegram(other, session)


def _telegram_booking_summary_line(viewer: User, booking: Booking, slot: Slot, session: Session) -> str:
    start_at = _as_utc(getattr(slot, 'starts_at', None)) or getattr(slot, 'starts_at', None)
    end_at = _as_utc(getattr(slot, 'ends_at', None)) or getattr(slot, 'ends_at', None)
    when = start_at.strftime('%d.%m %H:%M') if isinstance(start_at, datetime) else str(getattr(slot, 'starts_at', ''))
    if isinstance(end_at, datetime):
        when += f"–{end_at.strftime('%H:%M')}"
    role = _telegram_role_key(viewer)
    if role == 'admin':
        tutor_name, student_name = _telegram_participants_label(booking, session)
        tutor_status = _telegram_status_label(getattr(booking, 'tutor_attendance_status', 'pending'))
        student_status = _telegram_status_label(getattr(booking, 'student_attendance_status', 'pending'))
        return f"• #{booking.id} · {when} · репетитор: {tutor_name} · ученик: {student_name} · статусы: уч={student_status}, реп={tutor_status}"
    counterpart = _telegram_counterpart_label(viewer, booking, session)
    if role == 'tutor':
        my_status = _telegram_status_label(getattr(booking, 'tutor_attendance_status', 'pending'))
        other_status = _telegram_status_label(getattr(booking, 'student_attendance_status', 'pending'))
        counterpart_label = 'ученик'
    else:
        my_status = _telegram_status_label(getattr(booking, 'student_attendance_status', 'pending'))
        other_status = _telegram_status_label(getattr(booking, 'tutor_attendance_status', 'pending'))
        counterpart_label = 'репетитор'
    return f"• #{booking.id} · {when} · {counterpart_label}: {counterpart} · вы: {my_status} / вторая сторона: {other_status}"


def _telegram_callback_data(action: str, booking_id: int) -> str:
    return f"booking:{action}:{int(booking_id)}"


def _telegram_booking_card_text(viewer: User, booking: Booking, slot: Slot, session: Session) -> str:
    start_at = _as_utc(getattr(slot, 'starts_at', None)) or getattr(slot, 'starts_at', None)
    end_at = _as_utc(getattr(slot, 'ends_at', None)) or getattr(slot, 'ends_at', None)
    if isinstance(start_at, datetime):
        when = start_at.strftime('%d.%m.%Y %H:%M')
    else:
        when = str(getattr(slot, 'starts_at', ''))
    duration = ''
    if isinstance(start_at, datetime) and isinstance(end_at, datetime):
        mins = max(1, int((end_at - start_at).total_seconds() // 60))
        duration = f"{mins} мин"
    room_url = _room_url_for_booking(booking.id)
    role = _telegram_role_key(viewer)
    lines: List[str] = []
    if role == 'admin':
        tutor_name, student_name = _telegram_participants_label(booking, session)
        tutor_status = _telegram_status_label(getattr(booking, 'tutor_attendance_status', 'pending'))
        student_status = _telegram_status_label(getattr(booking, 'student_attendance_status', 'pending'))
        lines = [
            f"📘 Урок #{booking.id}",
            f"🗓 Когда: {when}",
            f"⏱ Длительность: {duration}" if duration else '',
            f"👩‍🏫 Репетитор: {tutor_name}",
            f"🎓 Ученик: {student_name}",
            f"📍 Статусы: ученик — {student_status}, репетитор — {tutor_status}",
        ]
    else:
        counterpart = _telegram_counterpart_label(viewer, booking, session)
        if role == 'tutor':
            my_status = _telegram_status_label(getattr(booking, 'tutor_attendance_status', 'pending'))
            other_status = _telegram_status_label(getattr(booking, 'student_attendance_status', 'pending'))
            counterpart_label = '🎓 Ученик'
        else:
            my_status = _telegram_status_label(getattr(booking, 'student_attendance_status', 'pending'))
            other_status = _telegram_status_label(getattr(booking, 'tutor_attendance_status', 'pending'))
            counterpart_label = '👩‍🏫 Репетитор'
        lines = [
            f"📘 Урок #{booking.id}",
            f"🗓 Когда: {when}",
            f"⏱ Длительность: {duration}" if duration else '',
            f"{counterpart_label}: {counterpart}",
            f"✅ Ваш статус: {my_status}",
            f"👥 Вторая сторона: {other_status}",
        ]
    if room_url:
        lines.append(f"🔗 Комната урока: {room_url}")
    return "\n".join([line for line in lines if line])


def _telegram_main_keyboard_for_booking(booking_id: int, viewer: Optional[User] = None) -> Optional[Dict[str, Any]]:
    buttons: List[List[Dict[str, str]]] = []
    role = _telegram_role_key(viewer) if viewer else 'student'
    if role in {'student', 'tutor'}:
        buttons.append([
            {'text': '✅ Подтверждаю', 'callback_data': _telegram_callback_data('confirm', booking_id)},
            {'text': '❌ Не смогу', 'callback_data': _telegram_callback_data('decline', booking_id)},
        ])
    room_url = _room_url_for_booking(booking_id)
    if room_url:
        buttons.append([{'text': '🔗 Открыть занятие', 'url': room_url}])
    dash = _dashboard_url(viewer)
    if dash:
        buttons.append([{'text': '🏠 Открыть кабинет', 'url': dash}])
    if not buttons:
        return None
    return {'inline_keyboard': buttons}


def _telegram_menu_keyboard(role_or_user: Any) -> Dict[str, Any]:
    role = _telegram_role_key(role_or_user)
    keyboard: List[List[Dict[str, str]]] = [
        [{'text': '📅 Сегодня'}, {'text': '⏭ Ближайшее'}],
        [{'text': '🗓 Расписание'}, {'text': '🧾 Кто я'}],
        [{'text': '🏠 Кабинет'}, {'text': '👋 Помощь'}],
    ]
    if role in {'student', 'tutor'}:
        keyboard.insert(2, [{'text': '✅ Подтвердить'}, {'text': '⚠️ Не смогу'}])
    if role == 'admin':
        keyboard.insert(2, [{'text': '📊 Статистика'}])
    return {
        'keyboard': keyboard,
        'resize_keyboard': True,
        'is_persistent': True,
        'input_field_placeholder': 'Например: /next или выберите кнопку ниже',
    }


def _telegram_support_text(user: User) -> str:
    role = _telegram_role_label(user)
    lines = [
        '🆘 Помощь по DoskoLink',
        f'Подключённый аккаунт: {getattr(user, "email", "—")}',
        f'Роль: {role}',
        '',
        'Что можно сделать прямо сейчас:',
        '• нажать «🏠 Кабинет» и открыть сайт',
        '• отправить /whoami, чтобы проверить текущую привязку',
        '• отправить /unlink и подключить Telegram заново при необходимости',
    ]
    if _public_app_url():
        lines.append('')
        lines.append(f'Сайт DoskoLink: {_dashboard_url(user) or _public_app_url()}')
    return '\n'.join(lines)


def _telegram_pick_booking_for_action(user: User, session: Session, arg: str = '') -> Tuple[Optional[Booking], Optional[Slot], str]:
    role = _telegram_role_key(user)
    if role == 'admin':
        return None, None, 'Для админа подтверждение участия не требуется. Используйте /stats, /today, /next и /schedule.'
    raw = str(arg or '').strip()
    booking_id: Optional[int] = None
    if raw:
        m = re.search(r'(\d+)', raw)
        if m:
            booking_id = int(m.group(1))
    if booking_id:
        booking = session.get(Booking, booking_id)
        if not booking:
            return None, None, f'Урок #{booking_id} не найден.'
        if role == 'student' and booking.student_user_id != user.id:
            return None, None, 'Этот урок не относится к вашему аккаунту.'
        if role == 'tutor' and booking.tutor_user_id != user.id:
            return None, None, 'Этот урок не относится к вашему аккаунту.'
        return booking, _slot_for_booking(booking, session), ''
    items = _telegram_upcoming_bookings_for_user(user, session, upcoming_only=True, limit=1)
    if not items:
        return None, None, 'Ближайших занятий для изменения статуса пока нет.'
    booking, slot, _ = items[0]
    return booking, slot, ''


def _telegram_apply_attendance_status(chat_id: str, user: User, session: Session, status: str, arg: str = '') -> None:
    booking, slot, problem = _telegram_pick_booking_for_action(user, session, arg)
    if problem:
        _send_telegram(chat_id, problem, reply_markup=_telegram_menu_keyboard(user))
        return
    if not booking:
        _send_telegram(chat_id, 'Не удалось определить урок для изменения статуса.', reply_markup=_telegram_menu_keyboard(user))
        return

    now = datetime.utcnow()
    if _telegram_role_key(user) == 'tutor':
        booking.tutor_attendance_status = status
        booking.tutor_attendance_updated_at = now
        who_ru = 'Репетитор'
    else:
        booking.student_attendance_status = status
        booking.student_attendance_updated_at = now
        who_ru = 'Ученик'

    session.add(booking)
    session.commit()
    session.refresh(booking)

    kind = 'attendance_confirmed' if status == 'confirmed' else 'attendance_declined'
    _notify_booking_event(kind, booking, session, extra=f'{who_ru} поставил статус: {status}')

    status_label = '✅ участие подтверждено' if status == 'confirmed' else '⚠️ отмечено, что вы не сможете прийти'
    when = slot.starts_at.strftime('%d.%m %H:%M') if slot and getattr(slot, 'starts_at', None) else '—'
    summary = _telegram_booking_card_text(user, booking, slot, session)
    _send_telegram(
        chat_id,
        f'{status_label}\nУрок #{booking.id}\nВремя: {when}\n\n{summary}',
        reply_markup=_telegram_main_keyboard_for_booking(booking.id, user),
    )


def _telegram_help_text(role: str) -> str:
    role = _telegram_role_key(role)
    lines = [
        '✨ Команды DoskoLink Assistant',
        '/menu — показать клавиатуру с быстрыми действиями',
        '/whoami — проверить, какой аккаунт и какая роль подключены',
        '/today — занятия на сегодня',
        '/tomorrow — занятия на завтра',
        '/next — ближайшее занятие',
        '/schedule — ближайшие 5 занятий',
        '/link — открыть кабинет DoskoLink',
        '/support — подсказка и быстрый путь назад в кабинет',
        '/unlink — отвязать Telegram от аккаунта',
    ]
    if role == 'admin':
        lines.extend([
            '/stats — сводка платформы для админа',
            '🎛 Роль: админ. Бот показывает сводку платформы, ближайшие уроки и Telegram-подключения.',
        ])
    else:
        lines.extend([
            '/confirm — подтвердить участие в ближайшем уроке',
            '/decline — отметить, что вы не сможете прийти',
            '🤖 Используйте и нижнюю клавиатуру, и inline-кнопки под карточками уроков: подтверждение и вход в урок теперь доступны в один тап.',
        ])
        if role == 'tutor':
            lines.append('🎓 Роль: репетитор. Бот показывает ваших учеников, ближайшие уроки и статусы подтверждения.')
        else:
            lines.append('📚 Роль: ученик. Бот показывает ваши занятия, репетиторов и статусы подтверждения.')
    return '\n'.join(lines)


def _telegram_whoami_text(user: User, session: Session) -> str:
    role = _telegram_role_key(user)
    role_label = _telegram_role_label(role)
    base = [
        'Подключение DoskoLink активно.',
        f'Аккаунт: {getattr(user, "email", "—")}',
        f'Роль: {role_label}',
        f'Telegram: @{getattr(user, "telegram_username", "")}' if getattr(user, 'telegram_username', None) else f'Chat ID: {getattr(user, "telegram_chat_id", "—")}',
    ]
    if getattr(user, 'telegram_linked_at', None):
        base.append(f'Связано: {user.telegram_linked_at.strftime("%d.%m.%Y %H:%M UTC")}')
    if role == 'admin':
        users = session.exec(select(User)).all()
        linked = len([u for u in users if getattr(u, 'telegram_chat_id', None)])
        base.append(f'Подключений Telegram на платформе: {linked}')
    return '\n'.join(base)


def _telegram_send_admin_stats(chat_id: str, session: Session) -> None:
    users = session.exec(select(User)).all()
    total = len(users)
    tutors = len([u for u in users if _telegram_role_key(u) == 'tutor'])
    students = len([u for u in users if _telegram_role_key(u) == 'student'])
    admins = len([u for u in users if _telegram_role_key(u) == 'admin'])
    linked = len([u for u in users if getattr(u, 'telegram_chat_id', None)])
    admin_viewer = User(id=0, email='admin@local', password_hash='', role='admin')
    now = _utcnow()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    today_end = today_start + timedelta(days=1) - timedelta(seconds=1)
    today_items = _telegram_upcoming_bookings_for_user(admin_viewer, session, window_start=today_start, window_end=today_end, upcoming_only=False, limit=500)
    upcoming_items = _telegram_upcoming_bookings_for_user(admin_viewer, session, upcoming_only=True, limit=500)
    pending_attendance = 0
    for booking, _, _ in upcoming_items:
        if str(getattr(booking, 'student_attendance_status', 'pending')) == 'pending' or str(getattr(booking, 'tutor_attendance_status', 'pending')) == 'pending':
            pending_attendance += 1
    lines = [
        'Сводка DoskoLink для админа:',
        f'Пользователи: {total} (ученики: {students}, репетиторы: {tutors}, админы: {admins})',
        f'Telegram подключён у: {linked}',
        f'Уроков на сегодня: {len(today_items)}',
        f'Ближайших активных уроков: {len(upcoming_items)}',
        f'Уроков с неподтверждённым участием: {pending_attendance}',
    ]
    if upcoming_items:
        booking, slot, _ = upcoming_items[0]
        lines.append('')
        lines.append(_telegram_booking_card_text(admin_viewer, booking, slot, session))
    dash = _dashboard_url(admin_viewer)
    _send_telegram(chat_id, '\n'.join(lines), reply_markup={'inline_keyboard': [[{'text': 'Открыть кабинет', 'url': dash}]]} if dash else None)


def _telegram_welcome_text(user: User) -> str:
    role = _telegram_role_label(user)
    greeting_name = str(getattr(user, 'telegram_first_name', '') or '').strip() or str(getattr(user, 'email', '') or 'друг')
    return (
        f'👋 Привет, {greeting_name}! Telegram подключён к DoskoLink.\n'
        f'Роль определена автоматически: {role}.\n\n'
        'Я могу показать расписание, ближайший урок, быстрые действия и статусы участия.\n'
        'Нажмите кнопки под полем ввода или отправьте /menu.\n\n'
        f'{_telegram_help_text(_telegram_role_key(user))}'
    )

def _telegram_short_code_for_token(session: Session, token_value: str) -> str:
    token_value = str(token_value or '').strip()
    if not token_value:
        return ''
    min_len = min(len(token_value), 10)
    max_len = len(token_value)
    if max_len <= min_len:
        return token_value
    for length in range(min_len, max_len + 1):
        prefix = token_value[:length]
        matches = session.exec(
            select(TelegramLinkToken)
            .where(TelegramLinkToken.token.startswith(prefix))
            .where(TelegramLinkToken.is_active == True)
            .where(TelegramLinkToken.used_at == None)
        ).all()
        if len(matches) == 1:
            return prefix
    return token_value


def _telegram_find_link_token(session: Session, token_value: str) -> Optional[TelegramLinkToken]:
    token_value = str(token_value or '').strip()
    if not token_value:
        return None
    row = session.exec(select(TelegramLinkToken).where(TelegramLinkToken.token == token_value)).first()
    if row:
        return row
    rows = session.exec(
        select(TelegramLinkToken)
        .where(TelegramLinkToken.token.startswith(token_value))
        .where(TelegramLinkToken.is_active == True)
        .where(TelegramLinkToken.used_at == None)
    ).all()
    return rows[0] if len(rows) == 1 else None


def _telegram_link_user_from_token(
    session: Session,
    token_value: str,
    chat_id: str,
    username: str = '',
    first_name: str = '',
) -> Tuple[bool, str, Optional[User]]:
    now = datetime.utcnow()
    row = _telegram_find_link_token(session, token_value)
    if not row or not bool(getattr(row, 'is_active', False)):
        return False, 'Ссылка для подключения не найдена или уже использована. Откройте кабинет DoskoLink и создайте новую ссылку.', None
    if row.used_at is not None:
        return False, 'Эта ссылка уже была использована. Создайте новую ссылку в кабинете DoskoLink.', None
    if row.expires_at <= now:
        row.is_active = False
        session.add(row)
        session.commit()
        return False, 'Срок действия ссылки истёк. Сгенерируйте новую ссылку в кабинете DoskoLink.', None
    user = session.get(User, row.user_id)
    if not user:
        return False, 'Аккаунт DoskoLink не найден.', None

    other = session.exec(select(User).where(User.telegram_chat_id == str(chat_id))).first()
    if other and other.id != user.id:
        other.telegram_chat_id = None
        other.telegram_username = None
        other.telegram_first_name = None
        other.telegram_linked_at = None
        other.notify_telegram = False
        session.add(other)

    _deactivate_telegram_tokens_for_user(session, user.id)
    user.telegram_chat_id = str(chat_id)
    user.telegram_username = str(username or '').strip() or None
    user.telegram_first_name = str(first_name or '').strip() or None
    user.telegram_linked_at = now
    user.notify_telegram = True
    session.add(user)

    row.used_at = now
    row.used_chat_id = str(chat_id)
    row.is_active = False
    session.add(row)

    session.commit()
    session.refresh(user)
    return True, _telegram_welcome_text(user), user


def _telegram_find_user_by_chat(session: Session, chat_id: str) -> Optional[User]:
    return session.exec(select(User).where(User.telegram_chat_id == str(chat_id))).first()


def _telegram_reply_not_linked(chat_id: str) -> None:
    txt = (
        '🔐 Этот Telegram ещё не подключён к DoskoLink.\n\n'
        'Откройте кабинет на сайте, нажмите «Подключить Telegram» и вернитесь в бот по deep link. '
        'Обычная команда /start без кода не подключает аккаунт.'
    )
    dash = _public_app_url()
    kb = {'inline_keyboard': [[{'text': 'Открыть DoskoLink', 'url': dash}]]} if dash else None
    _send_telegram(chat_id, txt, reply_markup=kb)

def _telegram_send_today_like(chat_id: str, user: User, session: Session, day_offset: int = 0) -> None:
    now = _utcnow() + timedelta(days=day_offset)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    day_end = day_start + timedelta(days=1) - timedelta(seconds=1)
    items = _telegram_upcoming_bookings_for_user(user, session, window_start=day_start, window_end=day_end, upcoming_only=False, limit=12)
    title = 'на сегодня' if day_offset == 0 else 'на завтра'
    if not items:
        _send_telegram(chat_id, f'📭 У вас нет занятий {title}.', reply_markup=_telegram_menu_keyboard(user))
        return
    lines = [f'📅 Ваши занятия {title}:']
    for booking, slot, _ in items:
        lines.append(_telegram_booking_summary_line(user, booking, slot, session))
    kb = _telegram_main_keyboard_for_booking(items[0][0].id, user) if items else None
    _send_telegram(chat_id, '\n'.join(lines), reply_markup=kb)


def _telegram_send_next(chat_id: str, user: User, session: Session) -> None:
    items = _telegram_upcoming_bookings_for_user(user, session, upcoming_only=True, limit=1)
    if not items:
        _send_telegram(chat_id, '📭 Ближайших занятий пока нет.', reply_markup=_telegram_menu_keyboard(user))
        return
    booking, slot, _ = items[0]
    _send_telegram(chat_id, _telegram_booking_card_text(user, booking, slot, session), reply_markup=_telegram_main_keyboard_for_booking(booking.id, user))


def _telegram_send_schedule(chat_id: str, user: User, session: Session) -> None:
    items = _telegram_upcoming_bookings_for_user(user, session, upcoming_only=True, limit=5)
    if not items:
        _send_telegram(chat_id, '📭 Ближайших занятий пока нет.', reply_markup=_telegram_menu_keyboard(user))
        return
    lines = ['🗓 Ближайшие занятия:']
    for booking, slot, _ in items:
        lines.append(_telegram_booking_summary_line(user, booking, slot, session))
    kb = _telegram_main_keyboard_for_booking(items[0][0].id, user) if items else None
    _send_telegram(chat_id, '\n'.join(lines), reply_markup=kb)


def _telegram_send_link(chat_id: str, user: User) -> None:
    dash = _dashboard_url(user)
    if not dash:
        _send_telegram(chat_id, 'Публичный адрес сайта DoskoLink ещё не настроен. Укажите DL_PUBLIC_APP_URL в Railway.', reply_markup=_telegram_menu_keyboard(user))
        return
    _send_telegram(chat_id, f'🏠 Личный кабинет DoskoLink: {dash}', reply_markup={'inline_keyboard': [[{'text': 'Открыть кабинет', 'url': dash}]]})


def _telegram_unlink(chat_id: str, user: User, session: Session) -> None:
    user.telegram_chat_id = None
    user.telegram_username = None
    user.telegram_first_name = None
    user.telegram_linked_at = None
    user.notify_telegram = False
    session.add(user)
    session.commit()
    _send_telegram(chat_id, 'Telegram отвязан от аккаунта DoskoLink. Подключить заново можно из личного кабинета.', reply_markup={'remove_keyboard': True})


@app.get('/api/me/telegram-link', response_model=TelegramLinkOut)
def me_telegram_link(
    refresh: bool = False,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return _telegram_link_payload(session, user, force_new=bool(refresh))


@app.post('/api/me/telegram-link', response_model=TelegramLinkOut)
def me_telegram_link_refresh(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return _telegram_link_payload(session, user, force_new=True)


@app.post('/api/me/telegram-unlink')
def me_telegram_unlink(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    user.telegram_chat_id = None
    user.telegram_username = None
    user.telegram_first_name = None
    user.telegram_linked_at = None
    user.notify_telegram = False
    session.add(user)
    session.commit()
    session.refresh(user)
    return {
        'ok': True,
        'telegram_chat_id': getattr(user, 'telegram_chat_id', None),
        'telegram_username': getattr(user, 'telegram_username', None),
        'telegram_first_name': getattr(user, 'telegram_first_name', None),
        'telegram_linked_at': getattr(user, 'telegram_linked_at', None),
        'notify_telegram': getattr(user, 'notify_telegram', False),
    }


@app.post('/api/integrations/telegram/webhook')
async def telegram_webhook(
    request: Request,
    session: Session = Depends(get_session),
):
    expected_secret = str(os.getenv('DL_TELEGRAM_WEBHOOK_SECRET') or '').strip()
    if expected_secret:
        got = str(request.headers.get('x-telegram-bot-api-secret-token') or '').strip()
        if got != expected_secret:
            raise HTTPException(403, 'bad telegram webhook secret')

    try:
        update = await request.json()
    except Exception:
        return {'ok': True}

    callback_query = (update or {}).get('callback_query') or {}
    if callback_query:
        callback_id = str(callback_query.get('id') or '').strip()
        data = str(callback_query.get('data') or '').strip()
        callback_message = callback_query.get('message') or {}
        callback_chat = callback_message.get('chat') or {}
        chat_id = str(callback_chat.get('id') or '').strip()
        chat_type = str(callback_chat.get('type') or '').strip()
        from_user = callback_query.get('from') or {}
        tg_username = str(from_user.get('username') or '').strip()
        tg_first_name = str(from_user.get('first_name') or '').strip()

        if chat_id and chat_type in {'private', ''}:
            user = _telegram_find_user_by_chat(session, chat_id)
            if user:
                if tg_username and tg_username != str(getattr(user, 'telegram_username', '') or ''):
                    user.telegram_username = tg_username
                    session.add(user)
                    session.commit()
                if tg_first_name and tg_first_name != str(getattr(user, 'telegram_first_name', '') or ''):
                    user.telegram_first_name = tg_first_name
                    session.add(user)
                    session.commit()

            if not user:
                _telegram_answer_callback(callback_id, 'Сначала подключите Telegram к DoskoLink.', show_alert=True)
                _telegram_reply_not_linked(chat_id)
                return {'ok': True}

            m_cb = re.match(r'^booking:(confirm|decline):(\d+)$', data)
            if m_cb:
                action = str(m_cb.group(1) or '').strip()
                booking_id = str(m_cb.group(2) or '').strip()
                _telegram_apply_attendance_status(chat_id, user, session, 'confirmed' if action == 'confirm' else 'declined', booking_id)
                _telegram_answer_callback(callback_id, 'Статус обновлён.')
                return {'ok': True}

            if data == 'menu:help':
                _send_telegram(chat_id, _telegram_help_text(_telegram_role_key(user)), reply_markup=_telegram_menu_keyboard(user))
                _telegram_answer_callback(callback_id, 'Открываю помощь')
                return {'ok': True}

            _telegram_answer_callback(callback_id, 'Действие пока не поддерживается.', show_alert=False)
            return {'ok': True}

        return {'ok': True}

    message = (update or {}).get('message') or (update or {}).get('edited_message') or {}
    chat = message.get('chat') or {}
    chat_id = str(chat.get('id') or '').strip()
    chat_type = str(chat.get('type') or '').strip()
    text = str(message.get('text') or '').strip()
    from_user = message.get('from') or {}
    tg_username = str(from_user.get('username') or '').strip()
    tg_first_name = str(from_user.get('first_name') or '').strip()

    if not chat_id or chat_type not in {'private', ''}:
        return {'ok': True}

    command = ''
    arg = ''
    if text.startswith('/'):
        m = re.match(r'^(?P<cmd>/[A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+(?P<arg>.*))?$', text, re.S)
        if m:
            command = str(m.group('cmd') or '').lower()
            arg = str(m.group('arg') or '').strip()

    token_candidate = ''
    if command == '/start' and arg:
        token_candidate = arg
        # Accept manual variants like "/start dl 66577" or extra spaces/newlines.
        if token_candidate.lower().startswith('dl '):
            token_candidate = 'dl_' + '_'.join(part for part in token_candidate[3:].split() if part)
        token_candidate = re.sub(r'\s+', '', token_candidate)
    elif not command and (text.startswith('dl_') or text.startswith('DL_') or text.lower().startswith('dl ')):
        token_candidate = text
        if token_candidate.lower().startswith('dl '):
            token_candidate = 'dl_' + '_'.join(part for part in token_candidate[3:].split() if part)
        token_candidate = re.sub(r'\s+', '', token_candidate)
    else:
        m_start = re.match(r'^/start_?(dl_[A-Za-z0-9_\-]+)$', text, re.I)
        if m_start:
            token_candidate = str(m_start.group(1) or '').strip()
    if token_candidate.lower().startswith('dl '):
        token_candidate = 'dl_' + '_'.join(part for part in token_candidate[3:].split() if part)
    token_candidate = str(token_candidate or '').strip()

    if token_candidate:
        ok, reply, linked_user = _telegram_link_user_from_token(session, token_candidate, chat_id, username=tg_username, first_name=tg_first_name)
        kb = {'inline_keyboard': [[{'text': 'Открыть кабинет', 'url': _dashboard_url(linked_user)}]]} if linked_user and _dashboard_url(linked_user) else None
        _send_telegram(chat_id, reply, reply_markup=kb)
        return {'ok': True}

    user = _telegram_find_user_by_chat(session, chat_id)
    if user:
        if tg_username and tg_username != str(getattr(user, 'telegram_username', '') or ''):
            user.telegram_username = tg_username
            session.add(user)
            session.commit()
        if tg_first_name and tg_first_name != str(getattr(user, 'telegram_first_name', '') or ''):
            user.telegram_first_name = tg_first_name
            session.add(user)
            session.commit()

    if not command and text:
        quick_map = {
            '📅 сегодня': '/today',
            '⏭ ближайшее': '/next',
            '🗓 расписание': '/schedule',
            '🧾 кто я': '/whoami',
            '🏠 кабинет': '/link',
            '👋 помощь': '/help',
            '✅ подтвердить': '/confirm',
            '⚠️ не смогу': '/decline',
            '📊 статистика': '/stats',
        }
        command = quick_map.get(text.strip().lower(), '')

    if command in {'/start', '/help', '/menu'}:
        if user:
            _send_telegram(chat_id, _telegram_welcome_text(user), reply_markup=_telegram_menu_keyboard(user))
        else:
            _telegram_reply_not_linked(chat_id)
        return {'ok': True}

    if not user:
        _telegram_reply_not_linked(chat_id)
        return {'ok': True}

    if command == '/today':
        _telegram_send_today_like(chat_id, user, session, day_offset=0)
    elif command == '/tomorrow':
        _telegram_send_today_like(chat_id, user, session, day_offset=1)
    elif command == '/next':
        _telegram_send_next(chat_id, user, session)
    elif command == '/schedule':
        _telegram_send_schedule(chat_id, user, session)
    elif command == '/confirm':
        _telegram_apply_attendance_status(chat_id, user, session, 'confirmed', arg)
    elif command == '/decline':
        _telegram_apply_attendance_status(chat_id, user, session, 'declined', arg)
    elif command == '/support':
        _send_telegram(chat_id, _telegram_support_text(user), reply_markup=_telegram_menu_keyboard(user))
    elif command == '/stats':
        if _telegram_role_key(user) == 'admin':
            _telegram_send_admin_stats(chat_id, session)
        else:
            _send_telegram(chat_id, 'Команда /stats доступна только администратору. Остальные команды подстраиваются по вашей роли автоматически.', reply_markup=_telegram_menu_keyboard(user))
    elif command == '/whoami':
        dash = _dashboard_url(user)
        _send_telegram(chat_id, _telegram_whoami_text(user, session), reply_markup={'inline_keyboard': [[{'text': 'Открыть кабинет', 'url': dash}]]} if dash else _telegram_menu_keyboard(user))
    elif command == '/link':
        _telegram_send_link(chat_id, user)
    elif command == '/unlink':
        _telegram_unlink(chat_id, user, session)
    else:
        _send_telegram(chat_id, _telegram_help_text(_telegram_role_key(user)), reply_markup=_telegram_menu_keyboard(user))

    return {'ok': True}


# -----------------
# Admin (RBAC)
# -----------------


class AdminUserOut(BaseModel):
    id: int
    email: str
    role: str
    is_active: bool
    created_at: datetime
    last_login_at: Optional[datetime] = None
    balance: int = 0
    earnings: int = 0


class AdminUserUpdateIn(BaseModel):
    role: Optional[str] = None  # student|tutor|admin
    is_active: Optional[bool] = None
    reset_password: Optional[str] = None


@app.get("/api/admin/users", response_model=List[AdminUserOut])
def admin_list_users(
    q: Optional[str] = None,
    _: User = Depends(require_role("admin")),
    session: Session = Depends(get_session),
):
    stmt = select(User)
    if q:
        qq = q.strip().lower()
        stmt = stmt.where(User.email.contains(qq))
    users = session.exec(stmt.order_by(User.created_at.desc())).all()
    return [
        AdminUserOut(
            id=u.id,
            email=u.email,
            role=u.role,
            is_active=getattr(u, "is_active", True),
            created_at=u.created_at,
            last_login_at=getattr(u, "last_login_at", None),
            balance=getattr(u, "balance", 0) or 0,
            earnings=getattr(u, "earnings", 0) or 0,
        )
        for u in users
    ]


@app.patch("/api/admin/users/{user_id}")
def admin_update_user(
    user_id: int,
    payload: AdminUserUpdateIn,
    _: User = Depends(require_role("admin")),
    session: Session = Depends(get_session),
):
    u = session.get(User, user_id)
    if not u:
        raise HTTPException(404, "user not found")

    data = payload.model_dump(exclude_unset=True)
    if "role" in data:
        if data["role"] not in {"student", "tutor", "admin"}:
            raise HTTPException(400, "invalid role")
        u.role = data["role"]
    if "is_active" in data:
        u.is_active = bool(data["is_active"])
    if "reset_password" in data and data["reset_password"]:
        if len(data["reset_password"]) < 8:
            raise HTTPException(400, "password too short")
        u.password_hash = hash_password(data["reset_password"])
        # Invalidate sessions
        u.token_version = int(getattr(u, "token_version", 0)) + 1

    session.add(u)
    session.commit()
    session.refresh(u)
    return {
        "ok": True,
        "id": u.id,
        "email": u.email,
        "role": u.role,
        "is_active": getattr(u, "is_active", True),
    }


class AdminTutorOut(BaseModel):
    id: int
    user_id: int
    email: str
    display_name: str
    photo_url: str
    subjects: List[str]
    goals: List[str]
    price_per_hour: int
    language: str
    is_published: bool
    founding_tutor: bool
    documents_status: str
    documents_note: str
    certificate_links: List[str]
    updated_at: datetime
    rating_avg: float
    rating_count: int
    lessons_count: int


class AdminTutorUpdateIn(BaseModel):
    is_published: Optional[bool] = None
    display_name: Optional[str] = None
    photo_url: Optional[str] = None
    founding_tutor: Optional[bool] = None
    documents_status: Optional[str] = None  # draft|pending|approved|rejected
    documents_note: Optional[str] = None


@app.get("/api/admin/tutors", response_model=List[AdminTutorOut])
def admin_list_tutors(
    only_pending: bool = False,
    status: Optional[str] = None,
    _: User = Depends(require_role("admin")),
    session: Session = Depends(get_session),
):
    stmt = select(TutorProfile)
    if only_pending:
        stmt = stmt.where(TutorProfile.documents_status == "pending")
    if status:
        stmt = stmt.where(TutorProfile.documents_status == status)
    profiles = session.exec(stmt.order_by(TutorProfile.updated_at.desc())).all()

    # map user emails
    user_ids = list({p.user_id for p in profiles})
    users = session.exec(select(User).where(User.id.in_(user_ids))).all() if user_ids else []
    email_map = {u.id: u.email for u in users}

    return [
        AdminTutorOut(
            id=p.id,
            user_id=p.user_id,
            email=email_map.get(p.user_id, ""),
            display_name=p.display_name,
            photo_url=str(getattr(p, "photo_url", "") or ""),
            subjects=_loads_list(getattr(p, "subjects_json", "[]")),
            goals=_loads_list(getattr(p, "goals_json", "[]")),
            price_per_hour=int(getattr(p, "price_per_hour", 0) or 0),
            language=str(getattr(p, "language", "") or "ru"),
            is_published=bool(getattr(p, "is_published", False)),
            founding_tutor=bool(getattr(p, "founding_tutor", False)),
            documents_status=str(getattr(p, "documents_status", "") or "draft"),
            documents_note=str(getattr(p, "documents_note", "") or ""),
            certificate_links=_loads_list(getattr(p, "certificate_links_json", "[]")),
            updated_at=p.updated_at,
            rating_avg=float(getattr(p, "rating_avg", 0) or 0),
            rating_count=int(getattr(p, "rating_count", 0) or 0),
            lessons_count=int(getattr(p, "lessons_count", 0) or 0),
        )
        for p in profiles
    ]


@app.patch("/api/admin/tutors/{profile_id}")
def admin_update_tutor(
    profile_id: int,
    payload: AdminTutorUpdateIn,
    _: User = Depends(require_role("admin")),
    session: Session = Depends(get_session),
):
    p = session.get(TutorProfile, profile_id)
    if not p:
        raise HTTPException(404, "profile not found")

    data = payload.model_dump(exclude_unset=True)

    if "is_published" in data:
        p.is_published = bool(data["is_published"])

    if "display_name" in data and data["display_name"] is not None:
        p.display_name = str(data["display_name"])[:80]

    if "photo_url" in data and data["photo_url"] is not None:
        p.photo_url = str(data["photo_url"])[:500]

    if "founding_tutor" in data:
        p.founding_tutor = bool(data["founding_tutor"])

    if "documents_status" in data and data["documents_status"] is not None:
        ds = str(data["documents_status"]).strip().lower()
        if ds not in {"draft", "pending", "approved", "rejected"}:
            raise HTTPException(400, "bad documents_status")
        p.documents_status = ds

    if "documents_note" in data and data["documents_note"] is not None:
        p.documents_note = str(data["documents_note"])[:4000]

    p.updated_at = datetime.utcnow()

    session.add(p)
    session.commit()
    session.refresh(p)
    return {"ok": True, "id": p.id, "documents_status": getattr(p, "documents_status", "draft"), "is_published": p.is_published}



# -----------------
# Admin: catalog (subjects/goals/levels/grades/...)
# -----------------


class AdminCatalogOut(BaseModel):
    id: int
    kind: str
    value: str
    is_active: bool
    order_index: int


class AdminCatalogIn(BaseModel):
    kind: str
    value: str
    is_active: bool = True
    order_index: int = 0


class AdminCatalogPatch(BaseModel):
    value: Optional[str] = None
    is_active: Optional[bool] = None
    order_index: Optional[int] = None


@app.get("/api/admin/catalog", response_model=List[AdminCatalogOut])
def admin_list_catalog(
    kind: Optional[str] = None,
    _: User = Depends(require_role("admin")),
    session: Session = Depends(get_session),
):
    stmt = select(PlatformCatalog)
    if kind:
        stmt = stmt.where(PlatformCatalog.kind == kind)
    items = session.exec(stmt.order_by(PlatformCatalog.kind.asc(), PlatformCatalog.order_index.asc(), PlatformCatalog.id.asc())).all()
    return [
        AdminCatalogOut(
            id=i.id,
            kind=i.kind,
            value=i.value,
            is_active=bool(i.is_active),
            order_index=int(getattr(i, "order_index", 0) or 0),
        )
        for i in items
    ]


@app.post("/api/admin/catalog", response_model=AdminCatalogOut)
def admin_create_catalog_item(
    payload: AdminCatalogIn,
    _: User = Depends(require_role("admin")),
    session: Session = Depends(get_session),
):
    kind = (payload.kind or "").strip().lower()
    value = (payload.value or "").strip()
    if not kind or not value:
        raise HTTPException(400, "kind and value required")
    if kind not in {"subject", "goal", "level", "grade", "language", "exam"}:
        raise HTTPException(400, "bad kind")

    # avoid duplicates
    existing = session.exec(
        select(PlatformCatalog)
        .where(PlatformCatalog.kind == kind)
        .where(PlatformCatalog.value == value)
        .limit(1)
    ).first()
    if existing:
        existing.is_active = bool(payload.is_active)
        existing.order_index = int(payload.order_index or 0)
        session.add(existing)
        session.commit()
        session.refresh(existing)
        return AdminCatalogOut(id=existing.id, kind=existing.kind, value=existing.value, is_active=existing.is_active, order_index=existing.order_index)

    item = PlatformCatalog(kind=kind, value=value, is_active=bool(payload.is_active), order_index=int(payload.order_index or 0))
    session.add(item)
    session.commit()
    session.refresh(item)
    return AdminCatalogOut(id=item.id, kind=item.kind, value=item.value, is_active=item.is_active, order_index=item.order_index)


@app.patch("/api/admin/catalog/{item_id}", response_model=AdminCatalogOut)
def admin_patch_catalog_item(
    item_id: int,
    payload: AdminCatalogPatch,
    _: User = Depends(require_role("admin")),
    session: Session = Depends(get_session),
):
    item = session.get(PlatformCatalog, item_id)
    if not item:
        raise HTTPException(404, "not found")

    data = payload.model_dump(exclude_unset=True)
    if "value" in data and data["value"] is not None:
        item.value = str(data["value"]).strip()[:200]
    if "is_active" in data:
        item.is_active = bool(data["is_active"])
    if "order_index" in data and data["order_index"] is not None:
        item.order_index = int(data["order_index"])
    session.add(item)
    session.commit()
    session.refresh(item)
    return AdminCatalogOut(id=item.id, kind=item.kind, value=item.value, is_active=item.is_active, order_index=item.order_index)


@app.delete("/api/admin/catalog/{item_id}")
def admin_delete_catalog_item(
    item_id: int,
    _: User = Depends(require_role("admin")),
    session: Session = Depends(get_session),
):
    item = session.get(PlatformCatalog, item_id)
    if not item:
        raise HTTPException(404, "not found")
    session.delete(item)
    session.commit()
    return {"ok": True}

@app.get("/api/admin/overview")
def admin_overview(
    _: User = Depends(require_role("admin")),
    session: Session = Depends(get_session),
):
    # lightweight overview for admin dashboard
    users = session.exec(select(User)).all()
    profiles = session.exec(select(TutorProfile)).all()
    bookings = session.exec(select(Booking)).all()
    reviews = session.exec(select(Review)).all()
    open_reports = session.exec(select(IssueReport).where(IssueReport.status == "open")).all()
    plans = session.exec(select(StudyPlan)).all()
    plan_items = session.exec(select(PlanItem)).all()
    hw = session.exec(select(Homework)).all()
    topics = session.exec(select(TopicProgress)).all()
    library_items = session.exec(select(StudentLibraryItem)).all()
    quizzes = session.exec(select(Quiz)).all()
    quiz_questions = session.exec(select(QuizQuestion)).all()
    quiz_attempts = session.exec(select(QuizAttempt)).all()

    by_status = {"confirmed": 0, "cancelled": 0, "done": 0}
    for b in bookings:
        by_status[b.status] = by_status.get(b.status, 0) + 1

    return {
        "users": len(users),
        "tutors": len([u for u in users if u.role == "tutor"]),
        "students": len([u for u in users if u.role == "student"]),
        "admins": len([u for u in users if u.role == "admin"]),
        "profiles": len(profiles),
        "published_profiles": len([p for p in profiles if p.is_published]),
        "bookings": len(bookings),
        "bookings_confirmed": by_status.get("confirmed", 0),
        "bookings_cancelled": by_status.get("cancelled", 0),
        "bookings_done": by_status.get("done", 0),
        "reviews": len(reviews),
        "open_reports": len(open_reports),
        "plans": len(plans),
        "plan_items": len(plan_items),
        "homework": len(hw),
        "topics": len(topics),
        "student_library_items": len(library_items),
        "quizzes": len(quizzes),
        "quiz_questions": len(quiz_questions),
        "quiz_attempts": len(quiz_attempts),
    }
# -----------------
# Admin: bookings / reviews / reports
# -----------------


class AdminBookingOut(BaseModel):
    id: int
    status: str
    created_at: datetime
    slot_id: int
    starts_at: Optional[datetime] = None
    ends_at: Optional[datetime] = None
    tutor_user_id: int
    tutor_email: str
    student_user_id: int
    student_email: str


class AdminBookingPatchIn(BaseModel):
    status: Optional[str] = None  # confirmed|cancelled|done
    slot_id: Optional[int] = None  # reschedule to another slot (same tutor)


def _booking_to_admin_out(b: Booking, session: Session) -> AdminBookingOut:
    slot = session.get(Slot, b.slot_id)
    tutor = session.get(User, b.tutor_user_id)
    student = session.get(User, b.student_user_id)
    return AdminBookingOut(
        id=b.id,
        status=b.status,
        created_at=b.created_at,
        slot_id=b.slot_id,
        starts_at=getattr(slot, 'starts_at', None) if slot else None,
        ends_at=getattr(slot, 'ends_at', None) if slot else None,
        tutor_user_id=b.tutor_user_id,
        tutor_email=getattr(tutor, 'email', '') if tutor else '',
        student_user_id=b.student_user_id,
        student_email=getattr(student, 'email', '') if student else '',
    )


@app.get('/api/admin/bookings', response_model=List[AdminBookingOut])
def admin_list_bookings(
    q: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 100,
    _: User = Depends(require_role('admin')),
    session: Session = Depends(get_session),
):
    limit = max(1, min(int(limit or 100), 500))

    stmt = select(Booking).order_by(Booking.created_at.desc())
    if status:
        stmt = stmt.where(Booking.status == status)

    bookings = session.exec(stmt.limit(limit)).all()

    if q:
        qq = q.strip().lower()
        # Filter in python by matching either tutor or student email
        out = []
        for b in bookings:
            tutor = session.get(User, b.tutor_user_id)
            student = session.get(User, b.student_user_id)
            if (tutor and qq in tutor.email.lower()) or (student and qq in student.email.lower()):
                out.append(b)
        bookings = out

    return [_booking_to_admin_out(b, session) for b in bookings]


@app.patch('/api/admin/bookings/{booking_id}')
def admin_patch_booking(
    booking_id: int,
    payload: AdminBookingPatchIn,
    _: User = Depends(require_role('admin')),
    session: Session = Depends(get_session),
):
    b = session.get(Booking, booking_id)
    if not b:
        raise HTTPException(404, 'booking not found')

    data = payload.model_dump(exclude_unset=True)

    if 'slot_id' in data and data['slot_id'] is not None:
        new_slot = session.get(Slot, int(data['slot_id']))
        if not new_slot:
            raise HTTPException(404, 'slot not found')
        if new_slot.tutor_user_id != b.tutor_user_id:
            raise HTTPException(400, 'slot must belong to the same tutor')
        if new_slot.status != 'open':
            raise HTTPException(400, 'slot is not open')

        # Release old slot
        old_slot = session.get(Slot, b.slot_id)
        if old_slot and old_slot.status == 'booked':
            old_slot.status = 'open'
            session.add(old_slot)

        # Book new slot
        new_slot.status = 'booked'
        session.add(new_slot)

        b.slot_id = new_slot.id
        session.add(b)

    if 'status' in data and data['status'] is not None:
        st = str(data['status'])
        if st not in {'confirmed', 'cancelled', 'done'}:
            raise HTTPException(400, 'invalid status')
        b.status = st
        session.add(b)

    session.commit()
    session.refresh(b)
    return {'ok': True, 'booking': _booking_to_admin_out(b, session).model_dump()}


class AdminReviewOut(BaseModel):
    id: int
    booking_id: int
    tutor_user_id: int
    tutor_email: str
    student_user_id: int
    student_email: str
    stars: int
    text: str
    created_at: datetime


def _review_to_admin_out(r: Review, session: Session) -> AdminReviewOut:
    tutor = session.get(User, r.tutor_user_id)
    student = session.get(User, r.student_user_id)
    return AdminReviewOut(
        id=r.id,
        booking_id=r.booking_id,
        tutor_user_id=r.tutor_user_id,
        tutor_email=getattr(tutor, 'email', '') if tutor else '',
        student_user_id=r.student_user_id,
        student_email=getattr(student, 'email', '') if student else '',
        stars=r.stars,
        text=r.text,
        created_at=r.created_at,
    )


def _recompute_tutor_rating(session: Session, tutor_user_id: int) -> None:
    profile = session.exec(select(TutorProfile).where(TutorProfile.user_id == tutor_user_id)).first()
    if not profile:
        return
    rows = session.exec(select(Review).where(Review.tutor_user_id == tutor_user_id)).all()
    if not rows:
        profile.rating_avg = 0
        profile.rating_count = 0
    else:
        total = sum(int(r.stars) for r in rows)
        profile.rating_count = len(rows)
        profile.rating_avg = float(total) / float(profile.rating_count)
    profile.updated_at = datetime.utcnow()
    session.add(profile)


@app.get('/api/admin/reviews', response_model=List[AdminReviewOut])
def admin_list_reviews(
    q: Optional[str] = None,
    stars: Optional[int] = None,
    limit: int = 100,
    _: User = Depends(require_role('admin')),
    session: Session = Depends(get_session),
):
    limit = max(1, min(int(limit or 100), 500))
    stmt = select(Review).order_by(Review.created_at.desc())
    if stars is not None:
        stmt = stmt.where(Review.stars == int(stars))
    rows = session.exec(stmt.limit(limit)).all()

    if q:
        qq = q.strip().lower()
        out = []
        for r in rows:
            tutor = session.get(User, r.tutor_user_id)
            student = session.get(User, r.student_user_id)
            if (tutor and qq in tutor.email.lower()) or (student and qq in student.email.lower()) or (qq in (r.text or '').lower()):
                out.append(r)
        rows = out

    return [_review_to_admin_out(r, session) for r in rows]


@app.delete('/api/admin/reviews/{review_id}')
def admin_delete_review(
    review_id: int,
    _: User = Depends(require_role('admin')),
    session: Session = Depends(get_session),
):
    r = session.get(Review, review_id)
    if not r:
        raise HTTPException(404, 'review not found')
    tutor_id = r.tutor_user_id

    session.delete(r)
    session.commit()

    # Recompute rating after delete
    _recompute_tutor_rating(session, tutor_id)
    session.commit()
    return {'ok': True}


class ReportIn(BaseModel):
    booking_id: Optional[int] = None
    category: str = Field(default='general')
    message: str = Field(default='')


class ReportOut(BaseModel):
    id: int
    created_at: datetime
    booking_id: Optional[int] = None
    reporter_user_id: int
    reporter_email: str
    reported_user_id: Optional[int] = None
    reported_email: Optional[str] = None
    category: str
    message: str
    status: str
    resolved_by_user_id: Optional[int] = None
    resolved_by_email: Optional[str] = None
    resolved_at: Optional[datetime] = None


def _report_to_out(r: IssueReport, session: Session) -> ReportOut:
    reporter = session.get(User, r.reporter_user_id)
    reported = session.get(User, r.reported_user_id) if r.reported_user_id else None
    resolver = session.get(User, r.resolved_by_user_id) if r.resolved_by_user_id else None
    return ReportOut(
        id=r.id,
        created_at=r.created_at,
        booking_id=r.booking_id,
        reporter_user_id=r.reporter_user_id,
        reporter_email=getattr(reporter, 'email', '') if reporter else '',
        reported_user_id=r.reported_user_id,
        reported_email=getattr(reported, 'email', None) if reported else None,
        category=r.category,
        message=r.message,
        status=r.status,
        resolved_by_user_id=r.resolved_by_user_id,
        resolved_by_email=getattr(resolver, 'email', None) if resolver else None,
        resolved_at=r.resolved_at,
    )


@app.post('/api/reports')
def create_report(
    payload: ReportIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    msg = (payload.message or '').strip()
    if len(msg) < 3:
        raise HTTPException(400, 'message too short')

    booking_id = payload.booking_id
    reported_user_id = None

    if booking_id is not None:
        booking = session.get(Booking, int(booking_id))
        if not booking:
            raise HTTPException(404, 'booking not found')
        # Only participants (or admin) can report a booking
        if user.role != 'admin' and user.id not in {booking.student_user_id, booking.tutor_user_id}:
            raise HTTPException(403, 'no access')
        # Set the "other side" as reported user
        if user.id == booking.student_user_id:
            reported_user_id = booking.tutor_user_id
        elif user.id == booking.tutor_user_id:
            reported_user_id = booking.student_user_id

    r = IssueReport(
        booking_id=int(booking_id) if booking_id is not None else None,
        reporter_user_id=user.id,
        reported_user_id=reported_user_id,
        category=(payload.category or 'general')[:40],
        message=msg[:2000],
        status='open',
    )
    session.add(r)
    session.commit()
    session.refresh(r)
    return {'ok': True, 'report_id': r.id}


class AdminReportPatchIn(BaseModel):
    status: Optional[str] = None  # open|resolved


@app.get('/api/admin/reports', response_model=List[ReportOut])
def admin_list_reports(
    status: Optional[str] = 'open',
    limit: int = 100,
    _: User = Depends(require_role('admin')),
    session: Session = Depends(get_session),
):
    limit = max(1, min(int(limit or 100), 500))
    stmt = select(IssueReport).order_by(IssueReport.created_at.desc())
    if status:
        stmt = stmt.where(IssueReport.status == status)
    rows = session.exec(stmt.limit(limit)).all()
    return [_report_to_out(r, session) for r in rows]


@app.patch('/api/admin/reports/{report_id}')
def admin_patch_report(
    report_id: int,
    payload: AdminReportPatchIn,
    admin: User = Depends(require_role('admin')),
    session: Session = Depends(get_session),
):
    r = session.get(IssueReport, report_id)
    if not r:
        raise HTTPException(404, 'report not found')

    data = payload.model_dump(exclude_unset=True)
    if 'status' in data and data['status'] is not None:
        st = str(data['status'])
        if st not in {'open', 'resolved'}:
            raise HTTPException(400, 'invalid status')
        r.status = st
        if st == 'resolved':
            r.resolved_by_user_id = admin.id
            r.resolved_at = datetime.utcnow()
        else:
            r.resolved_by_user_id = None
            r.resolved_at = None

    session.add(r)
    session.commit()
    session.refresh(r)
    return {'ok': True, 'report': _report_to_out(r, session).model_dump()}

# -----------------
# Tutors
# -----------------


class TutorProfilePublicOut(BaseModel):
    id: int
    user_id: int
    display_name: str
    photo_url: str = ""
    age: Optional[int] = None
    education: str = ""
    backgrounds: List[str]
    grades: List[str]
    subjects: List[str]
    levels: List[str]
    goals: List[str]
    price_per_hour: int
    language: str
    bio: str
    video_url: str
    public_schedule_note: str = ""
    rating_avg: float
    rating_count: int
    lessons_count: int
    founding_tutor: bool
    is_verified: bool
    is_published: bool


class TutorProfileMeOut(TutorProfilePublicOut):
    certificate_links: List[str]
    documents_status: str
    documents_note: str
    payment_method: str


def _profile_public_out(p: TutorProfile) -> TutorProfilePublicOut:
    docs_status = str(getattr(p, "documents_status", "") or "")
    is_verified = docs_status == "approved" or docs_status in {"", "draft"}  # backward compatible
    return TutorProfilePublicOut(
        id=p.id,
        user_id=p.user_id,
        display_name=p.display_name,
        photo_url=str(getattr(p, "photo_url", "") or ""),
        age=getattr(p, "age", None),
        education=str(getattr(p, "education", "") or ""),
        backgrounds=_loads_list(getattr(p, "backgrounds_json", "[]")),
        grades=_loads_list(getattr(p, "grades_json", "[]")),
        subjects=_loads_list(p.subjects_json),
        levels=_loads_list(p.levels_json),
        goals=_loads_list(p.goals_json),
        price_per_hour=p.price_per_hour,
        language=p.language,
        bio=p.bio,
        video_url=p.video_url,
        public_schedule_note=str(getattr(p, "public_schedule_note", "") or ""),
        rating_avg=p.rating_avg,
        rating_count=p.rating_count,
        lessons_count=int(getattr(p, "lessons_count", 0) or 0),
        founding_tutor=bool(getattr(p, "founding_tutor", False)),
        is_verified=bool(is_verified),
        is_published=p.is_published,
    )


def _profile_me_out(p: TutorProfile) -> TutorProfileMeOut:
    base = _profile_public_out(p).model_dump()
    return TutorProfileMeOut(
        **base,
        certificate_links=_loads_list(getattr(p, "certificate_links_json", "[]")),
        documents_status=str(getattr(p, "documents_status", "") or "draft"),
        documents_note=str(getattr(p, "documents_note", "") or ""),
        payment_method=str(getattr(p, "payment_method", "") or ""),
    )


def _get_or_create_tutor_profile(session: Session, user: User) -> TutorProfile:
    p = session.exec(select(TutorProfile).where(TutorProfile.user_id == user.id)).first()
    if p:
        return p
    base_name = (getattr(user, "email", "") or "репетитор").split("@", 1)[0] or "репетитор"
    p = TutorProfile(user_id=user.id, display_name=base_name)
    session.add(p)
    session.commit()
    session.refresh(p)
    return p


def _tutor_profile_missing_required(p: TutorProfile) -> List[str]:
    missing: List[str] = []

    def _arr(attr: str) -> List[str]:
        return [str(x).strip() for x in _loads_list(getattr(p, attr, "[]")) if str(x).strip()]

    if not str(getattr(p, "display_name", "") or "").strip():
        missing.append("имя")
    if not _arr("subjects_json"):
        missing.append("хотя бы 1 предмет")
    if not _arr("grades_json"):
        missing.append("классы")
    if int(getattr(p, "price_per_hour", 0) or 0) <= 0:
        missing.append("цена за час")
    if not str(getattr(p, "education", "") or "").strip():
        missing.append("образование")
    if not str(getattr(p, "bio", "") or "").strip():
        missing.append("описание / о себе")
    if not _arr("certificate_links_json"):
        missing.append("ссылки на сертификаты/дипломы")

    return missing


_DEFAULT_CATALOG = {
    "subjects": ["Математика", "Английский", "Физика", "Химия", "Русский язык", "Информатика", "Программирование"],
    "goals": ["ЕГЭ", "ОГЭ", "ЦТ", "ЦЭ", "Разговорный", "IELTS", "Подтянуть оценки"],
    "levels": ["1-4 класс", "5-9 класс", "10-11 класс", "A1", "A2", "B1", "B2", "C1"],
    "grades": [str(i) for i in range(1, 12)],
    "languages": ["ru", "en"],
    "exams": ["ЦТ", "ЦЭ", "ОГЭ", "ЕГЭ"],
}


@app.get("/api/catalog")
def get_catalog(session: Session = Depends(get_session)):
    """Public catalog for UI filters. Admin can manage via /api/admin/catalog."""
    rows = session.exec(select(PlatformCatalog).where(PlatformCatalog.is_active == True)).all()  # noqa
    by_kind: Dict[str, List[PlatformCatalog]] = {}
    for r in rows:
        by_kind.setdefault(r.kind, []).append(r)

    def _vals(kind: str, fallback_key: str):
        items = sorted(by_kind.get(kind, []), key=lambda x: (int(getattr(x, "order_index", 0) or 0), x.id or 0))
        if items:
            return [x.value for x in items]
        return list(_DEFAULT_CATALOG.get(fallback_key, []))

    return {
        "subjects": _vals("subject", "subjects"),
        "goals": _vals("goal", "goals"),
        "levels": _vals("level", "levels"),
        "grades": _vals("grade", "grades"),
        "languages": _vals("language", "languages"),
        "exams": _vals("exam", "exams"),
    }


@app.get("/api/tutors", response_model=List[TutorProfilePublicOut])
def list_tutors(
    q: Optional[str] = None,
    subject: Optional[str] = None,
    goal: Optional[str] = None,
    level: Optional[str] = None,
    grade: Optional[str] = None,
    language: Optional[str] = None,
    min_price: Optional[int] = None,
    max_price: Optional[int] = None,
    has_free_slots: bool = False,
    available_from: Optional[datetime] = None,
    available_to: Optional[datetime] = None,
    sort: str = "best",  # best|price_asc|price_desc|newest
    session: Session = Depends(get_session),
):
    # Visible: published + not pending/rejected moderation
    profiles = session.exec(select(TutorProfile).where(TutorProfile.is_published == True)).all()  # noqa

    needle = (q or "").strip().lower()
    subj = (subject or "").strip().lower()
    go = (goal or "").strip().lower()
    lev = (level or "").strip().lower()
    grd = (grade or "").strip().lower()
    lang = (language or "").strip().lower()

    # Slots filter (optional)
    available_tutor_ids: Optional[set[int]] = None
    if has_free_slots or available_from or available_to:
        st = select(Slot.tutor_user_id).where(Slot.status == "open")
        if available_from:
            st = st.where(Slot.starts_at >= available_from)
        if available_to:
            st = st.where(Slot.starts_at <= available_to)
        ids = session.exec(st).all()
        available_tutor_ids = set(int(x) for x in ids if x is not None)

    def _list_lower(lst: List[str]) -> List[str]:
        return [str(x).strip().lower() for x in (lst or []) if str(x).strip()]

    def _visible_status(p: TutorProfile) -> bool:
        ds = str(getattr(p, "documents_status", "") or "")
        # backward compatible: empty/draft -> visible; pending/rejected -> hidden
        return ds not in {"pending", "rejected"}

    def match(p: TutorProfile) -> bool:
        if not _visible_status(p):
            return False

        if available_tutor_ids is not None and int(p.user_id) not in available_tutor_ids:
            return False

        subjects = _list_lower(_loads_list(p.subjects_json))
        goals = _list_lower(_loads_list(p.goals_json))
        levels = _list_lower(_loads_list(p.levels_json))
        grades = _list_lower(_loads_list(getattr(p, "grades_json", "[]")))

        if subj and subj not in subjects:
            return False
        if go and go not in goals:
            return False
        if lev and lev not in levels:
            return False
        if grd and grd not in grades:
            return False

        if lang and str(getattr(p, "language", "") or "").strip().lower() != lang:
            return False

        price = int(getattr(p, "price_per_hour", 0) or 0)
        if min_price is not None and price < int(min_price):
            return False
        if max_price is not None and price > int(max_price):
            return False

        if needle:
            text = " ".join([
                str(getattr(p, "display_name", "") or ""),
                str(getattr(p, "bio", "") or ""),
                str(getattr(p, "education", "") or ""),
                " ".join(_loads_list(getattr(p, "backgrounds_json", "[]"))),
                " ".join(subjects),
                " ".join(goals),
                " ".join(levels),
                " ".join(grades),
            ]).lower()
            if needle not in text:
                return False

        return True

    filtered = [p for p in profiles if match(p)]

    def sort_key(p: TutorProfile):
        price = int(getattr(p, "price_per_hour", 0) or 0)
        rating = float(getattr(p, "rating_avg", 0) or 0)
        rc = int(getattr(p, "rating_count", 0) or 0)
        lc = int(getattr(p, "lessons_count", 0) or 0)
        upd = getattr(p, "updated_at", datetime.utcnow())
        if sort == "price_asc":
            return (price, -rating, -rc, -lc, -upd.timestamp())
        if sort == "price_desc":
            return (-price, -rating, -rc, -lc, -upd.timestamp())
        if sort == "newest":
            return (-upd.timestamp(), -rating, -rc, -lc, price)
        # best
        return (-rating, -rc, -lc, price, -upd.timestamp())

    filtered.sort(key=sort_key)
    return [_profile_public_out(p) for p in filtered]


@app.get("/api/tutors/{profile_id:int}", response_model=TutorProfilePublicOut)
def get_tutor(profile_id: int, session: Session = Depends(get_session)):
    p = session.get(TutorProfile, profile_id)
    if not p or not p.is_published:
        raise HTTPException(404, "tutor not found")
    ds = str(getattr(p, "documents_status", "") or "")
    if ds in {"pending", "rejected"}:
        raise HTTPException(404, "tutor not found")
    return _profile_public_out(p)


class TutorProfileUpdateIn(BaseModel):
    display_name: Optional[str] = None
    photo_url: Optional[str] = None
    age: Optional[int] = None
    education: Optional[str] = None
    backgrounds: Optional[List[str]] = None
    grades: Optional[List[str]] = None

    subjects: Optional[List[str]] = None
    levels: Optional[List[str]] = None
    goals: Optional[List[str]] = None

    price_per_hour: Optional[int] = None
    language: Optional[str] = None
    bio: Optional[str] = None
    video_url: Optional[str] = None

    certificate_links: Optional[List[str]] = None
    payment_method: Optional[str] = None
    public_schedule_note: Optional[str] = None


@app.get("/api/tutors/me", response_model=TutorProfileMeOut)
def get_my_profile(
    user: User = Depends(require_role("tutor", "admin")),
    session: Session = Depends(get_session),
):
    p = _get_or_create_tutor_profile(session, user)
    return _profile_me_out(p)


@app.put("/api/tutors/me", response_model=TutorProfileMeOut)
def update_my_profile(
    payload: TutorProfileUpdateIn,
    user: User = Depends(require_role("tutor", "admin")),
    session: Session = Depends(get_session),
):
    p = _get_or_create_tutor_profile(session, user)

    data = payload.model_dump(exclude_unset=True)

    # JSON lists
    for key, attr in [
        ("subjects", "subjects_json"),
        ("levels", "levels_json"),
        ("goals", "goals_json"),
        ("backgrounds", "backgrounds_json"),
        ("grades", "grades_json"),
        ("certificate_links", "certificate_links_json"),
    ]:
        if key in data:
            setattr(p, attr, json.dumps(data.pop(key) or [], ensure_ascii=False))

    # primitives
    for k, v in data.items():
        if k == "age" and v is not None:
            try:
                v = int(v)
                if v < 10 or v > 120:
                    v = None
            except Exception:
                v = None
        setattr(p, k, v)

    p.updated_at = datetime.utcnow()

    session.add(p)
    session.commit()
    session.refresh(p)
    return _profile_me_out(p)


@app.post("/api/tutors/me/submit", response_model=TutorProfileMeOut)
def submit_profile_for_moderation(
    user: User = Depends(require_role("tutor", "admin")),
    session: Session = Depends(get_session),
):
    p = _get_or_create_tutor_profile(session, user)

    missing = _tutor_profile_missing_required(p)
    if missing:
        raise HTTPException(400, {"message": "Профиль не заполнен", "missing": missing})

    p.documents_status = "pending"
    p.documents_note = ""
    p.updated_at = datetime.utcnow()
    session.add(p)
    session.commit()
    session.refresh(p)
    return _profile_me_out(p)


@app.post("/api/tutors/me/publish", response_model=TutorProfileMeOut)
def publish_my_profile(
    user: User = Depends(require_role("tutor", "admin")),
    session: Session = Depends(get_session),
):
    p = _get_or_create_tutor_profile(session, user)

    missing = _tutor_profile_missing_required(p)
    if missing:
        raise HTTPException(400, {"message": "Профиль не заполнен", "missing": missing})

    p.is_published = True
    # if not approved yet -> pending moderation
    ds = str(getattr(p, "documents_status", "") or "draft")
    if ds != "approved":
        p.documents_status = "pending"
    p.updated_at = datetime.utcnow()
    session.add(p)
    session.commit()
    session.refresh(p)
    return _profile_me_out(p)


# -----------------
# Slots + Bookings

# -----------------


class SlotCreateIn(BaseModel):
    starts_at: datetime
    ends_at: datetime


class SlotOut(BaseModel):
    id: int
    tutor_user_id: int
    starts_at: datetime
    ends_at: datetime
    status: str


@app.post("/api/slots", response_model=SlotOut)
def create_slot(
    payload: SlotCreateIn,
    user: User = Depends(require_role("tutor", "admin")),
    session: Session = Depends(get_session),
):
    if payload.ends_at <= payload.starts_at:
        raise HTTPException(400, "ends_at must be after starts_at")

    slot = Slot(
        tutor_user_id=user.id,
        starts_at=payload.starts_at,
        ends_at=payload.ends_at,
        status="open",
    )
    session.add(slot)
    session.commit()
    session.refresh(slot)
    try:
        _notify_waitlist_and_last_minute_for_slot(session, slot, reason='slot_created')
        session.commit()
    except Exception:
        session.rollback()
    return SlotOut(**slot.model_dump())


@app.get("/api/slots/me", response_model=List[SlotOut])
def list_my_slots(
    user: User = Depends(require_role("tutor", "admin")),
    session: Session = Depends(get_session),
):
    q = select(Slot)
    if user.role != "admin":
        q = q.where(Slot.tutor_user_id == user.id)
    slots = session.exec(q.order_by(Slot.starts_at.desc())).all()
    return [SlotOut(**s.model_dump()) for s in slots]


@app.get("/api/slots/available", response_model=List[SlotOut])
def list_available_slots(
    tutor_user_id: Optional[int] = None,
    session: Session = Depends(get_session),
):
    q = select(Slot).where(Slot.status == "open")
    if tutor_user_id:
        q = q.where(Slot.tutor_user_id == tutor_user_id)
    slots = session.exec(q.order_by(Slot.starts_at)).all()
    return [SlotOut(**s.model_dump()) for s in slots]


class BookingOut(BaseModel):
    id: int
    slot_id: int
    tutor_user_id: int
    student_user_id: int
    status: str
    created_at: datetime
    price: int = 0
    payment_status: str = 'unpaid'
    paid_at: Optional[datetime] = None
    room_id: str
    slot_starts_at: Optional[datetime] = None
    slot_ends_at: Optional[datetime] = None
    student_attendance_status: str = 'pending'
    tutor_attendance_status: str = 'pending'
    student_attendance_updated_at: Optional[datetime] = None
    tutor_attendance_updated_at: Optional[datetime] = None
    reschedule_count: int = 0
    last_reschedule_reason: str = ''
    risk_status: str = 'low'
    risk_reasons: List[str] = []


def _booking_to_out(b: Booking, session: Session) -> BookingOut:
    slot = _slot_for_booking(b, session)
    risk = _booking_risk_info(b, session)
    return BookingOut(
        id=b.id,
        slot_id=b.slot_id,
        tutor_user_id=b.tutor_user_id,
        student_user_id=b.student_user_id,
        status=b.status,
        created_at=b.created_at,
        price=getattr(b, 'price', 0) or 0,
        payment_status=getattr(b, 'payment_status', 'unpaid') or 'unpaid',
        paid_at=getattr(b, 'paid_at', None),
        room_id=f"booking-{b.id}",
        slot_starts_at=slot.starts_at if slot else None,
        slot_ends_at=slot.ends_at if slot else None,
        student_attendance_status=str(getattr(b, 'student_attendance_status', 'pending') or 'pending'),
        tutor_attendance_status=str(getattr(b, 'tutor_attendance_status', 'pending') or 'pending'),
        student_attendance_updated_at=getattr(b, 'student_attendance_updated_at', None),
        tutor_attendance_updated_at=getattr(b, 'tutor_attendance_updated_at', None),
        reschedule_count=int(getattr(b, 'reschedule_count', 0) or 0),
        last_reschedule_reason=str(getattr(b, 'last_reschedule_reason', '') or ''),
        risk_status=str(risk.get('status', 'low')),
        risk_reasons=list(risk.get('reasons', []) or []),
    )


@app.post("/api/slots/{slot_id}/book", response_model=BookingOut)
def book_slot(
    slot_id: int,
    user: User = Depends(require_role("student", "admin")),
    session: Session = Depends(get_session),
):
    slot = session.get(Slot, slot_id)
    if not slot or slot.status != "open":
        raise HTTPException(404, "slot not available")

    slot.status = "booked"
    session.add(slot)

    # Compute trial price from tutor profile and slot duration
    prof = session.exec(select(TutorProfile).where(TutorProfile.user_id == slot.tutor_user_id)).first()
    price_per_hour = int(prof.price_per_hour) if prof else 0
    minutes = max(1, int((slot.ends_at - slot.starts_at).total_seconds() // 60))
    price = int(round(price_per_hour * (minutes / 60)))

    booking = Booking(
        slot_id=slot.id,
        tutor_user_id=slot.tutor_user_id,
        student_user_id=user.id,
        status="confirmed",
        price=price,
        payment_status='unpaid',
    )
    session.add(booking)
    session.commit()
    session.refresh(booking)

    _notify_booking_event("booked", booking, session)
    return _booking_to_out(booking, session)


@app.get("/api/bookings", response_model=List[BookingOut])
def my_bookings(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    if user.role == "tutor":
        rows = session.exec(
            select(Booking)
            .where(Booking.tutor_user_id == user.id)
            .order_by(Booking.created_at.desc())
        ).all()
    else:
        rows = session.exec(
            select(Booking)
            .where(Booking.student_user_id == user.id)
            .order_by(Booking.created_at.desc())
        ).all()

    return [_booking_to_out(b, session) for b in rows]


class BookingActionOut(BaseModel):
    ok: bool = True
    booking: BookingOut


def _ensure_participant(booking: Booking, user: User):
    if user.role == "admin":
        return
    if user.id not in {booking.student_user_id, booking.tutor_user_id}:
        raise HTTPException(403, "booking access denied")


def _tutor_has_student(tutor_id: int, student_id: int, session: Session) -> bool:
    row = session.exec(
        select(Booking)
        .where(Booking.tutor_user_id == tutor_id)
        .where(Booking.student_user_id == student_id)
        .limit(1)
    ).first()
    return bool(row)


def _require_tutor_student_relation(tutor_id: int, student_id: int, session: Session) -> None:
    if not _tutor_has_student(tutor_id, student_id, session):
        raise HTTPException(400, "tutor has no lessons with this student yet")


def _booking_risk_info(booking: Booking, session: Session) -> Dict[str, Any]:
    """Simple rule-based risk flag (no ML)."""
    reasons: List[str] = []
    score = 0

    if str(getattr(booking, "status", "")) != "confirmed":
        return {"status": "low", "score": 0, "reasons": []}

    student_att = str(getattr(booking, "student_attendance_status", "pending") or "pending")
    tutor_att = str(getattr(booking, "tutor_attendance_status", "pending") or "pending")

    if student_att == "declined":
        score += 3
        reasons.append("Ученик отметил: не подтверждаю")
    elif student_att == "pending":
        score += 1
        reasons.append("Ученик ещё не подтвердил")

    if tutor_att == "declined":
        score += 3
        reasons.append("Репетитор отметил: не подтверждаю")
    elif tutor_att == "pending":
        score += 1
        reasons.append("Репетитор ещё не подтвердил")

    rc = int(getattr(booking, "reschedule_count", 0) or 0)
    if rc >= 2:
        score += 2
        reasons.append(f"Переносов подряд/по истории брони: {rc}")
    elif rc == 1:
        score += 1
        reasons.append("Был перенос занятия")

    slot = _slot_for_booking(booking, session)
    s = _as_utc(getattr(slot, "starts_at", None)) if slot else None
    if s:
        now = _utcnow()
        hours_to_start = (s - now).total_seconds() / 3600
        if 0 <= hours_to_start <= 12 and (student_att == "pending" or tutor_att == "pending"):
            score += 1
            reasons.append("До занятия меньше 12 часов, есть неподтверждённая сторона")

    # Lightweight history signal: recent student cancellations with this tutor
    try:
        recent = session.exec(
            select(Booking)
            .where(Booking.student_user_id == booking.student_user_id)
            .where(Booking.tutor_user_id == booking.tutor_user_id)
            .order_by(Booking.created_at.desc())
            .limit(8)
        ).all()
        cancels = sum(1 for x in recent if str(getattr(x, "status", "")) == "cancelled")
        if cancels >= 2:
            score += 1
            reasons.append("В истории есть повторные отмены")
    except Exception:
        pass

    if score >= 5:
        level = "high"
    elif score >= 3:
        level = "medium"
    else:
        level = "low"
    return {"status": level, "score": score, "reasons": reasons[:5]}


def _find_repeat_slot_candidates(booking: Booking, session: Session, limit: int = 20) -> List[Slot]:
    """Find open slots for same tutor after original lesson, sorted by closeness to original weekday/time."""
    old_slot = _slot_for_booking(booking, session)
    if not old_slot:
        return []

    old_start = _as_utc(old_slot.starts_at)
    old_end = _as_utc(old_slot.ends_at)
    if not old_start or not old_end:
        return []
    duration_min = max(1, int((old_end - old_start).total_seconds() // 60))
    now = _utcnow()

    rows = session.exec(
        select(Slot)
        .where(Slot.tutor_user_id == booking.tutor_user_id)
        .where(Slot.status == "open")
        .order_by(Slot.starts_at.asc())
        .limit(200)
    ).all()

    scored: List[Tuple[float, Slot]] = []
    for s in rows:
        s_start = _as_utc(s.starts_at)
        s_end = _as_utc(s.ends_at)
        if not s_start or not s_end:
            continue
        if s_start <= now:
            continue
        dur = int((s_end - s_start).total_seconds() // 60)
        if abs(dur - duration_min) > 15:
            continue

        weekday_pen = 0 if s_start.weekday() == old_start.weekday() else 1
        minutes_old = old_start.hour * 60 + old_start.minute
        minutes_new = s_start.hour * 60 + s_start.minute
        minute_pen = abs(minutes_new - minutes_old) / 60.0
        days_delta = abs((s_start.date() - old_start.date()).days)
        # Encourage next-week repeats (7 or 14 days) and same weekday/time first.
        week_target_pen = min(abs(days_delta - 7), abs(days_delta - 14), days_delta)
        score = (weekday_pen * 1000) + (week_target_pen * 10) + minute_pen
        scored.append((score, s))

    scored.sort(key=lambda x: (x[0], x[1].starts_at))
    return [s for _, s in scored[:max(1, limit)]]


def _book_existing_slot_for_student(slot: Slot, student_user_id: int, session: Session) -> Booking:
    if not slot or str(slot.status) != "open":
        raise HTTPException(404, "slot not available")

    slot.status = "booked"
    session.add(slot)

    prof = session.exec(select(TutorProfile).where(TutorProfile.user_id == slot.tutor_user_id)).first()
    price_per_hour = int(prof.price_per_hour) if prof else 0
    minutes = max(1, int((slot.ends_at - slot.starts_at).total_seconds() // 60))
    price = int(round(price_per_hour * (minutes / 60)))

    new_booking = Booking(
        slot_id=slot.id,
        tutor_user_id=slot.tutor_user_id,
        student_user_id=student_user_id,
        status="confirmed",
        price=price,
        payment_status='unpaid',
        student_attendance_status='pending',
        tutor_attendance_status='pending',
        reschedule_count=0,
    )
    session.add(new_booking)
    session.commit()
    session.refresh(new_booking)
    return new_booking


@app.post("/api/bookings/{booking_id}/complete", response_model=BookingActionOut)
def complete_booking(
    booking_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    booking = session.get(Booking, booking_id)
    if not booking:
        raise HTTPException(404, "booking not found")

    _ensure_participant(booking, user)

    if booking.status in {"done", "completed"}:
        return BookingActionOut(booking=_booking_to_out(booking, session))

    if booking.status == "cancelled":
        raise HTTPException(400, "booking is cancelled")

    booking.status = "done"  # keep MVP schema: confirmed|cancelled|done
    session.add(booking)

    # update tutor profile counter (best-effort)
    prof = session.exec(select(TutorProfile).where(TutorProfile.user_id == booking.tutor_user_id)).first()
    if prof:
        prof.lessons_count = int(getattr(prof, "lessons_count", 0) or 0) + 1
        prof.updated_at = datetime.utcnow()
        session.add(prof)

    session.commit()
    session.refresh(booking)
    _notify_booking_event("completed", booking, session)
    return BookingActionOut(booking=_booking_to_out(booking, session))


@app.post("/api/bookings/{booking_id}/cancel", response_model=BookingActionOut)
def cancel_booking(
    booking_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    booking = session.get(Booking, booking_id)
    if not booking:
        raise HTTPException(404, "booking not found")

    _ensure_participant(booking, user)

    if booking.status in {"done", "completed"}:
        raise HTTPException(400, "booking already completed")

    if booking.status == "cancelled":
        return BookingActionOut(booking=_booking_to_out(booking, session))

    booking.status = "cancelled"
    session.add(booking)

    slot = session.get(Slot, booking.slot_id)
    if slot and slot.status == "booked":
        slot.status = "open"
        session.add(slot)

    session.commit()
    session.refresh(booking)
    _notify_booking_event("cancelled", booking, session)
    try:
        if slot and str(getattr(slot, 'status', '')) == 'open':
            _notify_waitlist_and_last_minute_for_slot(session, slot, reason='cancelled_booking')
            session.commit()
    except Exception:
        session.rollback()
    return BookingActionOut(booking=_booking_to_out(booking, session))


class RescheduleIn(BaseModel):
    new_slot_id: int
    template: Optional[str] = None  # tomorrow | propose_other_time | cant_today
    note: Optional[str] = None


@app.post("/api/bookings/{booking_id}/reschedule", response_model=BookingActionOut)
def reschedule_booking(
    booking_id: int,
    payload: RescheduleIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    booking = session.get(Booking, booking_id)
    if not booking:
        raise HTTPException(404, "booking not found")
    _ensure_participant(booking, user)

    if booking.status != "confirmed":
        raise HTTPException(400, "only confirmed bookings can be rescheduled")

    old_slot = session.get(Slot, booking.slot_id)
    new_slot = session.get(Slot, payload.new_slot_id)
    if not new_slot or new_slot.status != "open":
        raise HTTPException(404, "new slot not available")
    if new_slot.tutor_user_id != booking.tutor_user_id:
        raise HTTPException(400, "new slot must belong to the same tutor")

    # Free old slot
    if old_slot and old_slot.status == "booked":
        old_slot.status = "open"
        session.add(old_slot)

    # Book new slot
    new_slot.status = "booked"
    session.add(new_slot)

    booking.slot_id = new_slot.id
    booking.reminder_sent = False
    booking.reminder_sent_at = None
    booking.student_attendance_status = "pending"
    booking.tutor_attendance_status = "pending"
    booking.student_attendance_updated_at = None
    booking.tutor_attendance_updated_at = None
    booking.reschedule_count = int(getattr(booking, "reschedule_count", 0) or 0) + 1
    if payload.template or payload.note:
        reason_bits = []
        if payload.template:
            reason_bits.append(f"template={payload.template}")
        if payload.note:
            reason_bits.append(str(payload.note).strip())
        booking.last_reschedule_reason = " | ".join([x for x in reason_bits if x])[:300]
    session.add(booking)

    session.commit()
    session.refresh(booking)

    extra = None
    try:
        o = _as_utc(old_slot.starts_at) if old_slot else None
        n = _as_utc(new_slot.starts_at) if new_slot else None
        extra = f"Перенос: {o.isoformat() if o else ''} → {n.isoformat() if n else ''}".strip()
    except Exception:
        pass

    if payload.template:
        extra = ((extra + "\n") if extra else "") + f"Шаблон переноса: {payload.template}"
    if payload.note:
        extra = ((extra + "\n") if extra else "") + f"Комментарий: {str(payload.note).strip()[:500]}"

    _notify_booking_event("rescheduled", booking, session, extra=extra)
    try:
        if old_slot and str(getattr(old_slot, 'status', '')) == 'open':
            _notify_waitlist_and_last_minute_for_slot(session, old_slot, reason='reschedule_opened_old_slot')
            session.commit()
    except Exception:
        session.rollback()
    return BookingActionOut(booking=_booking_to_out(booking, session))


class BookingAttendanceIn(BaseModel):
    status: str  # pending | confirmed | declined
    note: Optional[str] = None
    participant: Optional[str] = None  # admin only: student | tutor


@app.post("/api/bookings/{booking_id}/attendance", response_model=BookingActionOut)
def set_booking_attendance(
    booking_id: int,
    payload: BookingAttendanceIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    booking = session.get(Booking, booking_id)
    if not booking:
        raise HTTPException(404, "booking not found")
    _ensure_participant(booking, user)

    status = str(payload.status or "").strip().lower()
    if status not in {"pending", "confirmed", "declined"}:
        raise HTTPException(400, "status must be pending|confirmed|declined")

    now = datetime.utcnow()
    target = None
    if user.role == "admin" and payload.participant in {"student", "tutor"}:
        target = payload.participant
    elif user.id == booking.student_user_id:
        target = "student"
    elif user.id == booking.tutor_user_id:
        target = "tutor"

    if target == "student":
        booking.student_attendance_status = status
        booking.student_attendance_updated_at = now
    elif target == "tutor":
        booking.tutor_attendance_status = status
        booking.tutor_attendance_updated_at = now
    else:
        raise HTTPException(403, "booking access denied")

    session.add(booking)
    session.commit()
    session.refresh(booking)

    kind = "attendance_confirmed" if status == "confirmed" else ("attendance_declined" if status == "declined" else None)
    if kind:
        who_ru = "Ученик" if target == "student" else "Репетитор"
        extra = f"{who_ru} поставил статус: {status}"
        if payload.note:
            extra += f"\nКомментарий: {str(payload.note).strip()[:500]}"
        _notify_booking_event(kind, booking, session, extra=extra)

    return BookingActionOut(booking=_booking_to_out(booking, session))


class RepeatBookingOut(BaseModel):
    ok: bool = True
    booking: BookingOut
    match_type: str = "same_weekday_time"  # exact_next_week | same_weekday_time | nearest_available


@app.post("/api/bookings/{booking_id}/repeat", response_model=RepeatBookingOut)
def repeat_booking_one_click(
    booking_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    source = session.get(Booking, booking_id)
    if not source:
        raise HTTPException(404, "booking not found")
    _ensure_participant(source, user)

    # In product terms this is primarily for student retention; admin can also use it.
    if user.role != "admin" and user.id != source.student_user_id:
        raise HTTPException(403, "only student can repeat booking")
    if str(getattr(source, "status", "")) == "cancelled":
        raise HTTPException(400, "cannot repeat cancelled booking")

    old_slot = _slot_for_booking(source, session)
    if not old_slot:
        raise HTTPException(400, "source slot not found")
    candidates = _find_repeat_slot_candidates(source, session, limit=10)
    if not candidates:
        raise HTTPException(404, "no matching open slots for repeat yet")

    chosen = candidates[0]
    old_start = _as_utc(old_slot.starts_at)
    new_start = _as_utc(chosen.starts_at)
    match_type = "nearest_available"
    if old_start and new_start:
        dd = abs((new_start.date() - old_start.date()).days)
        same_wd = new_start.weekday() == old_start.weekday()
        same_hm = (new_start.hour, new_start.minute) == (old_start.hour, old_start.minute)
        if same_wd and same_hm and dd == 7:
            match_type = "exact_next_week"
        elif same_wd and same_hm:
            match_type = "same_weekday_time"

    new_booking = _book_existing_slot_for_student(chosen, source.student_user_id, session)
    _notify_booking_event("booked", new_booking, session, extra=f"Повторная запись в 1 клик. match_type={match_type}")
    return RepeatBookingOut(booking=_booking_to_out(new_booking, session), match_type=match_type)


# -----------------
# Cron: reminders (Railway Cron can call this endpoint)
# -----------------


@app.post("/api/cron/reminders")
def cron_send_reminders(
    key: Optional[str] = None,
    session: Session = Depends(get_session),
):
    """Send reminders for lessons starting soon.

    Protect with DL_CRON_KEY (query param ?key=...). If DL_CRON_KEY is not set,
    the endpoint will be disabled.
    """
    need_key = os.getenv("DL_CRON_KEY")
    if not need_key:
        raise HTTPException(403, "DL_CRON_KEY is not set")
    if (key or "") != need_key:
        raise HTTPException(403, "bad key")

    now = _utcnow()
    window_from = now + timedelta(minutes=7)
    window_to = now + timedelta(minutes=15)
    followup_from = now + timedelta(minutes=int(os.getenv("DL_ATTENDANCE_FOLLOWUP_MIN", "60") or "60"))
    followup_to = now + timedelta(minutes=int(os.getenv("DL_ATTENDANCE_FOLLOWUP_MAX", "180") or "180"))

    bookings = session.exec(
        select(Booking)
        .where(Booking.status == "confirmed")
    ).all()

    sent_basic = 0
    sent_followups = 0
    for b in bookings:
        slot = _slot_for_booking(b, session)
        if not slot:
            continue
        s = _as_utc(slot.starts_at)
        if not s:
            continue

        if not bool(getattr(b, "reminder_sent", False)) and window_from <= s <= window_to:
            mins = int((s - now).total_seconds() // 60)
            risk = _booking_risk_info(b, session)
            extra = f"До начала ~{mins} мин"
            extra += f"\nAttendance: student={getattr(b, 'student_attendance_status', 'pending')} tutor={getattr(b, 'tutor_attendance_status', 'pending')}"
            if str(risk.get('status')) in {"medium", "high"}:
                extra += f"\nРиск срыва: {risk.get('status')}"
            _notify_booking_event("reminder", b, session, extra=extra)
            b.reminder_sent = True
            b.reminder_sent_at = now
            session.add(b)
            sent_basic += 1

        if followup_from <= s <= followup_to:
            mins_left = max(1, int((s - now).total_seconds() // 60))
            pending_targets: List[Tuple[str, User]] = []
            if str(getattr(b, "student_attendance_status", "pending") or "pending") == "pending":
                student = session.get(User, b.student_user_id)
                if student:
                    pending_targets.append(("student", student))
            if str(getattr(b, "tutor_attendance_status", "pending") or "pending") == "pending":
                tutor = session.get(User, b.tutor_user_id)
                if tutor:
                    pending_targets.append(("tutor", tutor))

            tutor = session.get(User, b.tutor_user_id)
            student = session.get(User, b.student_user_id)
            for participant, recipient in pending_targets:
                notif_kind = f"attendance_followup_{participant}_slot_{b.slot_id}"
                rk = _notif_key_for_user(recipient, fallback=f"booking:{b.id}:{participant}")
                if _notification_exists(session, rk, "booking", b.id, notif_kind):
                    continue

                if participant == "student":
                    counterpart_name = str(getattr(tutor, "email", "") or f"репетитор #{b.tutor_user_id}")
                    audience_label = "ученика"
                else:
                    counterpart_name = str(getattr(student, "email", "") or f"ученик #{b.student_user_id}")
                    audience_label = "репетитора"

                subject = "DL: подтвердите участие в занятии"
                body = (
                    f"Напоминание для {audience_label}: занятие booking-{b.id} начнётся примерно через {mins_left} мин.\n"
                    f"Время: {s.isoformat()}\n"
                    f"Вторая сторона: {counterpart_name}\n"
                    "Статус подтверждения пока не получен. Пожалуйста, подтвердите участие в личном кабинете."
                )
                try:
                    _notify_user_direct(recipient, subject, body)
                    _notification_mark(session, rk, "booking", b.id, notif_kind, note=f"mins_left={mins_left}")
                    sent_followups += 1
                except Exception:
                    pass

    session.commit()
    return {
        "ok": True,
        "sent": sent_basic + sent_followups,
        "sent_basic": sent_basic,
        "sent_followups": sent_followups,
        "now": now.isoformat(),
    }


# -----------------
# Rooms (access check + info)
# -----------------


class RoomInfoOut(BaseModel):
    ok: bool = True
    room_id: str
    booking: BookingOut
    tutor_email_masked: str
    student_email_masked: str
    tutor_payment_method: str = ""


@app.get("/api/rooms/{room_id}", response_model=RoomInfoOut)
def room_info(
    room_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    booking = _require_room_access(room_id, user, session)
    tutor = session.get(User, booking.tutor_user_id)
    student = session.get(User, booking.student_user_id)

    prof = session.exec(select(TutorProfile).where(TutorProfile.user_id == booking.tutor_user_id)).first()
    pay = str(getattr(prof, "payment_method", "") or "") if prof else ""

    return RoomInfoOut(
        room_id=room_id,
        booking=_booking_to_out(booking, session),
        tutor_email_masked=_mask_email(tutor.email if tutor else ""),
        student_email_masked=_mask_email(student.email if student else ""),
        tutor_payment_method=pay,
    )


# -----------------
# Reviews
# -----------------


class ReviewIn(BaseModel):
    stars: int = Field(ge=1, le=5)
    text: str = ""


class ReviewOut(BaseModel):
    id: int
    booking_id: int
    stars: int
    text: str
    created_at: datetime
    student_hint: str


def _review_to_out(r: Review, session: Session) -> ReviewOut:
    u = session.get(User, r.student_user_id)
    return ReviewOut(
        id=r.id,
        booking_id=r.booking_id,
        stars=r.stars,
        text=r.text,
        created_at=r.created_at,
        student_hint=_mask_email(u.email if u else ""),
    )


@app.get("/api/bookings/{booking_id}/review")
def get_review_for_booking(
    booking_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    booking = session.get(Booking, booking_id)
    if not booking:
        raise HTTPException(404, "booking not found")
    _ensure_participant(booking, user)

    existing = session.exec(select(Review).where(Review.booking_id == booking_id)).first()
    if not existing:
        return {"review": None}
    return {"review": _review_to_out(existing, session).model_dump()}


@app.get("/api/tutors/{profile_id}/reviews", response_model=List[ReviewOut])
def list_reviews_for_tutor(profile_id: int, session: Session = Depends(get_session)):
    profile = session.get(TutorProfile, profile_id)
    if not profile or not profile.is_published:
        raise HTTPException(404, "tutor not found")

    rows = session.exec(
        select(Review)
        .where(Review.tutor_user_id == profile.user_id)
        .order_by(Review.created_at.desc())
        .limit(50)
    ).all()
    return [_review_to_out(r, session) for r in rows]


@app.post("/api/bookings/{booking_id}/review")
def leave_review(
    booking_id: int,
    payload: ReviewIn,
    user: User = Depends(require_role("student", "admin")),
    session: Session = Depends(get_session),
):
    booking = session.get(Booking, booking_id)
    if not booking or (user.role != "admin" and booking.student_user_id != user.id):
        raise HTTPException(404, "booking not found")

    if booking.status not in {"done", "completed"}:
        raise HTTPException(400, "you can leave a review only after the lesson is completed")

    existing = session.exec(select(Review).where(Review.booking_id == booking_id)).first()
    if existing:
        raise HTTPException(400, "review already exists")

    review = Review(
        booking_id=booking.id,
        tutor_user_id=booking.tutor_user_id,
        student_user_id=booking.student_user_id,
        stars=payload.stars,
        text=payload.text,
    )
    session.add(review)

    # Update tutor rating (simple average)
    profile = session.exec(select(TutorProfile).where(TutorProfile.user_id == booking.tutor_user_id)).first()
    if profile:
        total = profile.rating_avg * profile.rating_count
        profile.rating_count += 1
        profile.rating_avg = (total + payload.stars) / profile.rating_count
        session.add(profile)

    session.commit()
    return {"ok": True}


# -----------------
# WebSocket: signaling / whiteboard / chat
# -----------------


# -----------------
# Lesson artifacts (whiteboard export)
# -----------------


class ArtifactOut(BaseModel):
    id: int
    booking_id: int
    kind: str
    mime: str
    created_at: datetime


class WhiteboardSnapshotIn(BaseModel):
    png_base64: str


def _artifact_to_out(a: LessonArtifact) -> ArtifactOut:
    return ArtifactOut(
        id=a.id,
        booking_id=a.booking_id,
        kind=a.kind,
        mime=a.mime,
        created_at=a.created_at,
    )


def _png_to_pdf_bytes(png_bytes: bytes) -> bytes:
    # Lazy import so reportlab is only needed for this feature.
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas as pdfcanvas

    page_w, page_h = A4
    margin = 36
    avail_w = page_w - 2 * margin
    avail_h = page_h - 2 * margin

    img = ImageReader(io.BytesIO(png_bytes))
    iw, ih = img.getSize()
    if not iw or not ih:
        raise ValueError("invalid image")

    scale = min(avail_w / iw, avail_h / ih)
    w = iw * scale
    h = ih * scale
    x = (page_w - w) / 2
    y = (page_h - h) / 2

    buf = io.BytesIO()
    c = pdfcanvas.Canvas(buf, pagesize=A4)
    c.drawImage(img, x, y, width=w, height=h, preserveAspectRatio=True, mask='auto')
    c.showPage()
    c.save()
    return buf.getvalue()


@app.get("/api/bookings/{booking_id}/artifacts", response_model=List[ArtifactOut])
def list_artifacts(
    booking_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    booking = session.get(Booking, booking_id)
    if not booking:
        raise HTTPException(404, "booking not found")
    _ensure_participant(booking, user)

    rows = session.exec(
        select(LessonArtifact)
        .where(LessonArtifact.booking_id == booking_id)
        .order_by(LessonArtifact.created_at.desc())
    ).all()
    return [_artifact_to_out(a) for a in rows]


@app.post("/api/bookings/{booking_id}/artifacts/whiteboard", response_model=List[ArtifactOut])
def save_whiteboard_snapshot(
    booking_id: int,
    payload: WhiteboardSnapshotIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    booking = session.get(Booking, booking_id)
    if not booking:
        raise HTTPException(404, "booking not found")
    _ensure_participant(booking, user)

    try:
        png_bytes = base64.b64decode(payload.png_base64)
    except Exception:
        raise HTTPException(400, "invalid png_base64")

    a_png = LessonArtifact(
        booking_id=booking_id,
        kind="whiteboard_png",
        mime="image/png",
        data=png_bytes,
    )
    session.add(a_png)

    # Also store a PDF version (nice for printing/sharing)
    try:
        pdf_bytes = _png_to_pdf_bytes(png_bytes)
        a_pdf = LessonArtifact(
            booking_id=booking_id,
            kind="whiteboard_pdf",
            mime="application/pdf",
            data=pdf_bytes,
        )
        session.add(a_pdf)
    except Exception:
        # If PDF generation fails, still keep PNG.
        pass

    session.commit()

    rows = session.exec(
        select(LessonArtifact)
        .where(LessonArtifact.booking_id == booking_id)
        .order_by(LessonArtifact.created_at.desc())
    ).all()
    return [_artifact_to_out(a) for a in rows]


@app.get("/api/artifacts/{artifact_id}")
def download_artifact(
    artifact_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    art = session.get(LessonArtifact, artifact_id)
    if not art:
        raise HTTPException(404, "artifact not found")
    booking = session.get(Booking, art.booking_id)
    if not booking:
        raise HTTPException(404, "booking not found")
    _ensure_participant(booking, user)

    ext = "bin"
    if art.mime == "image/png":
        ext = "png"
    elif art.mime == "application/pdf":
        ext = "pdf"

    filename = f"booking-{art.booking_id}-{art.kind}-{art.id}.{ext}"
    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"'
    }
    return Response(content=art.data, media_type=art.mime, headers=headers)


# -----------------
# Lesson materials (file upload/download) – for homework sheets, PDFs, images, etc.
# -----------------


class MaterialOut(BaseModel):
    id: int
    booking_id: int
    name: str
    mime: str
    size_bytes: int
    created_at: datetime
    uploader_hint: str


def _material_to_out(m: LessonMaterial, session: Session) -> MaterialOut:
    u = session.get(User, m.uploader_user_id)
    return MaterialOut(
        id=m.id,
        booking_id=m.booking_id,
        name=m.name,
        mime=m.mime,
        size_bytes=m.size_bytes,
        created_at=m.created_at,
        uploader_hint=_mask_email(u.email if u else ""),
    )


@app.get("/api/bookings/{booking_id}/materials", response_model=List[MaterialOut])
def list_materials_for_booking(
    booking_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    booking = session.get(Booking, booking_id)
    if not booking:
        raise HTTPException(404, "booking not found")
    _ensure_participant(booking, user)

    rows = session.exec(
        select(LessonMaterial)
        .where(LessonMaterial.booking_id == booking_id)
        .order_by(LessonMaterial.created_at.desc())
    ).all()
    return [_material_to_out(m, session) for m in rows]


@app.post("/api/bookings/{booking_id}/materials", response_model=List[MaterialOut])
async def upload_material(
    booking_id: int,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    booking = session.get(Booking, booking_id)
    if not booking:
        raise HTTPException(404, "booking not found")
    _ensure_participant(booking, user)

    data = await file.read()
    if not data:
        raise HTTPException(400, "empty file")
    if len(data) > 7 * 1024 * 1024:
        # MVP safety: keep it small for DB storage.
        raise HTTPException(400, "file too large (max 7MB in MVP)")

    name = (file.filename or "file").strip()[:180]
    mime = (file.content_type or "application/octet-stream").strip()[:120]

    m = LessonMaterial(
        booking_id=booking_id,
        uploader_user_id=user.id,
        name=name,
        mime=mime,
        size_bytes=len(data),
        data=data,
    )
    session.add(m)
    session.commit()

    rows = session.exec(
        select(LessonMaterial)
        .where(LessonMaterial.booking_id == booking_id)
        .order_by(LessonMaterial.created_at.desc())
    ).all()
    return [_material_to_out(x, session) for x in rows]


@app.get("/api/materials", response_model=List[MaterialOut])
def list_my_materials(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    # List all materials across bookings for the current user.
    if user.role == "tutor":
        bks = session.exec(select(Booking).where(Booking.tutor_user_id == user.id)).all()
    else:
        bks = session.exec(select(Booking).where(Booking.student_user_id == user.id)).all()
    ids = [b.id for b in bks if b and b.id]
    if not ids:
        return []
    rows = session.exec(
        select(LessonMaterial)
        .where(LessonMaterial.booking_id.in_(ids))
        .order_by(LessonMaterial.created_at.desc())
        .limit(200)
    ).all()
    return [_material_to_out(m, session) for m in rows]


@app.get("/api/materials/{material_id}")
def download_material(
    material_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    m = session.get(LessonMaterial, material_id)
    if not m:
        raise HTTPException(404, "material not found")
    booking = session.get(Booking, m.booking_id)
    if not booking:
        raise HTTPException(404, "booking not found")
    _ensure_participant(booking, user)

    # Simple filename sanitation
    safe = "".join([c for c in (m.name or "file") if c.isalnum() or c in " ._-()"]).strip()
    if not safe:
        safe = "file"
    headers = {"Content-Disposition": f'attachment; filename="{safe}"'}
    return Response(content=m.data, media_type=m.mime, headers=headers)


# -----------------
# Homework
# -----------------


class HomeworkIn(BaseModel):
    student_user_id: int
    booking_id: Optional[int] = None
    title: str = Field(min_length=1, max_length=140)
    description: str = ""
    due_at: Optional[datetime] = None


class HomeworkSubmitIn(BaseModel):
    submission_text: str = Field(default="", max_length=4000)


class HomeworkCheckIn(BaseModel):
    feedback_text: str = Field(default="", max_length=4000)


class HomeworkOut(BaseModel):
    id: int
    tutor_user_id: int
    tutor_hint: str
    student_user_id: int
    student_hint: str
    booking_id: Optional[int]
    title: str
    description: str
    due_at: Optional[datetime]
    status: str
    submission_text: str
    submitted_at: Optional[datetime]
    feedback_text: str
    checked_at: Optional[datetime]
    created_at: datetime


def _hw_to_out(h: Homework, session: Session) -> HomeworkOut:
    tutor = session.get(User, h.tutor_user_id)
    student = session.get(User, h.student_user_id)
    return HomeworkOut(
        id=h.id,
        tutor_user_id=h.tutor_user_id,
        tutor_hint=_mask_email(tutor.email if tutor else ""),
        student_user_id=h.student_user_id,
        student_hint=_mask_email(student.email if student else ""),
        booking_id=h.booking_id,
        title=h.title,
        description=h.description,
        due_at=h.due_at,
        status=h.status,
        submission_text=h.submission_text,
        submitted_at=h.submitted_at,
        feedback_text=h.feedback_text,
        checked_at=h.checked_at,
        created_at=h.created_at,
    )


@app.get("/api/homework", response_model=List[HomeworkOut])
def list_homework(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if user.role == "tutor":
        rows = session.exec(
            select(Homework)
            .where(Homework.tutor_user_id == user.id)
            .order_by(Homework.created_at.desc())
            .limit(200)
        ).all()
    else:
        rows = session.exec(
            select(Homework)
            .where(Homework.student_user_id == user.id)
            .order_by(Homework.created_at.desc())
            .limit(200)
        ).all()
    return [_hw_to_out(h, session) for h in rows]


@app.post("/api/homework", response_model=HomeworkOut)
def create_homework(
    payload: HomeworkIn,
    user: User = Depends(require_role("tutor", "admin")),
    session: Session = Depends(get_session),
):
    if user.role != "admin":
        _require_tutor_student_relation(user.id, payload.student_user_id, session)
    if payload.booking_id:
        b = session.get(Booking, payload.booking_id)
        if not b:
            raise HTTPException(404, "booking not found")
        if user.role != "admin" and b.tutor_user_id != user.id:
            raise HTTPException(403, "no access to booking")

    h = Homework(
        tutor_user_id=user.id,
        student_user_id=payload.student_user_id,
        booking_id=payload.booking_id,
        title=payload.title,
        description=payload.description,
        due_at=payload.due_at,
        status="assigned",
    )
    # If admin creates homework, set tutor_user_id to booking tutor if possible.
    if user.role == "admin":
        if payload.booking_id:
            b = session.get(Booking, payload.booking_id)
            if b:
                h.tutor_user_id = b.tutor_user_id
        else:
            h.tutor_user_id = user.id

    session.add(h)
    session.commit()
    session.refresh(h)
    return _hw_to_out(h, session)


@app.post("/api/homework/{homework_id}/submit", response_model=HomeworkOut)
def submit_homework(
    homework_id: int,
    payload: HomeworkSubmitIn,
    user: User = Depends(require_role("student", "admin")),
    session: Session = Depends(get_session),
):
    h = session.get(Homework, homework_id)
    if not h:
        raise HTTPException(404, "homework not found")
    if user.role != "admin" and h.student_user_id != user.id:
        raise HTTPException(403, "no access")

    if h.status == "checked":
        raise HTTPException(400, "already checked")

    h.submission_text = payload.submission_text
    h.submitted_at = datetime.utcnow()
    h.status = "submitted"
    session.add(h)
    session.commit()
    session.refresh(h)
    return _hw_to_out(h, session)


@app.post("/api/homework/{homework_id}/check", response_model=HomeworkOut)
def check_homework(
    homework_id: int,
    payload: HomeworkCheckIn,
    user: User = Depends(require_role("tutor", "admin")),
    session: Session = Depends(get_session),
):
    h = session.get(Homework, homework_id)
    if not h:
        raise HTTPException(404, "homework not found")
    if user.role != "admin" and h.tutor_user_id != user.id:
        raise HTTPException(403, "no access")

    if h.status not in {"submitted", "assigned"}:
        raise HTTPException(400, "bad status")

    h.feedback_text = payload.feedback_text
    h.checked_at = datetime.utcnow()
    h.status = "checked"
    session.add(h)
    session.commit()
    session.refresh(h)
    return _hw_to_out(h, session)


# -----------------
# Progress by topics
# -----------------


class StudentOut(BaseModel):
    id: int
    hint: str


@app.get("/api/progress/students", response_model=List[StudentOut])
def list_my_students(
    user: User = Depends(require_role("tutor", "admin")),
    session: Session = Depends(get_session),
):
    if user.role == "admin":
        # In MVP, admin sees none here.
        return []

    rows = session.exec(select(Booking).where(Booking.tutor_user_id == user.id)).all()
    ids = sorted({b.student_user_id for b in rows if b})
    out: List[StudentOut] = []
    for sid in ids:
        u = session.get(User, sid)
        out.append(StudentOut(id=sid, hint=_mask_email(u.email if u else "")))
    return out


class TopicIn(BaseModel):
    topic: str = Field(min_length=1, max_length=120)
    status: str = Field(default="todo")  # todo|in_progress|done
    note: str = Field(default="", max_length=400)


class TopicOut(BaseModel):
    id: int
    topic: str
    status: str
    note: str
    updated_at: datetime
    tutor_hint: str


def _topic_to_out(t: TopicProgress, session: Session) -> TopicOut:
    tutor = session.get(User, t.tutor_user_id)
    return TopicOut(
        id=t.id,
        topic=t.topic,
        status=t.status,
        note=t.note,
        updated_at=t.updated_at,
        tutor_hint=_mask_email(tutor.email if tutor else ""),
    )


@app.get("/api/progress/student/{student_id}", response_model=List[TopicOut])
def get_progress_for_student(
    student_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    # Tutor can view only their students; student can view own.
    if user.role == "tutor":
        _require_tutor_student_relation(user.id, student_id, session)
        rows = session.exec(
            select(TopicProgress)
            .where(TopicProgress.tutor_user_id == user.id)
            .where(TopicProgress.student_user_id == student_id)
            .order_by(TopicProgress.updated_at.desc())
        ).all()
    elif user.role == "student":
        if user.id != student_id:
            raise HTTPException(403, "no access")
        rows = session.exec(
            select(TopicProgress)
            .where(TopicProgress.student_user_id == student_id)
            .order_by(TopicProgress.updated_at.desc())
        ).all()
    else:
        rows = session.exec(select(TopicProgress).where(TopicProgress.student_user_id == student_id)).all()
    return [_topic_to_out(t, session) for t in rows]


@app.post("/api/progress/student/{student_id}", response_model=TopicOut)
def upsert_topic_progress(
    student_id: int,
    payload: TopicIn,
    user: User = Depends(require_role("tutor", "admin")),
    session: Session = Depends(get_session),
):
    if user.role != "admin":
        _require_tutor_student_relation(user.id, student_id, session)

    status = payload.status
    if status not in {"todo", "in_progress", "done"}:
        raise HTTPException(400, "bad status")

    row = session.exec(
        select(TopicProgress)
        .where(TopicProgress.tutor_user_id == user.id)
        .where(TopicProgress.student_user_id == student_id)
        .where(TopicProgress.topic == payload.topic)
        .limit(1)
    ).first()

    if not row:
        row = TopicProgress(
            tutor_user_id=user.id,
            student_user_id=student_id,
            topic=payload.topic,
            status=status,
            note=payload.note,
            updated_at=datetime.utcnow(),
        )
    else:
        row.status = status
        row.note = payload.note
        row.updated_at = datetime.utcnow()

    session.add(row)
    session.commit()
    session.refresh(row)
    return _topic_to_out(row, session)


@app.get("/api/progress/mine", response_model=List[TopicOut])
def get_my_progress(
    user: User = Depends(require_role("student", "admin")),
    session: Session = Depends(get_session),
):
    rows = session.exec(
        select(TopicProgress)
        .where(TopicProgress.student_user_id == user.id)
        .order_by(TopicProgress.updated_at.desc())
        .limit(500)
    ).all()
    return [_topic_to_out(t, session) for t in rows]


# -----------------
# Pre-lesson mini-test (check-in)
# -----------------


class CheckinQuestionsIn(BaseModel):
    questions: List[str] = Field(default_factory=list)


class CheckinSubmitIn(BaseModel):
    answers: List[str] = Field(default_factory=list)


class CheckinOut(BaseModel):
    booking_id: int
    tutor_hint: str
    student_hint: str
    questions: List[str]
    answers: List[str]
    submitted_at: Optional[datetime]
    updated_at: datetime


def _checkin_to_out(c: PreLessonCheckin, session: Session) -> CheckinOut:
    tutor = session.get(User, c.tutor_user_id)
    student = session.get(User, c.student_user_id)
    try:
        qs = list(json.loads(c.questions_json or "[]"))
    except Exception:
        qs = []
    try:
        ans = list(json.loads(c.answers_json or "[]"))
    except Exception:
        ans = []
    return CheckinOut(
        booking_id=c.booking_id,
        tutor_hint=_mask_email(tutor.email if tutor else ""),
        student_hint=_mask_email(student.email if student else ""),
        questions=[str(x) for x in qs],
        answers=[str(x) for x in ans],
        submitted_at=c.submitted_at,
        updated_at=c.updated_at,
    )


@app.get("/api/bookings/{booking_id}/checkin", response_model=CheckinOut)
def get_checkin(
    booking_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    booking = session.get(Booking, booking_id)
    if not booking:
        raise HTTPException(404, "booking not found")
    _ensure_participant(booking, user)

    c = session.exec(select(PreLessonCheckin).where(PreLessonCheckin.booking_id == booking_id)).first()
    if not c:
        # empty default
        c = PreLessonCheckin(
            booking_id=booking_id,
            tutor_user_id=booking.tutor_user_id,
            student_user_id=booking.student_user_id,
            questions_json="[]",
            answers_json="[]",
        )
        session.add(c)
        session.commit()
        session.refresh(c)
    return _checkin_to_out(c, session)


@app.post("/api/bookings/{booking_id}/checkin", response_model=CheckinOut)
def set_checkin_questions(
    booking_id: int,
    payload: CheckinQuestionsIn,
    user: User = Depends(require_role("tutor", "admin")),
    session: Session = Depends(get_session),
):
    booking = session.get(Booking, booking_id)
    if not booking:
        raise HTTPException(404, "booking not found")
    _ensure_participant(booking, user)
    if user.role != "admin" and booking.tutor_user_id != user.id:
        raise HTTPException(403, "only tutor can set questions")
    if booking.status != "confirmed":
        raise HTTPException(400, "checkin is available only for confirmed lessons")

    qs = [str(x)[:300] for x in (payload.questions or []) if str(x).strip()]
    qs = qs[:10]

    c = session.exec(select(PreLessonCheckin).where(PreLessonCheckin.booking_id == booking_id)).first()
    if not c:
        c = PreLessonCheckin(
            booking_id=booking_id,
            tutor_user_id=booking.tutor_user_id,
            student_user_id=booking.student_user_id,
        )
    c.questions_json = json.dumps(qs, ensure_ascii=False)
    # Reset answers when questions change
    c.answers_json = "[]"
    c.submitted_at = None
    c.updated_at = datetime.utcnow()
    session.add(c)
    session.commit()
    session.refresh(c)
    return _checkin_to_out(c, session)


@app.post("/api/bookings/{booking_id}/checkin/submit", response_model=CheckinOut)
def submit_checkin(
    booking_id: int,
    payload: CheckinSubmitIn,
    user: User = Depends(require_role("student", "admin")),
    session: Session = Depends(get_session),
):
    booking = session.get(Booking, booking_id)
    if not booking:
        raise HTTPException(404, "booking not found")
    _ensure_participant(booking, user)
    if user.role != "admin" and booking.student_user_id != user.id:
        raise HTTPException(403, "only student can submit")
    if booking.status != "confirmed":
        raise HTTPException(400, "checkin is available only for confirmed lessons")

    c = session.exec(select(PreLessonCheckin).where(PreLessonCheckin.booking_id == booking_id)).first()
    if not c:
        raise HTTPException(400, "no checkin")

    try:
        qs = list(json.loads(c.questions_json or "[]"))
    except Exception:
        qs = []
    if not qs:
        raise HTTPException(400, "no questions set")

    ans = [str(x)[:1200] for x in (payload.answers or [])]
    # Normalize to length of questions
    ans = (ans + [""] * len(qs))[: len(qs)]

    c.answers_json = json.dumps(ans, ensure_ascii=False)
    c.submitted_at = datetime.utcnow()
    c.updated_at = datetime.utcnow()
    session.add(c)
    session.commit()
    session.refresh(c)
    return _checkin_to_out(c, session)


# -----------------
# Learning plan (StudyPlan)
# -----------------


class PlanIn(BaseModel):
    student_user_id: int
    title: str = Field(default="", max_length=140)
    goal: str = Field(default="", max_length=2000)
    starts_at: Optional[datetime] = None
    target_at: Optional[datetime] = None


class PlanPatch(BaseModel):
    title: Optional[str] = Field(default=None, max_length=140)
    goal: Optional[str] = Field(default=None, max_length=2000)
    status: Optional[str] = None  # active|paused|completed
    starts_at: Optional[datetime] = None
    target_at: Optional[datetime] = None


class PlanOut(BaseModel):
    id: int
    tutor_user_id: int
    tutor_hint: str
    student_user_id: int
    student_hint: str
    title: str
    goal: str
    status: str
    starts_at: Optional[datetime]
    target_at: Optional[datetime]
    created_at: datetime
    updated_at: datetime


def _plan_to_out(p: StudyPlan, session: Session) -> PlanOut:
    tutor = session.get(User, p.tutor_user_id)
    student = session.get(User, p.student_user_id)
    return PlanOut(
        id=p.id,
        tutor_user_id=p.tutor_user_id,
        tutor_hint=_mask_email(tutor.email if tutor else ""),
        student_user_id=p.student_user_id,
        student_hint=_mask_email(student.email if student else ""),
        title=p.title,
        goal=p.goal,
        status=p.status,
        starts_at=p.starts_at,
        target_at=p.target_at,
        created_at=p.created_at,
        updated_at=p.updated_at,
    )


def _ensure_plan_access(plan: StudyPlan, user: User) -> None:
    if user.role == "admin":
        return
    if user.role == "tutor" and plan.tutor_user_id != user.id:
        raise HTTPException(403, "no access")
    if user.role == "student" and plan.student_user_id != user.id:
        raise HTTPException(403, "no access")


@app.get("/api/plans", response_model=List[PlanOut])
def list_plans(
    student_user_id: Optional[int] = None,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    stmt = select(StudyPlan).order_by(StudyPlan.updated_at.desc())
    if user.role == "tutor":
        stmt = stmt.where(StudyPlan.tutor_user_id == user.id)
        if student_user_id:
            stmt = stmt.where(StudyPlan.student_user_id == student_user_id)
    elif user.role == "student":
        stmt = stmt.where(StudyPlan.student_user_id == user.id)
    else:
        if student_user_id:
            stmt = stmt.where(StudyPlan.student_user_id == student_user_id)
    rows = session.exec(stmt.limit(200)).all()
    return [_plan_to_out(p, session) for p in rows]


@app.post("/api/plans", response_model=PlanOut)
def create_plan(
    payload: PlanIn,
    user: User = Depends(require_role("tutor", "admin")),
    session: Session = Depends(get_session),
):
    if user.role != "admin":
        _require_tutor_student_relation(user.id, payload.student_user_id, session)
    p = StudyPlan(
        tutor_user_id=(user.id if user.role != "admin" else user.id),
        student_user_id=payload.student_user_id,
        title=(payload.title or "").strip()[:140],
        goal=(payload.goal or "").strip()[:2000],
        status="active",
        starts_at=payload.starts_at,
        target_at=payload.target_at,
        updated_at=datetime.utcnow(),
    )
    session.add(p)
    session.commit()
    session.refresh(p)
    return _plan_to_out(p, session)


@app.patch("/api/plans/{plan_id}", response_model=PlanOut)
def patch_plan(
    plan_id: int,
    payload: PlanPatch,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    p = session.get(StudyPlan, plan_id)
    if not p:
        raise HTTPException(404, "plan not found")
    _ensure_plan_access(p, user)
    if user.role == "student":
        # Students can only mark plan as completed/paused? Keep simple: no edits.
        raise HTTPException(403, "students cannot edit plan")

    if payload.title is not None:
        p.title = payload.title.strip()[:140]
    if payload.goal is not None:
        p.goal = payload.goal.strip()[:2000]
    if payload.status is not None:
        if payload.status not in {"active", "paused", "completed"}:
            raise HTTPException(400, "bad status")
        p.status = payload.status
    if payload.starts_at is not None:
        p.starts_at = payload.starts_at
    if payload.target_at is not None:
        p.target_at = payload.target_at
    p.updated_at = datetime.utcnow()
    session.add(p)
    session.commit()
    session.refresh(p)
    return _plan_to_out(p, session)


class PlanItemIn(BaseModel):
    kind: str = Field(default="milestone")
    title: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)
    due_at: Optional[datetime] = None
    status: str = Field(default="todo")
    booking_id: Optional[int] = None


class PlanItemPatch(BaseModel):
    kind: Optional[str] = None
    title: Optional[str] = Field(default=None, max_length=160)
    description: Optional[str] = Field(default=None, max_length=2000)
    due_at: Optional[datetime] = None
    status: Optional[str] = None
    order_index: Optional[int] = None
    booking_id: Optional[int] = None


class PlanItemOut(BaseModel):
    id: int
    plan_id: int
    order_index: int
    kind: str
    title: str
    description: str
    due_at: Optional[datetime]
    status: str
    booking_id: Optional[int]
    created_at: datetime
    updated_at: datetime


def _plan_item_to_out(i: PlanItem) -> PlanItemOut:
    return PlanItemOut(
        id=i.id,
        plan_id=i.plan_id,
        order_index=i.order_index,
        kind=i.kind,
        title=i.title,
        description=i.description,
        due_at=i.due_at,
        status=i.status,
        booking_id=i.booking_id,
        created_at=i.created_at,
        updated_at=i.updated_at,
    )


@app.get("/api/plans/{plan_id}/items", response_model=List[PlanItemOut])
def list_plan_items(
    plan_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    p = session.get(StudyPlan, plan_id)
    if not p:
        raise HTTPException(404, "plan not found")
    _ensure_plan_access(p, user)
    rows = session.exec(
        select(PlanItem)
        .where(PlanItem.plan_id == plan_id)
        .order_by(PlanItem.order_index.asc(), PlanItem.updated_at.desc())
    ).all()
    return [_plan_item_to_out(x) for x in rows]


@app.post("/api/plans/{plan_id}/items", response_model=PlanItemOut)
def create_plan_item(
    plan_id: int,
    payload: PlanItemIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    p = session.get(StudyPlan, plan_id)
    if not p:
        raise HTTPException(404, "plan not found")
    _ensure_plan_access(p, user)
    if user.role == "student":
        raise HTTPException(403, "students cannot create items")
    if payload.kind not in {"lesson", "milestone", "task"}:
        raise HTTPException(400, "bad kind")
    if payload.status not in {"todo", "in_progress", "done"}:
        raise HTTPException(400, "bad status")

    # Compute order_index as max + 1
    max_idx = session.exec(select(PlanItem.order_index).where(PlanItem.plan_id == plan_id).order_by(PlanItem.order_index.desc())).first()
    next_idx = int(max_idx or 0) + 1
    it = PlanItem(
        plan_id=plan_id,
        order_index=next_idx,
        kind=payload.kind,
        title=payload.title.strip()[:160],
        description=(payload.description or "").strip()[:2000],
        due_at=payload.due_at,
        status=payload.status,
        booking_id=payload.booking_id,
        updated_at=datetime.utcnow(),
    )
    session.add(it)
    p.updated_at = datetime.utcnow()
    session.add(p)
    session.commit()
    session.refresh(it)
    return _plan_item_to_out(it)


@app.patch("/api/plan-items/{item_id}", response_model=PlanItemOut)
def patch_plan_item(
    item_id: int,
    payload: PlanItemPatch,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    it = session.get(PlanItem, item_id)
    if not it:
        raise HTTPException(404, "item not found")
    p = session.get(StudyPlan, it.plan_id)
    if not p:
        raise HTTPException(404, "plan not found")
    _ensure_plan_access(p, user)

    # Students can only update status.
    if user.role == "student":
        if payload.status is None:
            raise HTTPException(403, "students can only update status")
        if payload.status not in {"todo", "in_progress", "done"}:
            raise HTTPException(400, "bad status")
        it.status = payload.status
    else:
        if payload.kind is not None:
            if payload.kind not in {"lesson", "milestone", "task"}:
                raise HTTPException(400, "bad kind")
            it.kind = payload.kind
        if payload.title is not None:
            it.title = payload.title.strip()[:160]
        if payload.description is not None:
            it.description = (payload.description or "").strip()[:2000]
        if payload.due_at is not None:
            it.due_at = payload.due_at
        if payload.status is not None:
            if payload.status not in {"todo", "in_progress", "done"}:
                raise HTTPException(400, "bad status")
            it.status = payload.status
        if payload.order_index is not None:
            it.order_index = int(payload.order_index)
        if payload.booking_id is not None:
            it.booking_id = payload.booking_id

    it.updated_at = datetime.utcnow()
    p.updated_at = datetime.utcnow()
    session.add(it)
    session.add(p)
    session.commit()
    session.refresh(it)
    return _plan_item_to_out(it)


@app.delete("/api/plan-items/{item_id}")
def delete_plan_item(
    item_id: int,
    user: User = Depends(require_role("tutor", "admin")),
    session: Session = Depends(get_session),
):
    it = session.get(PlanItem, item_id)
    if not it:
        raise HTTPException(404, "item not found")
    p = session.get(StudyPlan, it.plan_id)
    if not p:
        raise HTTPException(404, "plan not found")
    _ensure_plan_access(p, user)
    session.delete(it)
    p.updated_at = datetime.utcnow()
    session.add(p)
    session.commit()
    return {"ok": True}


# -----------------
# Student library (files/links/notes)
# -----------------


class LibraryCreateIn(BaseModel):
    title: str = Field(default="", max_length=160)
    kind: str = Field(default="link")  # link | note
    url: str = Field(default="", max_length=2000)  # for link
    note: str = Field(default="", max_length=4000)  # for note
    tags: List[str] = Field(default_factory=list)


class LibraryOut(BaseModel):
    id: int
    tutor_user_id: int
    student_user_id: int
    uploader_user_id: int
    uploader_hint: str
    title: str
    kind: str
    url: str
    tags: List[str]
    name: str
    mime: str
    size_bytes: int
    created_at: datetime
    preview: str


def _lib_to_out(x: StudentLibraryItem, session: Session) -> LibraryOut:
    up = session.get(User, x.uploader_user_id)
    try:
        tags = list(json.loads(x.tags_json or "[]"))
    except Exception:
        tags = []
    preview = ""
    if x.kind == "file":
        preview = f"{x.name} ({x.size_bytes} bytes)"
    elif x.kind == "link":
        preview = (x.url or "")[:120]
    else:
        preview = (x.url or "")[:160]
    return LibraryOut(
        id=x.id,
        tutor_user_id=x.tutor_user_id,
        student_user_id=x.student_user_id,
        uploader_user_id=x.uploader_user_id,
        uploader_hint=_mask_email(up.email if up else ""),
        title=x.title,
        kind=x.kind,
        url=x.url,
        tags=[str(t) for t in tags],
        name=x.name,
        mime=x.mime,
        size_bytes=x.size_bytes,
        created_at=x.created_at,
        preview=preview,
    )


def _ensure_library_access(tutor_id: int, student_id: int, user: User, session: Session) -> Tuple[int, int]:
    """Return (tutor_user_id, student_user_id) after validating access."""
    if user.role == "admin":
        return tutor_id, student_id
    if user.role == "student":
        if user.id != student_id:
            raise HTTPException(403, "no access")
        # Determine tutor_id as the last tutor who taught the student (best-effort)
        b = session.exec(
            select(Booking)
            .where(Booking.student_user_id == student_id)
            .order_by(Booking.created_at.desc())
            .limit(1)
        ).first()
        return (b.tutor_user_id if b else 0), student_id
    # tutor
    if tutor_id and tutor_id != user.id:
        raise HTTPException(403, "no access")
    _require_tutor_student_relation(user.id, student_id, session)
    return user.id, student_id


@app.get("/api/students/{student_id}/library", response_model=List[LibraryOut])
def list_student_library(
    student_id: int,
    tutor_user_id: int = 0,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    tid, sid = _ensure_library_access(tutor_user_id, student_id, user, session)
    stmt = select(StudentLibraryItem).where(StudentLibraryItem.student_user_id == sid)
    if tid:
        stmt = stmt.where(StudentLibraryItem.tutor_user_id == tid)
    rows = session.exec(stmt.order_by(StudentLibraryItem.created_at.desc()).limit(200)).all()
    return [_lib_to_out(x, session) for x in rows]


@app.post("/api/students/{student_id}/library", response_model=LibraryOut)
def create_library_link_or_note(
    student_id: int,
    payload: LibraryCreateIn,
    tutor_user_id: int = 0,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    tid, sid = _ensure_library_access(tutor_user_id, student_id, user, session)
    kind = (payload.kind or "link").strip().lower()
    if kind not in {"link", "note"}:
        raise HTTPException(400, "bad kind")
    title = (payload.title or "").strip()[:160]
    tags = [str(t).strip()[:40] for t in (payload.tags or []) if str(t).strip()]
    tags = tags[:20]

    url = ""
    if kind == "link":
        url = (payload.url or "").strip()[:2000]
        if not url:
            raise HTTPException(400, "url required")
    else:
        url = (payload.note or "").strip()[:4000]
        if not url:
            raise HTTPException(400, "note required")

    row = StudentLibraryItem(
        tutor_user_id=tid,
        student_user_id=sid,
        uploader_user_id=user.id,
        title=title,
        tags_json=json.dumps(tags, ensure_ascii=False),
        kind=kind,
        url=url,
        name=("link" if kind == "link" else "note"),
        mime=("text/plain" if kind == "note" else "text/uri-list"),
        size_bytes=len(url.encode("utf-8")),
        data=b"",
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return _lib_to_out(row, session)


@app.post("/api/students/{student_id}/library/upload", response_model=LibraryOut)
async def upload_library_file(
    student_id: int,
    file: UploadFile = File(...),
    title: str = "",
    tags: str = "",  # comma-separated
    tutor_user_id: int = 0,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    tid, sid = _ensure_library_access(tutor_user_id, student_id, user, session)
    data = await file.read()
    if not data:
        raise HTTPException(400, "empty file")
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(400, "file too large (max 10MB in MVP)")
    name = (file.filename or "file").strip()[:180]
    mime = (file.content_type or "application/octet-stream").strip()[:120]
    title_v = (title or name).strip()[:160]
    tag_list = [t.strip()[:40] for t in (tags or "").split(",") if t.strip()][:20]

    row = StudentLibraryItem(
        tutor_user_id=tid,
        student_user_id=sid,
        uploader_user_id=user.id,
        title=title_v,
        tags_json=json.dumps(tag_list, ensure_ascii=False),
        kind="file",
        url="",
        name=name,
        mime=mime,
        size_bytes=len(data),
        data=data,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return _lib_to_out(row, session)


@app.get("/api/library/{item_id}")
def download_library_item(
    item_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    row = session.get(StudentLibraryItem, item_id)
    if not row:
        raise HTTPException(404, "item not found")
    # Access rules:
    if user.role == "admin":
        pass
    elif user.role == "tutor":
        if row.tutor_user_id != user.id:
            raise HTTPException(403, "no access")
    else:
        if row.student_user_id != user.id:
            raise HTTPException(403, "no access")
    if row.kind != "file":
        # Return json for link/note
        return {
            "id": row.id,
            "kind": row.kind,
            "title": row.title,
            "value": row.url,
        }
    safe = "".join([c for c in (row.name or "file") if c.isalnum() or c in " ._-()"])
    if not safe:
        safe = "file"
    headers = {"Content-Disposition": f'attachment; filename="{safe}"'}
    return Response(content=row.data, media_type=row.mime, headers=headers)


# -----------------
# Quizzes (templates + attempts with auto-check)
# -----------------


class QuizIn(BaseModel):
    student_user_id: int
    title: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)


class QuizPatch(BaseModel):
    title: Optional[str] = Field(default=None, max_length=160)
    description: Optional[str] = Field(default=None, max_length=2000)
    status: Optional[str] = None  # draft|published|closed


class QuizOut(BaseModel):
    id: int
    tutor_user_id: int
    tutor_hint: str
    student_user_id: int
    student_hint: str
    title: str
    description: str
    status: str
    questions_count: int
    attempts_count: int
    updated_at: datetime
    created_at: datetime


def _quiz_to_out(q: Quiz, session: Session) -> QuizOut:
    tutor = session.get(User, q.tutor_user_id)
    student = session.get(User, q.student_user_id)
    qc = session.exec(select(QuizQuestion).where(QuizQuestion.quiz_id == q.id)).all()
    ac = session.exec(select(QuizAttempt).where(QuizAttempt.quiz_id == q.id)).all()
    return QuizOut(
        id=q.id,
        tutor_user_id=q.tutor_user_id,
        tutor_hint=_mask_email(tutor.email if tutor else ""),
        student_user_id=q.student_user_id,
        student_hint=_mask_email(student.email if student else ""),
        title=q.title,
        description=q.description,
        status=q.status,
        questions_count=len(qc),
        attempts_count=len(ac),
        updated_at=q.updated_at,
        created_at=q.created_at,
    )


def _ensure_quiz_access(q: Quiz, user: User) -> None:
    if user.role == "admin":
        return
    if user.role == "tutor" and q.tutor_user_id != user.id:
        raise HTTPException(403, "no access")
    if user.role == "student" and q.student_user_id != user.id:
        raise HTTPException(403, "no access")


@app.get("/api/quizzes", response_model=List[QuizOut])
def list_quizzes(
    student_user_id: Optional[int] = None,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    stmt = select(Quiz).order_by(Quiz.updated_at.desc())
    if user.role == "tutor":
        stmt = stmt.where(Quiz.tutor_user_id == user.id)
        if student_user_id:
            stmt = stmt.where(Quiz.student_user_id == student_user_id)
    elif user.role == "student":
        stmt = stmt.where(Quiz.student_user_id == user.id).where(Quiz.status != "draft")
    rows = session.exec(stmt.limit(200)).all()
    return [_quiz_to_out(x, session) for x in rows]


@app.post("/api/quizzes", response_model=QuizOut)
def create_quiz(
    payload: QuizIn,
    user: User = Depends(require_role("tutor", "admin")),
    session: Session = Depends(get_session),
):
    if user.role != "admin":
        _require_tutor_student_relation(user.id, payload.student_user_id, session)
    q = Quiz(
        tutor_user_id=user.id,
        student_user_id=payload.student_user_id,
        title=payload.title.strip()[:160],
        description=(payload.description or "").strip()[:2000],
        status="draft",
        updated_at=datetime.utcnow(),
    )
    session.add(q)
    session.commit()
    session.refresh(q)
    return _quiz_to_out(q, session)


@app.patch("/api/quizzes/{quiz_id}", response_model=QuizOut)
def patch_quiz(
    quiz_id: int,
    payload: QuizPatch,
    user: User = Depends(require_role("tutor", "admin")),
    session: Session = Depends(get_session),
):
    q = session.get(Quiz, quiz_id)
    if not q:
        raise HTTPException(404, "quiz not found")
    _ensure_quiz_access(q, user)
    if payload.title is not None:
        q.title = payload.title.strip()[:160]
    if payload.description is not None:
        q.description = (payload.description or "").strip()[:2000]
    if payload.status is not None:
        if payload.status not in {"draft", "published", "closed"}:
            raise HTTPException(400, "bad status")
        q.status = payload.status
    q.updated_at = datetime.utcnow()
    session.add(q)
    session.commit()
    session.refresh(q)
    return _quiz_to_out(q, session)


class QuizQuestionIn(BaseModel):
    kind: str = Field(default="mcq")  # mcq|short
    prompt: str = Field(min_length=1, max_length=1200)
    options: List[str] = Field(default_factory=list)
    correct_index: Optional[int] = None
    accepted_answers: List[str] = Field(default_factory=list)
    points: int = Field(default=1, ge=1, le=20)


class QuizQuestionOut(BaseModel):
    id: int
    quiz_id: int
    kind: str
    prompt: str
    options: List[str]
    points: int
    order_index: int


def _qq_to_out(q: QuizQuestion) -> QuizQuestionOut:
    try:
        opts = list(json.loads(q.options_json or "[]"))
    except Exception:
        opts = []
    return QuizQuestionOut(
        id=q.id,
        quiz_id=q.quiz_id,
        kind=q.kind,
        prompt=q.prompt,
        options=[str(x) for x in opts],
        points=q.points,
        order_index=q.order_index,
    )


@app.get("/api/quizzes/{quiz_id}/questions", response_model=List[QuizQuestionOut])
def list_quiz_questions(
    quiz_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    q = session.get(Quiz, quiz_id)
    if not q:
        raise HTTPException(404, "quiz not found")
    _ensure_quiz_access(q, user)
    if user.role == "student" and q.status != "published":
        raise HTTPException(403, "quiz not published")
    rows = session.exec(select(QuizQuestion).where(QuizQuestion.quiz_id == quiz_id).order_by(QuizQuestion.order_index.asc())).all()
    return [_qq_to_out(x) for x in rows]


@app.post("/api/quizzes/{quiz_id}/questions", response_model=List[QuizQuestionOut])
def add_quiz_question(
    quiz_id: int,
    payload: QuizQuestionIn,
    user: User = Depends(require_role("tutor", "admin")),
    session: Session = Depends(get_session),
):
    q = session.get(Quiz, quiz_id)
    if not q:
        raise HTTPException(404, "quiz not found")
    _ensure_quiz_access(q, user)
    if q.status == "closed":
        raise HTTPException(400, "quiz is closed")

    kind = (payload.kind or "mcq").strip()
    if kind not in {"mcq", "short"}:
        raise HTTPException(400, "bad kind")
    opts = [str(x)[:240] for x in (payload.options or []) if str(x).strip()][:10]

    correct = {}
    if kind == "mcq":
        if payload.correct_index is None:
            raise HTTPException(400, "correct_index required")
        if payload.correct_index < 0 or payload.correct_index >= max(1, len(opts)):
            raise HTTPException(400, "correct_index out of range")
        correct = {"index": int(payload.correct_index)}
    else:
        answers = [str(a).strip()[:120] for a in (payload.accepted_answers or []) if str(a).strip()]
        answers = answers[:10]
        if not answers:
            raise HTTPException(400, "accepted_answers required")
        correct = {"answers": answers}

    max_idx = session.exec(select(QuizQuestion.order_index).where(QuizQuestion.quiz_id == quiz_id).order_by(QuizQuestion.order_index.desc())).first()
    next_idx = int(max_idx or 0) + 1
    qq = QuizQuestion(
        quiz_id=quiz_id,
        kind=kind,
        prompt=payload.prompt.strip()[:1200],
        options_json=json.dumps(opts, ensure_ascii=False),
        correct_json=json.dumps(correct, ensure_ascii=False),
        points=int(payload.points),
        order_index=next_idx,
    )
    session.add(qq)
    q.updated_at = datetime.utcnow()
    session.add(q)
    session.commit()
    rows = session.exec(select(QuizQuestion).where(QuizQuestion.quiz_id == quiz_id).order_by(QuizQuestion.order_index.asc())).all()
    return [_qq_to_out(x) for x in rows]


class QuizQuestionPatch(BaseModel):
    prompt: Optional[str] = Field(default=None, max_length=1200)
    options: Optional[List[str]] = None
    correct_index: Optional[int] = None
    accepted_answers: Optional[List[str]] = None
    points: Optional[int] = Field(default=None, ge=1, le=20)
    order_index: Optional[int] = None


@app.patch("/api/quiz-questions/{question_id}", response_model=QuizQuestionOut)
def patch_quiz_question(
    question_id: int,
    payload: QuizQuestionPatch,
    user: User = Depends(require_role("tutor", "admin")),
    session: Session = Depends(get_session),
):
    qq = session.get(QuizQuestion, question_id)
    if not qq:
        raise HTTPException(404, "question not found")
    q = session.get(Quiz, qq.quiz_id)
    if not q:
        raise HTTPException(404, "quiz not found")
    _ensure_quiz_access(q, user)
    if q.status == "closed":
        raise HTTPException(400, "quiz is closed")

    if payload.prompt is not None:
        qq.prompt = payload.prompt.strip()[:1200]
    if payload.points is not None:
        qq.points = int(payload.points)
    if payload.order_index is not None:
        qq.order_index = int(payload.order_index)

    # Correct/Options update
    if qq.kind == "mcq":
        if payload.options is not None:
            opts = [str(x)[:240] for x in (payload.options or []) if str(x).strip()][:10]
            qq.options_json = json.dumps(opts, ensure_ascii=False)
        if payload.correct_index is not None:
            correct = {"index": int(payload.correct_index)}
            qq.correct_json = json.dumps(correct, ensure_ascii=False)
    else:
        if payload.accepted_answers is not None:
            answers = [str(a).strip()[:120] for a in (payload.accepted_answers or []) if str(a).strip()][:10]
            correct = {"answers": answers}
            qq.correct_json = json.dumps(correct, ensure_ascii=False)

    session.add(qq)
    q.updated_at = datetime.utcnow()
    session.add(q)
    session.commit()
    session.refresh(qq)
    return _qq_to_out(qq)


@app.delete("/api/quiz-questions/{question_id}")
def delete_quiz_question(
    question_id: int,
    user: User = Depends(require_role("tutor", "admin")),
    session: Session = Depends(get_session),
):
    qq = session.get(QuizQuestion, question_id)
    if not qq:
        raise HTTPException(404, "question not found")
    q = session.get(Quiz, qq.quiz_id)
    if not q:
        raise HTTPException(404, "quiz not found")
    _ensure_quiz_access(q, user)
    if q.status == "closed":
        raise HTTPException(400, "quiz is closed")
    session.delete(qq)
    q.updated_at = datetime.utcnow()
    session.add(q)
    session.commit()
    return {"ok": True}


class AttemptStartOut(BaseModel):
    attempt_id: int
    quiz: QuizOut
    questions: List[QuizQuestionOut]


@app.post("/api/quizzes/{quiz_id}/attempts/start", response_model=AttemptStartOut)
def start_attempt(
    quiz_id: int,
    user: User = Depends(require_role("student", "admin")),
    session: Session = Depends(get_session),
):
    q = session.get(Quiz, quiz_id)
    if not q:
        raise HTTPException(404, "quiz not found")
    if user.role != "admin":
        _ensure_quiz_access(q, user)
        if q.status != "published":
            raise HTTPException(400, "quiz not available")
    qs = session.exec(select(QuizQuestion).where(QuizQuestion.quiz_id == quiz_id).order_by(QuizQuestion.order_index.asc())).all()
    if not qs:
        raise HTTPException(400, "no questions")
    at = QuizAttempt(
        quiz_id=quiz_id,
        tutor_user_id=q.tutor_user_id,
        student_user_id=(q.student_user_id if user.role != "admin" else q.student_user_id),
        started_at=datetime.utcnow(),
        max_score=sum(int(x.points or 1) for x in qs),
        score=0,
        answers_json="[]",
    )
    session.add(at)
    session.commit()
    session.refresh(at)
    return AttemptStartOut(attempt_id=at.id, quiz=_quiz_to_out(q, session), questions=[_qq_to_out(x) for x in qs])


class AttemptSubmitIn(BaseModel):
    answers: List[dict] = Field(default_factory=list)  # [{question_id, answer}]


class AttemptOut(BaseModel):
    id: int
    quiz_id: int
    student_user_id: int
    started_at: datetime
    submitted_at: Optional[datetime]
    score: int
    max_score: int
    answers: List[dict]


def _attempt_to_out(a: QuizAttempt) -> AttemptOut:
    try:
        ans = list(json.loads(a.answers_json or "[]"))
    except Exception:
        ans = []
    return AttemptOut(
        id=a.id,
        quiz_id=a.quiz_id,
        student_user_id=a.student_user_id,
        started_at=a.started_at,
        submitted_at=a.submitted_at,
        score=a.score,
        max_score=a.max_score,
        answers=ans,
    )


def _normalize(s: str) -> str:
    return " ".join((s or "").strip().lower().split())


@app.post("/api/attempts/{attempt_id}/submit", response_model=AttemptOut)
def submit_attempt(
    attempt_id: int,
    payload: AttemptSubmitIn,
    user: User = Depends(require_role("student", "admin")),
    session: Session = Depends(get_session),
):
    at = session.get(QuizAttempt, attempt_id)
    if not at:
        raise HTTPException(404, "attempt not found")
    q = session.get(Quiz, at.quiz_id)
    if not q:
        raise HTTPException(404, "quiz not found")
    if user.role != "admin" and at.student_user_id != user.id:
        raise HTTPException(403, "no access")
    if at.submitted_at is not None:
        return _attempt_to_out(at)

    qs = session.exec(select(QuizQuestion).where(QuizQuestion.quiz_id == at.quiz_id)).all()
    qmap = {x.id: x for x in qs if x and x.id}
    answers = payload.answers or []

    score = 0
    max_score = sum(int(x.points or 1) for x in qs)
    graded_answers = []
    for item in answers:
        try:
            qid = int(item.get("question_id"))
        except Exception:
            continue
        if qid not in qmap:
            continue
        qq = qmap[qid]
        ans_val = item.get("answer")
        ok = False
        if qq.kind == "mcq":
            try:
                correct = json.loads(qq.correct_json or "{}")
            except Exception:
                correct = {}
            cidx = int(correct.get("index") or 0)
            try:
                aidx = int(ans_val)
            except Exception:
                aidx = -1
            ok = aidx == cidx
        else:
            try:
                correct = json.loads(qq.correct_json or "{}")
            except Exception:
                correct = {}
            accepted = [ _normalize(x) for x in (correct.get("answers") or []) ]
            ok = _normalize(str(ans_val or "")) in set(accepted)
        if ok:
            score += int(qq.points or 1)
        graded_answers.append({"question_id": qid, "answer": ans_val, "ok": ok, "points": int(qq.points or 1)})

    at.score = int(score)
    at.max_score = int(max_score)
    at.answers_json = json.dumps(graded_answers, ensure_ascii=False)
    at.submitted_at = datetime.utcnow()
    session.add(at)
    session.commit()
    session.refresh(at)
    return _attempt_to_out(at)


@app.get("/api/quizzes/{quiz_id}/attempts", response_model=List[AttemptOut])
def list_attempts(
    quiz_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    q = session.get(Quiz, quiz_id)
    if not q:
        raise HTTPException(404, "quiz not found")
    _ensure_quiz_access(q, user)
    stmt = select(QuizAttempt).where(QuizAttempt.quiz_id == quiz_id).order_by(QuizAttempt.started_at.desc()).limit(200)
    if user.role == "student":
        stmt = stmt.where(QuizAttempt.student_user_id == user.id)
    rows = session.exec(stmt).all()
    return [_attempt_to_out(x) for x in rows]


class WSManager:
    def __init__(self):
        # key: (channel, room_id)
        self.rooms: Dict[Tuple[str, str], List[WebSocket]] = {}

    async def connect(self, channel: str, room_id: str, ws: WebSocket):
        await ws.accept()
        key = (channel, room_id)
        self.rooms.setdefault(key, []).append(ws)

    def disconnect(self, channel: str, room_id: str, ws: WebSocket):
        key = (channel, room_id)
        if key in self.rooms and ws in self.rooms[key]:
            self.rooms[key].remove(ws)
        if key in self.rooms and not self.rooms[key]:
            self.rooms.pop(key, None)

    async def broadcast(self, channel: str, room_id: str, message: Any, sender: WebSocket):
        key = (channel, room_id)
        for ws in list(self.rooms.get(key, [])):
            if ws is sender:
                continue
            try:
                await ws.send_json(message)
            except Exception:
                self.disconnect(channel, room_id, ws)


manager = WSManager()


def _user_from_token(token: str, session: Session) -> User:
    # WebSocket auth uses the same access token as HTTP.
    _, user = decode_and_get_user(token, session, expected_typ="access")
    return user

async def _ws_auth(ws: WebSocket, session: Session) -> User:
    token = ws.query_params.get("token")
    if not token:
        await ws.close(code=4401)
        raise HTTPException(401, "Missing token")
    return _user_from_token(token, session)


@app.websocket("/ws/{channel}/{room_id}")
async def ws_room(ws: WebSocket, channel: str, room_id: str):
    if channel not in {"signaling", "whiteboard", "chat"}:
        await ws.close(code=4404)
        return

    # Use a session per connection
    from db import engine

    with Session(engine) as session:
        user = await _ws_auth(ws, session)

        # Room access control (important for production even in MVP)
        try:
            _require_room_access(room_id, user, session)
        except HTTPException:
            await ws.close(code=4403)
            return

        await manager.connect(channel, room_id, ws)

        try:
            await manager.broadcast(channel, room_id, {"type": "peer-joined", "userId": user.id}, sender=ws)
            while True:
                data = await ws.receive_text()
                try:
                    msg = json.loads(data)
                except Exception:
                    msg = {"type": "raw", "data": data}

                if isinstance(msg, dict):
                    msg.setdefault("fromUserId", user.id)

                await manager.broadcast(channel, room_id, msg, sender=ws)
        except WebSocketDisconnect:
            manager.disconnect(channel, room_id, ws)
            await manager.broadcast(channel, room_id, {"type": "peer-left", "userId": user.id}, sender=ws)
        except Exception:
            manager.disconnect(channel, room_id, ws)
            try:
                await ws.close(code=1011)
            except Exception:
                pass



# -----------------
# Growth & Retention extensions (MVP+): parent notifications, recommendations,
# recurring bookings, waitlist, last-minute alerts, exam mode, pulse, templates, CRM.
# -----------------


def _notif_key_for_user(u: Optional[User], fallback: str = "") -> str:
    if not u:
        return fallback or "unknown"
    return f"user:{u.id}:{u.email or ''}"


def _notification_exists(session: Session, recipient_key: str, entity_kind: str, entity_id: int, kind: str) -> bool:
    row = session.exec(
        select(NotificationLog)
        .where(NotificationLog.recipient_key == recipient_key)
        .where(NotificationLog.entity_kind == entity_kind)
        .where(NotificationLog.entity_id == int(entity_id))
        .where(NotificationLog.kind == kind)
    ).first()
    return bool(row)


def _notification_mark(session: Session, recipient_key: str, entity_kind: str, entity_id: int, kind: str, note: str = "") -> None:
    session.add(NotificationLog(
        recipient_key=recipient_key[:300],
        entity_kind=entity_kind[:40],
        entity_id=int(entity_id),
        kind=kind[:80],
        note=(note or "")[:500],
    ))


def _get_parent_contact(session: Session, student_user_id: int) -> Optional[ParentContact]:
    return session.exec(select(ParentContact).where(ParentContact.student_user_id == int(student_user_id))).first()


def _send_parent_contact(contact: ParentContact, subject: str, text_body: str) -> None:
    if not contact or not bool(getattr(contact, "is_active", True)):
        return
    em = str(getattr(contact, "parent_email", "") or "").strip()
    tg = str(getattr(contact, "parent_telegram_chat_id", "") or "").strip()
    if em:
        _send_email(em, subject, text_body)
    if tg:
        _send_telegram(tg, text_body)


def _parent_recipient_keys(contact: Optional[ParentContact]) -> List[str]:
    if not contact:
        return []
    out: List[str] = []
    em = str(getattr(contact, 'parent_email', '') or '').strip()
    tg = str(getattr(contact, 'parent_telegram_chat_id', '') or '').strip()
    if em:
        out.append(f"parent_email:{em.lower()}")
    if tg:
        out.append(f"parent_tg:{tg}")
    if not out:
        out.append(f"parent_student:{contact.student_user_id}")
    return out


def _get_or_create_booking_meta(session: Session, booking_id: int) -> BookingMeta:
    m = session.exec(select(BookingMeta).where(BookingMeta.booking_id == int(booking_id))).first()
    if m:
        return m
    m = BookingMeta(booking_id=int(booking_id), booking_type="regular")
    session.add(m)
    session.commit()
    session.refresh(m)
    return m


def _booking_meta_to_out(m: Optional[BookingMeta]) -> Dict[str, Any]:
    if not m:
        return {
            "booking_id": None,
            "booking_type": "regular",
            "tutor_comment": "",
            "tutor_comment_sent_at": None,
            "recurring_series_id": None,
            "is_trial": False,
        }
    return {
        "booking_id": m.booking_id,
        "booking_type": str(getattr(m, 'booking_type', 'regular') or 'regular'),
        "tutor_comment": str(getattr(m, 'tutor_comment', '') or ''),
        "tutor_comment_sent_at": getattr(m, 'tutor_comment_sent_at', None),
        "recurring_series_id": getattr(m, 'recurring_series_id', None),
        "is_trial": str(getattr(m, 'booking_type', 'regular') or 'regular') == 'trial',
    }


def _render_template_text(body: str, booking: Optional[Booking], session: Session, student: Optional[User] = None, tutor: Optional[User] = None) -> str:
    txt = str(body or "")
    slot = _slot_for_booking(booking, session) if booking else None
    if booking and not student:
        student = session.get(User, booking.student_user_id)
    if booking and not tutor:
        tutor = session.get(User, booking.tutor_user_id)
    tutor_profile = session.exec(select(TutorProfile).where(TutorProfile.user_id == booking.tutor_user_id)).first() if booking else None
    replacements = {
        "{{student_email}}": student.email if student else "",
        "{{student_mask}}": _mask_email(student.email if student else ""),
        "{{tutor_email}}": tutor.email if tutor else "",
        "{{tutor_name}}": getattr(tutor_profile, 'display_name', '') if tutor_profile else "",
        "{{booking_id}}": str(booking.id) if booking else "",
        "{{room_id}}": f"booking-{booking.id}" if booking else "",
        "{{slot_start}}": slot.starts_at.isoformat() if slot else "",
        "{{slot_end}}": slot.ends_at.isoformat() if slot else "",
    }
    for k, v in replacements.items():
        txt = txt.replace(k, str(v or ""))
    return txt


def _related_students_for_tutor(session: Session, tutor_user_id: int) -> List[int]:
    rows = session.exec(select(Booking).where(Booking.tutor_user_id == int(tutor_user_id))).all()
    return sorted({int(r.student_user_id) for r in rows if r})


def _has_tutor_student_relation(session: Session, tutor_user_id: int, student_user_id: int) -> bool:
    return bool(session.exec(select(Booking).where(Booking.tutor_user_id == int(tutor_user_id)).where(Booking.student_user_id == int(student_user_id))).first())


def _weekly_digest_for_tutor(session: Session, tutor_user_id: int, now: Optional[datetime] = None) -> Dict[str, Any]:
    now = _as_utc(now or _utcnow()) or _utcnow()
    since = now - timedelta(days=7)
    bookings = session.exec(select(Booking).where(Booking.tutor_user_id == int(tutor_user_id))).all()
    done = 0
    cancelled = 0
    new_students = set()
    all_students = set()
    last_seen: Dict[int, datetime] = {}
    for b in bookings:
        all_students.add(int(b.student_user_id))
        if b.created_at and _as_utc(b.created_at) and _as_utc(b.created_at) >= since:
            new_students.add(int(b.student_user_id))
        if _as_utc(b.created_at) and _as_utc(b.created_at) >= since:
            if str(b.status) in {"done", "completed"}:
                done += 1
            if str(b.status) == "cancelled":
                cancelled += 1
        slot = _slot_for_booking(b, session)
        if slot and slot.starts_at:
            ss = _as_utc(slot.starts_at)
            if ss:
                cur = last_seen.get(int(b.student_user_id))
                if not cur or ss > cur:
                    last_seen[int(b.student_user_id)] = ss
    dormant = []
    for sid in sorted(all_students):
        ls = last_seen.get(sid)
        if not ls or (now - ls).days >= 14:
            u = session.get(User, sid)
            dormant.append({"student_user_id": sid, "student_hint": _mask_email(u.email if u else ""), "last_lesson_at": ls.isoformat() if ls else None})
    txs = session.exec(select(BalanceTx).where(BalanceTx.user_id == int(tutor_user_id))).all()
    earnings_7d = sum(int(t.amount or 0) for t in txs if str(getattr(t, 'kind', '')) == 'earn' and (_as_utc(t.created_at) or now) >= since)
    return {
        "range_from": since.isoformat(),
        "range_to": now.isoformat(),
        "lessons_done": done,
        "cancelled": cancelled,
        "new_students": len(new_students),
        "dormant_students": dormant[:20],
        "earnings_7d": earnings_7d,
    }


def _student_pulse(session: Session, student_user_id: int) -> Dict[str, Any]:
    bookings = session.exec(select(Booking).where(Booking.student_user_id == int(student_user_id))).all()
    total = len(bookings)
    done = sum(1 for b in bookings if str(b.status) in {"done", "completed"})
    cancelled = sum(1 for b in bookings if str(b.status) == "cancelled")
    attended_confirmed = sum(1 for b in bookings if str(getattr(b, 'student_attendance_status', '')) == 'confirmed')
    attendance_pct = int(round((done / max(1, total)) * 100)) if total else 0
    hw = session.exec(select(Homework).where(Homework.student_user_id == int(student_user_id))).all()
    hw_total = len(hw)
    hw_done = sum(1 for h in hw if str(h.status) == 'checked')
    hw_submitted = sum(1 for h in hw if str(h.status) in {'submitted', 'checked'})
    homework_completion_pct = int(round((hw_submitted / max(1, hw_total)) * 100)) if hw_total else 0
    quizzes = session.exec(select(QuizAttempt).where(QuizAttempt.student_user_id == int(student_user_id))).all()
    quiz_scores = []
    for a in quizzes:
        if int(getattr(a, 'max_score', 0) or 0) > 0 and getattr(a, 'submitted_at', None):
            quiz_scores.append(100.0 * float(a.score or 0) / float(a.max_score or 1))
    avg_quiz = round(sum(quiz_scores)/len(quiz_scores), 1) if quiz_scores else None
    topics = session.exec(select(TopicProgress).where(TopicProgress.student_user_id == int(student_user_id))).all()
    gaps = [t.topic for t in topics if str(getattr(t, 'status', '')) != 'done']
    exam = session.exec(select(ExamTrack).where(ExamTrack.student_user_id == int(student_user_id)).order_by(ExamTrack.updated_at.desc())).first()
    readiness = int(getattr(exam, 'readiness_percent', 0) or 0) if exam else 0
    return {
        "student_user_id": int(student_user_id),
        "attendance": {
            "bookings_total": total,
            "done": done,
            "cancelled": cancelled,
            "attendance_percent": attendance_pct,
            "preconfirmed_count": attended_confirmed,
        },
        "homework": {
            "total": hw_total,
            "checked": hw_done,
            "submitted_or_checked": hw_submitted,
            "completion_percent": homework_completion_pct,
        },
        "mini_tests": {
            "attempts": len(quiz_scores),
            "avg_score_percent": avg_quiz,
        },
        "gaps": {
            "count": len(gaps),
            "topics": gaps[:15],
        },
        "exam": {
            "kind": getattr(exam, 'exam_kind', None) if exam else None,
            "subject": getattr(exam, 'exam_subject', None) if exam else None,
            "readiness_percent": readiness,
            "target_score": int(getattr(exam, 'target_score', 0) or 0) if exam else 0,
            "current_score": int(getattr(exam, 'current_score', 0) or 0) if exam else 0,
            "exam_date": getattr(exam, 'exam_date', None) if exam else None,
        },
    }


def _days_until(dt: Optional[datetime]) -> Optional[int]:
    if not dt:
        return None
    now = _as_utc(_utcnow()) or _utcnow()
    dd = _as_utc(dt)
    if not dd:
        return None
    return int((dd.date() - now.date()).days)


def _slot_subjects_for_tutor(session: Session, tutor_user_id: int) -> List[str]:
    p = session.exec(select(TutorProfile).where(TutorProfile.user_id == int(tutor_user_id))).first()
    return _loads_list(getattr(p, 'subjects_json', '[]')) if p else []


def _notify_waitlist_and_last_minute_for_slot(session: Session, slot: Slot, reason: str = "slot_open") -> Dict[str, int]:
    if not slot or str(getattr(slot, 'status', '')) != 'open':
        return {"waitlist": 0, "last_minute": 0}
    sdt = _as_utc(slot.starts_at)
    if not sdt:
        return {"waitlist": 0, "last_minute": 0}
    now = _as_utc(_utcnow()) or _utcnow()
    sent_waitlist = 0
    sent_last = 0
    tutor_subjects = [str(x).lower() for x in _slot_subjects_for_tutor(session, slot.tutor_user_id)]

    # Waitlist: precise slot or tutor/time/subject match
    waits = session.exec(select(WaitlistEntry).where(WaitlistEntry.status == 'active')).all()
    for w in waits:
        if w.slot_id and int(w.slot_id) != int(slot.id):
            continue
        if w.tutor_user_id and int(w.tutor_user_id) != int(slot.tutor_user_id):
            continue
        if w.desired_from and sdt < (_as_utc(w.desired_from) or sdt):
            continue
        if w.desired_to and sdt > (_as_utc(w.desired_to) or sdt):
            continue
        subj = str(getattr(w, 'subject', '') or '').strip().lower()
        if subj and tutor_subjects and subj not in tutor_subjects:
            continue
        stu = session.get(User, w.student_user_id)
        if not stu:
            continue
        key = _notif_key_for_user(stu, f"student:{w.student_user_id}")
        if _notification_exists(session, key, 'slot', slot.id, f'waitlist_{reason}'):
            continue
        msg = f"Освободился слот #{slot.id} у репетитора #{slot.tutor_user_id}\nВремя: {slot.starts_at.isoformat()}\nМожно забронировать сейчас."
        if getattr(stu, 'notify_email', True):
            _send_email(stu.email, 'DL: слот освободился (лист ожидания)', msg)
        if getattr(stu, 'notify_telegram', False) and getattr(stu, 'telegram_chat_id', None):
            _send_telegram(stu.telegram_chat_id, msg)
        _notification_mark(session, key, 'slot', slot.id, f'waitlist_{reason}', note=f'waitlist_id={w.id}')
        w.status = 'notified'
        w.updated_at = datetime.utcnow()
        session.add(w)
        sent_waitlist += 1

    # Last-minute alerts (within 24h; "Слоты горят")
    if 0 <= int((sdt - now).total_seconds()) <= 24 * 3600:
        subs = session.exec(select(LastMinuteAlertSubscription).where(LastMinuteAlertSubscription.is_active == True)).all()  # noqa
        for sub in subs:
            if sub.tutor_user_id and int(sub.tutor_user_id) != int(slot.tutor_user_id):
                continue
            if bool(getattr(sub, 'only_today', True)) and sdt.date() != now.date():
                continue
            subj = str(getattr(sub, 'subject', '') or '').strip().lower()
            if subj and tutor_subjects and subj not in tutor_subjects:
                continue
            stu = session.get(User, sub.student_user_id)
            if not stu:
                continue
            key = _notif_key_for_user(stu, f"student:{sub.student_user_id}")
            if _notification_exists(session, key, 'slot', slot.id, 'last_minute_slot'):
                continue
            msg = f"Слоты горят 🔥\nСегодня/скоро освободилось окно: {slot.starts_at.isoformat()} — {slot.ends_at.isoformat()}\nРепетитор #{slot.tutor_user_id}, слот #{slot.id}."
            if getattr(stu, 'notify_email', True):
                _send_email(stu.email, 'DL: освободился слот (last-minute)', msg)
            if getattr(stu, 'notify_telegram', False) and getattr(stu, 'telegram_chat_id', None):
                _send_telegram(stu.telegram_chat_id, msg)
            _notification_mark(session, key, 'slot', slot.id, 'last_minute_slot', note=f'sub_id={sub.id}')
            sent_last += 1
    return {"waitlist": sent_waitlist, "last_minute": sent_last}


def _recommend_tutors_payload(session: Session, q: Optional[str] = None, subject: Optional[str] = None, goal: Optional[str] = None,
                              level: Optional[str] = None, grade: Optional[str] = None, budget: Optional[int] = None,
                              has_free_slots: bool = True, limit: int = 8) -> List[Dict[str, Any]]:
    profiles = session.exec(select(TutorProfile).where(TutorProfile.is_published == True)).all()  # noqa
    subj = str(subject or '').strip().lower()
    go = str(goal or '').strip().lower()
    lev = str(level or '').strip().lower()
    grd = str(grade or '').strip().lower()
    needle = str(q or '').strip().lower()
    limit = max(1, min(int(limit or 8), 20))

    open_slots_by_tutor: Dict[int, int] = {}
    if has_free_slots:
        for s in session.exec(select(Slot).where(Slot.status == 'open')).all():
            open_slots_by_tutor[int(s.tutor_user_id)] = open_slots_by_tutor.get(int(s.tutor_user_id), 0) + 1

    out: List[Tuple[float, Dict[str, Any]]] = []
    for p in profiles:
        subjects = [str(x).strip().lower() for x in _loads_list(getattr(p, 'subjects_json', '[]'))]
        goals = [str(x).strip().lower() for x in _loads_list(getattr(p, 'goals_json', '[]'))]
        levels = [str(x).strip().lower() for x in _loads_list(getattr(p, 'levels_json', '[]'))]
        grades = [str(x).strip().lower() for x in _loads_list(getattr(p, 'grades_json', '[]'))]
        reasons: List[str] = []
        score = 0.0
        if subj:
            if subj in subjects:
                reasons.append(f"совпадает предмет: {subject}")
                score += 4
            else:
                continue
        if go and go in goals:
            reasons.append(f"готовит к цели: {goal}")
            score += 3
        elif go:
            continue
        if lev and lev in levels:
            reasons.append(f"подходит уровень: {level}")
            score += 2
        if grd and grd in grades:
            reasons.append(f"работает с классом: {grade}")
            score += 2
        if budget is not None:
            price = int(getattr(p, 'price_per_hour', 0) or 0)
            if price <= int(budget):
                reasons.append(f"в бюджете ({price} ₽/ч)")
                score += 2
            else:
                score -= min(2, (price - int(budget)) / 1000.0)
        free_cnt = open_slots_by_tutor.get(int(p.user_id), 0)
        if has_free_slots:
            if free_cnt <= 0:
                continue
            reasons.append(f"есть свободные слоты ({free_cnt})")
            score += min(2.5, free_cnt * 0.5)
        rating = float(getattr(p, 'rating_avg', 0) or 0)
        rc = int(getattr(p, 'rating_count', 0) or 0)
        lessons = int(getattr(p, 'lessons_count', 0) or 0)
        if rating > 0:
            reasons.append(f"рейтинг {rating:.1f} ({rc} отзывов)")
            score += rating
        if lessons > 0:
            score += min(3, lessons / 15)
        # retention proxy: students with 2+ bookings / all students
        bs = session.exec(select(Booking).where(Booking.tutor_user_id == int(p.user_id))).all()
        by_student: Dict[int, int] = {}
        for b in bs:
            if str(getattr(b, 'status', '')) == 'cancelled':
                continue
            sid = int(b.student_user_id)
            by_student[sid] = by_student.get(sid, 0) + 1
        if by_student:
            retained = sum(1 for c in by_student.values() if c >= 2)
            rr = int(round(100 * retained / max(1, len(by_student))))
            reasons.append(f"retention {rr}% (повторные занятия)")
            score += rr / 50.0
        if needle:
            text = ' '.join([getattr(p, 'display_name', '') or '', getattr(p, 'bio', '') or '', getattr(p, 'education', '') or '']).lower()
            if needle in text:
                score += 1
        out.append((score, {
            "tutor": _profile_public_out(p).model_dump(),
            "score": round(score, 2),
            "why": reasons[:6],
        }))
    out.sort(key=lambda x: (-x[0], -(x[1]['tutor'].get('rating_avg') or 0), x[1]['tutor'].get('price_per_hour') or 0))
    return [x[1] for x in out[:limit]]


class ParentContactIn(BaseModel):
    parent_name: str = ""
    relationship: str = "parent"
    parent_email: str = ""
    parent_telegram_chat_id: str = ""
    notify_lessons: bool = True
    notify_homework: bool = True
    notify_comments: bool = True
    is_active: bool = True


@app.get('/api/me/parent-contact')
def get_my_parent_contact(
    user: User = Depends(require_role('student', 'admin')),
    session: Session = Depends(get_session),
):
    c = _get_parent_contact(session, user.id)
    if not c:
        return {"contact": None}
    return {"contact": {
        "id": c.id,
        "student_user_id": c.student_user_id,
        "parent_name": c.parent_name,
        "relationship": c.relationship,
        "parent_email": c.parent_email,
        "parent_telegram_chat_id": c.parent_telegram_chat_id,
        "notify_lessons": c.notify_lessons,
        "notify_homework": c.notify_homework,
        "notify_comments": c.notify_comments,
        "is_active": c.is_active,
        "updated_at": c.updated_at,
    }}


@app.put('/api/me/parent-contact')
def upsert_my_parent_contact(
    payload: ParentContactIn,
    user: User = Depends(require_role('student', 'admin')),
    session: Session = Depends(get_session),
):
    c = _get_parent_contact(session, user.id)
    if not c:
        c = ParentContact(student_user_id=user.id)
    c.parent_name = (payload.parent_name or '')[:120]
    c.relationship = (payload.relationship or 'parent')[:40]
    c.parent_email = (payload.parent_email or '').strip()[:240]
    c.parent_telegram_chat_id = (payload.parent_telegram_chat_id or '').strip()[:120]
    c.notify_lessons = bool(payload.notify_lessons)
    c.notify_homework = bool(payload.notify_homework)
    c.notify_comments = bool(payload.notify_comments)
    c.is_active = bool(payload.is_active)
    c.updated_at = datetime.utcnow()
    session.add(c)
    session.commit()
    session.refresh(c)
    return {"ok": True, "contact": {
        "id": c.id,
        "student_user_id": c.student_user_id,
        "parent_name": c.parent_name,
        "relationship": c.relationship,
        "parent_email": c.parent_email,
        "parent_telegram_chat_id": c.parent_telegram_chat_id,
        "notify_lessons": c.notify_lessons,
        "notify_homework": c.notify_homework,
        "notify_comments": c.notify_comments,
        "is_active": c.is_active,
        "updated_at": c.updated_at,
    }}


class TutorMethodologyIn(BaseModel):
    fit_for: str = ""
    lesson_flow: str = ""
    homework_load: str = ""
    first_month_plan: str = ""
    avg_results: str = ""


def _methodology_out(m: Optional[TutorMethodology]) -> Dict[str, Any]:
    if not m:
        return {"fit_for": "", "lesson_flow": "", "homework_load": "", "first_month_plan": "", "avg_results": "", "updated_at": None}
    return {
        "fit_for": m.fit_for,
        "lesson_flow": m.lesson_flow,
        "homework_load": m.homework_load,
        "first_month_plan": m.first_month_plan,
        "avg_results": m.avg_results,
        "updated_at": m.updated_at,
    }


@app.get('/api/tutors/me/methodology')
def get_my_tutor_methodology(
    user: User = Depends(require_role('tutor', 'admin')),
    session: Session = Depends(get_session),
):
    m = session.exec(select(TutorMethodology).where(TutorMethodology.tutor_user_id == user.id)).first()
    return {"methodology": _methodology_out(m)}


@app.put('/api/tutors/me/methodology')
def put_my_tutor_methodology(
    payload: TutorMethodologyIn,
    user: User = Depends(require_role('tutor', 'admin')),
    session: Session = Depends(get_session),
):
    m = session.exec(select(TutorMethodology).where(TutorMethodology.tutor_user_id == user.id)).first()
    if not m:
        m = TutorMethodology(tutor_user_id=user.id)
    m.fit_for = (payload.fit_for or '')[:3000]
    m.lesson_flow = (payload.lesson_flow or '')[:3000]
    m.homework_load = (payload.homework_load or '')[:3000]
    m.first_month_plan = (payload.first_month_plan or '')[:3000]
    m.avg_results = (payload.avg_results or '')[:2000]
    m.updated_at = datetime.utcnow()
    session.add(m)
    session.commit()
    session.refresh(m)
    return {"ok": True, "methodology": _methodology_out(m)}


@app.get('/api/tutors/{profile_id:int}/methodology')
def get_public_tutor_methodology(profile_id: int, session: Session = Depends(get_session)):
    p = session.get(TutorProfile, profile_id)
    if not p or not bool(getattr(p, 'is_published', False)):
        raise HTTPException(404, 'tutor not found')
    m = session.exec(select(TutorMethodology).where(TutorMethodology.tutor_user_id == p.user_id)).first()
    return {"methodology": _methodology_out(m)}


@app.get('/api/tutors/recommended')
def recommended_tutors(
    q: Optional[str] = None,
    subject: Optional[str] = None,
    goal: Optional[str] = None,
    level: Optional[str] = None,
    grade: Optional[str] = None,
    budget: Optional[int] = None,
    has_free_slots: bool = True,
    limit: int = 8,
    session: Session = Depends(get_session),
):
    return {"items": _recommend_tutors_payload(session, q=q, subject=subject, goal=goal, level=level, grade=grade, budget=budget, has_free_slots=has_free_slots, limit=limit)}


class BookingMetaIn(BaseModel):
    booking_type: Optional[str] = None  # regular|trial
    tutor_comment: Optional[str] = None


@app.get('/api/bookings/meta')
def list_booking_meta(
    ids: Optional[str] = None,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    idset = None
    if ids:
        try:
            idset = {int(x) for x in ids.split(',') if str(x).strip()}
        except Exception:
            idset = None
    q = select(Booking)
    if user.role == 'student':
        q = q.where(Booking.student_user_id == user.id)
    elif user.role == 'tutor':
        q = q.where(Booking.tutor_user_id == user.id)
    rows = session.exec(q).all()
    if idset is not None:
        rows = [b for b in rows if int(b.id) in idset]
    mids = [int(b.id) for b in rows]
    metas = session.exec(select(BookingMeta)).all() if mids else []
    by_bid = {int(m.booking_id): m for m in metas if int(m.booking_id) in set(mids)}
    return {"items": [{**_booking_meta_to_out(by_bid.get(int(b.id))), "booking_id": int(b.id)} for b in rows]}


@app.get('/api/bookings/{booking_id}/meta')
def get_booking_meta(
    booking_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    b = session.get(Booking, booking_id)
    if not b:
        raise HTTPException(404, 'booking not found')
    _ensure_participant(b, user)
    m = session.exec(select(BookingMeta).where(BookingMeta.booking_id == booking_id)).first()
    out = _booking_meta_to_out(m)
    out['booking_id'] = booking_id
    return {"meta": out}


@app.put('/api/bookings/{booking_id}/meta')
def upsert_booking_meta(
    booking_id: int,
    payload: BookingMetaIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    b = session.get(Booking, booking_id)
    if not b:
        raise HTTPException(404, 'booking not found')
    _ensure_participant(b, user)
    m = _get_or_create_booking_meta(session, booking_id)
    if payload.booking_type is not None:
        bt = str(payload.booking_type or '').strip().lower() or 'regular'
        if bt not in {'regular', 'trial'}:
            raise HTTPException(400, 'invalid booking_type')
        m.booking_type = bt
    if payload.tutor_comment is not None:
        if user.role == 'student':
            raise HTTPException(403, 'student cannot edit tutor comment')
        m.tutor_comment = str(payload.tutor_comment or '')[:2000]
    m.updated_at = datetime.utcnow()
    session.add(m)
    session.commit()
    session.refresh(m)
    return {"ok": True, "meta": _booking_meta_to_out(m)}


class TutorCommentIn(BaseModel):
    comment: str = Field(default='', max_length=2000)
    send_to_parent: bool = True


@app.post('/api/bookings/{booking_id}/tutor-comment')
def set_tutor_comment(
    booking_id: int,
    payload: TutorCommentIn,
    user: User = Depends(require_role('tutor', 'admin')),
    session: Session = Depends(get_session),
):
    b = session.get(Booking, booking_id)
    if not b:
        raise HTTPException(404, 'booking not found')
    if user.role != 'admin' and int(b.tutor_user_id) != int(user.id):
        raise HTTPException(403, 'no access')
    m = _get_or_create_booking_meta(session, booking_id)
    m.tutor_comment = (payload.comment or '').strip()[:2000]
    m.updated_at = datetime.utcnow()
    if payload.send_to_parent and m.tutor_comment:
        pc = _get_parent_contact(session, b.student_user_id)
        if pc and bool(getattr(pc, 'notify_comments', True)):
            slot = _slot_for_booking(b, session)
            subj = 'DL: комментарий репетитора после урока'
            body = f"Занятие #{b.id}{' (' + (slot.starts_at.isoformat() if slot else '') + ')' if slot else ''}\nКомментарий: {m.tutor_comment}"
            _send_parent_contact(pc, subj, body)
            m.tutor_comment_sent_at = datetime.utcnow()
            for rk in _parent_recipient_keys(pc):
                if not _notification_exists(session, rk, 'booking', b.id, 'parent_tutor_comment'):
                    _notification_mark(session, rk, 'booking', b.id, 'parent_tutor_comment')
    session.add(m)
    session.commit()
    session.refresh(m)
    return {"ok": True, "meta": _booking_meta_to_out(m)}


class TrialBookOut(BaseModel):
    booking: BookingOut
    trial_followup_preview: Dict[str, Any]


def _trial_followup_payload(session: Session, booking: Booking) -> Dict[str, Any]:
    slot = _slot_for_booking(booking, session)
    p = session.exec(select(TutorProfile).where(TutorProfile.user_id == booking.tutor_user_id)).first()
    subj = (_loads_list(getattr(p, 'subjects_json', '[]'))[:1] or ['предмет'])[0] if p else 'предмет'
    goal = (_loads_list(getattr(p, 'goals_json', '[]'))[:1] or ['цель'])[0] if p else 'цель'
    if slot and slot.starts_at:
        start = _as_utc(slot.starts_at) or slot.starts_at
        try:
            next_anchor = start + timedelta(days=7)
        except Exception:
            next_anchor = None
    else:
        next_anchor = None
    weeks = [
        f"Неделя 1: диагностика пробелов по теме '{subj}', базовый план и мини-тест",
        f"Неделя 2: отработка слабых тем + домашнее задание + разбор ошибок",
        f"Неделя 3: тренировка формата ({goal}) и тайм-менеджмент",
        f"Неделя 4: контрольный прогон + корректировка плана на следующий месяц",
    ]
    return {
        "goal": goal,
        "subject": subj,
        "trial_booking_id": booking.id,
        "suggested_start_next_week": next_anchor.isoformat() if next_anchor else None,
        "plan_4_weeks": weeks,
        "cta": {
            "primary": "Купить пакет / записаться на 4 занятия",
            "secondary": "Повторить слот",
            "suggested_count": 4,
        },
    }


@app.post('/api/slots/{slot_id}/book-trial', response_model=TrialBookOut)
def book_trial_slot(
    slot_id: int,
    user: User = Depends(require_role('student', 'admin')),
    session: Session = Depends(get_session),
):
    slot = session.get(Slot, slot_id)
    if not slot or str(slot.status) != 'open':
        raise HTTPException(404, 'slot not available')
    mins = int(max(1, (slot.ends_at - slot.starts_at).total_seconds() // 60))
    if mins < 15 or mins > 45:
        # still allow, but mark as trial; 20-30 min is recommended
        pass
    b = _book_existing_slot_for_student(slot, user.id, session)
    m = _get_or_create_booking_meta(session, b.id)
    m.booking_type = 'trial'
    m.updated_at = datetime.utcnow()
    session.add(m)
    session.commit()
    session.refresh(b)
    return TrialBookOut(booking=_booking_to_out(b, session), trial_followup_preview=_trial_followup_payload(session, b))


@app.get('/api/bookings/{booking_id}/trial-followup')
def get_trial_followup(
    booking_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    b = session.get(Booking, booking_id)
    if not b:
        raise HTTPException(404, 'booking not found')
    _ensure_participant(b, user)
    m = session.exec(select(BookingMeta).where(BookingMeta.booking_id == booking_id)).first()
    is_trial = bool(m and str(getattr(m, 'booking_type', '')) == 'trial')
    if not is_trial:
        slot = _slot_for_booking(b, session)
        if slot:
            mins = int(max(1, (slot.ends_at - slot.starts_at).total_seconds() // 60))
            is_trial = mins <= 35
    if not is_trial:
        raise HTTPException(400, 'booking is not marked as trial')
    return {"followup": _trial_followup_payload(session, b), "meta": _booking_meta_to_out(m)}


class CRMCardIn(BaseModel):
    goal: str = ""
    weak_topics: List[str] = []
    notes: str = ""
    tags: List[str] = []


def _crm_card_to_out(c: Optional[TutorStudentCRMCard]) -> Dict[str, Any]:
    if not c:
        return {"goal": "", "weak_topics": [], "notes": "", "tags": [], "updated_at": None}
    return {
        "id": c.id,
        "tutor_user_id": c.tutor_user_id,
        "student_user_id": c.student_user_id,
        "goal": c.goal,
        "weak_topics": _loads_list(getattr(c, 'weak_topics_json', '[]')),
        "notes": c.notes,
        "tags": _loads_list(getattr(c, 'tags_json', '[]')),
        "updated_at": c.updated_at,
    }


@app.get('/api/crm/students')
def list_crm_students(
    user: User = Depends(require_role('tutor', 'admin')),
    session: Session = Depends(get_session),
):
    if user.role == 'admin':
        return {"items": []}
    sids = _related_students_for_tutor(session, user.id)
    cards = session.exec(select(TutorStudentCRMCard).where(TutorStudentCRMCard.tutor_user_id == user.id)).all()
    by_sid = {int(c.student_user_id): c for c in cards}
    items = []
    for sid in sids:
        u = session.get(User, sid)
        pulse = _student_pulse(session, sid)
        card = by_sid.get(sid)
        items.append({
            "student_user_id": sid,
            "student_hint": _mask_email(u.email if u else ""),
            "goal": getattr(card, 'goal', '') if card else '',
            "weak_topics_count": len(_loads_list(getattr(card, 'weak_topics_json', '[]'))) if card else 0,
            "homework_completion_percent": pulse['homework']['completion_percent'],
            "attendance_percent": pulse['attendance']['attendance_percent'],
        })
    return {"items": items}


@app.get('/api/crm/students/{student_id}/summary')
def get_crm_student_summary(
    student_id: int,
    user: User = Depends(require_role('tutor', 'admin')),
    session: Session = Depends(get_session),
):
    if user.role != 'admin' and not _has_tutor_student_relation(session, user.id, student_id):
        raise HTTPException(403, 'no relation')
    tutor_id = user.id if user.role != 'admin' else None
    if user.role == 'admin':
        b_any = session.exec(select(Booking).where(Booking.student_user_id == student_id)).first()
        tutor_id = b_any.tutor_user_id if b_any else None
    card = session.exec(select(TutorStudentCRMCard).where(TutorStudentCRMCard.student_user_id == student_id).where(TutorStudentCRMCard.tutor_user_id == int(tutor_id or 0))).first() if tutor_id else None
    bookings = session.exec(select(Booking).where(Booking.student_user_id == student_id).where(Booking.tutor_user_id == int(tutor_id or 0))).all() if tutor_id else []
    lesson_notes = session.exec(select(LessonNote).where(LessonNote.student_user_id == student_id).where(LessonNote.tutor_user_id == int(tutor_id or 0)).order_by(LessonNote.updated_at.desc())).all() if tutor_id else []
    hw = session.exec(select(Homework).where(Homework.student_user_id == student_id).where(Homework.tutor_user_id == int(tutor_id or 0)).order_by(Homework.created_at.desc())).all() if tutor_id else []
    return {
        "card": _crm_card_to_out(card),
        "pulse": _student_pulse(session, student_id),
        "history": [{"booking_id": b.id, "status": b.status, "slot_starts_at": (_slot_for_booking(b, session).starts_at if _slot_for_booking(b, session) else None)} for b in bookings[:50]],
        "lesson_notes": [{"id": n.id, "booking_id": n.booking_id, "lesson_summary": n.lesson_summary, "homework_assigned": n.homework_assigned, "homework_checked": n.homework_checked, "updated_at": n.updated_at} for n in lesson_notes[:20]],
        "homework": [{"id": h.id, "title": h.title, "status": h.status, "due_at": h.due_at, "checked_at": h.checked_at} for h in hw[:30]],
    }


@app.get('/api/crm/student/{student_id}')
def get_crm_card(
    student_id: int,
    user: User = Depends(require_role('tutor', 'admin')),
    session: Session = Depends(get_session),
):
    if user.role != 'admin' and not _has_tutor_student_relation(session, user.id, student_id):
        raise HTTPException(403, 'no relation')
    tutor_id = user.id if user.role != 'admin' else (session.exec(select(Booking).where(Booking.student_user_id == student_id)).first().tutor_user_id if session.exec(select(Booking).where(Booking.student_user_id == student_id)).first() else 0)
    c = session.exec(select(TutorStudentCRMCard).where(TutorStudentCRMCard.tutor_user_id == int(tutor_id)).where(TutorStudentCRMCard.student_user_id == int(student_id))).first()
    return {"card": _crm_card_to_out(c)}


@app.post('/api/crm/student/{student_id}')
def upsert_crm_card(
    student_id: int,
    payload: CRMCardIn,
    user: User = Depends(require_role('tutor', 'admin')),
    session: Session = Depends(get_session),
):
    if user.role != 'admin' and not _has_tutor_student_relation(session, user.id, student_id):
        raise HTTPException(403, 'no relation')
    tutor_id = user.id if user.role != 'admin' else (session.exec(select(Booking).where(Booking.student_user_id == student_id)).first().tutor_user_id if session.exec(select(Booking).where(Booking.student_user_id == student_id)).first() else 0)
    c = session.exec(select(TutorStudentCRMCard).where(TutorStudentCRMCard.tutor_user_id == int(tutor_id)).where(TutorStudentCRMCard.student_user_id == int(student_id))).first()
    if not c:
        c = TutorStudentCRMCard(tutor_user_id=int(tutor_id), student_user_id=int(student_id))
    c.goal = (payload.goal or '')[:500]
    c.weak_topics_json = json.dumps([str(x).strip() for x in (payload.weak_topics or []) if str(x).strip()][:50], ensure_ascii=False)
    c.notes = (payload.notes or '')[:5000]
    c.tags_json = json.dumps([str(x).strip() for x in (payload.tags or []) if str(x).strip()][:30], ensure_ascii=False)
    c.updated_at = datetime.utcnow()
    session.add(c)
    session.commit()
    session.refresh(c)
    return {"ok": True, "card": _crm_card_to_out(c)}


class LessonNoteIn(BaseModel):
    lesson_summary: str = ""
    weak_topics: List[str] = []
    homework_assigned: str = ""
    homework_checked: str = ""
    tutor_comment_for_parent: str = ""


@app.get('/api/bookings/{booking_id}/lesson-notes')
def get_lesson_notes(
    booking_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    b = session.get(Booking, booking_id)
    if not b:
        raise HTTPException(404, 'booking not found')
    _ensure_participant(b, user)
    rows = session.exec(select(LessonNote).where(LessonNote.booking_id == booking_id).order_by(LessonNote.updated_at.desc())).all()
    return {"items": [{
        "id": n.id,
        "booking_id": n.booking_id,
        "lesson_summary": n.lesson_summary,
        "weak_topics": _loads_list(getattr(n, 'weak_topics_json', '[]')),
        "homework_assigned": n.homework_assigned,
        "homework_checked": n.homework_checked,
        "tutor_comment_for_parent": n.tutor_comment_for_parent,
        "updated_at": n.updated_at,
    } for n in rows]}


@app.post('/api/bookings/{booking_id}/lesson-notes')
def create_or_update_lesson_note(
    booking_id: int,
    payload: LessonNoteIn,
    user: User = Depends(require_role('tutor', 'admin')),
    session: Session = Depends(get_session),
):
    b = session.get(Booking, booking_id)
    if not b:
        raise HTTPException(404, 'booking not found')
    if user.role != 'admin' and int(b.tutor_user_id) != int(user.id):
        raise HTTPException(403, 'no access')
    n = session.exec(select(LessonNote).where(LessonNote.booking_id == booking_id).order_by(LessonNote.updated_at.desc())).first()
    if not n:
        n = LessonNote(booking_id=booking_id, tutor_user_id=b.tutor_user_id, student_user_id=b.student_user_id)
    n.lesson_summary = (payload.lesson_summary or '')[:4000]
    n.weak_topics_json = json.dumps([str(x).strip() for x in (payload.weak_topics or []) if str(x).strip()][:50], ensure_ascii=False)
    n.homework_assigned = (payload.homework_assigned or '')[:4000]
    n.homework_checked = (payload.homework_checked or '')[:4000]
    n.tutor_comment_for_parent = (payload.tutor_comment_for_parent or '')[:2000]
    n.updated_at = datetime.utcnow()
    session.add(n)
    if n.tutor_comment_for_parent:
        m = _get_or_create_booking_meta(session, booking_id)
        m.tutor_comment = n.tutor_comment_for_parent
        m.updated_at = datetime.utcnow()
        session.add(m)
    session.commit()
    session.refresh(n)
    return {"ok": True, "item": {
        "id": n.id,
        "booking_id": n.booking_id,
        "lesson_summary": n.lesson_summary,
        "weak_topics": _loads_list(n.weak_topics_json),
        "homework_assigned": n.homework_assigned,
        "homework_checked": n.homework_checked,
        "tutor_comment_for_parent": n.tutor_comment_for_parent,
        "updated_at": n.updated_at,
    }}


class TemplateIn(BaseModel):
    kind: str = "general"
    title: str = ""
    body: str = ""
    channel: str = "email"


@app.get('/api/templates')
def list_templates(
    user: User = Depends(require_role('tutor', 'admin')),
    session: Session = Depends(get_session),
):
    if user.role == 'admin':
        rows = session.exec(select(TutorMessageTemplate).order_by(TutorMessageTemplate.updated_at.desc())).all()
    else:
        rows = session.exec(select(TutorMessageTemplate).where(TutorMessageTemplate.tutor_user_id == user.id).order_by(TutorMessageTemplate.updated_at.desc())).all()
    return {"items": [{"id": t.id, "kind": t.kind, "title": t.title, "body": t.body, "channel": t.channel, "updated_at": t.updated_at} for t in rows]}


@app.post('/api/templates')
def create_template(
    payload: TemplateIn,
    user: User = Depends(require_role('tutor', 'admin')),
    session: Session = Depends(get_session),
):
    t = TutorMessageTemplate(
        tutor_user_id=user.id,
        kind=(payload.kind or 'general')[:40],
        title=(payload.title or '')[:140],
        body=(payload.body or '')[:4000],
        channel=((payload.channel or 'email').strip().lower() if payload.channel else 'email')[:20],
        updated_at=datetime.utcnow(),
    )
    session.add(t)
    session.commit()
    session.refresh(t)
    return {"ok": True, "template": {"id": t.id, "kind": t.kind, "title": t.title, "body": t.body, "channel": t.channel, "updated_at": t.updated_at}}


@app.patch('/api/templates/{template_id}')
def patch_template(
    template_id: int,
    payload: TemplateIn,
    user: User = Depends(require_role('tutor', 'admin')),
    session: Session = Depends(get_session),
):
    t = session.get(TutorMessageTemplate, template_id)
    if not t:
        raise HTTPException(404, 'template not found')
    if user.role != 'admin' and int(t.tutor_user_id) != int(user.id):
        raise HTTPException(403, 'no access')
    t.kind = (payload.kind or t.kind or 'general')[:40]
    t.title = (payload.title or t.title or '')[:140]
    t.body = (payload.body or t.body or '')[:4000]
    t.channel = ((payload.channel or t.channel or 'email').strip().lower())[:20]
    t.updated_at = datetime.utcnow()
    session.add(t)
    session.commit()
    session.refresh(t)
    return {"ok": True, "template": {"id": t.id, "kind": t.kind, "title": t.title, "body": t.body, "channel": t.channel, "updated_at": t.updated_at}}


@app.delete('/api/templates/{template_id}')
def delete_template(
    template_id: int,
    user: User = Depends(require_role('tutor', 'admin')),
    session: Session = Depends(get_session),
):
    t = session.get(TutorMessageTemplate, template_id)
    if not t:
        raise HTTPException(404, 'template not found')
    if user.role != 'admin' and int(t.tutor_user_id) != int(user.id):
        raise HTTPException(403, 'no access')
    session.delete(t)
    session.commit()
    return {"ok": True}


class TemplateSendIn(BaseModel):
    booking_id: Optional[int] = None
    student_user_id: Optional[int] = None
    channel: Optional[str] = None
    subject: Optional[str] = None


@app.post('/api/templates/{template_id}/send')
def send_template_message(
    template_id: int,
    payload: TemplateSendIn,
    user: User = Depends(require_role('tutor', 'admin')),
    session: Session = Depends(get_session),
):
    t = session.get(TutorMessageTemplate, template_id)
    if not t:
        raise HTTPException(404, 'template not found')
    if user.role != 'admin' and int(t.tutor_user_id) != int(user.id):
        raise HTTPException(403, 'no access')
    booking = session.get(Booking, int(payload.booking_id)) if payload.booking_id else None
    if booking and user.role != 'admin' and int(booking.tutor_user_id) != int(user.id):
        raise HTTPException(403, 'no access to booking')
    student = session.get(User, int(payload.student_user_id)) if payload.student_user_id else (session.get(User, booking.student_user_id) if booking else None)
    if not student:
        raise HTTPException(400, 'student not found')
    body = _render_template_text(t.body, booking, session, student=student)
    channel = (payload.channel or t.channel or 'email').strip().lower()
    if channel == 'telegram':
        if not getattr(student, 'telegram_chat_id', None):
            raise HTTPException(400, 'student has no telegram_chat_id')
        _send_telegram(student.telegram_chat_id, body)
    else:
        _send_email(student.email, (payload.subject or t.title or 'DL: сообщение от репетитора')[:200], body)
    return {"ok": True, "channel": channel, "preview": body}


class WaitlistIn(BaseModel):
    tutor_user_id: Optional[int] = None
    slot_id: Optional[int] = None
    subject: str = ""
    desired_from: Optional[datetime] = None
    desired_to: Optional[datetime] = None
    note: str = ""


@app.get('/api/waitlist')
def list_waitlist(user: User = Depends(require_role('student', 'admin')), session: Session = Depends(get_session)):
    q = select(WaitlistEntry)
    if user.role != 'admin':
        q = q.where(WaitlistEntry.student_user_id == user.id)
    rows = session.exec(q.order_by(WaitlistEntry.created_at.desc())).all()
    return {"items": [{
        "id": w.id,
        "student_user_id": w.student_user_id,
        "tutor_user_id": w.tutor_user_id,
        "slot_id": w.slot_id,
        "subject": w.subject,
        "desired_from": w.desired_from,
        "desired_to": w.desired_to,
        "status": w.status,
        "note": w.note,
        "updated_at": w.updated_at,
    } for w in rows]}


@app.post('/api/waitlist')
def create_waitlist(
    payload: WaitlistIn,
    user: User = Depends(require_role('student', 'admin')),
    session: Session = Depends(get_session),
):
    w = WaitlistEntry(
        student_user_id=user.id,
        tutor_user_id=payload.tutor_user_id,
        slot_id=payload.slot_id,
        subject=(payload.subject or '')[:80],
        desired_from=payload.desired_from,
        desired_to=payload.desired_to,
        note=(payload.note or '')[:500],
        status='active',
        updated_at=datetime.utcnow(),
    )
    session.add(w)
    session.commit()
    session.refresh(w)
    return {"ok": True, "item": {"id": w.id, "status": w.status}}


@app.delete('/api/waitlist/{waitlist_id}')
def delete_waitlist(waitlist_id: int, user: User = Depends(require_role('student', 'admin')), session: Session = Depends(get_session)):
    w = session.get(WaitlistEntry, waitlist_id)
    if not w:
        raise HTTPException(404, 'not found')
    if user.role != 'admin' and int(w.student_user_id) != int(user.id):
        raise HTTPException(403, 'no access')
    w.status = 'cancelled'
    w.updated_at = datetime.utcnow()
    session.add(w)
    session.commit()
    return {"ok": True}


class LastMinuteSubIn(BaseModel):
    tutor_user_id: Optional[int] = None
    subject: str = ""
    only_today: bool = True


@app.get('/api/alerts/last-minute')
def list_last_minute_alerts(user: User = Depends(require_role('student', 'admin')), session: Session = Depends(get_session)):
    q = select(LastMinuteAlertSubscription)
    if user.role != 'admin':
        q = q.where(LastMinuteAlertSubscription.student_user_id == user.id)
    rows = session.exec(q.order_by(LastMinuteAlertSubscription.created_at.desc())).all()
    return {"items": [{"id": s.id, "student_user_id": s.student_user_id, "tutor_user_id": s.tutor_user_id, "subject": s.subject, "only_today": s.only_today, "is_active": s.is_active} for s in rows]}


@app.post('/api/alerts/last-minute')
def create_last_minute_alert(
    payload: LastMinuteSubIn,
    user: User = Depends(require_role('student', 'admin')),
    session: Session = Depends(get_session),
):
    s = LastMinuteAlertSubscription(student_user_id=user.id, tutor_user_id=payload.tutor_user_id, subject=(payload.subject or '')[:80], only_today=bool(payload.only_today), is_active=True)
    session.add(s)
    session.commit()
    session.refresh(s)
    return {"ok": True, "item": {"id": s.id}}


@app.delete('/api/alerts/last-minute/{sub_id}')
def delete_last_minute_alert(sub_id: int, user: User = Depends(require_role('student', 'admin')), session: Session = Depends(get_session)):
    s = session.get(LastMinuteAlertSubscription, sub_id)
    if not s:
        raise HTTPException(404, 'not found')
    if user.role != 'admin' and int(s.student_user_id) != int(user.id):
        raise HTTPException(403, 'no access')
    s.is_active = False
    session.add(s)
    session.commit()
    return {"ok": True}


class RecurringBookingIn(BaseModel):
    tutor_user_id: int
    weekdays: List[int] = Field(default_factory=list)
    time_hm: str = '18:00'
    duration_minutes: int = 60
    weeks_ahead: int = 4
    auto_attendance_confirm: bool = False


def _slot_matches_recurring(slot: Slot, tutor_user_id: int, weekdays: List[int], hh: int, mm: int, duration_min: int, now: datetime, until: datetime) -> bool:
    if int(slot.tutor_user_id) != int(tutor_user_id):
        return False
    if str(getattr(slot, 'status', '')) != 'open':
        return False
    s = _as_utc(slot.starts_at)
    e = _as_utc(slot.ends_at)
    if not s or not e:
        return False
    if s <= now or s > until:
        return False
    if s.weekday() not in set(int(x) for x in weekdays):
        return False
    if (s.hour, s.minute) != (hh, mm):
        return False
    dur = int((e - s).total_seconds() // 60)
    if abs(dur - int(duration_min)) > 15:
        return False
    return True


@app.get('/api/recurring/bookings')
def list_recurring_series(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    q = select(RecurringBookingSeries)
    if user.role == 'student':
        q = q.where(RecurringBookingSeries.student_user_id == user.id)
    elif user.role == 'tutor':
        q = q.where(RecurringBookingSeries.tutor_user_id == user.id)
    rows = session.exec(q.order_by(RecurringBookingSeries.updated_at.desc())).all()
    items = []
    for r in rows:
        item_rows = session.exec(select(RecurringBookingSeriesItem).where(RecurringBookingSeriesItem.series_id == r.id)).all()
        items.append({
            "id": r.id,
            "tutor_user_id": r.tutor_user_id,
            "student_user_id": r.student_user_id,
            "weekdays": _loads_list(getattr(r, 'weekdays_json', '[]')),
            "time_hm": r.time_hm,
            "duration_minutes": r.duration_minutes,
            "weeks_ahead": r.weeks_ahead,
            "auto_attendance_confirm": r.auto_attendance_confirm,
            "status": r.status,
            "booked_count": len(item_rows),
            "updated_at": r.updated_at,
        })
    return {"items": items}


def _book_recurring_matches(session: Session, series: RecurringBookingSeries) -> List[int]:
    now = _as_utc(_utcnow()) or _utcnow()
    until = now + timedelta(days=max(7, int(series.weeks_ahead or 4) * 7 + 2))
    weekdays = [int(x) for x in _loads_list(getattr(series, 'weekdays_json', '[]')) if str(x).strip().isdigit()]
    try:
        hh, mm = [int(x) for x in str(series.time_hm or '18:00').split(':', 1)]
    except Exception:
        hh, mm = 18, 0
    existing_items = session.exec(select(RecurringBookingSeriesItem).where(RecurringBookingSeriesItem.series_id == series.id)).all()
    existing_booking_ids = {int(it.booking_id) for it in existing_items}
    booked_ids = []
    for slot in session.exec(select(Slot).where(Slot.tutor_user_id == int(series.tutor_user_id)).where(Slot.status == 'open').order_by(Slot.starts_at.asc())).all():
        if not _slot_matches_recurring(slot, series.tutor_user_id, weekdays, hh, mm, int(series.duration_minutes or 60), now, until):
            continue
        b = _book_existing_slot_for_student(slot, int(series.student_user_id), session)
        if bool(getattr(series, 'auto_attendance_confirm', False)):
            b.student_attendance_status = 'confirmed'
            b.student_attendance_updated_at = datetime.utcnow()
            session.add(b)
        m = _get_or_create_booking_meta(session, b.id)
        m.recurring_series_id = int(series.id)
        m.updated_at = datetime.utcnow()
        session.add(m)
        session.commit()
        if int(b.id) not in existing_booking_ids:
            session.add(RecurringBookingSeriesItem(series_id=series.id, booking_id=b.id))
            session.commit()
        booked_ids.append(int(b.id))
    return booked_ids


@app.post('/api/recurring/bookings')
def create_recurring_booking_series(
    payload: RecurringBookingIn,
    user: User = Depends(require_role('student', 'admin')),
    session: Session = Depends(get_session),
):
    weekdays = [int(x) for x in (payload.weekdays or []) if int(x) in {0,1,2,3,4,5,6}]
    if not weekdays:
        raise HTTPException(400, 'weekdays required')
    series = RecurringBookingSeries(
        tutor_user_id=int(payload.tutor_user_id),
        student_user_id=int(user.id),
        weekdays_json=json.dumps(sorted(set(weekdays))),
        time_hm=(payload.time_hm or '18:00')[:5],
        duration_minutes=max(20, min(int(payload.duration_minutes or 60), 180)),
        weeks_ahead=max(1, min(int(payload.weeks_ahead or 4), 12)),
        auto_attendance_confirm=bool(payload.auto_attendance_confirm),
        status='active',
        updated_at=datetime.utcnow(),
    )
    session.add(series)
    session.commit()
    session.refresh(series)
    booked_ids = _book_recurring_matches(session, series)
    return {"ok": True, "series_id": series.id, "booked_booking_ids": booked_ids}


@app.post('/api/recurring/bookings/{series_id}/refresh')
def refresh_recurring_booking_series(series_id: int, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    series = session.get(RecurringBookingSeries, series_id)
    if not series:
        raise HTTPException(404, 'series not found')
    if user.role == 'student' and int(series.student_user_id) != int(user.id):
        raise HTTPException(403, 'no access')
    if user.role == 'tutor' and int(series.tutor_user_id) != int(user.id):
        raise HTTPException(403, 'no access')
    booked_ids = _book_recurring_matches(session, series)
    series.updated_at = datetime.utcnow()
    session.add(series)
    session.commit()
    return {"ok": True, "booked_booking_ids": booked_ids}


class ExamModeIn(BaseModel):
    student_user_id: Optional[int] = None
    exam_kind: str = 'ЕГЭ'
    exam_subject: str = ''
    exam_date: Optional[datetime] = None
    target_score: int = 0
    current_score: int = 0
    readiness_percent: int = 0
    weak_topics: List[str] = []
    plan_by_weeks: List[str] = []
    notes: str = ''


@app.get('/api/exam-mode')
def get_exam_mode(
    student_user_id: Optional[int] = None,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    sid = int(student_user_id or user.id)
    if user.role == 'student' and sid != int(user.id):
        raise HTTPException(403, 'no access')
    if user.role == 'tutor' and not _has_tutor_student_relation(session, user.id, sid):
        raise HTTPException(403, 'no relation')
    row = session.exec(select(ExamTrack).where(ExamTrack.student_user_id == sid).order_by(ExamTrack.updated_at.desc())).first()
    if not row:
        return {"exam": None}
    return {"exam": {
        "id": row.id,
        "student_user_id": row.student_user_id,
        "tutor_user_id": row.tutor_user_id,
        "exam_kind": row.exam_kind,
        "exam_subject": row.exam_subject,
        "exam_date": row.exam_date,
        "days_left": _days_until(row.exam_date),
        "target_score": row.target_score,
        "current_score": row.current_score,
        "readiness_percent": row.readiness_percent,
        "weak_topics": _loads_list(getattr(row, 'weak_topics_json', '[]')),
        "plan_by_weeks": _loads_list(getattr(row, 'plan_by_weeks_json', '[]')),
        "notes": row.notes,
        "updated_at": row.updated_at,
    }}


@app.put('/api/exam-mode')
def put_exam_mode(
    payload: ExamModeIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    sid = int(payload.student_user_id or user.id)
    if user.role == 'student' and sid != int(user.id):
        raise HTTPException(403, 'no access')
    if user.role == 'tutor' and not _has_tutor_student_relation(session, user.id, sid):
        raise HTTPException(403, 'no relation')
    row = session.exec(select(ExamTrack).where(ExamTrack.student_user_id == sid)).first()
    if not row:
        row = ExamTrack(student_user_id=sid)
    row.tutor_user_id = user.id if user.role == 'tutor' else getattr(row, 'tutor_user_id', None)
    row.exam_kind = (payload.exam_kind or 'ЕГЭ')[:40]
    row.exam_subject = (payload.exam_subject or '')[:80]
    row.exam_date = payload.exam_date
    row.target_score = max(0, min(int(payload.target_score or 0), 1000))
    row.current_score = max(0, min(int(payload.current_score or 0), 1000))
    row.readiness_percent = max(0, min(int(payload.readiness_percent or 0), 100))
    row.weak_topics_json = json.dumps([str(x).strip() for x in (payload.weak_topics or []) if str(x).strip()][:80], ensure_ascii=False)
    row.plan_by_weeks_json = json.dumps([str(x).strip() for x in (payload.plan_by_weeks or []) if str(x).strip()][:52], ensure_ascii=False)
    row.notes = (payload.notes or '')[:5000]
    row.updated_at = datetime.utcnow()
    session.add(row)
    session.commit()
    session.refresh(row)
    return {"ok": True, "exam": {
        "id": row.id,
        "student_user_id": row.student_user_id,
        "exam_kind": row.exam_kind,
        "exam_subject": row.exam_subject,
        "exam_date": row.exam_date,
        "days_left": _days_until(row.exam_date),
        "target_score": row.target_score,
        "current_score": row.current_score,
        "readiness_percent": row.readiness_percent,
        "weak_topics": _loads_list(row.weak_topics_json),
        "plan_by_weeks": _loads_list(row.plan_by_weeks_json),
        "notes": row.notes,
        "updated_at": row.updated_at,
    }}


@app.get('/api/pulse/mine')
def get_my_pulse(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    if user.role == 'tutor':
        items = []
        for sid in _related_students_for_tutor(session, user.id):
            u = session.get(User, sid)
            p = _student_pulse(session, sid)
            items.append({"student_user_id": sid, "student_hint": _mask_email(u.email if u else ''), **p})
        return {"items": items}
    return {"pulse": _student_pulse(session, user.id)}


@app.get('/api/pulse/student/{student_id}')
def get_student_pulse(student_id: int, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    if user.role == 'student' and int(student_id) != int(user.id):
        raise HTTPException(403, 'no access')
    if user.role == 'tutor' and not _has_tutor_student_relation(session, user.id, student_id):
        raise HTTPException(403, 'no relation')
    return {"pulse": _student_pulse(session, student_id)}


class ReviewDetailIn(BaseModel):
    explains_rating: Optional[int] = Field(default=None, ge=1, le=5)
    punctuality_rating: Optional[int] = Field(default=None, ge=1, le=5)
    materials_rating: Optional[int] = Field(default=None, ge=1, le=5)
    result_rating: Optional[int] = Field(default=None, ge=1, le=5)


@app.post('/api/bookings/{booking_id}/review/details')
def upsert_review_detail(
    booking_id: int,
    payload: ReviewDetailIn,
    user: User = Depends(require_role('student', 'admin')),
    session: Session = Depends(get_session),
):
    booking = session.get(Booking, booking_id)
    if not booking or (user.role != 'admin' and int(booking.student_user_id) != int(user.id)):
        raise HTTPException(404, 'booking not found')
    review = session.exec(select(Review).where(Review.booking_id == booking_id)).first()
    if not review:
        raise HTTPException(400, 'create base review first')
    d = session.exec(select(ReviewDetail).where(ReviewDetail.review_id == review.id)).first()
    if not d:
        d = ReviewDetail(review_id=review.id)
    for attr in ['explains_rating','punctuality_rating','materials_rating','result_rating']:
        val = getattr(payload, attr)
        if val is not None:
            setattr(d, attr, int(val))
    lessons_before = len(session.exec(select(Booking).where(Booking.student_user_id == booking.student_user_id).where(Booking.tutor_user_id == booking.tutor_user_id).where(Booking.status.in_(['done','completed']))).all())
    d.lessons_before_review = max(int(getattr(d, 'lessons_before_review', 0) or 0), int(lessons_before))
    d.updated_at = datetime.utcnow()
    session.add(d)
    session.commit()
    session.refresh(d)
    return {"ok": True, "detail": {
        "review_id": d.review_id,
        "explains_rating": d.explains_rating,
        "punctuality_rating": d.punctuality_rating,
        "materials_rating": d.materials_rating,
        "result_rating": d.result_rating,
        "lessons_before_review": d.lessons_before_review,
        "long_term_student": bool(int(d.lessons_before_review or 0) >= 10),
    }}


@app.get('/api/bookings/{booking_id}/review/details')
def get_review_detail(booking_id: int, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    booking = session.get(Booking, booking_id)
    if not booking:
        raise HTTPException(404, 'booking not found')
    _ensure_participant(booking, user)
    review = session.exec(select(Review).where(Review.booking_id == booking_id)).first()
    if not review:
        return {"detail": None}
    d = session.exec(select(ReviewDetail).where(ReviewDetail.review_id == review.id)).first()
    if not d:
        return {"detail": None}
    return {"detail": {
        "review_id": d.review_id,
        "explains_rating": d.explains_rating,
        "punctuality_rating": d.punctuality_rating,
        "materials_rating": d.materials_rating,
        "result_rating": d.result_rating,
        "lessons_before_review": d.lessons_before_review,
        "long_term_student": bool(int(d.lessons_before_review or 0) >= 10),
    }}


@app.get('/api/tutors/{profile_id:int}/reviews/extended')
def list_tutor_reviews_extended(profile_id: int, session: Session = Depends(get_session)):
    p = session.get(TutorProfile, profile_id)
    if not p or not bool(getattr(p, 'is_published', False)):
        raise HTTPException(404, 'tutor not found')
    reviews = session.exec(select(Review).where(Review.tutor_user_id == p.user_id).order_by(Review.created_at.desc()).limit(50)).all()
    details = session.exec(select(ReviewDetail)).all()
    by_rid = {int(d.review_id): d for d in details}
    items = []
    for r in reviews:
        d = by_rid.get(int(r.id))
        base = _review_to_out(r, session).model_dump()
        base['criteria'] = {
            'explains_rating': getattr(d, 'explains_rating', None) if d else None,
            'punctuality_rating': getattr(d, 'punctuality_rating', None) if d else None,
            'materials_rating': getattr(d, 'materials_rating', None) if d else None,
            'result_rating': getattr(d, 'result_rating', None) if d else None,
        }
        base['lessons_before_review'] = int(getattr(d, 'lessons_before_review', 0) or 0) if d else 0
        base['long_term_student'] = bool(d and int(getattr(d, 'lessons_before_review', 0) or 0) >= 10)
        items.append(base)
    return {"items": items}


class HomeworkReminderCronOut(BaseModel):
    ok: bool
    sent_24h: int = 0
    sent_dayof: int = 0
    sent_checked: int = 0


@app.post('/api/cron/homework-reminders', response_model=HomeworkReminderCronOut)
def cron_homework_reminders(key: Optional[str] = None, session: Session = Depends(get_session)):
    need_key = os.getenv('DL_CRON_KEY')
    if not need_key:
        raise HTTPException(403, 'DL_CRON_KEY is not set')
    if (key or '') != need_key:
        raise HTTPException(403, 'bad key')
    now = _as_utc(_utcnow()) or _utcnow()
    sent24 = 0
    sentday = 0
    sentchk = 0
    rows = session.exec(select(Homework).order_by(Homework.created_at.desc())).all()
    for h in rows:
        student = session.get(User, h.student_user_id)
        tutor = session.get(User, h.tutor_user_id)
        pc = _get_parent_contact(session, h.student_user_id)
        due = _as_utc(h.due_at) if h.due_at else None
        if due and str(h.status) in {'assigned', 'submitted'}:
            delta_h = (due - now).total_seconds() / 3600.0
            if 0 <= delta_h <= 28:
                for target_kind in (['homework_24h'] if delta_h >= 8 else ['homework_dayof']):
                    for recipient in [student]:
                        if not recipient:
                            continue
                        keyr = _notif_key_for_user(recipient, f"user:{getattr(recipient, 'id', 0)}")
                        if _notification_exists(session, keyr, 'homework', h.id, target_kind):
                            continue
                        msg = f"ДЗ: {h.title}\nДедлайн: {h.due_at.isoformat() if h.due_at else '-'}\nСтатус: {h.status}"
                        if getattr(recipient, 'notify_email', True):
                            _send_email(recipient.email, 'DL: напоминание о ДЗ', msg)
                        if getattr(recipient, 'notify_telegram', False) and getattr(recipient, 'telegram_chat_id', None):
                            _send_telegram(recipient.telegram_chat_id, msg)
                        _notification_mark(session, keyr, 'homework', h.id, target_kind)
                        if target_kind == 'homework_24h': sent24 += 1
                        else: sentday += 1
                    if pc and bool(getattr(pc, 'notify_homework', True)):
                        for rk in _parent_recipient_keys(pc):
                            pkind = f'parent_{target_kind}'
                            if _notification_exists(session, rk, 'homework', h.id, pkind):
                                continue
                            body = f"Домашнее задание ученика\nЗадание: {h.title}\nДедлайн: {h.due_at.isoformat() if h.due_at else '-'}\nСтатус: {h.status}" \
                                   + (f"\nРепетитор: {tutor.email}" if tutor else '')
                            _send_parent_contact(pc, 'DL: дедлайн домашнего задания', body)
                            _notification_mark(session, rk, 'homework', h.id, pkind)
            
        if str(h.status) == 'checked':
            # notify student + parent once about checked/comment
            if student:
                keyr = _notif_key_for_user(student, f"user:{student.id}")
                if not _notification_exists(session, keyr, 'homework', h.id, 'homework_checked'):
                    msg = f"ДЗ проверено: {h.title}\n" + (f"Комментарий: {h.feedback_text}" if (h.feedback_text or '').strip() else 'Есть отметка о проверке.')
                    if getattr(student, 'notify_email', True):
                        _send_email(student.email, 'DL: ДЗ проверено', msg)
                    if getattr(student, 'notify_telegram', False) and getattr(student, 'telegram_chat_id', None):
                        _send_telegram(student.telegram_chat_id, msg)
                    _notification_mark(session, keyr, 'homework', h.id, 'homework_checked')
                    sentchk += 1
            if pc and bool(getattr(pc, 'notify_homework', True)):
                for rk in _parent_recipient_keys(pc):
                    if _notification_exists(session, rk, 'homework', h.id, 'parent_homework_checked'):
                        continue
                    body = f"ДЗ проверено\nЗадание: {h.title}\n" + (f"Комментаррий репетитора: {h.feedback_text}" if (h.feedback_text or '').strip() else 'Репетитор отметил задание как проверенное.')
                    _send_parent_contact(pc, 'DL: ДЗ проверено', body)
                    _notification_mark(session, rk, 'homework', h.id, 'parent_homework_checked')
    session.commit()
    return HomeworkReminderCronOut(ok=True, sent_24h=sent24, sent_dayof=sentday, sent_checked=sentchk)


@app.post('/api/cron/parent-notifications')
def cron_parent_notifications(key: Optional[str] = None, session: Session = Depends(get_session)):
    need_key = os.getenv('DL_CRON_KEY')
    if not need_key:
        raise HTTPException(403, 'DL_CRON_KEY is not set')
    if (key or '') != need_key:
        raise HTTPException(403, 'bad key')
    now = _as_utc(_utcnow()) or _utcnow()
    sent = {"lesson_reminders": 0, "lesson_completed": 0, "comments": 0}
    for b in session.exec(select(Booking)).all():
        pc = _get_parent_contact(session, b.student_user_id)
        if not pc or not bool(getattr(pc, 'is_active', True)):
            continue
        slot = _slot_for_booking(b, session)
        s = _as_utc(slot.starts_at) if slot else None
        # Reminder (12-24h window, one per booking)
        if s and str(b.status) == 'confirmed' and bool(getattr(pc, 'notify_lessons', True)):
            hours = (s - now).total_seconds() / 3600.0
            if 0 <= hours <= 24:
                body = f"Напоминание о занятии\nУрок #{b.id}\nВремя: {slot.starts_at.isoformat() if slot else '-'}\nСтатусы подтверждения: ученик={getattr(b,'student_attendance_status','pending')} / репетитор={getattr(b,'tutor_attendance_status','pending')}"
                for rk in _parent_recipient_keys(pc):
                    if _notification_exists(session, rk, 'booking', b.id, 'parent_lesson_reminder'):
                        continue
                    _send_parent_contact(pc, 'DL: напоминание о занятии', body)
                    _notification_mark(session, rk, 'booking', b.id, 'parent_lesson_reminder')
                    sent['lesson_reminders'] += 1
                    break
        # Completed fact
        if str(b.status) in {'done', 'completed'} and bool(getattr(pc, 'notify_lessons', True)):
            for rk in _parent_recipient_keys(pc):
                if _notification_exists(session, rk, 'booking', b.id, 'parent_lesson_completed'):
                    continue
                body = f"Урок состоялся\nУрок #{b.id}\nВремя: {slot.starts_at.isoformat() if slot else '-'}"
                _send_parent_contact(pc, 'DL: урок состоялся', body)
                _notification_mark(session, rk, 'booking', b.id, 'parent_lesson_completed')
                sent['lesson_completed'] += 1
                break
        # Tutor comment (from BookingMeta)
        bm = session.exec(select(BookingMeta).where(BookingMeta.booking_id == b.id)).first()
        if bm and (str(getattr(bm, 'tutor_comment', '') or '').strip()) and bool(getattr(pc, 'notify_comments', True)):
            for rk in _parent_recipient_keys(pc):
                if _notification_exists(session, rk, 'booking', b.id, 'parent_tutor_comment'):
                    continue
                body = f"Комментарий репетитора по уроку #{b.id}\n{bm.tutor_comment}"
                _send_parent_contact(pc, 'DL: комментарий репетитора', body)
                _notification_mark(session, rk, 'booking', b.id, 'parent_tutor_comment')
                sent['comments'] += 1
                break
    session.commit()
    return {"ok": True, **sent}


@app.get('/api/me/weekly-digest')
def get_my_weekly_digest(
    user: User = Depends(require_role('tutor', 'admin')),
    session: Session = Depends(get_session),
):
    if user.role == 'admin':
        return {"digest": None}
    return {"digest": _weekly_digest_for_tutor(session, user.id)}


@app.post('/api/cron/weekly-digest')
def cron_weekly_digest(key: Optional[str] = None, session: Session = Depends(get_session)):
    need_key = os.getenv('DL_CRON_KEY')
    if not need_key:
        raise HTTPException(403, 'DL_CRON_KEY is not set')
    if (key or '') != need_key:
        raise HTTPException(403, 'bad key')
    now = _as_utc(_utcnow()) or _utcnow()
    iso_year, iso_week, _ = now.isocalendar()
    sent = 0
    tutors = session.exec(select(User).where(User.role == 'tutor')).all()
    for t in tutors:
        d = _weekly_digest_for_tutor(session, t.id, now=now)
        rk = _notif_key_for_user(t, f"user:{t.id}")
        kind = f'weekly_digest_{iso_year}_{iso_week}'
        if _notification_exists(session, rk, 'digest', t.id, kind):
            continue
        body = (
            f"Weekly digest\nПроведено занятий: {d['lessons_done']}\nОтмены: {d['cancelled']}\nНовые ученики: {d['new_students']}\n"
            f"Кто давно не записывался: {len(d['dormant_students'])}\nВыручка (trial): {d['earnings_7d']}"
        )
        if getattr(t, 'notify_email', True):
            _send_email(t.email, 'DL: weekly digest репетитора', body)
        if getattr(t, 'notify_telegram', False) and getattr(t, 'telegram_chat_id', None):
            _send_telegram(t.telegram_chat_id, body)
        _notification_mark(session, rk, 'digest', t.id, kind)
        sent += 1
    session.commit()
    return {"ok": True, "sent": sent, "iso_week": f"{iso_year}-W{iso_week}"}


@app.post('/api/cron/marketplace-alerts')
def cron_marketplace_alerts(key: Optional[str] = None, session: Session = Depends(get_session)):
    need_key = os.getenv('DL_CRON_KEY')
    if not need_key:
        raise HTTPException(403, 'DL_CRON_KEY is not set')
    if (key or '') != need_key:
        raise HTTPException(403, 'bad key')
    sent_wait = 0
    sent_last = 0
    now = _as_utc(_utcnow()) or _utcnow()
    until = now + timedelta(days=1)
    for slot in session.exec(select(Slot).where(Slot.status == 'open').order_by(Slot.starts_at.asc())).all():
        s = _as_utc(slot.starts_at)
        if not s or s < now or s > until:
            continue
        res = _notify_waitlist_and_last_minute_for_slot(session, slot, reason='cron')
        sent_wait += int(res.get('waitlist', 0) or 0)
        sent_last += int(res.get('last_minute', 0) or 0)
    session.commit()
    return {"ok": True, "waitlist": sent_wait, "last_minute": sent_last}


@app.get('/api/platform/value-features')
def platform_value_features():
    return {
        "anti_circumvention_strategy": {
            "principle": "ценность > запреты",
            "features": [
                "расписание и повторная запись",
                "напоминания и подтверждение занятия",
                "история уроков, ДЗ, прогресс",
                "отзывы с критериями",
                "родительские уведомления",
                "waitlist и last-minute slots",
                "серии занятий (recurring booking)",
            ],
        }
    }

# -----------------
# Serve Frontend (built with Vite) when ./static exists (single-service deploy)
# -----------------
DL_STATIC_DIR = Path(__file__).parent / "static"
if DL_STATIC_DIR.exists():
    # Serve static assets (e.g., /assets/...)
    if (DL_STATIC_DIR / "assets").exists():
        app.mount("/assets", StaticFiles(directory=str(DL_STATIC_DIR / "assets")), name="assets")

    @app.get("/", include_in_schema=False)
    def _spa_root():
        # Prevent stale index.html caching, otherwise browsers/CDNs can keep an old bundle
        # which may point to a wrong API host and cause "Failed to fetch".
        return FileResponse(
            str(DL_STATIC_DIR / "index.html"),
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/{full_path:path}", include_in_schema=False)
    def _spa_any(full_path: str):
        # Do not hijack API / WS paths
        if full_path.startswith("api") or full_path.startswith("ws"):
            raise HTTPException(status_code=404, detail="Not Found")
        candidate = DL_STATIC_DIR / full_path
        if candidate.exists() and candidate.is_file():
            return FileResponse(str(candidate))
        return FileResponse(
            str(DL_STATIC_DIR / "index.html"),
            headers={"Cache-Control": "no-store"},
        )

