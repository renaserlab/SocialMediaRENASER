"""Cada organizador escribe sus propias reglas, y lo publicado no se toca.

LO QUE DEFIENDEN. Que una política publicada sea inmutable de verdad —no por
convención del código, sino porque la base lo impide—, que una compra conserve
la versión que aceptó aunque después se publique otra, que nadie escriba
políticas de eventos ajenos, que un organizador no pueda decidir sobre el dinero
de la plataforma, y que cancelar un evento no mueva ni un céntimo mientras la
empresa no conteste.
"""

from __future__ import annotations

import hashlib
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import pytest_asyncio
import psycopg
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.exceptions import AppError
from app.modules.commerce.models import OwnerSaleBalance
from app.modules.events import aceptacion, cancelacion, politicas
from app.modules.events import politicas_del_organizador as propias
from app.modules.events import models as _modelos  # noqa: F401
from app.modules.events.aceptacion_models import EventOrderPolicyAcceptance
from app.modules.events.models import EventOrder
from app.modules.events.posventa_models import (
    DEVOLUCION_PENDIENTE,
    EXPEDIENTES_VIVOS,
    POLITICA_EFECTO_ENTRADA,
    POLITICA_ELEGIBILIDAD,
    EventAftersaleCase,
    EventAftersaleCaseEvent,
    EventPolicy,
)
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


@pytest.fixture(scope="module")
def base_aplicada():
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
            {
                "i": ident,
                "e": f"{etiqueta}-{ident[:8]}@x.test",
                "u": f"{etiqueta}{ident[:8]}",
            },
        )
        await db.commit()
    return ident


async def _evento(sesiones, organiza: str) -> str:
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
                "s": datetime.now(timezone.utc) + timedelta(days=10),
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
        await db.execute(
            text(
                "insert into public.event_ticketing_settings (event_id, access_mode,"
                " currency) values (cast(:i as uuid), 'TICKETED', 'PEN')"
            ),
            {"i": ident},
        )
        await db.commit()
    return ident


async def _venta(sesiones, evento: str, compra: str, *, total=10000) -> str:
    """Un pedido PAGADO con su entrada emitida."""
    tipo = str(uuid.uuid4())
    hold = str(uuid.uuid4())
    orden = str(uuid.uuid4())
    linea = str(uuid.uuid4())
    entrada = str(uuid.uuid4())
    momento = datetime.now(timezone.utc)
    async with sesiones() as db:
        await db.execute(
            text(
                "insert into public.event_ticket_types (id, event_id, name, quota,"
                " price_minor, currency, status) values (cast(:t as uuid),"
                " cast(:e as uuid), 'General', 10, :p, 'PEN', 'on_sale')"
            ),
            {"t": tipo, "e": evento, "p": total},
        )
        await db.execute(
            text(
                "insert into public.event_ticket_holds (id, event_id, user_id,"
                " idempotency_key, request_fingerprint, status, currency,"
                " subtotal_minor, expires_at) values (cast(:h as uuid),"
                " cast(:e as uuid), cast(:u as uuid), :k, '', 'CONSUMED', 'PEN',"
                " :p, :x)"
            ),
            {
                "h": hold, "e": evento, "u": compra, "k": f"h{hold[:8]}",
                "p": total, "x": momento + timedelta(minutes=15),
            },
        )
        await db.execute(
            text(
                "insert into public.event_ticket_hold_items (hold_id, event_id,"
                " ticket_type_id, quantity, unit_price_minor, subtotal_minor,"
                " ticket_type_name_snapshot) values (cast(:h as uuid),"
                " cast(:e as uuid), cast(:t as uuid), 1, :p, :p, 'General')"
            ),
            {"h": hold, "e": evento, "t": tipo, "p": total},
        )
        await db.execute(
            text(
                "insert into public.event_orders (id, event_id, buyer_id, hold_id,"
                " status, currency, subtotal_minor, total_minor, idempotency_key,"
                " provider, environment, external_payment_id, paid_at) values"
                " (cast(:o as uuid), cast(:e as uuid), cast(:u as uuid),"
                " cast(:h as uuid), 'PAID', 'PEN', :p, :p, :k, 'stripe',"
                " 'sandbox', :ref, :pa)"
            ),
            {
                "o": orden, "e": evento, "u": compra, "h": hold,
                "k": f"k{orden[:8]}", "p": total, "ref": f"pi_{orden[:8]}",
                "pa": momento,
            },
        )
        await db.execute(
            text(
                "insert into public.event_order_items (id, order_id, event_id,"
                " ticket_type_id, ticket_type_name_snapshot, unit_price_minor,"
                " quantity, subtotal_minor) values (cast(:l as uuid),"
                " cast(:o as uuid), cast(:e as uuid), cast(:t as uuid), 'General',"
                " :p, 1, :p)"
            ),
            {"l": linea, "o": orden, "e": evento, "t": tipo, "p": total},
        )
        await db.execute(
            text(
                "insert into public.event_tickets (id, event_id, order_id,"
                " order_item_id, owner_id, ticket_type_id,"
                " ticket_type_name_snapshot, code_hash, credential_hash, status)"
                " values (cast(:i as uuid), cast(:e as uuid), cast(:o as uuid),"
                " cast(:l as uuid), cast(:u as uuid), cast(:t as uuid), 'General',"
                " :ch, :cr, 'VALID')"
            ),
            {
                "i": entrada, "e": evento, "o": orden, "l": linea, "u": compra,
                "t": tipo,
                "ch": hashlib.sha256(f"c{entrada}".encode()).hexdigest(),
                "cr": hashlib.sha256(f"q{entrada}".encode()).hexdigest(),
            },
        )
        await db.commit()
    return orden


