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


# --------------------------------------------------------------------------- #
# La credencial, la revocacion y la suspension, todas a la vez
# --------------------------------------------------------------------------- #
async def test_dos_rotaciones_a_la_vez_dejan_una_credencial_coherente(
    motor, sesiones
) -> None:
    """El hash y el codigo tienen que ser de la MISMA rotacion.

    Si se cruzaran —el hash de una y el codigo de otra— quien pidio la primera
    tendria un QR que no vale y un codigo que si, y a la inversa. Lo impide el
    `with_for_update` sobre la fila: la segunda espera a que la primera confirme.
    """
    evento, entrada, _ = await _una_entrada(motor, sesiones)
    async with motor.connect() as conexion:
        dueno = (
            await conexion.execute(
                text(
                    "select owner_id::text from public.event_tickets "
                    "where id = cast(:t as uuid)"
                ),
                {"t": entrada},
            )
        ).scalar_one()

    barrera = asyncio.Barrier(2)

    async def rota():
        async with sesiones() as db:
            await barrera.wait()
            try:
                _, credencial = await emision.credencial_de(
                    db, entrada_id=entrada, usuario_id=dueno
                )
                return credencial
            except Exception as error:  # noqa: BLE001
                await db.rollback()
                return error

    una, otra = await asyncio.gather(rota(), rota())
    credenciales = [c for c in (una, otra) if isinstance(c, str)]
    assert len(credenciales) == 2, (una, otra)
    assert credenciales[0] != credenciales[1], "cada rotacion genera la suya"

    # La que vale es UNA de las dos, y el codigo que hay es el de esa misma.
    evento_id = evento
    operador = await _persona(motor, "puerta-rot")
    veredictos = []
    for credencial in credenciales:
        async with sesiones() as db:
            veredictos.append(
                (
                    await emision.verificar(
                        db, evento_id=evento_id, credencial=credencial
                    )
                ).resultado
            )
    assert veredictos.count(emision.OK) == 1, veredictos
    assert veredictos.count(emision.NO_EXISTE) == 1, veredictos

    # Y el codigo guardado admite: es el de la rotacion que gano, no el de la
    # otra. Si se hubieran cruzado, este check-in daria NOT_FOUND.
    async with motor.connect() as conexion:
        codigo = (
            await conexion.execute(
                text(
                    "select code from public.event_tickets where id = cast(:t as uuid)"
                ),
                {"t": entrada},
            )
        ).scalar_one()
    async with sesiones() as db:
        final = await emision.check_in(
            db, evento_id=evento_id, credencial=codigo, operador_id=operador
        )
    assert final.resultado == emision.OK


async def test_rotar_mientras_alguien_escanea_la_credencial_vieja(
    motor, sesiones
) -> None:
    """Gane quien gane, el resultado no puede ser contradictorio.

    O la vieja llega antes y la entrada se usa, o llega despues y ya no vale.
    Lo que NO puede pasar es que la entrada quede USED y la credencial vieja
    siga admitiendo, ni que quede VALID habiendo dejado pasar a alguien.
    """
    evento, entrada, vieja = await _una_entrada(motor, sesiones)
    async with motor.connect() as conexion:
        dueno = (
            await conexion.execute(
                text(
                    "select owner_id::text from public.event_tickets "
                    "where id = cast(:t as uuid)"
                ),
                {"t": entrada},
            )
        ).scalar_one()
    operador = await _persona(motor, "puerta-rot2")

    barrera = asyncio.Barrier(2)

    async def escanea():
        async with sesiones() as db:
            await barrera.wait()
            try:
                return await emision.check_in(
                    db, evento_id=evento, credencial=vieja, operador_id=operador
                )
            except Exception as error:  # noqa: BLE001
                await db.rollback()
                return error

    async def rota():
        async with sesiones() as db:
            await barrera.wait()
            try:
                return await emision.credencial_de(
                    db, entrada_id=entrada, usuario_id=dueno
                )
            except Exception as error:  # noqa: BLE001
                await db.rollback()
                return error

    paso, _rotacion = await asyncio.gather(escanea(), rota())

    async with motor.connect() as conexion:
        estado, correctos = (
            await conexion.execute(
                text(
                    "select t.status, ("
                    " select count(*) from public.event_checkins k"
                    " where k.ticket_id = t.id and k.result = 'OK') "
                    "from public.event_tickets t where t.id = cast(:t as uuid)"
                ),
                {"t": entrada},
            )
        ).one()

    if isinstance(paso, emision.Veredicto) and paso.resultado == emision.OK:
        assert estado == "USED" and correctos == 1
    else:
        # No dejo pasar: entonces NO puede haber quedado usada por este camino.
        assert correctos == 0, (paso, estado)


