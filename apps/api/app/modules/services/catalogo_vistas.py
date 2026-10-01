"""Lo que cada uno lee del catálogo: se arma aquí, por lotes.

SIN CONSULTAS POR FILA: una página de servicios trae sus versiones, sus
imágenes y sus categorías en una consulta por tabla, y las URLs se firman de
una vez. Las listas van POR CURSOR (fecha|id), no por desplazamiento: con
filas que cambian mientras alguien mira, el desplazamiento repite y se salta.
"""

from __future__ import annotations

from datetime import timezone
from uuid import UUID

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.modules.services import catalogo, catalogo_estados as estados, catalogo_imagenes as imagenes, esquema
from app.modules.services.catalogo_models import (
    Service,
    ServiceCategory,
    ServiceVersion,
    ServiceVersionImage,
)
from app.modules.services.catalogo_schemas import (
    ACCION_HACIA_EL_SERVICIO,
    ACCION_HACIA_LA_VERSION,
    CategoriaPublicaRead,
    CategoriaRead,
    EventoAdminRead,
    EventoVisibleRead,
    ObservacionRead,
    PaginaDeServicios,
    PaginaDeServiciosAdmin,
    PrestadorEnServicioRead,
    ServicioAdminRead,
    ServicioAdminResumenRead,
    ServicioPrivadoRead,
    ServicioPublicoRead,
    ServicioResumenRead,
    VersionEnListaRead,
    VersionRead,
)
from app.modules.services.models import PRESTADOR_ACTIVO, ServiceProvider
from app.modules.services.service import CursorInvalido, _cursor_partido

LIMITE_MAXIMO = 50

#: Las colas de la bandeja de administración.
COLAS = ("pending", "draft", "published", "suspended", "retired", "all")


def es_uuid(valor: str) -> bool:
    try:
        UUID(str(valor))
    except ValueError:
        return False
    return True


def _cursor(momento, ident: str) -> str:
    if momento.tzinfo is None:
        momento = momento.replace(tzinfo=timezone.utc)
    return f"{momento.isoformat()}|{ident}"


async def _versiones(db: AsyncSession, servicios: list[str]) -> dict[str, dict[str, ServiceVersion]]:
    """`servicio -> {"abierta": v, "publicada": v, "ultima": v}` en dos
    consultas. La ÚLTIMA (por número) nombra al servicio cuando no hay abierta
    ni publicada: la que volvió con cambios, o una retirada."""
    resultado: dict[str, dict[str, ServiceVersion]] = {s: {} for s in servicios}
    if not servicios:
        return resultado
    filas = await db.scalars(
        select(ServiceVersion).where(
            ServiceVersion.service_id.in_(servicios),
            ServiceVersion.status.in_(tuple(estados.ABIERTAS | {estados.PUBLICADA})),
        )
    )
    for v in filas:
        clave = "publicada" if v.status == estados.PUBLICADA else "abierta"
        resultado[v.service_id][clave] = v
    numeros = (
        select(ServiceVersion.service_id, func.max(ServiceVersion.version).label("n"))
        .where(ServiceVersion.service_id.in_(servicios))
        .group_by(ServiceVersion.service_id)
        .subquery()
    )
    for v in await db.scalars(
        select(ServiceVersion).join(
            numeros, and_(ServiceVersion.service_id == numeros.c.service_id, ServiceVersion.version == numeros.c.n)
        )
    ):
        resultado[v.service_id]["ultima"] = v
    return resultado


def _la_que_nombra(par: dict[str, ServiceVersion]) -> ServiceVersion | None:
    return par.get("abierta") or par.get("publicada") or par.get("ultima")


async def _imagenes(db: AsyncSession, versiones: list[str]) -> dict[str, list[ServiceVersionImage]]:
    resultado: dict[str, list[ServiceVersionImage]] = {v: [] for v in versiones}
    if not versiones:
        return resultado
    for i in await db.scalars(
        select(ServiceVersionImage)
        .where(ServiceVersionImage.version_id.in_(versiones))
        .order_by(ServiceVersionImage.position, ServiceVersionImage.id)
    ):
        resultado[i.version_id].append(i)
    return resultado


