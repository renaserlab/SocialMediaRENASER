"""Si dos personas se cruzaron DE VERDAD, y por que via.

QUE PROBLEMA RESUELVE. Una seccion de resenas donde cualquiera puede opinar de
cualquiera vale poco: no se distingue a quien contrato una sesion y salio
contento de quien pasaba por ahi. El sello de «interaccion verificada» es esa
distincion, y solo sirve para algo si NO SE PUEDE FALSEAR.

DE DONDE SALE LA EVIDENCIA. De datos que ya existen en esta base y que no los
escribe quien opina:

  * `bookings` con `status = 'completed'` entre las dos personas. La migracion
    0025 guardo `completed_at` diciendo exactamente esto: «es lo que permitira
    verificar una resena posterior».
  * `purchases` con `status = 'paid'` de quien opina, sobre un curso cuyo autor
    es la persona resenada.

QUE NO SE HACE, Y ES LO IMPORTANTE. No hay ningun campo que el cliente pueda
mandar para pedir el sello, ni ningun endpoint para ponerlo. Se calcula aqui,
en el servidor, en el momento de publicar. Si no hay constancia, la resena se
publica IGUAL y sin sello: no llevar sello no es un defecto, es la situacion
normal de casi todas.

POR QUE SE GUARDA LA FUENTE Y NO UN BOOLEANO. Un `verified = true` no se puede
justificar despues: seis meses mas tarde nadie sabe por que lo lleva. Con
`'booking'` o `'course'` guardado, el sello siempre se puede explicar.

POR QUE SE CONGELA AL PUBLICAR. La reserva ocurrio, y eso ya no cambia. Si se
recalculara en cada lectura, cancelar una reserva antigua retiraria el sello de
una resena escrita cuando la sesion si habia ocurrido, y volver a comprarle un
curso a alguien se lo devolveria. La resena describe un momento; su sello
tambien.
"""

from __future__ import annotations

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking
from app.modules.catalog.models import Course
from app.modules.commerce import esquema as esquema_comercio
from app.modules.commerce.models import CommerceProduct, Order
from app.modules.learning.models import Purchase


async def fuente_de_verificacion(
    db: AsyncSession, reviewer_id: str, reviewed_user_id: str
) -> str | None:
    """`'booking'`, `'course'` o `None` si no hay constancia de nada.

    El orden importa poco pero no es casual: una sesion 1:1 es la interaccion
    mas fuerte que hay entre dos cuentas de Z, asi que se mira primero y se
    devuelve sin seguir buscando.
    """
    if reviewer_id == reviewed_user_id:
        # No deberia llegar aqui —la autoresena se corta antes— pero devolver
        # un sello por haberse comprado el propio curso seria absurdo.
        return None

    # 1. Una sesion que OCURRIO entre las dos, en cualquiera de los dos papeles.
    #    Sirve tanto si quien opina pidio la sesion como si la dio: las dos
    #    personas estuvieron igual de presentes.
    sesion = await db.scalar(
        select(Booking.id)
        .where(
            Booking.status == "completed",
            or_(
                (Booking.requester_id == reviewer_id)
                & (Booking.provider_id == reviewed_user_id),
                (Booking.requester_id == reviewed_user_id)
                & (Booking.provider_id == reviewer_id),
            ),
        )
        .limit(1)
    )
    if sesion is not None:
        return "booking"

    # 2. Un curso de la persona resenada, PAGADO por quien opina.
    #
    #    `Purchase.status` esta tipada con el enum `purchase_status`: comparar
    #    con una cadena sin tipar reventaba en PostgreSQL con «operator does not
    #    exist: purchase_status = character varying».
    compra = await db.scalar(
        select(Purchase.id)
        .join(Course, Course.id == Purchase.course_id)
        .where(
            Purchase.user_id == reviewer_id,
            Purchase.status == "paid",
            Course.author_id == reviewed_user_id,
        )
        .limit(1)
    )
    if compra is not None:
        return "course"

    # 3. Lo mismo, pero en el COMERCIO NUEVO (0035).
    #
    #    `purchases` es la tabla heredada y ya no la escribe nadie: ni Stripe ni
    #    RevenueCat pasan por ahi, sus compras viven en `orders`. Mirando solo
    #    la vieja pasaba algo absurdo: quien compro un curso por la web y luego
    #    opinaba sobre su autor salia SIN sello, mientras que una compra antigua
    #    de la tabla heredada si lo llevaba. El mismo hecho, contado de dos
    #    maneras segun cuando ocurrio.
    #
    #    LA ORDEN Y NO EL DERECHO. Un `entitlement` tambien se concede por una
    #    beca, un regalo o la beta, y esos no son una compra: poner el sello ahi
    #    seria justo la clase de sello que no se puede justificar despues. La
    #    orden `paid` si es dinero que se cobro.
    if not await esquema_comercio.hay_comercio(db):
        return None

    orden = await db.scalar(
        select(Order.id)
        .join(CommerceProduct, CommerceProduct.id == Order.commerce_product_id)
        .join(Course, Course.id == CommerceProduct.course_id)
        .where(
            Order.user_id == reviewer_id,
            Order.status == "paid",
            Course.author_id == reviewed_user_id,
        )
        .limit(1)
    )
    return "course" if orden is not None else None
