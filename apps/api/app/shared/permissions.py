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

#: Roles con permisos de gestion.
ADMIN_ROLES = {"admin", "moderator"}


async def get_role(db: AsyncSession, user_id: str) -> str:
    return await db.scalar(select(Profile.role).where(Profile.id == user_id)) or "user"


async def is_admin(db: AsyncSession, user_id: str) -> bool:
    return await get_role(db, user_id) in ADMIN_ROLES


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
