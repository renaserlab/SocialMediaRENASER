"""Quién puede qué en la admisión de Servicios. LO DECIDE EL SERVIDOR.

QUÉ ROLES SE USAN Y POR QUÉ NO SE INVENTAN OTROS. El alcance habla de
Operaciones, Cumplimiento y Administración, y el blueprint de «Evaluador Z»,
pero `profiles.role` solo tiene `admin`, `moderator` y `user`. Crear roles
nuevos exigiría tocar una tabla que usa media plataforma y decidir por la
empresa quién es cada cosa. Se reutiliza la separación que ya existe:

    revisar (tomar, pedir correcciones)  ->  `admin` o `moderator`  = REVISOR
    decidir (aprobar, rechazar, suspender) -> solo `admin`           = ADMINISTRACION

Y EN EL HISTORIAL QUEDA CON QUÉ FUNCIÓN ACTUÓ cada persona (`actor_role`), que
es lo que el alcance exige cuando una misma persona ejerce más de un papel.

NINGÚN PERMISO FINANCIERO POR HERENCIA. Revisar documentos no concede mover
dinero: este fichero no menciona `puede_mover_dinero` ni `FINANCE_ROLES`, y
decidir una admisión usa su propio conjunto aunque hoy contenga el mismo rol.

DOS REGLAS QUE NO SON DE ROL Y PESAN MÁS:

  1. NADIE REVISA NI DECIDE SU PROPIA ADMISIÓN, ni siendo administrador. Se
     comprueba ANTES que el rol, y además lo impone la base (0086).
  2. LO AJENO ES UN 404, NUNCA UN 403. Decir «existe pero no es tuyo» ya
     cuenta que existe.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenError, NotFoundError
from app.modules.services import states
from app.shared.permissions import ADMIN_ROLES, get_role

#: Quién revisa: curaduría. Es `ADMIN_ROLES` de la plataforma.
ROLES_QUE_REVISAN = frozenset(ADMIN_ROLES)

#: Quién decide una admisión. Hoy solo `admin`; es un conjunto propio para que
#: el día que la empresa separe funciones no arrastre ningún permiso de dinero.
ROLES_QUE_DECIDEN = frozenset({"admin"})


class SolicitudNoEncontrada(NotFoundError):
    """404 para lo que no existe Y para lo ajeno. Ver la cabecera."""

    code = "service_application_not_found"
    message = "No encontramos esa postulación."


class SinPermisoDeRevision(ForbiddenError):
    code = "service_review_forbidden"
    message = "Solo el equipo de Z revisa postulaciones de Servicios."


class SinPermisoDeDecision(ForbiddenError):
    code = "service_decision_forbidden"
    message = "Solo administración aprueba, rechaza o suspende a un prestador."


class EsTuPropiaAdmision(ForbiddenError):
    code = "service_self_review_forbidden"
    message = "Nadie revisa ni decide su propia admisión."


async def funcion_de(db: AsyncSession, user_id: str) -> str | None:
    """Con qué función puede actuar esta persona sobre las admisiones.

    `admin` antes que `reviewer`: quien puede decidir también puede revisar, y
    el historial tiene que decir la función más alta con la que actuó.
    """
    rol = await get_role(db, user_id)
    if rol in ROLES_QUE_DECIDEN:
        return states.ADMINISTRACION
    if rol in ROLES_QUE_REVISAN:
        return states.REVISOR
    return None


async def exigir_revisor(db: AsyncSession, user_id: str) -> str:
    """Curaduría o administración. Devuelve la función con la que actúa."""
    funcion = await funcion_de(db, user_id)
    if funcion is None:
        raise SinPermisoDeRevision()
    return funcion


async def exigir_decisor(db: AsyncSession, user_id: str) -> str:
    """Solo administración: aprobar, rechazar y suspender."""
    funcion = await funcion_de(db, user_id)
    if funcion != states.ADMINISTRACION:
        raise SinPermisoDeDecision()
    return funcion


def exigir_ajena(*, dueno_del_expediente: str, user_id: str) -> None:
    """Que NO sea la propia. Se llama ANTES que el rol en las rutas que deciden.

    Un administrador que también postula no puede tocar su propio expediente, y
    el error dice exactamente eso en vez de un 403 genérico.
    """
    if dueno_del_expediente == user_id:
        raise EsTuPropiaAdmision()


__all__ = [
    "EsTuPropiaAdmision",
    "ROLES_QUE_DECIDEN",
    "ROLES_QUE_REVISAN",
    "SinPermisoDeDecision",
    "SinPermisoDeRevision",
    "SolicitudNoEncontrada",
    "exigir_ajena",
    "exigir_decisor",
    "exigir_revisor",
    "funcion_de",
]
