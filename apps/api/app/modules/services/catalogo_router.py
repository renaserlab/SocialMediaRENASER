"""Las rutas del catálogo de Servicios (Incremento 2).

EL ORDEN DE LAS PUERTAS, como en la admisión:

    prestador        sesión (401) -> bandera, admisión y 0090 (503) -> cuerpo (422)
    administración   sesión (401) -> rol (403) -> bandera, admisión y 0090 (503)
    público          bandera, admisión y 0090 (503) -> 404 si no está publicado

LO AJENO NO EXISTE: un servicio de otro prestador es un 404, igual que uno que
no existe, y la ficha pública de un borrador, suspendido o retirado también.

NINGÚN ESTADO SE CAMBIA CON UN PATCH: cada salto tiene su ruta (`/submit`,
`/withdraw`, `/start-review`, `/request-changes`, `/approve`, `/publish`,
`/suspend`, `/reinstate`, `/retire`) y todas aceptan `Idempotency-Key`.

Cada respuesta del prestador y de administración devuelve el SERVICIO ENTERO
recién leído: la pantalla pinta lo que dice el servidor.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, Query, Response, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import AuthUser, get_current_user
from app.modules.services import (
    catalogo,
    catalogo_imagenes as imagenes,
    catalogo_vistas as vistas,
    categorias,
    esquema,
)
from app.modules.services import service as admision_service
from app.modules.services.catalogo_models import PESO_MAXIMO_DE_LA_IMAGEN
from app.modules.services.catalogo_schemas import (
    CambiosPedir,
    CategoriaCrear,
    CategoriaEditar,
    CategoriaRead,
    CompletitudRead,
    EventoAdminRead,
    EventoVisibleRead,
    ImagenesOrdenar,
    PaginaDeServicios,
    PaginaDeServiciosAdmin,
    RevisionIniciar,
    ServicioAdminRead,
    ServicioCrear,
    ServicioMotivo,
    ServicioPrivadoRead,
    ServicioPublicoRead,
    VersionAprobar,
    VersionPublicar,
    VersionRead,
    VersionRetirar,
    BorradorEditar,
)
from app.modules.services.router import _clave, funcion_de_decision, funcion_de_revision
from app.shared.database import get_db

router = APIRouter(prefix="/services", tags=["services-catalog"])
admin_router = APIRouter(prefix="/admin/services", tags=["services-catalog-admin"])


async def catalogo_disponible(db: AsyncSession = Depends(get_db)) -> None:
    """Bandera encendida, admisión y 0090 completas, o 503 con su código."""
    await esquema.exigir_catalogo(db)


def _id(valor: str) -> str:
    """Un identificador mal escrito es un 404, no un 500."""
    if not vistas.es_uuid(valor):
        raise catalogo.ServicioNoEncontrado()
    return valor


async def _mio_fresco(db: AsyncSession, usuario_id: str, servicio_id: str) -> ServicioPrivadoRead:
    servicio, prestador = await catalogo.mio(db, usuario_id, servicio_id, bloquear_fila=False)
    await db.refresh(servicio)
    return await vistas.privada(db, servicio, prestador)


async def _admin_fresco(db: AsyncSession, servicio_id: str, usuario_id: str, funcion: str) -> ServicioAdminRead:
    from app.modules.services.catalogo_models import Service

    servicio = await db.get(Service, servicio_id)
    if servicio is None:
        raise catalogo.ServicioNoEncontrado()
    await db.refresh(servicio)
    return await vistas.admin(db, servicio, usuario_id=usuario_id, funcion=funcion)


# =========================================================================== #
# PRESTADOR (y quien crea un servicio): las categorías activas
# =========================================================================== #
@router.get("/categories", response_model=list[CategoriaRead])
async def categorias_activas(
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> list[CategoriaRead]:
    """Las categorías que QUIEN PREGUNTA puede usar: activas, de su país o de
    todos, y sin madre inactiva. Sin ninguna, no se puede crear un servicio
    (y la app lo dice)."""
    prestador = await admision_service.prestador_de(db, current_user.id)
    pais = prestador.country_code if prestador is not None else None
    activas = await categorias.todas(db, solo_activas=True)
    ids = {c.id for c in activas}
    return [
        CategoriaRead.desde(c)
        for c in activas
        if c.country_code in (None, pais) and (c.parent_id is None or c.parent_id in ids)
    ]


# =========================================================================== #
# PRESTADOR: sus servicios
# =========================================================================== #
@router.get("/provider/services", response_model=PaginaDeServicios)
async def mis_servicios(
    cursor: str | None = Query(default=None, max_length=120),
    limit: int = Query(default=20, ge=1, le=vistas.LIMITE_MAXIMO),
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> PaginaDeServicios:
    """Los servicios propios, del más nuevo al más viejo. Solo un prestador
    ACTIVO tiene catálogo; los demás, 403 `service_provider_not_active`."""
    prestador = await catalogo.prestador_activo(db, current_user.id)
    return await vistas.pagina_del_prestador(db, prestador, cursor=cursor, limite=limit)


@router.post("/provider/services", response_model=ServicioPrivadoRead, status_code=status.HTTP_201_CREATED)
async def crear_servicio(
    cuerpo: ServicioCrear,
    response: Response,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(catalogo_disponible),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> ServicioPrivadoRead:
    """Un servicio nuevo con su primer borrador. Con la misma
    `Idempotency-Key`, devuelve el mismo (200)."""
    resultado = await catalogo.crear(db, usuario_id=current_user.id, categoria_id=cuerpo.category_id, clave=clave)
    await db.commit()
    if resultado.repetido:
        response.status_code = status.HTTP_200_OK
    return await _mio_fresco(db, current_user.id, resultado.servicio.id)


@router.get("/provider/services/{service_id}", response_model=ServicioPrivadoRead)
async def mi_servicio(
    service_id: str,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> ServicioPrivadoRead:
    return await _mio_fresco(db, current_user.id, _id(service_id))


@router.post("/provider/services/{service_id}/draft", response_model=ServicioPrivadoRead)
async def abrir_borrador(
    service_id: str,
    response: Response,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> ServicioPrivadoRead:
    """El borrador abierto, o uno nuevo que sale de la última versión (201).
    Mientras tanto, la publicada sigue visible."""
    resultado = await catalogo.abrir_borrador(db, usuario_id=current_user.id, servicio_id=_id(service_id))
    await db.commit()
    if not resultado.repetido:
        response.status_code = status.HTTP_201_CREATED
    return await _mio_fresco(db, current_user.id, service_id)


@router.patch("/provider/services/{service_id}/draft", response_model=ServicioPrivadoRead)
async def editar_borrador(
    service_id: str,
    cuerpo: BorradorEditar,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> ServicioPrivadoRead:
    """Solo lo que llega y solo en el borrador. NUNCA un estado."""
    await catalogo.editar_borrador(
        db, usuario_id=current_user.id, servicio_id=_id(service_id), cambios=cuerpo.cambios()
    )
    await db.commit()
    return await _mio_fresco(db, current_user.id, service_id)


@router.get("/provider/services/{service_id}/draft/requirements", response_model=CompletitudRead)
async def lo_que_falta(
    service_id: str,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> CompletitudRead:
    """Qué le falta al borrador para enviarse. La autoridad es el servidor."""
    servicio, prestador = await catalogo.mio(db, current_user.id, _id(service_id), bloquear_fila=False)
    version = await catalogo.abierta(db, servicio.id)
    if version is None or version.status != "draft":
        raise catalogo.SinBorrador()
    return CompletitudRead(missing=await catalogo.faltantes_de(db, servicio, version, prestador))


@router.post(
    "/provider/services/{service_id}/draft/images",
    response_model=ServicioPrivadoRead,
    status_code=status.HTTP_201_CREATED,
)
async def subir_imagen(
    service_id: str,
    response: Response,
    archivo: UploadFile = File(..., alias="file"),
    alt_text: str = Form(..., max_length=300),
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(catalogo_disponible),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> ServicioPrivadoRead:
    """Una imagen del borrador (JPEG, PNG o WebP, máx. 5 MB) al depósito
    privado. La ruta la pone el servidor; la primera es la portada."""
    fila, nueva = await imagenes.subir(
        db,
        usuario_id=current_user.id,
        servicio_id=_id(service_id),
        datos=await archivo.read(PESO_MAXIMO_DE_LA_IMAGEN + 1),
        declarado=archivo.content_type,
        alt_text=alt_text,
        clave=clave,
    )
    ruta = fila.storage_path
    try:
        await db.commit()
    except BaseException:
        # El archivo ya subió: sin su fila no es de nadie.
        await db.rollback()
        if nueva:
            await imagenes.borrar_archivo(ruta)
        raise
    if not nueva:
        response.status_code = status.HTTP_200_OK
    return await _mio_fresco(db, current_user.id, service_id)


@router.put("/provider/services/{service_id}/draft/images/order", response_model=ServicioPrivadoRead)
async def ordenar_imagenes(
    service_id: str,
    cuerpo: ImagenesOrdenar,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> ServicioPrivadoRead:
    """El orden de TODAS las imágenes del borrador y, si llega, la portada."""
    await imagenes.ordenar(
        db, usuario_id=current_user.id, servicio_id=_id(service_id),
        en_orden=cuerpo.image_ids, portada=cuerpo.cover_id,
    )
    await db.commit()
    return await _mio_fresco(db, current_user.id, service_id)


@router.delete("/provider/services/{service_id}/draft/images/{image_id}", response_model=ServicioPrivadoRead)
async def quitar_imagen(
    service_id: str,
    image_id: str,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> ServicioPrivadoRead:
    """Quita una imagen del borrador. El archivo solo se borra si ninguna otra
    versión (la publicada, por ejemplo) lo sigue usando."""
    if not vistas.es_uuid(image_id):
        raise imagenes.ImagenNoEncontrada()
    ruta = await imagenes.quitar(db, usuario_id=current_user.id, servicio_id=_id(service_id), imagen_id=image_id)
    await db.commit()
    # Confirmada la base, el archivo (si nadie más lo nombra).
    if ruta is not None:
        await imagenes.borrar_archivo(ruta)
    return await _mio_fresco(db, current_user.id, service_id)


@router.post("/provider/services/{service_id}/draft/submit", response_model=ServicioPrivadoRead)
async def enviar_servicio(
    service_id: str,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(catalogo_disponible),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> ServicioPrivadoRead:
    """`draft → submitted`, completo (si no, 422 `service_catalog_incomplete`
    con la lista). La versión queda congelada y se avisa al equipo de Z."""
    await catalogo.enviar(db, usuario_id=current_user.id, servicio_id=_id(service_id), clave=clave)
    await db.commit()
    return await _mio_fresco(db, current_user.id, service_id)


@router.post("/provider/services/{service_id}/draft/withdraw", response_model=ServicioPrivadoRead)
async def retirar_version(
    service_id: str,
    cuerpo: VersionRetirar,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(catalogo_disponible),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> ServicioPrivadoRead:
    """Retira la versión abierta antes de publicarse. La publicada sigue."""
    await catalogo.retirar_version(db, usuario_id=current_user.id, servicio_id=_id(service_id), clave=clave)
    await db.commit()
    return await _mio_fresco(db, current_user.id, service_id)


@router.get("/provider/services/{service_id}/history", response_model=list[EventoVisibleRead])
async def historial_propio(
    service_id: str,
    current_user: AuthUser = Depends(get_current_user),
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> list[EventoVisibleRead]:
    """El historial VISIBLE: sin quién de Z actuó y sin notas internas."""
    servicio, _ = await catalogo.mio(db, current_user.id, _id(service_id), bloquear_fila=False)
    return await vistas.historial_visible(db, servicio.id)


# =========================================================================== #
# PÚBLICO: la ficha de un servicio publicado
# =========================================================================== #
@router.get("/catalog/{service_id}", response_model=ServicioPublicoRead)
async def ficha_publica(
    service_id: str,
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> ServicioPublicoRead:
    """Solo lo publicado de un prestador activo. Borrador, suspendido, retirado
    o inexistente: el mismo 404."""
    return await vistas.publica(db, service_id)


# =========================================================================== #
# ADMINISTRACIÓN: la bandeja, la revisión y la publicación
# =========================================================================== #
@admin_router.get("/catalog", response_model=PaginaDeServiciosAdmin)
async def bandeja(
    queue: str = Query(default="pending", pattern="^(pending|draft|published|suspended|retired|all)$"),
    version_status: str | None = Query(default=None, pattern="^(submitted|under_review|approved)$"),
    category_id: str | None = Query(default=None),
    modality: str | None = Query(default=None, pattern="^(virtual|in_person|at_home)$"),
    provider_id: str | None = Query(default=None),
    cursor: str | None = Query(default=None, max_length=120),
    limit: int = Query(default=20, ge=1, le=vistas.LIMITE_MAXIMO),
    funcion: str = Depends(funcion_de_revision),
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> PaginaDeServiciosAdmin:
    """Por defecto, lo que espera al equipo (enviados, en revisión y aprobados
    sin publicar), lo más reciente primero."""
    for ident in (category_id, provider_id):
        if ident is not None and not vistas.es_uuid(ident):
            return PaginaDeServiciosAdmin()
    return await vistas.bandeja(
        db, cola=queue, estado_version=version_status, categoria_id=category_id,
        modalidad=modality, prestador_id=provider_id, cursor=cursor, limite=limit,
    )


@admin_router.get("/catalog/{service_id}", response_model=ServicioAdminRead)
async def servicio_admin(
    service_id: str,
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_revision),
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> ServicioAdminRead:
    return await _admin_fresco(db, _id(service_id), current_user.id, funcion)


@admin_router.get("/catalog/{service_id}/versions/{version_id}", response_model=VersionRead)
async def version_admin(
    service_id: str,
    version_id: str,
    funcion: str = Depends(funcion_de_revision),
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> VersionRead:
    """Cualquier versión del servicio, para compararla."""
    if not vistas.es_uuid(version_id):
        raise catalogo.VersionNoEncontrada()
    version = await catalogo.version_del_servicio(db, _id(service_id), version_id)
    return await vistas.version_admin(db, version)


@admin_router.get("/catalog/{service_id}/history", response_model=list[EventoAdminRead])
async def historial_admin(
    service_id: str,
    funcion: str = Depends(funcion_de_revision),
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> list[EventoAdminRead]:
    """El historial COMPLETO: quién actuó, en calidad de qué, y notas internas."""
    from app.modules.services.catalogo_models import Service

    if await db.get(Service, _id(service_id)) is None:
        raise catalogo.ServicioNoEncontrado()
    return await vistas.historial_admin(db, service_id)


def _version_id(valor: str) -> str:
    if not vistas.es_uuid(valor):
        raise catalogo.VersionNoEncontrada()
    return valor


@admin_router.post("/catalog/{service_id}/versions/{version_id}/start-review", response_model=ServicioAdminRead)
async def iniciar_revision(
    service_id: str,
    version_id: str,
    cuerpo: RevisionIniciar,
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_revision),
    _disponible: None = Depends(catalogo_disponible),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> ServicioAdminRead:
    await catalogo.iniciar_revision(
        db, actor_id=current_user.id, funcion=funcion, servicio_id=_id(service_id),
        version_id=_version_id(version_id), nota_interna=cuerpo.internal_note, clave=clave,
    )
    await db.commit()
    return await _admin_fresco(db, service_id, current_user.id, funcion)


@admin_router.post("/catalog/{service_id}/versions/{version_id}/request-changes", response_model=ServicioAdminRead)
async def pedir_cambios(
    service_id: str,
    version_id: str,
    cuerpo: CambiosPedir,
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_revision),
    _disponible: None = Depends(catalogo_disponible),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> ServicioAdminRead:
    """Cierra la versión con un motivo VISIBLE y, si se quiere, los campos."""
    await catalogo.pedir_cambios(
        db, actor_id=current_user.id, funcion=funcion, servicio_id=_id(service_id),
        version_id=_version_id(version_id), nota=cuerpo.note, campos=cuerpo.fields,
        nota_interna=cuerpo.internal_note, clave=clave,
    )
    await db.commit()
    return await _admin_fresco(db, service_id, current_user.id, funcion)


@admin_router.post("/catalog/{service_id}/versions/{version_id}/approve", response_model=ServicioAdminRead)
async def aprobar(
    service_id: str,
    version_id: str,
    cuerpo: VersionAprobar,
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(catalogo_disponible),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> ServicioAdminRead:
    """Solo administración. Aprobar NO publica: es otro paso."""
    await catalogo.aprobar(
        db, actor_id=current_user.id, servicio_id=_id(service_id), version_id=_version_id(version_id),
        nota_interna=cuerpo.internal_note, clave=clave,
    )
    await db.commit()
    return await _admin_fresco(db, service_id, current_user.id, funcion)


@admin_router.post("/catalog/{service_id}/versions/{version_id}/publish", response_model=ServicioAdminRead)
async def publicar(
    service_id: str,
    version_id: str,
    cuerpo: VersionPublicar,
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(catalogo_disponible),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> ServicioAdminRead:
    """Solo administración y solo una versión APROBADA. La anterior pasa a
    superada en la misma transacción."""
    await catalogo.publicar(
        db, actor_id=current_user.id, servicio_id=_id(service_id), version_id=_version_id(version_id),
        nota_interna=cuerpo.internal_note, clave=clave,
    )
    await db.commit()
    return await _admin_fresco(db, service_id, current_user.id, funcion)


async def _paso_del_servicio(
    accion, service_id: str, cuerpo: ServicioMotivo, current_user: AuthUser, funcion: str,
    clave: str | None, db: AsyncSession,
) -> ServicioAdminRead:
    await accion(
        db, actor_id=current_user.id, servicio_id=_id(service_id), nota=cuerpo.note,
        nota_interna=cuerpo.internal_note, clave=clave,
    )
    await db.commit()
    return await _admin_fresco(db, service_id, current_user.id, funcion)


@admin_router.post("/catalog/{service_id}/suspend", response_model=ServicioAdminRead)
async def suspender(
    service_id: str,
    cuerpo: ServicioMotivo,
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(catalogo_disponible),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> ServicioAdminRead:
    """Sale del público con motivo visible. No borra nada."""
    return await _paso_del_servicio(catalogo.suspender, service_id, cuerpo, current_user, funcion, clave, db)


@admin_router.post("/catalog/{service_id}/reinstate", response_model=ServicioAdminRead)
async def reactivar(
    service_id: str,
    cuerpo: ServicioMotivo,
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(catalogo_disponible),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> ServicioAdminRead:
    """Levanta la suspensión, con el motivo resuelto. Vuelve la versión publicada."""
    return await _paso_del_servicio(catalogo.reactivar, service_id, cuerpo, current_user, funcion, clave, db)


@admin_router.post("/catalog/{service_id}/retire", response_model=ServicioAdminRead)
async def retirar_servicio(
    service_id: str,
    cuerpo: ServicioMotivo,
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(catalogo_disponible),
    clave: str | None = Depends(_clave),
    db: AsyncSession = Depends(get_db),
) -> ServicioAdminRead:
    """Sale del catálogo PARA SIEMPRE, con su historia intacta."""
    return await _paso_del_servicio(catalogo.retirar_servicio, service_id, cuerpo, current_user, funcion, clave, db)


# =========================================================================== #
# ADMINISTRACIÓN: las categorías
# =========================================================================== #
@admin_router.get("/categories", response_model=list[CategoriaRead])
async def categorias_admin(
    funcion: str = Depends(funcion_de_revision),
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> list[CategoriaRead]:
    """Todas, activas e inactivas."""
    return [CategoriaRead.desde(c) for c in await categorias.todas(db, solo_activas=False)]


@admin_router.post("/categories", response_model=CategoriaRead, status_code=status.HTTP_201_CREATED)
async def crear_categoria(
    cuerpo: CategoriaCrear,
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> CategoriaRead:
    categoria = await categorias.crear(db, actor_id=current_user.id, datos=cuerpo.model_dump())
    await db.commit()
    return CategoriaRead.desde(categoria)


def _categoria_id(valor: str) -> str:
    if not vistas.es_uuid(valor):
        raise catalogo.CategoriaNoEncontrada()
    return valor


@admin_router.patch("/categories/{category_id}", response_model=CategoriaRead)
async def editar_categoria(
    category_id: str,
    cuerpo: CategoriaEditar,
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> CategoriaRead:
    """Nombre, textos, icono, país, orden y madre. NI el estado ni el slug."""
    categoria = await categorias.editar(
        db, actor_id=current_user.id, categoria_id=_categoria_id(category_id), cambios=cuerpo.cambios()
    )
    await db.commit()
    return CategoriaRead.desde(categoria)


@admin_router.post("/categories/{category_id}/activate", response_model=CategoriaRead)
async def activar_categoria(
    category_id: str,
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> CategoriaRead:
    categoria = await categorias.cambiar_estado(
        db, actor_id=current_user.id, categoria_id=_categoria_id(category_id), activa=True
    )
    await db.commit()
    return CategoriaRead.desde(categoria)


@admin_router.post("/categories/{category_id}/deactivate", response_model=CategoriaRead)
async def desactivar_categoria(
    category_id: str,
    current_user: AuthUser = Depends(get_current_user),
    funcion: str = Depends(funcion_de_decision),
    _disponible: None = Depends(catalogo_disponible),
    db: AsyncSession = Depends(get_db),
) -> CategoriaRead:
    """No acepta servicios nuevos. Los que ya la usan siguen nombrándola."""
    categoria = await categorias.cambiar_estado(
        db, actor_id=current_user.id, categoria_id=_categoria_id(category_id), activa=False
    )
    await db.commit()
    return CategoriaRead.desde(categoria)
