"""Esquemas Pydantic de historias."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.modules.content.schemas import AuthorSummary

# Tope de duracion de un tramo, en milisegundos (coincide con el CHECK de la
# migracion 0042, ya aplicada). En video es su duracion real; en imagen, el
# tiempo del visor.
#
# El numero vive en dos sitios y solo dos: aqui y en
# `apps/mobile/src/lib/historias.ts` (mas el CHECK de la base, que es el mismo
# valor escrito en SQL). Llego a estar copiado en cinco pantallas del movil; con
# cinco copias basta cambiar cuatro para que la camara corte a un tiempo y el
# control de subida rechace a otro.
#
# LO QUE ESTE VALOR *NO* ES, POR SI SOLO: una comprobacion de la duracion real.
# Es un numero que manda el cliente, y ni Pydantic ni el CHECK pueden saber si
# el archivo dura de verdad eso. Quien SI lo sabe es ffprobe, y esta en esta
# imagen desde el 27/08/2026: `stories/recorte.py` mide el archivo subido antes
# de dejar que se publique, y `POST /stories` no crea la fila si el video pasa
# del tope y nadie ha elegido un tramo.
MAX_DURATION_MS = 30_000

#: Minimo que admite la base (`check (duration_ms between 1000 and 30000)`).
#: Por debajo, el visor ni parpadea.
MIN_DURATION_MS = 1_000


class StoryTrim(BaseModel):
    """El tramo que se queda de un video, en ms desde el principio.

    Es una PETICION, no un hecho: lo que decide es `recorte.revisar_tramo`
    contra la duracion que mide ffprobe sobre el archivo ya subido. Aqui solo se
    filtra lo que ni siquiera tiene forma de tramo.
    """

    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)


class StoryCreate(BaseModel):
    """Historia nueva. El autor sale del JWT, nunca del cuerpo."""

    storage_path: str = Field(min_length=1, max_length=500)
    media_type: str = Field(pattern=r"^(image|video)$")
    duration_ms: int = Field(default=5000, ge=MIN_DURATION_MS, le=MAX_DURATION_MS)
    caption: str = Field(default="", max_length=200)
    #: Presente solo cuando se ha elegido un tramo. El recorte lo hace el
    #: SERVIDOR (ver `stories/recorte.py`), porque en el telefono no se puede.
    trim: StoryTrim | None = None


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
