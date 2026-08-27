"""Servicios del comercio. Lo que llama el modulo de pagos.

QUE HACE ESTE FICHERO Y QUE NO.

Hace: crear ordenes, registrar cobros, guardar avisos, conceder y revocar
derechos, matricular, y responder si alguien puede ver un curso o una leccion.

NO hace: hablar con ninguna pasarela. Verificar la firma de un aviso es trabajo
del proveedor (`app/modules/payments/providers.py`); traducirlo a derechos es
trabajo de aqui. La separacion importa: el dia que se cambie de pasarela, esto
no se toca.

LAS TRES REGLAS QUE SOSTIENEN EL DINERO, Y DONDE VIVE CADA UNA

1. **La idempotencia la garantiza la BASE, no un `if`.** Ninguna funcion de
   aqui pregunta «¿ya existe?» antes de escribir. Todas insertan con
   `on conflict do nothing` contra un indice unico. La diferencia no es de
   estilo: dos avisos que llegan a la vez leen los dos antes de que escriba
   ninguno, los dos ven que no existe y los dos insertan. El indice no se puede
   esquivar.

2. **El importe se lee del servidor.** `crear_orden` NO acepta un importe: lo
   busca en el curso. Asi no hay forma de que un importe del cliente llegue
   hasta la orden ni por descuido ni por un parametro que alguien añada mañana.

3. **Un «success» del cliente no concede nada.** Conceder es `conceder_entitlement`
   y lo llama el webhook despues de verificar, nunca un endpoint que responde a
   la aplicacion.

SIN LAS MIGRACIONES 0035/0036 APLICADAS. Las LECTURAS funcionan y responden lo
mismo que hoy: acceso por curso gratuito, autor, administracion o fila en
`purchases`. Las ESCRITURAS responden 503 con `commerce_not_available` en vez de
reventar con un 500 —que ademas sale sin cabeceras CORS y se disfraza de fallo
de red—. Se comprueba una vez por proceso: despues de aplicar las migraciones
hay que REINICIAR la API.

NADIE HACE `commit` AQUI. Las funciones dejan la transaccion abierta y hacen
`flush` para que salten los indices unicos; el `commit` lo hace quien llama,
cuando ha terminado su operacion entera. Al reves, un webhook que concede el
derecho y luego falla al marcar la orden dejaria las dos cosas a medias.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    Column,
    MetaData,
    Table,
    Uuid,
    select,
    text,
    update,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ServiceUnavailableError, ValidationAppError
from app.core.logging import get_logger
from app.modules.catalog.models import Course
from app.modules.commerce import esquema
from app.modules.commerce.models import (
    CommerceProduct,
    CourseEnrollment,
    Entitlement,
    Order,
    PaymentEvent,
    PaymentTransaction,
    ProviderProduct,
)
from app.modules.learning.models import Purchase
from app.shared.permissions import is_admin

logger = get_logger("renaser.commerce")


# --------------------------------------------------------------------------- #
# Motivos de acceso
#
# Son los mismos cinco caminos que aplica `public.has_course_access()` en la
# 0036, con el mismo orden. Si aqui aparece uno que alli no esta —o al reves—,
# la pantalla promete algo que el almacenamiento niega, o niega algo que la base
# si deja ver. Ese desacuerdo es el fallo que corrigio la 0016 y no se repite.
# --------------------------------------------------------------------------- #
GRATUITO = "gratuito"
AUTOR = "autor"
ADMINISTRACION = "administracion"
#: Derecho activo en `entitlements`. La via nueva.
ENTITLEMENT = "entitlement"
#: Fila en `purchases` en 'paid'. El respaldo del trasvase: quien tenia acceso
#: antes lo conserva. Se retirara en otra migracion, no antes de comprobarlo.
COMPRA_HEREDADA = "compra_heredada"
#: Solo para lecciones: `is_preview`. Una muestra se ve sin comprar.
MUESTRA = "muestra"
SIN_ACCESO = "sin_acceso"


# --------------------------------------------------------------------------- #
# Origenes de un derecho (`entitlements.source_provider`)
#
# La columna no tiene CHECK a proposito —«aqui caben origenes que no son
# pasarelas» (0035)—, asi que anadir uno nuevo NO necesita migracion.
# --------------------------------------------------------------------------- #
#: Concedido durante la BETA GRATUITA. No es una pasarela y no lo pretende: no
#: hubo cobro, asi que el derecho se guarda con `transaction_id` NULO y sin
#: orden ni transaccion detras. Es lo que permite distinguir para siempre, y con
#: una sola consulta, lo regalado de lo comprado —«select ... where
#: source_provider = 'beta_free'»— el dia que haya que cuadrar cuentas.
BETA_GRATIS = "beta_free"


@dataclass(frozen=True)
class Acceso:
    """Si se puede ver, y POR QUE.

    El motivo no es decoracion: la interfaz necesita distinguir «es gratuito»
    de «lo compraste» de «es una muestra» para decir algo util en vez de un no
    sin explicacion. Y quien llama necesita saber si el acceso se sostiene solo
    en `purchases` para poder retirarlo al reembolsar.
    """

    tiene_acceso: bool
    motivo: str


# --------------------------------------------------------------------------- #
# Tablas ajenas, declaradas aqui a proposito
#
# `course_lessons` y `course_modules` son de otro modulo y ademas la 0034 les
# añade columnas. Mapearlas por mi cuenta —solo las columnas que leo— evita dos
# cosas: depender de cuando el otro modulo actualice su modelo, y que
# `select(Entidad)` pida columnas que la base todavia no tiene. Es un
# `MetaData` aparte para que `create_all` no intente crearlas dos veces.
# --------------------------------------------------------------------------- #
_ajenas = MetaData()

_lecciones = Table(
    "course_lessons",
    _ajenas,
    Column("id", Uuid(as_uuid=False), primary_key=True),
    Column("module_id", Uuid(as_uuid=False)),
    Column("is_preview", Boolean),
)

_modulos = Table(
    "course_modules",
    _ajenas,
    Column("id", Uuid(as_uuid=False), primary_key=True),
    Column("course_id", Uuid(as_uuid=False)),
)


# --------------------------------------------------------------------------- #
# Ayudantes
# --------------------------------------------------------------------------- #
def _ahora() -> datetime:
    return datetime.now(timezone.utc)


def _insert(db: AsyncSession):
    """El `insert` del dialecto que toque, con `on conflict do nothing`.

    Hace falta elegir porque `on conflict` no esta en el `insert` generico de
    SQLAlchemy: lo traen los dialectos. PostgreSQL es produccion y SQLite es
    donde corren las pruebas, y los dos aceptan indices unicos PARCIALES como
    objetivo del conflicto, que es justo lo que hace falta para
    `entitlements_activo_unico`.
    """
    nombre = db.get_bind().dialect.name
    if nombre == "postgresql":
        from sqlalchemy.dialects.postgresql import insert

        return insert
    if nombre == "sqlite":
        from sqlalchemy.dialects.sqlite import insert

        return insert
    raise RuntimeError(
        f"Dialecto '{nombre}' sin soporte de `on conflict`: la idempotencia del "
        "comercio depende de el y no se puede sustituir por una comprobacion "
        "en Python sin abrir una carrera."
    )


async def _exigir_comercio(db: AsyncSession) -> None:
    """503 si la 0035 todavia no esta aplicada. Nunca un 500."""
    if not await esquema.hay_comercio(db):
        raise ServiceUnavailableError(
            "El comercio todavia no esta disponible en esta base de datos.",
            code="commerce_not_available",
        )


def _vigente(expires_at: datetime | None) -> bool:
    """Si un derecho con esa caducidad sigue valiendo.

    Se resuelve en Python y no en SQL a proposito: comparar una fecha con
    `now()` cambia de comportamiento entre PostgreSQL y SQLite —y con las
    fechas sin zona que SQLite devuelve— y el acceso de alguien no puede
    depender de eso. Hoy `expires_at` es SIEMPRE nulo (compra unica), asi que
    esta rama casi nunca se pisa; existe para que el dia que haya suscripcion
    no haya que acordarse de añadirla.
    """
    if expires_at is None:
        return True
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at > _ahora()


# --------------------------------------------------------------------------- #
# Catalogo comercial
# --------------------------------------------------------------------------- #
async def producto_de_curso(db: AsyncSession, course_id: str) -> CommerceProduct | None:
    """El producto de acceso permanente de un curso, si existe.

    Devuelve `None` —y no un error— cuando no hay comercio o cuando el curso
    todavia no tiene producto. Las dos cosas significan lo mismo para quien
    pregunta: ese curso no esta a la venta por aqui.
    """
    if not await esquema.hay_comercio(db):
        return None
    return await db.scalar(
        select(CommerceProduct).where(
            CommerceProduct.course_id == course_id,
            CommerceProduct.kind == "course_lifetime",
        )
    )


async def producto_de_tienda(
    db: AsyncSession,
    *,
    course_id: str,
    provider: str,
    environment: str = "production",
) -> ProviderProduct | None:
    """Como se llama el producto de un curso en una tienda concreta.

    `None` significa «este curso no se vende en esa plataforma», y la interfaz
    tiene que DECIRLO. Es la regla 6 del contrato: sin producto configurado, la
    pantalla explica que la compra no esta disponible ahi. Nunca un boton
    muerto que falle al pulsarlo.
    """
    if not await esquema.hay_comercio(db):
        return None
    return await db.scalar(
        select(ProviderProduct)
        .join(CommerceProduct, CommerceProduct.id == ProviderProduct.commerce_product_id)
        .where(
            CommerceProduct.course_id == course_id,
            CommerceProduct.kind == "course_lifetime",
            CommerceProduct.active.is_(True),
            ProviderProduct.provider == provider,
            ProviderProduct.environment == environment,
            ProviderProduct.active.is_(True),
        )
    )


async def asegurar_producto_de_curso(
    db: AsyncSession, *, course_id: str
) -> CommerceProduct:
    """Devuelve el producto del curso, creandolo si no lo habia.

    Idempotente por el indice unico parcial `commerce_products_curso_unico`: dos
    llamadas simultaneas no crean dos productos del mismo curso, que si
    ocurriera dejaria dos derechos distintos sobre el mismo contenido y nadie
    sabria cual mirar.
    """
    await _exigir_comercio(db)

    ins = _insert(db)
    await db.execute(
        ins(CommerceProduct.__table__)
        .values(kind="course_lifetime", course_id=course_id, active=True)
        .on_conflict_do_nothing(
            index_elements=["course_id"],
            index_where=text("kind = 'course_lifetime'"),
        )
    )
    await db.flush()

    producto = await producto_de_curso(db, course_id)
    if producto is None:  # pragma: no cover - solo si alguien borra en paralelo
        raise ServiceUnavailableError(
            "No se pudo preparar el producto del curso.",
            code="commerce_not_available",
        )
    return producto


# --------------------------------------------------------------------------- #
# Ordenes
# --------------------------------------------------------------------------- #
async def crear_orden(
    db: AsyncSession,
    *,
    user_id: str,
    commerce_product_id: str,
    provider: str,
    channel: str,
    environment: str = "production",
    reutilizar_pendiente: bool = True,
) -> Order:
    """Registra la intencion de comprar. NO concede nada.

    **No hay parametro de importe, y es deliberado.** El precio se lee del curso
    aqui dentro. Si la firma lo aceptara, tarde o temprano alguien lo pasaria
    desde un endpoint y un curso de 300 se compraria por 1; sin el parametro no
    hay forma de equivocarse.

    En tienda el importe REAL lo pone la tienda con su precio localizado; este
    queda como referencia de catalogo y el de verdad llega en la transaccion.

    `reutilizar_pendiente` evita acumular filas muertas cada vez que alguien
    abre el checkout y se lo piensa. No es idempotencia —dos peticiones a la vez
    pueden crear dos ordenes pendientes— y no hace falta que lo sea: una orden
    no da acceso. Lo que si es idempotente es conceder el derecho.
    """
    await _exigir_comercio(db)

    producto = await db.get(CommerceProduct, commerce_product_id)
    if producto is None:
        raise NotFoundError("Producto no encontrado.")
    if producto.course_id is None:
        raise ValidationAppError("Ese producto no corresponde a ningun curso.")

    precio = (
        await db.execute(
            select(Course.price_minor, Course.currency).where(
                Course.id == producto.course_id
            )
        )
    ).first()
    if precio is None:
        raise NotFoundError("Curso no encontrado.")
    amount_minor, currency = int(precio[0] or 0), precio[1] or "PEN"

    if reutilizar_pendiente:
        orden = await db.scalar(
            select(Order).where(
                Order.user_id == user_id,
                Order.commerce_product_id == commerce_product_id,
                Order.provider == provider,
                Order.channel == channel,
                Order.environment == environment,
                Order.status == "pending",
            )
        )
        if orden is not None:
            # Se refresca el importe: si el precio cambio desde que abrio el
            # checkout, lo que se cobra es lo que se le enseña ahora.
            orden.amount_minor = amount_minor
            orden.currency = currency
            await db.flush()
            return orden

    orden = Order(
        user_id=user_id,
        commerce_product_id=commerce_product_id,
        provider=provider,
        channel=channel,
        environment=environment,
        status="pending",
        amount_minor=amount_minor,
        currency=currency,
    )
    db.add(orden)
    await db.flush()
    return orden


async def marcar_orden(db: AsyncSession, *, order_id: str, status: str) -> bool:
    """Mueve una orden a su estado final. `paid_at` solo lo escribe 'paid'.

    Devuelve si cambio algo. No cambiar nada NO es un error: significa que la
    orden ya estaba en ese estado, que es lo que pasa cuando la tienda reenvia
    su aviso.

    SI, AQUI HAY UN `if` Y NO UN INDICE, y es a proposito. La regla —«la
    idempotencia la garantiza la base»— protege lo que CONCEDE ACCESO: el
    derecho y el cobro. Una orden no concede nada; es un apunte de intencion.
    Que dos avisos simultaneos la pongan los dos en 'paid' no tiene ninguna
    consecuencia, porque el segundo escribe lo mismo que el primero.

    Se carga la fila y se modifica en vez de lanzar un `update` masivo para que
    el objeto que tenga quien llama quede al dia. Con un `update` masivo, su
    copia en memoria se queda con el `paid_at` viejo y la siguiente linea de su
    codigo lee una mentira.
    """
    await _exigir_comercio(db)
    if status not in {"pending", "paid", "failed", "cancelled", "refunded"}:
        raise ValidationAppError(f"Estado de orden no valido: {status}")

    orden = await db.get(Order, order_id)
    if orden is None:
        raise NotFoundError("Orden no encontrada.")
    if orden.status == status:
        return False

    orden.status = status
    if status == "paid" and orden.paid_at is None:
        orden.paid_at = _ahora()
    await db.flush()
    return True


# --------------------------------------------------------------------------- #
# Cobros y avisos
# --------------------------------------------------------------------------- #
async def registrar_transaccion(
    db: AsyncSession,
    *,
    provider: str,
    environment: str,
    external_transaction_id: str,
    kind: str = "purchase",
    amount_minor: int = 0,
    currency: str = "PEN",
    order_id: str | None = None,
) -> tuple[PaymentTransaction, bool]:
    """Guarda un cobro. Devuelve `(fila, es_nueva)`.

    `es_nueva = False` significa que ese cobro YA estaba registrado: la tienda
    reenvio su aviso. Quien llama puede parar ahi sin miedo.

    La proteccion es el UNIQUE `(provider, environment, external_transaction_id)`
    y no una consulta previa. Con una consulta previa, dos reintentos
    simultaneos la pasarian los dos.
    """
    await _exigir_comercio(db)

    ins = _insert(db)
    resultado = await db.execute(
        ins(PaymentTransaction.__table__)
        .values(
            order_id=order_id,
            provider=provider,
            environment=environment,
            external_transaction_id=external_transaction_id,
            kind=kind,
            amount_minor=amount_minor,
            currency=currency,
        )
        .on_conflict_do_nothing(
            index_elements=["provider", "environment", "external_transaction_id"]
        )
        .returning(PaymentTransaction.__table__.c.id)
    )
    es_nueva = resultado.scalar_one_or_none() is not None
    await db.flush()

    fila = await db.scalar(
        select(PaymentTransaction).where(
            PaymentTransaction.provider == provider,
            PaymentTransaction.environment == environment,
            PaymentTransaction.external_transaction_id == external_transaction_id,
        )
    )
    if fila is None:  # pragma: no cover - solo si alguien borra en paralelo
        raise ServiceUnavailableError(
            "No se pudo registrar el cobro.", code="commerce_not_available"
        )
    return fila, es_nueva


async def registrar_evento(
    db: AsyncSession,
    *,
    provider: str,
    external_event_id: str,
    event_type: str,
    environment: str = "production",
    payload: dict | None = None,
) -> tuple[PaymentEvent, bool]:
    """Guarda el aviso EN CRUDO antes de interpretarlo. `(fila, es_nuevo)`.

    ES LA PUERTA ANTI-REPLAY: `es_nuevo = False` significa que ese aviso ya se
    recibio, y quien llama debe PARAR. Sin esto, quien intercepte un webhook
    puede reenviarlo tantas veces como quiera.

    Se llama ANTES de aplicar nada. Si aplicar falla, la fila queda con
    `processed_at` nulo y se puede reintentar a mano sabiendo exactamente que
    llego.
    """
    await _exigir_comercio(db)

    ins = _insert(db)
    resultado = await db.execute(
        ins(PaymentEvent.__table__)
        .values(
            provider=provider,
            external_event_id=external_event_id,
            event_type=event_type,
            environment=environment,
            payload=payload or {},
        )
        .on_conflict_do_nothing(index_elements=["provider", "external_event_id"])
        .returning(PaymentEvent.__table__.c.id)
    )
    es_nuevo = resultado.scalar_one_or_none() is not None
    await db.flush()

    fila = await db.scalar(
        select(PaymentEvent).where(
            PaymentEvent.provider == provider,
            PaymentEvent.external_event_id == external_event_id,
        )
    )
    if fila is None:  # pragma: no cover - solo si alguien borra en paralelo
        raise ServiceUnavailableError(
            "No se pudo registrar el aviso.", code="commerce_not_available"
        )
    return fila, es_nuevo


async def marcar_evento_procesado(
    db: AsyncSession, *, event_id: str, error: str | None = None
) -> None:
    """Cierra el aviso. Con `error`, queda marcado para mirarlo a mano."""
    await _exigir_comercio(db)
    await db.execute(
        update(PaymentEvent)
        .where(PaymentEvent.id == event_id)
        .values(processed_at=_ahora(), error=error)
    )
    await db.flush()


# --------------------------------------------------------------------------- #
# EL DERECHO
# --------------------------------------------------------------------------- #
async def conceder_entitlement(
    db: AsyncSession,
    *,
    user_id: str,
    commerce_product_id: str,
    source_provider: str = "manual",
    transaction_id: str | None = None,
    expires_at: datetime | None = None,
    matricular_tambien: bool = True,
) -> tuple[Entitlement, bool]:
    """Concede el acceso. Devuelve `(derecho, es_nuevo)`.

    IDEMPOTENTE POR EL INDICE, NO POR UNA COMPROBACION. El indice unico parcial
    `entitlements_activo_unico` permite un solo derecho ACTIVO por persona y
    producto; el mismo aviso dos veces deja un derecho, no dos. Que sea parcial
    es lo que permite guardar el historial: revocados puede haber varios —se
    compro, se reembolso, se volvio a comprar— y esa historia no se borra.

    `es_nuevo = False` significa que ya lo tenia. No es un error: es el caso
    normal de un reintento.
    """
    await _exigir_comercio(db)

    ins = _insert(db)
    resultado = await db.execute(
        ins(Entitlement.__table__)
        .values(
            user_id=user_id,
            commerce_product_id=commerce_product_id,
            status="active",
            source_provider=source_provider,
            transaction_id=transaction_id,
            expires_at=expires_at,
        )
        .on_conflict_do_nothing(
            index_elements=["user_id", "commerce_product_id"],
            index_where=text("status = 'active'"),
        )
        .returning(Entitlement.__table__.c.id)
    )
    es_nuevo = resultado.scalar_one_or_none() is not None
    await db.flush()

    derecho = await db.scalar(
        select(Entitlement).where(
            Entitlement.user_id == user_id,
            Entitlement.commerce_product_id == commerce_product_id,
            Entitlement.status == "active",
        )
    )
    if derecho is None:  # pragma: no cover - solo si alguien revoca en paralelo
        raise ServiceUnavailableError(
            "No se pudo conceder el acceso.", code="commerce_not_available"
        )

    if matricular_tambien:
        producto = await db.get(CommerceProduct, commerce_product_id)
        if producto is not None and producto.course_id is not None:
            await matricular(
                db, user_id=user_id, course_id=producto.course_id, source="entitlement"
            )

    return derecho, es_nuevo


async def revocar_entitlement(
    db: AsyncSession, *, user_id: str, commerce_product_id: str
) -> bool:
    """Quita el acceso concedido. Devuelve si habia algo que quitar.

    NO borra la fila: la pasa a 'revoked' y sella `revoked_at`. Borrarla haria
    imposible explicar despues por que alguien dejo de tener acceso, y ademas
    perderia el rastro de un reembolso.

    CUIDADO, Y ESTO HAY QUE LEERLO. Mientras dure el trasvase, `has_course_access`
    tambien mira `purchases`: si esa persona tiene ahi una fila en 'paid' del
    mismo curso, revocar el derecho NO le quita el acceso. Para un reembolso hay
    que llamar ademas a `revocar_compra_heredada()`. `resolver_acceso_al_curso()`
    lo dice con el motivo `compra_heredada`, asi que se puede comprobar.
    """
    await _exigir_comercio(db)
    resultado = await db.execute(
        update(Entitlement)
        .where(
            Entitlement.user_id == user_id,
            Entitlement.commerce_product_id == commerce_product_id,
            Entitlement.status == "active",
        )
        .values(status="revoked", revoked_at=_ahora())
    )
    await db.flush()
    return bool(resultado.rowcount)


async def revocar_compra_heredada(
    db: AsyncSession, *, user_id: str, course_id: str, nuevo_estado: str = "refunded"
) -> int:
    """Cierra la compra vieja que todavia sostiene el acceso. Devuelve cuantas.

    Existe SOLO por el trasvase. `has_course_access` consulta `purchases` para
    que nadie pierda lo que ya tenia; el precio de esa red de seguridad es que
    un reembolso tiene que cerrar tambien la fila vieja o el acceso se queda
    puesto para siempre.

    NO borra nada y NO toca la RLS de `purchases`: solo mueve el estado de
    'paid' a 'refunded' o 'cancelled', que es lo que esa columna ya significaba.
    """
    if nuevo_estado not in {"refunded", "cancelled"}:
        raise ValidationAppError(
            "Una compra heredada solo se cierra como 'refunded' o 'cancelled'."
        )
    resultado = await db.execute(
        update(Purchase)
        .where(
            Purchase.user_id == user_id,
            Purchase.course_id == course_id,
            Purchase.status == "paid",
        )
        .values(status=nuevo_estado)
    )
    await db.flush()
    return int(resultado.rowcount or 0)


async def matricular(
    db: AsyncSession, *, user_id: str, course_id: str, source: str
) -> bool:
    """Pone el curso en «mis cursos». Idempotente por la clave primaria.

    NO concede acceso: eso lo hace el derecho. Que falte esta tabla no puede
    impedir que se conceda un derecho, asi que sin la 0035 devuelve `False` y
    se sigue —es cosmetico, no seguridad—.
    """
    if source not in {"free", "entitlement", "author", "admin", "legacy"}:
        raise ValidationAppError(f"Origen de matricula no valido: {source}")
    if not await esquema.hay_matriculas(db):
        logger.warning(
            "[comercio] sin `course_enrollments`: el curso %s no se añade a la "
            "lista de %s. El acceso no depende de esto.",
            course_id,
            user_id,
        )
        return False

    ins = _insert(db)
    resultado = await db.execute(
        ins(CourseEnrollment.__table__)
        .values(user_id=user_id, course_id=course_id, source=source)
        .on_conflict_do_nothing(index_elements=["user_id", "course_id"])
        .returning(CourseEnrollment.__table__.c.user_id)
    )
    nueva = resultado.scalar_one_or_none() is not None
    await db.flush()
    return nueva


# --------------------------------------------------------------------------- #
# Quien puede ver que
#
# Espejo en Python de `public.has_course_access()` y `public.has_lesson_access()`
# (migracion 0036). La que MANDA es la de la base: protege los archivos aunque
# alguien llame al almacenamiento saltandose la aplicacion. Esta sirve para que
# la interfaz sepa que enseñar, y tiene que decir lo mismo.
# --------------------------------------------------------------------------- #
async def resolver_acceso_al_curso(
    db: AsyncSession,
    *,
    user_id: str,
    course_id: str,
    es_admin: bool | None = None,
) -> Acceso:
    """Si esta persona puede ver el contenido de pago de un curso, y por que.

    El orden de las cinco vias es el mismo que el de la 0036 y no es casual:
    GRATUITO va primero porque es el mas barato de comprobar y el que mas gente
    cubre. Perderlo de vista es el error caro: sin esa via, estrenar el muro de
    pago deja sin acceso a todo el mundo de golpe.
    """
    fila = (
        await db.execute(
            select(Course.price_minor, Course.author_id).where(Course.id == course_id)
        )
    ).first()
    if fila is None:
        return Acceso(False, SIN_ACCESO)
    price_minor, author_id = int(fila[0] or 0), fila[1]

    if price_minor <= 0:
        return Acceso(True, GRATUITO)
    if author_id == user_id:
        return Acceso(True, AUTOR)
    if es_admin is None:
        es_admin = await is_admin(db, user_id)
    if es_admin:
        return Acceso(True, ADMINISTRACION)

    if await esquema.hay_comercio(db):
        caducidades = (
            await db.execute(
                select(Entitlement.expires_at)
                .join(
                    CommerceProduct,
                    CommerceProduct.id == Entitlement.commerce_product_id,
                )
                .where(
                    Entitlement.user_id == user_id,
                    Entitlement.status == "active",
                    CommerceProduct.kind == "course_lifetime",
                    CommerceProduct.course_id == course_id,
                )
            )
        ).scalars().all()
        if any(_vigente(c) for c in caducidades):
            return Acceso(True, ENTITLEMENT)

    comprado = await db.scalar(
        select(Purchase.id).where(
            Purchase.user_id == user_id,
            Purchase.course_id == course_id,
            Purchase.status == "paid",
        )
    )
    if comprado is not None:
        return Acceso(True, COMPRA_HEREDADA)

    return Acceso(False, SIN_ACCESO)


async def resolver_acceso_a_la_leccion(
    db: AsyncSession,
    *,
    user_id: str,
    lesson_id: str,
    es_admin: bool | None = None,
) -> Acceso:
    """Si esta persona puede ver UNA leccion, y por que.

    La muestra se comprueba PRIMERO: es leer una fila por su clave, mientras que
    el acceso al curso son varias consultas. En la politica del almacenamiento
    esto se evalua por cada objeto, asi que el orden se nota.

    Sin la 0034 no existe `is_preview` y una leccion vale lo que vale su curso,
    que es exactamente lo que pasa hoy. Preguntar por una columna que no existe
    tumbaria la comprobacion entera y dejaria sin ver su curso a quien lo pago.
    """
    hay_muestras = await esquema.hay_lecciones_de_muestra(db)

    columnas = [_lecciones.c.module_id]
    if hay_muestras:
        columnas.append(_lecciones.c.is_preview)

    fila = (
        await db.execute(select(*columnas).where(_lecciones.c.id == lesson_id))
    ).first()
    if fila is None:
        return Acceso(False, SIN_ACCESO)

    if hay_muestras and bool(fila[1]):
        return Acceso(True, MUESTRA)

    course_id = await db.scalar(
        select(_modulos.c.course_id).where(_modulos.c.id == fila[0])
    )
    if course_id is None:
        return Acceso(False, SIN_ACCESO)

    return await resolver_acceso_al_curso(
        db, user_id=user_id, course_id=str(course_id), es_admin=es_admin
    )


async def cursos_con_acceso(db: AsyncSession, *, user_id: str) -> list[str]:
    """Los cursos de pago a los que esta persona entra: derecho o compra vieja.

    Para «mis cursos» sin preguntar curso por curso. NO incluye los gratuitos ni
    los que se administran: eso lo sabe quien pregunta y depende de la pantalla.
    """
    cursos: set[str] = set()

    if await esquema.hay_comercio(db):
        filas = (
            await db.execute(
                select(CommerceProduct.course_id, Entitlement.expires_at)
                .join(
                    Entitlement,
                    Entitlement.commerce_product_id == CommerceProduct.id,
                )
                .where(
                    Entitlement.user_id == user_id,
                    Entitlement.status == "active",
                    CommerceProduct.kind == "course_lifetime",
                    CommerceProduct.course_id.is_not(None),
                )
            )
        ).all()
        cursos.update(str(c) for c, expira in filas if _vigente(expira))

    heredados = (
        await db.execute(
            select(Purchase.course_id).where(
                Purchase.user_id == user_id, Purchase.status == "paid"
            )
        )
    ).scalars().all()
    cursos.update(str(c) for c in heredados)

    return sorted(cursos)


#: Lo que el modulo de pagos puede llamar. Todo lo que no este aqui es interno
#: y puede cambiar sin avisar.
__all__ = [
    "Acceso",
    "ADMINISTRACION",
    "AUTOR",
    "BETA_GRATIS",
    "COMPRA_HEREDADA",
    "ENTITLEMENT",
    "GRATUITO",
    "MUESTRA",
    "SIN_ACCESO",
    "asegurar_producto_de_curso",
    "conceder_entitlement",
    "crear_orden",
    "cursos_con_acceso",
    "marcar_evento_procesado",
    "marcar_orden",
    "matricular",
    "producto_de_curso",
    "producto_de_tienda",
    "registrar_evento",
    "registrar_transaccion",
    "resolver_acceso_a_la_leccion",
    "resolver_acceso_al_curso",
    "revocar_compra_heredada",
    "revocar_entitlement",
]
