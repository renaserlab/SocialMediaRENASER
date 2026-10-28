"""«El ultimo mensaje de cada conversacion», pedido como tal.

QUE FIJA ESTE FICHERO. `lectura.ultimos_mensajes` dejo de numerar el historial
entero con `row_number()` (157 ms y 30 MB a disco con un grupo de 100 000
mensajes, en cada apertura de la bandeja) y pasa a pedir el ultimo con un
`LIMIT 1` correlacionado que baja por el indice. El cambio es de COMO se pide,
no de QUE se devuelve, y eso es lo que se comprueba aqui:

  * el mismo desempate por `id` cuando dos mensajes comparten `created_at`
    (en SQLite pasa a cada rato: `now()` tiene resolucion de segundo);
  * lo borrado no cuenta, y si se borro el ultimo se baja al anterior;
  * una conversacion sin mensajes vivos no sale, y no se lleva a las demas;
  * sigue siendo UNA consulta, sean tres conversaciones o treinta;
  * y, sobre datos revueltos, la respuesta es exactamente la de la funcion de
    ventana de antes, que se conserva aqui como referencia.

Se llama a la funcion directamente y no por HTTP: el listado ya tiene sus
pruebas (`test_mensajes_rendimiento.py`) y aqui interesa el caso de borde, que
por HTTP queda tapado por la paginacion y el resto de la fila.
"""

from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.modules.messaging import lectura
from app.modules.messaging.models import Conversation, ConversationMember, Message
from app.modules.profiles.models import Profile
from app.shared.database import Base

pytestmark = pytest.mark.asyncio

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"

ORIGEN = datetime(2026, 10, 28, 12, 0, 0, tzinfo=timezone.utc)


def _instante(segundos: int) -> datetime:
    return ORIGEN + timedelta(seconds=segundos)


def _conv(n: int) -> str:
    return f"cccccccc-0000-0000-0000-{n:012d}"


def _msg(conv: int, n: int) -> str:
    return f"dddddddd-{conv:04d}-0000-0000-{n:012d}"


@pytest_asyncio.fixture
async def sesiones():
    motor = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with motor.begin() as conn:
        from app.modules.messaging import models as _m  # noqa: F401
        from app.modules.profiles import models as _p  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)
    hacer = async_sessionmaker(motor, expire_on_commit=False)
    async with hacer() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        await db.commit()
    yield hacer
    await motor.dispose()


async def _conversacion(db, n: int) -> str:
    cid = _conv(n)
    db.add(Conversation(id=cid, kind="direct", created_by=ANA))
    db.add(ConversationMember(conversation_id=cid, user_id=ANA))
    db.add(ConversationMember(conversation_id=cid, user_id=BRUNO))
    return cid


def _mensaje(conv: int, n: int, segundos: int, *, borrado: bool = False, quien: str = BRUNO) -> Message:
    return Message(
        id=_msg(conv, n),
        conversation_id=_conv(conv),
        sender_id=quien,
        body=f"c{conv} m{n}",
        created_at=_instante(segundos),
        deleted_at=_instante(segundos + 1) if borrado else None,
    )


async def _referencia_con_ventana(db, ids: list[str]) -> dict[str, tuple]:
    """La implementacion ANTERIOR, tal cual, para comparar contra ella."""
    orden = (
        func.row_number()
        .over(
            partition_by=Message.conversation_id,
            order_by=(Message.created_at.desc(), Message.id.desc()),
        )
        .label("posicion")
    )
    numerados = (
        select(
            Message.id.label("id"),
            Message.conversation_id.label("conversation_id"),
            Message.sender_id.label("sender_id"),
            Message.body.label("body"),
            Message.created_at.label("created_at"),
            orden,
        )
        .where(Message.conversation_id.in_(ids), Message.deleted_at.is_(None))
        .subquery()
    )
    filas = (
        await db.execute(
            select(
                numerados.c.id,
                numerados.c.conversation_id,
                numerados.c.sender_id,
                numerados.c.body,
                numerados.c.created_at,
            ).where(numerados.c.posicion == 1)
        )
    ).all()
    return {f.conversation_id: tuple(f) for f in filas}


def _contar_selects(hacer):
    consultas: list[str] = []

    def _anotar(conn, cursor, statement, *args):  # noqa: ANN001
        if statement.lstrip().lower().startswith("select"):
            consultas.append(statement)

    motor = hacer.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _anotar)
    return consultas, lambda: event.remove(motor, "before_cursor_execute", _anotar)


# --------------------------------------------------------------------------- #
async def test_un_empate_en_created_at_lo_decide_el_id(sesiones):
    """Tres mensajes en el MISMO instante: gana el de `id` mayor, como antes.

    Y un mensaje posterior gana aunque su `id` sea menor: el `id` solo
    desempata, no ordena.
    """
    async with sesiones() as db:
        await _conversacion(db, 1)
        await _conversacion(db, 2)
        # Conversacion 1: empate a tres en el segundo 10; los ids no van en
        # orden de insercion a proposito.
        db.add(_mensaje(1, 1, 10))
        db.add(_mensaje(1, 3, 10))
        db.add(_mensaje(1, 2, 10))
        # Conversacion 2: el mas reciente tiene el id MAS PEQUENO.
        db.add(_mensaje(2, 9, 10))
        db.add(_mensaje(2, 1, 20))
        await db.commit()

        ultimos = await lectura.ultimos_mensajes(db, [_conv(1), _conv(2)])

    assert str(ultimos[_conv(1)].id) == _msg(1, 3)
    assert str(ultimos[_conv(2)].id) == _msg(2, 1)


