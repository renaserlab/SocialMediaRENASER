"""El descubrimiento de Servicios por la API real, contra PostgreSQL (Incremento 3).

Con la base 0001–0091 desechable, el Storage en memoria y `FEATURE_SERVICES`
encendida SOLO aquí. Los servicios se publican por el flujo real del
Incremento 2 (crear, completar, subir, enviar, revisar, aprobar, publicar).

LO QUE SE COMPRUEBA: que solo sale lo público y nada privado; buscar,
filtrar, ordenar y paginar en la base; la ficha y el perfil con la confianza
que Z comprobó y ninguna reseña inventada; guardar sin duplicados; sugerencias
con una razón de verdad; los bloqueos; la puerta de la 0091; y las carreras.
"""

from __future__ import annotations

import asyncio
import json
import uuid

import pytest
import pytest_asyncio
from fastapi import Request
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.exceptions import UnauthorizedError
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.services import esquema
from tests import test_baja_de_cuenta_postgres as baja_pg
from tests.test_baja_de_cuenta_postgres import (
    API,
    SIN_POSTGRES,
    _borrar_cuenta,
    _cliente,
    _filas,
    _llevar,
    _persona,
    _sembrar,
    _uno,
)
from tests.test_servicios_catalogo_api import (
    ADMIN,
    BANDEJA,
    CONTENIDO,
    MIOS,
    _accion,
    _crear,
    _editar,
    _equipo,
    _imagen,
    _prestador,
)

pytestmark = [SIN_POSTGRES, pytest.mark.asyncio]

base_aplicada = baja_pg.base_aplicada
entorno = baja_pg.entorno

CATALOGO = f"{API}/services/catalog"
CATEGORIAS = f"{API}/services/public-categories"
SUGERENCIAS = f"{API}/services/suggestions"
PRESTADORES = f"{API}/services/providers"
GUARDADOS = f"{API}/services/saved"

#: Lo que NUNCA puede salir en una respuesta pública.
PRIVADO = (
    "storage_path", "internal_note", "visible_note", "legal_name", "tax_id", "representative_name",
    "profile_id", "number_masked", "evidence", "review_note", "decided_by", "reviewed_by",
    "published_by", "created_by", "actor", "service-media", "service-provider-documents",
)


@pytest_asyncio.fixture()
async def mundo(entorno):
    """El entorno de siempre, y además la identidad OPCIONAL: con la cabecera
    de prueba es esa persona; sin ella, anónimo."""
    app, motor, almacen = entorno

    async def _opcional(request: Request) -> AuthUser | None:
        uid = request.headers.get("x-prueba-usuario")
        return AuthUser(id=uid, email="x@y.test", role="authenticated") if uid else None

    async def _obligatoria(request: Request) -> AuthUser:
        uid = request.headers.get("x-prueba-usuario")
        if not uid:
            raise UnauthorizedError()
        return AuthUser(id=uid, email="x@y.test", role="authenticated")

    app.dependency_overrides[get_optional_user] = _opcional
    app.dependency_overrides[get_current_user] = _obligatoria
    # CADA PRUEBA, SU CATÁLOGO. La base es la misma para todo el módulo: lo
    # publicado por las anteriores deja de ser público al desactivar sus
    # categorías (lo mismo que haría administración), y los bloqueos se van.
    await _sembrar(motor, "update public.service_categories set status = 'inactive' where status = 'active'")
    await _sembrar(motor, "delete from public.user_blocks")
    yield app, motor, almacen


def _anonimo(app) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _get(app, ruta: str, uid: str | None = None, **params):
    async with (_cliente(app, uid) if uid else _anonimo(app)) as http:
        return await http.get(ruta, params={k: v for k, v in params.items() if v is not None})


async def _lista(app, uid: str | None = None, **params) -> dict:
    r = await _get(app, CATALOGO, uid, **params)
    assert r.status_code == 200, r.text
    return r.json()


def _ids(pagina: dict) -> list[str]:
    return [i["id"] for i in pagina["items"]]


def _sin_privado(cuerpo, *extra: str) -> None:
    crudo = json.dumps(cuerpo, ensure_ascii=False)
    sin_urls = json.dumps(_quitar_urls(cuerpo), ensure_ascii=False)
    for prohibido in PRIVADO + extra:
        assert prohibido not in sin_urls, prohibido
    assert "/object/sign/" not in sin_urls
    del crudo


def _quitar_urls(valor):
    if isinstance(valor, dict):
        return {k: (None if k == "url" else _quitar_urls(v)) for k, v in valor.items()}
    if isinstance(valor, list):
        return [_quitar_urls(v) for v in valor]
    return valor


async def _categoria(app, jefa: str, **datos) -> dict:
    async with _cliente(app, jefa) as http:
        r = await http.post(
            f"{ADMIN}/categories",
            json={"slug": f"cat-{uuid.uuid4().hex[:10]}", "name": "Asesoría contable", **datos},
        )
    assert r.status_code == 201, r.text
    return r.json()


async def _hasta(app, perfil: str, jefa: str, moderador: str, categoria: str, estado: str, **contenido) -> str:
    """Un servicio llevado por el flujo real hasta `estado`."""
    ident = (await _crear(app, perfil, categoria)).json()["id"]
    r = await _editar(app, perfil, ident, **{**CONTENIDO, **contenido})
    assert r.status_code == 200, r.text
    if estado == "draft":
        return ident
    assert (await _imagen(app, perfil, ident)).status_code == 201
    enviado = await _accion(app, perfil, f"{MIOS}/{ident}/draft/submit")
    assert enviado.status_code == 200, enviado.text
    if estado == "submitted":
        return ident
    base = f"{BANDEJA}/{ident}/versions/{enviado.json()['open_version']['id']}"
    assert (await _accion(app, moderador, f"{base}/start-review")).status_code == 200
    if estado == "under_review":
        return ident
    if estado == "changes_requested":
        r = await _accion(app, moderador, f"{base}/request-changes", {"note": "Aclara el alcance.", "fields": ["scope"]})
        assert r.status_code == 200, r.text
        return ident
    assert (await _accion(app, jefa, f"{base}/approve")).status_code == 200
    if estado == "approved":
        return ident
    r = await _accion(app, jefa, f"{base}/publish")
    assert r.status_code == 200, r.text
    if estado in ("suspended", "retired"):
        paso = "suspend" if estado == "suspended" else "retire"
        r = await _accion(app, jefa, f"{BANDEJA}/{ident}/{paso}", {"note": "Motivo del equipo interno."})
        assert r.status_code == 200, r.text
    return ident


async def _publicado(app, perfil, jefa, moderador, categoria, **contenido) -> str:
    return await _hasta(app, perfil, jefa, moderador, categoria, "published", **contenido)


