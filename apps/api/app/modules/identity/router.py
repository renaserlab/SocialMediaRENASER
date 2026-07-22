"""Endpoints de identidad.

La creacion de cuentas, login y recuperacion los maneja Supabase Auth
directamente desde la app. Aqui el backend expone la identidad ya validada
del token, util para que la app confirme su sesion contra el API.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.core.security import AuthUser, get_current_user

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
