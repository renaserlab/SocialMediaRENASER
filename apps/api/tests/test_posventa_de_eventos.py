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

from app.modules.events import elegibilidad, politicas
from app.modules.events import models as _modelos_de_evento  # noqa: F401
from app.modules.events import posventa_estados as maquina
from app.modules.events.models import EventOrder
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
        maquina.exigir(ENVIADO, DEVOLUCION_EN_CURSO, maquina.ADMINISTRACION)
    with pytest.raises(maquina.SaltoNoPermitido):
        maquina.exigir(ENVIADO, RECHAZADO, maquina.COMPRADOR)


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
