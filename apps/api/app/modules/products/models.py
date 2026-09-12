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


class ProductMedia(Base):
    """La galería aprobada. Guarda la RUTA, nunca una URL firmada."""

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

    __table_args__ = (
        CheckConstraint("kind in ('image', 'video')", name="product_media_tipo"),
        UniqueConstraint("version_id", "storage_path", name="product_media_ruta_unica"),
        Index("product_media_de_la_version", "version_id", "position", "id"),
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


__all__ = [
    "APROBADO",
    "APROBADO_CON_CONDICIONES",
    "BORRADOR",
    "DECISIONES",
    "DECISION_APROBADO",
    "DECISION_CONDICIONADO",
    "DECISION_RECHAZADO",
    "DIMENSIONES",
    "DOCUMENTOS",
    "ENVIADO",
    "ESTADOS_DE_POSTULACION",
    "ESTADOS_DE_PRODUCTO",
    "ESTADOS_DE_VENDEDOR",
    "ESTADOS_DE_VERSION",
    "EVALUACION",
    "EVALUACION_BORRADOR",
    "EVALUACION_DECIDIDA",
    "FALLAS_CRITICAS",
    "MUESTRA_PEDIDA",
    "OBSERVACION",
    "POSTULACIONES_VIVAS",
    "POSTULACION_ACEPTADA",
    "POSTULACION_BORRADOR",
    "POSTULACION_EN_REVISION",
    "POSTULACION_ENVIADA",
    "POSTULACION_RECHAZADA",
    "POSTULACION_RETIRADA",
    "PUBLICADO",
    "RAZONES_EXIGIDAS",
    "RETIRADO",
    "REVISION_DOCUMENTAL",
    "SUSPENDIDO",
    "TIPOS_DE_EVIDENCIA",
    "VENDEDOR_ACTIVO",
    "VENDEDOR_PENDIENTE",
    "VENDEDOR_SUSPENDIDO",
    "VERSION_BORRADOR",
    "VERSION_PUBLICADA",
    "VERSION_SUPERADA",
    "Product",
    "ProductApprovalReason",
    "ProductCategory",
    "ProductEvaluation",
    "ProductEvaluationEvidence",
    "ProductEvaluationScore",
    "ProductMedia",
    "ProductSeller",
    "ProductVariant",
    "ProductVersion",
    "SavedProduct",
    "SellerApplication",
    "SellerApplicationDocument",
]
