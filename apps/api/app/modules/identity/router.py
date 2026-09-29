"""Endpoints de identidad.

La creacion de cuentas, login y recuperacion los maneja Supabase Auth
directamente desde la app. Aqui el backend expone la identidad ya validada
del token, util para que la app confirme su sesion contra el API, y permite
que una persona borre su propia cuenta.
"""

from fastapi import APIRouter, BackgroundTasks, Depends, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import AuthUser, get_current_user
from app.modules.identity import baja
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
    segundo_plano: BackgroundTasks,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Borra de forma permanente la cuenta de quien hace la peticion.

    Todo o nada, y los archivos antes de confirmar: ver `baja.py`.

    - 204: borrada (tambien si ya lo estaba: repetir es seguro).
    - 409 `account_deletion_blocked`: tiene ventas, saldos, pedidos o
      reclamos que la plataforma conserva; no se ha tocado nada.
    - 503 `account_deletion_storage_failed`: sus archivos no se pudieron
      borrar; la cuenta sigue activa y se puede reintentar.
    - 503 `account_deletion_unavailable`: la base no tiene la 0089 completa
      (o no se pudo comprobar); no se ha tocado nada y la cuenta sigue activa.

    La identidad sale del token ya validado, nunca de un id recibido: solo se
    puede borrar la cuenta propia.
    """
    enteras = await baja.borrar_cuenta(db, current_user.id)
    # Lo ajeno de las conversaciones que se fueron enteras, tras contestar.
    segundo_plano.add_task(baja.retirar_conversaciones, current_user.id, enteras)
