from __future__ import annotations

import base64
import io
import json
import os
import smtplib
import ssl
import urllib.request
from pathlib import Path
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect, UploadFile, File
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
    User,
    StudyPlan,
    PlanItem,
    StudentLibraryItem,
    BalanceTx,
    Quiz,
    QuizQuestion,
    QuizAttempt,
)

app = FastAPI(title="DL MVP API", version="0.6.4")

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


def _send_telegram(chat_id: str, text_body: str) -> None:
    token = os.getenv("DL_TELEGRAM_BOT_TOKEN")
    if not (token and chat_id):
        print(f"[notify/telegram] chat_id={chat_id} body={text_body[:180]}")
        return
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = json.dumps({"chat_id": chat_id, "text": text_body}).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            resp.read()
    except Exception:
        pass


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
    }.get(kind, "DL: уведомление")

    base = f"Событие: {kind}\nКомната: booking-{booking.id}{when}"
    if extra:
        base += f"\n{extra}"

    for u in [tutor, student]:
        if not u:
            continue
        if getattr(u, "notify_email", True):
            _send_email(u.email, subj, base)
        if getattr(u, "notify_telegram", False) and getattr(u, "telegram_chat_id", None):
            _send_telegram(u.telegram_chat_id, base)


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
    booking: BookingOut
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
        "notify_email": getattr(user, "notify_email", True),
        "notify_telegram": getattr(user, "notify_telegram", False),
    }


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
    is_published: bool
    updated_at: datetime
    rating_avg: float
    rating_count: int


class AdminTutorUpdateIn(BaseModel):
    is_published: Optional[bool] = None
    display_name: Optional[str] = None


@app.get("/api/admin/tutors", response_model=List[AdminTutorOut])
def admin_list_tutors(
    only_pending: bool = False,
    _: User = Depends(require_role("admin")),
    session: Session = Depends(get_session),
):
    stmt = select(TutorProfile)
    if only_pending:
        stmt = stmt.where(TutorProfile.is_published == False)  # noqa: E712
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
            is_published=p.is_published,
            updated_at=p.updated_at,
            rating_avg=p.rating_avg,
            rating_count=p.rating_count,
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
    p.updated_at = datetime.utcnow()

    session.add(p)
    session.commit()
    session.refresh(p)
    return {"ok": True, "id": p.id, "is_published": p.is_published, "display_name": p.display_name}


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


class TutorProfileOut(BaseModel):
    id: int
    user_id: int
    display_name: str
    subjects: List[str]
    levels: List[str]
    goals: List[str]
    price_per_hour: int
    language: str
    bio: str
    video_url: str
    rating_avg: float
    rating_count: int
    is_published: bool


def _profile_to_out(p: TutorProfile) -> TutorProfileOut:
    return TutorProfileOut(
        id=p.id,
        user_id=p.user_id,
        display_name=p.display_name,
        subjects=_loads_list(p.subjects_json),
        levels=_loads_list(p.levels_json),
        goals=_loads_list(p.goals_json),
        price_per_hour=p.price_per_hour,
        language=p.language,
        bio=p.bio,
        video_url=p.video_url,
        rating_avg=p.rating_avg,
        rating_count=p.rating_count,
        is_published=p.is_published,
    )


@app.get("/api/tutors", response_model=List[TutorProfileOut])
def list_tutors(
    q: Optional[str] = None,
    subject: Optional[str] = None,
    session: Session = Depends(get_session),
):
    tutors = session.exec(select(TutorProfile).where(TutorProfile.is_published == True)).all()  # noqa

    needle = (q or "").strip().lower()
    subj = (subject or "").strip().lower()

    def match(p: TutorProfile) -> bool:
        subjects = [str(x).lower() for x in _loads_list(p.subjects_json)]
        text = (p.display_name + " " + p.bio).lower()

        if subj and subj not in subjects:
            return False
        if needle and needle not in text and all(needle not in s for s in subjects):
            return False
        return True

    filtered = [p for p in tutors if match(p)]
    return [_profile_to_out(p) for p in filtered]


