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


async def _venta(sesiones, *, total=10000, entorno="sandbox"):
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
                " :env, :ref, :pa)"
            ),
            {"o": orden, "e": evento, "u": compra, "h": hold, "k": f"k{orden[:8]}",
             "p": total, "ref": f"pi_{orden[:8]}", "pa": momento, "env": entorno},
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


# =========================================================================== #
# Carreras: dos procesos sobre el mismo dinero
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dos_webhooks_a_la_vez_no_crean_dos_saldos(sesiones, con_comision) -> None:
    """EL INDICE, NO EL `if`. La comprobacion previa la pasan los dos; por el
    indice unico parcial pasa uno."""
    import asyncio

    orden, _, _ = await _venta(sesiones)
    barrera = asyncio.Barrier(2)

    async def registra():
        async with sesiones() as db:
            fresca = await db.get(EventOrder, orden.id)
            await barrera.wait()
            try:
                saldo = await finanzas.registrar_venta(db, orden=fresca)
                await db.commit()
                return saldo.id if saldo is not None else None
            except Exception as error:  # noqa: BLE001
                await db.rollback()
                return type(error).__name__

    una, otra = await asyncio.gather(registra(), registra())

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
    assert cuantos == 1, (una, otra)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dos_avisos_de_disputa_a_la_vez_no_abren_dos(
    sesiones, con_comision
) -> None:
    """La pasarela reintenta, y dos reintentos pueden solaparse."""
    import asyncio

    orden, _, _ = await _venta(sesiones)
    async with sesiones() as db:
        await finanzas.registrar_venta(db, orden=orden)
        await db.commit()

    referencia = f"dp_{uuid.uuid4().hex[:8]}"
    barrera = asyncio.Barrier(2)

    async def abre():
        async with sesiones() as db:
            fresca = await db.get(EventOrder, orden.id)
            await barrera.wait()
            try:
                d = await finanzas.abrir_o_actualizar_disputa(
                    db,
                    externa=referencia,
                    entorno="sandbox",
                    estado="open",
                    orden=fresca,
                    importe_minor=1000,
                    moneda="PEN",
                )
                await db.commit()
                return d.id if d is not None else None
            except Exception as error:  # noqa: BLE001
                await db.rollback()
                return type(error).__name__

    una, otra = await asyncio.gather(abre(), abre())

    async with sesiones() as db:
        cuantas = len(
            list(
                await db.scalars(
                    select(EventDispute).where(EventDispute.external_id == referencia)
                )
            )
        )
    assert cuantas == 1, (una, otra)


# =========================================================================== #
# Lo que la revisión independiente encontró
#
# Cada prueba de aquí abajo defiende un agujero que existía porque NADA lo
# miraba. No son casos raros: son los caminos normales del dinero.
# =========================================================================== #
async def _cuenta_de_cobro(
    sesiones,
    organiza: str,
    *,
    entorno: str = "sandbox",
    alta: str = "active",
    cobros: bool = True,
) -> str:
    """Una cuenta de cobro del organizador. Por defecto, una que sirve."""
    ident = str(uuid.uuid4())
    async with sesiones() as db:
        await db.execute(
            text(
                "insert into public.owner_payout_accounts (id, owner_id, provider,"
                " environment, external_account_id, onboarding_status,"
                " charges_enabled, payouts_enabled) values (cast(:i as uuid),"
                " cast(:o as uuid), 'stripe', :e, :x, :a, true, :p)"
            ),
            {"i": ident, "o": organiza, "e": entorno, "x": f"acct_{ident[:8]}",
             "a": alta, "p": cobros},
        )
        await db.commit()
    return ident


