"""Las tablas financieras propias de Productos (migración 0082).

QUÉ NO ESTÁ AQUÍ, Y ES LA MITAD DEL DISEÑO. El saldo de una venta, la cuenta de
cobro, la transferencia y la reserva **no son de este fichero**: viven en
`commerce/models.py` y en `events/finanzas_models.py` desde la 0049 y la 0068, y
Productos los usa tal cual. Lo único que hizo falta fue un tercer origen en
`owner_sale_balances` y dos columnas en `owner_sale_reserves`.

QUÉ SÍ ES PROPIO, Y POR QUÉ. La devolución y la disputa. `refund_requests` es de
Cursos y cuelga de `orders`; `event_disputes` se llama así y sus claves ajenas
apuntan a `events` y a `event_orders`. Meter dentro las de Productos dejaría dos
tablas cuyo nombre miente y cuyas claves ajenas sobran en la mitad de las filas.
Lo que sí se reutiliza entero es el **adaptador** de devoluciones —`RefundProvider`
con su `NoConfigurado`, que falla en cerrado y no simula nada— y la máquina de
estados del saldo.

APROBAR NO ES PAGAR. Una fila de `product_refunds` en `approved` dice que alguien
con permiso financiero decidió devolver un importe. Que el dinero haya salido lo
dice `confirmed`, y eso solo lo escribe el aviso de la pasarela.

EL IMPORTE NO SE CALCULA: LO TECLEA UNA PERSONA. Cuánto se devuelve en cada una
de las cinco salidas del blueprint es una decisión que la empresa no ha tomado,
así que aquí no hay ninguna fórmula ni ningún valor por defecto.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.modules.events.models import _uuid
from app.shared.database import Base

# --------------------------------------------------------------------------- #
# Los estados de una devolución.
#
# CINCO, Y NO TRES. «Aprobada» no es «pedida», «pedida» no es «procesándose» y
# ninguna de las tres es «el dinero llegó». Juntarlas haría que la pantalla
# dijera «devuelto» sobre algo que la pasarela todavía no ha aceptado, que es
# exactamente el error que esta tabla existe para no cometer.
# --------------------------------------------------------------------------- #
DEVOLUCION_APROBADA = "approved"
DEVOLUCION_PEDIDA = "requested"
DEVOLUCION_EN_CURSO = "processing"
DEVOLUCION_CONFIRMADA = "confirmed"
DEVOLUCION_FALLIDA = "failed"
DEVOLUCION_ANULADA = "cancelled"

ESTADOS_DE_DEVOLUCION = (
    DEVOLUCION_APROBADA,
    DEVOLUCION_PEDIDA,
    DEVOLUCION_EN_CURSO,
    DEVOLUCION_CONFIRMADA,
    DEVOLUCION_FALLIDA,
    DEVOLUCION_ANULADA,
)

#: LAS QUE TODAVÍA APARTAN DINERO. Mientras una devolución esté en cualquiera de
#: estas, el saldo de ese pedido no se le paga a nadie: `failed` y `cancelled`
#: no aparecen porque ya se decidieron, y `confirmed` SÍ aparece porque el
#: dinero salió y ese saldo ya no es del proveedor.
DEVOLUCION_RETIENE = (
    DEVOLUCION_APROBADA,
    DEVOLUCION_PEDIDA,
    DEVOLUCION_EN_CURSO,
    DEVOLUCION_CONFIRMADA,
)

#: Las que todavía se pueden mover. Una confirmada no vuelve atrás.
DEVOLUCION_EN_MARCHA = (
    DEVOLUCION_APROBADA,
    DEVOLUCION_PEDIDA,
    DEVOLUCION_EN_CURSO,
)

DEVOLUCION_TOTAL = "full"
DEVOLUCION_PARCIAL = "partial"
CLASES_DE_DEVOLUCION = (DEVOLUCION_TOTAL, DEVOLUCION_PARCIAL)

# --------------------------------------------------------------------------- #
# Los estados de una disputa. Son los de la pasarela, no los nuestros.
# --------------------------------------------------------------------------- #
DISPUTA_ABIERTA = "open"
DISPUTA_NECESITA_RESPUESTA = "needs_response"
DISPUTA_EN_REVISION = "under_review"
DISPUTA_GANADA = "won"
DISPUTA_PERDIDA = "lost"
DISPUTA_RETIRADA = "withdrawn"

ESTADOS_DE_DISPUTA = (
    DISPUTA_ABIERTA,
    DISPUTA_NECESITA_RESPUESTA,
    DISPUTA_EN_REVISION,
    DISPUTA_GANADA,
    DISPUTA_PERDIDA,
    DISPUTA_RETIRADA,
)

#: LAS QUE BLOQUEAN EL DINERO. Una disputa abierta es dinero que puede volver.
DISPUTA_VIVA = (
    DISPUTA_ABIERTA,
    DISPUTA_NECESITA_RESPUESTA,
    DISPUTA_EN_REVISION,
)

DISPUTA_CERRADA = (DISPUTA_GANADA, DISPUTA_PERDIDA, DISPUTA_RETIRADA)


class ProductRefund(Base):
    """El dinero que vuelve de un pedido de producto.

    NO SE BORRA Y NO SE RECTIFICA REESCRIBIÉNDOLA: una devolución equivocada se
    corrige con otra fila y con su historial, que es lo que dice el blueprint
    §14.1 de los registros financieros.
    """

    __tablename__ = "product_refunds"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)

    order_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_orders.id", ondelete="RESTRICT")
    )
    #: EL EXPEDIENTE QUE LA ORIGINA, cuando lo hay. Nulo para una devolución que
    #: decide administración sin reclamación de por medio —una cancelación, un
    #: error de cobro— y eso es un caso distinto, no un hueco.
    incident_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("product_incidents.id", ondelete="RESTRICT"),
        nullable=True,
    )
    #: EL SALDO AL QUE LE AFECTA. Nulo mientras no exista: sin comisión
    #: configurada no hay saldo, y la devolución se puede registrar igual.
    balance_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("owner_sale_balances.id", ondelete="RESTRICT"),
        nullable=True,
    )

    amount_minor: Mapped[int] = mapped_column(BigInteger)
    currency: Mapped[str] = mapped_column(String(3))
    #: SI ES TOTAL O PARCIAL, dicho y no deducido. Comparar el importe con el
    #: bruto para adivinarlo falla en cuanto haya dos parciales que sumen el
    #: total, que es una cosa distinta de una total.
    kind: Mapped[str] = mapped_column(Text)

    status: Mapped[str] = mapped_column(Text, default=DEVOLUCION_APROBADA)

    provider: Mapped[str] = mapped_column(Text, default="none")
    environment: Mapped[str] = mapped_column(Text)
    external_refund_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: ESTABLE POR DEVOLUCIÓN. Un reintento reutiliza la misma y no devuelve dos
    #: veces el mismo dinero.
    idempotency_key: Mapped[str] = mapped_column(Text)

    #: QUIÉN LO DECIDIÓ. Obligatorio: no hay devoluciones que decida el sistema.
    decided_by: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="RESTRICT")
    )
    decision_reason: Mapped[str] = mapped_column(Text)

    requested_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    confirmed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    failed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    failure_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    failure_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("amount_minor > 0", name="product_refunds_importe"),
        CheckConstraint(
            "currency = upper(currency) and length(currency) = 3",
            name="product_refunds_moneda",
        ),
        CheckConstraint(
            "kind in ('full', 'partial')", name="product_refunds_clase"
        ),
        CheckConstraint(
            "status in ('approved', 'requested', 'processing', 'confirmed', "
            "'failed', 'cancelled')",
            name="product_refunds_estado",
        ),
        CheckConstraint(
            "length(trim(decision_reason)) between 3 and 1000",
            name="product_refunds_motivo",
        ),
        CheckConstraint(
            "failure_message is null or length(failure_message) <= 500",
            name="product_refunds_mensaje_del_fallo",
        ),
        # LAS FECHAS Y EL ESTADO CUENTAN LO MISMO.
        CheckConstraint(
            "(status = 'confirmed') = (confirmed_at is not null)",
            name="product_refunds_confirmada_con_fecha",
        ),
        CheckConstraint(
            "(status = 'failed') = (failed_at is not null)",
            name="product_refunds_fallida_con_fecha",
        ),
        # Y NO SE CONFIRMA LO QUE NO SE PIDIÓ: un `confirmed` sin `requested_at`
        # sería dinero devuelto sin que nadie se lo pidiera a la pasarela.
        CheckConstraint(
            "status not in ('processing', 'confirmed') or requested_at is not null",
            name="product_refunds_confirmada_se_pidio",
        ),
        # UN FALLO DICE POR QUÉ. Un `failed` sin código no le sirve a nadie.
        CheckConstraint(
            "(status = 'failed') = (failure_code is not null)",
            name="product_refunds_fallida_con_motivo",
        ),
        UniqueConstraint("idempotency_key", name="product_refunds_clave_unica"),
        # UNA DEVOLUCIÓN VIVA POR EXPEDIENTE. Dos serían el mismo dinero dos
        # veces, y es lo único que lo impide bajo concurrencia.
        Index(
            "product_refunds_viva_por_expediente",
            "incident_id",
            unique=True,
            postgresql_where=text(
                "incident_id is not null and status in "
                "('approved', 'requested', 'processing', 'confirmed')"
            ),
            sqlite_where=text(
                "incident_id is not null and status in "
                "('approved', 'requested', 'processing', 'confirmed')"
            ),
        ),
        Index(
            "product_refunds_del_pedido",
            "order_id",
            text("created_at desc"),
        ),
        Index(
            "product_refunds_por_atender",
            "created_at",
            "id",
            postgresql_where=text(
                "status in ('approved', 'requested', 'processing')"
            ),
            sqlite_where=text("status in ('approved', 'requested', 'processing')"),
        ),
    )


class ProductRefundEvent(Base):
    """El historial de una devolución. SOLO SE AÑADE: lo impone un disparador."""

    __tablename__ = "product_refund_events"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    refund_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_refunds.id", ondelete="CASCADE")
    )
    from_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    to_status: Mapped[str] = mapped_column(Text)
    actor_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )
    actor_role: Mapped[str] = mapped_column(Text)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: LO QUE DIJO LA PASARELA, tal cual, para poder conciliar después.
    provider_reference: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "reason is null or length(reason) <= 500",
            name="product_refund_events_motivo",
        ),
        Index("product_refund_events_de_la_devolucion", "refund_id", "created_at"),
    )


class ProductDispute(Base):
    """Un contracargo sobre un pedido de producto.

    LA ABRE EL BANCO DE QUIEN COMPRÓ, se puede ganar, y quién asume la pérdida
    **no está decidido**: bloquea el importe y avisa; no descuenta nada de
    ningún otro saldo. Es la misma decisión que tomó la 0068 para Eventos.
    """

    __tablename__ = "product_disputes"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    order_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_orders.id", ondelete="RESTRICT")
    )
    balance_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("owner_sale_balances.id", ondelete="RESTRICT"),
        nullable=True,
    )

    #: LA REFERENCIA DE LA PASARELA ES LA IDENTIDAD DE LA DISPUTA: dos avisos
    #: del mismo contracargo traen la misma, y por eso no se duplica.
    provider: Mapped[str] = mapped_column(Text)
    external_dispute_id: Mapped[str] = mapped_column(Text)

    amount_minor: Mapped[int] = mapped_column(BigInteger)
    currency: Mapped[str] = mapped_column(String(3))

    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(Text)

    opened_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    due_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    closed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("amount_minor > 0", name="product_disputes_importe"),
        CheckConstraint(
            "currency = upper(currency) and length(currency) = 3",
            name="product_disputes_moneda",
        ),
        CheckConstraint(
            "status in ('open', 'needs_response', 'under_review', 'won', "
            "'lost', 'withdrawn')",
            name="product_disputes_estado",
        ),
        CheckConstraint(
            "(status in ('won', 'lost', 'withdrawn')) = (closed_at is not null)",
            name="product_disputes_cerrada_con_fecha",
        ),
        Index(
            "product_disputes_referencia_unica",
            "provider",
            "external_dispute_id",
            unique=True,
        ),
        Index(
            "product_disputes_abiertas",
            "order_id",
            postgresql_where=text(
                "status in ('open', 'needs_response', 'under_review')"
            ),
            sqlite_where=text(
                "status in ('open', 'needs_response', 'under_review')"
            ),
        ),
    )


class ProductDisputeEvent(Base):
    """El historial de una disputa. SOLO SE AÑADE."""

    __tablename__ = "product_dispute_events"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    dispute_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("product_disputes.id", ondelete="CASCADE")
    )
    from_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    to_status: Mapped[str] = mapped_column(Text)
    actor_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )
    actor_role: Mapped[str] = mapped_column(Text)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "reason is null or length(reason) <= 500",
            name="product_dispute_events_motivo",
        ),
        Index("product_dispute_events_de_la_disputa", "dispute_id", "created_at"),
    )


__all__ = [
    "CLASES_DE_DEVOLUCION",
    "DEVOLUCION_ANULADA",
    "DEVOLUCION_APROBADA",
    "DEVOLUCION_CONFIRMADA",
    "DEVOLUCION_EN_CURSO",
    "DEVOLUCION_EN_MARCHA",
    "DEVOLUCION_FALLIDA",
    "DEVOLUCION_PARCIAL",
    "DEVOLUCION_PEDIDA",
    "DEVOLUCION_RETIENE",
    "DEVOLUCION_TOTAL",
    "DISPUTA_ABIERTA",
    "DISPUTA_CERRADA",
    "DISPUTA_EN_REVISION",
    "DISPUTA_GANADA",
    "DISPUTA_NECESITA_RESPUESTA",
    "DISPUTA_PERDIDA",
    "DISPUTA_RETIRADA",
    "DISPUTA_VIVA",
    "ESTADOS_DE_DEVOLUCION",
    "ESTADOS_DE_DISPUTA",
    "ProductDispute",
    "ProductDisputeEvent",
    "ProductRefund",
    "ProductRefundEvent",
]
