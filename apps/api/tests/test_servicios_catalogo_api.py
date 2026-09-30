"""El catálogo de Servicios por la API real, contra PostgreSQL (Incremento 2).

Con la base 0001–0090 desechable, el Storage de Supabase en memoria (el de
`test_baja_de_cuenta_postgres`) y `FEATURE_SERVICES` encendida SOLO aquí.

EL RECORRIDO DE VERDAD: un prestador aprobado por la admisión del Incremento 1
crea un servicio, lo completa, sube imágenes y lo envía; el equipo lo revisa y
pide cambios; el prestador corrige en una versión nueva y reenvía;
administración aprueba y publica; el público ve la versión publicada; editar
lo publicado no cambia lo visible; suspender lo saca del público.

Y LO QUE NO PUEDE PASAR: crear sin estar aprobado, tocar lo ajeno, enviar
incompleto, publicar un borrador, publicar lo propio, dos publicadas, notas
internas o rutas en la ficha pública, perder la imagen de lo publicado.
"""

from __future__ import annotations

import asyncio
import json
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.modules.services import esquema
from tests import test_baja_de_cuenta_postgres as baja_pg
from tests.test_baja_de_cuenta_postgres import (
    API,
    SIN_POSTGRES,
    _borrar_cuenta,
    _cliente,
    _existe,
    _filas,
    _llevar,
    _persona,
    _png,
    _sembrar,
    _uno,
)

pytestmark = [SIN_POSTGRES, pytest.mark.asyncio]

# Los mismos montajes: base 0001–0090, app con usuario de prueba y Storage en memoria.
base_aplicada = baja_pg.base_aplicada
entorno = baja_pg.entorno

MIOS = f"{API}/services/provider/services"
CATEGORIAS = f"{API}/services/categories"
FICHA = f"{API}/services/catalog"
ADMIN = f"{API}/admin/services"
BANDEJA = f"{ADMIN}/catalog"
PNG_VERDE = _png((10, 200, 10))
PNG_AZUL = _png((10, 10, 200))


# --------------------------------------------------------------------------- #
# Montajes
# --------------------------------------------------------------------------- #
async def _prestador(motor, estado: str = "active", pais: str = "PE") -> str:
    """Un prestador sembrado (la admisión se prueba en el Incremento 1; uno de
    los recorridos de abajo lo aprueba de verdad)."""
    perfil = await _persona(motor)
    await _sembrar(
        motor,
        "insert into public.service_providers (profile_id, provider_type, display_name, country_code, status, "
        "activated_at, suspended_at) values (cast(:u as uuid), 'individual', 'Estudio Álvarez', :p, :e, "
        "case when :e = 'active' then now() end, case when :e = 'suspended' then now() end)",
        u=perfil, p=pais, e=estado,
    )
    return perfil


async def _categoria(app, jefa: str, **datos) -> dict:
    async with _cliente(app, jefa) as http:
        r = await http.post(
            f"{ADMIN}/categories",
            json={"slug": f"cat-{uuid.uuid4().hex[:10]}", "name": "Asesoría contable", **datos},
        )
    assert r.status_code == 201, r.text
    return r.json()


async def _crear(app, perfil: str, categoria_id: str, clave: str | None = None):
    async with _cliente(app, perfil) as http:
        return await http.post(
            MIOS, json={"category_id": categoria_id},
            headers={"Idempotency-Key": clave} if clave else None,
        )


CONTENIDO = {
    "title": "Diagnóstico contable inicial",
    "summary": "Revisamos tus cuentas del mes y te decimos qué ordenar.",
    "description": "Una sesión para ordenar ingresos, gastos y obligaciones del mes con tu contador.",
    "modality": "virtual",
    "duration_minutes": 50,
    "price_model": "fixed",
    "price_minor": 12000,
    "currency": "PEN",
    "scope": "Personas con negocio propio que empiezan a facturar.",
    "includes": ["Revisión de facturas", "Plan de orden mensual"],
    "excludes": ["Declaración anual", "Trámites ante SUNAT"],
    "requirements": "Traer las facturas del mes en PDF.",
}


async def _editar(app, perfil: str, servicio: str, **cambios):
    async with _cliente(app, perfil) as http:
        return await http.patch(f"{MIOS}/{servicio}/draft", json=cambios)


async def _imagen(app, perfil: str, servicio: str, datos: bytes = PNG_VERDE, alt: str = "Escritorio con facturas", clave=None):
    async with _cliente(app, perfil) as http:
        return await http.post(
            f"{MIOS}/{servicio}/draft/images",
            data={"alt_text": alt},
            files={"file": ("foto.png", datos, "image/png")},
            headers={"Idempotency-Key": clave} if clave else None,
        )


async def _accion(app, uid: str, ruta: str, cuerpo: dict | None = None, clave: str | None = None):
    async with _cliente(app, uid) as http:
        return await http.post(ruta, json=cuerpo or {}, headers={"Idempotency-Key": clave} if clave else None)


async def _enviado(app, perfil: str, jefa: str, **extra) -> dict:
    categoria = await _categoria(app, jefa)
    r = await _crear(app, perfil, categoria["id"])
    assert r.status_code == 201, r.text
    servicio = r.json()["id"]
    r = await _editar(app, perfil, servicio, **{**CONTENIDO, **extra})
    assert r.status_code == 200, r.text
    assert (await _imagen(app, perfil, servicio)).status_code == 201
    r = await _accion(app, perfil, f"{MIOS}/{servicio}/draft/submit")
    assert r.status_code == 200, r.text
    return r.json()


async def _publicado(app, perfil: str, jefa: str, moderador: str, **extra) -> dict:
    servicio = await _enviado(app, perfil, jefa, **extra)
    version = servicio["open_version"]["id"]
    base = f"{BANDEJA}/{servicio['id']}/versions/{version}"
    assert (await _accion(app, moderador, f"{base}/start-review")).status_code == 200
    assert (await _accion(app, jefa, f"{base}/approve")).status_code == 200
    r = await _accion(app, jefa, f"{base}/publish")
    assert r.status_code == 200, r.text
    return r.json()


async def _ficha(app, servicio: str, uid: str | None = None):
    async with _cliente(app, uid or str(uuid.uuid4())) as http:
        return await http.get(f"{FICHA}/{servicio}")


async def _equipo(motor) -> tuple[str, str]:
    return await _persona(motor, "admin"), await _persona(motor, "moderator")


# =========================================================================== #
# 1. Quién crea
# =========================================================================== #
async def test_solo_un_prestador_aprobado_y_activo_crea(entorno) -> None:
    app, motor, _ = entorno
    jefa, _ = await _equipo(motor)
    categoria = await _categoria(app, jefa)
    sin_prestador = await _persona(motor)
    pendiente = await _prestador(motor, "pending")
    suspendido = await _prestador(motor, "suspended")
    activo = await _prestador(motor)
    for perfil in (sin_prestador, pendiente, suspendido):
        r = await _crear(app, perfil, categoria["id"])
        assert r.status_code == 403 and r.json()["error"]["code"] == "service_provider_not_active", r.text
        async with _cliente(app, perfil) as http:
            assert (await http.get(MIOS)).status_code == 403
    r = await _crear(app, activo, categoria["id"])
    assert r.status_code == 201, r.text
    cuerpo = r.json()
    assert cuerpo["status"] == "draft" and cuerpo["open_version"]["status"] == "draft"
    assert cuerpo["open_version"]["version"] == 1 and cuerpo["published_version"] is None
    assert cuerpo["can_edit"] and not cuerpo["can_submit"] and not cuerpo["publicly_visible"]


