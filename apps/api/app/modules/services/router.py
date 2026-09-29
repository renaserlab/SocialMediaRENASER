"""Las rutas de la admisión de Servicios (Incremento 1 completo).

EL ORDEN DE LAS PUERTAS, en cada ruta, y por qué:

    prestador        sesión (401)  ->  bandera y esquema (503)  ->  cuerpo (422)
    administración   sesión (401)  ->  rol (403)  ->  bandera y esquema (503)

Las puertas son dependencias y no líneas del cuerpo de la función: FastAPI las
resuelve ANTES de validar el cuerpo, así que con la bandera apagada ninguna
petición llega a contar nada de su forma. Y en administración el rol va antes
que la bandera: una cuenta sin permisos no averigua cómo está configurado el
servidor.

LO AJENO NO EXISTE: las rutas del prestador no reciben el identificador de la
postulación, siempre hablan de la de quien pregunta; y un documento o una
credencial de otra postulación es un 404.

NINGÚN ESTADO SE CAMBIA CON UN PATCH: cada salto tiene su ruta (`/submit`,
`/resubmit`, `/withdraw`, `/start-review`, `/request-changes`, `/approve`,
`/reject`, `/suspend`), y todas aceptan `Idempotency-Key`.

Cada respuesta del prestador devuelve el EXPEDIENTE ENTERO recién leído: la
pantalla nunca asume el resultado, pinta lo que dice el servidor.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, Header, Query, Response, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import AuthUser, get_current_user
from app.modules.services import (
    admision,
    credenciales,
    documentos,
    esquema,
    permissions,
    politicas,
    service,
    states,
)
from app.modules.services.models import PESO_MAXIMO_DE_DOCUMENTO
from app.modules.services.schemas import (
    BorradorActualizar,
    CorreccionesSolicitar,
    CredencialEditar,
    CredencialRegistrar,
    EnlaceTemporalRead,
    EventoAdminRead,
    EventoVisibleRead,
    EvidenciaObservar,
    PaginaDeSolicitudes,
    PoliticaBorradorCrear,
    PoliticaEditar,
    PoliticaRead,
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
    TerminosAceptar,
    TerminosRead,
)
from app.shared.database import get_db

router = APIRouter(prefix="/services", tags=["services"])
admin_router = APIRouter(prefix="/admin/services", tags=["services-admin"])

#: El nombre de la acción de administración que lleva a cada estado.
ACCION_HACIA = {
    states.EN_REVISION: "start_review",
    states.CORRECCIONES_PEDIDAS: "request_changes",
    states.APROBADA: "approve",
    states.RECHAZADA: "reject",
    states.SUSPENDIDA: "suspend",
}


# --------------------------------------------------------------------------- #
# Puertas
# --------------------------------------------------------------------------- #
async def servicios_disponibles(db: AsyncSession = Depends(get_db)) -> None:
    """Bandera encendida y migraciones aplicadas, o 503 con su código."""
    await esquema.exigir_servicios(db)


async def funcion_de_revision(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> str:
    """Curaduría o administración, o 403. Devuelve con qué función actúa."""
    return await permissions.exigir_revisor(db, current_user.id)


async def funcion_de_decision(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> str:
    """Solo administración, o 403."""
    return await permissions.exigir_decisor(db, current_user.id)


def _clave(idempotency_key: str | None = Header(default=None, alias="Idempotency-Key")) -> str | None:
    return admision.exigir_clave_valida(idempotency_key)


async def _privada(db: AsyncSession, expediente: service.Expediente) -> SolicitudPrivadaRead:
    faltan = (
        await service.faltantes_de(db, expediente)
        if states.es_editable(expediente.solicitud.status)
        else []
    )
    return SolicitudPrivadaRead.desde(expediente, faltan=faltan, hoy=service.hoy())


async def _mia_fresca(db: AsyncSession, usuario_id: str) -> SolicitudPrivadaRead:
    return await _privada(db, await service.la_mia(db, usuario_id))


async def _admin(
    db: AsyncSession, solicitud_id: str, *, funcion: str, usuario_id: str
) -> SolicitudAdminRead:
    expediente = await service.expediente_de(db, await service.por_id(db, solicitud_id))
    propia = expediente.prestador.profile_id == usuario_id
    acciones = (
        []
        if propia
        else [
            ACCION_HACIA[h]
            for h in states.siguientes(expediente.solicitud.status, funcion)
            if h in ACCION_HACIA
        ]
    )
    bloqueos = (
        service.bloqueos_para_aprobar(expediente)
        if expediente.solicitud.status == states.EN_REVISION
        else []
    )
    return SolicitudAdminRead.desde(
        expediente, hoy=service.hoy(), bloqueos=bloqueos, acciones=acciones, propia=propia
    )


async def _leer_archivo(archivo: UploadFile) -> bytes:
    return await archivo.read(PESO_MAXIMO_DE_DOCUMENTO + 1)


# =========================================================================== #
# PRESTADOR: su postulación
# =========================================================================== #
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
    """Empieza la postulación o devuelve la viva. 201 si nace, 200 si ya estaba.

    Tras una retirada nace otra vacía; tras un rechazo, lo decide la política
    (`service_reapplication_not_configured` / `_not_allowed`)."""
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
    """La postulación viva, o la última (rechazada o retirada). 404 si no hay."""
    return await _mia_fresca(db, current_user.id)


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


# --- Condiciones ------------------------------------------------------------ #
@router.get("/provider/terms", response_model=TerminosRead)
async def condiciones_vigentes(
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> TerminosRead:
    """Las condiciones que rigen HOY para el país (y la categoría) de SU
    postulación. `provider_terms_not_published` si la empresa no ha publicado
    ninguna; `service_application_country_required` sin país."""
    expediente = await service.la_mia(db, current_user.id)
    if not expediente.prestador.country_code:
        raise admision.PaisRequerido()
    vigente = await admision.politica_vigente_para(db, expediente.solicitud, expediente.prestador)
    if vigente is None:
        raise politicas.TerminosNoPublicados()
    return TerminosRead.desde(vigente)


@router.post("/provider/application/terms", response_model=SolicitudPrivadaRead)
async def aceptar_condiciones(
    cuerpo: TerminosAceptar,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> SolicitudPrivadaRead:
    """Acepta EXPRESAMENTE la versión vigente, con su huella exacta."""
    await admision.aceptar_terminos(
        db,
        usuario_id=current_user.id,
        politica_id=cuerpo.terms_policy_id,
        huella=cuerpo.terms_sha256,
    )
    await db.commit()
    return await _mia_fresca(db, current_user.id)


# --- Documentos --------------------------------------------------------------- #
@router.post(
    "/provider/application/documents",
    response_model=SolicitudPrivadaRead,
    status_code=status.HTTP_201_CREATED,
)
async def subir_documento(
    response: Response,
    archivo: UploadFile = File(..., alias="file"),
    kind: str = Form(...),
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> SolicitudPrivadaRead:
    """Sube un documento (PDF o foto, máx. 10 MB) al depósito privado.

    La ruta la pone el servidor. Reintentar con el mismo archivo devuelve el
    mismo documento (200). Solo en `draft` o `changes_requested`."""
    expediente = await service.la_mia(db, current_user.id, bloquear=True)
    documento, nuevo = await documentos.subir(
        db,
        solicitud=expediente.solicitud,
        usuario_id=current_user.id,
        kind=kind,
        datos=await _leer_archivo(archivo),
        declarado=archivo.content_type,
    )
    ruta = documento.storage_path
    try:
        if nuevo:
            await admision.auditar(
                db, accion="service_document.uploaded", entidad="service_provider_document",
                entidad_id=documento.id, actor_id=current_user.id, funcion=states.PRESTADOR,
                datos={"application_id": expediente.solicitud.id, "kind": documento.kind},
            )
        await db.commit()
    except BaseException:
        # El archivo ya subió: sin su fila no es de nadie. Se borra, falle lo
        # que falle entre la subida y el commit.
        await db.rollback()
        if nuevo:
            await documentos.borrar_archivo(ruta)
        raise
    if not nuevo:
        response.status_code = status.HTTP_200_OK
    return await _mia_fresca(db, current_user.id)


@router.post(
    "/provider/application/documents/{document_id}/replace",
    response_model=SolicitudPrivadaRead,
)
async def reemplazar_documento(
    document_id: str,
    archivo: UploadFile = File(..., alias="file"),
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> SolicitudPrivadaRead:
    """Sube uno nuevo del mismo tipo; el anterior queda como evidencia."""
    expediente = await service.la_mia(db, current_user.id, bloquear=True)
    anterior = await documentos.uno(
        db, solicitud_id=expediente.solicitud.id, documento_id=document_id
    )
    nuevo = await documentos.reemplazar(
        db,
        solicitud=expediente.solicitud,
        documento=anterior,
        usuario_id=current_user.id,
        datos=await _leer_archivo(archivo),
        declarado=archivo.content_type,
    )
    ruta = nuevo.storage_path
    try:
        await admision.auditar(
            db, accion="service_document.replaced", entidad="service_provider_document",
            entidad_id=nuevo.id, actor_id=current_user.id, funcion=states.PRESTADOR,
            datos={
                "application_id": expediente.solicitud.id,
                "replaces": anterior.id,
                "kind": nuevo.kind,
            },
        )
        await db.commit()
    except BaseException:
        await db.rollback()
        await documentos.borrar_archivo(ruta)
        raise
    return await _mia_fresca(db, current_user.id)


@router.delete(
    "/provider/application/documents/{document_id}", response_model=SolicitudPrivadaRead
)
async def retirar_documento(
    document_id: str,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> SolicitudPrivadaRead:
    """Retira un documento que NUNCA se envió (y borra su archivo)."""
    expediente = await service.la_mia(db, current_user.id, bloquear=True)
    documento = await documentos.uno(
        db, solicitud_id=expediente.solicitud.id, documento_id=document_id
    )
    ruta = await documentos.retirar(db, solicitud=expediente.solicitud, documento=documento)
    if ruta:
        await admision.auditar(
            db, accion="service_document.removed", entidad="service_provider_document",
            entidad_id=documento.id, actor_id=current_user.id, funcion=states.PRESTADOR,
            datos={"application_id": expediente.solicitud.id, "kind": documento.kind},
        )
    await db.commit()
    await documentos.borrar_archivo(ruta)
    return await _mia_fresca(db, current_user.id)


@router.post(
    "/provider/application/documents/{document_id}/view", response_model=EnlaceTemporalRead
)
async def ver_mi_documento(
    document_id: str,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> EnlaceTemporalRead:
    """Un enlace de dos minutos para mirar SU documento. No se guarda."""
    expediente = await service.la_mia(db, current_user.id)
    documento = await documentos.uno(
        db, solicitud_id=expediente.solicitud.id, documento_id=document_id
    )
    return EnlaceTemporalRead(
        url=await documentos.firmar(documento), expires_in=documentos.SEGUNDOS_DE_LA_FIRMA
    )


# --- Credenciales ------------------------------------------------------------- #
@router.post(
    "/provider/application/credentials",
    response_model=SolicitudPrivadaRead,
    status_code=status.HTTP_201_CREATED,
)
async def registrar_credencial(
    cuerpo: CredencialRegistrar,
    response: Response,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(servicios_disponibles),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> SolicitudPrivadaRead:
    """Declara una credencial. Con la misma `Idempotency-Key`, la misma."""
    expediente = await service.la_mia(db, current_user.id, bloquear=True)
    credencial, nueva = await credenciales.crear(
        db, solicitud=expediente.solicitud, datos=cuerpo.model_dump(), clave=clave
    )
    if nueva:
        await admision.auditar(
            db, accion="service_credential.declared", entidad="service_provider_credential",
            entidad_id=credencial.id, actor_id=current_user.id, funcion=states.PRESTADOR,
            datos={"application_id": expediente.solicitud.id, "kind": credencial.kind},
        )
    await db.commit()
    if not nueva:
        response.status_code = status.HTTP_200_OK
    return await _mia_fresca(db, current_user.id)


@router.patch(
    "/provider/application/credentials/{credential_id}", response_model=SolicitudPrivadaRead
)
async def editar_credencial(
    credential_id: str,
    cuerpo: CredencialEditar,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> SolicitudPrivadaRead:
    """Edita una credencial declarada (y así se corrige una observada)."""
    expediente = await service.la_mia(db, current_user.id, bloquear=True)
    credencial = await credenciales.una(
        db, solicitud_id=expediente.solicitud.id, credencial_id=credential_id
    )
    await credenciales.editar(
        db, solicitud=expediente.solicitud, credencial=credencial, cambios=cuerpo.cambios()
    )
    await admision.auditar(
        db, accion="service_credential.updated", entidad="service_provider_credential",
        entidad_id=credencial.id, actor_id=current_user.id, funcion=states.PRESTADOR,
        datos={"application_id": expediente.solicitud.id, "kind": credencial.kind},
    )
    await db.commit()
    return await _mia_fresca(db, current_user.id)


@router.delete(
    "/provider/application/credentials/{credential_id}", response_model=SolicitudPrivadaRead
)
async def retirar_credencial(
    credential_id: str,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> SolicitudPrivadaRead:
    """Retira una credencial que NUNCA se envió."""
    expediente = await service.la_mia(db, current_user.id, bloquear=True)
    credencial = await credenciales.una(
        db, solicitud_id=expediente.solicitud.id, credencial_id=credential_id
    )
    await credenciales.retirar(db, solicitud=expediente.solicitud, credencial=credencial)
    await admision.auditar(
        db, accion="service_credential.removed", entidad="service_provider_credential",
        entidad_id=credencial.id, actor_id=current_user.id, funcion=states.PRESTADOR,
        datos={"application_id": expediente.solicitud.id, "kind": credencial.kind},
    )
    await db.commit()
    return await _mia_fresca(db, current_user.id)


# --- Saltos del prestador ----------------------------------------------------- #
@router.post("/provider/application/submit", response_model=SolicitudPrivadaRead)
async def enviar_postulacion(
    cuerpo: SolicitudEnviar,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(servicios_disponibles),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> SolicitudPrivadaRead:
    """`draft → submitted`. Exige todo lo que diga `missing` y las condiciones
    vigentes aceptadas. Congela el envío y avisa a revisión."""
    await admision.enviar(db, usuario_id=current_user.id, clave=clave)
    await db.commit()
    return await _mia_fresca(db, current_user.id)


@router.post("/provider/application/resubmit", response_model=SolicitudPrivadaRead)
async def reenviar_postulacion(
    cuerpo: SolicitudEnviar,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(servicios_disponibles),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> SolicitudPrivadaRead:
    """`changes_requested → resubmitted`, con lo pedido ya corregido."""
    await admision.reenviar(db, usuario_id=current_user.id, clave=clave)
    await db.commit()
    return await _mia_fresca(db, current_user.id)


@router.post("/provider/application/withdraw", response_model=SolicitudPrivadaRead)
async def retirar_postulacion(
    cuerpo: SolicitudRetirar,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(servicios_disponibles),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> SolicitudPrivadaRead:
    """Retira SU postulación antes de la decisión. Final e idempotente."""
    await admision.retirar(db, usuario_id=current_user.id, motivo=cuerpo.reason, clave=clave)
    await db.commit()
    return await _mia_fresca(db, current_user.id)


# =========================================================================== #
# ADMINISTRACIÓN: condiciones del prestador
# =========================================================================== #
@admin_router.get("/policies", response_model=list[PoliticaRead])
async def versiones_de_condiciones(
    country: str | None = Query(default=None, pattern=r"^[A-Z]{2}$"),
    _funcion: str = Depends(funcion_de_revision),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> list[PoliticaRead]:
    """Todas las versiones (borrador, publicada, superadas) de las condiciones."""
    return [PoliticaRead.desde(p) for p in await politicas.versiones(db, pais=country)]


@admin_router.post(
    "/policies/provider-terms/draft",
    response_model=PoliticaRead,
    status_code=status.HTTP_201_CREATED,
)
async def crear_borrador_de_condiciones(
    cuerpo: PoliticaBorradorCrear,
    response: Response,
    current_user: AuthUser = Depends(get_current_user),
    _funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> PoliticaRead:
    """Crea el borrador de un país, o devuelve el que ya hay (200) sin tocarlo."""
    politica, nueva = await politicas.borrador(
        db,
        pais=cuerpo.country_code,
        categoria=cuerpo.category,
        titulo=cuerpo.title,
        texto=cuerpo.body,
        parametros=cuerpo.parameters,
        autor_id=current_user.id,
    )
    if nueva:
        await admision.auditar(
            db, accion="service_policy.draft_created", entidad="service_policy",
            entidad_id=politica.id, actor_id=current_user.id, funcion=states.ADMINISTRACION,
            datos={"country": politica.country_code, "version": politica.version},
        )
    await db.commit()
    if not nueva:
        response.status_code = status.HTTP_200_OK
    return PoliticaRead.desde(politica)


@admin_router.patch("/policies/{policy_id}", response_model=PoliticaRead)
async def editar_borrador_de_condiciones(
    policy_id: str,
    cuerpo: PoliticaEditar,
    current_user: AuthUser = Depends(get_current_user),
    _funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> PoliticaRead:
    """Solo el BORRADOR. Una publicada no se edita (y la base lo impide)."""
    politica = await politicas.editar_borrador(
        db, politica=await politicas.por_id(db, policy_id), cambios=cuerpo.cambios()
    )
    await admision.auditar(
        db, accion="service_policy.draft_updated", entidad="service_policy",
        entidad_id=politica.id, actor_id=current_user.id, funcion=states.ADMINISTRACION,
        datos={"version": politica.version, "fields": sorted(cuerpo.cambios())},
    )
    await db.commit()
    return PoliticaRead.desde(politica)


@admin_router.get("/policies/{policy_id}/preview", response_model=TerminosRead)
async def previsualizar_condiciones(
    policy_id: str,
    _funcion: str = Depends(funcion_de_revision),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> TerminosRead:
    """Cómo lo verá quien postula: título, texto, versión y huella."""
    return TerminosRead.desde(await politicas.por_id(db, policy_id))


@admin_router.post("/policies/{policy_id}/publish", response_model=PoliticaRead)
async def publicar_condiciones(
    policy_id: str,
    current_user: AuthUser = Depends(get_current_user),
    _funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> PoliticaRead:
    """Publica el borrador y supera la anterior en la misma transacción. Las
    aceptaciones ya hechas siguen apuntando a la versión que se aceptó."""
    politica = await politicas.publicar(
        db, politica=await politicas.por_id(db, policy_id, bloquear=True), autor_id=current_user.id
    )
    await admision.auditar(
        db, accion="service_policy.published", entidad="service_policy",
        entidad_id=politica.id, actor_id=current_user.id, funcion=states.ADMINISTRACION,
        datos={"country": politica.country_code, "version": politica.version},
    )
    await db.commit()
    return PoliticaRead.desde(politica)


# =========================================================================== #
# ADMINISTRACIÓN: postulaciones
# =========================================================================== #
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

    `status` filtra por UNO de los nueve estados; `provider_type` por persona o
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
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_revision),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> SolicitudAdminRead:
    """El expediente completo, con lo que impide aprobar y lo que QUIEN MIRA
    puede hacer ahora (nada, si es el dueño)."""
    return await _admin(db, application_id, funcion=funcion, usuario_id=current_user.id)


@admin_router.get(
    "/applications/{application_id}/history", response_model=list[EventoAdminRead]
)
async def historial_completo(
    application_id: str,
    current_user: AuthUser = Depends(get_current_user),
    _funcion: str = Depends(funcion_de_revision),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> list[EventoAdminRead]:
    """Todo el historial. Quien mira SU PROPIA postulación (alguien del equipo
    que también postula) no lee las notas internas que Z escribió sobre ella."""
    solicitud = await service.por_id(db, application_id)
    expediente = await service.expediente_de(db, solicitud)
    propia = expediente.prestador.profile_id == current_user.id
    return [
        EventoAdminRead.desde(e, sin_notas=propia)
        for e in await service.historial(db, solicitud.id)
    ]


@admin_router.post(
    "/applications/{application_id}/documents/{document_id}/view",
    response_model=EnlaceTemporalRead,
)
async def ver_documento(
    application_id: str,
    document_id: str,
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_revision),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> EnlaceTemporalRead:
    """Un enlace de DOS MINUTOS para revisar el archivo. Queda en la auditoría
    quién lo pidió; el enlace no se guarda en ningún sitio."""
    solicitud = await service.por_id(db, application_id)
    documento = await documentos.uno(db, solicitud_id=solicitud.id, documento_id=document_id)
    enlace = await documentos.firmar(documento)
    await admision.auditar(
        db, accion="service_document.viewed", entidad="service_provider_document",
        entidad_id=documento.id, actor_id=current_user.id, funcion=funcion,
        datos={"application_id": solicitud.id, "kind": documento.kind},
    )
    await db.commit()
    return EnlaceTemporalRead(url=enlace, expires_in=documentos.SEGUNDOS_DE_LA_FIRMA)


@admin_router.post(
    "/applications/{application_id}/documents/{document_id}/accept",
    response_model=SolicitudAdminRead,
)
async def aceptar_documento(
    application_id: str,
    document_id: str,
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_revision),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> SolicitudAdminRead:
    await admision.revisar_documento(
        db, solicitud_id=application_id, documento_id=document_id, aceptar=True, nota=None,
        actor_id=current_user.id, funcion=funcion,
    )
    await db.commit()
    return await _admin(db, application_id, funcion=funcion, usuario_id=current_user.id)


@admin_router.post(
    "/applications/{application_id}/documents/{document_id}/observe",
    response_model=SolicitudAdminRead,
)
async def observar_documento(
    application_id: str,
    document_id: str,
    cuerpo: EvidenciaObservar,
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_revision),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> SolicitudAdminRead:
    await admision.revisar_documento(
        db, solicitud_id=application_id, documento_id=document_id, aceptar=False,
        nota=cuerpo.note, actor_id=current_user.id, funcion=funcion,
    )
    await db.commit()
    return await _admin(db, application_id, funcion=funcion, usuario_id=current_user.id)


async def _revisar_credencial(
    db: AsyncSession, *, application_id: str, credential_id: str, accion: str,
    nota: str | None, current_user: AuthUser, funcion: str,
) -> SolicitudAdminRead:
    await admision.revisar_credencial(
        db, solicitud_id=application_id, credencial_id=credential_id, accion=accion,
        nota=nota, actor_id=current_user.id, funcion=funcion,
    )
    await db.commit()
    return await _admin(db, application_id, funcion=funcion, usuario_id=current_user.id)


@admin_router.post(
    "/applications/{application_id}/credentials/{credential_id}/verify",
    response_model=SolicitudAdminRead,
)
async def verificar_credencial(
    application_id: str,
    credential_id: str,
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_revision),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> SolicitudAdminRead:
    """Solo con evidencia y sin vencer."""
    return await _revisar_credencial(
        db, application_id=application_id, credential_id=credential_id, accion="verify",
        nota=None, current_user=current_user, funcion=funcion,
    )


@admin_router.post(
    "/applications/{application_id}/credentials/{credential_id}/observe",
    response_model=SolicitudAdminRead,
)
async def observar_credencial(
    application_id: str,
    credential_id: str,
    cuerpo: EvidenciaObservar,
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_revision),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> SolicitudAdminRead:
    return await _revisar_credencial(
        db, application_id=application_id, credential_id=credential_id, accion="observe",
        nota=cuerpo.note, current_user=current_user, funcion=funcion,
    )


@admin_router.post(
    "/applications/{application_id}/credentials/{credential_id}/reject",
    response_model=SolicitudAdminRead,
)
async def rechazar_credencial(
    application_id: str,
    credential_id: str,
    cuerpo: EvidenciaObservar,
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_revision),
    _disponible: None = Depends(servicios_disponibles),
    db: AsyncSession = Depends(get_db),
) -> SolicitudAdminRead:
    return await _revisar_credencial(
        db, application_id=application_id, credential_id=credential_id, accion="reject",
        nota=cuerpo.note, current_user=current_user, funcion=funcion,
    )


# --- Saltos de administración ------------------------------------------------- #
@admin_router.post(
    "/applications/{application_id}/start-review", response_model=SolicitudAdminRead
)
async def iniciar_revision(
    application_id: str,
    cuerpo: RevisionIniciar,
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_revision),
    _disponible: None = Depends(servicios_disponibles),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> SolicitudAdminRead:
    """Toma una enviada o reenviada, o devuelve a revisión una suspendida."""
    await admision.iniciar_revision(
        db, solicitud_id=application_id, actor_id=current_user.id, funcion=funcion,
        nota_interna=cuerpo.internal_note, clave=clave,
    )
    await db.commit()
    return await _admin(db, application_id, funcion=funcion, usuario_id=current_user.id)


@admin_router.post(
    "/applications/{application_id}/request-changes", response_model=SolicitudAdminRead
)
async def pedir_correcciones(
    application_id: str,
    cuerpo: CorreccionesSolicitar,
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_revision),
    _disponible: None = Depends(servicios_disponibles),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> SolicitudAdminRead:
    await admision.pedir_correcciones(
        db, solicitud_id=application_id, actor_id=current_user.id, funcion=funcion,
        mensaje=cuerpo.message, campos=cuerpo.fields, nota_interna=cuerpo.internal_note,
        clave=clave,
    )
    await db.commit()
    return await _admin(db, application_id, funcion=funcion, usuario_id=current_user.id)


@admin_router.post("/applications/{application_id}/approve", response_model=SolicitudAdminRead)
async def aprobar(
    application_id: str,
    cuerpo: SolicitudAprobar,
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(servicios_disponibles),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> SolicitudAdminRead:
    """Solo administración, solo desde revisión y con todo lo exigido cumplido
    (`service_application_requirements_pending` con la lista si no)."""
    await admision.aprobar(
        db, solicitud_id=application_id, actor_id=current_user.id, funcion=funcion,
        mensaje=cuerpo.message, nota_interna=cuerpo.internal_note, clave=clave,
    )
    await db.commit()
    return await _admin(db, application_id, funcion=funcion, usuario_id=current_user.id)


@admin_router.post("/applications/{application_id}/reject", response_model=SolicitudAdminRead)
async def rechazar(
    application_id: str,
    cuerpo: SolicitudRechazar,
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(servicios_disponibles),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> SolicitudAdminRead:
    await admision.rechazar(
        db, solicitud_id=application_id, actor_id=current_user.id, funcion=funcion,
        mensaje=cuerpo.message, nota_interna=cuerpo.internal_note, clave=clave,
    )
    await db.commit()
    return await _admin(db, application_id, funcion=funcion, usuario_id=current_user.id)


@admin_router.post("/applications/{application_id}/suspend", response_model=SolicitudAdminRead)
async def suspender(
    application_id: str,
    cuerpo: PrestadorSuspender,
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(servicios_disponibles),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> SolicitudAdminRead:
    """Suspende a un prestador APROBADO, con motivo. Se levanta pasando otra
    vez por revisión (`/start-review`)."""
    await admision.suspender(
        db, solicitud_id=application_id, actor_id=current_user.id, funcion=funcion,
        mensaje=cuerpo.message, nota_interna=cuerpo.internal_note, clave=clave,
    )
    await db.commit()
    return await _admin(db, application_id, funcion=funcion, usuario_id=current_user.id)


__all__ = ["ACCION_HACIA", "admin_router", "router"]