# =========================================================================== #
# 1. Solo lo público
# =========================================================================== #
async def test_solo_sale_lo_publicado_de_un_prestador_activo_en_una_categoria_activa(mundo) -> None:
    app, motor, _ = mundo
    jefa, moderador = await _equipo(motor)
    categoria = (await _categoria(app, jefa))["id"]
    perfil = await _prestador(motor)
    visible = await _publicado(app, perfil, jefa, moderador, categoria, title="Servicio visible del catálogo")
    ocultos = {
        estado: await _hasta(app, perfil, jefa, moderador, categoria, estado, title=f"Oculto {estado}")
        for estado in ("draft", "submitted", "under_review", "changes_requested", "approved", "suspended", "retired")
    }
    # Un prestador que luego se suspende.
    suspendido = await _prestador(motor)
    de_suspendido = await _publicado(app, suspendido, jefa, moderador, categoria, title="De un prestador suspendido")
    await _sembrar(motor, "update public.service_providers set status = 'suspended', suspended_at = now() "
                          "where profile_id = cast(:u as uuid)", u=suspendido)
    # Una categoría que se desactiva DESPUÉS de publicar, y una madre inactiva.
    inactiva = (await _categoria(app, jefa))["id"]
    en_inactiva = await _publicado(app, perfil, jefa, moderador, inactiva, title="En una categoría desactivada")
    assert (await _accion(app, jefa, f"{ADMIN}/categories/{inactiva}/deactivate")).status_code == 200
    madre = (await _categoria(app, jefa))["id"]
    hija = (await _categoria(app, jefa, parent_id=madre))["id"]
    bajo_madre = await _publicado(app, perfil, jefa, moderador, hija, title="Bajo una madre desactivada")
    assert (await _accion(app, jefa, f"{ADMIN}/categories/{madre}/deactivate")).status_code == 200
    # Una categoría de OTRO país (si la base lo permitiera por un cambio posterior).
    otro_pais = (await _categoria(app, jefa))["id"]
    de_otro_pais = await _publicado(app, perfil, jefa, moderador, otro_pais, title="Categoría de otro país")
    await _sembrar(motor, "update public.service_categories set country_code = 'CL' where id = cast(:c as uuid)",
                   c=otro_pais)

    # Publicados con una versión NUEVA en curso (borrador, y otra en revisión):
    # se ven UNA vez y con lo publicado; lo que está en curso no sale.
    assert (await _accion(app, perfil, f"{MIOS}/{visible}/draft")).status_code == 201
    assert (await _editar(app, perfil, visible, title="Borrador en curso sin publicar")).status_code == 200
    en_revision = await _publicado(app, perfil, jefa, moderador, categoria, title="Publicado con revisión en curso")
    v2 = (await _accion(app, perfil, f"{MIOS}/{en_revision}/draft")).json()["open_version"]["id"]
    assert (await _editar(app, perfil, en_revision, title="Versión en revisión sin publicar")).status_code == 200
    assert (await _accion(app, perfil, f"{MIOS}/{en_revision}/draft/submit")).status_code == 200
    base = f"{BANDEJA}/{en_revision}/versions/{v2}"
    assert (await _accion(app, moderador, f"{base}/start-review")).status_code == 200

    pagina = await _lista(app, limit=50)
    assert sorted(_ids(pagina)) == sorted([visible, en_revision]), [i["title"] for i in pagina["items"]]
    assert {i["title"] for i in pagina["items"]} == {"Servicio visible del catálogo", "Publicado con revisión en curso"}
    assert _ids(await _lista(app, q="sin publicar")) == []
    assert (await _get(app, f"{CATALOGO}/{visible}")).json()["title"] == "Servicio visible del catálogo"
    _sin_privado(pagina, "Motivo del equipo", "Aclara el alcance")
    # La portada sale SIEMPRE como URL firmada, nunca como la ruta del depósito.
    for item in pagina["items"]:
        assert "/object/sign/" in item["cover"]["url"] and "token=" in item["cover"]["url"], item["cover"]
        assert perfil not in item["cover"]["url"].split("/object/sign/")[0]
    for ident in [*ocultos.values(), de_suspendido, en_inactiva, bajo_madre, de_otro_pais]:
        r = await _get(app, f"{CATALOGO}/{ident}")
        assert r.status_code == 404 and r.json()["error"]["code"] == "service_not_found", ident
    # Quien lo ofrece NO ve «publicado y visible» en lo que la categoría inactiva
    # sacó del público: lo decide la misma autoridad.
    async with _cliente(app, perfil) as http:
        for ident in (en_inactiva, bajo_madre):
            privado = (await http.get(f"{MIOS}/{ident}")).json()
            assert privado["status"] == "published" and privado["publicly_visible"] is False, ident
        assert (await http.get(f"{MIOS}/{visible}")).json()["publicly_visible"] is True
    # Las categorías que se ofrecen como filtro: solo la que tiene algo público.
    categorias = (await _get(app, CATEGORIAS)).json()
    assert [c["id"] for c in categorias] == [categoria]
    # Ni buscando por su título.
    assert _ids(await _lista(app, q="oculto")) == []
    assert _ids(await _lista(app, q="suspendido")) == []


# =========================================================================== #
# 2. Búsqueda
# =========================================================================== #
async def test_buscar_por_titulo_categoria_descripcion_prestador_y_zona(mundo) -> None:
    app, motor, _ = mundo
    jefa, moderador = await _equipo(motor)
    legal = (await _categoria(app, jefa, name="Orientación legal", name_en="Legal advice"))["id"]
    hogar = (await _categoria(app, jefa, name="Reparaciones del hogar"))["id"]
    ana = await _prestador(motor)
    luis = await _prestador(motor)
    await _sembrar(motor, "update public.service_providers set display_name = 'Carpintería Ruiz' "
                          "where profile_id = cast(:u as uuid)", u=luis)
    por_titulo = await _publicado(app, ana, jefa, moderador, legal, title="Contabilidad tributaria para pymes",
                                  description="Una sesión para revisar tus obligaciones fiscales del mes.")
    por_descripcion = await _publicado(
        app, ana, jefa, moderador, legal, title="Revisión de contratos",
        description="Incluye una revisión de la contabilidad del último trimestre y sus riesgos.",
    )
    por_prestador = await _publicado(
        app, luis, jefa, moderador, hogar, title="Arreglo de muebles", modality="at_home",
        location_area="Miraflores, Lima", description="Visita a domicilio para reparar muebles de madera.",
    )

    # Mayúsculas, tildes y espacios repetidos no cambian nada.
    for consulta in ("contabilidad", "CONTABILIDAD", "contabilidád", "  contabilidad   "):
        assert set(_ids(await _lista(app, q=consulta))) == {por_titulo, por_descripcion}, consulta
    # El título pesa más que la descripción, y la respuesta dice dónde coincidió.
    pagina = await _lista(app, q="contabilidad")
    assert _ids(pagina) == [por_titulo, por_descripcion]
    assert pagina["sort"] == "relevance"
    assert pagina["items"][0]["reason"] == "matches_search" and "title" in pagina["items"][0]["reason_fields"]
    assert pagina["items"][1]["reason_fields"] == ["description"]
    # Categoría (y su nombre en inglés), prestador, zona y modalidad.
    assert set(_ids(await _lista(app, q="orientacion"))) == {por_titulo, por_descripcion}
    assert set(_ids(await _lista(app, q="legal advice"))) == {por_titulo, por_descripcion}
    assert _ids(await _lista(app, q="carpinteria")) == [por_prestador]
    assert _ids(await _lista(app, q="miraflores")) == [por_prestador]
    assert _ids(await _lista(app, q="a domicilio")) == [por_prestador]
    # Varias palabras: TODAS tienen que aparecer en algún sitio.
    assert _ids(await _lista(app, q="contabilidad pymes")) == [por_titulo]
    assert _ids(await _lista(app, q="contabilidad muebles")) == []
    # Una letra no es una búsqueda.
    r = await _get(app, CATALOGO, q="a")
    assert r.status_code == 422 and r.json()["error"]["code"] == "service_catalog_query_too_short"
    # El guion bajo NO es un comodín: «____» no trae el catálogo entero ni
    # inventa dónde coincidió; «contabilidad__» es «contabilidad».
    for consulta in ("____", "a_b"):
        r = await _get(app, CATALOGO, q=consulta)
        assert r.status_code == 422 and r.json()["error"]["code"] == "service_catalog_query_too_short", consulta
    assert set(_ids(await _lista(app, q="contabilidad__"))) == {por_titulo, por_descripcion}
    r = await _get(app, CATALOGO, area="__")
    assert r.status_code == 422 and r.json()["error"]["code"] == "service_catalog_filter_invalid"
    # La modalidad, también en plural (y sin que el texto la nombre).
    assert _ids(await _lista(app, q="arreglos presenciales")) == []