REGLAS = {"allow_buyer_cancellation": True, "window_hours_before_event": 48}


# =========================================================================== #
# El ciclo de vida
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_borrador_se_edita_y_la_publicada_no(sesiones) -> None:
    """PARA ESO ES UN BORRADOR. Y lo publicado se cambia publicando otra
    versión, que es la única forma de no reescribirle las reglas a quien ya
    compró."""
    organiza = await _persona(sesiones, "org")
    evento = await _evento(sesiones, organiza)

    async with sesiones() as db:
        borrador = await propias.guardar_borrador(
            db,
            evento_id=evento,
            usuario_id=organiza,
            tipo=POLITICA_ELEGIBILIDAD,
            version="v1",
            params=REGLAS,
            body="Puedes cancelar hasta 48 horas antes.",
        )
        await db.commit()
        identificador = borrador.id
        assert borrador.status == politicas.BORRADOR

    # Reescribir el borrador NO crea otro: hay uno por tipo y evento.
    async with sesiones() as db:
        otra_vez = await propias.guardar_borrador(
            db,
            evento_id=evento,
            usuario_id=organiza,
            tipo=POLITICA_ELEGIBILIDAD,
            version="v1",
            params={**REGLAS, "window_hours_before_event": 24},
            body="Puedes cancelar hasta 24 horas antes.",
        )
        await db.commit()
    assert otra_vez.id == identificador
    assert otra_vez.params["window_hours_before_event"] == 24

    async with sesiones() as db:
        publicada = await propias.publicar_borrador(
            db, politica_id=identificador, usuario_id=organiza
        )
        await db.commit()
    assert publicada.status == politicas.PUBLICADA
    assert publicada.published_by == organiza
    assert publicada.published_at is not None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_base_impide_reescribir_una_publicada(sesiones) -> None:
    """NO ES UNA CONVENCIÓN DEL CÓDIGO. Un `update` directo tiene que fallar:
    si la huella se puede cambiar, la huella no demuestra nada."""
    organiza = await _persona(sesiones, "org")
    evento = await _evento(sesiones, organiza)
    async with sesiones() as db:
        borrador = await propias.guardar_borrador(
            db, evento_id=evento, usuario_id=organiza, tipo=POLITICA_ELEGIBILIDAD,
            version="v1", params=REGLAS, body="Texto.",
        )
        publicada = await propias.publicar_borrador(
            db, politica_id=borrador.id, usuario_id=organiza
        )
        await db.commit()
        identificador = publicada.id

    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        with pytest.raises(psycopg.errors.RestrictViolation):
            cur.execute(
                "update public.event_policies set params = '{\"refund_bps\": 10000}'"
                " where id = %s",
                (identificador,),
            )
        with pytest.raises(psycopg.errors.RestrictViolation):
            cur.execute(
                "update public.event_policies set body = 'otro texto' where id = %s",
                (identificador,),
            )
        with pytest.raises(psycopg.errors.RestrictViolation):
            cur.execute(
                "delete from public.event_policies where id = %s", (identificador,)
            )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_publicar_otra_version_supersede_la_anterior(sesiones) -> None:
    """UNA VIGENTE, NI CERO NI DOS. Y la anterior se queda para leerla."""
    organiza = await _persona(sesiones, "org")
    evento = await _evento(sesiones, organiza)

    async with sesiones() as db:
        primera = await propias.guardar_borrador(
            db, evento_id=evento, usuario_id=organiza, tipo=POLITICA_ELEGIBILIDAD,
            version="v1", params=REGLAS, body="48 horas.",
        )
        await propias.publicar_borrador(
            db, politica_id=primera.id, usuario_id=organiza
        )
        await db.commit()
        primera_id = primera.id

    async with sesiones() as db:
        segunda = await propias.guardar_borrador(
            db, evento_id=evento, usuario_id=organiza, tipo=POLITICA_ELEGIBILIDAD,
            version="v2", params={**REGLAS, "window_hours_before_event": 72},
            body="72 horas.",
        )
        await propias.publicar_borrador(
            db, politica_id=segunda.id, usuario_id=organiza
        )
        await db.commit()

    async with sesiones() as db:
        vieja = await db.get(EventPolicy, primera_id)
        assert vieja.status == politicas.SUPERADA
        assert vieja.effective_to is not None
        # Y SIGUE DICIENDO LO MISMO: superseder no reescribe su contenido.
        assert vieja.params["window_hours_before_event"] == 48
        assert vieja.body == "48 horas."

        vigentes = list(
            await db.scalars(
                select(EventPolicy).where(
                    EventPolicy.event_id == evento,
                    EventPolicy.policy_type == POLITICA_ELEGIBILIDAD,
                    EventPolicy.status == politicas.PUBLICADA,
                    EventPolicy.effective_to.is_(None),
                )
            )
        )
    assert len(vigentes) == 1
    assert vigentes[0].version == "v2"


