from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class ProfileCreate(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=3, max_length=120)
    username: str = Field(min_length=3, max_length=50, pattern=r"^[a-zA-Z0-9_.-]+$")
    bio: str = Field(default="", max_length=600)


class ProfileRead(ProfileCreate):
    id: str
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class PostCreate(BaseModel):
    author_id: str
    body: str = Field(min_length=1, max_length=3000)
    media_url: str | None = None


class PostRead(BaseModel):
    id: str
    author_id: str
    body: str
    media_url: str | None
    status: str
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class EventCreate(BaseModel):
    title: str = Field(min_length=3, max_length=180)
    description: str = Field(min_length=3, max_length=3000)
    starts_at: datetime
    location: str = Field(min_length=2, max_length=255)
    is_online: bool = False


class EventRead(EventCreate):
    id: str
    model_config = ConfigDict(from_attributes=True)


class CourseCreate(BaseModel):
    title: str = Field(min_length=3, max_length=180)
    description: str = Field(min_length=3, max_length=5000)
    price_minor: int = Field(ge=0)
    currency: str = Field(default="PEN", min_length=3, max_length=3)
    published: bool = False


class CourseRead(CourseCreate):
    id: str
    model_config = ConfigDict(from_attributes=True)
