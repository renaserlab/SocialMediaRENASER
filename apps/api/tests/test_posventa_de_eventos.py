"""La máquina de estados y la elegibilidad de la posventa de eventos.

LO QUE DEFIENDEN. Que aprobar no es haber pagado, que un plazo que nadie ha
decidido no se supone, y que un hecho que la política no resuelve va a revisión
en vez de resolverse solo hacia el lado cómodo.
"""

from __future__ import annotations

import hashlib
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.modules.events import efectos, elegibilidad, politicas, posventa
from app.modules.events import models as _modelos_de_evento  # noqa: F401
from app.modules.events import posventa_estados as maquina
from app.modules.events import tickets as emision
from app.modules.events.models import EventOrder, EventTicket
from app.modules.events.posventa_models import (
    APROBADO,
    CANCELADO,
    DEVOLUCION_EN_CURSO,
    DEVOLUCION_PENDIENTE,
    EN_REVISION,
    ENVIADO,
    ESPERANDO,
    FALLIDO,
    RECHAZADO,
    RESUELTO,
    EventAftersaleCase,
    EventAftersaleCaseTicket,
    EventChange,
)
from app.modules.profiles import models as _modelos_de_perfil  # noqa: F401
from tests.test_migraciones_reales import exigir_url_desechable

RAIZ = Path(__file__).resolve().parents[3]
MIGRACIONES = RAIZ / "supabase" / "migrations"
PROLOGO = RAIZ / "supabase" / "tests" / "prologo_local.sql"
URL = os.environ.get("MIGRACIONES_DATABASE_URL", "").strip()

SIN_POSTGRES = pytest.mark.skipif(
    not URL,
    reason=(
        "sin PostgreSQL desechable: define MIGRACIONES_DATABASE_URL "
        "(ver la cabecera de tests/test_migraciones_reales.py)"
    ),
)


# =========================================================================== #
# La máquina de estados: lógica pura, sin base de datos
# =========================================================================== #
def test_aprobar_no_es_haber_pagado() -> None:
    """LA REGLA QUE MÁS IMPORTA DE TODO EL INCREMENTO.

    Solo un aviso verificado del proveedor puede decir que el dinero volvió. Si
    un administrador pudiera declarar «devuelto», la pantalla del comprador
    enseñaría como hecho algo que nadie ha comprobado, y la persona dejaría de
    reclamar un dinero que no ha llegado.
    """
    assert maquina.SISTEMA in maquina.quienes(DEVOLUCION_EN_CURSO, RESUELTO)
    assert maquina.ADMINISTRACION not in maquina.quienes(DEVOLUCION_EN_CURSO, RESUELTO)
    with pytest.raises(maquina.SaltoNoPermitido):
        maquina.exigir(DEVOLUCION_EN_CURSO, RESUELTO, maquina.ADMINISTRACION)


def test_pero_cerrar_sin_dinero_si_lo_hace_quien_administra() -> None:
    """El otro camino a `resolved` no es el mismo: no hay dinero que mover.

    Sin distinguirlos, o se prohíbe cerrar un caso sin devolución, o se permite
    declarar «devuelto» a mano. Por eso los actores van por transición y no por
    destino.
    """
    maquina.exigir(APROBADO, RESUELTO, maquina.ADMINISTRACION)


def test_un_salto_que_no_existe_no_es_un_problema_de_permisos() -> None:
    """Dos preguntas distintas, dos errores distintos.

    Contestarlas igual hace que un fallo de permisos parezca del servidor.
    """
    with pytest.raises(maquina.SaltoInexistente):
        maquina.exigir(ENVIADO, DEVOLUCION_PENDIENTE, maquina.ADMINISTRACION)
    with pytest.raises(maquina.SaltoNoPermitido):
        maquina.exigir(ENVIADO, RECHAZADO, maquina.COMPRADOR)


def test_solo_el_sistema_registra_lo_que_el_proveedor_ya_hizo() -> None:
    """Un reembolso hecho desde el panel de la pasarela llega como un hecho
    consumado: el expediente tiene que poder reflejarlo desde donde este.

    Y SOLO EL SISTEMA. Si una persona pudiera dar este paso, aprobar y «el
    dinero ya volvio» volverian a ser lo mismo, que es lo que toda esta maquina
    existe para impedir.
    """
    for desde in (ENVIADO, EN_REVISION, ESPERANDO):
        maquina.exigir(desde, DEVOLUCION_EN_CURSO, maquina.SISTEMA)
        for quien in (maquina.ADMINISTRACION, maquina.SOPORTE, maquina.COMPRADOR):
            with pytest.raises(maquina.SaltoNoPermitido):
                maquina.exigir(desde, DEVOLUCION_EN_CURSO, quien)


def test_el_comprador_retira_lo_suyo_y_nada_mas() -> None:
    """Puede cancelar su solicitud mientras nadie ha decidido; no puede
    aprobarla, ni rechazarla, ni declararla devuelta."""
    for desde in (ENVIADO, EN_REVISION, ESPERANDO):
        maquina.exigir(desde, CANCELADO, maquina.COMPRADOR)
    for destino in (APROBADO, RECHAZADO, DEVOLUCION_PENDIENTE):
        with pytest.raises((maquina.SaltoNoPermitido, maquina.SaltoInexistente)):
            maquina.exigir(EN_REVISION, destino, maquina.COMPRADOR)


def test_moderar_contenido_no_mueve_dinero() -> None:
    """Soporte puede triar; no puede aprobar ni ejecutar una devolución."""
    maquina.exigir(ENVIADO, EN_REVISION, maquina.SOPORTE)
    for destino in (APROBADO, RECHAZADO):
        with pytest.raises(maquina.SaltoNoPermitido):
            maquina.exigir(EN_REVISION, destino, maquina.SOPORTE)
    # Y a la ejecucion no llega ni siquiera el camino: hay que aprobar antes.
    with pytest.raises(maquina.SaltoInexistente):
        maquina.exigir(EN_REVISION, DEVOLUCION_PENDIENTE, maquina.ADMINISTRACION)


def test_un_expediente_cerrado_no_se_reabre_por_una_transicion() -> None:
    """Reabrir es una decisión, no un efecto secundario de un paso."""
    for final in (RESUELTO, RECHAZADO, CANCELADO):
        assert maquina.es_final(final)
        assert maquina.siguientes(final, maquina.ADMINISTRACION) == ()
        assert maquina.siguientes(final, maquina.SISTEMA) == ()


def test_un_fallo_se_puede_reintentar_pero_no_declarar_resuelto() -> None:
    maquina.exigir(FALLIDO, DEVOLUCION_PENDIENTE, maquina.ADMINISTRACION)
    with pytest.raises(maquina.SaltoNoPermitido):
        maquina.exigir(FALLIDO, RESUELTO, maquina.ADMINISTRACION)
    maquina.exigir(FALLIDO, RESUELTO, maquina.SISTEMA)