async def test_categoria_inactiva_de_otro_pais_o_inexistente(entorno) -> None:
    app, motor, _ = entorno
    jefa, _ = await _equipo(motor)
    perfil = await _prestador(motor, pais="PE")
    inactiva = await _categoria(app, jefa)
    assert (await _accion(app, jefa, f"{ADMIN}/categories/{inactiva['id']}/deactivate")).status_code == 200
    r = await _crear(app, perfil, inactiva["id"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "service_category_inactive"
    chilena = await _categoria(app, jefa, country_code="CL")
    r = await _crear(app, perfil, chilena["id"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "service_category_not_available"
    r = await _crear(app, perfil, str(uuid.uuid4()))
    assert r.status_code == 404 and r.json()["error"]["code"] == "service_category_not_found"
    # La categoría inactiva no aparece para quien crea, pero sí para administración.
    async with _cliente(app, perfil) as http:
        activas = {c["id"] for c in (await http.get(CATEGORIAS)).json()}
    async with _cliente(app, jefa) as http:
        todas = {c["id"] for c in (await http.get(f"{ADMIN}/categories")).json()}
    assert inactiva["id"] not in activas and inactiva["id"] in todas


async def test_crear_con_la_misma_clave_no_crea_dos(entorno) -> None:
    app, motor, _ = entorno
    jefa, _ = await _equipo(motor)
    perfil = await _prestador(motor)
    categoria = await _categoria(app, jefa)
    clave = f"crear-{uuid.uuid4().hex}"
    primera, segunda = await asyncio.gather(
        _crear(app, perfil, categoria["id"], clave), _crear(app, perfil, categoria["id"], clave)
    )
    assert sorted([primera.status_code, segunda.status_code]) in ([200, 201], [201, 201]), [primera.text, segunda.text]
    assert primera.json()["id"] == segunda.json()["id"]
    assert await _uno(
        motor, "select count(*) from public.services where creation_key = :k", k=clave
    ) == 1
    tercera = await _crear(app, perfil, categoria["id"], clave)
    assert tercera.status_code == 200 and tercera.json()["id"] == primera.json()["id"]


# =========================================================================== #
# 2. Lo propio y lo ajeno
# =========================================================================== #
async def test_lo_ajeno_es_404_y_patch_no_cambia_estados(entorno) -> None:
    app, motor, _ = entorno
    jefa, _ = await _equipo(motor)
    duena, otra = await _prestador(motor), await _prestador(motor)
    servicio = (await _crear(app, duena, (await _categoria(app, jefa))["id"])).json()["id"]
    async with _cliente(app, otra) as http:
        for metodo, ruta, cuerpo in (
            ("GET", f"{MIOS}/{servicio}", None),
            ("PATCH", f"{MIOS}/{servicio}/draft", {"title": "Me lo quedo"}),
            ("POST", f"{MIOS}/{servicio}/draft", None),
            ("POST", f"{MIOS}/{servicio}/draft/submit", {}),
            ("POST", f"{MIOS}/{servicio}/draft/withdraw", {"confirm": True}),
            ("GET", f"{MIOS}/{servicio}/history", None),
            ("GET", f"{MIOS}/{servicio}/draft/requirements", None),
            ("GET", f"{MIOS}/no-es-un-id", None),
        ):
            r = await http.request(metodo, ruta, json=cuerpo)
            assert r.status_code == 404 and r.json()["error"]["code"] == "service_not_found", (ruta, r.text)
        assert (await _imagen(app, otra, servicio)).status_code == 404
    # PATCH no cambia estados: el campo no existe.
    r = await _editar(app, duena, servicio, status="published")
    assert r.status_code == 422
    assert (await _uno(motor, "select status from public.services where id = cast(:s as uuid)", s=servicio)) == "draft"


# =========================================================================== #
# 3. Completitud y precio
# =========================================================================== #
async def test_enviar_incompleto_dice_que_falta_y_no_cambia_nada(entorno) -> None:
    app, motor, _ = entorno
    jefa, _ = await _equipo(motor)
    perfil = await _prestador(motor)
    servicio = (await _crear(app, perfil, (await _categoria(app, jefa))["id"])).json()
    r = await _accion(app, perfil, f"{MIOS}/{servicio['id']}/draft/submit")
    assert r.status_code == 422, r.text
    error = r.json()["error"]
    assert error["code"] == "service_catalog_incomplete"
    for codigo in ("title", "summary", "description", "modality", "duration", "price_model", "scope",
                   "includes", "excludes", "requirements", "cover_image"):
        assert codigo in error["details"]["missing"], codigo
    async with _cliente(app, perfil) as http:
        lo_que_falta = (await http.get(f"{MIOS}/{servicio['id']}/draft/requirements")).json()["missing"]
    assert lo_que_falta == error["details"]["missing"] == servicio["missing"]
    assert await _uno(
        motor, "select status from public.service_versions where service_id = cast(:s as uuid)", s=servicio["id"]
    ) == "draft"


async def test_gratis_no_es_sin_precio_y_un_importe_va_con_moneda(entorno) -> None:
    app, motor, _ = entorno
    jefa, _ = await _equipo(motor)
    perfil = await _prestador(motor)
    servicio = (await _crear(app, perfil, (await _categoria(app, jefa))["id"])).json()["id"]
    # Un importe con «gratis» es un error, no un gratis con número escondido.
    r = await _editar(app, perfil, servicio, price_model="free", price_minor=500, currency="PEN")
    assert r.status_code == 422 and r.json()["error"]["code"] == "service_price_invalid"
    # Fijo sin moneda: falta la moneda.
    cuerpo = (await _editar(app, perfil, servicio, price_model="fixed", price_minor=5000)).json()
    assert "currency" in cuerpo["missing"] and cuerpo["open_version"]["price"]["amount_minor"] == 5000
    # Una moneda sin configurar no vale.
    cuerpo = (await _editar(app, perfil, servicio, currency="USD")).json()
    assert "currency_not_allowed" in cuerpo["missing"]
    # Pasar a gratis limpia el importe; y gratis NO es «sin configurar».
    cuerpo = (await _editar(app, perfil, servicio, price_model="free")).json()
    assert cuerpo["open_version"]["price"] == {"model": "free", "amount_minor": None, "currency": None}
    assert "price_model" not in cuerpo["missing"]
    cuerpo = (await _editar(app, perfil, servicio, price_model=None)).json()
    assert cuerpo["open_version"]["price"]["model"] is None and "price_model" in cuerpo["missing"]
    # Cero nunca es un importe.
    assert (await _editar(app, perfil, servicio, price_model="fixed", price_minor=0)).status_code == 422
    # Presencial sin zona: falta la zona.
    cuerpo = (await _editar(app, perfil, servicio, modality="in_person")).json()
    assert "location_area" in cuerpo["missing"]


# =========================================================================== #
# 4. EL RECORRIDO: admisión real → servicio → correcciones → publicación
# =========================================================================== #
async def test_recorrido_completo_desde_la_admision_hasta_el_publico(entorno) -> None:
    app, motor, almacen = entorno
    jefa, moderador = await _equipo(motor)
    ana = await _persona(motor)
    # Incremento 1 → prestadora aprobada de verdad.
    await _llevar(app, ana, "approved", jefa=jefa, moderador=moderador)
    categoria = await _categoria(app, jefa)
    servicio = (await _crear(app, ana, categoria["id"])).json()
    ident = servicio["id"]
    assert (await _editar(app, ana, ident, **CONTENIDO)).status_code == 200
    assert (await _imagen(app, ana, ident)).status_code == 201
    enviado = (await _accion(app, ana, f"{MIOS}/{ident}/draft/submit")).json()
    v1 = enviado["open_version"]
    assert v1["status"] == "submitted" and not enviado["can_edit"]
    # Lo enviado está congelado para la API.
    r = await _editar(app, ana, ident, title="Otro título")
    assert r.status_code == 409 and r.json()["error"]["code"] == "service_version_pending"
    # Al equipo le llega el aviso.
    assert await _uno(
        motor, "select count(*) from public.notifications where user_id = cast(:u as uuid) "
               "and type = 'service_catalog_submitted' and entity_id = cast(:s as uuid)", u=moderador, s=ident,
    ) == 1

    base = f"{BANDEJA}/{ident}/versions/{v1['id']}"
    # Una nota interna en un paso SIN motivo visible: es la que más fácil se
    # colaría al prestador.
    r = await _accion(app, moderador, f"{base}/start-review", {"internal_note": "Mirar la categoría con calma"})
    assert r.status_code == 200, r.text
    # Pedir cambios SIN motivo no.
    r = await _accion(app, moderador, f"{base}/request-changes", {"note": ""})
    assert r.status_code == 422
    r = await _accion(
        app, moderador, f"{base}/request-changes",
        {"note": "Aclara qué incluye el plan mensual.", "fields": ["includes"], "internal_note": "Revisar a fondo"},
    )
    assert r.status_code == 200, r.text
    # Lo que ve la prestadora: el motivo y el campo; NUNCA la nota interna.
    async with _cliente(app, ana) as http:
        propio = (await http.get(f"{MIOS}/{ident}")).json()
        historial = (await http.get(f"{MIOS}/{ident}/history")).json()
    assert propio["last_observation"]["note"] == "Aclara qué incluye el plan mensual."
    assert propio["last_observation"]["fields"] == ["includes"]
    assert propio["can_open_draft"] and propio["open_version"] is None
    for secreto in ("Revisar a fondo", "Mirar la categoría con calma"):
        assert secreto not in json.dumps(propio) + json.dumps(historial), secreto
    # El historial NO está vacío (un «ninguno trae nota interna» sobre una
    # lista vacía también pasaría): cada paso, en orden, con el motivo visible.
    assert [e["action"] for e in historial] == ["created", "submitted", "review_started", "changes_requested"]
    assert historial[2]["note"] is None
    assert historial[-1]["note"] == "Aclara qué incluye el plan mensual."
    assert historial[-1]["fields"] == ["includes"] and historial[-1]["version"] == 1
    assert all("actor_id" not in e and "internal_note" not in e for e in historial)
    # El equipo, en cambio, ve quién actuó, en calidad de qué y la nota interna.
    async with _cliente(app, jefa) as http:
        completo = (await http.get(f"{BANDEJA}/{ident}/history")).json()
    pedido = completo[-1]
    assert pedido["action"] == "changes_requested" and pedido["internal_note"] == "Revisar a fondo"
    # También la del paso sin motivo visible: se guarda, no se pierde.
    assert completo[2]["action"] == "review_started" and completo[2]["internal_note"] == "Mirar la categoría con calma"
    assert pedido["actor_id"] == moderador and pedido["actor_role"] == "reviewer"

    # Corrige en una versión NUEVA que sale de la observada, con sus imágenes.
    r = await _accion(app, ana, f"{MIOS}/{ident}/draft")
    assert r.status_code == 201, r.text
    v2 = r.json()["open_version"]
    assert v2["version"] == 2 and v2["based_on_version"] == 1 and v2["title"] == CONTENIDO["title"]
    assert len(v2["images"]) == 1 and v2["images"][0]["is_cover"]
    r = await _editar(app, ana, ident, includes=["Revisión de facturas", "Plan mensual con fechas de pago"])
    assert r.status_code == 200
    r = await _accion(app, ana, f"{MIOS}/{ident}/draft/submit")
    assert r.status_code == 200, r.text
    assert await _uno(
        motor, "select action from public.service_events where service_id = cast(:s as uuid) "
               "and version_id = cast(:v as uuid) and action in ('submitted', 'resubmitted')", s=ident, v=v2["id"],
    ) == "resubmitted"

    base = f"{BANDEJA}/{ident}/versions/{v2['id']}"
    assert (await _accion(app, moderador, f"{base}/start-review")).status_code == 200
    # Curaduría no aprueba ni publica.
    r = await _accion(app, moderador, f"{base}/approve")
    assert r.status_code == 403 and r.json()["error"]["code"] == "service_decision_forbidden"
    assert (await _accion(app, jefa, f"{base}/approve")).status_code == 200
    # Aprobado no es publicado: el público todavía no lo ve.
    assert (await _ficha(app, ident)).status_code == 404
    r = await _accion(app, moderador, f"{base}/publish")
    assert r.status_code == 403
    r = await _accion(app, jefa, f"{base}/publish")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "published" and r.json()["publicly_visible"]

    ficha = await _ficha(app, ident)
    assert ficha.status_code == 200, ficha.text
    publico = ficha.json()
    assert publico["title"] == CONTENIDO["title"] and publico["provider"]["display_name"] == "Ana"
    # Del prestador, SOLO lo autorizado (Incremento 3): su id público, el
    # nombre, el tipo y lo que Z comprobó en ESTA admisión real.
    assert set(publico["provider"]) == {"id", "display_name", "provider_type", "trust"}
    assert publico["provider"]["trust"]["identity_verified"] is True
    assert publico["provider"]["trust"]["credential_verified"] is True
    assert publico["includes"] == ["Revisión de facturas", "Plan mensual con fechas de pago"]
    assert publico["price"] == {"model": "fixed", "amount_minor": 12000, "currency": "PEN"}
    assert publico["images"][0]["url"] and publico["images"][0]["is_cover"]
    assert await _uno(
        motor, "select count(*) from public.notifications where user_id = cast(:u as uuid) "
               "and type = 'service_catalog_published'", u=ana,
    ) == 1
    del almacen


async def test_la_ficha_publica_no_filtra_nada(entorno) -> None:
    app, motor, _ = entorno
    jefa, moderador = await _equipo(motor)
    perfil = await _prestador(motor)
    servicio = await _publicado(app, perfil, jefa, moderador)
    ficha = (await _ficha(app, servicio["id"])).json()
    crudo = json.dumps(ficha)
    for prohibido in ("storage_path", "internal_note", "actor", "status", "decided", "reviewed",
                      "created_by", "provider_id", "tax_id", "legal_name", "profile_id"):
        assert prohibido not in crudo, prohibido
    # Las imágenes solo salen como URL FIRMADA y con caducidad: el mecanismo de
    # Productos y de los documentos. Fuera de esa URL, ninguna ruta.
    for imagen in ficha["images"]:
        assert "/object/sign/" in imagen["url"] and "token=" in imagen["url"]
    sin_urls = json.dumps({**ficha, "images": [{**i, "url": None} for i in ficha["images"]]})
    assert "service-media" not in sin_urls and perfil not in sin_urls
    # Borrador, suspendido, retirado o inexistente: el mismo 404.
    borrador = (await _crear(app, perfil, (await _categoria(app, jefa))["id"])).json()["id"]
    for ident in (borrador, str(uuid.uuid4()), "no-es-un-id"):
        r = await _ficha(app, ident)
        assert r.status_code == 404 and r.json()["error"]["code"] == "service_not_found"


# =========================================================================== #
# 5. Editar lo publicado, suspender, reactivar y retirar
# =========================================================================== #
async def test_editar_lo_publicado_conserva_la_version_visible(entorno) -> None:
    app, motor, _ = entorno
    jefa, moderador = await _equipo(motor)
    perfil = await _prestador(motor)
    servicio = await _publicado(app, perfil, jefa, moderador)
    ident = servicio["id"]
    borrador = (await _accion(app, perfil, f"{MIOS}/{ident}/draft")).json()
    assert borrador["open_version"]["version"] == 2 and borrador["published_version"]["version"] == 1
    assert (await _editar(app, perfil, ident, title="Diagnóstico contable y plan de ahorro")).status_code == 200
    # Mientras tanto el público sigue viendo la 1.
    assert (await _ficha(app, ident)).json()["title"] == CONTENIDO["title"]
    enviado = (await _accion(app, perfil, f"{MIOS}/{ident}/draft/submit")).json()
    v2 = enviado["open_version"]["id"]
    async with _cliente(app, jefa) as http:
        admin = (await http.get(f"{BANDEJA}/{ident}")).json()
    assert admin["changed_fields"] == ["title"]
    assert admin["published_version"]["version"] == 1 and admin["proposed_version"]["version"] == 2
    base = f"{BANDEJA}/{ident}/versions/{v2}"
    for paso, quien in (("start-review", moderador), ("approve", jefa)):
        assert (await _accion(app, quien, f"{base}/{paso}")).status_code == 200
    assert (await _ficha(app, ident)).json()["title"] == CONTENIDO["title"]
    assert (await _accion(app, jefa, f"{base}/publish")).status_code == 200
    assert (await _ficha(app, ident)).json()["title"] == "Diagnóstico contable y plan de ahorro"
    assert await _filas(
        motor, "select version, status from public.service_versions where service_id = cast(:s as uuid) order by 1",
        s=ident,
    ) == [(1, "superseded"), (2, "published")]


async def test_suspender_reactivar_y_retirar_con_motivo(entorno) -> None:
    app, motor, _ = entorno
    jefa, moderador = await _equipo(motor)
    perfil = await _prestador(motor)
    ident = (await _publicado(app, perfil, jefa, moderador))["id"]
    r = await _accion(app, jefa, f"{BANDEJA}/{ident}/suspend", {"note": ""})
    assert r.status_code == 422
    r = await _accion(app, moderador, f"{BANDEJA}/{ident}/suspend", {"note": "Reclamo en revisión."})
    assert r.status_code == 403
    r = await _accion(app, jefa, f"{BANDEJA}/{ident}/suspend", {"note": "Reclamo en revisión."})
    assert r.status_code == 200 and r.json()["status"] == "suspended" and not r.json()["publicly_visible"]
    assert (await _ficha(app, ident)).status_code == 404
    async with _cliente(app, perfil) as http:
        propio = (await http.get(f"{MIOS}/{ident}")).json()
    assert propio["last_observation"]["action"] == "suspended"
    assert propio["last_observation"]["note"] == "Reclamo en revisión."
    # Suspender no borra nada: la versión publicada sigue ahí.
    assert propio["published_version"]["version"] == 1
    r = await _accion(app, jefa, f"{BANDEJA}/{ident}/reinstate", {"note": "Reclamo resuelto."})
    assert r.status_code == 200 and r.json()["status"] == "published"
    assert (await _ficha(app, ident)).status_code == 200
    r = await _accion(app, jefa, f"{BANDEJA}/{ident}/retire", {"note": "El prestador dejó de ofrecerlo."})
    assert r.status_code == 200 and r.json()["status"] == "retired" and r.json()["actions"] == []
    assert (await _ficha(app, ident)).status_code == 404
    r = await _accion(app, perfil, f"{MIOS}/{ident}/draft")
    assert r.status_code == 409 and r.json()["error"]["code"] == "service_retired"
    acciones = [f[0] for f in await _filas(
        motor, "select action from public.service_events where service_id = cast(:s as uuid) "
               "order by created_at, id", s=ident,
    )]
    assert acciones[-3:] == ["suspended", "reinstated", "retired"]
    for tipo in ("service_catalog_suspended", "service_catalog_reinstated", "service_catalog_retired"):
        assert await _uno(
            motor, "select count(*) from public.notifications where user_id = cast(:u as uuid) and type = :t",
            u=perfil, t=tipo,
        ) == 1, tipo


async def test_el_motivo_lo_exige_el_dominio_no_solo_el_formulario(entorno) -> None:
    """Pedir cambios, suspender, reactivar y retirar sin motivo se rechazan en
    el DOMINIO, aunque un formulario futuro deje pasar el campo vacío."""
    from app.modules.services import catalogo
    from app.modules.services.states import REVISOR

    app, motor, _ = entorno
    jefa, moderador = await _equipo(motor)
    perfil = await _prestador(motor)
    enviado = await _enviado(app, perfil, jefa)
    ident, version = enviado["id"], enviado["open_version"]["id"]
    assert (await _accion(app, moderador, f"{BANDEJA}/{ident}/versions/{version}/start-review")).status_code == 200
    publicado = (await _publicado(app, await _prestador(motor), jefa, moderador))["id"]
    for nota in (None, "   ", "ok"):
        async with AsyncSession(motor, expire_on_commit=False) as db:
            with pytest.raises(catalogo.MotivoRequerido):
                await catalogo.pedir_cambios(
                    db, actor_id=moderador, funcion=REVISOR, servicio_id=ident, version_id=version,
                    nota=nota, campos=None, nota_interna="Solo interna", clave=None,
                )
            for paso in (catalogo.suspender, catalogo.reactivar, catalogo.retirar_servicio):
                with pytest.raises(catalogo.MotivoRequerido):
                    await paso(db, actor_id=jefa, servicio_id=publicado, nota=nota, nota_interna="Solo interna", clave=None)
            await db.rollback()
    # Nada cambió.
    assert await _filas(
        motor, "select status from public.service_versions where id = cast(:v as uuid)", v=version,
    ) == [("under_review",)]
    assert await _uno(motor, "select status from public.services where id = cast(:s as uuid)", s=publicado) == "published"


async def test_un_prestador_suspendido_desaparece_del_publico(entorno) -> None:
    app, motor, _ = entorno
    jefa, moderador = await _equipo(motor)
    perfil = await _prestador(motor)
    ident = (await _publicado(app, perfil, jefa, moderador))["id"]
    await _sembrar(
        motor, "update public.service_providers set status = 'suspended', suspended_at = now() "
               "where profile_id = cast(:u as uuid)", u=perfil,
    )
    assert (await _ficha(app, ident)).status_code == 404


async def test_nadie_revisa_ni_publica_lo_suyo(entorno) -> None:
    app, motor, _ = entorno
    jefa, _ = await _equipo(motor)
    # Una administradora que además es prestadora.
    await _sembrar(
        motor,
        "insert into public.service_providers (profile_id, provider_type, display_name, country_code, status, "
        "activated_at) values (cast(:u as uuid), 'individual', 'Jefa', 'PE', 'active', now())",
        u=jefa,
    )
    otra_jefa = await _persona(motor, "admin")
    servicio = await _enviado(app, jefa, otra_jefa)
    base = f"{BANDEJA}/{servicio['id']}/versions/{servicio['open_version']['id']}"
    r = await _accion(app, jefa, f"{base}/start-review")
    assert r.status_code == 403 and r.json()["error"]["code"] == "service_self_review_forbidden"
    async with _cliente(app, jefa) as http:
        detalle = (await http.get(f"{BANDEJA}/{servicio['id']}")).json()
    assert detalle["own"] and detalle["actions"] == []


async def test_solo_se_aprueba_lo_revisado_y_solo_se_publica_lo_aprobado(entorno) -> None:
    """Saltarse un paso es un 409 que no cambia nada, lo pida quien lo pida."""
    app, motor, _ = entorno
    jefa, moderador = await _equipo(motor)
    perfil = await _prestador(motor)
    # Un borrador que nunca se envió.
    borrador = (await _crear(app, perfil, (await _categoria(app, jefa))["id"])).json()
    r = await _accion(app, jefa, f"{BANDEJA}/{borrador['id']}/versions/{borrador['open_version']['id']}/publish")
    assert r.status_code == 409 and r.json()["error"]["code"] == "service_catalog_transition_invalid"
    # Uno enviado: ni se aprueba ni se publica sin revisar.
    servicio = await _enviado(app, perfil, jefa)
    ident = servicio["id"]
    base = f"{BANDEJA}/{ident}/versions/{servicio['open_version']['id']}"
    for paso in ("approve", "publish"):
        r = await _accion(app, jefa, f"{base}/{paso}")
        assert r.status_code == 409 and r.json()["error"]["code"] == "service_catalog_transition_invalid", paso
    # En revisión: se aprueba, pero todavía no se publica.
    assert (await _accion(app, moderador, f"{base}/start-review")).status_code == 200
    r = await _accion(app, jefa, f"{base}/publish")
    assert r.status_code == 409 and r.json()["error"]["code"] == "service_catalog_transition_invalid"
    # Nada cambió: ni la versión, ni el servicio, ni el público, ni el historial.
    assert await _filas(
        motor, "select v.status, s.status from public.service_versions v join public.services s on s.id = v.service_id "
               "where v.service_id = cast(:s as uuid)", s=ident,
    ) == [("under_review", "draft")]
    assert (await _ficha(app, ident)).status_code == 404
    assert await _uno(
        motor, "select count(*) from public.service_events where service_id in (cast(:a as uuid), cast(:b as uuid)) "
               "and action in ('approved', 'published')", a=ident, b=borrador["id"],
    ) == 0


# =========================================================================== #
# 6. Concurrencia e idempotencia
# =========================================================================== #
async def test_dos_envios_dos_aprobaciones_y_dos_publicaciones_a_la_vez(entorno) -> None:
    app, motor, _ = entorno
    jefa, moderador = await _equipo(motor)
    otra_jefa = await _persona(motor, "admin")
    perfil = await _prestador(motor)
    categoria = await _categoria(app, jefa)
    ident = (await _crear(app, perfil, categoria["id"])).json()["id"]
    await _editar(app, perfil, ident, **CONTENIDO)
    await _imagen(app, perfil, ident)
    envios = await asyncio.gather(*(_accion(app, perfil, f"{MIOS}/{ident}/draft/submit") for _ in range(2)))
    assert [r.status_code for r in envios] == [200, 200], [r.text for r in envios]
    assert await _uno(
        motor, "select count(*) from public.service_events where service_id = cast(:s as uuid) and action = 'submitted'",
        s=ident,
    ) == 1
    version = envios[0].json()["open_version"]["id"]
    base = f"{BANDEJA}/{ident}/versions/{version}"
    revisiones = await asyncio.gather(_accion(app, moderador, f"{base}/start-review"), _accion(app, jefa, f"{base}/start-review"))
    assert sorted(r.status_code for r in revisiones) == [200, 409], [r.text for r in revisiones]
    aprobaciones = await asyncio.gather(_accion(app, jefa, f"{base}/approve"), _accion(app, otra_jefa, f"{base}/approve"))
    assert sorted(r.status_code for r in aprobaciones) == [200, 409], [r.text for r in aprobaciones]
    publicaciones = await asyncio.gather(_accion(app, jefa, f"{base}/publish"), _accion(app, otra_jefa, f"{base}/publish"))
    assert sorted(r.status_code for r in publicaciones) == [200, 409], [r.text for r in publicaciones]
    assert await _uno(
        motor, "select count(*) from public.service_versions where service_id = cast(:s as uuid) and status = 'published'",
        s=ident,
    ) == 1
    assert await _uno(
        motor, "select count(*) from public.service_events where service_id = cast(:s as uuid) and action = 'published'",
        s=ident,
    ) == 1


async def test_la_misma_clave_no_repite_y_otra_accion_con_ella_es_un_error(entorno) -> None:
    app, motor, _ = entorno
    jefa, moderador = await _equipo(motor)
    perfil = await _prestador(motor)
    servicio = await _enviado(app, perfil, jefa)
    base = f"{BANDEJA}/{servicio['id']}/versions/{servicio['open_version']['id']}"
    assert (await _accion(app, moderador, f"{base}/start-review")).status_code == 200
    clave = f"aprobar-{uuid.uuid4().hex}"
    primera = await _accion(app, jefa, f"{base}/approve", clave=clave)
    segunda = await _accion(app, jefa, f"{base}/approve", clave=clave)
    assert primera.status_code == segunda.status_code == 200
    assert await _uno(
        motor, "select count(*) from public.service_events where service_id = cast(:s as uuid) and action = 'approved'",
        s=servicio["id"],
    ) == 1
    r = await _accion(app, jefa, f"{base}/publish", clave=clave)
    assert r.status_code == 409 and r.json()["error"]["code"] == "idempotency_key_reused"


# =========================================================================== #
# 7. Imágenes
# =========================================================================== #
async def test_imagenes_validadas_ordenadas_con_portada_y_sin_huerfanas(entorno, monkeypatch) -> None:
    app, motor, almacen = entorno
    jefa, _ = await _equipo(motor)
    perfil = await _prestador(motor)
    ident = (await _crear(app, perfil, (await _categoria(app, jefa))["id"])).json()["id"]
    # Solo imágenes de verdad, con descripción y hasta 5 MB.
    r = await _imagen(app, perfil, ident, datos=b"%PDF-1.4 no es una foto")
    assert r.status_code == 422 and r.json()["error"]["code"] == "service_image_invalid"
    r = await _imagen(app, perfil, ident, datos=b"\x89PNG" + b"0" * (5 * 1024 * 1024))
    assert r.status_code == 422
    r = await _imagen(app, perfil, ident, alt="x")
    assert r.status_code == 422
    primera = (await _imagen(app, perfil, ident)).json()["open_version"]["images"]
    assert len(primera) == 1 and primera[0]["is_cover"]
    segunda = (await _imagen(app, perfil, ident, datos=PNG_AZUL, alt="Contador revisando")).json()["open_version"]["images"]
    a, b = segunda[0]["id"], segunda[1]["id"]
    assert not segunda[1]["is_cover"]
    # Nunca sale la ruta: solo una URL firmada.
    assert all("storage_path" not in i for i in segunda)
    assert all("/object/sign/" in i["url"] and "token=" in i["url"] for i in segunda)
    # Orden: todas o ninguna; y la portada entre ellas.
    async with _cliente(app, perfil) as http:
        r = await http.put(f"{MIOS}/{ident}/draft/images/order", json={"image_ids": [b]})
        assert r.status_code == 422
        r = await http.put(f"{MIOS}/{ident}/draft/images/order", json={"image_ids": [b, a], "cover_id": b})
        assert r.status_code == 200
        orden = r.json()["open_version"]["images"]
        assert [i["id"] for i in orden] == [b, a] and orden[0]["is_cover"] and not orden[1]["is_cover"]
        # Quitar la portada deja a la otra de portada y BORRA el archivo (nadie más lo nombra).
        antes = len(almacen.objetos.get("service-media", {}))
        r = await http.delete(f"{MIOS}/{ident}/draft/images/{b}")
        assert r.status_code == 200 and r.json()["open_version"]["images"][0]["is_cover"]
        assert len(almacen.objetos.get("service-media", {})) == antes - 1
    # El tope de imágenes, configurable.
    monkeypatch.setattr(get_settings(), "services_catalog_max_images", 1)
    r = await _imagen(app, perfil, ident, datos=PNG_AZUL)
    assert r.status_code == 409 and r.json()["error"]["code"] == "service_image_limit_reached"


async def test_quitar_una_imagen_del_borrador_no_borra_la_de_lo_publicado(entorno) -> None:
    app, motor, almacen = entorno
    jefa, moderador = await _equipo(motor)
    perfil = await _prestador(motor)
    ident = (await _publicado(app, perfil, jefa, moderador))["id"]
    borrador = (await _accion(app, perfil, f"{MIOS}/{ident}/draft")).json()
    copia = borrador["open_version"]["images"][0]["id"]
    rutas = set(almacen.de("service-media", perfil))
    assert len(rutas) == 1
    async with _cliente(app, perfil) as http:
        assert (await http.delete(f"{MIOS}/{ident}/draft/images/{copia}")).status_code == 200
    # El archivo sigue: lo nombra la versión publicada.
    assert set(almacen.de("service-media", perfil)) == rutas
    assert (await _ficha(app, ident)).json()["images"][0]["url"]


async def test_un_reintento_de_subida_no_sube_dos_veces(entorno) -> None:
    app, motor, almacen = entorno
    jefa, _ = await _equipo(motor)
    perfil = await _prestador(motor)
    ident = (await _crear(app, perfil, (await _categoria(app, jefa))["id"])).json()["id"]
    clave = f"subir-{uuid.uuid4().hex}"
    uno = await _imagen(app, perfil, ident, clave=clave)
    dos = await _imagen(app, perfil, ident, clave=clave)
    assert uno.status_code == 201 and dos.status_code == 200
    assert len(dos.json()["open_version"]["images"]) == 1
    assert len(almacen.de("service-media", perfil)) == 1


# =========================================================================== #
# 8. Historial, auditoría y avisos
# =========================================================================== #
async def test_la_auditoria_no_copia_textos_libres(entorno) -> None:
    app, motor, _ = entorno
    jefa, moderador = await _equipo(motor)
    perfil = await _prestador(motor)
    servicio = await _enviado(app, perfil, jefa)
    base = f"{BANDEJA}/{servicio['id']}/versions/{servicio['open_version']['id']}"
    await _accion(app, moderador, f"{base}/start-review")
    secreto = "Motivo con datos de la persona 987654321"
    await _accion(app, moderador, f"{base}/request-changes",
                  {"note": secreto, "fields": ["title"], "internal_note": "Nota interna privada"})
    filas = await _filas(
        motor, "select action, reason, payload::text from public.audit_events where entity_id = cast(:s as uuid) "
               "order by occurred_at", s=servicio["id"],
    )
    acciones = [f[0] for f in filas]
    assert acciones == ["service.created", "service.submitted", "service.review_started", "service.changes_requested"]
    texto = json.dumps(filas, default=str)
    assert secreto not in texto and "Nota interna privada" not in texto and CONTENIDO["title"] not in texto
    assert all(f[1] is None for f in filas)


async def test_lo_que_pasa_en_el_mismo_instante_sale_siempre_en_el_mismo_orden(entorno) -> None:
    """Publicar supera la anterior en el MISMO instante. Con los ids elegidos
    para que el desempate por id ponga «publicada» primero, el historial tiene
    que enseñar igualmente «superada» antes: si no, cada lectura podía
    salir en un orden distinto (lo destapó el recorrido integral)."""
    app, motor, _ = entorno
    jefa, moderador = await _equipo(motor)
    perfil = await _prestador(motor)
    ident = (await _publicado(app, perfil, jefa, moderador))["id"]
    version = await _uno(
        motor, "select id::text from public.service_versions where service_id = cast(:s as uuid)", s=ident
    )
    for evento, accion, quien, rol in (
        ("00000000-0000-4000-8000-000000000001", "published", jefa, "admin"),
        ("ffffffff-ffff-4fff-bfff-ffffffffffff", "superseded", None, "system"),
    ):
        await _sembrar(
            motor,
            "insert into public.service_events (id, service_id, version_id, action, from_status, to_status, "
            "actor_id, actor_role, created_at) values (cast(:e as uuid), cast(:s as uuid), cast(:v as uuid), :a, "
            "'approved', 'published', cast(:q as uuid), :r, timestamptz '2999-01-01 00:00:00+00')",
            e=evento, s=ident, v=version, a=accion, q=quien, r=rol,
        )
    async with _cliente(app, jefa) as http:
        completo = (await http.get(f"{BANDEJA}/{ident}/history")).json()
    assert [e["action"] for e in completo[-2:]] == ["superseded", "published"]
    async with _cliente(app, perfil) as http:
        visible = (await http.get(f"{MIOS}/{ident}/history")).json()
    assert [e["action"] for e in visible[-2:]] == ["superseded", "published"]


async def test_un_aviso_que_falla_no_deshace_la_decision(entorno, monkeypatch) -> None:
    app, motor, _ = entorno
    jefa, moderador = await _equipo(motor)
    perfil = await _prestador(motor)

    async def revienta(*args, **kwargs):
        raise RuntimeError("la bandeja no contesta")

    from app.modules.notifications import service as notificaciones

    monkeypatch.setattr(notificaciones, "add_notification", revienta)
    servicio = await _enviado(app, perfil, jefa)
    base = f"{BANDEJA}/{servicio['id']}/versions/{servicio['open_version']['id']}"
    r = await _accion(app, moderador, f"{base}/start-review")
    assert r.status_code == 200, r.text
    assert await _uno(
        motor, "select status from public.service_versions where id = cast(:v as uuid)", v=servicio["open_version"]["id"]
    ) == "under_review"


# =========================================================================== #
# 9. Bandeja, categorías y bandera
# =========================================================================== #
async def test_la_bandeja_filtra_y_pagina_por_cursor(entorno) -> None:
    app, motor, _ = entorno
    jefa, moderador = await _equipo(motor)
    perfil = await _prestador(motor)
    categoria = await _categoria(app, jefa)
    idents = []
    for modalidad, zona in (("virtual", None), ("in_person", "Miraflores, Lima"), ("at_home", "San Isidro")):
        ident = (await _crear(app, perfil, categoria["id"])).json()["id"]
        await _editar(app, perfil, ident, **{**CONTENIDO, "modality": modalidad, "location_area": zona})
        await _imagen(app, perfil, ident)
        assert (await _accion(app, perfil, f"{MIOS}/{ident}/draft/submit")).status_code == 200
        idents.append(ident)
    async with _cliente(app, moderador) as http:
        r = await http.get(BANDEJA, params={"category_id": categoria["id"], "limit": 2})
        pagina = r.json()
        assert len(pagina["items"]) == 2 and pagina["next_cursor"]
        siguiente = (await http.get(BANDEJA, params={"category_id": categoria["id"], "limit": 2,
                                                     "cursor": pagina["next_cursor"]})).json()
        vistos = [i["id"] for i in pagina["items"] + siguiente["items"]]
        assert sorted(vistos) == sorted(idents) and siguiente["next_cursor"] is None
        presencial = (await http.get(BANDEJA, params={"category_id": categoria["id"], "modality": "in_person"})).json()
        assert [i["id"] for i in presencial["items"]] == [idents[1]]
        assert (await http.get(BANDEJA, params={"cursor": "basura"})).status_code == 422
    # Quien no es del equipo no ve la bandeja.
    async with _cliente(app, perfil) as http:
        assert (await http.get(BANDEJA)).status_code == 403


async def test_las_categorias_las_administra_administracion(entorno) -> None:
    app, motor, _ = entorno
    jefa, moderador = await _equipo(motor)
    async with _cliente(app, moderador) as http:
        r = await http.post(f"{ADMIN}/categories", json={"slug": "no-puedo", "name": "No puedo"})
        assert r.status_code == 403
    madre = await _categoria(app, jefa, icon="briefcase")
    hija = await _categoria(app, jefa, parent_id=madre["id"])
    async with _cliente(app, jefa) as http:
        r = await http.post(f"{ADMIN}/categories", json={"slug": madre["slug"], "name": "Repetida"})
        assert r.status_code == 409 and r.json()["error"]["code"] == "service_category_slug_taken"
        r = await http.post(f"{ADMIN}/categories", json={"slug": f"nieta-{uuid.uuid4().hex[:6]}", "name": "Nieta",
                                                         "parent_id": hija["id"]})
        assert r.status_code == 422 and r.json()["error"]["code"] == "service_category_hierarchy_invalid"
        r = await http.patch(f"{ADMIN}/categories/{madre['id']}", json={"status": "inactive"})
        assert r.status_code == 422
        r = await http.patch(f"{ADMIN}/categories/{madre['id']}", json={"name": "Asesoría y contabilidad", "name_en": "Accounting"})
        assert r.status_code == 200 and r.json()["name_en"] == "Accounting"
        for _ in range(2):
            r = await http.post(f"{ADMIN}/categories/{madre['id']}/deactivate")
            assert r.status_code == 200 and r.json()["status"] == "inactive"


async def test_con_la_bandera_apagada_nada_del_catalogo_responde(entorno, monkeypatch) -> None:
    app, motor, _ = entorno
    jefa, _ = await _equipo(motor)
    perfil = await _prestador(motor)
    monkeypatch.setattr(get_settings(), "feature_services", False)
    esquema.olvidar()
    async with _cliente(app, perfil) as http:
        for ruta in (MIOS, CATEGORIAS, f"{FICHA}/{uuid.uuid4()}"):
            r = await http.get(ruta)
            assert r.status_code == 503 and r.json()["error"]["code"] == "services_disabled", ruta
    async with _cliente(app, jefa) as http:
        r = await http.get(BANDEJA)
        assert r.status_code == 503 and r.json()["error"]["code"] == "services_disabled"


# =========================================================================== #
# 10. La puerta de esquema de la 0090
# =========================================================================== #
async def _puerta_con(motor, *cambios: str) -> bool:
    """`hay_catalogo` con `cambios` aplicados en una transacción que se deshace."""
    esquema.olvidar()
    async with motor.connect() as conexion:
        transaccion = await conexion.begin()
        try:
            for sql in cambios:
                await conexion.execute(text(sql))
            sesion = AsyncSession(bind=conexion)
            try:
                return await esquema.hay_catalogo(sesion)
            finally:
                await sesion.close()
        finally:
            await transaccion.rollback()
            esquema.olvidar()


async def test_la_puerta_reconoce_la_0090_completa(entorno) -> None:
    _, motor, _ = entorno
    assert await _puerta_con(motor) is True


@pytest.mark.parametrize(
    "cambios",
    [
        pytest.param(("drop trigger service_versions_saltos on public.service_versions",), id="sin_disparador"),
        pytest.param(
            ("create or replace trigger services_saltos before insert or update on public.services "
             "for each row execute function public.service_categories_dos_niveles()",),
            id="disparador_con_otra_funcion",
        ),
        pytest.param(
            ("drop trigger services_saltos on public.services",
             "create trigger services_saltos after insert or update on public.services "
             "for each row execute function public.services_salto_valido()"),
            id="disparador_con_otra_forma",
        ),
        pytest.param(("alter table public.service_events disable trigger service_events_inmutables",), id="deshabilitado"),
        pytest.param(("drop index public.service_versions_una_publicada",), id="sin_indice_critico"),
        pytest.param(
            ("drop index public.service_versions_una_publicada",
             "create index service_versions_una_publicada on public.service_versions (service_id) "
             "where status = 'published'"),
            id="indice_critico_no_unico",
        ),
        pytest.param(("alter table public.service_versions disable row level security",), id="sin_rls"),
        pytest.param(("alter table public.service_versions drop column location_area",), id="sin_columna"),
        pytest.param(("drop table public.service_events",), id="sin_tabla"),
        pytest.param(("delete from storage.buckets where id = 'service-media'",), id="sin_deposito"),
        pytest.param(("update storage.buckets set public = true where id = 'service-media'",), id="deposito_publico"),
        # Un rol que ve `storage.buckets` pero SIN saltarse su RLS y sin
        # ninguna política: la consulta no falla, simplemente no ve el
        # depósito. En Supabase el rol de la API (`postgres`) tiene BYPASSRLS.
        pytest.param(
            ("alter table storage.buckets enable row level security",
             "create role puerta_sin_bypass nologin nobypassrls",
             "grant usage on schema public to puerta_sin_bypass",
             "grant select on storage.buckets to puerta_sin_bypass",
             "set local role puerta_sin_bypass"),
            id="rls_de_storage_sin_bypass",
        ),
    ],
)
async def test_la_puerta_rechaza_una_0090_incompleta(entorno, cambios) -> None:
    _, motor, _ = entorno
    assert await _puerta_con(motor, *cambios) is False


async def test_la_puerta_con_un_rol_como_el_de_la_api_en_supabase(entorno) -> None:
    """El control del caso `rls_de_storage_sin_bypass`: con la RLS de
    `storage.buckets` activa y sin políticas, como en Supabase, un rol con
    BYPASSRLS y SELECT (lo que tiene `postgres`, verificado el 29/09/2026) sí
    ve el depósito. Así el «no» de arriba es por el bypass y no por otra cosa."""
    _, motor, _ = entorno
    assert await _puerta_con(
        motor,
        "alter table storage.buckets enable row level security",
        "create role puerta_con_bypass nologin bypassrls",
        "grant usage on schema public to puerta_con_bypass",
        "grant select on storage.buckets to puerta_con_bypass",
        "set local role puerta_con_bypass",
    ) is True


async def test_sin_permiso_sobre_storage_la_puerta_contesta_503_y_no_500(entorno) -> None:
    """Un rol de verdad, con todo lo de `public` pero SIN `SELECT` sobre
    `storage.buckets`: la consulta de la puerta falla con 42501. La API real
    contesta 503 `services_not_ready` en todas las entradas del catálogo, no
    recuerda el fallo, y en cuanto el permiso existe responde sin reiniciar."""
    from sqlalchemy.exc import DBAPIError
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.security import get_current_user
    from app.main import create_app
    from app.shared.database import get_db

    app, motor, _ = entorno
    jefa, _ = await _equipo(motor)
    perfil = await _prestador(motor)
    rol, clave = f"api_sin_storage_{uuid.uuid4().hex[:8]}", uuid.uuid4().hex
    async with motor.begin() as c:
        await c.execute(text(f"create role {rol} login password '{clave}' bypassrls"))
        for sql in (
            f"grant usage on schema public, auth to {rol}",
            f"grant select, insert, update, delete on all tables in schema public to {rol}",
            f"grant select on all tables in schema auth to {rol}",
        ):
            await c.execute(text(sql))
        # La precondición: sin ella la prueba pasaría por otro motivo.
        assert (await c.execute(text(
            "select has_table_privilege(:r, 'storage.buckets', 'select')"), {"r": rol})).scalar() is False
    restringido = create_async_engine(motor.url.set(username=rol, password=clave))
    sesiones = async_sessionmaker(restringido, expire_on_commit=False)
    otra = create_app()

    async def _db():
        async with sesiones() as db:
            yield db

    otra.dependency_overrides[get_db] = _db
    otra.dependency_overrides[get_current_user] = app.dependency_overrides[get_current_user]
    try:
        # La consulta de la puerta, sola, falla por permisos…
        async with restringido.connect() as c:
            with pytest.raises(DBAPIError) as fallo:
                await c.execute(esquema._LO_QUE_NECESITA_EL_CATALOGO)
        assert getattr(fallo.value.orig, "sqlstate", None) == "42501", fallo.value
        # …y la puerta real dice que no, sin recordarlo.
        esquema.olvidar()
        async with sesiones() as db:
            assert await esquema.hay_catalogo(db) is False
        assert "catalogo" not in esquema._cache
        # La API: 503 controlado en el prestador, el público y administración.
        for uid, ruta in ((perfil, MIOS), (perfil, CATEGORIAS), (perfil, f"{FICHA}/{uuid.uuid4()}"), (jefa, BANDEJA)):
            async with _cliente(otra, uid) as http:
                r = await http.get(ruta)
            assert r.status_code == 503 and r.json()["error"]["code"] == "services_not_ready", (ruta, r.text)
        # Con el permiso, sin reiniciar nada, contesta.
        async with motor.begin() as c:
            await c.execute(text(f"grant select on storage.buckets to {rol}"))
        async with _cliente(otra, perfil) as http:
            r = await http.get(MIOS)
        assert r.status_code == 200, r.text
        assert esquema._cache.get("catalogo") is True
    finally:
        otra.dependency_overrides.clear()
        await restringido.dispose()
        esquema.olvidar()
        async with motor.begin() as c:
            await c.execute(text(f"drop owned by {rol}"))
            await c.execute(text(f"drop role {rol}"))


async def test_la_puerta_sin_la_0090_dice_no_preparado(entorno, monkeypatch) -> None:
    app, motor, _ = entorno
    perfil = await _prestador(motor)

    async def _no(db):
        return False

    monkeypatch.setattr(esquema, "hay_catalogo", _no)
    async with _cliente(app, perfil) as http:
        r = await http.get(MIOS)
    assert r.status_code == 503 and r.json()["error"]["code"] == "services_not_ready"


# =========================================================================== #
# 11. La cuenta del prestador se borra con sus servicios y sus imágenes
# =========================================================================== #
async def test_la_baja_del_prestador_se_lleva_sus_servicios_e_imagenes(entorno) -> None:
    app, motor, almacen = entorno
    jefa, moderador = await _equipo(motor)
    perfil = await _prestador(motor)
    ident = (await _publicado(app, perfil, jefa, moderador))["id"]
    await _accion(app, perfil, f"{MIOS}/{ident}/draft")
    assert almacen.de("service-media", perfil)
    r = await _borrar_cuenta(app, perfil)
    assert r.status_code == 204, r.text
    assert not await _existe(motor, perfil)
    for tabla, columna in (("services", "id"), ("service_versions", "service_id"),
                           ("service_version_images", "service_id"), ("service_events", "service_id")):
        assert await _uno(motor, f"select count(*) from public.{tabla} where {columna} = cast(:s as uuid)", s=ident) == 0
    assert almacen.de("service-media", perfil) == []
    assert (await _ficha(app, ident)).status_code == 404
    # La auditoría de lo que hizo el equipo sigue, y la suya queda anónima.
    assert await _uno(
        motor, "select count(*) from public.audit_events where entity_id = cast(:s as uuid) and actor_id is null",
        s=ident,
    ) >= 1


# =========================================================================== #
# 12. Lo que encontró la revisión independiente (29/09/2026)
# =========================================================================== #
async def test_lo_que_cambia_se_dice_con_los_campos_que_la_app_sabe_pintar(entorno) -> None:
    """`changed_fields` habla el vocabulario de pedir cambios: el precio es uno
    (modelo, importe y moneda), la duración es `duration`, y las imágenes
    cuentan. Antes salía `price_minor`, que la app pintaba como «Otro dato»."""
    from app.modules.services.catalogo_requisitos import CAMPOS

    app, motor, _ = entorno
    jefa, moderador = await _equipo(motor)
    perfil = await _prestador(motor)
    ident = (await _publicado(app, perfil, jefa, moderador))["id"]
    await _accion(app, perfil, f"{MIOS}/{ident}/draft")

    async def cambia() -> list[str]:
        async with _cliente(app, jefa) as http:
            return (await http.get(f"{BANDEJA}/{ident}")).json()["changed_fields"]

    assert await cambia() == []
    assert (await _editar(app, perfil, ident, price_minor=15000)).status_code == 200
    assert await cambia() == ["price"]
    assert (await _editar(app, perfil, ident, duration_minutes=90)).status_code == 200
    assert await cambia() == ["duration", "price"]
    # Una imagen nueva que pasa a ser la portada: también es un cambio.
    borrador = (await _imagen(app, perfil, ident, PNG_AZUL, alt="Otra vista del escritorio")).json()
    nueva = next(i["id"] for i in borrador["open_version"]["images"] if not i["is_cover"])
    orden = [nueva] + [i["id"] for i in borrador["open_version"]["images"] if i["id"] != nueva]
    async with _cliente(app, perfil) as http:
        r = await http.put(f"{MIOS}/{ident}/draft/images/order", json={"image_ids": orden, "cover_id": nueva})
    assert r.status_code == 200, r.text
    campos = await cambia()
    assert campos == ["duration", "price", "images"]
    assert set(campos) <= set(CAMPOS)


async def test_publicar_la_version_de_un_suspendido_no_dice_que_ya_se_ve(entorno) -> None:
    app, motor, _ = entorno
    jefa, moderador = await _equipo(motor)
    perfil = await _prestador(motor)
    ident = (await _publicado(app, perfil, jefa, moderador))["id"]
    assert (await _accion(app, jefa, f"{BANDEJA}/{ident}/suspend", {"note": "Revisamos un reclamo."})).status_code == 200
    await _accion(app, perfil, f"{MIOS}/{ident}/draft")
    await _editar(app, perfil, ident, title="Diagnóstico contable corregido")
    v2 = (await _accion(app, perfil, f"{MIOS}/{ident}/draft/submit")).json()["open_version"]["id"]
    base = f"{BANDEJA}/{ident}/versions/{v2}"
    for paso, quien in (("start-review", moderador), ("approve", jefa), ("publish", jefa)):
        assert (await _accion(app, quien, f"{base}/{paso}")).status_code == 200, paso
    async with _cliente(app, jefa) as http:
        detalle = (await http.get(f"{BANDEJA}/{ident}")).json()
    assert detalle["status"] == "suspended" and not detalle["publicly_visible"]
    tipos = [f[0] for f in await _filas(
        motor, "select type from public.notifications where user_id = cast(:u as uuid) "
               "and type like 'service_catalog_published%' order by created_at", u=perfil,
    )]
    # La v1 avisó «publicado»; la v2, publicada en suspenso, avisa otra cosa.
    assert tipos == ["service_catalog_published", "service_catalog_published_suspended"]


async def test_un_servicio_con_cambios_pedidos_sigue_teniendo_nombre(entorno) -> None:
    app, motor, _ = entorno
    jefa, moderador = await _equipo(motor)
    perfil = await _prestador(motor)
    servicio = await _enviado(app, perfil, jefa)
    ident = servicio["id"]
    base = f"{BANDEJA}/{ident}/versions/{servicio['open_version']['id']}"
    assert (await _accion(app, moderador, f"{base}/start-review")).status_code == 200
    assert (await _accion(app, moderador, f"{base}/request-changes", {"note": "Aclara el alcance."})).status_code == 200
    async with _cliente(app, perfil) as http:
        lista = (await http.get(MIOS)).json()["items"]
        propio = (await http.get(f"{MIOS}/{ident}")).json()
    fila = next(s for s in lista if s["id"] == ident)
    assert fila["title"] == CONTENIDO["title"] and fila["cover_url"]
    assert fila["open_version_status"] is None and fila["last_version_status"] == "changes_requested"
    assert propio["title"] == CONTENIDO["title"] and propio["last_version_status"] == "changes_requested"
    async with _cliente(app, jefa) as http:
        cola = (await http.get(f"{BANDEJA}?queue=draft")).json()["items"]
        detalle = (await http.get(f"{BANDEJA}/{ident}")).json()
    assert next(s for s in cola if s["id"] == ident)["title"] == CONTENIDO["title"]
    assert detalle["title"] == CONTENIDO["title"]


async def test_las_categorias_que_se_ofrecen_son_las_que_se_pueden_usar(entorno) -> None:
    app, motor, _ = entorno
    jefa, _ = await _equipo(motor)
    perfil = await _prestador(motor, pais="PE")
    global_ = await _categoria(app, jefa)
    peruana = await _categoria(app, jefa, country_code="PE")
    chilena = await _categoria(app, jefa, country_code="CL")
    madre = await _categoria(app, jefa)
    hija = await _categoria(app, jefa, parent_id=madre["id"])
    async with _cliente(app, jefa) as http:
        assert (await http.post(f"{ADMIN}/categories/{madre['id']}/deactivate")).status_code == 200
    async with _cliente(app, perfil) as http:
        ofrecidas = {c["id"] for c in (await http.get(CATEGORIAS)).json()}
    assert {global_["id"], peruana["id"]} <= ofrecidas
    assert chilena["id"] not in ofrecidas
    # La hija de una madre inactiva no se ofrece… ni se puede usar.
    assert hija["id"] not in ofrecidas and madre["id"] not in ofrecidas
    r = await _crear(app, perfil, hija["id"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "service_category_inactive"


async def test_un_prestador_suspendido_no_sigue_escribiendo_en_su_catalogo(entorno) -> None:
    app, motor, _ = entorno
    jefa, _ = await _equipo(motor)
    perfil = await _prestador(motor)
    ident = (await _crear(app, perfil, (await _categoria(app, jefa))["id"])).json()["id"]
    await _sembrar(
        motor, "update public.service_providers set status = 'suspended', suspended_at = now() "
               "where profile_id = cast(:u as uuid)", u=perfil,
    )
    for r in (
        await _editar(app, perfil, ident, title="Otro título más largo"),
        await _imagen(app, perfil, ident),
        await _accion(app, perfil, f"{MIOS}/{ident}/draft"),
    ):
        assert r.status_code == 403 and r.json()["error"]["code"] == "service_provider_not_active", r.text
    assert await _uno(motor, "select title from public.service_versions where service_id = cast(:s as uuid)", s=ident) is None


async def test_lo_virtual_no_guarda_zona(entorno) -> None:
    app, motor, _ = entorno
    jefa, _ = await _equipo(motor)
    perfil = await _prestador(motor)
    ident = (await _crear(app, perfil, (await _categoria(app, jefa))["id"])).json()["id"]
    r = await _editar(app, perfil, ident, modality="in_person", location_area="Miraflores, Lima")
    assert r.json()["open_version"]["location_area"] == "Miraflores, Lima"
    r = await _editar(app, perfil, ident, modality="virtual")
    assert r.status_code == 200 and r.json()["open_version"]["location_area"] is None


async def test_quitar_una_imagen_borra_el_archivo_solo_despues_de_confirmar(entorno, monkeypatch) -> None:
    app, motor, almacen = entorno
    jefa, _ = await _equipo(motor)
    perfil = await _prestador(motor)
    ident = (await _crear(app, perfil, (await _categoria(app, jefa))["id"])).json()["id"]
    imagen = (await _imagen(app, perfil, ident)).json()["open_version"]["images"][0]["id"]
    antes = almacen.de("service-media", perfil)
    assert len(antes) == 1
    original = AsyncSession.commit

    async def falla(self):  # noqa: ANN001
        raise RuntimeError("la base se cayó al confirmar")

    monkeypatch.setattr(AsyncSession, "commit", falla)
    with pytest.raises(RuntimeError):
        async with _cliente(app, perfil) as http:
            await http.delete(f"{MIOS}/{ident}/draft/images/{imagen}")
    monkeypatch.setattr(AsyncSession, "commit", original)
    # La fila sigue (no se confirmó) y su archivo también.
    assert await _uno(
        motor, "select count(*) from public.service_version_images where id = cast(:i as uuid)", i=imagen
    ) == 1
    assert almacen.de("service-media", perfil) == antes
    # Y cuando sí se confirma, el archivo se va.
    async with _cliente(app, perfil) as http:
        assert (await http.delete(f"{MIOS}/{ident}/draft/images/{imagen}")).status_code == 200
    assert almacen.de("service-media", perfil) == []


async def test_con_clave_la_subida_pisa_un_archivo_huerfano_del_intento_anterior(entorno, monkeypatch) -> None:
    from app.modules.services import catalogo_imagenes

    app, motor, _ = entorno
    jefa, _ = await _equipo(motor)
    perfil = await _prestador(motor)
    ident = (await _crear(app, perfil, (await _categoria(app, jefa))["id"])).json()["id"]
    vistas: list[bool] = []
    original = catalogo_imagenes.storage.subir_objeto

    async def espia(*args, sobrescribir: bool = False, **kwargs):  # noqa: ANN002, ANN003
        vistas.append(sobrescribir)
        return await original(*args, sobrescribir=sobrescribir, **kwargs)

    monkeypatch.setattr(catalogo_imagenes.storage, "subir_objeto", espia)
    assert (await _imagen(app, perfil, ident, clave="subida-con-clave-1")).status_code == 201
    assert (await _imagen(app, perfil, ident, PNG_AZUL)).status_code == 201
    # Con clave, la ruta sale de la clave y se pisa; sin clave, la ruta es nueva.
    assert vistas == [True, False]


async def test_crear_sin_clave_no_devuelve_otro_servicio_si_la_base_protesta(entorno, monkeypatch) -> None:
    from sqlalchemy.exc import IntegrityError

    from app.modules.services import catalogo
    from app.modules.services.catalogo_models import ServiceCategory

    app, motor, _ = entorno
    jefa, _ = await _equipo(motor)
    perfil = await _prestador(motor)
    assert (await _crear(app, perfil, (await _categoria(app, jefa))["id"])).status_code == 201
    inactiva = await _categoria(app, jefa)
    async with _cliente(app, jefa) as http:
        assert (await http.post(f"{ADMIN}/categories/{inactiva['id']}/deactivate")).status_code == 200

    async def sin_mirar(db, categoria_id, prestador):  # noqa: ANN001
        return await db.get(ServiceCategory, categoria_id)

    # Como si la categoría se desactivara entre la comprobación y el INSERT: la
    # base protesta. Antes, sin clave, se devolvía el PRIMER servicio.
    monkeypatch.setattr(catalogo, "categoria_utilizable", sin_mirar)
    with pytest.raises(IntegrityError):
        await _crear(app, perfil, inactiva["id"])
    assert await _uno(
        motor, "select count(*) from public.services s join public.service_providers p on p.id = s.provider_id "
               "where p.profile_id = cast(:u as uuid)", u=perfil,
    ) == 1


async def test_un_choque_de_la_base_al_crear_categoria_no_se_llama_slug_repetido(entorno, monkeypatch) -> None:
    from sqlalchemy.exc import IntegrityError

    from app.modules.services import categorias

    app, motor, _ = entorno
    jefa, _ = await _equipo(motor)
    madre = await _categoria(app, jefa)
    hija = await _categoria(app, jefa, parent_id=madre["id"])

    async def sin_mirar(db, categoria_id, madre_id):  # noqa: ANN001
        return None

    # Tres niveles los impide la base (disparador). Sin la comprobación previa,
    # el choque NO es un slug repetido y no se disfraza de uno.
    monkeypatch.setattr(categorias, "_exigir_jerarquia", sin_mirar)
    with pytest.raises(IntegrityError):
        await _categoria(app, jefa, parent_id=hija["id"])
