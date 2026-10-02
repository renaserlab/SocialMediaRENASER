"""El recorrido integral del catálogo, de principio a fin, con la API real.

Contra PostgreSQL local desechable (0001–0090), el Storage en memoria y
`FEATURE_SERVICES` encendida SOLO aquí. UN servicio pasa por todo, en orden:

  admisión real → categoría → servicio → los 21 requisitos → imágenes →
  envío → revisión → cambios pedidos → corrección → reenvío → aprobación →
  publicación → ficha pública → versión nueva (la anterior sigue pública) →
  publicación de la nueva (la anterior pasa a superada) → suspensión (fuera
  del público) → reactivación → retiro definitivo.

Y en cada etapa, qué pueden y qué no pueden hacer los cinco: la prestadora
dueña, otro prestador, moderación, administración y el público.
"""

from __future__ import annotations

import json
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.modules.services import catalogo
from app.modules.services.catalogo_models import Service, ServiceVersion
from app.modules.services.catalogo_requisitos import CODIGOS
from app.modules.services.models import ServiceProvider
from tests import test_baja_de_cuenta_postgres as baja_pg
from tests.test_baja_de_cuenta_postgres import SIN_POSTGRES, _cliente, _filas, _llevar, _persona, _sembrar, _uno
from tests.test_servicios_catalogo_api import (
    ADMIN,
    BANDEJA,
    CATEGORIAS,
    CONTENIDO,
    FICHA,
    MIOS,
    PNG_AZUL,
    PNG_VERDE,
    _prestador,
)

pytestmark = [SIN_POSTGRES, pytest.mark.asyncio]

base_aplicada = baja_pg.base_aplicada
entorno = baja_pg.entorno


async def _pedir(app, uid: str, metodo: str, ruta: str, cuerpo=None, **kw):
    async with _cliente(app, uid) as http:
        return await http.request(metodo, ruta, json=cuerpo, **kw)


def _error(r) -> str | None:
    try:
        return (r.json().get("error") or {}).get("code")
    except ValueError:
        return None


async def _espera(app, uid: str, metodo: str, ruta: str, estado: int, codigo: str | None = None, cuerpo=None):
    r = await _pedir(app, uid, metodo, ruta, cuerpo)
    assert r.status_code == estado, (uid, metodo, ruta, r.status_code, r.text)
    if codigo:
        assert _error(r) == codigo, (ruta, r.text)
    return r


async def _negado(app, uid: str, metodo: str, ruta: str, cuerpo=None) -> None:
    """Quien no es prestador no llega al servicio de otro: 404 (lo ajeno) o
    403 (no tiene catálogo), nunca una respuesta con datos."""
    r = await _pedir(app, uid, metodo, ruta, cuerpo)
    assert (r.status_code, _error(r)) in ((404, "service_not_found"), (403, "service_provider_not_active")), (
        uid, metodo, ruta, r.status_code, r.text)


async def _estados(motor, servicio: str) -> tuple[str, list[tuple[int, str]]]:
    estado = await _uno(motor, "select status from public.services where id = cast(:s as uuid)", s=servicio)
    versiones = await _filas(
        motor, "select version, status from public.service_versions where service_id = cast(:s as uuid) order by 1",
        s=servicio,
    )
    return estado, versiones


