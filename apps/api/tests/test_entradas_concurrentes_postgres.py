"""La carrera por la última entrada, CORRIDA contra PostgreSQL.

Mismo motivo que la del aforo gratuito: SQLite serializa la base entera, así que
una prueba «concurrente» allí pasaría con el código roto, y `SELECT ... FOR
UPDATE` ni siquiera se compila. Aquí se abren N sesiones distintas y se llama al
código de producción desde todas a la vez.

LO QUE SE PRUEBA AQUÍ Y NO EN SQLITE: que dos personas no se lleven la misma
entrada, que un cupo se agote exacto, que dos tipos que comparten aforo no se
pasen entre los dos, y que una reserva vencida deje de ocupar sin esperar a la
limpieza.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.exceptions import AppError
from app.modules.catalog.models import Event
from app.modules.events import esquema, ticketing
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
    exigir_url_desechable(URL, os.environ.get("DATABASE_URL", ""))
    return URL.replace("postgresql://", "postgresql+asyncpg://", 1)


@pytest.fixture(scope="module")
def base_aplicada():
    """Esquema reconstruido con las migraciones de verdad, una sola vez."""
    import psycopg

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
    """Un motor POR PRUEBA, y la bandera encendida solo aquí."""
    monkeypatch.setattr(get_settings(), "feature_event_ticketing", True, raising=False)
    # LA ESPERA, FIJADA. Varias pruebas de este fichero serializan diez
    # transacciones sobre la misma fila y dan por hecho que ninguna se rinde por
    # tiempo; con el valor de producción (5 s) eso es cierto en un portátil y
    # deja de serlo en una integración continua cargada, y la prueba se volvía
    # intermitente sin que el código cambiara. El tiempo límite tiene sus
    # propias pruebas, en `test_aforo_concurrente_postgres.py`.
    monkeypatch.setattr(
        get_settings(), "inventory_lock_timeout_ms", 30000, raising=False
    )
    motor = create_async_engine(_url_async(), pool_size=20, max_overflow=10)
    yield motor
    await motor.dispose()


@pytest_asyncio.fixture()
async def sesiones(motor):
    return async_sessionmaker(motor, expire_on_commit=False)


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


async def _evento_con_entradas(motor, aforo: int | None = None) -> str:
    """Un evento publicado y configurado para vender."""
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


async def _tipo(
    motor, evento: str, *, cupo: int, precio: int = 4900, maximo: int = 10
) -> str:
    ident = str(uuid.uuid4())
    async with motor.begin() as conexion:
        await conexion.execute(
            text(
                "insert into public.event_ticket_types "
                "(id, event_id, name, price_minor, currency, quota, max_per_order, status) "
                "values (cast(:id as uuid), cast(:e as uuid), 'General', "
                "        cast(:p as int), 'PEN', cast(:q as int), cast(:m as int), 'on_sale')"
            ),
            {"id": ident, "e": evento, "p": precio, "q": cupo, "m": maximo},
        )
    return ident


async def _apartadas(motor, evento: str) -> int:
    """Cuántas entradas ocupan inventario AHORA."""
    async with motor.connect() as conexion:
        return (
            await conexion.execute(
                text(
                    "select coalesce(sum(i.quantity), 0) "
                    "from public.event_ticket_hold_items i "
                    "join public.event_ticket_holds h on h.id = i.hold_id "
                    "where h.event_id = cast(:e as uuid) and h.status = 'ACTIVE' "
                    "  and h.expires_at > now()"
                ),
                {"e": evento},
            )
        ).scalar_one()


async def _a_la_vez(sesiones, evento: str, personas, tipo: str, cantidad: int = 1):
    """Todas piden a la vez, cada una con SU sesión y su clave."""

    async def intenta(persona: str):
        async with sesiones() as db:
            try:
                await ticketing.crear_hold(
                    db,
                    evento_id=evento,
                    usuario_id=persona,
                    pedido=[(tipo, cantidad)],
                    clave=f"k-{persona[:8]}",
                )
                return "ok"
            except AppError as error:
                return error

    return await asyncio.gather(*[intenta(p) for p in personas])


# --------------------------------------------------------------------------- #
# La carrera
# --------------------------------------------------------------------------- #


async def test_dos_a_la_vez_por_la_ultima_entrada(motor, sesiones) -> None:
    evento = await _evento_con_entradas(motor)
    tipo = await _tipo(motor, evento, cupo=1)
    personas = [await _persona(motor, "a"), await _persona(motor, "b")]

    resultados = await _a_la_vez(sesiones, evento, personas, tipo)

    assert sum(r == "ok" for r in resultados) == 1, resultados
    assert await _apartadas(motor, evento) == 1


async def test_diez_a_la_vez_por_tres_entradas(motor, sesiones) -> None:
    """El cupo se agota EXACTO. Ni una de más."""
    evento = await _evento_con_entradas(motor)
    tipo = await _tipo(motor, evento, cupo=3)
    personas = [await _persona(motor, f"p{i}") for i in range(10)]

    resultados = await _a_la_vez(sesiones, evento, personas, tipo)

    assert sum(r == "ok" for r in resultados) == 3, resultados
    assert await _apartadas(motor, evento) == 3
    for fallo in [r for r in resultados if r != "ok"]:
        assert fallo.code == "event_capacity_exceeded"


async def test_mientras_una_reserva_tiene_la_fila_bloqueada_la_otra_espera(
    motor, sesiones
) -> None:
    """LA PRUEBA DETERMINISTA, la que no depende del planificador.

    Es el mismo cerrojo que usa la reserva gratuita: un evento no puede estar
    repartiendo aforo por dos caminos a la vez.
    """
    from app.modules.events import inventory

    evento = await _evento_con_entradas(motor)
    tipo = await _tipo(motor, evento, cupo=1)
    primera = await _persona(motor, "bloquea")
    segunda = await _persona(motor, "espera")

    async with sesiones() as a:
        await inventory.bloquear_evento(a, evento)  # A se queda con la fila

        async with sesiones() as b:
            intento = asyncio.create_task(
                ticketing.crear_hold(
                    db=b,
                    evento_id=evento,
                    usuario_id=segunda,
                    pedido=[(tipo, 1)],
                    clave="espera",
                )
            )
            await asyncio.sleep(0.5)
            assert not intento.done(), (
                "la segunda no espero al cerrojo: sin el, las dos leen la misma "
                "disponibilidad y las dos apartan la ultima entrada"
            )
            await a.commit()
            assert await intento is not None

    assert await _apartadas(motor, evento) == 1
    # Y la primera, que nunca llego a pedir, no aparto nada.
    async with motor.connect() as conexion:
        de_la_primera = (
            await conexion.execute(
                text(
                    "select count(*) from public.event_ticket_holds "
                    "where event_id = cast(:e as uuid) and user_id = cast(:u as uuid)"
                ),
                {"e": evento, "u": primera},
            )
        ).scalar_one()
    assert de_la_primera == 0


async def test_dos_tipos_comparten_el_aforo_general(motor, sesiones) -> None:
    """Los cupos suman más que el aforo: manda el aforo.

    Sin esto, dos tipos de cinco en un evento de tres venden seis entradas para
    una sala en la que caben tres personas.
    """
    evento = await _evento_con_entradas(motor, aforo=3)
    barato = await _tipo(motor, evento, cupo=5, precio=1000)
    caro = await _tipo(motor, evento, cupo=5, precio=9000)
    personas = [await _persona(motor, f"m{i}") for i in range(8)]

    async def intenta(persona: str, tipo: str):
        async with sesiones() as db:
            try:
                await ticketing.crear_hold(
                    db,
                    evento_id=evento,
                    usuario_id=persona,
                    pedido=[(tipo, 1)],
                    clave=f"k-{persona[:8]}",
                )
                return "ok"
            except AppError as error:
                return error

    resultados = await asyncio.gather(
        *[
            intenta(persona, barato if i % 2 == 0 else caro)
            for i, persona in enumerate(personas)
        ]
    )

    assert sum(r == "ok" for r in resultados) == 3, resultados
    assert await _apartadas(motor, evento) == 3


async def test_un_evento_sin_aforo_solo_lo_limita_el_cupo(motor, sesiones) -> None:
    evento = await _evento_con_entradas(motor, aforo=None)
    tipo = await _tipo(motor, evento, cupo=4)
    personas = [await _persona(motor, f"s{i}") for i in range(7)]

    resultados = await _a_la_vez(sesiones, evento, personas, tipo)

    assert sum(r == "ok" for r in resultados) == 4
    assert await _apartadas(motor, evento) == 4


# --------------------------------------------------------------------------- #
# Vencimiento
# --------------------------------------------------------------------------- #


async def test_una_reserva_vencida_deja_de_ocupar_sin_esperar_a_la_limpieza(
    motor, sesiones
) -> None:
    """La disponibilidad no espera a que nadie corra nada."""
    evento = await _evento_con_entradas(motor)
    tipo = await _tipo(motor, evento, cupo=1)
    primera = await _persona(motor, "vieja")
    segunda = await _persona(motor, "nueva")

    async with sesiones() as db:
        hold = await ticketing.crear_hold(
            db, evento_id=evento, usuario_id=primera, pedido=[(tipo, 1)], clave="v1"
        )
    async with motor.begin() as conexion:
        await conexion.execute(
            text(
                "update public.event_ticket_holds set expires_at = now() - interval "
                "'1 second' where id = cast(:h as uuid)"
            ),
            {"h": hold.id},
        )

    # La fila sigue diciendo ACTIVE y ya no ocupa.
    assert await _apartadas(motor, evento) == 0
    async with sesiones() as db:
        nuevo = await ticketing.crear_hold(
            db, evento_id=evento, usuario_id=segunda, pedido=[(tipo, 1)], clave="v2"
        )
    assert nuevo.id != hold.id


async def test_la_limpieza_es_idempotente(motor, sesiones) -> None:
    evento = await _evento_con_entradas(motor)
    tipo = await _tipo(motor, evento, cupo=5)
    persona = await _persona(motor, "limpia")

    async with sesiones() as db:
        hold = await ticketing.crear_hold(
            db, evento_id=evento, usuario_id=persona, pedido=[(tipo, 1)], clave="l1"
        )
    async with motor.begin() as conexion:
        await conexion.execute(
            text(
                "update public.event_ticket_holds set expires_at = now() - interval "
                "'1 second' where id = cast(:h as uuid)"
            ),
            {"h": hold.id},
        )

    async with sesiones() as db:
        primera = await ticketing.vencer_holds(db)
    async with sesiones() as db:
        segunda = await ticketing.vencer_holds(db)

    # SOBRE ESTA RESERVA, no sobre el recuento. `vencer_holds` barre la base
    # entera y el esquema es de ámbito módulo: `primera` cuenta también lo que
    # dejaron otras pruebas, así que por sí solo no dice nada de esta.
    assert primera >= 1
    async with motor.connect() as conexion:
        estado = (
            await conexion.execute(
                text(
                    "select status from public.event_ticket_holds "
                    "where id = cast(:h as uuid)"
                ),
                {"h": hold.id},
            )
        ).scalar_one()
    assert estado == "EXPIRED"
    assert segunda == 0, "correrla dos veces no cambia nada"


async def test_una_reserva_vencida_deja_sitio_para_otra_de_la_misma_persona(
    motor, sesiones
) -> None:
    """El índice parcial exige un solo ACTIVO, y no puede mirar el reloj.

    Lo resuelve el servicio: antes de crear otro, marca vencidos los pasados de
    hora de esa persona. Sin eso, quien deja vencer una reserva no puede hacer
    otra nunca más.
    """
    evento = await _evento_con_entradas(motor)
    tipo = await _tipo(motor, evento, cupo=5)
    persona = await _persona(motor, "otra_vez")

    async with sesiones() as db:
        viejo = await ticketing.crear_hold(
            db, evento_id=evento, usuario_id=persona, pedido=[(tipo, 1)], clave="x1"
        )
    async with motor.begin() as conexion:
        await conexion.execute(
            text(
                "update public.event_ticket_holds set expires_at = now() - interval "
                "'1 second' where id = cast(:h as uuid)"
            ),
            {"h": viejo.id},
        )

    async with sesiones() as db:
        nuevo = await ticketing.crear_hold(
            db, evento_id=evento, usuario_id=persona, pedido=[(tipo, 2)], clave="x2"
        )
    assert nuevo.id != viejo.id
    assert nuevo.subtotal_minor == 9800


# --------------------------------------------------------------------------- #
# Idempotencia
# --------------------------------------------------------------------------- #


async def test_la_misma_clave_a_la_vez_no_aparta_el_doble(motor, sesiones) -> None:
    """Un reintento de la red que llega mientras el primero sigue en vuelo."""
    evento = await _evento_con_entradas(motor)
    tipo = await _tipo(motor, evento, cupo=10)
    persona = await _persona(motor, "reintenta")

    async def intenta():
        async with sesiones() as db:
            try:
                hold = await ticketing.crear_hold(
                    db,
                    evento_id=evento,
                    usuario_id=persona,
                    pedido=[(tipo, 2)],
                    clave="la-misma",
                )
                return hold.id
            except AppError as error:
                return error

    resultados = await asyncio.gather(intenta(), intenta(), intenta())
    ids = {r for r in resultados if isinstance(r, str)}

    # O todas devuelven la misma reserva, o las que pierden la carrera reciben
    # un conflicto explicado. Lo que NO puede pasar es que se aparte el doble.
    # `<= 1` pasaba vacío si fallaban las tres. Una gana, siempre: la clave es
    # la misma, así que las otras dos reciben esa misma reserva o un conflicto.
    assert len(ids) == 1, resultados
    assert await _apartadas(motor, evento) == 2


async def test_la_misma_clave_con_otro_pedido_es_un_conflicto(motor, sesiones) -> None:
    evento = await _evento_con_entradas(motor)
    tipo = await _tipo(motor, evento, cupo=10)
    persona = await _persona(motor, "cambia")

    async with sesiones() as db:
        await ticketing.crear_hold(
            db, evento_id=evento, usuario_id=persona, pedido=[(tipo, 2)], clave="k"
        )
    async with sesiones() as db:
        with pytest.raises(ticketing.ClaveReutilizada):
            await ticketing.crear_hold(
                db, evento_id=evento, usuario_id=persona, pedido=[(tipo, 3)], clave="k"
            )
    assert await _apartadas(motor, evento) == 2


async def test_dos_claves_distintas_del_mismo_usuario_no_evaden_el_limite(
    motor, sesiones
) -> None:
    evento = await _evento_con_entradas(motor)
    tipo = await _tipo(motor, evento, cupo=10, maximo=2)
    persona = await _persona(motor, "listo")

    async with sesiones() as db:
        await ticketing.crear_hold(
            db, evento_id=evento, usuario_id=persona, pedido=[(tipo, 2)], clave="a"
        )
    async with sesiones() as db:
        with pytest.raises(ticketing.YaTienesUnaReserva):
            await ticketing.crear_hold(
                db, evento_id=evento, usuario_id=persona, pedido=[(tipo, 2)], clave="b"
            )
    assert await _apartadas(motor, evento) == 2


# --------------------------------------------------------------------------- #
# Precios
# --------------------------------------------------------------------------- #


async def test_el_precio_lo_pone_la_base_y_se_congela(motor, sesiones) -> None:
    evento = await _evento_con_entradas(motor)
    tipo = await _tipo(motor, evento, cupo=10, precio=4900)
    persona = await _persona(motor, "precio")

    async with sesiones() as db:
        hold = await ticketing.crear_hold(
            db, evento_id=evento, usuario_id=persona, pedido=[(tipo, 3)], clave="p"
        )
    assert hold.subtotal_minor == 14700

    # El organizador sube el precio DESPUES.
    async with motor.begin() as conexion:
        await conexion.execute(
            text(
                "update public.event_ticket_types set price_minor = 9900 "
                "where id = cast(:t as uuid)"
            ),
            {"t": tipo},
        )

    async with motor.connect() as conexion:
        subtotal, unitario = (
            await conexion.execute(
                text(
                    "select h.subtotal_minor, i.unit_price_minor "
                    "from public.event_ticket_holds h "
                    "join public.event_ticket_hold_items i on i.hold_id = h.id "
                    "where h.id = cast(:h as uuid)"
                ),
                {"h": hold.id},
            )
        ).one()
    assert (subtotal, unitario) == (14700, 4900), "la reserva sigue diciendo lo mismo"


async def test_la_suma_de_las_lineas_cuadra_con_la_cabecera(motor, sesiones) -> None:
    """El disparador diferido de la 0061, ejercido por el código de verdad."""
    evento = await _evento_con_entradas(motor)
    barato = await _tipo(motor, evento, cupo=10, precio=1000)
    caro = await _tipo(motor, evento, cupo=10, precio=25000)
    persona = await _persona(motor, "suma")

    async with sesiones() as db:
        hold = await ticketing.crear_hold(
            db,
            evento_id=evento,
            usuario_id=persona,
            pedido=[(barato, 3), (caro, 2)],
            clave="suma",
        )
    assert hold.subtotal_minor == 3 * 1000 + 2 * 25000

    async with motor.connect() as conexion:
        suma = (
            await conexion.execute(
                text(
                    "select sum(subtotal_minor) from public.event_ticket_hold_items "
                    "where hold_id = cast(:h as uuid)"
                ),
                {"h": hold.id},
            )
        ).scalar_one()
    assert suma == hold.subtotal_minor

    # Y AHORA EL DISPARADOR, DE VERDAD. Lo de arriba comprueba que la suma que
    # `crear_hold` escribio es la suma que `crear_hold` calculo: sale verde con
    # el disparador borrado. Lo que lo ejerce es intentar descuadrar la reserva
    # que el codigo real acaba de crear y que la base se niegue AL CONFIRMAR.
    with pytest.raises(IntegrityError):
        async with motor.begin() as conexion:
            await conexion.execute(
                text(
                    "update public.event_ticket_holds set subtotal_minor = 1 "
                    "where id = cast(:h as uuid)"
                ),
                {"h": hold.id},
            )

    async with motor.connect() as conexion:
        intacto = (
            await conexion.execute(
                text(
                    "select subtotal_minor from public.event_ticket_holds "
                    "where id = cast(:h as uuid)"
                ),
                {"h": hold.id},
            )
        ).scalar_one()
    assert intacto == hold.subtotal_minor, "el rechazo no dejo la reserva a medias"


async def test_bajar_el_cupo_mientras_alguien_aparta_no_se_cruza(motor, sesiones) -> None:
    """La carrera del ORGANIZADOR, que no tenía prueba.

    `editar_tipo` leía cuántas entradas hay apartadas y decidía con ese número
    sin tomar la fila del evento. Entre la lectura y la escritura cabía una
    reserva entera: el organizador bajaba el cupo a 2 sobre una lectura de cero
    apartadas mientras alguien apartaba 4, y quedaban cuatro entradas apartadas
    sobre un cupo de dos.

    Con el cerrojo puesto en los dos caminos, una de las dos operaciones ve el
    resultado de la otra: o la reserva no cabe, o el cupo no baja.
    """
    evento = await _evento_con_entradas(motor)
    tipo = await _tipo(motor, evento, cupo=10)
    persona = await _persona(motor, "aparta")
    organizador = await _persona(motor, "organiza")

    class _Usuario:
        id = organizador

    async def aparta():
        async with sesiones() as db:
            try:
                await ticketing.crear_hold(
                    db,
                    evento_id=evento,
                    usuario_id=persona,
                    pedido=[(tipo, 4)],
                    clave="carrera",
                )
                return "apartado"
            except AppError as error:
                return error

    async def baja_el_cupo():
        async with sesiones() as db:
            evento_orm = await db.get(Event, evento)
            try:
                await ticketing.editar_tipo(
                    db,
                    evento=evento_orm,
                    tipo_id=tipo,
                    datos={"quota": 2},
                    usuario=_Usuario(),
                )
                return "bajado"
            except AppError as error:
                await db.rollback()
                return error

    uno, dos = await asyncio.gather(aparta(), baja_el_cupo())

    async with motor.connect() as conexion:
        cupo = (
            await conexion.execute(
                text(
                    "select quota from public.event_ticket_types "
                    "where id = cast(:t as uuid)"
                ),
                {"t": tipo},
            )
        ).scalar_one()
    apartadas = await _apartadas(motor, evento)

    # NO SE AFIRMA QUIÉN GANA: eso lo decide el planificador. Se afirma lo que
    # no puede quedar de ninguna de las dos formas.
    assert apartadas <= cupo, (uno, dos, apartadas, cupo)
    if uno == "apartado":
        assert apartadas == 4
    else:
        assert apartadas == 0


async def test_pasar_a_gratuito_mientras_alguien_aparta_no_se_cruza(
    motor, sesiones
) -> None:
    """La misma carrera con el MODO: un evento gratuito con una reserva
    temporal encima es el estado que el código declara imposible."""
    evento = await _evento_con_entradas(motor)
    tipo = await _tipo(motor, evento, cupo=10)
    persona = await _persona(motor, "aparta-modo")
    organizador = await _persona(motor, "organiza-modo")

    class _Usuario:
        id = organizador

    async def aparta():
        async with sesiones() as db:
            try:
                await ticketing.crear_hold(
                    db,
                    evento_id=evento,
                    usuario_id=persona,
                    pedido=[(tipo, 1)],
                    clave="carrera-modo",
                )
                return "apartado"
            except AppError as error:
                return error

    async def a_gratuito():
        async with sesiones() as db:
            evento_orm = await db.get(Event, evento)
            try:
                await ticketing.guardar_configuracion(
                    db,
                    evento=evento_orm,
                    datos={"access_mode": "FREE_RSVP"},
                    usuario=_Usuario(),
                )
                return "gratuito"
            except AppError as error:
                await db.rollback()
                return error

    uno, dos = await asyncio.gather(aparta(), a_gratuito())

    async with motor.connect() as conexion:
        modo = (
            await conexion.execute(
                text(
                    "select access_mode from public.event_ticketing_settings "
                    "where event_id = cast(:e as uuid)"
                ),
                {"e": evento},
            )
        ).scalar_one()
    apartadas = await _apartadas(motor, evento)

    assert not (modo == "FREE_RSVP" and apartadas > 0), (uno, dos, modo, apartadas)