async def test_revocar_y_hacer_check_in_a_la_vez_no_deja_las_dos_cosas(
    motor, sesiones
) -> None:
    """USED y REVOKED son excluyentes, y sus fechas tambien.

    Los dos CHECK de la 0062 —`(status='USED') = (checked_in_at is not null)` y
    el gemelo de revocada— convierten cualquier cruce en una transaccion que no
    confirma, no en una fila incoherente.
    """
    evento, entrada, credencial = await _una_entrada(motor, sesiones)
    async with motor.connect() as conexion:
        organizador = (
            await conexion.execute(
                text(
                    "select organizer_id::text from public.events "
                    "where id = cast(:e as uuid)"
                ),
                {"e": evento},
            )
        ).scalar_one()
    operador = await _persona(motor, "puerta-rev")

    barrera = asyncio.Barrier(2)

    async def escanea():
        async with sesiones() as db:
            await barrera.wait()
            try:
                return await emision.check_in(
                    db, evento_id=evento, credencial=credencial, operador_id=operador
                )
            except Exception as error:  # noqa: BLE001
                await db.rollback()
                return error

    async def revoca():
        async with sesiones() as db:
            await barrera.wait()
            try:
                return await emision.revocar(
                    db, entrada_id=entrada, usuario_id=organizador, motivo="duplicada"
                )
            except Exception as error:  # noqa: BLE001
                await db.rollback()
                return error

    await asyncio.gather(escanea(), revoca())

    async with motor.connect() as conexion:
        estado, usada, revocada = (
            await conexion.execute(
                text(
                    "select status, checked_in_at, revoked_at "
                    "from public.event_tickets where id = cast(:t as uuid)"
                ),
                {"t": entrada},
            )
        ).one()
    assert estado in ("USED", "REVOKED"), estado
    # El estado y las fechas dicen lo mismo, sea cual sea el que gano.
    assert (estado == "USED") == (usada is not None)
    assert (estado == "REVOKED") == (revocada is not None)


async def test_suspender_el_evento_mientras_alguien_entra(motor, sesiones) -> None:
    """Suspender cierra la puerta, y lo que ya paso sigue pasado.

    No puede quedar un check-in correcto de un evento suspendido Y la entrada
    sin usar, ni al reves: o entro antes de la suspension, o no entro.
    """
    evento, entrada, credencial = await _una_entrada(motor, sesiones)
    operador = await _persona(motor, "puerta-susp")

    barrera = asyncio.Barrier(2)

    async def escanea():
        async with sesiones() as db:
            await barrera.wait()
            try:
                return await emision.check_in(
                    db, evento_id=evento, credencial=credencial, operador_id=operador
                )
            except Exception as error:  # noqa: BLE001
                await db.rollback()
                return error

    async def suspende():
        async with motor.begin() as conexion:
            await barrera.wait()
            await conexion.execute(
                text(
                    "update public.event_operations set workflow_status = 'SUSPENDED' "
                    "where event_id = cast(:e as uuid)"
                ),
                {"e": evento},
            )

    veredicto, _ = await asyncio.gather(escanea(), suspende())

    async with motor.connect() as conexion:
        estado, correctos = (
            await conexion.execute(
                text(
                    "select t.status, ("
                    " select count(*) from public.event_checkins k"
                    " where k.ticket_id = t.id and k.result = 'OK') "
                    "from public.event_tickets t where t.id = cast(:t as uuid)"
                ),
                {"t": entrada},
            )
        ).one()
    assert isinstance(veredicto, emision.Veredicto), veredicto
    if veredicto.resultado == emision.OK:
        assert estado == "USED" and correctos == 1
    else:
        assert veredicto.resultado == emision.SIN_ADMISION
        assert estado == "VALID" and correctos == 0

    # Y a partir de aqui la puerta esta cerrada para todos.
    async with sesiones() as db:
        despues = await emision.verificar(
            db, evento_id=evento, credencial=credencial
        )
    assert despues.resultado in (emision.SIN_ADMISION, emision.YA_USADA)


