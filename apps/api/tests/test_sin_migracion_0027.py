"""La aplicacion tiene que funcionar SIN la migracion 0027.

POR QUE ESTA PRUEBA EXISTE. Se escribio el codigo de la V1.1 contra un esquema
que todavia no estaba aplicado —la 0027 espera aprobacion, como debe ser— y la
rama entera dejo de funcionar contra la base real: cada peticion que tocaba
`post_topics` o `behavior_events.surface` reventaba con un 500.

Y lo peor no fue el 500. Fue que el navegador lo reportaba como un error de
CORS, porque Starlette no anade las cabeceras CORS a una respuesta que sale de
una excepcion sin capturar. Un fallo de esquema disfrazado de fallo de red.

La regla que se rompio es del propio proyecto: desplegar codigo no puede exigir
que una migracion concreta ya este puesta, y una vuelta atras no puede tumbar
la aplicacion. Con la 0027 se hacen mas cosas; sin ella, las de antes.

COMO SE COMPRUEBA. Se crea el esquema entero y despues se QUITA lo que anade la
0027, dejando la base exactamente como esta hoy produccion. Si algo vuelve a
depender de esas columnas a la fuerza, estas pruebas se caen.
"""

from __future__ import annotations

from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.modules.recommendations.models import Topic
from app.shared.database import Base, get_db

API = "/api/v1/recommendations"
POSTS = "/api/v1/posts"

CARPINTERIA = "11111111-1111-1111-1111-111111111111"
ANA = "aaaaaaaa-0000-0000-0000-000000000001"
PEDRO = "aaaaaaaa-0000-0000-0000-000000000002"


@pytest_asyncio.fixture
async def base_sin_0027():
    """El esquema tal y como esta HOY en produccion: con la 0026, sin la 0027."""
    cache.vaciar()
    esquema.olvidar()

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        from app.modules.bookings import models as _b  # noqa: F401
        from app.modules.catalog import models as _c  # noqa: F401
        from app.modules.communities import models as _co  # noqa: F401
        from app.modules.content import models as _ct  # noqa: F401
        from app.modules.learning import models as _l  # noqa: F401
        from app.modules.messaging import models as _m  # noqa: F401
        from app.modules.moderation import models as _mo  # noqa: F401
        from app.modules.notifications import device_tokens as _dt  # noqa: F401
        from app.modules.notifications import models as _n  # noqa: F401
        from app.modules.social_graph import models as _s  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)

        # Y ahora se DESHACE la 0027, que es lo que se quiere probar.
        await conn.execute(text("drop table post_topics"))
        for columna in ("surface", "algorithm_version", "rank"):
            await conn.execute(
                text(f"alter table behavior_events drop column {columna}")
            )

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Topic(id=CARPINTERIA, slug="carpinteria", name="Carpintería"))
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=PEDRO, full_name="Pedro", username="pedro"))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    identidad = {"uid": ANA}

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="ana@ejemplo.com", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, identidad
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    esquema.olvidar()
    await engine.dispose()


# --------------------------------------------------------------------------- #
# Lo que reventaba
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_muro_carga(base_sin_0027):
    """`/posts` lee los temas de cada publicacion. Sin la tabla, vacios."""
    http, _, _ = base_sin_0027
    respuesta = await http.get(f"{POSTS}?limit=10")
    assert respuesta.status_code == 200


@pytest.mark.asyncio
async def test_se_puede_publicar(base_sin_0027):
    """Etiquetar es opcional; que no se pueda guardar la etiqueta no puede
    impedir compartir algo."""
    http, _, _ = base_sin_0027
    respuesta = await http.post(
        POSTS,
        json={
            "body": "una mesa",
            "media": [{"storage_path": "x/v.mp4", "media_type": "video"}],
            "topic_ids": [CARPINTERIA],
        },
    )
    assert respuesta.status_code == 201
    # Se publica, pero SIN temas: no hay donde guardarlos y no se finge que si.
    assert respuesta.json()["topic_ids"] == []


@pytest.mark.asyncio
async def test_el_feed_recomendado_responde(base_sin_0027):
    http, _, _ = base_sin_0027
    respuesta = await http.get(f"{API}/content?limit=6&media=video")
    assert respuesta.status_code == 200
    assert respuesta.json()["with_own_topics"] == 0


