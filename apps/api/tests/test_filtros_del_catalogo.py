"""Los filtros de `GET /catalog/courses`, y por que tienen que correr en la base.

EL FALLO QUE EVITAN. Filtrando en el movil sobre la pagina que llega, pedir
«avanzado» devuelve los cursos avanzados QUE HUBIERA en los veinte primeros: la
pantalla ensena tres resultados y jura que no hay mas. El filtro tiene que
aplicarse ANTES de paginar o no es un filtro, es un recorte.

LA OTRA MITAD, y es la que romperia produccion: sin ningun parametro la
respuesta tiene que ser EXACTAMENTE la de siempre. Este endpoint es la pantalla
de inicio de todo el mundo.

SQLite en memoria, igual que el resto de la suite.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.main import app
from app.modules.catalog import esquema as esquema_de_catalogo
from app.modules.catalog.models import Course
from app.modules.gobernanza import esquema as esquema_gobernanza
from app.modules.profiles.models import Profile
from app.shared.database import Base, get_db

#: Ver la nota de `test_temario_por_la_api`: la 0034 se importa, no se copia.
from test_cursos_v2 import MIGRACION_0034

CATALOGO = "/api/v1/catalog"
ANA = "aaaaaaaa-0000-0000-0000-000000000001"
AHORA = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)

#: Tres cursos publicados, en la forma (id, titulo, descripcion, nivel, idioma,
#: dias de antiguedad).
#:
#: LAS FECHAS VAN A MANO porque el catalogo ordena por `created_at` y en SQLite
#: las cuatro filas se crean dentro del mismo milisegundo: sin fechas distintas
#: el orden seria el que quisiera la base y la prueba de paginacion —que es la
#: que justifica todo el cambio— no probaria nada.
CURSOS = (
    (
        "11111111-0000-0000-0000-000000000001",
        "Cocina peruana",
        "Ceviche y causa.",
        "advanced",
        "es",
        3,
    ),
    (
        "11111111-0000-0000-0000-000000000002",
        "Marketing digital",
        "Anuncios y embudos.",
        "beginner",
        "es",
        2,
    ),
    (
        "11111111-0000-0000-0000-000000000003",
        "Fundamentos",
        "Introduccion a la cocina.",
        "beginner",
        "en",
        1,
    ),
)
BORRADOR = "11111111-0000-0000-0000-000000000009"


async def _levantar(con_0034: bool):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        if con_0034:
            for sentencia in MIGRACION_0034:
                await conn.execute(text(sentencia))
    esquema_de_catalogo.olvidar()
    esquema_gobernanza.olvidar()
    sesiones = async_sessionmaker(engine, expire_on_commit=False)

    async with sesiones() as db:
        db.add(Profile(id=ANA, username="ana", full_name="Ana"))
        for ident, titulo, descripcion, _nivel, _idioma, dias in CURSOS:
            db.add(
                Course(
                    id=ident,
                    author_id=ANA,
                    title=titulo,
                    description=descripcion,
                    status="published",
                    created_at=AHORA - timedelta(days=dias),
                )
            )
        db.add(
            Course(
                id=BORRADOR,
                author_id=ANA,
                title="Cocina secreta",
                description="Todavia sin publicar.",
                status="draft",
                created_at=AHORA,
            )
        )
        await db.commit()
        if con_0034:
            # EL ID VA EN HEXADECIMAL SIN GUIONES. `Uuid(as_uuid=False)` se
            # guarda en SQLite como `char(32)`, asi que un `where id = :id` con
            # la forma con guiones no casa NINGUNA fila: la prueba se quedaria
            # verde midiendo un catalogo sin nivel ninguno.
            for ident, _t, _d, nivel, idioma, _dias in CURSOS:
                await db.execute(
                    text("update courses set level = :n, language = :i where id = :id"),
                    {"n": nivel, "i": idioma, "id": ident.replace("-", "")},
                )
            await db.commit()

    async def _sesion():
        async with sesiones() as db:
            yield db

    app.dependency_overrides[get_db] = _sesion
    return engine, AsyncClient(transport=ASGITransport(app=app), base_url="http://t")


@pytest_asyncio.fixture
async def http():
    engine, cliente = await _levantar(con_0034=True)
    try:
        async with cliente:
            yield cliente
    finally:
        app.dependency_overrides.clear()
        esquema_de_catalogo.olvidar()
        esquema_gobernanza.olvidar()
        await engine.dispose()


@pytest_asyncio.fixture
async def http_sin_0034():
    engine, cliente = await _levantar(con_0034=False)
    try:
        async with cliente:
            yield cliente
    finally:
        app.dependency_overrides.clear()
        esquema_de_catalogo.olvidar()
        esquema_gobernanza.olvidar()
        await engine.dispose()


async def _titulos(cliente, **params) -> list[str]:
    respuesta = await cliente.get(f"{CATALOGO}/courses", params=params)
    assert respuesta.status_code == 200, respuesta.text
    return [c["title"] for c in respuesta.json()]


@pytest.mark.asyncio
async def test_sin_filtros_el_catalogo_es_el_de_siempre(http) -> None:
    """Solo publicados y del mas nuevo al mas viejo. Ni un `where` de mas."""
    assert await _titulos(http) == [
        "Fundamentos",
        "Marketing digital",
        "Cocina peruana",
    ]


@pytest.mark.asyncio
async def test_el_nivel_filtra_antes_de_paginar(http) -> None:
    """LA PRUEBA QUE JUSTIFICA TODO EL CAMBIO.

    «Cocina peruana» es el UNICO avanzado y ademas el mas viejo de los tres, asi
    que es el ultimo de la lista. Pidiendo una sola pagina de uno: filtrando en
    la base sale el; filtrando despues de paginar salen cero resultados, y la
    pantalla diria que no hay ningun curso avanzado.
    """
    assert await _titulos(http, level="advanced", limit=1) == ["Cocina peruana"]


@pytest.mark.asyncio
async def test_el_idioma_filtra_antes_de_paginar(http) -> None:
    """Mismo razonamiento: el unico en ingles es el mas nuevo, asi que se pide
    la segunda pagina para que un filtro aplicado despues no acierte por suerte.
    """
    assert await _titulos(http, language="en") == ["Fundamentos"]
    assert await _titulos(http, language="es", limit=1, offset=1) == ["Cocina peruana"]


@pytest.mark.asyncio
async def test_nivel_e_idioma_se_combinan(http) -> None:
    esperado = ["Marketing digital"]
    assert await _titulos(http, level="beginner", language="es") == esperado


@pytest.mark.asyncio
async def test_la_busqueda_mira_titulo_y_descripcion(http) -> None:
    """Buscar solo en el titulo deja fuera «Fundamentos», que explica en la
    descripcion que va de cocina. Quien busca «cocina» quiere los dos.
    """
    assert sorted(await _titulos(http, q="cocina")) == ["Cocina peruana", "Fundamentos"]


@pytest.mark.asyncio
async def test_un_comodin_no_devuelve_el_catalogo_entero(http) -> None:
    """`%` y `_` SON COMODINES EN SQL.

    Sin escaparlos, buscar «%» devuelve el catalogo entero y «a_a» encuentra
    «ana», «ala» y «aja»: quien busca no sabe que ha escrito un comodin y la
    lista le miente sin avisar.
    """
    assert await _titulos(http, q="%") == []
    assert await _titulos(http, q="_") == []
    assert await _titulos(http, q="coc_na") == []


@pytest.mark.asyncio
async def test_la_busqueda_no_saca_borradores(http) -> None:
    """El filtro se anade AL de siempre, no lo sustituye.

    «Cocina secreta» casa con la busqueda y esta en borrador: si apareciera, el
    filtro habria abierto el catalogo publico a lo que solo ve su autor.
    """
    assert "Cocina secreta" not in await _titulos(http, q="cocina")


@pytest.mark.asyncio
async def test_un_nivel_inventado_se_rechaza(http) -> None:
    """422 y no una lista vacia: «no hay cursos» y «ese nivel no existe» son
    cosas distintas, y solo una de las dos se arregla escribiendo bien.
    """
    respuesta = await http.get(f"{CATALOGO}/courses", params={"level": "experto"})
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_sin_la_0034_el_catalogo_sigue_funcionando(http_sin_0034) -> None:
    """Lo primero que hay que garantizar: la migracion espera aprobacion."""
    assert await _titulos(http_sin_0034) == [
        "Fundamentos",
        "Marketing digital",
        "Cocina peruana",
    ]
    # Del mas nuevo al mas viejo, como el catalogo sin filtrar: buscar no
    # reordena nada.
    esperado = ["Fundamentos", "Cocina peruana"]
    assert await _titulos(http_sin_0034, q="cocina") == esperado


@pytest.mark.asyncio
async def test_sin_la_0034_filtrar_por_nivel_responde_503(http_sin_0034) -> None:
    """503, y no el catalogo entero ni una lista vacia.

    Devolver todo seria mentir —el filtro no se aplico— y devolver vacio haria
    pensar que no hay cursos de ese nivel. La funcion existe, todavia no esta
    montada, y eso es lo mismo que ya responde la revision de cursos.
    """
    respuesta = await http_sin_0034.get(
        f"{CATALOGO}/courses", params={"level": "beginner"}
    )
    assert respuesta.status_code == 503
    assert respuesta.json()["error"]["code"] == "course_filters_not_available"


@pytest.mark.asyncio
async def test_un_curso_sin_nivel_sale_sin_filtro_y_no_con_filtro(http) -> None:
    """El caso real: los cuatro cursos publicados tienen `level` nulo.

    Sin filtro tienen que seguir visibles —no especificar el nivel no es motivo
    para desaparecer del catalogo— y con filtro no pueden colarse en ninguno,
    porque no coinciden con ninguno.
    """
    from app.shared.database import get_db

    sesion = app.dependency_overrides[get_db]
    async for db in sesion():
        await db.execute(text("update courses set level = null"))
        await db.commit()
        break

    assert len(await _titulos(http)) > 0, "sin nivel no se desaparece del catalogo"
    for nivel in ("beginner", "intermediate", "advanced"):
        assert await _titulos(http, level=nivel) == [], (
            f"un curso sin nivel no puede salir como {nivel}"
        )
