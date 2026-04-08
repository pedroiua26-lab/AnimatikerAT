"""FastAPI application entrypoint for Animatic Analyzer."""

from __future__ import annotations

import json
import os
import re
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated

import resend
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
import jwt as _jwt
from jwt.exceptions import InvalidTokenError as _JWTError
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr
from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text, create_engine
from sqlalchemy.orm import Session, declarative_base, relationship, sessionmaker

from .scenes import SceneDetectionError, analyze_scenes
from .utils import ensure_directories, output_report_path, unique_upload_path, write_json_report

load_dotenv()

RESEND_API_KEY = os.getenv("RESEND_API_KEY")
FRONTEND_URL = os.getenv(
    "FRONTEND_URL", "https://pedroiua26-lab.github.io/AnimatikerAT/frontend"
)
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY")
if not JWT_SECRET_KEY:
    print("WARNING: JWT_SECRET_KEY not set. Using insecure development fallback key.")
    JWT_SECRET_KEY = "unsafe-dev-only-change-me"

if not RESEND_API_KEY:
    print("WARNING: RESEND_API_KEY not set")
else:
    resend.api_key = RESEND_API_KEY

DATABASE_URL = "sqlite:///./animatic.db"
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
Base = declarative_base()
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
PASSWORD_REGEX = re.compile(r"^[0-9]{6}$")
JWT_ALGORITHM = "HS256"
JWT_EXPIRATION_HOURS = 24
VERIFY_TOKEN_EXPIRATION_HOURS = 48
ALLOWED_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, nullable=False, index=True)
    password_hash = Column(String, nullable=True)
    is_verified = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(UTC), nullable=False)
    projects = relationship("Project", back_populates="user", cascade="all, delete-orphan")


class Project(Base):
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    video_name = Column(String, nullable=False)
    markers_json = Column(Text, nullable=False)
    duration = Column(Float, nullable=False, default=0.0)
    created_at = Column(DateTime, default=lambda: datetime.now(UTC), nullable=False)
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
        nullable=False,
    )

    user = relationship("User", back_populates="projects")


class RegisterRequest(BaseModel):
    email: EmailStr


class VerifyRequest(BaseModel):
    token: str
    password: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class CreateProjectRequest(BaseModel):
    name: str
    video_name: str
    markers: list[dict]
    duration: float


class UpdateProjectRequest(BaseModel):
    name: str
    video_name: str
    markers: list[dict]
    duration: float


app = FastAPI(title="Animatic Analyzer API", version="1.2.0")

