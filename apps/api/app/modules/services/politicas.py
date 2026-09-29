"""Las políticas versionadas de Servicios: las condiciones del prestador.

EL CICLO, ENTERO: administración crea o recupera un borrador, lo edita, lo
previsualiza y lo publica. Publicar SUPERA a la versión publicada anterior en
la misma transacción; la base garantiza que solo haya una publicada por país y
categoría (`service_policies_una_publicada`) y que una publicada no se edite
ni se borre (0086). Nada de esto se siembra: NO HAY POLÍTICA PREDETERMINADA.

SIN POLÍTICA PUBLICADA NO SE PUEDE ENVIAR UNA POSTULACIÓN
(`provider_terms_not_published`). Aceptar las condiciones es un requisito del
alcance, y aceptar un texto que la empresa no ha escrito sería aceptar nada.

LOS PARÁMETROS SON LAS DECISIONES CONFIGURABLES de la empresa, y se validan al
guardar. Hoy tres, todos opcionales; si faltan, NO se interpretan como sí ni
como no:

    required_documents       {"individual": [...], "company": [...]}
    required_credentials     [...]
    reapplication_after_rejection   "allowed" | "not_allowed"

PUBLICAR RIGE DESDE YA. Programar una vigencia futura no entra en el
Incremento 1: con una sola publicada a la vez, una futura dejaría un hueco sin
condiciones vigentes hasta su fecha.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone

from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError, ValidationAppError
from app.modules.services.models import (
    POLITICA_BORRADOR,
    POLITICA_PUBLICADA,
    POLITICA_SUPERADA,
    POLITICA_TERMINOS_DEL_PRESTADOR,
    TIPOS_DE_CREDENCIAL,
    TIPOS_DE_DOCUMENTO,
    TIPOS_DE_PRESTADOR,
    ServicePolicy,
)

#: Qué se hace con quien fue rechazado y quiere volver a postular.
REPOSTULAR_PERMITIDO = "allowed"
REPOSTULAR_NO_PERMITIDO = "not_allowed"


class TerminosNoPublicados(ConflictError):
    code = "provider_terms_not_published"
    message = "Todavía no hay condiciones del prestador publicadas."


class TerminosCambiaron(ConflictError):
    code = "provider_terms_changed"
    message = "Las condiciones cambiaron. Léelas y acéptalas de nuevo."


class PoliticaNoEncontrada(NotFoundError):
    code = "service_policy_not_found"
    message = "No encontramos esa política."


class PoliticaNoEditable(ConflictError):
    code = "service_policy_not_editable"
    message = "Una política publicada no se edita: crea una versión nueva."


class ParametrosInvalidos(ValidationAppError):
    code = "service_policy_parameters_invalid"
    message = "Los parámetros de la política no son válidos."


def huella(texto: str) -> str:
    """El SHA-256 del texto EXACTO que se enseña. Sin normalizar: un espacio
    distinto es otro texto, y la huella tiene que decirlo."""
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


def validar_parametros(parametros: dict | None) -> dict:
    """Solo lo conocido, con valores que existen. Nada se completa por defecto."""
    parametros = dict(parametros or {})
    desconocidos = set(parametros) - {
        "required_documents",
        "required_credentials",
        "reapplication_after_rejection",
    }
    if desconocidos:
        raise ParametrosInvalidos(details={"unknown": sorted(desconocidos)})

    documentos = parametros.get("required_documents")
    if documentos is not None:
        if not isinstance(documentos, dict) or set(documentos) - set(TIPOS_DE_PRESTADOR):
            raise ParametrosInvalidos(details={"field": "required_documents"})
        for lista in documentos.values():
            if not isinstance(lista, list) or any(k not in TIPOS_DE_DOCUMENTO for k in lista):
                raise ParametrosInvalidos(details={"field": "required_documents"})

    credenciales = parametros.get("required_credentials")
    if credenciales is not None and (
        not isinstance(credenciales, list)
        or any(k not in TIPOS_DE_CREDENCIAL for k in credenciales)
    ):
        raise ParametrosInvalidos(details={"field": "required_credentials"})

    repostular = parametros.get("reapplication_after_rejection")
    if repostular is not None and repostular not in (REPOSTULAR_PERMITIDO, REPOSTULAR_NO_PERMITIDO):
        raise ParametrosInvalidos(details={"field": "reapplication_after_rejection"})
    return parametros


# --------------------------------------------------------------------------- #
# Lectura
# --------------------------------------------------------------------------- #
async def vigente(
    db: AsyncSession,
    *,
    tipo: str = POLITICA_TERMINOS_DEL_PRESTADOR,
    pais: str,
    categoria: str | None = None,
    ahora: datetime | None = None,
) -> ServicePolicy | None:
    """La política publicada y en vigor, o `None`.

    LA DE LA CATEGORÍA GANA A LA GENERAL: si existe una para esa categoría, es
    la que rige; si no, la que vale para todas. Una publicada con fecha futura
    todavía no rige.
    """
    momento = ahora or _ahora()
    filtros = [
        ServicePolicy.kind == tipo,
        ServicePolicy.country_code == pais,
        ServicePolicy.status == POLITICA_PUBLICADA,
        ServicePolicy.effective_at <= momento,
    ]
    if categoria:
        filtros.append(
            or_(ServicePolicy.category == categoria, ServicePolicy.category.is_(None))
        )
    else:
        filtros.append(ServicePolicy.category.is_(None))

    candidatas = list(await db.scalars(select(ServicePolicy).where(*filtros)))
    if not candidatas:
        return None
    # La específica primero; entre iguales, la versión más alta.
    candidatas.sort(key=lambda p: (p.category is not None, p.version), reverse=True)
    return candidatas[0]


async def por_id(db: AsyncSession, politica_id: str) -> ServicePolicy:
    from uuid import UUID

    try:
        UUID(politica_id)
    except ValueError:
        raise PoliticaNoEncontrada() from None
    politica = await db.get(ServicePolicy, politica_id)
    if politica is None:
        raise PoliticaNoEncontrada()
    return politica


async def versiones(
    db: AsyncSession, *, pais: str | None = None, tipo: str = POLITICA_TERMINOS_DEL_PRESTADOR
) -> list[ServicePolicy]:
    consulta = select(ServicePolicy).where(ServicePolicy.kind == tipo)
    if pais:
        consulta = consulta.where(ServicePolicy.country_code == pais)
    return list(
        await db.scalars(
            consulta.order_by(
                ServicePolicy.country_code,
                ServicePolicy.category.nulls_first(),
                ServicePolicy.version.desc(),
            )
        )
    )


# --------------------------------------------------------------------------- #
# Escritura (administración)
# --------------------------------------------------------------------------- #
async def borrador(
    db: AsyncSession,
    *,
    pais: str,
    categoria: str | None,
    titulo: str,
    texto: str,
    parametros: dict | None,
    autor_id: str,
) -> tuple[ServicePolicy, bool]:
    """El borrador de ese país y categoría, o uno nuevo. IDEMPOTENTE.

    Si ya hay un borrador, se devuelve ESE y no se toca: editarlo es otra
    acción. La versión nueva es la siguiente a la más alta que exista.
    """
    existente = await db.scalar(
        select(ServicePolicy).where(
            ServicePolicy.kind == POLITICA_TERMINOS_DEL_PRESTADOR,
            ServicePolicy.country_code == pais,
            ServicePolicy.category.is_(None) if categoria is None else ServicePolicy.category == categoria,
            ServicePolicy.status == POLITICA_BORRADOR,
        )
    )
    if existente is not None:
        return existente, False
    ultima = await db.scalar(
        select(func.max(ServicePolicy.version)).where(
            ServicePolicy.kind == POLITICA_TERMINOS_DEL_PRESTADOR,
            ServicePolicy.country_code == pais,
            ServicePolicy.category.is_(None) if categoria is None else ServicePolicy.category == categoria,
        )
    )
    ahora = _ahora()
    politica = ServicePolicy(
        kind=POLITICA_TERMINOS_DEL_PRESTADOR,
        country_code=pais,
        category=categoria,
        version=(ultima or 0) + 1,
        status=POLITICA_BORRADOR,
        title=titulo,
        body=texto,
        body_sha256=huella(texto),
        parameters=validar_parametros(parametros),
        created_by=autor_id,
        created_at=ahora,
        updated_at=ahora,
    )
    db.add(politica)
    await db.flush()
    return politica, True


async def editar_borrador(
    db: AsyncSession, *, politica: ServicePolicy, cambios: dict[str, object]
) -> ServicePolicy:
    if politica.status != POLITICA_BORRADOR:
        raise PoliticaNoEditable(details={"status": politica.status})
    if "title" in cambios:
        politica.title = str(cambios["title"])
    if "body" in cambios:
        politica.body = str(cambios["body"])
        politica.body_sha256 = huella(politica.body)
    if "parameters" in cambios:
        politica.parameters = validar_parametros(cambios["parameters"])  # type: ignore[arg-type]
    politica.updated_at = _ahora()
    await db.flush()
    return politica


async def publicar(db: AsyncSession, *, politica: ServicePolicy, autor_id: str) -> ServicePolicy:
    """Publica el borrador y supera a la anterior, EN LA MISMA TRANSACCIÓN.

    Publicar lo ya publicado devuelve lo mismo: un doble toque no crea nada.
    """
    if politica.status == POLITICA_PUBLICADA:
        return politica
    if politica.status != POLITICA_BORRADOR:
        raise PoliticaNoEditable(details={"status": politica.status})
    ahora = _ahora()
    await db.execute(
        update(ServicePolicy)
        .where(
            ServicePolicy.kind == politica.kind,
            ServicePolicy.country_code == politica.country_code,
            ServicePolicy.category.is_(None)
            if politica.category is None
            else ServicePolicy.category == politica.category,
            ServicePolicy.status == POLITICA_PUBLICADA,
            ServicePolicy.id != politica.id,
        )
        .values(status=POLITICA_SUPERADA, updated_at=ahora)
        .execution_options(synchronize_session="fetch")
    )
    # La huella se vuelve a calcular: lo que se publica es exactamente esto.
    politica.body_sha256 = huella(politica.body)
    politica.status = POLITICA_PUBLICADA
    politica.published_at = ahora
    politica.effective_at = ahora
    politica.published_by = autor_id
    politica.updated_at = ahora
    await db.flush()
    return politica


__all__ = [
    "ParametrosInvalidos",
    "PoliticaNoEditable",
    "PoliticaNoEncontrada",
    "REPOSTULAR_NO_PERMITIDO",
    "REPOSTULAR_PERMITIDO",
    "TerminosCambiaron",
    "TerminosNoPublicados",
    "borrador",
    "editar_borrador",
    "huella",
    "por_id",
    "publicar",
    "validar_parametros",
    "versiones",
    "vigente",
]
