from __future__ import annotations

import json
import os
from datetime import datetime, timedelta
from typing import List, Tuple

from sqlmodel import Session, select

from auth import hash_password
from models import User, TutorProfile, Slot, Booking, Review


def _truthy(v: str | None) -> bool:
    if not v:
        return False
    return v.strip().lower() in {"1", "true", "yes", "y", "on"}


def _is_railway() -> bool:
    return bool(os.getenv("RAILWAY_PROJECT_ID") or os.getenv("RAILWAY_ENVIRONMENT") or os.getenv("RAILWAY_SERVICE_ID"))


def seed_demo(session: Session) -> None:
    """Create demo tutors/students/profiles/slots/bookings for MVP demos.

    Controls:
      - DL_SEED_DEMO=true|1   -> always seed (idempotent)
      - DL_DEMO_PASSWORD      -> password for all demo accounts (default: DemoPass123!)
      - DL_DEMO_RESET_PASSWORDS=true|1 -> reset demo passwords on each boot (default: true)
      - DL_AUTO_SEED_IF_EMPTY=true|1   -> auto seed ONLY if DB has no users AND running on Railway (default: true)
    """
    demo_flag = _truthy(os.getenv("DL_SEED_DEMO"))
    auto_if_empty = _truthy(os.getenv("DL_AUTO_SEED_IF_EMPTY") or "true") and _is_railway()
    has_any_user = session.exec(select(User.id)).first() is not None

    enabled = demo_flag or (auto_if_empty and not has_any_user)
    if not enabled:
        return

    demo_password = str(os.getenv("DL_DEMO_PASSWORD") or "DemoPass123!")
    reset_pw = _truthy(os.getenv("DL_DEMO_RESET_PASSWORDS") or "true")

    # Demo admin account (handy for demos)
    demo_admin_email = (os.getenv("DL_DEMO_ADMIN_EMAIL") or "admin@demo.dl").strip().lower()

    tutors: List[Tuple[str, str, dict]] = [
        ("tutor1@demo.dl", "Анна И.", {"subjects": ["Математика"], "levels": ["5-11 класс"], "goals": ["ЕГЭ", "ОГЭ"], "price": 1500, "lang": "ru",
                                      "bio": "Подготовка к ЕГЭ/ОГЭ. Объясняю простым языком, много практики."}),
        ("tutor2@demo.dl", "Илья С.", {"subjects": ["Английский"], "levels": ["A1-C1"], "goals": ["Разговорный", "IELTS"], "price": 1800, "lang": "ru",
                                      "bio": "Разговорная практика + грамматика. Домашка и трекер прогресса."}),
        ("tutor3@demo.dl", "Мария К.", {"subjects": ["Физика"], "levels": ["7-11 класс"], "goals": ["ЕГЭ"], "price": 1700, "lang": "ru",
                                      "bio": "Физика с нуля до уверенного балла. Разбор задач на доске."}),
        ("tutor4@demo.dl", "Денис П.", {"subjects": ["Информатика"], "levels": ["8-11 класс"], "goals": ["ЕГЭ"], "price": 2000, "lang": "ru",
                                      "bio": "Алгоритмы, Python, разбор прототипов. Уроки в платформе."}),
        ("tutor5@demo.dl", "София Р.", {"subjects": ["Русский язык"], "levels": ["5-11 класс"], "goals": ["ЕГЭ", "Сочинение"], "price": 1400, "lang": "ru",
                                      "bio": "Сочинение, грамматика, тестовая часть. Понятные схемы."}),
        ("tutor6@demo.dl", "Павел Д.", {"subjects": ["Химия"], "levels": ["8-11 класс"], "goals": ["ОГЭ", "ЕГЭ"], "price": 1600, "lang": "ru",
                                      "bio": "Реакции, расчёты, теория + практика. Мини-тесты перед уроком."}),
    ]

    students: List[Tuple[str, str]] = [
        ("student1@demo.dl", "Андрей"),
        ("student2@demo.dl", "Алина"),
        ("student3@demo.dl", "Кирилл"),
        ("student4@demo.dl", "Наталья"),
        ("student5@demo.dl", "Игорь"),
        ("student6@demo.dl", "Виктория"),
    ]

    def upsert_user(email: str, role: str) -> User:
        email_l = email.strip().lower()
        u = session.exec(select(User).where(User.email == email_l)).first()
        if not u:
            u = User(email=email_l, password_hash=hash_password(demo_password), role=role, is_active=True)
            session.add(u)
            session.commit()
            session.refresh(u)
            return u

        changed = False
        if u.role != role:
            u.role = role
            changed = True
        if not u.is_active:
            u.is_active = True
            changed = True
        if reset_pw:
            u.password_hash = hash_password(demo_password)
            changed = True

        if changed:
            session.add(u)
            session.commit()
            session.refresh(u)
        return u

    # Admin
    upsert_user(demo_admin_email, "admin")

    # Tutors & profiles
    tutor_users: List[User] = []
    for email, name, meta in tutors:
        u = upsert_user(email, "tutor")
        # Ensure earnings field exists
        try:
            u.earnings = int(getattr(u, 'earnings', 0) or 0)
            session.add(u)
            session.commit()
            session.refresh(u)
        except Exception:
            pass
        tutor_users.append(u)

        prof = session.exec(select(TutorProfile).where(TutorProfile.user_id == u.id)).first()
        if not prof:
            prof = TutorProfile(
                user_id=u.id,
                display_name=name,
                subjects_json=json.dumps(meta.get("subjects", []), ensure_ascii=False),
                levels_json=json.dumps(meta.get("levels", []), ensure_ascii=False),
                goals_json=json.dumps(meta.get("goals", []), ensure_ascii=False),
                price_per_hour=int(meta.get("price") or 0),
                language=str(meta.get("lang") or "ru"),
                bio=str(meta.get("bio") or ""),
                video_url="",
                rating_avg=0,
                rating_count=0,
                is_published=True,
            )
            session.add(prof)
            session.commit()
            session.refresh(prof)
        else:
            # keep published for demo
            updated = False
            if not prof.is_published:
                prof.is_published = True
                updated = True
            if prof.display_name != name:
                prof.display_name = name
                updated = True
            if updated:
                prof.updated_at = datetime.utcnow()
                session.add(prof)
                session.commit()

    # Students
    student_users: List[User] = []
    for email, _name in students:
        u = upsert_user(email, "student")
        # Give students some trial balance for demos
        try:
            u.balance = max(int(getattr(u, 'balance', 0) or 0), 5000)
            session.add(u)
            session.commit()
            session.refresh(u)
        except Exception:
            pass
        student_users.append(u)

    # Slots for each tutor (only if no slots yet)
    now = datetime.utcnow()
    for i, tutor_u in enumerate(tutor_users):
        has_slot = session.exec(select(Slot.id).where(Slot.tutor_user_id == tutor_u.id)).first() is not None
        if has_slot:
            continue
        base = now + timedelta(hours=1 + i)
        for k in range(4):
            st = base + timedelta(hours=2 * k)
            en = st + timedelta(minutes=60)
            session.add(Slot(tutor_user_id=tutor_u.id, starts_at=st, ends_at=en, status="open"))
        session.commit()

    # One demo booking (tutor1 + student1) if none exist for those two
    tutor1 = tutor_users[0]
    student1 = student_users[0]
    existing_booking = session.exec(
        select(Booking.id).where(Booking.tutor_user_id == tutor1.id).where(Booking.student_user_id == student1.id)
    ).first()
    if not existing_booking:
        slot = session.exec(
            select(Slot).where(Slot.tutor_user_id == tutor1.id).where(Slot.status == "open").order_by(Slot.starts_at.asc())
        ).first()
        if slot:
            slot.status = "booked"
            session.add(slot)
            session.commit()
            session.refresh(slot)

            # Create an UNPAID lesson so demos can test "Оплатить с баланса".
            b = Booking(slot_id=slot.id, tutor_user_id=tutor1.id, student_user_id=student1.id, status="confirmed", price=1500, payment_status="unpaid")
            session.add(b)
            session.commit()
            session.refresh(b)

    # Reviews (if none exist)
    for tutor_u in tutor_users[:3]:
        has_review = session.exec(select(Review.id).where(Review.tutor_user_id == tutor_u.id)).first() is not None
        if has_review:
            continue

        prof = session.exec(select(TutorProfile).where(TutorProfile.user_id == tutor_u.id)).first()
        price = int(getattr(prof, 'price_per_hour', 0) or 0)
        if price <= 0:
            price = 1500

        # Create 2 reviews from different students (link to any existing booking or create dummy booking)
        for s_idx, stars, text in [(1, 5, "Отличный преподаватель, всё стало понятно!"), (2, 4, "Хороший урок, хотелось бы больше практики.")]:
            student = student_users[s_idx]
            # create dummy booking with cancelled slot if needed
            slot = session.exec(
                select(Slot).where(Slot.tutor_user_id == tutor_u.id).order_by(Slot.starts_at.asc())
            ).first()
            if not slot:
                st = now + timedelta(days=1, hours=2)
                en = st + timedelta(minutes=60)
                slot = Slot(tutor_user_id=tutor_u.id, starts_at=st, ends_at=en, status="booked")
                session.add(slot)
                session.commit()
                session.refresh(slot)

            b = Booking(slot_id=slot.id, tutor_user_id=tutor_u.id, student_user_id=student.id, status="done", price=price, payment_status="paid")
            session.add(b)
            session.commit()
            session.refresh(b)

            r = Review(booking_id=b.id, tutor_user_id=tutor_u.id, student_user_id=student.id, stars=int(stars), text=text)
            session.add(r)
            session.commit()

        # Update rating
        if prof:
            rows = session.exec(select(Review).where(Review.tutor_user_id == tutor_u.id)).all()
            if rows:
                prof.rating_count = len(rows)
                prof.rating_avg = float(sum(int(x.stars) for x in rows)) / float(prof.rating_count)
            else:
                prof.rating_count = 0
                prof.rating_avg = 0
            prof.updated_at = datetime.utcnow()
            session.add(prof)
            session.commit()

    print("[seed] demo accounts ready (emails: *@demo.dl)")
