"""Quién puede qué en Eventos. Por capacidad, no por pantalla.

TRES CAPACIDADES, Y NO UN `is_admin` PARA TODAS. Es la misma lección que separó
moderar contenido de mover dinero: `ADMIN_ROLES` incluye `moderator`, que existe
para revisar contenido, y con esa comprobación un moderador podía APROBAR y
PUBLICAR un evento. Aprobar es autorizar que se venda algo, y no es lo mismo que
revisar si está bien escrito.

    organizador   -> lo suyo: crear, editar el borrador, enviar a revisión
    curaduría     -> evaluar contenido y calidad, pedir correcciones
    administración-> aprobar, rechazar, publicar, suspender

Curaduría PUNTÚA; administración DECIDE. Un curador que puntúa 92 no ha
aprobado nada: la decisión es una acción aparte, de otra capacidad, y con
motivo obligatorio.

LO QUE NINGUNA DE LAS TRES PUEDE: publicarse a sí misma un evento. El
organizador no aparece en `puede_admitir` ni aunque sea administrador de la
aplicación —se comprueba antes—, porque «aprobarse» es exactamente lo que el
blueprint prohíbe en su primera decisión cerrada.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenError, NotFoundError
from app.core.security import AuthUser
from app.shared.permissions import get_role

#: Evalúan calidad y contenido, y pueden devolver un evento a borrador.
ROLES_CURADURIA = {"admin", "moderator"}

#: Deciden: aprobar, rechazar, publicar, suspender. Estrecho a propósito.
ROLES_ADMISION = {"admin"}


async def es_curador(db: AsyncSession, usuario_id: str) -> bool:
    return await get_role(db, usuario_id) in ROLES_CURADURIA


async def es_admision(db: AsyncSession, usuario_id: str) -> bool:
    return await get_role(db, usuario_id) in ROLES_ADMISION


def es_organizador(evento, usuario: AuthUser) -> bool:
    return evento.organizer_id == usuario.id


def exigir_organizador(evento, usuario: AuthUser) -> None:
    """El organizador de ESE evento, y nadie más.

    RESPONDE 404, NO 403. Un 403 sobre un evento ajeno confirma que existe y
    que alguien lo está preparando; para quien no es su dueño, un borrador ajeno
    no existe. Es la misma respuesta que da el catálogo para un no publicado.
    """
    if not es_organizador(evento, usuario):
        raise NotFoundError("Evento no encontrado.")


async def exigir_curaduria(db: AsyncSession, usuario: AuthUser) -> None:
    if not await es_curador(db, usuario.id):
        raise ForbiddenError("Solo la curaduría puede evaluar un evento.")


async def exigir_admision(db: AsyncSession, evento, usuario: AuthUser) -> None:
    """Decide sobre un evento AJENO.

    El orden de las dos comprobaciones no es indiferente: primero se descarta
    que sea su propio evento y después se mira el rol. Al revés, un
    administrador que organiza podría aprobarse el suyo.
    """
    if es_organizador(evento, usuario):
        raise ForbiddenError(
            "Nadie aprueba ni publica su propio evento: lo revisa otra persona."
        )
    if not await es_admision(db, usuario.id):
        raise ForbiddenError("Solo la administración puede decidir sobre un evento.")


async def puede_ver_expediente(db: AsyncSession, evento, usuario: AuthUser) -> bool:
    """Quién ve la ficha interna: su organizador y quien revisa.

    El organizador ve el estado y las observaciones que le dirigen, pero NO la
    evaluación interna con sus ocho puntajes: esa es la deliberación, y
    enseñarla convierte la curaduría en una negociación.
    """
    return es_organizador(evento, usuario) or await es_curador(db, usuario.id)