async def test_tildes_en_palabras_cortas_y_relevancia_dominante(mundo) -> None:
    app, motor, _ = mundo
    jefa, moderador = await _equipo(motor)
    categoria = (await _categoria(app, jefa, name="Diseño gráfico"))["id"]
    otra = (await _categoria(app, jefa, name="Negocio"))["id"]
    ana = await _prestador(motor)
    cafe = await _publicado(app, ana, jefa, moderador, otra, title="Cata de café de especialidad")
    peru = await _publicado(app, ana, jefa, moderador, otra, title="Rutas por el Perú profundo")
    diseno = await _publicado(app, ana, jefa, moderador, categoria, title="Identidad para marcas")
    # Tildes y eñe en palabras cortas, en los dos sentidos.
    for consulta, esperado in (("cafe", cafe), ("CAFÉ", cafe), ("peru", peru), ("PERÚ", peru),
                               ("diseno grafico", diseno), ("diseño", diseno)):
        assert _ids(await _lista(app, q=consulta)) == [esperado], consulta
    # «virtuales» es la modalidad virtual aunque ningún texto diga «virtual».
    assert _ids(await _lista(app, q="cata virtuales")) == [cafe]
    # EL TÍTULO MANDA: uno que solo coincide en el título va antes que otro que
    # coincide en la categoría, el resumen y la descripción a la vez.
    solo_titulo = await _publicado(app, ana, jefa, moderador, otra, title="Asesoría en marketing digital",
                                   summary="Una sesión para ordenar tus campañas del mes.",
                                   description="Revisamos tus anuncios y te dejamos un plan claro para seguir.")
    marketing = (await _categoria(app, jefa, name="Marketing"))["id"]
    tres_sitios = await _publicado(app, ana, jefa, moderador, marketing, title="Plan de redes para tu negocio",
                                   summary="Marketing de contenidos para pequeños negocios del barrio.",
                                   description="Una sesión de marketing para ordenar tus publicaciones.")
    pagina = await _lista(app, q="marketing")
    assert _ids(pagina) == [solo_titulo, tres_sitios], [i["title"] for i in pagina["items"]]
    assert set(pagina["items"][1]["reason_fields"]) == {"category", "summary", "description"}


# =========================================================================== #
# 3. Filtros
# =========================================================================== #
async def test_filtros_combinados_sin_mezclar_monedas(mundo, monkeypatch) -> None:
    app, motor, _ = mundo
    monkeypatch.setattr(get_settings(), "services_catalog_currencies", "PEN,USD")
    jefa, moderador = await _equipo(motor)
    madre = (await _categoria(app, jefa, name="Bienestar"))["id"]
    hija = (await _categoria(app, jefa, name="Nutrición", parent_id=madre))["id"]
    otra = (await _categoria(app, jefa, name="Negocio"))["id"]
    ana = await _prestador(motor)
    gratis = await _publicado(app, ana, jefa, moderador, hija, title="Charla gratuita de nutrición",
                              price_model="free", price_minor=None, currency=None)
    consulta = await _publicado(app, ana, jefa, moderador, hija, title="Plan a consultar",
                                price_model="on_request", price_minor=None, currency=None)
    soles = await _publicado(app, ana, jefa, moderador, otra, title="Asesoría en soles", price_minor=15000,
                             modality="in_person", location_area="San Isidro, Lima")
    dolares = await _publicado(app, ana, jefa, moderador, otra, title="Asesoría en dólares", price_minor=5000,
                               currency="USD")

    # La madre incluye a sus hijas.
    assert set(_ids(await _lista(app, category_id=madre))) == {gratis, consulta}
    assert set(_ids(await _lista(app, category_id=hija))) == {gratis, consulta}
    # Gratis, a consultar y con importe: tres cosas distintas.
    assert _ids(await _lista(app, price="free")) == [gratis]
    assert _ids(await _lista(app, price="on_request")) == [consulta]
    assert set(_ids(await _lista(app, price="priced"))) == {soles, dolares}
    # Moneda: nunca se mezclan ni se convierten.
    assert _ids(await _lista(app, currency="PEN")) == [soles]
    assert _ids(await _lista(app, currency="usd")) == [dolares]
    assert _ids(await _lista(app, currency="PEN", min_price=10000, max_price=20000)) == [soles]
    assert _ids(await _lista(app, currency="PEN", max_price=10000)) == []
    # Modalidad, zona y combinados.
    assert _ids(await _lista(app, modality="in_person")) == [soles]
    assert _ids(await _lista(app, area="san isidro")) == [soles]
    assert _ids(await _lista(app, category_id=otra, modality="virtual", currency="USD")) == [dolares]
    assert _ids(await _lista(app, category_id=otra, modality="in_person", currency="USD")) == []
    # Limpiar los filtros devuelve todo.
    assert set(_ids(await _lista(app))) == {gratis, consulta, soles, dolares}

    for params, codigo in (
        ({"min_price": 100}, "service_catalog_currency_required"),
        ({"sort": "price_asc"}, "service_catalog_currency_required"),
        ({"price": "free", "currency": "PEN"}, "service_catalog_filter_invalid"),
        ({"currency": "PEN", "min_price": 500, "max_price": 100}, "service_catalog_filter_invalid"),
        ({"modality": "hybrid"}, "service_catalog_filter_invalid"),
        ({"category_id": "no-es-un-id"}, "service_catalog_filter_invalid"),
        ({"sort": "popular"}, "service_catalog_filter_invalid"),
        ({"price": "cheap"}, "service_catalog_filter_invalid"),
    ):
        r = await _get(app, CATALOGO, **params)
        assert r.status_code == 422 and r.json()["error"]["code"] == codigo, (params, r.text)


