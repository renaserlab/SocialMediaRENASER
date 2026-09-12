"""La regla obligatoria de Z: si el organizador cancela, se devuelve el 100 %.

LO QUE DEFIENDEN ESTAS PRUEBAS. Que la regla prevalezca sobre una condición del
organizador que diga lo contrario; que prevalezca incluso cuando esa compra no
aceptó ninguna política; que DECIDIR no se confunda nunca con HABER PAGADO —el
expediente queda debiendo el dinero, no cobrado—; que no se libere ni se revoque
nada por el camino; que una condición contradictoria no se pueda publicar y que
una histórica no se reescriba, sino que se muestre la excepción; y que todo esto
siga siendo idempotente y reanudable por tandas.

Los ayudantes se importan de `test_politicas_del_organizador` a propósito: son
los mismos hechos —una persona, un evento, una venta pagada con su entrada— y
tener dos copias significaría que una se queda vieja.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import func, select, text

from app.core.exceptions import AppError
from app.modules.commerce.models import OwnerSaleBalance
from app.modules.events import aceptacion, cancelacion, elegibilidad, finanzas, politicas
from app.modules.events import politicas_del_organizador as propias
from app.modules.events.models import EventOrder, EventTicket
from app.modules.events.posventa_models import (
    APROBADO,
    DEVOLUCION_EN_CURSO,
    DEVOLUCION_PENDIENTE,
    ENVIADO,
    EXPEDIENTES_VIVOS,
    POLITICA_ELEGIBILIDAD,
    RESUELTO,
    EventAftersaleCase,
    EventAftersaleCaseEvent,
    EventPolicy,
)
from app.modules.notifications.models import NotificationDelivery
from tests.test_politicas_del_organizador import (  # noqa: F401
    REGLAS,
    SIN_POSTGRES,
    _evento,
    _persona,
    _venta,
    base_aplicada,
    sesiones,
)


def ahora() -> datetime:
    return datetime.now(timezone.utc)


async def _cancelar_el_evento(sesiones, evento: str) -> None:
    """Deja el evento CANCELADO en lo operativo, sin pasar por el servicio.

    `aplica_a` mira `workflow_status`, que es lo que de verdad pasó, y no
    `events.status`, que es visibilidad.
    """
    async with sesiones() as db:
        await db.execute(
            text(
                "update public.event_operations set workflow_status = 'CANCELLED'"
                " where event_id = cast(:e as uuid)"
            ),
            {"e": evento},
        )
        await db.commit()


async def _publicada_a_mano(
    sesiones, evento: str, params: dict, *, version="v1"
) -> str:
    """Una política PUBLICADA escrita directamente en la base.

    Es la única forma de tener una histórica que contradiga el mandato: por la
    API ya no se puede publicar, y de eso va justamente una de estas pruebas.
    """
    ident = str(uuid.uuid4())
    async with sesiones() as db:
        await db.execute(
            text(
                "insert into public.event_policies (id, policy_type, scope,"
                " event_id, jurisdiction, locale, version, status, params,"
                " params_sha256, body, effective_from, published_at) values"
                " (cast(:i as uuid), :t, 'event', cast(:e as uuid), 'PE', 'es',"
                " :v, 'published', cast(:p as jsonb), :h, :b, :m, :m)"
            ),
            {
                "i": ident,
                "t": POLITICA_ELEGIBILIDAD,
                "e": evento,
                "v": version,
                "p": json.dumps(params),
                "h": politicas.huella(params),
                "b": "Si cancelamos el evento no se devuelve el importe.",
                "m": ahora(),
            },
        )
        await db.commit()
    return ident


async def _caso_vivo(sesiones, orden: str) -> EventAftersaleCase | None:
    async with sesiones() as db:
        return await db.scalar(
            select(EventAftersaleCase).where(
                EventAftersaleCase.order_id == orden,
                EventAftersaleCase.status.in_(EXPEDIENTES_VIVOS),
            )
        )


# =========================================================================== #
# Antes de vender, y después
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_cancelar_antes_de_vender_no_inventa_nada(sesiones) -> None:
    """UN EVENTO SIN COMPRAS SE CANCELA IGUAL, y no deja nada detrás.

    Ni expedientes, ni avisos, ni saldos. Que la regla obligatoria exista no
    puede hacer que aparezca una devolución donde nadie pagó.
    """
    organiza = await _persona(sesiones, "org")
    evento = await _evento(sesiones, organiza)
    await _cancelar_el_evento(sesiones, evento)

    async with sesiones() as db:
        resultado = await cancelacion.cancelar_evento(
            db, evento_id=evento, actor_id=organiza, motivo="se cayó el recinto"
        )
        await db.commit()

    assert resultado.regla == "full_refund_required"
    assert resultado.expedientes == 0
    assert resultado.devoluciones_decididas == 0
    assert resultado.saldos_bloqueados == 0
    assert resultado.pendientes == 0

    async with sesiones() as db:
        assert (
            await db.scalar(select(func.count()).select_from(EventAftersaleCase))
        ) == 0
        assert (
            await db.scalar(
                select(func.count()).select_from(NotificationDelivery)
            )
        ) == 0


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_cancelar_despues_de_vender_deja_la_devolucion_debida(
    sesiones, monkeypatch
) -> None:
    """DECIDIDO, NO PAGADO, y sin tocar nada de lo que no toca.

    El expediente queda en «hay que devolver» con el importe entero; el saldo
    del organizador sigue retenido y sin liberar; la entrada sigue válida; y no
    hay ningún rastro de cobro, porque nadie ha cobrado nada.
    """
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "platform_fee_bps", 1000, raising=False)
    organiza = await _persona(sesiones, "org")
    compra = await _persona(sesiones, "com")
    evento = await _evento(sesiones, organiza)
    orden = await _venta(sesiones, evento, compra, total=25_000)
    await _cancelar_el_evento(sesiones, evento)

    async with sesiones() as db:
        fila = await db.get(EventOrder, orden)
        saldo = await finanzas.registrar_venta(db, orden=fila)
        await db.commit()
        saldo_id, neto = saldo.id, saldo.net_amount_minor

    async with sesiones() as db:
        resultado = await cancelacion.cancelar_evento(
            db, evento_id=evento, actor_id=organiza, motivo="no se hará"
        )
        await db.commit()

    assert resultado.devoluciones_decididas == 1
    assert resultado.saldos_bloqueados == 1

    caso = await _caso_vivo(sesiones, orden)
    assert caso is not None
    assert caso.status == DEVOLUCION_PENDIENTE
    assert caso.refund_amount_minor == 25_000
    assert caso.currency == "PEN"
    # NADA DE PAGADO: sin resultado, sin fecha de cierre y sin referencia
    # externa. Las tres aparecen cuando el proveedor confirma, no antes.
    assert caso.outcome is None
    assert caso.resolved_at is None
    assert caso.external_refund_id is None

    async with sesiones() as db:
        actual = await db.get(OwnerSaleBalance, saldo_id)
        assert actual.status == finanzas.PENDIENTE
        assert await finanzas.reservado_de(db, saldo_id=saldo_id) == neto
        assert await finanzas.por_que_no_se_libera(db, saldo=actual) is not None
        entradas = list(
            await db.scalars(select(EventTicket.status).where(EventTicket.order_id == orden))
        )
    assert entradas == ["VALID"], "cancelar no revoca: revocar no es reversible"


# =========================================================================== #
# La condición del organizador no manda
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_politica_que_promete_menos_no_se_publica(sesiones) -> None:
    """NI EL ORGANIZADOR NI LA PLATAFORMA pueden publicar «sin devolución».

    No es una opinión sobre su negocio: publicada dejaría a quien compra leyendo
    lo contrario de lo que va a pasar.
    """
    organiza = await _persona(sesiones, "org")
    evento = await _evento(sesiones, organiza)

    async with sesiones() as db:
        borrador = await propias.guardar_borrador(
            db,
            evento_id=evento,
            usuario_id=organiza,
            tipo=POLITICA_ELEGIBILIDAD,
            version="v1",
            params={**REGLAS, "cancelled_event_bps": 0},
        )
        await db.commit()
        borrador_id = borrador.id

    # EL BORRADOR SÍ SE GUARDA: a medias es lo normal mientras se escribe.
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await propias.publicar_borrador(
                db, politica_id=borrador_id, usuario_id=organiza
            )
    assert fallo.value.code == "event_policy_contradicts_mandatory_refund"

    # Y tampoco por la puerta de la plataforma.
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await politicas.publicar(
                db,
                tipo=POLITICA_ELEGIBILIDAD,
                version="global-1",
                params={**REGLAS, "cancelled_event_bps": 5_000},
            )
    assert fallo.value.code == "event_policy_contradicts_mandatory_refund"

    # El 100 % sí, obviamente: es lo que Z exige.
    async with sesiones() as db:
        await politicas.publicar(
            db,
            tipo=POLITICA_ELEGIBILIDAD,
            version="global-2",
            params={**REGLAS, "cancelled_event_bps": 10_000},
        )
        await db.commit()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_politica_historica_contradictoria_no_se_reescribe(sesiones) -> None:
    """LO ACEPTADO NO SE TOCA, Y LA EXCEPCIÓN SE VE.

    Una política publicada antes de la regla puede decir «no se devuelve». Su
    versión aceptada es intocable —falsificaría lo que esa persona leyó—, así
    que la regla se aplica AL RESOLVER y la excepción viaja al comprador.
    """
    organiza = await _persona(sesiones, "org")
    compra = await _persona(sesiones, "com")
    evento = await _evento(sesiones, organiza)
    politica_id = await _publicada_a_mano(
        sesiones, evento, {**REGLAS, "cancelled_event_bps": 0}
    )
    orden = await _venta(sesiones, evento, compra)
    async with sesiones() as db:
        pedido = await db.get(EventOrder, orden)
        await aceptacion.registrar(
            db, orden_id=orden, evento_id=evento, usuario_id=compra
        )
        await db.commit()

    # 1. La versión publicada sigue diciendo exactamente lo que decía.
    async with sesiones() as db:
        vieja = await db.get(EventPolicy, politica_id)
        assert vieja.params["cancelled_event_bps"] == 0
        assert vieja.status == "published"
        assert vieja.params_sha256 == politicas.huella(dict(vieja.params))

    # 2. Y la excepción se enseña: el mandato viaja con las condiciones y dice
    #    qué parámetro queda sin efecto.
    from app.modules.events.politicas_router import _mandato_sobre

    async with sesiones() as db:
        vigentes = await aceptacion.aplicables(db, evento_id=evento)
    mandato = _mandato_sobre(vigentes)
    assert mandato is not None
    assert mandato.code == cancelacion.MANDATO
    assert mandato.refund_bps == 10_000
    assert mandato.overrides == ["cancelled_event_bps"]

    # 3. Al decidir, manda Z: el 100 %, no el 0 % que prometió la condición.
    await _cancelar_el_evento(sesiones, evento)
    async with sesiones() as db:
        pedido = await db.get(EventOrder, orden)
        veredicto = await elegibilidad.evaluar(db, orden=pedido)
    assert veredicto.resultado == elegibilidad.ELEGIBLE
    assert veredicto.porcentaje_bps == 10_000
    assert elegibilidad.MANDATO_DE_Z in veredicto.motivos
    # Se conserva de qué versión se está haciendo la excepción.
    assert veredicto.politica_id == politica_id


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_politica_configurada_el_mandato_sigue_rigiendo(sesiones) -> None:
    """LA REGLA ES DE Z, NO DEL ORGANIZADOR.

    Sin este orden, una compra que no aceptó ninguna política contestaría
    `policy_not_configured` y la pantalla apagaría el botón: quien pagó por un
    evento que no se hará se quedaría sin nada porque nadie publicó un plazo.
    """
    organiza = await _persona(sesiones, "org")
    compra = await _persona(sesiones, "com")
    evento = await _evento(sesiones, organiza)
    orden = await _venta(sesiones, evento, compra)

    # Sin cancelar y sin política: eso SÍ es «no configurado».
    async with sesiones() as db:
        pedido = await db.get(EventOrder, orden)
        antes = await elegibilidad.evaluar(db, orden=pedido)
    assert antes.resultado == elegibilidad.POLITICA_NO_CONFIGURADA

    await _cancelar_el_evento(sesiones, evento)
    async with sesiones() as db:
        pedido = await db.get(EventOrder, orden)
        despues = await elegibilidad.evaluar(db, orden=pedido)
    assert despues.resultado == elegibilidad.ELEGIBLE
    assert despues.porcentaje_bps == 10_000
    assert despues.politica_id is None, "no se inventa una política que nadie publicó"


# =========================================================================== #
# Solicitudes que ya existían
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_solicitud_existente_se_eleva_y_no_se_duplica(sesiones) -> None:
    """SU CASO ES SU CASO. Se eleva el que ya tenía, no se abre otro.

    Abrirle un segundo expediente partiría su solicitud en dos y chocaría con
    el índice parcial de uno vivo por pedido.
    """
    from app.modules.events import posventa

    organiza = await _persona(sesiones, "org")
    compra = await _persona(sesiones, "com")
    evento = await _evento(sesiones, organiza)
    orden = await _venta(sesiones, evento, compra, total=8_000)

    async with sesiones() as db:
        pedido = await db.get(EventOrder, orden)
        suyo = await posventa.abrir(
            db,
            orden=pedido,
            organizador_id=organiza,
            tipo="refund_request",
            motivo="ya no puedo ir",
            actor_id=compra,
            actor_rol="buyer",
            origen="buyer",
        )
        await db.commit()
        suyo_id = suyo.id
        assert suyo.status == ENVIADO

    await _cancelar_el_evento(sesiones, evento)
    async with sesiones() as db:
        resultado = await cancelacion.cancelar_evento(
            db, evento_id=evento, actor_id=organiza, motivo="no se hará"
        )
        await db.commit()

    assert resultado.expedientes == 1
    assert resultado.devoluciones_decididas == 1

    async with sesiones() as db:
        cuantos = await db.scalar(
            select(func.count())
            .select_from(EventAftersaleCase)
            .where(EventAftersaleCase.order_id == orden)
        )
        caso = await db.get(EventAftersaleCase, suyo_id)
    assert cuantos == 1, "se abrió un segundo expediente sobre la misma compra"
    assert caso.status == DEVOLUCION_PENDIENTE
    assert caso.refund_amount_minor == 8_000
    # Y lo que escribió el comprador sigue ahí: la causa se anota aparte.
    assert caso.buyer_reason == "ya no puedo ir"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_no_devolver_ya_decidido_queda_sin_efecto(sesiones) -> None:
    """EL MANDATO PREVALECE SOBRE UNA DECISIÓN YA TOMADA.

    Si alguien aprobó el caso aplicando una condición de «sin devolución», esa
    decisión deja de valer cuando el evento se cancela. No se reescribe ninguna
    política: se rectifica la DECISIÓN, y se anota por qué.
    """
    from app.modules.events import posventa

    organiza = await _persona(sesiones, "org")
    compra = await _persona(sesiones, "com")
    evento = await _evento(sesiones, organiza)
    politica_id = await _publicada_a_mano(
        sesiones, evento, {**REGLAS, "cancelled_event_bps": 0}
    )
    orden = await _venta(sesiones, evento, compra, total=12_000)

    async with sesiones() as db:
        pedido = await db.get(EventOrder, orden)
        caso = await posventa.abrir(
            db,
            orden=pedido,
            organizador_id=organiza,
            tipo="refund_request",
            motivo="pido devolución",
            actor_id=compra,
            actor_rol="buyer",
            origen="buyer",
        )
        await db.commit()
        caso_id = caso.id
    async with sesiones() as db:
        await posventa.transicionar(
            db,
            expediente_id=caso_id,
            hasta="under_review",
            actor_id=organiza,
            actor_rol="admin",
        )
        await posventa.transicionar(
            db,
            expediente_id=caso_id,
            hasta=APROBADO,
            actor_id=organiza,
            actor_rol="admin",
            politica_id=politica_id,
            resultado="no_refund",
        )
        await db.commit()
    async with sesiones() as db:
        assert (await db.get(EventAftersaleCase, caso_id)).outcome == "no_refund"

    await _cancelar_el_evento(sesiones, evento)
    async with sesiones() as db:
        await cancelacion.cancelar_evento(
            db, evento_id=evento, actor_id=organiza, motivo="no se hará"
        )
        await db.commit()

    async with sesiones() as db:
        caso = await db.get(EventAftersaleCase, caso_id)
    assert caso.status == DEVOLUCION_PENDIENTE
    assert caso.refund_amount_minor == 12_000
    assert caso.outcome is None, "el «no devolver» tenía que quedar sin efecto"
    assert "no_refund" in (caso.internal_notes or "")
    assert cancelacion.MANDATO in (caso.internal_notes or "")


# =========================================================================== #
# Devolución ya confirmada
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_lo_ya_devuelto_no_se_debe_dos_veces(sesiones) -> None:
    """EL 100 % MENOS LO QUE YA VOLVIÓ.

    Si a esa compra ya se le devolvió todo, el mandato no decide nada nuevo.
    Deberlo otra vez sería pagar dos veces por lo mismo.
    """
    organiza = await _persona(sesiones, "org")
    compra = await _persona(sesiones, "com")
    evento = await _evento(sesiones, organiza)
    politica_id = await _publicada_a_mano(sesiones, evento, dict(REGLAS))
    orden = await _venta(sesiones, evento, compra, total=9_000)

    # Un expediente CERRADO con la devolución hecha: el dinero volvió.
    async with sesiones() as db:
        await db.execute(
            text(
                "insert into public.event_aftersale_cases (id, event_id, order_id,"
                " buyer_id, organizer_id, kind, status, origin, policy_id, outcome,"
                " refund_amount_minor, currency, resolved_at) values"
                " (gen_random_uuid(), cast(:e as uuid), cast(:o as uuid),"
                " cast(:b as uuid), cast(:g as uuid), 'refund_request', 'resolved',"
                " 'buyer', cast(:p as uuid), 'full_refund', 9000, 'PEN', :m)"
            ),
            {"e": evento, "o": orden, "b": compra, "g": organiza,
             "p": politica_id, "m": ahora()},
        )
        await db.commit()

    async with sesiones() as db:
        pedido = await db.get(EventOrder, orden)
        assert await cancelacion.por_devolver(db, pedido=pedido) == 0

    await _cancelar_el_evento(sesiones, evento)
    async with sesiones() as db:
        resultado = await cancelacion.cancelar_evento(
            db, evento_id=evento, actor_id=organiza, motivo="no se hará"
        )
        await db.commit()

    # Se le abre expediente por la cancelación —es un hecho que hay que
    # registrar— pero no se decide ninguna devolución nueva.
    assert resultado.devoluciones_decididas == 0
    caso = await _caso_vivo(sesiones, orden)
    assert caso is not None
    assert caso.status != DEVOLUCION_PENDIENTE
    assert caso.refund_amount_minor is None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_devolucion_en_curso_no_la_pisa_el_mandato(sesiones) -> None:
    """EL DINERO YA VA DE CAMINO: no se vuelve a decidir sobre él.

    `refund_processing` significa que la orden salió al proveedor. Devolverlo a
    «hay que devolver» abriría la puerta a ejecutarlo dos veces.
    """
    organiza = await _persona(sesiones, "org")
    compra = await _persona(sesiones, "com")
    evento = await _evento(sesiones, organiza)
    politica_id = await _publicada_a_mano(sesiones, evento, dict(REGLAS))
    orden = await _venta(sesiones, evento, compra, total=7_000)

    async with sesiones() as db:
        await db.execute(
            text(
                "insert into public.event_aftersale_cases (id, event_id, order_id,"
                " buyer_id, organizer_id, kind, status, origin, policy_id,"
                " refund_amount_minor, currency, external_refund_id) values"
                " (gen_random_uuid(), cast(:e as uuid), cast(:o as uuid),"
                " cast(:b as uuid), cast(:g as uuid), 'refund_request',"
                " 'refund_processing', 'buyer', cast(:p as uuid), 3000, 'PEN',"
                " 're_enCurso')"
            ),
            {"e": evento, "o": orden, "b": compra, "g": organiza, "p": politica_id},
        )
        await db.commit()

    await _cancelar_el_evento(sesiones, evento)
    async with sesiones() as db:
        resultado = await cancelacion.cancelar_evento(
            db, evento_id=evento, actor_id=organiza, motivo="no se hará"
        )
        await db.commit()

    assert resultado.devoluciones_decididas == 0
    caso = await _caso_vivo(sesiones, orden)
    assert caso.status == DEVOLUCION_EN_CURSO
    assert caso.refund_amount_minor == 3_000
    assert caso.external_refund_id == "re_enCurso"
    # Y NO SE LE ABRE OTRO: su caso sigue siendo uno, el que va de camino.
    async with sesiones() as db:
        cuantos = await db.scalar(
            select(func.count())
            .select_from(EventAftersaleCase)
            .where(EventAftersaleCase.order_id == orden)
        )
    assert cuantos == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_mandato_nunca_declara_el_dinero_devuelto(sesiones) -> None:
    """DECIDIR NO ES HABER PAGADO, y la máquina lo impone.

    De `refund_pending` no se sale a `resolved`: hay que ejecutar, y de la
    ejecución solo sale un aviso verificado del proveedor. Ni el sistema ni
    quien administra pueden saltarse ese paso.
    """
    from app.modules.events import posventa_estados as maquina

    with pytest.raises(maquina.SaltoInexistente):
        maquina.exigir(DEVOLUCION_PENDIENTE, RESUELTO, maquina.SISTEMA)
    with pytest.raises(maquina.SaltoInexistente):
        maquina.exigir(DEVOLUCION_PENDIENTE, RESUELTO, maquina.ADMINISTRACION)
    # Y el último paso, el que sí declara el hecho, no es de ninguna persona.
    with pytest.raises(maquina.SaltoNoPermitido):
        maquina.exigir(DEVOLUCION_EN_CURSO, RESUELTO, maquina.ADMINISTRACION)
    maquina.exigir(DEVOLUCION_EN_CURSO, RESUELTO, maquina.SISTEMA)


# =========================================================================== #
# Tandas, reintentos y avisos
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_por_tandas_se_decide_todo_sin_repetir_ninguna(sesiones) -> None:
    """EL TIEMPO SE ACABA ANTES QUE LAS COMPRAS.

    Un evento grande no cabe en una petición, así que se atiende por tandas. Lo
    que no puede pasar es que una tanda decida dos veces la misma devolución ni
    que alguna se quede sin decidir.
    """
    organiza = await _persona(sesiones, "org")
    evento = await _evento(sesiones, organiza)
    ordenes = []
    for _ in range(3):
        compra = await _persona(sesiones, "com")
        ordenes.append(await _venta(sesiones, evento, compra, total=5_000))
    await _cancelar_el_evento(sesiones, evento)

    decididas = 0
    for esperados in (2, 1, 0):
        async with sesiones() as db:
            tanda = await cancelacion.cancelar_evento(
                db, evento_id=evento, actor_id=organiza, motivo="no se hará", limite=1
            )
            await db.commit()
        assert tanda.pendientes == esperados
        decididas += tanda.devoluciones_decididas
    assert decididas == 3

    async with sesiones() as db:
        estados = list(
            await db.scalars(
                select(EventAftersaleCase.status).where(
                    EventAftersaleCase.order_id.in_(ordenes)
                )
            )
        )
        pasos = await db.scalar(
            select(func.count())
            .select_from(EventAftersaleCaseEvent)
            .where(
                EventAftersaleCaseEvent.to_status == DEVOLUCION_PENDIENTE,
                EventAftersaleCaseEvent.case_id.in_(
                    select(EventAftersaleCase.id).where(
                        EventAftersaleCase.order_id.in_(ordenes)
                    )
                ),
            )
        )
    assert estados == [DEVOLUCION_PENDIENTE] * 3
    assert pasos == 3, "una decisión por compra, ni una repetida"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_cancelar_dos_veces_no_avisa_dos_veces(sesiones) -> None:
    """EL BOTÓN SE PULSA DOS VECES, Y LA PETICIÓN SE REINTENTA.

    Un aviso repetido sobre el mismo hecho es la forma más rápida de que la
    gente apague las notificaciones y se pierda el siguiente.
    """
    organiza = await _persona(sesiones, "org")
    compra = await _persona(sesiones, "com")
    evento = await _evento(sesiones, organiza)
    orden = await _venta(sesiones, evento, compra)
    await _cancelar_el_evento(sesiones, evento)

    for _ in range(2):
        async with sesiones() as db:
            await cancelacion.cancelar_evento(
                db, evento_id=evento, actor_id=organiza, motivo="no se hará"
            )
            await db.commit()

    async with sesiones() as db:
        del_comprador = await db.scalar(
            select(func.count())
            .select_from(NotificationDelivery)
            .where(
                NotificationDelivery.user_id == compra,
                NotificationDelivery.type == "event_cancelled_full_refund",
            )
        )
        del_organizador = await db.scalar(
            select(func.count())
            .select_from(NotificationDelivery)
            .where(
                NotificationDelivery.user_id == organiza,
                NotificationDelivery.type
                == "event_cancelled_organizer_full_refund",
            )
        )
        pasos = await db.scalar(
            select(func.count())
            .select_from(EventAftersaleCaseEvent)
            .where(
                EventAftersaleCaseEvent.to_status == DEVOLUCION_PENDIENTE,
                EventAftersaleCaseEvent.case_id.in_(
                    select(EventAftersaleCase.id).where(
                        EventAftersaleCase.order_id == orden
                    )
                ),
            )
        )
    assert del_comprador == 1
    assert del_organizador == 1
    assert pasos == 1, "la segunda pasada volvió a mover un expediente ya decidido"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_los_avisos_del_mandato_dicen_que_se_debe_no_que_se_pago(sesiones) -> None:
    """LO QUE SE PROMETE ES LA DECISIÓN, NO EL ABONO.

    El plazo bancario no lo decidimos nosotros, así que no aparece; y «ya te lo
    devolvimos» sería falso hasta que lo confirme el proveedor.
    """
    from app.modules.notifications import textos

    for tipo in (
        "event_cancelled_full_refund",
        "event_cancelled_organizer_full_refund",
    ):
        assert tipo in textos.TEXTOS
        assert tipo in textos.DEDUPLICABLES
        for idioma in textos.IDIOMAS:
            titulo, cuerpo = textos.TEXTOS[tipo][idioma]
            assert titulo.strip() and cuerpo.strip()
            entero = f"{titulo} {cuerpo}".lower()
            # Ningún plazo prometido, y ningún hecho que no haya pasado.
            for prohibido in ("día", "dias", "días", "hábil", "day", "business",
                              "devolvimos", "refunded", "devolvido", "reembolsado"):
                assert prohibido not in entero, (tipo, idioma, prohibido)


# =========================================================================== #
# Nadie se lo salta
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_nadie_aprueba_menos_de_lo_que_Z_exige(sesiones) -> None:
    """AUTOCONCEDERSE UNA EXCEPCIÓN, CERRADO.

    Con el evento cancelado, cerrar el expediente con «sin devolución» o con
    una parcial no es una decisión disponible para nadie.
    """
    organiza = await _persona(sesiones, "org")
    compra = await _persona(sesiones, "com")
    evento = await _evento(sesiones, organiza)
    orden = await _venta(sesiones, evento, compra)

    async with sesiones() as db:
        pedido = await db.get(EventOrder, orden)
        assert await cancelacion.aplica_a(db, orden=pedido) is False

    await _cancelar_el_evento(sesiones, evento)
    async with sesiones() as db:
        pedido = await db.get(EventOrder, orden)
        assert await cancelacion.aplica_a(db, orden=pedido) is True