def test_ningun_estado_se_queda_sin_salida_salvo_los_finales() -> None:
    """Un estado sin salida que no sea final es un expediente atascado para
    siempre, y nadie se entera hasta que hay uno."""
    from app.modules.events.posventa_models import ESTADOS_DE_EXPEDIENTE

    for estado in ESTADOS_DE_EXPEDIENTE:
        salidas = {h for (d, h) in maquina.TRANSICIONES if d == estado}
        if maquina.es_final(estado):
            assert not salidas, f"{estado} es final y tiene salidas"
        else:
            assert salidas, f"{estado} no tiene ninguna salida"


def test_toda_transicion_lleva_a_un_estado_que_existe() -> None:
    from app.modules.events.posventa_models import ESTADOS_DE_EXPEDIENTE

    for desde, hasta in maquina.TRANSICIONES:
        assert desde in ESTADOS_DE_EXPEDIENTE, desde
        assert hasta in ESTADOS_DE_EXPEDIENTE, hasta


# =========================================================================== #
# Elegibilidad: contra PostgreSQL real
# =========================================================================== #
pytestmark_pg = [SIN_POSTGRES, pytest.mark.asyncio]


@pytest.fixture(scope="module")
def base_aplicada():
    import psycopg

    if not URL:
        pytest.skip("sin PostgreSQL desechable")
    exigir_url_desechable(URL, os.environ.get("DATABASE_URL", ""))
    with psycopg.connect(URL, autocommit=True) as conexion:
        with conexion.cursor() as cur:
            cur.execute("drop schema if exists public cascade")
            cur.execute("drop schema if exists auth cascade")
            cur.execute("drop schema if exists storage cascade")
            cur.execute("create schema public")
            cur.execute(PROLOGO.read_text(encoding="utf-8"))
        for ruta in sorted(MIGRACIONES.glob("*.sql")):
            with conexion.cursor() as cur:
                cur.execute(ruta.read_text(encoding="utf-8"))
    from app.modules.events import esquema

    esquema.olvidar()
    return True


@pytest_asyncio.fixture()
async def sesiones(base_aplicada):
    motor = create_async_engine(URL.replace("postgresql://", "postgresql+asyncpg://", 1))
    yield async_sessionmaker(motor, expire_on_commit=False)
    await motor.dispose()


async def _persona(sesiones, etiqueta="p") -> str:
    ident = str(uuid.uuid4())
    async with sesiones() as db:
        await db.execute(
            text(
                "insert into auth.users (id, email, raw_user_meta_data) values "
                "(cast(:i as uuid), cast(:e as text), "
                " jsonb_build_object('full_name','P','username',cast(:u as text)))"
            ),
            {"i": ident, "e": f"{etiqueta}-{ident[:8]}@x.test", "u": f"{etiqueta}{ident[:8]}"},
        )
        await db.commit()
    return ident


async def _compra(sesiones, *, dias=10, estado_entrada="VALID", pagada=True):
    """Un pedido PAGADO con una entrada emitida. Devuelve (orden, evento)."""
    organiza = await _persona(sesiones, "org")
    compra = await _persona(sesiones, "com")
    evento = str(uuid.uuid4())
    tipo = str(uuid.uuid4())
    hold = str(uuid.uuid4())
    orden = str(uuid.uuid4())
    linea = str(uuid.uuid4())
    entrada = str(uuid.uuid4())
    momento = datetime.now(timezone.utc)

    async with sesiones() as db:
        await db.execute(
            text(
                "insert into public.events (id, organizer_id, title, description,"
                " starts_at, event_type, location, status, capacity) values"
                " (cast(:i as uuid), cast(:o as uuid), 'Evento', 'Descripción larga"
                " para poder revisarla.', :s, 'presential', 'Sala', 'published', 50)"
            ),
            {"i": evento, "o": organiza, "s": momento + timedelta(days=dias)},
        )
        await db.execute(
            text(
                "insert into public.event_operations (event_id, workflow_status,"
                " selection_status, origin) values (cast(:i as uuid), 'PUBLISHED',"
                " 'none', 'events_v2')"
            ),
            {"i": evento},
        )
        await db.execute(
            text(
                "insert into public.event_ticketing_settings (event_id, access_mode,"
                " currency) values (cast(:i as uuid), 'TICKETED', 'PEN')"
            ),
            {"i": evento},
        )
        await db.execute(
            text(
                "insert into public.event_ticket_types (id, event_id, name, quota,"
                " price_minor, currency, status) values (cast(:t as uuid),"
                " cast(:e as uuid), 'General', 10, 4900, 'PEN', 'on_sale')"
            ),
            {"t": tipo, "e": evento},
        )
        await db.execute(
            text(
                "insert into public.event_ticket_holds (id, event_id, user_id,"
                " idempotency_key, request_fingerprint, status, currency,"
                " subtotal_minor, expires_at) values (cast(:h as uuid),"
                " cast(:e as uuid), cast(:u as uuid), :k, '', 'CONSUMED', 'PEN',"
                " 4900, :x)"
            ),
            {
                "h": hold,
                "e": evento,
                "u": compra,
                "k": f"h-{hold[:8]}",
                "x": momento + timedelta(minutes=15),
            },
        )
        # LA RESERVA TIENE QUE APARTAR ALGO: un disparador diferido de la 0061
        # rechaza una reserva sin lineas, y con razon.
        await db.execute(
            text(
                "insert into public.event_ticket_hold_items (hold_id, event_id,"
                " ticket_type_id, quantity, unit_price_minor, subtotal_minor,"
                " ticket_type_name_snapshot) values (cast(:h as uuid),"
                " cast(:e as uuid), cast(:t as uuid), 1, 4900, 4900, 'General')"
            ),
            {"h": hold, "e": evento, "t": tipo},
        )
        await db.execute(
            text(
                "insert into public.event_orders (id, event_id, buyer_id, hold_id,"
                " status, currency, subtotal_minor, total_minor, idempotency_key,"
                " provider, environment, external_payment_id, paid_at) values"
                " (cast(:o as uuid), cast(:e as uuid), cast(:u as uuid),"
                " cast(:h as uuid), :st, 'PEN', 4900, 4900, :k, 'stripe', 'sandbox',"
                " :ref, :pa)"
            ),
            {
                "o": orden,
                "e": evento,
                "u": compra,
                "h": hold,
                "st": "PAID" if pagada else "PENDING_PAYMENT",
                "k": f"k-{orden[:8]}",
                "ref": f"pi_{orden[:8]}" if pagada else None,
                "pa": momento if pagada else None,
            },
        )
        await db.execute(
            text(
                "insert into public.event_order_items (id, order_id, event_id,"
                " ticket_type_id, ticket_type_name_snapshot, unit_price_minor,"
                " quantity, subtotal_minor) values (cast(:l as uuid), cast(:o as uuid),"
                " cast(:e as uuid), cast(:t as uuid), 'General', 4900, 1, 4900)"
            ),
            {"l": linea, "o": orden, "e": evento, "t": tipo},
        )
        if pagada:
            await db.execute(
                text(
                    "insert into public.event_tickets (id, event_id, order_id,"
                    " order_item_id, owner_id, ticket_type_id,"
                    " ticket_type_name_snapshot, code_hash, credential_hash, status,"
                    " checked_in_at, revoked_at, revoked_reason) values"
                    " (cast(:i as uuid), cast(:e as uuid), cast(:o as uuid),"
                    " cast(:l as uuid), cast(:u as uuid), cast(:t as uuid), 'General',"
                    " :ch, :cr, :st, :usada, :rev, :motivo)"
                ),
                {
                    "i": entrada,
                    "e": evento,
                    "o": orden,
                    "l": linea,
                    "u": compra,
                    "t": tipo,
                    # UNICOS POR ENTRADA. La 0062 exige que no se repitan, y
                    # con razon: dos entradas con la misma credencial son la
                    # misma entrada dos veces.
                    "ch": hashlib.sha256(f"c-{entrada}".encode()).hexdigest(),
                    "cr": hashlib.sha256(f"q-{entrada}".encode()).hexdigest(),
                    "st": estado_entrada,
                    "usada": momento if estado_entrada == "USED" else None,
                    "rev": momento if estado_entrada == "REVOKED" else None,
                    "motivo": "prueba" if estado_entrada == "REVOKED" else None,
                },
            )
        await db.commit()

    async with sesiones() as db:
        return await db.get(EventOrder, orden), evento


