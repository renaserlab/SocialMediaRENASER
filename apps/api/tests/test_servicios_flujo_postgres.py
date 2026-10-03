"""Z Servicios: la admisión entera por la API, contra PostgreSQL de verdad.

POR QUÉ SOLO AQUÍ. SQLite no tiene `for update`, ni disparadores, ni la regla
diferida de la 0088 que ata el prestador a su postulación al confirmar. Una
aprobación que en SQLite pasa podría romper en PostgreSQL justo en el
`commit`; y dos decisiones a la vez solo se pueden probar con dos escritores.

LO QUE DEFIENDEN:

  1. EL FLUJO COMPLETO por las rutas reales, sobre las migraciones reales
     (0001–0088): cada commit cumple los disparadores de la 0086, la 0087 y la
     0088, y deja historial, envío congelado, auditoría y avisos.
  2. DOS DECISIONES A LA VEZ sobre la misma postulación: gana una, la otra
     recibe un 409 y el historial tiene UN solo evento de decisión.
  3. DOS ENVÍOS A LA VEZ, o dos altas a la vez, no crean dos de nada.
  4. BORRAR LA CUENTA se lleva lo que la API creó (desde la 0089).
"""

from __future__ import annotations

import asyncio
import io
import os
import uuid
from pathlib import Path

import pytest
import pytest_asyncio
from fastapi import Request
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.security import AuthUser, get_current_user
from app.main import create_app
from app.modules.services import esquema
from app.shared.database import get_db
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

API = "/api/v1"
MIA = f"{API}/services/provider/application"
ADMIN = f"{API}/admin/services"
BANDEJA = f"{ADMIN}/applications"
TEXTO = "Condiciones del prestador de Z Servicios, versión de prueba. " * 3


def _png() -> bytes:
    from PIL import Image

    salida = io.BytesIO()
    Image.new("RGB", (4, 4), (10, 200, 10)).save(salida, format="PNG")
    return salida.getvalue()


PNG = _png()


def _url_async() -> str:
    return URL.replace("postgresql://", "postgresql+asyncpg://", 1)


@pytest.fixture(scope="module")
def base_aplicada():
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
    return True


class _Almacen:
    def __init__(self) -> None:
        self.objetos: dict[str, bytes] = {}

    async def subir(self, bucket, ruta, datos, content_type, *, sobrescribir=False):
        self.objetos[ruta] = datos

    async def firmar(self, bucket, rutas, *, segundos=3600):
        return {r: f"https://almacen.test/{uuid.uuid4()}" for r in rutas}

    async def borrar(self, bucket, ruta):
        self.objetos.pop(ruta, None)
        return True


@pytest_asyncio.fixture()
async def entorno(base_aplicada, monkeypatch):
    from app.shared import storage

    monkeypatch.setattr(get_settings(), "feature_services", True)
    almacen = _Almacen()
    monkeypatch.setattr(storage, "subir_objeto", almacen.subir)
    monkeypatch.setattr(storage, "firmar_objetos", almacen.firmar)
    monkeypatch.setattr(storage, "borrar_objeto", almacen.borrar)
    esquema.olvidar()

    motor = create_async_engine(_url_async(), pool_size=10, max_overflow=5)
    sesiones = async_sessionmaker(motor, expire_on_commit=False)
    app = create_app()

    async def _db():
        async with sesiones() as db:
            yield db

    app.dependency_overrides[get_db] = _db
    try:
        yield app, motor
    finally:
        app.dependency_overrides.clear()
        await motor.dispose()
        esquema.olvidar()


def _cliente(app, uid: str) -> AsyncClient:
    """Un cliente que SIEMPRE es la misma persona (dos a la vez no se pisan)."""

    async def _usuario(request: Request) -> AuthUser:
        return AuthUser(id=request.headers["x-prueba-usuario"], email="x@y.test", role="authenticated")

    app.dependency_overrides[get_current_user] = _usuario
    return AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"x-prueba-usuario": uid},
    )


async def _persona(motor, rol: str = "user") -> str:
    ident = str(uuid.uuid4())
    async with motor.begin() as conexion:
        await conexion.execute(
            text(
                "insert into auth.users (id, email, raw_user_meta_data) values "
                "(cast(:id as uuid), cast(:email as text), "
                " jsonb_build_object('full_name', 'P', 'username', cast(:u as text)))"
            ),
            {"id": ident, "email": f"sv-{ident[:8]}@x.test", "u": f"sv{ident[:8]}"},
        )
        await conexion.execute(
            text("update public.profiles set role = :rol where id = cast(:id as uuid)"),
            {"rol": rol, "id": ident},
        )
    return ident


