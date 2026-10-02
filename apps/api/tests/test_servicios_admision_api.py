"""Z Servicios, Incremento 1: la admisión del prestador por la API, de punta a punta.

SQLite desde `Base.metadata`, como el resto de la suite. Lo que solo impone
PostgreSQL —disparadores, bloqueo de fila, RLS, privilegios, coherencia
diferida— está en `test_servicios_migracion_00*.py` y en
`test_servicios_flujo_postgres.py`.

LO QUE DEFIENDEN ESTAS PRUEBAS:

  1. CON LA BANDERA APAGADA NO SE VE NADA: cada ruta contesta 503
     `services_disabled` sin tocar la base; en administración, el rol antes.
  2. LAS 35 RUTAS EXISTEN, sin duplicados, y ningún estado cambia con PATCH.
  3. POLÍTICAS: borrador, edición, vista previa, publicación que supera a la
     anterior; publicada inmutable; aceptación exacta; sin política no se envía.
  4. DOCUMENTOS PRIVADOS: bytes mirados, tamaño, sin rutas en ninguna
     respuesta, reemplazo, retirada solo antes de enviar, enlaces de 2 minutos,
     nada ajeno.
  5. CREDENCIALES: número enmascarado, evidencia propia, observar, verificar
     solo con evidencia, rechazar con motivo.
  6. EL FLUJO ENTERO: enviar, revisar, corregir, reenviar, aprobar, rechazar,
     suspender, volver a revisión y retirar; idempotencia; nadie se admite a sí
     mismo; prestador coherente; historial, envíos congelados, auditoría y
     avisos.
"""

from __future__ import annotations

import io
import uuid
from collections import Counter
from datetime import date, timedelta

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.security import AuthUser, get_current_user
from app.main import create_app
from app.modules.profiles.models import Profile
from app.modules.services import avisos, esquema, permissions, schemas
from app.modules.services.models import (
    PRESTADOR_ACTIVO,
    ServicePolicy,
    ServiceProvider,
    ServiceProviderApplication,
    ServiceProviderApplicationEvent,
    ServiceProviderApplicationSubmission,
    ServiceProviderCredential,
    ServiceProviderDocument,
)
from app.shared.database import Base, get_db

API = "/api/v1"
MIA = f"{API}/services/provider/application"
TERMINOS = f"{API}/services/provider/terms"
ADMIN = f"{API}/admin/services"
BANDEJA = f"{ADMIN}/applications"

PRESTADORA = str(uuid.uuid4())
OTRA = str(uuid.uuid4())
TERCERA = str(uuid.uuid4())
MODERADOR = str(uuid.uuid4())
JEFA = str(uuid.uuid4())

RESUMEN = "Doy clases de guitarra clásica desde hace diez años, en persona y en línea."
TEXTO = "Condiciones del prestador de Z Servicios. " * 3


def _png() -> bytes:
    from PIL import Image

    salida = io.BytesIO()
    Image.new("RGB", (4, 4), (200, 10, 10)).save(salida, format="PNG")
    return salida.getvalue()


PNG = _png()
PDF = b"%PDF-1.4\n% documento de prueba\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n"


def _rutas(app) -> list[tuple[str, str]]:
    def planas(rutas, prefijo=""):
        for ruta in rutas:
            if type(ruta).__name__ == "_IncludedRouter":
                yield from planas(
                    ruta.original_router.routes, prefijo + ruta.include_context.prefix
                )
            elif getattr(ruta, "methods", None):
                for metodo in ruta.methods:
                    yield metodo, prefijo + ruta.path

    return list(planas(app.routes))


# =========================================================================== #
# Fixtures
# =========================================================================== #
class Almacen:
    """El almacenamiento, de mentira: guarda lo que se sube y firma con plazo."""

    def __init__(self) -> None:
        self.objetos: dict[str, bytes] = {}
        self.firmas: list[tuple[str, list[str], int]] = []
        self.borrados: list[str] = []
        self.configurado = True

    async def subir(self, bucket, ruta, datos, content_type, *, sobrescribir=False):
        from app.shared import storage

        if not self.configurado:
            raise storage.StorageNoConfigurado("no")
        assert ruta not in self.objetos, "se pisó un archivo"
        self.objetos[ruta] = datos

    async def firmar(self, bucket, rutas, *, segundos=3600):
        from app.shared import storage

        if not self.configurado:
            raise storage.StorageNoConfigurado("no")
        self.firmas.append((bucket, list(rutas), segundos))
        return {r: f"https://almacen.test/firmado/{uuid.uuid4()}?expira={segundos}" for r in rutas}

    async def borrar(self, bucket, ruta):
        self.borrados.append(ruta)
        self.objetos.pop(ruta, None)
        return True


@pytest.fixture()
def almacen(monkeypatch):
    from app.shared import storage

    falso = Almacen()
    monkeypatch.setattr(storage, "subir_objeto", falso.subir)
    monkeypatch.setattr(storage, "firmar_objetos", falso.firmar)
    monkeypatch.setattr(storage, "borrar_objeto", falso.borrar)
    return falso


@pytest.fixture()
def encendida(monkeypatch):
    monkeypatch.setattr(get_settings(), "feature_services", True)
    esquema.olvidar()
    yield
    esquema.olvidar()


@pytest_asyncio.fixture()
async def entorno():
    """La aplicación de verdad con una base SQLite propia y cinco personas."""
    esquema.olvidar()
    app = create_app()
    motor = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with motor.begin() as conexion:
        await conexion.run_sync(Base.metadata.create_all)
    sesiones = async_sessionmaker(motor, expire_on_commit=False)
    async with sesiones() as db:
        for ident, nombre, rol in (
            (PRESTADORA, "Ana", "user"),
            (OTRA, "Olga", "user"),
            (TERCERA, "Tere", "user"),
            (MODERADOR, "Mode", "moderator"),
            (JEFA, "Jefa", "admin"),
        ):
            db.add(Profile(id=ident, full_name=nombre, username=nombre.lower(), role=rol))
        await db.commit()

    quien = {"uid": PRESTADORA}

    async def _db():
        async with sesiones() as db:
            yield db

    async def _usuario() -> AuthUser:
        return AuthUser(id=quien["uid"], email="x@y.test", role="authenticated")

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _usuario
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, quien, sesiones, app
    app.dependency_overrides.clear()
    await motor.dispose()
    esquema.olvidar()


def _como(quien: dict, uid: str) -> None:
    quien["uid"] = uid


def _codigo(respuesta) -> str:
    return respuesta.json()["error"]["code"]


# --- Recorridos ------------------------------------------------------------- #
async def _publicar(http, quien, *, pais="PE", parametros=None, texto=TEXTO) -> dict:
    anterior = quien["uid"]
    _como(quien, JEFA)
    r = await http.post(
        f"{ADMIN}/policies/provider-terms/draft",
        json={"country_code": pais, "title": "Condiciones", "body": texto, "parameters": parametros or {}},
    )
    assert r.status_code in (200, 201), r.text
    politica = r.json()
    r = await http.post(f"{ADMIN}/policies/{politica['id']}/publish")
    assert r.status_code == 200, r.text
    _como(quien, anterior)
    return r.json()


async def _documento(http, *, kind="identity", datos=PNG, nombre="dni.png", tipo="image/png"):
    return await http.post(
        f"{MIA}/documents", data={"kind": kind}, files={"file": (nombre, datos, tipo)}
    )


async def _listo_para_enviar(http, quien, *, uid=PRESTADORA, tipo="individual") -> dict:
    """Postulación completa y con las condiciones aceptadas, sin enviar."""
    _como(quien, uid)
    r = await http.post(MIA, json={"provider_type": tipo, "display_name": "Ana Guitarra"})
    assert r.status_code in (200, 201), r.text
    cambios = {"legal_name": "Ana María Quispe", "country_code": "PE", "summary": RESUMEN}
    if tipo == "company":
        cambios |= {"tax_id": "20123456789", "representative_name": "Ana Quispe"}
    assert (await http.patch(MIA, json=cambios)).status_code == 200
    assert (await _documento(http)).status_code in (200, 201)
    if tipo == "company":
        assert (await _documento(http, kind="legal_representation", datos=PDF, nombre="poder.pdf", tipo="application/pdf")).status_code == 201
    terminos = (await http.get(TERMINOS)).json()
    r = await http.post(
        f"{MIA}/terms",
        json={"terms_policy_id": terminos["policy_id"], "terms_sha256": terminos["sha256"]},
    )
    assert r.status_code == 200, r.text
    return r.json()


async def _enviada(http, quien, **kw) -> dict:
    await _listo_para_enviar(http, quien, **kw)
    r = await http.post(f"{MIA}/submit", json={"declare_truthfulness": True})
    assert r.status_code == 200, r.text
    return r.json()


async def _en_revision(http, quien, *, revisor=MODERADOR, **kw) -> str:
    solicitud = (await _enviada(http, quien, **kw))["id"]
    _como(quien, revisor)
    r = await http.post(f"{BANDEJA}/{solicitud}/start-review", json={})
    assert r.status_code == 200, r.text
    return solicitud


async def _todo_aceptado(http, quien, solicitud: str) -> dict:
    _como(quien, MODERADOR)
    detalle = (await http.get(f"{BANDEJA}/{solicitud}")).json()
    for d in detalle["documents"]:
        assert (await http.post(f"{BANDEJA}/{solicitud}/documents/{d['id']}/accept")).status_code == 200
    for c in detalle["credentials"]:
        if c["display_status"] == "pending":
            assert (await http.post(f"{BANDEJA}/{solicitud}/credentials/{c['id']}/verify")).status_code == 200
    return (await http.get(f"{BANDEJA}/{solicitud}")).json()


async def _aprobada(http, quien, **kw) -> str:
    solicitud = await _en_revision(http, quien, **kw)
    await _todo_aceptado(http, quien, solicitud)
    _como(quien, JEFA)
    r = await http.post(f"{BANDEJA}/{solicitud}/approve", json={})
    assert r.status_code == 200, r.text
    return solicitud