@app.get("/api/tutors/{profile_id}", response_model=TutorProfileOut)
def get_tutor(profile_id: int, session: Session = Depends(get_session)):
    p = session.get(TutorProfile, profile_id)
    if not p or not p.is_published:
        raise HTTPException(404, "tutor not found")
    return _profile_to_out(p)


class TutorProfileUpdateIn(BaseModel):
    display_name: Optional[str] = None
    subjects: Optional[List[str]] = None
    levels: Optional[List[str]] = None
    goals: Optional[List[str]] = None
    price_per_hour: Optional[int] = None
    language: Optional[str] = None
    bio: Optional[str] = None
    video_url: Optional[str] = None


@app.get("/api/tutors/me", response_model=TutorProfileOut)
def get_my_profile(
    user: User = Depends(require_role("tutor", "admin")),
    session: Session = Depends(get_session),
):
    p = session.exec(select(TutorProfile).where(TutorProfile.user_id == user.id)).first()
    if not p:
        raise HTTPException(404, "profile not found")
    return _profile_to_out(p)


@app.put("/api/tutors/me", response_model=TutorProfileOut)
def update_my_profile(
    payload: TutorProfileUpdateIn,
    user: User = Depends(require_role("tutor", "admin")),
    session: Session = Depends(get_session),
):
    p = session.exec(select(TutorProfile).where(TutorProfile.user_id == user.id)).first()
    if not p:
        raise HTTPException(404, "profile not found")

    data = payload.model_dump(exclude_unset=True)
    if "subjects" in data:
        p.subjects_json = json.dumps(data.pop("subjects"))
    if "levels" in data:
        p.levels_json = json.dumps(data.pop("levels"))
    if "goals" in data:
        p.goals_json = json.dumps(data.pop("goals"))

    for k, v in data.items():
        setattr(p, k, v)

    p.updated_at = datetime.utcnow()
    session.add(p)
    session.commit()
    session.refresh(p)
    return _profile_to_out(p)


@app.post("/api/tutors/me/publish", response_model=TutorProfileOut)
def publish_my_profile(
    user: User = Depends(require_role("tutor", "admin")),
    session: Session = Depends(get_session),
):
    p = session.exec(select(TutorProfile).where(TutorProfile.user_id == user.id)).first()
    if not p:
        raise HTTPException(404, "profile not found")

    p.is_published = True
    p.updated_at = datetime.utcnow()
    session.add(p)
    session.commit()
    session.refresh(p)
    return _profile_to_out(p)


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


def _booking_to_out(b: Booking, session: Session) -> BookingOut:
    slot = _slot_for_booking(b, session)
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
    return BookingActionOut(booking=_booking_to_out(booking, session))


class RescheduleIn(BaseModel):
    new_slot_id: int


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

    _notify_booking_event("rescheduled", booking, session, extra=extra)
    return BookingActionOut(booking=_booking_to_out(booking, session))


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

    bookings = session.exec(
        select(Booking)
        .where(Booking.status == "confirmed")
        .where(Booking.reminder_sent == False)  # noqa
    ).all()

    sent = 0
    for b in bookings:
        slot = _slot_for_booking(b, session)
        if not slot:
            continue
        s = _as_utc(slot.starts_at)
        if not s:
            continue
        if window_from <= s <= window_to:
            mins = int((s - now).total_seconds() // 60)
            _notify_booking_event("reminder", b, session, extra=f"До начала ~{mins} мин")
            b.reminder_sent = True
            b.reminder_sent_at = now
            session.add(b)
            sent += 1

    session.commit()
    return {"ok": True, "sent": sent, "now": now.isoformat()}


# -----------------
# Rooms (access check + info)
# -----------------


class RoomInfoOut(BaseModel):
    ok: bool = True
    room_id: str
    booking: BookingOut
    tutor_email_masked: str
    student_email_masked: str


@app.get("/api/rooms/{room_id}", response_model=RoomInfoOut)
def room_info(
    room_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    booking = _require_room_access(room_id, user, session)
    tutor = session.get(User, booking.tutor_user_id)
    student = session.get(User, booking.student_user_id)
    return RoomInfoOut(
        room_id=room_id,
        booking=_booking_to_out(booking, session),
        tutor_email_masked=_mask_email(tutor.email if tutor else ""),
        student_email_masked=_mask_email(student.email if student else ""),
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

