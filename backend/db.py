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
    elif dialect.startswith("postgres"):
        _exec('ALTER TABLE "user" ADD COLUMN IF NOT EXISTS telegram_chat_id VARCHAR')
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


def get_session():
    with Session(engine) as session:
        yield session