# =========================================================================== #
# 1. Rutas, bandera y puertas
# =========================================================================== #
RUTAS_DE_SERVICIOS = {
    ("POST", "/services/provider/application"),
    ("GET", "/services/provider/application"),
    ("PATCH", "/services/provider/application"),
    ("GET", "/services/provider/application/history"),
    ("GET", "/services/provider/terms"),
    ("POST", "/services/provider/application/terms"),
    ("POST", "/services/provider/application/documents"),
    ("POST", "/services/provider/application/documents/{document_id}/replace"),
    ("DELETE", "/services/provider/application/documents/{document_id}"),
    ("POST", "/services/provider/application/documents/{document_id}/view"),
    ("POST", "/services/provider/application/credentials"),
    ("PATCH", "/services/provider/application/credentials/{credential_id}"),
    ("DELETE", "/services/provider/application/credentials/{credential_id}"),
    ("POST", "/services/provider/application/submit"),
    ("POST", "/services/provider/application/resubmit"),
    ("POST", "/services/provider/application/withdraw"),
    ("GET", "/admin/services/policies"),
    ("POST", "/admin/services/policies/provider-terms/draft"),
    ("PATCH", "/admin/services/policies/{policy_id}"),
    ("GET", "/admin/services/policies/{policy_id}/preview"),
    ("POST", "/admin/services/policies/{policy_id}/publish"),
    ("GET", "/admin/services/applications"),
    ("GET", "/admin/services/applications/{application_id}"),
    ("GET", "/admin/services/applications/{application_id}/history"),
    ("POST", "/admin/services/applications/{application_id}/documents/{document_id}/view"),
    ("POST", "/admin/services/applications/{application_id}/documents/{document_id}/accept"),
    ("POST", "/admin/services/applications/{application_id}/documents/{document_id}/observe"),
    ("POST", "/admin/services/applications/{application_id}/credentials/{credential_id}/verify"),
    ("POST", "/admin/services/applications/{application_id}/credentials/{credential_id}/observe"),
    ("POST", "/admin/services/applications/{application_id}/credentials/{credential_id}/reject"),
    ("POST", "/admin/services/applications/{application_id}/start-review"),
    ("POST", "/admin/services/applications/{application_id}/request-changes"),
    ("POST", "/admin/services/applications/{application_id}/approve"),
    ("POST", "/admin/services/applications/{application_id}/reject"),
    ("POST", "/admin/services/applications/{application_id}/suspend"),
}


#: El catálogo (Incremento 2): `tests/test_servicios_catalogo_api.py` lo prueba.
RUTAS_DEL_CATALOGO = {
    ("GET", "/services/categories"),
    ("GET", "/services/provider/services"),
    ("POST", "/services/provider/services"),
    ("GET", "/services/provider/services/{service_id}"),
    ("POST", "/services/provider/services/{service_id}/draft"),
    ("PATCH", "/services/provider/services/{service_id}/draft"),
    ("GET", "/services/provider/services/{service_id}/draft/requirements"),
    ("POST", "/services/provider/services/{service_id}/draft/images"),
    ("PUT", "/services/provider/services/{service_id}/draft/images/order"),
    ("DELETE", "/services/provider/services/{service_id}/draft/images/{image_id}"),
    ("POST", "/services/provider/services/{service_id}/draft/submit"),
    ("POST", "/services/provider/services/{service_id}/draft/withdraw"),
    ("GET", "/services/provider/services/{service_id}/history"),
    ("GET", "/services/catalog/{service_id}"),
    ("GET", "/admin/services/catalog"),
    ("GET", "/admin/services/catalog/{service_id}"),
    ("GET", "/admin/services/catalog/{service_id}/versions/{version_id}"),
    ("GET", "/admin/services/catalog/{service_id}/history"),
    ("POST", "/admin/services/catalog/{service_id}/versions/{version_id}/start-review"),
    ("POST", "/admin/services/catalog/{service_id}/versions/{version_id}/request-changes"),
    ("POST", "/admin/services/catalog/{service_id}/versions/{version_id}/approve"),
    ("POST", "/admin/services/catalog/{service_id}/versions/{version_id}/publish"),
    ("POST", "/admin/services/catalog/{service_id}/suspend"),
    ("POST", "/admin/services/catalog/{service_id}/reinstate"),
    ("POST", "/admin/services/catalog/{service_id}/retire"),
    ("GET", "/admin/services/categories"),
    ("POST", "/admin/services/categories"),
    ("PATCH", "/admin/services/categories/{category_id}"),
    ("POST", "/admin/services/categories/{category_id}/activate"),
    ("POST", "/admin/services/categories/{category_id}/deactivate"),
}

#: Las del descubrimiento (Incremento 3): el catálogo público, sus categorías,
#: las sugerencias, el perfil del prestador y los guardados.
RUTAS_DEL_DESCUBRIMIENTO = {
    ("GET", "/services/catalog"),
    ("GET", "/services/public-categories"),
    ("GET", "/services/suggestions"),
    ("GET", "/services/providers/{provider_id}"),
    ("GET", "/services/providers/{provider_id}/services"),
    ("POST", "/services/catalog/{service_id}/save"),
    ("DELETE", "/services/catalog/{service_id}/save"),
    ("GET", "/services/saved"),
}

#: La agenda (Incremento 4): doce del prestador y dos públicas.
_AGENDA = "/services/provider/services/{service_id}/schedule"
RUTAS_DE_LA_AGENDA = {
    ("GET", _AGENDA),
    ("PUT", _AGENDA),
    ("POST", f"{_AGENDA}/rules"),
    ("PATCH", f"{_AGENDA}/rules/{{rule_id}}"),
    ("DELETE", f"{_AGENDA}/rules/{{rule_id}}"),
    ("POST", f"{_AGENDA}/exceptions"),
    ("PATCH", f"{_AGENDA}/exceptions/{{exception_id}}"),
    ("DELETE", f"{_AGENDA}/exceptions/{{exception_id}}"),
    ("POST", f"{_AGENDA}/blocks"),
    ("DELETE", f"{_AGENDA}/blocks/{{block_id}}"),
    ("GET", f"{_AGENDA}/preview"),
    ("GET", f"{_AGENDA}/preview/{{day}}"),
    ("GET", "/services/catalog/{service_id}/availability"),
    ("GET", "/services/catalog/{service_id}/availability/{day}"),
}

#: La reserva (Incremento 5, 0093): doce, y el borrador de las condiciones de
#: contratación en administración.
RUTAS_DE_LA_RESERVA = {
    ("POST", "/services/catalog/{service_id}/holds"),
    ("GET", "/services/holds/{hold_id}"),
    ("POST", "/services/holds/{hold_id}/release"),
    ("GET", "/services/holds/{hold_id}/checkout"),
    ("POST", "/services/holds/{hold_id}/confirm"),
    ("GET", "/services/me/bookings"),
    ("GET", "/services/me/bookings/{booking_id}"),
    ("GET", "/services/provider/bookings"),
    ("GET", "/services/provider/bookings/{booking_id}"),
    ("GET", "/admin/services/holds"),
    ("GET", "/admin/services/bookings"),
    ("POST", "/admin/services/holds/expire"),
    ("POST", "/admin/services/policies/booking-terms/draft"),
}


#: La atención y la posventa (Incremento 6, 0094): cancelar, reprogramar, la
#: asistencia, el caso con su expediente, la reseña y su administración.
RUTAS_DE_LA_ATENCION = {
    ("GET", "/services/catalog/{service_id}/reviews"),
    ("POST", "/services/me/bookings/{booking_id}/cancel"),
    ("POST", "/services/me/bookings/{booking_id}/check-in-code"),
    ("POST", "/services/me/bookings/{booking_id}/confirm"),
    ("GET", "/services/me/bookings/{booking_id}/incident"),
    ("POST", "/services/me/bookings/{booking_id}/incident"),
    ("POST", "/services/me/bookings/{booking_id}/incident/appeal"),
    ("POST", "/services/me/bookings/{booking_id}/incident/entries"),
    ("GET", "/services/me/bookings/{booking_id}/incident/entries/{entry_id}/file"),
    ("POST", "/services/me/bookings/{booking_id}/incident/evidence"),
    ("POST", "/services/me/bookings/{booking_id}/incident/withdraw"),
    ("POST", "/services/me/bookings/{booking_id}/no-show"),
    ("POST", "/services/me/bookings/{booking_id}/reschedule"),
    ("POST", "/services/me/bookings/{booking_id}/review"),
    ("POST", "/services/provider/bookings/{booking_id}/cancel"),
    ("POST", "/services/provider/bookings/{booking_id}/complete"),
    ("GET", "/services/provider/bookings/{booking_id}/incident"),
    ("POST", "/services/provider/bookings/{booking_id}/incident"),
    ("POST", "/services/provider/bookings/{booking_id}/incident/appeal"),
    ("POST", "/services/provider/bookings/{booking_id}/incident/entries"),
    ("GET", "/services/provider/bookings/{booking_id}/incident/entries/{entry_id}/file"),
    ("POST", "/services/provider/bookings/{booking_id}/incident/evidence"),
    ("POST", "/services/provider/bookings/{booking_id}/incident/withdraw"),
    ("POST", "/services/provider/bookings/{booking_id}/no-show"),
    ("POST", "/services/provider/bookings/{booking_id}/review/reply"),
    ("POST", "/services/provider/bookings/{booking_id}/start"),
    ("GET", "/admin/services/incidents"),
    ("GET", "/admin/services/incidents/{incident_id}"),
    ("POST", "/admin/services/incidents/{incident_id}/entries"),
    ("GET", "/admin/services/incidents/{incident_id}/entries/{entry_id}/file"),
    ("POST", "/admin/services/incidents/{incident_id}/resolve"),
    ("GET", "/admin/services/reviews"),
    ("POST", "/admin/services/reviews/{review_id}/moderate"),
    ("POST", "/admin/services/tasks/run"),
}