async def _retencion(sesiones, evento: str, dias: int, *, desde_el_evento=False):
    """Una política de retención publicada, con su plazo."""
    async with sesiones() as db:
        await politicas.publicar(
            db,
            tipo="settlement_hold",
            version=f"v{uuid.uuid4().hex[:8]}",
            params={"hold_days": dias, "hold_from_event": desde_el_evento},
            evento_id=evento,
        )
        await db.commit()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_saldo_reembolsado_deja_de_estar_disponible(
    sesiones, con_comision
) -> None:
    """EL AGUJERO MÁS GRAVE QUE HABÍA.

    `liquidacion.cancelar` y sus hermanas filtran por `OwnerSaleBalance.order_id`,
    que en un saldo de EVENTO es nulo, así que ninguna lo tocaba. La secuencia
    completa era: se vende, el comprador pide devolución, la pasarela la
    confirma, se revocan las entradas, el expediente se cierra —y `resolved` no
    está entre los vivos—, vence la retención, y `por_que_no_se_libera` contesta
    `None`: «no hay nada que lo impida» sobre cien que ya se devolvieron.
    """
    orden, evento, organiza = await _venta(sesiones, total=10000)
    await _cuenta_de_cobro(sesiones, organiza)
    await _retencion(sesiones, evento, 0)

    async with sesiones() as db:
        orden = await db.get(EventOrder, orden.id)
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
        saldo_id = saldo.id

    # Antes de la devolución no hay nada que lo impida: la retención venció.
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        assert await finanzas.por_que_no_se_libera(db, saldo=saldo) is None

    # Llega la devolución CONFIRMADA y TOTAL.
    async with sesiones() as db:
        orden = await db.get(EventOrder, orden.id)
        hecho = await finanzas.atender_devolucion(
            db,
            orden=orden,
            importe_devuelto_minor=10000,
            moneda="PEN",
            confirmada=True,
        )
        await db.commit()
    assert hecho == finanzas.CANCELADO

    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        assert saldo.status == finanzas.CANCELADO
        bloqueo = await finanzas.por_que_no_se_libera(db, saldo=saldo)
        assert bloqueo is not None
        assert bloqueo.motivo == finanzas.SALDO_NO_PENDIENTE


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_devolucion_parcial_bloquea_lo_devuelto(
    sesiones, con_comision
) -> None:
    """CUÁNTO SE QUEDA EL ORGANIZADOR DE UNA PARCIAL ES UNA POLÍTICA que nadie
    ha publicado. Bloquear lo devuelto es un hecho; restarlo del neto sería
    inventar el reparto.
    """
    orden, evento, organiza = await _venta(sesiones, total=10000)
    await _cuenta_de_cobro(sesiones, organiza)
    await _retencion(sesiones, evento, 0)

    async with sesiones() as db:
        orden = await db.get(EventOrder, orden.id)
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
        saldo_id, neto = saldo.id, saldo.net_amount_minor

    async with sesiones() as db:
        orden = await db.get(EventOrder, orden.id)
        hecho = await finanzas.atender_devolucion(
            db,
            orden=orden,
            importe_devuelto_minor=3000,
            moneda="PEN",
            confirmada=True,
        )
        await db.commit()
    assert hecho == "reserved"

    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        # El saldo NO se cancela y su neto NO se toca.
        assert saldo.status == finanzas.PENDIENTE
        assert saldo.net_amount_minor == neto
        assert await finanzas.reservado_de(db, saldo_id=saldo_id) == 3000
        bloqueo = await finanzas.por_que_no_se_libera(db, saldo=saldo)
        assert bloqueo is not None and bloqueo.motivo == finanzas.RESERVA_VIVA


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_motor_de_cursos_no_recoge_los_saldos_de_evento(
    sesiones, con_comision, monkeypatch
) -> None:
    """LA 0068 MEZCLA LAS DOS COSAS EN UNA TABLA, y el trabajo que libera
    vencidos de Cursos no filtraba: pasaba a `eligible` saldos de evento
    saltándose reserva, disputa y expediente, y después los omitía uno por uno
    copando el turno de pago de los creadores de cursos.
    """
    from app.modules.commerce import liquidacion

    orden, evento, organiza = await _venta(sesiones, total=10000)
    await _cuenta_de_cobro(sesiones, organiza)
    await _retencion(sesiones, evento, 0)

    async with sesiones() as db:
        orden = await db.get(EventOrder, orden.id)
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
        saldo_id = saldo.id

    async with sesiones() as db:
        movidos = await liquidacion.liberar_vencidos(db, limite=500)
        await db.commit()

    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        assert saldo.status == finanzas.PENDIENTE, (
            "el motor de Cursos movió un saldo de evento"
        )
    assert movidos == 0

    # Y SI LLEGARA A `eligible` POR OTRA VÍA —alguien escribe el estado a mano—
    # el camino de transferencia de Cursos lo rechaza diciendo lo que pasa de
    # verdad. Se encienden las dos banderas A PROPÓSITO para llegar hasta esa
    # comprobación: sin ellas, la función corta antes y esta prueba no
    # comprobaría nada. NO SE MUEVE DINERO: `puede_transferirse` solo lee.
    monkeypatch.setattr(
        get_settings(), "creator_transfers_enabled", True, raising=False
    )
    monkeypatch.setattr(
        get_settings(), "stripe_connect_enabled", True, raising=False
    )
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        saldo.status = "eligible"
        await db.flush()
        assert (
            await liquidacion.puede_transferirse(db, saldo) == "not_a_course_balance"
        )
        await db.rollback()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_cuenta_de_cobro_sale_del_entorno_del_pedido(
    sesiones, con_comision
) -> None:
    """NO DEL ENTORNO DEL PROCESO.

    El organizador tiene las DOS cuentas, la de pruebas y la de verdad. El
    pedido es `sandbox`, así que le toca la de pruebas —pase lo que pase con la
    configuración de la réplica que atiende el webhook—. Eligiéndola con el
    entorno del proceso, un pedido de pruebas confirmado por una réplica de
    producción apuntaba a la cuenta de cobro REAL, y el saldo no guarda entorno:
    después no había forma de distinguirlos.
    """
    import inspect

    # EL PEDIDO ES DE PRODUCCIÓN y la réplica que lo atiende está configurada
    # como pruebas —`payments_environment` se deriva del despliegue y aquí vale
    # `sandbox`—. Eligiendo la cuenta con el entorno del proceso, este pedido
    # real acabaría apuntando a la cuenta DE JUGUETE. Con el del pedido, no.
    assert get_settings().payments_environment == "sandbox"
    orden, evento, organiza = await _venta(
        sesiones, total=10000, entorno="production"
    )
    de_pruebas = await _cuenta_de_cobro(sesiones, organiza, entorno="sandbox")
    de_verdad = await _cuenta_de_cobro(sesiones, organiza, entorno="production")

    async with sesiones() as db:
        orden = await db.get(EventOrder, orden.id)
        assert orden.environment == "production"
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()

    assert saldo.payout_account_id == de_verdad
    assert saldo.payout_account_id != de_pruebas
    # Y LA CONFIGURACIÓN DEL PROCESO NO PARTICIPA. `payments_environment` es una
    # propiedad derivada del despliegue; que no se lea aquí es justamente el
    # arreglo, y por eso se comprueba sobre la fuente.
    fuente = inspect.getsource(finanzas._cuenta_de)
    assert "payments_environment" not in fuente
    assert "entorno" in fuente


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_cuenta_a_medias_no_es_una_cuenta(sesiones, con_comision) -> None:
    """TENERLA APUNTADA NO ES PODER PAGAR EN ELLA. Un alta sin terminar o los
    cobros apagados pasaban por «nada lo impide»; el camino de Cursos sí lo
    exige y este no lo miraba.
    """
    orden, evento, organiza = await _venta(sesiones, total=10000)
    await _cuenta_de_cobro(sesiones, organiza, alta="pending", cobros=False)
    await _retencion(sesiones, evento, 0)

    async with sesiones() as db:
        orden = await db.get(EventOrder, orden.id)
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
        assert saldo.payout_account_id is not None
        bloqueo = await finanzas.por_que_no_se_libera(db, saldo=saldo)
    assert bloqueo is not None
    assert bloqueo.motivo == finanzas.CUENTA_SIN_ALTA


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_disputa_sin_saldo_todavia_bloquea_cuando_el_saldo_llega(
    sesiones, con_comision
) -> None:
    """HOY TODAS LAS DISPUTAS SON ASÍ. Sin comisión configurada no existe ningún
    saldo, así que la disputa nace con `balance_id` nulo; filtrando el bloqueo
    solo por `balance_id`, no impedía nada el día que la comisión se decidiera.
    """
    orden, evento, organiza = await _venta(sesiones, total=10000)
    await _cuenta_de_cobro(sesiones, organiza)
    await _retencion(sesiones, evento, 0)

    # La disputa llega ANTES de que exista el saldo.
    async with sesiones() as db:
        orden = await db.get(EventOrder, orden.id)
        disputa = await finanzas.abrir_o_actualizar_disputa(
            db,
            externa=f"dp_{orden.id[:8]}",
            entorno="sandbox",
            estado="open",
            orden=orden,
            importe_minor=10000,
            moneda="PEN",
        )
        await db.commit()
        disputa_id = disputa.id
        assert disputa.balance_id is None

    async with sesiones() as db:
        orden = await db.get(EventOrder, orden.id)
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
        saldo_id = saldo.id

    # Aunque la disputa no apunte al saldo, bloquea: se compara por pedido.
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        bloqueo = await finanzas.por_que_no_se_libera(db, saldo=saldo)
    assert bloqueo is not None and bloqueo.motivo == finanzas.DISPUTA_ABIERTA

    # Y el siguiente aviso de la misma disputa SÍ rellena el saldo y retiene.
    async with sesiones() as db:
        orden = await db.get(EventOrder, orden.id)
        await finanzas.abrir_o_actualizar_disputa(
            db,
            externa=f"dp_{orden.id[:8]}",
            entorno="sandbox",
            estado="under_review",
            orden=orden,
            importe_minor=10000,
            moneda="PEN",
        )
        await db.commit()

    async with sesiones() as db:
        disputa = await db.get(EventDispute, disputa_id)
        assert disputa.balance_id == saldo_id
        assert await finanzas.reservado_de(db, saldo_id=saldo_id) == 10000


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_ganar_la_disputa_suelta_lo_bloqueado(sesiones, con_comision) -> None:
    """`liberar_reserva` NO TENÍA NI UN LLAMANTE. La reserva que abría una
    disputa no se soltaba jamás —ni ganándola—: el saldo se quedaba con
    `reserve_held` para siempre y solo salía de ahí con SQL a mano.
    """
    orden, evento, organiza = await _venta(sesiones, total=10000)
    await _cuenta_de_cobro(sesiones, organiza)
    await _retencion(sesiones, evento, 0)

    async with sesiones() as db:
        orden = await db.get(EventOrder, orden.id)
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
        saldo_id = saldo.id

    referencia = f"dw_{orden.id[:8]}"
    async with sesiones() as db:
        orden = await db.get(EventOrder, orden.id)
        await finanzas.abrir_o_actualizar_disputa(
            db, externa=referencia, entorno="sandbox", estado="open",
            orden=orden, importe_minor=4000, moneda="PEN",
        )
        await db.commit()
    async with sesiones() as db:
        assert await finanzas.reservado_de(db, saldo_id=saldo_id) == 4000

    async with sesiones() as db:
        await finanzas.abrir_o_actualizar_disputa(
            db, externa=referencia, entorno="sandbox", estado="won",
        )
        await db.commit()

    async with sesiones() as db:
        assert await finanzas.reservado_de(db, saldo_id=saldo_id) == 0
        reserva = await db.scalar(
            select(OwnerSaleReserve).where(OwnerSaleReserve.balance_id == saldo_id)
        )
        assert reserva.status == "released"
        # La suelta el sistema: no lleva nombre, porque no lo decidió nadie.
        assert reserva.released_by is None
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        assert await finanzas.por_que_no_se_libera(db, saldo=saldo) is None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_perder_la_disputa_da_la_reserva_por_consumida(
    sesiones, con_comision
) -> None:
    """PERDERLA NO ES SOLTARLA. Ese importe se fue de verdad; marcarlo
    `released` lo devolvería a la cola del organizador."""
    orden, evento, organiza = await _venta(sesiones, total=10000)
    await _cuenta_de_cobro(sesiones, organiza)

    async with sesiones() as db:
        orden = await db.get(EventOrder, orden.id)
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
        saldo_id = saldo.id

    referencia = f"dl_{orden.id[:8]}"
    async with sesiones() as db:
        orden = await db.get(EventOrder, orden.id)
        await finanzas.abrir_o_actualizar_disputa(
            db, externa=referencia, entorno="sandbox", estado="open",
            orden=orden, importe_minor=4000, moneda="PEN",
        )
        await db.commit()
    async with sesiones() as db:
        await finanzas.abrir_o_actualizar_disputa(
            db, externa=referencia, entorno="sandbox", estado="lost",
        )
        await db.commit()

    async with sesiones() as db:
        reserva = await db.scalar(
            select(OwnerSaleReserve).where(OwnerSaleReserve.balance_id == saldo_id)
        )
    assert reserva.status == "consumed"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_disputa_en_otra_moneda_no_escribe_un_numero_mal_etiquetado(
    sesiones, con_comision
) -> None:
    """LA RESERVA SE GUARDA CON LA MONEDA DEL SALDO. Meterle el importe de una
    disputa en otra divisa sería un número de una moneda etiquetado con otra,
    que es peor que no tenerlo. El bloqueo lo pone la disputa misma.
    """
    orden, evento, organiza = await _venta(sesiones, total=10000)
    await _cuenta_de_cobro(sesiones, organiza)
    await _retencion(sesiones, evento, 0)

    async with sesiones() as db:
        orden = await db.get(EventOrder, orden.id)
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
        saldo_id = saldo.id
        assert saldo.currency == "PEN"

    async with sesiones() as db:
        orden = await db.get(EventOrder, orden.id)
        await finanzas.abrir_o_actualizar_disputa(
            db, externa=f"dx_{orden.id[:8]}", entorno="sandbox", estado="open",
            orden=orden, importe_minor=2500, moneda="USD",
        )
        await db.commit()

    async with sesiones() as db:
        assert await finanzas.reservado_de(db, saldo_id=saldo_id) == 0
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        bloqueo = await finanzas.por_que_no_se_libera(db, saldo=saldo)
    # Bloqueado igual, y por el motivo correcto.
    assert bloqueo is not None and bloqueo.motivo == finanzas.DISPUTA_ABIERTA


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_retencion_cuenta_desde_que_el_evento_TERMINA(
    sesiones, con_comision
) -> None:
    """EN UN FESTIVAL DE TRES DÍAS la diferencia entre empezar y terminar son
    tres días de reloj corriendo mientras el evento todavía está pasando."""
    orden, evento, organiza = await _venta(sesiones, total=10000)
    async with sesiones() as db:
        await db.execute(
            text(
                "update public.events set ends_at = starts_at + interval '3 days'"
                " where id = cast(:i as uuid)"
            ),
            {"i": evento},
        )
        await db.commit()
    await _retencion(sesiones, evento, 7, desde_el_evento=True)

    async with sesiones() as db:
        orden = await db.get(EventOrder, orden.id)
        evento_fila = await db.execute(
            text("select starts_at, ends_at from public.events where id = cast(:i as uuid)"),
            {"i": evento},
        )
        empieza, termina = evento_fila.one()
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()

    disponible = saldo.available_at
    if disponible.tzinfo is None:
        disponible = disponible.replace(tzinfo=timezone.utc)
    assert disponible == termina + timedelta(days=7)
    assert disponible != empieza + timedelta(days=7)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_bruto_admite_un_pedido_grande(sesiones, con_comision) -> None:
    """EL TOPE DE `integer` ERAN 21 474 836,47 y `event_orders.total_minor` ya
    era `bigint`: un pedido corporativo por encima reventaba el INSERT del saldo
    con un error que nadie captura, DENTRO del savepoint del webhook de cobro.
    Cobro hecho y entradas sin emitir.
    """
    grande = 3_000_000_000  # 30 000 000,00: por encima del tope de `integer`.
    orden, _, organiza = await _venta(sesiones, total=grande)
    await _cuenta_de_cobro(sesiones, organiza)

    async with sesiones() as db:
        orden = await db.get(EventOrder, orden.id)
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
    assert saldo is not None
    assert saldo.gross_amount_minor == grande


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_soltar_una_reserva_a_mano_deja_nombre(sesiones, con_comision) -> None:
    """LEVANTAR UNA RETENCIÓN sobre dinero de otra persona sin dejar nombre no
    se puede auditar después."""
    orden, evento, organiza = await _venta(sesiones, total=10000)
    quien = await _persona(sesiones, "adm")

    async with sesiones() as db:
        orden = await db.get(EventOrder, orden.id)
        saldo = await finanzas.registrar_venta(db, orden=orden)
        reserva = await finanzas.reservar(
            db, saldo=saldo, importe_minor=500, motivo="operational_risk"
        )
        await db.commit()
        reserva_id = reserva.id

    async with sesiones() as db:
        assert await finanzas.liberar_reserva(
            db, reserva_id=reserva_id, motivo="lo revisó operaciones", actor_id=quien
        )
        await db.commit()
    # La segunda vez ya no hay nada que soltar.
    async with sesiones() as db:
        assert not await finanzas.liberar_reserva(
            db, reserva_id=reserva_id, motivo="otra vez", actor_id=quien
        )
        fila = await db.get(OwnerSaleReserve, reserva_id)
    assert fila.status == "released"
    assert fila.released_by == quien
    assert fila.release_reason == "lo revisó operaciones"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_evento_sin_saldos_no_revienta_en_postgres(sesiones) -> None:
    """`in_(lista or [""])` MANDA LA CADENA VACÍA contra una columna `uuid`.

    SQLite la acepta y PostgreSQL contesta 500, así que el fallo solo aparecía
    en producción. Y hoy, sin comisión configurada, no hay ningún saldo: era el
    caso de TODOS los eventos, en el panel que el organizador abre primero.

    Se comprueban las dos mitades: que PostgreSQL DE VERDAD lo rechaza —si
    dejara de hacerlo, esta prueba avisa de que la guarda ya no hace falta— y
    que las dos rutas que lo tenían salen antes de consultar.
    """
    import inspect

    from app.modules.events import finanzas_router, posventa_router

    async with sesiones() as db:
        with pytest.raises(Exception):
            await db.execute(
                select(OwnerSaleReserve.id).where(
                    OwnerSaleReserve.balance_id.in_([""])
                )
            )
        await db.rollback()

    def _sin_comentarios(funcion) -> str:
        """Solo el código. Los comentarios SÍ nombran el idioma prohibido, y es
        justo donde queda explicado por qué no se usa."""
        return "\n".join(
            linea
            for linea in inspect.getsource(funcion).splitlines()
            if not linea.lstrip().startswith("#")
        )

    detalle = _sin_comentarios(finanzas_router.saldos_del_evento)
    assert 'or [""]' not in detalle
    assert "if not filas:" in detalle

    casos = _sin_comentarios(posventa_router.casos_de_mi_evento)
    assert 'or [""]' not in casos
    assert "if casos" in casos


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_conciliacion_cuenta_las_ventas_sin_saldo(sesiones) -> None:
    """ES EL DESCUADRE QUE EXISTE AHORA MISMO EN MASA: sin comisión configurada
    no se crea ningún saldo, y nada lo contaba."""
    from app.modules.events import conciliacion

    orden, _, _ = await _venta(sesiones, total=10000)
    async with sesiones() as db:
        hallazgos = await conciliacion.conciliar_ventas(db, limite=500)
    codigos = {h.codigo for h in hallazgos}
    assert conciliacion.PEDIDO_SIN_SALDO in codigos
    # Y NO SE HA CORREGIDO NADA.
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