async def test_credencial_verificada_publica_y_privada(mundo) -> None:
    """La confianza sale de la admisión REAL: identidad aceptada y credencial
    verificada. Del detalle de la credencial, nada."""
    app, motor, _ = mundo
    jefa, moderador = await _equipo(motor)
    categoria = (await _categoria(app, jefa))["id"]
    verificada = await _persona(motor)
    await _llevar(app, verificada, "approved", jefa=jefa, moderador=moderador)
    sin = await _prestador(motor)
    con = await _publicado(app, verificada, jefa, moderador, categoria, title="Con credencial verificada")
    sin_credencial = await _publicado(app, sin, jefa, moderador, categoria, title="Sin credencial")

    assert _ids(await _lista(app, credential_verified="true")) == [con]
    ficha = (await _get(app, f"{CATALOGO}/{con}")).json()
    assert ficha["provider"]["trust"] == {
        "admitted_since": ficha["provider"]["trust"]["admitted_since"], "identity_verified": True,
        "credential_verified": True,
    } and ficha["provider"]["trust"]["admitted_since"]
    # Nada del detalle: ni el título, ni el emisor, ni el número.
    _sin_privado(ficha, "Colegiatura", "PSI-2020", "4587", "Colegio")
    assert (await _get(app, f"{CATALOGO}/{sin_credencial}")).json()["provider"]["trust"]["credential_verified"] is False
    # Vencida deja de contar, aunque siga «verificada».
    await _sembrar(
        motor, "update public.service_provider_credentials set expires_on = current_date - 1 "
               "where provider_id = (select id from public.service_providers where profile_id = cast(:u as uuid))",
        u=verificada,
    )
    assert _ids(await _lista(app, credential_verified="true")) == []
    assert (await _get(app, f"{CATALOGO}/{con}")).json()["provider"]["trust"]["credential_verified"] is False
    # Vigente otra vez, pero RECHAZADA (o solo declarada): tampoco cuenta.
    for estado in ("rejected", "declared"):
        await _sembrar(
            motor, "update public.service_provider_credentials set expires_on = current_date + 30, status = :e, "
                   "review_note = case when :e = 'rejected' then 'No coincide con el registro.' end, "
                   "verified_at = null, verified_by = null "
                   "where provider_id = (select id from public.service_providers where profile_id = cast(:u as uuid))",
            u=verificada, e=estado,
        )
        assert _ids(await _lista(app, credential_verified="true")) == [], estado
        assert (await _get(app, f"{CATALOGO}/{con}")).json()["provider"]["trust"]["credential_verified"] is False


# =========================================================================== #
# 4. Orden y cursor
# =========================================================================== #
async def test_cursor_estable_en_cada_orden(mundo) -> None:
    app, motor, _ = mundo
    jefa, moderador = await _equipo(motor)
    categoria = (await _categoria(app, jefa))["id"]
    ana = await _prestador(motor)
    idents = []
    for n, precio in enumerate((9000, 12000, 12000, 5000, 20000, 12000, 7000)):
        idents.append(await _publicado(app, ana, jefa, moderador, categoria, title=f"Asesoría número {n}",
                                       price_minor=precio))
    # Empates a propósito: la misma fecha de publicación y el mismo precio.
    await _sembrar(motor, "update public.services set first_published_at = timestamptz '2026-09-01 10:00:00+00' "
                          "where id = any(cast(:ids as uuid[]))", ids=idents[:4])

    for orden, extra in (("recent", {}), ("price_asc", {"currency": "PEN"}), ("price_desc", {"currency": "PEN"}),
                         ("relevance", {"q": "asesoria"})):
        vistos, cursor = [], None
        for _ in range(10):
            pagina = await _lista(app, sort=orden, limit=2, cursor=cursor, **extra)
            vistos += _ids(pagina)
            cursor = pagina["next_cursor"]
            if not cursor:
                break
        assert sorted(vistos) == sorted(idents) and len(vistos) == len(set(vistos)), orden
        # Y en SU orden, página a página igual que de una vez.
        de_una_vez = await _lista(app, sort=orden, limit=50, **extra)
        assert vistos == _ids(de_una_vez), orden
        precios = [i["price"]["amount_minor"] for i in de_una_vez["items"]]
        if orden == "price_asc":
            assert precios == sorted(precios)
        if orden == "price_desc":
            assert precios == sorted(precios, reverse=True)
    # Relevancia con puntuaciones DISTINTAS entre páginas: el título primero.
    fuerte = await _publicado(app, ana, jefa, moderador, categoria, title="Asesoría contable completa")
    flojo = await _publicado(app, ana, jefa, moderador, categoria, title="Otro servicio",
                             description="Incluye una asesoría breve sobre cuentas y un repaso contable.")
    vistos, cursor = [], None
    for _ in range(10):
        pagina = await _lista(app, q="asesoria contable", limit=1, cursor=cursor)
        vistos += _ids(pagina)
        cursor = pagina["next_cursor"]
        if not cursor:
            break
    assert vistos[0] == fuerte and vistos[-1] == flojo and len(vistos) == len(set(vistos)), vistos
    # Un cursor de otro orden, o basura, es un 422 y no una página cualquiera.
    otro = (await _lista(app, sort="recent", limit=2))["next_cursor"]
    for malo in (otro, "basura", "eyJvIjoicmVjZW50In0"):
        r = await _get(app, CATALOGO, sort="price_asc", currency="PEN", cursor=malo)
        assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_cursor", malo


async def test_publicar_mientras_se_pagina_no_repite_ni_salta(mundo) -> None:
    app, motor, _ = mundo
    jefa, moderador = await _equipo(motor)
    categoria = (await _categoria(app, jefa))["id"]
    ana = await _prestador(motor)
    viejos = [await _publicado(app, ana, jefa, moderador, categoria, title=f"Viejo {n}") for n in range(4)]
    primera = await _lista(app, limit=2)
    nuevo = await _publicado(app, ana, jefa, moderador, categoria, title="Recién llegado")
    segunda = await _lista(app, limit=10, cursor=primera["next_cursor"])
    vistos = _ids(primera) + _ids(segunda)
    assert sorted(vistos) == sorted(viejos) and nuevo not in vistos
    assert _ids(await _lista(app, limit=1)) == [nuevo]


