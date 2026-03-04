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
    # Trial balance (MVP)
    balance: int = Field(default=0)
    earnings: int = Field(default=0)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class TutorProfile(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(index=True)

    # Public
    display_name: str
    photo_url: str = Field(default="")  # avatar / photo URL
    age: Optional[int] = Field(default=None)
    education: str = Field(default="")  # free text (университет/курсы/сертификаты)
    backgrounds_json: str = Field(default="[]")  # JSON list: опыт/бекграунд
    grades_json: str = Field(default="[]")  # JSON list: с какими классами работает

    subjects_json: str = Field(default="[]")  # JSON list
    levels_json: str = Field(default="[]")
    goals_json: str = Field(default="[]")

    price_per_hour: int = Field(default=0)
    language: str = Field(default="ru")

    bio: str = Field(default="")
    video_url: str = Field(default="")

    # Documents for moderation (links to cloud storage)
    certificate_links_json: str = Field(default="[]")  # JSON list of URLs
    documents_status: str = Field(default="draft", index=True)  # draft | pending | approved | rejected
    documents_note: str = Field(default="")

    # Payments "direct to tutor" (shown only after booking / in room)
    payment_method: str = Field(default="")

    # Public schedule note (manual text in profile)
    public_schedule_note: str = Field(default="")

    # Social proof
    rating_avg: float = Field(default=0)
    rating_count: int = Field(default=0)
    lessons_count: int = Field(default=0)

    # Marketplace
    is_published: bool = Field(default=False, index=True)  # tutor wants to be listed
    founding_tutor: bool = Field(default=False, index=True)

    updated_at: datetime = Field(default_factory=datetime.utcnow)



class PlatformCatalog(SQLModel, table=True):
    """Catalog items for filters (subjects/goals/levels/grades/languages)."""

    id: Optional[int] = Field(default=None, primary_key=True)
    kind: str = Field(index=True)  # subject | goal | level | grade | language | exam
    value: str = Field(index=True)
    is_active: bool = Field(default=True, index=True)
    order_index: int = Field(default=0, index=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)


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

    # Attendance confirmation (MVP): each side confirms readiness before lesson.
    student_attendance_status: str = Field(default="pending", index=True)  # pending | confirmed | declined
    tutor_attendance_status: str = Field(default="pending", index=True)  # pending | confirmed | declined
    student_attendance_updated_at: Optional[datetime] = Field(default=None)
    tutor_attendance_updated_at: Optional[datetime] = Field(default=None)

    # Reschedule analytics (MVP): useful for risk flag and weekly digest later.
    reschedule_count: int = Field(default=0)
    last_reschedule_reason: str = Field(default="")

    # Trial balance payment (no real payouts yet)
    price: int = Field(default=0)
    payment_status: str = Field(default='unpaid', index=True)  # unpaid | paid | refunded
    paid_at: Optional[datetime] = Field(default=None)


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


# -----------------
# Learning Plan / Student Library / Quizzes
# -----------------


class StudyPlan(SQLModel, table=True):
    """A lightweight learning plan for a tutor-student pair."""

    id: Optional[int] = Field(default=None, primary_key=True)
    tutor_user_id: int = Field(index=True)
    student_user_id: int = Field(index=True)

    title: str = Field(default="", index=True)
    goal: str = Field(default="")
    status: str = Field(default="active", index=True)  # active | paused | completed

    starts_at: Optional[datetime] = Field(default=None, index=True)
    target_at: Optional[datetime] = Field(default=None, index=True)

    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow, index=True)


class PlanItem(SQLModel, table=True):
    """An item inside a StudyPlan: lesson, milestone, homework task, etc."""

    id: Optional[int] = Field(default=None, primary_key=True)
    plan_id: int = Field(index=True)

    order_index: int = Field(default=0, index=True)
    kind: str = Field(default="milestone", index=True)  # lesson | milestone | task

    title: str = Field(default="", index=True)
    description: str = Field(default="")
    due_at: Optional[datetime] = Field(default=None, index=True)
    status: str = Field(default="todo", index=True)  # todo | in_progress | done
    booking_id: Optional[int] = Field(default=None, index=True)  # optional link to a lesson

    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow, index=True)


class StudentLibraryItem(SQLModel, table=True):
    """Files and links attached to a student (not tied to a booking)."""

    id: Optional[int] = Field(default=None, primary_key=True)
    tutor_user_id: int = Field(index=True)
    student_user_id: int = Field(index=True)
    uploader_user_id: int = Field(index=True)

    title: str = Field(default="")
    tags_json: str = Field(default="[]")

    kind: str = Field(default="file", index=True)  # file | link | note
    url: str = Field(default="")  # used when kind == link

    name: str = Field(default="file")
    mime: str = Field(default="application/octet-stream")
    size_bytes: int = Field(default=0)
    data: bytes = Field(default=b"")  # used when kind == file

    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)


class Quiz(SQLModel, table=True):
    """A quiz created by a tutor for a student."""

    id: Optional[int] = Field(default=None, primary_key=True)
    tutor_user_id: int = Field(index=True)
    student_user_id: int = Field(index=True)

    title: str = Field(index=True)
    description: str = Field(default="")
    status: str = Field(default="draft", index=True)  # draft | published | closed

    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow, index=True)


