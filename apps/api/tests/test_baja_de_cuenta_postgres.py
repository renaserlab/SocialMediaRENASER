"""Borrar la cuenta (`DELETE /auth/me`) contra PostgreSQL de verdad.

POR QUÉ SOLO AQUÍ. Lo que decide si una cuenta se puede borrar son las claves
ajenas y los disparadores de las migraciones reales: `on delete set null`
contra historiales de solo añadir, cascadas contra filas que «no se borran» y
`restrict` de ventas. SQLite no ejecuta ninguno. Una prueba que borrara el
perfil con un `delete` suelto tampoco sirve: el recorrido es el del endpoint,
con su orden y su transacción.

EL ALMACENAMIENTO es un Supabase Storage en memoria con sus reglas de verdad:
el listado NO es recursivo (una carpeta llega con `id: null`), va paginado,
y borrar quita NOMBRES EXACTOS y tolera los que no existen. Las subidas de
Servicios pasan por él, así que los documentos que se borran son los que la
API subió.
"""

from __future__ import annotations

import io
import json
import os
import uuid
from datetime import date, timedelta
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from fastapi import Request
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.security import AuthUser, get_current_user
from app.main import create_app
from app.modules.identity import baja
from app.modules.services import esquema
from app.shared import storage
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
ME = f"{API}/auth/me"
MIA = f"{API}/services/provider/application"
ADMIN = f"{API}/admin/services"
BANDEJA = f"{ADMIN}/applications"
TEXTO = "Condiciones del prestador de Z Servicios, versión de prueba. " * 3
ALMACEN = "https://almacen.test"
_ClienteReal = httpx.AsyncClient


def _png(color: tuple[int, int, int]) -> bytes:
    from PIL import Image

    salida = io.BytesIO()
    Image.new("RGB", (4, 4), color).save(salida, format="PNG")
    return salida.getvalue()


PNG = _png((10, 200, 10))
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


# --------------------------------------------------------------------------- #
# Supabase Storage, en memoria y con sus reglas
# --------------------------------------------------------------------------- #
class StorageDeMentira:
    def __init__(self) -> None:
        self.objetos: dict[str, dict[str, bytes]] = {}
        #: Depósitos en los que listar (y borrar) falla con un 500.
        self.fallar_en: set[str] = set()
        #: Depósitos que se dejan listar pero no borrar.
        self.fallar_al_borrar_en: set[str] = set()
        #: Prefijos EXACTOS cuyo listado falla (una conversación entera, p. ej.).
        self.fallar_al_listar: set[tuple[str, str]] = set()
        self.borrados: list[tuple[str, list[str]]] = []

    def poner(self, deposito: str, *rutas: str) -> None:
        for ruta in rutas:
            self.objetos.setdefault(deposito, {})[ruta] = b"x"

    def de(self, deposito: str, prefijo: str) -> list[str]:
        return sorted(r for r in self.objetos.get(deposito, {}) if r.startswith(prefijo.rstrip("/") + "/"))

    def responder(self, peticion: httpx.Request) -> httpx.Response:
        if peticion.url.host != "almacen.test":
            return httpx.Response(404)
        camino = peticion.url.path.split("/storage/v1/object/", 1)[1]
        cuerpo = json.loads(peticion.content or b"{}") if peticion.method != "POST" or camino.startswith(("list/", "sign/")) else {}
        if peticion.method == "POST" and camino.startswith("list/"):
            deposito = camino[len("list/"):]
            if deposito in self.fallar_en or (deposito, cuerpo["prefix"]) in self.fallar_al_listar:
                return httpx.Response(500, json={"error": "caído"})
            prefijo = cuerpo["prefix"].rstrip("/") + "/"
            nivel: dict[str, str | None] = {}
            for ruta in self.objetos.get(deposito, {}):
                if ruta.startswith(prefijo):
                    resto = ruta[len(prefijo):]
                    cabeza = resto.split("/", 1)[0]
                    nivel[cabeza] = None if "/" in resto else f"id-{cabeza}"
            pagina = [{"name": k, "id": v} for k, v in sorted(nivel.items())]
            desde = cuerpo.get("offset", 0)
            return httpx.Response(200, json=pagina[desde:desde + cuerpo["limit"]])
        if peticion.method == "POST" and camino.startswith("sign/"):
            deposito = camino[len("sign/"):]
            existentes = self.objetos.get(deposito, {})
            return httpx.Response(200, json=[
                {"path": r, "signedURL": f"/object/sign/{deposito}/{r}?token=t"} if r in existentes
                else {"path": r, "error": "Object not found", "signedURL": None}
                for r in cuerpo["paths"]
            ])
        if peticion.method == "POST":
            deposito, ruta = camino.split("/", 1)
            self.objetos.setdefault(deposito, {})[ruta] = peticion.content
            return httpx.Response(200, json={"Key": f"{deposito}/{ruta}"})
        if peticion.method == "DELETE":
            deposito = camino
            if deposito in self.fallar_en | self.fallar_al_borrar_en:
                return httpx.Response(500, json={"error": "caído"})
            quitados = [r for r in cuerpo["prefixes"] if self.objetos.get(deposito, {}).pop(r, None) is not None]
            self.borrados.append((deposito, list(cuerpo["prefixes"])))
            return httpx.Response(200, json=[{"name": r} for r in quitados])
        return httpx.Response(405)


# --------------------------------------------------------------------------- #
# Base y aplicación
# --------------------------------------------------------------------------- #
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


@pytest_asyncio.fixture()
async def entorno(base_aplicada, monkeypatch):
    ajustes = get_settings()
    monkeypatch.setattr(ajustes, "feature_services", True)
    # Valores DE PRUEBA: el almacén es el de mentira de arriba.
    monkeypatch.setattr(ajustes, "supabase_url", ALMACEN)
    monkeypatch.setattr(ajustes, "supabase_service_role_key", "clave-de-prueba")
    almacen = StorageDeMentira()
    monkeypatch.setattr(
        storage.httpx, "AsyncClient",
        lambda **kw: _ClienteReal(transport=httpx.MockTransport(almacen.responder), **kw),
    )
    esquema.olvidar()
    baja.olvidar()

    motor = create_async_engine(_url_async(), pool_size=10, max_overflow=5)
    sesiones = async_sessionmaker(motor, expire_on_commit=False)
    app = create_app()

    async def _db():
        async with sesiones() as db:
            yield db

    async def _usuario(request: Request) -> AuthUser:
        return AuthUser(id=request.headers["x-prueba-usuario"], email="x@y.test", role="authenticated")

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _usuario
    try:
        yield app, motor, almacen
    finally:
        app.dependency_overrides.clear()
        await motor.dispose()
        esquema.olvidar()
        baja.olvidar()


def _cliente(app, uid: str) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test", headers={"x-prueba-usuario": uid})


async def _persona(motor, rol: str = "user", etiqueta: str = "p") -> str:
    ident = str(uuid.uuid4())
    async with motor.begin() as conexion:
        await conexion.execute(
            text(
                "insert into auth.users (id, email, raw_user_meta_data) values "
                "(cast(:id as uuid), cast(:email as text), "
                " jsonb_build_object('full_name', 'P', 'username', cast(:u as text)))"
            ),
            {"id": ident, "email": f"{etiqueta}-{ident[:8]}@x.test", "u": f"{etiqueta}{ident[:8]}"},
        )
        await conexion.execute(
            text("update public.profiles set role = :rol where id = cast(:id as uuid)"),
            {"rol": rol, "id": ident},
        )
    return ident


async def _uno(motor, sql: str, **datos):
    async with motor.connect() as conexion:
        return (await conexion.execute(text(sql), datos)).scalar()


async def _filas(motor, sql: str, **datos) -> list:
    async with motor.connect() as conexion:
        return [tuple(f) for f in (await conexion.execute(text(sql), datos)).all()]


async def _existe(motor, uid: str) -> bool:
    return bool(
        await _uno(motor, "select count(*) from public.profiles where id = cast(:u as uuid)", u=uid)
        + await _uno(motor, "select count(*) from auth.users where id = cast(:u as uuid)", u=uid)
    )


async def _borrar_cuenta(app, uid: str) -> httpx.Response:
    async with _cliente(app, uid) as http:
        return await http.delete(ME)


