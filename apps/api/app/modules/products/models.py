"""Las tablas de Productos (migraciones 0070 a 0079).

LO QUE DECLARA EL ORM TIENE QUE DECLARARLO TAMBIÉN LA BASE, y al revés. Las
pruebas montan SQLite desde `Base.metadata`, así que un CHECK o un índice
parcial que solo viva en el `.sql` es invisible para la suite: la protección
existe en producción y ninguna prueba la ve.

Los disparadores no se pueden declarar aquí. Los que hay —«nadie evalúa su
propio producto»— se prueban contra PostgreSQL de verdad.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
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
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.modules.events.models import _uuid
from app.shared.database import Base

#: JSONB en PostgreSQL, JSON en SQLite. Igual que en comercio y en posventa.
_opciones = JSON().with_variant(JSONB, "postgresql")


# --------------------------------------------------------------------------- #
# El responsable comercial
# --------------------------------------------------------------------------- #
#: Nace `pending`: nadie vende por haberse registrado.
VENDEDOR_PENDIENTE = "pending"
VENDEDOR_ACTIVO = "active"
VENDEDOR_SUSPENDIDO = "suspended"
ESTADOS_DE_VENDEDOR = (VENDEDOR_PENDIENTE, VENDEDOR_ACTIVO, VENDEDOR_SUSPENDIDO)


class ProductSeller(Base):
    """La capacidad comercial de un perfil. NO es una segunda identidad."""

    __tablename__ = "product_sellers"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    profile_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), unique=True
    )
    display_name: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(
        String(16), server_default=text(f"'{VENDEDOR_PENDIENTE}'")
    )

    activated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    activated_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    suspended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    suspension_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            f"status in ({', '.join(repr(e) for e in ESTADOS_DE_VENDEDOR)})",
            name="product_sellers_estado",
        ),
        CheckConstraint(
            f"status <> '{VENDEDOR_ACTIVO}' or activated_at is not null",
            name="product_sellers_activo_con_fecha",
        ),
        CheckConstraint(
            f"status <> '{VENDEDOR_SUSPENDIDO}' or suspended_at is not null",
            name="product_sellers_suspendido_con_fecha",
        ),
    )


class ProductCategory(Base):
    """Las categorías. NACE VACÍA: las iniciales las decide la empresa."""

    __tablename__ = "product_categories"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    slug: Mapped[str] = mapped_column(Text, unique=True)
    name: Mapped[str] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    active: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


# --------------------------------------------------------------------------- #
# El producto y su versión
# --------------------------------------------------------------------------- #
#: El ciclo del blueprint §5, letra por letra.
BORRADOR = "draft"
ENVIADO = "submitted"
REVISION_DOCUMENTAL = "document_review"
MUESTRA_PEDIDA = "sample_requested"
EVALUACION = "evaluation"
APROBADO_CON_CONDICIONES = "conditionally_approved"
APROBADO = "approved"
PUBLICADO = "published"
OBSERVACION = "observation"
SUSPENDIDO = "suspended"
RETIRADO = "removed"

ESTADOS_DE_PRODUCTO = (
    BORRADOR,
    ENVIADO,
    REVISION_DOCUMENTAL,
    MUESTRA_PEDIDA,
    EVALUACION,
    APROBADO_CON_CONDICIONES,
    APROBADO,
    PUBLICADO,
    OBSERVACION,
    SUSPENDIDO,
    RETIRADO,
)


class Product(Base):
    """La identidad estable del producto. Lo que cambia vive en la versión."""

    __tablename__ = "products"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    seller_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_sellers.id", ondelete="RESTRICT")
    )
    category_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("product_categories.id", ondelete="SET NULL"),
        nullable=True,
    )
    status: Mapped[str] = mapped_column(String(24), server_default=text(f"'{BORRADOR}'"))

    #: NULA mientras no haya ninguna publicada, y es lo que impide que un
    #: producto sin nada que enseñar aparezca en catálogo.
    published_version_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), nullable=True
    )

    published_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    suspended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    suspension_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    removed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    created_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            f"status in ({', '.join(repr(e) for e in ESTADOS_DE_PRODUCTO)})",
            name="products_estado",
        ),
        CheckConstraint(
            f"status <> '{PUBLICADO}' or published_version_id is not null",
            name="products_publicado_con_version",
        ),
        CheckConstraint(
            f"status <> '{PUBLICADO}' or published_at is not null",
            name="products_publicado_con_fecha",
        ),
        Index("products_del_responsable", "seller_id", "status"),
        Index(
            "products_en_catalogo",
            text("published_at desc"),
            text("id desc"),
            postgresql_where=text(f"status = '{PUBLICADO}'"),
            sqlite_where=text(f"status = '{PUBLICADO}'"),
        ),
    )


VERSION_BORRADOR = "draft"
VERSION_PUBLICADA = "published"
VERSION_SUPERADA = "superseded"
ESTADOS_DE_VERSION = (VERSION_BORRADOR, VERSION_PUBLICADA, VERSION_SUPERADA)


class ProductVersion(Base):
    """Lo que se publica. Una vez publicada NO se toca: se publica otra."""

    __tablename__ = "product_versions"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    product_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("products.id", ondelete="CASCADE")
    )

    version: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(
        String(16), server_default=text(f"'{VERSION_BORRADOR}'")
    )

    name: Mapped[str] = mapped_column(Text)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    materials: Mapped[str | None] = mapped_column(Text, nullable=True)
    origin_country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    manufacturer: Mapped[str | None] = mapped_column(Text, nullable=True)

    #: NULOS, y nulo NO es gratis: es «sin precio configurado».
    price_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    currency: Mapped[str | None] = mapped_column(String(3), nullable=True)

    content_sha256: Mapped[str] = mapped_column(Text)

    created_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    published_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    published_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    effective_from: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    effective_to: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        CheckConstraint(
            f"status in ({', '.join(repr(e) for e in ESTADOS_DE_VERSION)})",
            name="product_versions_estado",
        ),
        CheckConstraint(
            f"status <> '{VERSION_PUBLICADA}' or published_at is not null",
            name="product_versions_publicada_con_fecha",
        ),
        CheckConstraint(
            "(price_minor is null) = (currency is null)",
            name="product_versions_precio_con_moneda",
        ),
        CheckConstraint(
            "price_minor is null or price_minor >= 0",
            name="product_versions_precio",
        ),
        UniqueConstraint("product_id", "version", name="product_versions_unica"),
        Index(
            "product_versions_vigente",
            "product_id",
            unique=True,
            postgresql_where=text(
                f"status = '{VERSION_PUBLICADA}' and effective_to is null"
            ),
            sqlite_where=text(
                f"status = '{VERSION_PUBLICADA}' and effective_to is null"
            ),
        ),
        Index(
            "product_versions_un_borrador",
            "product_id",
            unique=True,
            postgresql_where=text(f"status = '{VERSION_BORRADOR}'"),
            sqlite_where=text(f"status = '{VERSION_BORRADOR}'"),
        ),
    )


class ProductVariant(Base):
    """Talla, color, modelo. De la VERSIÓN, no del producto.

    SIN EXISTENCIAS a propósito: cuántas hay es inventario, y una columna
    `stock` aquí invitaría a venderla sin reservas ni concurrencia.
    """

    __tablename__ = "product_variants"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    version_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_versions.id", ondelete="CASCADE")
    )
    sku: Mapped[str] = mapped_column(String(48))
    name: Mapped[str] = mapped_column(Text)
    options: Mapped[dict] = mapped_column(_opciones, default=dict)
    price_delta_minor: Mapped[int] = mapped_column(BigInteger, server_default=text("0"))
    position: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint("version_id", "sku", name="product_variants_sku_unico"),
        Index("product_variants_de_la_version", "version_id", "position", "sku"),
    )


#: El estado de una fotografía (0073). SUBIR NO ES PUBLICAR: nace pendiente.
FOTO_PENDIENTE = "pending"
FOTO_APROBADA = "approved"
FOTO_RECHAZADA = "rejected"
ESTADOS_DE_FOTO = (FOTO_PENDIENTE, FOTO_APROBADA, FOTO_RECHAZADA)

#: Los tres tipos que admite el depósito `product-media`. LISTA CERRADA, y sin
#: `image/svg+xml`: un SVG es un documento con scripts, no una fotografía.
TIPOS_DE_IMAGEN = ("image/jpeg", "image/png", "image/webp")

#: Qué extensión le pone el servidor a cada tipo. El nombre lo genera él: el que
#: trae quien sube puede llevar rutas, puntos y cosas que el almacenamiento
#: interpreta.
EXTENSION_DE_LA_IMAGEN = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}

#: Tope por archivo, el mismo que el depósito declara en la 0073.
MAXIMO_BYTES_DE_LA_FOTO = 10 * 1024 * 1024

#: Cuántas fotos admite una versión. EL BLUEPRINT NO FIJA EL NÚMERO: la captura
#: 6 enseña una galería «1/5», así que cinco es lo que la referencia visual
#: sostiene. Se cuenta en el servidor porque un CHECK no cuenta filas.
MAXIMO_DE_FOTOS = 5


class ProductMedia(Base):
    """La galería. Guarda la RUTA, nunca una URL firmada.

    SUBIR NO ES PUBLICAR (0073). Una foto nace `pending`, quien evalúa la
    aprueba o la rechaza con motivo, y el catálogo SOLO firma las aprobadas.
    Sin este estado, aprobar un producto aprobaría también cualquier fotografía
    que le añadieran después.
    """

    __tablename__ = "product_media"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    version_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_versions.id", ondelete="CASCADE")
    )
    kind: Mapped[str] = mapped_column(String(8), server_default=text("'image'"))
    storage_path: Mapped[str] = mapped_column(Text)
    alt_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    position: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    created_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    status: Mapped[str] = mapped_column(
        Text, server_default=text(f"'{FOTO_PENDIENTE}'")
    )
    #: LO QUE MIDIÓ EL SERVIDOR al recibir los bytes, no lo que declaró quien
    #: sube: un `Content-Type` lo escribe el cliente.
    content_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    byte_size: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    checksum_sha256: Mapped[str | None] = mapped_column(Text, nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    reviewed_by: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )
    rejection_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (
        CheckConstraint("kind in ('image', 'video')", name="product_media_tipo"),
        CheckConstraint(
            f"status in ({', '.join(repr(e) for e in ESTADOS_DE_FOTO)})",
            name="product_media_estado",
        ),
        CheckConstraint(
            f"status = '{FOTO_PENDIENTE}' or reviewed_at is not null",
            name="product_media_decidida_con_fecha",
        ),
        CheckConstraint(
            f"status <> '{FOTO_RECHAZADA}' or "
            "(rejection_reason is not null and length(trim(rejection_reason)) >= 3)",
            name="product_media_rechazo_con_motivo",
        ),
        CheckConstraint(
            f"status <> '{FOTO_APROBADA}' or "
            "(content_type is not null and byte_size is not null and byte_size > 0)",
            name="product_media_aprobada_con_archivo",
        ),
        CheckConstraint(
            "content_type is null or content_type in "
            f"({', '.join(repr(t) for t in TIPOS_DE_IMAGEN)})",
            name="product_media_tipo_de_archivo",
        ),
        CheckConstraint(
            "(width is null or width > 0) and (height is null or height > 0) "
            "and (byte_size is null or byte_size > 0)",
            name="product_media_medidas",
        ),
        CheckConstraint(
            "storage_path not like '%://%' and storage_path not like '/%'",
            name="product_media_ruta_no_es_url",
        ),
        UniqueConstraint("version_id", "storage_path", name="product_media_ruta_unica"),
        Index("product_media_de_la_version", "version_id", "position", "id"),
        Index(
            "product_media_aprobadas",
            "version_id",
            "position",
            "id",
            postgresql_where=text(f"status = '{FOTO_APROBADA}'"),
            sqlite_where=text(f"status = '{FOTO_APROBADA}'"),
        ),
        Index("product_media_por_ruta", "storage_path"),
    )


# --------------------------------------------------------------------------- #
# Admisión: la postulación del proveedor (0071)
# --------------------------------------------------------------------------- #
POSTULACION_BORRADOR = "draft"
POSTULACION_ENVIADA = "submitted"
POSTULACION_EN_REVISION = "under_review"
POSTULACION_ACEPTADA = "accepted"
POSTULACION_RECHAZADA = "rejected"
POSTULACION_RETIRADA = "withdrawn"

ESTADOS_DE_POSTULACION = (
    POSTULACION_BORRADOR,
    POSTULACION_ENVIADA,
    POSTULACION_EN_REVISION,
    POSTULACION_ACEPTADA,
    POSTULACION_RECHAZADA,
    POSTULACION_RETIRADA,
)

#: Las que ocupan sitio: mientras una esté así, no se abre otra del mismo
#: perfil. Tiene que coincidir letra por letra con el índice parcial de la 0071.
POSTULACIONES_VIVAS = (
    POSTULACION_BORRADOR,
    POSTULACION_ENVIADA,
    POSTULACION_EN_REVISION,
)

#: Los del blueprint §5.1, como códigos. Una lista en prosa no se puede exigir.
DOCUMENTOS = (
    "identity",
    "tax_data",
    "bank_account",
    "manufacturer",
    "materials_and_batch",
    "warranty_procedure",
    "permits",
    "photos",
    "other",
)


class SellerApplication(Base):
    """Postular para ser proveedor. Del PERFIL, no del `product_seller`."""

    __tablename__ = "seller_applications"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    profile_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE")
    )
    status: Mapped[str] = mapped_column(
        String(16), server_default=text(f"'{POSTULACION_BORRADOR}'")
    )
    display_name: Mapped[str] = mapped_column(Text)
    proposal: Mapped[str] = mapped_column(Text)

    submitted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    decided_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    decided_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    #: EL MOTIVO QUE SE LE ENSEÑA. Las notas internas van aparte a propósito.
    decision_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    internal_notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            f"status in ({', '.join(repr(e) for e in ESTADOS_DE_POSTULACION)})",
            name="seller_applications_estado",
        ),
        CheckConstraint(
            f"status = '{POSTULACION_BORRADOR}' or submitted_at is not null",
            name="seller_applications_enviada_con_fecha",
        ),
        CheckConstraint(
            f"status not in ('{POSTULACION_ACEPTADA}', '{POSTULACION_RECHAZADA}')"
            " or decided_at is not null",
            name="seller_applications_decidida_con_fecha",
        ),
        CheckConstraint(
            f"status <> '{POSTULACION_RECHAZADA}'"
            " or length(trim(coalesce(decision_reason, ''))) > 0",
            name="seller_applications_rechazo_con_motivo",
        ),
        Index(
            "seller_applications_una_viva",
            "profile_id",
            unique=True,
            postgresql_where=text(
                "status in (" + ", ".join(repr(e) for e in POSTULACIONES_VIVAS) + ")"
            ),
            sqlite_where=text(
                "status in (" + ", ".join(repr(e) for e in POSTULACIONES_VIVAS) + ")"
            ),
        ),
    )


class SellerApplicationDocument(Base):
    """Lo que se presentó. Una ruta o una nota, no los dos vacíos."""

    __tablename__ = "seller_application_documents"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    application_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("seller_applications.id", ondelete="CASCADE")
    )
    kind: Mapped[str] = mapped_column(String(24))
    storage_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            f"kind in ({', '.join(repr(k) for k in DOCUMENTOS)})",
            name="seller_application_documents_tipo",
        ),
        CheckConstraint(
            "length(trim(coalesce(storage_path, ''))) > 0"
            " or length(trim(coalesce(note, ''))) > 0",
            name="seller_application_documents_algo",
        ),
        Index(
            "seller_application_documents_de_la_postulacion",
            "application_id",
            "kind",
        ),
    )


# --------------------------------------------------------------------------- #
# Evaluación (0071)
# --------------------------------------------------------------------------- #
EVALUACION_BORRADOR = "draft"
EVALUACION_DECIDIDA = "decided"

DECISION_APROBADO = "approved"
DECISION_CONDICIONADO = "conditionally_approved"
DECISION_RECHAZADO = "rejected"
DECISIONES = (DECISION_APROBADO, DECISION_CONDICIONADO, DECISION_RECHAZADO)

#: Las seis dimensiones del blueprint §5.2 con su peso. Transcritas, no
#: inventadas. El peso se COPIA a cada fila al puntuar: la matriz puede cambiar
#: y una decisión pasada tiene que poder explicarse con sus propios números.
DIMENSIONES: dict[str, int] = {
    "quality": 25,
    "design": 20,
    "usefulness": 20,
    "durability": 15,
    "origin": 10,
    "warranty": 10,
}

#: Rechazo directo, SIN compensación por puntaje (blueprint §5.2).
FALLAS_CRITICAS = (
    "safety",
    "counterfeit",
    "misleading_advertising",
    "unverifiable_origin",
    "missing_permits",
    "tampered_evidence",
)

#: Qué cuenta como evidencia. Los tipos salen de la columna «evidencia mínima».
TIPOS_DE_EVIDENCIA = (
    "functional_test",
    "inspection",
    "usage_review",
    "problem_and_result",
    "materials",
    "batch",
    "warranty_policy",
    "photo",
    "document",
    "sample",
)


class ProductEvaluation(Base):
    """La evaluación de una VERSIÓN. No del producto: se evalúa lo que se
    publica."""

    __tablename__ = "product_evaluations"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    product_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("products.id", ondelete="CASCADE")
    )
    version_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_versions.id", ondelete="CASCADE")
    )
    evaluator_id: Mapped[str] = mapped_column(Uuid(as_uuid=False))
    status: Mapped[str] = mapped_column(
        String(16), server_default=text(f"'{EVALUACION_BORRADOR}'")
    )

    #: EN CENTÉSIMAS DE PUNTO: 9 000 son 90,00. Nula mientras no se decide, y
    #: nula NO es cero.
    score_total: Mapped[int | None] = mapped_column(Integer, nullable=True)
    decision: Mapped[str | None] = mapped_column(String(24), nullable=True)
    critical_failure: Mapped[str | None] = mapped_column(String(32), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    decided_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            f"status in ('{EVALUACION_BORRADOR}', '{EVALUACION_DECIDIDA}')",
            name="product_evaluations_estado",
        ),
        CheckConstraint(
            "decision is null or decision in ("
            + ", ".join(repr(d) for d in DECISIONES)
            + ")",
            name="product_evaluations_decision",
        ),
        CheckConstraint(
            "critical_failure is null or critical_failure in ("
            + ", ".join(repr(f) for f in FALLAS_CRITICAS)
            + ")",
            name="product_evaluations_falla",
        ),
        CheckConstraint(
            "score_total is null or (score_total >= 0 and score_total <= 10000)",
            name="product_evaluations_puntuacion",
        ),
        CheckConstraint(
            f"status <> '{EVALUACION_DECIDIDA}'"
            " or (decision is not null and decided_at is not null)",
            name="product_evaluations_decidida_con_decision",
        ),
        # UNA FALLA CRÍTICA SOLO PUEDE ACABAR EN RECHAZO.
        CheckConstraint(
            "critical_failure is null or decision is null"
            f" or decision = '{DECISION_RECHAZADO}'",
            name="product_evaluations_falla_rechaza",
        ),
        CheckConstraint(
            f"decision is null or decision = '{DECISION_RECHAZADO}'"
            " or score_total is not null",
            name="product_evaluations_aprobada_con_puntuacion",
        ),
        Index(
            "product_evaluations_una_viva",
            "version_id",
            unique=True,
            postgresql_where=text(f"status = '{EVALUACION_BORRADOR}'"),
            sqlite_where=text(f"status = '{EVALUACION_BORRADOR}'"),
        ),
        Index("product_evaluations_del_producto", "product_id", "created_at"),
    )


class ProductEvaluationScore(Base):
    """Una dimensión puntuada, con su peso CONGELADO."""

    __tablename__ = "product_evaluation_scores"

    evaluation_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("product_evaluations.id", ondelete="CASCADE"),
        primary_key=True,
    )
    dimension: Mapped[str] = mapped_column(String(16), primary_key=True)
    score: Mapped[int] = mapped_column(Integer)
    weight: Mapped[int] = mapped_column(Integer)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "dimension in (" + ", ".join(repr(d) for d in DIMENSIONES) + ")",
            name="product_evaluation_scores_dimension",
        ),
        CheckConstraint(
            "score >= 0 and score <= 100", name="product_evaluation_scores_puntuacion"
        ),
        CheckConstraint(
            "weight >= 0 and weight <= 100", name="product_evaluation_scores_peso"
        ),
    )


class ProductEvaluationEvidence(Base):
    """Lo que se miró. Sin esto una puntuación no se sostiene."""

    __tablename__ = "product_evaluation_evidence"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    evaluation_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_evaluations.id", ondelete="CASCADE")
    )
    dimension: Mapped[str] = mapped_column(String(16))
    kind: Mapped[str] = mapped_column(String(24))
    summary: Mapped[str] = mapped_column(Text)
    storage_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "dimension in (" + ", ".join(repr(d) for d in DIMENSIONES) + ")",
            name="product_evaluation_evidence_dimension",
        ),
        CheckConstraint(
            "kind in (" + ", ".join(repr(k) for k in TIPOS_DE_EVIDENCIA) + ")",
            name="product_evaluation_evidence_tipo",
        ),
        Index(
            "product_evaluation_evidence_de_la_evaluacion",
            "evaluation_id",
            "dimension",
        ),
    )


#: EXACTAMENTE TRES (blueprint §4.1). El tope lo pone el CHECK de posición; que
#: estén las tres al publicar lo comprueba el código.
RAZONES_EXIGIDAS = 3


class ProductApprovalReason(Base):
    """Una de las tres razones que lee quien compra.

    `evidence_id` es NOT NULL a propósito: es lo que hace imposible que «Por qué
    está en Z» enseñe una frase que nadie respaldó.
    """

    __tablename__ = "product_approval_reasons"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    version_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_versions.id", ondelete="CASCADE")
    )
    evaluation_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_evaluations.id", ondelete="CASCADE")
    )
    evidence_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("product_evaluation_evidence.id", ondelete="RESTRICT"),
    )
    text: Mapped[str] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer)
    created_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            f"position >= 1 and position <= {RAZONES_EXIGIDAS}",
            name="product_approval_reasons_posicion",
        ),
        UniqueConstraint(
            "version_id", "position", name="product_approval_reasons_una_por_posicion"
        ),
        Index("product_approval_reasons_de_la_version", "version_id", "position"),
    )


# --------------------------------------------------------------------------- #
# Guardados (0072)
# --------------------------------------------------------------------------- #
class SavedProduct(Base):
    """Guardar no reserva nada, no tiene cantidad y no lleva a pagar."""

    __tablename__ = "saved_products"

    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), primary_key=True
    )
    product_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("products.id", ondelete="CASCADE"), primary_key=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (Index("saved_products_mios", "user_id", text("created_at desc")),)


# --------------------------------------------------------------------------- #
# Inventario (0074)
# --------------------------------------------------------------------------- #
#: Los cinco movimientos, y ninguno más.
ENTRADA = "intake"
AJUSTE = "adjustment"
RESERVA = "reservation"
LIBERACION = "release"
SALIDA = "dispatch"
MOVIMIENTOS = (ENTRADA, AJUSTE, RESERVA, LIBERACION, SALIDA)

#: Quién puede firmar un movimiento. `system` queda para el checkout.
ACTOR_PROVEEDOR = "seller"
ACTOR_ADMINISTRACION = "admin"
ACTOR_SISTEMA = "system"
ACTORES_DE_INVENTARIO = (ACTOR_PROVEEDOR, ACTOR_ADMINISTRACION, ACTOR_SISTEMA)

#: Tope técnico de un movimiento. No es una regla comercial: está para que un
#: cliente roto no mande un número que desborde la columna.
MAXIMO_DEL_MOVIMIENTO = 1_000_000


class ProductInventory(Base):
    """Cuántas hay y cuántas están comprometidas. UNA FILA POR (PRODUCTO, SKU).

    NO CUELGA DE LA VARIANTE. Una variante pertenece a una versión inmutable:
    publicar otra crearía filas nuevas para las mismas cajas del mismo almacén,
    y el inventario quedaría huérfano en cada publicación. El SKU es,
    literalmente, la unidad de almacén, y es lo único estable entre versiones.

    SIN COLUMNA `available`, y es la decisión que más pesa: lo disponible es
    `on_hand - reserved`, se calcula, y guardarlo además crearía dos verdades
    que divergen la primera vez que alguien escriba una y olvide la otra.
    """

    __tablename__ = "product_inventory"

    product_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("products.id", ondelete="CASCADE"),
        primary_key=True,
    )
    sku: Mapped[str] = mapped_column(Text, primary_key=True)
    on_hand: Mapped[int] = mapped_column(BigInteger, server_default=text("0"))
    reserved: Mapped[int] = mapped_column(BigInteger, server_default=text("0"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("on_hand >= 0", name="product_inventory_existencia"),
        CheckConstraint("reserved >= 0", name="product_inventory_reservado"),
        #: NO SE COMPROMETE LO QUE NO HAY. Es lo que impide que lo disponible
        #: salga negativo sin necesidad de guardarlo.
        CheckConstraint(
            "reserved <= on_hand", name="product_inventory_reservado_cabe"
        ),
        CheckConstraint(
            "length(trim(sku)) between 1 and 48", name="product_inventory_sku"
        ),
    )

    @property
    def available(self) -> int:
        """Lo que se puede vender ahora mismo. SE CALCULA, no se guarda."""
        return int(self.on_hand) - int(self.reserved)


class InventoryMovement(Base):
    """El historial. SOLO SE AÑADE: un disparador rechaza `update` y `delete`.

    El identificador SE DERIVA de la clave de idempotencia, así que la segunda
    petición con la misma clave choca contra la clave primaria antes de mover
    nada.
    """

    __tablename__ = "inventory_movements"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    product_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("products.id", ondelete="RESTRICT")
    )
    sku: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(Text)
    quantity: Mapped[int] = mapped_column(BigInteger)
    on_hand_after: Mapped[int] = mapped_column(BigInteger)
    reserved_after: Mapped[int] = mapped_column(BigInteger)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: SIN CLAVE AJENA: `on delete set null` exige un `update` sobre esta tabla
    #: y el disparador de la 0074 lo rechaza. Quien firmó un movimiento es un
    #: hecho del pasado, y sigue siendo cierto aunque esa cuenta desaparezca.
    actor_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    actor_role: Mapped[str] = mapped_column(Text)
    idempotency_key: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            f"kind in ({', '.join(repr(k) for k in MOVIMIENTOS)})",
            name="inventory_movements_tipo",
        ),
        CheckConstraint(
            f"quantity <> 0 and abs(quantity) <= {MAXIMO_DEL_MOVIMIENTO}",
            name="inventory_movements_cantidad",
        ),
        CheckConstraint(
            f"kind = '{AJUSTE}' or quantity > 0",
            name="inventory_movements_solo_el_ajuste_resta",
        ),
        CheckConstraint(
            "on_hand_after >= 0", name="inventory_movements_existencia_despues"
        ),
        CheckConstraint(
            "reserved_after >= 0", name="inventory_movements_reservado_despues"
        ),
        CheckConstraint(
            f"kind <> '{AJUSTE}' or "
            "(reason is not null and length(trim(reason)) >= 3)",
            name="inventory_movements_ajuste_con_motivo",
        ),
        CheckConstraint(
            f"actor_role in ({', '.join(repr(a) for a in ACTORES_DE_INVENTARIO)})",
            name="inventory_movements_actor",
        ),
        CheckConstraint(
            "length(trim(sku)) between 1 and 48", name="inventory_movements_sku"
        ),
        UniqueConstraint(
            "product_id",
            "sku",
            "idempotency_key",
            name="inventory_movements_clave_unica",
        ),
        Index(
            "inventory_movements_de_la_unidad",
            "product_id",
            "sku",
            text("created_at desc"),
            text("id desc"),
        ),
    )


# --------------------------------------------------------------------------- #
# Carrito (0075)
# --------------------------------------------------------------------------- #
#: Tope técnico de una línea. Lo que de verdad limita es la disponibilidad.
MAXIMO_POR_LINEA = 1000


class ProductCart(Base):
    """UNA PERSONA, UN CARRITO. Y es la fila que se bloquea para ordenar
    cualquier cambio: es lo que hace que un doble toque no sume dos."""

    __tablename__ = "product_carts"

    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        primary_key=True,
    )
    #: La de la primera línea. NULA mientras esté vacío, y nula no es una
    #: moneda por defecto: sumar soles con euros da un número que no es dinero.
    currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ProductCartItem(Base):
    """Una línea: producto, versión y variante. NO RESERVA NADA."""

    __tablename__ = "product_cart_items"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_carts.user_id", ondelete="CASCADE")
    )
    product_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("products.id", ondelete="CASCADE")
    )
    version_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_versions.id", ondelete="CASCADE")
    )
    variant_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_variants.id", ondelete="CASCADE")
    )
    quantity: Mapped[int] = mapped_column(Integer)
    #: LO QUE SE VEÍA AL AÑADIR. Sirve para AVISAR de que cambió, no para
    #: cobrarlo: congelar el precio ocurre al crear el pedido.
    seen_price_minor: Mapped[int] = mapped_column(BigInteger)
    seen_currency: Mapped[str] = mapped_column(String(3))
    #: La última operación aplicada a esta línea. Un reintento con la misma
    #: clave no vuelve a sumar.
    last_operation_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            f"quantity >= 1 and quantity <= {MAXIMO_POR_LINEA}",
            name="product_cart_items_cantidad",
        ),
        CheckConstraint(
            "seen_price_minor >= 0", name="product_cart_items_precio"
        ),
        UniqueConstraint(
            "user_id",
            "product_id",
            "version_id",
            "variant_id",
            name="product_cart_items_una_linea",
        ),
        Index("product_cart_items_del_carrito", "user_id", "created_at", "id"),
        Index("product_cart_items_del_producto", "product_id"),
    )


# --------------------------------------------------------------------------- #
# La politica de venta por jurisdiccion (0077)
# --------------------------------------------------------------------------- #
#: SIN POLITICA APROBADA PARA LA JURISDICCION, NO SE VENDE. Una en borrador
#: existe para poder revisarla; solo la publicada y vigente habilita un pedido.
POLITICA_BORRADOR = "draft"
POLITICA_PUBLICADA = "published"
POLITICA_RETIRADA = "retired"
ESTADOS_DE_POLITICA = (POLITICA_BORRADOR, POLITICA_PUBLICADA, POLITICA_RETIRADA)


class ProductPolicy(Base):
    """Las condiciones de venta de un pais, en una version concreta.

    LO QUE CONGELA UN PEDIDO ES ESTA FILA. Publicar la siguiente version no le
    cambia las reglas a quien ya compro: su pedido guarda el identificador, la
    version y la huella del texto.
    """

    __tablename__ = "product_policies"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    country_code: Mapped[str] = mapped_column(String(2))
    seller_entity: Mapped[str] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer)
    #: LA UNICA MONEDA en la que se puede cobrar en ese pais.
    currency: Mapped[str] = mapped_column(String(3))
    terms: Mapped[str] = mapped_column(Text)
    terms_sha256: Mapped[str] = mapped_column(Text)

    #: LOS PLAZOS. Nulos mientras nadie los decida, y NULO NO ES CERO: cero
    #: horas para reportar una incidencia seria no tener derecho a reportarla.
    incident_report_hours: Mapped[int | None] = mapped_column(Integer, nullable=True)
    return_shipment_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    withdrawal_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    buyer_pays_return_for_remorse: Mapped[bool | None] = mapped_column(
        Boolean, nullable=True
    )
    seller_pays_return_for_defect: Mapped[bool | None] = mapped_column(
        Boolean, nullable=True
    )
    warranty_rules_url: Mapped[str | None] = mapped_column(Text, nullable=True)

    status: Mapped[str] = mapped_column(Text, default=POLITICA_BORRADOR)
    effective_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    published_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    #: Sin clave ajena: quien publico una politica es un hecho del pasado.
    published_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "status in ('draft', 'published', 'retired')",
            name="product_policies_estado",
        ),
        CheckConstraint("version >= 1", name="product_policies_version"),
        #: PUBLICAR EXIGE ESTAR COMPLETA. Es el CHECK que convierte «sin
        #: politica aprobada no se vende» en una regla de la base.
        CheckConstraint(
            "status <> 'published' or ("
            " effective_at is not null and published_at is not null"
            " and withdrawal_days is not null"
            " and incident_report_hours is not null"
            " and return_shipment_days is not null"
            " and buyer_pays_return_for_remorse is not null"
            " and seller_pays_return_for_defect is not null)",
            name="product_policies_publicada_esta_completa",
        ),
        UniqueConstraint(
            "country_code", "version", name="product_policies_una_version"
        ),
        Index(
            "product_policies_vigente",
            "country_code",
            text("effective_at desc"),
            text("version desc"),
            postgresql_where=text("status = 'published'"),
            sqlite_where=text("status = 'published'"),
        ),
    )


# --------------------------------------------------------------------------- #
# El pedido fisico (0078)
# --------------------------------------------------------------------------- #
PEDIDO_PENDIENTE = "PENDING_PAYMENT"
PEDIDO_PROCESANDO = "PAYMENT_PROCESSING"
PEDIDO_PAGADO = "PAID"
PEDIDO_FALLIDO = "PAYMENT_FAILED"
PEDIDO_VENCIDO = "EXPIRED"
PEDIDO_CANCELADO = "CANCELLED"
#: EL PAGO QUE LLEGO TARDE. Ni se cobra en silencio ni se niega en silencio:
#: queda explicito y lo mira una persona.
PEDIDO_EN_REVISION = "UNDER_REVIEW"

ESTADOS_DE_PEDIDO = (
    PEDIDO_PENDIENTE,
    PEDIDO_PROCESANDO,
    PEDIDO_PAGADO,
    PEDIDO_FALLIDO,
    PEDIDO_VENCIDO,
    PEDIDO_CANCELADO,
    PEDIDO_EN_REVISION,
)

#: Los que todavia pueden pagarse, y por tanto los que siguen apartando.
PEDIDO_EN_CURSO = (PEDIDO_PENDIENTE, PEDIDO_PROCESANDO)

#: Los que TODAVIA APARTAN UNIDADES, que no es lo mismo.
#:
#: LA REVISION INDEPENDIENTE ENCONTRO AQUI EL PEOR DEFECTO DEL INCREMENTO. El
#: barrido de vencimiento miraba `PEDIDO_EN_CURSO`, asi que un pedido que caia
#: en `PAYMENT_FAILED` —lo provoca cualquier tarjeta rechazada— o en
#: `UNDER_REVIEW` salia de esa lista con la reserva puesta y YA NO LA SOLTABA
#: NADIE, NUNCA: ni el barrido, que no lo veia; ni cancelar, que lo rechazaba;
#: ni el reintento, que exige que la reserva siga viva. Las unidades se quedaban
#: apartadas para siempre, y el mismo comprador podia repetirlo.
#:
#: Por eso hay DOS listas y no una. `PEDIDO_EN_CURSO` es «todavia se puede
#: pagar»; esta es «todavia tiene unidades apartadas», y es la que gobierna el
#: vencimiento y el candado de un pedido vivo a la vez.
PEDIDO_RETIENE = (
    PEDIDO_PENDIENTE,
    PEDIDO_PROCESANDO,
    PEDIDO_FALLIDO,
    PEDIDO_EN_REVISION,
)

#: EL ULTIMO ENTERO QUE JAVASCRIPT REPRESENTA SIN PERDER PRECISION. Estos
#: importes viajan en un JSON que lee JavaScript: por encima, el cliente veria
#: otro numero.
MAXIMO_SEGURO_EN_JS = 9_007_199_254_740_991


class ProductOrder(Base):
    """Un pedido fisico. UN PEDIDO, UN PROVEEDOR."""

    __tablename__ = "product_orders"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    buyer_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="RESTRICT")
    )
    seller_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_sellers.id", ondelete="RESTRICT")
    )

    status: Mapped[str] = mapped_column(Text, default=PEDIDO_PENDIENTE)
    currency: Mapped[str] = mapped_column(String(3))
    subtotal_minor: Mapped[int] = mapped_column(BigInteger)
    total_minor: Mapped[int] = mapped_column(BigInteger)

    provider: Mapped[str] = mapped_column(Text, default="none")
    environment: Mapped[str] = mapped_column(Text)
    external_payment_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    operation_ref: Mapped[str | None] = mapped_column(Text, nullable=True)

    idempotency_key: Mapped[str] = mapped_column(Text)
    request_fingerprint: Mapped[str] = mapped_column(Text)

    #: QUE POLITICA ACEPTO, con su huella. Es lo que permite demostrar despues
    #: que a esa persona se le enseno exactamente ese texto.
    policy_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_policies.id", ondelete="RESTRICT")
    )
    policy_version: Mapped[int] = mapped_column(Integer)
    policy_terms_sha256: Mapped[str] = mapped_column(Text)
    policy_country: Mapped[str] = mapped_column(String(2))
    policy_accepted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    #: HASTA CUANDO APARTA, y cuando dejo de apartar. La segunda es la marca
    #: que hace que liberar ocurra UNA VEZ.
    reserved_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    reservation_settled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    paid_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    cancelled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    failed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    expired_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    review_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "status in ('PENDING_PAYMENT', 'PAYMENT_PROCESSING', 'PAID',"
            " 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED', 'UNDER_REVIEW')",
            name="product_orders_estado",
        ),
        CheckConstraint(
            f"subtotal_minor >= 0 and subtotal_minor <= {MAXIMO_SEGURO_EN_JS}",
            name="product_orders_subtotal",
        ),
        CheckConstraint(
            f"total_minor >= 0 and total_minor <= {MAXIMO_SEGURO_EN_JS}",
            name="product_orders_total",
        ),
        #: HOY `total = subtotal`. Impuestos, envio y comision no estan
        #: decididos: un total distinto seria un cargo inventado.
        CheckConstraint(
            "total_minor = subtotal_minor",
            name="product_orders_total_es_el_subtotal",
        ),
        CheckConstraint(
            "provider in ('none', 'stripe')", name="product_orders_pasarela"
        ),
        CheckConstraint(
            "environment in ('sandbox', 'production')", name="product_orders_entorno"
        ),
        CheckConstraint("policy_version >= 1", name="product_orders_politica_version"),
        #: UN PEDIDO PAGADO TIENE CON QUE DEMOSTRARLO.
        CheckConstraint(
            "status <> 'PAID' or (paid_at is not null"
            " and external_payment_id is not null and provider <> 'none')",
            name="product_orders_pagada_con_cobro",
        ),
        CheckConstraint(
            "status <> 'CANCELLED' or cancelled_at is not null",
            name="product_orders_cancelada_con_fecha",
        ),
        CheckConstraint(
            "status <> 'EXPIRED' or expired_at is not null",
            name="product_orders_vencida_con_fecha",
        ),
        CheckConstraint(
            "status <> 'PAYMENT_FAILED' or failed_at is not null",
            name="product_orders_fallida_con_fecha",
        ),
        CheckConstraint(
            "status <> 'UNDER_REVIEW' or review_reason is not null",
            name="product_orders_revision_con_motivo",
        ),
        UniqueConstraint(
            "buyer_id", "idempotency_key", name="product_orders_una_clave"
        ),
        #: REDUNDANTE A PROPOSITO (0081). `id` ya es clave primaria, asi que
        #: esto no impide nada nuevo. Existe porque una resena verificada ata
        #: `(order_id, author_id, order_paid_at)` contra estas tres columnas con
        #: una clave ajena compuesta, y PostgreSQL exige que el lado padre sea
        #: unico. Es lo que hace que «compra verificada» no sea un `if`.
        UniqueConstraint(
            "id", "buyer_id", "paid_at", name="product_orders_comprador_y_cobro"
        ),
        Index(
            "product_orders_del_comprador",
            "buyer_id",
            text("created_at desc"),
            text("id desc"),
        ),
        Index(
            "product_orders_del_proveedor",
            "seller_id",
            text("created_at desc"),
            text("id desc"),
            postgresql_where=text("status = 'PAID'"),
            sqlite_where=text("status = 'PAID'"),
        ),
        #: POR LA RESERVA Y NO POR EL ESTADO: ver la 0078.
        Index(
            "product_orders_por_vencer",
            "reserved_until",
            "id",
            postgresql_where=text(
                "reservation_settled_at is null and status <> 'PAID'"
            ),
            sqlite_where=text(
                "reservation_settled_at is null and status <> 'PAID'"
            ),
        ),
        Index(
            "product_orders_por_cobro",
            "provider",
            "environment",
            "external_payment_id",
            postgresql_where=text("external_payment_id is not null"),
            sqlite_where=text("external_payment_id is not null"),
        ),
        Index(
            "product_orders_en_revision",
            text("created_at desc"),
            text("id desc"),
            postgresql_where=text("status = 'UNDER_REVIEW'"),
            sqlite_where=text("status = 'UNDER_REVIEW'"),
        ),
    )


class ProductOrderItem(Base):
    """Una linea comprada. SOLO SE ANADE: lo impone un disparador."""

    __tablename__ = "product_order_items"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    order_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_orders.id", ondelete="CASCADE")
    )
    product_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("products.id", ondelete="RESTRICT")
    )
    version_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_versions.id", ondelete="RESTRICT")
    )
    variant_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_variants.id", ondelete="RESTRICT")
    )
    #: EL SKU ES LA UNIDAD DE ALMACEN, y por eso se copia: es con lo que se
    #: reserva y con lo que se despacha.
    sku: Mapped[str] = mapped_column(Text)

    name_snapshot: Mapped[str] = mapped_column(Text)
    variant_name_snapshot: Mapped[str | None] = mapped_column(Text, nullable=True)

    unit_price_minor: Mapped[int] = mapped_column(BigInteger)
    quantity: Mapped[int] = mapped_column(Integer)
    subtotal_minor: Mapped[int] = mapped_column(BigInteger)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "length(trim(sku)) between 1 and 48", name="product_order_items_sku"
        ),
        CheckConstraint(
            f"unit_price_minor >= 0 and unit_price_minor <= {MAXIMO_SEGURO_EN_JS}",
            name="product_order_items_precio",
        ),
        CheckConstraint(
            f"quantity >= 1 and quantity <= {MAXIMO_POR_LINEA}",
            name="product_order_items_cantidad",
        ),
        CheckConstraint(
            f"subtotal_minor >= 0 and subtotal_minor <= {MAXIMO_SEGURO_EN_JS}",
            name="product_order_items_subtotal",
        ),
        UniqueConstraint(
            "order_id",
            "product_id",
            "version_id",
            "variant_id",
            name="product_order_items_una_linea",
        ),
        #: REDUNDANTE A PROPOSITO (0081), por lo mismo: la resena declara de que
        #: linea, de que pedido y de que producto habla, y las tres tienen que
        #: casar. Sin esto se podria resenar un producto que no venia en esa
        #: linea.
        UniqueConstraint(
            "id",
            "order_id",
            "product_id",
            name="product_order_items_del_pedido_y_producto",
        ),
        Index("product_order_items_del_pedido", "order_id", "created_at", "id"),
        Index("product_order_items_de_la_unidad", "product_id", "sku"),
    )


class ProductOrderAddress(Base):
    """La direccion de ESTE envio, congelada. No es una libreta.

    NI LATITUD NI LONGITUD. Una coordenada es la ubicacion exacta de la casa de
    alguien; para entregar un paquete basta la direccion escrita.
    """

    __tablename__ = "product_order_addresses"

    order_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("product_orders.id", ondelete="CASCADE"),
        primary_key=True,
    )
    recipient_name: Mapped[str] = mapped_column(Text)
    phone: Mapped[str] = mapped_column(Text)
    country_code: Mapped[str] = mapped_column(String(2))
    region: Mapped[str] = mapped_column(Text)
    city: Mapped[str] = mapped_column(Text)
    district: Mapped[str | None] = mapped_column(Text, nullable=True)
    address_line: Mapped[str] = mapped_column(Text)
    reference: Mapped[str | None] = mapped_column(Text, nullable=True)
    postal_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    instructions: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ProductOrderEvent(Base):
    """Un cambio de estado. SOLO SE ANADE, y sin datos personales."""

    __tablename__ = "product_order_events"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    order_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_orders.id", ondelete="RESTRICT")
    )
    from_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    to_status: Mapped[str] = mapped_column(Text)
    #: Sin clave ajena: quien movio un pedido es un hecho del pasado.
    actor_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    actor_role: Mapped[str] = mapped_column(Text)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "actor_role in ('buyer', 'seller', 'admin', 'system')",
            name="product_order_events_rol",
        ),
        Index("product_order_events_del_pedido", "order_id", "created_at", "id"),
    )


# --------------------------------------------------------------------------- #
# El envio del pedido pagado (0079)
# --------------------------------------------------------------------------- #
#: Pedido pagado que todavia no ha tocado nadie. NO ES UNA FILA: es lo que se
#: contesta mientras no exista. Ver `envios.del_pedido`.
ENVIO_PENDIENTE = "PENDING"
ENVIO_PREPARANDO = "PREPARING"
ENVIO_LISTO = "READY"
ENVIO_DESPACHADO = "DISPATCHED"
ENVIO_ENTREGADO = "DELIVERED"
ENVIO_FALLIDO = "DELIVERY_FAILED"
ENVIO_CANCELADO = "CANCELLED"

ESTADOS_DE_ENVIO = (
    ENVIO_PENDIENTE,
    ENVIO_PREPARANDO,
    ENVIO_LISTO,
    ENVIO_DESPACHADO,
    ENVIO_ENTREGADO,
    ENVIO_FALLIDO,
    ENVIO_CANCELADO,
)

#: Los que todavia apartan unidades: no han salido del almacen.
ENVIO_ANTES_DE_SALIR = (ENVIO_PENDIENTE, ENVIO_PREPARANDO, ENVIO_LISTO)

#: QUIEN AFIRMA QUE LLEGO. Administracion no aparece: no tiene como saberlo, y
#: escribirlo seria fabricar una entrega.
ENTREGA_LA_DICE_EL_PROVEEDOR = "seller"
ENTREGA_LA_DICE_EL_COMPRADOR = "buyer"
ORIGENES_DE_LA_ENTREGA = (
    ENTREGA_LA_DICE_EL_PROVEEDOR,
    ENTREGA_LA_DICE_EL_COMPRADOR,
)

#: Lo mismo que una linea de pedido, y por la misma razon.
MAXIMO_PREPARADO = 1000


class ProductShipment(Base):
    """El envio de UN pedido. UN PEDIDO, UN PAQUETE.

    NO HAY ENVIOS PARCIALES. Repartir un pedido en dos paquetes obliga a
    decidir quien paga el segundo porte y que pasa con lo que no salio, y
    ninguna politica publicada lo dice: un paquete sale entero o no sale.

    LA FILA NACE TARDE. No se crea al cobrar, sino con la primera accion sobre
    el envio; un pedido pagado sin fila se lee como `PENDING`, que es
    exactamente lo que es.
    """

    __tablename__ = "product_shipments"

    order_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("product_orders.id", ondelete="RESTRICT"),
        primary_key=True,
    )

    status: Mapped[str] = mapped_column(Text, default=ENVIO_PENDIENTE)

    #: TEXTO LIBRE Y OPCIONAL, mientras la empresa no elija transportista.
    #: NULO ES «NO LO DIJERON», nunca «no hay» ni «N/A».
    carrier_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    tracking_reference: Mapped[str | None] = mapped_column(Text, nullable=True)

    prepared_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    ready_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    dispatched_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    delivered_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    failed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    cancelled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    delivered_source: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: LA CONFIRMACION DE QUIEN COMPRA, APARTE. Y NO ES CONFORMIDAD: confirmar
    #: que llego no es decir que esta bien. Lo segundo libera dinero y es del
    #: Incremento 9.
    buyer_confirmed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    cancellation_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    #: LAS DOS MARCAS QUE HACEN QUE EL INVENTARIO SE TOQUE UNA SOLA VEZ, y son
    #: excluyentes: un envio o sale o se suelta.
    dispatch_settled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    release_settled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "status in ('PENDING', 'PREPARING', 'READY', 'DISPATCHED',"
            " 'DELIVERED', 'DELIVERY_FAILED', 'CANCELLED')",
            name="product_shipments_estado",
        ),
        CheckConstraint(
            "carrier_name is null or length(trim(carrier_name)) between 1 and 120",
            name="product_shipments_transportista",
        ),
        CheckConstraint(
            "tracking_reference is null"
            " or length(trim(tracking_reference)) between 1 and 120",
            name="product_shipments_referencia",
        ),
        CheckConstraint(
            "delivered_source is null or delivered_source in ('seller', 'buyer')",
            name="product_shipments_origen_de_la_entrega",
        ),
        CheckConstraint(
            "failure_reason is null"
            " or length(trim(failure_reason)) between 3 and 500",
            name="product_shipments_motivo_del_fallo",
        ),
        CheckConstraint(
            "cancellation_reason is null"
            " or length(trim(cancellation_reason)) between 3 and 500",
            name="product_shipments_motivo_de_la_cancelacion",
        ),
        #: UN ENVIO QUE SALIO TIENE CON QUE DEMOSTRARLO.
        CheckConstraint(
            "status not in ('DISPATCHED', 'DELIVERED', 'DELIVERY_FAILED')"
            " or (dispatched_at is not null and dispatch_settled_at is not null)",
            name="product_shipments_despachado_con_salida",
        ),
        CheckConstraint(
            "status <> 'DELIVERED' or delivered_at is not null",
            name="product_shipments_entregado_con_fecha",
        ),
        #: UNA ENTREGA SIEMPRE DICE QUIEN LA AFIRMA.
        CheckConstraint(
            "delivered_at is null or delivered_source is not null",
            name="product_shipments_entrega_con_origen",
        ),
        CheckConstraint(
            "status <> 'DELIVERY_FAILED'"
            " or (failed_at is not null and failure_reason is not null)",
            name="product_shipments_fallo_con_motivo",
        ),
        CheckConstraint(
            "status <> 'CANCELLED' or (cancelled_at is not null"
            " and cancellation_reason is not null"
            " and release_settled_at is not null)",
            name="product_shipments_cancelado_completo",
        ),
        #: NO SE PUEDE HABER SOLTADO Y CONSUMIDO LO MISMO.
        CheckConstraint(
            "dispatch_settled_at is null or release_settled_at is null",
            name="product_shipments_o_sale_o_se_suelta",
        ),
        CheckConstraint(
            "dispatch_settled_at is null or dispatched_at is not null",
            name="product_shipments_salida_con_fecha",
        ),
        CheckConstraint(
            "release_settled_at is null or status = 'CANCELLED'",
            name="product_shipments_soltado_esta_cancelado",
        ),
        Index(
            "product_shipments_sin_cerrar",
            "created_at",
            "order_id",
            postgresql_where=text("status not in ('DELIVERED', 'CANCELLED')"),
            sqlite_where=text("status not in ('DELIVERED', 'CANCELLED')"),
        ),
        Index(
            "product_shipments_antes_de_salir",
            "status",
            "order_id",
            postgresql_where=text(
                "dispatch_settled_at is null and release_settled_at is null"
            ),
            sqlite_where=text(
                "dispatch_settled_at is null and release_settled_at is null"
            ),
        ),
        #: REDUNDANTE A PROPOSITO (0081). `order_id` ya es clave primaria. Esta
        #: es la que convierte «el paquete llego» en una clave ajena: la resena
        #: lleva `delivered_at` NOT NULL, y una fila de envio sin entregar
        #: —`delivered_at` nulo— no puede emparejar con ella.
        UniqueConstraint(
            "order_id", "delivered_at", name="product_shipments_entrega_del_pedido"
        ),
    )


class ProductShipmentItem(Base):
    """Cuantas unidades de una linea se han metido ya en la caja.

    NO ES UN HISTORIAL Y NO PRETENDE SERLO: es la lista de comprobacion de
    quien empaqueta, y se corrige tantas veces como haga falta. Lo que si es
    historial esta en `ProductShipmentEvent`, y ese solo se anade.

    VIVE APARTE DE `ProductOrderItem` PORQUE ESA TABLA ES INMUTABLE: la 0078 le
    puso un disparador que rechaza cualquier `update`.
    """

    __tablename__ = "product_shipment_items"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    shipment_order_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("product_shipments.order_id", ondelete="CASCADE"),
    )
    order_item_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("product_order_items.id", ondelete="RESTRICT"),
    )
    #: CERO ES LEGITIMO: es «empezado y todavia ninguna». Que no pase de lo
    #: comprado lo comprueba el servidor, que tiene delante la linea del pedido.
    prepared_quantity: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            f"prepared_quantity >= 0 and prepared_quantity <= {MAXIMO_PREPARADO}",
            name="product_shipment_items_cantidad",
        ),
        UniqueConstraint(
            "shipment_order_id",
            "order_item_id",
            name="product_shipment_items_una_linea",
        ),
        Index(
            "product_shipment_items_del_envio",
            "shipment_order_id",
            "order_item_id",
        ),
    )


class ProductShipmentEvent(Base):
    """Un cambio de estado del envio. SOLO SE ANADE, y sin datos personales."""

    __tablename__ = "product_shipment_events"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    shipment_order_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("product_shipments.order_id", ondelete="RESTRICT"),
    )
    from_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    to_status: Mapped[str] = mapped_column(Text)
    #: Sin clave ajena: quien movio un envio es un hecho del pasado.
    actor_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    actor_role: Mapped[str] = mapped_column(Text)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "actor_role in ('buyer', 'seller', 'admin', 'system')",
            name="product_shipment_events_rol",
        ),
        #: LOS DOS DEL LARGO DEL ESTADO. Estaban solo en el `.sql` y por tanto
        #: no los veia la suite, que monta SQLite desde estos modelos: la
        #: proteccion existia en produccion y ninguna prueba la miraba. Lo
        #: encontro la revision independiente comparando los dos esquemas.
        CheckConstraint(
            "from_status is null or length(from_status) <= 40",
            name="product_shipment_events_desde",
        ),
        CheckConstraint(
            "length(to_status) <= 40", name="product_shipment_events_hasta"
        ),
        CheckConstraint(
            "reason is null or length(trim(reason)) between 3 and 500",
            name="product_shipment_events_motivo",
        ),
        Index(
            "product_shipment_events_del_envio",
            "shipment_order_id",
            "created_at",
            "id",
        ),
    )




# --------------------------------------------------------------------------- #
# La incidencia de un pedido entregado (0080)
# --------------------------------------------------------------------------- #
#: Los motivos. CERRADOS: lo dice el blueprint §10. «Ya no lo quiero» NO esta:
#: eso es desistimiento, no un defecto, y tiene otros plazos.
INCIDENCIA_DANADO = "DAMAGED"
INCIDENCIA_NO_COMO_SE_DESCRIBE = "NOT_AS_DESCRIBED"
INCIDENCIA_PRODUCTO_INCORRECTO = "WRONG_ITEM"
INCIDENCIA_FALTAN_PIEZAS = "MISSING_PARTS"
INCIDENCIA_NO_FUNCIONA = "NOT_WORKING"
INCIDENCIA_FALSIFICACION = "SUSPECTED_COUNTERFEIT"
INCIDENCIA_OTRO = "OTHER"
#: El octavo es del §9, no del §10: quien compro niega una entrega que el
#: proveedor afirmo.
INCIDENCIA_ENTREGA_NEGADA = "DELIVERY_DISPUTED"

MOTIVOS_DE_INCIDENCIA = (
    INCIDENCIA_DANADO,
    INCIDENCIA_NO_COMO_SE_DESCRIBE,
    INCIDENCIA_PRODUCTO_INCORRECTO,
    INCIDENCIA_FALTAN_PIEZAS,
    INCIDENCIA_NO_FUNCIONA,
    INCIDENCIA_FALSIFICACION,
    INCIDENCIA_OTRO,
    INCIDENCIA_ENTREGA_NEGADA,
)

CASO_ABIERTO = "OPEN"
CASO_MAS_EVIDENCIA = "MORE_EVIDENCE_REQUESTED"
CASO_RESPONDIDO = "SELLER_RESPONDED"
CASO_EN_MEDIACION = "MEDIATION"
CASO_RESUELTO = "RESOLVED"
CASO_APELADO = "APPEALED"
CASO_RETIRADO = "WITHDRAWN"

ESTADOS_DE_INCIDENCIA = (
    CASO_ABIERTO,
    CASO_MAS_EVIDENCIA,
    CASO_RESPONDIDO,
    CASO_EN_MEDIACION,
    CASO_RESUELTO,
    CASO_APELADO,
    CASO_RETIRADO,
)

#: Los que todavia esperan a alguien.
CASOS_VIVOS = (
    CASO_ABIERTO,
    CASO_MAS_EVIDENCIA,
    CASO_RESPONDIDO,
    CASO_EN_MEDIACION,
    CASO_APELADO,
)

#: LAS CINCO SALIDAS. `REQUEST_MORE_EVIDENCE` no esta: pedir mas evidencia es un
#: paso, no una salida, y contarlo como resolucion daria un numero falso.
RESOLUCION_DEVOLVER_Y_REEMBOLSAR = "RETURN_AND_FULL_REFUND"
RESOLUCION_REEMBOLSAR_SIN_DEVOLVER = "FULL_REFUND_WITHOUT_RETURN"
RESOLUCION_REEMBOLSAR_EN_PARTE = "PARTIAL_REFUND"
RESOLUCION_REPONER = "REPLACEMENT"
RESOLUCION_RECHAZAR = "REJECT_CLAIM"

RESOLUCIONES_DE_INCIDENCIA = (
    RESOLUCION_DEVOLVER_Y_REEMBOLSAR,
    RESOLUCION_REEMBOLSAR_SIN_DEVOLVER,
    RESOLUCION_REEMBOLSAR_EN_PARTE,
    RESOLUCION_REPONER,
    RESOLUCION_RECHAZAR,
)

PEDIR_MAS_EVIDENCIA = "REQUEST_MORE_EVIDENCE"
PROPUESTAS_DEL_PROVEEDOR = RESOLUCIONES_DE_INCIDENCIA + (PEDIR_MAS_EVIDENCIA,)

#: RESOLVER NO ES PAGAR: el efecto nace pendiente y nadie lo ejecuta.
EFECTO_PENDIENTE = "PENDING"
EFECTO_NO_APLICA = "NOT_APPLICABLE"
EFECTOS_DE_INCIDENCIA = (EFECTO_PENDIENTE, EFECTO_NO_APLICA)

#: «2-6 fotografias» y «descripcion minima de 20 caracteres», literales del
#: blueprint §10.
MINIMO_DE_FOTOS_DE_INCIDENCIA = 2
MAXIMO_DE_FOTOS_DE_INCIDENCIA = 6
MINIMO_DE_LA_DESCRIPCION = 20
MAXIMO_DE_LA_DESCRIPCION = 2000

#: LAS 48 HORAS DEL PROVEEDOR. Del blueprint §10.1, exactas: «48 horas exactas
#: desde la notificacion». Se transcribe, no se decide.
HORAS_PARA_RESPONDER = 48
#: Y LAS 48 DE LA APELACION, del mismo sitio.
HORAS_PARA_APELAR = 48

#: Los tipos que admite el deposito de evidencia. SIN VIDEO a proposito: un
#: video no se puede validar abriendolo como se valida una imagen.
TIPOS_DE_EVIDENCIA_DE_INCIDENCIA = ("image/jpeg", "image/png", "image/webp")


class ProductIncident(Base):
    """El expediente de algo que llego mal.

    LA CUARTA MAQUINA, Y ES SUYA. Abrir una incidencia no despaga un pedido ni
    devuelve un paquete al almacen: solo anota que hay un caso.

    ABRIR NO ES APROBAR, Y RESOLVER NO ES PAGAR. `status = OPEN` significa que
    alguien dice que algo llego mal; `resolution` dice que se decidio, y
    `financial_effect` nace PENDIENTE porque mover el dinero es del Incremento 9
    y no existe.
    """

    __tablename__ = "product_incidents"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)

    order_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_orders.id", ondelete="RESTRICT")
    )
    #: NULO CUANDO EL CASO ES DE TODO EL PEDIDO. Hoy solo la entrega negada.
    order_item_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("product_order_items.id", ondelete="RESTRICT"),
        nullable=True,
    )

    #: SE COPIAN LOS DOS LADOS: quien reclama y quien responde son un hecho de
    #: este caso, y leerlos del pedido cada vez haria que un cambio de
    #: responsable comercial reescribiera quien tenia que contestar.
    buyer_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="RESTRICT")
    )
    seller_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_sellers.id", ondelete="RESTRICT")
    )

    reason: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, default=CASO_ABIERTO)

    #: NULO MIENTRAS LA PELOTA NO SEA SUYA: no puede correrle el reloj mientras
    #: espera a que le manden la evidencia que pidio.
    seller_response_due_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    seller_responded_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    seller_proposal: Mapped[str | None] = mapped_column(Text, nullable=True)

    resolution: Mapped[str | None] = mapped_column(Text, nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    #: Sin clave ajena: quien resolvio un caso es un hecho del pasado.
    resolved_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    financial_effect: Mapped[str | None] = mapped_column(Text, nullable=True)

    appeal_due_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    appealed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    appeals_used: Mapped[int] = mapped_column(Integer, default=0)

    withdrawn_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "reason in ('DAMAGED', 'NOT_AS_DESCRIBED', 'WRONG_ITEM',"
            " 'MISSING_PARTS', 'NOT_WORKING', 'SUSPECTED_COUNTERFEIT',"
            " 'OTHER', 'DELIVERY_DISPUTED')",
            name="product_incidents_motivo",
        ),
        CheckConstraint(
            f"length(trim(description)) between {MINIMO_DE_LA_DESCRIPCION}"
            f" and {MAXIMO_DE_LA_DESCRIPCION}",
            name="product_incidents_descripcion",
        ),
        CheckConstraint(
            "status in ('OPEN', 'MORE_EVIDENCE_REQUESTED', 'SELLER_RESPONDED',"
            " 'MEDIATION', 'RESOLVED', 'APPEALED', 'WITHDRAWN')",
            name="product_incidents_estado",
        ),
        CheckConstraint(
            "seller_proposal is null or seller_proposal in"
            " ('RETURN_AND_FULL_REFUND', 'FULL_REFUND_WITHOUT_RETURN',"
            " 'PARTIAL_REFUND', 'REPLACEMENT', 'REJECT_CLAIM',"
            " 'REQUEST_MORE_EVIDENCE')",
            name="product_incidents_propuesta",
        ),
        #: LA RESOLUCION NUNCA ES `REQUEST_MORE_EVIDENCE`: es un paso.
        CheckConstraint(
            "resolution is null or resolution in ('RETURN_AND_FULL_REFUND',"
            " 'FULL_REFUND_WITHOUT_RETURN', 'PARTIAL_REFUND', 'REPLACEMENT',"
            " 'REJECT_CLAIM')",
            name="product_incidents_resolucion",
        ),
        CheckConstraint(
            "financial_effect is null or financial_effect in"
            " ('PENDING', 'NOT_APPLICABLE')",
            name="product_incidents_efecto",
        ),
        CheckConstraint(
            "appeals_used between 0 and 1", name="product_incidents_una_apelacion"
        ),
        CheckConstraint(
            "status <> 'RESOLVED' or (resolution is not null"
            " and resolved_at is not null and resolved_by is not null"
            " and financial_effect is not null)",
            name="product_incidents_resuelta_completa",
        ),
        CheckConstraint(
            "resolution is null or status in ('RESOLVED', 'APPEALED')",
            name="product_incidents_resolucion_con_estado",
        ),
        CheckConstraint(
            "status <> 'APPEALED' or appealed_at is not null",
            name="product_incidents_apelada_con_fecha",
        ),
        CheckConstraint(
            "status <> 'WITHDRAWN' or withdrawn_at is not null",
            name="product_incidents_retirada_con_fecha",
        ),
        CheckConstraint(
            "seller_responded_at is null or seller_proposal is not null",
            name="product_incidents_respondida_con_fecha",
        ),
        #: EL CASO DE TODO EL PEDIDO ES SOLO EL DE LA ENTREGA NEGADA.
        CheckConstraint(
            "order_item_id is not null or reason = 'DELIVERY_DISPUTED'",
            name="product_incidents_linea_salvo_entrega",
        ),
        Index(
            "product_incidents_uno_vivo_por_linea",
            "order_id",
            "order_item_id",
            unique=True,
            postgresql_where=text(
                "order_item_id is not null and status in ('OPEN',"
                " 'MORE_EVIDENCE_REQUESTED', 'SELLER_RESPONDED', 'MEDIATION',"
                " 'APPEALED')"
            ),
            sqlite_where=text(
                "order_item_id is not null and status in ('OPEN',"
                " 'MORE_EVIDENCE_REQUESTED', 'SELLER_RESPONDED', 'MEDIATION',"
                " 'APPEALED')"
            ),
        ),
        Index(
            "product_incidents_uno_vivo_por_pedido",
            "order_id",
            unique=True,
            postgresql_where=text(
                "order_item_id is null and status in ('OPEN',"
                " 'MORE_EVIDENCE_REQUESTED', 'SELLER_RESPONDED', 'MEDIATION',"
                " 'APPEALED')"
            ),
            sqlite_where=text(
                "order_item_id is null and status in ('OPEN',"
                " 'MORE_EVIDENCE_REQUESTED', 'SELLER_RESPONDED', 'MEDIATION',"
                " 'APPEALED')"
            ),
        ),
        Index(
            "product_incidents_del_comprador",
            "buyer_id",
            text("created_at desc"),
            text("id desc"),
        ),
        Index(
            "product_incidents_del_proveedor",
            "seller_id",
            text("created_at desc"),
            text("id desc"),
        ),
        Index(
            "product_incidents_en_mediacion",
            "created_at",
            "id",
            postgresql_where=text("status in ('MEDIATION', 'APPEALED')"),
            sqlite_where=text("status in ('MEDIATION', 'APPEALED')"),
        ),
        #: POR EL PLAZO Y NO POR EL ESTADO, igual que el vencimiento de reservas.
        Index(
            "product_incidents_por_escalar",
            "seller_response_due_at",
            "id",
            postgresql_where=text(
                "seller_response_due_at is not null and status = 'OPEN'"
            ),
            sqlite_where=text(
                "seller_response_due_at is not null and status = 'OPEN'"
            ),
        ),
    )


class ProductIncidentEvidence(Base):
    """Una prueba del caso. SOLO SE ANADE, y tampoco se borra.

    NI SIQUIERA QUIEN LA SUBIO PUEDE QUITARLA. Retirar una foto despues de que
    la otra parte la haya visto es reescribir lo que se discutio; si una
    evidencia no vale, se dice en el historial.

    SE GUARDA LA RUTA, NUNCA UNA URL: una firmada caduca, y guardarla haria que
    la evidencia de una disputa dejara de cargar sin que nadie tocara nada.
    """

    __tablename__ = "product_incident_evidence"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    incident_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_incidents.id", ondelete="RESTRICT")
    )
    #: Sin clave ajena: quien aporto una prueba es un hecho del pasado.
    uploaded_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    uploaded_role: Mapped[str] = mapped_column(Text)

    storage_path: Mapped[str] = mapped_column(Text)
    content_type: Mapped[str] = mapped_column(Text)
    byte_size: Mapped[int] = mapped_column(BigInteger)
    checksum_sha256: Mapped[str] = mapped_column(Text)
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    caption: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "uploaded_role in ('buyer', 'seller', 'admin')",
            name="product_incident_evidence_rol",
        ),
        CheckConstraint(
            "length(trim(storage_path)) between 1 and 500"
            " and storage_path not like '%://%'",
            name="product_incident_evidence_ruta",
        ),
        CheckConstraint(
            "content_type in ('image/jpeg', 'image/png', 'image/webp')",
            name="product_incident_evidence_tipo",
        ),
        CheckConstraint(
            "byte_size > 0 and byte_size <= 10485760",
            name="product_incident_evidence_peso",
        ),
        #: LA HUELLA TIENE SU CHECK, Y VIVE SOLO EN LA 0080.
        #:
        #: Es una expresión regular —`~ '^[0-9a-f]{64}$'`— y ese operador es de
        #: PostgreSQL: SQLite no sabe leerlo, y la suite monta su esquema desde
        #: ESTOS modelos. Declararlo aquí no protege más y rompe la suite
        #: entera, que es exactamente lo que pasó al escribir este incremento.
        #:
        #: Es la misma decisión que ya estaba tomada para
        #: `product_orders_huella` y `product_orders_moneda`, que tampoco están
        #: aquí. Lo que sí se comprueba en las dos bases es la LONGITUD, que no
        #: necesita expresiones regulares.
        CheckConstraint(
            "length(checksum_sha256) = 64",
            name="product_incident_evidence_huella_larga",
        ),
        CheckConstraint("width > 0", name="product_incident_evidence_ancho"),
        CheckConstraint("height > 0", name="product_incident_evidence_alto"),
        CheckConstraint(
            "caption is null or length(trim(caption)) between 1 and 300",
            name="product_incident_evidence_texto",
        ),
        #: EL MISMO ARCHIVO NO SE CUENTA DOS VECES: subir dos veces la misma
        #: foto para llegar al minimo de dos no es aportar dos evidencias.
        UniqueConstraint(
            "incident_id",
            "checksum_sha256",
            name="product_incident_evidence_una_vez",
        ),
        Index(
            "product_incident_evidence_del_caso",
            "incident_id",
            "created_at",
            "id",
        ),
    )


class ProductIncidentEvent(Base):
    """Un paso del expediente. SOLO SE ANADE.

    AQUI SI VA EL TEXTO LIBRE, y es correcto que vaya: este expediente lo leen
    quien reclama, quien responde y quien resuelve, que son las tres personas
    que ya conocen el caso. Lo que NO puede pasar es que salga de aqui a una
    lista general o a la auditoria compartida.
    """

    __tablename__ = "product_incident_events"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    incident_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_incidents.id", ondelete="RESTRICT")
    )
    from_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    to_status: Mapped[str] = mapped_column(Text)
    #: Sin clave ajena: quien movio un caso es un hecho del pasado.
    actor_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    actor_role: Mapped[str] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "actor_role in ('buyer', 'seller', 'admin', 'system')",
            name="product_incident_events_rol",
        ),
        CheckConstraint(
            "from_status is null or length(from_status) <= 40",
            name="product_incident_events_desde",
        ),
        CheckConstraint(
            "length(to_status) <= 40", name="product_incident_events_hasta"
        ),
        CheckConstraint(
            "note is null or length(trim(note)) between 3 and 1000",
            name="product_incident_events_nota",
        ),
        Index(
            "product_incident_events_del_caso",
            "incident_id",
            "created_at",
            "id",
        ),
    )

# --------------------------------------------------------------------------- #
# Las resenas verificadas (0081).
# --------------------------------------------------------------------------- #

RESENA_VISIBLE = "visible"
RESENA_ESCONDIDA = "hidden"

#: Los cuatro ejes del blueprint, en una tupla y no sueltos para que el resumen,
#: el contrato y las pruebas no puedan divergir. La puntuacion general va aparte
#: porque NO es su media: responde a otra pregunta.
EJES_DE_RESENA = ("quality", "fidelity", "functioning", "value_for_money")


class ProductReview(Base):
    """Lo que opina quien compro una linea de pedido que le llego.

    «COMPRA VERIFICADA» NO ES UNA COLUMNA. No hay ningun booleano que alguien
    pueda escribir: las cuatro condiciones las imponen tres claves ajenas
    compuestas contra `product_orders`, `product_order_items` y
    `product_shipments`. Si falta una, el INSERT lo rechaza la base.

    LA UNIDAD ES LA LINEA DE PEDIDO, no el producto: quien compro lo mismo dos
    veces en dos pedidos opina dos veces, porque son dos compras.
    """

    __tablename__ = "product_reviews"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)

    product_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("products.id", ondelete="RESTRICT")
    )
    order_id: Mapped[str] = mapped_column(Uuid(as_uuid=False))
    order_item_id: Mapped[str] = mapped_column(Uuid(as_uuid=False))
    author_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE")
    )

    #: LAS DOS FECHAS QUE VERIFICAN, y no se escriben a mano: tienen que casar
    #: con las del pedido y las del envio. NOT NULL las dos, porque con una nula
    #: la clave ajena compuesta se cumpliria sola.
    order_paid_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    delivered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    overall: Mapped[int] = mapped_column(Integer)
    quality: Mapped[int] = mapped_column(Integer)
    fidelity: Mapped[int] = mapped_column(Integer)
    functioning: Mapped[int] = mapped_column(Integer)
    value_for_money: Mapped[int] = mapped_column(Integer)
    recommends: Mapped[bool] = mapped_column(Boolean)

    comment: Mapped[str | None] = mapped_column(Text, nullable=True)

    status: Mapped[str] = mapped_column(Text, default=RESENA_VISIBLE)
    moderation_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    moderated_by: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="SET NULL"),
        nullable=True,
    )
    moderated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("overall between 1 and 5", name="product_reviews_general"),
        CheckConstraint("quality between 1 and 5", name="product_reviews_calidad"),
        CheckConstraint("fidelity between 1 and 5", name="product_reviews_fidelidad"),
        CheckConstraint(
            "functioning between 1 and 5", name="product_reviews_funcionamiento"
        ),
        CheckConstraint("value_for_money between 1 and 5", name="product_reviews_valor"),
        CheckConstraint(
            "comment is null or length(comment) <= 1000",
            name="product_reviews_comentario",
        ),
        CheckConstraint("status in ('visible', 'hidden')", name="product_reviews_estado"),
        CheckConstraint(
            "moderation_reason is null or length(moderation_reason) <= 500",
            name="product_reviews_motivo_moderacion",
        ),
        CheckConstraint(
            "(status = 'hidden') = (moderated_at is not null)",
            name="product_reviews_escondida_con_fecha",
        ),
        UniqueConstraint("order_item_id", name="product_reviews_una_por_linea"),
        #: QUIEN COMPRO, Y QUE ESTABA PAGADO.
        ForeignKeyConstraint(
            ["order_id", "author_id", "order_paid_at"],
            ["product_orders.id", "product_orders.buyer_id", "product_orders.paid_at"],
            name="product_reviews_de_su_compra",
            ondelete="RESTRICT",
        ),
        #: LA LINEA ES DE ESE PEDIDO Y DE ESE PRODUCTO.
        ForeignKeyConstraint(
            ["order_item_id", "order_id", "product_id"],
            [
                "product_order_items.id",
                "product_order_items.order_id",
                "product_order_items.product_id",
            ],
            name="product_reviews_de_esa_linea",
            ondelete="RESTRICT",
        ),
        #: Y EL PAQUETE LLEGO.
        ForeignKeyConstraint(
            ["order_id", "delivered_at"],
            ["product_shipments.order_id", "product_shipments.delivered_at"],
            name="product_reviews_con_entrega",
            ondelete="RESTRICT",
        ),
        Index(
            "product_reviews_del_producto",
            "product_id",
            text("created_at desc"),
            text("id desc"),
            postgresql_where=text("status = 'visible'"),
            sqlite_where=text("status = 'visible'"),
        ),
        Index(
            "product_reviews_resumen_del_producto",
            "product_id",
            "overall",
            postgresql_where=text("status = 'visible'"),
            sqlite_where=text("status = 'visible'"),
        ),
        Index(
            "product_reviews_de_la_persona",
            "author_id",
            text("created_at desc"),
            text("id desc"),
        ),
        Index(
            "product_reviews_por_moderar",
            text("created_at desc"),
            text("id desc"),
            postgresql_where=text("status = 'visible'"),
            sqlite_where=text("status = 'visible'"),
        ),
        Index("product_reviews_del_pedido", "order_id"),
    )


class ProductReviewReply(Base):
    """La respuesta publica del proveedor. UNA VISIBLE POR RESENA.

    Varias sobre la misma resena serian una forma de hostigar a quien opino, y
    lo impide un indice unico parcial. Las escondidas por moderacion se quedan
    en el historial y dejan sitio a otra.
    """

    __tablename__ = "product_review_replies"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    review_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_reviews.id", ondelete="CASCADE")
    )
    author_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE")
    )

    body: Mapped[str] = mapped_column(Text)

    status: Mapped[str] = mapped_column(Text, default=RESENA_VISIBLE)
    moderation_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    moderated_by: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="SET NULL"),
        nullable=True,
    )
    moderated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "length(trim(body)) between 1 and 1000",
            name="product_review_replies_texto",
        ),
        CheckConstraint(
            "status in ('visible', 'hidden')", name="product_review_replies_estado"
        ),
        CheckConstraint(
            "moderation_reason is null or length(moderation_reason) <= 500",
            name="product_review_replies_motivo",
        ),
        CheckConstraint(
            "(status = 'hidden') = (moderated_at is not null)",
            name="product_review_replies_escondida_con_fecha",
        ),
        Index(
            "product_review_replies_una_visible",
            "review_id",
            unique=True,
            postgresql_where=text("status = 'visible'"),
            sqlite_where=text("status = 'visible'"),
        ),
        Index(
            "product_review_replies_de_la_resena",
            "review_id",
            text("created_at desc"),
            text("id desc"),
        ),
    )


class ProductReviewModeration(Base):
    """El historial de moderacion. SOLO SE ANADE: lo impone un disparador.

    Una fila habla de una resena O de una respuesta, nunca de las dos ni de
    ninguna: si no, no se sabe que se modero.
    """

    __tablename__ = "product_review_moderation"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    review_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("product_reviews.id", ondelete="CASCADE"),
        nullable=True,
    )
    reply_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("product_review_replies.id", ondelete="CASCADE"),
        nullable=True,
    )
    actor_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="SET NULL"),
        nullable=True,
    )
    from_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    to_status: Mapped[str] = mapped_column(Text)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "reason is null or length(reason) <= 500",
            name="product_review_moderation_motivo",
        ),
        CheckConstraint(
            "(review_id is null) <> (reply_id is null)",
            name="product_review_moderation_de_algo",
        ),
        Index("product_review_moderation_de_la_resena", "review_id", "created_at"),
        Index("product_review_moderation_de_la_respuesta", "reply_id", "created_at"),
    )


__all__ = [
    "EJES_DE_RESENA",
    "RESENA_ESCONDIDA",
    "RESENA_VISIBLE",
    "ACTORES_DE_INVENTARIO",
    "ACTOR_ADMINISTRACION",
    "ACTOR_PROVEEDOR",
    "ACTOR_SISTEMA",
    "AJUSTE",
    "APROBADO",
    "APROBADO_CON_CONDICIONES",
    "BORRADOR",
    "CASOS_VIVOS",
    "CASO_ABIERTO",
    "CASO_APELADO",
    "CASO_EN_MEDIACION",
    "CASO_MAS_EVIDENCIA",
    "CASO_RESPONDIDO",
    "CASO_RESUELTO",
    "CASO_RETIRADO",
    "DECISIONES",
    "DECISION_APROBADO",
    "DECISION_CONDICIONADO",
    "DECISION_RECHAZADO",
    "DIMENSIONES",
    "DOCUMENTOS",
    "EFECTOS_DE_INCIDENCIA",
    "EFECTO_NO_APLICA",
    "EFECTO_PENDIENTE",
    "ENTRADA",
    "ENTREGA_LA_DICE_EL_COMPRADOR",
    "ENTREGA_LA_DICE_EL_PROVEEDOR",
    "ENVIADO",
    "ENVIO_ANTES_DE_SALIR",
    "ENVIO_CANCELADO",
    "ENVIO_DESPACHADO",
    "ENVIO_ENTREGADO",
    "ENVIO_FALLIDO",
    "ENVIO_LISTO",
    "ENVIO_PENDIENTE",
    "ENVIO_PREPARANDO",
    "ESTADOS_DE_ENVIO",
    "ESTADOS_DE_FOTO",
    "ESTADOS_DE_INCIDENCIA",
    "ESTADOS_DE_PEDIDO",
    "ESTADOS_DE_POLITICA",
    "ESTADOS_DE_POSTULACION",
    "ESTADOS_DE_PRODUCTO",
    "ESTADOS_DE_VENDEDOR",
    "ESTADOS_DE_VERSION",
    "EVALUACION",
    "EVALUACION_BORRADOR",
    "EVALUACION_DECIDIDA",
    "EXTENSION_DE_LA_IMAGEN",
    "FALLAS_CRITICAS",
    "FOTO_APROBADA",
    "FOTO_PENDIENTE",
    "FOTO_RECHAZADA",
    "HORAS_PARA_APELAR",
    "HORAS_PARA_RESPONDER",
    "INCIDENCIA_DANADO",
    "INCIDENCIA_ENTREGA_NEGADA",
    "INCIDENCIA_FALSIFICACION",
    "INCIDENCIA_FALTAN_PIEZAS",
    "INCIDENCIA_NO_COMO_SE_DESCRIBE",
    "INCIDENCIA_NO_FUNCIONA",
    "INCIDENCIA_OTRO",
    "INCIDENCIA_PRODUCTO_INCORRECTO",
    "LIBERACION",
    "MAXIMO_BYTES_DE_LA_FOTO",
    "MAXIMO_DEL_MOVIMIENTO",
    "MAXIMO_DE_FOTOS",
    "MAXIMO_DE_FOTOS_DE_INCIDENCIA",
    "MAXIMO_DE_LA_DESCRIPCION",
    "MAXIMO_POR_LINEA",
    "MAXIMO_PREPARADO",
    "MAXIMO_SEGURO_EN_JS",
    "MINIMO_DE_FOTOS_DE_INCIDENCIA",
    "MINIMO_DE_LA_DESCRIPCION",
    "MOTIVOS_DE_INCIDENCIA",
    "MOVIMIENTOS",
    "MUESTRA_PEDIDA",
    "OBSERVACION",
    "ORIGENES_DE_LA_ENTREGA",
    "PEDIDO_CANCELADO",
    "PEDIDO_EN_CURSO",
    "PEDIDO_EN_REVISION",
    "PEDIDO_FALLIDO",
    "PEDIDO_PAGADO",
    "PEDIDO_PENDIENTE",
    "PEDIDO_PROCESANDO",
    "PEDIDO_RETIENE",
    "PEDIDO_VENCIDO",
    "PEDIR_MAS_EVIDENCIA",
    "POLITICA_BORRADOR",
    "POLITICA_PUBLICADA",
    "POLITICA_RETIRADA",
    "POSTULACIONES_VIVAS",
    "POSTULACION_ACEPTADA",
    "POSTULACION_BORRADOR",
    "POSTULACION_ENVIADA",
    "POSTULACION_EN_REVISION",
    "POSTULACION_RECHAZADA",
    "POSTULACION_RETIRADA",
    "PROPUESTAS_DEL_PROVEEDOR",
    "PUBLICADO",
    "RAZONES_EXIGIDAS",
    "RESERVA",
    "RESOLUCIONES_DE_INCIDENCIA",
    "RESOLUCION_DEVOLVER_Y_REEMBOLSAR",
    "RESOLUCION_RECHAZAR",
    "RESOLUCION_REEMBOLSAR_EN_PARTE",
    "RESOLUCION_REEMBOLSAR_SIN_DEVOLVER",
    "RESOLUCION_REPONER",
    "RETIRADO",
    "REVISION_DOCUMENTAL",
    "SALIDA",
    "SUSPENDIDO",
    "TIPOS_DE_EVIDENCIA",
    "TIPOS_DE_EVIDENCIA_DE_INCIDENCIA",
    "TIPOS_DE_IMAGEN",
    "VENDEDOR_ACTIVO",
    "VENDEDOR_PENDIENTE",
    "VENDEDOR_SUSPENDIDO",
    "VERSION_BORRADOR",
    "VERSION_PUBLICADA",
    "VERSION_SUPERADA",
    "InventoryMovement",
    "Product",
    "ProductApprovalReason",
    "ProductCart",
    "ProductCartItem",
    "ProductCategory",
    "ProductEvaluation",
    "ProductEvaluationEvidence",
    "ProductEvaluationScore",
    "ProductIncident",
    "ProductIncidentEvent",
    "ProductIncidentEvidence",
    "ProductInventory",
    "ProductMedia",
    "ProductOrder",
    "ProductOrderAddress",
    "ProductOrderEvent",
    "ProductOrderItem",
    "ProductPolicy",
    "ProductReview",
    "ProductReviewModeration",
    "ProductReviewReply",
    "ProductSeller",
    "ProductShipment",
    "ProductShipmentEvent",
    "ProductShipmentItem",
    "ProductVariant",
    "ProductVersion",
    "SavedProduct",
    "SellerApplication",
    "SellerApplicationDocument",
]