async def test_un_fallo_de_auditoria_no_deja_pasar_a_medias(motor, sesiones) -> None:
    """Si el rastro no se puede escribir, el check-in NO se confirma.

    Es la unica salida que no miente: dejar pasar sin registro convierte la
    puerta en algo que no se puede investigar despues, y confirmar la entrada
    diciendo que fallo dejaria a la persona fuera con su entrada consumida.
    """
    evento, entrada, credencial = await _una_entrada(motor, sesiones)
    operador = await _persona(motor, "puerta-aud")

    from app.modules.gobernanza import auditoria

    async def revienta(*_args, **_kwargs):
        raise RuntimeError("la auditoria no esta disponible")

    original = auditoria.anotar
    auditoria.anotar = revienta
    try:
        async with sesiones() as db:
            with pytest.raises(RuntimeError):
                await emision.check_in(
                    db, evento_id=evento, credencial=credencial, operador_id=operador
                )
            await db.rollback()
    finally:
        auditoria.anotar = original

    async with motor.connect() as conexion:
        estado, intentos = (
            await conexion.execute(
                text(
                    "select t.status, ("
                    " select count(*) from public.event_checkins k"
                    " where k.ticket_id = t.id) "
                    "from public.event_tickets t where t.id = cast(:t as uuid)"
                ),
                {"t": entrada},
            )
        ).one()
    assert estado == "VALID", "la entrada no se consume sin rastro"
    assert intentos == 0, "y no queda un check-in huerfano"

    # Y con la auditoria de vuelta, la entrada SIGUE sirviendo.
    async with sesiones() as db:
        veredicto = await emision.check_in(
            db, evento_id=evento, credencial=credencial, operador_id=operador
        )
    assert veredicto.resultado == emision.OK


# --------------------------------------------------------------------------- #
# Lo que la revision independiente encontro
# --------------------------------------------------------------------------- #
async def test_revocar_tras_haber_leido_la_entrada_no_revienta(motor, sesiones) -> None:
    """LA RUTA REAL LEE LA ENTRADA ANTES DE REVOCARLA.

    `order_router` hace `db.get(EventTicket, ...)` para saber de que evento es
    y comprobar permisos, y despues llama a `revocar`, que la vuelve a leer con
    `with_for_update`. Pero un `for update` NO refresca un objeto que ya esta en
    el mapa de identidad: el cerrojo se toma sobre una fila que entretanto puede
    haber cambiado, y el codigo decide mirando la foto vieja.

    Si mientras tanto alguien paso por la puerta, `revocar` no ve el `USED`,
    escribe `REVOKED` encima y deja `checked_in_at` puesto: el CHECK de la 0062
    rechaza la transaccion y quien revoca recibe un 500 en vez de un 409.
    """
    evento, entrada, credencial = await _una_entrada(motor, sesiones)
    async with motor.connect() as conexion:
        organizador = (
            await conexion.execute(
                text(
                    "select organizer_id::text from public.events "
                    "where id = cast(:e as uuid)"
                ),
                {"e": evento},
            )
        ).scalar_one()
    operador = await _persona(motor, "puerta-rancia")

    # SIN `sleep`: se espera a que la puerta HAYA terminado, no a que pase un
    # tiempo. Una carrera resuelta con el reloj es una apuesta sobre lo rapida
    # que sea la maquina, y una apuesta que sale bien no prueba nada.
    leida = asyncio.Event()
    entro = asyncio.Event()

    async def revoca_como_la_ruta():
        async with sesiones() as db:
            # LO QUE HACE LA RUTA, en la misma sesion y antes de nada: la lee
            # para saber de que evento es, y SE QUEDA CON ELLA mientras
            # comprueba permisos. Retenerla importa: el mapa de identidad de
            # SQLAlchemy guarda referencias debiles, asi que soltar el objeto lo
            # deja recolectar y la siguiente consulta lo traeria fresco. La ruta
            # no lo suelta, y por eso la lectura de `revocar` cae sobre la foto
            # vieja.
            precargada = await db.get(emision.EventTicket, entrada)
            assert precargada is not None
            leida.set()
            await asyncio.wait_for(entro.wait(), timeout=30)
            try:
                await emision.revocar(
                    db, entrada_id=entrada, usuario_id=organizador, motivo="duplicada"
                )
                return "revocada"
            except AppError as esperado:
                await db.rollback()
                return esperado.code or "AppError"
            except Exception as error:  # noqa: BLE001
                await db.rollback()
                return type(error).__name__
            finally:
                del precargada

    async def escanea():
        await asyncio.wait_for(leida.wait(), timeout=30)
        async with sesiones() as db:
            try:
                return await emision.check_in(
                    db, evento_id=evento, credencial=credencial, operador_id=operador
                )
            finally:
                entro.set()

    resultado, veredicto = await asyncio.gather(revoca_como_la_ruta(), escanea())
    assert veredicto.resultado == emision.OK
    assert resultado == "event_ticket_already_used", (
        f"revocar sobre una entrada ya usada devolvio {resultado!r}: "
        "la lectura previa dejo el objeto rancio"
    )