# --------------------------------------------------------------------------- #
# Servicios, por la API
# --------------------------------------------------------------------------- #
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


async def _borrador(app, uid: str, pais: str) -> str:
    """Postulación en borrador con datos, un documento de identidad, una
    credencial con su evidencia y las condiciones aceptadas."""
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
        r = await http.post(f"{MIA}/documents", data={"kind": "identity"}, files={"file": ("dni.png", PNG, "image/png")})
        assert r.status_code == 201, r.text
        r = await http.post(
            f"{MIA}/documents", data={"kind": "professional_license"},
            files={"file": ("colegiatura.pdf", PDF, "application/pdf")},
        )
        assert r.status_code == 201, r.text
        evidencia = next(d for d in r.json()["documents"] if d["kind"] == "professional_license")
        r = await http.post(
            f"{MIA}/credentials",
            json={
                "kind": "professional_license", "title": "Colegiatura", "issuer": "Colegio",
                "number": "PSI-2020-4587", "expires_on": str(date.today() + timedelta(days=365)),
                "evidence_document_id": evidencia["id"],
            },
        )
        assert r.status_code == 201, r.text
        terminos = (await http.get(f"{API}/services/provider/terms")).json()
        r = await http.post(
            f"{MIA}/terms", json={"terms_policy_id": terminos["policy_id"], "terms_sha256": terminos["sha256"]}
        )
        assert r.status_code == 200, r.text
        return r.json()["id"]


async def _llevar(app, uid: str, estado: str, *, jefa: str, moderador: str) -> str:
    """Una postulación en `estado`, recorriendo los saltos reales."""
    pais = await _publicar(app, jefa)
    solicitud = await _borrador(app, uid, pais)
    if estado == "draft":
        return solicitud
    async with _cliente(app, uid) as yo, _cliente(app, moderador) as mod, _cliente(app, jefa) as adm:
        if estado == "withdrawn":
            assert (await yo.post(f"{MIA}/withdraw", json={"confirm": True, "reason": "Ya no lo necesito"})).status_code == 200
            return solicitud
        assert (await yo.post(f"{MIA}/submit", json={"declare_truthfulness": True})).status_code == 200
        if estado == "submitted":
            return solicitud
        r = await mod.post(f"{BANDEJA}/{solicitud}/start-review", json={})
        assert r.status_code == 200, r.text
        if estado == "under_review":
            return solicitud
        if estado in ("changes_requested", "resubmitted"):
            r = await mod.post(f"{BANDEJA}/{solicitud}/request-changes", json={"message": "Sube el DNI por ambas caras."})
            assert r.status_code == 200, r.text
            if estado == "changes_requested":
                return solicitud
            r = await yo.post(f"{MIA}/resubmit", json={"declare_truthfulness": True})
            assert r.status_code == 200, r.text
            return solicitud
        if estado == "rejected":
            r = await adm.post(f"{BANDEJA}/{solicitud}/reject", json={"message": "No cumple los requisitos."})
            assert r.status_code == 200, r.text
            return solicitud
        detalle = r.json()
        for d in detalle["documents"]:
            assert (await mod.post(f"{BANDEJA}/{solicitud}/documents/{d['id']}/accept")).status_code == 200
        for c in detalle["credentials"]:
            assert (await mod.post(f"{BANDEJA}/{solicitud}/credentials/{c['id']}/verify")).status_code == 200
        r = await adm.post(f"{BANDEJA}/{solicitud}/approve", json={"message": "Bienvenida."})
        assert r.status_code == 200, r.text
        if estado == "suspended":
            r = await adm.post(f"{BANDEJA}/{solicitud}/suspend", json={"message": "Revisión de un reclamo."})
            assert r.status_code == 200, r.text
        return solicitud


SERVICIOS = (
    ("service_provider_applications", "id"),
    ("service_provider_documents", "application_id"),
    ("service_provider_credentials", "application_id"),
    ("service_provider_application_events", "application_id"),
    ("service_provider_application_submissions", "application_id"),
)


async def _restos_de_servicios(motor, solicitud: str) -> dict[str, int]:
    return {
        tabla: await _uno(motor, f"select count(*) from public.{tabla} where {columna} = cast(:s as uuid)", s=solicitud)
        for tabla, columna in SERVICIOS
    }


# =========================================================================== #
# 1. LA REPRODUCCIÓN: auditoría + Servicios, por el endpoint real
# =========================================================================== #
async def test_borrar_la_cuenta_de_quien_figura_en_la_auditoria(entorno) -> None:
    """El caso que se encontró el 29/09/2026 al cerrar el Incremento 1.

    Ana postula a Servicios: su alta, su envío y sus documentos escriben
    `audit_events` con `actor_id = Ana`. Borrar el perfil pide a PostgreSQL
    `UPDATE audit_events SET actor_id = NULL` (la clave es `on delete set
    null`) y el disparador de solo añadir lo rechazaba: 23001 y la transacción
    entera abortada. Y como los archivos se borraban ANTES, Ana se quedaba sin
    sus documentos y con la cuenta viva.
    """
    app, motor, almacen = entorno
    jefa, moderador, ana = await _persona(motor, "admin"), await _persona(motor, "moderator"), await _persona(motor)
    solicitud = await _llevar(app, ana, "under_review", jefa=jefa, moderador=moderador)
    almacen.poner("post-media", f"{ana}/foto.jpg")
    assert await _uno(
        motor, "select count(*) from public.audit_events where actor_id = cast(:u as uuid)", u=ana
    ) > 0, "el escenario tiene que tener auditoría de Ana (si no, la prueba pasa por vacío)"
    documentos = almacen.de("service-provider-documents", ana)
    assert len(documentos) == 2
    auditoria_antes = await _filas(
        motor,
        "select id, occurred_at, actor_role, action, entity_type, entity_id, outcome, previous_state, "
        "new_state, reason, payload::text from public.audit_events where actor_id = cast(:u as uuid) order by id",
        u=ana,
    )

    r = await _borrar_cuenta(app, ana)

    assert r.status_code == 204, r.text
    assert not await _existe(motor, ana)
    assert await _restos_de_servicios(motor, solicitud) == {t: 0 for t, _ in SERVICIOS}
    assert almacen.de("service-provider-documents", ana) == []
    assert almacen.de("post-media", ana) == []
    # La auditoría sigue ENTERA, y sin nombrar a Ana.
    ids = [f[0] for f in auditoria_antes]
    despues = await _filas(
        motor,
        "select id, occurred_at, actor_role, action, entity_type, entity_id, outcome, previous_state, "
        "new_state, reason, payload::text from public.audit_events where id = any(cast(:ids as uuid[])) order by id",
        ids=ids,
    )
    assert despues == auditoria_antes
    assert await _uno(
        motor, "select count(*) from public.audit_events where id = any(cast(:ids as uuid[])) and actor_id is null", ids=ids
    ) == len(ids)
    # Lo que hizo el equipo sobre su postulación sigue firmado por el equipo.
    assert await _uno(
        motor,
        "select count(*) from public.audit_events where entity_id = cast(:s as uuid) and actor_id = cast(:m as uuid)",
        s=solicitud, m=moderador,
    ) >= 1


# =========================================================================== #
# Montajes por vertical, con las tablas reales
# =========================================================================== #
async def _escribir(motor, sql: str, **datos):
    async with motor.begin() as conexion:
        resultado = await conexion.execute(text(sql), datos)
        return resultado.scalar() if resultado.returns_rows else None


async def _sembrar(motor, sql: str, **datos) -> None:
    """SOLO para historiales cuya madre exige el circuito de pagos, que está
    apagado (disputas, devoluciones, posventa): la fila se siembra sin comprobar
    sus claves ajenas y se CONFIRMA. El borrado de después va con las claves y
    los disparadores reales; lo que se prueba es qué le pasa al actor."""
    async with motor.begin() as conexion:
        await conexion.execute(text("set local session_replication_role = replica"))
        await conexion.execute(text(sql), datos)


async def _curso(motor, autor: str, *, publico: str | None = None) -> tuple[str, str]:
    curso = str(await _escribir(
        motor, "insert into public.courses (author_id, title) values (cast(:a as uuid), 'Guitarra') returning id", a=autor
    ))
    version = str(await _escribir(
        motor,
        "insert into public.course_versions (course_id, version, status, content_hash, snapshot, published_by) "
        "values (cast(:c as uuid), 1, 'published', 'h', '{}', cast(:p as uuid)) returning id",
        c=curso, p=publico or autor,
    ))
    return curso, version


