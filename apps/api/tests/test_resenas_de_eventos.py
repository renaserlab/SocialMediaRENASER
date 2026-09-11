"""Reseñas de evento: el sello se deriva, no se escribe.

LO QUE DEFIENDEN. Que solo reseñe quien entró de verdad, que nadie valore lo
suyo, que una persona valore una vez, que sin política la función esté apagada,
y que un evento sin reseñas NO tenga una puntuación de cero.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.modules.events import politicas, resenas
from app.modules.events import models as _modelos  # noqa: F401
from app.modules.events.resenas_models import EventReview
from app.modules.profiles import models as _perfiles  # noqa: F401
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


def test_los_cinco_ejes_son_los_del_blueprint() -> None:
    """Contenido, organización, recinto, seguridad y valor. Ni más ni menos."""
    assert resenas.EJES == ("content", "organization", "venue", "safety", "value")


def test_la_resena_publica_no_lleva_la_entrada_ni_el_acceso() -> None:
    """LOS DOS ATAN A UNA PERSONA CON UN ACCESO CONCRETO. El sello ya dice lo
    único que el lector necesita saber."""
    from app.modules.events.resenas_router import ResenaRead

    campos = set(ResenaRead.model_fields)
    assert "ticket_id" not in campos
    assert "checkin_id" not in campos
    assert "asistencia_verificada" in campos


def test_el_modelo_no_tiene_ninguna_columna_de_verificacion_editable() -> None:
    """EL SELLO SE DERIVA. Si existiera un `verified`, alguien podría ponerlo."""
    columnas = {c.name for c in EventReview.__table__.columns}
    assert "verified" not in columnas
    assert "is_verified" not in columnas
    assert "verified_source" not in columnas
    assert "checkin_id" in columnas, "y el que sí está es la prueba real"


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


async def _persona(sesiones, etiqueta="r") -> str:
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


async def _evento_pasado(sesiones, organiza: str) -> str:
    ident = str(uuid.uuid4())
    async with sesiones() as db:
        await db.execute(
            text(
                "insert into public.events (id, organizer_id, title, description,"
                " starts_at, event_type, location, status, capacity) values"
                " (cast(:i as uuid), cast(:o as uuid), 'Concierto', 'Una descripción"
                " suficientemente larga para revisarla.', :s, 'presential', 'Sala',"
                " 'published', 100)"
            ),
            {
                "i": ident,
                "o": organiza,
                "s": datetime.now(timezone.utc) - timedelta(days=2),
            },
        )
        await db.execute(
            text(
                "insert into public.event_operations (event_id, workflow_status,"
                " selection_status, origin) values (cast(:i as uuid), 'PUBLISHED',"
                " 'none', 'events_v2')"
            ),
            {"i": ident},
        )
        await db.commit()
    return ident


async def _entro(sesiones, evento: str, quien: str) -> str:
    """Emite una entrada a esa persona y le registra un check-in correcto."""
    tipo = str(uuid.uuid4())
    hold = str(uuid.uuid4())
    orden = str(uuid.uuid4())
    linea = str(uuid.uuid4())
    entrada = str(uuid.uuid4())
    import hashlib

    momento = datetime.now(timezone.utc)
    async with sesiones() as db:
        await db.execute(
            text(
                "insert into public.event_ticketing_settings (event_id, access_mode,"
                " currency) values (cast(:e as uuid), 'TICKETED', 'PEN')"
                " on conflict do nothing"
            ),
            {"e": evento},
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
            {"h": hold, "e": evento, "u": quien, "k": f"h{hold[:8]}",
             "x": momento + timedelta(minutes=15)},
        )
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
                " cast(:h as uuid), 'PAID', 'PEN', 4900, 4900, :k, 'stripe',"
                " 'sandbox', :ref, :pa)"
            ),
            {"o": orden, "e": evento, "u": quien, "h": hold, "k": f"k{orden[:8]}",
             "ref": f"pi_{orden[:8]}", "pa": momento},
        )
        await db.execute(
            text(
                "insert into public.event_order_items (id, order_id, event_id,"
                " ticket_type_id, ticket_type_name_snapshot, unit_price_minor,"
                " quantity, subtotal_minor) values (cast(:l as uuid),"
                " cast(:o as uuid), cast(:e as uuid), cast(:t as uuid), 'General',"
                " 4900, 1, 4900)"
            ),
            {"l": linea, "o": orden, "e": evento, "t": tipo},
        )
        await db.execute(
            text(
                "insert into public.event_tickets (id, event_id, order_id,"
                " order_item_id, owner_id, ticket_type_id,"
                " ticket_type_name_snapshot, code_hash, credential_hash, status,"
                " checked_in_at) values (cast(:i as uuid), cast(:e as uuid),"
                " cast(:o as uuid), cast(:l as uuid), cast(:u as uuid),"
                " cast(:t as uuid), 'General', :ch, :cr, 'USED', :ci)"
            ),
            {"i": entrada, "e": evento, "o": orden, "l": linea, "u": quien, "t": tipo,
             "ch": hashlib.sha256(f"c{entrada}".encode()).hexdigest(),
             "cr": hashlib.sha256(f"q{entrada}".encode()).hexdigest(),
             "ci": momento},
        )
        await db.execute(
            text(
                "insert into public.event_checkins (ticket_id, event_id, result)"
                " values (cast(:t as uuid), cast(:e as uuid), 'OK')"
            ),
            {"t": entrada, "e": evento},
        )
        await db.commit()
    return entrada


async def _politica(sesiones, evento: str, **params):
    async with sesiones() as db:
        await politicas.publicar(
            db,
            tipo="review_window",
            version=f"v{uuid.uuid4().hex[:8]}",
            params=params or {"days_after_event": 30},
            evento_id=evento,
        )
        await db.commit()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_politica_la_funcion_esta_apagada(sesiones) -> None:
    """EL PLAZO PARA OPINAR NO ESTÁ DECIDIDO, y no se supone ninguno."""
    organiza = await _persona(sesiones, "org")
    quien = await _persona(sesiones, "asi")
    evento = await _evento_pasado(sesiones, organiza)
    await _entro(sesiones, evento, quien)

    async with sesiones() as db:
        puede, motivo, _ = await resenas.puede_resenar(
            db, evento_id=evento, usuario_id=quien
        )
    assert puede is False
    assert motivo == "policy_not_configured"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_quien_no_entro_no_resena(sesiones) -> None:
    """Sin check-in no hay sello, y sin sello no hay reseña."""
    organiza = await _persona(sesiones, "org")
    nadie = await _persona(sesiones, "nad")
    evento = await _evento_pasado(sesiones, organiza)
    await _politica(sesiones, evento)

    async with sesiones() as db:
        puede, motivo, _ = await resenas.puede_resenar(
            db, evento_id=evento, usuario_id=nadie
        )
    assert puede is False
    assert motivo == "no_check_in"

    async with sesiones() as db:
        with pytest.raises(resenas.ResenaNoPermitida):
            await resenas.crear(
                db, evento_id=evento, usuario_id=nadie, overall=5
            )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_nadie_valora_lo_suyo(sesiones) -> None:
    organiza = await _persona(sesiones, "org")
    evento = await _evento_pasado(sesiones, organiza)
    await _politica(sesiones, evento)

    async with sesiones() as db:
        puede, motivo, _ = await resenas.puede_resenar(
            db, evento_id=evento, usuario_id=organiza
        )
    assert puede is False
    assert motivo == "own_event"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_quien_entro_si_resena_y_queda_con_su_acceso(sesiones) -> None:
    """Y la reseña apunta al check-in que la respalda: el sello se puede
    reconstruir, no se cree."""
    organiza = await _persona(sesiones, "org")
    quien = await _persona(sesiones, "asi")
    evento = await _evento_pasado(sesiones, organiza)
    entrada = await _entro(sesiones, evento, quien)
    await _politica(sesiones, evento)

    async with sesiones() as db:
        resena = await resenas.crear(
            db,
            evento_id=evento,
            usuario_id=quien,
            overall=4,
            ejes={"content": 5, "organization": 4, "venue": 3, "safety": 5, "value": 4},
            recomienda=True,
            comentario="Muy bueno",
        )
        await db.commit()
        identificador = resena.id

    async with sesiones() as db:
        fresca = await db.get(EventReview, identificador)
    assert fresca.checkin_id is not None
    assert fresca.ticket_id == entrada
    assert fresca.overall == 4
    assert fresca.content == 5


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_persona_valora_una_vez(sesiones) -> None:
    organiza = await _persona(sesiones, "org")
    quien = await _persona(sesiones, "asi")
    evento = await _evento_pasado(sesiones, organiza)
    await _entro(sesiones, evento, quien)
    await _politica(sesiones, evento)

    async with sesiones() as db:
        await resenas.crear(db, evento_id=evento, usuario_id=quien, overall=5)
        await db.commit()
    async with sesiones() as db:
        with pytest.raises(resenas.ResenaDuplicada):
            await resenas.crear(db, evento_id=evento, usuario_id=quien, overall=1)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_evento_sin_resenas_no_tiene_promedio_cero(sesiones) -> None:
    """NO TIENE PUNTUACIÓN, que es distinto de tener un cero. Pintar `0.0` o
    cinco estrellas vacías dice algo que nadie ha dicho."""
    organiza = await _persona(sesiones, "org")
    evento = await _evento_pasado(sesiones, organiza)

    async with sesiones() as db:
        r = await resenas.resumen(db, evento_id=evento)
    assert r.total == 0
    assert r.promedio is None, "None, no 0.0"
    assert r.recomiendan_bps is None
    assert all(v is None for v in r.por_eje.values())


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_resumen_calcula_promedio_histograma_y_recomendacion(sesiones) -> None:
    organiza = await _persona(sesiones, "org")
    evento = await _evento_pasado(sesiones, organiza)
    await _politica(sesiones, evento)
    for nota, recomienda in ((5, True), (3, False), (4, True)):
        quien = await _persona(sesiones, "asi")
        await _entro(sesiones, evento, quien)
        async with sesiones() as db:
            await resenas.crear(
                db,
                evento_id=evento,
                usuario_id=quien,
                overall=nota,
                ejes={"content": nota},
                recomienda=recomienda,
            )
            await db.commit()

    async with sesiones() as db:
        r = await resenas.resumen(db, evento_id=evento)
    assert r.total == 3
    assert r.promedio == 4.0
    assert r.histograma == {5: 1, 4: 1, 3: 1}
    assert r.recomiendan_bps == round(2 * 10_000 / 3)
    assert r.por_eje["content"] == 4.0
    assert r.por_eje["venue"] is None, "nadie puntuó ese eje"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_resena_escondida_no_cuenta_en_el_resumen(sesiones) -> None:
    """Moderar es esconder, no borrar: la fila se queda y deja de contar."""
    organiza = await _persona(sesiones, "org")
    quien = await _persona(sesiones, "asi")
    modera = await _persona(sesiones, "mod")
    evento = await _evento_pasado(sesiones, organiza)
    await _entro(sesiones, evento, quien)
    await _politica(sesiones, evento)

    async with sesiones() as db:
        resena = await resenas.crear(
            db, evento_id=evento, usuario_id=quien, overall=1
        )
        await db.commit()
        identificador = resena.id

    async with sesiones() as db:
        await resenas.moderar(
            db, resena_id=identificador, actor_id=modera, esconder=True, motivo="insultos"
        )
        await db.commit()

    async with sesiones() as db:
        r = await resenas.resumen(db, evento_id=evento)
        fresca = await db.get(EventReview, identificador)
    assert r.total == 0
    assert fresca is not None, "no se borra"
    assert fresca.status == "hidden"
    assert fresca.overall == 1, "moderar no cambia la puntuación"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_responder_sin_politica_no_se_puede(sesiones) -> None:
    """La respuesta pública NACE APAGADA: sin reglas de moderación ni límites
    aprobados, publicarla expone a quien opinó."""
    organiza = await _persona(sesiones, "org")
    quien = await _persona(sesiones, "asi")
    evento = await _evento_pasado(sesiones, organiza)
    await _entro(sesiones, evento, quien)
    await _politica(sesiones, evento)

    async with sesiones() as db:
        resena = await resenas.crear(db, evento_id=evento, usuario_id=quien, overall=5)
        await db.commit()
        identificador = resena.id

    async with sesiones() as db:
        with pytest.raises(resenas.ResenaNoPermitida) as fallo:
            await resenas.responder(
                db, resena_id=identificador, usuario_id=organiza, texto="Gracias"
            )
    assert fallo.value.code == "event_reply_not_configured"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_organizador_ajeno_no_responde(sesiones) -> None:
    """Y recibe 404: quien no organiza ese evento no tiene por qué saber que
    esa reseña existe."""
    organiza = await _persona(sesiones, "org")
    ajeno = await _persona(sesiones, "aje")
    quien = await _persona(sesiones, "asi")
    evento = await _evento_pasado(sesiones, organiza)
    await _entro(sesiones, evento, quien)
    await _politica(sesiones, evento)
    async with sesiones() as db:
        await politicas.publicar(
            db,
            tipo="organizer_reply",
            version=f"v{uuid.uuid4().hex[:8]}",
            params={"allow_reply": True},
            evento_id=evento,
        )
        await db.commit()

    async with sesiones() as db:
        resena = await resenas.crear(db, evento_id=evento, usuario_id=quien, overall=5)
        await db.commit()
        identificador = resena.id

    async with sesiones() as db:
        with pytest.raises(resenas.ResenaNoEncontrada):
            await resenas.responder(
                db, resena_id=identificador, usuario_id=ajeno, texto="Mía"
            )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_con_politica_el_organizador_responde_una_vez(sesiones) -> None:
    organiza = await _persona(sesiones, "org")
    quien = await _persona(sesiones, "asi")
    evento = await _evento_pasado(sesiones, organiza)
    await _entro(sesiones, evento, quien)
    await _politica(sesiones, evento)
    async with sesiones() as db:
        await politicas.publicar(
            db,
            tipo="organizer_reply",
            version=f"v{uuid.uuid4().hex[:8]}",
            params={"allow_reply": True},
            evento_id=evento,
        )
        await db.commit()

    async with sesiones() as db:
        resena = await resenas.crear(db, evento_id=evento, usuario_id=quien, overall=5)
        await db.commit()
        identificador = resena.id

    async with sesiones() as db:
        await resenas.responder(
            db, resena_id=identificador, usuario_id=organiza, texto="Gracias"
        )
        await db.commit()

    from app.core.exceptions import ConflictError

    async with sesiones() as db:
        with pytest.raises(ConflictError):
            await resenas.responder(
                db, resena_id=identificador, usuario_id=organiza, texto="Otra"
            )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_las_resenas_no_las_lee_nadie_desde_el_movil(sesiones) -> None:
    async with sesiones() as db:
        filas = (
            await db.execute(
                text(
                    "select table_name, grantee from information_schema.table_privileges"
                    " where table_schema='public'"
                    "   and table_name in ('event_reviews','event_review_replies',"
                    "     'event_review_moderation')"
                    "   and grantee in ('anon','authenticated')"
                )
            )
        ).all()
    assert filas == [], filas


# =========================================================================== #
# Lo que la revisión independiente encontró
# =========================================================================== #
def test_el_cursor_valida_las_dos_mitades() -> None:
    """LA RUTA ES ANÓNIMA, y la segunda mitad del cursor va a una columna
    `uuid`. Un cursor sin `|` dejaba ahí la cadena vacía: SQLite la acepta y
    PostgreSQL contesta 500. Cualquiera podía provocarlo sin sesión.
    """
    import inspect

    fuente = inspect.getsource(resenas.listar)
    # Las dos mitades se validan, y el identificador como UUID.
    assert "datetime.fromisoformat" in fuente
    assert "UUID(ident)" in fuente
    # Y la excepción es la misma en los dos casos: un 400 con su código, no un
    # 500 con la traza de la base.
    assert fuente.count("event_review_cursor_invalid") == 2


def test_la_ventana_mira_el_FIN_del_evento_y_no_se_salta_sin_fecha() -> None:
    """DOS COSAS A LA VEZ.

    La comprobación se llamaba `event_not_finished` y miraba `starts_at`: en un
    festival de tres días se podía opinar a los cinco minutos de entrar. Y
    `starts_at` es anulable, así que con la fecha ausente el `getattr` saltaba
    la comprobación ENTERA y se podía reseñar un evento del que no se sabe ni
    cuándo es.
    """
    import inspect

    fuente = inspect.getsource(resenas.puede_resenar)
    assert "ends_at" in fuente
    # Sin ninguna fecha, se bloquea. No se da por terminado lo desconocido.
    assert "if termina is None:" in fuente
    indice = fuente.index("if termina is None:")
    assert "event_not_finished" in fuente[indice : indice + 120]


def test_la_respuesta_del_organizador_viaja_con_su_resena() -> None:
    """SIN N+1 Y SOLO LA VISIBLE.

    La lista pública no traía la respuesta, así que la pantalla no tenía de
    dónde sacarla; pedirla reseña a reseña habría sido veinte viajes en la
    pantalla que más se abre. Y una respuesta escondida por moderación no se
    lee: esconder es esconder.
    """
    import inspect

    fuente = inspect.getsource(resenas.respuestas_de)
    assert "EventReviewReply.status == VISIBLE" in fuente
    # Lista vacía = no se consulta: `in_([])` con relleno revienta en Postgres.
    assert "if not resenas_ids" in fuente

    from app.modules.events import resenas_router

    listar = inspect.getsource(resenas_router.listar_resenas)
    assert "respuestas_de" in listar
    assert listar.count("respuestas_de") == 1


def test_la_resena_propia_se_puede_leer_aunque_este_escondida() -> None:
    """SU AUTOR TIENE QUE PODER VER LO QUE ESCRIBIÓ. Moderar esconde para los
    demás; borrarlo de la vista de quien lo escribió es otra cosa."""
    import inspect

    fuente = inspect.getsource(resenas.mia)
    # No filtra por estado: la escondida también sale.
    assert "status" not in fuente

    from app.modules.events import resenas_router

    ruta = inspect.getsource(resenas_router.mi_resena)
    assert "current_user.id" in ruta
    assert "con_estado=True" in ruta
