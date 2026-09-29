"""Las tablas del catálogo de Servicios (migración 0090, Incremento 2).

LO QUE DECLARA EL ORM LO DECLARA TAMBIÉN LA BASE, con el mismo nombre y la
misma expresión escrita con funciones de los dos motores (`length`, `trim`,
`ltrim`, `substr`), como en `models.py`. Las pruebas montan SQLite desde
`Base.metadata`; `tests/test_servicios_migracion_0090.py` compara los dos.

Los disparadores (saltos del mapa, lo enviado congelado, imágenes solo en
borrador, nadie se publica a sí mismo, historial que solo se añade, borrado
solo en cascada, coherencia servicio↔versión publicada) no se declaran aquí:
se prueban contra PostgreSQL de verdad.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.modules.events.models import _uuid
from app.modules.services import catalogo_estados as estados
from app.modules.services.models import _parametros
from app.shared.database import Base

_MINUSCULAS_Y_GUION = "abcdefghijklmnopqrstuvwxyz0123456789-"
_MAYUSCULAS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_HEXADECIMAL = "0123456789abcdef"


def _lista(valores) -> str:
    return ", ".join(repr(v) for v in valores)


# --------------------------------------------------------------------------- #
# Vocabulario
# --------------------------------------------------------------------------- #
CATEGORIA_ACTIVA = "active"
CATEGORIA_INACTIVA = "inactive"
ESTADOS_DE_CATEGORIA = (CATEGORIA_ACTIVA, CATEGORIA_INACTIVA)

VIRTUAL = "virtual"
PRESENCIAL = "in_person"
A_DOMICILIO = "at_home"
MODALIDADES = (VIRTUAL, PRESENCIAL, A_DOMICILIO)

GRATIS = "free"
PRECIO_FIJO = "fixed"
PRECIO_DESDE = "from"
A_CONSULTAR = "on_request"
MODELOS_DE_PRECIO = (GRATIS, PRECIO_FIJO, PRECIO_DESDE, A_CONSULTAR)
#: Los que llevan importe y moneda.
CON_IMPORTE = (PRECIO_FIJO, PRECIO_DESDE)

TIPOS_DE_IMAGEN = ("image/jpeg", "image/png", "image/webp")
PESO_MAXIMO_DE_LA_IMAGEN = 5 * 1024 * 1024

ACCIONES = (
    "created",
    "draft_opened",
    "submitted",
    "resubmitted",
    "withdrawn",
    "review_started",
    "changes_requested",
    "approved",
    "published",
    "superseded",
    "suspended",
    "reinstated",
    "retired",
)
#: Las que no se dan sin motivo visible.
CON_MOTIVO = ("changes_requested", "suspended", "reinstated", "retired")


# --------------------------------------------------------------------------- #
# 1. Categorías
# --------------------------------------------------------------------------- #
class ServiceCategory(Base):
    __tablename__ = "service_categories"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    parent_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_categories.id", ondelete="RESTRICT"), nullable=True
    )
    slug: Mapped[str] = mapped_column(String(60))
    name: Mapped[str] = mapped_column(Text)
    name_en: Mapped[str | None] = mapped_column(Text, nullable=True)
    name_pt: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    icon: Mapped[str | None] = mapped_column(String(40), nullable=True)
    country_code: Mapped[str | None] = mapped_column(String(2), nullable=True)
    status: Mapped[str] = mapped_column(String(16), server_default=text(f"'{CATEGORIA_ACTIVA}'"))
    sort_order: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    created_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("slug", name="service_categories_slug_unico"),
        CheckConstraint(
            "length(slug) between 2 and 60"
            f" and ltrim(slug, '{_MINUSCULAS_Y_GUION}') = ''"
            " and substr(slug, 1, 1) <> '-'",
            name="service_categories_slug",
        ),
        CheckConstraint("length(trim(name)) between 2 and 80", name="service_categories_nombre"),
        CheckConstraint(
            "name_en is null or length(trim(name_en)) between 2 and 80",
            name="service_categories_nombre_en",
        ),
        CheckConstraint(
            "name_pt is null or length(trim(name_pt)) between 2 and 80",
            name="service_categories_nombre_pt",
        ),
        CheckConstraint(
            "description is null or length(description) <= 280",
            name="service_categories_descripcion",
        ),
        CheckConstraint(
            "icon is null or (length(icon) between 2 and 40"
            f" and ltrim(icon, '{_MINUSCULAS_Y_GUION}') = '')",
            name="service_categories_icono",
        ),
        CheckConstraint(
            "country_code is null or (length(country_code) = 2"
            f" and ltrim(country_code, '{_MAYUSCULAS}') = '')",
            name="service_categories_pais",
        ),
        CheckConstraint(
            f"status in ({_lista(ESTADOS_DE_CATEGORIA)})", name="service_categories_estado"
        ),
        CheckConstraint("sort_order between 0 and 100000", name="service_categories_orden"),
        CheckConstraint(
            "parent_id is null or parent_id <> id", name="service_categories_no_es_su_madre"
        ),
        Index("service_categories_por_orden", "status", "sort_order", "id"),
        Index(
            "service_categories_hijas",
            "parent_id",
            postgresql_where=text("parent_id is not null"),
            sqlite_where=text("parent_id is not null"),
        ),
    )


# --------------------------------------------------------------------------- #
# 2. El servicio
# --------------------------------------------------------------------------- #
class Service(Base):
    __tablename__ = "services"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    provider_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_providers.id", ondelete="CASCADE")
    )
    category_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_categories.id", ondelete="RESTRICT")
    )
    status: Mapped[str] = mapped_column(
        String(16), server_default=text(f"'{estados.SERVICIO_BORRADOR}'")
    )
    creation_key: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    first_published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    suspended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    retired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint(
            f"status in ({_lista(estados.ESTADOS_DEL_SERVICIO)})", name="services_estado"
        ),
        CheckConstraint(
            "creation_key is null or length(creation_key) between 8 and 100", name="services_clave"
        ),
        CheckConstraint(
            "status <> 'published' or published_at is not null", name="services_publicado_con_fecha"
        ),
        CheckConstraint(
            "status <> 'suspended' or suspended_at is not null", name="services_suspendido_con_fecha"
        ),
        CheckConstraint(
            "status <> 'retired' or retired_at is not null", name="services_retirado_con_fecha"
        ),
        CheckConstraint(
            "status not in ('published', 'suspended') or first_published_at is not null",
            name="services_publicado_alguna_vez",
        ),
        Index(
            "services_una_por_clave",
            "provider_id",
            "creation_key",
            unique=True,
            postgresql_where=text("creation_key is not null"),
            sqlite_where=text("creation_key is not null"),
        ),
        Index("services_del_prestador", "provider_id", text("created_at desc"), text("id desc")),
        Index("services_por_estado", "status", text("updated_at desc"), text("id desc")),
        Index("services_de_la_categoria", "category_id"),
    )


# --------------------------------------------------------------------------- #
# 3. Las versiones
# --------------------------------------------------------------------------- #
class ServiceVersion(Base):
    __tablename__ = "service_versions"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    service_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("services.id", ondelete="CASCADE")
    )
    version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(24), server_default=text(f"'{estados.BORRADOR}'"))
    based_on_version_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)

    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    modality: Mapped[str | None] = mapped_column(String(16), nullable=True)
    duration_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    capacity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    price_model: Mapped[str | None] = mapped_column(String(16), nullable=True)
    price_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
    scope: Mapped[str | None] = mapped_column(Text, nullable=True)
    includes: Mapped[list] = mapped_column(_parametros, server_default=text("'[]'"))
    excludes: Mapped[list] = mapped_column(_parametros, server_default=text("'[]'"))
    requirements: Mapped[str | None] = mapped_column(Text, nullable=True)
    conditions: Mapped[str | None] = mapped_column(Text, nullable=True)
    location_area: Mapped[str | None] = mapped_column(Text, nullable=True)

    #: SIN CLAVE AJENA a propósito (0086, S10).
    created_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    submitted_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    review_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reviewed_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    decided_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    published_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    withdrawn_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        UniqueConstraint("service_id", "version", name="service_versions_numero_unico"),
        UniqueConstraint("id", "service_id", name="service_versions_del_servicio"),
        ForeignKeyConstraint(
            ["based_on_version_id", "service_id"],
            ["service_versions.id", "service_versions.service_id"],
            name="service_versions_base_del_mismo_servicio",
        ),
        CheckConstraint("version >= 1", name="service_versions_numero"),
        CheckConstraint(
            f"status in ({_lista(estados.ESTADOS_DE_LA_VERSION)})", name="service_versions_estado"
        ),
        CheckConstraint(
            "title is null or length(trim(title)) between 3 and 120", name="service_versions_titulo"
        ),
        CheckConstraint(
            "summary is null or length(trim(summary)) between 10 and 280",
            name="service_versions_resumen",
        ),
        CheckConstraint(
            "description is null or length(trim(description)) between 20 and 5000",
            name="service_versions_descripcion",
        ),
        CheckConstraint(
            f"modality is null or modality in ({_lista(MODALIDADES)})",
            name="service_versions_modalidad",
        ),
        CheckConstraint(
            "duration_minutes is null or duration_minutes between 5 and 1440",
            name="service_versions_duracion",
        ),
        CheckConstraint(
            "capacity is null or capacity between 1 and 1000", name="service_versions_capacidad"
        ),
        CheckConstraint(
            f"price_model is null or price_model in ({_lista(MODELOS_DE_PRECIO)})",
            name="service_versions_modelo_de_precio",
        ),
        CheckConstraint(
            "price_minor is null or price_minor > 0", name="service_versions_importe"
        ),
        CheckConstraint(
            "currency is null or (length(currency) = 3"
            f" and ltrim(currency, '{_MAYUSCULAS}') = '')",
            name="service_versions_moneda",
        ),
        CheckConstraint(
            "scope is null or length(trim(scope)) between 10 and 2000",
            name="service_versions_alcance",
        ),
        CheckConstraint(
            "requirements is null or length(trim(requirements)) between 3 and 2000",
            name="service_versions_requisitos",
        ),
        CheckConstraint(
            "conditions is null or length(conditions) <= 2000", name="service_versions_condiciones"
        ),
        CheckConstraint(
            "location_area is null or length(trim(location_area)) between 2 and 120",
            name="service_versions_zona",
        ),
        CheckConstraint(
            f"price_model in ({_lista(CON_IMPORTE)})"
            " or (price_minor is null and currency is null)",
            name="service_versions_importe_solo_con_precio",
        ),
        CheckConstraint(
            "status in ('draft', 'withdrawn')"
            " or (title is not null and summary is not null and description is not null"
            " and modality is not null and duration_minutes is not null"
            " and price_model is not null and scope is not null and requirements is not null"
            " and (price_model not in ('fixed', 'from')"
            " or (price_minor is not null and currency is not null))"
            " and (modality = 'virtual' or location_area is not null))",
            name="service_versions_completa_al_enviar",
        ),
        CheckConstraint(
            "status in ('draft', 'withdrawn') or submitted_at is not null",
            name="service_versions_enviada_con_fecha",
        ),
        CheckConstraint(
            "status not in ('under_review', 'changes_requested', 'approved', 'published', 'superseded')"
            " or review_started_at is not null",
            name="service_versions_revisada_con_fecha",
        ),
        CheckConstraint(
            "status not in ('changes_requested', 'approved', 'published', 'superseded')"
            " or (decided_at is not null and decided_by is not null)",
            name="service_versions_decidida_con_fecha",
        ),
        CheckConstraint(
            "status not in ('published', 'superseded')"
            " or (published_at is not null and published_by is not null)",
            name="service_versions_publicada_con_fecha",
        ),
        CheckConstraint(
            "status <> 'superseded' or superseded_at is not null",
            name="service_versions_superada_con_fecha",
        ),
        CheckConstraint(
            "status <> 'withdrawn' or withdrawn_at is not null",
            name="service_versions_retirada_con_fecha",
        ),
        Index(
            "service_versions_una_abierta",
            "service_id",
            unique=True,
            postgresql_where=text("status in ('draft', 'submitted', 'under_review', 'approved')"),
            sqlite_where=text("status in ('draft', 'submitted', 'under_review', 'approved')"),
        ),
        Index(
            "service_versions_una_publicada",
            "service_id",
            unique=True,
            postgresql_where=text("status = 'published'"),
            sqlite_where=text("status = 'published'"),
        ),
        Index("service_versions_del_servicio_por_numero", "service_id", text("version desc")),
        Index(
            "service_versions_en_cola",
            "status",
            "submitted_at",
            "id",
            postgresql_where=text("status in ('submitted', 'under_review', 'approved')"),
            sqlite_where=text("status in ('submitted', 'under_review', 'approved')"),
        ),
    )


# --------------------------------------------------------------------------- #
# 4. Las imágenes
# --------------------------------------------------------------------------- #
class ServiceVersionImage(Base):
    __tablename__ = "service_version_images"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    version_id: Mapped[str] = mapped_column(Uuid(as_uuid=False))
    service_id: Mapped[str] = mapped_column(Uuid(as_uuid=False))
    #: NUNCA sale en una respuesta.
    storage_path: Mapped[str] = mapped_column(Text)
    alt_text: Mapped[str] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    is_cover: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    content_type: Mapped[str] = mapped_column(String(16))
    byte_size: Mapped[int] = mapped_column(Integer)
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    checksum_sha256: Mapped[str] = mapped_column(String(64))
    created_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        ForeignKeyConstraint(
            ["version_id", "service_id"],
            ["service_versions.id", "service_versions.service_id"],
            ondelete="CASCADE",
            name="service_version_images_de_su_version",
        ),
        UniqueConstraint("version_id", "storage_path", name="service_version_images_ruta_unica"),
        CheckConstraint(
            "length(trim(storage_path)) between 3 and 512"
            " and storage_path not like '/%'"
            " and storage_path not like '%..%'",
            name="service_version_images_ruta",
        ),
        CheckConstraint(
            "length(trim(alt_text)) between 3 and 300", name="service_version_images_alternativo"
        ),
        CheckConstraint("position between 0 and 100", name="service_version_images_posicion"),
        CheckConstraint(
            f"content_type in ({_lista(TIPOS_DE_IMAGEN)})", name="service_version_images_tipo"
        ),
        CheckConstraint("byte_size between 1 and 5242880", name="service_version_images_peso"),
        CheckConstraint("width > 0", name="service_version_images_ancho"),
        CheckConstraint("height > 0", name="service_version_images_alto"),
        CheckConstraint(
            f"length(checksum_sha256) = 64 and ltrim(checksum_sha256, '{_HEXADECIMAL}') = ''",
            name="service_version_images_huella",
        ),
        Index(
            "service_version_images_una_portada",
            "version_id",
            unique=True,
            postgresql_where=text("is_cover"),
            sqlite_where=text("is_cover"),
        ),
        Index("service_version_images_de_la_version", "version_id", "position", "id"),
        Index("service_version_images_por_ruta", "storage_path"),
    )


# --------------------------------------------------------------------------- #
# 5. El historial
# --------------------------------------------------------------------------- #
class ServiceEvent(Base):
    __tablename__ = "service_events"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    service_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("services.id", ondelete="CASCADE")
    )
    version_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    action: Mapped[str] = mapped_column(String(24))
    from_status: Mapped[str | None] = mapped_column(String(24), nullable=True)
    to_status: Mapped[str] = mapped_column(String(24))
    #: SIN CLAVE AJENA a propósito (0086, S10).
    actor_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    actor_role: Mapped[str] = mapped_column(String(16))
    visible_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    internal_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    details: Mapped[dict] = mapped_column(_parametros, server_default=text("'{}'"))
    idempotency_key: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        ForeignKeyConstraint(
            ["version_id", "service_id"],
            ["service_versions.id", "service_versions.service_id"],
            ondelete="CASCADE",
            name="service_events_de_su_version",
        ),
        CheckConstraint(f"action in ({_lista(ACCIONES)})", name="service_events_accion"),
        CheckConstraint(
            "from_status is null or length(from_status) between 3 and 24", name="service_events_desde"
        ),
        CheckConstraint("length(to_status) between 3 and 24", name="service_events_hasta"),
        CheckConstraint(
            "actor_role in ('provider', 'reviewer', 'admin', 'system')", name="service_events_rol"
        ),
        CheckConstraint(
            "visible_note is null or length(trim(visible_note)) between 3 and 2000",
            name="service_events_nota_visible",
        ),
        CheckConstraint(
            "internal_note is null or length(internal_note) <= 4000",
            name="service_events_nota_interna",
        ),
        CheckConstraint(
            "idempotency_key is null or length(idempotency_key) between 8 and 100",
            name="service_events_clave",
        ),
        CheckConstraint(
            f"action not in ({_lista(CON_MOTIVO)}) or visible_note is not null",
            name="service_events_con_motivo",
        ),
        CheckConstraint(
            "(action in ('created', 'draft_opened', 'submitted', 'resubmitted') and actor_role = 'provider')"
            " or (action = 'withdrawn' and actor_role in ('provider', 'system'))"
            " or (action in ('review_started', 'changes_requested') and actor_role in ('reviewer', 'admin'))"
            " or (action in ('approved', 'published', 'suspended', 'reinstated', 'retired')"
            " and actor_role = 'admin')"
            " or (action = 'superseded' and actor_role = 'system')",
            name="service_events_quien",
        ),
        Index(
            "service_events_una_por_clave",
            "service_id",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key is not null"),
            sqlite_where=text("idempotency_key is not null"),
        ),
        Index("service_events_del_servicio", "service_id", "created_at", "id"),
    )


__all__ = [
    "A_CONSULTAR",
    "A_DOMICILIO",
    "ACCIONES",
    "CATEGORIA_ACTIVA",
    "CATEGORIA_INACTIVA",
    "CON_IMPORTE",
    "CON_MOTIVO",
    "GRATIS",
    "MODALIDADES",
    "MODELOS_DE_PRECIO",
    "PESO_MAXIMO_DE_LA_IMAGEN",
    "PRECIO_DESDE",
    "PRECIO_FIJO",
    "PRESENCIAL",
    "Service",
    "ServiceCategory",
    "ServiceEvent",
    "ServiceVersion",
    "ServiceVersionImage",
    "TIPOS_DE_IMAGEN",
    "VIRTUAL",
]
