"""Los contratos del catálogo de Servicios (Incremento 2).

TRES VISTAS, Y NINGUNA SE DERIVA DE OTRA POR DESCUIDO (como `schemas.py`):

    pública          SOLO lo publicado: el contenido de la versión publicada,
                     sus imágenes firmadas, la categoría y el nombre público
                     del prestador. Nada de borradores, notas, estados
                     internos ni rutas.
    del prestador    su servicio: la versión publicada, la abierta, qué le
                     falta y lo último que Z le dijo con motivo VISIBLE.
    administrativa   además, el prestador, las notas internas, el historial
                     completo y qué cambia la propuesta respecto de lo publicado.

LAS SALIDAS SE CONSTRUYEN CAMPO A CAMPO. NINGUNA lleva `storage_path`: una
imagen sale con una URL firmada que caduca, o sin URL.

LAS ENTRADAS PROHÍBEN CAMPOS DESCONOCIDOS: no existe `status` en ninguna.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.modules.services import catalogo_estados as estados
from app.modules.services.catalogo_models import (
    Service,
    ServiceCategory,
    ServiceEvent,
    ServiceVersion,
    ServiceVersionImage,
)
from app.modules.services.models import ServiceProvider

Modalidad = Literal["virtual", "in_person", "at_home"]
ModeloDePrecio = Literal["free", "fixed", "from", "on_request"]
AccionDeAdministracion = Literal[
    "start_review", "request_changes", "approve", "publish", "suspend", "reinstate", "retire"
]


class _Entrada(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


def _uuid(valor: object) -> object:
    if valor is None:
        return None
    try:
        return str(UUID(str(valor)))
    except ValueError:
        raise ValueError("No es un identificador válido.") from None


def _frases(valor: object) -> object:
    if valor is None:
        return None
    if not isinstance(valor, list):
        raise ValueError("Tiene que ser una lista de frases.")
    limpias = [str(f).strip() for f in valor if str(f).strip()]
    if len(limpias) > 20:
        raise ValueError("Como mucho 20 frases.")
    for frase in limpias:
        if not 2 <= len(frase) <= 200:
            raise ValueError("Cada frase tiene entre 2 y 200 caracteres.")
    return limpias


# --------------------------------------------------------------------------- #
# Entradas del prestador
# --------------------------------------------------------------------------- #
class ServicioCrear(_Entrada):
    category_id: str

    @field_validator("category_id", mode="before")
    @classmethod
    def _categoria(cls, valor: object) -> object:
        return _uuid(valor)


class BorradorEditar(_Entrada):
    """Un campo AUSENTE no se toca; `null` lo vacía. Nunca un estado."""

    category_id: str | None = None
    title: str | None = Field(default=None, min_length=3, max_length=120)
    summary: str | None = Field(default=None, min_length=10, max_length=280)
    description: str | None = Field(default=None, min_length=20, max_length=5000)
    modality: Modalidad | None = None
    duration_minutes: int | None = Field(default=None, ge=5, le=1440)
    capacity: int | None = Field(default=None, ge=1, le=1000)
    price_model: ModeloDePrecio | None = None
    price_minor: int | None = Field(default=None, gt=0, le=10_000_000_000)
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    scope: str | None = Field(default=None, min_length=10, max_length=2000)
    includes: list[str] | None = None
    excludes: list[str] | None = None
    requirements: str | None = Field(default=None, min_length=3, max_length=2000)
    conditions: str | None = Field(default=None, max_length=2000)
    location_area: str | None = Field(default=None, min_length=2, max_length=120)

    @field_validator("category_id", mode="before")
    @classmethod
    def _categoria(cls, valor: object) -> object:
        return _uuid(valor)

    @field_validator("currency", mode="before")
    @classmethod
    def _moneda(cls, valor: object) -> object:
        return valor.strip().upper() if isinstance(valor, str) else valor

    @field_validator("includes", "excludes", mode="before")
    @classmethod
    def _listas(cls, valor: object) -> object:
        return _frases(valor)

    @field_validator("conditions", mode="before")
    @classmethod
    def _condiciones(cls, valor: object) -> object:
        return (valor.strip() or None) if isinstance(valor, str) else valor

    @model_validator(mode="after")
    def _algo(self) -> "BorradorEditar":
        if not self.model_fields_set:
            raise ValueError("No hay nada que actualizar.")
        if "category_id" in self.model_fields_set and self.category_id is None:
            raise ValueError("La categoría no se puede vaciar.")
        for lista in ("includes", "excludes"):
            if lista in self.model_fields_set and getattr(self, lista) is None:
                setattr(self, lista, [])
        return self

    def cambios(self) -> dict[str, object]:
        return {campo: getattr(self, campo) for campo in self.model_fields_set}


class ImagenesOrdenar(_Entrada):
    image_ids: list[str] = Field(min_length=1, max_length=100)
    cover_id: str | None = None

    @field_validator("image_ids", mode="before")
    @classmethod
    def _ids(cls, valor: object) -> object:
        return [_uuid(v) for v in valor] if isinstance(valor, list) else valor

    @field_validator("cover_id", mode="before")
    @classmethod
    def _portada(cls, valor: object) -> object:
        return _uuid(valor)


class VersionRetirar(_Entrada):
    confirm: Literal[True]


# --------------------------------------------------------------------------- #
# Entradas del equipo de Z
# --------------------------------------------------------------------------- #
class _Decision(_Entrada):
    internal_note: str | None = Field(default=None, max_length=4000)


class RevisionIniciar(_Decision):
    pass


class CambiosPedir(_Decision):
    note: str = Field(min_length=3, max_length=2000)
    fields: list[str] = Field(default_factory=list, max_length=15)


class VersionAprobar(_Decision):
    pass


class VersionPublicar(_Decision):
    pass


class ServicioMotivo(_Decision):
    """Suspender, reactivar y retirar: con motivo que el prestador lee."""

    note: str = Field(min_length=3, max_length=2000)


class CategoriaCrear(_Entrada):
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,59}$")
    name: str = Field(min_length=2, max_length=80)
    name_en: str | None = Field(default=None, min_length=2, max_length=80)
    name_pt: str | None = Field(default=None, min_length=2, max_length=80)
    description: str | None = Field(default=None, max_length=280)
    icon: str | None = Field(default=None, pattern=r"^[a-z0-9-]{2,40}$")
    country_code: str | None = Field(default=None, pattern=r"^[A-Z]{2}$")
    sort_order: int = Field(default=0, ge=0, le=100000)
    parent_id: str | None = None

    @field_validator("parent_id", mode="before")
    @classmethod
    def _madre(cls, valor: object) -> object:
        return _uuid(valor)

    @field_validator("country_code", mode="before")
    @classmethod
    def _pais(cls, valor: object) -> object:
        return valor.strip().upper() if isinstance(valor, str) and valor.strip() else None


class CategoriaEditar(_Entrada):
    name: str | None = Field(default=None, min_length=2, max_length=80)
    name_en: str | None = Field(default=None, min_length=2, max_length=80)
    name_pt: str | None = Field(default=None, min_length=2, max_length=80)
    description: str | None = Field(default=None, max_length=280)
    icon: str | None = Field(default=None, pattern=r"^[a-z0-9-]{2,40}$")
    country_code: str | None = Field(default=None, pattern=r"^[A-Z]{2}$")
    sort_order: int | None = Field(default=None, ge=0, le=100000)
    parent_id: str | None = None

    @field_validator("parent_id", mode="before")
    @classmethod
    def _madre(cls, valor: object) -> object:
        return _uuid(valor)

    @field_validator("country_code", mode="before")
    @classmethod
    def _pais(cls, valor: object) -> object:
        return valor.strip().upper() if isinstance(valor, str) and valor.strip() else None

    @model_validator(mode="after")
    def _algo(self) -> "CategoriaEditar":
        if not self.model_fields_set:
            raise ValueError("No hay nada que actualizar.")
        for campo in ("name", "sort_order"):
            if campo in self.model_fields_set and getattr(self, campo) is None:
                raise ValueError(f"{campo} no se puede vaciar.")
        return self

    def cambios(self) -> dict[str, object]:
        return {campo: getattr(self, campo) for campo in self.model_fields_set}


# --------------------------------------------------------------------------- #
# Salidas
# --------------------------------------------------------------------------- #
class CategoriaRead(BaseModel):
    id: str
    slug: str
    name: str
    name_en: str | None
    name_pt: str | None
    description: str | None
    icon: str | None
    parent_id: str | None
    country_code: str | None
    sort_order: int
    status: str

    @classmethod
    def desde(cls, c: ServiceCategory) -> "CategoriaRead":
        return cls(
            id=c.id, slug=c.slug, name=c.name, name_en=c.name_en, name_pt=c.name_pt,
            description=c.description, icon=c.icon, parent_id=c.parent_id,
            country_code=c.country_code, sort_order=c.sort_order, status=c.status,
        )


class CategoriaPublicaRead(BaseModel):
    id: str
    slug: str
    name: str
    name_en: str | None
    name_pt: str | None
    icon: str | None

    @classmethod
    def desde(cls, c: ServiceCategory) -> "CategoriaPublicaRead":
        return cls(id=c.id, slug=c.slug, name=c.name, name_en=c.name_en, name_pt=c.name_pt, icon=c.icon)


class ImagenRead(BaseModel):
    id: str
    #: Firmada y con caducidad. `null` si el almacenamiento no contestó.
    url: str | None
    alt_text: str
    position: int
    is_cover: bool
    width: int
    height: int

    @classmethod
    def desde(cls, i: ServiceVersionImage, firmadas: dict[str, str]) -> "ImagenRead":
        return cls(
            id=i.id, url=firmadas.get(i.storage_path), alt_text=i.alt_text, position=i.position,
            is_cover=i.is_cover, width=i.width, height=i.height,
        )


class PrecioRead(BaseModel):
    #: `null` = sin configurar (NO es gratis).
    model: str | None
    amount_minor: int | None
    currency: str | None

    @classmethod
    def desde(cls, v: ServiceVersion) -> "PrecioRead":
        return cls(model=v.price_model, amount_minor=v.price_minor, currency=v.currency)


class _Contenido(BaseModel):
    title: str | None
    summary: str | None
    description: str | None
    modality: str | None
    duration_minutes: int | None
    capacity: int | None
    price: PrecioRead
    scope: str | None
    includes: list[str]
    excludes: list[str]
    requirements: str | None
    conditions: str | None
    location_area: str | None


def _contenido(v: ServiceVersion) -> dict:
    return {
        "title": v.title,
        "summary": v.summary,
        "description": v.description,
        "modality": v.modality,
        "duration_minutes": v.duration_minutes,
        "capacity": v.capacity,
        "price": PrecioRead.desde(v),
        "scope": v.scope,
        "includes": list(v.includes or []),
        "excludes": list(v.excludes or []),
        "requirements": v.requirements,
        "conditions": v.conditions,
        "location_area": v.location_area,
    }


class VersionRead(_Contenido):
    """Una versión, vista por su dueño o por el equipo de Z."""

    id: str
    version: int
    status: str
    based_on_version: int | None
    images: list[ImagenRead]
    created_at: datetime
    updated_at: datetime
    submitted_at: datetime | None
    decided_at: datetime | None
    published_at: datetime | None

    @classmethod
    def desde(
        cls,
        v: ServiceVersion,
        *,
        imagenes: list[ServiceVersionImage],
        firmadas: dict[str, str],
        base: int | None,
    ) -> "VersionRead":
        return cls(
            **_contenido(v),
            id=v.id,
            version=v.version,
            status=v.status,
            based_on_version=base,
            images=[ImagenRead.desde(i, firmadas) for i in imagenes],
            created_at=v.created_at,
            updated_at=v.updated_at,
            submitted_at=v.submitted_at,
            decided_at=v.decided_at,
            published_at=v.published_at,
        )


class ObservacionRead(BaseModel):
    """Lo último que Z dijo con motivo VISIBLE. Nunca la nota interna."""

    action: str
    note: str
    fields: list[str]
    version: int | None
    created_at: datetime


class ServicioPrivadoRead(BaseModel):
    id: str
    status: str
    #: El título que lo nombra: el de la abierta, si no el de la publicada,
    #: y si no el de la última (una que volvió con cambios, o retirada).
    title: str | None
    #: El estado de la ÚLTIMA versión, abierta o no: `changes_requested`
    #: dice que hay algo que corregir aunque no haya ninguna abierta.
    last_version_status: str | None
    category: CategoriaRead
    created_at: datetime
    updated_at: datetime
    first_published_at: datetime | None
    published_at: datetime | None
    suspended_at: datetime | None
    retired_at: datetime | None
    published_version: VersionRead | None
    open_version: VersionRead | None
    last_observation: ObservacionRead | None
    #: Qué le falta a la versión abierta para enviarse (solo en borrador).
    missing: list[str]
    can_edit: bool
    can_submit: bool
    can_withdraw: bool
    can_open_draft: bool
    #: Si ahora mismo lo ve el público.
    publicly_visible: bool


class ServicioResumenRead(BaseModel):
    id: str
    status: str
    title: str | None
    category: CategoriaPublicaRead
    open_version_status: str | None
    last_version_status: str | None
    has_published_version: bool
    cover_url: str | None
    updated_at: datetime


class PaginaDeServicios(BaseModel):
    items: list[ServicioResumenRead] = Field(default_factory=list)
    next_cursor: str | None = None


class CompletitudRead(BaseModel):
    missing: list[str]


class EventoVisibleRead(BaseModel):
    """Un paso del historial, visto por el prestador: SIN quién de Z ni nota
    interna."""

    id: str
    action: str
    from_status: str | None
    to_status: str
    version: int | None
    note: str | None
    fields: list[str]
    created_at: datetime

    @classmethod
    def desde(cls, e: ServiceEvent, numero: int | None) -> "EventoVisibleRead":
        detalles = e.details or {}
        return cls(
            id=e.id, action=e.action, from_status=e.from_status, to_status=e.to_status,
            version=numero, note=e.visible_note,
            fields=[str(f) for f in detalles.get("fields", [])] if isinstance(detalles, dict) else [],
            created_at=e.created_at,
        )


class EventoAdminRead(EventoVisibleRead):
    actor_id: str | None
    actor_role: str
    internal_note: str | None

    @classmethod
    def desde_admin(cls, e: ServiceEvent, numero: int | None) -> "EventoAdminRead":
        return cls(
            **EventoVisibleRead.desde(e, numero).model_dump(),
            actor_id=e.actor_id, actor_role=e.actor_role, internal_note=e.internal_note,
        )


class PrestadorEnServicioRead(BaseModel):
    id: str
    display_name: str
    provider_type: str
    country_code: str | None
    status: str

    @classmethod
    def desde(cls, p: ServiceProvider) -> "PrestadorEnServicioRead":
        return cls(
            id=p.id, display_name=p.display_name, provider_type=p.provider_type,
            country_code=p.country_code, status=p.status,
        )


class VersionEnListaRead(BaseModel):
    id: str
    version: int
    status: str
    submitted_at: datetime | None
    decided_at: datetime | None
    published_at: datetime | None


class ServicioAdminRead(BaseModel):
    id: str
    status: str
    #: Como en la vista del prestador: abierta, publicada o la última.
    title: str | None
    category: CategoriaRead
    provider: PrestadorEnServicioRead
    created_at: datetime
    updated_at: datetime
    first_published_at: datetime | None
    published_at: datetime | None
    suspended_at: datetime | None
    retired_at: datetime | None
    #: Lo que ve hoy el público (si está publicado y no suspendido).
    published_version: VersionRead | None
    #: La propuesta: la versión abierta.
    proposed_version: VersionRead | None
    #: Qué cambia la propuesta respecto de lo publicado.
    changed_fields: list[str]
    versions: list[VersionEnListaRead]
    last_observation: ObservacionRead | None
    #: Lo que ESTA persona puede hacer ahora. Vacío si el servicio es suyo.
    actions: list[AccionDeAdministracion]
    own: bool
    publicly_visible: bool


class ServicioAdminResumenRead(BaseModel):
    id: str
    status: str
    title: str | None
    category: CategoriaPublicaRead
    modality: str | None
    provider_name: str
    provider_status: str
    open_version_status: str | None
    open_version: int | None
    submitted_at: datetime | None
    updated_at: datetime


class PaginaDeServiciosAdmin(BaseModel):
    items: list[ServicioAdminResumenRead] = Field(default_factory=list)
    next_cursor: str | None = None


class PrestadorPublicoRead(BaseModel):
    display_name: str


class ImagenPublicaRead(BaseModel):
    url: str | None
    alt_text: str
    width: int
    height: int
    is_cover: bool


class ServicioPublicoRead(_Contenido):
    """LO ÚNICO QUE VE EL PÚBLICO: la versión publicada."""

    id: str
    category: CategoriaPublicaRead
    provider: PrestadorPublicoRead
    images: list[ImagenPublicaRead]
    published_at: datetime

    @classmethod
    def desde(
        cls,
        s: Service,
        v: ServiceVersion,
        p: ServiceProvider,
        c: ServiceCategory,
        imagenes: list[ServiceVersionImage],
        firmadas: dict[str, str],
    ) -> "ServicioPublicoRead":
        return cls(
            **_contenido(v),
            id=s.id,
            category=CategoriaPublicaRead.desde(c),
            provider=PrestadorPublicoRead(display_name=p.display_name),
            images=[
                ImagenPublicaRead(
                    url=firmadas.get(i.storage_path), alt_text=i.alt_text, width=i.width,
                    height=i.height, is_cover=i.is_cover,
                )
                for i in imagenes
            ],
            published_at=v.published_at or s.published_at,
        )


#: El nombre de la acción de administración que lleva a cada estado.
ACCION_HACIA_LA_VERSION = {
    estados.EN_REVISION: "start_review",
    estados.CAMBIOS_PEDIDOS: "request_changes",
    estados.APROBADA: "approve",
    estados.PUBLICADA: "publish",
}
ACCION_HACIA_EL_SERVICIO = {
    estados.SERVICIO_SUSPENDIDO: "suspend",
    estados.SERVICIO_PUBLICADO: "reinstate",
    estados.SERVICIO_RETIRADO: "retire",
}