# =========================================================================== #
# 5. La ficha, el perfil y las reseñas
# =========================================================================== #
async def test_ficha_y_perfil_sin_nada_privado_ni_resenas_inventadas(mundo) -> None:
    app, motor, _ = mundo
    jefa, moderador = await _equipo(motor)
    categoria = (await _categoria(app, jefa))["id"]
    otra_categoria = (await _categoria(app, jefa, name="Otra"))["id"]
    ana = await _prestador(motor)
    bea = await _prestador(motor)
    principal = await _publicado(app, ana, jefa, moderador, categoria, title="Principal", modality="in_person",
                                 location_area="Barranco")
    hermano = await _publicado(app, ana, jefa, moderador, otra_categoria, title="Del mismo prestador")
    vecino = await _publicado(app, bea, jefa, moderador, categoria, title="De la misma categoría")
    # Una reseña de PERFIL, del sistema transversal: no es de este servicio.
    alguien = await _persona(motor)
    await _sembrar(
        motor, "insert into public.profile_reviews (reviewer_id, reviewed_user_id, body, verified_source) "
               "values (cast(:a as uuid), cast(:b as uuid), 'Muy buena atención.', 'booking')",
        a=alguien, b=ana,
    )
    ficha = (await _get(app, f"{CATALOGO}/{principal}")).json()
    assert ficha["reviews"] == {"count": 0, "average": None}
    assert ficha["approved_by_z"] is True and ficha["saved"] is False
    assert [(i["id"], i["reason"]) for i in ficha["more_from_provider"]] == [(hermano, "same_provider")]
    assert [(i["id"], i["reason"]) for i in ficha["related"]] == [(vecino, "same_category")]
    assert ficha["provider"]["trust"]["identity_verified"] is False  # sembrado sin admisión
    _sin_privado(ficha, "Muy buena atención", ana)

    # La propia prestadora no ve «más de este prestador» sobre lo suyo.
    assert (await _get(app, f"{CATALOGO}/{principal}", ana)).json()["more_from_provider"] == []

    proveedor = ficha["provider"]["id"]
    perfil = (await _get(app, f"{PRESTADORES}/{proveedor}")).json()
    assert perfil["display_name"] == "Estudio Álvarez" and perfil["provider_type"] == "individual"
    assert perfil["reviews"] == {"count": 0, "average": None}
    assert {c["id"] for c in perfil["categories"]} == {categoria, otra_categoria}
    assert perfil["modalities"] == ["virtual", "in_person"] and perfil["areas"] == ["Barranco"]
    _sin_privado(perfil, ana, "PE")
    servicios = (await _get(app, f"{PRESTADORES}/{proveedor}/services", limit=1)).json()
    assert len(servicios["items"]) == 1 and servicios["next_cursor"]
    resto = (await _get(app, f"{PRESTADORES}/{proveedor}/services", cursor=servicios["next_cursor"])).json()
    assert {i["id"] for i in servicios["items"] + resto["items"]} == {principal, hermano}
    # Un prestador sin nada público no existe hacia fuera.
    for s in (principal, hermano):
        assert (await _accion(app, jefa, f"{BANDEJA}/{s}/suspend", {"note": "Revisión."})).status_code == 200
    for ruta in (f"{PRESTADORES}/{proveedor}", f"{PRESTADORES}/{proveedor}/services",
                 f"{PRESTADORES}/{uuid.uuid4()}", f"{PRESTADORES}/no-es-un-id"):
        r = await _get(app, ruta)
        assert r.status_code == 404 and r.json()["error"]["code"] == "service_provider_not_found", ruta


# =========================================================================== #
# 6. Guardados
# =========================================================================== #
async def test_guardar_quitar_y_la_lista_propia(mundo) -> None:
    app, motor, _ = mundo
    jefa, moderador = await _equipo(motor)
    categoria = (await _categoria(app, jefa))["id"]
    ana = await _prestador(motor)
    uno = await _publicado(app, ana, jefa, moderador, categoria, title="Uno")
    dos = await _publicado(app, ana, jefa, moderador, categoria, title="Dos")
    borrador = await _hasta(app, ana, jefa, moderador, categoria, "draft", title="Borrador")
    lucia, pedro = await _persona(motor), await _persona(motor)
    avisos_antes = await _uno(motor, "select count(*) from public.notifications where user_id = cast(:u as uuid)", u=ana)

    async with _cliente(app, lucia) as http:
        for _ in range(2):
            r = await http.post(f"{CATALOGO}/{uno}/save")
            assert r.status_code == 200 and r.json() == {"saved": True}
        assert (await http.post(f"{CATALOGO}/{dos}/save")).status_code == 200
        r = await http.post(f"{CATALOGO}/{borrador}/save")
        assert r.status_code == 404 and r.json()["error"]["code"] == "service_not_found"
        assert (await http.post(f"{CATALOGO}/no-es-un-id/save")).status_code == 404
    assert await _uno(motor, "select count(*) from public.saved_services where profile_id = cast(:u as uuid)",
                      u=lucia) == 2
    # Sin sesión, el comportamiento estándar.
    async with _anonimo(app) as http:
        assert (await http.post(f"{CATALOGO}/{uno}/save")).status_code in (401, 403)
    # Guardar no avisa a nadie y no se cuenta en ninguna parte pública.
    assert await _uno(motor, "select count(*) from public.notifications where user_id = cast(:u as uuid)",
                      u=ana) == avisos_antes
    ficha = (await _get(app, f"{CATALOGO}/{uno}", lucia)).json()
    assert ficha["saved"] is True and "saves" not in json.dumps(ficha) and "count\": 1" not in json.dumps(ficha)
    assert (await _get(app, f"{CATALOGO}/{uno}", pedro)).json()["saved"] is False
    assert [i["saved"] for i in (await _lista(app, lucia, q="uno"))["items"]] == [True]
    # Cada cual ve SOLO lo suyo.
    lista = (await _get(app, GUARDADOS, lucia)).json()
    assert [i["service_id"] for i in lista["items"]] == [dos, uno]
    assert (await _get(app, GUARDADOS, pedro)).json()["items"] == []
    # Lo que deja de estar disponible sigue en la lista, sin contenido.
    assert (await _accion(app, jefa, f"{BANDEJA}/{uno}/suspend", {"note": "Revisión."})).status_code == 200
    lista = (await _get(app, GUARDADOS, lucia)).json()
    suspendido = next(i for i in lista["items"] if i["service_id"] == uno)
    assert suspendido == {"service_id": uno, "saved_at": suspendido["saved_at"], "available": False,
                          "title": "Uno", "service": None}
    assert next(i for i in lista["items"] if i["service_id"] == dos)["available"] is True
    # Mientras sigue suspendido se publica una versión NUEVA (publicar no
    # reactiva): su título nunca fue público y NO puede salir en la lista.
    v2 = (await _accion(app, ana, f"{MIOS}/{uno}/draft")).json()["open_version"]["id"]
    assert (await _editar(app, ana, uno, title="Título que nunca fue público")).status_code == 200
    assert (await _accion(app, ana, f"{MIOS}/{uno}/draft/submit")).status_code == 200
    base = f"{BANDEJA}/{uno}/versions/{v2}"
    for paso, quien in (("start-review", moderador), ("approve", jefa), ("publish", jefa)):
        assert (await _accion(app, quien, f"{base}/{paso}")).status_code == 200, paso
    lista = (await _get(app, GUARDADOS, lucia)).json()
    assert next(i for i in lista["items"] if i["service_id"] == uno)["title"] == "Uno"
    assert "nunca fue público" not in json.dumps(lista, ensure_ascii=False)
    # Si la prestadora bloquea a Lucía, lo guardado deja de estar disponible y
    # conserva el título que tenía; nada de lo que cambie después.
    await _sembrar(motor, "insert into public.user_blocks (blocker_id, blocked_id) values "
                          "(cast(:a as uuid), cast(:b as uuid))", a=ana, b=lucia)
    bloqueado = next(i for i in (await _get(app, GUARDADOS, lucia)).json()["items"] if i["service_id"] == dos)
    assert bloqueado["available"] is False and bloqueado["title"] == "Dos" and bloqueado["service"] is None
    await _sembrar(motor, "delete from public.user_blocks")
    # Quitar: idempotente, y vale aunque ya no sea público.
    async with _cliente(app, lucia) as http:
        for _ in range(2):
            r = await http.delete(f"{CATALOGO}/{uno}/save")
            assert r.status_code == 200 and r.json() == {"saved": False}
    assert [i["service_id"] for i in (await _get(app, GUARDADOS, lucia)).json()["items"]] == [dos]
    # La baja de la cuenta se lleva su lista.
    assert (await _borrar_cuenta(app, lucia)).status_code == 204
    assert await _uno(motor, "select count(*) from public.saved_services where profile_id = cast(:u as uuid)",
                      u=lucia) == 0


