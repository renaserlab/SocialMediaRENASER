"""Modelos de la migración 0050: políticas, consentimientos y auditoría.

Las tres tablas comparten una propiedad y es la que las define: **lo que se
escribe aquí no se reescribe**. Una política publicada, un consentimiento y un
evento de auditoría son pruebas de algo que pasó; editarlos no corrige un error,
lo tapa. La base lo impide con disparadores (ver la 0050), no solo con RLS: la
API entra con la clave de servicio y la RLS se la salta.
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    JSON,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.shared.database import Base

_DOCUMENTO = JSONB().with_variant(JSON, "sqlite")

#: El identificador que se usa en el índice único cuando el alcance es global.
#: Un `NULL` no colisiona con otro `NULL` en un índice, así que sin este relleno
#: el «un solo consentimiento pendiente» no protegería nada en el caso global.
SIN_ALCANCE = "00000000-0000-0000-0000-000000000000"


def _uuid() -> str:
    return str(uuid4())


class PolicyVersion(Base):
    """Un texto legal, con su versión y su huella, guardado como DATO.

    HOY EL TEXTO VIVE EN EL CÓDIGO (`refunds/politica.py`, `VERSION_ACTUAL`).
    Eso significa que la huella guardada en una aceptación solo demuestra algo
    mientras esa versión del código siga en el repositorio: dentro de un año,
    «lo aceptó» no dice el qué. Aquí el texto es una fila.

    UNA PUBLICADA NO SE EDITA. Cambiar la redacción obliga a publicar otra
    versión; las aceptaciones ya guardadas siguen apuntando a la suya. Lo impide
    un disparador de la 0050, porque la RLS no alcanza a la clave de servicio.
    """

    __tablename__ = "policy_versions"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    policy_type: Mapped[str] = mapped_column(Text)
    jurisdiction: Mapped[str] = mapped_column(Text, default="PE", server_default="PE")
    locale: Mapped[str] = mapped_column(Text, default="es", server_default="es")
    version: Mapped[str] = mapped_column(Text)

    body: Mapped[str] = mapped_column(Text)
    body_sha256: Mapped[str] = mapped_column(Text)
    #: Lo que hay que marcar para aceptar, cuando la política lo lleva.
    checkbox_text: Mapped[str | None] = mapped_column(Text, nullable=True)

    status: Mapped[str] = mapped_column(Text, default="draft", server_default="draft")
    effective_from: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    effective_to: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    published_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    published_by: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "policy_type in ('refund_repurchase', 'terms', 'privacy', 'guarantee')",
            name="policy_versions_type",
        ),
        CheckConstraint(
            "status in ('draft', 'published', 'superseded')",
            name="policy_versions_status",
        ),
        # Publicada quiere decir COMPLETA. Sin esto, «publicada» podría
        # significar «publicada sin fecha de vigencia», que no significa nada.
        CheckConstraint(
            "status <> 'published' "
            "or (effective_from is not null and published_at is not null)",
            name="policy_versions_publicada_completa",
        ),
        CheckConstraint(
            "effective_to is null or effective_from is null "
            "or effective_to > effective_from",
            name="policy_versions_vigencia",
        ),
        Index(
            "policy_versions_unica",
            "policy_type",
            "jurisdiction",
            "locale",
            "version",
            unique=True,
        ),
        # UNA SOLA VIGENTE por tipo, jurisdicción e idioma. Es lo que impide que
        # el servidor tenga que ELEGIR entre dos, que es exactamente lo que no
        # puede pasar con un texto que alguien va a firmar.
        Index(
            "policy_versions_vigente_unica",
            "policy_type",
            "jurisdiction",
            "locale",
            unique=True,
            postgresql_where=text("status = 'published' and effective_to is null"),
            sqlite_where=text("status = 'published' and effective_to is null"),
        ),
    )


class ConsentRecord(Base):
    """Que alguien aceptó un texto concreto, en un momento concreto.

    `refund_policy_acceptances` (0049) SIGUE EXISTIENDO y no se migra: su
    unicidad es de devoluciones. Esta es la general, para lo que venga.

    LO QUE LA HACE ÚTIL COMO PRUEBA es lo que no se puede hacer con ella: no se
    borra, no se reescribe, y su consumo se sella una sola vez.
    """

    __tablename__ = "consent_records"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    #: `SET NULL` desde la 0089 (antes `RESTRICT`), y nunca `CASCADE`: borrar un
    #: perfil no puede borrar la prueba de lo que esa persona aceptó antes de
    #: pagar, pero la prueba tampoco puede impedir que se vaya. Se queda,
    #: anónima. Siempre nace con persona: NULL solo lo pone la baja de la cuenta.
    subject_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="SET NULL"), index=True, nullable=True
    )
    policy_version_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("policy_versions.id", ondelete="RESTRICT")
    )
    #: Desnormalizados a propósito: la respuesta se tiene que poder dar aunque
    #: la fila de la política cambie de estado.
    policy_type: Mapped[str] = mapped_column(Text)
    policy_version: Mapped[str] = mapped_column(Text)
    #: Huella del texto EXACTO que se mostró, con sus huecos ya rellenados.
    policy_hash: Mapped[str] = mapped_column(Text)

    scope_kind: Mapped[str] = mapped_column(
        Text, default="global", server_default="global"
    )
    scope_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)

    consumed_by_kind: Mapped[str | None] = mapped_column(Text, nullable=True)
    consumed_by_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    consumed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    accepted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    # --- Contexto de origen. NUNCA en claro. --- #
    request_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: SHA-256 de la IP con la sal del servidor. Permite comparar sin poder leer.
    ip_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: Prefijo de red (/24 en IPv4, /48 en IPv6). Sirve para el análisis de
    #: abuso y no identifica a nadie por sí solo.
    ip_prefix: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: Familia y versión mayor, no la cadena completa: la completa es una huella
    #: digital del aparato.
    user_agent_family: Mapped[str | None] = mapped_column(Text, nullable=True)
    channel: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "scope_kind in ('global', 'course', 'order')", name="consent_records_scope"
        ),
        CheckConstraint(
            "(scope_kind = 'global' and scope_id is null) "
            "or (scope_kind <> 'global' and scope_id is not null)",
            name="consent_records_scope_coherente",
        ),
        CheckConstraint(
            "(consumed_at is null and consumed_by_id is null and consumed_by_kind is null) "
            "or (consumed_at is not null and consumed_by_id is not null "
            "and consumed_by_kind is not null)",
            name="consent_records_consumo_coherente",
        ),
        # LA IP EN CLARO NO CABE AQUI NI POR ACCIDENTE. En la 0050 la
        # comprobacion usa el operador de expresiones regulares de
        # PostgreSQL (`~ '^[0-9a-f]{64}$'`), que SQLite no tiene; aqui se
        # escribe con `length`, que funciona en los dos. El NOMBRE es el
        # mismo a proposito: es por el nombre por el que el contrato entre
        # el SQL y los modelos las empareja. La de la base es mas estricta;
        # esta basta para que una prueba no pueda escribir una IP legible.
        CheckConstraint(
            "ip_hash is null or length(ip_hash) = 64",
            name="consent_records_ip_sin_claro",
        ),
        # UNA ACEPTACIÓN NO SE CONSUME DOS VECES. El enlace aceptación→orden se
        # resolvía en Python con un `order_by … limit 1` tras un fallo ya
        # corregido a mano; esto lo sostiene la base.
        Index(
            "consent_records_consumo_unico",
            "consumed_by_kind",
            "consumed_by_id",
            unique=True,
            postgresql_where=text("consumed_by_id is not null"),
            sqlite_where=text("consumed_by_id is not null"),
        ),
        # Y UN DOBLE TOQUE NO CREA DOS. El «mira si existe y si no inserta» de
        # Python lo pasan dos peticiones simultáneas; un índice único no.
        Index(
            "consent_records_pendiente_unico",
            "subject_id",
            "policy_type",
            "scope_kind",
            text(f"coalesce(scope_id, '{SIN_ALCANCE}')"),
            "policy_version_id",
            unique=True,
            postgresql_where=text("consumed_at is null"),
            sqlite_where=text("consumed_at is null"),
        ),
    )


class AuditEvent(Base):
    """Quién hizo qué, sobre qué, y cómo acabó.

    NO SUSTITUYE A `refund_request_events`. Aquella es la máquina de estados del
    expediente de devolución, con claves foráneas reales y consultas de negocio
    encima —`_fallos_terminales` cuenta sus eventos fallidos—. Esta es el rastro
    de las operaciones sensibles que hoy no dejan ninguno: publicar un curso,
    congelar un saldo, lanzar una transferencia. Antes de la 0050, la única
    respuesta a «¿quién movió este dinero?» era una línea de registro que nadie
    conserva.

    DISTINGUE LO INTENTADO DE LO CONSEGUIDO (`outcome`). Un rastro que solo sabe
    contar éxitos no sirve para investigar nada, que es para lo único que sirve
    un rastro.
    """

    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    actor_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )
    actor_role: Mapped[str] = mapped_column(
        String(16), default="system", server_default="system"
    )

    action: Mapped[str] = mapped_column(Text)
    entity_type: Mapped[str] = mapped_column(Text)
    entity_id: Mapped[str] = mapped_column(Uuid(as_uuid=False))

    outcome: Mapped[str] = mapped_column(String(8), default="ok", server_default="ok")

    previous_state: Mapped[str | None] = mapped_column(Text, nullable=True)
    new_state: Mapped[str | None] = mapped_column(Text, nullable=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    external_reference: Mapped[str | None] = mapped_column(Text, nullable=True)

    #: Identificadores y códigos. NUNCA cuerpos de aviso, cabeceras ni secretos.
    payload: Mapped[dict] = mapped_column(_DOCUMENTO, default=dict)

    request_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    ip_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
    ip_prefix: Mapped[str | None] = mapped_column(Text, nullable=True)
    user_agent_family: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "actor_role in ('user', 'admin', 'moderator', 'system')",
            name="audit_events_actor_role",
        ),
        CheckConstraint(
            "outcome in ('ok', 'denied', 'error')", name="audit_events_outcome"
        ),
        # Mismo motivo que en `consent_records`: la de la base usa el operador
        # de expresiones regulares de PostgreSQL, esta usa `length`.
        CheckConstraint(
            "ip_hash is null or length(ip_hash) = 64",
            name="audit_events_ip_sin_claro",
        ),
        Index("audit_events_entidad_idx", "entity_type", "entity_id", "occurred_at"),
        Index("audit_events_actor_idx", "actor_id", "occurred_at"),
        Index("audit_events_accion_idx", "action", "occurred_at"),
    )