# =========================================================================== #
# Quién puede qué
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_nadie_escribe_politicas_de_un_evento_ajeno(sesiones) -> None:
    """404, NUNCA 403: decir «existe pero no es tuyo» ya cuenta que existe."""
    from app.core.exceptions import NotFoundError

    organiza = await _persona(sesiones, "org")
    otro = await _persona(sesiones, "otro")
    evento = await _evento(sesiones, organiza)

    async with sesiones() as db:
        with pytest.raises(NotFoundError):
            await propias.guardar_borrador(
                db, evento_id=evento, usuario_id=otro, tipo=POLITICA_ELEGIBILIDAD,
                version="v1", params=REGLAS,
            )
        await db.rollback()
        with pytest.raises(NotFoundError):
            await propias.listar(db, evento_id=evento, usuario_id=otro)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_organizador_no_decide_sobre_el_dinero_de_la_plataforma(
    sesiones,
) -> None:
    """DECIDE LO QUE PROMETE, NO CÓMO SE MUEVE EL DINERO.

    Retención, reserva, quién asume una disputa y saldo negativo son decisiones
    sobre dinero de terceros: dejárselas al organizador es exactamente
    autoconcederse una excepción.
    """
    from app.core.exceptions import ValidationAppError
    from app.modules.events.posventa_models import (
        POLITICA_DISPUTA,
        POLITICA_EJECUCION,
        POLITICA_RESERVA,
        POLITICA_RETENCION,
        POLITICA_SALDO_NEGATIVO,
    )

    organiza = await _persona(sesiones, "org")
    evento = await _evento(sesiones, organiza)
    prohibidos = (
        POLITICA_RETENCION,
        POLITICA_RESERVA,
        POLITICA_DISPUTA,
        POLITICA_SALDO_NEGATIVO,
        POLITICA_EJECUCION,
    )
    for tipo in prohibidos:
        async with sesiones() as db:
            with pytest.raises(ValidationAppError) as fallo:
                await propias.guardar_borrador(
                    db, evento_id=evento, usuario_id=organiza, tipo=tipo,
                    version="v1", params={"hold_days": 0},
                )
            assert fallo.value.code == "event_policy_type_not_allowed"
            await db.rollback()

    # Y los dos que sí: lo que le promete a quien compra.
    assert set(propias.TIPOS_DEL_ORGANIZADOR) == {
        POLITICA_ELEGIBILIDAD,
        POLITICA_EFECTO_ENTRADA,
    }


# =========================================================================== #
# Lo que no se publica
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_publica_una_politica_que_no_decide_nada(sesiones) -> None:
    from app.core.exceptions import ValidationAppError

    organiza = await _persona(sesiones, "org")
    evento = await _evento(sesiones, organiza)
    async with sesiones() as db:
        borrador = await propias.guardar_borrador(
            db, evento_id=evento, usuario_id=organiza, tipo=POLITICA_ELEGIBILIDAD,
            version="v1", params={}, body="Un texto bonito y nada más.",
        )
        await db.commit()
        identificador = borrador.id

    async with sesiones() as db:
        with pytest.raises(ValidationAppError) as fallo:
            await propias.publicar_borrador(
                db, politica_id=identificador, usuario_id=organiza
            )
    assert fallo.value.code == "event_policy_empty"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_publica_una_politica_que_se_contradice(sesiones) -> None:
    """REVOCAR EN LA PARCIAL Y NO EN LA TOTAL no puede significar nada: lo menos
    implica lo más. Publicado, el comprador leería una promesa imposible."""
    from app.core.exceptions import ValidationAppError

    organiza = await _persona(sesiones, "org")
    evento = await _evento(sesiones, organiza)
    async with sesiones() as db:
        borrador = await propias.guardar_borrador(
            db, evento_id=evento, usuario_id=organiza, tipo=POLITICA_EFECTO_ENTRADA,
            version="v1",
            params={"revoke_on_partial_refund": True, "revoke_on_refund": False},
        )
        await db.commit()
        identificador = borrador.id

    async with sesiones() as db:
        with pytest.raises(ValidationAppError) as fallo:
            await propias.publicar_borrador(
                db, politica_id=identificador, usuario_id=organiza
            )
    assert fallo.value.code == "event_policy_contradictory"

    # Y permitir cancelar sin decir hasta cuándo, tampoco.
    async with sesiones() as db:
        otro = await propias.guardar_borrador(
            db, evento_id=evento, usuario_id=organiza, tipo=POLITICA_ELEGIBILIDAD,
            version="v1", params={"allow_buyer_cancellation": True},
        )
        await db.commit()
    async with sesiones() as db:
        with pytest.raises(ValidationAppError) as fallo:
            await propias.publicar_borrador(
                db, politica_id=otro.id, usuario_id=organiza
            )
    assert fallo.value.code == "event_policy_contradictory"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_numero_imposible_no_llega_ni_al_borrador(sesiones) -> None:
    """Un `refund_bps` de nueve millones no es «a medias»: es un número que no
    existe, y llegaba tal cual a la pantalla de quien compra."""
    from app.core.exceptions import ValidationAppError

    organiza = await _persona(sesiones, "org")
    evento = await _evento(sesiones, organiza)
    async with sesiones() as db:
        with pytest.raises(ValidationAppError):
            await propias.guardar_borrador(
                db, evento_id=evento, usuario_id=organiza,
                tipo=POLITICA_ELEGIBILIDAD, version="v1",
                params={"refund_bps": 9_999_999},
            )


