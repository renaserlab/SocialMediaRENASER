"""Lo que la app necesita saber de la configuración del servidor.

Solo reglas de PRODUCTO que cambian lo que se pinta (por ejemplo, si un botón
dice «Publicar» o «Enviar a revisión»). Nunca claves, ni proveedores, ni nada
de la cuenta: esto es público y lo lee cualquiera, con sesión o sin ella.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from app.core.config import get_settings

router = APIRouter(prefix="/platform", tags=["platform"])


class PlatformConfig(BaseModel):
    #: Ver `Settings.publicacion_flexible`: si enviar publica al momento.
    publicacion_flexible: bool


@router.get("/config", response_model=PlatformConfig)
async def configuracion() -> PlatformConfig:
    return PlatformConfig(publicacion_flexible=get_settings().publicacion_flexible)
