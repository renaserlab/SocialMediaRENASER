"""El código público de un certificado, su dirección y su revocación.

EL CÓDIGO NO SE PUEDE ADIVINAR, y esa es la única defensa de una página que
cualquiera puede abrir. Un identificador como «ZC-2025-034892» —año más
contador— se recorre entero en una tarde: con eso, quien quiera puede listar el
nombre y el curso de todo el que se haya certificado.

POR ESO NO ES CORRELATIVO Y NO LLEVA FECHA. Son bytes de `secrets`, que es el
generador criptográfico de la biblioteca estándar, y no `random`, que es
predecible a partir de unas cuantas salidas.

EL PREFIJO `ZC-` NO ES SEGURIDAD, es que un código se copia y se pega en sitios
donde conviene que se reconozca de dónde viene.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.modules.learning.models import CourseCertificate

#: Bytes de aleatoriedad del código. Dieciséis son 128 bits: no se recorre.
_BYTES = 16

_PREFIJO = "ZC-"


def nuevo_codigo_publico() -> str:
    """Un código nuevo, imposible de adivinar y de longitud fija."""
    return f"{_PREFIJO}{secrets.token_hex(_BYTES)}"


def direccion_de_verificacion(public_id: str) -> str:
    """Dónde se comprueba ese certificado.

    La compone el SERVIDOR: el teléfono no sabe en qué dominio vive la API, y
    dejar que la arme cada cliente terminaría con certificados apuntando a
    direcciones distintas según por dónde se emitieran.
    """
    base = (get_settings().certificates_verify_url or "").rstrip("/")
    return f"{base}/{public_id}" if base else f"/verificar/{public_id}"


def nombre_para_el_certificado(perfil) -> str:  # noqa: ANN001
    """El nombre que se imprime, copiado en el momento de emitir.

    Si no hay nombre se usa el usuario, y si tampoco lo hay se deja vacío: un
    certificado a nombre de «Usuario» o de un identificador no certifica a
    nadie, y es mejor que la pantalla lo enseñe sin nombre a que afirme uno
    falso.
    """
    if perfil is None:
        return ""
    nombre = (getattr(perfil, "full_name", "") or "").strip()
    if nombre:
        return nombre
    usuario = (getattr(perfil, "username", "") or "").strip()
    return f"@{usuario}" if usuario else ""


async def revocar(
    db: AsyncSession,
    certificado: CourseCertificate,
    *,
    motivo: str,
    actor_id: str | None,
) -> None:
    """Marcarlo como no vigente. NO se borra: desaparecer sin decir nada es
    peor que decir que fue revocado, y deja a quien lo compartió sin
    explicación."""
    from app.modules.gobernanza import auditoria

    certificado.status = "revoked"
    certificado.revoked_at = datetime.now(timezone.utc)
    certificado.revoked_reason = motivo or None
    await auditoria.anotar(
        db,
        actor_id=actor_id,
        action="course_certificate.revoked",
        entity_type="course_certificate",
        entity_id=certificado.id,
        new_state="revoked",
        payload={"course_id": certificado.course_id, "reason": motivo or ""},
    )
