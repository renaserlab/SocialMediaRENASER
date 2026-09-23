"""Garantía de 7 días y devoluciones. Mapea cuatro tablas de la 0049.

Los índices únicos parciales de este fichero SON la política de devoluciones.
Escritos como un `if` en Python, dos pestañas abiertas se los saltan: las dos
leen antes de que escriba ninguna, las dos ven que no hay reembolso previo y
las dos cobran. Un índice único no se puede esquivar.

Se declaran también aquí —y no solo en el SQL— porque las pruebas corren sobre
SQLite, que respeta los índices parciales y los CHECK igual que PostgreSQL. Sin
declararlos, las pruebas de concurrencia pasarían por casualidad.

El esquema es propiedad de las migraciones; esto solo mapea.
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.modules.refunds.estados import SQL_VIVOS
from app.shared.database import Base


def _uuid() -> str:
    return str(uuid4())


_metadata = JSON().with_variant(JSONB, "postgresql")

#: Lo que dura la garantía, en horas. Exactamente 168 = 7 × 24.
#:
#: Está aquí y no en la configuración a propósito: cambiarlo por variable de
#: entorno alteraría el plazo de garantías YA empezadas, que es una promesa
#: hecha a alguien. Si algún día cambia, cambia para las nuevas — y por eso
#: `expires_at` se guarda en la fila en vez de calcularse al leer.
HORAS_DE_GARANTIA = 168


class CourseRefundWindow(Base):
    """Cuándo empezó a contar la garantía de una persona en un curso.

    UNA POR (usuario, curso) PARA TODA LA VIDA DE LA CUENTA, no por orden. Eso
    es lo que hace que recomprar no regale una segunda garantía: la ventana ya
    existe con su `refund_used_at` puesto y la recompra no la toca.
    """

    __tablename__ = "course_refund_windows"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    course_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("courses.id", ondelete="CASCADE"), index=True
    )
    order_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("orders.id", ondelete="SET NULL"), nullable=True
    )
    #: Lo pone el SERVIDOR al entregar contenido protegido por primera vez.
    #: Nunca el cliente: una fecha que manda el móvil se puede retrasar para
    #: estirar el plazo indefinidamente.
    first_accessed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    #: Redundante con `first_accessed_at + 168h` y a propósito: el plazo de una
    #: garantía ya empezada no puede cambiar porque alguien edite una constante.
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    refund_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    refund_request_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "expires_at > first_accessed_at", name="course_refund_windows_plazo"
        ),
        # Si está usada, tiene fecha de uso; y al revés. Estaba solo en el SQL
        # de la 0049, así que en pruebas se podía crear una garantía consumida
        # SIN fecha de consumo —un estado que producción rechaza— y la suite se
        # ponía verde. Las restricciones que decide la base tienen que estar en
        # los dos sitios o no protegen nada donde se comprueban las cosas.
        CheckConstraint(
            "(refund_used_at is null and refund_request_id is null) "
            "or (refund_used_at is not null)",
            name="course_refund_windows_uso_coherente",
        ),
        # LA INVARIANTE NÚMERO UNO. Sin esto, dos peticiones simultáneas a la
        # primera lección crean dos ventanas y la persona tiene dos garantías.
        Index("course_refund_windows_unica", "user_id", "course_id", unique=True),
    )


class RefundRequest(Base):
    """Una solicitud de devolución y su estado.

    Las transiciones válidas están en `estados.py`: son una regla de negocio,
    no una restricción de integridad. Lo que sí es integridad, y va abajo, es
    que no haya dos solicitudes vivas sobre el mismo dinero ni dos reembolsos
    con éxito sobre el mismo curso.
    """

    __tablename__ = "refund_requests"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    order_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("orders.id", ondelete="RESTRICT"), index=True
    )
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    course_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("courses.id", ondelete="CASCADE"), index=True
    )

    status: Mapped[str] = mapped_column(
        String(24), default="requested", server_default="requested"
    )
    reason: Mapped[str] = mapped_column(String(32))
    #: PRIVADA. No se le enseña al propietario del curso, que solo ve el estado
    #: comercial de la venta.
    explanation: Mapped[str | None] = mapped_column(Text, nullable=True)

    #: Congelado desde la ORDEN al crear la solicitud. Nunca llega del cliente:
    #: aceptar un importe del navegador es dejar elegir cuánto se devuelve.
    amount_minor: Mapped[int] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(3))

    reviewer_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )
    review_notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    external_refund_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    provider: Mapped[str | None] = mapped_column(String(32), nullable=True)
    environment: Mapped[str | None] = mapped_column(String(16), nullable=True)

    requested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    resolved_at: Mapped[datetime | None] = mapped_column(
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
            "status in ('requested', 'under_review', 'approved', "
            "'refund_processing', 'refunded', 'rejected', 'failed', 'cancelled')",
            name="refund_requests_status",
        ),
        CheckConstraint(
            "reason in ('not_as_expected', 'content_quality', "
            "'technical_problem', 'other')",
            name="refund_requests_reason",
        ),
        CheckConstraint("amount_minor >= 0", name="refund_requests_amount"),
        # El entorno es 'sandbox' o 'production', y nada más. Estaba solo en el
        # SQL: en pruebas se podía escribir 'live' o 'test' —lo que devuelve
        # cualquier pasarela— y la fila entraba; en producción la rechaza.
        CheckConstraint(
            "environment is null or environment in ('sandbox', 'production')",
            name="refund_requests_environment",
        ),
        # UNA SOLICITUD VIVA POR ORDEN. Parcial: rechazadas y canceladas puede
        # haber varias —es historial—; abiertas sobre el mismo dinero, una.
        #
        # El `WHERE` sale de `estados.SQL_VIVOS` y no se escribe aquí a mano:
        # tiene que coincidir LETRA POR LETRA con el de la inserción, o la base
        # rechaza el `ON CONFLICT` con un error que no menciona el motivo real.
        Index(
            "refund_requests_viva_por_orden",
            "order_id",
            unique=True,
            postgresql_where=text(SQL_VIVOS),
            sqlite_where=text(SQL_VIVOS),
        ),
        # UN REEMBOLSO CON ÉXITO POR (usuario, curso), PARA SIEMPRE. Es la
        # política de una sola devolución, y va aquí porque un `if` se salta
        # con dos pestañas abiertas.
        Index(
            "refund_requests_exito_unico",
            "user_id",
            "course_id",
            unique=True,
            postgresql_where=text("status = 'refunded'"),
            sqlite_where=text("status = 'refunded'"),
        ),
    )


class RefundRequestEvent(Base):
    """Quién movió qué y cuándo. Solo-añadir.

    Un reembolso de dinero real sin rastro de quién lo autorizó no es
    defendible ante nadie: ni ante el alumno, ni ante el propietario del curso,
    ni ante la pasarela si abre una investigación.
    """

    __tablename__ = "refund_request_events"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    refund_request_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("refund_requests.id", ondelete="CASCADE"),
        index=True,
    )
    from_status: Mapped[str | None] = mapped_column(String(24), nullable=True)
    to_status: Mapped[str] = mapped_column(String(24))
    #: Nulo cuando lo movió el sistema (un webhook), no una persona.
    actor_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )
    actor_role: Mapped[str] = mapped_column(
        String(16), default="system", server_default="system"
    )
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    external_reference: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: Identificadores y códigos. NUNCA secretos ni el cuerpo de un webhook.
    event_metadata: Mapped[dict] = mapped_column(
        "metadata", _metadata, default=dict
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "actor_role in ('user', 'admin', 'system')",
            name="refund_request_events_actor_role",
        ),
    )


class RefundPolicyAcceptance(Base):
    """«Sé que esta recompra no tiene garantía», firmado y fechado.

    Se guardan la VERSIÓN y el HASH del texto: si mañana cambia la redacción,
    las aceptaciones antiguas siguen apuntando a la que se mostró. Sin eso, «lo
    aceptó» no se puede demostrar, porque no se sabría el qué.
    """

    __tablename__ = "refund_policy_acceptances"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    course_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("courses.id", ondelete="CASCADE"), index=True
    )
    #: Nulo mientras la orden no existe: se acepta ANTES de crear el checkout.
    order_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("orders.id", ondelete="SET NULL"), nullable=True
    )
    policy_version: Mapped[str] = mapped_column(String(32))
    policy_hash: Mapped[str] = mapped_column(String(64))

    # ---- Por dónde se iba a comprar cuando se aceptó (migración 0054) ------- #
    #
    # LAS TRES SON OPCIONALES Y NO SE RELLENAN HACIA ATRÁS. Las aceptaciones
    # anteriores a la 0054 se firmaron sin estos datos, y una fila con `provider`
    # nulo significa exactamente eso. Inventarles un valor plausible sería
    # escribir en un registro de consentimientos algo que nadie firmó.
    #
    # `provider` NO ES EL CANAL. El canal es 'android' / 'ios'; el proveedor es
    # 'google' / 'apple' / 'stripe', y es lo que admite el CHECK de la base.
    # Guardar el canal aquí reventaría al insertar.
    provider: Mapped[str | None] = mapped_column(String(16), nullable=True)
    external_product_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    #: La referencia de la operación de tienda con la que se consumió. En el
    #: checkout web esto va por `order_id`; en las tiendas la orden no existe
    #: hasta después del cobro, así que hace falta otra forma de responder «qué
    #: aceptó exactamente quien hizo ESTA compra».
    operation_ref: Mapped[str | None] = mapped_column(String(255), nullable=True)

    accepted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        Index(
            "refund_policy_acceptances_unica",
            "user_id",
            "course_id",
            "order_id",
            unique=True,
            postgresql_where=text("order_id is not null"),
            sqlite_where=text("order_id is not null"),
        ),
    )
