"""Las categorías del catálogo de Servicios. Las administra la empresa.

NO SE SIEMBRA NINGUNA: cuáles son las iniciales, cuáles están prohibidas y
cuáles son reguladas es una decisión de la empresa (pendiente). Sin categorías
activas no se puede crear ningún servicio, y la app lo dice.

DOS NIVELES COMO MUCHO: categoría y subcategoría (lo impone la 0090).

UNA INACTIVA no admite servicios nuevos ni envíos, pero NO SE BORRA y NO
desaparece de lo que ya existe: los servicios que la usan siguen nombrándola.
Activar y desactivar son acciones propias, nunca un PATCH.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, ValidationAppError
from app.modules.services import admision
from app.modules.services.catalogo import CategoriaNoEncontrada
from app.modules.services.catalogo_models import CATEGORIA_ACTIVA, CATEGORIA_INACTIVA, ServiceCategory
from app.modules.services.states import ADMINISTRACION

ENTIDAD = "service_category"

#: Lo que se edita con PATCH. Ni el estado ni el slug (el slug es la identidad
#: estable que usarán las URLs y la búsqueda del Incremento 3).
EDITABLES = ("name", "name_en", "name_pt", "description", "icon", "country_code", "sort_order", "parent_id")


class SlugRepetido(ConflictError):
    code = "service_category_slug_taken"
    message = "Ya hay una categoría con ese identificador."


class JerarquiaInvalida(ValidationAppError):
    code = "service_category_hierarchy_invalid"
    message = "Una categoría tiene, como mucho, un nivel de subcategorías."


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


async def todas(db: AsyncSession, *, solo_activas: bool) -> list[ServiceCategory]:
    consulta = select(ServiceCategory).order_by(
        ServiceCategory.sort_order, ServiceCategory.name, ServiceCategory.id
    )
    if solo_activas:
        consulta = consulta.where(ServiceCategory.status == CATEGORIA_ACTIVA)
    return list(await db.scalars(consulta))


async def _exigir_jerarquia(db: AsyncSession, categoria_id: str | None, madre_id: str | None) -> None:
    if madre_id is None:
        return
    if madre_id == categoria_id:
        raise JerarquiaInvalida()
    madre = await db.get(ServiceCategory, madre_id)
    if madre is None:
        raise CategoriaNoEncontrada()
    if madre.parent_id is not None:
        raise JerarquiaInvalida()
    if categoria_id is not None and await db.scalar(
        select(ServiceCategory.id).where(ServiceCategory.parent_id == categoria_id).limit(1)
    ):
        raise JerarquiaInvalida()


async def crear(db: AsyncSession, *, actor_id: str, datos: dict) -> ServiceCategory:
    await _exigir_jerarquia(db, None, datos.get("parent_id"))
    ahora = _ahora()
    categoria = ServiceCategory(
        **{k: datos.get(k) for k in EDITABLES if k in datos},
        slug=datos["slug"],
        status=CATEGORIA_ACTIVA,
        created_by=actor_id,
        updated_by=actor_id,
        created_at=ahora,
        updated_at=ahora,
    )
    try:
        async with db.begin_nested():
            db.add(categoria)
            await db.flush()
    except IntegrityError:
        # Solo es «slug repetido» si de verdad lo está; otro choque no se disfraza.
        if await db.scalar(select(ServiceCategory.id).where(ServiceCategory.slug == categoria.slug)):
            raise SlugRepetido() from None
        raise
    await admision.auditar(
        db, accion="service_category.created", entidad=ENTIDAD, entidad_id=categoria.id,
        actor_id=actor_id, funcion=ADMINISTRACION, datos={"slug": categoria.slug},
    )
    return categoria


async def editar(db: AsyncSession, *, actor_id: str, categoria_id: str, cambios: dict) -> ServiceCategory:
    categoria = await db.get(ServiceCategory, categoria_id)
    if categoria is None:
        raise CategoriaNoEncontrada()
    if "parent_id" in cambios:
        await _exigir_jerarquia(db, categoria.id, cambios["parent_id"])
    for campo in EDITABLES:
        if campo in cambios:
            setattr(categoria, campo, cambios[campo])
    categoria.updated_by = actor_id
    categoria.updated_at = _ahora()
    await db.flush()
    await admision.auditar(
        db, accion="service_category.updated", entidad=ENTIDAD, entidad_id=categoria.id,
        actor_id=actor_id, funcion=ADMINISTRACION, datos={"fields": sorted(cambios)},
    )
    return categoria


async def cambiar_estado(
    db: AsyncSession, *, actor_id: str, categoria_id: str, activa: bool
) -> ServiceCategory:
    """Activar o desactivar. Repetirlo no hace nada."""
    categoria = await db.scalar(
        select(ServiceCategory).where(ServiceCategory.id == categoria_id).with_for_update()
    )
    if categoria is None:
        raise CategoriaNoEncontrada()
    destino = CATEGORIA_ACTIVA if activa else CATEGORIA_INACTIVA
    if categoria.status == destino:
        return categoria
    anterior = categoria.status
    categoria.status = destino
    categoria.updated_by = actor_id
    categoria.updated_at = _ahora()
    await db.flush()
    await admision.auditar(
        db,
        accion=f"service_category.{'activated' if activa else 'deactivated'}",
        entidad=ENTIDAD, entidad_id=categoria.id, actor_id=actor_id, funcion=ADMINISTRACION,
        datos={"from": anterior, "to": destino},
    )
    return categoria


__all__ = ["EDITABLES", "JerarquiaInvalida", "SlugRepetido", "cambiar_estado", "crear", "editar", "todas"]