async def _numeros(db: AsyncSession, ids: list[str]) -> dict[str, int]:
    ids = [i for i in ids if i]
    if not ids:
        return {}
    return {
        i: n for i, n in (await db.execute(
            select(ServiceVersion.id, ServiceVersion.version).where(ServiceVersion.id.in_(ids))
        )).all()
    }


async def _version_read(
    db: AsyncSession, v: ServiceVersion | None, imgs: list[ServiceVersionImage], firmadas: dict[str, str]
) -> VersionRead | None:
    if v is None:
        return None
    base = (await _numeros(db, [v.based_on_version_id])).get(v.based_on_version_id) if v.based_on_version_id else None
    return VersionRead.desde(v, imagenes=imgs, firmadas=firmadas, base=base)


async def _observacion(db: AsyncSession, servicio_id: str) -> ObservacionRead | None:
    evento = await catalogo.ultima_observacion(db, servicio_id)
    if evento is None:
        return None
    numero = (await _numeros(db, [evento.version_id])).get(evento.version_id) if evento.version_id else None
    detalles = evento.details if isinstance(evento.details, dict) else {}
    return ObservacionRead(
        action=evento.action, note=evento.visible_note or "",
        fields=[str(f) for f in detalles.get("fields", [])], version=numero,
        created_at=evento.created_at,
    )


async def _visible(db: AsyncSession, servicio: Service, publicada: ServiceVersion | None) -> bool:
    """Lo decide la misma autoridad que el catálogo público (Incremento 3):
    si la categoría se desactiva, quien lo ofrece ve «no visible», no un
    «publicado» que nadie encuentra."""
    if servicio.status not in estados.VISIBLE_AL_PUBLICO or publicada is None:
        return False
    from app.modules.services import descubrimiento

    return bool(await db.scalar(select(descubrimiento.base().where(Service.id == servicio.id).exists())))


# --------------------------------------------------------------------------- #
# El prestador
# --------------------------------------------------------------------------- #
async def privada(db: AsyncSession, servicio: Service, prestador: ServiceProvider) -> ServicioPrivadoRead:
    par = (await _versiones(db, [servicio.id]))[servicio.id]
    abierta, vigente = par.get("abierta"), par.get("publicada")
    nombra, ultima = _la_que_nombra(par), par.get("ultima")
    imgs = await _imagenes(db, [v.id for v in (abierta, vigente) if v is not None])
    firmadas = await imagenes.firmar(sorted({i.storage_path for lista in imgs.values() for i in lista}))
    categoria = await db.get(ServiceCategory, servicio.category_id)
    editable = abierta is not None and abierta.status == estados.BORRADOR and servicio.status != estados.SERVICIO_RETIRADO
    falta = await catalogo.faltantes_de(db, servicio, abierta, prestador) if editable else []
    return ServicioPrivadoRead(
        id=servicio.id,
        status=servicio.status,
        title=nombra.title if nombra else None,
        last_version_status=ultima.status if ultima else None,
        category=CategoriaRead.desde(categoria),
        created_at=servicio.created_at,
        updated_at=servicio.updated_at,
        first_published_at=servicio.first_published_at,
        published_at=servicio.published_at,
        suspended_at=servicio.suspended_at,
        retired_at=servicio.retired_at,
        published_version=await _version_read(db, vigente, imgs.get(vigente.id, []) if vigente else [], firmadas),
        open_version=await _version_read(db, abierta, imgs.get(abierta.id, []) if abierta else [], firmadas),
        last_observation=await _observacion(db, servicio.id),
        missing=falta,
        can_edit=editable,
        can_submit=editable and not falta,
        can_withdraw=abierta is not None and abierta.status in estados.RETIRABLES,
        can_open_draft=abierta is None and servicio.status != estados.SERVICIO_RETIRADO,
        publicly_visible=await _visible(db, servicio, vigente),
        can_manage_schedule=(
            prestador.status == PRESTADOR_ACTIVO
            and servicio.status != estados.SERVICIO_RETIRADO
            and await esquema.hay_agenda(db)
        ),
    )