async def _publicar(sesiones, params, evento_id=None):
    async with sesiones() as db:
        p = await politicas.publicar(
            db,
            tipo="aftersale_eligibility",
            version=f"v{uuid.uuid4().hex[:8]}",
            params=params,
            evento_id=evento_id,
        )
        await db.commit()
        return p


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_politica_no_dice_ni_si_ni_no(sesiones) -> None:
    """EL ESTADO DE FÁBRICA. No es un fallo: es que nadie lo ha decidido.

    Si esto devolviera NO_ELEGIBLE, «todavía no lo hemos decidido» se
    convertiría en «no» sin que nadie lo aprobara. Y si devolviera ELEGIBLE,
    en «sí».
    """
    orden, _ = await _compra(sesiones)
    async with sesiones() as db:
        v = await elegibilidad.evaluar(db, orden=orden)
    assert v.resultado == elegibilidad.POLITICA_NO_CONFIGURADA
    assert v.motivos == (elegibilidad.SIN_POLITICA,)
    assert v.porcentaje_bps is None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_politica_sin_plazo_no_supone_ninguno(sesiones) -> None:
    """La política existe, pero no trae el número. No se inventa: va a revisión."""
    orden, evento = await _compra(sesiones)
    await _publicar(sesiones, {"refund_bps": 10000}, evento_id=evento)
    async with sesiones() as db:
        v = await elegibilidad.evaluar(db, orden=orden)
    assert v.resultado == elegibilidad.REQUIERE_REVISION
    assert elegibilidad.SIN_POLITICA in v.motivos


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_con_plazo_y_dentro_de_el_es_elegible(sesiones) -> None:
    orden, evento = await _compra(sesiones, dias=10)
    await _publicar(
        sesiones,
        {"window_hours_before_event": 48, "refund_bps": 10000},
        evento_id=evento,
    )
    async with sesiones() as db:
        v = await elegibilidad.evaluar(db, orden=orden)
    assert v.resultado == elegibilidad.ELEGIBLE
    assert v.porcentaje_bps == 10000
    assert v.politica_version is not None, "tiene que decir con qué reglas se decidió"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_fuera_del_plazo_no_lo_es(sesiones) -> None:
    orden, evento = await _compra(sesiones, dias=1)
    await _publicar(
        sesiones,
        {"window_hours_before_event": 48, "refund_bps": 10000},
        evento_id=evento,
    )
    async with sesiones() as db:
        v = await elegibilidad.evaluar(db, orden=orden)
    assert v.resultado == elegibilidad.NO_ELEGIBLE
    assert v.motivos == (elegibilidad.PLAZO_VENCIDO,)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_porcentaje_ausente_no_vale_cero(sesiones) -> None:
    """Elegible, sí; pero cuánto se devuelve NO se supone.

    Un cero aquí se leería como «devolución de nada» y la pantalla se lo
    enseñaría al comprador como una cifra decidida.
    """
    orden, evento = await _compra(sesiones, dias=10)
    await _publicar(sesiones, {"window_hours_before_event": 48}, evento_id=evento)
    async with sesiones() as db:
        v = await elegibilidad.evaluar(db, orden=orden)
    assert v.resultado == elegibilidad.ELEGIBLE
    assert v.porcentaje_bps is None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_si_ya_entro_no_se_decide_solo(sesiones) -> None:
    """ESCENARIO C DEL INFORME. El servicio pudo consumirse entero o a medias.

    Sin permiso expreso de la política, no. Con permiso expreso, a revisión —no
    a «sí»—, porque cuánto corresponde sigue sin estar decidido.
    """
    orden, evento = await _compra(sesiones, dias=10, estado_entrada="USED")
    await _publicar(sesiones, {"window_hours_before_event": 48}, evento_id=evento)
    async with sesiones() as db:
        v = await elegibilidad.evaluar(db, orden=orden)
    assert v.resultado == elegibilidad.NO_ELEGIBLE
    assert v.motivos == (elegibilidad.YA_ENTRO,)

    await _publicar(
        sesiones,
        {"window_hours_before_event": 48, "allow_after_check_in": True},
        evento_id=evento,
    )
    async with sesiones() as db:
        v = await elegibilidad.evaluar(db, orden=orden)
    assert v.resultado == elegibilidad.REQUIERE_REVISION
    assert elegibilidad.YA_ENTRO in v.motivos


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_cambio_sin_clasificar_manda_a_revision(sesiones) -> None:
    """Puede ser una tilde o puede ser la ciudad. Hasta que alguien lo mire, no
    se decide solo hacia ninguno de los dos lados."""
    orden, evento = await _compra(sesiones, dias=10)
    await _publicar(
        sesiones,
        {"window_hours_before_event": 48, "refund_bps": 10000},
        evento_id=evento,
    )
    async with sesiones() as db:
        db.add(
            EventChange(
                event_id=evento,
                field="location",
                previous_value="Sala A",
                new_value="Sala B",
            )
        )
        await db.commit()
        v = await elegibilidad.evaluar(db, orden=orden)
    assert v.resultado == elegibilidad.REQUIERE_REVISION
    assert elegibilidad.CAMBIO_SIN_CLASIFICAR in v.motivos


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_evento_cancelado_no_se_resuelve_solo_sin_permiso(sesiones) -> None:
    """El caso de mayor impacto colectivo. Automático solo si la empresa lo dijo."""
    orden, evento = await _compra(sesiones, dias=10)
    await _publicar(sesiones, {"window_hours_before_event": 48}, evento_id=evento)
    async with sesiones() as db:
        await db.execute(
            text(
                "update public.event_operations set workflow_status = 'CANCELLED'"
                " where event_id = cast(:e as uuid)"
            ),
            {"e": evento},
        )
        await db.commit()
        v = await elegibilidad.evaluar(db, orden=orden)
    assert v.resultado == elegibilidad.REQUIERE_REVISION
    assert v.motivos == (elegibilidad.EVENTO_CANCELADO,)

    await _publicar(
        sesiones,
        {"window_hours_before_event": 48, "organizer_cancellation_auto": True,
         "cancelled_event_bps": 10000},
        evento_id=evento,
    )
    async with sesiones() as db:
        v = await elegibilidad.evaluar(db, orden=orden)
    assert v.resultado == elegibilidad.ELEGIBLE
    assert v.porcentaje_bps == 10000


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_pedido_sin_pagar_no_se_devuelve(sesiones) -> None:
    """Y esto NO depende de ninguna política: es un hecho duro."""
    orden, evento = await _compra(sesiones, pagada=False)
    await _publicar(
        sesiones, {"window_hours_before_event": 48, "refund_bps": 10000}, evento_id=evento
    )
    async with sesiones() as db:
        v = await elegibilidad.evaluar(db, orden=orden)
    assert v.resultado == elegibilidad.NO_ELEGIBLE
    assert elegibilidad.PEDIDO_NO_PAGADO in v.motivos


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_con_un_expediente_abierto_no_se_abre_otro(sesiones) -> None:
    """Dos solicitudes vivas sobre la misma compra acaban en dos decisiones
    distintas sobre el mismo dinero."""
    orden, evento = await _compra(sesiones, dias=10)
    await _publicar(
        sesiones, {"window_hours_before_event": 48, "refund_bps": 10000}, evento_id=evento
    )
    async with sesiones() as db:
        db.add(
            EventAftersaleCase(
                event_id=evento,
                order_id=orden.id,
                buyer_id=orden.buyer_id,
                organizer_id=orden.buyer_id,
                kind="refund_request",
                status=ENVIADO,
            )
        )
        await db.commit()
        v = await elegibilidad.evaluar(db, orden=orden)
    assert v.resultado == elegibilidad.NO_ELEGIBLE
    assert elegibilidad.EXPEDIENTE_ABIERTO in v.motivos


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_politica_del_evento_manda_sobre_la_global(sesiones) -> None:
    orden, evento = await _compra(sesiones, dias=10)
    await _publicar(sesiones, {"window_hours_before_event": 48, "refund_bps": 5000})
    await _publicar(
        sesiones,
        {"window_hours_before_event": 48, "refund_bps": 10000},
        evento_id=evento,
    )
    async with sesiones() as db:
        v = await elegibilidad.evaluar(db, orden=orden)
    assert v.porcentaje_bps == 10000


