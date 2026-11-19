"""Endpoints de los medios en S3: subidas, limpieza diaria y salud (spec §5, §9).

SUBIDA (con sesión, y solo si `medios_s3_subida` abre para esta cuenta):

- `POST /medios/subidas`: hasta 50 MB, un PUT prefirmado de 15 min con
  `Content-Type` y `Content-Length` exactos DENTRO de la firma (S3 rechaza otro
  tamaño o tipo); por encima, una subida por partes de 10 MiB.
- `POST /medios/subidas/{id}/partes`: URLs de partes por tandas (15 min cada
  una, con el tamaño exacto de esa parte), para que ninguna caduque en una
  subida larga por 4G.
- `GET /medios/subidas/{id}`: las partes ya subidas (`ListParts`), para
  reanudar incluso tras cerrar la app.
- `POST /medios/subidas/{id}/completar` y `DELETE /medios/subidas/{id}`.

La clave la fija la API: `pendientes/<uid de la sesión>/<id>.<ext>`. Nadie
puede subir a la carpeta de otra persona ni elegir el nombre.

LÍMITE: 20 publicaciones con video por cuenta y por hora, contadas por
`grupo` (el UUID que la app genera por publicación). Video y póster del mismo
grupo cuentan una vez, y los reintentos de una subida no cuentan.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import math
from datetime import datetime, timedelta, timezone
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, Header, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.exceptions import AppError, ServiceUnavailableError, ValidationAppError
from app.core.security import AuthUser, get_current_user
from app.modules.medios import almacen, banderas, esquema, firma, limpieza, publicacion
from app.modules.medios.models import MedioSubida
from app.shared.cliente_http import cliente_http
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.permissions import require_admin

logger = logging.getLogger("renaser.medios")

router = APIRouter(tags=["medios"])

#: Hasta aquí, un solo PUT; por encima, por partes.
LIMITE_SIMPLE = 50 * 1024 * 1024
#: Tamaño de cada parte. S3 exige al menos 5 MiB salvo en la última.
TAMANO_PARTE = 10 * 1024 * 1024
#: Vida de cada URL de subida.
VIDA_URL_S = 15 * 60
#: Vida del registro de una subida: un poco menos que el ciclo de vida de
#: `pendientes/` (1 día), para no publicar algo que S3 está por borrar.
VIDA_SUBIDA = timedelta(hours=23)
#: El póster es un JPEG pequeño; nada justifica más.
MAX_POSTER_BYTES = 10 * 1024 * 1024
#: URLs de partes por llamada.
MAX_PARTES_POR_TANDA = 100

TIPOS = {"video": {"video/mp4", "video/quicktime"}, "poster": {"image/jpeg"}}

CABECERA_TAREAS = "X-Medios-Tareas-Token"
LARGO_MINIMO_DEL_SECRETO = 32


class DemasiadasSubidas(AppError):
    status_code = 429
    code = "demasiadas_subidas"
    message = "Llegaste al límite de publicaciones con video por hora. Prueba más tarde."


class SubidaCreate(BaseModel):
    tipo: Literal["video", "poster"]
    content_type: str = Field(max_length=60)
    bytes: int = Field(gt=0)
    grupo: str = Field(min_length=36, max_length=36)


class SubidaCreada(BaseModel):
    id_de_subida: str
    clave_pendiente: str
    modo: Literal["simple", "partes"]
    url: str | None = None
    #: Cabeceras que el PUT simple tiene que mandar TAL CUAL (van firmadas).
    cabeceras: dict[str, str] = Field(default_factory=dict)
    upload_id: str | None = None
    partes_totales: int | None = None
    tamano_parte: int | None = None
    expira: datetime


class PedidoDePartes(BaseModel):
    numeros: list[int] = Field(min_length=1, max_length=MAX_PARTES_POR_TANDA)


class UrlDeParte(BaseModel):
    numero: int
    url: str
    bytes: int


class PartesFirmadas(BaseModel):
    partes: list[UrlDeParte]
    expira: datetime


class ParteHecha(BaseModel):
    numero: int
    etag: str
    bytes: int


class EstadoDeSubida(BaseModel):
    id_de_subida: str
    estado: str
    modo: Literal["simple", "partes"]
    partes_totales: int | None = None
    tamano_parte: int | None = None
    partes_hechas: list[ParteHecha] = Field(default_factory=list)
    expira: datetime


class ParteACerrar(BaseModel):
    numero: int = Field(ge=1, le=10000)
    etag: str = Field(min_length=1, max_length=200)


class Completar(BaseModel):
    #: Vacía en una subida simple: S3 no avisa cuando termina un PUT, y la app
    #: llama igual a `completar` para dejar constancia (ver abajo).
    partes: list[ParteACerrar] = Field(default_factory=list, max_length=10000)


class SubidaCompletada(BaseModel):
    id_de_subida: str
    estado: str


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


def _con_zona(fecha: datetime) -> datetime:
    return fecha if fecha.tzinfo else fecha.replace(tzinfo=timezone.utc)


def _bytes_de_parte(subida: MedioSubida, numero: int) -> int:
    total = int(subida.bytes_declarados)
    inicio = (numero - 1) * TAMANO_PARTE
    return max(0, min(TAMANO_PARTE, total - inicio))


async def _exigir_viva(subida: MedioSubida, *estados: str) -> None:
    if subida.estado not in estados or _con_zona(subida.expira) <= _ahora():
        raise publicacion.SubidaNoDisponible()


async def _limite_por_hora(db: AsyncSession, uid: str, grupo: str) -> None:
    ya_contado = await db.scalar(
        select(MedioSubida.id)
        .where(MedioSubida.uid == uid, MedioSubida.grupo == grupo)
        .limit(1)
    )
    if ya_contado is not None:
        return
    desde = _ahora() - timedelta(hours=1)
    grupos = await db.scalar(
        select(func.count(func.distinct(MedioSubida.grupo))).where(
            MedioSubida.uid == uid, MedioSubida.creada >= desde
        )
    )
    if (grupos or 0) >= get_settings().medios_publicaciones_con_video_por_hora:
        raise DemasiadasSubidas()


@router.post("/medios/subidas", response_model=SubidaCreada, status_code=status.HTTP_201_CREATED)
async def crear_subida(
    payload: SubidaCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SubidaCreada:
    uid = current_user.id
    await publicacion.exigir_habilitado(db, uid)
    ensure_uuid(payload.grupo, "Grupo no valido.")
    tipo_contenido = payload.content_type.split(";")[0].strip().lower()
    if tipo_contenido not in TIPOS[payload.tipo]:
        raise ValidationAppError("Ese tipo de archivo no se puede subir aquí.")
    tope = (
        get_settings().medios_max_video_mb * 1024 * 1024
        if payload.tipo == "video"
        else MAX_POSTER_BYTES
    )
    if payload.bytes > tope:
        raise ValidationAppError(
            f"El archivo pasa del máximo permitido ({tope // (1024 * 1024)} MB)."
        )
    await _limite_por_hora(db, uid, payload.grupo)

    id_de_subida = str(uuid4())
    clave = (
        f"{almacen.PREFIJO_PENDIENTES}/{uid}/{id_de_subida}."
        f"{publicacion.EXTENSIONES[tipo_contenido]}"
    )
    s3 = almacen.cliente_s3()
    expira_url = _ahora() + timedelta(seconds=VIDA_URL_S)
    subida = MedioSubida(
        id=id_de_subida,
        uid=uid,
        grupo=payload.grupo,
        tipo=payload.tipo,
        clave_pendiente=clave,
        content_type=tipo_contenido,
        bytes_declarados=payload.bytes,
        expira=_ahora() + VIDA_SUBIDA,
    )
    if payload.bytes <= LIMITE_SIMPLE:
        url = s3.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": almacen.bucket(),
                "Key": clave,
                "ContentType": tipo_contenido,
                "ContentLength": payload.bytes,
            },
            ExpiresIn=VIDA_URL_S,
        )
        respuesta = SubidaCreada(
            id_de_subida=id_de_subida,
            clave_pendiente=clave,
            modo="simple",
            url=url,
            cabeceras={"Content-Type": tipo_contenido},
            expira=expira_url,
        )
    else:
        creada = await asyncio.to_thread(
            s3.create_multipart_upload,
            Bucket=almacen.bucket(),
            Key=clave,
            ContentType=tipo_contenido,
        )
        subida.upload_id = creada["UploadId"]
        subida.partes_totales = math.ceil(payload.bytes / TAMANO_PARTE)
        respuesta = SubidaCreada(
            id_de_subida=id_de_subida,
            clave_pendiente=clave,
            modo="partes",
            upload_id=subida.upload_id,
            partes_totales=subida.partes_totales,
            tamano_parte=TAMANO_PARTE,
            expira=expira_url,
        )
    db.add(subida)
    await db.commit()
    return respuesta


@router.post("/medios/subidas/{id_de_subida}/partes", response_model=PartesFirmadas)
async def firmar_partes(
    id_de_subida: str,
    payload: PedidoDePartes,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PartesFirmadas:
    await publicacion.exigir_habilitado(db, current_user.id)
    subida = await publicacion.subida_propia(db, current_user.id, id_de_subida)
    await _exigir_viva(subida, "abierta")
    if not subida.upload_id or not subida.partes_totales:
        raise ValidationAppError("Esta subida no es por partes.")
    numeros = sorted(set(payload.numeros))
    if numeros[0] < 1 or numeros[-1] > subida.partes_totales:
        raise ValidationAppError("Número de parte fuera de rango.")
    s3 = almacen.cliente_s3()
    partes = []
    for numero in numeros:
        tamano = _bytes_de_parte(subida, numero)
        url = s3.generate_presigned_url(
            "upload_part",
            Params={
                "Bucket": almacen.bucket(),
                "Key": subida.clave_pendiente,
                "UploadId": subida.upload_id,
                "PartNumber": numero,
                "ContentLength": tamano,
            },
            ExpiresIn=VIDA_URL_S,
        )
        partes.append(UrlDeParte(numero=numero, url=url, bytes=tamano))
    return PartesFirmadas(partes=partes, expira=_ahora() + timedelta(seconds=VIDA_URL_S))


def _partes_hechas(subida: MedioSubida) -> list[ParteHecha]:
    s3 = almacen.cliente_s3()
    hechas: list[ParteHecha] = []
    marcador = 0
    while True:
        respuesta = s3.list_parts(
            Bucket=almacen.bucket(),
            Key=subida.clave_pendiente,
            UploadId=subida.upload_id,
            PartNumberMarker=marcador,
        )
        for parte in respuesta.get("Parts") or []:
            hechas.append(
                ParteHecha(
                    numero=parte["PartNumber"], etag=parte["ETag"], bytes=parte.get("Size", 0)
                )
            )
        if not respuesta.get("IsTruncated"):
            return hechas
        marcador = respuesta.get("NextPartNumberMarker") or 0


@router.get("/medios/subidas/{id_de_subida}", response_model=EstadoDeSubida)
async def estado_de_subida(
    id_de_subida: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EstadoDeSubida:
    await publicacion.exigir_habilitado(db, current_user.id)
    subida = await publicacion.subida_propia(db, current_user.id, id_de_subida)
    hechas: list[ParteHecha] = []
    if subida.upload_id and subida.estado == "abierta" and _con_zona(subida.expira) > _ahora():
        try:
            hechas = await asyncio.to_thread(_partes_hechas, subida)
        except Exception as error:  # noqa: BLE001
            if not almacen.es_no_existe(error):
                raise
            # El multipart ya no existe (abortado o vencido): no hay qué reanudar.
            raise publicacion.SubidaNoDisponible() from None
    return EstadoDeSubida(
        id_de_subida=subida.id,
        estado=subida.estado,
        modo="partes" if subida.upload_id else "simple",
        partes_totales=subida.partes_totales,
        tamano_parte=TAMANO_PARTE if subida.upload_id else None,
        partes_hechas=hechas,
        expira=_con_zona(subida.expira),
    )


def _completar_sync(subida: MedioSubida, partes: list[ParteACerrar]) -> int:
    s3 = almacen.cliente_s3()
    s3.complete_multipart_upload(
        Bucket=almacen.bucket(),
        Key=subida.clave_pendiente,
        UploadId=subida.upload_id,
        MultipartUpload={
            "Parts": [{"PartNumber": p.numero, "ETag": p.etag} for p in partes]
        },
    )
    cabeza = s3.head_object(Bucket=almacen.bucket(), Key=subida.clave_pendiente)
    return int(cabeza.get("ContentLength") or 0)


@router.post("/medios/subidas/{id_de_subida}/completar", response_model=SubidaCompletada)
async def completar_subida(
    id_de_subida: str,
    payload: Completar,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SubidaCompletada:
    await publicacion.exigir_habilitado(db, current_user.id)
    subida = await publicacion.subida_propia(db, current_user.id, id_de_subida)
    if subida.estado == "subida":
        # Reintento de un `completar` que ya se hizo: misma respuesta.
        return SubidaCompletada(id_de_subida=subida.id, estado=subida.estado)
    await _exigir_viva(subida, "abierta")
    if not subida.upload_id:
        # SUBIDA SIMPLE: solo se comprueba que el archivo llegó con el tamaño
        # y el tipo firmados. Publicar lo vuelve a comprobar igual.
        try:
            cabeza = await asyncio.to_thread(
                almacen.cliente_s3().head_object,
                Bucket=almacen.bucket(),
                Key=subida.clave_pendiente,
            )
        except Exception as error:  # noqa: BLE001
            if almacen.es_no_existe(error):
                raise publicacion.SubidaNoDisponible("El archivo no llegó a subirse.") from None
            raise
        if int(cabeza.get("ContentLength") or 0) != int(subida.bytes_declarados):
            raise ValidationAppError("El archivo subido no tiene el tamaño anunciado.")
        subida.estado = "subida"
        await db.commit()
        return SubidaCompletada(id_de_subida=subida.id, estado=subida.estado)
    if not subida.partes_totales:
        raise ValidationAppError("Esta subida no es por partes.")
    partes = sorted(payload.partes, key=lambda p: p.numero)
    if [p.numero for p in partes] != list(range(1, subida.partes_totales + 1)):
        raise ValidationAppError("Faltan partes o sobran.")
    tamano = await asyncio.to_thread(_completar_sync, subida, partes)
    if tamano != int(subida.bytes_declarados):
        # Lo que llegó no es lo que se anunció: se descarta.
        await asyncio.to_thread(
            almacen.cliente_s3().delete_object, Bucket=almacen.bucket(), Key=subida.clave_pendiente
        )
        subida.estado = "cancelada"
        await db.commit()
        raise ValidationAppError("El archivo subido no tiene el tamaño anunciado.")
    subida.estado = "subida"
    await db.commit()
    return SubidaCompletada(id_de_subida=subida.id, estado=subida.estado)


@router.delete("/medios/subidas/{id_de_subida}", status_code=status.HTTP_204_NO_CONTENT)
async def cancelar_subida(
    id_de_subida: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    # Cancelar se permite aunque la bandera se haya apagado: es limpiar lo
    # propio. Sin bucket o sin la 0116 no hay nada que cancelar.
    if not banderas.s3_configurado() or not await esquema.hay_almacen(db):
        raise publicacion.MediosS3NoHabilitado()
    subida = await publicacion.subida_propia(db, current_user.id, id_de_subida)
    if subida.estado in ("abierta", "subida"):
        s3 = almacen.cliente_s3()
        try:
            if subida.upload_id and subida.estado == "abierta":
                await asyncio.to_thread(
                    s3.abort_multipart_upload,
                    Bucket=almacen.bucket(),
                    Key=subida.clave_pendiente,
                    UploadId=subida.upload_id,
                )
            await asyncio.to_thread(
                s3.delete_object, Bucket=almacen.bucket(), Key=subida.clave_pendiente
            )
        except Exception:  # noqa: BLE001 — el ciclo de vida lo borra igual a 1 día
            logger.info("No se pudo limpiar en S3 la subida cancelada %s", subida.id)
        subida.estado = "cancelada"
        await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------------- #
# Limpieza diaria (EventBridge)
# --------------------------------------------------------------------------- #
def exigir_tareas(recibido: str | None = Header(default=None, alias=CABECERA_TAREAS)) -> None:
    """Secreto compartido, comparado en tiempo constante y EN BYTES (igual que
    `services/procesos_router.py`). Falla cerrada: sin secreto, o con uno
    corto, no acepta nada. A quien no reconoce le contesta lo mismo que si
    no estuviera configurado."""
    esperado = (get_settings().medios_tareas_token or "").strip()
    configurado = len(esperado) >= LARGO_MINIMO_DEL_SECRETO
    candidato = (recibido or "").strip().encode("utf-8")
    coincide = hmac.compare_digest(candidato, esperado.encode("utf-8"))
    if not (configurado and coincide):
        logger.warning(
            "medios.tareas: llamada rechazada (%s)",
            "sin secreto configurado" if not configurado else "secreto que no coincide",
        )
        raise ServiceUnavailableError("Tareas de medios no disponibles.", code="medios_tareas_no_disponibles")


async def _limpieza_en_segundo_plano() -> None:
    """Con su propia sesion: la de la peticion ya se cerro al contestar."""
    from app.shared.database import SessionLocal

    try:
        async with SessionLocal() as db:
            resultado = await limpieza.ejecutar(db)
        # «medios.limpieza» es lo que cita la alarma de la pila 02.
        nivel = logging.WARNING if resultado.get("errores") else logging.INFO
        logger.log(nivel, "medios.limpieza: %s", resultado)
    except Exception:  # noqa: BLE001
        logger.exception("medios.limpieza: fallo")


@router.post(
    "/tareas/medios/limpieza",
    dependencies=[Depends(exigir_tareas)],
    status_code=status.HTTP_202_ACCEPTED,
)
async def limpieza_diaria(background: BackgroundTasks) -> dict[str, object]:
    """Contesta AL MOMENTO y trabaja despues: EventBridge corta la llamada a
    los 5 s, y listar y mover en S3 puede tardar mas. Idempotente: si
    EventBridge reintenta, la segunda pasada no encuentra nada que hacer."""
    background.add_task(_limpieza_en_segundo_plano)
    return {"aceptada": True}


# --------------------------------------------------------------------------- #
# Salud (prueba de humo de la fase 1, corrección N6)
# --------------------------------------------------------------------------- #
CARPETA_DE_SALUD = f"{almacen.PREFIJO_VIDEOS}/_salud/prueba"


def _escribir_prueba() -> None:
    s3 = almacen.cliente_s3()
    # NO `HeadBucket`: el rol tiene `s3:ListBucket` acotado por prefijo
    # (`videos/`, `borrados/`, `pendientes/`) y HeadBucket no lleva prefijo, asi
    # que contestaria 403 aunque todo estuviera bien. Un listado acotado
    # prueba lo mismo (bucket, rol y credenciales) por el camino real.
    s3.list_objects_v2(Bucket=almacen.bucket(), Prefix=f"{CARPETA_DE_SALUD}/", MaxKeys=1)
    s3.put_object(
        Bucket=almacen.bucket(),
        Key=f"{CARPETA_DE_SALUD}/ping.txt",
        Body=b"ok",
        ContentType="text/plain",
        CacheControl="no-store",
    )


@router.get("/admin/medios/salud")
async def salud_de_medios(
    _: AuthUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict[str, object]:
    """Listado del bucket + firma de prueba + pedirla a CloudFront (200).

    Valida el camino real —rol de la instancia (hop limit), clave en base64
    del secreto y grupo de claves— antes de abrir ninguna bandera. No devuelve
    nada secreto: solo qué paso falló.
    """
    salida: dict[str, object] = {
        "migracion_0116": await esquema.hay_almacen(db),
        "bucket": None,
        "firma": firma.firma_configurada(),
        "cloudfront": None,
        "banderas": {
            "subida": get_settings().medios_s3_subida,
            "lectura": banderas.lectura_activa(),
            "visibilidad": get_settings().publicaciones_visibilidad,
        },
    }
    if not banderas.s3_configurado():
        salida["bucket"] = "sin_configurar"
        return salida
    try:
        await asyncio.to_thread(_escribir_prueba)
        salida["bucket"] = "ok"
    except Exception as error:  # noqa: BLE001
        salida["bucket"] = f"fallo:{type(error).__name__}"
        return salida
    query = firma.query_de_carpeta(CARPETA_DE_SALUD)
    if query is None:
        salida["cloudfront"] = "sin_firma"
        return salida
    try:
        async with cliente_http(10.0) as client:
            respuesta = await client.get(firma.url_firmada(f"{CARPETA_DE_SALUD}/ping.txt", query))
        salida["cloudfront"] = respuesta.status_code
    except Exception as error:  # noqa: BLE001
        salida["cloudfront"] = f"fallo:{type(error).__name__}"
    return salida