async def _alumno(motor, alumno: str, curso: str) -> None:
    await _escribir(
        motor,
        "insert into public.course_enrollments (user_id, course_id, source) values (cast(:u as uuid), cast(:c as uuid), 'free')",
        u=alumno, c=curso,
    )
    await _escribir(
        motor,
        "insert into public.course_reviews (course_id, user_id, rating, comment) "
        "values (cast(:c as uuid), cast(:u as uuid), 5, 'Muy bueno')",
        u=alumno, c=curso,
    )


async def _venta_de_curso(motor, comprador: str, curso: str, version: str) -> str:
    producto = str(await _escribir(
        motor, "insert into public.commerce_products (kind, course_id) values ('course_lifetime', cast(:c as uuid)) returning id",
        c=curso,
    ))
    return str(await _escribir(
        motor,
        "insert into public.orders (user_id, commerce_product_id, provider, channel, status, amount_minor, currency, "
        "course_version_id, snapshot_origin) values (cast(:u as uuid), cast(:p as uuid), 'stripe', 'web', 'paid', 4900, "
        "'PEN', cast(:v as uuid), 'live') returning id",
        u=comprador, p=producto, v=version,
    ))


async def _evento(motor, organizador: str) -> tuple[str, str]:
    evento = str(await _escribir(
        motor,
        "insert into public.events (organizer_id, title, starts_at, status) "
        "values (cast(:o as uuid), 'Concierto', now() + interval '20 days', 'published') returning id",
        o=organizador,
    ))
    await _escribir(
        motor, "insert into public.event_operations (event_id, workflow_status, origin) "
        "values (cast(:e as uuid), 'PUBLISHED', 'events_v2')", e=evento,
    )
    await _escribir(
        motor, "insert into public.event_ticketing_settings (event_id, access_mode, currency) "
        "values (cast(:e as uuid), 'TICKETED', 'PEN')", e=evento,
    )
    await _escribir(
        motor, "insert into public.event_versions (event_id, version, snapshot, created_by) "
        "values (cast(:e as uuid), 1, '{}', cast(:o as uuid))", e=evento, o=organizador,
    )
    await _escribir(
        motor,
        "insert into public.event_policies (policy_type, scope, event_id, version, params_sha256, status, "
        "published_at, created_by, published_by) values ('review_window', 'event', cast(:e as uuid), 'v1', "
        "repeat('a', 64), 'published', now(), cast(:o as uuid), cast(:o as uuid))",
        e=evento, o=organizador,
    )
    tipo = str(await _escribir(
        motor,
        "insert into public.event_ticket_types (event_id, name, price_minor, currency, quota, max_per_order, status) "
        "values (cast(:e as uuid), 'General', 0, 'PEN', 10, 10, 'on_sale') returning id",
        e=evento,
    ))
    return evento, tipo


async def _asistencia(
    motor, evento: str, tipo: str, asistente: str, *, organizador: str, stripe: bool = False
) -> str:
    """Reserva, orden gratuita pagada con su entrada, aceptación de la política,
    acceso y reseña con respuesta del organizador. Devuelve la reseña."""
    # La reserva y sus líneas, EN LA MISMA TRANSACCIÓN: el cuadre es diferido.
    async with motor.begin() as c:
        reserva = str((await c.execute(text(
            "insert into public.event_ticket_holds (event_id, user_id, idempotency_key, request_fingerprint, status, "
            "currency, subtotal_minor, expires_at) values (cast(:e as uuid), cast(:u as uuid), "
            "cast(gen_random_uuid() as text), 'f', 'CONSUMED', 'PEN', 0, now() + interval '1 hour') returning id"
        ), {"e": evento, "u": asistente})).scalar())
        await c.execute(text(
            "insert into public.event_ticket_hold_items (hold_id, event_id, ticket_type_id, quantity, unit_price_minor, "
            "subtotal_minor, ticket_type_name_snapshot) values (cast(:h as uuid), cast(:e as uuid), cast(:t as uuid), 1, 0, 0, 'General')"
        ), {"h": reserva, "e": evento, "t": tipo})
    async with motor.begin() as c:
        orden = str((await c.execute(text(
            "insert into public.event_orders (event_id, buyer_id, hold_id, currency, subtotal_minor, total_minor, idempotency_key) "
            "values (cast(:e as uuid), cast(:u as uuid), cast(:h as uuid), 'PEN', 0, 0, cast(gen_random_uuid() as text)) returning id"
        ), {"e": evento, "u": asistente, "h": reserva})).scalar())
        linea = str((await c.execute(text(
            "insert into public.event_order_items (order_id, event_id, ticket_type_id, ticket_type_name_snapshot, "
            "unit_price_minor, quantity, subtotal_minor) values (cast(:o as uuid), cast(:e as uuid), cast(:t as uuid), "
            "'General', 0, 1, 0) returning id"
        ), {"o": orden, "e": evento, "t": tipo})).scalar())
        entrada = str((await c.execute(text(
            "insert into public.event_tickets (event_id, order_id, order_item_id, owner_id, ticket_type_id, "
            "ticket_type_name_snapshot, credential_hash) values (cast(:e as uuid), cast(:o as uuid), cast(:l as uuid), "
            "cast(:u as uuid), cast(:t as uuid), 'General', md5(random()::text) || md5(random()::text)) returning id"
        ), {"e": evento, "o": orden, "l": linea, "u": asistente, "t": tipo})).scalar())
        await c.execute(text(
            "update public.event_orders set status = 'PAID', paid_at = now(), "
            "provider = cast(:p as text), external_payment_id = cast(:x as text), "
            "environment = cast(:e as text) where id = cast(:o as uuid)"
        ), {"o": orden, "p": "stripe" if stripe else "none", "x": f"pi_prueba_{orden[:8]}" if stripe else None,
            "e": "production" if stripe else "sandbox"})
    politica = await _uno(
        motor, "select id from public.event_policies where event_id = cast(:e as uuid) limit 1", e=evento
    )
    await _escribir(
        motor,
        "insert into public.event_order_policy_acceptances (order_id, policy_id, policy_type, policy_version, "
        "params_sha256, accepted_by) values (cast(:o as uuid), cast(:p as uuid), 'review_window', 'v1', repeat('a', 64), "
        "cast(:u as uuid))",
        o=orden, p=str(politica), u=asistente,
    )
    acceso = str(await _escribir(
        motor,
        "insert into public.event_checkins (ticket_id, event_id, result, operator_id) "
        "values (cast(:t as uuid), cast(:e as uuid), 'OK', cast(:o as uuid)) returning id",
        t=entrada, e=evento, o=organizador,
    ))
    resena = str(await _escribir(
        motor,
        "insert into public.event_reviews (event_id, author_id, checkin_id, ticket_id, overall, comment) "
        "values (cast(:e as uuid), cast(:u as uuid), cast(:a as uuid), cast(:t as uuid), 5, 'Genial') returning id",
        e=evento, u=asistente, a=acceso, t=entrada,
    ))
    await _escribir(
        motor,
        "insert into public.event_review_replies (review_id, author_id, body, status) "
        "values (cast(:r as uuid), cast(:o as uuid), 'Gracias por venir', 'visible')",
        r=resena, o=organizador,
    )
    return resena


async def _moderar_resena_de_evento(motor, resena: str, moderador: str) -> None:
    await _escribir(
        motor,
        "insert into public.event_review_moderation (review_id, actor_id, from_status, to_status, reason) "
        "values (cast(:r as uuid), cast(:m as uuid), 'visible', 'hidden', 'Lenguaje ofensivo')",
        r=resena, m=moderador,
    )


async def _consentimiento(sesiones, persona: str, *, consumido: bool) -> str:
    from app.modules.gobernanza import consentimientos, politicas

    async with sesiones() as db:
        await politicas.sembrar_recompra(db)
        fila = await consentimientos.registrar(
            db, subject_id=persona, policy_type=politicas.RECOMPRA,
            texto_mostrado="Política de recompra mostrada, con sus huecos rellenados.",
        )
        if consumido:
            assert await consentimientos.consumir(db, fila, kind="order", identificador=str(uuid.uuid4()))
        await db.commit()
        return fila.id