async def pagina_del_prestador(
    db: AsyncSession, prestador: ServiceProvider, *, cursor: str | None, limite: int
) -> PaginaDeServicios:
    limite = max(1, min(int(limite), LIMITE_MAXIMO))
    consulta = select(Service).where(Service.provider_id == prestador.id)
    if cursor:
        momento, ident = _cursor_partido(cursor)
        consulta = consulta.where(
            or_(Service.created_at < momento, and_(Service.created_at == momento, Service.id < ident))
        )
    filas = list(
        await db.scalars(consulta.order_by(Service.created_at.desc(), Service.id.desc()).limit(limite + 1))
    )
    siguiente = None
    if len(filas) > limite:
        filas = filas[:limite]
        siguiente = _cursor(filas[-1].created_at, filas[-1].id)
    return PaginaDeServicios(items=await _resumenes(db, filas), next_cursor=siguiente)


async def _resumenes(db: AsyncSession, filas: list[Service]) -> list[ServicioResumenRead]:
    ids = [s.id for s in filas]
    versiones = await _versiones(db, ids)
    categorias = {
        c.id: c for c in await db.scalars(
            select(ServiceCategory).where(ServiceCategory.id.in_({s.category_id for s in filas}))
        )
    } if filas else {}
    mostradas = {s: _la_que_nombra(par) for s, par in versiones.items()}
    imgs = await _imagenes(db, [v.id for v in mostradas.values() if v is not None])
    portadas = {
        vid: next((i for i in lista if i.is_cover), None) for vid, lista in imgs.items()
    }
    firmadas = await imagenes.firmar(sorted({p.storage_path for p in portadas.values() if p}))
    items = []
    for s in filas:
        par = versiones[s.id]
        mostrada = mostradas[s.id]
        portada = portadas.get(mostrada.id) if mostrada else None
        items.append(
            ServicioResumenRead(
                id=s.id,
                status=s.status,
                title=mostrada.title if mostrada else None,
                category=CategoriaPublicaRead.desde(categorias[s.category_id]),
                open_version_status=par["abierta"].status if "abierta" in par else None,
                last_version_status=par["ultima"].status if "ultima" in par else None,
                has_published_version="publicada" in par,
                cover_url=firmadas.get(portada.storage_path) if portada else None,
                updated_at=s.updated_at,
            )
        )
    return items


async def historial_visible(db: AsyncSession, servicio_id: str) -> list[EventoVisibleRead]:
    eventos = await catalogo.historial(db, servicio_id)
    numeros = await _numeros(db, [e.version_id for e in eventos])
    return [EventoVisibleRead.desde(e, numeros.get(e.version_id)) for e in eventos]


# --------------------------------------------------------------------------- #
# Administración
# --------------------------------------------------------------------------- #
def acciones(servicio: Service, abierta: ServiceVersion | None, funcion: str) -> list[str]:
    elegidas: list[str] = []
    if abierta is not None:
        for hasta in estados.siguientes_de_la_version(abierta.status, funcion):
            if hasta in ACCION_HACIA_LA_VERSION:
                elegidas.append(ACCION_HACIA_LA_VERSION[hasta])
    for hasta in estados.siguientes_del_servicio(servicio.status, funcion):
        # La primera publicación es la de una versión, no una acción aparte.
        if servicio.status == estados.SERVICIO_BORRADOR and hasta == estados.SERVICIO_PUBLICADO:
            continue
        elegidas.append(ACCION_HACIA_EL_SERVICIO[hasta])
    return elegidas


