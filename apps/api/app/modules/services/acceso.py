"""Quién entra a Z Servicios: el piloto (política P101).

`FEATURE_SERVICES` dice si Servicios existe en este servidor. ESTO dice PARA
QUIÉN. Son tres casos, y el de fábrica es el más cerrado:

  1. `FEATURE_SERVICES` APAGADA: nadie. Lo mismo de siempre (`esquema.py`).
  2. ENCENDIDA, y `SERVICES_PUBLIC_ACCESS` apagada (lo de fábrica): EL PILOTO.
     Solo entran los perfiles de `SERVICES_PILOT_PROFILE_IDS`. La lista VACÍA
     no deja entrar a nadie —desplegar con la bandera encendida no abre nada
     por descuido—, y una lista MAL ESCRITA tampoco: ante la duda, cerrado.
  3. ENCENDIDA y `SERVICES_PUBLIC_ACCESS` encendida: todo el mundo. La
     apertura general es una decisión que se escribe; no se deduce de nada.

A QUIEN NO ENTRA SE LE CONTESTA LO MISMO QUE CON SERVICIOS APAGADO (503
`services_disabled`). Para esa persona es verdad —Servicios no está
disponible para ella—, la app ya sabe pintarlo y nadie averigua desde fuera
que hay un piloto en marcha ni quién participa.

TAMBIÉN EL CATÁLOGO PÚBLICO. Durante el piloto, la búsqueda, la ficha, los
horarios y el perfil de un prestador son de los participantes con sesión: una
visita sin sesión recibe el mismo 503. Lo que se publica en un piloto no es
todavía para todo Internet.

LAS RUTAS DE ADMINISTRACIÓN NO PASAN POR AQUÍ. Quien revisa una postulación o
resuelve un caso entra por su rol (`permissions.py`), esté o no en la lista; y
estar en la lista no da ningún rol. El piloto no eleva privilegios.

UNA SOLA COMPROBACIÓN. `exigir_participante` cuelga de los seis routers de
`/services` en `main.py`, y `/platform/config` usa `abierto_para` para decirle
a la app si enseña las entradas. Ninguna ruta repite la condición.
"""

from __future__ import annotations

import logging
import uuid
from functools import lru_cache

from fastapi import Depends

from app.core.config import get_settings
from app.core.security import AuthUser, get_optional_user
from app.modules.services import esquema

logger = logging.getLogger("renaser.services")


@lru_cache(maxsize=8)
def _participantes(cruda: str) -> frozenset[str] | None:
    """Los perfiles del piloto, normalizados; `None` si la lista no se entiende.

    TODO O NADA: una sola entrada que no sea un UUID invalida la lista entera.
    Aceptar «las que sí se entienden» abriría el piloto a medias sin que nadie
    lo hubiera decidido. Se registra CUÁNTAS fallan, nunca cuáles: el valor de
    una variable de entorno no va al registro.

    Guardado por su texto: el aviso sale una vez por valor, no en cada
    petición.
    """
    perfiles: set[str] = set()
    malas = 0
    for trozo in cruda.split(","):
        limpio = trozo.strip()
        if not limpio:
            continue
        try:
            perfiles.add(str(uuid.UUID(limpio)))
        except ValueError:
            malas += 1
    if malas:
        logger.error(
            "Servicios: SERVICES_PILOT_PROFILE_IDS tiene %d entrada(s) que no son un UUID. "
            "El piloto queda cerrado para todos hasta corregirla.",
            malas,
        )
        return None
    return frozenset(perfiles)


def abierto_para(perfil_id: str | None) -> bool:
    """¿Puede esta persona usar Servicios ahora? Sin tocar la base."""
    ajustes = get_settings()
    if not ajustes.feature_services:
        return False
    if ajustes.services_public_access:
        return True
    if not perfil_id:
        return False
    participantes = _participantes(ajustes.services_pilot_profile_ids or "")
    if not participantes:
        return False
    try:
        return str(uuid.UUID(str(perfil_id))) in participantes
    except ValueError:
        return False


async def exigir_participante(usuario: AuthUser | None = Depends(get_optional_user)) -> None:
    """La puerta de quién, antes que cualquier otra y sin consultar la base."""
    if not abierto_para(usuario.id if usuario is not None else None):
        raise esquema.ServiciosApagados()


__all__ = ["abierto_para", "exigir_participante"]
