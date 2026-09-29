"""La puerta de la baja (`baja._hay_0089`) contra PostgreSQL de verdad.

POR QUÉ EXISTE. El 29/09/2026 la 0089 se aplicó en Supabase en su versión de
`c6d3cd6`, sin la sección 8: faltaban las dos funciones y los dos disparadores
que impiden que una orden con dinero caiga en cascada con la cuenta de quien
compró. La puerta de entonces solo miraba `es_anonimizacion_por_baja` y dijo
que sí. Ahora mira cada pieza de la que depende que la baja sea segura.

CADA PROTECCIÓN SE RETIRA POR SEPARADO, dentro de una transacción que se
deshace (el DDL de PostgreSQL es transaccional): la base de la prueba no cambia
y la puerta tiene que decir que no en cada caso. Lo que sí se confirma (la
baja por el endpoint con la base a medias) se restaura al terminar
reejecutando la 0089, que es reejecutable.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.identity import baja
from tests import test_baja_de_cuenta_postgres as baja_pg
from tests.test_baja_de_cuenta_postgres import (
    MIGRACIONES,
    SIN_POSTGRES,
    URL,
    _archivos_de,
    _borrar_cuenta,
    _cuantos,
    _escribir,
    _existe,
    _persona,
    _uno,
)

pytestmark = [SIN_POSTGRES, pytest.mark.asyncio]

# Los mismos montajes (base 0001–0089 desechable, app y Storage de mentira).
base_aplicada = baja_pg.base_aplicada
entorno = baja_pg.entorno

LA_0089 = MIGRACIONES / "0089_baja_de_cuenta_con_historial_anonimo.sql"

#: Lo que la versión de `c6d3cd6` NO traía. Retirarlo deja la base exactamente
#: como quedó Supabase el 29/09/2026 (comprobado comparando el esquema entero).
COMO_C6D3CD6 = (
    "drop trigger event_orders_con_dinero_no_se_borran on public.event_orders",
    "drop trigger orders_con_dinero_no_se_borran on public.orders",
    "drop function public.event_orders_con_dinero_no_se_borran()",
    "drop function public.orders_con_dinero_no_se_borran()",
)
_CLAVE = "alter table public.consent_records drop constraint consent_records_subject_id_fkey"


def _clave(accion: str) -> str:
    return (
        "alter table public.consent_records add constraint consent_records_subject_id_fkey "
        f"foreign key (subject_id) references public.profiles(id) on delete {accion}"
    )


async def _puerta_con(motor, *cambios: str) -> bool:
    """La puerta, con `cambios` aplicados en una transacción que se DESHACE."""
    baja.olvidar()
    async with motor.connect() as conexion:
        transaccion = await conexion.begin()
        try:
            for sql in cambios:
                await conexion.execute(text(sql))
            # La consulta, a pelo: si reventara, la prueba lo diría. Así un
            # «no» es de la comprobación y no de un error que la puerta tapa.
            directa = (await conexion.execute(baja._LO_QUE_NECESITA_LA_BAJA)).scalar()
            sesion = AsyncSession(bind=conexion)
            try:
                puerta = await baja._hay_0089(sesion)
            finally:
                await sesion.close()
            assert puerta is bool(directa)
            return puerta
        finally:
            await transaccion.rollback()
            baja.olvidar()


async def test_con_la_0089_completa_la_puerta_esta_abierta(entorno) -> None:
    _, motor, _ = entorno
    assert await _puerta_con(motor) is True
    # 'A' (siempre) también es un disparador activo.
    assert await _puerta_con(
        motor, "alter table public.orders enable always trigger orders_con_dinero_no_se_borran"
    ) is True


@pytest.mark.parametrize(
    "cambios",
    [
        pytest.param(COMO_C6D3CD6, id="la_version_de_c6d3cd6"),
        # Falta cada uno de los cuatro objetos de la sección 8.
        pytest.param(COMO_C6D3CD6[:1], id="sin_el_disparador_de_event_orders"),
        pytest.param(COMO_C6D3CD6[1:2], id="sin_el_disparador_de_orders"),
        pytest.param(
            ("alter function public.event_orders_con_dinero_no_se_borran() rename to otra_funcion",),
            id="sin_la_funcion_de_event_orders",
        ),
        pytest.param(
            ("alter function public.orders_con_dinero_no_se_borran() rename to otra_funcion",),
            id="sin_la_funcion_de_orders",
        ),
        # Las otras dos funciones de las que depende.
        pytest.param(
            ("alter function public.es_anonimizacion_por_baja(jsonb, jsonb, text[]) rename to otra_funcion",),
            id="sin_la_excepcion_de_anonimizar",
        ),
        pytest.param(
            ("alter function public.auditoria_solo_anadir() rename to otra_funcion",),
            id="sin_la_funcion_de_la_auditoria",
        ),
        # El disparador existe, pero llama a otra función.
        pytest.param(
            ("create or replace trigger event_orders_con_dinero_no_se_borran before delete on public.event_orders "
             "for each row execute function public.orders_con_dinero_no_se_borran()",),
            id="disparador_de_event_orders_con_otra_funcion",
        ),
        pytest.param(
            ("create or replace trigger audit_events_solo_anadir before update or delete on public.audit_events "
             "for each row execute function public.impedir_reescritura()",),
            id="auditoria_con_la_funcion_de_antes_de_la_0089",
        ),
        # En otra tabla.
        pytest.param(
            (COMO_C6D3CD6[1],
             "create trigger orders_con_dinero_no_se_borran before delete on public.event_orders "
             "for each row execute function public.orders_con_dinero_no_se_borran()"),
            id="disparador_de_orders_en_otra_tabla",
        ),
        # Deshabilitado, o solo en réplica.
        pytest.param(
            ("alter table public.orders disable trigger orders_con_dinero_no_se_borran",),
            id="disparador_de_orders_deshabilitado",
        ),
        pytest.param(
            ("alter table public.event_orders enable replica trigger event_orders_con_dinero_no_se_borran",),
            id="disparador_de_event_orders_solo_en_replica",
        ),
        pytest.param(
            ("alter table public.audit_events disable trigger audit_events_solo_anadir",),
            id="disparador_de_la_auditoria_deshabilitado",
        ),
        # Con otra forma: después, o por sentencia.
        pytest.param(
            ("create or replace trigger orders_con_dinero_no_se_borran after delete on public.orders "
             "for each row execute function public.orders_con_dinero_no_se_borran()",),
            id="disparador_de_orders_despues_del_borrado",
        ),
        pytest.param(
            ("create or replace trigger event_orders_con_dinero_no_se_borran before delete on public.event_orders "
             "for each statement execute function public.event_orders_con_dinero_no_se_borran()",),
            id="disparador_de_event_orders_por_sentencia",
        ),
        # El consentimiento.
        pytest.param((_CLAVE, _clave("restrict")), id="consentimiento_con_restrict"),
        pytest.param((_CLAVE, _clave("cascade")), id="consentimiento_con_cascade"),
        pytest.param((_CLAVE,), id="consentimiento_sin_clave"),
        pytest.param(
            ("alter table public.consent_records add constraint otra_clave_del_sujeto "
             "foreign key (subject_id) references public.profiles(id) on delete restrict",),
            id="consentimiento_con_una_segunda_clave_restrict",
        ),
        pytest.param(
            ("alter table public.consent_records alter column subject_id set not null",),
            id="consentimiento_sin_admitir_null",
        ),
    ],
)
async def test_si_falta_cualquier_proteccion_la_puerta_se_cierra(entorno, cambios) -> None:
    _, motor, _ = entorno
    assert await _puerta_con(motor, *cambios) is False


async def test_un_error_al_mirar_cierra_la_puerta_de_verdad(entorno, monkeypatch) -> None:
    """Un error de PostgreSQL al inspeccionar (aquí, una consulta que revienta)
    no da la base por buena: 503 y nada tocado."""
    app, motor, almacen = entorno
    ana = await _persona(motor)
    _archivos_de(almacen, ana)
    monkeypatch.setattr(baja, "_LO_QUE_NECESITA_LA_BAJA", text("select 1 / 0 = 1"))
    baja.olvidar()

    r = await _borrar_cuenta(app, ana)

    assert r.status_code == 503, r.text
    assert r.json()["error"]["code"] == "account_deletion_unavailable"
    assert await _existe(motor, ana) and almacen.borrados == []


async def test_con_la_0089_a_medias_la_baja_no_se_lleva_una_orden_con_dinero(entorno) -> None:
    """EL CASO REAL. Con la base como quedó Supabase (sin la sección 8), una
    compra de curso cobrada en `production` y sin saldo del vendedor caía con
    la cuenta de quien compró. Ahora la puerta lo impide ANTES de tocar nada
    (503); y con la 0089 completa, el freno de la base contesta 409."""
    import psycopg

    app, motor, almacen = entorno
    autora, ana = await _persona(motor), await _persona(motor)
    curso = str(await _escribir(
        motor, "insert into public.courses (author_id, title) values (cast(:a as uuid), 'Guitarra') returning id", a=autora
    ))
    oferta = str(await _escribir(
        motor, "insert into public.commerce_products (kind, course_id) values ('course_lifetime', cast(:c as uuid)) returning id",
        c=curso,
    ))
    compra = str(await _escribir(
        motor,
        "insert into public.orders (user_id, commerce_product_id, provider, channel, status, amount_minor, currency, "
        "paid_at) values (cast(:u as uuid), cast(:p as uuid), 'stripe', 'web', 'paid', 4900, 'PEN', now()) returning id",
        u=ana, p=oferta,
    ))
    _archivos_de(almacen, ana)
    archivos = _cuantos(almacen, ana)

    for sql in COMO_C6D3CD6:
        await _escribir(motor, sql)
    try:
        baja.olvidar()
        r = await _borrar_cuenta(app, ana)
        assert r.status_code == 503, r.text
        assert r.json()["error"]["code"] == "account_deletion_unavailable"
        assert await _existe(motor, ana)
        assert await _uno(motor, "select count(*) from public.orders where id = cast(:o as uuid)", o=compra) == 1
        assert almacen.borrados == [] and _cuantos(almacen, ana) == archivos
    finally:
        # La 0089 es reejecutable: devuelve lo retirado.
        with psycopg.connect(URL, autocommit=True) as conexion:
            conexion.execute(LA_0089.read_text(encoding="utf-8"))
        baja.olvidar()

    r = await _borrar_cuenta(app, ana)
    assert r.status_code == 409, r.text
    assert r.json()["error"]["details"] == {"reason": "courses"}
    assert await _uno(motor, "select count(*) from public.orders where id = cast(:o as uuid)", o=compra) == 1
    assert almacen.borrados == [] and _cuantos(almacen, ana) == archivos
