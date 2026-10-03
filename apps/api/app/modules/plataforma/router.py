"""Lo que la app necesita saber de la configuración del servidor.

Solo reglas de PRODUCTO que cambian lo que se pinta (por ejemplo, si un botón
dice «Publicar» o «Enviar a revisión»). Nunca claves, ni proveedores, ni nada
de la cuenta: esto es público y lo lee cualquiera, con sesión o sin ella. Con
sesión, lo de Servicios se contesta para esa persona (el piloto).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.security import AuthUser, get_optional_user
from app.modules.services import acceso as servicios
from app.shared.database import get_db

router = APIRouter(prefix="/platform", tags=["platform"])


class PlatformConfig(BaseModel):
    #: Ver `Settings.publicacion_flexible`: si enviar publica al momento.
    publicacion_flexible: bool
    #: Si la app enseña las entradas de Z Servicios A QUIEN PREGUNTA. No es
    #: solo `Settings.feature_services`: durante el piloto vale `true`
    #: únicamente para los perfiles autorizados (`services/acceso.py`), y sin
    #: sesión vale `false`. Es un sí o un no de esa persona: la lista del
    #: piloto no sale del servidor. AÑADIDO, no sustituido: una app vieja lo
    #: ignora, y una app nueva frente a un servidor viejo no lo recibe y lo
    #: toma como apagado.
    feature_services: bool = False
    #: Si la app enseña a quien pregunta la sección de Servicios del panel de
    #: administración. Va APARTE de `feature_services` porque administración
    #: entra por su rol y no por la lista del piloto: quien revisa no tiene por
    #: qué ser participante, y un participante no administra nada.
    feature_services_admin: bool = False


@router.get("/config", response_model=PlatformConfig)
async def configuracion(
    usuario: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> PlatformConfig:
    ajustes = get_settings()
    perfil = usuario.id if usuario is not None else None
    return PlatformConfig(
        publicacion_flexible=ajustes.publicacion_flexible,
        feature_services=servicios.abierto_para(perfil),
        feature_services_admin=await servicios.administra(db, perfil),
    )