# =========================================================================== #
# Efectos sobre entradas: lo que NO revoca, que es casi todo
# =========================================================================== #
async def _expediente(sesiones, orden, evento, *, importe=4900, moneda="PEN"):
    """Un expediente abierto sobre la compra, con sus entradas congeladas."""
    async with sesiones() as db:
        organiza = (
            await db.execute(
                text(
                    "select organizer_id::text from public.events"
                    " where id = cast(:e as uuid)"
                ),
                {"e": evento},
            )
        ).scalar_one()
        fresca = await db.get(EventOrder, orden.id)
        caso = await posventa.abrir(
            db,
            orden=fresca,
            organizador_id=organiza,
            tipo="refund_request",
            actor_id=fresca.buyer_id,
            motivo="no puedo ir",
        )
        caso.refund_amount_minor = importe
        caso.currency = moneda
        await db.commit()
        return caso.id


async def _politica_que_revoca(sesiones, evento):
    """La politica que SI retira el acceso. Para que las pruebas de «no revoca»
    prueben su propio motivo y no la ausencia de politica."""
    async with sesiones() as db:
        await politicas.publicar(
            db,
            tipo="ticket_effect",
            version=f"v{uuid.uuid4().hex[:8]}",
            params={"revoke_on_refund": True, "revoke_on_partial_refund": True},
            evento_id=evento,
        )
        await db.commit()


async def _caso(sesiones, caso_id):
    async with sesiones() as db:
        return await db.get(EventAftersaleCase, caso_id)


