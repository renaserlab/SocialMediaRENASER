"""La cola de entregas: traducida, deduplicada y con reintento.

LO QUE DEFIENDE. Que un aviso que falla no se pierda, que el mismo suceso no
haga sonar el teléfono dos veces, que nada se marque enviado antes de salir, y
que un fallo de aviso no deshaga la devolución que lo provocó.
"""

from __future__ import annotations

import os
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.modules.notifications import entregas, textos
from app.modules.notifications.models import NotificationDelivery
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


# =========================================================================== #
# Los textos: lógica pura
# =========================================================================== #
def test_los_quince_avisos_estan_en_los_tres_idiomas() -> None:
    """Un aviso que solo existe en español es un aviso que media plataforma no
    entiende."""
    assert len(textos.TEXTOS) >= 15
    for tipo, porIdioma in textos.TEXTOS.items():
        assert set(porIdioma) == set(textos.IDIOMAS), tipo
        for idioma, (titulo, cuerpo) in porIdioma.items():
            assert titulo.strip(), (tipo, idioma)
            assert cuerpo.strip(), (tipo, idioma)


def test_ningun_aviso_promete_un_plazo_ni_un_importe() -> None:
    """EL PLAZO BANCARIO NO LO DECIDIMOS NOSOTROS, y la empresa no ha aprobado
    ninguno. «Tu devolución se está procesando» es un hecho; «en 5 días» es una
    promesa que no se puede cumplir.
    """
    import re

    prohibido = re.compile(
        r"\b\d+\s*(d[ií]as?|days?|dias?|horas?|hours?|semanas?|weeks?)\b"
        r"|[$€]|S/|\bUSD\b|\bPEN\b",
        re.IGNORECASE,
    )
    for tipo, porIdioma in textos.TEXTOS.items():
        for idioma, (titulo, cuerpo) in porIdioma.items():
            assert not prohibido.search(titulo), (tipo, idioma, titulo)
            assert not prohibido.search(cuerpo), (tipo, idioma, cuerpo)


def test_un_idioma_que_no_existe_cae_al_de_por_defecto() -> None:
    assert textos.idioma_valido("de") == textos.POR_DEFECTO
    assert textos.idioma_valido(None) == textos.POR_DEFECTO
    assert textos.idioma_valido("") == textos.POR_DEFECTO
    assert textos.idioma_valido("EN") == "en"
    assert textos.idioma_valido("pt-BR") == "pt"


def test_el_texto_sale_en_el_idioma_pedido() -> None:
    es = textos.texto("event_refund_confirmed", locale="es")
    en = textos.texto("event_refund_confirmed", locale="en")
    pt = textos.texto("event_refund_confirmed", locale="pt")
    assert es and en and pt
    assert len({es[0], en[0], pt[0]}) == 3, "tres idiomas, tres títulos distintos"


def test_un_tipo_sin_texto_devuelve_nada_y_no_revienta() -> None:
    """Los tipos anteriores viven en `push.TEMPLATES`; esta tabla no los
    duplica, y pedir uno de allí no es un fallo."""
    assert textos.texto("like", locale="es") is None


def test_la_clave_de_suceso_distingue_persona_tipo_y_entidad() -> None:
    """Va a una columna con índice único: dos sucesos distintos no se pueden
    escribir igual."""
    a = textos.clave_de_suceso("event_case_approved", entidad_id="x", usuario_id="u")
    b = textos.clave_de_suceso("event_case_approved", entidad_id="y", usuario_id="u")
    c = textos.clave_de_suceso("event_case_rejected", entidad_id="x", usuario_id="u")
    d = textos.clave_de_suceso("event_case_approved", entidad_id="x", usuario_id="v")
    assert len({a, b, c, d}) == 4


def test_un_hueco_vacio_no_confunde_dos_claves() -> None:
    """Sin separador fijo, `entidad` ausente hacía que dos claves distintas se
    escribieran igual."""
    a = textos.clave_de_suceso("event_changed", entidad_id=None, usuario_id="u")
    b = textos.clave_de_suceso("event_changed", entidad_id="", usuario_id="u")
    assert a == b
    assert "|-" in a


