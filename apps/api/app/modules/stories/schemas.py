"""Esquemas Pydantic de historias."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.modules.content.schemas import AuthorSummary

# Tope de duracion de un tramo, en milisegundos (coincide con el CHECK de la
# migracion 0042). En video es su duracion real; en imagen, el tiempo del visor.
#
# SUBE DE 15 A 30 SEGUNDOS, que es lo que pidio el encargo. El numero tiene que
# moverse a la vez en tres sitios o algo se rompe: aqui, en el CHECK de la base
# (migracion 0042, escrita y SIN aplicar) y en `apps/mobile/src/lib/historias.ts`.
#
# LO QUE ESTE VALOR *NO* ES: una comprobacion de la duracion real. Es un numero
# que manda el cliente, y ni Pydantic ni el CHECK pueden saber si el archivo
# dura de verdad eso. Verificarlo pide leer el medio con ffprobe —que SI esta en
# esta imagen (ver `content/media_processing.py`)— y para eso las historias
# tendrian que pasar por esta API, cosa que hoy no hacen: el movil las inserta
# directamente contra PostgREST (ver `StoryRepository`). Mientras siga siendo
# asi, el limite real es el del dispositivo, que ahora si mide el archivo antes
# de subirlo (`lib/historias.ts` + `readVideoMetadata`).
MAX_DURATION_MS = 30_000


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
