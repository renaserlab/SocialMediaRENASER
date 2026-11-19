"""Lo que acepta `POST /telemetria/video`. Estricto a proposito.

Es un endpoint SIN SESION (Inicio funciona sin cuenta), asi que lo puede llamar
cualquiera con cualquier cosa. Por eso nada es libre: campos desconocidos
rechazados, textos cortos y con un juego de caracteres cerrado, numeros con
rango, listas con tope. Lo que no encaje se rechaza entero: una medicion a
medias o inventada es peor que ninguna.

Las formas son las de `apps/mobile/src/lib/medicionDeVideo.ts`; si cambian alli,
cambian aqui.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

#: Igual que `MS_MAXIMO` en el movil: dos minutos. Mas alla no es una medida util.
MS_MAXIMO = 120_000

#: Igual que `TOPE_DE_EVENTOS` en el movil.
TOPE_DE_TRAMOS = 30

#: El cuerpo mas grande que se lee. Un lote lleno pesa ~4,7 KB (medido en la
#: prueba del movil); 16 KB deja margen sin abrir la puerta a nada.
CUERPO_MAXIMO_BYTES = 16 * 1024

Ms = Annotated[int, Field(ge=0, le=MS_MAXIMO)]

#: Letras (incluidas las acentuadas), digitos y la puntuacion que aparece en los
#: nombres de modelo y de version: «iPhone 13 Pro», «SM-G991B», «iOS 18.1».
_TEXTO = r"^[\w .,()+/-]*$"


def _texto(maximo: int):  # noqa: ANN202
    return Annotated[str | None, Field(max_length=maximo, pattern=_TEXTO)]


class _Estricto(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ContextoDelEquipo(_Estricto):
    plataforma: Literal["ios", "android", "web"]
    version_app: _texto(32) = None
    build: _texto(32) = None
    modelo: _texto(64) = None
    sistema: _texto(32) = None
    red: _texto(16) = None


class Hitos(_Estricto):
    feed_pedido: Ms | None = None
    feed_respuesta: Ms | None = None
    urls_firmadas: Ms | None = None
    primer_fotograma: Ms | None = None
    primera_reproduccion: Ms | None = None


class TramoDeVideo(_Estricto):
    tipo: Literal["primer_video", "deslizamiento", "otro"]
    hasta_reproducir_ms: Ms | None = None
    hasta_fotograma_ms: Ms | None = None
    esperas: int = Field(default=0, ge=0, le=1000)
    espera_ms: Ms = 0
    formato: Literal["hls", "mp4"]
    #: De donde salio el video. Opcional: un cliente que no lo mande cuenta como Supabase.
    almacen: Literal["supabase", "s3"] = "supabase"
    #: Hasta 10 GB: ningun video subido pesa mas (el limite de subida es 500 MB).
    bytes: int | None = Field(default=None, ge=0, le=10 * 1024**3)
    error: bool = False


class LoteDeMedicion(_Estricto):
    sesion: str = Field(pattern=r"^[0-9a-f]{16}$")
    contexto: ContextoDelEquipo
    hitos: Hitos = Field(default_factory=Hitos)
    tramos: list[TramoDeVideo] = Field(default_factory=list, max_length=TOPE_DE_TRAMOS)


class Recepcion(BaseModel):
    aceptado: bool
    filas: int


class Resumen(BaseModel):
    plataforma: str
    tramo: str
    #: Solo en los tramos de video; en los hitos de carga va vacio.
    almacen: str | None = None
    n: int
    #: Cuantas de esas mediciones no llegaron a reproducir (solo en tramos).
    sin_reproducir: int = 0
    mediana_ms: int | None
    p75_ms: int | None
    p90_ms: int | None
    #: Fraccion de tramos con al menos una espera tras arrancar.
    con_esperas: float | None = None
    mediana_espera_ms: int | None = None


class InformeDeVideo(BaseModel):
    dias: int
    desde: str
    filas_leidas: int
    #: Se leyeron menos filas de las que hay: los numeros son de las mas recientes.
    recortado: bool
    resumen: list[Resumen]
