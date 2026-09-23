"""Las políticas de posventa: sin publicar, todo bloqueado.

LO QUE ESTAS PRUEBAS DEFIENDEN. La regla del proyecto no es «hay una tabla de
políticas»: es que **una decisión que la empresa no ha tomado no se toma
sola**. Un plazo ausente leído como cero cierra la ventana para todo el mundo;
un porcentaje ausente leído como cero regala el importe entero. Las dos cosas
cuadran, así que ninguna prueba de resultado las delata: hay que probar
explícitamente que el dato ausente NO se sustituye.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.modules.events import politicas
from app.modules.events import models as _modelos_de_evento  # noqa: F401
from app.modules.profiles import models as _modelos_de_perfil  # noqa: F401
from app.modules.events.posventa_models import (
    PUBLICADA,
    SUPERADA,
    EventPolicy,
)
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

ELEGIBILIDAD = politicas.TIPOS_DE_POLITICA[0] if hasattr(politicas, "TIPOS_DE_POLITICA") else "aftersale_eligibility"


@pytest.fixture(scope="module")
def base_aplicada():
    """El esquema real, con las 64 migraciones. Una sola vez."""
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
    from app.modules.events import esquema

    esquema.olvidar()
    return True


@pytest_asyncio.fixture()
async def sesiones(base_aplicada):
    motor = create_async_engine(URL.replace("postgresql://", "postgresql+asyncpg://", 1))
    yield async_sessionmaker(motor, expire_on_commit=False)
    await motor.dispose()


async def _persona(sesiones) -> str:
    """Un perfil real. El disparador de `auth.users` crea el `profiles`."""
    ident = str(uuid.uuid4())
    async with sesiones() as db:
        await db.execute(
            text(
                "insert into auth.users (id, email, raw_user_meta_data) values "
                "(cast(:i as uuid), cast(:e as text), "
                " jsonb_build_object('full_name', 'P', 'username', cast(:u as text)))"
            ),
            {"i": ident, "e": f"pol-{ident[:8]}@x.test", "u": f"pol{ident[:8]}"},
        )
        await db.commit()
    return ident


async def _evento(sesiones) -> str:
    """Un evento real, para las políticas de alcance de evento."""
    organiza = await _persona(sesiones)
    ident = str(uuid.uuid4())
    async with sesiones() as db:
        await db.execute(
            text(
                "insert into public.events"
                " (id, organizer_id, title, description, starts_at, event_type,"
                "  location, status, capacity)"
                " values (cast(:i as uuid), cast(:o as uuid), :t, :d,"
                "  now() + interval '10 days', 'presential', 'Sala', 'published', 50)"
            ),
            {
                "i": ident,
                "o": organiza,
                "t": "Evento de políticas",
                "d": "Una descripción suficientemente larga para revisarla.",
            },
        )
        await db.commit()
    return ident


# --------------------------------------------------------------------------- #
# Sin política publicada, todo bloqueado
# --------------------------------------------------------------------------- #
async def test_sin_politica_publicada_no_hay_ninguna(sesiones) -> None:
    """La migración no deja ninguna, y eso es el criterio de aceptación."""
    async with sesiones() as db:
        assert await politicas.vigente(db, tipo="aftersale_eligibility") is None
        assert await politicas.vigente(db, tipo="settlement_hold") is None
        assert await politicas.vigente(db, tipo="dispute_liability") is None


async def test_exigirla_se_para_y_lo_dice(sesiones) -> None:
    """Y se para con un código estable, no con un 500.

    Un 500 haría pensar que algo se rompió; esto es una decisión que nadie ha
    tomado, y la pantalla tiene que poder explicar por qué el botón está
    apagado.
    """
    async with sesiones() as db:
        with pytest.raises(politicas.PoliticaAusente) as fallo:
            await politicas.exigir_vigente(db, tipo="aftersale_eligibility")
    assert fallo.value.code == "event_policy_not_configured"
    assert fallo.value.status_code == 409


async def test_un_borrador_no_rige(sesiones) -> None:
    """Escribir la política no es publicarla."""
    async with sesiones() as db:
        db.add(
            EventPolicy(
                policy_type="aftersale_eligibility",
                version="borrador",
                params={"refund_window_hours": 48},
                params_sha256=politicas.huella({"refund_window_hours": 48}),
            )
        )
        await db.commit()
        assert await politicas.vigente(db, tipo="aftersale_eligibility") is None


# --------------------------------------------------------------------------- #
# Publicar
# --------------------------------------------------------------------------- #
async def test_publicar_cierra_la_anterior_en_la_misma_transaccion(sesiones) -> None:
    """Ni «ninguna vigente» ni «dos vigentes» pueden existir ni un instante.

    En el primer estado se bloquearía una operación legítima; en el segundo, el
    resultado dependería del orden de lectura.
    """
    quien = await _persona(sesiones)
    async with sesiones() as db:
        primera = await politicas.publicar(
            db,
            tipo="refund_execution",
            version="v1",
            params={"platform_fee_refundable": False},
            actor_id=quien,
        )
        await db.commit()
        assert primera.status == PUBLICADA

        segunda = await politicas.publicar(
            db,
            tipo="refund_execution",
            version="v2",
            params={"platform_fee_refundable": True},
            actor_id=quien,
        )
        await db.commit()

        vigentes = list(
            await db.scalars(
                select(EventPolicy).where(
                    EventPolicy.policy_type == "refund_execution",
                    EventPolicy.status == PUBLICADA,
                    EventPolicy.effective_to.is_(None),
                )
            )
        )
        assert len(vigentes) == 1
        assert vigentes[0].id == segunda.id

        await db.refresh(primera)
        assert primera.status == SUPERADA
        assert primera.effective_to is not None


async def test_republicar_la_misma_version_no_duplica(sesiones) -> None:
    """Idempotente: reintentar no abre una segunda."""
    async with sesiones() as db:
        una = await politicas.publicar(
            db, tipo="review_window", version="v1", params={"days_after_event": 30}
        )
        await db.commit()
        otra = await politicas.publicar(
            db, tipo="review_window", version="v1", params={"days_after_event": 30}
        )
        await db.commit()
    assert una.id == otra.id


async def test_la_del_evento_manda_sobre_la_global(sesiones) -> None:
    """Un festival puede necesitar condiciones propias, y no se mezclan."""
    evento = await _evento(sesiones)

    async with sesiones() as db:
        await politicas.publicar(
            db, tipo="ticket_effect", version="global", params={"revoke_on_refund": False}
        )
        propia = await politicas.publicar(
            db,
            tipo="ticket_effect",
            version="del-evento",
            params={"revoke_on_refund": True},
            evento_id=evento,
        )
        await db.commit()

        manda = await politicas.vigente(db, tipo="ticket_effect", evento_id=evento)
        assert manda is not None and manda.id == propia.id
        # Y para cualquier otro evento sigue mandando la global.
        general = await politicas.vigente(db, tipo="ticket_effect")
        assert general is not None and general.id != propia.id


async def test_dos_vigentes_del_mismo_tipo_no_caben_en_la_base(sesiones) -> None:
    """Y lo impide la BASE, no el servicio.

    Sin el índice parcial, dos escrituras a la vez pasarían las dos por
    cualquier comprobación previa y dejarían dos políticas rigiendo a la vez.
    """
    async with sesiones() as db:
        await politicas.publicar(
            db, tipo="negative_balance", version="v1", params={"recover": False}
        )
        await db.commit()

    async with sesiones() as db:
        db.add(
            EventPolicy(
                policy_type="negative_balance",
                version="colada",
                params={},
                params_sha256=politicas.huella({}),
                status=PUBLICADA,
                published_at=politicas.ahora(),
            )
        )
        with pytest.raises(IntegrityError):
            await db.commit()
        await db.rollback()


# --------------------------------------------------------------------------- #
# Lo que NO se sustituye
# --------------------------------------------------------------------------- #
async def test_un_parametro_ausente_no_vale_cero(sesiones) -> None:
    """EL CORAZÓN DE TODO ESTO.

    Un plazo ausente leído como cero cierra la ventana para todo el mundo; un
    porcentaje ausente leído como cero regala el importe entero. Las dos cosas
    cuadran y ninguna prueba de resultado las delata.
    """
    async with sesiones() as db:
        politica = await politicas.publicar(
            db, tipo="settlement_hold", version="v1", params={"hold_days": 14}
        )
        await db.commit()

    assert politicas.numero(politica, "hold_days") == 14
    assert politicas.numero(politica, "reserve_bps") is None, (
        "un parámetro que nadie ha decidido no puede leerse como cero"
    )


async def test_una_bandera_ausente_no_permite_nada(sesiones) -> None:
    """Falla en cerrado: lo que la política no permite expresamente, no vale."""
    async with sesiones() as db:
        politica = await politicas.publicar(
            db, tipo="organizer_reply", version="v1", params={"allow_reply": True}
        )
        await db.commit()

    assert politicas.bandera(politica, "allow_reply") is True
    assert politicas.bandera(politica, "allow_edit") is False
    assert politicas.bandera(politica, "lo_que_sea") is False


async def test_una_politica_vacia_no_habilita_nada(sesiones) -> None:
    """`{}` no es «todo en cero»: es «nada decidido»."""
    async with sesiones() as db:
        politica = await politicas.publicar(
            db, tipo="dispute_liability", version="v1", params={}
        )
        await db.commit()

    assert politicas.numero(politica, "organizer_share_bps") is None
    assert politicas.bandera(politica, "charge_organizer") is False


async def test_un_booleano_no_se_lee_como_numero(sesiones) -> None:
    """`True` vale 1 en Python. Un plazo de «un día» que en realidad era un sí
    es exactamente el tipo de dato equivocado que cuadra."""
    async with sesiones() as db:
        politica = await politicas.publicar(
            db, tipo="settlement_reserve", version="v1", params={"enabled": True}
        )
        await db.commit()

    assert politicas.numero(politica, "enabled") is None


# --------------------------------------------------------------------------- #
# La huella
# --------------------------------------------------------------------------- #
async def test_la_huella_no_depende_de_como_se_escriba(sesiones) -> None:
    """Sirve para demostrar qué números se aplicaron; si dependiera del orden
    de las claves no demostraría nada."""
    assert politicas.huella({"a": 1, "b": 2}) == politicas.huella({"b": 2, "a": 1})
    assert politicas.huella({"a": 1}) != politicas.huella({"a": 2})


async def test_la_huella_guardada_es_la_de_lo_publicado(sesiones) -> None:
    async with sesiones() as db:
        politica = await politicas.publicar(
            db, tipo="aftersale_eligibility", version="v1", params={"window_hours": 72}
        )
        await db.commit()
    assert politica.params_sha256 == politicas.huella({"window_hours": 72})


# --------------------------------------------------------------------------- #
# Cerrado por fuera
# --------------------------------------------------------------------------- #
async def test_ni_anon_ni_authenticated_tocan_las_politicas(sesiones) -> None:
    """Aquí viven las reglas del dinero. El móvil no las lee ni las escribe."""
    async with sesiones() as db:
        filas = (
            await db.execute(
                text(
                    "select table_name, grantee, privilege_type"
                    " from information_schema.table_privileges"
                    " where table_schema='public'"
                    "   and table_name in ('event_policies','event_changes',"
                    "     'event_aftersale_cases','event_aftersale_case_tickets',"
                    "     'event_aftersale_case_events')"
                    "   and grantee in ('anon','authenticated')"
                )
            )
        ).all()
    assert filas == [], f"la posventa tiene permisos sueltos: {filas}"


async def test_el_historial_de_un_expediente_es_solo_anadir(sesiones) -> None:
    """Y lo impide un disparador, no una promesa.

    NO SE EJERCE CON UNA FILA porque escribir una exige un expediente entero
    —evento, pedido, comprador y organizador—, y montar eso aquí probaría la
    cadena de compra, no el disparador. Se comprueba lo que define su fuerza:
    que existe, que es de FILA y que cubre UPDATE y DELETE. Un disparador de
    sentencia, o uno que solo cubriera DELETE, dejaría reescribir el historial
    y esta prueba lo vería.
    """
    async with sesiones() as db:
        fila = (
            await db.execute(
                text(
                    "select tg.tgname, tg.tgtype"
                    "  from pg_trigger tg"
                    "  join pg_class t on t.oid = tg.tgrelid"
                    " where t.relname = 'event_aftersale_case_events'"
                    "   and not tg.tgisinternal"
                )
            )
        ).all()
    assert len(fila) == 1, fila
    nombre, tipo = fila[0]
    assert nombre == "event_aftersale_case_events_inmutables"
    # `tgtype` es una máscara: 1 = FILA, 2 = BEFORE, 8 = DELETE, 16 = UPDATE.
    assert tipo & 1, "tiene que ser de FILA"
    assert tipo & 2, "y BEFORE, para poder impedirlo"
    assert tipo & 8, "cubre DELETE"
    assert tipo & 16, "y UPDATE"
