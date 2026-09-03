"""La vista comercial del PROPIETARIO de un curso.

DOS ENDPOINTS Y UNA REGLA: quien vende ve su dinero; nadie mas ve el suyo, y el
que vende no ve el expediente de nadie.

    autor del curso   su resumen y sus ventas
    administracion    lo mismo, para poder ayudar
    cualquier otro    403, comprobado en el SERVIDOR

Que la pantalla no ofrezca el boton no protege nada: el 403 se decide aqui,
leyendo `Course.author_id`, y no en la aplicacion.

SIN LA 0049 RESPONDE CEROS, NO UN 500. Un 500 sale sin cabeceras CORS y el
navegador lo cuenta como fallo de red, que manda a buscar el problema al sitio
equivocado. Misma leccion que en `recommendations/esquema.py`.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenError, NotFoundError
from app.core.security import AuthUser, get_current_user
from app.modules.catalog.models import Course
from app.modules.commerce.models import CommerceProduct, Order, OwnerSaleBalance
from app.modules.commerce.schemas import (
    ESTADOS_DE_SALDO,
    Comprador,
    OwnerCourseSummary,
    OwnerSaleRead,
    SaldoPorEstado,
)
from app.modules.profiles.models import Profile
from app.modules.refunds import esquema as esquema_devoluciones
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.pagination import Page, pagination_params
from app.shared.permissions import is_admin

router = APIRouter(prefix="/commerce", tags=["comercio-propietario"])


async def _curso_propio(
    db: AsyncSession, course_id: str, current_user: AuthUser
) -> Course:
    """El curso, si esta persona puede ver su dinero. Si no, 403."""
    ensure_uuid(course_id, "Curso no encontrado.")
    curso = await db.get(Course, course_id)
    if curso is None:
        raise NotFoundError("Curso no encontrado.")
    if curso.author_id != current_user.id and not await is_admin(db, current_user.id):
        raise ForbiddenError("No puedes ver las ventas de este curso.")
    return curso


def _saldos_en_cero() -> dict[str, SaldoPorEstado]:
    """Las siete claves siempre presentes, aunque valgan cero."""
    return {estado: SaldoPorEstado() for estado in ESTADOS_DE_SALDO}


@router.get("/courses/{course_id}/summary", response_model=OwnerCourseSummary)
async def resumen_de_ventas(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> OwnerCourseSummary:
    """Cuanto se ha vendido de este curso y en que estado esta ese dinero."""
    curso = await _curso_propio(db, course_id, current_user)

    resumen = OwnerCourseSummary(
        course_id=curso.id,
        course_title=curso.title,
        currency=curso.currency or "PEN",
        balances=_saldos_en_cero(),
    )
    if not await esquema_devoluciones.hay_liquidaciones(db):
        # Sin la 0049 no hay saldos que sumar. Estructura completa y en ceros:
        # la pantalla se pinta igual y `settlement_available` lo explica.
        resumen.settlement_available = False
        return resumen

    # Alumnos que PAGARON: personas distintas, no compras. Quien compra dos
    # veces el mismo curso es un alumno, no dos.
    resumen.paid_students = int(
        await db.scalar(
            select(func.count(func.distinct(Order.user_id)))
            .join(CommerceProduct, CommerceProduct.id == Order.commerce_product_id)
            .where(CommerceProduct.course_id == curso.id, Order.status == "paid")
        )
        or 0
    )
    resumen.refunds = int(
        await db.scalar(
            select(func.count())
            .select_from(Order)
            .join(CommerceProduct, CommerceProduct.id == Order.commerce_product_id)
            .where(CommerceProduct.course_id == curso.id, Order.status == "refunded")
        )
        or 0
    )

    filas = await db.execute(
        select(
            OwnerSaleBalance.status,
            func.count().label("n"),
            func.sum(OwnerSaleBalance.gross_amount_minor),
            func.sum(OwnerSaleBalance.platform_fee_minor),
            func.sum(OwnerSaleBalance.provider_fee_minor),
            func.sum(OwnerSaleBalance.net_amount_minor),
            func.max(OwnerSaleBalance.currency),
        )
        .where(OwnerSaleBalance.course_id == curso.id)
        .group_by(OwnerSaleBalance.status)
    )
    for estado, n, bruto, comision, comision_pasarela, neto, moneda in filas:
        resumen.balances[estado] = SaldoPorEstado(
            count=int(n or 0), net_amount_minor=int(neto or 0)
        )
        # Una venta cancelada ya no es dinero de nadie: no suma a los totales.
        if estado == "cancelled":
            continue
        resumen.gross_amount_minor += int(bruto or 0)
        resumen.platform_fee_minor += int(comision or 0)
        resumen.provider_fee_minor += int(comision_pasarela or 0)
        resumen.net_amount_minor += int(neto or 0)
        if moneda:
            resumen.currency = moneda
    return resumen


@router.get("/courses/{course_id}/sales", response_model=list[OwnerSaleRead])
async def ventas_del_curso(
    course_id: str,
    page: Page = Depends(pagination_params),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[OwnerSaleRead]:
    """Las ventas, de la mas reciente a la mas antigua.

    LISTA VACIA y no un error cuando la 0049 no esta: es la misma pantalla.
    """
    await _curso_propio(db, course_id, current_user)
    if not await esquema_devoluciones.hay_liquidaciones(db):
        return []

    filas = (
        await db.execute(
            select(OwnerSaleBalance, Order.user_id)
            .join(Order, Order.id == OwnerSaleBalance.order_id)
            .where(OwnerSaleBalance.course_id == course_id)
            .order_by(OwnerSaleBalance.created_at.desc())
            .offset(page.offset)
            .limit(page.limit)
        )
    ).all()

    ventas: list[OwnerSaleRead] = []
    # UNA consulta para todos los perfiles de la pagina, no una por venta.
    # `db.get` dentro del bucle eran veinte viajes a la base para pintar veinte
    # filas, y crecia con el tamaño de pagina.
    ids = {user_id for _, user_id in filas if user_id}
    perfiles = (
        {
            p.id: p
            for p in await db.scalars(
                select(Profile).where(Profile.id.in_(ids))
            )
        }
        if ids
        else {}
    )
    for saldo, user_id in filas:
        perfil = perfiles.get(user_id) if user_id else None
        ventas.append(
            OwnerSaleRead(
                id=saldo.id,
                sold_at=saldo.created_at,
                gross_amount_minor=saldo.gross_amount_minor,
                platform_fee_minor=saldo.platform_fee_minor,
                provider_fee_minor=saldo.provider_fee_minor,
                net_amount_minor=saldo.net_amount_minor,
                currency=saldo.currency,
                status=saldo.status,
                available_at=saldo.available_at,
                # Nombre, usuario y avatar. Ni correo ni identificadores de la
                # pasarela: quien vende no necesita nada de eso para cobrar.
                buyer=(
                    Comprador(
                        id=perfil.id,
                        name=perfil.full_name or "",
                        username=perfil.username,
                        avatar_path=perfil.avatar_path,
                    )
                    if perfil
                    else None
                ),
            )
        )
    return ventas
