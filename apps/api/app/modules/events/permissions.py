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
    """Para lo que no habla de UN evento concreto: la cola de revisión."""
    if not await es_curador(db, usuario.id):
        raise ForbiddenError("Solo la curaduría puede evaluar un evento.")


async def exigir_curaduria_ajena(db: AsyncSession, evento, usuario: AuthUser) -> None:
    """Revisar un evento de OTRA persona.

    PUNTUARSE A SÍ MISMO ERA LA PUERTA DE AL LADO de aprobarse. Aprobar lo
    propio ya estaba cerrado, pero el puntaje es exactamente lo que habilita la
    aprobación de otra persona: una cuenta de curaduría que organiza podía
    ponerse 100/100 y esperar a que alguien pulsara aprobar. Quien fabrica la
    condición acababa siendo el propio organizador.

    Vale igual para leer el expediente: los ocho puntajes son la deliberación, y
    su evento lo ve por la puerta del organizador, donde no salen.
    """
    if es_organizador(evento, usuario):
        raise ForbiddenError(
            "Nadie revisa ni puntúa su propio evento: lo mira otra persona."
        )
    await exigir_curaduria(db, usuario)


async def exigir_rol_de_admision(db: AsyncSession, usuario: AuthUser) -> None:
    """Solo el rol, SIN mirar de quién es el evento.

    Se comprueba ANTES de buscar el evento: al revés, un id inexistente daba 404
    y uno real daba 403, y sondear identificadores decía cuáles corresponden a
    eventos de verdad que todavía no se han publicado.
    """
    if not await es_admision(db, usuario.id):
        raise ForbiddenError("Solo la administración puede decidir sobre un evento.")


async def exigir_admision(db: AsyncSession, evento, usuario: AuthUser) -> None:
    """Decide sobre un evento AJENO.

    Las dos comprobaciones, y el ORDEN importa por dos motivos distintos:

      - El rol primero, porque el evento hay que buscarlo y un 404 en vez de un
        403 dice si ese identificador existe.
      - La propiedad después, porque un administrador que organiza no puede
        aprobarse el suyo.
    """
    await exigir_rol_de_admision(db, usuario)
    if es_organizador(evento, usuario):
        raise ForbiddenError(
            "Nadie aprueba ni publica su propio evento: lo revisa otra persona."
        )


async def puede_ver_expediente(db: AsyncSession, evento, usuario: AuthUser) -> bool:
    """Quién ve la ficha interna: su organizador y quien revisa.

    El organizador ve el estado y las observaciones que le dirigen, pero NO la
    evaluación interna con sus ocho puntajes: esa es la deliberación, y
    enseñarla convierte la curaduría en una negociación.
    """
    return es_organizador(evento, usuario) or await es_curador(db, usuario.id)
