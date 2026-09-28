"""Las rutas de la admisión de Servicios (Bloque 1A).

SOLO SE REGISTRAN LAS QUE RESPONDEN DE VERDAD. Las operaciones del Bloque 1B
—enviar, reenviar, retirarse, registrar documentos y credenciales, y las
decisiones de Z— tienen su contrato fijado en `CONTRATOS_DEL_BLOQUE_1B` y NINGUNA RUTA: un
endpoint que respondiera «éxito» sin hacer nada, o siempre 500, sería peor que
no tenerlo. Una prueba comprueba que no existen hasta que se implementen.

EL ORDEN DE LAS PUERTAS, en cada ruta, y por qué:

    prestador        sesión (401)  ->  bandera y esquema (503)  ->  cuerpo (422)
    administración   sesión (401)  ->  rol (403)  ->  bandera y esquema (503)

Las puertas son dependencias y no líneas del cuerpo de la función: FastAPI las
resuelve ANTES de validar el cuerpo, así que con la bandera apagada ninguna
petición llega a contar nada de su forma. Y en administración el rol va antes
que la bandera: una cuenta sin permisos no averigua cómo está configurado el
servidor.

LO AJENO NO EXISTE: las rutas del prestador no reciben ningún identificador,
siempre hablan de la postulación de quien pregunta.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import APIRouter, Depends, Query, Response, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import AuthUser, get_current_user
from app.modules.services import esquema, permissions, service, states
from app.modules.services.schemas import (
    BorradorActualizar,
    CorreccionesSolicitar,
    CredencialPrivadaRead,
    CredencialRegistrar,
    DocumentoPrivadoRead,
    DocumentoRegistrar,
    EventoAdminRead,
    EventoVisibleRead,
    PaginaDeSolicitudes,
    PrestadorSuspender,
    RevisionIniciar,
    SolicitudAdminRead,
    SolicitudAprobar,
    SolicitudEnviar,
    SolicitudIniciar,
    SolicitudPrivadaRead,
    SolicitudRechazar,
    SolicitudResumenRead,
    SolicitudRetirar,
)
from app.shared.database import get_db

router = APIRouter(prefix="/services", tags=["services"])
admin_router = APIRouter(prefix="/admin/services", tags=["services-admin"])


# --------------------------------------------------------------------------- #
# Puertas
# --------------------------------------------------------------------------- #
async def servicios_disponibles(db: AsyncSession = Depends(get_db)) -> None:
    """Bandera encendida y 0086 aplicada, o 503 con su código."""
    await esquema.exigir_servicios(db)


async def funcion_de_revision(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> str:
    """Curaduría o administración, o 403. Devuelve con qué función actúa."""
    return await permissions.exigir_revisor(db, current_user.id)


async def _privada(db: AsyncSession, expediente: service.Expediente) -> SolicitudPrivadaRead:
    return SolicitudPrivadaRead.desde(
        solicitud=expediente.solicitud,
        prestador=expediente.prestador,
        documentos=expediente.documentos,
        credenciales=expediente.credenciales,
        faltan=(
            await service.faltantes_de(db, expediente)
            if states.es_editable(expediente.solicitud.status)
            else []
        ),
    )


# --------------------------------------------------------------------------- #
# Prestador: SU postulación
# --------------------------------------------------------------------------- #
@router.post(
    "/provider/application",
    response_model=SolicitudPrivadaRead,
    status_code=status.HTTP_201_CREATED,
)
async def iniciar_postulacion(
    cuerpo: SolicitudIniciar,
    response: Response,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> SolicitudPrivadaRead:
    """Empieza la postulación o devuelve la viva. 201 si nace, 200 si ya estaba."""
    expediente, nueva = await service.iniciar(
        db,
        usuario_id=current_user.id,
        tipo=cuerpo.provider_type,
        nombre=cuerpo.display_name,
    )
    await db.commit()
    if not nueva:
        response.status_code = status.HTTP_200_OK
    return await _privada(db, expediente)


@router.get("/provider/application", response_model=SolicitudPrivadaRead)
async def mi_postulacion(
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> SolicitudPrivadaRead:
    """La postulación viva, o la última rechazada con su motivo. 404 si no hay."""
    return await _privada(db, await service.la_mia(db, current_user.id))


@router.patch("/provider/application", response_model=SolicitudPrivadaRead)
async def actualizar_mi_borrador(
    cuerpo: BorradorActualizar,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> SolicitudPrivadaRead:
    """Cambia datos del borrador. NUNCA el estado: el cuerpo no admite `status`."""
    expediente = await service.actualizar_borrador(
        db, usuario_id=current_user.id, cambios=cuerpo.cambios()
    )
    await db.commit()
    return await _privada(db, expediente)


@router.get("/provider/application/history", response_model=list[EventoVisibleRead])
async def historial_de_mi_postulacion(
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> list[EventoVisibleRead]:
    """Lo que pasó con SU postulación. Sin nombres de Z ni notas internas."""
    expediente = await service.la_mia(db, current_user.id)
    return [
        EventoVisibleRead.desde(e)
        for e in await service.historial(db, expediente.solicitud.id)
    ]


# --------------------------------------------------------------------------- #
# Administración: solo lectura en este bloque
# --------------------------------------------------------------------------- #
@admin_router.get("/applications", response_model=PaginaDeSolicitudes)
async def bandeja_de_postulaciones(
    estado: str | None = Query(default=None, alias="status"),
    tipo: str | None = Query(default=None, alias="provider_type"),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=service.LIMITE_MAXIMO),
    _funcion: str = Depends(funcion_de_revision),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> PaginaDeSolicitudes:
    """Por defecto, lo que espera a Z: enviadas, en revisión y reenviadas.

    `status` filtra por UNO de los ocho estados; `provider_type` por persona o
    empresa. Un valor que no existe es un 422, no una lista vacía que haga
    creer que no hay nada.
    """
    if estado is not None and not states.es_estado(estado):
        raise states.EstadoDesconocido(
            "Ese estado no existe.", details={"status": estado}
        )
    if tipo is not None and tipo not in ("individual", "company"):
        raise states.EstadoDesconocido(
            "Ese tipo de prestador no existe.",
            code="service_provider_type_unknown",
            details={"provider_type": tipo},
        )
    filas, siguiente = await service.bandeja(
        db,
        estados=(estado,) if estado else states.PENDIENTES_DE_Z,
        tipo=tipo,
        cursor=cursor,
        limite=limit,
    )
    return PaginaDeSolicitudes(
        items=[SolicitudResumenRead.desde(s, p) for s, p in filas],
        next_cursor=siguiente,
    )


@admin_router.get("/applications/{application_id}", response_model=SolicitudAdminRead)
async def detalle_de_postulacion(
    application_id: str,
    _funcion: str = Depends(funcion_de_revision),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> SolicitudAdminRead:
    expediente = await service.expediente_de(db, await service.por_id(db, application_id))
    return SolicitudAdminRead.desde(
        solicitud=expediente.solicitud,
        prestador=expediente.prestador,
        documentos=expediente.documentos,
        credenciales=expediente.credenciales,
    )


@admin_router.get(
    "/applications/{application_id}/history", response_model=list[EventoAdminRead]
)
async def historial_completo(
    application_id: str,
    _funcion: str = Depends(funcion_de_revision),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> list[EventoAdminRead]:
    solicitud = await service.por_id(db, application_id)
    return [EventoAdminRead.desde(e) for e in await service.historial(db, solicitud.id)]


# --------------------------------------------------------------------------- #
# Contratos del Bloque 1B: fijados, SIN RUTA todavía
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Contrato:
    metodo: str
    ruta: str
    entrada: type[BaseModel] | None
    salida: type[BaseModel] | None
    #: Los pasos de `states.TRANSICIONES` que ejecuta la acción. Vacío = no
    #: cambia el estado.
    saltos: tuple[tuple[str, str], ...]
    idempotente_por: str
    para_que: str


_P = "/services/provider/application"
_A = "/admin/services/applications/{application_id}"

#: Lo que el Bloque 1B implementará, con su forma ya decidida. NO SE REGISTRA.
#: Entre todos cubren TODOS los saltos del mapa; una prueba lo comprueba.
CONTRATOS_DEL_BLOQUE_1B: tuple[Contrato, ...] = (
    Contrato(
        "POST", f"{_P}/documents", DocumentoRegistrar, DocumentoPrivadoRead, (),
        "storage_path única", "Registrar los metadatos de un documento ya subido.",
    ),
    Contrato(
        "POST", f"{_P}/credentials", CredencialRegistrar, CredencialPrivadaRead, (),
        "cabecera Idempotency-Key", "Declarar una credencial profesional.",
    ),
    Contrato(
        "POST", f"{_P}/submit", SolicitudEnviar, SolicitudPrivadaRead,
        ((states.BORRADOR, states.ENVIADA),),
        "estado: enviar lo ya enviado devuelve lo mismo", "Enviar la postulación.",
    ),
    Contrato(
        "POST", f"{_P}/resubmit", SolicitudEnviar, SolicitudPrivadaRead,
        ((states.CORRECCIONES_PEDIDAS, states.REENVIADA),),
        "estado", "Reenviar tras corregir.",
    ),
    Contrato(
        "POST", f"{_P}/withdraw", SolicitudRetirar, SolicitudPrivadaRead,
        tuple((desde, states.RETIRADA) for desde in sorted(states.RETIRABLES)),
        "estado: retirar lo ya retirado devuelve lo mismo, sin otro evento; "
        "y cabecera Idempotency-Key",
        "Retirar la postulación propia. Solo el prestador; registra auditoría.",
    ),
    Contrato(
        "POST", f"{_A}/start-review", RevisionIniciar, SolicitudAdminRead,
        (
            (states.ENVIADA, states.EN_REVISION),
            (states.REENVIADA, states.EN_REVISION),
            (states.SUSPENDIDA, states.EN_REVISION),
        ),
        "cabecera Idempotency-Key", "Tomar una postulación enviada, reenviada o suspendida.",
    ),
    Contrato(
        "POST", f"{_A}/request-changes", CorreccionesSolicitar, SolicitudAdminRead,
        ((states.EN_REVISION, states.CORRECCIONES_PEDIDAS),),
        "cabecera Idempotency-Key", "Devolverla con lo que hay que corregir.",
    ),
    Contrato(
        "POST", f"{_A}/approve", SolicitudAprobar, SolicitudAdminRead,
        ((states.EN_REVISION, states.APROBADA),),
        "cabecera Idempotency-Key", "Aprobar. Solo administración.",
    ),
    Contrato(
        "POST", f"{_A}/reject", SolicitudRechazar, SolicitudAdminRead,
        ((states.EN_REVISION, states.RECHAZADA),),
        "cabecera Idempotency-Key", "Rechazar con motivo. Solo administración.",
    ),
    Contrato(
        "POST", f"{_A}/suspend", PrestadorSuspender, SolicitudAdminRead,
        ((states.APROBADA, states.SUSPENDIDA),),
        "cabecera Idempotency-Key", "Suspender con motivo. Solo administración.",
    ),
)


__all__ = ["CONTRATOS_DEL_BLOQUE_1B", "Contrato", "admin_router", "router"]