async def admin(db: AsyncSession, servicio: Service, *, usuario_id: str, funcion: str) -> ServicioAdminRead:
    prestador = await db.get(ServiceProvider, servicio.provider_id)
    par = (await _versiones(db, [servicio.id]))[servicio.id]
    abierta, vigente = par.get("abierta"), par.get("publicada")
    nombra = _la_que_nombra(par)
    imgs = await _imagenes(db, [v.id for v in (abierta, vigente) if v is not None])
    firmadas = await imagenes.firmar(sorted({i.storage_path for lista in imgs.values() for i in lista}))
    categoria = await db.get(ServiceCategory, servicio.category_id)
    todas = list(
        await db.scalars(
            select(ServiceVersion).where(ServiceVersion.service_id == servicio.id).order_by(ServiceVersion.version.desc())
        )
    )
    propia = prestador.profile_id == usuario_id
    return ServicioAdminRead(
        id=servicio.id,
        status=servicio.status,
        title=nombra.title if nombra else None,
        category=CategoriaRead.desde(categoria),
        provider=PrestadorEnServicioRead.desde(prestador),
        created_at=servicio.created_at,
        updated_at=servicio.updated_at,
        first_published_at=servicio.first_published_at,
        published_at=servicio.published_at,
        suspended_at=servicio.suspended_at,
        retired_at=servicio.retired_at,
        published_version=await _version_read(db, vigente, imgs.get(vigente.id, []) if vigente else [], firmadas),
        proposed_version=await _version_read(db, abierta, imgs.get(abierta.id, []) if abierta else [], firmadas),
        changed_fields=catalogo.campos_distintos(
            abierta, vigente, imgs.get(abierta.id, []), imgs.get(vigente.id, []) if vigente else []
        ) if abierta is not None else [],
        versions=[
            VersionEnListaRead(
                id=v.id, version=v.version, status=v.status, submitted_at=v.submitted_at,
                decided_at=v.decided_at, published_at=v.published_at,
            )
            for v in todas
        ],
        last_observation=await _observacion(db, servicio.id),
        actions=[] if propia else acciones(servicio, abierta, funcion),
        own=propia,
        publicly_visible=await _visible(db, servicio, vigente),
    )


async def version_admin(db: AsyncSession, version: ServiceVersion) -> VersionRead:
    imgs = await catalogo.imagenes_de(db, version.id)
    firmadas = await imagenes.firmar(sorted({i.storage_path for i in imgs}))
    return await _version_read(db, version, imgs, firmadas)


async def historial_admin(db: AsyncSession, servicio_id: str) -> list[EventoAdminRead]:
    eventos = await catalogo.historial(db, servicio_id)
    numeros = await _numeros(db, [e.version_id for e in eventos])
    return [EventoAdminRead.desde_admin(e, numeros.get(e.version_id)) for e in eventos]