async def test_recorrido_integral_con_los_cinco_actores(entorno, monkeypatch) -> None:
    app, motor, almacen = entorno
    ajustes = get_settings()
    jefa, moderador = await _persona(motor, "admin"), await _persona(motor, "moderator")
    ana = await _persona(motor)
    otro = await _prestador(motor)          # otro prestador, activo
    publico = await _persona(motor)         # una cuenta cualquiera, sin prestador ni rol

    # ------------------------------------------------------------------ #
    # 1. Prestadora aprobada POR LA ADMISIÓN REAL del Incremento 1
    # ------------------------------------------------------------------ #
    await _llevar(app, ana, "approved", jefa=jefa, moderador=moderador)
    assert await _uno(
        motor, "select status from public.service_providers where profile_id = cast(:u as uuid)", u=ana
    ) == "active"

    # ------------------------------------------------------------------ #
    # 2. La categoría: solo administración la crea
    # ------------------------------------------------------------------ #
    alta = {"slug": f"asesoria-{uuid.uuid4().hex[:8]}", "name": "Asesoría contable"}
    for quien in (moderador, ana, otro, publico):
        await _espera(app, quien, "POST", f"{ADMIN}/categories", 403, cuerpo=alta)
    categoria = (await _espera(app, jefa, "POST", f"{ADMIN}/categories", 201, cuerpo=alta)).json()
    ofrecidas = (await _espera(app, ana, "GET", CATEGORIAS, 200)).json()
    assert categoria["id"] in {c["id"] for c in ofrecidas}

    # ------------------------------------------------------------------ #
    # 3. El servicio: solo un prestador activo lo crea
    # ------------------------------------------------------------------ #
    for quien in (publico, moderador, jefa):
        await _espera(app, quien, "POST", MIOS, 403, "service_provider_not_active", {"category_id": categoria["id"]})
    clave = f"crear-{uuid.uuid4().hex}"
    r = await _pedir(app, ana, "POST", MIOS, {"category_id": categoria["id"]}, headers={"Idempotency-Key": clave})
    assert r.status_code == 201, r.text
    creado = r.json()
    ident = creado["id"]
    mio = f"{MIOS}/{ident}"
    # Repetir con la misma clave no crea otro.
    r = await _pedir(app, ana, "POST", MIOS, {"category_id": categoria["id"]}, headers={"Idempotency-Key": clave})
    assert r.status_code == 200 and r.json()["id"] == ident

    # Lo ajeno es 404 para otro prestador; quien no es prestador no tiene catálogo.
    for metodo, ruta, cuerpo in (
        ("GET", mio, None), ("PATCH", f"{mio}/draft", {"title": "Me lo quedo"}),
        ("POST", f"{mio}/draft/submit", {}), ("GET", f"{mio}/history", None),
        ("GET", f"{mio}/draft/requirements", None),
    ):
        await _espera(app, otro, metodo, ruta, 404, "service_not_found", cuerpo)
        for quien in (publico, moderador, jefa):
            await _negado(app, quien, metodo, ruta, cuerpo)
    # El equipo lo ve por administración; los demás no.
    await _espera(app, moderador, "GET", f"{BANDEJA}/{ident}", 200)
    for quien in (ana, otro, publico):
        await _espera(app, quien, "GET", f"{BANDEJA}/{ident}", 403)
    for quien in (ana, otro, publico, moderador, jefa):
        await _espera(app, quien, "GET", f"{FICHA}/{ident}", 404, "service_not_found")

    # ------------------------------------------------------------------ #
    # 4. LOS 21 REQUISITOS: cada código sale y se resuelve
    # ------------------------------------------------------------------ #
    vistos: set[str] = set()

    async def editar(**cambios) -> list[str]:
        r = await _espera(app, ana, "PATCH", f"{mio}/draft", 200, cuerpo=cambios)
        faltan = r.json()["missing"]
        vistos.update(faltan)
        return faltan

    async def que_falta() -> list[str]:
        faltan = (await _espera(app, ana, "GET", f"{mio}/draft/requirements", 200)).json()["missing"]
        vistos.update(faltan)
        return faltan

    inicial = await que_falta()
    assert inicial == creado["missing"]
    assert set(inicial) == {"title", "summary", "description", "modality", "duration", "price_model", "scope",
                            "includes", "excludes", "requirements", "cover_image"}, inicial
    # Enviar así: 422 con lo que falta, y nada cambia.
    r = await _espera(app, ana, "POST", f"{mio}/draft/submit", 422, "service_catalog_incomplete", {})
    assert r.json()["error"]["details"]["missing"] == inicial

    # Categoría inactiva, y de vuelta.
    await _espera(app, jefa, "POST", f"{ADMIN}/categories/{categoria['id']}/deactivate", 200)
    assert "category_inactive" in await que_falta()
    await _espera(app, jefa, "POST", f"{ADMIN}/categories/{categoria['id']}/activate", 200)
    assert "category_inactive" not in await que_falta()

    # Prestador que deja de estar activo: la API le cierra la puerta (403) y
    # el dominio lo nombra; de vuelta a activo, desaparece.
    await _sembrar(motor, "update public.service_providers set status = 'suspended', suspended_at = now() "
                          "where profile_id = cast(:u as uuid)", u=ana)
    await _espera(app, ana, "PATCH", f"{mio}/draft", 403, "service_provider_not_active", {"title": "Otro"})
    async with AsyncSession(motor, expire_on_commit=False) as db:
        servicio = await db.get(Service, ident)
        version = await db.get(ServiceVersion, creado["open_version"]["id"])
        prestador = await db.get(ServiceProvider, servicio.provider_id)
        dominio = await catalogo.faltantes_de(db, servicio, version, prestador)
    assert "provider_not_active" in dominio
    vistos.update(dominio)
    await _sembrar(motor, "update public.service_providers set status = 'active', suspended_at = null "
                          "where profile_id = cast(:u as uuid)", u=ana)

    await editar(title=CONTENIDO["title"], summary=CONTENIDO["summary"], description=CONTENIDO["description"])
    # Modalidad: lo que Z no ofrece no entra en el borrador (P5); un borrador
    # que ya la tenía lo dice al enviar; presencial sin zona; y virtual.
    await _espera(app, ana, "PATCH", f"{mio}/draft", 422, "service_modality_not_allowed", {"modality": "at_home"})
    await editar(modality="virtual")
    monkeypatch.setattr(ajustes, "services_catalog_modalities", "in_person")
    assert "modality_not_allowed" in await que_falta()
    monkeypatch.setattr(ajustes, "services_catalog_modalities", "virtual,in_person")
    assert "location_area" in await editar(modality="in_person")
    assert "location_area" not in await editar(location_area="Miraflores, Lima")
    # Duración: fuera del rango configurado, y dentro.
    monkeypatch.setattr(ajustes, "services_catalog_min_duration_minutes", 30)
    assert "duration_out_of_range" in await editar(duration_minutes=20)
    assert "duration_out_of_range" not in await editar(duration_minutes=50)
    monkeypatch.setattr(ajustes, "services_catalog_min_duration_minutes", 5)
    # Precio: modelo no permitido, sin importe, sin moneda, moneda no permitida.
    monkeypatch.setattr(ajustes, "services_catalog_price_models", "fixed")
    assert "price_model_not_allowed" in await editar(price_model="on_request")
    monkeypatch.setattr(ajustes, "services_catalog_price_models", "free,fixed,from,on_request")
    faltan = await editar(price_model="fixed")
    assert "price" in faltan and "currency" in faltan
    # Una moneda que Z no admite no entra en el borrador (P2); un borrador que
    # ya la tenía lo dice al enviar.
    await _espera(app, ana, "PATCH", f"{mio}/draft", 422, "service_currency_not_allowed",
                  {"price_minor": 12000, "currency": "USD"})
    monkeypatch.setattr(ajustes, "services_catalog_currencies", "PEN,USD")
    await editar(price_minor=12000, currency="USD")
    monkeypatch.setattr(ajustes, "services_catalog_currencies", "PEN")
    assert "currency_not_allowed" in await que_falta()
    faltan = await editar(currency="PEN")
    assert not {"price", "currency", "currency_not_allowed", "price_model"} & set(faltan)
    await editar(scope=CONTENIDO["scope"], includes=CONTENIDO["includes"], excludes=CONTENIDO["excludes"],
                 requirements=CONTENIDO["requirements"])
    assert await que_falta() == ["cover_image"]

    # ------------------------------------------------------------------ #
    # 5. Imágenes: la primera es la portada; orden; demasiadas
    # ------------------------------------------------------------------ #
    async def subir(datos: bytes, alt: str) -> dict:
        async with _cliente(app, ana) as http:
            r = await http.post(f"{mio}/draft/images", data={"alt_text": alt},
                                files={"file": ("foto.png", datos, "image/png")})
        assert r.status_code == 201, r.text
        vistos.update(r.json()["missing"])
        return r.json()

    async with _cliente(app, otro) as http:
        r = await http.post(f"{mio}/draft/images", data={"alt_text": "Ajena"},
                            files={"file": ("foto.png", PNG_VERDE, "image/png")})
    assert r.status_code == 404
    primera = (await subir(PNG_VERDE, "Escritorio con facturas"))["open_version"]["images"]
    assert primera[0]["is_cover"]
    imagenes = (await subir(PNG_AZUL, "Contador revisando cuentas"))["open_version"]["images"]
    a, b = imagenes[0]["id"], imagenes[1]["id"]
    assert all("/object/sign/" in i["url"] and "storage_path" not in i for i in imagenes)
    r = await _espera(app, ana, "PUT", f"{mio}/draft/images/order", 200, cuerpo={"image_ids": [b, a], "cover_id": b})
    assert [i["id"] for i in r.json()["open_version"]["images"]] == [b, a]
    monkeypatch.setattr(ajustes, "services_catalog_max_images", 1)
    assert "too_many_images" in await que_falta()
    monkeypatch.setattr(ajustes, "services_catalog_max_images", 8)
    assert await que_falta() == []
    assert len(almacen.de("service-media", ident)) == 2
    # LOS 21, todos vistos, y ninguno fuera de la lista estable.
    assert vistos == set(CODIGOS), sorted(set(CODIGOS) ^ vistos)
    assert len(CODIGOS) == 21

    # ------------------------------------------------------------------ #
    # 6. Envío
    # ------------------------------------------------------------------ #
    for quien in (otro,):
        await _espera(app, quien, "POST", f"{mio}/draft/submit", 404, "service_not_found", {})
    enviado = (await _espera(app, ana, "POST", f"{mio}/draft/submit", 200, cuerpo={})).json()
    v1 = enviado["open_version"]
    assert v1["status"] == "submitted" and not enviado["can_edit"]
    await _espera(app, ana, "PATCH", f"{mio}/draft", 409, "service_version_pending", {"title": "Otro título"})
    base = f"{BANDEJA}/{ident}/versions/{v1['id']}"

    # ------------------------------------------------------------------ #
    # 7. Revisión: moderación o administración; nadie más
    # ------------------------------------------------------------------ #
    for quien in (ana, otro, publico):
        await _espera(app, quien, "POST", f"{base}/start-review", 403, cuerpo={})
    await _espera(app, moderador, "POST", f"{base}/start-review", 200,
                  cuerpo={"internal_note": "Nota interna del equipo"})

    # ------------------------------------------------------------------ #
    # 8. Cambios pedidos, con motivo visible y campos señalados
    # ------------------------------------------------------------------ #
    await _espera(app, moderador, "POST", f"{base}/request-changes", 422, cuerpo={"note": ""})
    for quien in (ana, otro, publico):
        await _espera(app, quien, "POST", f"{base}/request-changes", 403, cuerpo={"note": "Aclara el plan."})
    await _espera(app, moderador, "POST", f"{base}/request-changes", 200,
                  cuerpo={"note": "Aclara qué incluye el plan mensual.", "fields": ["includes", "price"],
                          "internal_note": "Otra nota interna"})
    propio = (await _espera(app, ana, "GET", mio, 200)).json()
    assert propio["last_observation"]["note"] == "Aclara qué incluye el plan mensual."
    assert propio["last_observation"]["fields"] == ["includes", "price"]
    assert propio["title"] == CONTENIDO["title"] and propio["last_version_status"] == "changes_requested"
    historial = (await _espera(app, ana, "GET", f"{mio}/history", 200)).json()
    assert "Nota interna" not in json.dumps(propio) + json.dumps(historial)
    assert [e["action"] for e in historial] == ["created", "submitted", "review_started", "changes_requested"]

    # ------------------------------------------------------------------ #
    # 9–10. Corregir en una versión nueva y reenviar
    # ------------------------------------------------------------------ #
    await _espera(app, otro, "POST", f"{mio}/draft", 404, "service_not_found")
    v2 = (await _espera(app, ana, "POST", f"{mio}/draft", 201)).json()["open_version"]
    assert v2["version"] == 2 and v2["based_on_version"] == 1 and len(v2["images"]) == 2
    assert await editar(includes=["Revisión de facturas", "Plan mensual con fechas de pago"]) == []
    await _espera(app, ana, "POST", f"{mio}/draft/submit", 200, cuerpo={})
    assert await _uno(
        motor, "select action from public.service_events where version_id = cast(:v as uuid) "
               "and action in ('submitted', 'resubmitted')", v=v2["id"],
    ) == "resubmitted"
    base = f"{BANDEJA}/{ident}/versions/{v2['id']}"
    detalle = (await _espera(app, jefa, "GET", f"{BANDEJA}/{ident}", 200)).json()
    assert detalle["proposed_version"]["version"] == 2

    # ------------------------------------------------------------------ #
    # 11. Aprobar: solo administración
    # ------------------------------------------------------------------ #
    await _espera(app, jefa, "POST", f"{base}/start-review", 200, cuerpo={})
    await _espera(app, moderador, "POST", f"{base}/approve", 403, "service_decision_forbidden", {})
    for quien in (ana, otro, publico):
        await _espera(app, quien, "POST", f"{base}/approve", 403, cuerpo={})
    await _espera(app, jefa, "POST", f"{base}/approve", 200, cuerpo={})
    for quien in (ana, publico):
        await _espera(app, quien, "GET", f"{FICHA}/{ident}", 404, "service_not_found")  # aprobado no es publicado

    # ------------------------------------------------------------------ #
    # 12. Publicar: solo administración
    # ------------------------------------------------------------------ #
    await _espera(app, moderador, "POST", f"{base}/publish", 403, "service_decision_forbidden", {})
    for quien in (ana, otro, publico):
        await _espera(app, quien, "POST", f"{base}/publish", 403, cuerpo={})
    r = await _espera(app, jefa, "POST", f"{base}/publish", 200, cuerpo={})
    assert r.json()["status"] == "published" and r.json()["publicly_visible"]
    assert await _estados(motor, ident) == ("published", [(1, "changes_requested"), (2, "published")])

    # ------------------------------------------------------------------ #
    # 13. La ficha pública: la ve cualquiera, sin nada interno
    # ------------------------------------------------------------------ #
    for quien in (publico, otro, ana, moderador, jefa):
        ficha = (await _espera(app, quien, "GET", f"{FICHA}/{ident}", 200)).json()
        assert ficha["title"] == CONTENIDO["title"]
        assert ficha["includes"] == ["Revisión de facturas", "Plan mensual con fechas de pago"]
        assert ficha["price"] == {"model": "fixed", "amount_minor": 12000, "currency": "PEN"}
        assert ficha["location_area"] == "Miraflores, Lima" and ficha["modality"] == "in_person"
        assert ficha["images"][0]["is_cover"] and "/object/sign/" in ficha["images"][0]["url"]
        crudo = json.dumps({**ficha, "images": [{**i, "url": None} for i in ficha["images"]]})
        for prohibido in ("internal_note", "Nota interna", "storage_path", "profile_id", ana):
            assert prohibido not in crudo, prohibido

    # ------------------------------------------------------------------ #
    # 14. Una versión nueva: la anterior sigue siendo la pública
    # ------------------------------------------------------------------ #
    v3 = (await _espera(app, ana, "POST", f"{mio}/draft", 201)).json()["open_version"]
    assert v3["version"] == 3 and v3["based_on_version"] == 2
    await editar(title="Diagnóstico contable y plan de ahorro")
    assert (await _espera(app, publico, "GET", f"{FICHA}/{ident}", 200)).json()["title"] == CONTENIDO["title"]
    await _espera(app, ana, "POST", f"{mio}/draft/submit", 200, cuerpo={})
    base = f"{BANDEJA}/{ident}/versions/{v3['id']}"
    detalle = (await _espera(app, moderador, "GET", f"{BANDEJA}/{ident}", 200)).json()
    assert detalle["changed_fields"] == ["title"]
    assert detalle["published_version"]["version"] == 2 and detalle["proposed_version"]["version"] == 3
    await _espera(app, moderador, "POST", f"{base}/start-review", 200, cuerpo={})
    await _espera(app, jefa, "POST", f"{base}/approve", 200, cuerpo={})
    assert (await _espera(app, publico, "GET", f"{FICHA}/{ident}", 200)).json()["title"] == CONTENIDO["title"]
    assert await _estados(motor, ident) == (
        "published", [(1, "changes_requested"), (2, "published"), (3, "approved")]
    )

    # ------------------------------------------------------------------ #
    # 15. Publicar la nueva: la anterior pasa a superada
    # ------------------------------------------------------------------ #
    await _espera(app, jefa, "POST", f"{base}/publish", 200, cuerpo={})
    assert await _estados(motor, ident) == (
        "published", [(1, "changes_requested"), (2, "superseded"), (3, "published")]
    )
    ficha = (await _espera(app, publico, "GET", f"{FICHA}/{ident}", 200)).json()
    assert ficha["title"] == "Diagnóstico contable y plan de ahorro"
    # Los archivos de la versión superada siguen (la publicada usa la misma ruta).
    assert len(almacen.de("service-media", ident)) == 2

    # ------------------------------------------------------------------ #
    # 16. Suspender: desaparece del público
    # ------------------------------------------------------------------ #
    motivo = {"note": "Reclamo en revisión."}
    await _espera(app, jefa, "POST", f"{BANDEJA}/{ident}/suspend", 422, cuerpo={"note": ""})
    for quien in (moderador, ana, otro, publico):
        await _espera(app, quien, "POST", f"{BANDEJA}/{ident}/suspend", 403, cuerpo=motivo)
    r = await _espera(app, jefa, "POST", f"{BANDEJA}/{ident}/suspend", 200, cuerpo=motivo)
    assert r.json()["status"] == "suspended" and not r.json()["publicly_visible"]
    for quien in (publico, otro, ana, moderador, jefa):
        await _espera(app, quien, "GET", f"{FICHA}/{ident}", 404, "service_not_found")
    propio = (await _espera(app, ana, "GET", mio, 200)).json()
    assert propio["status"] == "suspended" and propio["last_observation"]["note"] == "Reclamo en revisión."
    assert propio["published_version"]["version"] == 3  # suspender no borra nada

    # ------------------------------------------------------------------ #
    # 17. Reactivar: vuelve
    # ------------------------------------------------------------------ #
    for quien in (moderador, ana, otro, publico):
        await _espera(app, quien, "POST", f"{BANDEJA}/{ident}/reinstate", 403, cuerpo={"note": "Resuelto."})
    await _espera(app, jefa, "POST", f"{BANDEJA}/{ident}/reinstate", 200, cuerpo={"note": "Reclamo resuelto."})
    assert (await _espera(app, publico, "GET", f"{FICHA}/{ident}", 200)).json()["title"].startswith("Diagnóstico")

    # ------------------------------------------------------------------ #
    # 18. Retirar: definitivo
    # ------------------------------------------------------------------ #
    for quien in (moderador, ana, otro, publico):
        await _espera(app, quien, "POST", f"{BANDEJA}/{ident}/retire", 403, cuerpo={"note": "Ya no se ofrece."})
    r = await _espera(app, jefa, "POST", f"{BANDEJA}/{ident}/retire", 200, cuerpo={"note": "Ya no se ofrece."})
    assert r.json()["status"] == "retired" and r.json()["actions"] == []
    for quien in (publico, otro, ana, moderador, jefa):
        await _espera(app, quien, "GET", f"{FICHA}/{ident}", 404, "service_not_found")
    # Nadie lo devuelve: ni reactivar, ni suspender, ni retirar otra vez, ni un borrador nuevo.
    for paso in ("reinstate", "suspend", "retire"):
        await _espera(app, jefa, "POST", f"{BANDEJA}/{ident}/{paso}", 409, "service_catalog_transition_invalid",
                      {"note": "Intento de volver atrás."})
    await _espera(app, ana, "POST", f"{mio}/draft", 409, "service_retired")
    propio = (await _espera(app, ana, "GET", mio, 200)).json()
    assert propio["status"] == "retired" and not propio["can_open_draft"] and not propio["can_edit"]
    # Ni siquiera escribiendo en la base: el disparador de saltos lo impide.
    with pytest.raises(DBAPIError, match="services"):
        async with motor.begin() as c:
            await c.execute(text("update public.services set status = 'published' where id = cast(:s as uuid)"),
                            {"s": ident})
    assert await _estados(motor, ident) == (
        "retired", [(1, "changes_requested"), (2, "superseded"), (3, "published")]
    )

    # ------------------------------------------------------------------ #
    # El historial: lo que ve la prestadora y lo que ve el equipo
    # ------------------------------------------------------------------ #
    visible = [e["action"] for e in (await _espera(app, ana, "GET", f"{mio}/history", 200)).json()]
    completo = (await _espera(app, jefa, "GET", f"{BANDEJA}/{ident}/history", 200)).json()
    esperado = [
        "created", "submitted", "review_started", "changes_requested",
        "draft_opened", "resubmitted", "review_started", "approved", "published",
        "draft_opened", "submitted", "review_started", "approved", "superseded", "published",
        "suspended", "reinstated", "retired",
    ]
    assert [e["action"] for e in completo] == esperado, [e["action"] for e in completo]
    assert visible == esperado
    assert any(e.get("internal_note") == "Nota interna del equipo" for e in completo)
    for quien in (ana, otro, publico):
        await _espera(app, quien, "GET", f"{BANDEJA}/{ident}/history", 403)
    await _espera(app, otro, "GET", f"{mio}/history", 404, "service_not_found")
    # Los avisos que recibió la prestadora, en orden de tipo.
    tipos = {f[0] for f in await _filas(
        motor, "select type from public.notifications where user_id = cast(:u as uuid) "
               "and type like 'service_catalog_%'", u=ana,
    )}
    assert tipos == {
        "service_catalog_review_started", "service_catalog_changes_requested", "service_catalog_approved",
        "service_catalog_published", "service_catalog_suspended", "service_catalog_reinstated",
        "service_catalog_retired",
    }, tipos
