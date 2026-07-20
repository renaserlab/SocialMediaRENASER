"""Esquemas de comunidades."""

from pydantic import BaseModel, ConfigDict


class CircleRead(BaseModel):
    id: str
    owner_id: str
    name: str
    description: str
    cover_path: str | None = None
    is_private: bool = True
    members_count: int = 0
    is_member: bool = False

    model_config = ConfigDict(from_attributes=True)
