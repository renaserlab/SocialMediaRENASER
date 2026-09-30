"""Las tablas de la reserva de Servicios (migración 0093, Incremento 5).

SEIS TABLAS, cada una con un solo trabajo:

  service_holds                LA RETENCIÓN: un horario apartado unos minutos
                               para una persona. ES EL REGISTRO QUE OCUPA: al
                               confirmar pasa a `consumed` y sigue ocupando
                               por la reserva.
  service_orders               EL PEDIDO: lo comercial. Hoy solo gratuito, sin
                               cobro ni pasarela.
  service_bookings             LA RESERVA: la cita y su fotografía.
  service_booking_intakes      lo que pide la atención (nota y, a domicilio,
                               la dirección). Privado y de la persona.
  service_booking_acceptances  lo que se aceptó, con su huella.
  service_booking_events       el historial. Solo se añade.

LO QUE DECLARA EL ORM LO DECLARA TAMBIÉN LA BASE, con el mismo nombre y la
misma expresión en funciones de los dos motores (nada de expresiones
regulares ni de intervalos: la batería sin PostgreSQL crea estas tablas en
SQLite). `tests/test_servicios_migracion_0093.py` compara los dos.

LO QUE SOLO DECLARA LA BASE, y se prueba contra PostgreSQL de verdad: la
EXCLUSIÓN que impide que dos sesiones distintas se pisen (la autoridad de la
doble reserva), los saltos de una retención, la reserva y el pedido que no se
reescriben, las comprobaciones diferidas que impiden un estado a medias, la
baja de una cuenta con reservas por venir y el borrado solo en cascada.
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    CHAR,
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.modules.events.models import _uuid
from app.modules.services import reserva_politica as limites
from app.modules.services.catalogo_models import MODALIDADES
from app.modules.services.models import _parametros
from app.shared.database import Base


def _lista(valores) -> str:
    return ", ".join(repr(v) for v in valores)


# --------------------------------------------------------------------------- #
# Vocabulario
# --------------------------------------------------------------------------- #
#: La retención.
RETENCION_ACTIVA = "active"
RETENCION_CONSUMIDA = "consumed"
RETENCION_LIBERADA = "released"
RETENCION_VENCIDA = "expired"
ESTADOS_DE_RETENCION = (RETENCION_ACTIVA, RETENCION_CONSUMIDA, RETENCION_LIBERADA, RETENCION_VENCIDA)
#: Las que OCUPAN su horario.
OCUPAN = (RETENCION_ACTIVA, RETENCION_CONSUMIDA)

#: La reserva y el pedido. UN SOLO ESTADO en este incremento: una reserva
#: existe cuando está confirmada. `pending_payment` llegará con el cobro, y
#: la cancelación con el Incremento 6.
RESERVA_CONFIRMADA = "confirmed"
ESTADOS_DE_RESERVA = (RESERVA_CONFIRMADA,)
PEDIDO_CONFIRMADO = "confirmed"
ESTADOS_DE_PEDIDO = (PEDIDO_CONFIRMADO,)
#: El pago, separado del estado (arquitectura §5).
PAGO_NO_REQUERIDO = "not_required"
ESTADOS_DE_PAGO = (PAGO_NO_REQUERIDO,)
PASARELA_NINGUNA = "none"
PASARELAS = (PASARELA_NINGUNA,)
ENTORNOS = ("sandbox", "production")
#: Lo único que se contrata hoy.
CONTRATABLES = ("free",)

#: Lo que se acepta.
ACEPTA_CONDICIONES_DE_Z = "booking_terms"
ACEPTA_CONDICIONES_DEL_SERVICIO = "service_conditions"
TIPOS_DE_ACEPTACION = (ACEPTA_CONDICIONES_DE_Z, ACEPTA_CONDICIONES_DEL_SERVICIO)

#: El historial.
RETENCION_CREADA = "hold_created"
RETENCION_SOLTADA = "hold_released"
RETENCION_VENCIO = "hold_expired"
RESERVA_CONFIRMADA_EVENTO = "booking_confirmed"
ACCIONES = (RETENCION_CREADA, RETENCION_SOLTADA, RETENCION_VENCIO, RESERVA_CONFIRMADA_EVENTO)
CLIENTE = "client"
SISTEMA = "system"
ROLES = (CLIENTE, SISTEMA)

_HEXADECIMAL = "0123456789abcdef"


def _zona(columna: str) -> str:
    return f"length({columna}) between 3 and 64 and {columna} like '%/%'"


def _horario() -> str:
    return "starts_at < ends_at and occupied_from <= starts_at and ends_at <= occupied_until"


def _texto(columna: str, maximo: int, *, nulo: bool = False) -> str:
    base = f"length(trim({columna})) between 1 and {maximo}"
    return f"{columna} is null or {base}" if nulo else base


# --------------------------------------------------------------------------- #
# 1. La retención
# --------------------------------------------------------------------------- #
class ServiceHold(Base):
    __tablename__ = "service_holds"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    service_id: Mapped[str] = mapped_column(Uuid(as_uuid=False), ForeignKey("services.id", ondelete="CASCADE"))
    #: La versión PUBLICADA cuando se retuvo: confirmar exige que siga siéndolo.
    version_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_versions.id", ondelete="CASCADE")
    )
    #: NULA solo tras la baja de la cuenta (0089).
    client_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[str] = mapped_column(Text, server_default=text(f"'{RETENCION_ACTIVA}'"))
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    occupied_from: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    occupied_until: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    timezone: Mapped[str] = mapped_column(Text)
    local_date: Mapped[date] = mapped_column(Date)
    modality: Mapped[str] = mapped_column(Text)
    capacity: Mapped[int] = mapped_column(Integer)
    seat: Mapped[int] = mapped_column(Integer)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint(f"status in ({_lista(ESTADOS_DE_RETENCION)})", name="service_holds_estado"),
        CheckConstraint(_zona("timezone"), name="service_holds_zona"),
        CheckConstraint(f"modality in ({_lista(MODALIDADES)})", name="service_holds_modalidad"),
        CheckConstraint("capacity between 1 and 1000", name="service_holds_capacidad"),
        CheckConstraint(_horario(), name="service_holds_horario"),
        CheckConstraint("seat between 1 and capacity", name="service_holds_plaza"),
        CheckConstraint("expires_at > created_at", name="service_holds_vence"),
        CheckConstraint(
            "(status = 'consumed') = (consumed_at is not null)"
            " and (status = 'released') = (released_at is not null)"
            " and (status = 'expired') = (expired_at is not null)",
            name="service_holds_momentos",
        ),
        Index(
            "service_holds_una_plaza", "service_id", "starts_at", "seat", unique=True,
            postgresql_where=text("status in ('active', 'consumed')"),
            sqlite_where=text("status in ('active', 'consumed')"),
        ),
        Index(
            "service_holds_una_por_persona", "service_id", "starts_at", "client_id", unique=True,
            postgresql_where=text("status in ('active', 'consumed')"),
            sqlite_where=text("status in ('active', 'consumed')"),
        ),
        Index(
            "service_holds_una_activa", "service_id", "client_id", unique=True,
            postgresql_where=text("status = 'active'"),
            sqlite_where=text("status = 'active'"),
        ),
        Index(
            "service_holds_ocupan", "service_id", "occupied_until",
            postgresql_where=text("status in ('active', 'consumed')"),
            sqlite_where=text("status in ('active', 'consumed')"),
        ),
        Index("service_holds_de_la_persona", "client_id", "status"),
        Index(
            "service_holds_por_vencer", "expires_at",
            postgresql_where=text("status = 'active'"),
            sqlite_where=text("status = 'active'"),
        ),
    )


# --------------------------------------------------------------------------- #
# 2. El pedido
# --------------------------------------------------------------------------- #
class ServiceOrder(Base):
    __tablename__ = "service_orders"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    service_id: Mapped[str] = mapped_column(Uuid(as_uuid=False), ForeignKey("services.id", ondelete="CASCADE"))
    version_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_versions.id", ondelete="CASCADE")
    )
    provider_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_providers.id", ondelete="CASCADE")
    )
    client_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[str] = mapped_column(Text, server_default=text(f"'{PEDIDO_CONFIRMADO}'"))
    payment_status: Mapped[str] = mapped_column(Text, server_default=text(f"'{PAGO_NO_REQUERIDO}'"))
    payment_provider: Mapped[str] = mapped_column(Text, server_default=text(f"'{PASARELA_NINGUNA}'"))
    environment: Mapped[str] = mapped_column(Text)
    price_model: Mapped[str] = mapped_column(Text)
    price_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    currency: Mapped[str | None] = mapped_column(CHAR(3), nullable=True)
    total_minor: Mapped[int] = mapped_column(BigInteger, server_default=text("0"))
    title_snapshot: Mapped[str] = mapped_column(Text)
    provider_name_snapshot: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    confirmed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(f"status in ({_lista(ESTADOS_DE_PEDIDO)})", name="service_orders_estado"),
        CheckConstraint(f"payment_status in ({_lista(ESTADOS_DE_PAGO)})", name="service_orders_pago"),
        CheckConstraint(f"payment_provider in ({_lista(PASARELAS)})", name="service_orders_pasarela"),
        CheckConstraint(f"environment in ({_lista(ENTORNOS)})", name="service_orders_entorno"),
        CheckConstraint(f"price_model in ({_lista(CONTRATABLES)})", name="service_orders_modelo"),
        CheckConstraint(_texto("title_snapshot", 300), name="service_orders_titulo"),
        CheckConstraint(_texto("provider_name_snapshot", 200), name="service_orders_prestador"),
        CheckConstraint(
            "price_minor is null and currency is null and total_minor = 0", name="service_orders_sin_dinero"
        ),
        Index("service_orders_de_la_persona", "client_id", text("created_at desc"), text("id desc")),
        Index("service_orders_del_prestador", "provider_id", text("created_at desc"), text("id desc")),
    )


# --------------------------------------------------------------------------- #
# 3. La reserva
# --------------------------------------------------------------------------- #
class ServiceBooking(Base):
    __tablename__ = "service_bookings"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    #: El código que se lee y se dicta: «ABCD-2345».
    booking_code: Mapped[str] = mapped_column(Text)
    order_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_orders.id", ondelete="CASCADE")
    )
    hold_id: Mapped[str] = mapped_column(Uuid(as_uuid=False), ForeignKey("service_holds.id", ondelete="CASCADE"))
    service_id: Mapped[str] = mapped_column(Uuid(as_uuid=False), ForeignKey("services.id", ondelete="CASCADE"))
    version_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_versions.id", ondelete="CASCADE")
    )
    provider_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_providers.id", ondelete="CASCADE")
    )
    client_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[str] = mapped_column(Text, server_default=text(f"'{RESERVA_CONFIRMADA}'"))
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    occupied_from: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    occupied_until: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    timezone: Mapped[str] = mapped_column(Text)
    local_date: Mapped[date] = mapped_column(Date)
    modality: Mapped[str] = mapped_column(Text)
    duration_minutes: Mapped[int] = mapped_column(Integer)
    buffer_before_minutes: Mapped[int] = mapped_column(Integer)
    buffer_after_minutes: Mapped[int] = mapped_column(Integer)
    capacity: Mapped[int] = mapped_column(Integer)
    seat: Mapped[int] = mapped_column(Integer)
    title_snapshot: Mapped[str] = mapped_column(Text)
    provider_name_snapshot: Mapped[str] = mapped_column(Text)
    #: Lo PÚBLICO del lugar (la zona de la ficha). Nunca una dirección.
    location_area_snapshot: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    confirmed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(
            "length(booking_code) = 9 and substr(booking_code, 5, 1) = '-'"
            f" and ltrim(replace(booking_code, '-', ''), '{limites.ALFABETO_DEL_CODIGO}') = ''",
            name="service_bookings_codigo",
        ),
        CheckConstraint(f"status in ({_lista(ESTADOS_DE_RESERVA)})", name="service_bookings_estado"),
        CheckConstraint(_zona("timezone"), name="service_bookings_zona"),
        CheckConstraint(f"modality in ({_lista(MODALIDADES)})", name="service_bookings_modalidad"),
        CheckConstraint("duration_minutes between 5 and 1440", name="service_bookings_duracion"),
        CheckConstraint("buffer_before_minutes between 0 and 240", name="service_bookings_preparacion"),
        CheckConstraint("buffer_after_minutes between 0 and 240", name="service_bookings_descanso"),
        CheckConstraint("capacity between 1 and 1000", name="service_bookings_capacidad"),
        CheckConstraint(_texto("title_snapshot", 300), name="service_bookings_titulo"),
        CheckConstraint(_texto("provider_name_snapshot", 200), name="service_bookings_prestador"),
        CheckConstraint(
            _texto("location_area_snapshot", 200, nulo=True), name="service_bookings_zona_publica"
        ),
        CheckConstraint(_horario(), name="service_bookings_horario"),
        CheckConstraint("seat between 1 and capacity", name="service_bookings_plaza"),
        UniqueConstraint("booking_code", name="service_bookings_codigo_unico"),
        UniqueConstraint("order_id", name="service_bookings_un_pedido"),
        UniqueConstraint("hold_id", name="service_bookings_una_retencion"),
        Index("service_bookings_de_la_persona", "client_id", "starts_at", "id"),
        Index("service_bookings_del_prestador", "provider_id", "starts_at", "id"),
        Index("service_bookings_del_servicio", "service_id", "starts_at"),
    )


# --------------------------------------------------------------------------- #
# 4. Lo que pide la atención
# --------------------------------------------------------------------------- #
class ServiceBookingIntake(Base):
    __tablename__ = "service_booking_intakes"

    booking_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_bookings.id", ondelete="CASCADE"), primary_key=True
    )
    #: Se va CON la persona: su nota y su dirección no le sobreviven.
    client_id: Mapped[str] = mapped_column(Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"))
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    district: Mapped[str | None] = mapped_column(Text, nullable=True)
    address_line: Mapped[str | None] = mapped_column(Text, nullable=True)
    address_reference: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(_texto("note", limites.NOTA_MAXIMA, nulo=True), name="service_booking_intakes_nota"),
        CheckConstraint(
            _texto("district", limites.DISTRITO_MAXIMO, nulo=True), name="service_booking_intakes_distrito"
        ),
        CheckConstraint(
            _texto("address_line", limites.DIRECCION_MAXIMA, nulo=True), name="service_booking_intakes_direccion"
        ),
        CheckConstraint(
            _texto("address_reference", limites.REFERENCIA_MAXIMA, nulo=True),
            name="service_booking_intakes_referencia",
        ),
        CheckConstraint(
            "(district is null) = (address_line is null)"
            " and (address_reference is null or address_line is not null)",
            name="service_booking_intakes_direccion_completa",
        ),
        CheckConstraint("note is not null or address_line is not null", name="service_booking_intakes_algo"),
    )


# --------------------------------------------------------------------------- #
# 5. Lo que se aceptó
# --------------------------------------------------------------------------- #
class ServiceBookingAcceptance(Base):
    __tablename__ = "service_booking_acceptances"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    order_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_orders.id", ondelete="CASCADE")
    )
    kind: Mapped[str] = mapped_column(Text)
    policy_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_policies.id", ondelete="RESTRICT"), nullable=True
    )
    policy_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    version_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_versions.id", ondelete="CASCADE"), nullable=True
    )
    sha256: Mapped[str] = mapped_column(Text)
    #: SIN CLAVE AJENA a propósito (0086, S10).
    accepted_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    accepted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(f"kind in ({_lista(TIPOS_DE_ACEPTACION)})", name="service_booking_acceptances_tipo"),
        CheckConstraint(
            f"length(sha256) = 64 and ltrim(sha256, '{_HEXADECIMAL}') = ''",
            name="service_booking_acceptances_huella",
        ),
        CheckConstraint(
            "(kind = 'booking_terms' and policy_id is not null and policy_version is not null"
            " and version_id is null)"
            " or (kind = 'service_conditions' and version_id is not null and policy_id is null"
            " and policy_version is null)",
            name="service_booking_acceptances_referencia",
        ),
        UniqueConstraint("order_id", "kind", name="service_booking_acceptances_una"),
    )


# --------------------------------------------------------------------------- #
# 6. El historial
# --------------------------------------------------------------------------- #
class ServiceBookingEvent(Base):
    __tablename__ = "service_booking_events"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    service_id: Mapped[str] = mapped_column(Uuid(as_uuid=False), ForeignKey("services.id", ondelete="CASCADE"))
    hold_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_holds.id", ondelete="CASCADE"), nullable=True
    )
    booking_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_bookings.id", ondelete="CASCADE"), nullable=True
    )
    action: Mapped[str] = mapped_column(Text)
    from_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    to_status: Mapped[str] = mapped_column(Text)
    #: SIN CLAVE AJENA a propósito (0086, S10).
    actor_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    actor_role: Mapped[str] = mapped_column(Text)
    idempotency_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    details: Mapped[dict] = mapped_column(_parametros, server_default=text("'{}'"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(f"action in ({_lista(ACCIONES)})", name="service_booking_events_accion"),
        CheckConstraint(f"actor_role in ({_lista(ROLES)})", name="service_booking_events_rol"),
        CheckConstraint(
            "idempotency_key is null or length(idempotency_key) between 8 and 100",
            name="service_booking_events_clave",
        ),
        CheckConstraint("hold_id is not null or booking_id is not null", name="service_booking_events_de_algo"),
        Index(
            "service_booking_events_una_por_clave", "actor_id", "idempotency_key", unique=True,
            postgresql_where=text("idempotency_key is not null"),
            sqlite_where=text("idempotency_key is not null"),
        ),
        Index("service_booking_events_de_la_retencion", "hold_id", "created_at", "id"),
        Index("service_booking_events_de_la_reserva", "booking_id", "created_at", "id"),
    )


__all__ = [
    "ACCIONES",
    "ACEPTA_CONDICIONES_DEL_SERVICIO",
    "ACEPTA_CONDICIONES_DE_Z",
    "CLIENTE",
    "CONTRATABLES",
    "OCUPAN",
    "PAGO_NO_REQUERIDO",
    "PASARELA_NINGUNA",
    "PEDIDO_CONFIRMADO",
    "RESERVA_CONFIRMADA",
    "RESERVA_CONFIRMADA_EVENTO",
    "RETENCION_ACTIVA",
    "RETENCION_CONSUMIDA",
    "RETENCION_CREADA",
    "RETENCION_LIBERADA",
    "RETENCION_SOLTADA",
    "RETENCION_VENCIDA",
    "RETENCION_VENCIO",
    "SISTEMA",
    "ServiceBooking",
    "ServiceBookingAcceptance",
    "ServiceBookingEvent",
    "ServiceBookingIntake",
    "ServiceHold",
    "ServiceOrder",
]
