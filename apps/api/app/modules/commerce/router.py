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

import logging

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenError, NotFoundError
from app.core.security import AuthUser, get_current_user
from app.modules.catalog.models import Course
from app.modules.commerce.models import CommerceProduct, Order, OwnerSaleBalance
from app.modules.commerce import liquidacion
from app.modules.gobernanza import auditoria
from app.modules.gobernanza.contexto import leer_origen
from app.modules.commerce.schemas import (
    ESTADOS_DE_SALDO,
    Comprador,
    OwnerCourseSummary,
    BalancesRetenidos,
    OwnerSaleRead,
    ResultadoDeLiquidacion,
    SaldoPorEstado,
)
from app.modules.profiles.models import Profile
from app.modules.refunds import esquema as esquema_devoluciones
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.pagination import Page, pagination_params
from app.shared.permissions import puede_mover_dinero

logger = logging.getLogger("renaser.commerce")

router = APIRouter(prefix="/commerce", tags=["comercio-propietario"])


async def _curso_propio(
    db: AsyncSession, course_id: str, current_user: AuthUser
) -> Course:
    """El curso, si esta persona puede ver su dinero. Si no, 403."""
    ensure_uuid(course_id, "Curso no encontrado.")
    curso = await db.get(Course, course_id)
    if curso is None:
        raise NotFoundError("Curso no encontrado.")
    # `puede_mover_dinero` Y NO `is_admin`. `is_admin` incluye `moderator`, que
    # es la cuenta creada para ocultar una publicacion o resolver un reporte; con
    # ella se veian importes brutos, comision de plataforma, neto del autor y el
    # listado de ventas de CUALQUIER curso. Moderar contenido y mirar la caja de
    # otra persona son dos permisos distintos, y aqui lo eran solo en el nombre.
    if curso.author_id != current_user.id and not await puede_mover_dinero(
        db, current_user.id
    ):
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


# --------------------------------------------------------------------------- #
# Administración: el dinero retenido, visible
# --------------------------------------------------------------------------- #
#
# POR QUE EXISTE. La documentacion prometia vigilar «saldos `pending` con
# `available_at` nulo y mas de 30 dias» —compras que nadie llego a abrir, con el
# dinero del propietario retenido sin fecha— y esa señal no tenia donde verse:
# lo unico que habia era el resumen POR CURSO y solo para su autor. Cien ventas
# asi acumulan dinero parado hasta que alguien reclama.
#
# No es un panel de tesoreria: es la consulta minima que convierte una promesa
# de la documentacion en algo que se puede mirar.

admin_router = APIRouter(prefix="/admin", tags=["comercio-administracion"])


async def _exigir_admin(db: AsyncSession, current_user: AuthUser) -> None:
    """Los saldos son dinero, así que valen los mismos permisos que el dinero.

    `puede_mover_dinero` y no `is_admin`: este endpoint dice cuánto hay
    retenido, cuánto congelado y desde cuándo. Es información de tesorería, no
    de moderación, y `is_admin` incluía al rol `moderator`.
    """
    if not await puede_mover_dinero(db, current_user.id):
        raise ForbiddenError("Solo administración puede ver los saldos.")