async def _uno(motor, sql: str, **datos):
    async with motor.connect() as conexion:
        return (await conexion.execute(text(sql), datos)).scalar()


_PAISES = iter(a + b for a in "ABCDEFGHIJKLMNOPQRSTUVWXY" for b in "ABCDEFGHIJKLMNOPQRSTUVWXYZ")


async def _publicar(app, jefa: str) -> str:
    pais = next(_PAISES)
    async with _cliente(app, jefa) as http:
        r = await http.post(
            f"{ADMIN}/policies/provider-terms/draft",
            json={"country_code": pais, "title": "Condiciones", "body": TEXTO},
        )
        assert r.status_code == 201, r.text
        r = await http.post(f"{ADMIN}/policies/{r.json()['id']}/publish")
        assert r.status_code == 200, r.text
    return pais


async def _enviada(app, uid: str, pais: str) -> dict:
    async with _cliente(app, uid) as http:
        r = await http.post(MIA, json={"provider_type": "individual", "display_name": "Ana"})
        assert r.status_code == 201, r.text
        r = await http.patch(
            MIA,
            json={
                "legal_name": "Ana María Quispe",
                "country_code": pais,
                "summary": "Clases de guitarra clásica en persona y en línea desde hace años.",
            },
        )
        assert r.status_code == 200, r.text
        r = await http.post(
            f"{MIA}/documents", data={"kind": "identity"}, files={"file": ("dni.png", PNG, "image/png")}
        )
        assert r.status_code == 201, r.text
        terminos = (await http.get(f"{API}/services/provider/terms")).json()
        r = await http.post(
            f"{MIA}/terms",
            json={"terms_policy_id": terminos["policy_id"], "terms_sha256": terminos["sha256"]},
        )
        assert r.status_code == 200, r.text
        r = await http.post(f"{MIA}/submit", json={"declare_truthfulness": True})
        assert r.status_code == 200, r.text
        return r.json()


async def _en_revision(app, uid: str, revisor: str, pais: str) -> str:
    solicitud = (await _enviada(app, uid, pais))["id"]
    async with _cliente(app, revisor) as http:
        r = await http.post(f"{BANDEJA}/{solicitud}/start-review", json={})
        assert r.status_code == 200, r.text
        for d in r.json()["documents"]:
            assert (await http.post(f"{BANDEJA}/{solicitud}/documents/{d['id']}/accept")).status_code == 200
    return solicitud


# =========================================================================== #
async def test_el_flujo_completo_cumple_todas_las_reglas_de_la_base(entorno) -> None:
    app, motor = entorno
    jefa, moderador, ana = await _persona(motor, "admin"), await _persona(motor, "moderator"), await _persona(motor)
    pais = await _publicar(app, jefa)
    solicitud = await _en_revision(app, ana, moderador, pais)

    async with _cliente(app, jefa) as http:
        r = await http.post(f"{BANDEJA}/{solicitud}/approve", json={"message": "Bienvenida."})
        assert r.status_code == 200, r.text
        assert (r.json()["status"], r.json()["provider"]["status"]) == ("approved", "active")
        r = await http.post(f"{BANDEJA}/{solicitud}/suspend", json={"message": "Revisión de un reclamo."})
        assert (r.json()["status"], r.json()["provider"]["status"]) == ("suspended", "suspended")
        r = await http.post(f"{BANDEJA}/{solicitud}/start-review", json={})
        assert (r.json()["status"], r.json()["provider"]["status"]) == ("under_review", "suspended")
        r = await http.post(f"{BANDEJA}/{solicitud}/approve", json={})
        assert (r.json()["status"], r.json()["provider"]["status"]) == ("approved", "active")
        historial = (await http.get(f"{BANDEJA}/{solicitud}/history")).json()

    assert [e["to_status"] for e in historial] == [
        "draft", "submitted", "under_review", "approved", "suspended", "under_review", "approved",
    ]
    assert await _uno(
        motor,
        "select count(*) from service_provider_application_submissions where application_id = cast(:s as uuid)",
        s=solicitud,
    ) == 1
    assert await _uno(
        motor,
        "select count(*) from audit_events where entity_id = cast(:s as uuid) "
        "and action like 'service_application.%'",
        s=solicitud,
    ) >= 7
    # Avisos a quien postula: revisión, aprobada, suspendida, revisión, aprobada.
    assert await _uno(
        motor,
        "select count(*) from notifications where user_id = cast(:u as uuid) and type like 'service_%'",
        u=ana,
    ) == 5
    # Lo propio de quien postula nunca lleva la ruta del archivo.
    async with _cliente(app, ana) as http:
        assert "storage_path" not in (await http.get(MIA)).text


