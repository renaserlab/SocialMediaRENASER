"""Permisos por rol de la aplicacion.

IMPORTANTE: el rol de la app vive en `profiles.role`, NO en el JWT. En el token
de Supabase, `role` vale siempre "authenticated", asi que comprobarlo contra
"admin" no se cumple nunca. Por eso estas funciones consultan la base de datos.

El control se hace SIEMPRE aqui, en el servidor. Que la app movil oculte un
boton es comodidad para el usuario, no seguridad: cualquiera puede llamar al
endpoint directamente.
"""

from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenError
from app.core.security import AuthUser, get_current_user
from app.modules.profiles.models import Profile
from app.shared.database import get_db

#: Roles con permisos de gestion: moderar contenido, ver colas, retirar cosas.
ADMIN_ROLES = {"admin", "moderator"}

#: Roles que pueden MOVER DINERO: aprobar y ejecutar devoluciones, liberar
#: saldos retenidos y transferir a los propietarios.
#:
#: ES UN CONJUNTO APARTE, Y MAS ESTRECHO. `moderator` existe para ocultar una
#: publicacion o resolver un reporte; con `ADMIN_ROLES` esa misma cuenta podia
#: llamar a `POST /admin/refund-requests/{id}/approve` y lanzar un reembolso
#: real contra la pasarela, ademas de leer el motivo privado y el historial de
#: cualquier alumno. Moderar contenido y devolver dinero son dos trabajos
#: distintos y no tienen por que caer en la misma persona.
FINANCE_ROLES = {"admin"}


async def get_role(db: AsyncSession, user_id: str) -> str:
    return await db.scalar(select(Profile.role).where(Profile.id == user_id)) or "user"


async def is_admin(db: AsyncSession, user_id: str) -> bool:
    return await get_role(db, user_id) in ADMIN_ROLES


async def puede_mover_dinero(db: AsyncSession, user_id: str) -> bool:
    """Si esta cuenta puede tocar devoluciones, saldos y transferencias.

    Separada de `is_admin` para que cambiar quien administra el dinero sea
    cambiar un conjunto, y no repasar cada endpoint buscando cual se olvido.
    """
    return await get_role(db, user_id) in FINANCE_ROLES


async def require_admin(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AuthUser:
    """Dependencia para endpoints de gestion. 403 si no es administrador."""
    if not await is_admin(db, current_user.id):
        raise ForbiddenError("Solo un administrador puede realizar esta acción.")
    return current_user


async def require_owner_or_admin(
    db: AsyncSession,
    owner_id: str | None,
    current_user: AuthUser,
    message: str = "No puedes modificar este contenido.",
) -> None:
    """Exige ser quien lo creo, o administrar la aplicacion.

    Cualquiera puede publicar sus propios cursos, resenas y citas, pero solo
    sobre lo suyo: sin esta comprobacion, abrir la creacion a todo el mundo
    dejaria tambien que se editara o borrara lo de los demas.

    La administracion mantiene el paso franco para poder moderar.
    """
    if owner_id == current_user.id:
        return
    if await is_admin(db, current_user.id):
        return
    raise ForbiddenError(message)


async def require_owner_or_strict_admin(
    db: AsyncSession,
    owner_id: str | None,
    current_user: AuthUser,
    message: str = "No puedes modificar este contenido.",
) -> None:
    """Como `require_owner_or_admin`, pero SIN moderacion.

    `is_admin` incluye a `moderator`, que existe para ocultar una publicacion o
    resolver un reporte. Hay operaciones que no son moderar —borrar un curso lo
    hace desaparecer con su contenido— y para esas vale el autor o `admin`.
    """
    if owner_id == current_user.id:
        return
    if await puede_mover_dinero(db, current_user.id):
        return
    raise ForbiddenError(message)