async def _chat(motor, almacen, persona: str, otra: str) -> tuple[str, str]:
    """Una conversación que creó `persona` y otra que creó `otra`, las dos con
    adjuntos de las dos en `message-media` (`<conversación>/<quien>/<archivo>`)."""
    propia = str(await _escribir(
        motor, "insert into public.conversations (created_by, kind) values (cast(:p as uuid), 'direct') returning id", p=persona
    ))
    ajena = str(await _escribir(
        motor, "insert into public.conversations (created_by, kind) values (cast(:o as uuid), 'direct') returning id", o=otra
    ))
    for conversacion in (propia, ajena):
        for miembro in (persona, otra):
            await _escribir(
                motor,
                "insert into public.conversation_members (conversation_id, user_id) values (cast(:c as uuid), cast(:u as uuid))",
                c=conversacion, u=miembro,
            )
            await _escribir(
                motor,
                "insert into public.messages (conversation_id, sender_id, body, attachment_path) "
                "values (cast(:c as uuid), cast(:u as uuid), 'hola', cast(:r as text))",
                c=conversacion, u=miembro, r=f"{conversacion}/{miembro}/foto.jpg",
            )
            almacen.poner("message-media", f"{conversacion}/{miembro}/foto.jpg", f"{conversacion}/{miembro}/nota/voz.m4a")
    return propia, ajena


def _archivos_de(almacen, uid: str) -> None:
    """Lo que el móvil sube bajo `<perfil>/`, con carpetas anidadas."""
    almacen.poner("post-media", f"{uid}/foto.jpg", f"{uid}/derived/m1/thumb.webp", f"{uid}/derived/m1/feed.mp4")
    almacen.poner("avatars", f"{uid}/avatar-1.jpg")
    almacen.poner("course-media", f"{uid}/curso-1/leccion.mp4")


def _cuantos(almacen, uid: str) -> int:
    return sum(len(almacen.de(d, uid)) for d in ("post-media", "avatars", "course-media", "seller-documents", "service-provider-documents"))


# =========================================================================== #
# 2. Sin nada, y lo ajeno intacto
# =========================================================================== #
async def test_una_cuenta_sin_actividad_se_borra(entorno) -> None:
    app, motor, almacen = entorno
    nadie = await _persona(motor)
    r = await _borrar_cuenta(app, nadie)
    assert r.status_code == 204, r.text
    assert not await _existe(motor, nadie)


async def test_solo_se_borra_la_cuenta_propia(entorno) -> None:
    app, motor, almacen = entorno
    jefa, moderador, ana, bea = (
        await _persona(motor, "admin"), await _persona(motor, "moderator"), await _persona(motor), await _persona(motor)
    )
    solicitud_de_bea = await _llevar(app, bea, "submitted", jefa=jefa, moderador=moderador)
    _archivos_de(almacen, ana)
    _archivos_de(almacen, bea)
    antes_de_bea = _cuantos(almacen, bea)

    r = await _borrar_cuenta(app, ana)

    assert r.status_code == 204, r.text
    assert not await _existe(motor, ana)
    assert await _existe(motor, bea)
    assert _cuantos(almacen, ana) == 0
    assert _cuantos(almacen, bea) == antes_de_bea
    assert all(v >= 1 for v in (await _restos_de_servicios(motor, solicitud_de_bea)).values())


async def test_repetir_la_baja_es_seguro(entorno) -> None:
    app, motor, almacen = entorno
    ana = await _persona(motor)
    _archivos_de(almacen, ana)
    assert (await _borrar_cuenta(app, ana)).status_code == 204
    assert (await _borrar_cuenta(app, ana)).status_code == 204
    assert not await _existe(motor, ana) and _cuantos(almacen, ana) == 0


# =========================================================================== #
# 3. Servicios: cada estado, con documentos, credenciales, historial, envíos
#    congelados, avisos y auditoría
# =========================================================================== #
@pytest.mark.parametrize(
    "estado",
    ["draft", "submitted", "under_review", "changes_requested", "resubmitted",
     "approved", "rejected", "suspended", "withdrawn"],
)
async def test_servicios_en_cada_estado(entorno, estado) -> None:
    app, motor, almacen = entorno
    jefa, moderador, ana = await _persona(motor, "admin"), await _persona(motor, "moderator"), await _persona(motor)
    solicitud = await _llevar(app, ana, estado, jefa=jefa, moderador=moderador)
    antes = await _restos_de_servicios(motor, solicitud)
    assert antes["service_provider_documents"] == 2 and antes["service_provider_credentials"] == 1
    assert antes["service_provider_application_events"] >= 1
    if estado not in ("draft", "withdrawn"):
        assert antes["service_provider_application_submissions"] >= 1
    assert len(almacen.de("service-provider-documents", ana)) >= 2
    mia = [f[0] for f in await _filas(
        motor, "select cast(id as text) from public.audit_events where actor_id = cast(:u as uuid)", u=ana
    )]
    del_equipo = await _uno(
        motor,
        "select count(*) from public.audit_events where entity_id = cast(:s as uuid) and actor_id <> cast(:u as uuid)",
        s=solicitud, u=ana,
    )
    assert mia, "sin auditoría de Ana la prueba pasaría por vacío"

    r = await _borrar_cuenta(app, ana)

    assert r.status_code == 204, r.text
    assert not await _existe(motor, ana)
    assert await _restos_de_servicios(motor, solicitud) == {t: 0 for t, _ in SERVICIOS}
    assert await _uno(motor, "select count(*) from public.service_providers where profile_id = cast(:u as uuid)", u=ana) == 0
    assert await _uno(motor, "select count(*) from public.notifications where user_id = cast(:u as uuid)", u=ana) == 0
    assert almacen.de("service-provider-documents", ana) == []
    # La auditoría sigue: la de Ana, anónima; la del equipo, firmada.
    assert await _uno(motor, "select count(*) from public.audit_events where actor_id = cast(:u as uuid)", u=ana) == 0
    assert await _uno(
        motor,
        "select count(*) from public.audit_events where entity_id = cast(:s as uuid) and actor_id is not null",
        s=solicitud,
    ) == del_equipo
    assert await _uno(
        motor, "select count(*) from public.audit_events where id = any(cast(:ids as uuid[])) and actor_id is null", ids=mia
    ) == len(mia)


async def test_la_retirada_no_deja_la_nota_de_quien_postula_en_la_auditoria(entorno) -> None:
    """La auditoría sobrevive a la cuenta; la nota de retirada es texto libre de
    quien postula y no le hace falta para rastrear nada."""
    app, motor, almacen = entorno
    jefa, moderador, ana = await _persona(motor, "admin"), await _persona(motor, "moderator"), await _persona(motor)
    solicitud = await _llevar(app, ana, "submitted", jefa=jefa, moderador=moderador)
    async with _cliente(app, ana) as http:
        r = await http.post(f"{MIA}/withdraw", json={"confirm": True, "reason": "Me mudo con mi familia a Arequipa"})
        assert r.status_code == 200, r.text
    assert (await _borrar_cuenta(app, ana)).status_code == 204
    filas = await _filas(
        motor,
        "select coalesce(reason, ''), payload::text from public.audit_events "
        "where entity_id = cast(:s as uuid) and action = 'service_application.withdrawn'",
        s=solicitud,
    )
    assert len(filas) == 1
    assert "Arequipa" not in filas[0][0] + filas[0][1]
    assert '"with_note": true' in filas[0][1]


