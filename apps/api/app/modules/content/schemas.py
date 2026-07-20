"""Esquemas Pydantic de contenido."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class AuthorSummary(BaseModel):
    id: str
    full_name: str
    username: str | None = None
    avatar_path: str | None = None


class PostCreate(BaseModel):
    # OJO: sin author_id. El autor se toma del JWT (current_user.id).
    body: str = Field(min_length=1, max_length=3000)
    visibility: str = Field(default="public", pattern=r"^(public|followers|circle)$")


class PostRead(BaseModel):
    id: str
    author: AuthorSummary
    body: str
    status: str
    visibility: str
    created_at: datetime
    likes_count: int = 0
    comments_count: int = 0
    liked_by_me: bool = False
    saved_by_me: bool = False

    model_config = ConfigDict(from_attributes=True)


class CommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=1200)
    parent_id: str | None = None


class CommentRead(BaseModel):
    id: str
    post_id: str
    author: AuthorSummary
    parent_id: str | None
    body: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