async def test_guardar_a_la_vez_y_guardar_y_quitar_a_la_vez(mundo) -> None:
    app, motor, _ = mundo
    jefa, moderador = await _equipo(motor)
    categoria = (await _categoria(app, jefa))["id"]
    ident = await _publicado(app, await _prestador(motor), jefa, moderador, categoria, title="Concurrido")
    quien = await _persona(motor)

    async def _hacer(metodo: str):
        async with _cliente(app, quien) as http:
            return await http.request(metodo, f"{CATALOGO}/{ident}/save")

    respuestas = await asyncio.gather(*(_hacer("POST") for _ in range(4)))
    assert [r.status_code for r in respuestas] == [200] * 4, [r.text for r in respuestas]
    assert await _uno(motor, "select count(*) from public.saved_services where profile_id = cast(:u as uuid)",
                      u=quien) == 1
    respuestas = await asyncio.gather(_hacer("POST"), _hacer("DELETE"), _hacer("POST"), _hacer("DELETE"))
    assert all(r.status_code == 200 for r in respuestas), [r.text for r in respuestas]
    assert await _uno(motor, "select count(*) from public.saved_services where profile_id = cast(:u as uuid)",
                      u=quien) in (0, 1)


# =========================================================================== #
# 7. Sugerencias con razón
# =========================================================================== #
async def test_sugerencias_solo_con_una_razon_de_verdad(mundo) -> None:
    app, motor, _ = mundo
    jefa, moderador = await _equipo(motor)
    cocina = (await _categoria(app, jefa, name="Cocina"))["id"]
    legal = (await _categoria(app, jefa, name="Legal"))["id"]
    ana, bea = await _prestador(motor), await _prestador(motor)
    viejo = await _publicado(app, ana, jefa, moderador, legal, title="Viejo legal")
    guardado = await _publicado(app, ana, jefa, moderador, cocina, title="Cocina guardada")
    parecido = await _publicado(app, bea, jefa, moderador, cocina, title="Cocina parecida")
    todos = [viejo, guardado, parecido]
    # Nada es reciente: sin guardados, NO HAY sugerencias (no se rellena).
    await _sembrar(motor, "update public.services set first_published_at = now() - interval '90 days' "
                          "where id = any(cast(:ids as uuid[]))", ids=todos)
    lucia = await _persona(motor)
    assert (await _get(app, SUGERENCIAS, lucia)).json() == {"sections": []}
    assert (await _get(app, SUGERENCIAS)).json() == {"sections": []}
    # Guarda uno de cocina: sale lo parecido, con su razón, y no lo guardado.
    async with _cliente(app, lucia) as http:
        assert (await http.post(f"{CATALOGO}/{guardado}/save")).status_code == 200
    secciones = (await _get(app, SUGERENCIAS, lucia)).json()["sections"]
    assert [(s["reason"], [i["id"] for i in s["items"]]) for s in secciones] == [("similar_to_saved", [parecido])]
    assert secciones[0]["items"][0]["reason"] == "similar_to_saved"
    # Algo reciente: sale con su razón, y nunca lo propio de quien mira.
    nuevo = await _publicado(app, bea, jefa, moderador, legal, title="Nuevo legal")
    secciones = (await _get(app, SUGERENCIAS, lucia)).json()["sections"]
    assert secciones[-1]["reason"] == "recently_published" and [i["id"] for i in secciones[-1]["items"]] == [nuevo]
    de_bea = (await _get(app, f"{CATALOGO}/{nuevo}")).json()["provider"]["id"]
    propias = (await _get(app, SUGERENCIAS, bea)).json()["sections"]
    assert all(i["provider"]["id"] != de_bea for s in propias for i in s["items"])
    # Cada tarjeta, con razón; y ninguna repetida entre secciones.
    ids = [i["id"] for s in secciones for i in s["items"]]
    assert len(ids) == len(set(ids)) and all(i["reason"] for s in secciones for i in s["items"])


# =========================================================================== #
# 8. Bloqueos, bandera y puerta
# =========================================================================== #
async def test_quien_bloquea_o_esta_bloqueado_no_ve_ni_es_visto(mundo) -> None:
    app, motor, _ = mundo
    jefa, moderador = await _equipo(motor)
    categoria = (await _categoria(app, jefa))["id"]
    ana = await _prestador(motor)
    ident = await _publicado(app, ana, jefa, moderador, categoria, title="De Ana")
    proveedor = (await _get(app, f"{CATALOGO}/{ident}")).json()["provider"]["id"]
    quien = await _persona(motor)
    for bloqueador, bloqueado in ((quien, ana), (ana, quien)):
        await _sembrar(motor, "delete from public.user_blocks")
        await _sembrar(motor, "insert into public.user_blocks (blocker_id, blocked_id) values "
                              "(cast(:a as uuid), cast(:b as uuid))", a=bloqueador, b=bloqueado)
        assert _ids(await _lista(app, quien)) == []
        assert (await _get(app, f"{CATALOGO}/{ident}", quien)).status_code == 404
        assert (await _get(app, f"{PRESTADORES}/{proveedor}", quien)).status_code == 404
    # Para los demás, sigue ahí.
    assert _ids(await _lista(app)) == [ident]


async def test_con_la_bandera_apagada_nada_del_descubrimiento_responde(mundo, monkeypatch) -> None:
    app, motor, _ = mundo
    monkeypatch.setattr(get_settings(), "feature_services", False)
    esquema.olvidar()
    quien = await _persona(motor)
    ident = str(uuid.uuid4())
    for metodo, ruta in (
        ("GET", CATALOGO), ("GET", CATEGORIAS), ("GET", SUGERENCIAS), ("GET", f"{PRESTADORES}/{ident}"),
        ("GET", f"{PRESTADORES}/{ident}/services"), ("GET", GUARDADOS), ("POST", f"{CATALOGO}/{ident}/save"),
        ("DELETE", f"{CATALOGO}/{ident}/save"), ("GET", f"{CATALOGO}/{ident}"),
    ):
        async with _cliente(app, quien) as http:
            r = await http.request(metodo, ruta)
        assert r.status_code == 503 and r.json()["error"]["code"] == "services_disabled", (metodo, ruta)


async def _puerta_de_guardados(motor, *cambios: str) -> bool:
    esquema.olvidar()
    async with motor.connect() as conexion:
        transaccion = await conexion.begin()
        try:
            for sql in cambios:
                await conexion.execute(text(sql))
            sesion = AsyncSession(bind=conexion)
            try:
                return await esquema.hay_guardados(sesion)
            finally:
                await sesion.close()
        finally:
            await transaccion.rollback()
            esquema.olvidar()


