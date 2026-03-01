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


def seed_demo(session: Session) -> None:
    """Create demo tutors/students/profiles/slots/bookings for MVP demos.

    Controlled by env:
      - DL_SEED_DEMO=true|1
      - DL_DEMO_PASSWORD (default: DemoPass123!)
    """
    if not _truthy(os.getenv("DL_SEED_DEMO")):
        return

    demo_password = os.getenv("DL_DEMO_PASSWORD") or "DemoPass123!"
    demo_password = str(demo_password)

# Optional demo admin account (handy for demos)
admin_email = (os.getenv("DL_DEMO_ADMIN_EMAIL") or "admin@demo.dl").strip().lower()
# Create or update admin
u_admin = session.exec(select(User).where(User.email == admin_email)).first()
if not u_admin:
    u_admin = User(email=admin_email, password_hash=hash_password(demo_password), role="admin", is_active=True)
    session.add(u_admin)
    session.commit()
    session.refresh(u_admin)
else:
    changed = False
    if u_admin.role != "admin":
        u_admin.role = "admin"
        changed = True
    if not u_admin.is_active:
        u_admin.is_active = True
        changed = True
    if changed:
        session.add(u_admin)
        session.commit()
        session.refresh(u_admin)

    # If there are already some demo users, keep idempotent.
    # We seed a small, deterministic set of accounts.
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

    def get_or_create_user(email: str, role: str) -> User:
        email_l = email.strip().lower()
        u = session.exec(select(User).where(User.email == email_l)).first()
        if u:
            # ensure role and active
            changed = False
            if u.role != role:
                u.role = role
                changed = True
            if not u.is_active:
                u.is_active = True
                changed = True
            if changed:
                session.add(u)
                session.commit()
                session.refresh(u)
            return u
        u = User(email=email_l, password_hash=hash_password(demo_password), role=role, is_active=True)
        session.add(u)
        session.commit()
        session.refresh(u)
        return u

    tutor_users: List[User] = []
    for email, name, meta in tutors:
        u = get_or_create_user(email, "tutor")
        tutor_users.append(u)

        # profile
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
            if not prof.is_published:
                prof.is_published = True
                session.add(prof)
                session.commit()

    student_users: List[User] = []
    for email, _name in students:
        u = get_or_create_user(email, "student")
        student_users.append(u)

    # Seed slots (open) for each tutor if none exist.
    now = datetime.utcnow()
    for i, tutor_u in enumerate(tutor_users):
        existing = session.exec(select(Slot).where(Slot.tutor_user_id == tutor_u.id)).first()
        if existing:
            continue

        # Create 4 slots: today+1h, +3h, tomorrow, +2days
        starts_list = [
            now + timedelta(hours=1 + i),
            now + timedelta(hours=3 + i),
            now + timedelta(days=1, hours=2),
            now + timedelta(days=2, hours=1),
        ]
        for s in starts_list:
            slot = Slot(
                tutor_user_id=tutor_u.id,
                starts_at=s,
                ends_at=s + timedelta(minutes=60),
                status="open",
            )
            session.add(slot)
        session.commit()

    # Seed one booking between first tutor and first student if no bookings exist.
    any_booking = session.exec(select(Booking)).first()
    if not any_booking and tutor_users and student_users:
        tutor_u = tutor_users[0]
        student_u = student_users[0]
        # pick the earliest open slot for tutor
        slot = session.exec(
            select(Slot).where(Slot.tutor_user_id == tutor_u.id).where(Slot.status == "open").order_by(Slot.starts_at)
        ).first()
        if slot:
            slot.status = "booked"
            session.add(slot)
            session.commit()
            session.refresh(slot)

            booking = Booking(
                slot_id=slot.id,
                tutor_user_id=tutor_u.id,
                student_user_id=student_u.id,
                status="confirmed",
            )
            session.add(booking)
            session.commit()
            session.refresh(booking)

    # Seed a couple of reviews for visual ratings (optional, only if none exist).
    existing_reviews = session.exec(select(Review)).first()
    if not existing_reviews:
        # create synthetic done bookings + reviews for each tutor
        for i, tutor_u in enumerate(tutor_users):
            # create a completed booking in the past
            slot = Slot(
                tutor_user_id=tutor_u.id,
                starts_at=now - timedelta(days=7+i, hours=1),
                ends_at=now - timedelta(days=7+i),
                status="booked",
            )
            session.add(slot)
            session.commit()
            session.refresh(slot)

            student_u = student_users[i % len(student_users)]
            booking = Booking(
                slot_id=slot.id,
                tutor_user_id=tutor_u.id,
                student_user_id=student_u.id,
                status="done",
            )
            session.add(booking)
            session.commit()
            session.refresh(booking)

            stars = 5 if i % 3 != 0 else 4
            review = Review(
                booking_id=booking.id,
                tutor_user_id=tutor_u.id,
                student_user_id=student_u.id,
                stars=stars,
                text="Отличное занятие: понятно и структурно. Рекомендую!",
            )
            session.add(review)
            session.commit()

        # Update rating aggregates
        for tutor_u in tutor_users:
            prof = session.exec(select(TutorProfile).where(TutorProfile.user_id == tutor_u.id)).first()
            if not prof:
                continue
            rows = session.exec(select(Review).where(Review.tutor_user_id == tutor_u.id)).all()
            if rows:
                prof.rating_count = len(rows)
                prof.rating_avg = sum([r.stars for r in rows]) / len(rows)
                session.add(prof)
        session.commit()

    print("[seed] demo data ensured. demo password:", demo_password)
