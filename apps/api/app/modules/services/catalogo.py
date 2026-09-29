"""EL CATÁLOGO DE SERVICIOS: crear, editar, enviar, revisar y publicar.

CADA ACCIÓN, EN ESTE ORDEN Y EN UNA SOLA TRANSACCIÓN (como `admision.py`):

  1. BLOQUEA LA FILA DEL SERVICIO (`SELECT … FOR UPDATE`). Dos envíos, dos
     aprobaciones o dos publicaciones a la vez no ven el mismo estado: la
     segunda espera y, al entrar, encuentra el nuevo.
  2. REPETICIÓN: si la misma `Idempotency-Key` ya dejó su evento, devuelve lo
     que hay sin escribir nada. Las acciones del prestador (enviar, retirar)
     son idempotentes también por estado.
  3. NADIE REVISA, APRUEBA NI PUBLICA LO SUYO (antes que el rol), el salto
     EXISTE y es de quien lo pide (`catalogo_estados`), y lo enviado está
     COMPLETO (`catalogo_requisitos`).
  4. ESCRIBE a la vez el estado, el historial (`service_events`, solo se
     añade), la AUDITORÍA (solo lo necesario: nada de textos libres) y los
     AVISOS (en savepoints: si fallan, la decisión sigue).

EL CONTENIDO VIVE EN LA VERSIÓN; la identidad, en el servicio. Solo el
borrador se edita. Pedir cambios cierra la versión: corregir es abrir una
nueva que sale de ella.

NINGÚN ESTADO SE CAMBIA POR PATCH: editar el borrador no toca ni un estado.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, ForbiddenError, NotFoundError, ValidationAppError
from app.modules.services import avisos, catalogo_estados as estados, catalogo_requisitos as requisitos
from app.modules.services import service as admision_service
from app.modules.services.admision import ROL_DE_AUDITORIA, ClaveReutilizada
from app.modules.services.catalogo_models import (
    CATEGORIA_ACTIVA,
    CON_IMPORTE,
    Service,
    ServiceCategory,
    ServiceEvent,
    ServiceVersion,
    ServiceVersionImage,
)
from app.modules.services.models import PRESTADOR_ACTIVO, ServiceProvider
from app.modules.services.states import ADMINISTRACION, PRESTADOR, SISTEMA

ENTIDAD = avisos.ENTIDAD_SERVICIO

#: Lo que el prestador puede escribir en su borrador. NI UN ESTADO.
CAMPOS_DEL_BORRADOR = (
    "title",
    "summary",
    "description",
    "modality",
    "duration_minutes",
    "capacity",
    "price_model",
    "price_minor",
    "currency",
    "scope",
    "includes",
    "excludes",
    "requirements",
    "conditions",
    "location_area",
)

#: Lo que se copia de una versión a la siguiente.
_CONTENIDO = CAMPOS_DEL_BORRADOR


# --------------------------------------------------------------------------- #
# Errores (códigos estables)
# --------------------------------------------------------------------------- #
class PrestadorNoActivo(ForbiddenError):
    code = "service_provider_not_active"
    message = "Solo un prestador aprobado y activo ofrece servicios."


class PrestadorNoDisponible(ConflictError):
    """Para el equipo: el prestador ya no está activo."""

    code = "service_provider_unavailable"
    message = "El prestador de este servicio no está activo."


class ServicioNoEncontrado(NotFoundError):
    """404 para lo que no existe Y para lo ajeno."""

    code = "service_not_found"
    message = "No encontramos ese servicio."


class VersionNoEncontrada(NotFoundError):
    code = "service_version_not_found"
    message = "No encontramos esa versión del servicio."


class CategoriaNoEncontrada(NotFoundError):
    code = "service_category_not_found"
    message = "No encontramos esa categoría."


class CategoriaInactiva(ConflictError):
    code = "service_category_inactive"
    message = "Esa categoría no admite servicios nuevos."


class CategoriaNoDisponible(ConflictError):
    code = "service_category_not_available"
    message = "Esa categoría no está disponible en tu país."


class CategoriaFija(ConflictError):
    code = "service_category_locked"
    message = "La categoría de un servicio ya publicado no cambia."


class ServicioRetirado(ConflictError):
    code = "service_retired"
    message = "Este servicio salió del catálogo y ya no se edita."


class SinBorrador(ConflictError):
    code = "service_draft_missing"
    message = "Este servicio no tiene un borrador abierto."


class VersionPendiente(ConflictError):
    code = "service_version_pending"
    message = "Hay una versión de este servicio esperando al equipo de Z."


class ServicioIncompleto(ValidationAppError):
    code = "service_catalog_incomplete"
    message = "Al servicio todavía le falta información."


class PrecioInvalido(ValidationAppError):
    code = "service_price_invalid"
    message = "Un importe solo va con precio fijo o «desde»."


class MotivoRequerido(ValidationAppError):
    code = "service_reason_required"
    message = "Este paso lleva un motivo que el prestador pueda leer."


class CampoDesconocido(ValidationAppError):
    code = "service_field_unknown"
    message = "Uno de los campos señalados no existe."


class EsTuPropioServicio(ForbiddenError):
    code = "service_self_review_forbidden"
    message = "Nadie revisa, aprueba ni publica su propio servicio."


@dataclass
class Resultado:
    servicio: Service
    version: ServiceVersion | None
    evento: ServiceEvent | None
    repetido: bool


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# Lecturas y cerrojos
# --------------------------------------------------------------------------- #
async def bloquear(db: AsyncSession, servicio_id: str) -> Service:
    """La fila del servicio, BLOQUEADA hasta el final de la transacción."""
    servicio = await db.scalar(
        select(Service)
        .where(Service.id == servicio_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if servicio is None:
        raise ServicioNoEncontrado()
    return servicio


async def prestador_activo(db: AsyncSession, usuario_id: str) -> ServiceProvider:
    prestador = await admision_service.prestador_de(db, usuario_id)
    if prestador is None or prestador.status != PRESTADOR_ACTIVO:
        raise PrestadorNoActivo()
    return prestador


async def mio(
    db: AsyncSession, usuario_id: str, servicio_id: str, *, bloquear_fila: bool = True
) -> tuple[Service, ServiceProvider]:
    """El servicio de quien pregunta. LO AJENO ES UN 404, nunca un 403."""
    prestador = await admision_service.prestador_de(db, usuario_id)
    if prestador is None:
        raise ServicioNoEncontrado()
    if bloquear_fila:
        servicio = await bloquear(db, servicio_id)
    else:
        servicio = await db.get(Service, servicio_id)
    if servicio is None or servicio.provider_id != prestador.id:
        raise ServicioNoEncontrado()
    return servicio, prestador


async def abierta(db: AsyncSession, servicio_id: str) -> ServiceVersion | None:
    return await db.scalar(
        select(ServiceVersion).where(
            ServiceVersion.service_id == servicio_id,
            ServiceVersion.status.in_(tuple(estados.ABIERTAS)),
        )
    )


async def publicada(db: AsyncSession, servicio_id: str) -> ServiceVersion | None:
    return await db.scalar(
        select(ServiceVersion).where(
            ServiceVersion.service_id == servicio_id,
            ServiceVersion.status == estados.PUBLICADA,
        )
    )


async def version_del_servicio(db: AsyncSession, servicio_id: str, version_id: str) -> ServiceVersion:
    version = await db.get(ServiceVersion, version_id)
    if version is None or version.service_id != servicio_id:
        raise VersionNoEncontrada()
    return version


async def imagenes_de(db: AsyncSession, version_id: str) -> list[ServiceVersionImage]:
    return list(
        await db.scalars(
            select(ServiceVersionImage)
            .where(ServiceVersionImage.version_id == version_id)
            .order_by(ServiceVersionImage.position, ServiceVersionImage.id)
        )
    )


async def categoria_utilizable(
    db: AsyncSession, categoria_id: str, prestador: ServiceProvider
) -> ServiceCategory:
    categoria = await db.get(ServiceCategory, categoria_id)
    if categoria is None:
        raise CategoriaNoEncontrada()
    if categoria.status != CATEGORIA_ACTIVA:
        raise CategoriaInactiva()
    if categoria.country_code and categoria.country_code != prestador.country_code:
        raise CategoriaNoDisponible()
    return categoria


async def faltantes_de(
    db: AsyncSession, servicio: Service, version: ServiceVersion, prestador: ServiceProvider
) -> list[str]:
    categoria = await db.get(ServiceCategory, servicio.category_id)
    return requisitos.faltantes(
        servicio=servicio,
        version=version,
        categoria=categoria,
        prestador=prestador,
        imagenes=await imagenes_de(db, version.id),
    )


# --------------------------------------------------------------------------- #
# Historial, auditoría, avisos
# --------------------------------------------------------------------------- #
async def _por_clave(
    db: AsyncSession, servicio_id: str, clave: str | None, accion: str
) -> ServiceEvent | None:
    """El evento que ya dejó ESTA clave. Una clave usada para OTRA acción no es
    una repetición: es un error de quien llama."""
    if not clave:
        return None
    previo = await db.scalar(
        select(ServiceEvent).where(
            ServiceEvent.service_id == servicio_id,
            ServiceEvent.idempotency_key == clave,
        )
    )
    if previo is not None and previo.action != accion:
        raise ClaveReutilizada(details={"action": previo.action})
    return previo


async def _registrar(
    db: AsyncSession,
    *,
    servicio: Service,
    version: ServiceVersion | None,
    accion: str,
    desde: str | None,
    hasta: str,
    actor_id: str | None,
    funcion: str,
    ahora: datetime,
    nota_visible: str | None = None,
    nota_interna: str | None = None,
    detalles: dict | None = None,
    clave: str | None = None,
) -> ServiceEvent:
    evento = ServiceEvent(
        service_id=servicio.id,
        version_id=version.id if version is not None else None,
        action=accion,
        from_status=desde,
        to_status=hasta,
        actor_id=actor_id,
        actor_role=funcion,
        visible_note=nota_visible,
        internal_note=nota_interna,
        details=detalles or {},
        idempotency_key=clave,
        created_at=ahora,
    )
    db.add(evento)
    await db.flush()
    return evento


async def _auditar(
    db: AsyncSession,
    *,
    accion: str,
    servicio: Service,
    version: ServiceVersion | None,
    actor_id: str | None,
    funcion: str,
    desde: str | None,
    hasta: str | None,
    datos: dict | None = None,
) -> None:
    """LO NECESARIO Y NADA MÁS: el paso, la versión y si hubo nota. Ni títulos,
    ni descripciones, ni motivos escritos (sobreviven a las cuentas, S14)."""
    from app.modules.gobernanza import auditoria

    carga = {"version": version.version} if version is not None else {}
    carga.update(datos or {})
    await auditoria.anotar(
        db,
        action=f"service.{accion}",
        entity_type=ENTIDAD,
        entity_id=servicio.id,
        actor_id=actor_id,
        actor_role=ROL_DE_AUDITORIA[funcion],
        previous_state=desde,
        new_state=hasta,
        reason=None,
        payload=carga,
    )


async def _perfil_del_dueno(db: AsyncSession, servicio: Service) -> str:
    return str(
        await db.scalar(select(ServiceProvider.profile_id).where(ServiceProvider.id == servicio.provider_id))
    )


async def _avisar_al_dueno(db: AsyncSession, servicio: Service, tipo: str, evento: ServiceEvent) -> None:
    await avisos.avisar(
        db,
        usuario_id=await _perfil_del_dueno(db, servicio),
        tipo=tipo,
        solicitud_id=servicio.id,
        suceso_id=evento.id,
        entidad=ENTIDAD,
    )


async def _avisar_al_equipo(db: AsyncSession, servicio: Service, tipo: str, evento: ServiceEvent) -> None:
    await avisos.avisar_al_equipo(
        db,
        tipo=tipo,
        solicitud_id=servicio.id,
        suceso_id=evento.id,
        excepto={await _perfil_del_dueno(db, servicio)},
        entidad=ENTIDAD,
    )


def _nota(nota: str | None, *, obligatoria: bool) -> str | None:
    limpia = (nota or "").strip() or None
    if obligatoria and (limpia is None or len(limpia) < 3):
        raise MotivoRequerido()
    return limpia


def _campos(campos: list[str] | None) -> list[str]:
    elegidos = sorted({c.strip() for c in (campos or []) if c and c.strip()})
    desconocidos = [c for c in elegidos if c not in requisitos.CAMPOS]
    if desconocidos:
        raise CampoDesconocido(details={"fields": desconocidos})
    return elegidos


# --------------------------------------------------------------------------- #
# El prestador
# --------------------------------------------------------------------------- #
async def crear(
    db: AsyncSession, *, usuario_id: str, categoria_id: str, clave: str | None
) -> Resultado:
    """Un servicio nuevo con su primer borrador. Un doble toque no crea dos."""
    prestador = await prestador_activo(db, usuario_id)
    if clave:
        previo = await db.scalar(
            select(Service).where(Service.provider_id == prestador.id, Service.creation_key == clave)
        )
        if previo is not None:
            return Resultado(previo, await abierta(db, previo.id), None, True)
    await categoria_utilizable(db, categoria_id, prestador)

    ahora = _ahora()
    try:
        async with db.begin_nested():
            servicio = Service(
                provider_id=prestador.id,
                category_id=categoria_id,
                status=estados.SERVICIO_BORRADOR,
                creation_key=clave,
                created_at=ahora,
                updated_at=ahora,
            )
            db.add(servicio)
            await db.flush()
    except IntegrityError:
        # La otra petición con la misma clave ganó: se devuelve la suya.
        previo = await db.scalar(
            select(Service).where(Service.provider_id == prestador.id, Service.creation_key == clave)
        )
        if previo is None:
            raise
        return Resultado(previo, await abierta(db, previo.id), None, True)

    version = ServiceVersion(
        service_id=servicio.id,
        version=1,
        status=estados.BORRADOR,
        includes=[],
        excludes=[],
        created_by=usuario_id,
        created_at=ahora,
        updated_at=ahora,
    )
    db.add(version)
    await db.flush()
    evento = await _registrar(
        db, servicio=servicio, version=version, accion="created", desde=None,
        hasta=estados.BORRADOR, actor_id=usuario_id, funcion=PRESTADOR, ahora=ahora,
    )
    await _auditar(
        db, accion="created", servicio=servicio, version=version, actor_id=usuario_id,
        funcion=PRESTADOR, desde=None, hasta=estados.SERVICIO_BORRADOR,
    )
    return Resultado(servicio, version, evento, False)


async def abrir_borrador(db: AsyncSession, *, usuario_id: str, servicio_id: str) -> Resultado:
    """El borrador abierto, o uno NUEVO que sale de la última versión cerrada
    (la que volvió con cambios, o la publicada). IDEMPOTENTE."""
    servicio, _ = await mio(db, usuario_id, servicio_id)
    if servicio.status == estados.SERVICIO_RETIRADO:
        raise ServicioRetirado()
    actual = await abierta(db, servicio.id)
    if actual is not None:
        if actual.status == estados.BORRADOR:
            return Resultado(servicio, actual, None, True)
        raise VersionPendiente(details={"status": actual.status})

    base = await db.scalar(
        select(ServiceVersion)
        .where(ServiceVersion.service_id == servicio.id)
        .order_by(ServiceVersion.version.desc())
        .limit(1)
    )
    ahora = _ahora()
    nueva = ServiceVersion(
        service_id=servicio.id,
        version=(base.version + 1) if base is not None else 1,
        status=estados.BORRADOR,
        based_on_version_id=base.id if base is not None else None,
        includes=[],
        excludes=[],
        created_by=usuario_id,
        created_at=ahora,
        updated_at=ahora,
    )
    if base is not None:
        for campo in _CONTENIDO:
            setattr(nueva, campo, getattr(base, campo))
    db.add(nueva)
    await db.flush()
    # LAS IMÁGENES SE COPIAN CON LA MISMA RUTA: no se suben otra vez los bytes,
    # y por eso quitar una del borrador no borra el archivo de la publicada.
    if base is not None:
        for imagen in await imagenes_de(db, base.id):
            db.add(
                ServiceVersionImage(
                    version_id=nueva.id,
                    service_id=servicio.id,
                    storage_path=imagen.storage_path,
                    alt_text=imagen.alt_text,
                    position=imagen.position,
                    is_cover=imagen.is_cover,
                    content_type=imagen.content_type,
                    byte_size=imagen.byte_size,
                    width=imagen.width,
                    height=imagen.height,
                    checksum_sha256=imagen.checksum_sha256,
                    created_by=imagen.created_by,
                    created_at=imagen.created_at,
                )
            )
        await db.flush()
    evento = await _registrar(
        db, servicio=servicio, version=nueva, accion="draft_opened", desde=None,
        hasta=estados.BORRADOR, actor_id=usuario_id, funcion=PRESTADOR, ahora=ahora,
        detalles={"based_on": base.version} if base is not None else None,
    )
    servicio.updated_at = ahora
    return Resultado(servicio, nueva, evento, False)


async def editar_borrador(
    db: AsyncSession, *, usuario_id: str, servicio_id: str, cambios: dict
) -> tuple[Service, ServiceVersion]:
    """Solo lo que llega, solo en el borrador, y NUNCA un estado."""
    servicio, prestador = await mio(db, usuario_id, servicio_id)
    if servicio.status == estados.SERVICIO_RETIRADO:
        raise ServicioRetirado()
    version = await abierta(db, servicio.id)
    if version is None:
        raise SinBorrador()
    if version.status != estados.BORRADOR:
        raise VersionPendiente(details={"status": version.status})

    ahora = _ahora()
    if "category_id" in cambios and cambios["category_id"] != servicio.category_id:
        if servicio.first_published_at is not None or servicio.status != estados.SERVICIO_BORRADOR:
            raise CategoriaFija()
        await categoria_utilizable(db, cambios["category_id"], prestador)
        servicio.category_id = cambios["category_id"]

    for campo in CAMPOS_DEL_BORRADOR:
        if campo in cambios:
            setattr(version, campo, cambios[campo])

    # EL PRECIO, COHERENTE. Gratis o a consultar no llevan importe: se limpia
    # en vez de guardar un número que nadie verá. Un importe sin modelo que lo
    # admita es un error, no un «gratis».
    if version.price_model not in CON_IMPORTE:
        if cambios.get("price_minor") is not None or cambios.get("currency") is not None:
            raise PrecioInvalido(details={"price_model": version.price_model})
        version.price_minor = None
        version.currency = None

    version.updated_at = ahora
    servicio.updated_at = ahora
    await db.flush()
    return servicio, version


async def enviar(
    db: AsyncSession, *, usuario_id: str, servicio_id: str, clave: str | None
) -> Resultado:
    """`draft → submitted`, completo. Si sale de una versión que volvió con
    cambios, el historial lo llama `resubmitted`."""
    servicio, prestador = await mio(db, usuario_id, servicio_id)
    if clave:
        previo = await db.scalar(
            select(ServiceEvent).where(
                ServiceEvent.service_id == servicio.id, ServiceEvent.idempotency_key == clave
            )
        )
        if previo is not None:
            if previo.action not in ("submitted", "resubmitted"):
                raise ClaveReutilizada(details={"action": previo.action})
            return Resultado(servicio, await db.get(ServiceVersion, previo.version_id), previo, True)
    if servicio.status == estados.SERVICIO_RETIRADO:
        raise ServicioRetirado()
    version = await abierta(db, servicio.id)
    if version is None:
        raise SinBorrador()
    if version.status == estados.ENVIADA and not clave:
        # Idempotente por estado: ya está enviada.
        return Resultado(servicio, version, None, True)
    if prestador.status != PRESTADOR_ACTIVO:
        raise PrestadorNoActivo()
    estados.exigir_version(version.status, estados.ENVIADA, PRESTADOR)

    falta = await faltantes_de(db, servicio, version, prestador)
    if falta:
        raise ServicioIncompleto(details={"missing": falta})

    base = await db.get(ServiceVersion, version.based_on_version_id) if version.based_on_version_id else None
    accion = "resubmitted" if base is not None and base.status == estados.CAMBIOS_PEDIDOS else "submitted"
    ahora = _ahora()
    version.status = estados.ENVIADA
    version.submitted_at = ahora
    version.submitted_by = usuario_id
    version.updated_at = ahora
    servicio.updated_at = ahora
    await db.flush()
    evento = await _registrar(
        db, servicio=servicio, version=version, accion=accion, desde=estados.BORRADOR,
        hasta=estados.ENVIADA, actor_id=usuario_id, funcion=PRESTADOR, ahora=ahora, clave=clave,
    )
    await _auditar(
        db, accion=accion, servicio=servicio, version=version, actor_id=usuario_id,
        funcion=PRESTADOR, desde=estados.BORRADOR, hasta=estados.ENVIADA,
    )
    await _avisar_al_equipo(
        db, servicio,
        avisos.SERVICIO_REENVIADO if accion == "resubmitted" else avisos.SERVICIO_ENVIADO,
        evento,
    )
    return Resultado(servicio, version, evento, False)


async def retirar_version(
    db: AsyncSession, *, usuario_id: str, servicio_id: str, clave: str | None
) -> Resultado:
    """El prestador retira su versión abierta ANTES de publicarse. La publicada,
    si la hay, sigue donde está."""
    servicio, _ = await mio(db, usuario_id, servicio_id)
    previo = await _por_clave(db, servicio.id, clave, "withdrawn")
    if previo is not None:
        return Resultado(servicio, await db.get(ServiceVersion, previo.version_id), previo, True)
    version = await abierta(db, servicio.id)
    if version is None:
        raise SinBorrador()
    estados.exigir_version(version.status, estados.RETIRADA, PRESTADOR)
    desde = version.status
    ahora = _ahora()
    version.status = estados.RETIRADA
    version.withdrawn_at = ahora
    version.updated_at = ahora
    servicio.updated_at = ahora
    await db.flush()
    evento = await _registrar(
        db, servicio=servicio, version=version, accion="withdrawn", desde=desde,
        hasta=estados.RETIRADA, actor_id=usuario_id, funcion=PRESTADOR, ahora=ahora, clave=clave,
    )
    await _auditar(
        db, accion="withdrawn", servicio=servicio, version=version, actor_id=usuario_id,
        funcion=PRESTADOR, desde=desde, hasta=estados.RETIRADA,
    )
    if desde in estados.PENDIENTES_DE_Z:
        await _avisar_al_equipo(db, servicio, avisos.SERVICIO_RETIRADO_EN_REVISION, evento)
    return Resultado(servicio, version, evento, False)


# --------------------------------------------------------------------------- #
# El equipo de Z
# --------------------------------------------------------------------------- #
async def _ajeno(db: AsyncSession, servicio: Service, usuario_id: str) -> None:
    """ANTES QUE EL ROL: nadie revisa ni publica lo suyo, ni siendo admin."""
    if await _perfil_del_dueno(db, servicio) == usuario_id:
        raise EsTuPropioServicio()


async def _paso_de_version(
    db: AsyncSession,
    *,
    actor_id: str,
    funcion: str,
    servicio_id: str,
    version_id: str,
    hasta: str,
    accion: str,
    clave: str | None,
    nota_visible: str | None = None,
    nota_interna: str | None = None,
    detalles: dict | None = None,
    aviso: str | None = None,
) -> Resultado:
    servicio = await bloquear(db, servicio_id)
    await _ajeno(db, servicio, actor_id)
    version = await version_del_servicio(db, servicio.id, version_id)
    previo = await _por_clave(db, servicio.id, clave, accion)
    if previo is not None:
        return Resultado(servicio, version, previo, True)
    if servicio.status == estados.SERVICIO_RETIRADO:
        raise ServicioRetirado()
    estados.exigir_version(version.status, hasta, funcion)

    desde = version.status
    ahora = _ahora()
    if hasta == estados.EN_REVISION:
        version.review_started_at = ahora
        version.reviewed_by = actor_id
    elif hasta in (estados.CAMBIOS_PEDIDOS, estados.APROBADA):
        version.decided_at = ahora
        version.decided_by = actor_id
    version.status = hasta
    version.updated_at = ahora
    servicio.updated_at = ahora
    await db.flush()
    evento = await _registrar(
        db, servicio=servicio, version=version, accion=accion, desde=desde, hasta=hasta,
        actor_id=actor_id, funcion=funcion, ahora=ahora, nota_visible=nota_visible,
        nota_interna=nota_interna, detalles=detalles, clave=clave,
    )
    await _auditar(
        db, accion=accion, servicio=servicio, version=version, actor_id=actor_id, funcion=funcion,
        desde=desde, hasta=hasta,
        datos={
            **({"with_note": True} if nota_visible else {}),
            **({"fields": detalles["fields"]} if detalles and detalles.get("fields") else {}),
        },
    )
    if aviso:
        await _avisar_al_dueno(db, servicio, aviso, evento)
    return Resultado(servicio, version, evento, False)


async def iniciar_revision(
    db: AsyncSession, *, actor_id: str, funcion: str, servicio_id: str, version_id: str,
    nota_interna: str | None, clave: str | None,
) -> Resultado:
    return await _paso_de_version(
        db, actor_id=actor_id, funcion=funcion, servicio_id=servicio_id, version_id=version_id,
        hasta=estados.EN_REVISION, accion="review_started", clave=clave,
        nota_interna=_nota(nota_interna, obligatoria=False), aviso=avisos.SERVICIO_EN_REVISION,
    )


async def pedir_cambios(
    db: AsyncSession,
    *,
    actor_id: str,
    funcion: str,
    servicio_id: str,
    version_id: str,
    nota: str | None,
    campos: list[str] | None,
    nota_interna: str | None,
    clave: str | None,
) -> Resultado:
    """Cierra la versión con un MOTIVO VISIBLE. Corregir es abrir otra."""
    motivo = _nota(nota, obligatoria=True)
    elegidos = _campos(campos)
    return await _paso_de_version(
        db, actor_id=actor_id, funcion=funcion, servicio_id=servicio_id, version_id=version_id,
        hasta=estados.CAMBIOS_PEDIDOS, accion="changes_requested", clave=clave,
        nota_visible=motivo, nota_interna=_nota(nota_interna, obligatoria=False),
        detalles={"fields": elegidos} if elegidos else None,
        aviso=avisos.SERVICIO_CAMBIOS_PEDIDOS,
    )


async def aprobar(
    db: AsyncSession, *, actor_id: str, servicio_id: str, version_id: str,
    nota_interna: str | None, clave: str | None,
) -> Resultado:
    return await _paso_de_version(
        db, actor_id=actor_id, funcion=ADMINISTRACION, servicio_id=servicio_id,
        version_id=version_id, hasta=estados.APROBADA, accion="approved", clave=clave,
        nota_interna=_nota(nota_interna, obligatoria=False), aviso=avisos.SERVICIO_APROBADO,
    )


async def publicar(
    db: AsyncSession, *, actor_id: str, servicio_id: str, version_id: str,
    nota_interna: str | None, clave: str | None,
) -> Resultado:
    """`approved → published`. La publicada anterior pasa a `superseded` en la
    MISMA transacción (primero ella: el índice no admite dos publicadas). Un
    servicio suspendido sigue suspendido: publicar no lo reactiva."""
    servicio = await bloquear(db, servicio_id)
    await _ajeno(db, servicio, actor_id)
    version = await version_del_servicio(db, servicio.id, version_id)
    previo = await _por_clave(db, servicio.id, clave, "published")
    if previo is not None:
        return Resultado(servicio, version, previo, True)
    if servicio.status == estados.SERVICIO_RETIRADO:
        raise ServicioRetirado()
    estados.exigir_version(version.status, estados.PUBLICADA, ADMINISTRACION)
    prestador = await db.get(ServiceProvider, servicio.provider_id)
    if prestador is None or prestador.status != PRESTADOR_ACTIVO:
        raise PrestadorNoDisponible()

    ahora = _ahora()
    anterior = await publicada(db, servicio.id)
    if anterior is not None:
        anterior.status = estados.SUPERADA
        anterior.superseded_at = ahora
        anterior.updated_at = ahora
        await db.flush()
        await _registrar(
            db, servicio=servicio, version=anterior, accion="superseded", desde=estados.PUBLICADA,
            hasta=estados.SUPERADA, actor_id=None, funcion=SISTEMA, ahora=ahora,
            detalles={"by_version": version.version},
        )

    version.status = estados.PUBLICADA
    version.published_at = ahora
    version.published_by = actor_id
    version.updated_at = ahora
    desde_servicio = servicio.status
    if servicio.status == estados.SERVICIO_BORRADOR:
        estados.exigir_servicio(servicio.status, estados.SERVICIO_PUBLICADO, ADMINISTRACION)
        servicio.status = estados.SERVICIO_PUBLICADO
        servicio.first_published_at = ahora
    servicio.published_at = ahora
    servicio.updated_at = ahora
    await db.flush()
    evento = await _registrar(
        db, servicio=servicio, version=version, accion="published", desde=estados.APROBADA,
        hasta=estados.PUBLICADA, actor_id=actor_id, funcion=ADMINISTRACION, ahora=ahora,
        nota_interna=_nota(nota_interna, obligatoria=False),
        detalles={"service_status": servicio.status}, clave=clave,
    )
    await _auditar(
        db, accion="published", servicio=servicio, version=version, actor_id=actor_id,
        funcion=ADMINISTRACION, desde=desde_servicio, hasta=servicio.status,
        datos={"superseded": anterior.version} if anterior is not None else None,
    )
    await _avisar_al_dueno(db, servicio, avisos.SERVICIO_PUBLICADO, evento)
    return Resultado(servicio, version, evento, False)


async def _paso_del_servicio(
    db: AsyncSession,
    *,
    actor_id: str,
    servicio_id: str,
    hasta: str,
    accion: str,
    nota: str | None,
    nota_interna: str | None,
    clave: str | None,
    aviso: str,
) -> Resultado:
    motivo = _nota(nota, obligatoria=True)
    servicio = await bloquear(db, servicio_id)
    await _ajeno(db, servicio, actor_id)
    previo = await _por_clave(db, servicio.id, clave, accion)
    if previo is not None:
        return Resultado(servicio, None, previo, True)
    estados.exigir_servicio(servicio.status, hasta, ADMINISTRACION)
    if hasta == estados.SERVICIO_PUBLICADO:
        prestador = await db.get(ServiceProvider, servicio.provider_id)
        if prestador is None or prestador.status != PRESTADOR_ACTIVO:
            raise PrestadorNoDisponible()

    ahora = _ahora()
    desde = servicio.status
    if hasta == estados.SERVICIO_RETIRADO:
        # Lo que estuviera abierto se cierra con el servicio.
        pendiente = await abierta(db, servicio.id)
        if pendiente is not None:
            anterior = pendiente.status
            pendiente.status = estados.RETIRADA
            pendiente.withdrawn_at = ahora
            pendiente.updated_at = ahora
            await db.flush()
            await _registrar(
                db, servicio=servicio, version=pendiente, accion="withdrawn", desde=anterior,
                hasta=estados.RETIRADA, actor_id=None, funcion=SISTEMA, ahora=ahora,
                detalles={"reason": "service_retired"},
            )
        servicio.retired_at = ahora
    elif hasta == estados.SERVICIO_SUSPENDIDO:
        servicio.suspended_at = ahora
    servicio.status = hasta
    servicio.updated_at = ahora
    await db.flush()
    evento = await _registrar(
        db, servicio=servicio, version=None, accion=accion, desde=desde, hasta=hasta,
        actor_id=actor_id, funcion=ADMINISTRACION, ahora=ahora, nota_visible=motivo,
        nota_interna=_nota(nota_interna, obligatoria=False), clave=clave,
    )
    await _auditar(
        db, accion=accion, servicio=servicio, version=None, actor_id=actor_id,
        funcion=ADMINISTRACION, desde=desde, hasta=hasta, datos={"with_note": True},
    )
    await _avisar_al_dueno(db, servicio, aviso, evento)
    return Resultado(servicio, None, evento, False)


async def suspender(
    db: AsyncSession, *, actor_id: str, servicio_id: str, nota: str | None,
    nota_interna: str | None, clave: str | None,
) -> Resultado:
    return await _paso_del_servicio(
        db, actor_id=actor_id, servicio_id=servicio_id, hasta=estados.SERVICIO_SUSPENDIDO,
        accion="suspended", nota=nota, nota_interna=nota_interna, clave=clave,
        aviso=avisos.SERVICIO_SUSPENDIDO,
    )


async def reactivar(
    db: AsyncSession, *, actor_id: str, servicio_id: str, nota: str | None,
    nota_interna: str | None, clave: str | None,
) -> Resultado:
    return await _paso_del_servicio(
        db, actor_id=actor_id, servicio_id=servicio_id, hasta=estados.SERVICIO_PUBLICADO,
        accion="reinstated", nota=nota, nota_interna=nota_interna, clave=clave,
        aviso=avisos.SERVICIO_REACTIVADO,
    )


async def retirar_servicio(
    db: AsyncSession, *, actor_id: str, servicio_id: str, nota: str | None,
    nota_interna: str | None, clave: str | None,
) -> Resultado:
    return await _paso_del_servicio(
        db, actor_id=actor_id, servicio_id=servicio_id, hasta=estados.SERVICIO_RETIRADO,
        accion="retired", nota=nota, nota_interna=nota_interna, clave=clave,
        aviso=avisos.SERVICIO_RETIRADO,
    )


# --------------------------------------------------------------------------- #
# Lo que ve cada uno
# --------------------------------------------------------------------------- #
async def historial(db: AsyncSession, servicio_id: str) -> list[ServiceEvent]:
    return list(
        await db.scalars(
            select(ServiceEvent)
            .where(ServiceEvent.service_id == servicio_id)
            .order_by(ServiceEvent.created_at, ServiceEvent.id)
        )
    )


async def ultima_observacion(db: AsyncSession, servicio_id: str) -> ServiceEvent | None:
    """Lo último que el equipo le dijo al prestador con motivo visible."""
    return await db.scalar(
        select(ServiceEvent)
        .where(
            ServiceEvent.service_id == servicio_id,
            ServiceEvent.visible_note.is_not(None),
        )
        .order_by(ServiceEvent.created_at.desc(), ServiceEvent.id.desc())
        .limit(1)
    )


async def publico(db: AsyncSession, servicio_id: str) -> tuple[Service, ServiceVersion, ServiceProvider, ServiceCategory]:
    """LO ÚNICO QUE VE EL PÚBLICO: un servicio publicado, de un prestador
    activo, con su versión publicada. Todo lo demás —borrador, suspendido,
    retirado, inexistente— es el mismo 404."""
    fila = (
        await db.execute(
            select(Service, ServiceVersion, ServiceProvider, ServiceCategory)
            .join(ServiceVersion, ServiceVersion.service_id == Service.id)
            .join(ServiceProvider, ServiceProvider.id == Service.provider_id)
            .join(ServiceCategory, ServiceCategory.id == Service.category_id)
            .where(
                Service.id == servicio_id,
                Service.status.in_(tuple(estados.VISIBLE_AL_PUBLICO)),
                ServiceVersion.status == estados.PUBLICADA,
                ServiceProvider.status == PRESTADOR_ACTIVO,
            )
        )
    ).first()
    if fila is None:
        raise ServicioNoEncontrado()
    return fila[0], fila[1], fila[2], fila[3]


def campos_distintos(propuesta: ServiceVersion, vigente: ServiceVersion | None) -> list[str]:
    """Qué cambia la propuesta respecto de lo publicado (para compararlas)."""
    if vigente is None:
        return []
    return [c for c in _CONTENIDO if getattr(propuesta, c) != getattr(vigente, c)]


async def contar_versiones(db: AsyncSession, servicio_id: str) -> int:
    return int(
        await db.scalar(
            select(func.count()).select_from(ServiceVersion).where(ServiceVersion.service_id == servicio_id)
        )
        or 0
    )


__all__ = [
    "CAMPOS_DEL_BORRADOR",
    "CategoriaFija",
    "CategoriaInactiva",
    "CategoriaNoDisponible",
    "CategoriaNoEncontrada",
    "EsTuPropioServicio",
    "MotivoRequerido",
    "PrecioInvalido",
    "PrestadorNoActivo",
    "PrestadorNoDisponible",
    "Resultado",
    "ServicioIncompleto",
    "ServicioNoEncontrado",
    "ServicioRetirado",
    "SinBorrador",
    "VersionNoEncontrada",
    "VersionPendiente",
    "abierta",
    "abrir_borrador",
    "aprobar",
    "bloquear",
    "campos_distintos",
    "crear",
    "editar_borrador",
    "enviar",
    "faltantes_de",
    "historial",
    "imagenes_de",
    "iniciar_revision",
    "mio",
    "pedir_cambios",
    "prestador_activo",
    "publicada",
    "publicar",
    "publico",
    "reactivar",
    "retirar_servicio",
    "retirar_version",
    "suspender",
    "ultima_observacion",
    "version_del_servicio",
]