def test_todos_los_codigos_de_conciliacion_se_emiten() -> None:
    """UN PANEL QUE CONTESTA CERO de un código que ninguna consulta produce
    parece haber comprobado algo. Había cuatro así."""
    import inspect

    from app.modules.events import conciliacion

    # SIN SALTOS NI ESPACIOS: una llamada repartida en varias líneas emite el
    # código igual, y la comprobación no puede depender de cómo esté formateada.
    fuente = " ".join(inspect.getsource(conciliacion.conciliar_ventas).split())
    fuente = fuente.replace("Hallazgo( ", "Hallazgo(")
    declarados = [
        nombre
        for nombre in conciliacion.__all__
        if nombre.isupper() or (nombre.replace("_", "").isupper() and nombre != "Hallazgo")
    ]
    for nombre in declarados:
        assert f"Hallazgo({nombre}" in fuente, nombre


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_las_tres_migraciones_se_reaplican_CON_datos(
    sesiones, con_comision
) -> None:
    """RE-EJECUTABLES TAMBIÉN EN USO, y no solo sobre tablas vacías.

    `test_las_que_prometen_reejecucion_la_cumplen` las reaplica sobre una base
    recién montada, donde todo está vacío. Las tres verificaban «este fichero no
    escribe ninguna fila» CONTANDO las filas de las tablas nuevas, así que
    pasaban esa prueba y abortaban en cuanto existiera una entrega, una reseña o
    una reserva: justo cuando alguien vuelve a pegar el fichero en el editor de
    Supabase para terminar de aplicarlo.
    """
    import psycopg

    orden, _, _ = await _venta(sesiones, total=10000)
    async with sesiones() as db:
        orden = await db.get(EventOrder, orden.id)
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await finanzas.reservar(
            db, saldo=saldo, importe_minor=100, motivo="operational_risk"
        )
        await db.commit()

    with psycopg.connect(URL, autocommit=True) as conexion:
        with conexion.cursor() as cur:
            cur.execute("select count(*) from public.owner_sale_reserves")
            assert cur.fetchone()[0] > 0, "hace falta al menos una fila"
        for nombre in (
            "0066_entrega_de_avisos_con_reintento.sql",
            "0067_resenas_verificadas_de_eventos.sql",
            "0068_finanzas_de_eventos.sql",
        ):
            with conexion.cursor() as cur:
                cur.execute((MIGRACIONES / nombre).read_text(encoding="utf-8"))


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_puerta_de_salida_se_puede_encontrar(sesiones, con_comision) -> None:
    """UNA SALIDA QUE NADIE PUEDE ENCONTRAR es la misma retención eterna con
    otro nombre.

    La ruta que suelta una reserva existía y no había ninguna que las listara:
    el resumen del organizador solo manda cuánto hay retenido en total, así que
    el panel no tenía de dónde sacar el identificador.
    """
    import inspect

    from app.modules.events import finanzas_router

    fuente = inspect.getsource(finanzas_router.retenciones)
    # Solo saldos de evento: los de Cursos tienen su propio camino.
    assert "OwnerSaleBalance.event_order_id.is_not(None)" in fuente
    # Y devuelve el identificador que la otra ruta necesita.
    assert '"id": reserva.id' in fuente

    salida = inspect.getsource(finanzas_router.soltar_reserva)
    assert "liberar_reserva" in salida
    assert "actor_id=current_user.id" in salida

    # EL TURNO DE PAGO EXIGE EL ESQUEMA. Contestaba 200 con su lista de
    # bloqueos aunque las tablas no existieran.
    turno = inspect.getsource(finanzas_router.ejecutar_transferencias)
    assert "exigir_disponible" in turno


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_los_saldos_de_evento_tienen_su_propio_camino_de_liberacion(
    sesiones, con_comision
) -> None:
    """AL SACAR EVENTOS DEL MOTOR DE CURSOS SE QUEDABAN SIN NINGUNO.

    El de Cursos mira una orden, una solicitud de devolución y una garantía que
    aquí no existen. Este pasa cada saldo por `por_que_no_se_libera`, que es
    donde viven las puertas de Eventos.
    """
    orden, evento, organiza = await _venta(sesiones, total=10000)
    await _cuenta_de_cobro(sesiones, organiza)
    await _retencion(sesiones, evento, 0)

    async with sesiones() as db:
        orden = await db.get(EventOrder, orden.id)
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
        saldo_id = saldo.id

    async with sesiones() as db:
        cuenta = await finanzas.liberar_vencidos(db, limite=500)
        await db.commit()
    assert cuenta["liberados"] >= 1

    async with sesiones() as db:
        actual = await db.get(OwnerSaleBalance, saldo_id)
    assert actual.status == finanzas.ELEGIBLE

    # Y ES IDEMPOTENTE: la segunda vez no mueve nada.
    async with sesiones() as db:
        otra = await finanzas.liberar_vencidos(db, limite=500)
        await db.commit()
    assert otra["liberados"] == 0


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_saldo_reservado_no_se_libera_por_vencimiento(
    sesiones, con_comision
) -> None:
    """LA PUERTA QUE EL MOTOR DE CURSOS SE SALTABA. Vencer la retención no es
    lo mismo que no tener nada pendiente."""
    orden, evento, organiza = await _venta(sesiones, total=10000)
    await _cuenta_de_cobro(sesiones, organiza)
    await _retencion(sesiones, evento, 0)

    async with sesiones() as db:
        orden = await db.get(EventOrder, orden.id)
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await finanzas.reservar(
            db, saldo=saldo, importe_minor=100, motivo="operational_risk"
        )
        await db.commit()
        saldo_id = saldo.id

    async with sesiones() as db:
        cuenta = await finanzas.liberar_vencidos(db, limite=500)
        await db.commit()
    assert cuenta["liberados"] == 0
    assert cuenta["bloqueados"] >= 1

    async with sesiones() as db:
        actual = await db.get(OwnerSaleBalance, saldo_id)
    assert actual.status == finanzas.PENDIENTE


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_saldo_con_expediente_abierto_tampoco(
    sesiones, con_comision
) -> None:
    """Un caso de posventa vivo es dinero en discusión."""
    from app.modules.events import cancelacion

    orden, evento, organiza = await _venta(sesiones, total=10000)
    await _cuenta_de_cobro(sesiones, organiza)
    await _retencion(sesiones, evento, 0)

    async with sesiones() as db:
        orden = await db.get(EventOrder, orden.id)
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
        saldo_id = saldo.id

    # Cancelar el evento abre expediente Y retiene: las dos puertas.
    async with sesiones() as db:
        await cancelacion.cancelar_evento(
            db, evento_id=evento, actor_id=organiza, motivo="se cayó el recinto"
        )
        await db.commit()

    async with sesiones() as db:
        cuenta = await finanzas.liberar_vencidos(db, limite=500)
        await db.commit()
        actual = await db.get(OwnerSaleBalance, saldo_id)
    assert cuenta["liberados"] == 0
    assert actual.status == finanzas.PENDIENTE


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_liberacion_de_eventos_no_toca_los_saldos_de_cursos(
    sesiones, con_comision
) -> None:
    """EL ESPEJO DEL FALLO QUE SE ARREGLÓ, y en el otro sentido.

    Compartir tabla no es compartir reglas. El camino de Eventos evalúa reserva,
    disputa y expediente; el de Cursos evalúa una orden, una solicitud de
    devolución y una garantía. Pasar un saldo de curso por las puertas de
    Eventos lo liberaría saltándose las suyas.
    """
    autor = await _persona(sesiones, "aut")
    curso = str(uuid.uuid4())
    producto = str(uuid.uuid4())
    pedido = str(uuid.uuid4())
    saldo_de_curso = str(uuid.uuid4())
    ayer = datetime.now(timezone.utc) - timedelta(days=1)

    # CON CUENTA DE COBRO EN REGLA, y eso es lo que hace la prueba útil: sin
    # ella, `por_que_no_se_libera` lo frenaría por «sin cuenta» y el filtro
    # parecería innecesario. Con ella, todas las puertas de EVENTOS están
    # abiertas para un saldo que no es de eventos.
    cuenta_del_autor = await _cuenta_de_cobro(sesiones, autor, entorno="sandbox")

    async with sesiones() as db:
        await db.execute(
            text(
                "insert into public.courses (id, author_id, title) values"
                " (cast(:i as uuid), cast(:a as uuid), 'Un curso')"
            ),
            {"i": curso, "a": autor},
        )
        await db.execute(
            text(
                "insert into public.commerce_products (id, course_id, kind)"
                " values (cast(:p as uuid), cast(:c as uuid), 'course_lifetime')"
            ),
            {"p": producto, "c": curso},
        )
        await db.execute(
            text(
                "insert into public.orders (id, user_id, commerce_product_id,"
                " provider, channel, status, amount_minor, currency) values"
                " (cast(:o as uuid), cast(:u as uuid), cast(:p as uuid), 'stripe',"
                " 'web', 'paid', 5000, 'PEN')"
            ),
            {"o": pedido, "u": autor, "p": producto},
        )
        # UN SALDO DE CURSO VENCIDO: el candidato perfecto para que el motor
        # equivocado se lo lleve.
        await db.execute(
            text(
                "insert into public.owner_sale_balances (id, course_id, order_id,"
                " owner_id, payout_account_id, gross_amount_minor,"
                " platform_fee_minor, provider_fee_minor, net_amount_minor,"
                " currency, fee_rules_version, status, available_at) values"
                " (cast(:s as uuid), cast(:c as uuid), cast(:o as uuid),"
                " cast(:u as uuid), cast(:pa as uuid), 5000, 500, 0, 4500, 'PEN',"
                " 'v1', 'pending', :av)"
            ),
            {"s": saldo_de_curso, "c": curso, "o": pedido, "u": autor,
             "pa": cuenta_del_autor, "av": ayer},
        )
        await db.commit()

    async with sesiones() as db:
        cuenta = await finanzas.liberar_vencidos(db, limite=500)
        await db.commit()

    async with sesiones() as db:
        fila = await db.get(OwnerSaleBalance, saldo_de_curso)
    assert fila.status == "pending", (
        "el camino de Eventos se llevó un saldo de Cursos"
    )
    # Y NO ESTUVO NI ENTRE LOS CANDIDATOS. Comprobar solo el estado final
    # dejaría pasar un filtro que lo mira y lo descarta por otra razón: el día
    # que esa otra razón cambie, se lo lleva.
    assert cuenta["mirados"] == cuenta["liberados"] + cuenta["bloqueados"]
    async with sesiones() as db:
        candidatos = list(
            await db.scalars(
                select(OwnerSaleBalance.id).where(
                    OwnerSaleBalance.event_order_id.is_not(None),
                    OwnerSaleBalance.status == finanzas.PENDIENTE,
                    OwnerSaleBalance.available_at.is_not(None),
                )
            )
        )
    assert saldo_de_curso not in [str(c) for c in candidatos]
