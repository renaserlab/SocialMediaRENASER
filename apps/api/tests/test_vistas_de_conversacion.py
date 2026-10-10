"""Vistas de una conversación: categorías automáticas y filtros de grupo.

Pedido el 09/10/2026. Lo que se protege:

  · que una vista enseñe los mensajes que le tocan y solo esos, sin copiar
    ninguno;
  · que nadie lea ni toque las vistas de una conversación que no es suya, ni
    los filtros de otro grupo;
  · que solo quien administra el grupo cambie sus filtros, aunque llame a la
    API a mano;
  · que paginar no repita ni se salte mensajes;
  · que sin la migración 0102 el chat y las categorías sigan funcionando.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.messaging import esquema, vistas
from app.modules.messaging.models import (
    Conversation,
    ConversationFilter,
    ConversationMember,
    Message,
    MessageAttachment,
)
from app.modules.profiles.models import Profile
from app.shared.database import Base, get_db

ANA = "aaaaaaaa-0000-0000-0000-000000000001"     # creó el grupo: lo administra
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"   # miembro; creó el otro grupo
CARLA = "aaaaaaaa-0000-0000-0000-000000000003"   # miembro de los dos grupos
DAVID = "aaaaaaaa-0000-0000-0000-000000000004"   # no está en ninguna

GRUPO = "bbbbbbbb-0000-0000-0000-000000000001"
OTRO_GRUPO = "bbbbbbbb-0000-0000-0000-000000000002"
DIRECTO = "bbbbbbbb-0000-0000-0000-000000000003"

API = "/api/v1/conversations"
BASE = datetime(2026, 10, 1, 12, 0, 0, tzinfo=timezone.utc)


async def _levantar(sin_la_0102: bool = False, sin_tablas: tuple[str, ...] = ()):
    """`sin_tablas` deja fuera las de otra migracion (la 0104, por ejemplo)."""
    esquema.olvidar()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        from app.modules.bookings import models as _b  # noqa: F401
        from app.modules.catalog import models as _c  # noqa: F401
        from app.modules.communities import models as _co  # noqa: F401
        from app.modules.content import models as _ct  # noqa: F401
        from app.modules.learning import models as _l  # noqa: F401
        from app.modules.live import models as _li  # noqa: F401
        from app.modules.messaging import models as _m  # noqa: F401
        from app.modules.moderation import models as _mo  # noqa: F401
        from app.modules.notifications import device_tokens as _dt  # noqa: F401
        from app.modules.notifications import models as _n  # noqa: F401
        from app.modules.social_graph import models as _s  # noqa: F401
        from app.modules.stories import models as _st  # noqa: F401

        fuera = set(sin_tablas) | ({"conversation_filters"} if sin_la_0102 else set())
        if fuera:
            tablas = [t for t in Base.metadata.sorted_tables if t.name not in fuera]
            await conn.run_sync(lambda sync: Base.metadata.create_all(sync, tables=tablas))
        else:
            await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        for uid, nombre in ((ANA, "Ana"), (BRUNO, "Bruno"), (CARLA, "Carla"), (DAVID, "David")):
            db.add(Profile(id=uid, full_name=nombre, username=nombre.lower()))
        await db.flush()
        db.add(Conversation(id=GRUPO, kind="group", title="Aula", created_by=ANA))
        db.add(Conversation(id=OTRO_GRUPO, kind="group", title="Otro", created_by=BRUNO))
        db.add(Conversation(id=DIRECTO, kind="direct", created_by=ANA))
        await db.flush()
        for conv, miembros in (
            (GRUPO, (ANA, BRUNO, CARLA)),
            (OTRO_GRUPO, (BRUNO, CARLA)),
            (DIRECTO, (ANA, BRUNO)),
        ):
            for uid in miembros:
                db.add(ConversationMember(conversation_id=conv, user_id=uid))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    identidad = {"uid": ANA}

    async def _usuario() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario
    app.dependency_overrides[get_optional_user] = _usuario
    return engine, sesiones, identidad


async def _recoger(engine) -> None:
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    esquema.olvidar()
    await engine.dispose()


@pytest_asyncio.fixture
async def entorno():
    engine, sesiones, identidad = await _levantar()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, sesiones, identidad
    await _recoger(engine)


@pytest_asyncio.fixture
async def sin_migracion():
    engine, sesiones, identidad = await _levantar(sin_la_0102=True)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, sesiones, identidad
    await _recoger(engine)


async def _mensaje(
    sesiones,
    *,
    de: str = ANA,
    texto: str = "",
    adjuntos: tuple[str, ...] = (),
    en: str = GRUPO,
    minuto: int = 0,
    cuando: datetime | None = None,
    borrado: bool = False,
    nombre: str | None = None,
    mid: str | None = None,
) -> str:
    """Un mensaje escrito directamente en la base, con sus adjuntos."""
    mid = mid or str(uuid4())
    instante = cuando or (BASE + timedelta(minutes=minuto))
    async with sesiones() as db:
        db.add(
            Message(
                id=mid,
                conversation_id=en,
                sender_id=de,
                body=texto,
                created_at=instante,
                deleted_at=instante if borrado else None,
            )
        )
        await db.flush()
        for posicion, tipo in enumerate(adjuntos):
            db.add(
                MessageAttachment(
                    message_id=mid,
                    conversation_id=en,
                    storage_path=f"{en}/{de}/{uuid4()}",
                    kind=tipo,
                    file_name=nombre if tipo == "document" else None,
                    sort_order=posicion,
                )
            )
        await db.commit()
    return mid


async def _vista(http, conv: str = GRUPO, **params) -> list[str]:
    respuesta = await http.get(f"{API}/{conv}/views/messages", params=params)
    assert respuesta.status_code == 200, respuesta.text
    return [m["id"] for m in respuesta.json()["items"]]


def _filtro(nombre: str = "Material de estudio", **criterios) -> dict:
    return {"name": nombre, "criteria": criterios or {"keywords": ["examen"]}}


async def _crear(http, cuerpo: dict | None = None, conv: str = GRUPO):
    return await http.post(f"{API}/{conv}/filters", json=cuerpo or _filtro())


# --------------------------------------------------------------------------- #
# 1. Categorías automáticas
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_cada_mensaje_sale_en_la_categoria_de_lo_que_es(entorno):
    http, sesiones, _ = entorno
    texto = await _mensaje(sesiones, texto="Hola a todos", minuto=1)
    foto = await _mensaje(sesiones, adjuntos=("image",), minuto=2)
    video = await _mensaje(sesiones, adjuntos=("video",), minuto=3)
    pdf = await _mensaje(sesiones, adjuntos=("document",), nombre="guia.pdf", minuto=4)
    voz = await _mensaje(sesiones, adjuntos=("audio",), minuto=5)
    enlace = await _mensaje(sesiones, texto="Mirad https://renaser.pe/curso", minuto=6)

    assert await _vista(http, category="image") == [foto]
    assert await _vista(http, category="video") == [video]
    assert await _vista(http, category="document") == [pdf]
    assert await _vista(http, category="audio") == [voz]
    assert await _vista(http, category="link") == [enlace]
    # «Todo» es la conversación entera, de lo más reciente a lo más antiguo.
    assert await _vista(http, category="all") == [enlace, voz, pdf, video, foto, texto]


@pytest.mark.asyncio
async def test_un_mensaje_con_varias_cosas_sale_una_vez_en_cada_categoria(entorno):
    http, sesiones, _ = entorno
    mixto = await _mensaje(
        sesiones,
        texto="Fotos y vídeo, y el resto en www.renaser.pe",
        adjuntos=("image", "image", "image", "video"),
    )
    for categoria in ("image", "video", "link"):
        assert await _vista(http, category=categoria) == [mixto], categoria
    assert await _vista(http, category="document") == []

    # Es UN mensaje y sigue siéndolo: llega con sus cuatro adjuntos.
    respuesta = await http.get(f"{API}/{GRUPO}/views/messages", params={"category": "image"})
    assert len(respuesta.json()["items"][0]["attachments"]) == 4


@pytest.mark.asyncio
async def test_las_cuentas_dicen_mensajes_y_no_archivos_ni_borrados(entorno):
    http, sesiones, _ = entorno
    await _mensaje(sesiones, adjuntos=("image", "image", "image"), minuto=1)
    await _mensaje(sesiones, adjuntos=("image",), minuto=2)
    await _mensaje(sesiones, adjuntos=("image",), minuto=3, borrado=True)
    await _mensaje(sesiones, texto="http://x.example", minuto=4)
    await _mensaje(sesiones, texto="https://borrado.example", minuto=5, borrado=True)
    # Lo de otra conversación no cuenta aquí.
    await _mensaje(sesiones, adjuntos=("video",), en=OTRO_GRUPO, de=BRUNO)

    cuerpo = (await http.get(f"{API}/{GRUPO}/views")).json()
    cuentas = {c["key"]: c["count"] for c in cuerpo["categories"]}
    assert [c["key"] for c in cuerpo["categories"]] == list(vistas.CATEGORIAS)
    assert cuentas["image"] == 2
    assert cuentas["link"] == 1
    assert cuentas["video"] == 0
    assert cuentas["document"] == 0


@pytest.mark.asyncio
async def test_un_mensaje_borrado_no_sale_en_ninguna_vista(entorno):
    http, sesiones, _ = entorno
    await _mensaje(sesiones, texto="examen https://x.example", adjuntos=("image",), borrado=True)
    await _crear(http)
    filtro = (await http.get(f"{API}/{GRUPO}/filters")).json()[0]["id"]
    for params in ({"category": "all"}, {"category": "image"}, {"category": "link"}, {"filter_id": filtro}):
        assert await _vista(http, **params) == [], params


@pytest.mark.asyncio
async def test_borrar_un_mensaje_por_la_api_lo_quita_de_las_vistas(entorno):
    http, sesiones, _ = entorno
    foto = await _mensaje(sesiones, adjuntos=("image",))
    assert await _vista(http, category="image") == [foto]
    assert (await http.delete(f"{API}/{GRUPO}/messages/{foto}")).status_code == 204
    assert await _vista(http, category="image") == []


@pytest.mark.asyncio
async def test_un_mensaje_mandado_por_la_api_aparece_en_su_categoria(entorno):
    http, _, identidad = entorno
    identidad["uid"] = BRUNO
    respuesta = await http.post(
        f"{API}/{GRUPO}/messages",
        json={
            "body": "",
            "attachments": [
                {"storage_path": f"{GRUPO}/{BRUNO}/apuntes.pdf", "kind": "document", "file_name": "apuntes.pdf"}
            ],
        },
    )
    assert respuesta.status_code == 201, respuesta.text
    nuevo = respuesta.json()["id"]
    assert await _vista(http, category="document") == [nuevo]
    assert await _vista(http, category="image") == []


@pytest.mark.asyncio
async def test_las_categorias_valen_tambien_en_un_chat_de_dos(entorno):
    http, sesiones, _ = entorno
    foto = await _mensaje(sesiones, adjuntos=("image",), en=DIRECTO)
    assert await _vista(http, DIRECTO, category="image") == [foto]

    cuerpo = (await http.get(f"{API}/{DIRECTO}/views")).json()
    assert cuerpo["kind"] == "direct"
    assert cuerpo["filters_available"] is False
    assert cuerpo["can_manage"] is False
    assert cuerpo["filters"] == []


# --------------------------------------------------------------------------- #
# 2. Quién puede mirar
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_quien_no_pertenece_no_ve_nada(entorno):
    http, sesiones, identidad = entorno
    await _mensaje(sesiones, adjuntos=("image",))
    creado = (await _crear(http)).json()["id"]

    identidad["uid"] = DAVID
    assert (await http.get(f"{API}/{GRUPO}/views")).status_code == 403
    assert (await http.get(f"{API}/{GRUPO}/filters")).status_code == 403
    for params in ({"category": "image"}, {"filter_id": creado}):
        respuesta = await http.get(f"{API}/{GRUPO}/views/messages", params=params)
        assert respuesta.status_code == 403, params
    assert (await _crear(http)).status_code == 403
    assert (await http.patch(f"{API}/{GRUPO}/filters/{creado}", json={"name": "X"})).status_code == 403
    assert (await http.delete(f"{API}/{GRUPO}/filters/{creado}")).status_code == 403


@pytest.mark.asyncio
async def test_una_vista_no_mezcla_mensajes_de_otra_conversacion(entorno):
    http, sesiones, identidad = entorno
    mio = await _mensaje(sesiones, texto="examen del viernes", adjuntos=("document",))
    ajeno = await _mensaje(
        sesiones, texto="examen del lunes", adjuntos=("document",), en=OTRO_GRUPO, de=BRUNO
    )
    filtro = (await _crear(http)).json()["id"]

    assert await _vista(http, category="document") == [mio]
    assert await _vista(http, filter_id=filtro) == [mio]

    identidad["uid"] = BRUNO
    assert await _vista(http, OTRO_GRUPO, category="document") == [ajeno]


@pytest.mark.asyncio
async def test_hay_que_elegir_una_vista_y_solo_una(entorno):
    http, _, _ = entorno
    filtro = (await _crear(http)).json()["id"]
    ruta = f"{API}/{GRUPO}/views/messages"

    ninguna = await http.get(ruta)
    assert ninguna.status_code == 422
    assert ninguna.json()["error"]["code"] == "view_selector_invalid"
    las_dos = await http.get(ruta, params={"category": "image", "filter_id": filtro})
    assert las_dos.status_code == 422
    rara = await http.get(ruta, params={"category": "sticker"})
    assert rara.status_code == 422
    assert rara.json()["error"]["code"] == "view_category_invalid"


# --------------------------------------------------------------------------- #
# 3. Filtros personalizados: lo que devuelven
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_quien_administra_crea_un_filtro_y_queda_guardado(entorno):
    http, sesiones, _ = entorno
    respuesta = await _crear(
        http,
        {
            "name": "  Material   de estudio ",
            "description": "Lo que entra en el examen",
            "icon": "book-open",
            "criteria": {"types": ["document", "link"], "keywords": [" Examen ", "examen"]},
        },
    )
    assert respuesta.status_code == 201, respuesta.text
    creado = respuesta.json()
    assert creado["name"] == "Material de estudio"
    assert creado["icon"] == "book-open"
    assert creado["enabled"] is True
    # Las palabras se limpian y no se repiten; los tipos salen en su orden.
    assert creado["criteria"] == {
        "types": ["document", "link"],
        "keywords": ["Examen"],
        "keyword_mode": "any",
        "author_ids": [],
    }

    async with sesiones() as db:
        fila = (await db.execute(select(ConversationFilter))).scalar_one()
        assert fila.conversation_id == GRUPO
        assert fila.created_by == ANA
        assert fila.criteria["types"] == ["document", "link"]

    cuerpo = (await http.get(f"{API}/{GRUPO}/views")).json()
    assert cuerpo["filters_available"] is True
    assert cuerpo["can_manage"] is True
    assert [f["id"] for f in cuerpo["filters"]] == [creado["id"]]


@pytest.mark.asyncio
async def test_un_filtro_devuelve_lo_que_cumple_sus_criterios_y_nada_mas(entorno):
    http, sesiones, _ = entorno
    pdf = await _mensaje(
        sesiones, texto="Material para el EXAMEN del viernes", adjuntos=("document",), minuto=1
    )
    await _mensaje(sesiones, texto="¿Alguien viene mañana?", minuto=2)
    await _mensaje(sesiones, adjuntos=("document",), minuto=3)          # PDF sin la palabra
    await _mensaje(sesiones, texto="examen aplazado", minuto=4)         # la palabra sin PDF
    filtro = (await _crear(http, _filtro(types=["document"], keywords=["examen"]))).json()["id"]

    assert await _vista(http, filter_id=filtro) == [pdf]


@pytest.mark.asyncio
async def test_las_palabras_pueden_pedir_una_o_todas(entorno):
    http, sesiones, _ = entorno
    los_dos = await _mensaje(sesiones, texto="Tarea y entrega el lunes", minuto=1)
    solo_tarea = await _mensaje(sesiones, texto="Otra tarea", minuto=2)
    await _mensaje(sesiones, texto="Nada que ver", minuto=3)

    una = (await _crear(http, _filtro("Una", keywords=["tarea", "entrega"]))).json()["id"]
    todas = (
        await _crear(http, _filtro("Todas", keywords=["tarea", "entrega"], keyword_mode="all"))
    ).json()["id"]

    assert await _vista(http, filter_id=una) == [solo_tarea, los_dos]
    assert await _vista(http, filter_id=todas) == [los_dos]


@pytest.mark.asyncio
async def test_un_filtro_por_autor_y_por_solo_texto(entorno):
    http, sesiones, _ = entorno
    de_bruno = await _mensaje(sesiones, de=BRUNO, texto="Comunicado", minuto=1)
    await _mensaje(sesiones, de=CARLA, texto="Comunicado", minuto=2)
    await _mensaje(sesiones, de=BRUNO, texto="Con foto", adjuntos=("image",), minuto=3)

    filtro = (
        await _crear(http, _filtro("De Bruno", types=["text"], author_ids=[BRUNO]))
    ).json()["id"]
    assert await _vista(http, filter_id=filtro) == [de_bruno]


@pytest.mark.asyncio
async def test_el_mismo_mensaje_sale_en_varias_vistas_sin_copiarse(entorno):
    http, sesiones, _ = entorno
    pdf = await _mensaje(
        sesiones, texto="Material para el examen del viernes", adjuntos=("document",)
    )
    estudio = (await _crear(http, _filtro("Material de estudio", keywords=["material"]))).json()["id"]
    viernes = (await _crear(http, _filtro("Examen del viernes", keywords=["examen", "viernes"], keyword_mode="all"))).json()["id"]

    for params in (
        {"category": "all"},
        {"category": "document"},
        {"filter_id": estudio},
        {"filter_id": viernes},
    ):
        assert await _vista(http, **params) == [pdf], params

    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(Message)) == 1
        assert await db.scalar(select(func.count()).select_from(MessageAttachment)) == 1


@pytest.mark.asyncio
async def test_los_comodines_de_una_palabra_no_hacen_de_comodin(entorno):
    http, sesiones, _ = entorno
    literal = await _mensaje(sesiones, texto="Descuento del 100% hoy", minuto=1)
    await _mensaje(sesiones, texto="Somos 1000 inscritos", minuto=2)
    filtro = (await _crear(http, _filtro("Cien", keywords=["100%"]))).json()["id"]
    assert await _vista(http, filter_id=filtro) == [literal]


@pytest.mark.asyncio
async def test_cambiar_los_criterios_cambia_el_resultado(entorno):
    http, sesiones, _ = entorno
    examen = await _mensaje(sesiones, texto="examen", minuto=1)
    reunion = await _mensaje(sesiones, texto="reunión el martes", minuto=2)
    filtro = (await _crear(http)).json()["id"]
    assert await _vista(http, filter_id=filtro) == [examen]

    cambio = await http.patch(
        f"{API}/{GRUPO}/filters/{filtro}",
        json={"name": "Reuniones", "criteria": {"keywords": ["reunión"]}},
    )
    assert cambio.status_code == 200, cambio.text
    assert cambio.json()["name"] == "Reuniones"
    assert await _vista(http, filter_id=filtro) == [reunion]


@pytest.mark.asyncio
async def test_borrar_un_filtro_no_borra_ningun_mensaje(entorno):
    http, sesiones, _ = entorno
    pdf = await _mensaje(sesiones, texto="examen", adjuntos=("document",))
    filtro = (await _crear(http)).json()["id"]

    assert (await http.delete(f"{API}/{GRUPO}/filters/{filtro}")).status_code == 204
    assert (await http.get(f"{API}/{GRUPO}/filters")).json() == []
    assert (await http.get(f"{API}/{GRUPO}/views/messages", params={"filter_id": filtro})).status_code == 404

    assert await _vista(http, category="document") == [pdf]
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(Message)) == 1
        assert await db.scalar(select(func.count()).select_from(MessageAttachment)) == 1


@pytest.mark.asyncio
async def test_un_filtro_sin_resultados_devuelve_una_pagina_vacia(entorno):
    http, _, _ = entorno
    filtro = (await _crear(http)).json()["id"]
    respuesta = await http.get(f"{API}/{GRUPO}/views/messages", params={"filter_id": filtro})
    assert respuesta.status_code == 200
    assert respuesta.json() == {"items": [], "next_before": None, "next_before_id": None}


@pytest.mark.asyncio
async def test_se_puede_buscar_dentro_de_una_vista_por_texto_y_por_nombre(entorno):
    http, sesiones, _ = entorno
    por_nombre = await _mensaje(sesiones, adjuntos=("document",), nombre="Temario_2026.pdf", minuto=1)
    por_texto = await _mensaje(sesiones, texto="el temario nuevo", adjuntos=("document",), nombre="a.pdf", minuto=2)
    await _mensaje(sesiones, adjuntos=("document",), nombre="horario.pdf", minuto=3)
    await _mensaje(sesiones, texto="temario en foto", adjuntos=("image",), minuto=4)

    assert await _vista(http, category="document", q="temario") == [por_texto, por_nombre]
    assert await _vista(http, category="document", q="   ") != []  # un espacio no es buscar


# --------------------------------------------------------------------------- #
# 4. Filtros personalizados: quién los cambia
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_miembro_usa_los_filtros_pero_no_los_cambia(entorno):
    http, sesiones, identidad = entorno
    examen = await _mensaje(sesiones, texto="examen")
    filtro = (await _crear(http)).json()["id"]

    identidad["uid"] = BRUNO
    cuerpo = (await http.get(f"{API}/{GRUPO}/views")).json()
    assert cuerpo["can_manage"] is False
    assert [f["id"] for f in cuerpo["filters"]] == [filtro]
    assert await _vista(http, filter_id=filtro) == [examen]

    crear = await _crear(http, _filtro("De Bruno"))
    assert crear.status_code == 403
    assert crear.json()["error"]["code"] == "filters_not_allowed"
    cambiar = await http.patch(f"{API}/{GRUPO}/filters/{filtro}", json={"name": "Pisado"})
    assert cambiar.status_code == 403
    apagar = await http.patch(f"{API}/{GRUPO}/filters/{filtro}", json={"enabled": False})
    assert apagar.status_code == 403
    assert (await http.delete(f"{API}/{GRUPO}/filters/{filtro}")).status_code == 403

    async with sesiones() as db:
        fila = (await db.execute(select(ConversationFilter))).scalar_one()
        assert (fila.name, fila.enabled) == ("Material de estudio", True)


@pytest.mark.asyncio
async def test_quien_administra_un_grupo_no_toca_los_filtros_de_otro(entorno):
    http, sesiones, identidad = entorno
    await _mensaje(sesiones, texto="examen")
    de_ana = (await _crear(http)).json()["id"]

    # Bruno administra OTRO_GRUPO. Con el identificador del filtro de Ana:
    identidad["uid"] = BRUNO
    #  · por su grupo no existe (404), ni para leerlo ni para cambiarlo;
    assert (await http.get(f"{API}/{OTRO_GRUPO}/views/messages", params={"filter_id": de_ana})).status_code == 404
    assert (await http.patch(f"{API}/{OTRO_GRUPO}/filters/{de_ana}", json={"name": "Mío"})).status_code == 404
    assert (await http.delete(f"{API}/{OTRO_GRUPO}/filters/{de_ana}")).status_code == 404
    #  · y por el de Ana no tiene permiso (403).
    assert (await http.delete(f"{API}/{GRUPO}/filters/{de_ana}")).status_code == 403

    # Sus filtros son suyos y no aparecen en el grupo de Ana.
    suyo = await _crear(http, _filtro("Del otro"), OTRO_GRUPO)
    assert suyo.status_code == 201
    identidad["uid"] = ANA
    assert [f["id"] for f in (await http.get(f"{API}/{GRUPO}/filters")).json()] == [de_ana]

    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(ConversationFilter)) == 2


@pytest.mark.asyncio
async def test_un_filtro_apagado_solo_lo_ve_quien_administra(entorno):
    http, sesiones, identidad = entorno
    examen = await _mensaje(sesiones, texto="examen")
    filtro = (await _crear(http)).json()["id"]
    apagado = await http.patch(f"{API}/{GRUPO}/filters/{filtro}", json={"enabled": False})
    assert apagado.json()["enabled"] is False

    assert [f["id"] for f in (await http.get(f"{API}/{GRUPO}/views")).json()["filters"]] == [filtro]
    assert await _vista(http, filter_id=filtro) == [examen]

    identidad["uid"] = CARLA
    assert (await http.get(f"{API}/{GRUPO}/views")).json()["filters"] == []
    assert (await http.get(f"{API}/{GRUPO}/filters")).json() == []
    respuesta = await http.get(f"{API}/{GRUPO}/views/messages", params={"filter_id": filtro})
    assert respuesta.status_code == 404


@pytest.mark.asyncio
async def test_en_un_chat_de_dos_no_hay_filtros(entorno):
    http, _, _ = entorno
    respuesta = await _crear(http, conv=DIRECTO)
    assert respuesta.status_code == 409
    assert respuesta.json()["error"]["code"] == "filters_only_in_groups"
    assert (await http.get(f"{API}/{DIRECTO}/filters")).json() == []


# --------------------------------------------------------------------------- #
# 5. Lo que no se deja guardar
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "cuerpo",
    [
        {"name": "Vacío", "criteria": {}},
        {"name": "Vacío", "criteria": {"types": [], "keywords": ["  "]}},
        {"name": "Tipo", "criteria": {"types": ["sticker"]}},
        {"name": "Corta", "criteria": {"keywords": ["ab"]}},
        {"name": "Larga", "criteria": {"keywords": ["x" * 41]}},
        {"name": "Muchas", "criteria": {"keywords": [f"palabra{i}" for i in range(6)]}},
        {"name": "Modo", "criteria": {"keywords": ["examen"], "keyword_mode": "regex"}},
        {"name": "Autor", "criteria": {"author_ids": ["no-es-un-uuid"]}},
        {"name": "De más", "criteria": {"keywords": ["examen"], "sql": "drop table messages"}},
        {"name": "De más", "criteria": {"keywords": ["examen"]}, "conversation_id": OTRO_GRUPO},
        {"name": "   ", "criteria": {"keywords": ["examen"]}},
        {"name": "x" * 41, "criteria": {"keywords": ["examen"]}},
        {"name": "Icono", "icon": "<script>", "criteria": {"keywords": ["examen"]}},
        {"name": "Sin criterios"},
    ],
)
async def test_un_filtro_mal_escrito_no_se_guarda(entorno, cuerpo):
    http, sesiones, _ = entorno
    respuesta = await _crear(http, cuerpo)
    assert respuesta.status_code == 422, respuesta.text
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(ConversationFilter)) == 0


@pytest.mark.asyncio
async def test_un_filtro_solo_nombra_a_miembros_del_grupo(entorno):
    http, _, _ = entorno
    fuera = await _crear(http, _filtro("De David", author_ids=[DAVID]))
    assert fuera.status_code == 422
    assert fuera.json()["error"]["code"] == "filter_author_not_member"

    dentro = (await _crear(http, _filtro("De Carla", author_ids=[CARLA]))).json()["id"]
    cambio = await http.patch(
        f"{API}/{GRUPO}/filters/{dentro}", json={"criteria": {"author_ids": [DAVID]}}
    )
    assert cambio.status_code == 422


@pytest.mark.asyncio
async def test_dos_filtros_del_mismo_grupo_no_se_llaman_igual(entorno):
    http, _, identidad = entorno
    assert (await _crear(http, _filtro("Tareas"))).status_code == 201
    repetido = await _crear(http, _filtro("  tareas "))
    assert repetido.status_code == 409
    assert repetido.json()["error"]["code"] == "filter_name_taken"

    otro = (await _crear(http, _filtro("Anuncios"))).json()["id"]
    assert (await http.patch(f"{API}/{GRUPO}/filters/{otro}", json={"name": "TAREAS"})).status_code == 409
    # Renombrarlo a su propio nombre, con otras mayúsculas, sí.
    assert (await http.patch(f"{API}/{GRUPO}/filters/{otro}", json={"name": "ANUNCIOS"})).status_code == 200

    # En otro grupo el nombre está libre.
    identidad["uid"] = BRUNO
    assert (await _crear(http, _filtro("Tareas"), OTRO_GRUPO)).status_code == 201


@pytest.mark.asyncio
async def test_un_grupo_tiene_un_tope_de_filtros(entorno):
    http, _, _ = entorno
    for i in range(vistas.MAX_FILTROS_POR_CONVERSACION):
        assert (await _crear(http, _filtro(f"Filtro {i}"))).status_code == 201
    uno_mas = await _crear(http, _filtro("El que no cabe"))
    assert uno_mas.status_code == 409
    assert uno_mas.json()["error"]["code"] == "filters_limit_reached"


# --------------------------------------------------------------------------- #
# 6. Paginar no repite ni se salta
# --------------------------------------------------------------------------- #
async def _todas_las_paginas(http, tope: int, **params) -> list[list[str]]:
    paginas: list[list[str]] = []
    cursor: dict = {}
    for _ in range(50):
        respuesta = await http.get(
            f"{API}/{GRUPO}/views/messages", params={**params, **cursor, "limit": tope}
        )
        assert respuesta.status_code == 200, respuesta.text
        cuerpo = respuesta.json()
        paginas.append([m["id"] for m in cuerpo["items"]])
        if cuerpo["next_before"] is None:
            assert cuerpo["next_before_id"] is None
            return paginas
        cursor = {"before": cuerpo["next_before"], "before_id": cuerpo["next_before_id"]}
    raise AssertionError("la paginación no termina")


@pytest.mark.asyncio
async def test_paginar_con_mensajes_del_mismo_instante_no_repite_ni_se_salta(entorno):
    http, sesiones, _ = entorno
    # Diez fotos, y siete de ellas en EL MISMO instante: es el caso que rompe
    # un cursor que solo mire la fecha.
    esperados = []
    for i in range(10):
        esperados.append(
            await _mensaje(
                sesiones,
                adjuntos=("image",),
                cuando=BASE if i < 7 else BASE + timedelta(seconds=i),
            )
        )
    await _mensaje(sesiones, texto="sin foto", minuto=30)

    paginas = await _todas_las_paginas(http, 3, category="image")
    vistos = [mid for pagina in paginas for mid in pagina]
    assert [len(p) for p in paginas] == [3, 3, 3, 1]
    assert len(vistos) == len(set(vistos)) == 10
    assert set(vistos) == set(esperados)


@pytest.mark.asyncio
async def test_un_mensaje_nuevo_mientras_se_pagina_no_descoloca_nada(entorno):
    http, sesiones, _ = entorno
    viejos = [
        await _mensaje(sesiones, texto=f"examen {i}", minuto=i) for i in range(5)
    ]
    filtro = (await _crear(http)).json()["id"]

    primera = (await http.get(f"{API}/{GRUPO}/views/messages", params={"filter_id": filtro, "limit": 2})).json()
    assert [m["id"] for m in primera["items"]] == [viejos[4], viejos[3]]

    # Entra uno nuevo, que también cumple, antes de pedir la página siguiente.
    nuevo = await _mensaje(sesiones, texto="examen recién llegado", minuto=99)

    segunda = (
        await http.get(
            f"{API}/{GRUPO}/views/messages",
            params={
                "filter_id": filtro,
                "limit": 2,
                "before": primera["next_before"],
                "before_id": primera["next_before_id"],
            },
        )
    ).json()
    assert [m["id"] for m in segunda["items"]] == [viejos[2], viejos[1]]
    # Y al volver a empezar, el nuevo sale el primero.
    assert (await _vista(http, filter_id=filtro))[0] == nuevo


@pytest.mark.asyncio
async def test_el_tamano_de_pagina_tiene_tope(entorno):
    http, _, _ = entorno
    ruta = f"{API}/{GRUPO}/views/messages"
    assert (await http.get(ruta, params={"category": "all", "limit": vistas.PAGINA_MAXIMA + 1})).status_code == 422
    assert (await http.get(ruta, params={"category": "all", "limit": 0})).status_code == 422


# --------------------------------------------------------------------------- #
# 7. Sin la migración 0102
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_sin_la_0102_las_categorias_y_el_chat_siguen_funcionando(sin_migracion):
    http, sesiones, _ = sin_migracion
    foto = await _mensaje(sesiones, adjuntos=("image",))

    assert await _vista(http, category="image") == [foto]
    cuerpo = (await http.get(f"{API}/{GRUPO}/views")).json()
    assert cuerpo["filters_available"] is False
    assert cuerpo["can_manage"] is False
    assert cuerpo["filters"] == []
    assert (await http.get(f"{API}/{GRUPO}/filters")).json() == []

    crear = await _crear(http)
    assert crear.status_code == 503
    assert crear.json()["error"]["code"] == "conversation_filters_not_available"
    por_filtro = await http.get(f"{API}/{GRUPO}/views/messages", params={"filter_id": str(uuid4())})
    assert por_filtro.status_code == 404

    # El chat de siempre no se entera.
    historial = await http.get(f"{API}/{GRUPO}/messages")
    assert historial.status_code == 200
    assert [m["id"] for m in historial.json()] == [foto]


# --------------------------------------------------------------------------- #
# 8. Lo que no cambia, y la migración
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_historial_del_chat_sigue_ensenando_la_lapida(entorno):
    """Las vistas esconden lo borrado; el chat NO, y eso no puede cambiar."""
    http, sesiones, _ = entorno
    borrado = await _mensaje(sesiones, texto="me arrepentí", borrado=True)
    historial = (await http.get(f"{API}/{GRUPO}/messages")).json()
    assert [(m["id"], m["body"]) for m in historial] == [(borrado, "")]
    assert historial[0]["deleted_at"] is not None


def test_los_criterios_se_traducen_sin_escribir_sql_a_mano():
    """Ni `text()`, ni f-strings dentro de una consulta: solo parámetros."""
    fuente = Path(vistas.__file__).read_text(encoding="utf-8")
    assert "text(" not in fuente
    assert not re.search(r"\.(where|filter)\(\s*f[\"']", fuente)
    assert "import re" not in fuente  # ninguna expresión regular sobre lo que escribe la gente


def _sql_de_la_0102() -> str:
    raiz = Path(__file__).resolve().parents[3]
    crudo = (raiz / "supabase" / "migrations" / "0102_filtros_de_conversacion.sql").read_text(
        encoding="utf-8"
    )
    return "\n".join(
        linea for linea in crudo.replace("\r\n", "\n").split("\n") if not linea.lstrip().startswith("--")
    )


def test_la_0102_solo_crea_su_tabla_y_la_deja_cerrada():
    sql = _sql_de_la_0102()
    assert "create table if not exists public.conversation_filters" in sql
    assert "enable row level security" in sql
    assert "create policy" not in sql
    assert "alter publication" not in sql
    # No toca nada de lo que ya existía.
    for tabla in ("messages", "conversations", "conversation_members", "message_attachments"):
        assert not re.search(rf"alter table public\.{tabla}\b", sql), tabla
    assert not re.search(r"\b(drop table|delete from|truncate|update public\.)", sql)
    # Borrar el grupo se lleva sus filtros; borrar un filtro no se lleva nada.
    assert "references public.conversations(id) on delete cascade" in sql


def test_la_tabla_del_modelo_es_la_de_la_migracion():
    sql = _sql_de_la_0102()
    cuerpo = sql[sql.index("create table") : sql.index(");")]
    del_sql = set(re.findall(r"^\s{2}([a-z_]+) ", cuerpo, flags=re.M))
    del_modelo = {c.name for c in ConversationFilter.__table__.columns}
    assert del_sql == del_modelo