async def test_quien_decidio_se_va_y_la_postulacion_ajena_se_queda(entorno) -> None:
    app, motor, almacen = entorno
    jefa, moderador, ana = await _persona(motor, "admin"), await _persona(motor, "moderator"), await _persona(motor)
    solicitud = await _llevar(app, ana, "approved", jefa=jefa, moderador=moderador)
    firmadas_por_la_jefa = [f[0] for f in await _filas(
        motor, "select cast(id as text) from public.audit_events where actor_id = cast(:j as uuid)", j=jefa
    )]
    assert len(firmadas_por_la_jefa) >= 3  # crear y publicar las condiciones, aprobar

    r = await _borrar_cuenta(app, jefa)

    assert r.status_code == 204, r.text
    assert await _uno(motor, "select count(*) from public.audit_events where actor_id = cast(:j as uuid)", j=jefa) == 0
    assert await _filas(
        motor,
        "select distinct actor_role, actor_id is null from public.audit_events where id = any(cast(:ids as uuid[]))",
        ids=firmadas_por_la_jefa,
    ) == [("admin", True)]
    assert all(v >= 1 for t, v in (await _restos_de_servicios(motor, solicitud)).items())
    assert await _uno(
        motor, "select status from public.service_provider_applications where id = cast(:s as uuid)", s=solicitud
    ) == "approved"


# =========================================================================== #
# 4. Consentimientos, Cursos y Comercio
# =========================================================================== #
async def test_el_consentimiento_se_queda_y_deja_de_nombrar(entorno) -> None:
    app, motor, almacen = entorno
    sesiones = async_sessionmaker(motor, expire_on_commit=False)
    ana = await _persona(motor)
    # Una ya sellada y otra pendiente (con una pendiente, registrar otra vez
    # devuelve la misma: por eso la sellada va primero).
    ana_usado = await _consentimiento(sesiones, ana, consumido=True)
    sin_usar = await _consentimiento(sesiones, ana, consumido=False)
    # Y una de otra persona, que la baja de Ana no toca.
    usado = await _consentimiento(sesiones, await _persona(motor), consumido=True)
    columnas = "id, policy_version_id, policy_type, policy_version, policy_hash, scope_kind, scope_id, " \
               "consumed_by_kind, consumed_by_id, consumed_at, accepted_at, request_id, ip_hash, ip_prefix, " \
               "user_agent_family, channel, created_at"
    antes = await _filas(motor, f"select {columnas} from public.consent_records where subject_id = cast(:u as uuid) order by id", u=ana)
    assert len(antes) == 2

    r = await _borrar_cuenta(app, ana)

    assert r.status_code == 204, r.text
    despues = await _filas(
        motor, f"select {columnas} from public.consent_records where id in (cast(:a as uuid), cast(:b as uuid)) order by id",
        a=sin_usar, b=ana_usado,
    )
    assert despues == antes
    assert await _uno(
        motor, "select count(*) from public.consent_records where id in (cast(:a as uuid), cast(:b as uuid)) and subject_id is null",
        a=sin_usar, b=ana_usado,
    ) == 2
    assert await _uno(motor, "select subject_id is not null from public.consent_records where id = cast(:c as uuid)", c=usado)


async def test_autor_sin_ventas_y_su_alumna(entorno) -> None:
    app, motor, almacen = entorno
    autor, alumna, jefa = await _persona(motor), await _persona(motor), await _persona(motor, "admin")
    curso, version = await _curso(motor, autor)
    otro_curso, version_ajena = await _curso(motor, await _persona(motor), publico=jefa)
    await _alumno(motor, alumna, otro_curso)
    _archivos_de(almacen, autor)

    assert (await _borrar_cuenta(app, alumna)).status_code == 204
    assert await _uno(motor, "select count(*) from public.course_enrollments where user_id = cast(:u as uuid)", u=alumna) == 0
    assert await _uno(motor, "select count(*) from public.course_reviews where user_id = cast(:u as uuid)", u=alumna) == 0
    assert await _uno(motor, "select count(*) from public.courses where id = cast(:c as uuid)", c=otro_curso) == 1

    assert (await _borrar_cuenta(app, autor)).status_code == 204
    assert await _uno(motor, "select count(*) from public.courses where id = cast(:c as uuid)", c=curso) == 0
    assert await _uno(motor, "select count(*) from public.course_versions where id = cast(:v as uuid)", v=version) == 0
    assert _cuantos(almacen, autor) == 0

    # Quien publicó la versión de otro curso se va: la versión se queda, anónima.
    assert (await _borrar_cuenta(app, jefa)).status_code == 204
    assert await _filas(
        motor, "select status, published_by is null from public.course_versions where id = cast(:v as uuid)", v=version_ajena
    ) == [("published", True)]


async def test_autor_con_una_venta_no_se_borra_solo_y_no_pierde_nada(entorno) -> None:
    """LO LEGÍTIMO QUE BLOQUEA. Alguien compró su curso: la versión vendida es
    la prueba de lo que se compró (`orders.course_version_id` es `restrict`).
    Responde 409 y NO SE TOCA NINGÚN ARCHIVO."""
    app, motor, almacen = entorno
    autor, comprador = await _persona(motor), await _persona(motor)
    curso, version = await _curso(motor, autor)
    await _venta_de_curso(motor, comprador, curso, version)
    _archivos_de(almacen, autor)
    antes = _cuantos(almacen, autor)

    r = await _borrar_cuenta(app, autor)

    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "account_deletion_blocked"
    assert r.json()["error"]["details"] == {"reason": "courses"}
    assert await _existe(motor, autor)
    assert await _uno(motor, "select count(*) from public.course_versions where id = cast(:v as uuid)", v=version) == 1
    assert _cuantos(almacen, autor) == antes
    assert almacen.borrados == []


async def test_comercio_compra_sin_saldo_se_va_y_con_saldo_se_frena(entorno) -> None:
    app, motor, almacen = entorno
    autor, sin_saldo, con_saldo = await _persona(motor), await _persona(motor), await _persona(motor)
    curso, version = await _curso(motor, autor)
    await _escribir(
        motor,
        "insert into public.commerce_products (kind, course_id) values ('course_lifetime', cast(:c as uuid))", c=curso,
    )
    producto = str(await _uno(motor, "select id from public.commerce_products where course_id = cast(:c as uuid)", c=curso))
    await _escribir(
        motor,
        "insert into public.orders (user_id, commerce_product_id, provider, channel, status, amount_minor, currency) "
        "values (cast(:u as uuid), cast(:p as uuid), 'stripe', 'web', 'pending', 4900, 'PEN')",
        u=sin_saldo, p=producto,
    )
    await _escribir(
        motor,
        "insert into public.entitlements (user_id, commerce_product_id, status, source_provider) "
        "values (cast(:u as uuid), cast(:p as uuid), 'active', 'beta')",
        u=sin_saldo, p=producto,
    )
    assert (await _borrar_cuenta(app, sin_saldo)).status_code == 204
    assert await _uno(motor, "select count(*) from public.orders where user_id = cast(:u as uuid)", u=sin_saldo) == 0
    assert await _uno(motor, "select count(*) from public.entitlements where user_id = cast(:u as uuid)", u=sin_saldo) == 0

    orden = str(await _escribir(
        motor,
        "insert into public.orders (user_id, commerce_product_id, provider, channel, status, amount_minor, currency) "
        "values (cast(:u as uuid), cast(:p as uuid), 'stripe', 'web', 'paid', 4900, 'PEN') returning id",
        u=con_saldo, p=producto,
    ))
    await _escribir(
        motor,
        "insert into public.owner_sale_balances (order_id, course_id, owner_id, gross_amount_minor, platform_fee_minor, "
        "net_amount_minor, currency, fee_rules_version) values (cast(:o as uuid), cast(:c as uuid), cast(:a as uuid), "
        "4900, 900, 4000, 'PEN', 'v1')",
        o=orden, c=curso, a=autor,
    )
    r = await _borrar_cuenta(app, con_saldo)
    # Lo primero que frena es la propia orden pagada (0089); el saldo también
    # lo haría (`owner_sale_balances.order_id`, `restrict`).
    assert r.status_code == 409 and r.json()["error"]["details"] == {"reason": "courses"}, r.text
    assert await _existe(motor, con_saldo)
    r = await _borrar_cuenta(app, autor)
    assert r.status_code == 409 and r.json()["error"]["code"] == "account_deletion_blocked", r.text