async def bandeja(
    db: AsyncSession,
    *,
    cola: str,
    estado_version: str | None,
    categoria_id: str | None,
    modalidad: str | None,
    prestador_id: str | None,
    cursor: str | None,
    limite: int,
) -> PaginaDeServiciosAdmin:
    limite = max(1, min(int(limite), LIMITE_MAXIMO))
    abierta = aliased(ServiceVersion)
    vigente = aliased(ServiceVersion)
    consulta = (
        select(Service, ServiceProvider, abierta, vigente)
        .join(ServiceProvider, ServiceProvider.id == Service.provider_id)
        .outerjoin(abierta, and_(abierta.service_id == Service.id, abierta.status.in_(tuple(estados.ABIERTAS))))
        .outerjoin(vigente, and_(vigente.service_id == Service.id, vigente.status == estados.PUBLICADA))
    )
    if cola == "pending":
        consulta = consulta.where(abierta.status.in_(tuple(estados.PENDIENTES_DE_Z)))
    elif cola != "all":
        consulta = consulta.where(Service.status == cola)
    if estado_version:
        consulta = consulta.where(abierta.status == estado_version)
    if categoria_id:
        consulta = consulta.where(Service.category_id == categoria_id)
    if modalidad:
        consulta = consulta.where(func.coalesce(abierta.modality, vigente.modality) == modalidad)
    if prestador_id:
        consulta = consulta.where(Service.provider_id == prestador_id)
    if cursor:
        momento, ident = _cursor_partido(cursor)
        consulta = consulta.where(
            or_(Service.updated_at < momento, and_(Service.updated_at == momento, Service.id < ident))
        )
    filas = list(
        (await db.execute(consulta.order_by(Service.updated_at.desc(), Service.id.desc()).limit(limite + 1))).all()
    )
    siguiente = None
    if len(filas) > limite:
        filas = filas[:limite]
        siguiente = _cursor(filas[-1][0].updated_at, filas[-1][0].id)
    categorias = {
        c.id: c for c in await db.scalars(
            select(ServiceCategory).where(ServiceCategory.id.in_({f[0].category_id for f in filas}))
        )
    } if filas else {}
    # Sin abierta ni publicada, la última lo nombra (una que volvió con cambios).
    ultimas = await _versiones(db, [s.id for s, _, a, v in filas if a is None and v is None])
    items = []
    for s, p, a, v in filas:
        mostrada = a or v or ultimas.get(s.id, {}).get("ultima")
        items.append(
            ServicioAdminResumenRead(
                id=s.id,
                status=s.status,
                title=mostrada.title if mostrada else None,
                category=CategoriaPublicaRead.desde(categorias[s.category_id]),
                modality=mostrada.modality if mostrada else None,
                provider_name=p.display_name,
                provider_status=p.status,
                open_version_status=a.status if a else None,
                open_version=a.version if a else None,
                submitted_at=a.submitted_at if a else None,
                updated_at=s.updated_at,
            )
        )
    return PaginaDeServiciosAdmin(items=items, next_cursor=siguiente)


# --------------------------------------------------------------------------- #
# El público
# --------------------------------------------------------------------------- #
async def publica(db: AsyncSession, servicio_id: str, *, mira: str | None = None):
    """La ficha pública (Incremento 3): lo que decide `descubrimiento` y nada
    más. Lo que no es público es el mismo 404 que no existe."""
    from app.modules.services import descubrimiento, posventa
    from app.modules.services.descubrimiento_schemas import (
        ConfianzaRead,
        FichaPublicaRead,
        PrestadorDeLaFichaRead,
        ResenasRead,
        TarjetaDeServicioRead,
    )

    try:
        f = await descubrimiento.ficha(db, servicio_id, mira=mira)
    except descubrimiento.ServicioNoPublico:
        raise catalogo.ServicioNoEncontrado() from None
    imgs = await catalogo.imagenes_de(db, f.version.id)
    firmadas = await imagenes.firmar(sorted({i.storage_path for i in imgs}))
    comun = ServicioPublicoRead.desde(f.servicio, f.version, f.prestador, f.categoria, imgs, firmadas)
    cuantas, promedio = await posventa.resenas_visibles(db, servicio_id=f.servicio.id)
    return FichaPublicaRead(
        **comun.model_dump(exclude={"provider"}),
        provider=PrestadorDeLaFichaRead(
            id=f.prestador.id,
            display_name=f.prestador.display_name,
            provider_type=f.prestador.provider_type,
            trust=ConfianzaRead.desde(f.confianza),
        ),
        category_parent_id=f.categoria.parent_id,
        approved_by_z=True,
        reviews=ResenasRead(count=cuantas, average=promedio),
        saved=f.guardado,
        more_from_provider=[TarjetaDeServicioRead.desde(t) for t in f.del_prestador],
        related=[TarjetaDeServicioRead.desde(t) for t in f.relacionados],
    )


__all__ = [
    "COLAS",
    "CursorInvalido",
    "LIMITE_MAXIMO",
    "acciones",
    "admin",
    "bandeja",
    "es_uuid",
    "historial_admin",
    "historial_visible",
    "pagina_del_prestador",
    "privada",
    "publica",
    "version_admin",
]
