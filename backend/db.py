from __future__ import annotations

import os
from sqlmodel import SQLModel, Session, create_engine
from sqlalchemy import text

# Railway Postgres plugin typically provides DATABASE_URL.
# Keep DL_DB_URL as an explicit override.
DB_URL = os.getenv("DL_DB_URL") or os.getenv("DATABASE_URL") or "sqlite:///./dl_mvp.db"

# Some platforms still use the deprecated postgres:// scheme.
if DB_URL.startswith("postgres://"):
    DB_URL = DB_URL.replace("postgres://", "postgresql://", 1)

# For SQLite with threads
connect_args = {"check_same_thread": False} if DB_URL.startswith("sqlite") else {}
engine = create_engine(DB_URL, echo=False, connect_args=connect_args)


def init_db() -> None:
    SQLModel.metadata.create_all(engine)
    _ensure_schema()


def _ensure_schema() -> None:
    """Very small, best-effort schema updater for MVP.

    Railway Postgres is typically fresh, but local SQLite may persist.
    We try to add new columns if missing. Failures are ignored.
    """

    dialect = engine.dialect.name

    # Quote table names because "user" is reserved in Postgres.
    def _exec(sql: str):
        try:
            with engine.begin() as conn:
                conn.execute(text(sql))
        except Exception:
            pass

    if dialect.startswith("sqlite"):
        # SQLite: no IF NOT EXISTS for ADD COLUMN in older versions; ignore failures.
        _exec('ALTER TABLE "user" ADD COLUMN telegram_chat_id VARCHAR')
        _exec('ALTER TABLE "user" ADD COLUMN telegram_username VARCHAR')
        _exec('ALTER TABLE "user" ADD COLUMN telegram_first_name VARCHAR')
        _exec('ALTER TABLE "user" ADD COLUMN telegram_linked_at DATETIME')
        _exec('ALTER TABLE "user" ADD COLUMN is_active BOOLEAN DEFAULT 1')
        _exec('ALTER TABLE "user" ADD COLUMN token_version INTEGER DEFAULT 0')
        _exec('ALTER TABLE "user" ADD COLUMN last_login_at DATETIME')
        _exec('ALTER TABLE "user" ADD COLUMN notify_email BOOLEAN DEFAULT 1')
        _exec('ALTER TABLE "user" ADD COLUMN notify_telegram BOOLEAN DEFAULT 0')
        _exec('ALTER TABLE "user" ADD COLUMN balance INTEGER DEFAULT 0')
        _exec('ALTER TABLE "user" ADD COLUMN earnings INTEGER DEFAULT 0')

        _exec('ALTER TABLE booking ADD COLUMN reminder_sent BOOLEAN DEFAULT 0')
        _exec('ALTER TABLE booking ADD COLUMN reminder_sent_at DATETIME')
        _exec('ALTER TABLE booking ADD COLUMN price INTEGER DEFAULT 0')
        _exec('ALTER TABLE booking ADD COLUMN payment_status VARCHAR DEFAULT "unpaid"')
        _exec('ALTER TABLE booking ADD COLUMN paid_at DATETIME')
        _exec('ALTER TABLE booking ADD COLUMN student_attendance_status VARCHAR DEFAULT "pending"')
        _exec('ALTER TABLE booking ADD COLUMN tutor_attendance_status VARCHAR DEFAULT "pending"')
        _exec('ALTER TABLE booking ADD COLUMN student_attendance_updated_at DATETIME')
        _exec('ALTER TABLE booking ADD COLUMN tutor_attendance_updated_at DATETIME')
        _exec('ALTER TABLE booking ADD COLUMN reschedule_count INTEGER DEFAULT 0')
        _exec('ALTER TABLE booking ADD COLUMN last_reschedule_reason VARCHAR DEFAULT ""')

        # TutorProfile extensions (v0.7+)
        _exec('ALTER TABLE tutorprofile ADD COLUMN photo_url VARCHAR')
        _exec('ALTER TABLE tutorprofile ADD COLUMN age INTEGER')
        _exec('ALTER TABLE tutorprofile ADD COLUMN education VARCHAR')
        _exec('ALTER TABLE tutorprofile ADD COLUMN backgrounds_json VARCHAR DEFAULT "[]"')
        _exec('ALTER TABLE tutorprofile ADD COLUMN grades_json VARCHAR DEFAULT "[]"')
        _exec('ALTER TABLE tutorprofile ADD COLUMN certificate_links_json VARCHAR DEFAULT "[]"')
        _exec('ALTER TABLE tutorprofile ADD COLUMN documents_status VARCHAR DEFAULT "draft"')
        _exec('ALTER TABLE tutorprofile ADD COLUMN documents_note VARCHAR DEFAULT ""')
        _exec('ALTER TABLE tutorprofile ADD COLUMN payment_method VARCHAR DEFAULT ""')
        _exec('ALTER TABLE tutorprofile ADD COLUMN public_schedule_note VARCHAR DEFAULT ""')
        _exec('ALTER TABLE tutorprofile ADD COLUMN lessons_count INTEGER DEFAULT 0')
        _exec('ALTER TABLE tutorprofile ADD COLUMN founding_tutor BOOLEAN DEFAULT 0')

    elif dialect.startswith("postgres"):
        _exec('ALTER TABLE "user" ADD COLUMN IF NOT EXISTS telegram_chat_id VARCHAR')
        _exec('ALTER TABLE "user" ADD COLUMN IF NOT EXISTS telegram_username VARCHAR')
        _exec('ALTER TABLE "user" ADD COLUMN IF NOT EXISTS telegram_first_name VARCHAR')
        _exec('ALTER TABLE "user" ADD COLUMN IF NOT EXISTS telegram_linked_at TIMESTAMP')
        _exec('ALTER TABLE "user" ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE')
        _exec('ALTER TABLE "user" ADD COLUMN IF NOT EXISTS token_version INTEGER DEFAULT 0')
        _exec('ALTER TABLE "user" ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP')
        _exec('ALTER TABLE "user" ADD COLUMN IF NOT EXISTS notify_email BOOLEAN DEFAULT TRUE')
        _exec('ALTER TABLE "user" ADD COLUMN IF NOT EXISTS notify_telegram BOOLEAN DEFAULT FALSE')
        _exec('ALTER TABLE "user" ADD COLUMN IF NOT EXISTS balance INTEGER DEFAULT 0')
        _exec('ALTER TABLE "user" ADD COLUMN IF NOT EXISTS earnings INTEGER DEFAULT 0')

        _exec('ALTER TABLE booking ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN DEFAULT FALSE')
        _exec('ALTER TABLE booking ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMP')
        _exec('ALTER TABLE booking ADD COLUMN IF NOT EXISTS price INTEGER DEFAULT 0')
        _exec("ALTER TABLE booking ADD COLUMN IF NOT EXISTS payment_status VARCHAR DEFAULT 'unpaid'")
        _exec('ALTER TABLE booking ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP')
        _exec("ALTER TABLE booking ADD COLUMN IF NOT EXISTS student_attendance_status VARCHAR DEFAULT 'pending'")
        _exec("ALTER TABLE booking ADD COLUMN IF NOT EXISTS tutor_attendance_status VARCHAR DEFAULT 'pending'")
        _exec('ALTER TABLE booking ADD COLUMN IF NOT EXISTS student_attendance_updated_at TIMESTAMP')
        _exec('ALTER TABLE booking ADD COLUMN IF NOT EXISTS tutor_attendance_updated_at TIMESTAMP')
        _exec('ALTER TABLE booking ADD COLUMN IF NOT EXISTS reschedule_count INTEGER DEFAULT 0')
        _exec("ALTER TABLE booking ADD COLUMN IF NOT EXISTS last_reschedule_reason VARCHAR DEFAULT ''")

        # TutorProfile extensions (v0.7+)
        _exec('ALTER TABLE tutorprofile ADD COLUMN IF NOT EXISTS photo_url VARCHAR')
        _exec('ALTER TABLE tutorprofile ADD COLUMN IF NOT EXISTS age INTEGER')
        _exec('ALTER TABLE tutorprofile ADD COLUMN IF NOT EXISTS education VARCHAR')
        _exec("ALTER TABLE tutorprofile ADD COLUMN IF NOT EXISTS backgrounds_json VARCHAR DEFAULT '[]'")
        _exec("ALTER TABLE tutorprofile ADD COLUMN IF NOT EXISTS grades_json VARCHAR DEFAULT '[]'")
        _exec("ALTER TABLE tutorprofile ADD COLUMN IF NOT EXISTS certificate_links_json VARCHAR DEFAULT '[]'")
        _exec("ALTER TABLE tutorprofile ADD COLUMN IF NOT EXISTS documents_status VARCHAR DEFAULT 'draft'")
        _exec("ALTER TABLE tutorprofile ADD COLUMN IF NOT EXISTS documents_note VARCHAR DEFAULT ''")
        _exec("ALTER TABLE tutorprofile ADD COLUMN IF NOT EXISTS payment_method VARCHAR DEFAULT ''")
        _exec("ALTER TABLE tutorprofile ADD COLUMN IF NOT EXISTS public_schedule_note VARCHAR DEFAULT ''")
        _exec('ALTER TABLE tutorprofile ADD COLUMN IF NOT EXISTS lessons_count INTEGER DEFAULT 0')
        _exec('ALTER TABLE tutorprofile ADD COLUMN IF NOT EXISTS founding_tutor BOOLEAN DEFAULT FALSE')


def get_session():
    with Session(engine) as session:
        yield session