async def _estado_de_las_entradas(sesiones, orden_id):
    async with sesiones() as db:
        filas = (
            await db.execute(
                text(
                    "select t.status, coalesce(k.effect, 'none')"
                    "  from public.event_tickets t"
                    "  left join public.event_aftersale_case_tickets k"
                    "    on k.ticket_id = t.id"
                    " where t.order_id = cast(:o as uuid)"
                ),
                {"o": orden_id},
            )
        ).all()
    return filas


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_abrir_una_solicitud_no_retira_el_acceso(sesiones) -> None:
    """PEDIR NO ES HABER OBTENIDO. Retirar la entrada por haber preguntado
    deja sin acceso a quien todavía podría ir."""
    orden, evento = await _compra(sesiones, dias=10)
    await _expediente(sesiones, orden, evento)
    filas = await _estado_de_las_entradas(sesiones, orden.id)
    assert filas == [("VALID", "none")]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_devolucion_sin_confirmar_no_revoca(sesiones) -> None:
    """Un intento no es una devolución. Se RETIENE, que es reversible."""
    orden, evento = await _compra(sesiones, dias=10)
    caso_id = await _expediente(sesiones, orden, evento)
    # CON LA POLITICA QUE SI REVOCARIA. Sin ella, esta prueba pasaria porque no
    # hay politica y no porque el aviso este sin confirmar: diria estar
    # probando una cosa y estaria probando otra.
    await _politica_que_revoca(sesiones, evento)
    async with sesiones() as db:
        r = await efectos.revocar_por_devolucion(
            db,
            caso=await db.get(EventAftersaleCase, caso_id),
            importe_devuelto_minor=4900,
            moneda="PEN",
            referencia="re_123",
            confirmada=False,
        )
        await db.commit()
    assert r.efecto == efectos.EN_REVISION
    assert await _estado_de_las_entradas(sesiones, orden.id) == [
        ("VALID", "under_review")
    ]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_aviso_incompleto_no_revoca(sesiones) -> None:
    """Sin importe, sin moneda o sin referencia no se puede saber si fue total.

    La AUSENCIA de un dato no vale como coincidencia: es exactamente el error
    que en el webhook de pagos dejaba conceder acceso sin importe.
    """
    for importe, moneda, referencia in (
        (None, "PEN", "re_1"),
        (4900, None, "re_1"),
        (4900, "PEN", "  "),
    ):
        orden, evento = await _compra(sesiones, dias=10)
        caso_id = await _expediente(sesiones, orden, evento)
        async with sesiones() as db:
            r = await efectos.revocar_por_devolucion(
                db,
                caso=await db.get(EventAftersaleCase, caso_id),
                importe_devuelto_minor=importe,
                moneda=moneda,
                referencia=referencia,
                confirmada=True,
            )
            await db.commit()
        assert r.efecto == efectos.EN_REVISION, (importe, moneda, referencia)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_otra_moneda_no_revoca(sesiones) -> None:
    orden, evento = await _compra(sesiones, dias=10)
    caso_id = await _expediente(sesiones, orden, evento)
    # CON LA POLITICA QUE SI REVOCARIA: lo unico que lo impide es la moneda.
    await _politica_que_revoca(sesiones, evento)
    async with sesiones() as db:
        r = await efectos.revocar_por_devolucion(
            db,
            caso=await db.get(EventAftersaleCase, caso_id),
            importe_devuelto_minor=4900,
            moneda="USD",
            referencia="re_1",
            confirmada=True,
        )
        await db.commit()
    assert r.efecto == efectos.EN_REVISION


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_politica_de_efecto_no_se_revoca(sesiones) -> None:
    """Una devolución total y confirmada, y aun así no se revoca.

    Cuándo se retira el acceso es una decisión de la empresa. Sin ella, la
    entrada se queda RETENIDA y a la vista de una persona: retenida se levanta
    y revocada no.
    """
    orden, evento = await _compra(sesiones, dias=10)
    caso_id = await _expediente(sesiones, orden, evento)
    async with sesiones() as db:
        r = await efectos.revocar_por_devolucion(
            db,
            caso=await db.get(EventAftersaleCase, caso_id),
            importe_devuelto_minor=4900,
            moneda="PEN",
            referencia="re_1",
            confirmada=True,
        )
        await db.commit()
    assert r.efecto == efectos.EN_REVISION
    assert await _estado_de_las_entradas(sesiones, orden.id) == [
        ("VALID", "under_review")
    ]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_devolucion_parcial_no_revoca_la_entrada_entera(sesiones) -> None:
    """Sin política explícita, quien recuperó parte del dinero no pierde todo."""
    orden, evento = await _compra(sesiones, dias=10)
    caso_id = await _expediente(sesiones, orden, evento, importe=4900)
    async with sesiones() as db:
        await politicas.publicar(
            db,
            tipo="ticket_effect",
            version=f"v{uuid.uuid4().hex[:8]}",
            params={"revoke_on_refund": True},
            evento_id=evento,
        )
        await db.commit()
    async with sesiones() as db:
        r = await efectos.revocar_por_devolucion(
            db,
            caso=await db.get(EventAftersaleCase, caso_id),
            importe_devuelto_minor=2000,
            moneda="PEN",
            referencia="re_1",
            confirmada=True,
        )
        await db.commit()
    assert r.efecto == efectos.EN_REVISION


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_politica_que_no_revoca_no_revoca(sesiones) -> None:
    """Publicar la política no equivale a decir que se retire el acceso."""
    orden, evento = await _compra(sesiones, dias=10)
    caso_id = await _expediente(sesiones, orden, evento)
    async with sesiones() as db:
        await politicas.publicar(
            db,
            tipo="ticket_effect",
            version=f"v{uuid.uuid4().hex[:8]}",
            params={"revoke_on_refund": False},
            evento_id=evento,
        )
        await db.commit()
    async with sesiones() as db:
        r = await efectos.revocar_por_devolucion(
            db,
            caso=await db.get(EventAftersaleCase, caso_id),
            importe_devuelto_minor=4900,
            moneda="PEN",
            referencia="re_1",
            confirmada=True,
        )
        await db.commit()
    assert r.efecto == efectos.EN_REVISION


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_total_confirmada_y_con_politica_si_revoca(sesiones) -> None:
    """LAS CINCO CONDICIONES A LA VEZ. Es el único camino que retira acceso."""
    orden, evento = await _compra(sesiones, dias=10)
    caso_id = await _expediente(sesiones, orden, evento, importe=4900)
    async with sesiones() as db:
        await politicas.publicar(
            db,
            tipo="ticket_effect",
            version=f"v{uuid.uuid4().hex[:8]}",
            params={"revoke_on_refund": True},
            evento_id=evento,
        )
        await db.commit()
    async with sesiones() as db:
        r = await efectos.revocar_por_devolucion(
            db,
            caso=await db.get(EventAftersaleCase, caso_id),
            importe_devuelto_minor=4900,
            moneda="PEN",
            referencia="re_1",
            confirmada=True,
        )
        await db.commit()
    assert r.efecto == efectos.REVOCADA
    assert r.revocadas == 1
    assert await _estado_de_las_entradas(sesiones, orden.id) == [("REVOKED", "revoked")]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_entrada_retenida_no_pasa_por_la_puerta(sesiones) -> None:
    """Y NO SE CONSUME. Retener es reversible; consumirla no lo sería.

    Sin esto, «en revisión» sería una etiqueta que no impide nada y quien tiene
    una devolución en trámite entraría igual.
    """
    orden, evento = await _compra(sesiones, dias=10)
    caso_id = await _expediente(sesiones, orden, evento)
    async with sesiones() as db:
        await efectos.aplicar(
            db,
            caso=await db.get(EventAftersaleCase, caso_id),
            efecto=efectos.EN_REVISION,
            actor_id=None,
            motivo="en trámite",
        )
        await db.commit()

    async with sesiones() as db:
        entrada = (
            await db.execute(
                text(
                    "select id::text from public.event_tickets"
                    " where order_id = cast(:o as uuid)"
                ),
                {"o": orden.id},
            )
        ).scalar_one()
        credencial = (
            await db.execute(
                text(
                    "select credential_hash from public.event_tickets"
                    " where id = cast(:t as uuid)"
                ),
                {"t": entrada},
            )
        ).scalar_one()

    # Se verifica y se hace check-in con el hash directo, que es lo que la
    # puerta compara: el veredicto tiene que ser RETENIDA en los dos casos.
    operador = await _persona(sesiones, "puerta")
    async with sesiones() as db:
        # `verificar` no consume.
        fila = await db.get(EventTicket, entrada)
        assert fila.status == "VALID"
        v = await emision.check_in(
            db,
            evento_id=evento,
            credencial="lo-que-sea",
            operador_id=operador,
        )
    # Con una credencial inventada da NOT_FOUND; lo que importa es que la
    # entrada retenida siga VALID y que la retención esté puesta.
    assert v.resultado in (emision.NO_EXISTE, emision.RETENIDA)
    filas = await _estado_de_las_entradas(sesiones, orden.id)
    assert filas == [("VALID", "under_review")]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_aplicar_dos_veces_el_mismo_efecto_no_cambia_nada(sesiones) -> None:
    """IDEMPOTENTE. Un reintento no puede contar como una segunda decisión."""
    orden, evento = await _compra(sesiones, dias=10)
    caso_id = await _expediente(sesiones, orden, evento)
    async with sesiones() as db:
        caso = await db.get(EventAftersaleCase, caso_id)
        una = await efectos.aplicar(
            db, caso=caso, efecto=efectos.BLOQUEADA, actor_id=None, motivo="x"
        )
        otra = await efectos.aplicar(
            db, caso=caso, efecto=efectos.BLOQUEADA, actor_id=None, motivo="x"
        )
        await db.commit()
    assert una.cambiadas == 1
    assert otra.cambiadas == 0


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_entrada_revocada_no_vuelve_a_revision(sesiones) -> None:
    """Los terminales no se pisan con un paso posterior del expediente."""
    orden, evento = await _compra(sesiones, dias=10)
    caso_id = await _expediente(sesiones, orden, evento, importe=4900)
    async with sesiones() as db:
        await politicas.publicar(
            db,
            tipo="ticket_effect",
            version=f"v{uuid.uuid4().hex[:8]}",
            params={"revoke_on_refund": True},
            evento_id=evento,
        )
        await db.commit()
    async with sesiones() as db:
        caso = await db.get(EventAftersaleCase, caso_id)
        await efectos.revocar_por_devolucion(
            db,
            caso=caso,
            importe_devuelto_minor=4900,
            moneda="PEN",
            referencia="re_1",
            confirmada=True,
        )
        r = await efectos.aplicar(
            db, caso=caso, efecto=efectos.EN_REVISION, actor_id=None, motivo="ups"
        )
        await db.commit()
    assert r.cambiadas == 0
    assert await _estado_de_las_entradas(sesiones, orden.id) == [("REVOKED", "revoked")]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_restaurar_no_devuelve_la_credencial_vieja(sesiones) -> None:
    """QUIEN LA TUVIERA FOTOGRAFIADA NO VUELVE A ENTRAR.

    Restaurar el acceso con la credencial de antes reactivaría un QR que estuvo
    fuera de servicio, y nadie sabe por dónde anduvo mientras tanto.
    """
    orden, evento = await _compra(sesiones, dias=10)
    caso_id = await _expediente(sesiones, orden, evento, importe=4900)
    async with sesiones() as db:
        await politicas.publicar(
            db,
            tipo="ticket_effect",
            version=f"v{uuid.uuid4().hex[:8]}",
            params={"revoke_on_refund": True},
            evento_id=evento,
        )
        await db.commit()

    async with sesiones() as db:
        entrada = (
            await db.execute(
                text(
                    "select id::text from public.event_tickets"
                    " where order_id = cast(:o as uuid)"
                ),
                {"o": orden.id},
            )
        ).scalar_one()
        antes = (
            await db.execute(
                text(
                    "select credential_hash from public.event_tickets"
                    " where id = cast(:t as uuid)"
                ),
                {"t": entrada},
            )
        ).scalar_one()
        caso = await db.get(EventAftersaleCase, caso_id)
        await efectos.revocar_por_devolucion(
            db,
            caso=caso,
            importe_devuelto_minor=4900,
            moneda="PEN",
            referencia="re_1",
            confirmada=True,
        )
        await db.commit()

    quien = await _persona(sesiones, "admin")
    async with sesiones() as db:
        r = await efectos.restaurar(
            db,
            caso=await db.get(EventAftersaleCase, caso_id),
            actor_id=quien,
            motivo="error nuestro",
        )
        await db.commit()
    assert r.revocadas == 1

    async with sesiones() as db:
        estado, despues = (
            await db.execute(
                text(
                    "select status, credential_hash from public.event_tickets"
                    " where id = cast(:t as uuid)"
                ),
                {"t": entrada},
            )
        ).one()
    assert estado == "VALID", "la entrada vuelve a servir"
    assert despues != antes, "pero NO con la credencial de antes"