async def test_la_puerta_de_los_guardados_mira_lo_que_hace_falta(mundo) -> None:
    _, motor, _ = mundo
    assert await _puerta_de_guardados(motor) is True
    for cambios in (
        ("drop table public.saved_services",),
        ("alter table public.saved_services drop constraint saved_services_pkey",),
        ("alter table public.saved_services drop constraint saved_services_pkey",
         "alter table public.saved_services add constraint saved_services_pkey primary key (service_id, profile_id)"),
        ("alter table public.saved_services drop constraint saved_services_service_id_fkey",
         "alter table public.saved_services add constraint saved_services_service_id_fkey "
         "foreign key (service_id) references public.services(id) on delete restrict"),
        ("drop index public.saved_services_mios",),
        ("alter table public.saved_services disable row level security",),
        ("alter table public.saved_services drop column created_at",),
        # Las dos claves a la MISMA tabla no son «una a cada una».
        ("alter table public.saved_services drop constraint saved_services_profile_id_fkey",
         "alter table public.saved_services add constraint saved_services_profile_id_fkey "
         "foreign key (service_id) references public.services(id) on delete cascade"),
        # Una columna con otro tipo.
        ("alter table public.saved_services alter column title_at_save type varchar(20)",),
        # Nulable, o sin el `now()` del que depende guardar (sería un 500).
        ("alter table public.saved_services alter column title_at_save drop not null",),
        ("alter table public.saved_services alter column created_at drop default",),
        # El título: sin comprobación, con otro límite o sin validar.
        ("alter table public.saved_services drop constraint saved_services_titulo",),
        ("alter table public.saved_services drop constraint saved_services_titulo",
         "alter table public.saved_services add constraint saved_services_titulo "
         "check (length(trim(title_at_save)) between 1 and 3000)"),
        ("alter table public.saved_services drop constraint saved_services_titulo",
         "alter table public.saved_services add constraint saved_services_titulo "
         "check (length(trim(title_at_save)) between 1 and 300) not valid"),
        # Una clave ajena sin validar.
        ("alter table public.saved_services drop constraint saved_services_service_id_fkey",
         "alter table public.saved_services add constraint saved_services_service_id_fkey "
         "foreign key (service_id) references public.services(id) on delete cascade not valid"),
        # Los índices, por definición: otro orden, otras columnas, parcial,
        # único (dos personas no podrían guardar lo mismo), de otro tipo o no válido.
        ("drop index public.saved_services_mios",
         "create index saved_services_mios on public.saved_services (profile_id, created_at, service_id)"),
        ("drop index public.saved_services_del_servicio",
         "create index saved_services_del_servicio on public.saved_services (profile_id)"),
        ("drop index public.saved_services_del_servicio",
         "create index saved_services_del_servicio on public.saved_services (service_id) where title_at_save <> ''"),
        ("drop index public.saved_services_del_servicio",
         "create unique index saved_services_del_servicio on public.saved_services (service_id)"),
        ("drop index public.saved_services_del_servicio",
         "create index saved_services_del_servicio on public.saved_services using hash (service_id)"),
        ("update pg_catalog.pg_index set indisvalid = false "
         "where indexrelid = 'public.saved_services_mios'::regclass",),
        # RLS con una política, o alguien de fuera con permisos.
        ("create policy abierta on public.saved_services for select to authenticated using (true)",),
        ("grant select on public.saved_services to anon",),
        ("grant insert on public.saved_services to authenticated",),
        ("grant references on public.saved_services to authenticated",),
        ("grant select on public.saved_services to public",),
        ("grant select (title_at_save) on public.saved_services to authenticated",),
        ("grant update (title_at_save) on public.saved_services to public",),
    ):
        assert await _puerta_de_guardados(motor, *cambios) is False, cambios
    # Control: lo que la puerta NO debe exigir. `service_role` (la clave del
    # servidor) puede tener permisos, y el orden físico de las filas da igual.
    for cambios in (
        ("grant all on public.saved_services to service_role",),
        ("cluster public.saved_services using saved_services_mios",),
    ):
        assert await _puerta_de_guardados(motor, *cambios) is True, cambios


async def test_un_error_al_mirar_la_0091_es_503_y_no_se_recuerda(mundo, monkeypatch) -> None:
    """Una excepción DURANTE la inspección: la puerta dice que no sin recordarlo
    y guardar contesta 503 `services_not_ready`, nunca 500. Al dejar de fallar
    responde sin reiniciar."""
    app, motor, _ = mundo
    jefa, moderador = await _equipo(motor)
    categoria = (await _categoria(app, jefa))["id"]
    ident = await _publicado(app, await _prestador(motor), jefa, moderador, categoria, title="Inspección rota")
    quien = await _persona(motor)
    esquema.olvidar()
    buena = esquema._LO_QUE_NECESITAN_LOS_GUARDADOS
    monkeypatch.setattr(esquema, "_LO_QUE_NECESITAN_LOS_GUARDADOS", text("select 1 / 0 = 1"))
    async with _cliente(app, quien) as http:
        for metodo, ruta in (("POST", f"{CATALOGO}/{ident}/save"), ("GET", GUARDADOS)):
            r = await http.request(metodo, ruta)
            assert r.status_code == 503 and r.json()["error"]["code"] == "services_not_ready", (ruta, r.text)
    assert "guardados" not in esquema._cache
    assert _ids(await _lista(app, quien)) == [ident]  # el catálogo no depende de la 0091
    monkeypatch.setattr(esquema, "_LO_QUE_NECESITAN_LOS_GUARDADOS", buena)
    async with _cliente(app, quien) as http:
        assert (await http.post(f"{CATALOGO}/{ident}/save")).status_code == 200
    assert esquema._cache["guardados"] is True


async def test_si_la_tabla_desaparece_con_la_api_en_marcha_el_catalogo_no_cae(mundo) -> None:
    """Un rollback de la 0091 sin reiniciar: la puerta recordaba el «sí». El
    catálogo, la ficha y las sugerencias siguen (sin guardados) y la puerta
    vuelve a mirar; nunca un 500."""
    app, motor, _ = mundo
    jefa, moderador = await _equipo(motor)
    categoria = (await _categoria(app, jefa))["id"]
    ident = await _publicado(app, await _prestador(motor), jefa, moderador, categoria, title="Resiste")
    quien = await _persona(motor)
    assert _ids(await _lista(app, quien)) == [ident]  # la puerta ya dijo «sí»
    await _sembrar(motor, "alter table public.saved_services rename to saved_services_apartada")
    try:
        assert _ids(await _lista(app, quien)) == [ident]
        assert (await _get(app, f"{CATALOGO}/{ident}", quien)).json()["saved"] is False
        assert (await _get(app, SUGERENCIAS, quien)).status_code == 200
        async with _cliente(app, quien) as http:
            r = await http.post(f"{CATALOGO}/{ident}/save")
        assert r.status_code == 503 and r.json()["error"]["code"] == "services_not_ready"
    finally:
        await _sembrar(motor, "alter table public.saved_services_apartada rename to saved_services")
        esquema.olvidar()


