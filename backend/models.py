from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlmodel import SQLModel, Field


class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    email: str = Field(index=True, unique=True)
    password_hash: str
    role: str = Field(default="student", index=True)  # student | tutor | admin
    is_active: bool = Field(default=True, index=True)
    token_version: int = Field(default=0)
    last_login_at: Optional[datetime] = Field(default=None)
    # Notifications (MVP)
    telegram_chat_id: Optional[str] = Field(default=None)
    notify_email: bool = Field(default=True)
    notify_telegram: bool = Field(default=False)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class TutorProfile(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(index=True)

    display_name: str
    subjects_json: str = Field(default="[]")  # JSON list
    levels_json: str = Field(default="[]")
    goals_json: str = Field(default="[]")

    price_per_hour: int = Field(default=0)
    language: str = Field(default="ru")

    bio: str = Field(default="")
    video_url: str = Field(default="")

    rating_avg: float = Field(default=0)
    rating_count: int = Field(default=0)

    is_published: bool = Field(default=False, index=True)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class Slot(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    tutor_user_id: int = Field(index=True)

    starts_at: datetime = Field(index=True)
    ends_at: datetime

    status: str = Field(default="open", index=True)  # open | booked | cancelled


class Booking(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    slot_id: int = Field(index=True)
    tutor_user_id: int = Field(index=True)
    student_user_id: int = Field(index=True)

    created_at: datetime = Field(default_factory=datetime.utcnow)
    status: str = Field(default="confirmed", index=True)  # confirmed | cancelled | done
    reminder_sent: bool = Field(default=False, index=True)
    reminder_sent_at: Optional[datetime] = Field(default=None)


class Review(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    booking_id: int = Field(index=True)
    tutor_user_id: int = Field(index=True)
    student_user_id: int = Field(index=True)

    stars: int
    text: str = Field(default="")
    created_at: datetime = Field(default_factory=datetime.utcnow)


class LessonArtifact(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    booking_id: int = Field(index=True)
    kind: str = Field(default="")  # whiteboard_png | whiteboard_pdf | ...
    mime: str = Field(default="application/octet-stream")
    data: bytes = Field(default=b"")
    created_at: datetime = Field(default_factory=datetime.utcnow)


# -----------------
# Learning tools (Homework / Progress / Pre-lesson mini-test)
# -----------------


class LessonMaterial(SQLModel, table=True):
    """Arbitrary files for a booking (homework sheets, pdf, images, etc.)."""

    id: Optional[int] = Field(default=None, primary_key=True)
    booking_id: int = Field(index=True)
    uploader_user_id: int = Field(index=True)
    name: str = Field(default="file")
    mime: str = Field(default="application/octet-stream")
    size_bytes: int = Field(default=0)
    data: bytes = Field(default=b"")
    created_at: datetime = Field(default_factory=datetime.utcnow)


class Homework(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    tutor_user_id: int = Field(index=True)
    student_user_id: int = Field(index=True)
    booking_id: Optional[int] = Field(default=None, index=True)

    title: str
    description: str = Field(default="")
    due_at: Optional[datetime] = Field(default=None, index=True)
    status: str = Field(default="assigned", index=True)  # assigned | submitted | checked

    submission_text: str = Field(default="")
    submitted_at: Optional[datetime] = Field(default=None)

    feedback_text: str = Field(default="")
    checked_at: Optional[datetime] = Field(default=None)

    created_at: datetime = Field(default_factory=datetime.utcnow)


class TopicProgress(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    tutor_user_id: int = Field(index=True)
    student_user_id: int = Field(index=True)

    topic: str = Field(index=True)
    status: str = Field(default="todo", index=True)  # todo | in_progress | done
    note: str = Field(default="")
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class PreLessonCheckin(SQLModel, table=True):
    """Mini-test / check-in before lesson."""

    id: Optional[int] = Field(default=None, primary_key=True)
    booking_id: int = Field(index=True, unique=True)
    tutor_user_id: int = Field(index=True)
    student_user_id: int = Field(index=True)

    questions_json: str = Field(default="[]")  # list[str]
    answers_json: str = Field(default="[]")  # list[str]
    submitted_at: Optional[datetime] = Field(default=None, index=True)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class IssueReport(SQLModel, table=True):
    """Simple support ticket / report (MVP).

    Used for: "problem with lesson", user reports, abuse, etc.
    """

    id: Optional[int] = Field(default=None, primary_key=True)
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)

    booking_id: Optional[int] = Field(default=None, index=True)
    reporter_user_id: int = Field(index=True)
    reported_user_id: Optional[int] = Field(default=None, index=True)

    category: str = Field(default="general", index=True)  # general | lesson | user | payments (future)
    message: str = Field(default="")

    status: str = Field(default="open", index=True)  # open | resolved
    resolved_by_user_id: Optional[int] = Field(default=None, index=True)
    resolved_at: Optional[datetime] = Field(default=None)
