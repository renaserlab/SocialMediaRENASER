"""Las tablas de Productos (migraciones 0070, 0071 y 0072).

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


__all__ = [
    "ACTORES_DE_INVENTARIO",
    "ACTOR_ADMINISTRACION",
    "ACTOR_PROVEEDOR",
    "ACTOR_SISTEMA",
    "AJUSTE",
    "APROBADO",
    "APROBADO_CON_CONDICIONES",
    "BORRADOR",
    "DECISIONES",
    "DECISION_APROBADO",
    "DECISION_CONDICIONADO",
    "DECISION_RECHAZADO",
    "DIMENSIONES",
    "DOCUMENTOS",
    "ENTRADA",
    "ENVIADO",
    "ESTADOS_DE_FOTO",
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
    "LIBERACION",
    "MAXIMO_BYTES_DE_LA_FOTO",
    "MAXIMO_DEL_MOVIMIENTO",
    "MAXIMO_DE_FOTOS",
    "MAXIMO_POR_LINEA",
    "MOVIMIENTOS",
    "MUESTRA_PEDIDA",
    "OBSERVACION",
    "POSTULACIONES_VIVAS",
    "POSTULACION_ACEPTADA",
    "POSTULACION_BORRADOR",
    "POSTULACION_ENVIADA",
    "POSTULACION_EN_REVISION",
    "POSTULACION_RECHAZADA",
    "POSTULACION_RETIRADA",
    "PUBLICADO",
    "RAZONES_EXIGIDAS",
    "RESERVA",
    "RETIRADO",
    "REVISION_DOCUMENTAL",
    "SALIDA",
    "SUSPENDIDO",
    "TIPOS_DE_EVIDENCIA",
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
    "ProductInventory",
    "ProductMedia",
    "ProductSeller",
    "ProductVariant",
    "ProductVersion",
    "SavedProduct",
    "SellerApplication",
    "SellerApplicationDocument",
]
