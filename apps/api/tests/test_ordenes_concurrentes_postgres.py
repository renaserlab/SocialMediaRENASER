"""Órdenes, emisión y check-in a la vez. Solo contra PostgreSQL.

POR QUÉ SOLO AQUÍ. SQLAlchemy omite `for update` en SQLite sin avisar y allí no
hay dos escritores: una carrera probada contra SQLite no prueba nada. Estas
comprobaciones necesitan la base de verdad, con sus índices parciales, sus
claves ajenas compuestas y sus disparadores diferidos.

LAS CARRERAS SE COORDINAN CON BARRERAS, no con esperas. `asyncio.Barrier` hace
que las dos transacciones lleguen al punto de conflicto a la vez de forma
determinista; un `sleep` convierte la prueba en una apuesta sobre lo rápida que
sea la máquina, y una apuesta que sale bien no prueba nada.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.exceptions import AppError
from app.modules.events import esquema, orders, ticketing
from app.modules.events import tickets as emision
from app.modules.events import models as _modelos_de_evento  # noqa: F401
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

pytestmark = [SIN_POSTGRES, pytest.mark.asyncio]


def _url_async() -> str:
    return URL.replace("postgresql://", "postgresql+asyncpg://", 1)


@pytest.fixture(scope="module")
def base_aplicada():
    """Esquema reconstruido con las migraciones de verdad, una sola vez."""
    import psycopg

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
    esquema.olvidar()
    return True


@pytest_asyncio.fixture()
async def motor(base_aplicada, monkeypatch):
    monkeypatch.setattr(get_settings(), "feature_event_ticketing", True, raising=False)
    monkeypatch.setattr(get_settings(), "environment", "development", raising=False)
    # La espera, fijada: varias de estas pruebas serializan transacciones sobre
    # la misma fila y dan por hecho que ninguna se rinde por tiempo.
    monkeypatch.setattr(
        get_settings(), "inventory_lock_timeout_ms", 30000, raising=False
    )
    motor = create_async_engine(_url_async(), pool_size=20, max_overflow=10)
    yield motor
    await motor.dispose()


@pytest_asyncio.fixture()
async def sesiones(motor):
    return async_sessionmaker(motor, expire_on_commit=False)


# --------------------------------------------------------------------------- #
# Montaje
# --------------------------------------------------------------------------- #
async def _persona(motor, etiqueta: str) -> str:
    ident = str(uuid.uuid4())
    async with motor.begin() as conexion:
        await conexion.execute(
            text(
                "insert into auth.users (id, email, raw_user_meta_data) values "
                "(cast(:id as uuid), cast(:email as text), "
                " jsonb_build_object('full_name', 'P', 'username', cast(:u as text)))"
            ),
            {
                "id": ident,
                "email": f"{etiqueta}-{ident[:8]}@x.test",
                "u": f"{etiqueta}{ident[:8]}",
            },
        )
    return ident


async def _evento(motor, aforo: int | None = None) -> str:
    organizador = await _persona(motor, "org")
    ident = str(uuid.uuid4())
    async with motor.begin() as conexion:
        await conexion.execute(
            text(
                "insert into public.events "
                "(id, organizer_id, title, description, starts_at, capacity, status) "
                "values (cast(:id as uuid), cast(:org as uuid), 'Concierto', 'x', "
                "        now() + interval '20 days', cast(:aforo as int), 'published')"
            ),
            {"id": ident, "org": organizador, "aforo": aforo},
        )
        await conexion.execute(
            text(
                "insert into public.event_operations (event_id, workflow_status, origin) "
                "values (cast(:id as uuid), 'PUBLISHED', 'events_v2')"
            ),
            {"id": ident},
        )
        await conexion.execute(
            text(
                "insert into public.event_ticketing_settings "
                "(event_id, access_mode, currency) "
                "values (cast(:id as uuid), 'TICKETED', 'PEN')"
            ),
            {"id": ident},
        )
    return ident


async def _tipo(motor, evento: str, *, cupo: int, precio: int = 4900) -> str:
    ident = str(uuid.uuid4())
    async with motor.begin() as conexion:
        await conexion.execute(
            text(
                "insert into public.event_ticket_types "
                "(id, event_id, name, price_minor, currency, quota, max_per_order, status) "
                "values (cast(:id as uuid), cast(:e as uuid), 'General', "
                "        cast(:p as int), 'PEN', cast(:q as int), 10, 'on_sale')"
            ),
            {"id": ident, "e": evento, "p": precio, "q": cupo},
        )
    return ident


async def _hold(sesiones, evento: str, persona: str, tipo: str, cantidad: int = 1) -> str:
    async with sesiones() as db:
        hold = await ticketing.crear_hold(
            db,
            evento_id=evento,
            usuario_id=persona,
            pedido=[(tipo, cantidad)],
            clave=f"h-{uuid.uuid4()}",
        )
        return hold.id


async def _orden(sesiones, hold_id: str, persona: str) -> str:
    async with sesiones() as db:
        creada = await orders.crear_orden(
            db, hold_id=hold_id, usuario_id=persona, clave=f"o-{uuid.uuid4()}"
        )
        return creada.orden.id


async def _cuantas_entradas(motor, orden_id: str) -> int:
    async with motor.connect() as conexion:
        return (
            await conexion.execute(
                text(
                    "select count(*) from public.event_tickets "
                    "where order_id = cast(:o as uuid)"
                ),
                {"o": orden_id},
            )
        ).scalar_one()


async def _abrir_cobro(motor, orden_id: str) -> None:
    """Lo que hace `iniciar_pago` sin llamar a ninguna pasarela.

    Una orden con `provider = 'none'` nunca abrio un cobro, asi que ningun aviso
    puede ser suyo: las pruebas del camino de pago tienen que dejarla como la
    dejaria el checkout.
    """
    async with motor.begin() as conexion:
        await conexion.execute(
            text(
                "update public.event_orders set provider = 'stripe', "
                "  environment = 'sandbox', status = 'PAYMENT_PROCESSING' "
                "where id = cast(:o as uuid) and status = 'PENDING_PAYMENT'"
            ),
            {"o": orden_id},
        )


async def _confirmar(sesiones, orden_id: str, referencia: str, importe: int):
    """Un aviso ya verificado, con el `commit` que hace el webhook."""
    async with sesiones() as db:
        try:
            resultado = await orders.confirmar_pago(
                db,
                orden_id=orden_id,
                provider="stripe",
                environment="sandbox",
                external_payment_id=referencia,
                amount_minor=importe,
                currency="PEN",
            )
        except Exception as error:  # noqa: BLE001
            await db.rollback()
            return error
        await db.commit()
        return resultado


# --------------------------------------------------------------------------- #
# 1. Dos órdenes sobre la misma reserva
# --------------------------------------------------------------------------- #
async def test_dos_ordenes_a_la_vez_sobre_la_misma_reserva(motor, sesiones) -> None:
    """Una reserva, una orden. Las dos pasan la comprobación; por el índice
    único pasa una."""
    evento = await _evento(motor, aforo=10)
    tipo = await _tipo(motor, evento, cupo=10)
    persona = await _persona(motor, "compra")
    hold = await _hold(sesiones, evento, persona, tipo, 2)

    barrera = asyncio.Barrier(2)

    async def intenta():
        async with sesiones() as db:
            await barrera.wait()
            try:
                creada = await orders.crear_orden(
                    db, hold_id=hold, usuario_id=persona, clave=f"k-{uuid.uuid4()}"
                )
                return creada.orden.id
            except AppError as error:
                return error

    uno, dos = await asyncio.gather(intenta(), intenta())
    ids = {r for r in (uno, dos) if isinstance(r, str)}
    assert len(ids) == 1, (uno, dos)

    async with motor.connect() as conexion:
        cuantas = (
            await conexion.execute(
                text(
                    "select count(*) from public.event_orders "
                    "where hold_id = cast(:h as uuid)"
                ),
                {"h": hold},
            )
        ).scalar_one()
    assert cuantas == 1



async def test_la_base_rechaza_una_segunda_orden_sobre_la_misma_reserva(
    motor, sesiones
) -> None:
    """El indice unico, ejercido SIN pasar por el servicio.

    La prueba de arriba serializa las dos peticiones en el cerrojo del evento,
    asi que el servicio ya las separa por si solo: sale verde con el indice
    quitado. Esto comprueba que la base tambien lo impide, que es lo que hace
    falta el dia que otro camino inserte una orden sin ese cerrojo.
    """
    evento = await _evento(motor, aforo=10)
    tipo = await _tipo(motor, evento, cupo=10)
    persona = await _persona(motor, "una-reserva")
    hold = await _hold(sesiones, evento, persona, tipo, 1)
    await _orden(sesiones, hold, persona)

    otra = str(uuid.uuid4())
    with pytest.raises(IntegrityError):
        async with motor.begin() as conexion:
            await conexion.execute(
                text(
                    "insert into public.event_orders "
                    "(id, event_id, buyer_id, hold_id, currency, subtotal_minor, "
                    " total_minor, idempotency_key) "
                    "values (cast(:o as uuid), cast(:e as uuid), cast(:b as uuid), "
                    "        cast(:h as uuid), 'PEN', 4900, 4900, 'la-segunda')"
                ),
                {"o": otra, "e": evento, "b": persona, "h": hold},
            )
            await conexion.execute(
                text(
                    "insert into public.event_order_items "
                    "(order_id, event_id, ticket_type_id, ticket_type_name_snapshot, "
                    " unit_price_minor, quantity, subtotal_minor) "
                    "values (cast(:o as uuid), cast(:e as uuid), cast(:t as uuid), "
                    "        'General', 4900, 1, 4900)"
                ),
                {"o": otra, "e": evento, "t": tipo},
            )


# --------------------------------------------------------------------------- #
# 2. Dos confirmaciones a la vez
# --------------------------------------------------------------------------- #
async def test_dos_confirmaciones_a_la_vez_no_emiten_el_doble(motor, sesiones) -> None:
    """Las pasarelas reintentan, y dos avisos pueden llegar a la vez.

    Lo que impide el doble juego de entradas es el cerrojo de la fila de la
    orden: la segunda transacción espera, ve `PAID` y no emite nada.
    """
    evento = await _evento(motor, aforo=20)
    tipo = await _tipo(motor, evento, cupo=20)
    persona = await _persona(motor, "paga")
    hold = await _hold(sesiones, evento, persona, tipo, 3)
    orden = await _orden(sesiones, hold, persona)
    await _abrir_cobro(motor, orden)

    barrera = asyncio.Barrier(2)

    async def avisa():
        async with sesiones() as db:
            await barrera.wait()
            try:
                resultado = await orders.confirmar_pago(
                    db,
                    orden_id=orden,
                    provider="stripe",
                    environment="sandbox",
                    external_payment_id="pi_el_mismo",
                    amount_minor=3 * 4900,
                    currency="PEN",
                )
            except Exception as error:  # noqa: BLE001
                await db.rollback()
                return error
            await db.commit()
            return resultado

    uno, dos = await asyncio.gather(avisa(), avisa())
    estrenadas = [
        r.estrenada for r in (uno, dos) if isinstance(r, orders.OrdenCreada)
    ]
    assert estrenadas.count(True) <= 1, (uno, dos)
    assert await _cuantas_entradas(motor, orden) == 3, "ni una de más"

    async with motor.connect() as conexion:
        estado = (
            await conexion.execute(
                text("select status from public.event_orders where id = cast(:o as uuid)"),
                {"o": orden},
            )
        ).scalar_one()
    assert estado == "PAID"


async def test_dos_cobros_distintos_no_confirman_la_misma_orden(motor, sesiones) -> None:
    """Uno gana; el otro es un problema de conciliación, no una confirmación."""
    evento = await _evento(motor, aforo=20)
    tipo = await _tipo(motor, evento, cupo=20)
    persona = await _persona(motor, "dos-cobros")
    hold = await _hold(sesiones, evento, persona, tipo, 1)
    orden = await _orden(sesiones, hold, persona)
    await _abrir_cobro(motor, orden)

    barrera = asyncio.Barrier(2)

    async def avisa(referencia: str):
        async with sesiones() as db:
            await barrera.wait()
            try:
                resultado = await orders.confirmar_pago(
                    db,
                    orden_id=orden,
                    provider="stripe",
                    environment="sandbox",
                    external_payment_id=referencia,
                    amount_minor=4900,
                    currency="PEN",
                )
            except Exception as error:  # noqa: BLE001
                await db.rollback()
                return error
            await db.commit()
            return resultado

    resultados = await asyncio.gather(avisa("pi_uno"), avisa("pi_dos"))
    exitos = [r for r in resultados if isinstance(r, orders.OrdenCreada)]
    assert len(exitos) == 1, resultados
    assert isinstance(
        [r for r in resultados if not isinstance(r, orders.OrdenCreada)][0],
        orders.PagoNoCuadra,
    )
    assert await _cuantas_entradas(motor, orden) == 1


# --------------------------------------------------------------------------- #
# 3. Dos check-ins a la vez
# --------------------------------------------------------------------------- #
async def _una_entrada(motor, sesiones) -> tuple[str, str, str]:
    """Devuelve (evento, entrada, credencial)."""
    evento = await _evento(motor, aforo=20)
    tipo = await _tipo(motor, evento, cupo=20, precio=0)
    persona = await _persona(motor, "asiste")
    hold = await _hold(sesiones, evento, persona, tipo, 1)
    orden = await _orden(sesiones, hold, persona)  # gratis: se confirma sola

    async with motor.connect() as conexion:
        entrada = (
            await conexion.execute(
                text(
                    "select id::text from public.event_tickets "
                    "where order_id = cast(:o as uuid)"
                ),
                {"o": orden},
            )
        ).scalar_one()
    async with sesiones() as db:
        _, credencial = await emision.credencial_de(
            db, entrada_id=entrada, usuario_id=persona
        )
    return evento, entrada, credencial


async def test_dos_lectores_escanean_el_mismo_qr_a_la_vez(motor, sesiones) -> None:
    """Uno deja pasar, el otro dice «ya utilizada». Y una sola escritura.

    Lo que lo garantiza no es el `if` que mira el estado —las dos lo leen
    `VALID`— sino el `UPDATE ... WHERE status = 'VALID'`, que la base resuelve
    fila a fila.
    """
    evento, entrada, credencial = await _una_entrada(motor, sesiones)
    operador = await _persona(motor, "puerta")

    barrera = asyncio.Barrier(2)

    async def escanea():
        async with sesiones() as db:
            await barrera.wait()
            try:
                return await emision.check_in(
                    db,
                    evento_id=evento,
                    credencial=credencial,
                    operador_id=operador,
                )
            except Exception as error:  # noqa: BLE001
                await db.rollback()
                return error

    uno, dos = await asyncio.gather(escanea(), escanea())
    resultados = [r.resultado for r in (uno, dos) if isinstance(r, emision.Veredicto)]
    assert resultados.count(emision.OK) == 1, (uno, dos)

    async with motor.connect() as conexion:
        correctos = (
            await conexion.execute(
                text(
                    "select count(*) from public.event_checkins "
                    "where ticket_id = cast(:t as uuid) and result = 'OK'"
                ),
                {"t": entrada},
            )
        ).scalar_one()
        estado = (
            await conexion.execute(
                text("select status from public.event_tickets where id = cast(:t as uuid)"),
                {"t": entrada},
            )
        ).scalar_one()
    assert correctos == 1, "el índice parcial deja UN check-in correcto"
    assert estado == "USED"


async def test_la_base_rechaza_un_segundo_check_in_correcto(motor, sesiones) -> None:
    """El índice parcial, ejercido a mano: no es un `if` de Python."""
    import asyncpg

    evento, entrada, _ = await _una_entrada(motor, sesiones)
    operador = await _persona(motor, "puerta2")

    async def anota():
        async with motor.begin() as conexion:
            await conexion.execute(
                text(
                    "insert into public.event_checkins "
                    "(ticket_id, event_id, operator_id, result) "
                    "values (cast(:t as uuid), cast(:e as uuid), cast(:o as uuid), 'OK')"
                ),
                {"t": entrada, "e": evento, "o": operador},
            )

    await anota()
    with pytest.raises(IntegrityError):
        await anota()


# --------------------------------------------------------------------------- #
# 4. La última entrada
# --------------------------------------------------------------------------- #
async def test_diez_compran_a_la_vez_las_tres_que_quedan(motor, sesiones) -> None:
    """El aforo se agota EXACTO, atravesando hold, orden y emisión."""
    evento = await _evento(motor, aforo=3)
    tipo = await _tipo(motor, evento, cupo=10, precio=0)
    personas = [await _persona(motor, f"p{i}") for i in range(10)]

    barrera = asyncio.Barrier(len(personas))

    async def compra(persona: str):
        async with sesiones() as db:
            await barrera.wait()
            try:
                hold = await ticketing.crear_hold(
                    db,
                    evento_id=evento,
                    usuario_id=persona,
                    pedido=[(tipo, 1)],
                    clave=f"h-{persona}",
                )
            except AppError as error:
                return error
        async with sesiones() as db:
            try:
                creada = await orders.crear_orden(
                    db, hold_id=hold.id, usuario_id=persona, clave=f"o-{persona}"
                )
                return creada.orden.id
            except AppError as error:
                return error

    resultados = await asyncio.gather(*(compra(p) for p in personas))
    ordenes = [r for r in resultados if isinstance(r, str)]
    assert len(ordenes) == 3, resultados

    async with motor.connect() as conexion:
        emitidas = (
            await conexion.execute(
                text(
                    "select count(*) from public.event_tickets "
                    "where event_id = cast(:e as uuid)"
                ),
                {"e": evento},
            )
        ).scalar_one()
    assert emitidas == 3, "ni una entrada de más para un aforo de tres"


# --------------------------------------------------------------------------- #
# 5. Lo que sostiene la base, ejercido a mano
# --------------------------------------------------------------------------- #
async def test_una_orden_sin_lineas_no_se_confirma(motor, sesiones) -> None:
    """El disparador diferido: una orden que no compra nada no entra.

    CON SUBTOTAL CERO A PROPOSITO. Con 4900 la orden se rechazaria igual por la
    suma —cero lineas suman cero—, y entonces la prueba no diria nada de la
    regla que dice probar: quitando la exigencia de al menos una linea seguiria
    en verde. Con cero la suma CUADRA, y lo unico que puede rechazarla es no
    tener ninguna linea.
    """
    evento = await _evento(motor, aforo=10)
    tipo = await _tipo(motor, evento, cupo=10, precio=0)
    persona = await _persona(motor, "sin-lineas")
    hold = await _hold(sesiones, evento, persona, tipo, 1)

    with pytest.raises(IntegrityError):
        async with motor.begin() as conexion:
            await conexion.execute(
                text(
                    "insert into public.event_orders "
                    "(event_id, buyer_id, hold_id, currency, subtotal_minor, "
                    " total_minor, idempotency_key) "
                    "values (cast(:e as uuid), cast(:b as uuid), cast(:h as uuid), "
                    "        'PEN', 0, 0, 'suelta')"
                ),
                {"e": evento, "b": persona, "h": hold},
            )


async def test_una_orden_pagada_sin_sus_entradas_no_se_confirma(motor, sesiones) -> None:
    """Se emiten EXACTAMENTE las compradas, y lo dice la base.

    Se marca la orden como pagada sin emitir nada: el disparador diferido lo ve
    al confirmar y la transacción entera se cae.
    """
    evento = await _evento(motor, aforo=10)
    tipo = await _tipo(motor, evento, cupo=10)
    persona = await _persona(motor, "sin-emitir")
    hold = await _hold(sesiones, evento, persona, tipo, 2)
    orden = await _orden(sesiones, hold, persona)

    with pytest.raises(IntegrityError):
        async with motor.begin() as conexion:
            await conexion.execute(
                text(
                    "update public.event_orders set status = 'PAID', paid_at = now(), "
                    "  provider = 'stripe', external_payment_id = 'pi_x' "
                    "where id = cast(:o as uuid)"
                ),
                {"o": orden},
            )

    async with motor.connect() as conexion:
        estado = (
            await conexion.execute(
                text("select status from public.event_orders where id = cast(:o as uuid)"),
                {"o": orden},
            )
        ).scalar_one()
    assert estado == "PENDING_PAYMENT", "el rechazo no dejó la orden a medias"


async def test_una_referencia_de_cobro_no_confirma_dos_ordenes(motor, sesiones) -> None:
    evento = await _evento(motor, aforo=20)
    tipo = await _tipo(motor, evento, cupo=20, precio=0)
    primera_persona = await _persona(motor, "ref1")
    segunda_persona = await _persona(motor, "ref2")
    uno = await _orden(sesiones, await _hold(sesiones, evento, primera_persona, tipo), primera_persona)
    dos = await _orden(sesiones, await _hold(sesiones, evento, segunda_persona, tipo), segunda_persona)

    async def apunta(orden_id: str):
        async with motor.begin() as conexion:
            await conexion.execute(
                text(
                    "update public.event_orders set provider = 'stripe', "
                    "  external_payment_id = 'pi_repetido' where id = cast(:o as uuid)"
                ),
                {"o": orden_id},
            )

    await apunta(uno)
    with pytest.raises(IntegrityError):
        await apunta(dos)


async def test_la_orden_hereda_evento_comprador_y_moneda_de_su_reserva(
    motor, sesiones
) -> None:
    """La clave ajena compuesta: una orden a nombre de otro no entra.

    CON SU LINEA ESCRITA. Sin ella la insercion se rechazaria igual por el
    disparador de cuadre, y la prueba saldria verde con la clave ajena quitada:
    diria estar probando una cosa y estaria probando otra.
    """
    evento = await _evento(motor, aforo=10)
    tipo = await _tipo(motor, evento, cupo=10)
    persona = await _persona(motor, "duena")
    otra = await _persona(motor, "ajena")
    hold = await _hold(sesiones, evento, persona, tipo, 1)
    orden = str(uuid.uuid4())

    with pytest.raises(IntegrityError):
        async with motor.begin() as conexion:
            await conexion.execute(
                text(
                    "insert into public.event_orders "
                    "(id, event_id, buyer_id, hold_id, currency, subtotal_minor, "
                    " total_minor, idempotency_key) "
                    "values (cast(:o as uuid), cast(:e as uuid), cast(:b as uuid), "
                    "        cast(:h as uuid), 'PEN', 4900, 4900, 'a-nombre-de-otro')"
                ),
                {"o": orden, "e": evento, "b": otra, "h": hold},
            )
            await conexion.execute(
                text(
                    "insert into public.event_order_items "
                    "(order_id, event_id, ticket_type_id, ticket_type_name_snapshot, "
                    " unit_price_minor, quantity, subtotal_minor) "
                    "values (cast(:o as uuid), cast(:e as uuid), cast(:t as uuid), "
                    "        'General', 4900, 1, 4900)"
                ),
                {"o": orden, "e": evento, "t": tipo},
            )


async def test_una_entrada_usada_no_vuelve_a_valida(motor, sesiones) -> None:
    """`USED` sin hora de entrada no entra, y `VALID` con hora tampoco."""
    evento, entrada, credencial = await _una_entrada(motor, sesiones)
    operador = await _persona(motor, "puerta3")
    async with sesiones() as db:
        veredicto = await emision.check_in(
            db, evento_id=evento, credencial=credencial, operador_id=operador
        )
    assert veredicto.resultado == emision.OK

    with pytest.raises(IntegrityError):
        async with motor.begin() as conexion:
            await conexion.execute(
                text(
                    "update public.event_tickets set status = 'VALID' "
                    "where id = cast(:t as uuid)"
                ),
                {"t": entrada},
            )


async def test_una_entrada_revocada_exige_su_fecha(motor, sesiones) -> None:
    _, entrada, _ = await _una_entrada(motor, sesiones)
    with pytest.raises(IntegrityError):
        async with motor.begin() as conexion:
            await conexion.execute(
                text(
                    "update public.event_tickets set status = 'REVOKED' "
                    "where id = cast(:t as uuid)"
                ),
                {"t": entrada},
            )


async def test_una_orden_pagada_con_pasarela_exige_evidencia(motor, sesiones) -> None:
    """`PAID` con proveedor y sin identificador externo no entra."""
    evento = await _evento(motor, aforo=10)
    tipo = await _tipo(motor, evento, cupo=10, precio=0)
    persona = await _persona(motor, "evidencia")
    orden = await _orden(sesiones, await _hold(sesiones, evento, persona, tipo), persona)

    with pytest.raises(IntegrityError):
        async with motor.begin() as conexion:
            await conexion.execute(
                text(
                    "update public.event_orders set provider = 'stripe' "
                    "where id = cast(:o as uuid)"
                ),
                {"o": orden},
            )


# --------------------------------------------------------------------------- #
# 6. RLS y permisos reales
# --------------------------------------------------------------------------- #
async def test_las_cuatro_tablas_nuevas_tienen_rls_y_ninguna_politica(motor) -> None:
    async with motor.connect() as conexion:
        sin_rls = (
            await conexion.execute(
                text(
                    "select count(*) from pg_class c "
                    "join pg_namespace n on n.oid = c.relnamespace "
                    "where n.nspname = 'public' and not c.relrowsecurity "
                    "  and c.relname in ('event_orders', 'event_order_items', "
                    "                    'event_tickets', 'event_checkins')"
                )
            )
        ).scalar_one()
        politicas = (
            await conexion.execute(
                text(
                    "select count(*) from pg_policies where schemaname = 'public' "
                    "  and tablename in ('event_orders', 'event_order_items', "
                    "                    'event_tickets', 'event_checkins')"
                )
            )
        ).scalar_one()
        concesiones = (
            await conexion.execute(
                text(
                    "select count(*) from information_schema.role_table_grants "
                    "where table_schema = 'public' "
                    "  and grantee in ('anon', 'authenticated') "
                    "  and table_name in ('event_orders', 'event_order_items', "
                    "                     'event_tickets', 'event_checkins')"
                )
            )
        ).scalar_one()
    assert sin_rls == 0
    assert politicas == 0, "sin política no se lee ni se escribe desde el teléfono"
    assert concesiones == 0


async def test_ni_anon_ni_authenticated_tienen_permisos_por_columna(motor) -> None:
    """Retirar el permiso de tabla y dejar el de columna es el hueco clásico."""
    async with motor.connect() as conexion:
        cuantos = (
            await conexion.execute(
                text(
                    "select count(*) from information_schema.column_privileges "
                    "where table_schema = 'public' "
                    "  and grantee in ('anon', 'authenticated') "
                    "  and table_name in ('event_orders', 'event_order_items', "
                    "                     'event_tickets', 'event_checkins')"
                )
            )
        ).scalar_one()
    assert cuantos == 0