# =========================================================================== #
# 5. Eventos
# =========================================================================== #
async def test_eventos_organizador_asistente_y_moderacion(entorno) -> None:
    app, motor, almacen = entorno
    organizador, asistente, moderadora = await _persona(motor), await _persona(motor), await _persona(motor, "moderator")
    evento, tipo = await _evento(motor, organizador)
    resena = await _asistencia(motor, evento, tipo, asistente, organizador=organizador)
    await _moderar_resena_de_evento(motor, resena, moderadora)
    otra_resena_evento, otro_tipo = await _evento(motor, await _persona(motor))
    otra_resena = await _asistencia(motor, otra_resena_evento, otro_tipo, await _persona(motor), organizador=organizador)
    await _moderar_resena_de_evento(motor, otra_resena, moderadora)

    # Quien asistió: su orden, su entrada, su acceso, su aceptación, su reseña
    # y la moderación de su reseña se van con ella.
    assert (await _borrar_cuenta(app, asistente)).status_code == 204
    assert await _uno(motor, "select count(*) from public.event_orders where buyer_id = cast(:u as uuid)", u=asistente) == 0
    assert await _uno(motor, "select count(*) from public.event_tickets where owner_id = cast(:u as uuid)", u=asistente) == 0
    assert await _uno(motor, "select count(*) from public.event_reviews where id = cast(:r as uuid)", r=resena) == 0
    assert await _uno(motor, "select count(*) from public.event_review_moderation where review_id = cast(:r as uuid)", r=resena) == 0

    # La moderadora se va: la moderación de la otra reseña se queda, anónima.
    assert (await _borrar_cuenta(app, moderadora)).status_code == 204
    assert await _filas(
        motor, "select to_status, reason, actor_id is null from public.event_review_moderation where review_id = cast(:r as uuid)",
        r=otra_resena,
    ) == [("hidden", "Lenguaje ofensivo", True)]


async def test_organizador_sin_ventas_se_va_y_con_ventas_se_frena(entorno) -> None:
    app, motor, almacen = entorno
    libre, con_ventas, publico = await _persona(motor), await _persona(motor), await _persona(motor)
    evento_libre, _ = await _evento(motor, libre)
    assert (await _borrar_cuenta(app, libre)).status_code == 204
    for tabla in ("events", "event_versions", "event_policies"):
        columna = "id" if tabla == "events" else "event_id"
        assert await _uno(motor, f"select count(*) from public.{tabla} where {columna} = cast(:e as uuid)", e=evento_libre) == 0

    evento, tipo = await _evento(motor, con_ventas)
    await _asistencia(motor, evento, tipo, publico, organizador=con_ventas)
    r = await _borrar_cuenta(app, con_ventas)
    assert r.status_code == 409 and r.json()["error"]["details"] == {"reason": "events"}, r.text
    assert await _existe(motor, con_ventas)
    assert await _uno(motor, "select count(*) from public.events where id = cast(:e as uuid)", e=evento) == 1


async def test_quien_creo_una_politica_global_de_eventos(entorno) -> None:
    app, motor, almacen = entorno
    jefa = await _persona(motor, "admin")
    politica = str(await _escribir(
        motor,
        "insert into public.event_policies (policy_type, scope, version, params_sha256, status, published_at, "
        "created_by, published_by) values ('organizer_reply', 'global', 'v1', repeat('c', 64), 'published', now(), "
        "cast(:j as uuid), cast(:j as uuid)) returning id",
        j=jefa,
    ))
    assert (await _borrar_cuenta(app, jefa)).status_code == 204
    assert await _filas(
        motor, "select status, created_by is null, published_by is null from public.event_policies where id = cast(:p as uuid)",
        p=politica,
    ) == [("published", True, True)]


# =========================================================================== #
# 6. Productos
# =========================================================================== #
async def test_productos_vendedora_sin_productos_se_va_con_sus_documentos(entorno) -> None:
    app, motor, almacen = entorno
    vendedora = await _persona(motor)
    postulacion = str(await _escribir(
        motor,
        "insert into public.seller_applications (profile_id, status, display_name, proposal, submitted_at) "
        "values (cast(:u as uuid), 'submitted', 'Tienda Ana', 'Vendo cerámica hecha a mano en Cusco.', now()) returning id",
        u=vendedora,
    ))
    ruta = f"{vendedora}/{postulacion}/ruc.pdf"
    await _escribir(
        motor,
        "insert into public.seller_application_documents (application_id, kind, storage_path, created_by) "
        "values (cast(:a as uuid), 'tax_data', cast(:r as text), cast(:u as uuid))",
        a=postulacion, r=ruta, u=vendedora,
    )
    await _escribir(
        motor, "insert into public.product_sellers (profile_id, display_name) values (cast(:u as uuid), 'Tienda Ana')", u=vendedora
    )
    almacen.poner("seller-documents", ruta)

    assert (await _borrar_cuenta(app, vendedora)).status_code == 204
    assert almacen.de("seller-documents", vendedora) == []
    assert await _uno(motor, "select count(*) from public.seller_applications where id = cast(:a as uuid)", a=postulacion) == 0
    # Y ningún enlace firmado sale ya para ese documento.
    assert await storage.firmar_objetos("seller-documents", [ruta]) == {}


async def test_productos_con_catalogo_se_frena_y_quien_guarda_se_va(entorno) -> None:
    app, motor, almacen = entorno
    vendedora, clienta = await _persona(motor), await _persona(motor)
    tienda = str(await _escribir(
        motor, "insert into public.product_sellers (profile_id, display_name) values (cast(:u as uuid), 'Tienda') returning id",
        u=vendedora,
    ))
    producto = str(await _escribir(
        motor, "insert into public.products (seller_id, created_by) values (cast(:s as uuid), cast(:u as uuid)) returning id",
        s=tienda, u=vendedora,
    ))
    await _escribir(
        motor, "insert into public.saved_products (user_id, product_id) values (cast(:u as uuid), cast(:p as uuid))",
        u=clienta, p=producto,
    )
    assert (await _borrar_cuenta(app, clienta)).status_code == 204
    assert await _uno(motor, "select count(*) from public.saved_products where user_id = cast(:u as uuid)", u=clienta) == 0

    r = await _borrar_cuenta(app, vendedora)
    assert r.status_code == 409 and r.json()["error"]["details"] == {"reason": "products"}, r.text
    assert await _existe(motor, vendedora)


@pytest.mark.parametrize(
    ("tabla", "columnas", "valores"),
    [
        ("product_review_moderation", "review_id, to_status", "gen_random_uuid(), 'hidden'"),
        ("product_refund_events", "refund_id, to_status, actor_role", "gen_random_uuid(), 'approved', 'admin'"),
        ("product_dispute_events", "dispute_id, to_status, actor_role", "gen_random_uuid(), 'opened', 'admin'"),
        ("event_dispute_events", "dispute_id, to_status, actor_role", "gen_random_uuid(), 'opened', 'admin'"),
        ("event_aftersale_case_events", "case_id, to_status, actor_role", "gen_random_uuid(), 'opened', 'admin'"),
    ],
)
async def test_quien_actuo_en_un_historial_de_dinero_o_moderacion_queda_anonimo(entorno, tabla, columnas, valores) -> None:
    app, motor, almacen = entorno
    quien = await _persona(motor, "admin")
    fila = str(uuid.uuid4())
    await _sembrar(
        motor, f"insert into public.{tabla} (id, actor_id, {columnas}) values (cast(:f as uuid), cast(:q as uuid), {valores})",
        f=fila, q=quien,
    )
    antes = await _filas(motor, f"select to_jsonb(t) - 'actor_id' from public.{tabla} t where id = cast(:f as uuid)", f=fila)

    assert (await _borrar_cuenta(app, quien)).status_code == 204

    assert await _filas(motor, f"select to_jsonb(t) - 'actor_id' from public.{tabla} t where id = cast(:f as uuid)", f=fila) == antes
    assert await _uno(motor, f"select actor_id is null from public.{tabla} where id = cast(:f as uuid)", f=fila)


# =========================================================================== #
# 7. Avisos, chat, y todo a la vez
# =========================================================================== #
async def test_avisos_propios_se_van_y_en_los_ajenos_deja_de_figurar(entorno) -> None:
    app, motor, almacen = entorno
    ana, bea = await _persona(motor), await _persona(motor)
    await _escribir(
        motor, "insert into public.notifications (user_id, type, payload) values (cast(:u as uuid), 'follow', '{}')", u=ana
    )
    ajeno = str(await _escribir(
        motor,
        "insert into public.notifications (user_id, actor_id, type, payload) "
        "values (cast(:b as uuid), cast(:a as uuid), 'follow', '{}') returning id",
        a=ana, b=bea,
    ))
    assert (await _borrar_cuenta(app, ana)).status_code == 204
    assert await _uno(motor, "select count(*) from public.notifications where user_id = cast(:u as uuid)", u=ana) == 0
    assert await _uno(motor, "select actor_id is null from public.notifications where id = cast(:n as uuid)", n=ajeno)