def test_estan_exactamente_las_rutas_de_los_incrementos_1_a_6() -> None:
    rutas = {(m, p[len(API):]) for m, p in _rutas(create_app()) if "/services" in p}
    assert len(RUTAS_DE_LA_AGENDA) == 14 and len(RUTAS_DE_LA_RESERVA) == 13 and len(RUTAS_DE_LA_ATENCION) == 34
    assert rutas == (
        RUTAS_DE_SERVICIOS | RUTAS_DEL_CATALOGO | RUTAS_DEL_DESCUBRIMIENTO | RUTAS_DE_LA_AGENDA
        | RUTAS_DE_LA_RESERVA | RUTAS_DE_LA_ATENCION
    )


def test_ninguna_ruta_de_la_aplicacion_esta_duplicada() -> None:
    rutas = _rutas(create_app())
    assert not [r for r, n in Counter(rutas).items() if n > 1]
    assert len(rutas) > 300


def test_ninguna_ruta_cambia_el_estado_con_patch() -> None:
    parches = {p for m, p in RUTAS_DE_SERVICIOS if m == "PATCH"}
    assert parches == {
        "/services/provider/application",
        "/services/provider/application/credentials/{credential_id}",
        "/admin/services/policies/{policy_id}",
    }
    for esquema_de_entrada in (schemas.BorradorActualizar, schemas.CredencialEditar, schemas.PoliticaEditar):
        assert "status" not in esquema_de_entrada.model_fields
        with pytest.raises(ValidationError):
            esquema_de_entrada.model_validate({"status": "approved"})


def test_la_bandera_nace_apagada() -> None:
    assert get_settings().__class__.model_fields["feature_services"].default is False


def _concreta(ruta: str) -> str:
    return (
        API
        + ruta.replace("{application_id}", str(uuid.uuid4()))
        .replace("{document_id}", str(uuid.uuid4()))
        .replace("{credential_id}", str(uuid.uuid4()))
        .replace("{policy_id}", str(uuid.uuid4()))
    )


@pytest.mark.asyncio
async def test_con_la_bandera_apagada_todo_contesta_503_sin_mirar_la_base(entorno) -> None:
    http, quien, _, _ = entorno
    assert get_settings().feature_services is False
    for rol in (PRESTADORA, JEFA):
        _como(quien, rol)
        for metodo, ruta in sorted(RUTAS_DE_SERVICIOS):
            if rol == PRESTADORA and ruta.startswith("/admin/"):
                continue
            r = await http.request(metodo, _concreta(ruta), json={})
            assert r.status_code == 503, (metodo, ruta, r.text)
            assert _codigo(r) == "services_disabled"
    # NO SE MIRÓ LA BASE: la puerta de esquema sigue sin respuesta guardada.
    assert "admision" not in esquema._cache


def _de_la_reserva(ruta: str) -> str:
    return (
        API
        + ruta.replace("{service_id}", str(uuid.uuid4()))
        .replace("{hold_id}", str(uuid.uuid4()))
        .replace("{booking_id}", str(uuid.uuid4()))
    )


@pytest.mark.asyncio
async def test_la_reserva_con_una_bandera_apagada_contesta_503_sin_mirar_la_base(entorno, monkeypatch) -> None:
    """Incremento 5: Servicios apagado → `services_disabled`; encendido pero
    con la contratación apagada → `service_booking_disabled`. En los dos casos,
    ANTES de mirar la base (ninguna puerta de esquema guarda respuesta). Las
    condiciones de contratación no dependen de la bandera de la contratación
    (la empresa puede preparar el texto antes), solo de Servicios."""
    http, quien, _, _ = entorno
    _como(quien, JEFA)
    for bandera, codigo in ((None, "services_disabled"), ("feature_services", "service_booking_disabled")):
        if bandera:
            monkeypatch.setattr(get_settings(), bandera, True)
        assert get_settings().feature_service_booking is False
        esquema.olvidar()
        for metodo, ruta in sorted(RUTAS_DE_LA_RESERVA):
            if ruta.endswith("/booking-terms/draft"):
                continue
            r = await http.request(metodo, _de_la_reserva(ruta), json={}, headers={"Idempotency-Key": "k-1"})
            assert (r.status_code, _codigo(r)) == (503, codigo), (bandera, metodo, ruta, r.text)
        assert not {"admision", "catalogo", "agenda", "reserva"} & set(esquema._cache), (bandera, esquema._cache)
    esquema.olvidar()
    monkeypatch.setattr(get_settings(), "feature_services", False)
    r = await http.post(f"{API}/admin/services/policies/booking-terms/draft", json={})
    assert (r.status_code, _codigo(r)) == (503, "services_disabled")
    assert "reserva" not in esquema._cache


@pytest.mark.asyncio
async def test_sin_permiso_de_revision_es_403_incluso_con_la_bandera_apagada(entorno) -> None:
    http, quien, _, _ = entorno
    _como(quien, OTRA)
    for metodo, ruta in sorted(RUTAS_DE_SERVICIOS):
        if ruta.startswith("/admin/"):
            r = await http.request(metodo, _concreta(ruta), json={})
            assert r.status_code == 403, (metodo, ruta)
            assert _codigo(r) in ("service_review_forbidden", "service_decision_forbidden")


@pytest.mark.asyncio
async def test_sin_sesion_es_401(entorno, monkeypatch) -> None:
    """En administración, siempre 401. En las rutas de `/services` manda antes
    la puerta de quién entra (el piloto, `services/acceso.py`): con Servicios
    apagado no hay nada que pedirle a nadie, y se contesta lo mismo que a
    cualquiera (503 `services_disabled`); encendido y abierto, 401."""
    http, _, _, app = entorno
    app.dependency_overrides.pop(get_current_user)
    assert get_settings().feature_services is False
    assert (await http.get(BANDEJA)).status_code == 401
    for metodo, ruta in (("GET", MIA), ("POST", f"{MIA}/submit")):
        r = await http.request(metodo, ruta, json={})
        assert (r.status_code, _codigo(r)) == (503, "services_disabled")
    monkeypatch.setattr(get_settings(), "feature_services", True)
    for metodo, ruta in (("GET", MIA), ("POST", f"{MIA}/submit"), ("GET", BANDEJA)):
        assert (await http.request(metodo, ruta, json={})).status_code == 401


@pytest.mark.asyncio
async def test_encendida_sin_las_migraciones_contesta_503_services_not_ready(encendida) -> None:
    esquema.olvidar()
    app = create_app()
    motor = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with motor.begin() as conexion:
        await conexion.run_sync(
            lambda sync: Base.metadata.create_all(
                sync,
                tables=[t for n, t in Base.metadata.tables.items() if n != "service_provider_application_submissions"],
            )
        )
    sesiones = async_sessionmaker(motor, expire_on_commit=False)

    async def _db():
        async with sesiones() as db:
            yield db

    async def _usuario() -> AuthUser:
        return AuthUser(id=PRESTADORA, email="x@y.test", role="authenticated")

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _usuario
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as http:
            r = await http.get(MIA)
        assert r.status_code == 503
        assert _codigo(r) == "services_not_ready"
    finally:
        app.dependency_overrides.clear()
        await motor.dispose()
        esquema.olvidar()


@pytest.mark.asyncio
async def test_la_configuracion_publica_dice_si_servicios_esta_encendido(entorno) -> None:
    http, *_ = entorno
    assert (await http.get(f"{API}/platform/config")).json() == {
        "publicacion_flexible": get_settings().publicacion_flexible,
        "feature_services": False,
    }
    assert (await http.get("/health")).json()["status"] == "ok"


# =========================================================================== #
# 2. Condiciones del prestador
# =========================================================================== #
@pytest.mark.asyncio
async def test_ciclo_completo_de_las_condiciones(entorno, encendida) -> None:
    http, quien, sesiones, _ = entorno
    _como(quien, MODERADOR)
    assert (await http.get(f"{ADMIN}/policies")).status_code == 200
    r = await http.post(
        f"{ADMIN}/policies/provider-terms/draft",
        json={"country_code": "PE", "title": "Condiciones", "body": TEXTO},
    )
    assert r.status_code == 403 and _codigo(r) == "service_decision_forbidden"

    _como(quien, JEFA)
    r = await http.post(
        f"{ADMIN}/policies/provider-terms/draft",
        json={"country_code": "pe", "title": "Condiciones", "body": TEXTO},
    )
    assert r.status_code == 201
    borrador = r.json()
    assert (borrador["status"], borrador["version"], borrador["country_code"]) == ("draft", 1, "PE")
    # Crear otra vez devuelve el mismo borrador sin tocarlo.
    otra = await http.post(
        f"{ADMIN}/policies/provider-terms/draft",
        json={"country_code": "PE", "title": "Otro título", "body": TEXTO + "x"},
    )
    assert otra.status_code == 200 and otra.json()["id"] == borrador["id"]
    assert otra.json()["title"] == "Condiciones"

    editada = await http.patch(f"{ADMIN}/policies/{borrador['id']}", json={"body": TEXTO + " Versión uno."})
    assert editada.status_code == 200
    vista = (await http.get(f"{ADMIN}/policies/{borrador['id']}/preview")).json()
    assert vista["body"].endswith("Versión uno.") and vista["sha256"] == editada.json()["body_sha256"]

    v1 = (await http.post(f"{ADMIN}/policies/{borrador['id']}/publish")).json()
    assert v1["status"] == "published" and v1["published_at"]
    # Publicar otra vez no cambia nada; editarla, no se puede.
    assert (await http.post(f"{ADMIN}/policies/{borrador['id']}/publish")).json()["status"] == "published"
    r = await http.patch(f"{ADMIN}/policies/{borrador['id']}", json={"title": "Otro"})
    assert r.status_code == 409 and _codigo(r) == "service_policy_not_editable"

    nueva = (await http.post(
        f"{ADMIN}/policies/provider-terms/draft",
        json={"country_code": "PE", "title": "Condiciones v2", "body": TEXTO + " dos"},
    )).json()
    assert nueva["version"] == 2
    await http.post(f"{ADMIN}/policies/{nueva['id']}/publish")
    versiones = {p["version"]: p["status"] for p in (await http.get(f"{ADMIN}/policies", params={"country": "PE"})).json()}
    assert versiones == {1: "superseded", 2: "published"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "parametros",
    [
        {"desconocido": True},
        {"required_documents": {"individual": ["pasaporte_inventado"]}},
        {"required_documents": {"robot": ["identity"]}},
        {"required_credentials": ["licencia_de_magia"]},
        {"reapplication_after_rejection": "quizas"},
    ],
)
async def test_los_parametros_de_la_politica_se_validan(entorno, encendida, parametros) -> None:
    http, quien, _, _ = entorno
    _como(quien, JEFA)
    r = await http.post(
        f"{ADMIN}/policies/provider-terms/draft",
        json={"country_code": "PE", "title": "Condiciones", "body": TEXTO, "parameters": parametros},
    )
    assert r.status_code == 422 and _codigo(r) == "service_policy_parameters_invalid"


