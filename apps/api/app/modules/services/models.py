"""Las tablas de la admisión de Servicios (migraciones 0086, 0087 y 0088).

LO QUE DECLARA EL ORM TIENE QUE DECLARARLO TAMBIÉN LA BASE, y al revés. Las
pruebas montan SQLite desde `Base.metadata`: un CHECK que solo viva en el `.sql`
es invisible para la suite. Por eso cada CHECK está aquí con SU MISMO NOMBRE y
la misma expresión que en la base TAL Y COMO QUEDA tras la 0088 (la 0087 amplía
la 0086 para `withdrawn`; la 0088 añade el ciclo de vida, los envíos congelados
y la coherencia con el prestador; `tests/test_servicios_migracion_00*.py` lo
comprueban), escrita con funciones que existen en los dos motores: `length`,
`trim`, `ltrim`, `upper`, `coalesce`.

Los disparadores no se pueden declarar aquí —nadie se admite a sí mismo, el
historial solo se añade, los saltos del mapa, la evidencia solo se borra en
cascada—. Se prueban contra PostgreSQL de verdad.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date, datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    CheckConstraint,
    Date,
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
from app.modules.services import states
from app.shared.database import Base

#: JSONB en PostgreSQL, JSON en SQLite. Igual que en Productos.
_parametros = JSON().with_variant(JSONB, "postgresql")

_MAYUSCULAS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_HEXADECIMAL = "0123456789abcdef"


def _lista(valores: Iterable[str]) -> str:
    return ", ".join(repr(v) for v in valores)


def _es_huella(columna: str, *, nula: bool) -> str:
    base = f"length({columna}) = 64 and ltrim({columna}, '{_HEXADECIMAL}') = ''"
    return f"{columna} is null or ({base})" if nula else base


def _es_pais(columna: str) -> str:
    return f"length({columna}) = 2 and ltrim({columna}, '{_MAYUSCULAS}') = ''"


# --------------------------------------------------------------------------- #
# 1. Políticas versionadas
# --------------------------------------------------------------------------- #
POLITICA_TERMINOS_DEL_PRESTADOR = "provider_terms"
#: Las condiciones de CONTRATACIÓN de Z (Incremento 5, 0093): las acepta
#: quien contrata un servicio, por país. Las publica la empresa.
POLITICA_CONDICIONES_DE_CONTRATACION = "booking_terms"
TIPOS_DE_POLITICA = (POLITICA_TERMINOS_DEL_PRESTADOR, POLITICA_CONDICIONES_DE_CONTRATACION)

POLITICA_BORRADOR = "draft"
POLITICA_PUBLICADA = "published"
POLITICA_SUPERADA = "superseded"
POLITICA_RETIRADA = "withdrawn"
ESTADOS_DE_POLITICA = (
    POLITICA_BORRADOR,
    POLITICA_PUBLICADA,
    POLITICA_SUPERADA,
    POLITICA_RETIRADA,
)


class ServicePolicy(Base):
    """Una versión de una política de Servicios. Publicada, no se edita."""

    __tablename__ = "service_policies"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    kind: Mapped[str] = mapped_column(String(32))
    country_code: Mapped[str] = mapped_column(String(2))
    #: NULA = todas las categorías. Texto hasta que exista el catálogo.
    category: Mapped[str | None] = mapped_column(Text, nullable=True)
    version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(
        String(16), server_default=text(f"'{POLITICA_BORRADOR}'")
    )
    title: Mapped[str] = mapped_column(Text)
    body: Mapped[str] = mapped_column(Text)
    body_sha256: Mapped[str] = mapped_column(String(64))
    parameters: Mapped[dict] = mapped_column(_parametros, server_default=text("'{}'"))
    effective_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    published_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    published_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    created_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(f"kind in ({_lista(TIPOS_DE_POLITICA)})", name="service_policies_tipo"),
        CheckConstraint(_es_pais("country_code"), name="service_policies_pais"),
        CheckConstraint(
            "category is null or length(trim(category)) between 2 and 80",
            name="service_policies_categoria",
        ),
        CheckConstraint("version >= 1", name="service_policies_version"),
        CheckConstraint(
            f"status in ({_lista(ESTADOS_DE_POLITICA)})", name="service_policies_estado"
        ),
        CheckConstraint(
            "length(trim(title)) between 3 and 200", name="service_policies_titulo"
        ),
        CheckConstraint("length(trim(body)) >= 50", name="service_policies_texto"),
        CheckConstraint(_es_huella("body_sha256", nula=False), name="service_policies_huella"),
        CheckConstraint(
            f"status = '{POLITICA_BORRADOR}'"
            " or (effective_at is not null and published_at is not null"
            " and published_by is not null)",
            name="service_policies_publicada_completa",
        ),
        Index(
            "service_policies_una_version",
            "kind",
            "country_code",
            text("coalesce(category, '')"),
            "version",
            unique=True,
        ),
        Index(
            "service_policies_una_publicada",
            "kind",
            "country_code",
            text("coalesce(category, '')"),
            unique=True,
            postgresql_where=text(f"status = '{POLITICA_PUBLICADA}'"),
            sqlite_where=text(f"status = '{POLITICA_PUBLICADA}'"),
        ),
    )


# --------------------------------------------------------------------------- #
# 2. El prestador
# --------------------------------------------------------------------------- #
PERSONA_NATURAL = "individual"
EMPRESA = "company"
TIPOS_DE_PRESTADOR = (PERSONA_NATURAL, EMPRESA)

#: Nace `pending`: nadie ofrece servicios por haberse registrado.
PRESTADOR_PENDIENTE = "pending"
PRESTADOR_ACTIVO = "active"
PRESTADOR_SUSPENDIDO = "suspended"
ESTADOS_DE_PRESTADOR = (PRESTADOR_PENDIENTE, PRESTADOR_ACTIVO, PRESTADOR_SUSPENDIDO)


class ServiceProvider(Base):
    """La capacidad de ofrecer servicios de un perfil. NO es otra identidad."""

    __tablename__ = "service_providers"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    profile_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE")
    )
    provider_type: Mapped[str] = mapped_column(String(16))
    display_name: Mapped[str] = mapped_column(Text)
    legal_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    country_code: Mapped[str | None] = mapped_column(String(2), nullable=True)
    #: PRIVADO: solo lo ven su dueño y administración.
    tax_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    representative_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        String(16), server_default=text(f"'{PRESTADOR_PENDIENTE}'")
    )
    activated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    suspended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint("profile_id", name="service_providers_un_perfil"),
        CheckConstraint(
            f"provider_type in ({_lista(TIPOS_DE_PRESTADOR)})",
            name="service_providers_tipo",
        ),
        CheckConstraint(
            "length(trim(display_name)) between 2 and 120",
            name="service_providers_nombre",
        ),
        CheckConstraint(
            "legal_name is null or length(trim(legal_name)) between 2 and 200",
            name="service_providers_nombre_legal",
        ),
        CheckConstraint(
            f"country_code is null or ({_es_pais('country_code')})",
            name="service_providers_pais",
        ),
        CheckConstraint(
            "tax_id is null or length(trim(tax_id)) between 5 and 20",
            name="service_providers_registro_tributario",
        ),
        CheckConstraint(
            "representative_name is null"
            " or length(trim(representative_name)) between 2 and 200",
            name="service_providers_representante",
        ),
        CheckConstraint(
            f"status in ({_lista(ESTADOS_DE_PRESTADOR)})",
            name="service_providers_estado",
        ),
        CheckConstraint(
            f"status <> '{PRESTADOR_ACTIVO}' or activated_at is not null",
            name="service_providers_activo_con_fecha",
        ),
        CheckConstraint(
            f"status <> '{PRESTADOR_SUSPENDIDO}' or suspended_at is not null",
            name="service_providers_suspendido_con_fecha",
        ),
        Index(
            "service_providers_por_estado",
            "status",
            text("created_at desc"),
            text("id desc"),
        ),
    )


# --------------------------------------------------------------------------- #
# 3. La postulación
# --------------------------------------------------------------------------- #
class ServiceProviderApplication(Base):
    """El expediente de admisión. Su estado lo gobierna `states`."""

    __tablename__ = "service_provider_applications"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    provider_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_providers.id", ondelete="CASCADE")
    )
    status: Mapped[str] = mapped_column(
        String(24), server_default=text(f"'{states.BORRADOR}'")
    )
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    requested_category: Mapped[str | None] = mapped_column(Text, nullable=True)
    terms_policy_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("service_policies.id", ondelete="RESTRICT"),
        nullable=True,
    )
    terms_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    terms_accepted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    truthfulness_declared_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    submitted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_submitted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    review_started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    decided_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    #: SIN CLAVE AJENA a propósito: quién decidió sobrevive a su cuenta.
    decided_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    suspended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    #: LO QUE SE LE ENSEÑA a quien postula. Las notas internas van aparte.
    applicant_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    internal_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint("id", "provider_id", name="service_provider_applications_id_prestador"),
        CheckConstraint(
            f"status in ({_lista(states.ESTADOS)})",
            name="service_provider_applications_estado",
        ),
        CheckConstraint(
            "summary is null or length(trim(summary)) between 20 and 4000",
            name="service_provider_applications_resumen",
        ),
        CheckConstraint(
            "requested_category is null"
            " or length(trim(requested_category)) between 2 and 80",
            name="service_provider_applications_categoria",
        ),
        CheckConstraint(
            _es_huella("terms_sha256", nula=True),
            name="service_provider_applications_huella",
        ),
        CheckConstraint(
            "applicant_message is null"
            " or length(trim(applicant_message)) between 3 and 2000",
            name="service_provider_applications_mensaje",
        ),
        CheckConstraint(
            "internal_notes is null or length(internal_notes) <= 4000",
            name="service_provider_applications_notas",
        ),
        # 0087: un borrador RETIRADO no tiene por qué estar completo; todo lo
        # demás fuera de `draft` exige lo mismo que en la 0086.
        CheckConstraint(
            f"status in ({_lista((states.BORRADOR, states.RETIRADA))}) or ("
            "summary is not null and submitted_at is not null"
            " and last_submitted_at is not null and terms_policy_id is not null"
            " and terms_sha256 is not null and terms_accepted_at is not null"
            " and truthfulness_declared_at is not null)",
            name="service_provider_applications_enviada_completa",
        ),
        CheckConstraint(
            f"status <> '{states.EN_REVISION}' or review_started_at is not null",
            name="service_provider_applications_en_revision_con_fecha",
        ),
        CheckConstraint(
            f"status not in ({_lista((states.APROBADA, states.RECHAZADA))})"
            " or (decided_at is not null and decided_by is not null)",
            name="service_provider_applications_decidida_con_autor",
        ),
        CheckConstraint(
            f"status <> '{states.SUSPENDIDA}' or suspended_at is not null",
            name="service_provider_applications_suspendida_con_fecha",
        ),
        CheckConstraint(
            "status not in ("
            + _lista((states.CORRECCIONES_PEDIDAS, states.RECHAZADA, states.SUSPENDIDA))
            + ") or applicant_message is not null",
            name="service_provider_applications_con_motivo",
        ),
        # 0088: retirarse es ANTES de la decisión. Una aprobada que se suspende
        # vuelve a `under_review`, pero ya tiene `decided_at`.
        CheckConstraint(
            f"status <> '{states.RETIRADA}' or decided_at is null",
            name="service_provider_applications_retirada_antes_de_decidir",
        ),
        # 0087: el rechazo Y LA RETIRADA liberan el hueco.
        Index(
            "service_provider_applications_una_viva",
            "provider_id",
            unique=True,
            postgresql_where=text(f"status not in ({_lista(sorted(states.FINALES))})"),
            sqlite_where=text(f"status not in ({_lista(sorted(states.FINALES))})"),
        ),
        Index(
            "service_provider_applications_bandeja",
            "status",
            text("last_submitted_at desc"),
            text("id desc"),
        ),
        Index(
            "service_provider_applications_del_prestador",
            "provider_id",
            text("created_at desc"),
            text("id desc"),
        ),
    )


# --------------------------------------------------------------------------- #
# 4. Los documentos: SOLO METADATOS
# --------------------------------------------------------------------------- #
TIPOS_DE_DOCUMENTO = (
    "identity",
    "legal_representation",
    "tax_registration",
    "proof_of_address",
    "professional_title",
    "professional_license",
    "insurance",
    "portfolio",
    "other",
)
#: LISTA CERRADA: nada que pueda llevar scripts.
FORMATOS_DE_DOCUMENTO = ("application/pdf", "image/jpeg", "image/png", "image/webp")
PESO_MAXIMO_DE_DOCUMENTO = 10 * 1024 * 1024

DOCUMENTO_PENDIENTE = "pending"
DOCUMENTO_ACEPTADO = "accepted"
DOCUMENTO_OBSERVADO = "rejected"
ESTADOS_DE_DOCUMENTO = (DOCUMENTO_PENDIENTE, DOCUMENTO_ACEPTADO, DOCUMENTO_OBSERVADO)

#: EL CICLO DE VIDA (0088). Nada se borra: se reemplaza o se retira.
ACTIVO = "active"
REEMPLAZADO = "replaced"
RETIRADO = "removed"
CICLO_DE_DOCUMENTO = (ACTIVO, REEMPLAZADO, RETIRADO)
CICLO_DE_CREDENCIAL = (ACTIVO, RETIRADO)


class ServiceProviderDocument(Base):
    """Un documento presentado. La ruta NUNCA sale en una respuesta."""

    __tablename__ = "service_provider_documents"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    provider_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_providers.id", ondelete="CASCADE")
    )
    application_id: Mapped[str] = mapped_column(Uuid(as_uuid=False))
    kind: Mapped[str] = mapped_column(String(32))
    storage_path: Mapped[str] = mapped_column(Text)
    content_type: Mapped[str] = mapped_column(String(32))
    byte_size: Mapped[int] = mapped_column(BigInteger)
    checksum_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    review_status: Mapped[str] = mapped_column(
        String(16), server_default=text(f"'{DOCUMENTO_PENDIENTE}'")
    )
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    reviewed_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    uploaded_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    #: 0088: `active`, `replaced` (por `replaced_by`) o `removed`.
    lifecycle: Mapped[str] = mapped_column(String(16), server_default=text(f"'{ACTIVO}'"))
    lifecycle_changed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    replaced_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)

    __table_args__ = (
        UniqueConstraint("storage_path", name="service_provider_documents_ruta_unica"),
        UniqueConstraint("id", "provider_id", name="service_provider_documents_id_prestador"),
        ForeignKeyConstraint(
            ["application_id", "provider_id"],
            [
                "service_provider_applications.id",
                "service_provider_applications.provider_id",
            ],
            ondelete="CASCADE",
            name="service_provider_documents_de_su_postulacion",
        ),
        CheckConstraint(
            f"kind in ({_lista(TIPOS_DE_DOCUMENTO)})",
            name="service_provider_documents_tipo",
        ),
        CheckConstraint(
            "length(storage_path) between 3 and 512"
            " and storage_path not like '/%'"
            " and storage_path not like '%..%'",
            name="service_provider_documents_ruta",
        ),
        CheckConstraint(
            f"content_type in ({_lista(FORMATOS_DE_DOCUMENTO)})",
            name="service_provider_documents_formato",
        ),
        CheckConstraint(
            f"byte_size between 1 and {PESO_MAXIMO_DE_DOCUMENTO}",
            name="service_provider_documents_peso",
        ),
        CheckConstraint(
            _es_huella("checksum_sha256", nula=True),
            name="service_provider_documents_huella",
        ),
        CheckConstraint(
            f"review_status in ({_lista(ESTADOS_DE_DOCUMENTO)})",
            name="service_provider_documents_revision",
        ),
        CheckConstraint(
            "review_note is null or length(trim(review_note)) between 3 and 1000",
            name="service_provider_documents_nota",
        ),
        CheckConstraint(
            f"review_status = '{DOCUMENTO_PENDIENTE}'"
            " or (reviewed_at is not null and reviewed_by is not null)",
            name="service_provider_documents_revisado_con_autor",
        ),
        CheckConstraint(
            f"review_status <> '{DOCUMENTO_OBSERVADO}' or review_note is not null",
            name="service_provider_documents_observado_con_motivo",
        ),
        Index(
            "service_provider_documents_de_la_postulacion",
            "application_id",
            "kind",
            "created_at",
        ),
        # 0088
        ForeignKeyConstraint(
            ["replaced_by", "provider_id"],
            ["service_provider_documents.id", "service_provider_documents.provider_id"],
            ondelete="CASCADE",
            name="service_provider_documents_reemplazado_por",
        ),
        CheckConstraint(
            f"lifecycle in ({_lista(CICLO_DE_DOCUMENTO)})",
            name="service_provider_documents_ciclo",
        ),
        CheckConstraint(
            f"(lifecycle = '{ACTIVO}') = (lifecycle_changed_at is null)",
            name="service_provider_documents_ciclo_con_fecha",
        ),
        CheckConstraint(
            f"(lifecycle = '{REEMPLAZADO}') = (replaced_by is not null)"
            " and (replaced_by is null or replaced_by <> id)",
            name="service_provider_documents_reemplazo_coherente",
        ),
        Index(
            "service_provider_documents_activos",
            "application_id",
            "kind",
            postgresql_where=text(f"lifecycle = '{ACTIVO}'"),
            sqlite_where=text(f"lifecycle = '{ACTIVO}'"),
        ),
    )


# --------------------------------------------------------------------------- #
# 5. Las credenciales profesionales
# --------------------------------------------------------------------------- #
TIPOS_DE_CREDENCIAL = (
    "professional_title",
    "professional_license",
    "professional_registration",
    "certification",
    "insurance",
    "other",
)

#: QUIEN POSTULA DECLARA; SOLO Z VERIFICA.
CREDENCIAL_DECLARADA = "declared"
CREDENCIAL_VERIFICADA = "verified"
CREDENCIAL_RECHAZADA = "rejected"
CREDENCIAL_VENCIDA = "expired"
ESTADOS_DE_CREDENCIAL = (
    CREDENCIAL_DECLARADA,
    CREDENCIAL_VERIFICADA,
    CREDENCIAL_RECHAZADA,
    CREDENCIAL_VENCIDA,
)


class ServiceProviderCredential(Base):
    """Una credencial profesional. Del prestador, no de una postulación."""

    __tablename__ = "service_provider_credentials"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    provider_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_providers.id", ondelete="CASCADE")
    )
    application_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    kind: Mapped[str] = mapped_column(String(32))
    title: Mapped[str] = mapped_column(Text)
    issuer: Mapped[str] = mapped_column(Text)
    jurisdiction: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: SOLO ENMASCARADO. El número completo está en el documento de respaldo.
    number_masked: Mapped[str | None] = mapped_column(String(40), nullable=True)
    specialty: Mapped[str | None] = mapped_column(Text, nullable=True)
    issued_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    expires_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    evidence_document_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), nullable=True
    )
    status: Mapped[str] = mapped_column(
        String(16), server_default=text(f"'{CREDENCIAL_DECLARADA}'")
    )
    verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    verified_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    #: 0088: `active` o `removed`; y OBSERVADA = `declared` + `observed_at`.
    lifecycle: Mapped[str] = mapped_column(String(16), server_default=text(f"'{ACTIVO}'"))
    lifecycle_changed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    observed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        # 0088
        CheckConstraint(
            f"lifecycle in ({_lista(CICLO_DE_CREDENCIAL)})",
            name="service_provider_credentials_ciclo",
        ),
        CheckConstraint(
            f"(lifecycle = '{ACTIVO}') = (lifecycle_changed_at is null)",
            name="service_provider_credentials_ciclo_con_fecha",
        ),
        CheckConstraint(
            f"observed_at is null or (status = '{CREDENCIAL_DECLARADA}'"
            " and review_note is not null)",
            name="service_provider_credentials_observada_coherente",
        ),
        ForeignKeyConstraint(
            ["application_id", "provider_id"],
            [
                "service_provider_applications.id",
                "service_provider_applications.provider_id",
            ],
            ondelete="CASCADE",
            name="service_provider_credentials_de_su_postulacion",
        ),
        ForeignKeyConstraint(
            ["evidence_document_id", "provider_id"],
            [
                "service_provider_documents.id",
                "service_provider_documents.provider_id",
            ],
            ondelete="CASCADE",
            name="service_provider_credentials_evidencia_propia",
        ),
        CheckConstraint(
            f"kind in ({_lista(TIPOS_DE_CREDENCIAL)})",
            name="service_provider_credentials_tipo",
        ),
        CheckConstraint(
            "length(trim(title)) between 2 and 200",
            name="service_provider_credentials_titulo",
        ),
        CheckConstraint(
            "length(trim(issuer)) between 2 and 200",
            name="service_provider_credentials_emisor",
        ),
        CheckConstraint(
            "jurisdiction is null or length(trim(jurisdiction)) between 2 and 120",
            name="service_provider_credentials_jurisdiccion",
        ),
        CheckConstraint(
            "number_masked is null or length(number_masked) between 1 and 40",
            name="service_provider_credentials_numero",
        ),
        CheckConstraint(
            "specialty is null or length(trim(specialty)) between 2 and 200",
            name="service_provider_credentials_especialidad",
        ),
        CheckConstraint(
            f"status in ({_lista(ESTADOS_DE_CREDENCIAL)})",
            name="service_provider_credentials_estado",
        ),
        CheckConstraint(
            "review_note is null or length(trim(review_note)) between 3 and 1000",
            name="service_provider_credentials_nota",
        ),
        CheckConstraint(
            "idempotency_key is null or length(idempotency_key) between 8 and 100",
            name="service_provider_credentials_clave",
        ),
        CheckConstraint(
            "issued_on is null or expires_on is null or expires_on >= issued_on",
            name="service_provider_credentials_vigencia",
        ),
        CheckConstraint(
            f"status <> '{CREDENCIAL_VERIFICADA}' or (verified_at is not null"
            " and verified_by is not null and evidence_document_id is not null)",
            name="service_provider_credentials_verificada_con_evidencia",
        ),
        CheckConstraint(
            f"status <> '{CREDENCIAL_RECHAZADA}' or review_note is not null",
            name="service_provider_credentials_rechazada_con_motivo",
        ),
        Index(
            "service_provider_credentials_una_por_clave",
            "provider_id",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key is not null"),
            sqlite_where=text("idempotency_key is not null"),
        ),
        Index(
            "service_provider_credentials_por_vencimiento",
            "provider_id",
            "status",
            "expires_on",
        ),
    )


# --------------------------------------------------------------------------- #
# 6. El historial: SOLO SE AÑADE
# --------------------------------------------------------------------------- #
def condicion_de_saltos(desde: str = "from_status", hasta: str = "to_status") -> str:
    """El mapa de `states.TRANSICIONES` como condición SQL.

    Es la MISMA que escribe la 0086 en el CHECK del historial, generada desde el
    mapa: si alguien añade un salto en Python sin añadirlo en la migración, la
    prueba de coherencia lo caza.
    """
    partes = [f"({desde} is null and {hasta} = '{states.BORRADOR}')"]
    for de, a in states.TRANSICIONES:
        partes.append(f"({desde} = '{de}' and {hasta} = '{a}')")
    return " or ".join(partes)


class ServiceProviderApplicationEvent(Base):
    """Un salto del expediente, con quién, en calidad de qué y por qué."""

    __tablename__ = "service_provider_application_events"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    application_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("service_provider_applications.id", ondelete="CASCADE"),
    )
    from_status: Mapped[str | None] = mapped_column(String(24), nullable=True)
    to_status: Mapped[str] = mapped_column(String(24))
    #: SIN CLAVE AJENA a propósito: el historial sobrevive a la cuenta.
    actor_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    actor_role: Mapped[str] = mapped_column(String(16))
    visible_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    internal_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    #: 0088: lo VISIBLE que acompaña al paso, p. ej. `{"fields": [...]}` al pedir
    #: correcciones. Nunca notas internas.
    details: Mapped[dict] = mapped_column(_parametros, server_default=text("'{}'"))

    __table_args__ = (
        CheckConstraint(
            f"from_status is null or from_status in ({_lista(states.ESTADOS)})",
            name="service_provider_application_events_desde",
        ),
        CheckConstraint(
            f"to_status in ({_lista(states.ESTADOS)})",
            name="service_provider_application_events_hasta",
        ),
        CheckConstraint(
            f"actor_role in ({_lista(states.ACTORES)})",
            name="service_provider_application_events_rol",
        ),
        CheckConstraint(
            "visible_note is null or length(trim(visible_note)) between 3 and 2000",
            name="service_provider_application_events_nota_visible",
        ),
        CheckConstraint(
            "internal_note is null or length(internal_note) <= 4000",
            name="service_provider_application_events_nota_interna",
        ),
        CheckConstraint(
            "idempotency_key is null or length(idempotency_key) between 8 and 100",
            name="service_provider_application_events_clave",
        ),
        CheckConstraint(
            condicion_de_saltos(),
            name="service_provider_application_events_salto_permitido",
        ),
        # 0087: un evento hacia `withdrawn` lo firma quien postula, nunca Z.
        # Que sea EL DUEÑO lo impone un disparador (solo en PostgreSQL).
        CheckConstraint(
            f"to_status <> '{states.RETIRADA}' or actor_role = '{states.PRESTADOR}'",
            name="service_provider_application_events_retira_el_prestador",
        ),
        Index(
            "service_provider_application_events_una_por_clave",
            "application_id",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key is not null"),
            sqlite_where=text("idempotency_key is not null"),
        ),
        Index(
            "service_provider_application_events_de_la_postulacion",
            "application_id",
            "created_at",
            "id",
        ),
    )


# --------------------------------------------------------------------------- #
# 7. Los envíos congelados (0088): SOLO SE AÑADEN
# --------------------------------------------------------------------------- #
ENVIO_INICIAL = "submitted"
REENVIO = "resubmitted"


class ServiceProviderApplicationSubmission(Base):
    """Lo que se envió en cada envío o reenvío, y las condiciones aceptadas."""

    __tablename__ = "service_provider_application_submissions"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    application_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("service_provider_applications.id", ondelete="CASCADE"),
    )
    sequence: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(16))
    terms_policy_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_policies.id", ondelete="RESTRICT")
    )
    terms_version: Mapped[int] = mapped_column(Integer)
    terms_sha256: Mapped[str] = mapped_column(String(64))
    snapshot: Mapped[dict] = mapped_column(_parametros)
    snapshot_sha256: Mapped[str] = mapped_column(String(64))
    submitted_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "application_id",
            "sequence",
            name="service_provider_application_submissions_una_por_secuencia",
        ),
        CheckConstraint(
            "sequence >= 1", name="service_provider_application_submissions_secuencia"
        ),
        CheckConstraint(
            f"kind in ({_lista((ENVIO_INICIAL, REENVIO))})",
            name="service_provider_application_submissions_tipo",
        ),
        CheckConstraint(
            "terms_version >= 1", name="service_provider_application_submissions_version"
        ),
        CheckConstraint(
            _es_huella("terms_sha256", nula=False),
            name="service_provider_application_submissions_huella_de_terminos",
        ),
        CheckConstraint(
            _es_huella("snapshot_sha256", nula=False),
            name="service_provider_application_submissions_huella_del_envio",
        ),
        Index(
            "service_provider_application_submissions_de_la_postulacion",
            "application_id",
            text("sequence desc"),
        ),
    )


__all__ = [
    "ACTIVO",
    "CICLO_DE_CREDENCIAL",
    "CICLO_DE_DOCUMENTO",
    "ENVIO_INICIAL",
    "REEMPLAZADO",
    "REENVIO",
    "RETIRADO",
    "ServiceProviderApplicationSubmission",
    "CREDENCIAL_DECLARADA",
    "CREDENCIAL_VERIFICADA",
    "DOCUMENTO_PENDIENTE",
    "EMPRESA",
    "ESTADOS_DE_CREDENCIAL",
    "ESTADOS_DE_DOCUMENTO",
    "ESTADOS_DE_POLITICA",
    "ESTADOS_DE_PRESTADOR",
    "FORMATOS_DE_DOCUMENTO",
    "PERSONA_NATURAL",
    "POLITICA_PUBLICADA",
    "POLITICA_CONDICIONES_DE_CONTRATACION",
    "POLITICA_TERMINOS_DEL_PRESTADOR",
    "PRESTADOR_ACTIVO",
    "PRESTADOR_PENDIENTE",
    "PRESTADOR_SUSPENDIDO",
    "ServicePolicy",
    "ServiceProvider",
    "ServiceProviderApplication",
    "ServiceProviderApplicationEvent",
    "ServiceProviderCredential",
    "ServiceProviderDocument",
    "TIPOS_DE_CREDENCIAL",
    "TIPOS_DE_DOCUMENTO",
    "TIPOS_DE_POLITICA",
    "TIPOS_DE_PRESTADOR",
    "condicion_de_saltos",
]