async def test_una_credencial_ya_rotada_no_admite(motor, sesiones) -> None:
    """La escritura del check-in no volvia a comprobar la credencial.

    Su `where` era solo `id` y `status = 'VALID'`. Entre encontrar la entrada
    por su credencial y escribir «usada» no habia cerrojo, asi que una rotacion
    que entrara justo en medio no impedia nada: el QR viejo —el fotografiado,
    el compartido— seguia dejando pasar. Era la promesa entera de rotar.
    """
    evento, entrada, vieja = await _una_entrada(motor, sesiones)
    async with motor.connect() as conexion:
        dueno = (
            await conexion.execute(
                text(
                    "select owner_id::text from public.event_tickets "
                    "where id = cast(:t as uuid)"
                ),
                {"t": entrada},
            )
        ).scalar_one()
    operador = await _persona(motor, "puerta-vieja")

    barrera = asyncio.Barrier(2)
    original = emision._admite_entrada

    rotada = asyncio.Event()

    async def espera_en_medio(db, evento_id, momento):
        # EL HUECO EXACTO: ya se encontro la entrada por la credencial vieja y
        # todavia no se ha escrito nada. Se espera a que la rotacion HAYA
        # confirmado, no a que pase un tiempo.
        await barrera.wait()
        await asyncio.wait_for(rotada.wait(), timeout=30)
        return await original(db, evento_id, momento)

    emision._admite_entrada = espera_en_medio
    try:

        async def escanea():
            async with sesiones() as db:
                return await emision.check_in(
                    db, evento_id=evento, credencial=vieja, operador_id=operador
                )

        async def rota():
            async with sesiones() as db:
                await barrera.wait()
                try:
                    return await emision.credencial_de(
                        db, entrada_id=entrada, usuario_id=dueno
                    )
                finally:
                    rotada.set()

        veredicto, _ = await asyncio.gather(escanea(), rota())
    finally:
        emision._admite_entrada = original

    assert veredicto.resultado != emision.OK, (
        "una credencial ya rotada ha dejado pasar"
    )

    async with motor.connect() as conexion:
        estado = (
            await conexion.execute(
                text("select status from public.event_tickets where id = cast(:t as uuid)"),
                {"t": entrada},
            )
        ).scalar_one()
    assert estado == "VALID", "y no se ha consumido"


async def test_la_puerta_no_se_queda_colgada_detras_de_una_compra(
    motor, sesiones, monkeypatch
) -> None:
    """EL CERROJO DEL EVENTO PARA LA PUERTA ENTERA.

    Registrar un check-in inserta en `event_checkins`, que tiene clave ajena a
    `events`: ese insert pide `for key share` sobre la fila del evento, y eso
    choca con el `for update` que toma cualquier compra, confirmacion de pago o
    cambio de ajustes. Sin limite de espera, cada escaneo se queda parado hasta
    que la otra transaccion termine; con el pool de conexiones que hay, diez
    escaneos parados no paran esa puerta: paran la API.

    Tiene que fallar RAPIDO y de forma reintentable, no esperar.
    """
    evento, entrada, credencial = await _una_entrada(motor, sesiones)
    operador = await _persona(motor, "puerta-cola")
    # LA FIXTURE DE ESTE MODULO SUBE LA ESPERA A 30 SEGUNDOS a proposito, para
    # que las carreras que serializan sobre la misma fila no se rindan por
    # tiempo. Aqui se prueba justo lo contrario, asi que se baja.
    monkeypatch.setattr(
        get_settings(), "inventory_lock_timeout_ms", 1000, raising=False
    )

    tomado = asyncio.Event()
    soltar = asyncio.Event()

    async def sostiene_el_evento():
        async with sesiones() as db:
            await db.execute(
                text(
                    "select id from public.events where id = cast(:e as uuid) for update"
                ),
                {"e": evento},
            )
            tomado.set()
            await asyncio.wait_for(soltar.wait(), timeout=30)
            await db.rollback()

    async def escanea():
        await asyncio.wait_for(tomado.wait(), timeout=30)
        async with sesiones() as db:
            comienzo = asyncio.get_running_loop().time()
            try:
                await emision.check_in(
                    db, evento_id=evento, credencial=credencial, operador_id=operador
                )
                return "paso", asyncio.get_running_loop().time() - comienzo
            except AppError as error:
                await db.rollback()
                return error.code or "AppError", (
                    asyncio.get_running_loop().time() - comienzo
                )
            except Exception as error:  # noqa: BLE001
                await db.rollback()
                return type(error).__name__, (
                    asyncio.get_running_loop().time() - comienzo
                )
            finally:
                soltar.set()

    ajustes = get_settings()
    limite = ajustes.inventory_lock_timeout_ms / 1000
    _, (resultado, tardanza) = await asyncio.gather(sostiene_el_evento(), escanea())

    assert tardanza < limite + 5, (
        f"el escaneo tardo {tardanza:.1f}s: se quedo esperando el cerrojo del evento"
    )
    assert resultado == "inventory_lock_timeout", (
        f"el escaneo termino con {resultado!r}: tiene que ser un fallo "
        "reintentable y con nombre, no una espera eterna ni un 500"
    )