async def test_dos_decisiones_a_la_vez_gana_una_sola(entorno) -> None:
    app, motor = entorno
    jefa, otra_jefa, moderador, ana = (
        await _persona(motor, "admin"), await _persona(motor, "admin"),
        await _persona(motor, "moderator"), await _persona(motor),
    )
    pais = await _publicar(app, jefa)
    solicitud = await _en_revision(app, ana, moderador, pais)

    async def decidir(uid: str, accion: str, cuerpo: dict):
        async with _cliente(app, uid) as http:
            return await http.post(f"{BANDEJA}/{solicitud}/{accion}", json=cuerpo)

    respuestas = await asyncio.gather(
        decidir(jefa, "approve", {}),
        decidir(otra_jefa, "reject", {"message": "No cumple los requisitos."}),
    )
    codigos = sorted(r.status_code for r in respuestas)
    assert codigos == [200, 409], [r.text for r in respuestas]
    perdedora = next(r for r in respuestas if r.status_code == 409)
    assert perdedora.json()["error"]["code"] == "service_application_transition_invalid"
    decisiones = await _uno(
        motor,
        "select count(*) from service_provider_application_events where application_id = cast(:s as uuid) "
        "and to_status in ('approved', 'rejected')",
        s=solicitud,
    )
    assert decisiones == 1
    estado, prestador = (
        await _uno(motor, "select status from service_provider_applications where id = cast(:s as uuid)", s=solicitud),
        await _uno(
            motor,
            "select p.status from service_providers p join service_provider_applications a "
            "on a.provider_id = p.id where a.id = cast(:s as uuid)",
            s=solicitud,
        ),
    )
    assert (estado, prestador) in {("approved", "active"), ("rejected", "pending")}


async def test_dos_envios_o_dos_altas_a_la_vez_no_crean_dos(entorno) -> None:
    app, motor = entorno
    jefa, ana, bea = await _persona(motor, "admin"), await _persona(motor), await _persona(motor)
    pais = await _publicar(app, jefa)

    async def alta(uid: str):
        async with _cliente(app, uid) as http:
            return await http.post(MIA, json={"provider_type": "individual", "display_name": "Bea"})

    altas = await asyncio.gather(alta(bea), alta(bea))
    assert sorted(r.status_code for r in altas) == [200, 201], [r.text for r in altas]
    assert altas[0].json()["id"] == altas[1].json()["id"]
    assert await _uno(
        motor,
        "select count(*) from service_provider_applications a join service_providers p "
        "on p.id = a.provider_id where p.profile_id = cast(:u as uuid)",
        u=bea,
    ) == 1

    enviada = await _enviada(app, ana, pais)
    # Reenviar el envío dos veces a la vez sobre la ya enviada: nada nuevo.
    async def enviar():
        async with _cliente(app, ana) as http:
            return await http.post(f"{MIA}/submit", json={"declare_truthfulness": True})

    otra_vez = await asyncio.gather(enviar(), enviar())
    assert [r.status_code for r in otra_vez] == [200, 200]
    assert await _uno(
        motor,
        "select count(*) from service_provider_application_submissions where application_id = cast(:s as uuid)",
        s=enviada["id"],
    ) == 1
    assert await _uno(
        motor,
        "select count(*) from service_provider_application_events where application_id = cast(:s as uuid) "
        "and to_status = 'submitted'",
        s=enviada["id"],
    ) == 1


async def test_dos_envios_a_la_vez_desde_el_borrador_solo_envian_uno(entorno) -> None:
    app, motor = entorno
    jefa, carla = await _persona(motor, "admin"), await _persona(motor)
    pais = await _publicar(app, jefa)
    async with _cliente(app, carla) as http:
        await http.post(MIA, json={"provider_type": "individual", "display_name": "Carla"})
        await http.patch(
            MIA,
            json={
                "legal_name": "Carla Rojas", "country_code": pais,
                "summary": "Asesoría contable para pequeños negocios familiares.",
            },
        )
        await http.post(f"{MIA}/documents", data={"kind": "identity"}, files={"file": ("d.png", PNG, "image/png")})
        terminos = (await http.get(f"{API}/services/provider/terms")).json()
        await http.post(
            f"{MIA}/terms", json={"terms_policy_id": terminos["policy_id"], "terms_sha256": terminos["sha256"]}
        )

    async def enviar():
        async with _cliente(app, carla) as http:
            return await http.post(f"{MIA}/submit", json={"declare_truthfulness": True})

    respuestas = await asyncio.gather(enviar(), enviar(), enviar())
    assert all(r.status_code == 200 for r in respuestas), [r.text for r in respuestas]
    solicitud = respuestas[0].json()["id"]
    assert await _uno(
        motor,
        "select count(*) from service_provider_application_submissions where application_id = cast(:s as uuid)",
        s=solicitud,
    ) == 1


