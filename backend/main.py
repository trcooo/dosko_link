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
from jose import JWTError, jwt
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from auth import (
    ALGORITHM,
    SECRET_KEY,
    create_access_token,
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
    Review,
    Slot,
    TopicProgress,
    TutorProfile,
    User,
)

app = FastAPI(title="DL MVP API", version="0.4.0")

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
    # Create tables (no migrations in MVP)
    from db import init_db

    init_db()


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


class RegisterIn(BaseModel):
    email: str
    password: str = Field(min_length=6)
    role: str = "student"  # student|tutor


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"


@app.post("/api/auth/register", response_model=TokenOut)
def register(payload: RegisterIn, session: Session = Depends(get_session)):
    email = payload.email.strip().lower()
    if payload.role not in {"student", "tutor"}:
        raise HTTPException(400, "role must be student or tutor")

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

    token = create_access_token(subject=user.email)
    return TokenOut(access_token=token)


@app.post("/api/auth/login", response_model=TokenOut)
def login(
    form: OAuth2PasswordRequestForm = Depends(),
    session: Session = Depends(get_session),
):
    email = form.username.strip().lower()
    user = session.exec(select(User).where(User.email == email)).first()
    if not user or not verify_password(form.password, user.password_hash):
        raise HTTPException(401, "invalid credentials")

    token = create_access_token(subject=user.email)
    return TokenOut(access_token=token)


@app.get("/api/me")
def me(user: User = Depends(get_current_user)):
    return {
        "id": user.id,
        "email": user.email,
        "role": user.role,
        "telegram_chat_id": user.telegram_chat_id,
        "notify_email": user.notify_email,
        "notify_telegram": user.notify_telegram,
    }


class MeSettingsIn(BaseModel):
    telegram_chat_id: Optional[str] = None
    notify_email: Optional[bool] = None
    notify_telegram: Optional[bool] = None


@app.get("/api/me/settings")
def me_settings(user: User = Depends(get_current_user)):
    return {
        "telegram_chat_id": user.telegram_chat_id,
        "notify_email": user.notify_email,
        "notify_telegram": user.notify_telegram,
    }


@app.put("/api/me/settings")
def update_me_settings(
    payload: MeSettingsIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    data = payload.model_dump(exclude_unset=True)
    # Normalize telegram chat id
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
        "telegram_chat_id": user.telegram_chat_id,
        "notify_email": user.notify_email,
        "notify_telegram": user.notify_telegram,
    }


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

    booking = Booking(
        slot_id=slot.id,
        tutor_user_id=slot.tutor_user_id,
        student_user_id=user.id,
        status="confirmed",
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
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email = payload.get("sub")
        if not email:
            raise HTTPException(401, "Invalid token")
    except JWTError:
        raise HTTPException(401, "Invalid token")

    user = session.exec(select(User).where(User.email == str(email))).first()
    if not user:
        raise HTTPException(401, "Invalid token")
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
        return FileResponse(str(DL_STATIC_DIR / "index.html"))

    @app.get("/{full_path:path}", include_in_schema=False)
    def _spa_any(full_path: str):
        # Do not hijack API / WS paths
        if full_path.startswith("api") or full_path.startswith("ws"):
            raise HTTPException(status_code=404, detail="Not Found")
        candidate = DL_STATIC_DIR / full_path
        if candidate.exists() and candidate.is_file():
            return FileResponse(str(candidate))
        return FileResponse(str(DL_STATIC_DIR / "index.html"))

