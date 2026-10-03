"""Qué le falta a una versión para poder enviarse. LA AUTORIDAD ES ESTE FICHERO.

Una sola función, sin base de datos: la llama la API al enviar (y para contar
al móvil qué falta), y el móvil solo lo pinta. La base impone además un suelo
(`service_versions_completa_al_enviar` y la portada en el disparador de
saltos); esto es la lista completa, con la configuración de la empresa.

CADA CÓDIGO ES ESTABLE: el móvil lo traduce. Nunca un texto interno.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.core.config import Settings, get_settings
from app.modules.services.catalogo_models import (
    CATEGORIA_ACTIVA,
    CON_IMPORTE,
    MODALIDADES,
    MODELOS_DE_PRECIO,
    VIRTUAL,
    Service,
    ServiceCategory,
    ServiceVersion,
    ServiceVersionImage,
)
from app.modules.services.models import PRESTADOR_ACTIVO, ServiceProvider

#: Los códigos, en el orden en que el formulario los pide.
CODIGOS = (
    "provider_not_active",
    "category_inactive",
    "title",
    "summary",
    "description",
    "modality",
    "modality_not_allowed",
    "duration",
    "duration_out_of_range",
    "price_model",
    "price_model_not_allowed",
    "price",
    "currency",
    "currency_not_allowed",
    "scope",
    "includes",
    "excludes",
    "requirements",
    "location_area",
    "cover_image",
    "too_many_images",
)

#: Los campos del contenido que el equipo puede señalar al pedir cambios.
CAMPOS = (
    "category",
    "title",
    "summary",
    "description",
    "modality",
    "duration",
    "capacity",
    "price",
    "scope",
    "includes",
    "excludes",
    "requirements",
    "conditions",
    "location_area",
    "images",
)


def _lista(valor: str) -> frozenset[str]:
    return frozenset(v.strip() for v in (valor or "").split(",") if v.strip())


@dataclass(frozen=True)
class Reglas:
    """Lo configurable, ya leído. Sin configurar = los límites técnicos."""

    modalidades: frozenset[str]
    modelos_de_precio: frozenset[str]
    monedas: frozenset[str]
    duracion_minima: int
    duracion_maxima: int
    maximo_de_imagenes: int

    @classmethod
    def de(cls, ajustes: Settings | None = None) -> "Reglas":
        a = ajustes or get_settings()
        return cls(
            modalidades=_lista(a.services_catalog_modalities) & frozenset(MODALIDADES),
            modelos_de_precio=_lista(a.services_catalog_price_models) & frozenset(MODELOS_DE_PRECIO),
            monedas=frozenset(m.upper() for m in _lista(a.services_catalog_currencies)),
            duracion_minima=max(5, int(a.services_catalog_min_duration_minutes)),
            duracion_maxima=min(1440, int(a.services_catalog_max_duration_minutes)),
            maximo_de_imagenes=max(1, min(100, int(a.services_catalog_max_images))),
        )


def faltantes(
    *,
    servicio: Service,
    version: ServiceVersion,
    categoria: ServiceCategory,
    prestador: ServiceProvider,
    imagenes: list[ServiceVersionImage],
    reglas: Reglas | None = None,
) -> list[str]:
    """Los códigos de lo que falta, vacío si se puede enviar."""
    r = reglas or Reglas.de()
    falta: list[str] = []

    if prestador.status != PRESTADOR_ACTIVO:
        falta.append("provider_not_active")
    if categoria.status != CATEGORIA_ACTIVA:
        falta.append("category_inactive")

    for campo in ("title", "summary", "description"):
        if not (getattr(version, campo) or "").strip():
            falta.append(campo)

    if not version.modality:
        falta.append("modality")
    elif version.modality not in r.modalidades:
        falta.append("modality_not_allowed")

    if version.duration_minutes is None:
        falta.append("duration")
    elif not r.duracion_minima <= version.duration_minutes <= r.duracion_maxima:
        falta.append("duration_out_of_range")

    # EL PRECIO. «Sin configurar» (nulo) NO es gratis, y un importe va con su
    # moneda, que tiene que estar entre las configuradas.
    if not version.price_model:
        falta.append("price_model")
    elif version.price_model not in r.modelos_de_precio:
        falta.append("price_model_not_allowed")
    elif version.price_model in CON_IMPORTE:
        if not version.price_minor or version.price_minor <= 0:
            falta.append("price")
        if not version.currency:
            falta.append("currency")
        elif version.currency not in r.monedas:
            falta.append("currency_not_allowed")

    if not (version.scope or "").strip():
        falta.append("scope")
    if not _frases(version.includes):
        falta.append("includes")
    if not _frases(version.excludes):
        falta.append("excludes")
    if not (version.requirements or "").strip():
        falta.append("requirements")
    if version.modality and version.modality != VIRTUAL and not (version.location_area or "").strip():
        falta.append("location_area")

    if not any(i.is_cover for i in imagenes):
        falta.append("cover_image")
    if len(imagenes) > r.maximo_de_imagenes:
        falta.append("too_many_images")

    return falta


def _frases(valor) -> list[str]:
    if not isinstance(valor, list):
        return []
    return [f for f in valor if isinstance(f, str) and f.strip()]


__all__ = ["CAMPOS", "CODIGOS", "Reglas", "faltantes"]
