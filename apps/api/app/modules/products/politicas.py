"""Las condiciones de venta de un país, versionadas. La 0077.

LA REGLA ES UNA: **SIN POLÍTICA APROBADA PARA LA JURISDICCIÓN, NO SE VENDE.**
No es prudencia nuestra, lo dice el blueprint —«Si withdrawalDays es null, la
venta se bloquea en esa jurisdicción hasta aprobación legal»— y es lo razonable:
una tienda que cobra sin haber publicado su plazo de desistimiento es una tienda
que no puede cumplirlo.

QUÉ CONGELA UN PEDIDO. El identificador, la versión y la HUELLA del texto.
Con el identificador se lee la política entera; con la huella se demuestra que
ese texto es el que era aunque alguien tocara la fila por debajo. Publicar la
versión siguiente no le cambia las reglas a quien ya compró.

NO SE INVENTA NADA. Los plazos, la moneda, la entidad vendedora y el texto los
escribe una persona al publicar. Este módulo no tiene valores por defecto para
ninguno: cuando faltan, la respuesta es «pendiente de configuración» y el pago
no empieza.

LA HUELLA SE CALCULA DEL TEXTO NORMALIZADO. Los saltos de línea de Windows y los
de Unix son el mismo párrafo; sin normalizar, copiar el texto entre dos editores
cambiaría la huella y dejaría a un pedido citando una política que «ya no es la
misma».
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppError, ConflictError, NotFoundError
from app.modules.products import esquema
from app.modules.products.models import (
    POLITICA_BORRADOR,
    POLITICA_PUBLICADA,
    POLITICA_RETIRADA,
    ProductPolicy,
)


class PoliticaAusente(AppError):
    """No hay condiciones de venta publicadas para esa jurisdicción.

    409 Y NO 404: la ruta existe y el país puede ser correcto; lo que falta es
    una decisión de la empresa. Un 404 haría pensar que el país está mal escrito.
    """

    status_code = 409
    code = "product_policy_not_configured"

    def __init__(self, pais: str) -> None:
        super().__init__(
            f"Todavía no hay condiciones de venta publicadas para {pais}.",
            details={"country": pais, "pending": "policy"},
        )


class PoliticaCambio(ConflictError):
    """Quien aceptó no aceptó esto. Entre que se le enseñó el texto y pulsó
    comprar se publicó otra versión, y una aceptación de un texto que ya no rige
    no es una aceptación."""

    code = "product_policy_changed"


class MonedaFueraDeLaPolitica(ConflictError):
    """El carrito está en una moneda que esa jurisdicción no admite."""

    code = "product_policy_currency_mismatch"


def ahora() -> datetime:
    return datetime.now(timezone.utc)


def huella(texto: str) -> str:
    """La huella del texto de una política, normalizada.

    CRLF Y LF SON EL MISMO PÁRRAFO. Sin normalizar, pegar el texto desde otro
    editor cambiaría la huella sin cambiar una sola palabra, y todos los pedidos
    anteriores parecerían citar algo distinto.
    """
    normalizado = texto.replace("\r\n", "\n").replace("\r", "\n").strip()
    return hashlib.sha256(normalizado.encode("utf-8")).hexdigest()


def normalizar_pais(valor: str | None) -> str:
    """El código de país en el formato que guarda la base, o vacío."""
    limpio = (valor or "").strip().upper()
    return limpio if len(limpio) == 2 and limpio.isalpha() else ""


@dataclass(frozen=True)
class Condiciones:
    """Lo que se le enseña a quien compra, antes de pagar."""

    policy_id: str
    country_code: str
    version: int
    seller_entity: str
    currency: str
    terms: str
    terms_sha256: str
    incident_report_hours: int | None
    return_shipment_days: int | None
    withdrawal_days: int | None
    buyer_pays_return_for_remorse: bool | None
    seller_pays_return_for_defect: bool | None
    warranty_rules_url: str | None
    effective_at: datetime | None


def condiciones_de(politica: ProductPolicy) -> Condiciones:
    return Condiciones(
        policy_id=politica.id,
        country_code=politica.country_code,
        version=int(politica.version),
        seller_entity=politica.seller_entity,
        currency=politica.currency,
        terms=politica.terms,
        terms_sha256=politica.terms_sha256,
        incident_report_hours=politica.incident_report_hours,
        return_shipment_days=politica.return_shipment_days,
        withdrawal_days=politica.withdrawal_days,
        buyer_pays_return_for_remorse=politica.buyer_pays_return_for_remorse,
        seller_pays_return_for_defect=politica.seller_pays_return_for_defect,
        warranty_rules_url=politica.warranty_rules_url,
        effective_at=politica.effective_at,
    )


def _comparable(fecha: datetime | None, referencia: datetime) -> datetime:
    """La fecha con zona, para poder compararla.

    SQLite devuelve las marcas SIN zona horaria aunque la columna la declare, y
    comparar una con zona contra otra sin ella revienta con un `TypeError` en
    medio de una compra. Se le pone la del momento de referencia, que es UTC.
    """
    if fecha is None:
        return referencia
    if fecha.tzinfo is None:
        return fecha.replace(tzinfo=referencia.tzinfo or timezone.utc)
    return fecha


# --------------------------------------------------------------------------- #
# Leer
# --------------------------------------------------------------------------- #
async def vigente(
    db: AsyncSession, *, pais: str, momento: datetime | None = None
) -> ProductPolicy | None:
    """La política que rige HOY en ese país, o `None`.

    LA MÁS NUEVA QUE YA ENTRÓ EN VIGOR. Una publicada con fecha futura existe y
    se puede revisar, pero todavía no vende: si se eligiera, alguien compraría
    bajo condiciones que aún no son las suyas.
    """
    codigo = normalizar_pais(pais)
    if not codigo:
        return None
    if not await esquema.hay_politicas(db):
        return None
    momento = momento or ahora()
    candidatas = list(
        await db.scalars(
            select(ProductPolicy)
            .where(
                ProductPolicy.country_code == codigo,
                ProductPolicy.status == POLITICA_PUBLICADA,
            )
            .order_by(ProductPolicy.version.desc())
            .limit(50)
        )
    )
    for politica in candidatas:
        if _comparable(politica.effective_at, momento) <= momento:
            return politica
    return None


async def exigir_vigente(
    db: AsyncSession, *, pais: str, momento: datetime | None = None
) -> ProductPolicy:
    """La vigente, o se para la compra diciendo qué falta."""
    codigo = normalizar_pais(pais)
    if not codigo:
        raise PoliticaAusente(pais or "")
    politica = await vigente(db, pais=codigo, momento=momento)
    if politica is None:
        raise PoliticaAusente(codigo)
    return politica


async def paises_con_politica(db: AsyncSession) -> list[str]:
    """Dónde se puede vender hoy. Vacío significa EN NINGÚN SITIO."""
    if not await esquema.hay_politicas(db):
        return []
    momento = ahora()
    codigos = list(
        await db.scalars(
            select(ProductPolicy.country_code)
            .where(ProductPolicy.status == POLITICA_PUBLICADA)
            .distinct()
        )
    )
    #: SE COMPRUEBA LA VIGENCIA UNA A UNA. Un país con una política publicada
    #: pero con fecha futura no vende todavía, y decir que sí sería prometer un
    #: checkout que se va a negar.
    vigentes: list[str] = []
    for codigo in codigos:
        if await vigente(db, pais=codigo, momento=momento) is not None:
            vigentes.append(codigo)
    return sorted(vigentes)


async def historial(db: AsyncSession, *, pais: str) -> list[ProductPolicy]:
    """Todas las versiones de un país, las más nuevas primero. Administración."""
    codigo = normalizar_pais(pais)
    if not codigo or not await esquema.hay_politicas(db):
        return []
    return list(
        await db.scalars(
            select(ProductPolicy)
            .where(ProductPolicy.country_code == codigo)
            .order_by(ProductPolicy.version.desc())
            .limit(200)
        )
    )


# --------------------------------------------------------------------------- #
# Publicar
# --------------------------------------------------------------------------- #
async def publicar(
    db: AsyncSession,
    *,
    pais: str,
    entidad: str,
    moneda: str,
    texto: str,
    incident_report_hours: int,
    return_shipment_days: int,
    withdrawal_days: int,
    buyer_pays_return_for_remorse: bool,
    seller_pays_return_for_defect: bool,
    warranty_rules_url: str | None,
    effective_at: datetime | None,
    actor_id: str,
) -> ProductPolicy:
    """Publica la versión siguiente de un país. Administración.

    NO HAY VALORES POR DEFECTO. Los cinco plazos y banderas son obligatorios
    aquí porque el CHECK de la base tampoco deja publicar sin ellos: una
    política a medias no puede regir una venta.

    LA VERSIÓN LA PONE EL SERVIDOR. Dejarla al cliente permitiría publicar la 7
    antes que la 6, y un pedido que dice «versión 6» apuntaría a la que se
    escribió después.
    """
    await esquema.exigir_politicas(db)
    codigo = normalizar_pais(pais)
    if not codigo:
        raise NotFoundError("País no válido.", code="product_policy_country_invalid")

    limpio = (texto or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if len(limpio) < 50:
        raise ConflictError(
            "El texto de la política es demasiado corto para ser unas "
            "condiciones de venta.",
            code="product_policy_terms_too_short",
        )

    divisa = (moneda or "").strip().upper()
    if len(divisa) != 3 or not divisa.isalpha():
        raise ConflictError(
            "La moneda de la política no es un código de tres letras.",
            code="product_policy_currency_invalid",
        )

    ultima = await db.scalar(
        select(func.max(ProductPolicy.version)).where(
            ProductPolicy.country_code == codigo
        )
    )
    momento = ahora()
    politica = ProductPolicy(
        country_code=codigo,
        seller_entity=(entidad or "").strip(),
        version=int(ultima or 0) + 1,
        currency=divisa,
        terms=limpio,
        terms_sha256=huella(limpio),
        incident_report_hours=int(incident_report_hours),
        return_shipment_days=int(return_shipment_days),
        withdrawal_days=int(withdrawal_days),
        buyer_pays_return_for_remorse=bool(buyer_pays_return_for_remorse),
        seller_pays_return_for_defect=bool(seller_pays_return_for_defect),
        warranty_rules_url=(warranty_rules_url or "").strip() or None,
        status=POLITICA_PUBLICADA,
        effective_at=effective_at or momento,
        published_at=momento,
        published_by=actor_id,
        created_at=momento,
        updated_at=momento,
    )
    db.add(politica)
    await db.flush()
    return politica


async def retirar(
    db: AsyncSession, *, politica_id: str, actor_id: str
) -> ProductPolicy:
    """Retira una versión. NO TOCA NINGÚN PEDIDO.

    Un pedido guarda el identificador, la versión y la huella: retirar la
    política deja de venderse bajo ella y no cambia una coma de lo que aceptó
    quien ya compró. Por eso la fila NO se borra.
    """
    await esquema.exigir_politicas(db)
    politica = await db.get(ProductPolicy, politica_id)
    if politica is None:
        raise NotFoundError(
            "Política no encontrada.", code="product_policy_not_found"
        )
    if politica.status == POLITICA_RETIRADA:
        return politica
    if politica.status == POLITICA_BORRADOR:
        raise ConflictError(
            "Esa política nunca se publicó.", code="product_policy_not_published"
        )
    politica.status = POLITICA_RETIRADA
    politica.updated_at = ahora()
    await db.flush()
    _ = actor_id
    return politica


__all__ = [
    "Condiciones",
    "MonedaFueraDeLaPolitica",
    "PoliticaAusente",
    "PoliticaCambio",
    "ahora",
    "condiciones_de",
    "exigir_vigente",
    "historial",
    "huella",
    "normalizar_pais",
    "paises_con_politica",
    "publicar",
    "retirar",
    "vigente",
]