async def test_borrar_la_cuenta_se_lleva_lo_que_creo_la_api(entorno) -> None:
    """Fue una `xfail` estricta hasta la 0089: `audit_events` es de solo añadir
    pero su `actor_id` es `on delete set null`, y borrar el perfil de quien
    figuraba en la auditoría pedía un UPDATE que el disparador rechazaba. La
    0089 admite esa puesta a NULL y solo esa. El recorrido completo por
    `DELETE /auth/me` está en `test_baja_de_cuenta_postgres.py`."""
    app, motor = entorno
    jefa, moderador, dora = await _persona(motor, "admin"), await _persona(motor, "moderator"), await _persona(motor)
    pais = await _publicar(app, jefa)
    solicitud = await _en_revision(app, dora, moderador, pais)
    async with _cliente(app, jefa) as http:
        assert (await http.post(f"{BANDEJA}/{solicitud}/approve", json={})).status_code == 200

    async with motor.begin() as conexion:
        await conexion.execute(text("delete from public.profiles where id = cast(:u as uuid)"), {"u": dora})
    for tabla in (
        "service_provider_applications", "service_provider_documents",
        "service_provider_credentials", "service_provider_application_events",
        "service_provider_application_submissions",
    ):
        columna = "id" if tabla == "service_provider_applications" else "application_id"
        assert not await _uno(
            motor, f"select count(*) from {tabla} where {columna} = cast(:s as uuid)", s=solicitud
        ), tabla
    # Lo que decidió administración sigue en su auditoría.
    assert await _uno(
        motor,
        "select count(*) from audit_events where entity_id = cast(:s as uuid) "
        "and action = 'service_application.approved'",
        s=solicitud,
    ) == 1


# --------------------------------------------------------------------------- #
# Hallazgos de la revisión independiente (29/09/2026)
# --------------------------------------------------------------------------- #
async def test_M2_escribir_espera_al_bloqueo_y_no_cambia_lo_ya_enviado(entorno) -> None:
    """Las escrituras de quien postula leían su postulación SIN bloquearla: un
    PATCH o una subida que se colaba mientras se enviaba cambiaba lo enviado
    después de congelarlo. Ahora esperan al bloqueo de la fila y, cuando les
    toca, ven que ya está enviada."""
    app, motor = entorno
    jefa, ana = await _persona(motor, "admin"), await _persona(motor)
    pais = await _publicar(app, jefa)
    async with _cliente(app, ana) as http:
        r = await http.post(MIA, json={"provider_type": "individual", "display_name": "Ana"})
        solicitud = r.json()["id"]
        await http.patch(
            MIA,
            json={"legal_name": "Ana María Quispe", "country_code": pais,
                  "summary": "Clases de guitarra clásica en persona y en línea desde hace años."},
        )
        await http.post(f"{MIA}/documents", data={"kind": "identity"}, files={"file": ("dni.png", PNG, "image/png")})
        terminos = (await http.get(f"{API}/services/provider/terms")).json()
        await http.post(f"{MIA}/terms", json={"terms_policy_id": terminos["policy_id"], "terms_sha256": terminos["sha256"]})

    # Otra transacción tiene la fila (como un envío a medias).
    conexion = await motor.connect()
    transaccion = await conexion.begin()
    await conexion.execute(
        text("select id from service_provider_applications where id = cast(:s as uuid) for update"),
        {"s": solicitud},
    )

    async def cambiar():
        async with _cliente(app, ana) as http:
            return await http.patch(MIA, json={"legal_name": "Cambiado tras enviar"})

    async def subir():
        async with _cliente(app, ana) as http:
            return await http.post(
                f"{MIA}/documents", data={"kind": "other"}, files={"file": ("otro.png", PNG + b"x", "image/png")}
            )

    tareas = [asyncio.create_task(cambiar()), asyncio.create_task(subir())]
    await asyncio.sleep(0.8)
    assert not any(t.done() for t in tareas), "escribieron sin esperar al bloqueo"
    # El «envío» termina: la postulación deja de ser editable.
    await conexion.execute(
        text("update service_provider_applications set status = 'submitted', submitted_at = now(), "
             "last_submitted_at = now(), truthfulness_declared_at = now() where id = cast(:s as uuid)"),
        {"s": solicitud},
    )
    await transaccion.commit()
    await conexion.close()
    parche, subida = await asyncio.gather(*tareas)
    assert parche.status_code == 409, parche.text
    assert subida.status_code == 409, subida.text
    assert await _uno(
        motor,
        "select p.legal_name from service_providers p join service_provider_applications a "
        "on a.provider_id = p.id where a.id = cast(:s as uuid)",
        s=solicitud,
    ) == "Ana María Quispe"
    assert await _uno(
        motor, "select count(*) from service_provider_documents where application_id = cast(:s as uuid)", s=solicitud
    ) == 1


