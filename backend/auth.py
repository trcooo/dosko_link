from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple

from fastapi import Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer
from jose import jwt, JWTError
from passlib.context import CryptContext
from sqlmodel import Session, select

from db import get_session
from models import User

# -----------------
# Security settings
# -----------------
# IMPORTANT: Set DL_JWT_SECRET in Railway Variables.
SECRET_KEY = os.getenv("DL_JWT_SECRET", "dev-secret-change-me")
ALGORITHM = "HS256"

ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("DL_ACCESS_EXPIRE_MIN", "15"))
REFRESH_TOKEN_EXPIRE_DAYS = int(os.getenv("DL_REFRESH_EXPIRE_DAYS", "30"))

pwd_context = CryptContext(schemes=["bcrypt_sha256"], deprecated="auto")

# The frontend sends the access token in Authorization: Bearer <token>
# Refresh token is stored in an HttpOnly cookie handled by the backend.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _encode(payload: dict, expires_delta: timedelta) -> str:
    exp = _utcnow() + expires_delta
    payload = {**payload, "exp": exp}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def create_access_token(user: User) -> str:
    return _encode(
        {
            "sub": str(user.id),
            "role": user.role,
            "tv": int(getattr(user, "token_version", 0)),
            "typ": "access",
        },
        timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
    )


def create_refresh_token(user: User) -> str:
    return _encode(
        {
            "sub": str(user.id),
            "tv": int(getattr(user, "token_version", 0)),
            "typ": "refresh",
        },
        timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
    )


def _get_user_by_id(session: Session, user_id: int) -> Optional[User]:
    return session.exec(select(User).where(User.id == user_id)).first()


def decode_and_get_user(
    token: str,
    session: Session,
    expected_typ: str,
) -> Tuple[dict, User]:
    """Decode JWT, verify token type, and return (payload, user)."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        if payload.get("typ") != expected_typ:
            raise HTTPException(status_code=401, detail="Invalid token")
        sub = payload.get("sub")
        if not sub:
            raise HTTPException(status_code=401, detail="Invalid token")
        try:
            user_id = int(sub)
        except Exception:
            raise HTTPException(status_code=401, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

    user = _get_user_by_id(session, user_id)
    if not user or not getattr(user, "is_active", True):
        raise HTTPException(status_code=401, detail="Invalid authentication")

    # Token version check allows server-side logout / revoke all tokens.
    tv = int(payload.get("tv") or 0)
    if int(getattr(user, "token_version", 0)) != tv:
        raise HTTPException(status_code=401, detail="Session expired")

    return payload, user


def get_current_user(
    token: str = Depends(oauth2_scheme),
    session: Session = Depends(get_session),
) -> User:
    _, user = decode_and_get_user(token, session, expected_typ="access")
    return user


def require_role(*roles: str):
    def _inner(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=403, detail="Forbidden")
        return user

    return _inner