async def test_lo_borrado_no_cuenta_y_se_baja_al_anterior(sesiones):
    async with sesiones() as db:
        await _conversacion(db, 1)
        await _conversacion(db, 2)
        db.add(_mensaje(1, 1, 10))
        db.add(_mensaje(1, 2, 20))
        # El ultimo, y tambien el que empata con el en el tiempo, borrados.
        db.add(_mensaje(1, 3, 30, borrado=True))
        db.add(_mensaje(1, 4, 30, borrado=True))
        # Conversacion 2: TODO borrado.
        db.add(_mensaje(2, 1, 10, borrado=True))
        db.add(_mensaje(2, 2, 20, borrado=True))
        await db.commit()

        ultimos = await lectura.ultimos_mensajes(db, [_conv(1), _conv(2)])

    assert str(ultimos[_conv(1)].id) == _msg(1, 2)
    assert ultimos[_conv(1)].body == "c1 m2"
    assert _conv(2) not in ultimos, "una conversacion con todo borrado no tiene ultimo"


async def test_una_conversacion_sin_mensajes_no_sale_ni_se_lleva_a_las_demas(sesiones):
    async with sesiones() as db:
        await _conversacion(db, 1)
        await _conversacion(db, 2)
        await _conversacion(db, 3)
        db.add(_mensaje(1, 1, 10))
        db.add(_mensaje(3, 1, 10))
        await db.commit()

        ultimos = await lectura.ultimos_mensajes(db, [_conv(1), _conv(2), _conv(3)])

    assert set(ultimos) == {_conv(1), _conv(3)}


async def test_solo_devuelve_las_conversaciones_pedidas(sesiones):
    async with sesiones() as db:
        for n in (1, 2, 3):
            await _conversacion(db, n)
            db.add(_mensaje(n, 1, 10 * n))
        await db.commit()

        ultimos = await lectura.ultimos_mensajes(db, [_conv(2)])

    assert set(ultimos) == {_conv(2)}


async def test_trae_los_campos_que_usan_la_bandeja_y_los_temas(sesiones):
    """`id`, `conversation_id`, `sender_id`, `body` y `created_at`: los cinco
    que leen `leer_conversaciones`, `subgrupos` y `temas`."""
    async with sesiones() as db:
        await _conversacion(db, 1)
        db.add(_mensaje(1, 1, 10, quien=ANA))
        await db.commit()

        ultimo = (await lectura.ultimos_mensajes(db, [_conv(1)]))[_conv(1)]

    assert str(ultimo.id) == _msg(1, 1)
    assert str(ultimo.conversation_id) == _conv(1)
    assert str(ultimo.sender_id) == ANA
    assert ultimo.body == "c1 m1"
    assert ultimo.created_at.replace(tzinfo=timezone.utc) == _instante(10)


async def test_sin_conversaciones_no_se_consulta(sesiones):
    consultas, quitar = _contar_selects(sesiones)
    try:
        async with sesiones() as db:
            assert await lectura.ultimos_mensajes(db, []) == {}
    finally:
        quitar()
    assert consultas == []


async def test_es_una_sola_consulta_sean_tres_conversaciones_o_treinta(sesiones):
    """Correlacionada no quiere decir «una por conversacion»: la correlacion va
    DENTRO de la consulta. Se mide con dos tamanos y se exige lo mismo."""
    async with sesiones() as db:
        for n in range(30):
            await _conversacion(db, n)
            for k in range(5):
                db.add(_mensaje(n, k, n * 100 + k))
        await db.commit()

    cuentas = []
    for cuantas in (3, 30):
        consultas, quitar = _contar_selects(sesiones)
        try:
            async with sesiones() as db:
                ultimos = await lectura.ultimos_mensajes(db, [_conv(n) for n in range(cuantas)])
        finally:
            quitar()
        assert len(ultimos) == cuantas
        cuentas.append(len(consultas))
    assert cuentas == [1, 1], f"consultas para 3 y para 30 conversaciones: {cuentas}"


async def test_da_lo_mismo_que_la_funcion_de_ventana_de_antes(sesiones):
    """Datos revueltos —empates, borrados, conversaciones vacias— y la misma
    respuesta, fila a fila, que la implementacion anterior."""
    azar = random.Random(20261028)
    ids: list[str] = []
    async with sesiones() as db:
        for n in range(40):
            ids.append(await _conversacion(db, n))
            # Algunas sin mensajes; el resto con pocos instantes distintos para
            # forzar empates, y uno de cada cuatro borrado.
            for k in range(azar.choice([0, 0, 1, 3, 8, 15])):
                db.add(_mensaje(n, k, azar.randint(0, 5), borrado=azar.random() < 0.25))
        await db.commit()

        nueva = {
            str(cid): (str(f.id), str(f.conversation_id), str(f.sender_id), f.body, f.created_at)
            for cid, f in (await lectura.ultimos_mensajes(db, ids)).items()
        }
        antes = {
            str(cid): (str(f[0]), str(f[1]), str(f[2]), f[3], f[4])
            for cid, f in (await _referencia_con_ventana(db, ids)).items()
        }

    assert nueva == antes
    # Que la comparacion no sea trivial: hay vacias y hay llenas.
    assert 0 < len(nueva) < len(ids)
