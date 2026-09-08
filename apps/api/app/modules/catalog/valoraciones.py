"""Valoraciones de cursos: quién puede, y qué significa «compra verificada».

La verificación NO se guarda: se deriva de la compra cada vez que se lee. Si
alguien devuelve el curso, su reseña sigue ahí —es su opinión— pero deja de
presentarse como compra activa.
"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.catalog.models import Course, CourseReview

#: Estados de orden que cuentan como compra hecha. `refunded` entra: se compró
#: de verdad, aunque después se devolviera; lo que cambia es la verificación.
COMPRADA = ("paid", "refunded")


async def compro_el_curso(db: AsyncSession, *, user_id: str, course_id: str) -> bool:
    """Si esta persona pagó este curso alguna vez, por cualquiera de las vías."""
    from app.modules.learning.models import Purchase

    if await db.scalar(
        select(Purchase.id)
        .where(
            Purchase.user_id == user_id,
            Purchase.course_id == course_id,
            Purchase.status == "paid",
        )
        .limit(1)
    ):
        return True

    from app.modules.commerce import esquema as esquema_comercio

    if not await esquema_comercio.hay_comercio(db):
        return False

    from app.modules.commerce.models import CommerceProduct, Order

    return bool(
        await db.scalar(
            select(Order.id)
            .join(CommerceProduct, CommerceProduct.id == Order.commerce_product_id)
            .where(
                Order.user_id == user_id,
                CommerceProduct.course_id == course_id,
                Order.status.in_(COMPRADA),
            )
            .limit(1)
        )
    )


async def tiene_acceso_ahora(db: AsyncSession, *, user_id: str, course_id: str) -> bool:
    """Si el acceso sigue vivo. Es lo que decide «compra verificada» HOY."""
    from app.modules.commerce import esquema as esquema_comercio
    from app.modules.commerce import service as comercio

    if not await esquema_comercio.hay_comercio(db):
        return await compro_el_curso(db, user_id=user_id, course_id=course_id)
    acceso = await comercio.resolver_acceso_al_curso(
        db, user_id=user_id, course_id=course_id, es_admin=False
    )
    return acceso.tiene_acceso


async def puede_valorar(
    db: AsyncSession, *, user_id: str, course_id: str
) -> tuple[bool, str]:
    """Si esta persona puede valorar este curso, y por qué no si no puede."""
    curso = await db.get(Course, course_id)
    if curso is None or curso.status != "published":
        return False, "course_not_found"
    if curso.author_id == user_id:
        # Valorar lo propio no es una opinión, es publicidad.
        return False, "review_owner_not_allowed"
    if not await compro_el_curso(db, user_id=user_id, course_id=course_id):
        return False, "review_purchase_required"
    if not await tiene_acceso_ahora(db, user_id=user_id, course_id=course_id):
        # Compró y ya no tiene acceso: devolvió, o se le revocó.
        return False, "review_access_required"
    return True, ""


async def resumen(db: AsyncSession, course_id: str) -> dict:
    """Promedio, total y distribución. Solo con las visibles.

    Se calcula en una consulta: guardarlo obligaría a mantenerlo al día en cada
    creación, edición y moderación, y a corregirlo cuando se desincronice.
    """
    filas = list(
        await db.execute(
            select(CourseReview.rating, func.count())
            .where(CourseReview.course_id == course_id, CourseReview.status == "visible")
            .group_by(CourseReview.rating)
        )
    )
    distribucion = {str(n): 0 for n in range(1, 6)}
    total = 0
    suma = 0
    for puntuacion, cuantas in filas:
        distribucion[str(puntuacion)] = cuantas
        total += cuantas
        suma += puntuacion * cuantas
    return {
        # `None` y no 0: sin reseñas no hay media, y un 0,0 diría que el curso
        # está mal valorado.
        "average": round(suma / total, 2) if total else None,
        "total": total,
        "distribution": distribucion,
    }
