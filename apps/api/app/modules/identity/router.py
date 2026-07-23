"""Endpoints de identidad.

La creacion de cuentas, login y recuperacion los maneja Supabase Auth
directamente desde la app. Aqui el backend expone la identidad ya validada
del token, util para que la app confirme su sesion contra el API, y permite
que una persona borre su propia cuenta.
"""

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlalchemy import delete, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import AuthUser, get_current_user
from app.modules.profiles.models import Profile
from app.shared.database import get_db

router = APIRouter(prefix="/auth", tags=["identity"])


class SessionInfo(BaseModel):
    id: str
    email: str | None = None
    role: str | None = None


@router.get("/me", response_model=SessionInfo)
async def me(current_user: AuthUser = Depends(get_current_user)) -> SessionInfo:
    return SessionInfo(
        id=current_user.id,
        email=current_user.email,
        role=current_user.role,
    )


@router.delete("/me", status_code=status.HTTP_204_NO_CONTENT)
async def delete_my_account(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Borra de forma permanente la cuenta de quien hace la peticion.

    Se hace en dos pasos, dentro de una sola transaccion para que sea todo o
    nada:

    1. Borrar la fila de `profiles`. De ella cuelgan en cascada TODOS sus datos
       (publicaciones, comentarios, audios, cursos, eventos, seguidores,
       mensajes, ...), asi que esta linea se lleva por delante el contenido.
    2. Borrar la fila de `auth.users`. `profiles` no tiene clave foranea hacia
       `auth.users`, de modo que el paso 1 no la arrastra; hay que quitarla
       aparte o la persona podria volver a entrar con una cuenta sin perfil.

    El orden da igual (no hay dependencia entre ambas), pero conviene el mismo
    commit: si fallara a mitad, quedaria un perfil sin usuario o al reves.

    La identidad sale del token ya validado, nunca de un id recibido: solo se
    puede borrar la cuenta propia.

    Nota: los archivos subidos a Storage (avatares, media) no cuelgan de la base
    de datos y quedan huerfanos; su limpieza es un proceso aparte.
    """
    await db.execute(delete(Profile).where(Profile.id == current_user.id))
    # Cross-schema y sin modelo ORM: se hace con SQL parametrizado. El backend
    # conecta como `postgres`, que si tiene permiso para tocar el esquema auth.
    await db.execute(
        text("DELETE FROM auth.users WHERE id = :uid"),
        {"uid": current_user.id},
    )
    await db.commit()