@pytest.mark.asyncio
async def test_aceptar_las_condiciones(entorno, encendida, almacen) -> None:
    http, quien, _, _ = entorno
    await http.post(MIA, json={"provider_type": "individual", "display_name": "Ana"})
    r = await http.get(TERMINOS)
    assert r.status_code == 409 and _codigo(r) == "service_application_country_required"
    await http.patch(MIA, json={"country_code": "PE"})
    r = await http.get(TERMINOS)
    assert r.status_code == 409 and _codigo(r) == "provider_terms_not_published"
    assert "provider_terms_not_published" in (await http.get(MIA)).json()["missing"]

    await _publicar(http, quien)
    terminos = (await http.get(TERMINOS)).json()
    mal = await http.post(f"{MIA}/terms", json={"terms_policy_id": terminos["policy_id"], "terms_sha256": "0" * 64})
    assert mal.status_code == 409 and _codigo(mal) == "provider_terms_changed"
    assert "provider_terms_not_accepted" in (await http.get(MIA)).json()["missing"]

    bien = await http.post(f"{MIA}/terms", json={"terms_policy_id": terminos["policy_id"], "terms_sha256": terminos["sha256"]})
    assert bien.status_code == 200
    assert bien.json()["terms"]["version"] == 1
    assert not {"provider_terms_not_accepted", "provider_terms_changed"} & set(bien.json()["missing"])

    # La empresa publica otra versión: lo aceptado ya no vale para enviar.
    await _publicar(http, quien, texto=TEXTO + " Nueva versión.")
    assert "provider_terms_changed" in (await http.get(MIA)).json()["missing"]


# =========================================================================== #
# 3. Documentos privados
# =========================================================================== #
@pytest.mark.asyncio
async def test_subir_documentos_mira_los_bytes_y_no_dice_la_ruta(entorno, encendida, almacen) -> None:
    http, quien, sesiones, _ = entorno
    await http.post(MIA, json={"provider_type": "individual", "display_name": "Ana"})
    r = await _documento(http)
    assert r.status_code == 201, r.text
    texto = r.text
    assert "storage_path" not in texto and "service-provider-documents" not in texto
    assert PRESTADORA not in texto.replace(r.json()["provider"]["id"], "")  # ni el prefijo de la ruta
    documento = r.json()["documents"][0]
    assert (documento["kind"], documento["content_type"], documento["review_status"]) == ("identity", "image/png", "pending")
    assert documento["can_remove"] and documento["can_replace"]

    # La ruta la puso el servidor, bajo el perfil y la postulación.
    [ruta] = almacen.objetos
    assert ruta.startswith(f"{PRESTADORA}/{r.json()['id']}/") and ruta.endswith(".png")

    # El mismo archivo otra vez: el mismo documento (200), sin subir nada más.
    otra = await _documento(http)
    assert otra.status_code == 200 and len(otra.json()["documents"]) == 1 and len(almacen.objetos) == 1

    for datos, codigo in (
        (b"hola, no soy un pdf", "service_document_type_invalid"),
        (b"", "service_document_empty"),
        (b"%PDF-" + b"0" * (10 * 1024 * 1024), "service_document_too_big"),
    ):
        r = await _documento(http, datos=datos, nombre="x.pdf", tipo="application/pdf")
        assert r.status_code == 422 and _codigo(r) == codigo, codigo
    r = await _documento(http, kind="pasaporte_de_marte", datos=PDF, nombre="x.pdf", tipo="application/pdf")
    assert r.status_code == 422 and _codigo(r) == "service_document_kind_invalid"


@pytest.mark.asyncio
async def test_reemplazar_y_retirar_documentos(entorno, encendida, almacen) -> None:
    http, quien, sesiones, _ = entorno
    await http.post(MIA, json={"provider_type": "individual", "display_name": "Ana"})
    uno = (await _documento(http)).json()["documents"][0]
    r = await http.post(
        f"{MIA}/documents/{uno['id']}/replace", files={"file": ("dni.pdf", PDF, "application/pdf")}
    )
    assert r.status_code == 200
    [nuevo] = r.json()["documents"]
    assert nuevo["id"] != uno["id"] and nuevo["content_type"] == "application/pdf"
    async with sesiones() as db:
        viejo = await db.get(ServiceProviderDocument, uno["id"])
        assert (viejo.lifecycle, viejo.replaced_by) == ("replaced", nuevo["id"])

    r = await http.delete(f"{MIA}/documents/{nuevo['id']}")
    assert r.status_code == 200 and r.json()["documents"] == []
    async with sesiones() as db:
        assert (await db.get(ServiceProviderDocument, nuevo["id"])).lifecycle == "removed"
    assert len(almacen.borrados) == 1
    # Retirar lo retirado no hace nada ni borra otra vez.
    assert (await http.delete(f"{MIA}/documents/{nuevo['id']}")).status_code == 200
    assert len(almacen.borrados) == 1
    # Y lo reemplazado ya no se reemplaza ni se retira: es evidencia.
    r = await http.post(f"{MIA}/documents/{uno['id']}/replace", files={"file": ("x.pdf", PDF, "application/pdf")})
    assert r.status_code == 409 and _codigo(r) == "service_document_locked"
    r = await http.delete(f"{MIA}/documents/{uno['id']}")
    assert r.status_code == 409 and _codigo(r) == "service_document_locked"


@pytest.mark.asyncio
async def test_lo_enviado_no_se_retira_y_en_revision_no_se_toca(entorno, encendida, almacen) -> None:
    http, quien, _, _ = entorno
    await _publicar(http, quien)
    enviada = await _enviada(http, quien)
    documento = enviada["documents"][0]
    assert documento["can_remove"] is False and documento["can_replace"] is False
    r = await http.delete(f"{MIA}/documents/{documento['id']}")
    assert r.status_code == 409 and _codigo(r) == "service_document_locked"
    r = await _documento(http, datos=PDF, nombre="otro.pdf", tipo="application/pdf")
    assert r.status_code == 409 and _codigo(r) == "service_document_locked"
    r = await http.patch(MIA, json={"summary": RESUMEN + " Cambio tardío."})
    assert r.status_code == 409 and _codigo(r) == "service_application_not_editable"

    # Devuelta con correcciones: se reemplaza, pero lo enviado no se retira.
    _como(quien, MODERADOR)
    await http.post(f"{BANDEJA}/{enviada['id']}/start-review", json={})
    await http.post(f"{BANDEJA}/{enviada['id']}/request-changes", json={"message": "Sube el DNI por ambas caras."})
    _como(quien, PRESTADORA)
    vista = (await http.get(MIA)).json()
    assert vista["documents"][0]["can_remove"] is False and vista["documents"][0]["can_replace"] is True
    r = await http.delete(f"{MIA}/documents/{documento['id']}")
    assert r.status_code == 409 and _codigo(r) == "service_document_submitted"


@pytest.mark.asyncio
async def test_ver_un_documento_es_un_enlace_de_dos_minutos_y_solo_lo_propio(entorno, encendida, almacen) -> None:
    http, quien, _, _ = entorno
    await http.post(MIA, json={"provider_type": "individual", "display_name": "Ana"})
    documento = (await _documento(http)).json()["documents"][0]
    r = await http.post(f"{MIA}/documents/{documento['id']}/view")
    assert r.status_code == 200 and r.json()["expires_in"] == 120
    assert almacen.firmas[-1][2] == 120 and almacen.firmas[-1][0] == "service-provider-documents"

    _como(quien, OTRA)
    await http.post(MIA, json={"provider_type": "individual", "display_name": "Olga"})
    for metodo, ruta in (
        ("POST", f"{MIA}/documents/{documento['id']}/view"),
        ("DELETE", f"{MIA}/documents/{documento['id']}"),
        ("POST", f"{MIA}/documents/no-es-un-uuid/view"),
    ):
        r = await http.request(metodo, ruta)
        assert r.status_code == 404 and _codigo(r) == "service_document_not_found", ruta

    almacen.configurado = False
    _como(quien, PRESTADORA)
    r = await http.post(f"{MIA}/documents/{documento['id']}/view")
    assert r.status_code == 503 and _codigo(r) == "service_storage_not_configured"


# =========================================================================== #
# 4. Credenciales
# =========================================================================== #
@pytest.mark.asyncio
async def test_credenciales_del_prestador(entorno, encendida, almacen) -> None:
    http, quien, sesiones, _ = entorno
    await http.post(MIA, json={"provider_type": "individual", "display_name": "Ana"})
    evidencia = (await _documento(http, kind="professional_license", datos=PDF, nombre="c.pdf", tipo="application/pdf")).json()["documents"][0]
    cuerpo = {
        "kind": "professional_license", "title": "Colegiatura", "issuer": "Colegio de Psicólogos",
        "number": "PSI-2020-4587", "expires_on": str(date.today() + timedelta(days=365)),
        "evidence_document_id": evidencia["id"],
    }
    clave = {"Idempotency-Key": "credencial-1-abcdef"}
    r = await http.post(f"{MIA}/credentials", json=cuerpo, headers=clave)
    assert r.status_code == 201
    assert "PSI-2020-4587" not in r.text
    [credencial] = r.json()["credentials"]
    assert credencial["number_masked"] == "••••4587" and credencial["display_status"] == "pending"
    # Misma clave, misma credencial.
    r = await http.post(f"{MIA}/credentials", json=cuerpo, headers=clave)
    assert r.status_code == 200 and len(r.json()["credentials"]) == 1

    # Evidencia ajena: no.
    _como(quien, OTRA)
    await http.post(MIA, json={"provider_type": "individual", "display_name": "Olga"})
    r = await http.post(f"{MIA}/credentials", json=cuerpo)
    assert r.status_code == 422 and _codigo(r) == "service_credential_evidence_invalid"
    r = await http.patch(f"{MIA}/credentials/{credencial['id']}", json={"title": "Robada"})
    assert r.status_code == 404

    _como(quien, PRESTADORA)
    r = await http.patch(f"{MIA}/credentials/{credencial['id']}", json={"title": "Colegiatura CPsP"})
    assert r.status_code == 200 and r.json()["credentials"][0]["title"] == "Colegiatura CPsP"
    assert (await http.delete(f"{MIA}/credentials/{credencial['id']}")).json()["credentials"] == []