_default_origins = "https://pedroiua26-lab.github.io"
_extra_origins = os.getenv("ALLOWED_ORIGINS", "")
_allowed_origins = [o.strip() for o in (_default_origins + "," + _extra_origins).split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def validate_password(password: str) -> None:
    if not PASSWORD_REGEX.fullmatch(password):
        raise HTTPException(status_code=400, detail="Password must be exactly 6 digits.")


def create_access_token(user_id: int) -> str:
    expires_at = datetime.now(UTC) + timedelta(hours=JWT_EXPIRATION_HOURS)
    payload = {"sub": str(user_id), "exp": expires_at}
    return _jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def create_verification_token(email: str) -> str:
    """Return a signed JWT that proves ownership of *email* for verification.

    Storing the token in the database is not needed — the JWT is self-contained
    and survives server restarts (unlike a UUID stored in ephemeral SQLite).
    """
    expires_at = datetime.now(UTC) + timedelta(hours=VERIFY_TOKEN_EXPIRATION_HOURS)
    payload = {"sub": email, "typ": "verify", "exp": expires_at}
    return _jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def decode_verification_token(token: str) -> str:
    """Decode a verification JWT and return the email address it contains."""
    try:
        payload = _jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
    except _JWTError as exc:
        raise HTTPException(status_code=400, detail="Invalid or expired verification link. Please register again.") from exc
    if payload.get("typ") != "verify":
        raise HTTPException(status_code=400, detail="Invalid verification link.")
    email = payload.get("sub")
    if not email:
        raise HTTPException(status_code=400, detail="Invalid verification link.")
    return email


def get_current_user(
    authorization: Annotated[str | None, Header()] = None,
    db: Session = Depends(get_db),
) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token.")

    token = authorization.replace("Bearer ", "", 1).strip()
    try:
        payload = _jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
        user_id = int(payload.get("sub", "0"))
    except (_JWTError, ValueError) as exc:
        raise HTTPException(status_code=401, detail="Invalid token.") from exc

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found.")
    return user


def send_verification_email(email: str, token: str) -> None:
    if not RESEND_API_KEY:
        print("WARNING: RESEND_API_KEY not set")
        return

    verify_link = f"{FRONTEND_URL}/verify.html?token={token}"

    try:
        resend.Emails.send(
            {
                "from": "onboarding@resend.dev",
                "to": email,
                "subject": "Confirm your account",
                "html": f"""
                    <h2>Confirm your email</h2>
                    <p>Click below:</p>
                    <a href=\"{verify_link}\">{verify_link}</a>
                """,
            }
        )
    except Exception as exc:  # pragma: no cover - network service path
        print("Email send error:", exc)


@app.on_event("startup")
def startup_event() -> None:
    ensure_directories()
    Base.metadata.create_all(bind=engine)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/register")
def register(payload: RegisterRequest, db: Session = Depends(get_db)) -> dict[str, str]:
    existing = db.query(User).filter(User.email == payload.email).first()
    if existing and existing.is_verified:
        raise HTTPException(status_code=400, detail="Email already registered.")

    # Token is a signed JWT — no need to store it in the database.
    # This means the token remains valid even if the server restarts and the
    # SQLite database is wiped (common on Render free tier).
    token = create_verification_token(payload.email)

    if existing:
        existing.is_verified = False
        existing.password_hash = None
    else:
        db.add(User(email=payload.email, is_verified=False))

    db.commit()
    send_verification_email(payload.email, token)
    return {"message": "Registration started. Check your email for verification."}


@app.post("/verify")
def verify(payload: VerifyRequest, db: Session = Depends(get_db)) -> dict[str, bool]:
    validate_password(payload.password)
    # Decode the JWT — this validates the signature and expiration without any
    # database lookup. The token is self-contained.
    email = decode_verification_token(payload.token)

    user = db.query(User).filter(User.email == email).first()
    if user and user.is_verified:
        raise HTTPException(status_code=400, detail="Account already verified. Please log in.")

    if not user:
        # JWT is valid (proves the email was registered), but the database was
        # wiped (Render redeploy). Re-create the user so verification can proceed.
        user = User(email=email, is_verified=False)
        db.add(user)

    user.password_hash = pwd_context.hash(payload.password)
    user.is_verified = True
    db.commit()
    return {"success": True}


@app.post("/login")
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> dict[str, str]:
    user = db.query(User).filter(User.email == payload.email).first()
    if not user or not user.password_hash:
        raise HTTPException(status_code=401, detail="Invalid credentials.")
    if not user.is_verified:
        raise HTTPException(status_code=403, detail="Please verify your email first.")
    if not pwd_context.verify(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials.")

    token = create_access_token(user.id)
    return {"access_token": token, "token_type": "bearer"}


@app.get("/me")
def me(current_user: User = Depends(get_current_user)) -> dict[str, str]:
    return {"email": current_user.email}


@app.post("/projects")
def create_project(
    payload: CreateProjectRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, int | str]:
    project = Project(
        user_id=current_user.id,
        name=payload.name,
        video_name=payload.video_name,
        markers_json=json.dumps(payload.markers),
        duration=payload.duration,
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return {"id": project.id, "message": "Project saved."}


@app.get("/projects")
def list_projects(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict]:
    projects = (
        db.query(Project)
        .filter(Project.user_id == current_user.id)
        .order_by(Project.updated_at.desc())
        .all()
    )
    return [
        {
            "id": project.id,
            "name": project.name,
            "video_name": project.video_name,
            "duration": project.duration,
            "updated_at": project.updated_at.isoformat() if project.updated_at else None,
        }
        for project in projects
    ]


@app.get("/projects/{project_id}")
def get_project(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    project = (
        db.query(Project)
        .filter(Project.id == project_id, Project.user_id == current_user.id)
        .first()
    )
    if not project:
        raise HTTPException(status_code=404, detail="Project not found.")

    return {
        "id": project.id,
        "name": project.name,
        "video_name": project.video_name,
        "markers": json.loads(project.markers_json),
        "duration": project.duration,
    }


@app.put("/projects/{project_id}")
def update_project(
    project_id: int,
    payload: UpdateProjectRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    project = (
        db.query(Project)
        .filter(Project.id == project_id, Project.user_id == current_user.id)
        .first()
    )
    if not project:
        raise HTTPException(status_code=404, detail="Project not found.")

    project.name = payload.name
    project.video_name = payload.video_name
    project.markers_json = json.dumps(payload.markers)
    project.duration = payload.duration
    project.updated_at = datetime.now(UTC)
    db.commit()
    return {"message": "Project updated."}


@app.delete("/projects/{project_id}")
def delete_project(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    project = (
        db.query(Project)
        .filter(Project.id == project_id, Project.user_id == current_user.id)
        .first()
    )
    if not project:
        raise HTTPException(status_code=404, detail="Project not found.")

    db.delete(project)
    db.commit()
    return {"message": "Project deleted."}


@app.post("/analyze/")
async def analyze_video(
    file: UploadFile = File(...),
    mode: str = Query(default="animatic", pattern="^(animation|animatic)$"),
    min_scene_duration_frames: int = Query(default=12, ge=1),
) -> list[dict[str, int]]:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Filename is required.")

    extension = Path(file.filename).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file extension '{extension}'. Allowed: {sorted(ALLOWED_EXTENSIONS)}",
        )

    upload_path = unique_upload_path(file.filename)

    try:
        with upload_path.open("wb") as out_file:
            shutil.copyfileobj(file.file, out_file)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save upload: {exc}") from exc
    finally:
        file.file.close()

    try:
        scenes = analyze_scenes(
            upload_path,
            mode=mode,
            min_scene_duration_frames=min_scene_duration_frames,
        )
        write_json_report(output_report_path(upload_path), scenes)
    except SceneDetectionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - defensive path.
        raise HTTPException(status_code=500, detail=f"Unexpected analysis error: {exc}") from exc

    return scenes