async def test_los_adjuntos_de_chat_se_van_con_quien_los_subio(entorno) -> None:
    """`message-media` no va bajo `<perfil>/` sino `<conversación>/<quien>/`.
    Lo suyo se va en todas sus conversaciones; de la que creó (que se borra
    entera con sus mensajes) se va todo; lo de la otra persona en la ajena se
    queda."""
    app, motor, almacen = entorno
    ana, bea = await _persona(motor), await _persona(motor)
    propia, ajena = await _chat(motor, almacen, ana, bea)

    assert (await _borrar_cuenta(app, ana)).status_code == 204

    assert almacen.de("message-media", propia) == []
    assert almacen.de("message-media", f"{ajena}/{ana}") == []
    assert almacen.de("message-media", f"{ajena}/{bea}") == [f"{ajena}/{bea}/foto.jpg", f"{ajena}/{bea}/nota/voz.m4a"]
    assert await _uno(motor, "select count(*) from public.conversations where id = cast(:c as uuid)", c=propia) == 0
    assert await _uno(motor, "select count(*) from public.messages where conversation_id = cast(:c as uuid)", c=ajena) == 1


async def test_una_persona_en_todas_las_verticales_a_la_vez(entorno) -> None:
    app, motor, almacen = entorno
    sesiones = async_sessionmaker(motor, expire_on_commit=False)
    jefa, moderador, ana, bea = (
        await _persona(motor, "admin"), await _persona(motor, "moderator"), await _persona(motor), await _persona(motor)
    )
    solicitud = await _llevar(app, ana, "approved", jefa=jefa, moderador=moderador)
    await _consentimiento(sesiones, ana, consumido=True)
    curso_de_bea, _ = await _curso(motor, bea)
    await _alumno(motor, ana, curso_de_bea)
    curso_de_ana, _ = await _curso(motor, ana)
    evento, tipo = await _evento(motor, bea)
    resena = await _asistencia(motor, evento, tipo, ana, organizador=bea)
    await _moderar_resena_de_evento(motor, resena, moderador)
    await _chat(motor, almacen, ana, bea)
    _archivos_de(almacen, ana)
    await _escribir(
        motor, "insert into public.notifications (user_id, actor_id, type, payload) "
        "values (cast(:b as uuid), cast(:a as uuid), 'follow', '{}')", a=ana, b=bea,
    )

    r = await _borrar_cuenta(app, ana)

    assert r.status_code == 204, r.text
    assert not await _existe(motor, ana)
    assert await _restos_de_servicios(motor, solicitud) == {t: 0 for t, _ in SERVICIOS}
    assert _cuantos(almacen, ana) == 0
    assert [r for r in almacen.objetos.get("message-media", {}) if f"/{ana}/" in r] == []
    assert await _uno(motor, "select count(*) from public.courses where id = cast(:c as uuid)", c=curso_de_ana) == 0
    assert await _uno(motor, "select count(*) from public.courses where id = cast(:c as uuid)", c=curso_de_bea) == 1
    assert await _uno(motor, "select count(*) from public.events where id = cast(:e as uuid)", e=evento) == 1
    for tabla, columna in (
        ("audit_events", "actor_id"), ("consent_records", "subject_id"), ("notifications", "actor_id"),
        ("event_order_policy_acceptances", "accepted_by"), ("course_versions", "published_by"),
    ):
        assert await _uno(motor, f"select count(*) from public.{tabla} where {columna} = cast(:u as uuid)", u=ana) == 0, tabla


# =========================================================================== #
# 8. Fallos a mitad: nada se da por borrado si no lo está
# =========================================================================== #
async def test_si_storage_falla_no_se_borra_nada_y_se_puede_reintentar(entorno) -> None:
    app, motor, almacen = entorno
    jefa, moderador, ana = await _persona(motor, "admin"), await _persona(motor, "moderator"), await _persona(motor)
    solicitud = await _llevar(app, ana, "submitted", jefa=jefa, moderador=moderador)
    _archivos_de(almacen, ana)
    todos = _cuantos(almacen, ana)
    auditoria = await _uno(motor, "select count(*) from public.audit_events where actor_id = cast(:u as uuid)", u=ana)

    # Storage no contesta al LISTAR: no se borra ni un archivo.
    almacen.fallar_en = {"avatars"}
    r = await _borrar_cuenta(app, ana)
    assert r.status_code == 503, r.text
    assert r.json()["error"]["code"] == "account_deletion_storage_failed"
    assert await _existe(motor, ana)
    assert all(v >= 1 for v in (await _restos_de_servicios(motor, solicitud)).values())
    assert await _uno(motor, "select count(*) from public.audit_events where actor_id = cast(:u as uuid)", u=ana) == auditoria
    assert _cuantos(almacen, ana) == todos and almacen.borrados == []

    # Falla ya BORRANDO: la cuenta sigue; algo pudo irse; repetir termina.
    almacen.fallar_en = set()
    almacen.fallar_al_borrar_en = {"course-media"}
    r = await _borrar_cuenta(app, ana)
    assert r.status_code == 503, r.text
    assert await _existe(motor, ana)
    assert almacen.de("course-media", ana) == [f"{ana}/curso-1/leccion.mp4"]

    almacen.fallar_al_borrar_en = set()
    r = await _borrar_cuenta(app, ana)
    assert r.status_code == 204, r.text
    assert not await _existe(motor, ana) and _cuantos(almacen, ana) == 0


async def test_sin_credenciales_de_storage_en_produccion_no_se_borra(entorno, monkeypatch) -> None:
    app, motor, almacen = entorno
    ana = await _persona(motor)
    monkeypatch.setattr(get_settings(), "supabase_service_role_key", "")
    monkeypatch.setattr(get_settings(), "environment", "production")
    r = await _borrar_cuenta(app, ana)
    assert r.status_code == 503 and r.json()["error"]["code"] == "account_deletion_storage_failed", r.text
    assert await _existe(motor, ana)


async def test_dos_bajas_a_la_vez_de_la_misma_cuenta(entorno) -> None:
    """La segunda espera al bloqueo de la fila del perfil y, cuando entra, no
    encuentra nada que borrar: las dos responden 204 y no queda nada."""
    import asyncio

    app, motor, almacen = entorno
    jefa, moderador, ana = await _persona(motor, "admin"), await _persona(motor, "moderator"), await _persona(motor)
    solicitud = await _llevar(app, ana, "submitted", jefa=jefa, moderador=moderador)
    _archivos_de(almacen, ana)

    respuestas = await asyncio.gather(_borrar_cuenta(app, ana), _borrar_cuenta(app, ana))

    assert [r.status_code for r in respuestas] == [204, 204], [r.text for r in respuestas]
    assert not await _existe(motor, ana)
    assert await _restos_de_servicios(motor, solicitud) == {t: 0 for t, _ in SERVICIOS}
    assert _cuantos(almacen, ana) == 0


# =========================================================================== #
# 9. Hallazgos de la revisión independiente (29/09/2026)
# =========================================================================== #
async def test_R1_una_orden_de_evento_pagada_no_se_va_con_quien_compro(entorno) -> None:
    """ALTA. Sin comisión configurada (el valor por defecto) una venta no crea
    saldo, y nada frenaba la cascada `event_orders.buyer_id`: la orden pagada,
    con la referencia del cobro, desaparecía con la cuenta. Ahora 409, y nada
    se toca. Una orden GRATUITA sí se va (la prueba de Eventos de arriba)."""
    app, motor, almacen = entorno
    organizador, compradora = await _persona(motor), await _persona(motor)
    evento, tipo = await _evento(motor, organizador)
    await _asistencia(motor, evento, tipo, compradora, organizador=organizador, stripe=True)
    assert await _uno(motor, "select count(*) from public.owner_sale_balances where event_id = cast(:e as uuid)", e=evento) == 0
    _archivos_de(almacen, compradora)

    r = await _borrar_cuenta(app, compradora)

    assert r.status_code == 409 and r.json()["error"]["details"] == {"reason": "events"}, r.text
    assert await _existe(motor, compradora)
    assert await _uno(
        motor, "select count(*) from public.event_orders where buyer_id = cast(:u as uuid) and status = 'PAID'", u=compradora
    ) == 1
    assert almacen.borrados == [] and _cuantos(almacen, compradora) == 5


