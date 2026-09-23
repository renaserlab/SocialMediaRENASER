"""Modelos del dominio comercial. Mapean las siete tablas de la 0035.

LOS UNIQUE DE ESTE FICHERO NO SON ADORNO: son la idempotencia entera.

Las tiendas y las pasarelas REINTENTAN sus avisos. Si la proteccion contra
repeticiones se escribe en Python —«mira si ya existe y, si no, insertalo»—, dos
avisos que llegan a la vez leen los dos antes de que escriba ninguno, los dos
ven que no existe y los dos insertan. El resultado es un cobro contado dos veces
o dos derechos sobre el mismo producto. Un indice unico no se puede esquivar: la
segunda insercion choca contra la base y no hay carrera que valga.

Por eso las restricciones se declaran TAMBIEN aqui y no solo en el SQL de la
migracion: las pruebas corren sobre SQLite, que respeta los indices unicos
parciales y los CHECK igual que PostgreSQL. Sin declararlas, las pruebas de
idempotencia pasarian por casualidad —porque en una prueba no hay concurrencia—
y no probarian nada.

Regla del proyecto que se aplica aqui: el esquema es propiedad de las
migraciones. Estos modelos solo mapean; `create_all` es una comodidad de
desarrollo y de pruebas.
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.shared.database import Base


def _uuid() -> str:
    return str(uuid4())


#: `jsonb` en PostgreSQL, JSON de texto en SQLite. El payload de un aviso se
#: guarda entero y en crudo: cuando un cobro no cuadra, lo unico que permite
#: saber que dijo la tienda es lo que dijo la tienda.
_payload = JSON().with_variant(JSONB, "postgresql")


class CommerceProduct(Base):
    """Que se vende, sin mencionar a ninguna tienda.

    Un producto es «el derecho que se compra», no «el archivo que se descarga».
    """

    __tablename__ = "commerce_products"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    #: Hoy solo 'course_lifetime'. La columna existe desde el principio porque
    #: añadirla a una tabla ya llena obliga a decidir que significan las filas
    #: viejas, y esa decision se toma mal con prisa.
    kind: Mapped[str] = mapped_column(
        String(32), default="course_lifetime", server_default="course_lifetime"
    )
    course_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("courses.id", ondelete="RESTRICT"), nullable=True
    )
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("kind in ('course_lifetime')", name="commerce_products_kind"),
        CheckConstraint(
            "kind <> 'course_lifetime' or course_id is not null",
            name="commerce_products_curso_obligatorio",
        ),
        # Un curso, un producto de acceso permanente. PARCIAL: el dia que `kind`
        # tenga mas valores, dos productos distintos del mismo curso seran
        # legitimos. Lo que no puede haber son dos «acceso permanente» del mismo
        # curso, porque entonces comprar uno u otro daria derechos distintos al
        # mismo contenido y nadie sabria cual mirar.
        Index(
            "commerce_products_curso_unico",
            "course_id",
            unique=True,
            postgresql_where=text("kind = 'course_lifetime'"),
            sqlite_where=text("kind = 'course_lifetime'"),
        ),
    )


class ProviderProduct(Base):
    """Como se llama ese producto en cada tienda y en cada entorno.

    Es la tabla que `purchases` nunca tuvo y por la que hubo que rehacer el
    dominio: el mismo curso tiene un identificador distinto en Apple, en Google
    y en Stripe, y sin esta traduccion el webhook no puede pasar de «te han
    comprado ESTE producto de la tienda» a «esta persona tiene derecho a ESTE
    curso».
    """

    __tablename__ = "provider_products"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    commerce_product_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("commerce_products.id", ondelete="CASCADE"),
        index=True,
    )
    provider: Mapped[str] = mapped_column(String(32))
    #: `sandbox` y `production` conviven: las tiendas mandan compras de prueba
    #: con la misma forma que las de verdad. Sin separar los identificadores,
    #: una compra en sandbox concede acceso real.
    environment: Mapped[str] = mapped_column(String(16))
    external_product_id: Mapped[str] = mapped_column(Text)
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "provider in ('revenuecat_test', 'google', 'apple', 'stripe')",
            name="provider_products_provider",
        ),
        CheckConstraint(
            "environment in ('sandbox', 'production')",
            name="provider_products_environment",
        ),
        # Un identificador de tienda apunta a UN producto nuestro: con dos, la
        # misma compra podria mandar a dos cursos y cual gana dependeria del
        # orden de lectura.
        UniqueConstraint(
            "provider", "environment", "external_product_id",
            name="provider_products_externo_unico",
        ),
        # Y al reves: un producto nuestro tiene UN identificador por tienda y
        # entorno, o la pantalla no sabria cual pedirle a la tienda.
        UniqueConstraint(
            "commerce_product_id", "provider", "environment",
            name="provider_products_producto_unico",
        ),
    )


class Order(Base):
    """La INTENCION de comprar. No concede nada.

    Se crea en nuestro servidor ANTES de hablar con la tienda, y es donde se
    congela el importe: si el precio del curso sube mientras alguien esta
    pagando, paga lo que se le enseño.
    """

    __tablename__ = "orders"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    commerce_product_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("commerce_products.id", ondelete="RESTRICT")
    )
    #: QUIEN cobra.
    provider: Mapped[str] = mapped_column(String(32))
    #: DONDE se compra. No es lo mismo: una compra en Android puede cobrarla
    #: Google o Stripe segun como este configurado el producto.
    channel: Mapped[str] = mapped_column(String(16))
    environment: Mapped[str] = mapped_column(
        String(16), default="production", server_default="production"
    )
    status: Mapped[str] = mapped_column(
        String(16), default="pending", server_default="pending"
    )
    #: Unidad MENOR de la moneda y ENTERO. Nunca coma flotante: en dinero eso
    #: acaba en descuadres de un centimo que nadie sabe explicar.
    amount_minor: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    currency: Mapped[str] = mapped_column(String(3), server_default="PEN")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    #: Solo lo escribe una confirmacion servidor a servidor. Un «success» del
    #: cliente no lo toca.
    paid_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # ------------------------------------------------------------------ #
    # LA OFERTA, CONGELADA (0050)
    #
    # *** ESTAS COLUMNAS NO TIENEN GUARDA DE ESQUEMA. ***
    #
    # A diferencia de `cursos_v2`, que lee las columnas de la 0034 por un
    # `MetaData` aparte, aqui estan en el modelo: cualquier `select(Order)` las
    # pide. Desplegar este codigo con la 0050 SIN APLICAR tumba el checkout, el
    # webhook de pago y el historial de compras. La 0050 va PRIMERO.
    #
    # La orden ya era el snapshot del dinero —importe y moneda desde la 0035—;
    # esto completa lo que faltaba: QUE se compro y con QUE promesa. En columnas
    # y no en una tabla aparte porque la relacion es uno a uno, y una fila mas
    # que puede faltar es una fila mas que puede faltar justo donde el dinero no
    # admite «casi».
    # ------------------------------------------------------------------ #

    #: ANULABLE, y no se puede evitar: las ordenes anteriores a la 0050 no
    #: tienen version, y ponerles una seria afirmar que se vendio. El temario no
    #: guarda ninguna marca temporal, asi que no hay forma de saberlo.
    course_version_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("course_versions.id", ondelete="RESTRICT"),
        nullable=True,
    )
    #: La promesa de garantia que se enseño, en horas. 168 por defecto porque es
    #: lo que el codigo aplica hoy a todos los cursos; congelarlo aqui NO cambia
    #: ningun plazo vivo —las ventanas guardan su propio `expires_at`— y evita
    #: una segunda migracion sobre ordenes ya pagadas el dia que la duracion
    #: deje de ser unica.
    guarantee_hours: Mapped[int] = mapped_column(
        Integer, default=168, server_default="168"
    )
    guarantee_policy: Mapped[str] = mapped_column(
        Text, default="refund_v1", server_default="refund_v1"
    )
    #: Reservada. HOY SIEMPRE NULA: no hay terminos de compra aprobados porque
    #: falta decidir entidad vendedora, jurisdiccion e impuestos.
    terms_version: Mapped[str | None] = mapped_column(Text, nullable=True)
    offer_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: `live` cuando la orden nacio con version; `legacy` para lo anterior. El
    #: valor por defecto es `legacy` a proposito: si el codigo no lo rellena, lo
    #: honesto es decir que no se sabe.
    snapshot_origin: Mapped[str] = mapped_column(
        String(16), default="legacy", server_default="legacy"
    )

    __table_args__ = (
        CheckConstraint("channel in ('ios', 'android', 'web')", name="orders_channel"),
        CheckConstraint(
            "status in ('pending', 'paid', 'failed', 'cancelled', 'refunded')",
            name="orders_status",
        ),
        CheckConstraint("amount_minor >= 0", name="orders_amount_minor"),
        CheckConstraint(
            "snapshot_origin in ('live', 'legacy')", name="orders_snapshot_origin"
        ),
        CheckConstraint("guarantee_hours >= 0", name="orders_guarantee_hours"),
    )


class PaymentTransaction(Base):
    """El cobro que de verdad ocurrio, tal y como lo nombra la tienda.

    Un reembolso es OTRA fila (`kind='refund'`), no un `update` de la compra:
    machacar la fila borraria que la compra existio, y hace falta para cuadrar
    cuentas y para saber por que se revoco un acceso.
    """

    __tablename__ = "payment_transactions"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    #: Nulo a proposito: una compra recuperada de la tienda puede llegar sin
    #: orden nuestra. Perder el cobro por no tener a que engancharlo seria peor
    #: que guardarlo suelto.
    order_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("orders.id", ondelete="SET NULL"), nullable=True
    )
    provider: Mapped[str] = mapped_column(String(32))
    environment: Mapped[str] = mapped_column(
        String(16), default="production", server_default="production"
    )
    external_transaction_id: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(
        String(16), default="purchase", server_default="purchase"
    )
    amount_minor: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    currency: Mapped[str] = mapped_column(String(3), server_default="PEN")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "kind in ('purchase', 'refund')", name="payment_transactions_kind"
        ),
        CheckConstraint("amount_minor >= 0", name="payment_transactions_amount_minor"),
        # LA IDEMPOTENCIA DEL DINERO. Aqui y no en un `if` de Python.
        UniqueConstraint(
            "provider", "environment", "external_transaction_id",
            name="payment_transactions_externa_unica",
        ),
    )


class PaymentEvent(Base):
    """El aviso recibido, en crudo y antes de interpretarlo.

    Dos razones, las dos aprendidas caras: el UNIQUE hace que reenviar un aviso
    capturado no vuelva a ejecutar nada (ANTI-REPLAY), y el payload entero es lo
    unico que permite reconstruir que dijo la tienda cuando algo no cuadra —un
    resumen nuestro ya es una interpretacion, y la interpretacion es justo lo
    que se sospecha—.
    """

    __tablename__ = "payment_events"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    provider: Mapped[str] = mapped_column(String(32))
    external_event_id: Mapped[str] = mapped_column(Text)
    event_type: Mapped[str] = mapped_column(Text)
    environment: Mapped[str] = mapped_column(
        String(16), default="production", server_default="production"
    )
    payload: Mapped[dict] = mapped_column(_payload, default=dict)
    #: Nulo = recibido y todavia no aplicado. Con `error` a la vez = se intento
    #: y fallo. Los dos juntos permiten reprocesar sin adivinar.
    processed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "provider", "external_event_id", name="payment_events_externo_unico"
        ),
    )


class Entitlement(Base):
    """EL DERECHO. La unica fuente de verdad del acceso.

    Se separa del cobro para que el acceso sobreviva a cambiar de pasarela, y
    para que un regalo, una beca o una compensacion se puedan conceder sin
    inventarse un cobro que no existio.
    """

    __tablename__ = "entitlements"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    commerce_product_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("commerce_products.id", ondelete="RESTRICT")
    )
    status: Mapped[str] = mapped_column(
        String(16), default="active", server_default="active"
    )
    source_provider: Mapped[str] = mapped_column(
        String(32), default="manual", server_default="manual"
    )
    transaction_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("payment_transactions.id", ondelete="SET NULL"),
        nullable=True,
    )
    granted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    #: NULO en compra unica, que es lo unico que hay hoy. La columna existe
    #: desde el principio porque el dia que haya suscripcion no se puede añadir
    #: a una tabla con derechos ya concedidos sin decidir que significan los
    #: antiguos, y esa decision tomada con prisa deja gente fuera.
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    #: QUE VERSION ABRE ESTE DERECHO (0050).
    #:
    #: Esta aqui ADEMAS de en la orden porque el derecho es el UNICO punto comun
    #: a las tres vias de acceso: compra por web, compra por tienda y beta. La
    #: beta no crea orden ninguna, asi que un snapshot que viviera solo en
    #: `orders` la dejaria fuera.
    #:
    #: `SET NULL` y no `RESTRICT`: aqui la version es informativa —quien decide
    #: el acceso es el producto—, y un derecho vivo no puede quedar bloqueado
    #: por una fila de version.
    course_version_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("course_versions.id", ondelete="SET NULL"),
        nullable=True,
    )

    __table_args__ = (
        CheckConstraint(
            "status in ('active', 'revoked', 'expired')", name="entitlements_status"
        ),
        # LA IDEMPOTENCIA DEL ACCESO, y es PARCIAL por una razon concreta: un
        # derecho ACTIVO solo puede haber uno por persona y producto, pero
        # revocados puede haber varios —se compro, se reembolso, se volvio a
        # comprar— y ese historial no se puede perder. Un unique total obligaria
        # a borrar la fila vieja, es decir, a borrar que aquello paso.
        Index(
            "entitlements_activo_unico",
            "user_id",
            "commerce_product_id",
            unique=True,
            postgresql_where=text("status = 'active'"),
            sqlite_where=text("status = 'active'"),
        ),
    )


class CourseEnrollment(Base):
    """La matricula: «este curso esta en mi lista».

    Es una pregunta DISTINTA de la del derecho. Un curso gratuito al que alguien
    se apunta genera matricula y no genera derecho —no hay nada que comprar—;
    una compra genera las dos cosas. `source` guarda por que esta ahi, para que
    el dia que se limpien matriculas no se borre la de quien pago creyendo que
    era la de quien pulso «apuntarme».
    """

    __tablename__ = "course_enrollments"

    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        primary_key=True,
    )
    course_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("courses.id", ondelete="CASCADE"),
        primary_key=True,
    )
    source: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "source in ('free', 'entitlement', 'author', 'admin', 'legacy')",
            name="course_enrollments_source",
        ),
        Index("course_enrollments_curso_idx", "course_id"),
    )


# --------------------------------------------------------------------------- #
# Liquidacion al propietario del curso  (migracion 0049)
# --------------------------------------------------------------------------- #
#
# EL SALDO NO SE CALCULA AL PAGAR, SE FOTOGRAFIA AL VENDER. Si el neto se
# resolviera al transferir —precio actual x comision actual, propietario
# actual—, cambiar cualquiera de las tres cosas reescribiria el pasado: una
# venta de hace tres meses pasaria a deberle dinero a otra persona.


class OwnerPayoutAccount(Base):
    """Donde cobra quien vende.

    Se guarda el identificador EXTERNO de la cuenta conectada. Ni un numero de
    tarjeta ni una cuenta bancaria pasan por aqui: de eso se encarga el
    proveedor, que para eso existe.
    """

    __tablename__ = "owner_payout_accounts"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    owner_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    provider: Mapped[str] = mapped_column(
        String(32), default="stripe", server_default="stripe"
    )
    environment: Mapped[str] = mapped_column(
        String(16), default="production", server_default="production"
    )
    external_account_id: Mapped[str] = mapped_column(Text)
    onboarding_status: Mapped[str] = mapped_column(
        String(16), default="pending", server_default="pending"
    )
    charges_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    payouts_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("provider in ('stripe')", name="owner_payout_accounts_provider"),
        CheckConstraint(
            "environment in ('sandbox', 'production')",
            name="owner_payout_accounts_environment",
        ),
        CheckConstraint(
            "onboarding_status in ('pending', 'incomplete', 'active', "
            "'restricted', 'disabled')",
            name="owner_payout_accounts_onboarding",
        ),
        # Con dos cuentas del mismo propietario en el mismo entorno no se
        # sabria a cual transferir.
        UniqueConstraint(
            "owner_id", "provider", "environment", name="owner_payout_accounts_unica"
        ),
        UniqueConstraint(
            "provider", "environment", "external_account_id",
            name="owner_payout_accounts_externa_unica",
        ),
    )


class OwnerSaleBalance(Base):
    """La fotografia inmutable de una venta. Se escribe al confirmar el pago."""

    __tablename__ = "owner_sale_balances"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    #: UN ORIGEN, EXACTAMENTE UNO (0068): o curso, o evento. Un CHECK de la base
    #: lo impone; aquí los cuatro son anulables porque cada venta llena su par.
    #: Los saldos anteriores siguen con `order_id` y `course_id`, sin tocar.
    order_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("orders.id", ondelete="RESTRICT"), nullable=True
    )
    course_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("courses.id", ondelete="RESTRICT"),
        index=True,
        nullable=True,
    )
    event_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("events.id", ondelete="RESTRICT"), nullable=True
    )
    event_order_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("event_orders.id", ondelete="RESTRICT"),
        nullable=True,
    )
    #: EL TERCER ORIGEN (0082). Productos no tiene una tabla de «producto
    #: vendido» equivalente a `courses` o `events`: lo que se vende es un pedido
    #: con sus lineas, y el producto de cada linea vive ahi. Asi que el origen
    #: es UNA columna y no un par, y el CHECK lo admite asi.
    product_order_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("product_orders.id", ondelete="RESTRICT"),
        nullable=True,
    )
    owner_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="RESTRICT"), index=True
    )
    #: La cuenta que aplicaba EN ESE MOMENTO. Nula si el propietario todavia no
    #: habia terminado su alta: el saldo se acumula igual y se paga despues.
    payout_account_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("owner_payout_accounts.id", ondelete="SET NULL"),
        nullable=True,
    )

    # `BigInteger` desde la 0068. Con `Integer` el tope eran 21 474 836,47 en
    # una moneda de dos decimales, y `event_orders.total_minor` ya era `bigint`:
    # un pedido por encima reventaba el INSERT con un error que nadie captura,
    # dentro del savepoint del webhook de cobro.
    gross_amount_minor: Mapped[int] = mapped_column(BigInteger)
    platform_fee_minor: Mapped[int] = mapped_column(BigInteger)
    provider_fee_minor: Mapped[int] = mapped_column(
        BigInteger, default=0, server_default="0"
    )
    net_amount_minor: Mapped[int] = mapped_column(BigInteger)
    currency: Mapped[str] = mapped_column(String(3))
    #: Que reglas de comision se aplicaron. Cambiarlas no reescribe lo anterior.
    fee_rules_version: Mapped[str] = mapped_column(String(32))

    status: Mapped[str] = mapped_column(
        String(16), default="pending", server_default="pending"
    )
    #: Cuando deja de estar retenido: cuando vence la garantia del comprador.
    available_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    frozen_by_request_id: Mapped[str | None] = mapped_column(
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
            "status in ('pending', 'frozen', 'eligible', 'transferring', "
            "'transferred', 'cancelled', 'failed')",
            name="owner_sale_balances_status",
        ),
        # UN ORIGEN, EXACTAMENTE UNO. Estaba en la 0068 y no aquí: las pruebas
        # podían crear un saldo sin origen o con los dos y no enterarse. Desde
        # la 0082 son TRES ramas, y las dos primeras no cambian ni una letra.
        CheckConstraint(
            "(course_id is not null and order_id is not null "
            " and event_id is null and event_order_id is null "
            " and product_order_id is null) "
            "or (event_id is not null and event_order_id is not null "
            " and course_id is null and order_id is null "
            " and product_order_id is null) "
            "or (product_order_id is not null "
            " and course_id is null and order_id is null "
            " and event_id is null and event_order_id is null)",
            name="owner_sale_balances_un_origen",
        ),
        # UN SALDO POR PEDIDO DE PRODUCTO. Es lo único que protege de dos saldos
        # para la misma venta cuando un aviso de cobro llega dos veces, y sin él
        # en el modelo el camino del `IntegrityError` no se ejercita en pruebas.
        Index(
            "owner_sale_balances_pedido_de_producto_unico",
            "product_order_id",
            unique=True,
            postgresql_where=text("product_order_id is not null"),
            sqlite_where=text("product_order_id is not null"),
        ),
        # UN SALDO POR PEDIDO DE EVENTO. Es lo único que protege de dos saldos
        # para la misma venta bajo concurrencia, y sin él en el modelo el camino
        # del `IntegrityError` no se ejercitaba nunca en pruebas.
        Index(
            "owner_sale_balances_pedido_de_evento_unico",
            "event_order_id",
            unique=True,
            postgresql_where=text("event_order_id is not null"),
            sqlite_where=text("event_order_id is not null"),
        ),
        CheckConstraint(
            "gross_amount_minor >= 0 and platform_fee_minor >= 0 "
            "and provider_fee_minor >= 0 and net_amount_minor >= 0",
            name="owner_sale_balances_importes",
        ),
        # Que el neto cuadre lo comprueba la base, no una prueba.
        CheckConstraint(
            "net_amount_minor = gross_amount_minor - platform_fee_minor "
            "- provider_fee_minor",
            name="owner_sale_balances_cuadra",
        ),
        # UN SALDO POR ORDEN. Un webhook repetido no puede deberle el dinero
        # dos veces al propietario.
        UniqueConstraint("order_id", name="owner_sale_balances_orden_unica"),
    )


class OwnerTransfer(Base):
    """Un intento de pagarle a quien vende."""

    __tablename__ = "owner_transfers"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    balance_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("owner_sale_balances.id", ondelete="RESTRICT"),
        index=True,
    )
    owner_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="RESTRICT"), index=True
    )
    payout_account_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("owner_payout_accounts.id", ondelete="SET NULL"),
        nullable=True,
    )

    amount_minor: Mapped[int] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(3))
    provider: Mapped[str] = mapped_column(
        String(32), default="stripe", server_default="stripe"
    )
    environment: Mapped[str] = mapped_column(
        String(16), default="production", server_default="production"
    )
    external_transfer_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: La clave que se le manda al proveedor para que un reintento no pague dos
    #: veces. La generamos nosotros y es estable por saldo.
    idempotency_key: Mapped[str] = mapped_column(Text)

    status: Mapped[str] = mapped_column(
        String(16), default="processing", server_default="processing"
    )
    failure_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    failure_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "status in ('processing', 'completed', 'failed', 'cancelled')",
            name="owner_transfers_status",
        ),
        CheckConstraint("amount_minor >= 0", name="owner_transfers_amount"),
        # Igual que en `refund_requests`: estaba solo en el SQL de la 0049, así
        # que una transferencia con entorno 'live' pasaba en pruebas y la base
        # de verdad la rechaza. Aquí no admite nulo, y ese matiz también importa.
        CheckConstraint(
            "environment in ('sandbox', 'production')",
            name="owner_transfers_environment",
        ),
        # UNA TRANSFERENCIA VIVA POR SALDO. Parcial porque un fallo se puede
        # reintentar y los intentos fallidos son historial.
        Index(
            "owner_transfers_viva_por_saldo",
            "balance_id",
            unique=True,
            postgresql_where=text("status in ('processing', 'completed')"),
            sqlite_where=text("status in ('processing', 'completed')"),
        ),
        UniqueConstraint(
            "provider", "environment", "idempotency_key",
            name="owner_transfers_idempotencia",
        ),
    )