async def test_sin_la_0091_guardar_contesta_503_y_el_resto_funciona(mundo, monkeypatch) -> None:
    app, motor, _ = mundo
    jefa, moderador = await _equipo(motor)
    categoria = (await _categoria(app, jefa))["id"]
    ident = await _publicado(app, await _prestador(motor), jefa, moderador, categoria, title="Sin guardados")
    quien = await _persona(motor)

    async def _no(db):
        return False

    monkeypatch.setattr(esquema, "hay_guardados", _no)
    async with _cliente(app, quien) as http:
        for metodo, ruta in (("POST", f"{CATALOGO}/{ident}/save"), ("DELETE", f"{CATALOGO}/{ident}/save"),
                             ("GET", GUARDADOS)):
            r = await http.request(metodo, ruta)
            assert r.status_code == 503 and r.json()["error"]["code"] == "services_not_ready", ruta
    assert _ids(await _lista(app, quien)) == [ident]
    assert (await _get(app, f"{CATALOGO}/{ident}", quien)).json()["saved"] is False


# =========================================================================== #
# 9. Sin N+1
# =========================================================================== #
async def test_el_catalogo_hace_las_mismas_consultas_con_2_que_con_8(mundo) -> None:
    app, motor, _ = mundo
    jefa, moderador = await _equipo(motor)
    categoria = (await _categoria(app, jefa))["id"]
    quien = await _persona(motor)
    prestadores = [await _prestador(motor) for _ in range(4)]
    idents = [await _publicado(app, prestadores[n % 4], jefa, moderador, categoria, title=f"Consulta {n}")
              for n in range(8)]
    async with _cliente(app, quien) as http:
        for ident in idents:
            assert (await http.post(f"{CATALOGO}/{ident}/save")).status_code == 200
    esquema.olvidar()
    await _lista(app, quien, limit=2)  # la puerta, ya recordada

    cuenta = {"n": 0}

    def _contar(*_):
        cuenta["n"] += 1

    event.listen(motor.sync_engine, "before_cursor_execute", _contar)
    try:
        medidas = {}
        for limite in (2, 8):
            cuenta["n"] = 0
            pagina = await _lista(app, quien, limit=limite, q="consulta")
            assert len(pagina["items"]) == limite
            medidas[limite] = cuenta["n"]
            cuenta["n"] = 0
            assert len((await _get(app, GUARDADOS, quien, limit=limite)).json()["items"]) == limite
            medidas[f"g{limite}"] = cuenta["n"]
    finally:
        event.remove(motor.sync_engine, "before_cursor_execute", _contar)
    assert medidas[2] == medidas[8] and medidas["g2"] == medidas["g8"], medidas


# =========================================================================== #
# 10. Carreras con la ficha y las categorías
# =========================================================================== #
async def test_suspender_o_desactivar_mientras_se_consulta(mundo) -> None:
    app, motor, _ = mundo
    jefa, moderador = await _equipo(motor)
    categoria = (await _categoria(app, jefa))["id"]
    ident = await _publicado(app, await _prestador(motor), jefa, moderador, categoria, title="En plena carrera")
    ficha, suspension = await asyncio.gather(
        _get(app, f"{CATALOGO}/{ident}"),
        _accion(app, jefa, f"{BANDEJA}/{ident}/suspend", {"note": "Revisión."}),
    )
    assert suspension.status_code == 200 and ficha.status_code in (200, 404), ficha.text
    assert (await _get(app, f"{CATALOGO}/{ident}")).status_code == 404
    assert (await _accion(app, jefa, f"{BANDEJA}/{ident}/reinstate", {"note": "Resuelto."})).status_code == 200
    lista, desactivar = await asyncio.gather(
        _get(app, CATALOGO, category_id=categoria),
        _accion(app, jefa, f"{ADMIN}/categories/{categoria}/deactivate"),
    )
    assert desactivar.status_code == 200 and lista.status_code == 200
    assert _ids(lista.json()) in ([], [ident])
    assert _ids(await _lista(app, category_id=categoria)) == []


# =========================================================================== #
# 11. El recorrido: publicar → descubrir → … → retirar
# =========================================================================== #
async def test_recorrido_de_descubrimiento(mundo) -> None:
    app, motor, _ = mundo
    jefa, moderador = await _equipo(motor)
    categoria = (await _categoria(app, jefa, name="Consultoría financiera"))["id"]
    ana = await _persona(motor)
    await _llevar(app, ana, "approved", jefa=jefa, moderador=moderador)
    lucia = await _persona(motor)
    ident = await _publicado(app, ana, jefa, moderador, categoria, title="Plan de ahorro familiar",
                             modality="in_person", location_area="Surco, Lima")
    # Descubrir, buscar, filtrar, abrir la ficha y el perfil, guardar.
    assert ident in _ids(await _lista(app, lucia))
    assert _ids(await _lista(app, lucia, q="ahorro")) == [ident]
    assert _ids(await _lista(app, lucia, modality="in_person", area="surco", credential_verified="true")) == [ident]
    ficha = (await _get(app, f"{CATALOGO}/{ident}", lucia)).json()
    perfil = (await _get(app, f"{PRESTADORES}/{ficha['provider']['id']}", lucia)).json()
    assert perfil["trust"]["identity_verified"] and perfil["trust"]["credential_verified"]
    async with _cliente(app, lucia) as http:
        assert (await http.post(f"{CATALOGO}/{ident}/save")).status_code == 200
    # Editar una versión nueva no cambia lo visible…
    v2 = (await _accion(app, ana, f"{MIOS}/{ident}/draft")).json()["open_version"]["id"]
    assert (await _editar(app, ana, ident, title="Plan de ahorro y deudas")).status_code == 200
    assert _ids(await _lista(app, lucia, q="deudas")) == []
    assert (await _get(app, f"{CATALOGO}/{ident}", lucia)).json()["title"] == "Plan de ahorro familiar"
    # …hasta que se publica.
    assert (await _accion(app, ana, f"{MIOS}/{ident}/draft/submit")).status_code == 200
    base = f"{BANDEJA}/{ident}/versions/{v2}"
    for paso, quien in (("start-review", moderador), ("approve", jefa), ("publish", jefa)):
        assert (await _accion(app, quien, f"{base}/{paso}")).status_code == 200, paso
    assert _ids(await _lista(app, lucia, q="deudas")) == [ident]
    assert (await _get(app, GUARDADOS, lucia)).json()["items"][0]["service"]["title"] == "Plan de ahorro y deudas"
    # Suspender lo saca de todo lo público; la lista propia lo marca no disponible.
    assert (await _accion(app, jefa, f"{BANDEJA}/{ident}/suspend", {"note": "Revisión."})).status_code == 200
    assert ident not in _ids(await _lista(app, lucia)) and _ids(await _lista(app, lucia, q="deudas")) == []
    assert (await _get(app, f"{PRESTADORES}/{ficha['provider']['id']}", lucia)).status_code == 404
    assert (await _get(app, GUARDADOS, lucia)).json()["items"][0]["available"] is False
    # Reactivar lo devuelve; retirar lo quita para siempre.
    assert (await _accion(app, jefa, f"{BANDEJA}/{ident}/reinstate", {"note": "Resuelto."})).status_code == 200
    assert _ids(await _lista(app, lucia, q="deudas")) == [ident]
    assert (await _accion(app, jefa, f"{BANDEJA}/{ident}/retire", {"note": "Ya no se ofrece."})).status_code == 200
    assert ident not in _ids(await _lista(app, lucia)) and (await _get(app, f"{CATALOGO}/{ident}")).status_code == 404
    assert await _filas(motor, "select status from public.services where id = cast(:s as uuid)", s=ident) == [
        ("retired",)
    ]