# =========================================================================== #
# Lo que aceptó cada compra
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_compra_conserva_la_version_que_acepto(sesiones) -> None:
    """LA NO RETROACTIVIDAD, DEMOSTRADA.

    Sin esto, publicar una versión nueva cambiaba en silencio las reglas de todo
    lo ya vendido y nadie podía probar qué se había prometido.
    """
    organiza = await _persona(sesiones, "org")
    compra = await _persona(sesiones, "com")
    evento = await _evento(sesiones, organiza)

    async with sesiones() as db:
        primera = await propias.guardar_borrador(
            db, evento_id=evento, usuario_id=organiza, tipo=POLITICA_ELEGIBILIDAD,
            version="v1", params=REGLAS, body="48 horas.",
        )
        await propias.publicar_borrador(
            db, politica_id=primera.id, usuario_id=organiza
        )
        await db.commit()
        primera_id, primera_huella = primera.id, primera.params_sha256

    orden = await _venta(sesiones, evento, compra)
    async with sesiones() as db:
        await aceptacion.registrar(
            db, orden_id=orden, evento_id=evento, usuario_id=compra
        )
        await db.commit()

    # Se publica otra versión DESPUÉS de la compra.
    async with sesiones() as db:
        segunda = await propias.guardar_borrador(
            db, evento_id=evento, usuario_id=organiza, tipo=POLITICA_ELEGIBILIDAD,
            version="v2", params={**REGLAS, "window_hours_before_event": 1},
            body="1 hora.",
        )
        await propias.publicar_borrador(
            db, politica_id=segunda.id, usuario_id=organiza
        )
        await db.commit()

    async with sesiones() as db:
        rige = await aceptacion.la_que_rige(
            db, orden_id=orden, tipo=POLITICA_ELEGIBILIDAD
        )
    assert rige is not None
    assert rige.id == primera_id
    assert rige.version == "v1"
    assert rige.params["window_hours_before_event"] == 48
    assert rige.params_sha256 == primera_huella


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_aceptacion_no_se_reescribe_ni_se_borra(sesiones) -> None:
    """ES UN CONSENTIMIENTO. Cambiarlo después es falsificarlo."""
    organiza = await _persona(sesiones, "org")
    compra = await _persona(sesiones, "com")
    evento = await _evento(sesiones, organiza)
    async with sesiones() as db:
        borrador = await propias.guardar_borrador(
            db, evento_id=evento, usuario_id=organiza, tipo=POLITICA_ELEGIBILIDAD,
            version="v1", params=REGLAS,
        )
        await propias.publicar_borrador(
            db, politica_id=borrador.id, usuario_id=organiza
        )
        await db.commit()
    orden = await _venta(sesiones, evento, compra)
    async with sesiones() as db:
        guardadas = await aceptacion.registrar(
            db, orden_id=orden, evento_id=evento, usuario_id=compra
        )
        await db.commit()
    assert len(guardadas) == 1
    fila = guardadas[0].id

    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        with pytest.raises(psycopg.errors.RestrictViolation):
            cur.execute(
                "update public.event_order_policy_acceptances"
                " set policy_version = 'v9' where id = %s",
                (fila,),
            )
        with pytest.raises(psycopg.errors.RestrictViolation):
            cur.execute(
                "delete from public.event_order_policy_acceptances where id = %s",
                (fila,),
            )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_registrar_dos_veces_no_duplica_la_aceptacion(sesiones) -> None:
    """El pedido se reintenta. Aceptar dos versiones del mismo tipo en la misma
    compra sería no saber cuál rige."""
    organiza = await _persona(sesiones, "org")
    compra = await _persona(sesiones, "com")
    evento = await _evento(sesiones, organiza)
    async with sesiones() as db:
        borrador = await propias.guardar_borrador(
            db, evento_id=evento, usuario_id=organiza, tipo=POLITICA_ELEGIBILIDAD,
            version="v1", params=REGLAS,
        )
        await propias.publicar_borrador(
            db, politica_id=borrador.id, usuario_id=organiza
        )
        await db.commit()
    orden = await _venta(sesiones, evento, compra)
    async with sesiones() as db:
        await aceptacion.registrar(
            db, orden_id=orden, evento_id=evento, usuario_id=compra
        )
        await db.commit()
    async with sesiones() as db:
        repetida = await aceptacion.registrar(
            db, orden_id=orden, evento_id=evento, usuario_id=compra
        )
        await db.commit()
    assert repetida == []

    async with sesiones() as db:
        cuantas = len(
            list(
                await db.scalars(
                    select(EventOrderPolicyAcceptance).where(
                        EventOrderPolicyAcceptance.order_id == orden
                    )
                )
            )
        )
    assert cuantas == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_politica_publicada_no_se_inventa_ninguna_aceptacion(
    sesiones,
) -> None:
    """A esa persona no se le enseñó nada porque no había nada. Escribirle una
    aceptación sería falsificar un consentimiento."""
    organiza = await _persona(sesiones, "org")
    compra = await _persona(sesiones, "com")
    evento = await _evento(sesiones, organiza)
    orden = await _venta(sesiones, evento, compra)
    async with sesiones() as db:
        guardadas = await aceptacion.registrar(
            db, orden_id=orden, evento_id=evento, usuario_id=compra
        )
        await db.commit()
        assert guardadas == []
        assert await aceptacion.de_la_orden(db, orden_id=orden) == []
        # Y NO CAE A LA VIGENTE DE HOY: eso es justo lo que esto evita.
        assert (
            await aceptacion.la_que_rige(
                db, orden_id=orden, tipo=POLITICA_ELEGIBILIDAD
            )
            is None
        )