async def test_R1_una_orden_de_curso_pagada_sin_saldo_tampoco(entorno) -> None:
    app, motor, almacen = entorno
    autor, comprador = await _persona(motor), await _persona(motor)
    curso, _ = await _curso(motor, autor)
    producto = str(await _escribir(
        motor, "insert into public.commerce_products (kind, course_id) values ('course_lifetime', cast(:c as uuid)) returning id",
        c=curso,
    ))
    await _escribir(
        motor,
        "insert into public.orders (user_id, commerce_product_id, provider, channel, status, amount_minor, currency, paid_at) "
        "values (cast(:u as uuid), cast(:p as uuid), 'stripe', 'web', 'paid', 4900, 'PEN', now())",
        u=comprador, p=producto,
    )
    r = await _borrar_cuenta(app, comprador)
    assert r.status_code == 409 and r.json()["error"]["details"] == {"reason": "courses"}, r.text
    assert await _uno(motor, "select count(*) from public.orders where user_id = cast(:u as uuid)", u=comprador) == 1


async def test_R2_los_textos_del_equipo_sobre_quien_postula_no_quedan_en_la_auditoria(entorno) -> None:
    """MEDIA. El mensaje de una decisión y las notas sobre documentos y
    credenciales las escribe el equipo SOBRE quien postula (a veces con un
    número de documento) y la auditoría sobrevive a su cuenta."""
    app, motor, almacen = entorno
    jefa, moderador, ana = await _persona(motor, "admin"), await _persona(motor, "moderator"), await _persona(motor)
    solicitud = await _llevar(app, ana, "under_review", jefa=jefa, moderador=moderador)
    async with _cliente(app, moderador) as mod:
        detalle = (await mod.get(f"{BANDEJA}/{solicitud}")).json()
        documento = detalle["documents"][0]["id"]
        credencial = detalle["credentials"][0]["id"]
        r = await mod.post(f"{BANDEJA}/{solicitud}/documents/{documento}/observe", json={"note": "El DNI 45872145 está vencido"})
        assert r.status_code == 200, r.text
        r = await mod.post(f"{BANDEJA}/{solicitud}/credentials/{credencial}/observe", json={"note": "Colegiatura 4587 ilegible"})
        assert r.status_code == 200, r.text
        r = await mod.post(f"{BANDEJA}/{solicitud}/request-changes", json={"message": "Ana, sube el DNI 45872145 vigente"})
        assert r.status_code == 200, r.text
    assert (await _borrar_cuenta(app, ana)).status_code == 204

    filas = await _filas(
        motor,
        "select action, coalesce(reason, ''), payload::text from public.audit_events "
        "where action in ('service_document.observed', 'service_credential.observed', "
        "'service_application.changes_requested') and (entity_id = cast(:s as uuid) "
        "or payload->>'application_id' = cast(:s as text))",
        s=solicitud,
    )
    assert {f[0] for f in filas} == {
        "service_document.observed", "service_credential.observed", "service_application.changes_requested",
    }
    for accion, motivo, carga in filas:
        assert motivo == "", accion
        assert "45872145" not in carga and "4587" not in carga and "Ana" not in carga, accion
        assert '"with_note": true' in carga or '"with_message": true' in carga, accion


async def test_R5_si_la_baja_se_deshace_los_adjuntos_ajenos_siguen(entorno) -> None:
    """MEDIA. Los adjuntos de Bea en la conversación que creó Ana se borraban
    ANTES de confirmar: si otro depósito fallaba, la baja se deshacía y la
    conversación volvía sin ellos. Ahora se retiran después de confirmar."""
    app, motor, almacen = entorno
    ana, bea = await _persona(motor), await _persona(motor)
    propia, ajena = await _chat(motor, almacen, ana, bea)
    _archivos_de(almacen, ana)
    almacen.fallar_al_borrar_en = {"course-media"}

    r = await _borrar_cuenta(app, ana)

    assert r.status_code == 503, r.text
    assert await _existe(motor, ana)
    assert almacen.de("message-media", f"{propia}/{bea}") == [f"{propia}/{bea}/foto.jpg", f"{propia}/{bea}/nota/voz.m4a"]
    assert almacen.de("message-media", f"{ajena}/{bea}") == [f"{ajena}/{bea}/foto.jpg", f"{ajena}/{bea}/nota/voz.m4a"]

    almacen.fallar_al_borrar_en = set()
    assert (await _borrar_cuenta(app, ana)).status_code == 204
    assert almacen.de("message-media", propia) == []
    assert len(almacen.de("message-media", f"{ajena}/{bea}")) == 2


async def test_R5_si_falla_lo_de_despues_la_cuenta_ya_esta_borrada_y_se_registra(entorno, caplog) -> None:
    import logging

    app, motor, almacen = entorno
    ana, bea = await _persona(motor), await _persona(motor)
    propia, _ = await _chat(motor, almacen, ana, bea)
    almacen.fallar_al_listar = {("message-media", propia)}

    with caplog.at_level(logging.ERROR):
        r = await _borrar_cuenta(app, ana)

    assert r.status_code == 204, r.text
    assert not await _existe(motor, ana)
    assert almacen.de("message-media", f"{propia}/{ana}") == []
    assert almacen.de("message-media", f"{propia}/{bea}") != []
    registro = " ".join(x.getMessage() for x in caplog.records if x.levelno >= logging.ERROR)
    assert propia in registro and "foto.jpg" not in registro


async def test_R8_la_base_de_pruebas_tiene_la_0089(entorno) -> None:
    from app.modules.identity import baja

    _, motor, _ = entorno
    async with async_sessionmaker(motor)() as db:
        assert await baja._hay_0089(db) is True


async def test_R4_el_procesado_que_acaba_durante_la_baja_retira_sus_derivados(entorno, monkeypatch) -> None:
    """MEDIA. Un vídeo se transcodifica durante minutos. Si la baja está a
    medio confirmar cuando el procesado guarda, antes lo leía como vivo y, al
    escribir, chocaba con la fila ya borrada: los derivados recién subidos se
    quedaban sin dueño. Ahora espera al bloqueo, ve que ya no está y los
    retira."""
    import asyncio

    from app.modules.content import media_processing as mp

    app, motor, almacen = entorno
    ana = await _persona(motor)
    publicacion = str(await _escribir(
        motor, "insert into public.posts (author_id, body) values (cast(:u as uuid), '') returning id", u=ana
    ))
    medio = str(await _escribir(
        motor,
        "insert into public.post_media (post_id, storage_path, media_type) "
        "values (cast(:p as uuid), cast(:r as text), 'video') returning id",
        p=publicacion, r=f"{ana}/video.mp4",
    ))
    baja = await motor.connect()
    transaccion = await baja.begin()

    async def procesar(client, media):
        media.feed_path = f"{ana}/derived/{media.id}/feed.mp4"
        # La baja empieza mientras se procesa y todavía no se ha confirmado.
        await baja.execute(text("delete from public.profiles where id = cast(:u as uuid)"), {"u": ana})

        async def confirmar_luego():
            await asyncio.sleep(0.5)
            await transaccion.commit()

        asyncio.create_task(confirmar_luego())

    retiradas: list[tuple[str, str]] = []

    async def borrar_carpeta(bucket, prefijo):
        retiradas.append((bucket, prefijo))
        return 1

    monkeypatch.setattr(mp, "SessionLocal", async_sessionmaker(motor, expire_on_commit=False))
    monkeypatch.setattr(mp, "processing_configured", lambda: True)
    monkeypatch.setattr(mp, "_process_video", procesar)
    monkeypatch.setattr(storage, "borrar_carpeta", borrar_carpeta)
    try:
        await mp.process_media(medio)
    finally:
        await baja.close()

    assert retiradas == [("post-media", f"{ana}/derived/{medio}")]
    assert await _uno(motor, "select count(*) from public.post_media where id = cast(:m as uuid)", m=medio) == 0