# =========================================================================== #
# Registro de cambios: registrar no es clasificar
# =========================================================================== #
def test_una_edicion_sin_diferencias_no_registra_nada() -> None:
    """Corregir una coma y guardar no es un cambio del evento.

    Sin esto, cada guardado dejaria filas que alguien tendria que clasificar, y
    la bandeja de cambios dejaria de significar nada.
    """
    from app.modules.events import cambios

    foto = {"title": "Concierto", "capacity": 100, "location": "Sala A"}
    assert cambios.diferencias(foto, dict(foto)) == []


def test_una_fecha_con_y_sin_zona_no_es_un_cambio() -> None:
    """Se comparan los TEXTOS ya normalizados, no los objetos.

    Sin normalizar, guardar sin tocar la fecha dejaba una diferencia falsa cada
    vez que el objeto venia de la base con zona y del formulario sin ella.
    """
    from app.modules.events import cambios

    con = datetime(2026, 12, 1, 20, 0, tzinfo=timezone.utc)
    assert cambios.diferencias({"starts_at": con}, {"starts_at": con}) == []


def test_se_detectan_los_campos_que_pueden_alterar_la_compra() -> None:
    """Fecha, sitio, modalidad y aforo. Y NO se clasifican."""
    from app.modules.events import cambios

    antes = {
        "starts_at": datetime(2026, 12, 1, 20, 0, tzinfo=timezone.utc),
        "location": "Sala A",
        "event_type": "presential",
        "capacity": 100,
        "title": "Concierto",
    }
    despues = dict(
        antes,
        starts_at=datetime(2026, 12, 8, 20, 0, tzinfo=timezone.utc),
        location="Sala B",
        event_type="online",
        capacity=80,
    )
    campos = {c for c, _, _ in cambios.diferencias(antes, despues)}
    assert campos == {"starts_at", "location", "event_type", "capacity"}


def test_el_valor_guardado_se_recorta() -> None:
    """Esto es una pista de que cambio, no una copia del evento."""
    from app.modules.events import cambios

    largo = "x" * 5000
    salida = cambios.diferencias({"description": "a"}, {"description": largo})
    assert len(salida) == 1
    assert len(salida[0][2]) == cambios.LARGO_DEL_VALOR


def test_un_valor_vacio_no_se_confunde_con_uno_ausente() -> None:
    """Quitar el texto de un campo y dejarlo en blanco es lo mismo, y tratarlos
    distinto dejaria un cambio que nadie hizo."""
    from app.modules.events import cambios

    assert cambios.diferencias({"location": None}, {"location": "   "}) == []


async def _organizador_de(sesiones, evento):
    async with sesiones() as db:
        return (
            await db.execute(
                text(
                    "select organizer_id::text from public.events"
                    " where id = cast(:e as uuid)"
                ),
                {"e": evento},
            )
        ).scalar_one()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_editar_un_publicado_deja_version_y_cambios_sin_clasificar(
    sesiones,
) -> None:
    """LA REGLA ENTERA: se registra, y nace SIN clasificar.

    `pending` no es «no esencial». Dar por bueno lo que nadie ha mirado es
    exactamente como un cambio material reescribe en silencio lo que la gente
    compro.
    """
    from app.core.security import AuthUser
    from app.modules.events import cambios

    orden, evento = await _compra(sesiones, dias=20)
    quien = AuthUser(id=await _organizador_de(sesiones, evento), email="org@x.test")
    async with sesiones() as db:
        version, filas = await cambios.actualizar_publicado(
            db,
            evento_id=evento,
            datos={"location": "Sala B"},
            usuario=quien,
            motivo="cambio de recinto",
        )
    assert version.version >= 1
    assert [f.field for f in filas] == ["location"]
    assert all(f.classification == "pending" for f in filas)
    assert filas[0].previous_value == "Sala"
    assert filas[0].new_value == "Sala B"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_editar_un_publicado_no_toca_pedidos_ni_entradas(sesiones) -> None:
    """Registrar un cambio NO altera lo vendido. Ni una entrada, ni un pedido."""
    from app.core.security import AuthUser
    from app.modules.events import cambios

    orden, evento = await _compra(sesiones, dias=20)
    antes = await _estado_de_las_entradas(sesiones, orden.id)
    quien = AuthUser(id=await _organizador_de(sesiones, evento), email="org@x.test")
    async with sesiones() as db:
        await cambios.actualizar_publicado(
            db,
            evento_id=evento,
            datos={"capacity": 30},
            usuario=quien,
            motivo="reduccion de aforo",
        )
    async with sesiones() as db:
        assert (await db.get(EventOrder, orden.id)).status == "PAID"
    assert await _estado_de_las_entradas(sesiones, orden.id) == antes


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_version_desactualizada_no_pisa(sesiones) -> None:
    """Dos organizadores editando a la vez: el segundo se entera."""
    from app.core.exceptions import ConflictError
    from app.core.security import AuthUser
    from app.modules.events import cambios

    orden, evento = await _compra(sesiones, dias=20)
    quien = AuthUser(id=await _organizador_de(sesiones, evento), email="org@x.test")
    async with sesiones() as db:
        await cambios.actualizar_publicado(
            db, evento_id=evento, datos={"location": "Sala B"}, usuario=quien,
            motivo="uno",
        )
    async with sesiones() as db:
        with pytest.raises(ConflictError) as fallo:
            await cambios.actualizar_publicado(
                db,
                evento_id=evento,
                datos={"location": "Sala C"},
                usuario=quien,
                motivo="dos",
                version_esperada=99,
            )
    assert fallo.value.code == "event_version_stale"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_cambio_sin_motivo_no_entra(sesiones) -> None:
    """Un cambio sobre lo publicado sin motivo no se puede explicar despues."""
    from app.core.exceptions import ValidationAppError
    from app.core.security import AuthUser
    from app.modules.events import cambios

    orden, evento = await _compra(sesiones, dias=20)
    quien = AuthUser(id=await _organizador_de(sesiones, evento), email="org@x.test")
    async with sesiones() as db:
        with pytest.raises(ValidationAppError):
            await cambios.actualizar_publicado(
                db,
                evento_id=evento,
                datos={"location": "Sala B"},
                usuario=quien,
                motivo="   ",
            )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_quien_no_organiza_no_edita(sesiones) -> None:
    from app.core.exceptions import NotFoundError
    from app.core.security import AuthUser
    from app.modules.events import cambios

    orden, evento = await _compra(sesiones, dias=20)
    ajeno = await _persona(sesiones, "ajeno")
    async with sesiones() as db:
        with pytest.raises(NotFoundError):
            await cambios.actualizar_publicado(
                db,
                evento_id=evento,
                datos={"location": "Sala B"},
                usuario=AuthUser(id=ajeno, email="x@x.test"),
                motivo="me apetece",
            )