# =========================================================================== #
# La cancelación total
# =========================================================================== #
def test_la_regla_de_cancelacion_vive_en_un_solo_sitio() -> None:
    """LA EMPRESA CONTESTÓ, y se cambió UN valor.

    Repartida entre el endpoint, la pantalla y el webhook, cambiarla
    significaría encontrar todos los sitios y alguno se quedaría con la
    respuesta vieja. Esta prueba es la que garantiza que sigue habiendo uno.
    """
    import inspect
    from pathlib import Path as _Path

    assert cancelacion.DEVOLUCION_TOTAL_OBLIGATORIA is True
    assert cancelacion.regla_vigente() == "full_refund_required"
    assert cancelacion.rige_el_mandato() is True
    # El 100 % en la misma unidad que `cancelled_event_bps`, para poder
    # comparar lo que promete una política con lo que Z exige.
    assert cancelacion.BPS_DEL_MANDATO == 10_000

    # Y NADIE MÁS DECIDE ESTO. Solo `cancelacion.py` la nombra.
    raiz = _Path(inspect.getfile(cancelacion)).parents[2]
    otros = []
    for ruta in raiz.rglob("*.py"):
        if ruta.name in ("cancelacion.py",) or "__pycache__" in str(ruta):
            continue
        if "DEVOLUCION_TOTAL_OBLIGATORIA" in ruta.read_text(encoding="utf-8"):
            otros.append(ruta.name)
    assert otros == [], f"la regla está repartida: {otros}"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_cancelar_bloquea_y_no_mueve_ni_un_centimo(
    sesiones, monkeypatch
) -> None:
    """LO PROVISIONAL, DEMOSTRADO. Expediente abierto, importe retenido, aviso a
    las dos partes, y CERO movimientos: ni devolución, ni rechazo, ni
    liberación, ni transferencia."""
    from app.core.config import get_settings
    from app.modules.events import finanzas

    monkeypatch.setattr(get_settings(), "platform_fee_bps", 1000, raising=False)
    organiza = await _persona(sesiones, "org")
    compra = await _persona(sesiones, "com")
    evento = await _evento(sesiones, organiza)
    orden = await _venta(sesiones, evento, compra)

    async with sesiones() as db:
        fila = await db.get(EventOrder, orden)
        saldo = await finanzas.registrar_venta(db, orden=fila)
        await db.commit()
        saldo_id, neto = saldo.id, saldo.net_amount_minor

    async with sesiones() as db:
        resultado = await cancelacion.cancelar_evento(
            db, evento_id=evento, actor_id=organiza, motivo="se cayó el recinto"
        )
        await db.commit()

    assert resultado.regla == "full_refund_required"
    assert resultado.expedientes == 1
    assert resultado.saldos_bloqueados == 1
    assert resultado.devoluciones_decididas == 1

    async with sesiones() as db:
        # El saldo NO se canceló, NO se liberó, y su neto no se tocó.
        actual = await db.get(OwnerSaleBalance, saldo_id)
        assert actual.status == finanzas.PENDIENTE
        assert actual.net_amount_minor == neto
        # Está retenido ENTERO. Z debe el 100 % a quien compró, así que del
        # cobro del organizador no se suelta nada.
        assert await finanzas.reservado_de(db, saldo_id=saldo_id) == neto
        bloqueo = await finanzas.por_que_no_se_libera(db, saldo=actual)
        assert bloqueo is not None

        # Y hay un expediente vivo, con la causa anotada.
        caso = await db.scalar(
            select(EventAftersaleCase).where(
                EventAftersaleCase.order_id == orden,
                EventAftersaleCase.status.in_(EXPEDIENTES_VIVOS),
            )
        )
        assert caso is not None
        assert caso.kind == cancelacion.TIPO_DE_EXPEDIENTE
        assert "full_refund_required" in (caso.internal_notes or "")
        assert "se cayó el recinto" in (caso.internal_notes or "")

        # DECIDIDO, NO PAGADO. El expediente dice que hay que devolver el
        # 100 % de lo pagado, y no dice en ningún sitio que se haya devuelto:
        # `resolved` solo lo alcanza un aviso verificado del proveedor, y
        # `outcome` sigue vacío porque nada se ha cerrado.
        pedido = await db.get(EventOrder, orden)
        assert caso.status == DEVOLUCION_PENDIENTE
        assert caso.refund_amount_minor == pedido.total_minor
        assert caso.currency == pedido.currency
        assert caso.outcome is None
        assert caso.resolved_at is None
        assert caso.external_refund_id is None

        # QUIÉN LO DECIDIÓ CONSTA: el sistema, por mandato de Z. No una
        # persona, y no la política del organizador.
        paso = await db.scalar(
            select(EventAftersaleCaseEvent).where(
                EventAftersaleCaseEvent.case_id == caso.id,
                EventAftersaleCaseEvent.to_status == DEVOLUCION_PENDIENTE,
            )
        )
        assert paso is not None
        assert paso.actor_role == "system"
        assert paso.reason == cancelacion.MANDATO

        # Y la entrada NO se revocó: cancelar no revoca.
        entradas = (
            await db.execute(
                text(
                    "select status from public.event_tickets"
                    " where order_id = cast(:o as uuid)"
                ),
                {"o": orden},
            )
        ).all()
    assert [e[0] for e in entradas] == ["VALID"]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_cancelar_dos_veces_no_abre_dos_expedientes(sesiones) -> None:
    """El organizador toca el botón dos veces, o se reintenta la petición."""
    organiza = await _persona(sesiones, "org")
    compra = await _persona(sesiones, "com")
    evento = await _evento(sesiones, organiza)
    orden = await _venta(sesiones, evento, compra)

    async with sesiones() as db:
        await cancelacion.cancelar_evento(
            db, evento_id=evento, actor_id=organiza, motivo="motivo"
        )
        await db.commit()
    async with sesiones() as db:
        await cancelacion.cancelar_evento(
            db, evento_id=evento, actor_id=organiza, motivo="motivo"
        )
        await db.commit()

    async with sesiones() as db:
        cuantos = len(
            list(
                await db.scalars(
                    select(EventAftersaleCase).where(
                        EventAftersaleCase.order_id == orden
                    )
                )
            )
        )
    assert cuantos == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_cancelacion_registra_la_politica_que_regia(sesiones) -> None:
    """LA DE ESA COMPRA, no la de hoy. Resolver con la política de hoy a quien
    compró bajo otra es cambiarle las reglas después de cobrarle."""
    organiza = await _persona(sesiones, "org")
    compra = await _persona(sesiones, "com")
    evento = await _evento(sesiones, organiza)

    async with sesiones() as db:
        borrador = await propias.guardar_borrador(
            db, evento_id=evento, usuario_id=organiza, tipo=POLITICA_ELEGIBILIDAD,
            version="v1", params=REGLAS, body="48 horas.",
        )
        publicada = await propias.publicar_borrador(
            db, politica_id=borrador.id, usuario_id=organiza
        )
        await db.commit()
        primera_id = publicada.id

    orden = await _venta(sesiones, evento, compra)
    async with sesiones() as db:
        await aceptacion.registrar(
            db, orden_id=orden, evento_id=evento, usuario_id=compra
        )
        await db.commit()

    # Se publica otra DESPUÉS de vender.
    async with sesiones() as db:
        segunda = await propias.guardar_borrador(
            db, evento_id=evento, usuario_id=organiza, tipo=POLITICA_ELEGIBILIDAD,
            version="v2", params={**REGLAS, "window_hours_before_event": 1},
        )
        await propias.publicar_borrador(
            db, politica_id=segunda.id, usuario_id=organiza
        )
        await db.commit()

    async with sesiones() as db:
        await cancelacion.cancelar_evento(
            db, evento_id=evento, actor_id=organiza, motivo="motivo"
        )
        await db.commit()

    async with sesiones() as db:
        caso = await db.scalar(
            select(EventAftersaleCase).where(EventAftersaleCase.order_id == orden)
        )
    assert caso.policy_id == primera_id


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_los_avisos_de_cancelacion_no_prometen_nada() -> None:
    """“Está en evaluación” es un hecho. “Te devolveremos” es una decisión que
    nadie ha tomado, dicha con el tono de que ya está tomada."""
    import re

    from app.modules.notifications import textos

    prohibido = re.compile(
        r"\d|devolver|reembols|refund|estorn|days?|días?|dias|hours?|horas?",
        re.IGNORECASE,
    )
    for tipo in (
        "event_cancelled_under_review",
        "event_cancelled_organizer_notice",
    ):
        assert tipo in textos.TEXTOS, tipo
        for idioma, (titulo, cuerpo) in textos.TEXTOS[tipo].items():
            assert not prohibido.search(titulo), (tipo, idioma, titulo)
            assert not prohibido.search(cuerpo), (tipo, idioma, cuerpo)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_publicar_despues_de_vender_no_cierra_la_ventana_de_quien_ya_pago(
    sesiones,
) -> None:
    """EL AGUJERO QUE LA 0069 SE ESCRIBIO PARA CERRAR, y que no cerraba.

    La tabla de aceptaciones, la huella y los disparadores estaban perfectos, y
    los tres sitios donde SE DECIDE leian `politicas.vigente`, es decir la
    publicada HOY. El organizador podia cobrar bajo unas condiciones y publicar
    otras al dia siguiente.
    """
    from app.modules.events import elegibilidad

    organiza = await _persona(sesiones, "org")
    compra = await _persona(sesiones, "com")
    evento = await _evento(sesiones, organiza)

    # Se vende con la ventana ABIERTA de par en par.
    async with sesiones() as db:
        v1 = await propias.guardar_borrador(
            db, evento_id=evento, usuario_id=organiza, tipo=POLITICA_ELEGIBILIDAD,
            version="v1",
            params={
                "allow_buyer_cancellation": True,
                "window_hours_before_event": 0,
                "refund_bps": 10000,
            },
            body="Puedes cancelar hasta el comienzo, y se devuelve todo.",
        )
        await propias.publicar_borrador(db, politica_id=v1.id, usuario_id=organiza)
        await db.commit()

    orden = await _venta(sesiones, evento, compra)
    async with sesiones() as db:
        await aceptacion.registrar(
            db, orden_id=orden, evento_id=evento, usuario_id=compra
        )
        await db.commit()

    async with sesiones() as db:
        fila = await db.get(EventOrder, orden)
        antes = await elegibilidad.evaluar(db, orden=fila)
    assert antes.resultado == elegibilidad.ELEGIBLE
    assert antes.porcentaje_bps == 10000

    # Y AHORA EL ORGANIZADOR CAMBIA LAS REGLAS, despues de haber cobrado.
    async with sesiones() as db:
        v2 = await propias.guardar_borrador(
            db, evento_id=evento, usuario_id=organiza, tipo=POLITICA_ELEGIBILIDAD,
            version="v2",
            params={
                "allow_buyer_cancellation": True,
                "window_hours_before_event": 8760,
                "refund_bps": 0,
            },
            body="Ya no se devuelve nada.",
        )
        await propias.publicar_borrador(db, politica_id=v2.id, usuario_id=organiza)
        await db.commit()

    async with sesiones() as db:
        fila = await db.get(EventOrder, orden)
        despues = await elegibilidad.evaluar(db, orden=fila)

    # LO QUE ESA PERSONA COMPRO SIGUE VALIENDO.
    assert despues.resultado == elegibilidad.ELEGIBLE, (
        "publicar una version nueva le cerro la ventana a quien ya habia pagado"
    )
    assert despues.porcentaje_bps == 10000
    assert despues.politica_version == antes.politica_version


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_publicar_despues_no_revoca_la_entrada_de_quien_acepto_otra_cosa(
    sesiones,
) -> None:
    """LA VARIANTE PEOR. Publicar `revoke_on_partial_refund` despues de vender
    anulaba la entrada entera de alguien que acepto lo contrario."""
    from app.modules.events import efectos

    organiza = await _persona(sesiones, "org")
    compra = await _persona(sesiones, "com")
    evento = await _evento(sesiones, organiza)

    async with sesiones() as db:
        suave = await propias.guardar_borrador(
            db, evento_id=evento, usuario_id=organiza, tipo=POLITICA_EFECTO_ENTRADA,
            version="v1",
            params={"revoke_on_refund": True, "revoke_on_partial_refund": False},
        )
        await propias.publicar_borrador(db, politica_id=suave.id, usuario_id=organiza)
        await db.commit()

    orden = await _venta(sesiones, evento, compra, total=10000)
    async with sesiones() as db:
        await aceptacion.registrar(
            db, orden_id=orden, evento_id=evento, usuario_id=compra
        )
        await db.commit()

    # Ahora el organizador endurece la regla.
    async with sesiones() as db:
        dura = await propias.guardar_borrador(
            db, evento_id=evento, usuario_id=organiza, tipo=POLITICA_EFECTO_ENTRADA,
            version="v2",
            params={"revoke_on_refund": True, "revoke_on_partial_refund": True},
        )
        await propias.publicar_borrador(db, politica_id=dura.id, usuario_id=organiza)
        await db.commit()

    # Y llega una devolucion PARCIAL confirmada.
    async with sesiones() as db:
        fila = await db.get(EventOrder, orden)
        caso = await cancelacion._expediente_de(
            db, pedido=fila, actor_id=None, motivo="prueba",
            momento=cancelacion.ahora(),
        )
        await db.commit()
        caso_id = caso.id

    async with sesiones() as db:
        caso = await db.get(EventAftersaleCase, caso_id)
        resultado = await efectos.revocar_por_devolucion(
            db,
            caso=caso,
            importe_devuelto_minor=3000,
            moneda="PEN",
            referencia="re_123",
            confirmada=True,
        )
        await db.commit()

    assert resultado.efecto != efectos.REVOCADA, (
        "la version publicada despues de vender revoco una entrada"
    )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_cancelar_un_evento_grande_va_por_tandas(sesiones) -> None:
    """UN EVENTO DE MUCHAS COMPRAS NO CABE EN UNA PETICION.

    Atender cada pedido cuesta una docena de viajes a la base y todo corre con
    la fila del evento bloqueada. Sin cota, el evento que mas importa cancelar
    bien era el unico que no se podia cancelar: agotaba el tiempo y se deshacia
    entero, incluida la cancelacion.
    """
    organiza = await _persona(sesiones, "org")
    evento = await _evento(sesiones, organiza)
    ordenes = []
    for _ in range(3):
        compra = await _persona(sesiones, "com")
        ordenes.append(await _venta(sesiones, evento, compra))

    async with sesiones() as db:
        primera = await cancelacion.cancelar_evento(
            db, evento_id=evento, actor_id=organiza, motivo="motivo", limite=2
        )
        await db.commit()
    assert primera.expedientes == 2
    assert primera.pendientes == 1

    # REANUDABLE: la segunda tanda atiende lo que queda y no repite lo hecho.
    async with sesiones() as db:
        segunda = await cancelacion.cancelar_evento(
            db, evento_id=evento, actor_id=organiza, motivo="motivo", limite=2
        )
        await db.commit()
    assert segunda.expedientes == 1
    assert segunda.pendientes == 0

    async with sesiones() as db:
        cuantos = len(
            list(
                await db.scalars(
                    select(EventAftersaleCase).where(
                        EventAftersaleCase.event_id == evento
                    )
                )
            )
        )
    assert cuantos == 3, "una tanda repitio un expediente o se salto uno"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_al_organizador_se_le_avisa_UNA_vez(sesiones) -> None:
    """CANCELO UN EVENTO, NO QUINIENTOS.

    La clave anti-duplicado lleva el identificador de la entidad, y con el del
    expediente era distinta en cada pedido: el mismo telefono recibia una
    notificacion identica por cada compra.
    """
    from app.modules.notifications.models import NotificationDelivery

    organiza = await _persona(sesiones, "org")
    evento = await _evento(sesiones, organiza)
    compradores = []
    for _ in range(3):
        compra = await _persona(sesiones, "com")
        compradores.append(compra)
        await _venta(sesiones, evento, compra)

    async with sesiones() as db:
        await cancelacion.cancelar_evento(
            db, evento_id=evento, actor_id=organiza, motivo="motivo", limite=10
        )
        await db.commit()

    async with sesiones() as db:
        del_organizador = list(
            await db.scalars(
                select(NotificationDelivery).where(
                    NotificationDelivery.user_id == organiza,
                    NotificationDelivery.type
                    == "event_cancelled_organizer_full_refund",
                )
            )
        )
        de_compradores = list(
            await db.scalars(
                select(NotificationDelivery).where(
                    NotificationDelivery.type == "event_cancelled_full_refund",
                    NotificationDelivery.user_id.in_(compradores),
                )
            )
        )
    assert len(del_organizador) == 1, "al organizador se le aviso una vez por pedido"
    # Y a cada comprador SI le toca el suyo: es su compra.
    assert len(de_compradores) == 3


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_borrador_por_evento_y_tipo_lo_impone_la_base(sesiones) -> None:
    """Entre mirar si hay borrador y escribirlo cabe la otra peticion. El
    servicio lee con `scalar()`, asi que el segundo quedaba huerfano y visible
    en el historial."""
    organiza = await _persona(sesiones, "org")
    evento = await _evento(sesiones, organiza)
    async with sesiones() as db:
        await propias.guardar_borrador(
            db, evento_id=evento, usuario_id=organiza, tipo=POLITICA_ELEGIBILIDAD,
            version="v1", params=REGLAS,
        )
        await db.commit()

    with psycopg.connect(URL, autocommit=True) as cx, cx.cursor() as cur:
        with pytest.raises(psycopg.errors.UniqueViolation):
            cur.execute(
                "insert into public.event_policies (policy_type, scope, event_id,"
                " jurisdiction, locale, version, status, params, params_sha256)"
                " values ('aftersale_eligibility', 'event', %s, 'PE', 'es', 'v9',"
                " 'draft', '{}'::jsonb, %s)",
                (evento, "0" * 64),
            )
