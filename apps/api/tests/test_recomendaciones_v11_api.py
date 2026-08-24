"""La V1.1 de extremo a extremo, sobre una base de datos de verdad.

SQLite en memoria, mismo patron que el resto. Las personas de estos escenarios
viven los milisegundos que dura cada prueba: NUNCA llegan a Supabase.

Lo que se comprueba aqui y no cabe en una funcion pura: que nadie pueda
etiquetar publicaciones ajenas, que borrar una publicacion se lleve sus temas,
que un «no me interesa» sobre un video no bloquee a su autor, y que el embudo
de metricas cuente lo que de verdad paso y no lo que nos gustaria.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.content.models import Post, PostMedia
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache
from app.modules.recommendations.models import BehaviorEvent, PostTopic, Topic
from app.shared.database import Base, get_db

API = "/api/v1/recommendations"
POSTS = "/api/v1/posts"

CARPINTERIA = "11111111-1111-1111-1111-111111111111"
COCINA = "22222222-2222-2222-2222-222222222222"
NEGOCIOS = "33333333-3333-3333-3333-333333333333"
INACTIVO = "44444444-4444-4444-4444-444444444444"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
PEDRO = "aaaaaaaa-0000-0000-0000-000000000002"


@pytest_asyncio.fixture
async def entorno():
    cache.vaciar()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        from app.modules.bookings import models as _b  # noqa: F401
        from app.modules.catalog import models as _c  # noqa: F401
        from app.modules.communities import models as _co  # noqa: F401
        from app.modules.learning import models as _l  # noqa: F401
        from app.modules.messaging import models as _m  # noqa: F401
        from app.modules.moderation import models as _mo  # noqa: F401
        from app.modules.notifications import device_tokens as _dt  # noqa: F401
        from app.modules.notifications import models as _n  # noqa: F401
        from app.modules.social_graph import models as _s  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        for pos, (tid, slug, nombre, activo) in enumerate(
            [
                (CARPINTERIA, "carpinteria", "Carpintería", True),
                (COCINA, "cocina", "Cocina", True),
                (NEGOCIOS, "negocios", "Negocios", True),
                (INACTIVO, "retirado", "Retirado", False),
            ]
        ):
            db.add(
                Topic(id=tid, slug=slug, name=nombre, topic_group="Test",
                      position=pos, active=activo)
            )
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
    await engine.dispose()


async def _publicar(http, texto: str, temas: list[str] | None = None) -> dict:
    respuesta = await http.post(
        POSTS,
        json={
            "body": texto,
            "media": [{"storage_path": f"x/{uuid4()}.mp4", "media_type": "video"}],
            "topic_ids": temas or [],
        },
    )
    assert respuesta.status_code == 201, respuesta.text
    return respuesta.json()


# --------------------------------------------------------------------------- #
# Temas del contenido
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_se_puede_publicar_diciendo_de_que_trata(entorno):
    http, _, _ = entorno
    creado = await _publicar(http, "Cómo montar una mesa", [CARPINTERIA])
    assert creado["topic_ids"] == [CARPINTERIA]


@pytest.mark.asyncio
async def test_una_publicacion_admite_hasta_tres_temas(entorno):
    http, _, _ = entorno
    creado = await _publicar(http, "Mesa para un negocio", [CARPINTERIA, NEGOCIOS, COCINA])
    assert set(creado["topic_ids"]) == {CARPINTERIA, NEGOCIOS, COCINA}


@pytest.mark.asyncio
async def test_mas_de_tres_temas_se_rechaza(entorno):
    """Con mas, etiquetar deja de significar «de esto trata»."""
    http, _, _ = entorno
    respuesta = await http.post(
        POSTS,
        json={
            "body": "todo a la vez",
            "media": [{"storage_path": "x/v.mp4", "media_type": "video"}],
            "topic_ids": [CARPINTERIA, COCINA, NEGOCIOS, INACTIVO],
        },
    )
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_un_tema_inventado_no_se_guarda_ni_a_medias(entorno):
    """Se rechaza la publicacion entera: guardar «lo que se pueda» dejaria a
    quien publica creyendo que su video esta clasificado en algo que no lo esta."""
    http, sesiones, _ = entorno
    respuesta = await http.post(
        POSTS,
        json={
            "body": "algo",
            "media": [{"storage_path": "x/v.mp4", "media_type": "video"}],
            "topic_ids": [CARPINTERIA, "99999999-9999-9999-9999-999999999999"],
        },
    )
    assert respuesta.status_code == 422
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(PostTopic)) == 0


@pytest.mark.asyncio
async def test_un_tema_retirado_ya_no_se_puede_elegir(entorno):
    """Retirar un tema no borra las relaciones que ya apuntaban a el, pero si
    impide crear nuevas."""
    http, _, _ = entorno
    respuesta = await http.post(
        POSTS,
        json={
            "body": "algo",
            "media": [{"storage_path": "x/v.mp4", "media_type": "video"}],
            "topic_ids": [INACTIVO],
        },
    )
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_repetir_un_tema_no_lo_duplica(entorno):
    http, sesiones, _ = entorno
    creado = await _publicar(http, "mesa", [CARPINTERIA, CARPINTERIA])
    assert creado["topic_ids"] == [CARPINTERIA]
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(PostTopic)) == 1


@pytest.mark.asyncio
async def test_publicar_sin_temas_sigue_funcionando(entorno):
    """Etiquetar es opcional: obligar a hacerlo convertiria publicar en un
    formulario, que es justo de lo que se venia."""
    http, _, _ = entorno
    creado = await _publicar(http, "sin clasificar")
    assert creado["topic_ids"] == []


# --------------------------------------------------------------------------- #
# Editar
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_editar_reemplaza_los_temas_y_no_deja_fantasmas(entorno):
    http, sesiones, _ = entorno
    creado = await _publicar(http, "mesa", [CARPINTERIA])
    respuesta = await http.patch(f"{POSTS}/{creado['id']}", json={"topic_ids": [COCINA]})
    assert respuesta.status_code == 200
    assert respuesta.json()["topic_ids"] == [COCINA]
    async with sesiones() as db:
        temas = set(
            (
                await db.scalars(
                    select(PostTopic.topic_id).where(PostTopic.post_id == creado["id"])
                )
            ).all()
        )
    assert temas == {COCINA}


@pytest.mark.asyncio
async def test_editar_sin_mandar_temas_los_deja_como_estaban(entorno):
    """Ausente no es lo mismo que vacio: cambiar el texto no puede desclasificar
    la publicacion sin querer."""
    http, _, _ = entorno
    creado = await _publicar(http, "mesa", [CARPINTERIA])
    respuesta = await http.patch(f"{POSTS}/{creado['id']}", json={"body": "otra cosa"})
    assert respuesta.json()["topic_ids"] == [CARPINTERIA]


@pytest.mark.asyncio
async def test_mandar_una_lista_vacia_si_quita_todos_los_temas(entorno):
    http, _, _ = entorno
    creado = await _publicar(http, "mesa", [CARPINTERIA])
    respuesta = await http.patch(f"{POSTS}/{creado['id']}", json={"topic_ids": []})
    assert respuesta.json()["topic_ids"] == []


@pytest.mark.asyncio
async def test_nadie_etiqueta_la_publicacion_de_otra_persona(entorno):
    """Etiquetar decide a quien se le recomienda: no es un detalle cosmetico."""
    http, sesiones, identidad = entorno
    creado = await _publicar(http, "mesa de Ana", [CARPINTERIA])

    identidad["uid"] = PEDRO
    respuesta = await http.patch(f"{POSTS}/{creado['id']}", json={"topic_ids": [COCINA]})
    assert respuesta.status_code == 403

    async with sesiones() as db:
        temas = set(
            (
                await db.scalars(
                    select(PostTopic.topic_id).where(PostTopic.post_id == creado["id"])
                )
            ).all()
        )
    assert temas == {CARPINTERIA}


@pytest.mark.asyncio
async def test_editar_una_publicacion_no_toca_los_temas_de_otra(entorno):
    http, sesiones, _ = entorno
    primera = await _publicar(http, "mesa", [CARPINTERIA])
    segunda = await _publicar(http, "receta", [COCINA])
    await http.patch(f"{POSTS}/{segunda['id']}", json={"topic_ids": [NEGOCIOS]})
    async with sesiones() as db:
        temas = set(
            (
                await db.scalars(
                    select(PostTopic.topic_id).where(PostTopic.post_id == primera["id"])
                )
            ).all()
        )
    assert temas == {CARPINTERIA}


@pytest.mark.asyncio
async def test_retirar_una_publicacion_la_saca_de_las_recomendaciones(entorno):
    """Retirar es un borrado SUAVE: la fila sigue existiendo con estado
    'deleted', asi que sus temas tampoco desaparecen —no quedan huerfanos, su
    publicacion sigue ahi—. Lo que si tiene que pasar es que deje de
    recomendarse."""
    http, sesiones, _ = entorno
    creado = await _publicar(http, "mesa", [CARPINTERIA])
    assert (await http.delete(f"{POSTS}/{creado['id']}")).status_code == 204

    datos = (await http.get(f"{API}/content?limit=10&media=video")).json()
    assert creado["id"] not in [p["id"] for p in datos["items"]]

    async with sesiones() as db:
        restantes = await db.scalar(
            select(func.count()).select_from(PostTopic).where(
                PostTopic.post_id == creado["id"]
            )
        )
    assert restantes == 1


def test_la_migracion_declara_la_cascada_al_borrar_de_verdad():
    """El borrado FISICO si ocurre: al eliminar una cuenta, la cascada baja de
    `profiles` a `posts` y de ahi a `post_topics`. Sin ella quedarian etiquetas
    apuntando a publicaciones que ya no existen.

    Se comprueba sobre el SQL porque es una garantia del ESQUEMA, no del
    codigo, y porque SQLite no aplica claves foraneas por defecto: una prueba
    en memoria diria que funciona sin haberlo comprobado de verdad.
    """
    import re
    from pathlib import Path

    sql = (
        Path(__file__).resolve().parents[3]
        / "supabase"
        / "migrations"
        / "0027_temas_del_contenido_y_atribucion.sql"
    ).read_text(encoding="utf-8")
    # Sin comentarios: el propio fichero explica la cascada en prosa, y buscar
    # el texto crudo daria positivo por el comentario en vez de por el SQL.
    sin_comentarios = "\n".join(linea.split("--")[0] for linea in sql.splitlines())
    assert re.search(
        r"post_id\s+uuid\s+not null\s+references\s+public\.posts\(id\)\s+on delete cascade",
        sin_comentarios,
    ), "post_topics tiene que caer con su publicacion"
    assert re.search(
        r"topic_id\s+uuid\s+not null\s+references\s+public\.topics\(id\)\s+on delete cascade",
        sin_comentarios,
    ), "post_topics tiene que caer con su tema"


# --------------------------------------------------------------------------- #
# El ranking usa el tema propio antes que el del autor
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_video_de_cocina_de_un_carpintero_no_sube_como_carpinteria(entorno):
    """El escenario del documento, contra la base de datos.

    Pedro es carpintero y publica dos cosas: una mesa y una receta. Ana quiere
    aprender carpinteria. La mesa tiene que ir por delante.
    """
    http, _, identidad = entorno

    identidad["uid"] = PEDRO
    mesa = await _publicar(http, "Cómo montar una mesa", [CARPINTERIA])
    receta = await _publicar(http, "Mi receta favorita", [COCINA])

    identidad["uid"] = ANA
    await http.put(
        f"{API}/preferences",
        json={"learning_topic_ids": [CARPINTERIA], "connection_types": ["ensena"]},
    )
    # Pedro declara que ensena carpinteria: sin eso no seria un candidato.
    identidad["uid"] = PEDRO
    await http.put(
        f"{API}/preferences",
        json={"offer_modes": ["puedo_ensenar"], "offer_topic_ids": [CARPINTERIA]},
    )

    identidad["uid"] = ANA
    datos = (await http.get(f"{API}/content?limit=10&media=video")).json()
    ids = [p["id"] for p in datos["items"]]
    assert ids.index(mesa["id"]) < ids.index(receta["id"])
    assert datos["with_own_topics"] == 2


@pytest.mark.asyncio
async def test_el_contenido_sin_clasificar_sigue_apareciendo(entorno):
    """Compatibilidad hacia atras: lo publicado antes de la 0027 no desaparece."""
    http, _, identidad = entorno
    identidad["uid"] = PEDRO
    antiguo = await _publicar(http, "publicado antes de la migracion")

    identidad["uid"] = ANA
    await http.put(f"{API}/preferences", json={"learning_topic_ids": [CARPINTERIA]})
    datos = (await http.get(f"{API}/content?limit=10&media=video")).json()
    assert antiguo["id"] in [p["id"] for p in datos["items"]]
    assert datos["with_own_topics"] == 0


# --------------------------------------------------------------------------- #
# «No me interesa» sobre contenido
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_rechazar_un_video_lo_retira_del_feed(entorno):
    http, _, identidad = entorno
    identidad["uid"] = PEDRO
    rechazado = await _publicar(http, "no me gusta", [COCINA])
    otro = await _publicar(http, "este si", [CARPINTERIA])

    identidad["uid"] = ANA
    await http.post(
        f"{API}/events",
        json={
            "events": [
                {
                    "event_type": "not_interested",
                    "entity_type": "post",
                    "entity_id": rechazado["id"],
                    "surface": "for_you_feed",
                    "algorithm_version": "content-v1.1",
                    "rank": 0,
                }
            ]
        },
    )
    datos = (await http.get(f"{API}/content?limit=10&media=video")).json()
    ids = [p["id"] for p in datos["items"]]
    assert rechazado["id"] not in ids
    assert otro["id"] in ids


@pytest.mark.asyncio
async def test_rechazar_un_video_NO_bloquea_a_su_autor(entorno):
    """La confusion que arruinaria el producto: un rechazo es una senal sobre
    un contenido, no una sentencia sobre una persona."""
    http, _, identidad = entorno
    identidad["uid"] = PEDRO
    rechazado = await _publicar(http, "uno", [COCINA])
    otro_del_mismo = await _publicar(http, "otro", [CARPINTERIA])

    identidad["uid"] = ANA
    await http.post(
        f"{API}/events",
        json={
            "events": [
                {
                    "event_type": "not_interested",
                    "entity_type": "post",
                    "entity_id": rechazado["id"],
                }
            ]
        },
    )
    datos = (await http.get(f"{API}/content?limit=10&media=video")).json()
    assert otro_del_mismo["id"] in [p["id"] for p in datos["items"]]

    # Y Pedro sigue siendo recomendable como persona.
    personas = (await http.get(f"{API}/people?limit=10")).json()
    assert PEDRO in [p["id"] for p in personas["items"]]


@pytest.mark.asyncio
async def test_el_rechazo_guarda_los_temas_del_contenido(entorno):
    """Sin ellos, «no me interesa» solo escondería ese video y no aprenderia
    nada: es lo que convierte un rechazo en una senal util."""
    http, sesiones, identidad = entorno
    identidad["uid"] = PEDRO
    rechazado = await _publicar(http, "receta", [COCINA])

    identidad["uid"] = ANA
    await http.post(
        f"{API}/events",
        json={
            "events": [
                {
                    "event_type": "not_interested",
                    "entity_type": "post",
                    "entity_id": rechazado["id"],
                }
            ]
        },
    )
    async with sesiones() as db:
        evento = (
            await db.scalars(
                select(BehaviorEvent).where(BehaviorEvent.event_type == "not_interested")
            )
        ).first()
    assert evento is not None
    assert evento.topic_ids == [COCINA]


@pytest.mark.asyncio
async def test_nadie_registra_feedback_en_nombre_de_otra_persona(entorno):
    """El identificador sale del token; mandar uno en el cuerpo no cambia nada."""
    http, sesiones, _ = entorno
    await http.post(
        f"{API}/events",
        json={
            "user_id": PEDRO,
            "events": [
                {
                    "event_type": "not_interested",
                    "entity_type": "post",
                    "entity_id": str(uuid4()),
                }
            ],
        },
    )
    async with sesiones() as db:
        duenos = set(
            (await db.scalars(select(BehaviorEvent.user_id))).all()
        )
    assert duenos == {ANA}


# --------------------------------------------------------------------------- #
# Atribucion
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_recomendacion_de_persona_dice_en_que_puesto_salio(entorno):
    http, _, _ = entorno
    datos = (await http.get(f"{API}/people?limit=10")).json()
    assert [p["rank"] for p in datos["items"]] == list(range(len(datos["items"])))


@pytest.mark.asyncio
async def test_el_puesto_continua_al_paginar(entorno):
    """Si la segunda pagina empezara otra vez en 0, la posicion no significaria
    nada y las tasas por puesto saldrian mal."""
    http, sesiones, _ = entorno
    async with sesiones() as db:
        # Destacados: sin publicaciones no entrarian por la via de actividad, y
        # lo que se comprueba aqui es la paginacion, no como se generan.
        for i in range(4):
            db.add(
                Profile(
                    id=str(uuid4()),
                    full_name=f"P{i}",
                    username=f"p{i}",
                    is_featured=True,
                )
            )
        await db.commit()
    segunda = (await http.get(f"{API}/people?limit=2&offset=2")).json()
    assert [p["rank"] for p in segunda["items"]] == [2, 3]


@pytest.mark.asyncio
async def test_la_impresion_conserva_superficie_version_y_puesto(entorno):
    http, sesiones, _ = entorno
    await http.post(
        f"{API}/events",
        json={
            "events": [
                {
                    "event_type": "content_impression",
                    "entity_type": "profile",
                    "entity_id": PEDRO,
                    "surface": "people_for_you",
                    "algorithm_version": "people-v1.1",
                    "rank": 3,
                    "event_key": "imp-1",
                }
            ]
        },
    )
    async with sesiones() as db:
        evento = (
            await db.scalars(
                select(BehaviorEvent).where(
                    BehaviorEvent.event_type == "content_impression"
                )
            )
        ).first()
    assert evento.surface == "people_for_you"
    assert evento.algorithm_version == "people-v1.1"
    assert evento.rank == 3


@pytest.mark.asyncio
async def test_una_superficie_inventada_se_rechaza(entorno):
    """Una superficie escrita a mano en dos sitios acaba siendo dos, y las
    metricas dejan de sumar."""
    http, _, _ = entorno
    respuesta = await http.post(
        f"{API}/events",
        json={
            "events": [
                {
                    "event_type": "profile_view",
                    "entity_type": "profile",
                    "entity_id": PEDRO,
                    "surface": "pantalla_secreta",
                }
            ]
        },
    )
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_una_accion_sin_superficie_sigue_valiendo(entorno):
    """Abrir un perfil desde un comentario no viene de una recomendacion. Eso
    es informacion, no un hueco que rellenar."""
    http, _, _ = entorno
    respuesta = await http.post(
        f"{API}/events",
        json={
            "events": [
                {"event_type": "profile_view", "entity_type": "profile", "entity_id": PEDRO}
            ]
        },
    )
    assert respuesta.status_code == 200
    assert respuesta.json()["accepted"] == 1


# --------------------------------------------------------------------------- #
# Metricas
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_las_metricas_solo_las_ve_la_administracion(entorno):
    """Es informacion agregada del producto, no de una persona, pero dice
    cuanta gente hay al otro lado y como se comporta."""
    http, _, _ = entorno
    assert (await http.get(f"{API}/metrics")).status_code == 403


@pytest.mark.asyncio
async def test_el_embudo_relaciona_la_impresion_con_lo_que_paso_despues(entorno):
    """La pregunta que la V1 no podia responder: ¿sirvio de algo?"""
    http, sesiones, identidad = entorno
    async with sesiones() as db:
        ana = await db.get(Profile, ANA)
        ana.role = "admin"
        await db.commit()

    await http.post(
        f"{API}/events",
        json={
            "events": [
                {
                    "event_type": "content_impression",
                    "entity_type": "profile",
                    "entity_id": PEDRO,
                    "surface": "people_for_you",
                    "algorithm_version": "people-v1.1",
                    "rank": 0,
                    "event_key": "imp-pedro",
                },
                {
                    "event_type": "profile_view",
                    "entity_type": "profile",
                    "entity_id": PEDRO,
                    "surface": "people_for_you",
                    "algorithm_version": "people-v1.1",
                    "event_key": "vista-pedro",
                },
            ]
        },
    )
    # Seguir lo escribe el SERVIDOR, no el cliente.
    assert (await http.post(f"/api/v1/profiles/{PEDRO}/follow")).status_code == 200

    datos = (await http.get(f"{API}/metrics?days=30")).json()
    embudo = next(f for f in datos["funnels"] if f["surface"] == "people_for_you")
    assert embudo["algorithm_version"] == "people-v1.1"
    assert embudo["impressions"] == 1
    assert embudo["conversions"]["profile_view"] == 1
    assert embudo["conversions"]["follow"] == 1
    assert embudo["rates"]["follow"] == 1.0
    # Lo que no ocurrio sale a CERO, no ausente: un hueco se lee como «no se
    # midio», que es otra cosa muy distinta.
    assert embudo["conversions"]["booking_completed"] == 0


@pytest.mark.asyncio
async def test_sin_actividad_las_metricas_devuelven_vacio_y_no_inventan_nada(entorno):
    http, sesiones, _ = entorno
    async with sesiones() as db:
        ana = await db.get(Profile, ANA)
        ana.role = "admin"
        await db.commit()
    datos = (await http.get(f"{API}/metrics")).json()
    assert datos["funnels"] == []
    assert datos["attribution_window_days"] > 0


@pytest.mark.asyncio
async def test_una_accion_fuera_de_la_ventana_no_se_atribuye(entorno):
    """Atribuir un follow de hace tres meses a una impresion de hoy seria
    contarse un exito que no ocurrio."""
    http, sesiones, _ = entorno
    async with sesiones() as db:
        ana = await db.get(Profile, ANA)
        ana.role = "admin"
        hace_mucho = datetime.now(timezone.utc) - timedelta(days=20)
        db.add(
            BehaviorEvent(
                user_id=ANA,
                event_type="content_impression",
                entity_type="profile",
                entity_id=PEDRO,
                surface="people_for_you",
                algorithm_version="people-v1.1",
                rank=0,
                created_at=hace_mucho,
            )
        )
        db.add(
            BehaviorEvent(
                user_id=ANA,
                event_type="follow",
                entity_type="profile",
                entity_id=PEDRO,
                source="server",
                created_at=datetime.now(timezone.utc),
            )
        )
        await db.commit()

    datos = (await http.get(f"{API}/metrics?days=60")).json()
    embudo = next(f for f in datos["funnels"] if f["surface"] == "people_for_you")
    assert embudo["impressions"] == 1
    assert embudo["conversions"]["follow"] == 0
