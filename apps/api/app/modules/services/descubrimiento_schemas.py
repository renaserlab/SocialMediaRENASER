"""Lo que devuelve el descubrimiento de Servicios. SOLO LO PÚBLICO.

Ninguna respuesta lleva, como campo, rutas de almacenamiento, notas, motivos
del equipo, estados internos, documentos, números de credencial, el nombre
legal ni cuántas personas guardaron algo. Las imágenes salen como URL
firmada que caduca; ESA URL CONTIENE la ruta `<perfil>/<servicio>/…`, con el
identificador del perfil del prestador (decisión C15/D6, pendiente: una ruta
opaca antes de encender Servicios lo evitaría).

LA CONFIANZA NOMBRA EXACTAMENTE LO QUE Z COMPROBÓ: que admitió al prestador
(y cuándo), que verificó su identidad, que verificó al menos una credencial
vigente y que aprobó y publicó el servicio. Nada de eso garantiza el resultado
del servicio, y la app no lo dice.
"""

from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel

from app.modules.services.catalogo_schemas import (
    CategoriaPublicaRead,
    PrecioRead,
    ServicioPublicoRead,
)
from app.modules.services.catalogo_models import VIRTUAL, ServiceCategory
from app.modules.services.descubrimiento import Confianza, Tarjeta


class PortadaRead(BaseModel):
    #: Firmada y con caducidad. `null` si el almacenamiento no contestó.
    url: str | None
    alt_text: str


class PrestadorEnTarjetaRead(BaseModel):
    id: str
    display_name: str


class CategoriaDelCatalogoRead(CategoriaPublicaRead):
    parent_id: str | None

    @classmethod
    def desde(cls, c: ServiceCategory) -> "CategoriaDelCatalogoRead":
        return cls(
            id=c.id, slug=c.slug, name=c.name, name_en=c.name_en, name_pt=c.name_pt, icon=c.icon,
            parent_id=c.parent_id,
        )


class TarjetaDeServicioRead(BaseModel):
    id: str
    title: str | None
    summary: str | None
    category: CategoriaDelCatalogoRead
    modality: str | None
    #: Solo fuera de lo virtual, y es la ZONA general, nunca una dirección.
    location_area: str | None
    duration_minutes: int | None
    price: PrecioRead
    cover: PortadaRead | None
    provider: PrestadorEnTarjetaRead
    #: Z verificó al menos una credencial vigente de quien lo ofrece.
    credential_verified: bool
    #: Si quien mira lo tiene guardado (`false` sin sesión).
    saved: bool
    #: Por qué aparece: un CÓDIGO estable, o `null` en una lista sin más.
    reason: str | None
    #: Con `matches_search`: dónde coincidió (`title`, `category`, …).
    reason_fields: list[str]

    @classmethod
    def desde(cls, t: Tarjeta) -> "TarjetaDeServicioRead":
        v = t.version
        return cls(
            id=t.servicio.id,
            title=v.title,
            summary=v.summary,
            category=CategoriaDelCatalogoRead.desde(t.categoria),
            modality=v.modality,
            location_area=v.location_area if v.modality != VIRTUAL else None,
            duration_minutes=v.duration_minutes,
            price=PrecioRead.desde(v),
            cover=PortadaRead(url=t.portada_url, alt_text=t.portada_alt) if t.portada_alt else None,
            provider=PrestadorEnTarjetaRead(id=t.prestador.id, display_name=t.prestador.display_name),
            credential_verified=t.credencial_verificada,
            saved=t.guardado,
            reason=t.motivo,
            reason_fields=list(t.campos),
        )


class PaginaDelCatalogoRead(BaseModel):
    items: list[TarjetaDeServicioRead]
    next_cursor: str | None
    #: El orden que se aplicó (sin consulta, «relevancia» es «recientes»).
    sort: str


class ConfianzaRead(BaseModel):
    #: El día en que Z lo admitió. `null` si no consta.
    admitted_since: date | None
    identity_verified: bool
    credential_verified: bool

    @classmethod
    def desde(cls, c: Confianza) -> "ConfianzaRead":
        return cls(
            admitted_since=c.admitido_desde.date() if isinstance(c.admitido_desde, datetime) else None,
            identity_verified=c.identidad_revisada,
            credential_verified=c.credencial_verificada,
        )


class ResenasRead(BaseModel):
    """Las reseñas VERIFICADAS y publicadas (Incremento 6). Sin ninguna —o sin
    la 0094—, `count` es 0 y `average` es `null`, nunca un 0 que parezca una nota."""

    count: int = 0
    average: float | None = None


class PrestadorDeLaFichaRead(BaseModel):
    id: str
    display_name: str
    #: `individual` o `company`, tal como se admitió.
    provider_type: str
    trust: ConfianzaRead


class FichaPublicaRead(ServicioPublicoRead):
    """La ficha del Incremento 2, con lo que hace falta para decidir si
    confiar y seguir mirando. Sigue sin botón de contratar."""

    provider: PrestadorDeLaFichaRead  # type: ignore[assignment]
    category_parent_id: str | None
    #: Z revisó, aprobó y publicó esta versión (siempre cierto en lo público).
    approved_by_z: bool
    reviews: ResenasRead
    saved: bool
    more_from_provider: list[TarjetaDeServicioRead]
    related: list[TarjetaDeServicioRead]


class PerfilDePrestadorRead(BaseModel):
    id: str
    display_name: str
    provider_type: str
    trust: ConfianzaRead
    #: Las categorías de lo que tiene publicado.
    categories: list[CategoriaDelCatalogoRead]
    modalities: list[str]
    #: Las zonas generales de lo que presta fuera de lo virtual.
    areas: list[str]
    reviews: ResenasRead


class SeccionDeSugerenciasRead(BaseModel):
    reason: str
    items: list[TarjetaDeServicioRead]


class SugerenciasRead(BaseModel):
    """Solo las secciones que tienen una razón de verdad. Puede ir vacía."""

    sections: list[SeccionDeSugerenciasRead]


class GuardadoRead(BaseModel):
    service_id: str
    saved_at: datetime
    #: `false` si ya no se puede ver (suspendido, retirado, prestador fuera…).
    available: bool
    #: El título que tenía, para reconocerlo y quitarlo.
    title: str | None
    #: La tarjeta, solo si está disponible.
    service: TarjetaDeServicioRead | None


class PaginaDeGuardadosRead(BaseModel):
    items: list[GuardadoRead]
    next_cursor: str | None


class EstadoDeGuardadoRead(BaseModel):
    saved: bool


__all__ = [
    "CategoriaDelCatalogoRead",
    "ConfianzaRead",
    "EstadoDeGuardadoRead",
    "FichaPublicaRead",
    "GuardadoRead",
    "PaginaDeGuardadosRead",
    "PaginaDelCatalogoRead",
    "PerfilDePrestadorRead",
    "PortadaRead",
    "PrestadorDeLaFichaRead",
    "ResenasRead",
    "SugerenciasRead",
    "TarjetaDeServicioRead",
]