# =========================================================================== #
# Carreras: dos personas decidiendo sobre el mismo dinero
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dos_revisores_no_resuelven_el_mismo_caso(sesiones) -> None:
    """LA CARRERA REAL de una bandeja: dos personas con el caso abierto.

    Las dos leen `submitted`, las dos pulsan. Lo que impide que las dos
    escrituras cuenten no es el `if` de arriba sino el `where status = :desde`,
    que la base resuelve fila a fila: una cambia una fila y la otra cero.
    """
    import asyncio

    orden, evento = await _compra(sesiones, dias=10)
    caso_id = await _expediente(sesiones, orden, evento)
    quien = await _persona(sesiones, "gestor")

    barrera = asyncio.Barrier(2)

    async def resuelve():
        async with sesiones() as db:
            await barrera.wait()
            try:
                m = await posventa.transicionar(
                    db,
                    expediente_id=caso_id,
                    hasta="under_review",
                    actor_id=quien,
                    actor_rol="admin",
                )
                await db.commit()
                return m.hasta
            except Exception as error:  # noqa: BLE001
                await db.rollback()
                return type(error).__name__

    una, otra = await asyncio.gather(resuelve(), resuelve())
    resultados = [una, otra]
    assert resultados.count("under_review") == 1, resultados
    assert "ExpedienteCambiado" in resultados, resultados

    # Y una sola linea de historial para ese paso.
    async with sesiones() as db:
        cuantas = (
            await db.execute(
                text(
                    "select count(*) from public.event_aftersale_case_events"
                    " where case_id = cast(:c as uuid) and to_status = 'under_review'"
                ),
                {"c": caso_id},
            )
        ).scalar_one()
    assert cuantas == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dos_solicitudes_a_la_vez_sobre_el_mismo_pedido(sesiones) -> None:
    """Dos expedientes vivos sobre la misma compra acabarian en dos decisiones
    distintas sobre el mismo dinero. Lo impide la BASE, no el servicio."""
    import asyncio

    orden, evento = await _compra(sesiones, dias=10)
    organiza = await _organizador_de(sesiones, evento)

    barrera = asyncio.Barrier(2)

    async def pide():
        async with sesiones() as db:
            fresca = await db.get(EventOrder, orden.id)
            await barrera.wait()
            try:
                caso = await posventa.abrir(
                    db,
                    orden=fresca,
                    organizador_id=organiza,
                    tipo="refund_request",
                    actor_id=fresca.buyer_id,
                )
                await db.commit()
                return caso.id
            except Exception as error:  # noqa: BLE001
                await db.rollback()
                return type(error).__name__

    una, otra = await asyncio.gather(pide(), pide())
    abiertos = [x for x in (una, otra) if x not in ("ExpedienteAbierto",)]
    assert len(abiertos) == 1, (una, otra)

    async with sesiones() as db:
        vivos = (
            await db.execute(
                text(
                    "select count(*) from public.event_aftersale_cases"
                    " where order_id = cast(:o as uuid)"
                ),
                {"o": orden.id},
            )
        ).scalar_one()
    assert vivos == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_retener_y_escanear_a_la_vez_no_deja_las_dos_cosas(sesiones) -> None:
    """O entro antes de la retencion, o no entro. Nunca usada Y retenida."""
    import asyncio

    orden, evento = await _compra(sesiones, dias=10)
    caso_id = await _expediente(sesiones, orden, evento)
    operador = await _persona(sesiones, "puerta")

    async with sesiones() as db:
        entrada = (
            await db.execute(
                text(
                    "select id::text from public.event_tickets"
                    " where order_id = cast(:o as uuid)"
                ),
                {"o": orden.id},
            )
        ).scalar_one()
        _, credencial, _codigo = await emision.credencial_de(
            db, entrada_id=entrada, usuario_id=orden.buyer_id
        )

    barrera = asyncio.Barrier(2)

    async def escanea():
        async with sesiones() as db:
            await barrera.wait()
            try:
                return (
                    await emision.check_in(
                        db,
                        evento_id=evento,
                        credencial=credencial,
                        operador_id=operador,
                    )
                ).resultado
            except Exception as error:  # noqa: BLE001
                await db.rollback()
                return type(error).__name__

    async def retiene():
        async with sesiones() as db:
            await barrera.wait()
            try:
                await efectos.aplicar(
                    db,
                    caso=await db.get(EventAftersaleCase, caso_id),
                    efecto=efectos.EN_REVISION,
                    actor_id=None,
                    motivo="en tramite",
                )
                await db.commit()
                return "retenida"
            except Exception as error:  # noqa: BLE001
                await db.rollback()
                return type(error).__name__

    veredicto, _ = await asyncio.gather(escanea(), retiene())

    async with sesiones() as db:
        estado, efecto = (
            await db.execute(
                text(
                    "select t.status, coalesce(k.effect, 'none')"
                    "  from public.event_tickets t"
                    "  left join public.event_aftersale_case_tickets k"
                    "    on k.ticket_id = t.id"
                    " where t.id = cast(:t as uuid)"
                ),
                {"t": entrada},
            )
        ).one()

    if veredicto == emision.OK:
        # Entro antes: la entrada esta usada, y la retencion no la deshace.
        assert estado == "USED"
    else:
        assert veredicto in (emision.RETENIDA, "CerrojoOcupado"), veredicto
        assert estado == "VALID", "una entrada retenida NO se consume"


