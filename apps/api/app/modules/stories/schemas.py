"""Esquemas Pydantic de historias."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.modules.content.schemas import AuthorSummary

# Tope de duracion de un tramo, en milisegundos (coincide con el CHECK de la
# migracion). En video es su duracion real; en imagen, el tiempo del visor.
MAX_DURATION_MS = 15_000


class StoryCreate(BaseModel):
    """Historia nueva. El autor sale del JWT, nunca del cuerpo."""

    storage_path: str = Field(min_length=1, max_length=500)
    media_type: str = Field(pattern=r"^(image|video)$")
    duration_ms: int = Field(default=5000, ge=1000, le=MAX_DURATION_MS)
    caption: str = Field(default="", max_length=200)


class StoryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    storage_path: str
    media_type: str
    duration_ms: int
    caption: str
    created_at: datetime
    expires_at: datetime

    viewed_by_me: bool = False
    #: Solo se rellena en las historias propias.
    views_count: int = 0


class StoryGroupRead(BaseModel):
    """Las historias de un mismo autor, en el orden en que se publicaron.

    El movil pinta una burbuja por grupo y recorre `items` dentro del visor.
    """

    author: AuthorSummary
    items: list[StoryRead] = Field(default_factory=list)
    #: False si queda algun tramo sin ver: es lo que decide el anillo.
    seen: bool = False
    is_own: bool = False


class StoryViewerRead(BaseModel):
    viewer: AuthorSummary
    viewed_at: datetime
