"""Telemetria de velocidad de los videos de Inicio, medida en los telefonos.

POR QUE VA APARTE DE `recommendations/events`. Aquel endpoint alimenta al
recomendador: lo que entra ahi cambia lo que ve la gente. Esto es medicion de
rendimiento y no puede rozarlo: otra ruta, otra tabla (`metricas_de_video`,
migracion 0115) y ningun dato de persona.

DOS RUTAS:

  · `POST /telemetria/video` — SIN SESION, porque Inicio se ve sin cuenta. El
    cliente manda un lote por arranque (`apps/mobile/src/lib/medicionDeVideo`).
    Responde 202 en cuanto valida; la escritura va DESPUES de la respuesta, en
    segundo plano, y si falla se pierde (es medicion, no un dato de negocio).
  · `GET /admin/telemetria/video?dias=7` — solo administracion: medianas y
    percentiles por plataforma y tramo.

LIMITES, porque cualquiera puede llamar a la primera:
  · el cuerpo se lee con tope (16 KB) antes de interpretarlo;
  · la validacion es estricta (`schemas.py`);
  · ritmo por IP, en memoria del proceso, con el mismo limitador que el chat en
    directo (`live/limites.py`; sus limitaciones estan explicadas alli).
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, Query, Request, status
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppError, ValidationAppError
from app.core.logging import get_logger
from app.core.security import AuthUser
from app.modules.gobernanza.contexto import _ip_del_cliente
from app.modules.live.limites import VentanaDeslizante
from app.modules.telemetria.models import MetricaDeVideo
from app.modules.telemetria.schemas import (
    CUERPO_MAXIMO_BYTES,
    InformeDeVideo,
    LoteDeMedicion,
    Recepcion,
    Resumen,
)
from app.shared.database import SessionLocal, get_db
from app.shared.permissions import require_admin

logger = get_logger("renaser.telemetria")

router = APIRouter(prefix="/telemetria", tags=["telemetria"])
admin_router = APIRouter(prefix="/admin/telemetria", tags=["telemetria"])

#: Lotes por IP en la ventana. El movil manda UNO por arranque: veinte en diez
#: minutos es abrir y cerrar la app veinte veces, y aun asi cabe una oficina
#: entera detras de la misma IP. Un bucle se corta aqui.
LOTES_POR_IP = 20
VENTANA_POR_IP = timedelta(minutes=10)
por_ip = VentanaDeslizante(LOTES_POR_IP, VENTANA_POR_IP)

#: Tope global del proceso, para cuando no se sabe la IP (sin
#: `TRUST_PROXY_HEADERS`, detras del proxy todas parecen la misma): sin el, o
#: se limitaba a todo el mundo como si fuera una persona, o no se limitaba nada.
LOTES_POR_MINUTO_SIN_IP = 600
sin_ip = VentanaDeslizante(LOTES_POR_MINUTO_SIN_IP, timedelta(minutes=1))

#: Cuantas filas lee como mucho el informe. Con el volumen de hoy son semanas;
#: si algun dia se recorta, el informe lo dice (`recortado`).
FILAS_MAXIMAS_DEL_INFORME = 50_000

#: De donde saca la sesion la escritura en segundo plano. Es una variable del
#: modulo para que las pruebas la apunten a su base en memoria: la sesion de la
#: peticion (`get_db`) ya esta cerrada cuando corre la tarea.
fabrica_de_sesiones = SessionLocal

HITOS = (
    "feed_pedido",
    "feed_respuesta",
    "urls_firmadas",
    "primer_fotograma",
    "primera_reproduccion",
)


class DemasiadosLotes(AppError):
    status_code = status.HTTP_429_TOO_MANY_REQUESTS
    code = "telemetry_rate_limited"
    message = "Demasiados envíos de medición."


class CuerpoDemasiadoGrande(AppError):
    status_code = 413  # numero y no constante: su nombre cambio entre versiones de Starlette
    code = "telemetry_too_large"
    message = "El lote de medición es demasiado grande."


def vaciar() -> None:
    """Solo para las pruebas: que una no herede el ritmo de la anterior."""
    por_ip.vaciar()
    sin_ip.vaciar()


async def _leer_cuerpo(peticion: Request) -> bytes:
    """El cuerpo, sin pasar nunca de `CUERPO_MAXIMO_BYTES` en memoria.

    No basta con mirar `Content-Length`: se puede omitir o mentir. Se mira para
    cortar pronto y ademas se cuenta lo que llega de verdad.
    """
    declarado = peticion.headers.get("content-length")
    if declarado and declarado.isdigit() and int(declarado) > CUERPO_MAXIMO_BYTES:
        raise CuerpoDemasiadoGrande()
    partes: list[bytes] = []
    total = 0
    async for trozo in peticion.stream():
        total += len(trozo)
        if total > CUERPO_MAXIMO_BYTES:
            raise CuerpoDemasiadoGrande()
        partes.append(trozo)
    return b"".join(partes)


def filas_del_lote(lote: LoteDeMedicion) -> list[MetricaDeVideo]:
    """Un lote → una fila por hito y una por tramo."""
    comun = {
        "sesion": lote.sesion,
        "plataforma": lote.contexto.plataforma,
        "version_app": lote.contexto.version_app,
        "build": lote.contexto.build,
        "modelo": lote.contexto.modelo,
        "sistema": lote.contexto.sistema,
        "red": lote.contexto.red,
    }
    filas = [
        MetricaDeVideo(**comun, tramo=nombre, ms=valor)
        for nombre in HITOS
        if (valor := getattr(lote.hitos, nombre)) is not None
    ]
    filas.extend(
        MetricaDeVideo(
            **comun,
            tramo=t.tipo,
            ms=t.hasta_reproducir_ms,
            fotograma_ms=t.hasta_fotograma_ms,
            esperas=t.esperas,
            espera_ms=t.espera_ms,
            formato=t.formato,
            almacen=t.almacen,
            bytes=t.bytes,
            error=t.error,
        )
        for t in lote.tramos
    )
    return filas


async def _guardar(lote: LoteDeMedicion) -> None:
    """Escribe el lote. Corre DESPUES de responder; si falla, se registra y ya.

    Sin la migracion 0115 aplicada falla con «no existe la tabla»: es el
    comportamiento esperado de desplegar la API antes que la migracion, y no
    afecta a nadie, porque el telefono ya tiene su 202.
    """
    try:
        async with fabrica_de_sesiones() as db:
            db.add_all(filas_del_lote(lote))
            await db.commit()
    except Exception as error:  # noqa: BLE001 - medicion: nunca debe propagar
        logger.warning("[telemetria] no se pudo guardar un lote: %s", type(error).__name__)


@router.post("/video", status_code=status.HTTP_202_ACCEPTED, response_model=Recepcion)
async def recibir_lote(peticion: Request, tareas: BackgroundTasks) -> Recepcion:
    ip = _ip_del_cliente(
        peticion.headers.get("x-forwarded-for"),
        getattr(peticion.client, "host", None),
    )
    if ip:
        if not por_ip.permitido(ip):
            raise DemasiadosLotes()
    elif not sin_ip.permitido("*"):
        raise DemasiadosLotes()

    cuerpo = await _leer_cuerpo(peticion)
    try:
        lote = LoteDeMedicion.model_validate_json(cuerpo)
    except ValidationError as error:
        # Se devuelven solo las rutas de los campos, no los valores recibidos:
        # no hay por que reflejar al cliente lo que mando.
        campos = sorted({".".join(str(p) for p in e["loc"]) for e in error.errors()})[:10]
        raise ValidationAppError("Lote de medición inválido.", details=campos) from None

    filas = len(lote.tramos) + sum(
        1 for nombre in HITOS if getattr(lote.hitos, nombre) is not None
    )
    if filas == 0:
        return Recepcion(aceptado=False, filas=0)
    tareas.add_task(_guardar, lote)
    return Recepcion(aceptado=True, filas=filas)


def _percentil(ordenados: list[int], p: float) -> int | None:
    """Percentil con interpolacion lineal (igual que `percentile_cont`)."""
    if not ordenados:
        return None
    if len(ordenados) == 1:
        return ordenados[0]
    posicion = (len(ordenados) - 1) * p
    abajo = int(posicion)
    arriba = min(abajo + 1, len(ordenados) - 1)
    return round(ordenados[abajo] + (ordenados[arriba] - ordenados[abajo]) * (posicion - abajo))


def resumir(filas: list[MetricaDeVideo]) -> list[Resumen]:
    # Los tramos de video se separan tambien por almacen (Supabase o S3) para
    # poder comparar los dos mientras conviven; los hitos de carga no lo tienen.
    grupos: dict[tuple[str, str, str], list[MetricaDeVideo]] = defaultdict(list)
    for fila in filas:
        grupos[(fila.plataforma, fila.tramo, fila.almacen or "")].append(fila)
    salida: list[Resumen] = []
    for (plataforma, tramo, almacen), grupo in sorted(grupos.items()):
        valores = sorted(f.ms for f in grupo if f.ms is not None)
        es_tramo = tramo not in HITOS
        resumen = Resumen(
            plataforma=plataforma,
            tramo=tramo,
            almacen=almacen or None,
            n=len(grupo),
            sin_reproducir=sum(1 for f in grupo if f.ms is None) if es_tramo else 0,
            mediana_ms=_percentil(valores, 0.5),
            p75_ms=_percentil(valores, 0.75),
            p90_ms=_percentil(valores, 0.9),
        )
        if es_tramo:
            resumen.con_esperas = round(sum(1 for f in grupo if (f.esperas or 0) > 0) / len(grupo), 3)
            esperas = sorted(f.espera_ms for f in grupo if (f.esperas or 0) > 0 and f.espera_ms is not None)
            resumen.mediana_espera_ms = _percentil(esperas, 0.5)
        salida.append(resumen)
    return salida


@admin_router.get("/video", response_model=InformeDeVideo)
async def informe_de_video(
    dias: int = Query(default=7, ge=1, le=90),
    _: AuthUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> InformeDeVideo:
    desde = datetime.now(timezone.utc) - timedelta(days=dias)
    filas = list(
        (
            await db.scalars(
                select(MetricaDeVideo)
                .where(MetricaDeVideo.creado_en >= desde)
                .order_by(MetricaDeVideo.creado_en.desc())
                .limit(FILAS_MAXIMAS_DEL_INFORME + 1)
            )
        ).all()
    )
    recortado = len(filas) > FILAS_MAXIMAS_DEL_INFORME
    filas = filas[:FILAS_MAXIMAS_DEL_INFORME]
    return InformeDeVideo(
        dias=dias,
        desde=desde.isoformat(),
        filas_leidas=len(filas),
        recortado=recortado,
        resumen=resumir(filas),
    )

