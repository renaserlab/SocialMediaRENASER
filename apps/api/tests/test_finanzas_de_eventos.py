"""Las finanzas de una venta de entradas.

LO QUE DEFIENDEN. Que sin comisión configurada no se cree ningún saldo, que un
webhook repetido no cree dos, que el organizador quede CONGELADO, que nada se
libere sin política, y que una disputa bloquee sin descontar.
"""

from __future__ import annotations

import hashlib
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.modules.commerce.models import OwnerSaleBalance
from app.modules.events import finanzas, politicas
from app.modules.events import models as _modelos  # noqa: F401
from app.modules.events.finanzas_models import EventDispute, OwnerSaleReserve
from app.modules.events.models import EventOrder
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


@pytest.fixture()
def con_comision(monkeypatch):
    """Una comisión decidida. Sin esto, `platform_fee_bps` vale -1."""
    monkeypatch.setattr(get_settings(), "platform_fee_bps", 1000, raising=False)
    return 1000


async def _persona(sesiones, etiqueta="f") -> str:
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


async def _venta(sesiones, *, total=10000):
    """Un pedido de entradas PAGADO. Devuelve (orden, evento, organizador)."""
    organiza = await _persona(sesiones, "org")
    compra = await _persona(sesiones, "com")
    evento = str(uuid.uuid4())
    tipo = str(uuid.uuid4())
    hold = str(uuid.uuid4())
    orden = str(uuid.uuid4())
    linea = str(uuid.uuid4())
    momento = datetime.now(timezone.utc)

    async with sesiones() as db:
        await db.execute(
            text(
                "insert into public.events (id, organizer_id, title, description,"
                " starts_at, event_type, location, status, capacity) values"
                " (cast(:i as uuid), cast(:o as uuid), 'Concierto', 'Una descripción"
                " suficientemente larga para revisarla.', :s, 'presential', 'Sala',"
                " 'published', 100)"
            ),
            {"i": evento, "o": organiza, "s": momento + timedelta(days=10)},
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
            {"h": hold, "e": evento, "u": compra, "k": f"h{hold[:8]}", "p": total,
             "x": momento + timedelta(minutes=15)},
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
            {"o": orden, "e": evento, "u": compra, "h": hold, "k": f"k{orden[:8]}",
             "p": total, "ref": f"pi_{orden[:8]}", "pa": momento},
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
        # LA ENTRADA EMITIDA. Un disparador diferido de la 0062 exige que un
        # pedido pagado tenga exactamente las que compro, y con razon.
        entrada = str(uuid.uuid4())
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

    async with sesiones() as db:
        return await db.get(EventOrder, orden), evento, organiza


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_comision_configurada_no_se_crea_ningun_saldo(sesiones) -> None:
    """`platform_fee_bps = -1` significa que nadie decidió el número.

    Suponer 0 % transferiría el bruto entero —Z pagaría de su bolsillo la parte
    que le tocaba— y ninguna prueba lo delataría, porque el resultado cuadra.
    """
    assert get_settings().platform_fee_bps == -1, "de fábrica, sin decidir"
    orden, _, _ = await _venta(sesiones)
    async with sesiones() as db:
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
    assert saldo is None

    async with sesiones() as db:
        cuantos = len(
            list(
                await db.scalars(
                    select(OwnerSaleBalance).where(
                        OwnerSaleBalance.event_order_id == orden.id
                    )
                )
            )
        )
    assert cuantos == 0


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_con_comision_se_crea_y_cuadra(sesiones, con_comision) -> None:
    """Bruto menos comisión menos coste igual a neto, y lo exige la base."""
    orden, evento, organiza = await _venta(sesiones, total=10000)
    async with sesiones() as db:
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
    assert saldo is not None
    assert saldo.gross_amount_minor == 10000
    assert saldo.platform_fee_minor == 1000, "10 % de 10000"
    assert saldo.net_amount_minor == 9000
    assert saldo.currency == "PEN"
    assert saldo.event_id == evento
    assert saldo.event_order_id == orden.id
    assert saldo.course_id is None and saldo.order_id is None
    assert saldo.status == finanzas.PENDIENTE


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_organizador_queda_congelado(sesiones, con_comision) -> None:
    """CAMBIAR DESPUÉS EL ORGANIZADOR NO REDIRIGE DINERO YA VENDIDO."""
    orden, evento, organiza = await _venta(sesiones)
    async with sesiones() as db:
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
        identificador = saldo.id
    assert saldo.owner_id == organiza

    otro = await _persona(sesiones, "otro")
    async with sesiones() as db:
        await db.execute(
            text(
                "update public.events set organizer_id = cast(:o as uuid)"
                " where id = cast(:e as uuid)"
            ),
            {"o": otro, "e": evento},
        )
        await db.commit()

    async with sesiones() as db:
        fresco = await db.get(OwnerSaleBalance, identificador)
    assert fresco.owner_id == organiza, "el saldo sigue siendo de quien vendio"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_mismo_pedido_no_crea_dos_saldos(sesiones, con_comision) -> None:
    """El webhook se reintenta. Un saldo por pedido, y lo impone un índice."""
    orden, _, _ = await _venta(sesiones)
    async with sesiones() as db:
        uno = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
    async with sesiones() as db:
        dos = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
    assert uno.id == dos.id

    async with sesiones() as db:
        cuantos = len(
            list(
                await db.scalars(
                    select(OwnerSaleBalance).where(
                        OwnerSaleBalance.event_order_id == orden.id
                    )
                )
            )
        )
    assert cuantos == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_pedido_sin_pagar_no_genera_saldo(sesiones, con_comision) -> None:
    orden, _, _ = await _venta(sesiones)
    async with sesiones() as db:
        await db.execute(
            text(
                "update public.event_orders set status='PENDING_PAYMENT',"
                " paid_at=null, external_payment_id=null where id = cast(:o as uuid)"
            ),
            {"o": orden.id},
        )
        await db.commit()
        fresca = await db.get(EventOrder, orden.id)
        saldo = await finanzas.registrar_venta(db, orden=fresca)
        await db.commit()
    assert saldo is None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_politica_de_retencion_no_hay_fecha_de_disponibilidad(
    sesiones, con_comision
) -> None:
    """El reloj no empieza, y el saldo no se libera solo. No se aproxima con la
    fecha del evento ni con ningún plazo."""
    orden, _, _ = await _venta(sesiones)
    async with sesiones() as db:
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
    assert saldo.available_at is None

    async with sesiones() as db:
        bloqueo = await finanzas.por_que_no_se_libera(db, saldo=saldo)
    assert bloqueo is not None
    assert bloqueo.motivo in (
        finanzas.SIN_CUENTA,
        finanzas.SIN_POLITICA_DE_RETENCION,
    )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_con_politica_si_hay_fecha(sesiones, con_comision) -> None:
    orden, evento, _ = await _venta(sesiones)
    async with sesiones() as db:
        await politicas.publicar(
            db,
            tipo="settlement_hold",
            version=f"v{uuid.uuid4().hex[:8]}",
            params={"hold_days": 14},
            evento_id=evento,
        )
        await db.commit()
    async with sesiones() as db:
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
    assert saldo.available_at is not None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_politica_sin_dias_no_supone_ninguno(sesiones, con_comision) -> None:
    """La política existe pero no trae el número. No se inventa."""
    orden, evento, _ = await _venta(sesiones)
    async with sesiones() as db:
        await politicas.publicar(
            db,
            tipo="settlement_hold",
            version=f"v{uuid.uuid4().hex[:8]}",
            params={"hold_from_event": True},
            evento_id=evento,
        )
        await db.commit()
    async with sesiones() as db:
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
    assert saldo.available_at is None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_reserva_bloquea_y_no_se_duplica(sesiones, con_comision) -> None:
    """Dos reservas por el mismo motivo serían el mismo dinero retenido dos
    veces."""
    orden, _, _ = await _venta(sesiones)
    async with sesiones() as db:
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()

    async with sesiones() as db:
        una = await finanzas.reservar(
            db, saldo=saldo, importe_minor=5000, motivo="dispute"
        )
        await db.commit()
    async with sesiones() as db:
        otra = await finanzas.reservar(
            db, saldo=saldo, importe_minor=5000, motivo="dispute"
        )
        await db.commit()
    assert una is not None
    assert otra is None

    async with sesiones() as db:
        retenido = await finanzas.reservado_de(db, saldo_id=saldo.id)
        bloqueo = await finanzas.por_que_no_se_libera(db, saldo=saldo)
    assert retenido == 5000
    assert bloqueo is not None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_liberar_una_reserva_la_saca_del_bloqueo(sesiones, con_comision) -> None:
    orden, _, _ = await _venta(sesiones)
    async with sesiones() as db:
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
    async with sesiones() as db:
        reserva = await finanzas.reservar(
            db, saldo=saldo, importe_minor=3000, motivo="refund"
        )
        await db.commit()
        identificador = reserva.id
    async with sesiones() as db:
        soltada = await finanzas.liberar_reserva(
            db, reserva_id=identificador, motivo="resuelto"
        )
        await db.commit()
    assert soltada is True

    async with sesiones() as db:
        # Y una segunda liberación no cambia nada: UPDATE condicional.
        otra_vez = await finanzas.liberar_reserva(
            db, reserva_id=identificador, motivo="otra"
        )
        retenido = await finanzas.reservado_de(db, saldo_id=saldo.id)
    assert otra_vez is False
    assert retenido == 0


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_disputa_abre_expediente_y_bloquea_sin_descontar(
    sesiones, con_comision
) -> None:
    """QUIÉN ASUME LA PÉRDIDA NO ESTÁ DECIDIDO: se bloquea el importe y se
    avisa; no se descuenta nada de ningún otro saldo."""
    orden, _, _ = await _venta(sesiones)
    async with sesiones() as db:
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
        neto_antes = saldo.net_amount_minor

    async with sesiones() as db:
        fresca = await db.get(EventOrder, orden.id)
        disputa = await finanzas.abrir_o_actualizar_disputa(
            db,
            externa="dp_1",
            entorno="sandbox",
            estado="open",
            orden=fresca,
            importe_minor=4000,
            moneda="PEN",
        )
        await db.commit()
    assert disputa is not None
    assert disputa.liability is None, "quien paga no se decide aqui"

    async with sesiones() as db:
        fresco = await db.get(OwnerSaleBalance, saldo.id)
        retenido = await finanzas.reservado_de(db, saldo_id=saldo.id)
    assert fresco.net_amount_minor == neto_antes, "no se descuenta nada"
    assert retenido == 4000, "se bloquea"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_mismo_aviso_de_disputa_no_abre_dos(sesiones, con_comision) -> None:
    orden, _, _ = await _venta(sesiones)
    async with sesiones() as db:
        await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
    async with sesiones() as db:
        fresca = await db.get(EventOrder, orden.id)
        a = await finanzas.abrir_o_actualizar_disputa(
            db, externa="dp_2", entorno="sandbox", estado="open", orden=fresca
        )
        await db.commit()
    async with sesiones() as db:
        fresca = await db.get(EventOrder, orden.id)
        b = await finanzas.abrir_o_actualizar_disputa(
            db, externa="dp_2", entorno="sandbox", estado="needs_response", orden=fresca
        )
        await db.commit()
    assert a.id == b.id

    async with sesiones() as db:
        cuantas = len(
            list(
                await db.scalars(
                    select(EventDispute).where(EventDispute.external_id == "dp_2")
                )
            )
        )
        fresca_disputa = await db.get(EventDispute, a.id)
    assert cuantas == 1
    assert fresca_disputa.status == "needs_response", "el estado si avanza"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_saldo_no_puede_tener_dos_origenes(sesiones) -> None:
    """CURSO O EVENTO, EXACTAMENTE UNO. Los dos contarían el dinero dos veces;
    ninguno sería un saldo que nadie puede explicar."""
    from sqlalchemy.exc import IntegrityError

    quien = await _persona(sesiones, "dos")
    async with sesiones() as db:
        db.add(
            OwnerSaleBalance(
                owner_id=quien,
                gross_amount_minor=100,
                platform_fee_minor=0,
                provider_fee_minor=0,
                net_amount_minor=100,
                currency="PEN",
                fee_rules_version="v1",
            )
        )
        with pytest.raises(IntegrityError):
            await db.commit()
        await db.rollback()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_las_finanzas_no_las_escribe_nadie_desde_el_movil(sesiones) -> None:
    async with sesiones() as db:
        filas = (
            await db.execute(
                text(
                    "select table_name, grantee, privilege_type"
                    " from information_schema.table_privileges"
                    " where table_schema='public'"
                    "   and table_name in ('owner_sale_reserves','event_disputes',"
                    "     'event_dispute_events')"
                    "   and grantee in ('anon','authenticated')"
                )
            )
        ).all()
    assert filas == [], filas


# =========================================================================== #
# Conciliacion y contratos
# =========================================================================== #
def test_el_saldo_no_ensena_comision_si_no_esta_configurada() -> None:
    """ENSENAR CERO SERIA DECIR QUE Z NO COBRA NADA, y eso es una decision que
    nadie ha tomado. `null` y la pantalla escribe «pendiente de configuracion».
    """
    from app.modules.events.finanzas_router import ResumenFinancieroRead, SaldoRead

    assert SaldoRead.model_fields["platform_fee_minor"].default is None
    assert SaldoRead.model_fields["net_amount_minor"].default is None
    assert ResumenFinancieroRead.model_fields["comision_minor"].default is None
    # Y el bruto NO es opcional: eso si se sabe siempre.
    assert ResumenFinancieroRead.model_fields["bruto_minor"].is_required()


def test_el_saldo_no_ensena_la_cuenta_de_cobro() -> None:
    """Ni al organizador ni a nadie: es un dato bancario."""
    from app.modules.events.finanzas_router import SaldoRead

    campos = set(SaldoRead.model_fields)
    assert "payout_account_id" not in campos
    assert "owner_id" not in campos


def test_los_hallazgos_son_codigos_y_no_frases() -> None:
    """La pantalla los traduce y una consulta los agrupa. Un motivo en prosa no
    se puede contar."""
    from app.modules.events import conciliacion

    for codigo in (
        conciliacion.PEDIDO_SIN_ENTRADAS,
        conciliacion.ENTRADA_SIN_PAGO,
        conciliacion.SALDO_SIN_PEDIDO,
        conciliacion.SALDO_DUPLICADO,
        conciliacion.IMPORTE_DISTINTO,
        conciliacion.MONEDA_DISTINTA,
        conciliacion.TRANSFERIDO_CON_RESERVA,
    ):
        assert codigo == codigo.lower()
        assert " " not in codigo


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_conciliacion_no_corrige_nada(sesiones, con_comision) -> None:
    """Una diferencia de dinero no se arregla escribiendo el numero que falta:
    eso no concilia, tapa."""
    from app.modules.events import conciliacion

    orden, _, _ = await _venta(sesiones)
    async with sesiones() as db:
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
        identificador = saldo.id
        bruto_antes = saldo.gross_amount_minor

    # Se descuadra el saldo a proposito.
    async with sesiones() as db:
        await db.execute(
            text(
                "update public.owner_sale_balances set gross_amount_minor = 1,"
                " platform_fee_minor = 0, provider_fee_minor = 0,"
                " net_amount_minor = 1 where id = cast(:i as uuid)"
            ),
            {"i": identificador},
        )
        await db.commit()

    async with sesiones() as db:
        hallazgos = await conciliacion.conciliar_ventas(db)
    assert any(
        h.codigo == conciliacion.IMPORTE_DISTINTO and h.identificador == identificador
        for h in hallazgos
    ), [h.codigo for h in hallazgos]

    # Y NO lo ha tocado.
    async with sesiones() as db:
        fresco = await db.get(OwnerSaleBalance, identificador)
    assert fresco.gross_amount_minor == 1, "la conciliacion no reescribe dinero"
    assert bruto_antes != 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_salud_cuenta_los_saldos_sin_fecha(sesiones, con_comision) -> None:
    """Es el numero que dice cuanto dinero esta esperando una decision."""
    from app.modules.events import conciliacion

    orden, _, _ = await _venta(sesiones)
    async with sesiones() as db:
        await finanzas.registrar_venta(db, orden=orden)
        await db.commit()

    async with sesiones() as db:
        numeros = await conciliacion.salud(db)
    assert numeros["saldos_sin_fecha"] >= 1
