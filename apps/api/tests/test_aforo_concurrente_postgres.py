"""La carrera por el último cupo, CORRIDA de verdad contra PostgreSQL.

POR QUÉ ESTO NO SE PUEDE PROBAR EN SQLITE, que es donde corre el resto de la
suite. SQLite serializa la base entera: no hay dos escritores a la vez, así que
una prueba «concurrente» allí pasaría con el código roto. Y `SELECT ... FOR
UPDATE` no existe en SQLite —SQLAlchemy lo omite al compilar—, de modo que lo
único que arregla el fallo es justo lo único que SQLite no ejecuta.

Aquí se abren N SESIONES DISTINTAS contra un PostgreSQL desechable y se llama a
`inventory.reservar` desde todas a la vez. Es el código de producción, sin
simular, con su bloqueo y su transacción.

CÓMO SE COMPRUEBA QUE LA PRUEBA SIRVE. Con el código anterior —contar, comparar,
insertar— `test_dos_a_la_vez_por_el_ultimo_cupo` deja DOS filas en un aforo de
uno. Está reproducido a mano y anotado en `docs/Z_EVENTOS_ARQUITECTURA.md`.

Se omite sin `MIGRACIONES_DATABASE_URL`, como el resto de pruebas de PostgreSQL.
Omitida NO es aprobada: la línea de CI las ejecuta.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.exceptions import ConflictError, NotFoundError
from app.modules.events import esquema, inventory
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
    """La misma base, por el driver async que usa la aplicación."""
    exigir_url_desechable(URL, os.environ.get("DATABASE_URL", ""))
    return URL.replace("postgresql://", "postgresql+asyncpg://", 1)


@pytest.fixture(scope="module")
def base_aplicada():
    """Un esquema reconstruido desde CERO con las migraciones de verdad.

    No con `Base.metadata.create_all`: lo que se quiere probar convive con la
    clave única real, las claves ajenas reales y el aforo real.

    Se hace UNA vez por módulo y con psycopg —síncrono— porque construir el
    esquema no tiene nada que ver con la carrera y tarda lo suyo.
    """
    import psycopg

    with psycopg.connect(URL, autocommit=True) as conexion:
        with conexion.cursor() as cur:
            cur.execute("drop schema if exists public cascade")
            # Tambien `auth` y `storage`: sus politicas sobreviven a un
            # `drop schema public` y la siguiente migracion choca con ellas.
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
async def motor(base_aplicada):
    """Un motor POR PRUEBA.

    Uno compartido entre pruebas guardaría conexiones atadas al bucle de
    eventos de la primera, y la segunda fallaría con «another operation is in
    progress»: un fallo del andamiaje que no dice nada del aforo.

    Sitio de sobra en el pool: con menos conexiones que corrutinas, la
    «concurrencia» la impondría el pool y no habría carrera que observar.
    """
    motor = create_async_engine(_url_async(), pool_size=20, max_overflow=10)
    yield motor
    await motor.dispose()


@pytest_asyncio.fixture()
async def sesiones(motor):
    return async_sessionmaker(motor, expire_on_commit=False)


async def _persona(motor, etiqueta: str) -> str:
    """Una cuenta, que es lo que crea el perfil (disparador de la 0001)."""
    ident = str(uuid.uuid4())
    async with motor.begin() as conexion:
        await conexion.execute(
            text(
                "insert into auth.users (id, email, raw_user_meta_data) values "
                "(cast(:id as uuid), cast(:email as text), "
                "jsonb_build_object('full_name', 'P', 'username', cast(:u as text)))"
            ),
            {"id": ident, "email": f"{etiqueta}-{ident[:8]}@x.test", "u": f"{etiqueta}{ident[:8]}"},
        )
    return ident


async def _evento(motor, organizador: str, aforo: int | None, *, publicado: bool = True) -> str:
    ident = str(uuid.uuid4())
    async with motor.begin() as conexion:
        await conexion.execute(
            text(
                "insert into public.events "
                "(id, organizer_id, title, description, starts_at, capacity, status) "
                "values (cast(:id as uuid), cast(:org as uuid), 'Evento', 'x', "
                "now() + interval '10 days', cast(:aforo as int), cast(:estado as content_status))"
            ),
            {
                "id": ident,
                "org": organizador,
                "aforo": aforo,
                "estado": "published" if publicado else "draft",
            },
        )
        await conexion.execute(
            text(
                "insert into public.event_operations (event_id, workflow_status, origin) "
                "values (cast(:id as uuid), cast(:estado as text), 'events_v2') "
                "on conflict (event_id) do update set workflow_status = cast(:estado as text)"
            ),
            {"id": ident, "estado": "PUBLISHED" if publicado else "DRAFT"},
        )
    return ident


async def _confirmadas(motor, evento: str) -> int:
    async with motor.connect() as conexion:
        return (
            await conexion.execute(
                text(
                    "select count(*) from public.event_registrations "
                    "where event_id = cast(:e as uuid) and status = 'confirmed'"
                ),
                {"e": evento},
            )
        ).scalar_one()


async def _a_la_vez(sesiones, evento: str, personas: list[str]) -> list[object]:
    """Todas piden el cupo a la vez, cada una con SU sesión.

    Una sesión compartida no probaría nada: la concurrencia que rompía el aforo
    es la de dos conexiones distintas hablando con la misma base.
    """

    async def intenta(persona: str):
        async with sesiones() as db:
            try:
                await inventory.reservar(
                    db,
                    evento_id=evento,
                    usuario_id=persona,
                    momento=inventory.eventos.ahora(),
                )
                return "ok"
            except ConflictError as error:
                return error

    return await asyncio.gather(*[intenta(p) for p in personas])


# --------------------------------------------------------------------------- #
# La carrera
# --------------------------------------------------------------------------- #


async def test_mientras_una_reserva_tiene_la_fila_bloqueada_la_otra_espera(
    motor, sesiones
) -> None:
    """LA PRUEBA QUE DEMUESTRA EL ARREGLO, y la única que no depende de la suerte.

    Las de más abajo lanzan N peticiones a la vez y miran el resultado; son la
    comprobación de punta a punta, pero el planificador decide cuánto se solapan
    y con poca gente pueden serializarse solas. Esta no: fija el orden a mano.

        A  ->  bloquea la fila del evento y NO confirma
        B  ->  pide el cupo: se queda esperando en el `select ... for update`
        A  ->  ocupa el último sitio y confirma
        B  ->  despierta, cuenta lo que hay AHORA y ve el evento lleno

    El paso que importa es el segundo. SIN el bloqueo, B no espera: lee cero,
    inserta y el evento acaba con dos personas en un aforo de una. Comprobado
    quitando `with_for_update()`: esta prueba se pone roja.
    """
    organizador = await _persona(motor, "org")
    evento = await _evento(motor, organizador, 1)
    primera = await _persona(motor, "bloquea")
    segunda = await _persona(motor, "espera")

    async with sesiones() as a:
        await inventory._bloquear(a, evento)  # A se queda con la fila

        async with sesiones() as b:
            intento = asyncio.create_task(
                inventory.reservar(
                    db=b,
                    evento_id=evento,
                    usuario_id=segunda,
                    momento=inventory.eventos.ahora(),
                )
            )
            # B TIENE que seguir esperando. Medio segundo es una eternidad para
            # una consulta local; si termina, es que nadie la detuvo.
            await asyncio.sleep(0.5)
            assert not intento.done(), (
                "la segunda reserva no espero al cerrojo: sin el, las dos "
                "leen el mismo conteo y las dos entran"
            )

            a.add(
                inventory.EventRegistration(
                    event_id=evento, user_id=primera, status="confirmed"
                )
            )
            await a.commit()

            with pytest.raises(ConflictError):
                await intento

    assert await _confirmadas(motor, evento) == 1


async def test_dos_a_la_vez_por_el_ultimo_cupo(motor, sesiones) -> None:
    """El fallo original, de punta a punta.

    Con el código anterior las dos podían entrar y el evento acababa con 2 de 1.
    Cuánto se solapan lo decide el planificador: la garantía está en la prueba
    de arriba, que fija el orden.
    """
    organizador = await _persona(motor, "org")
    evento = await _evento(motor, organizador, 1)
    personas = [await _persona(motor, "a"), await _persona(motor, "b")]

    resultados = await _a_la_vez(sesiones, evento, personas)

    assert sorted(r == "ok" for r in resultados) == [False, True], resultados
    assert await _confirmadas(motor, evento) == 1


async def test_diez_a_la_vez_por_un_solo_cupo(motor, sesiones) -> None:
    organizador = await _persona(motor, "org")
    evento = await _evento(motor, organizador, 1)
    personas = [await _persona(motor, f"p{i}") for i in range(10)]

    resultados = await _a_la_vez(sesiones, evento, personas)

    assert sum(r == "ok" for r in resultados) == 1
    assert await _confirmadas(motor, evento) == 1
    # Y las nueve que pierden reciben un conflicto explicado, no un 500.
    for fallo in [r for r in resultados if r != "ok"]:
        assert "capacidad" in str(fallo)


async def test_diez_a_la_vez_por_tres_cupos(motor, sesiones) -> None:
    """El aforo se agota EXACTO. Ni uno de más ni uno de menos."""
    organizador = await _persona(motor, "org")
    evento = await _evento(motor, organizador, 3)
    personas = [await _persona(motor, f"q{i}") for i in range(10)]

    resultados = await _a_la_vez(sesiones, evento, personas)

    assert sum(r == "ok" for r in resultados) == 3
    assert await _confirmadas(motor, evento) == 3


async def test_la_misma_persona_pulsando_diez_veces_ocupa_un_sitio(motor, sesiones) -> None:
    """Un doble toque —o diez— no consume diez cupos ni devuelve un error."""
    organizador = await _persona(motor, "org")
    evento = await _evento(motor, organizador, 5)
    persona = await _persona(motor, "unica")

    resultados = await _a_la_vez(sesiones, evento, [persona] * 10)

    assert all(r == "ok" for r in resultados), resultados
    assert await _confirmadas(motor, evento) == 1


async def test_sin_aforo_entran_todos(motor, sesiones) -> None:
    """Compatibilidad: un evento sin límite sigue admitiendo a quien llegue."""
    organizador = await _persona(motor, "org")
    evento = await _evento(motor, organizador, None)
    personas = [await _persona(motor, f"r{i}") for i in range(8)]

    resultados = await _a_la_vez(sesiones, evento, personas)

    assert all(r == "ok" for r in resultados)
    assert await _confirmadas(motor, evento) == 8


async def test_el_aforo_aprobado_manda_sobre_el_declarado(motor, sesiones) -> None:
    """Se pidieron 5 y se aprobaron 2: entran 2.

    Es la diferencia entre `capacity` y `approved_capacity`, y sin ella un
    organizador podría admitir a quien nadie autorizó con solo editar su ficha.
    """
    organizador = await _persona(motor, "org")
    evento = await _evento(motor, organizador, 5)
    async with motor.begin() as conexion:
        await conexion.execute(
            text(
                "update public.event_operations set approved_capacity = 2 "
                "where event_id = cast(:e as uuid)"
            ),
            {"e": evento},
        )
    personas = [await _persona(motor, f"s{i}") for i in range(6)]

    resultados = await _a_la_vez(sesiones, evento, personas)

    assert sum(r == "ok" for r in resultados) == 2
    assert await _confirmadas(motor, evento) == 2


async def test_perder_la_carrera_no_deshace_la_reserva_de_quien_la_gano(
    motor, sesiones
) -> None:
    """El fallo de una petición no puede tocar el trabajo de otra.

    Es la propiedad que un `rollback` mal puesto rompe sin hacer ruido: la que
    pierde deshace la transacción, y con ella la fila que la ganadora acababa
    de confirmar.
    """
    organizador = await _persona(motor, "org")
    evento = await _evento(motor, organizador, 1)
    ganadora = await _persona(motor, "gana")
    perdedora = await _persona(motor, "pierde")

    async with sesiones() as db:
        await inventory.reservar(
            db, evento_id=evento, usuario_id=ganadora, momento=inventory.eventos.ahora()
        )
    async with sesiones() as db:
        with pytest.raises(ConflictError):
            await inventory.reservar(
                db,
                evento_id=evento,
                usuario_id=perdedora,
                momento=inventory.eventos.ahora(),
            )

    assert await _confirmadas(motor, evento) == 1
    async with motor.connect() as conexion:
        quien = (
            await conexion.execute(
                text(
                    "select user_id::text from public.event_registrations "
                    "where event_id = cast(:e as uuid)"
                ),
                {"e": evento},
            )
        ).scalar_one()
    assert quien == ganadora


async def test_cancelar_libera_el_cupo_y_otro_puede_entrar(motor, sesiones) -> None:
    organizador = await _persona(motor, "org")
    evento = await _evento(motor, organizador, 1)
    primera = await _persona(motor, "primera")
    segunda = await _persona(motor, "segunda")

    async with sesiones() as db:
        await inventory.reservar(
            db, evento_id=evento, usuario_id=primera, momento=inventory.eventos.ahora()
        )
    async with sesiones() as db:
        with pytest.raises(ConflictError):
            await inventory.reservar(
                db, evento_id=evento, usuario_id=segunda, momento=inventory.eventos.ahora()
            )
    async with sesiones() as db:
        await inventory.cancelar(db, evento_id=evento, usuario_id=primera)
    async with sesiones() as db:
        await inventory.reservar(
            db, evento_id=evento, usuario_id=segunda, momento=inventory.eventos.ahora()
        )

    assert await _confirmadas(motor, evento) == 1


async def test_cancelar_lo_que_no_existe_no_es_un_error(motor, sesiones) -> None:
    organizador = await _persona(motor, "org")
    evento = await _evento(motor, organizador, 3)
    nadie = await _persona(motor, "nadie")

    async with sesiones() as db:
        resultado = await inventory.cancelar(db, evento_id=evento, usuario_id=nadie)

    assert resultado.inscritos == 0
    assert resultado.reservada is False


async def test_un_evento_suspendido_no_recibe_reservas(motor, sesiones) -> None:
    organizador = await _persona(motor, "org")
    evento = await _evento(motor, organizador, 10)
    async with motor.begin() as conexion:
        await conexion.execute(
            text(
                "update public.event_operations set workflow_status = 'SUSPENDED' "
                "where event_id = cast(:e as uuid)"
            ),
            {"e": evento},
        )
    persona = await _persona(motor, "tarde")

    async with sesiones() as db:
        with pytest.raises(ConflictError):
            await inventory.reservar(
                db, evento_id=evento, usuario_id=persona, momento=inventory.eventos.ahora()
            )

    assert await _confirmadas(motor, evento) == 0


async def test_un_borrador_no_dice_ni_que_existe(motor, sesiones) -> None:
    """404 y no 409: un borrador ajeno no existe para quien no lo organiza."""
    organizador = await _persona(motor, "org")
    evento = await _evento(motor, organizador, 10, publicado=False)
    persona = await _persona(motor, "curiosa")

    async with sesiones() as db:
        with pytest.raises(NotFoundError):
            await inventory.reservar(
                db, evento_id=evento, usuario_id=persona, momento=inventory.eventos.ahora()
            )

    assert await _confirmadas(motor, evento) == 0


async def test_una_transaccion_que_falla_no_queda_inservible(motor, sesiones) -> None:
    """Después de un conflicto, la misma sesión sigue sirviendo.

    En PostgreSQL una sentencia fallida deja la transacción abortada y TODO lo
    que venga después revienta con «current transaction is aborted». Si el
    conflicto se resolviera dejando la sesión rota, el siguiente uso de esa
    conexión fallaría por un motivo que no tiene nada que ver.
    """
    organizador = await _persona(motor, "org")
    # Lleno de verdad: `events_capacity_check` no admite un aforo de cero, asi
    # que se llena con alguien. Es ademas el caso real.
    lleno = await _evento(motor, organizador, 1)
    libre = await _evento(motor, organizador, 5)
    ocupa = await _persona(motor, "ocupa")
    async with sesiones() as db:
        await inventory.reservar(
            db, evento_id=lleno, usuario_id=ocupa, momento=inventory.eventos.ahora()
        )
    persona = await _persona(motor, "reintenta")

    async with sesiones() as db:
        with pytest.raises(ConflictError):
            await inventory.reservar(
                db, evento_id=lleno, usuario_id=persona, momento=inventory.eventos.ahora()
            )
        await db.rollback()
        resultado = await inventory.reservar(
            db, evento_id=libre, usuario_id=persona, momento=inventory.eventos.ahora()
        )

    assert resultado.inscritos == 1


async def test_el_conteo_que_se_devuelve_es_el_de_las_confirmadas(motor, sesiones) -> None:
    """Lo que se enseña coincide con lo que hay en la base."""
    organizador = await _persona(motor, "org")
    evento = await _evento(motor, organizador, 10)
    personas = [await _persona(motor, f"t{i}") for i in range(4)]

    await _a_la_vez(sesiones, evento, personas)
    async with sesiones() as db:
        resultado = await inventory.reservar(
            db,
            evento_id=evento,
            usuario_id=personas[0],
            momento=inventory.eventos.ahora(),
        )

    assert resultado.inscritos == await _confirmadas(motor, evento) == 4