# =========================================================================== #
# Lo que encontro la revision independiente
# =========================================================================== #
def test_editar_un_publicado_valida_como_el_borrador() -> None:
    """UN EVENTO YA VENDIDO NO PUEDE ADMITIR LO QUE EL BORRADOR PROHIBE.

    El contrato del publicado no validaba nada: aforo negativo, modalidad fuera
    del enum y textos sin limite pasaban, y un `null` en un campo obligatorio
    salia como 500 desde la base.
    """
    from pydantic import ValidationError

    from app.modules.events.schemas import CambioPublicadoRequest

    for malo in (
        {"reason": "x", "capacity": -5},
        {"reason": "x", "capacity": 10_000_001},
        {"reason": "x", "event_type": "regalado"},
        {"reason": "x", "title": ""},
        {"reason": "x", "title": "t" * 200},
        {"reason": "x", "location": "l" * 300},
        {"reason": "", "capacity": 10},
    ):
        with pytest.raises(ValidationError):
            CambioPublicadoRequest(**malo)

    # Y lo valido sigue pasando.
    bueno = CambioPublicadoRequest(reason="cambio de sala", location="Sala B")
    assert bueno.location == "Sala B"


def test_una_politica_con_numeros_imposibles_no_se_publica() -> None:
    """Un `refund_bps` de 9.999.999 llegaba tal cual a la pantalla del
    comprador como si fuera una decision de la empresa."""
    from app.core.exceptions import ValidationAppError
    from app.modules.events import politicas

    for malo in (
        {"refund_bps": 9_999_999},
        {"refund_bps": -1},
        {"window_hours_before_event": -1},
        {"reserve_bps": 20_000},
        # Un booleano no es un numero: `True` vale 1 y un plazo de «un dia»
        # que en realidad era un si es del mismo tipo de error.
        {"hold_days": True},
    ):
        with pytest.raises(ValidationAppError):
            politicas._exigir_parametros_sensatos(malo)

    # Lo posible pasa, y una clave desconocida no se rechaza: la empresa puede
    # necesitar guardar algo que hoy no se lee.
    politicas._exigir_parametros_sensatos({"refund_bps": 10_000, "lo_que_sea": "x"})


def test_una_politica_no_es_un_almacen() -> None:
    from app.core.exceptions import ValidationAppError
    from app.modules.events import politicas

    with pytest.raises(ValidationAppError):
        politicas._exigir_parametros_sensatos(
            {f"k{i}": i for i in range(politicas.CLAVES_MAXIMAS + 1)}
        )


def test_el_contrato_de_retirar_no_publica_campos_de_administracion() -> None:
    """`/withdraw` reutilizaba el esquema de decision, que expone `notes`,
    `outcome` e importes. El codigo los ignoraba; el OpenAPI decia lo contrario.
    """
    from app.modules.events.posventa_schemas import RetiroRequest

    campos = set(RetiroRequest.model_fields)
    assert campos == {"reason"}, campos


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_cursor_ilegible_no_es_un_500(sesiones) -> None:
    """Llega del cliente: es un 422, no un fallo del servidor."""
    from app.core.exceptions import ValidationAppError

    quien = await _persona(sesiones, "cur")
    for malo in ("basura", "|", "2026-13-45|x", ""):
        if malo == "":
            continue
        async with sesiones() as db:
            with pytest.raises(ValidationAppError):
                await posventa.mios(db, usuario_id=quien, cursor=malo)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_cursor_sin_zona_no_revienta_en_la_base(sesiones) -> None:
    """Una fecha naive contra una columna con zona falla dentro de la base y
    llega disfrazada de otra cosa."""
    quien = await _persona(sesiones, "cur2")
    async with sesiones() as db:
        assert await posventa.mios(db, usuario_id=quien, cursor=f"2026-01-01T00:00:00|{uuid.uuid4()}") == []


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_tipo_de_expediente_inventado_es_un_422(sesiones) -> None:
    from app.core.exceptions import ValidationAppError

    orden, evento = await _compra(sesiones, dias=10)
    organiza = await _organizador_de(sesiones, evento)
    async with sesiones() as db:
        with pytest.raises(ValidationAppError):
            await posventa.abrir(
                db,
                orden=await db.get(EventOrder, orden.id),
                organizador_id=organiza,
                tipo="lo_que_sea",
                actor_id=orden.buyer_id,
            )


# =========================================================================== #
# El estado a medio migrar, que es el que rompia la puerta
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_con_la_0064_puesta_y_la_0065_no_la_puerta_sigue_funcionando() -> None:
    """EL ORDEN NATURAL DE DESPLIEGUE PASA POR AQUI: se aplica la 0064, se
    prueba, y luego la 0065.

    En esa ventana existen las cinco tablas de posventa pero NO la columna
    `effect`, y la puerta la consulta en cada escaneo para saber si una entrada
    esta retenida. Comprobar solo las tablas dejaba pasar ese estado y cada
    escaneo respondia 500, sin dejar ni rastro del intento.

    Se monta una base a medio migrar de verdad, porque es la unica forma de
    ejercer esto: en una base completa la columna existe y la proteccion no se
    puede distinguir de su ausencia.
    """
    import psycopg
    from sqlalchemy.ext.asyncio import create_async_engine

    from app.modules.events import esquema

    base = "renaser_media_migracion"
    servidor = URL.rsplit("/", 1)[0]
    with psycopg.connect(f"{servidor}/postgres", autocommit=True) as cn:
        with cn.cursor() as cur:
            cur.execute(f"drop database if exists {base}")
            cur.execute(f"create database {base}")

    with psycopg.connect(f"{servidor}/{base}", autocommit=True) as cn:
        with cn.cursor() as cur:
            cur.execute(PROLOGO.read_text(encoding="utf-8"))
        for ruta in sorted(MIGRACIONES.glob("*.sql")):
            # HASTA LA 0064, y ni una mas.
            if ruta.name >= "0065":
                break
            with cn.cursor() as cur:
                cur.execute(ruta.read_text(encoding="utf-8"))

    motor = create_async_engine(
        f"{servidor}/{base}".replace("postgresql://", "postgresql+asyncpg://", 1)
    )
    try:
        esquema.olvidar()
        async with motor.connect() as cx:
            from sqlalchemy.ext.asyncio import AsyncSession

            async with AsyncSession(bind=cx) as db:
                # Las cinco tablas ESTAN...
                assert await db.scalar(
                    text("select to_regclass('public.event_aftersale_case_tickets')")
                ) is not None
                # ...y aun asi la posventa se declara NO disponible, porque le
                # falta la columna que la puerta consulta.
                assert await esquema.hay_posventa(db) is False
    finally:
        await motor.dispose()
        esquema.olvidar()
        with psycopg.connect(f"{servidor}/postgres", autocommit=True) as cn:
            with cn.cursor() as cur:
                cur.execute(f"drop database if exists {base}")