# =========================================================================== #
# 5. El flujo de admisión
# =========================================================================== #
@pytest.mark.asyncio
async def test_enviar_exige_lo_que_falta(entorno, encendida, almacen) -> None:
    http, quien, _, _ = entorno
    await _publicar(http, quien)
    await http.post(MIA, json={"provider_type": "company", "display_name": "Taller"})
    r = await http.post(f"{MIA}/submit", json={"declare_truthfulness": True})
    assert r.status_code == 422 and _codigo(r) == "service_application_incomplete"
    assert set(r.json()["error"]["details"]["missing"]) >= {
        "legal_name", "country_code", "summary", "tax_id", "representative_name",
        "document:identity", "document:legal_representation",
    }
    r = await http.post(f"{MIA}/submit", json={"declare_truthfulness": False})
    assert r.status_code == 422
    assert (await http.get(MIA)).json()["status"] == "draft"


@pytest.mark.asyncio
async def test_la_politica_puede_exigir_mas_documentos_y_credenciales(entorno, encendida, almacen) -> None:
    http, quien, _, _ = entorno
    await _publicar(http, quien, parametros={
        "required_documents": {"individual": ["proof_of_address"]},
        "required_credentials": ["professional_license"],
    })
    faltan = (await _listo_para_enviar(http, quien))["missing"]
    assert "document:proof_of_address" in faltan and "credential:professional_license" in faltan


@pytest.mark.asyncio
async def test_enviar_congela_avisa_audita_y_es_idempotente(entorno, encendida, almacen) -> None:
    from app.modules.gobernanza.models import AuditEvent
    from app.modules.notifications.models import Notification

    http, quien, sesiones, _ = entorno
    await _publicar(http, quien)
    await _listo_para_enviar(http, quien)
    clave = {"Idempotency-Key": "enviar-una-vez-123"}
    r = await http.post(f"{MIA}/submit", json={"declare_truthfulness": True}, headers=clave)
    assert r.status_code == 200 and r.json()["status"] == "submitted"
    assert r.json()["editable"] is False and r.json()["can_withdraw"] is True
    for _ in range(2):
        again = await http.post(f"{MIA}/submit", json={"declare_truthfulness": True}, headers=clave)
        assert again.status_code == 200
    assert (await http.post(f"{MIA}/submit", json={"declare_truthfulness": True})).status_code == 200

    async with sesiones() as db:
        solicitud = await db.scalar(select(ServiceProviderApplication))
        eventos = list(await db.scalars(select(ServiceProviderApplicationEvent)))
        envios = list(await db.scalars(select(ServiceProviderApplicationSubmission)))
        avisos_ = list(await db.scalars(select(Notification).where(Notification.type == avisos.ENVIADA)))
        rastro = list(await db.scalars(select(AuditEvent).where(AuditEvent.action == "service_application.submitted")))
    assert [(e.from_status, e.to_status) for e in eventos] == [(None, "draft"), ("draft", "submitted")]
    assert len(envios) == 1 and envios[0].sequence == 1 and envios[0].terms_version == 1
    foto = str(envios[0].snapshot)
    assert "storage_path" not in foto and f"{PRESTADORA}/" not in foto
    assert solicitud.truthfulness_declared_at is not None
    # Avisa al equipo (moderación y administración), no a quien postula.
    assert sorted(a.user_id for a in avisos_) == sorted([MODERADOR, JEFA])
    assert len(rastro) == 1 and rastro[0].actor_role == "user"
    assert "storage" not in str(rastro[0].payload)


@pytest.mark.asyncio
async def test_revision_correcciones_y_reenvio(entorno, encendida, almacen) -> None:
    http, quien, sesiones, _ = entorno
    await _publicar(http, quien)
    solicitud = await _en_revision(http, quien)
    detalle = (await http.get(f"{BANDEJA}/{solicitud}")).json()
    documento = detalle["documents"][0]["id"]

    r = await http.post(f"{BANDEJA}/{solicitud}/documents/{documento}/observe", json={"note": "La foto está borrosa."})
    assert r.status_code == 200
    r = await http.post(f"{BANDEJA}/{solicitud}/request-changes", json={"message": "Corrige tu nombre legal y el DNI.", "fields": ["legal_name"], "internal_note": "NOTA-INTERNA-X"})
    assert r.status_code == 200 and r.json()["status"] == "changes_requested"
    r = await http.post(f"{BANDEJA}/{solicitud}/request-changes", json={"message": "Otra vez"})
    assert r.status_code == 409  # ya no está en revisión
    r = await http.post(f"{BANDEJA}/{solicitud}/request-changes", json={"message": "x", "fields": ["salario"]})
    assert r.status_code in (409, 422)

    _como(quien, PRESTADORA)
    vista = (await http.get(MIA)).json()
    assert vista["status"] == "changes_requested" and vista["editable"] is True
    assert vista["applicant_message"] == "Corrige tu nombre legal y el DNI."
    assert vista["observed_fields"] == ["legal_name"]
    assert "NOTA-INTERNA-X" not in (await http.get(MIA)).text
    assert "NOTA-INTERNA-X" not in (await http.get(f"{MIA}/history")).text
    assert {"field_not_corrected:legal_name", "document_observed:identity"} <= set(vista["missing"])
    r = await http.post(f"{MIA}/resubmit", json={"declare_truthfulness": True})
    assert r.status_code == 422 and _codigo(r) == "service_application_incomplete"

    await http.patch(MIA, json={"legal_name": "Ana María Quispe Rojas"})
    r = await http.post(f"{MIA}/documents/{documento}/replace", files={"file": ("dni.pdf", PDF, "application/pdf")})
    assert r.status_code == 200
    r = await http.post(f"{MIA}/resubmit", json={"declare_truthfulness": True})
    assert r.status_code == 200 and r.json()["status"] == "resubmitted"
    assert r.json()["submissions_count"] == 2

    _como(quien, MODERADOR)
    assert (await http.post(f"{BANDEJA}/{solicitud}/start-review", json={})).json()["status"] == "under_review"
    historial = (await http.get(f"{BANDEJA}/{solicitud}/history")).json()
    assert [(e["from_status"], e["to_status"]) for e in historial] == [
        (None, "draft"), ("draft", "submitted"), ("submitted", "under_review"),
        ("under_review", "changes_requested"), ("changes_requested", "resubmitted"),
        ("resubmitted", "under_review"),
    ]
    assert historial[3]["internal_note"] == "NOTA-INTERNA-X"
    assert historial[3]["details"] == {"fields": ["legal_name"]}
    assert historial[4]["details"]["submission"] == 2
    assert all(e["actor_id"] for e in historial)

    _como(quien, PRESTADORA)
    visible = (await http.get(f"{MIA}/history")).json()
    assert [e["by"] for e in visible] == ["you", "you", "z", "z", "you", "z"]
    assert visible[3]["fields"] == ["legal_name"]
    assert MODERADOR not in str(visible)


@pytest.mark.asyncio
async def test_aprobar_exige_la_evidencia_revisada_y_solo_administracion(entorno, encendida, almacen) -> None:
    http, quien, sesiones, _ = entorno
    await _publicar(http, quien)
    solicitud = await _en_revision(http, quien)
    _como(quien, JEFA)
    r = await http.post(f"{BANDEJA}/{solicitud}/approve", json={})
    assert r.status_code == 409 and _codigo(r) == "service_application_requirements_pending"
    assert "document_pending_review:identity" in r.json()["error"]["details"]["blockers"]

    await _todo_aceptado(http, quien, solicitud)
    _como(quien, MODERADOR)
    r = await http.post(f"{BANDEJA}/{solicitud}/approve", json={})
    assert r.status_code == 403 and _codigo(r) == "service_decision_forbidden"

    _como(quien, JEFA)
    detalle = (await http.get(f"{BANDEJA}/{solicitud}")).json()
    assert detalle["approval_blockers"] == []
    assert set(detalle["available_actions"]) == {"request_changes", "approve", "reject"}
    r = await http.post(f"{BANDEJA}/{solicitud}/approve", json={"message": "Bienvenida."})
    assert r.status_code == 200 and r.json()["status"] == "approved"
    assert r.json()["provider"]["status"] == PRESTADOR_ACTIVO
    assert r.json()["decided_by"] == JEFA

    _como(quien, PRESTADORA)
    vista = (await http.get(MIA)).json()
    assert vista["provider"]["status"] == "active" and "decided_by" not in vista
    assert vista["can_withdraw"] is False


@pytest.mark.asyncio
async def test_suspender_y_volver_a_revision_mantienen_al_prestador_coherente(entorno, encendida, almacen) -> None:
    http, quien, sesiones, _ = entorno
    await _publicar(http, quien)
    solicitud = await _aprobada(http, quien)
    _como(quien, JEFA)
    r = await http.post(f"{BANDEJA}/{solicitud}/suspend", json={})
    assert r.status_code == 422
    r = await http.post(f"{BANDEJA}/{solicitud}/suspend", json={"message": "Reclamo grave en curso."})
    assert r.status_code == 200 and (r.json()["status"], r.json()["provider"]["status"]) == ("suspended", "suspended")
    r = await http.post(f"{BANDEJA}/{solicitud}/start-review", json={})
    assert (r.json()["status"], r.json()["provider"]["status"]) == ("under_review", "suspended")
    # En revisión otra vez, pero YA DECIDIDA: retirarse no la saca de la investigación.
    _como(quien, PRESTADORA)
    assert (await http.get(MIA)).json()["can_withdraw"] is False
    r = await http.post(f"{MIA}/withdraw", json={"confirm": True})
    assert r.status_code == 409 and _codigo(r) == "service_application_already_decided"
    _como(quien, JEFA)
    r = await http.post(f"{BANDEJA}/{solicitud}/approve", json={})
    assert (r.json()["status"], r.json()["provider"]["status"]) == ("approved", "active")
    # Suspender de nuevo y rechazar tras investigar: sigue suspendido, nunca activo.
    await http.post(f"{BANDEJA}/{solicitud}/suspend", json={"message": "Otra vez."})
    await http.post(f"{BANDEJA}/{solicitud}/start-review", json={})
    r = await http.post(f"{BANDEJA}/{solicitud}/reject", json={"message": "Fraude comprobado."})
    assert (r.json()["status"], r.json()["provider"]["status"]) == ("rejected", "suspended")