@admin_router.get("/owner-balances/health", response_model=BalancesRetenidos)
async def salud_de_los_saldos(
    dias: int = 30,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> BalancesRetenidos:
    """Cuánto dinero hay retenido, en qué estado y desde cuándo.

    Devuelve ceros —no un 500— si la 0049 no está aplicada, igual que el resto
    del módulo: desplegar este endpoint no puede exigir la migración.
    """
    await _exigir_admin(db, current_user)
    vacio = BalancesRetenidos(
        por_estado=_saldos_en_cero(),
        sin_fecha=0,
        sin_fecha_antiguos=0,
        congelados_antiguos=0,
        dias=dias,
    )
    if not await esquema_devoluciones.hay_liquidaciones(db):
        return vacio

    from datetime import datetime, timedelta, timezone

    corte = datetime.now(timezone.utc) - timedelta(days=max(dias, 0))

    filas = await db.execute(
        select(
            OwnerSaleBalance.status,
            func.count(OwnerSaleBalance.id),
            func.coalesce(func.sum(OwnerSaleBalance.net_amount_minor), 0),
        ).group_by(OwnerSaleBalance.status)
    )
    por_estado = _saldos_en_cero()
    for estado, cuantos, importe in filas:
        if estado in por_estado:
            por_estado[estado] = SaldoPorEstado(
                count=int(cuantos), net_amount_minor=int(importe)
            )

    # LA SEÑAL QUE IMPORTA: `pending` sin fecha de vencimiento. Significa que la
    # persona compró y no ha entrado nunca, así que la garantía no ha arrancado
    # y el dinero no tiene cuándo liberarse.
    sin_fecha = await db.scalar(
        select(func.count(OwnerSaleBalance.id)).where(
            OwnerSaleBalance.status == "pending",
            OwnerSaleBalance.available_at.is_(None),
        )
    )
    sin_fecha_antiguos = await db.scalar(
        select(func.count(OwnerSaleBalance.id)).where(
            OwnerSaleBalance.status == "pending",
            OwnerSaleBalance.available_at.is_(None),
            OwnerSaleBalance.created_at <= corte,
        )
    )
    # Y los congelados que nadie resuelve: expedientes abiertos, o una disputa.
    congelados = await db.scalar(
        select(func.count(OwnerSaleBalance.id)).where(
            OwnerSaleBalance.status == "frozen",
            OwnerSaleBalance.updated_at <= corte,
        )
    )
    return BalancesRetenidos(
        por_estado=por_estado,
        sin_fecha=int(sin_fecha or 0),
        sin_fecha_antiguos=int(sin_fecha_antiguos or 0),
        congelados_antiguos=int(congelados or 0),
        dias=dias,
    )


@admin_router.post("/owner-balances/settle", response_model=ResultadoDeLiquidacion)
async def liquidar(
    request: Request,
    limite: int = Query(default=100, ge=1, le=500),
    solo_liberar: bool = Query(default=False),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ResultadoDeLiquidacion:
    """Mueve los saldos vencidos y paga a los propietarios que toque.

    POR QUE EXISTE ESTE ENDPOINT. `liberar_vencidos` y `ejecutar_transferencia`
    estaban escritas, documentadas y probadas, y NADIE LAS LLAMABA: ni un
    endpoint, ni una tarea, ni el arranque. El resultado es que ningun saldo
    salia nunca de `pending`, asi que `puede_transferirse` contestaba siempre
    `not_eligible` y el dinero del propietario se quedaba retenido para siempre
    por mucho que se encendieran las banderas. Solo se veia en el endpoint de
    salud, que mira pero no toca.

    SE DISPARA A MANO, y no desde un planificador dentro de la API. La aplicacion
    corre en varias replicas y un temporizador en el proceso significa tantas
    pasadas simultaneas como replicas haya; ademas, pagar dinero cuando nadie
    esta mirando es exactamente lo que no conviene mientras la funcion es nueva.
    Es idempotente y acotado, asi que llamarlo dos veces seguidas no duplica
    nada y se puede colgar de un cron externo cuando se decida.

    NO ENCIENDE NADA. Con las banderas apagadas la parte de liberacion sigue
    funcionando —es contabilidad interna, no dinero saliendo— y todas las
    transferencias se cuentan como omitidas con el motivo `transfers_disabled`,
    que es lo que hace util llamarlo tambien en pruebas.

    `solo_liberar` deja la primera mitad y se salta los pagos: sirve para poner
    al dia los estados sin tocar la pasarela.

    LIMITE CONOCIDO. Los elegibles se toman por fecha de vencimiento y acotados
    por `limite`; los que no pasan `puede_transferirse` se cuentan como omitidos
    pero siguen siendo los primeros de la cola en la siguiente pasada. Con
    `limite` saldos permanentemente bloqueados —una cuenta de cobro sin
    completar, por ejemplo— los de detras no llegarian a pagarse nunca. Se
    detecta mirando `omitidos`: un motivo repetido y estable en cada pasada es
    justo eso, y se resuelve subiendo `limite` o arreglando esas cuentas. No se
    pagina aqui porque hoy el volumen no lo justifica y un `offset` sobre una
    lista que cambia mientras se recorre trae sus propios problemas.
    """
    await _exigir_admin(db, current_user)
    resultado = ResultadoDeLiquidacion()
    if not await esquema_devoluciones.hay_liquidaciones(db):
        # Sin la 0049 no hay nada que liquidar. Ceros, no un 500: el endpoint se
        # puede desplegar antes que la migracion.
        return resultado

    resultado.liberados = await liquidacion.liberar_vencidos(db, limite=limite)
    if resultado.liberados:
        # QUIEN LO DISPARO Y CUANTOS SE MOVIERON. Antes esto solo devolvia un
        # contador: no quedaba constancia de que alguien hubiera pasado saldos a
        # disponibles, ni de cuando. Va en la MISMA transaccion que el cambio.
        await auditoria.anotar(
            db,
            action="balances.released",
            entity_type="owner_sale_balance",
            # No hay una entidad unica: es una pasada. Se apunta contra quien la
            # lanzo, que es la respuesta a «¿quien movio esto?».
            entity_id=current_user.id,
            actor_id=current_user.id,
            actor_role="admin",
            new_state="eligible",
            payload={"liberados": resultado.liberados, "limite": limite},
            origen=leer_origen(request),
        )
    await db.commit()
    if solo_liberar:
        return resultado

    # SOLO LOS IDENTIFICADORES, no los objetos.
    #
    # El bucle hace `commit` y, cuando algo falla, `rollback`. Las dos cosas
    # caducan TODOS los objetos del ORM cargados en la sesion, no solo el de la
    # vuelta que fallo: guardando la lista de saldos, la vuelta siguiente leia
    # `saldo.status` de un objeto expirado y disparaba una recarga perezosa que
    # en asincrono revienta con `MissingGreenlet`. Un fallo en el primero se
    # llevaba por delante a todos los demas, que es justo lo que el `try` de
    # abajo dice evitar.
    #
    # Con los identificadores se recarga en cada vuelta y el estado es el real,
    # no el que se leyo hace veinte transferencias.
    identificadores = list(
        await db.scalars(
            select(OwnerSaleBalance.id)
            .where(OwnerSaleBalance.status == "eligible")
            .order_by(OwnerSaleBalance.available_at)
            .limit(limite)
        )
    )
    omitidos: dict[str, int] = {}
    for balance_id in identificadores:
        saldo = await db.get(OwnerSaleBalance, balance_id)
        if saldo is None:
            continue
        motivo = await liquidacion.puede_transferirse(db, saldo)
        if motivo is not None:
            omitidos[motivo] = omitidos.get(motivo, 0) + 1
            continue
        try:
            intento = await liquidacion.ejecutar_transferencia(db, saldo)
            estado_del_intento = intento.status if intento is not None else None
            if intento is not None:
                # ANTES DEL `commit`, Y NO DESPUES. La propiedad que se busca es
                # «no existe movimiento sin su registro»: con la anotacion
                # despues, una caida entre los dos `commit` dejaba el dinero
                # fuera y `audit_events` vacio, que es exactamente el caso
                # indefendible.
                await auditoria.anotar(
                    db,
                    action="transfer.executed",
                    entity_type="owner_sale_balance",
                    entity_id=balance_id,
                    actor_id=current_user.id,
                    actor_role="admin",
                    # `ok` solo cuando la pasarela lo dio por completado. Un
                    # intento en curso no es un pago hecho.
                    outcome="ok" if estado_del_intento == "completed" else "error",
                    new_state=estado_del_intento,
                    payload={"transfer_id": intento.id},
                    origen=leer_origen(request),
                )
            await db.commit()
        except Exception:  # noqa: BLE001
            # UNO QUE FALLA NO SE LLEVA A LOS DEMAS. Se deshace lo suyo y se
            # sigue: el saldo se queda como estaba y entra en la proxima pasada.
            logger.exception(
                "[liquidacion] fallo al transferir el saldo %s", balance_id
            )
            await db.rollback()
            resultado.fallidos += 1
            continue
        if intento is None:
            # Se lo llevo otro proceso entre la comprobacion y el turno.
            omitidos["taken"] = omitidos.get("taken", 0) + 1
            continue
        resultado.transferencias_intentadas += 1
        # `estado_del_intento` se leyo ANTES del commit: despues, el objeto esta
        # caducado y leerle el estado seria otra recarga perezosa.
        if estado_del_intento == "completed":
            resultado.transferencias_completadas += 1
    resultado.omitidos = omitidos
    return resultado
