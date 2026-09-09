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
from app.core.security import AuthUser
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
        await inventory.bloquear_evento(a, evento)  # A se queda con la fila

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


async def test_la_reserva_de_quien_gana_sobrevive_al_conflicto_de_quien_pierde(
    motor, sesiones
) -> None:
    """El estado final después de un conflicto: la ganadora sigue apuntada.

    QUÉ NO PRUEBA ESTO, y se dice para que nadie lo lea como más de lo que es:
    las dos peticiones usan SESIONES DISTINTAS, así que la segunda no podría
    deshacer el trabajo de la primera aunque hiciera `rollback` de todo. Esa
    propiedad es estructural, no algo que esta prueba observe. Se llamaba
    «perder la carrera no deshace...» y aquí no hay ninguna carrera.

    La serialización de verdad la prueba
    `test_mientras_una_reserva_tiene_la_fila_bloqueada_la_otra_espera`.
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
        # SIN `rollback` A MANO. Antes la prueba lo hacía por su cuenta, así
        # que comprobaba una limpieza que el código de producción no hacía: es
        # `reservar` quien suelta la transacción —y el cerrojo— antes de lanzar.
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
    # UNA PERSONA NUEVA, no una de las cuatro. Con alguien ya inscrito se sale
    # por el camino idempotente y nunca se toca el conteo posterior a la
    # inserción, que es justo el que se quiere comprobar.
    nueva = await _persona(motor, "quinta")
    async with sesiones() as db:
        resultado = await inventory.reservar(
            db, evento_id=evento, usuario_id=nueva, momento=inventory.eventos.ahora()
        )

    assert resultado.inscritos == await _confirmadas(motor, evento) == 5


# --------------------------------------------------------------------------- #
# La misma carrera, un nivel más arriba: el ciclo del evento
# --------------------------------------------------------------------------- #

#: 90 sobre 100, dentro de los ocho topes.
PUNTAJES = {
    "propuesta": 18,
    "trayectoria": 14,
    "programa": 14,
    "recinto": 13,
    "seguridad": 13,
    "precio": 9,
    "accesibilidad": 5,
    "afinidad": 4,
}


async def _listo_para_enviar(motor) -> str:
    """Un evento con lo mínimo para que `enviar_a_revision` lo acepte."""
    organizador = await _persona(motor, "org")
    evento = await _evento(motor, organizador, 20, publicado=False)
    async with motor.begin() as conexion:
        await conexion.execute(
            text(
                "update public.events set title = 'Cena', description = "
                "'Una descripcion larga y suficiente para poder revisarla', "
                "event_type = 'online' where id = cast(:e as uuid)"
            ),
            {"e": evento},
        )
        await conexion.execute(
            text(
                "update public.event_operations set workflow_status = 'DRAFT', "
                "promise = 'Algo bueno', category = 'gastronomia' "
                "where event_id = cast(:e as uuid)"
            ),
            {"e": evento},
        )
    return evento


def _como(ident: str) -> AuthUser:
    return AuthUser(id=ident, email="x@y.test", role="authenticated")


async def test_dos_envios_a_la_vez_no_dan_un_500(motor, sesiones) -> None:
    """Dos `submit` simultáneos calculaban el mismo número de versión.

    Chocaban contra `event_versions_correlativa` y el perdedor recibía un 500
    en vez de una respuesta con sentido. Con el cerrojo, el segundo ve el
    evento ya enviado y responde que desde ahí no se puede enviar.

    HASTA DÓNDE LLEGA ESTA PRUEBA. Es probabilista, y además aquí el cerrojo no
    es lo único que serializa: insertar una versión toma un `FOR KEY SHARE`
    sobre la fila del evento por la clave ajena, y eso ya choca con el
    `FOR UPDATE`. Quitar `bloquear_evento` NO la pone roja. Lo que comprueba de
    verdad es el resultado: una sola versión y ningún 500.

    La prueba que sí demuestra el cerrojo del ciclo es
    `test_dos_decisiones_a_la_vez_no_producen_una_transicion_imposible`: allí
    la clave ajena no salva nada, porque la validación ya se hizo contra un
    estado caducado antes de que ninguna fila se insertara.
    """
    from app.modules.events import service

    evento = await _listo_para_enviar(motor)
    async with motor.connect() as conexion:
        organizador = (
            await conexion.execute(
                text("select organizer_id::text from public.events where id = cast(:e as uuid)"),
                {"e": evento},
            )
        ).scalar_one()

    async def envia():
        async with sesiones() as db:
            try:
                await service.enviar_a_revision(
                    db, evento_id=evento, usuario=_como(organizador), motivo=""
                )
                return "ok"
            except ConflictError as error:
                return error

    resultados = await asyncio.gather(envia(), envia(), envia())

    # Uno entra. Los otros dos reciben un conflicto EXPLICADO, no un 500: lo
    # que sube de `enviar_a_revision` es `ConflictError`, y cualquier otra cosa
    # —un `IntegrityError` contra `event_versions_correlativa`, por ejemplo—
    # haria fallar este `gather`, porque solo se captura la primera.
    assert sum(r == "ok" for r in resultados) == 1, resultados
    async with motor.connect() as conexion:
        versiones = (
            await conexion.execute(
                text(
                    "select count(*) from public.event_versions "
                    "where event_id = cast(:e as uuid)"
                ),
                {"e": evento},
            )
        ).scalar_one()
    assert versiones == 1


async def test_dos_decisiones_a_la_vez_no_producen_una_transicion_imposible(
    motor, sesiones
) -> None:
    """EL MISMO FALLO QUE EL DEL AFORO, un nivel más arriba.

    Sin el cerrojo, un `reject` y un `approve` simultáneos sobre un evento en
    SUBMITTED leían los dos ese estado, los dos validaban contra él y los dos
    escribían: quedaba `SUBMITTED -> DRAFT -> APPROVED`, una transición que la
    máquina de estados no permite, con el sello puesto y dos decisiones
    contradictorias en el expediente.
    """
    from app.modules.events import service

    evento = await _listo_para_enviar(motor)
    async with motor.connect() as conexion:
        organizador = (
            await conexion.execute(
                text("select organizer_id::text from public.events where id = cast(:e as uuid)"),
                {"e": evento},
            )
        ).scalar_one()
    async with sesiones() as db:
        await service.enviar_a_revision(
            db, evento_id=evento, usuario=_como(organizador), motivo=""
        )
    revisora = await _persona(motor, "cur")
    async with sesiones() as db:
        await service.evaluar(
            db,
            evento_id=evento,
            puntajes=PUNTAJES,
            evidencia="Recinto confirmado y programa completo.",
            falla_critica=False,
            motivo_de_la_falla="",
            usuario=_como(revisora),
        )

    async def decide(decision: str):
        async with sesiones() as db:
            try:
                await service.decidir(
                    db,
                    evento_id=evento,
                    decision=decision,
                    motivo=f"Porque {decision}",
                    usuario=_como(revisora),
                )
                return "ok"
            except ConflictError as error:
                return error

    resultados = await asyncio.gather(decide("approved"), decide("rejected"))

    assert sum(r == "ok" for r in resultados) == 1, resultados
    async with motor.connect() as conexion:
        estado, sello = (
            await conexion.execute(
                text(
                    "select workflow_status, selection_status "
                    "from public.event_operations where event_id = cast(:e as uuid)"
                ),
                {"e": evento},
            )
        ).one()
        decisiones = (
            await conexion.execute(
                text(
                    "select count(*) from public.event_admission_decisions "
                    "where event_id = cast(:e as uuid)"
                ),
                {"e": evento},
            )
        ).scalar_one()

    assert estado in ("APPROVED", "DRAFT")
    assert decisiones == 1, "una decision rechazada no puede dejar fila"
    # Y el sello acompana al estado, nunca al reves.
    assert (sello == "approved") == (estado == "APPROVED")


# --------------------------------------------------------------------------- #
# El tiempo límite del cerrojo
# --------------------------------------------------------------------------- #


async def test_una_espera_demasiado_larga_no_dice_que_el_evento_esta_lleno(
    motor, sesiones, monkeypatch
) -> None:
    """LO QUE NO PUEDE PASAR: que un cerrojo ocupado se cuente como aforo lleno.

    Son dos cosas distintas y la diferencia importa para quien mira la
    pantalla: «no queda sitio» es definitivo y «vuelve a intentarlo» no. Por eso
    el fallo tiene su propio código, `inventory_lock_timeout`, y un 409 con un
    mensaje de reintento.

    Se baja el límite a 300 ms para no tener la prueba esperando cinco segundos.
    """
    from app.core.config import get_settings

    ajustes = get_settings()
    monkeypatch.setattr(ajustes, "inventory_lock_timeout_ms", 300, raising=False)

    organizador = await _persona(motor, "org")
    evento = await _evento(motor, organizador, 10)
    persona = await _persona(motor, "espera")

    async with sesiones() as a:
        await inventory.bloquear_evento(a, evento)  # A se queda con la fila

        async with sesiones() as b:
            with pytest.raises(inventory.CerrojoOcupado) as fallo:
                await inventory.reservar(
                    db=b,
                    evento_id=evento,
                    usuario_id=persona,
                    momento=inventory.eventos.ahora(),
                )
            assert fallo.value.code == "inventory_lock_timeout"
            assert fallo.value.status_code == 409
            # Y NO se apuntó a nadie.
            assert await _confirmadas(motor, evento) == 0

            # LA SESIÓN SIGUE SIRVIENDO. En PostgreSQL una sentencia fallida
            # deja la transacción abortada; si no se deshiciera, lo siguiente
            # que usara esa conexión fallaría por un motivo que no es el suyo.
            otro = await _evento(motor, organizador, 5)
            resultado = await inventory.reservar(
                db=b,
                evento_id=otro,
                usuario_id=persona,
                momento=inventory.eventos.ahora(),
            )
            assert resultado.inscritos == 1


async def test_soltado_el_cerrojo_a_tiempo_la_reserva_entra(
    motor, sesiones, monkeypatch
) -> None:
    """El límite no rechaza lo que llega dentro de plazo."""
    from app.core.config import get_settings

    monkeypatch.setattr(
        get_settings(), "inventory_lock_timeout_ms", 3000, raising=False
    )

    organizador = await _persona(motor, "org")
    evento = await _evento(motor, organizador, 10)
    persona = await _persona(motor, "paciente")

    async with sesiones() as a:
        await inventory.bloquear_evento(a, evento)
        async with sesiones() as b:
            intento = asyncio.create_task(
                inventory.reservar(
                    db=b,
                    evento_id=evento,
                    usuario_id=persona,
                    momento=inventory.eventos.ahora(),
                )
            )
            await asyncio.sleep(0.3)
            assert not intento.done()
            await a.commit()  # se suelta dentro del plazo
            resultado = await intento

    assert resultado.inscritos == 1
    assert await _confirmadas(motor, evento) == 1


async def test_tras_el_tiempo_limite_se_puede_reintentar(
    motor, sesiones, monkeypatch
) -> None:
    """Reintentar es la salida, y funciona en cuanto el otro suelta."""
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "inventory_lock_timeout_ms", 300, raising=False)

    organizador = await _persona(motor, "org")
    evento = await _evento(motor, organizador, 10)
    persona = await _persona(motor, "reintenta")

    async with sesiones() as a:
        await inventory.bloquear_evento(a, evento)
        async with sesiones() as b:
            with pytest.raises(inventory.CerrojoOcupado):
                await inventory.reservar(
                    db=b,
                    evento_id=evento,
                    usuario_id=persona,
                    momento=inventory.eventos.ahora(),
                )
        await a.commit()

    async with sesiones() as b:
        resultado = await inventory.reservar(
            db=b, evento_id=evento, usuario_id=persona, momento=inventory.eventos.ahora()
        )
    assert resultado.inscritos == 1


async def test_el_tiempo_limite_no_deja_pasar_de_aforo(
    motor, sesiones, monkeypatch
) -> None:
    """Ni con el límite puesto se cuela nadie de más.

    El cerrojo con plazo sigue siendo un cerrojo: quien no llega a tomarlo no
    inserta, y quien lo toma cuenta lo que hay.
    """
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "inventory_lock_timeout_ms", 2000, raising=False)

    organizador = await _persona(motor, "org")
    evento = await _evento(motor, organizador, 2)
    personas = [await _persona(motor, f"lim{i}") for i in range(8)]

    resultados = await _a_la_vez(sesiones, evento, personas)

    entraron = sum(r == "ok" for r in resultados)
    assert entraron == 2, resultados
    assert await _confirmadas(motor, evento) == 2


async def test_sin_limite_configurado_no_se_toca_la_base(
    motor, sesiones, monkeypatch
) -> None:
    """Cero desactiva el límite, y entonces no se emite ningún `SET`.

    Lo que se comprueba es que la reserva sigue funcionando igual: el ajuste es
    una decisión de despliegue, no una condición para que el aforo funcione.
    """
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "inventory_lock_timeout_ms", 0, raising=False)

    organizador = await _persona(motor, "org")
    evento = await _evento(motor, organizador, 3)
    persona = await _persona(motor, "sinlimite")

    async with sesiones() as db:
        resultado = await inventory.reservar(
            db=db, evento_id=evento, usuario_id=persona, momento=inventory.eventos.ahora()
        )
    assert resultado.inscritos == 1