class QuizQuestion(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    quiz_id: int = Field(index=True)
    kind: str = Field(default="mcq", index=True)  # mcq | short
    prompt: str = Field(default="")
    options_json: str = Field(default="[]")  # for mcq
    correct_json: str = Field(default="{}")  # {"index": 0} or {"answers": ["..."]}
    points: int = Field(default=1)
    order_index: int = Field(default=0, index=True)


class QuizAttempt(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    quiz_id: int = Field(index=True)
    tutor_user_id: int = Field(index=True)
    student_user_id: int = Field(index=True)

    started_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    submitted_at: Optional[datetime] = Field(default=None, index=True)

    score: int = Field(default=0)
    max_score: int = Field(default=0)
    answers_json: str = Field(default="[]")  # list[{question_id, answer}]



# -----------------
# Trial balance ledger
# -----------------


class BalanceTx(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(index=True)
    amount: int
    kind: str = Field(default='topup', index=True)  # topup | pay | earn | adjust
    booking_id: Optional[int] = Field(default=None, index=True)
    note: str = Field(default='')
    created_at: datetime = Field(default_factory=datetime.utcnow)


# -----------------
# Growth & Retention extensions (MVP+)
# -----------------


class ParentContact(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    student_user_id: int = Field(index=True, unique=True)
    parent_name: str = Field(default="")
    relationship: str = Field(default="parent")
    parent_email: str = Field(default="")
    parent_telegram_chat_id: str = Field(default="")
    notify_lessons: bool = Field(default=True, index=True)
    notify_homework: bool = Field(default=True, index=True)
    notify_comments: bool = Field(default=True, index=True)
    is_active: bool = Field(default=True, index=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow, index=True)


class TutorMethodology(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    tutor_user_id: int = Field(index=True, unique=True)
    fit_for: str = Field(default="")
    lesson_flow: str = Field(default="")
    homework_load: str = Field(default="")
    first_month_plan: str = Field(default="")
    avg_results: str = Field(default="")
    updated_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class TutorStudentCRMCard(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    tutor_user_id: int = Field(index=True)
    student_user_id: int = Field(index=True)
    goal: str = Field(default="")
    weak_topics_json: str = Field(default="[]")
    notes: str = Field(default="")
    tags_json: str = Field(default="[]")
    updated_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class LessonNote(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    booking_id: int = Field(index=True)
    tutor_user_id: int = Field(index=True)
    student_user_id: int = Field(index=True)
    lesson_summary: str = Field(default="")
    weak_topics_json: str = Field(default="[]")
    homework_assigned: str = Field(default="")
    homework_checked: str = Field(default="")
    tutor_comment_for_parent: str = Field(default="")
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    updated_at: datetime = Field(default_factory=datetime.utcnow, index=True)


class TutorMessageTemplate(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    tutor_user_id: int = Field(index=True)
    kind: str = Field(default="general", index=True)  # reminder | repeat | homework | reschedule | general
    title: str = Field(default="")
    body: str = Field(default="")
    channel: str = Field(default="email", index=True)  # email | telegram
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow, index=True)


class WaitlistEntry(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    student_user_id: int = Field(index=True)
    tutor_user_id: Optional[int] = Field(default=None, index=True)
    slot_id: Optional[int] = Field(default=None, index=True)
    subject: str = Field(default="", index=True)
    desired_from: Optional[datetime] = Field(default=None, index=True)
    desired_to: Optional[datetime] = Field(default=None, index=True)
    status: str = Field(default="active", index=True)  # active | notified | fulfilled | cancelled
    note: str = Field(default="")
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    updated_at: datetime = Field(default_factory=datetime.utcnow, index=True)


class LastMinuteAlertSubscription(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    student_user_id: int = Field(index=True)
    tutor_user_id: Optional[int] = Field(default=None, index=True)
    subject: str = Field(default="", index=True)
    only_today: bool = Field(default=True, index=True)
    is_active: bool = Field(default=True, index=True)
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)


class RecurringBookingSeries(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    tutor_user_id: int = Field(index=True)
    student_user_id: int = Field(index=True)
    weekdays_json: str = Field(default="[]")
    time_hm: str = Field(default="18:00")
    duration_minutes: int = Field(default=60)
    weeks_ahead: int = Field(default=4)
    auto_attendance_confirm: bool = Field(default=False)
    status: str = Field(default="active", index=True)  # active | paused | cancelled
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow, index=True)


class RecurringBookingSeriesItem(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    series_id: int = Field(index=True)
    booking_id: int = Field(index=True)
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)


class ExamTrack(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    student_user_id: int = Field(index=True)
    tutor_user_id: Optional[int] = Field(default=None, index=True)
    exam_kind: str = Field(default="ЕГЭ", index=True)
    exam_subject: str = Field(default="")
    exam_date: Optional[datetime] = Field(default=None, index=True)
    target_score: int = Field(default=0)
    current_score: int = Field(default=0)
    readiness_percent: int = Field(default=0)
    weak_topics_json: str = Field(default="[]")
    plan_by_weeks_json: str = Field(default="[]")
    notes: str = Field(default="")
    updated_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class BookingMeta(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    booking_id: int = Field(index=True, unique=True)
    booking_type: str = Field(default="regular", index=True)  # regular | trial
    tutor_comment: str = Field(default="")
    tutor_comment_sent_at: Optional[datetime] = Field(default=None, index=True)
    recurring_series_id: Optional[int] = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow, index=True)


class NotificationLog(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    recipient_key: str = Field(index=True)
    entity_kind: str = Field(index=True)  # booking | homework | slot | digest
    entity_id: int = Field(index=True)
    kind: str = Field(index=True)  # homework_24h | parent_completed | ...
    sent_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    note: str = Field(default="")


class ReviewDetail(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    review_id: int = Field(index=True, unique=True)
    explains_rating: Optional[int] = Field(default=None)
    punctuality_rating: Optional[int] = Field(default=None)
    materials_rating: Optional[int] = Field(default=None)
    result_rating: Optional[int] = Field(default=None)
    lessons_before_review: int = Field(default=0)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow, index=True)