@pytest.mark.asyncio
async def test_rechazar_es_final_y_volver_a_postular_lo_decide_la_politica(entorno, encendida, almacen) -> None:
    http, quien, sesiones, _ = entorno
    await _publicar(http, quien)
    solicitud = await _en_revision(http, quien)
    _como(quien, JEFA)
    assert (await http.post(f"{BANDEJA}/{solicitud}/reject", json={})).status_code == 422
    r = await http.post(f"{BANDEJA}/{solicitud}/reject", json={"message": "No se pudo verificar la identidad."})
    assert r.status_code == 200 and r.json()["status"] == "rejected"
    assert (await http.post(f"{BANDEJA}/{solicitud}/start-review", json={})).status_code == 409

    _como(quien, PRESTADORA)
    assert (await http.get(MIA)).json()["applicant_message"] == "No se pudo verificar la identidad."
    r = await http.post(MIA, json={"provider_type": "individual", "display_name": "Ana"})
    assert r.status_code == 409 and _codigo(r) == "service_reapplication_not_configured"
    await _publicar(http, quien, parametros={"reapplication_after_rejection": "not_allowed"}, texto=TEXTO + " B")
    r = await http.post(MIA, json={"provider_type": "individual", "display_name": "Ana"})
    assert r.status_code == 403 and _codigo(r) == "service_reapplication_not_allowed"
    await _publicar(http, quien, parametros={"reapplication_after_rejection": "allowed"}, texto=TEXTO + " C")
    r = await http.post(MIA, json={"provider_type": "individual", "display_name": "Ana"})
    assert r.status_code == 201 and r.json()["id"] != solicitud


@pytest.mark.asyncio
async def test_nadie_se_admite_a_si_mismo_ni_siendo_administrador(entorno, encendida, almacen) -> None:
    http, quien, _, _ = entorno
    await _publicar(http, quien)
    solicitud = await _en_revision(http, quien, uid=JEFA, revisor=MODERADOR)
    _como(quien, JEFA)
    detalle = (await http.get(f"{BANDEJA}/{solicitud}")).json()
    assert detalle["is_own"] is True and detalle["available_actions"] == []
    for accion, cuerpo in (
        ("approve", {}), ("reject", {"message": "No me gusto yo"}),
        ("request-changes", {"message": "Me corrijo"}),
    ):
        r = await http.post(f"{BANDEJA}/{solicitud}/{accion}", json=cuerpo)
        assert r.status_code == 403 and _codigo(r) == "service_self_review_forbidden", accion
    documento = detalle["documents"][0]["id"]
    r = await http.post(f"{BANDEJA}/{solicitud}/documents/{documento}/accept")
    assert r.status_code == 403 and _codigo(r) == "service_self_review_forbidden"


@pytest.mark.asyncio
async def test_retirar_desde_cada_estado_permitido(entorno, encendida, almacen) -> None:
    from app.modules.notifications.models import Notification

    http, quien, sesiones, _ = entorno
    await _publicar(http, quien)
    # Desde borrador.
    await http.post(MIA, json={"provider_type": "individual", "display_name": "Ana"})
    r = await http.post(f"{MIA}/withdraw", json={"confirm": True})
    assert r.status_code == 200 and r.json()["status"] == "withdrawn" and r.json()["can_withdraw"] is False
    # Idempotente: otra vez, 200 y sin evento nuevo.
    assert (await http.post(f"{MIA}/withdraw", json={"confirm": True})).status_code == 200
    async with sesiones() as db:
        retiradas = list(await db.scalars(select(ServiceProviderApplicationEvent).where(ServiceProviderApplicationEvent.to_status == "withdrawn")))
    assert len(retiradas) == 1

    # Desde enviada, con motivo: el equipo se entera.
    await _enviada(http, quien)
    r = await http.post(f"{MIA}/withdraw", json={"confirm": True, "reason": "Me mudo de ciudad."})
    assert r.json()["status"] == "withdrawn"
    historial = (await http.get(f"{MIA}/history")).json()
    assert historial[-1]["visible_note"] == "Me mudo de ciudad." and historial[-1]["by"] == "you"
    async with sesiones() as db:
        al_equipo = list(await db.scalars(select(Notification).where(Notification.type == avisos.RETIRADA_EN_REVISION)))
    assert sorted(a.user_id for a in al_equipo) == sorted([MODERADOR, JEFA])

    for cuerpo in ({}, {"confirm": False}, {"confirm": True, "reason": "x" * 501}):
        assert (await http.post(f"{MIA}/withdraw", json=cuerpo)).status_code == 422


@pytest.mark.asyncio
async def test_no_se_retira_tras_la_decision_ni_la_retira_administracion(entorno, encendida, almacen) -> None:
    http, quien, _, _ = entorno
    await _publicar(http, quien)
    solicitud = await _aprobada(http, quien)
    _como(quien, PRESTADORA)
    r = await http.post(f"{MIA}/withdraw", json={"confirm": True})
    assert r.status_code == 409 and _codigo(r) == "service_application_transition_invalid"
    # Administración no tiene ruta para retirar en nombre de nadie, y la del
    # prestador solo habla de la postulación de quien pregunta.
    assert not [p for m, p in RUTAS_DE_SERVICIOS if p.startswith("/admin/") and "withdraw" in p]
    _como(quien, JEFA)
    r = await http.post(f"{MIA}/withdraw", json={"confirm": True})
    assert r.status_code == 404
    assert (await http.get(f"{BANDEJA}/{solicitud}")).json()["status"] == "approved"


@pytest.mark.asyncio
async def test_tras_retirarse_la_nueva_empieza_vacia_y_acepta_otra_vez(entorno, encendida, almacen) -> None:
    http, quien, sesiones, _ = entorno
    await _publicar(http, quien)
    primera = await _enviada(http, quien)
    await http.post(f"{MIA}/withdraw", json={"confirm": True})
    nueva = await http.post(MIA, json={"provider_type": "individual", "display_name": "Ana"})
    assert nueva.status_code == 201
    cuerpo = nueva.json()
    assert cuerpo["id"] != primera["id"]
    assert (cuerpo["documents"], cuerpo["credentials"], cuerpo["terms"], cuerpo["summary"]) == ([], [], None, None)
    assert "provider_terms_not_accepted" in cuerpo["missing"]
    async with sesiones() as db:
        vieja = await db.get(ServiceProviderApplication, primera["id"])
        assert vieja.status == "withdrawn" and vieja.terms_policy_id is not None
        assert len(list(await db.scalars(select(ServiceProviderDocument).where(ServiceProviderDocument.application_id == primera["id"])))) == 1


@pytest.mark.asyncio
async def test_idempotencia_de_las_decisiones(entorno, encendida, almacen) -> None:
    http, quien, sesiones, _ = entorno
    await _publicar(http, quien)
    solicitud = (await _enviada(http, quien))["id"]
    _como(quien, MODERADOR)
    clave = {"Idempotency-Key": "tomar-la-postulacion-1"}
    for _ in range(3):
        r = await http.post(f"{BANDEJA}/{solicitud}/start-review", json={}, headers=clave)
        assert r.status_code == 200
    # La misma clave para OTRA acción es un error, no una repetición.
    r = await http.post(f"{BANDEJA}/{solicitud}/request-changes", json={"message": "Falta algo"}, headers=clave)
    assert r.status_code == 409 and _codigo(r) == "idempotency_key_reused"
    r = await http.post(f"{BANDEJA}/{solicitud}/start-review", json={}, headers={"Idempotency-Key": "corta"})
    assert r.status_code == 422 and _codigo(r) == "idempotency_key_invalid"
    async with sesiones() as db:
        tomas = list(await db.scalars(select(ServiceProviderApplicationEvent).where(ServiceProviderApplicationEvent.to_status == "under_review")))
    assert len(tomas) == 1


@pytest.mark.asyncio
async def test_credenciales_revisadas_por_z(entorno, encendida, almacen) -> None:
    http, quien, sesiones, _ = entorno
    await _publicar(http, quien)
    await _listo_para_enviar(http, quien)
    sin_evidencia = await http.post(f"{MIA}/credentials", json={"kind": "certification", "title": "Curso", "issuer": "Instituto"})
    assert sin_evidencia.status_code == 201
    faltan = sin_evidencia.json()["missing"]
    assert "credential_evidence" in faltan
    credencial = sin_evidencia.json()["credentials"][0]["id"]
    evidencia = (await _documento(http, kind="professional_title", datos=PDF, nombre="t.pdf", tipo="application/pdf")).json()
    doc = [d for d in evidencia["documents"] if d["kind"] == "professional_title"][0]["id"]
    await http.patch(f"{MIA}/credentials/{credencial}", json={"evidence_document_id": doc})
    await http.post(f"{MIA}/submit", json={"declare_truthfulness": True})
    # Enviada: ni se retira ni se edita.
    assert (await http.delete(f"{MIA}/credentials/{credencial}")).status_code == 409

    _como(quien, MODERADOR)
    solicitud = (await http.get(BANDEJA)).json()["items"][0]["id"]
    await http.post(f"{BANDEJA}/{solicitud}/start-review", json={})
    r = await http.post(f"{BANDEJA}/{solicitud}/credentials/{credencial}/observe", json={"note": "Falta la fecha de emisión."})
    assert r.json()["credentials"][0]["display_status"] == "observed"
    r = await http.post(f"{BANDEJA}/{solicitud}/credentials/{credencial}/reject", json={"note": "No corresponde."})
    assert r.json()["credentials"][0]["display_status"] == "rejected"
    r = await http.post(f"{BANDEJA}/{solicitud}/credentials/{credencial}/verify")
    assert r.status_code == 409  # rechazada es final para esa credencial

    _como(quien, PRESTADORA)
    vista = (await http.get(MIA)).json()
    assert vista["credentials"][0]["display_status"] == "rejected"
    assert vista["credentials"][0]["review_note"] == "No corresponde."