# =========================================================================== #
# La cola: contra PostgreSQL real
# =========================================================================== #
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
    from app.modules.notifications import esquema

    esquema.olvidar_entregas()
    return True


@pytest_asyncio.fixture()
async def sesiones(base_aplicada):
    motor = create_async_engine(URL.replace("postgresql://", "postgresql+asyncpg://", 1))
    yield async_sessionmaker(motor, expire_on_commit=False)
    await motor.dispose()


async def _persona(sesiones) -> str:
    ident = str(uuid.uuid4())
    async with sesiones() as db:
        await db.execute(
            text(
                "insert into auth.users (id, email, raw_user_meta_data) values "
                "(cast(:i as uuid), cast(:e as text), "
                " jsonb_build_object('full_name','P','username',cast(:u as text)))"
            ),
            {"i": ident, "e": f"av-{ident[:8]}@x.test", "u": f"av{ident[:8]}"},
        )
        await db.commit()
    return ident


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_mismo_suceso_no_se_encola_dos_veces(sesiones) -> None:
    """EL WEBHOOK SE REINTENTA. Tres reintentos del mismo reembolso no pueden
    ser tres veces que suena el teléfono, y lo impide un índice único."""
    quien = await _persona(sesiones)
    caso = str(uuid.uuid4())
    async with sesiones() as db:
        una = await entregas.encolar(
            db, usuario_id=quien, tipo="event_refund_confirmed", entidad_id=caso
        )
        await db.commit()
    async with sesiones() as db:
        otra = await entregas.encolar(
            db, usuario_id=quien, tipo="event_refund_confirmed", entidad_id=caso
        )
        await db.commit()
    assert una is not None
    assert otra is None, "el segundo encolado del mismo suceso no crea nada"

    async with sesiones() as db:
        cuantas = len(
            list(
                await db.scalars(
                    select(NotificationDelivery).where(
                        NotificationDelivery.user_id == quien
                    )
                )
            )
        )
    assert cuantas == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dos_sucesos_distintos_si_se_encolan(sesiones) -> None:
    quien = await _persona(sesiones)
    async with sesiones() as db:
        a = await entregas.encolar(
            db, usuario_id=quien, tipo="event_case_approved", entidad_id="c1"
        )
        b = await entregas.encolar(
            db, usuario_id=quien, tipo="event_case_rejected", entidad_id="c1"
        )
        await db.commit()
    assert a is not None and b is not None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_lo_enviado_se_marca_DESPUES_de_salir(sesiones) -> None:
    """Marcarlo antes es decir que llegó algo que no llegó."""
    quien = await _persona(sesiones)
    async with sesiones() as db:
        fila = await entregas.encolar(
            db, usuario_id=quien, tipo="event_case_submitted", entidad_id="c9"
        )
        await db.commit()
        identificador = fila.id

    salidas: list[str] = []

    async def enviar(db, *, usuario_id, tipo, locale):
        salidas.append(tipo)

    async with sesiones() as db:
        cuenta = await entregas.procesar(db, enviar=enviar)
    # SIN CONTAR LA COLA ENTERA: otras pruebas del modulo dejan las suyas, y
    # una prueba que depende de cuantas haya depende del orden de ejecucion.
    assert cuenta["enviadas"] >= 1
    assert "event_case_submitted" in salidas

    async with sesiones() as db:
        fresca = await db.get(NotificationDelivery, identificador)
        assert fresca.status == entregas.ENVIADA
        assert fresca.sent_at is not None
        assert fresca.last_error is None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_fallo_se_reintenta_con_espera_creciente(sesiones) -> None:
    """Y con tope. Reintentar cada segundo contra un servicio caído es
    insistir, no reintentar."""
    quien = await _persona(sesiones)
    async with sesiones() as db:
        fila = await entregas.encolar(
            db, usuario_id=quien, tipo="event_ticket_held", entidad_id="c8"
        )
        await db.commit()
        identificador = fila.id
        antes = fila.next_attempt_at

    async def revienta(db, *, usuario_id, tipo, locale):
        raise RuntimeError("expo dijo que no")

    async with sesiones() as db:
        cuenta = await entregas.procesar(db, enviar=revienta)
    assert cuenta["reintentables"] == 1

    async with sesiones() as db:
        fresca = await db.get(NotificationDelivery, identificador)
    assert fresca.status == entregas.PENDIENTE
    assert fresca.attempts == 1
    assert fresca.next_attempt_at > antes, "el siguiente intento se aleja"
    assert "expo dijo que no" in (fresca.last_error or "")


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_cuando_se_acaban_los_intentos_queda_fallida(sesiones) -> None:
    """Y ahí se queda: seguir reintentando para siempre esconde el problema."""
    quien = await _persona(sesiones)
    async with sesiones() as db:
        fila = await entregas.encolar(
            db, usuario_id=quien, tipo="event_ticket_revoked", entidad_id="c7"
        )
        await db.commit()
        identificador = fila.id

    async with sesiones() as db:
        # Se lleva al último intento sin esperar horas de verdad.
        await db.execute(
            text(
                "update public.notification_deliveries"
                " set attempts = max_attempts where id = cast(:i as uuid)"
            ),
            {"i": identificador},
        )
        await db.commit()
        estado = await entregas.marcar_fallo(
            db, entrega_id=identificador, error="ya no hay token"
        )
        await db.commit()
    assert estado == entregas.FALLIDA

    async with sesiones() as db:
        fresca = await db.get(NotificationDelivery, identificador)
    assert fresca.status == entregas.FALLIDA
    assert fresca.next_attempt_at is None, "una fallida no vuelve a la cola sola"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_error_se_guarda_saneado_y_acotado(sesiones) -> None:
    """Ni cuerpos de respuesta enteros, ni saltos de línea, ni tokens."""
    quien = await _persona(sesiones)
    async with sesiones() as db:
        fila = await entregas.encolar(
            db, usuario_id=quien, tipo="event_changed", entidad_id="c6"
        )
        await db.commit()
        identificador = fila.id
        await entregas.marcar_fallo(
            db,
            entrega_id=identificador,
            error="linea uno\nlinea dos\r\n" + "x" * 2000,
        )
        await db.commit()

    async with sesiones() as db:
        fresca = await db.get(NotificationDelivery, identificador)
    assert len(fresca.last_error) <= entregas.LARGO_DEL_ERROR
    assert "\n" not in fresca.last_error


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dos_procesos_no_envian_el_mismo_aviso(sesiones) -> None:
    """UPDATE CONDICIONAL: uno cambia una fila y el otro cero."""
    quien = await _persona(sesiones)
    async with sesiones() as db:
        fila = await entregas.encolar(
            db, usuario_id=quien, tipo="event_case_taken", entidad_id="c5"
        )
        await db.commit()
        identificador = fila.id

    async with sesiones() as db:
        primero = await entregas.tomar(db, entrega_id=identificador)
        await db.commit()
    async with sesiones() as db:
        segundo = await entregas.tomar(db, entrega_id=identificador)
        await db.commit()
    assert primero is True
    assert segundo is False


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_entrega_futura_no_se_intenta_todavia(sesiones) -> None:
    quien = await _persona(sesiones)
    async with sesiones() as db:
        fila = await entregas.encolar(
            db,
            usuario_id=quien,
            tipo="event_case_info_requested",
            entidad_id="c4",
            momento=entregas.ahora() + timedelta(hours=1),
        )
        await db.commit()
        assert fila is not None

    async with sesiones() as db:
        cola = await entregas.pendientes(db)
    assert all(f.id != fila.id for f in cola)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_cola_no_la_lee_nadie_desde_el_movil(sesiones) -> None:
    async with sesiones() as db:
        filas = (
            await db.execute(
                text(
                    "select grantee, privilege_type"
                    " from information_schema.table_privileges"
                    " where table_schema='public'"
                    "   and table_name='notification_deliveries'"
                    "   and grantee in ('anon','authenticated')"
                )
            )
        ).all()
    assert filas == [], filas