@pytest.mark.asyncio
async def test_personas_para_ti_responde(base_sin_0027):
    """La que fallaba por leer `behavior_events` entero, columnas nuevas
    incluidas."""
    http, _, _ = base_sin_0027
    respuesta = await http.get(f"{API}/people?limit=10")
    assert respuesta.status_code == 200


@pytest.mark.asyncio
async def test_las_senales_se_guardan_aunque_sin_contexto(base_sin_0027):
    """Se sigue aprendiendo; lo que no se puede es medir el embudo. Perder
    informacion es aceptable, dejar de registrar nada no."""
    http, sesiones, _ = base_sin_0027
    respuesta = await http.post(
        f"{API}/events",
        json={
            "events": [
                {
                    "event_type": "profile_view",
                    "entity_type": "profile",
                    "entity_id": PEDRO,
                    "surface": "people_for_you",
                    "algorithm_version": "people-v1.1",
                    "rank": 0,
                    "event_key": "v1",
                }
            ]
        },
    )
    assert respuesta.status_code == 200
    assert respuesta.json()["accepted"] == 1

    async with sesiones() as db:
        total = (await db.execute(text("select count(*) from behavior_events"))).scalar()
    assert total == 1


@pytest.mark.asyncio
async def test_el_cuestionario_sigue_funcionando(base_sin_0027):
    """La 0026 si esta aplicada: las preferencias no dependen de la 0027."""
    http, _, _ = base_sin_0027
    guardar = await http.put(
        f"{API}/preferences",
        json={"learning_topic_ids": [CARPINTERIA], "goals": ["aprender"]},
    )
    assert guardar.status_code == 200
    estado = await http.get(f"{API}/onboarding/status")
    assert estado.status_code == 200
    assert estado.json()["completed"] is True


@pytest.mark.asyncio
async def test_la_oferta_publica_sigue_funcionando(base_sin_0027):
    http, _, _ = base_sin_0027
    assert (await http.get(f"{API}/profiles/{PEDRO}/offer")).status_code == 200


@pytest.mark.asyncio
async def test_seguir_a_alguien_sigue_funcionando(base_sin_0027):
    """Escribe una senal desde el servidor: si esa escritura dependiera de las
    columnas nuevas, seguir a alguien fallaria."""
    http, _, _ = base_sin_0027
    assert (await http.post(f"/api/v1/profiles/{PEDRO}/follow")).status_code == 200


@pytest.mark.asyncio
async def test_las_metricas_responden_vacio_en_vez_de_reventar(base_sin_0027):
    """Vacio es la verdad —«no hay nada medido»—, y un 500 no lo es."""
    http, sesiones, _ = base_sin_0027
    async with sesiones() as db:
        ana = await db.get(Profile, ANA)
        ana.role = "admin"
        await db.commit()
    respuesta = await http.get(f"{API}/metrics")
    assert respuesta.status_code == 200
    assert respuesta.json()["funnels"] == []


@pytest.mark.asyncio
async def test_editar_una_publicacion_no_falla_por_los_temas(base_sin_0027):
    http, _, _ = base_sin_0027
    creado = (
        await http.post(
            POSTS,
            json={
                "body": "algo",
                "media": [{"storage_path": "x/v.mp4", "media_type": "video"}],
            },
        )
    ).json()
    respuesta = await http.patch(
        f"{POSTS}/{creado['id']}", json={"body": "otra cosa", "topic_ids": [CARPINTERIA]}
    )
    assert respuesta.status_code == 200
    assert respuesta.json()["body"] == "otra cosa"


@pytest.mark.asyncio
async def test_el_esquema_se_detecta_una_sola_vez(base_sin_0027):
    """La comprobacion no puede costar una consulta por peticion.

    Se publica algo primero: con el muro vacio no hay temas que leer y la
    comprobacion ni siquiera llega a hacerse.
    """
    from app.modules.recommendations import esquema as e

    http, _, _ = base_sin_0027
    await http.post(
        POSTS,
        json={
            "body": "algo",
            "media": [{"storage_path": "x/v.mp4", "media_type": "video"}],
        },
    )
    await http.get(f"{POSTS}?limit=5")
    assert e._cache.get("post_topics") is False
    await http.get(f"{POSTS}?limit=5")
    assert e._cache.get("post_topics") is False