@pytest.mark.asyncio
async def test_revisar_evidencia_solo_en_revision_y_por_quien_puede(entorno, encendida, almacen) -> None:
    http, quien, _, _ = entorno
    await _publicar(http, quien)
    solicitud = (await _enviada(http, quien))["id"]
    _como(quien, MODERADOR)
    documento = (await http.get(f"{BANDEJA}/{solicitud}")).json()["documents"][0]["id"]
    r = await http.post(f"{BANDEJA}/{solicitud}/documents/{documento}/accept")
    assert r.status_code == 409 and _codigo(r) == "service_document_locked"
    await http.post(f"{BANDEJA}/{solicitud}/start-review", json={})
    assert (await http.post(f"{BANDEJA}/{solicitud}/documents/{documento}/observe", json={})).status_code == 422
    # El enlace de administración queda auditado y dura dos minutos.
    r = await http.post(f"{BANDEJA}/{solicitud}/documents/{documento}/view")
    assert r.status_code == 200 and r.json()["expires_in"] == 120
    _como(quien, OTRA)
    assert (await http.post(f"{BANDEJA}/{solicitud}/documents/{documento}/view")).status_code == 403


@pytest.mark.asyncio
async def test_la_bandeja_filtra_y_pagina(entorno, encendida, almacen) -> None:
    http, quien, _, _ = entorno
    await _publicar(http, quien)
    for uid in (PRESTADORA, OTRA, TERCERA):
        await _enviada(http, quien, uid=uid)
    _como(quien, MODERADOR)
    vistos, cursor = [], None
    for _ in range(5):
        params = {"limit": 1} | ({"cursor": cursor} if cursor else {})
        pagina = (await http.get(BANDEJA, params=params)).json()
        vistos += [i["id"] for i in pagina["items"]]
        cursor = pagina["next_cursor"]
        if cursor is None:
            break
    assert len(vistos) == 3 == len(set(vistos))
    for params, codigo in (
        ({"status": "aprobado"}, "service_application_status_unknown"),
        ({"provider_type": "robot"}, "service_provider_type_unknown"),
        ({"cursor": "no-es-un-cursor"}, "invalid_cursor"),
    ):
        r = await http.get(BANDEJA, params=params)
        assert r.status_code == 422 and _codigo(r) == codigo
    assert (await http.get(BANDEJA, params={"provider_type": "company"})).json()["items"] == []
    for ident in (str(uuid.uuid4()), "no-es-un-uuid"):
        assert (await http.get(f"{BANDEJA}/{ident}")).status_code == 404


@pytest.mark.asyncio
async def test_un_aviso_que_falla_no_deshace_la_decision(entorno, encendida, almacen, monkeypatch) -> None:
    from app.modules.notifications import service as avisos_de_la_app

    http, quien, _, _ = entorno
    await _publicar(http, quien)
    await _listo_para_enviar(http, quien)

    async def _revienta(*a, **k):
        raise RuntimeError("la bandeja se cayó")

    monkeypatch.setattr(avisos_de_la_app, "add_notification", _revienta)
    r = await http.post(f"{MIA}/submit", json={"declare_truthfulness": True})
    assert r.status_code == 200 and r.json()["status"] == "submitted"


def test_cada_aviso_tiene_texto_en_los_tres_idiomas_y_sin_datos() -> None:
    from app.modules.notifications import textos

    for tipo in avisos.TIPOS:
        assert set(textos.TEXTOS[tipo]) == {"es", "en", "pt"}, tipo
        for titulo, cuerpo in textos.TEXTOS[tipo].values():
            assert titulo and cuerpo and "{" not in cuerpo


def test_la_vista_publica_solo_existe_para_un_prestador_activo() -> None:
    prestador = ServiceProvider(
        id=str(uuid.uuid4()), profile_id=PRESTADORA, provider_type="company",
        display_name="Taller Andino", legal_name="Taller Andino S.A.C.", tax_id="20123456789",
        representative_name="Ana", country_code="PE", status="pending",
    )
    assert schemas.PrestadorPublicoRead.desde(prestador) is None
    prestador.status = PRESTADOR_ACTIVO
    assert schemas.PrestadorPublicoRead.desde(prestador).model_dump() == {
        "id": prestador.id, "provider_type": "company", "display_name": "Taller Andino", "country_code": "PE",
    }


def test_las_salidas_no_llevan_rutas_ni_numeros_completos() -> None:
    for salida in (
        schemas.DocumentoPrivadoRead, schemas.DocumentoAdminRead, schemas.SolicitudPrivadaRead,
        schemas.SolicitudAdminRead, schemas.CredencialPrivadaRead, schemas.CredencialAdminRead,
        schemas.EnvioRead,
    ):
        assert "storage_path" not in salida.model_fields and "number" not in salida.model_fields
    privada = set(schemas.SolicitudPrivadaRead.model_fields)
    assert not privada & {"internal_notes", "decided_by", "terms_sha256", "approval_blockers"}
    assert not set(schemas.EventoVisibleRead.model_fields) & {"internal_note", "actor_id"}


@pytest.mark.asyncio
async def test_permisos_conceptuales(entorno) -> None:
    _, _, sesiones, _ = entorno
    async with sesiones() as db:
        assert await permissions.funcion_de(db, JEFA) == "admin"
        assert await permissions.funcion_de(db, MODERADOR) == "reviewer"
        assert await permissions.funcion_de(db, OTRA) is None
    with pytest.raises(permissions.EsTuPropiaAdmision):
        permissions.exigir_ajena(dueno_del_expediente=JEFA, user_id=JEFA)
    assert permissions.ROLES_QUE_DECIDEN == {"admin"}
    assert permissions.ROLES_QUE_REVISAN == {"admin", "moderator"}


@pytest.mark.asyncio
async def test_una_credencial_vencida_no_se_verifica_y_no_cuenta(entorno, encendida, almacen) -> None:
    http, quien, _, _ = entorno
    await _publicar(http, quien)
    await _listo_para_enviar(http, quien)
    evidencia = (await _documento(http, kind="professional_license", datos=PDF, nombre="l.pdf", tipo="application/pdf")).json()
    doc = [d for d in evidencia["documents"] if d["kind"] == "professional_license"][0]["id"]
    r = await http.post(f"{MIA}/credentials", json={
        "kind": "professional_license", "title": "Licencia", "issuer": "Ministerio",
        "issued_on": "2020-01-01", "expires_on": str(date.today() - timedelta(days=1)),
        "evidence_document_id": doc,
    })
    [credencial] = r.json()["credentials"]
    assert credencial["display_status"] == "expired"
    r = await http.post(f"{MIA}/credentials", json={
        "kind": "certification", "title": "Curso", "issuer": "Instituto",
        "issued_on": "2024-01-01", "expires_on": "2023-01-01",
    })
    assert r.status_code == 422
    await http.post(f"{MIA}/submit", json={"declare_truthfulness": True})
    _como(quien, MODERADOR)
    solicitud = (await http.get(BANDEJA)).json()["items"][0]["id"]
    await http.post(f"{BANDEJA}/{solicitud}/start-review", json={})
    r = await http.post(f"{BANDEJA}/{solicitud}/credentials/{credencial['id']}/verify")
    assert r.status_code == 422 and _codigo(r) == "service_credential_expired"
    r = await http.post(f"{BANDEJA}/{solicitud}/credentials/{credencial['id']}/observe", json={"note": "  "})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_una_aprobada_que_vuelve_a_revision_no_se_retira(entorno, encendida, almacen) -> None:
    """Retirarse es ANTES de la decisión. Una aprobada que se suspende y vuelve
    a revisión está en `under_review`, pero retirarla sería escapar de la
    investigación: 409 y el botón no aparece."""
    http, quien, _, _ = entorno
    await _publicar(http, quien)
    solicitud = await _aprobada(http, quien)
    _como(quien, JEFA)
    await http.post(f"{BANDEJA}/{solicitud}/suspend", json={"message": "Reclamo en curso."})
    await http.post(f"{BANDEJA}/{solicitud}/start-review", json={})
    _como(quien, PRESTADORA)
    vista = (await http.get(MIA)).json()
    assert vista["status"] == "under_review" and vista["can_withdraw"] is False
    r = await http.post(f"{MIA}/withdraw", json={"confirm": True, "reason": "Me voy."})
    assert r.status_code == 409 and _codigo(r) == "service_application_already_decided"
    assert (await http.get(MIA)).json()["status"] == "under_review"
    # Ni devuelta con correcciones tras la suspensión.
    _como(quien, MODERADOR)
    await http.post(f"{BANDEJA}/{solicitud}/request-changes", json={"message": "Aclara el reclamo."})
    _como(quien, PRESTADORA)
    assert (await http.get(MIA)).json()["can_withdraw"] is False
    r = await http.post(f"{MIA}/withdraw", json={"confirm": True})
    assert r.status_code == 409 and _codigo(r) == "service_application_already_decided"


# =========================================================================== #
# Hallazgos de la revisión independiente (29/09/2026), reproducidos aquí
# =========================================================================== #
async def _con_credencial_respaldada(http, quien) -> tuple[str, str]:
    """(documento de evidencia, credencial declarada con él)."""
    await _publicar(http, quien)
    await _listo_para_enviar(http, quien)
    r = await _documento(http, kind="professional_license", datos=PDF, nombre="lic.pdf", tipo="application/pdf")
    evidencia = next(d["id"] for d in r.json()["documents"] if d["kind"] == "professional_license")
    r = await http.post(
        f"{MIA}/credentials",
        json={"kind": "professional_license", "title": "Licencia", "issuer": "Colegio", "number": "ABC12345",
              "evidence_document_id": evidencia},
        headers={"Idempotency-Key": "credencial-respaldada-1"},
    )
    assert r.status_code == 201, r.text
    return evidencia, r.json()["credentials"][0]["id"]