async def test_L6_dos_borradores_o_dos_publicaciones_a_la_vez_no_dan_500(entorno) -> None:
    app, motor = entorno
    jefa, otra = await _persona(motor, "admin"), await _persona(motor, "admin")
    pais = next(_PAISES)

    async def borrador(uid: str):
        async with _cliente(app, uid) as http:
            return await http.post(
                f"{ADMIN}/policies/provider-terms/draft",
                json={"country_code": pais, "title": "Condiciones", "body": TEXTO},
            )

    borradores = await asyncio.gather(borrador(jefa), borrador(otra))
    assert sorted(r.status_code for r in borradores) == [200, 201], [r.text for r in borradores]
    assert borradores[0].json()["id"] == borradores[1].json()["id"]
    politica = borradores[0].json()["id"]

    async def publicar(uid: str):
        async with _cliente(app, uid) as http:
            return await http.post(f"{ADMIN}/policies/{politica}/publish")

    publicaciones = await asyncio.gather(publicar(jefa), publicar(otra))
    assert [r.status_code for r in publicaciones] == [200, 200], [r.text for r in publicaciones]
    assert await _uno(
        motor,
        "select count(*) from service_policies where country_code = :p and status = 'published'",
        p=pais,
    ) == 1


async def test_L6b_dos_borradores_del_mismo_pais_nunca_son_dos(entorno) -> None:
    """La carrera que hacía intermitente a L6 (1 de cada 10 o 20 veces): la
    otra petición confirma su borrador JUSTO entre las dos consultas de
    `politicas.borrador` («¿hay ya un borrador?» y «¿cuál es la versión más
    alta?»). La segunda creaba entonces la versión 2: dos borradores del mismo
    país, los dos con 201. Aquí esa intercalación se fuerza."""
    from app.modules.services import politicas

    _, motor = entorno
    jefa = await _persona(motor, "admin")
    pais = next(_PAISES)
    sesiones = async_sessionmaker(motor, expire_on_commit=False)
    en_pausa, seguir = asyncio.Event(), asyncio.Event()

    async def crear(db) -> tuple[str, bool]:
        politica, nueva = await politicas.borrador(
            db, pais=pais, categoria=None, titulo="Condiciones", texto=TEXTO, parametros=None, autor_id=jefa
        )
        await db.commit()
        return politica.id, nueva

    async with sesiones() as primera, sesiones() as segunda:
        consultar = primera.scalar
        pausada = False

        async def consultar_y_esperar(*args, **kwargs):
            nonlocal pausada
            resultado = await consultar(*args, **kwargs)
            if not pausada:  # justo después de «¿hay ya un borrador?»
                pausada = True
                en_pausa.set()
                await seguir.wait()
            return resultado

        primera.scalar = consultar_y_esperar
        tarea_primera = asyncio.create_task(crear(primera))
        await en_pausa.wait()
        tarea_segunda = asyncio.create_task(crear(segunda))
        # Sin serializar, la segunda termina aquí; serializada, espera a la primera.
        await asyncio.wait({tarea_segunda}, timeout=2)
        seguir.set()
        resultados = await asyncio.gather(tarea_primera, tarea_segunda)

    assert sorted(nueva for _, nueva in resultados) == [False, True], resultados
    assert resultados[0][0] == resultados[1][0]
    assert await _uno(
        motor, "select count(*) from service_policies where country_code = :p and status = 'draft'", p=pais
    ) == 1