@pytest.mark.asyncio
async def test_H1_la_evidencia_de_una_credencial_no_se_retira(entorno, encendida, almacen) -> None:
    """Retirar el documento que respalda una credencial dejaba verificarla sin
    evidencia (y el archivo borrado). Ahora no se retira: se cambia la
    evidencia o se quita la credencial antes."""
    http, quien, sesiones, _ = entorno
    evidencia, credencial = await _con_credencial_respaldada(http, quien)
    vista = (await http.get(MIA)).json()
    assert next(d for d in vista["documents"] if d["id"] == evidencia)["can_remove"] is False
    r = await http.delete(f"{MIA}/documents/{evidencia}")
    assert r.status_code == 409 and _codigo(r) == "service_document_in_use"
    assert not almacen.borrados
    # Quitada la credencial, el documento ya se puede retirar.
    assert (await http.delete(f"{MIA}/credentials/{credencial}")).status_code == 200
    assert (await http.delete(f"{MIA}/documents/{evidencia}")).status_code == 200


@pytest.mark.asyncio
async def test_H1_reemplazar_la_evidencia_mueve_la_credencial_al_nuevo(entorno, encendida, almacen) -> None:
    http, quien, sesiones, _ = entorno
    evidencia, credencial = await _con_credencial_respaldada(http, quien)
    r = await http.post(
        f"{MIA}/documents/{evidencia}/replace", files={"file": ("lic2.pdf", PDF + b"%v2", "application/pdf")}
    )
    assert r.status_code == 200, r.text
    nuevo = next(d["id"] for d in r.json()["documents"] if d["kind"] == "professional_license")
    assert r.json()["credentials"][0]["evidence_document_id"] == nuevo != evidencia
    assert "credential_evidence" not in r.json()["missing"]


@pytest.mark.asyncio
async def test_H1_sin_evidencia_activa_ni_se_envia_ni_se_verifica(entorno, encendida, almacen) -> None:
    """Defensa en profundidad: si la evidencia ya no está activa (por cualquier
    camino), enviar pide evidencia y verificar se niega."""
    from datetime import datetime, timezone

    http, quien, sesiones, _ = entorno
    evidencia, credencial = await _con_credencial_respaldada(http, quien)

    async def ciclo(valor: str) -> None:
        async with sesiones() as db:
            doc = await db.get(ServiceProviderDocument, evidencia)
            doc.lifecycle = valor
            doc.lifecycle_changed_at = None if valor == "active" else datetime.now(timezone.utc)
            await db.commit()

    await ciclo("removed")
    vista = (await http.get(MIA)).json()
    assert "credential_evidence" in vista["missing"] and vista["can_submit"] is False
    r = await http.post(f"{MIA}/submit", json={"declare_truthfulness": True})
    assert r.status_code == 422 and "credential_evidence" in r.json()["error"]["details"]["missing"]

    # Y aunque llegara a revisión, verificar la exige disponible.
    await ciclo("active")
    assert (await http.post(f"{MIA}/submit", json={"declare_truthfulness": True})).status_code == 200
    _como(quien, MODERADOR)
    solicitud = (await http.get(BANDEJA)).json()["items"][0]["id"]
    await http.post(f"{BANDEJA}/{solicitud}/start-review", json={})
    await ciclo("removed")
    r = await http.post(f"{BANDEJA}/{solicitud}/credentials/{credencial}/verify")
    assert r.status_code == 422 and _codigo(r) == "service_credential_evidence_required"


@pytest.mark.asyncio
async def test_M1_vaciar_el_resumen_tras_enviar_es_422_y_no_500(entorno, encendida, almacen) -> None:
    http, quien, _, _ = entorno
    await _publicar(http, quien)
    solicitud = await _en_revision(http, quien)
    await http.post(f"{BANDEJA}/{solicitud}/request-changes", json={"message": "Amplía el resumen."})
    _como(quien, PRESTADORA)
    r = await http.patch(MIA, json={"summary": None})
    assert r.status_code == 422 and _codigo(r) == "service_application_field_required"
    assert r.json()["error"]["details"]["fields"] == ["summary"]
    # En borrador sí se puede vaciar.
    _como(quien, OTRA)
    await http.post(MIA, json={"provider_type": "individual", "display_name": "Olga"})
    await http.patch(MIA, json={"summary": RESUMEN})
    assert (await http.patch(MIA, json={"summary": None})).status_code == 200


@pytest.mark.asyncio
async def test_L1_un_fallo_de_red_del_almacenamiento_es_503(entorno, encendida, almacen, monkeypatch) -> None:
    import httpx

    from app.shared import storage

    http, quien, _, _ = entorno
    await http.post(MIA, json={"provider_type": "individual", "display_name": "Ana"})

    async def sin_red(*a, **k):
        raise httpx.ConnectTimeout("sin red")

    monkeypatch.setattr(storage, "subir_objeto", sin_red)
    r = await _documento(http)
    assert r.status_code == 503 and _codigo(r) == "service_storage_failed"
    monkeypatch.setattr(storage, "subir_objeto", almacen.subir)
    documento = (await _documento(http)).json()["documents"][0]["id"]
    monkeypatch.setattr(storage, "firmar_objetos", sin_red)
    r = await http.post(f"{MIA}/documents/{documento}/view")
    assert r.status_code == 503 and _codigo(r) == "service_storage_failed"


@pytest.mark.asyncio
async def test_L2_si_algo_falla_tras_subir_el_archivo_se_borra(entorno, encendida, almacen, monkeypatch) -> None:
    from app.modules.gobernanza import auditoria

    http, quien, sesiones, _ = entorno
    await http.post(MIA, json={"provider_type": "individual", "display_name": "Ana"})
    original = auditoria.anotar

    async def falla(db, **kw):
        if kw.get("action") in ("service_document.uploaded", "service_document.replaced"):
            raise RuntimeError("fallo simulado de la auditoría")
        return await original(db, **kw)

    monkeypatch.setattr(auditoria, "anotar", falla)
    with pytest.raises(RuntimeError):
        await _documento(http)
    async with sesiones() as db:
        assert not list(await db.scalars(select(ServiceProviderDocument)))
    assert almacen.objetos == {} and len(almacen.borrados) == 1


@pytest.mark.asyncio
async def test_L4_quien_revisa_y_postula_no_lee_las_notas_internas_de_la_suya(entorno, encendida, almacen) -> None:
    http, quien, _, _ = entorno
    await _publicar(http, quien)
    solicitud = (await _enviada(http, quien, uid=MODERADOR))["id"]
    _como(quien, JEFA)
    await http.post(f"{BANDEJA}/{solicitud}/start-review", json={"internal_note": "NOTA-SOBRE-MODE"})
    _como(quien, MODERADOR)
    detalle = await http.get(f"{BANDEJA}/{solicitud}")
    assert detalle.json()["is_own"] is True
    assert "NOTA-SOBRE-MODE" not in detalle.text
    historial = await http.get(f"{BANDEJA}/{solicitud}/history")
    assert historial.status_code == 200 and "NOTA-SOBRE-MODE" not in historial.text
    # Quien no es el dueño sí las lee.
    _como(quien, JEFA)
    assert "NOTA-SOBRE-MODE" in (await http.get(f"{BANDEJA}/{solicitud}/history")).text


@pytest.mark.asyncio
async def test_L5_volver_a_postular_mira_la_politica_de_su_categoria(entorno, encendida, almacen) -> None:
    http, quien, _, _ = entorno
    _como(quien, JEFA)
    r = await http.post(
        f"{ADMIN}/policies/provider-terms/draft",
        json={"country_code": "PE", "category": "musica", "title": "Condiciones música", "body": TEXTO,
              "parameters": {"reapplication_after_rejection": "allowed"}},
    )
    await http.post(f"{ADMIN}/policies/{r.json()['id']}/publish")
    _como(quien, PRESTADORA)
    await http.post(MIA, json={"provider_type": "individual", "display_name": "Ana Guitarra"})
    await http.patch(MIA, json={
        "legal_name": "Ana María Quispe", "country_code": "PE", "summary": RESUMEN, "requested_category": "musica",
    })
    await _documento(http)
    terminos = (await http.get(TERMINOS)).json()
    await http.post(f"{MIA}/terms", json={"terms_policy_id": terminos["policy_id"], "terms_sha256": terminos["sha256"]})
    r = await http.post(f"{MIA}/submit", json={"declare_truthfulness": True})
    assert r.status_code == 200, r.text
    solicitud = r.json()["id"]
    _como(quien, MODERADOR)
    await http.post(f"{BANDEJA}/{solicitud}/start-review", json={})
    _como(quien, JEFA)
    assert (await http.post(f"{BANDEJA}/{solicitud}/reject", json={"message": "No cumple."})).status_code == 200
    _como(quien, PRESTADORA)
    r = await http.post(MIA, json={"provider_type": "individual", "display_name": "Ana"})
    assert r.status_code == 201, r.text


@pytest.mark.asyncio
async def test_L7_los_reemplazos_tienen_tope(entorno, encendida, almacen) -> None:
    from app.modules.services import documentos

    http, quien, _, _ = entorno
    await http.post(MIA, json={"provider_type": "individual", "display_name": "Ana"})
    documento = (await _documento(http)).json()["documents"][0]["id"]
    ultimo = None
    for i in range(80):
        r = await http.post(
            f"{MIA}/documents/{documento}/replace",
            files={"file": ("x.pdf", PDF + str(i).encode(), "application/pdf")},
        )
        ultimo = r
        if r.status_code != 200:
            break
        documento = r.json()["documents"][0]["id"]
    assert ultimo.status_code == 422 and _codigo(ultimo) == "service_document_too_many"
    assert len(almacen.objetos) == getattr(documentos, "MAXIMO_POR_POSTULACION", -1)
