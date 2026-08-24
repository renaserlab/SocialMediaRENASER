"""El recomendador de extremo a extremo, sobre una base de datos de verdad.

Corre sobre SQLite EN MEMORIA, con el mismo patron que `test_feed_metadata`.
Las personas que aparecen aqui existen durante los milisegundos que dura cada
prueba y mueren con ella: NUNCA llegan a Supabase, y por eso se puede probar
que «Carlos aparece antes que Lucia» sin ensuciar los datos reales ni las
metricas de nadie.

Lo que se comprueba aqui y no se puede comprobar con funciones puras: que la
identidad salga del token, que las exclusiones funcionen contra la base, que
guardar sea un reemplazo y que un lote repetido no duplique senales.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.content.models import Post, PostMedia
from app.modules.profiles.models import Profile
from app.modules.recommendations.models import (
    BehaviorEvent,
    RecommendationPreference,
    Topic,
    UserTopicRelation,
)
from app.modules.social_graph.models import Follow, UserBlock
from app.shared.database import Base, get_db

CARPINTERIA = "11111111-1111-1111-1111-111111111111"
MARKETING = "22222222-2222-2222-2222-222222222222"
REACT = "33333333-3333-3333-3333-333333333333"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
CARLOS = "aaaaaaaa-0000-0000-0000-000000000002"
LUCIA = "aaaaaaaa-0000-0000-0000-000000000003"
ANDRES = "aaaaaaaa-0000-0000-0000-000000000004"

API = "/api/v1/recommendations"


@pytest_asyncio.fixture
async def entorno():
    """La aplicacion real contra una base efimera, y Ana autenticada.

    La identidad se sustituye por la dependencia de FastAPI, no por un token
    falso: asi lo que se prueba es el codigo de produccion tal cual, incluido
    que ningun endpoint acepte un `user_id` del cliente.
    """
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

        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    ahora = datetime.now(timezone.utc)

    async with sesiones() as db:
        for pos, (tid, slug, nombre) in enumerate(
            [
                (CARPINTERIA, "carpinteria", "Carpintería"),
                (MARKETING, "marketing", "Marketing"),
                (REACT, "programacion", "Programación"),
            ]
        ):
            db.add(Topic(id=tid, slug=slug, name=nombre, topic_group="Test", position=pos))
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=CARLOS, full_name="Carlos", username="carlos"))
        db.add(Profile(id=LUCIA, full_name="Lucía", username="lucia"))
        db.add(Profile(id=ANDRES, full_name="Andrés", username="andres"))

        # La oferta de cada cual.
        for uid, tema, relaciones in [
            (CARLOS, CARPINTERIA, ["can_help", "teach", "experienced"]),
            (LUCIA, MARKETING, ["teach"]),
            (ANDRES, REACT, ["teach", "experienced"]),
        ]:
            for relacion in relaciones:
                db.add(
                    UserTopicRelation(
                        user_id=uid, topic_id=tema, relation=relacion, source="onboarding"
                    )
                )

        # Contenido real de cada uno, para que la actividad no sea cero.
        for uid in (CARLOS, LUCIA, ANDRES):
            post = Post(
                id=str(uuid4()),
                author_id=uid,
                body=f"video de {uid}",
                status="published",
                created_at=ahora - timedelta(hours=1),
            )
            db.add(post)
            await db.flush()
            db.add(
                PostMedia(post_id=post.id, storage_path=f"{uid}/v.mp4", media_type="video")
            )
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


# --------------------------------------------------------------------------- #
# Onboarding
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_usuario_sin_preferencias_ve_el_cuestionario(entorno):
    """Incluye a los que ya existian: no tienen fila, asi que se les pregunta."""
    http, _, _ = entorno
    datos = (await http.get(f"{API}/onboarding/status")).json()
    assert datos["should_show"] is True
    assert datos["completed"] is False


@pytest.mark.asyncio
async def test_el_catalogo_trae_los_temas_de_la_base_y_no_una_lista_del_movil(entorno):
    http, _, _ = entorno
    datos = (await http.get(f"{API}/onboarding/catalog")).json()
    assert {t["slug"] for t in datos["topics"]} == {"carpinteria", "marketing", "programacion"}
    assert datos["goals"] and datos["connection_types"] and datos["content_formats"]


@pytest.mark.asyncio
async def test_guardar_las_respuestas_deja_de_preguntar(entorno):
    http, _, _ = entorno
    respuesta = await http.put(
        f"{API}/preferences",
        json={
            "goals": ["aprender"],
            "learning_topic_ids": [CARPINTERIA],
            "connection_types": ["ensena"],
            "content_formats": ["video"],
        },
    )
    assert respuesta.status_code == 200
    estado = (await http.get(f"{API}/onboarding/status")).json()
    assert estado["should_show"] is False
    assert estado["completed"] is True


@pytest.mark.asyncio
async def test_el_servidor_deduce_las_relaciones_a_partir_de_las_respuestas(entorno):
    """El movil manda respuestas; la regla de producto vive en el servidor."""
    http, _, _ = entorno
    await http.put(
        f"{API}/preferences",
        json={
            "goals": ["aprender", "orientacion"],
            "learning_topic_ids": [CARPINTERIA],
        },
    )
    datos = (await http.get(f"{API}/preferences")).json()
    derivadas = {d["topic_id"]: set(d["relations"]) for d in datos["derived_relations"]}
    assert derivadas[CARPINTERIA] == {"learn", "interest", "seek_guidance"}


@pytest.mark.asyncio
async def test_decir_que_puedo_ayudar_crea_la_oferta(entorno):
    http, _, _ = entorno
    await http.put(
        f"{API}/preferences",
        json={
            "offer_modes": ["puedo_ensenar", "ofrezco_sesiones"],
            "offer_topic_ids": [MARKETING],
        },
    )
    datos = (await http.get(f"{API}/preferences")).json()
    derivadas = {d["topic_id"]: set(d["relations"]) for d in datos["derived_relations"]}
    # «Ofrezco sesiones» describe el canal, no el conocimiento: no crea relacion.
    assert derivadas[MARKETING] == {"teach"}


@pytest.mark.asyncio
async def test_editar_las_preferencias_reemplaza_y_no_suma(entorno):
    """El fallo que dejaria «temas fantasma»: quien se equivoco no podria quitarlo."""
    http, sesiones, _ = entorno
    await http.put(f"{API}/preferences", json={"learning_topic_ids": [CARPINTERIA]})
    await http.put(f"{API}/preferences", json={"learning_topic_ids": [MARKETING]})

    datos = (await http.get(f"{API}/preferences")).json()
    assert datos["learning_topic_ids"] == [MARKETING]
    async with sesiones() as db:
        from sqlalchemy import select

        temas = set(
            (
                await db.scalars(
                    select(UserTopicRelation.topic_id).where(
                        UserTopicRelation.user_id == ANA
                    )
                )
            ).all()
        )
    assert temas == {MARKETING}


@pytest.mark.asyncio
async def test_editar_lo_propio_no_toca_las_relaciones_de_nadie_mas(entorno):
    """El borrado del reemplazo esta acotado a la persona y a su cuestionario."""
    http, sesiones, _ = entorno
    await http.put(f"{API}/preferences", json={"learning_topic_ids": [CARPINTERIA]})
    async with sesiones() as db:
        from sqlalchemy import func, select

        de_carlos = await db.scalar(
            select(func.count())
            .select_from(UserTopicRelation)
            .where(UserTopicRelation.user_id == CARLOS)
        )
    assert de_carlos == 3


@pytest.mark.asyncio
async def test_nadie_puede_escribir_las_preferencias_de_otra_persona(entorno):
    """No hay campo por donde intentarlo: el identificador sale del token.

    Mandar un `user_id` en el cuerpo no cambia nada; se ignora y lo guardado
    sigue siendo de quien hizo la peticion.
    """
    http, sesiones, _ = entorno
    await http.put(
        f"{API}/preferences",
        json={"user_id": CARLOS, "learning_topic_ids": [CARPINTERIA]},
    )
    async with sesiones() as db:
        from sqlalchemy import select

        propietarios = set(
            (
                await db.scalars(
                    select(UserTopicRelation.user_id).where(
                        UserTopicRelation.topic_id == CARPINTERIA,
                        UserTopicRelation.relation == "learn",
                    )
                )
            ).all()
        )
    assert propietarios == {ANA}


@pytest.mark.asyncio
async def test_un_tema_que_no_existe_se_rechaza_entero(entorno):
    """Guardar «lo que se pueda» dejaria a la persona creyendo que eligio algo."""
    http, _, _ = entorno
    respuesta = await http.put(
        f"{API}/preferences",
        json={"learning_topic_ids": ["99999999-9999-9999-9999-999999999999"]},
    )
    assert respuesta.status_code == 422
    assert (await http.get(f"{API}/onboarding/status")).json()["should_show"] is True


@pytest.mark.asyncio
async def test_una_respuesta_inventada_no_se_guarda(entorno):
    http, _, _ = entorno
    respuesta = await http.put(f"{API}/preferences", json={"goals": ["hackear"]})
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_saltar_el_cuestionario_no_vuelve_a_preguntar_pero_no_cuenta_como_hecho(
    entorno,
):
    http, _, _ = entorno
    await http.put(f"{API}/preferences", json={"skipped": True})
    estado = (await http.get(f"{API}/onboarding/status")).json()
    assert estado["should_show"] is False
    assert estado["completed"] is False
    assert estado["skipped"] is True


@pytest.mark.asyncio
async def test_guardar_dos_veces_lo_mismo_deja_el_mismo_estado(entorno):
    """Idempotente: el boton pulsado dos veces no duplica nada."""
    http, sesiones, _ = entorno
    cuerpo = {"learning_topic_ids": [CARPINTERIA], "goals": ["aprender"]}
    await http.put(f"{API}/preferences", json=cuerpo)
    await http.put(f"{API}/preferences", json=cuerpo)
    async with sesiones() as db:
        from sqlalchemy import func, select

        total = await db.scalar(
            select(func.count())
            .select_from(UserTopicRelation)
            .where(UserTopicRelation.user_id == ANA)
        )
    assert total == 2  # learn + interest, una sola vez


# --------------------------------------------------------------------------- #
# Personas para ti
# --------------------------------------------------------------------------- #
async def _preferir_carpinteria(http):
    await http.put(
        f"{API}/preferences",
        json={
            "goals": ["aprender"],
            "learning_topic_ids": [CARPINTERIA],
            "connection_types": ["ensena"],
        },
    )


@pytest.mark.asyncio
async def test_quien_ensena_lo_que_busco_sale_primero(entorno):
    http, _, _ = entorno
    await _preferir_carpinteria(http)
    datos = (await http.get(f"{API}/people?limit=10")).json()
    assert datos["strategy"] == "personalized"
    assert datos["items"][0]["full_name"] == "Carlos"


@pytest.mark.asyncio
async def test_cada_recomendacion_trae_su_por_que(entorno):
    http, _, _ = entorno
    await _preferir_carpinteria(http)
    primero = (await http.get(f"{API}/people?limit=10")).json()["items"][0]
    codigos = {r["code"] for r in primero["reasons"]}
    assert "TOPIC_MATCH" in codigos
    temas = [t for r in primero["reasons"] for t in r["topics"]]
    # El nombre legible, no el identificador: es lo que la interfaz escribe.
    assert "Carpintería" in temas


@pytest.mark.asyncio
async def test_el_score_no_viaja_a_la_pantalla(entorno):
    """«0.8734261» no significa nada para quien lo lee."""
    http, _, _ = entorno
    await _preferir_carpinteria(http)
    primero = (await http.get(f"{API}/people?limit=10")).json()["items"][0]
    assert primero["debug"] is None
    assert "score" not in primero


@pytest.mark.asyncio
async def test_en_desarrollo_si_se_puede_inspeccionar_el_desglose(entorno):
    http, _, _ = entorno
    await _preferir_carpinteria(http)
    primero = (await http.get(f"{API}/people?limit=10&debug=1")).json()["items"][0]
    assert primero["debug"]["final"] > 0


@pytest.mark.asyncio
async def test_nadie_se_recomienda_a_si_mismo(entorno):
    http, _, _ = entorno
    await _preferir_carpinteria(http)
    datos = (await http.get(f"{API}/people?limit=20")).json()
    assert ANA not in [p["id"] for p in datos["items"]]


@pytest.mark.asyncio
async def test_un_perfil_bloqueado_no_se_recomienda(entorno):
    http, sesiones, _ = entorno
    await _preferir_carpinteria(http)
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=ANA, blocked_id=CARLOS))
        await db.commit()
    datos = (await http.get(f"{API}/people?limit=20")).json()
    assert CARLOS not in [p["id"] for p in datos["items"]]


@pytest.mark.asyncio
async def test_quien_me_bloqueo_tampoco_aparece(entorno):
    """El corte es simetrico: si no, bloquear no protegeria de nada."""
    http, sesiones, _ = entorno
    await _preferir_carpinteria(http)
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=CARLOS, blocked_id=ANA))
        await db.commit()
    datos = (await http.get(f"{API}/people?limit=20")).json()
    assert CARLOS not in [p["id"] for p in datos["items"]]


@pytest.mark.asyncio
async def test_a_quien_ya_sigo_no_hace_falta_recomendarmelo(entorno):
    http, sesiones, _ = entorno
    await _preferir_carpinteria(http)
    async with sesiones() as db:
        db.add(Follow(follower_id=ANA, following_id=CARLOS))
        await db.commit()
    datos = (await http.get(f"{API}/people?limit=20")).json()
    assert CARLOS not in [p["id"] for p in datos["items"]]
    # Salvo que se pida expresamente verlos.
    con_seguidos = (await http.get(f"{API}/people?limit=20&include_following=true")).json()
    assert CARLOS in [p["id"] for p in con_seguidos["items"]]


@pytest.mark.asyncio
async def test_una_cuenta_privada_no_se_recomienda(entorno):
    http, sesiones, _ = entorno
    await _preferir_carpinteria(http)
    async with sesiones() as db:
        carlos = await db.get(Profile, CARLOS)
        carlos.is_private = True
        await db.commit()
    datos = (await http.get(f"{API}/people?limit=20")).json()
    assert CARLOS not in [p["id"] for p in datos["items"]]


@pytest.mark.asyncio
async def test_decir_no_me_interesa_lo_saca_de_la_lista(entorno):
    http, _, _ = entorno
    await _preferir_carpinteria(http)
    await http.post(
        f"{API}/events",
        json={
            "events": [
                {
                    "event_type": "not_interested",
                    "entity_type": "profile",
                    "entity_id": CARLOS,
                }
            ]
        },
    )
    datos = (await http.get(f"{API}/people?limit=20")).json()
    assert CARLOS not in [p["id"] for p in datos["items"]]


@pytest.mark.asyncio
async def test_sin_preferencias_hay_respaldo_y_se_dice_que_lo_es(entorno):
    """Nunca una pantalla vacia; y nunca un respaldo disfrazado de coincidencia."""
    http, _, _ = entorno
    datos = (await http.get(f"{API}/people?limit=10")).json()
    assert datos["strategy"] == "cold_start"
    assert len(datos["items"]) >= 3


@pytest.mark.asyncio
async def test_el_resultado_depende_de_quien_pregunta(entorno):
    """Dos personas, mismas preferencias distintas, distinto primero."""
    http, _, identidad = entorno
    await _preferir_carpinteria(http)
    de_ana = (await http.get(f"{API}/people?limit=10")).json()["items"][0]["id"]

    identidad["uid"] = LUCIA
    await http.put(
        f"{API}/preferences",
        json={"learning_topic_ids": [REACT], "connection_types": ["ensena"]},
    )
    de_lucia = (await http.get(f"{API}/people?limit=10")).json()["items"][0]["id"]

    assert de_ana == CARLOS
    assert de_lucia == ANDRES


# --------------------------------------------------------------------------- #
# Contenido
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_contenido_recomendado_llega_con_la_misma_forma_que_el_feed(entorno):
    """Misma forma = el movil cambia de fuente sin cambiar de pantalla."""
    http, _, _ = entorno
    await _preferir_carpinteria(http)
    datos = (await http.get(f"{API}/content?limit=6&media=video")).json()
    assert datos
    assert {"id", "author", "media", "likes_count"} <= set(datos[0])


@pytest.mark.asyncio
async def test_el_contenido_de_quien_encaja_sube(entorno):
    http, _, _ = entorno
    await _preferir_carpinteria(http)
    datos = (await http.get(f"{API}/content?limit=6&media=video")).json()
    assert datos[0]["author"]["id"] == CARLOS


@pytest.mark.asyncio
async def test_el_contenido_de_un_bloqueado_no_aparece(entorno):
    http, sesiones, _ = entorno
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=ANA, blocked_id=CARLOS))
        await db.commit()
    datos = (await http.get(f"{API}/content?limit=10&media=video")).json()
    assert CARLOS not in [p["author"]["id"] for p in datos]


@pytest.mark.asyncio
async def test_no_se_inventa_contenido_que_no_existe(entorno):
    """Tres videos son tres videos. Pedir treinta no rellena con nada."""
    http, _, _ = entorno
    datos = (await http.get(f"{API}/content?limit=30&media=video")).json()
    assert len(datos) == 3


# --------------------------------------------------------------------------- #
# Senales
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_lote_repetido_no_duplica_senales(entorno):
    """El movil reintenta cuando la red falla; eso no puede contar dos veces."""
    http, sesiones, _ = entorno
    lote = {
        "events": [
            {
                "event_type": "profile_view",
                "entity_type": "profile",
                "entity_id": CARLOS,
                "event_key": "vista-1",
            }
        ]
    }
    primera = (await http.post(f"{API}/events", json=lote)).json()
    segunda = (await http.post(f"{API}/events", json=lote)).json()
    assert primera == {"accepted": 1, "duplicated": 0}
    assert segunda == {"accepted": 0, "duplicated": 1}

    async with sesiones() as db:
        from sqlalchemy import func, select

        total = await db.scalar(
            select(func.count()).select_from(BehaviorEvent).where(
                BehaviorEvent.user_id == ANA
            )
        )
    assert total == 1


@pytest.mark.asyncio
async def test_el_movil_no_puede_declarar_que_alguien_siguio_a_alguien(entorno):
    """Las senales fuertes las escribe el servidor cuando ocurren de verdad."""
    http, _, _ = entorno
    respuesta = await http.post(
        f"{API}/events",
        json={
            "events": [
                {"event_type": "follow", "entity_type": "profile", "entity_id": CARLOS}
            ]
        },
    )
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_seguir_a_alguien_deja_su_senal_registrada_por_el_servidor(entorno):
    http, sesiones, _ = entorno
    respuesta = await http.post(f"/api/v1/profiles/{CARLOS}/follow")
    assert respuesta.status_code == 200

    async with sesiones() as db:
        from sqlalchemy import select

        senal = (
            await db.scalars(
                select(BehaviorEvent).where(
                    BehaviorEvent.user_id == ANA, BehaviorEvent.event_type == "follow"
                )
            )
        ).first()
    assert senal is not None
    assert senal.entity_id == CARLOS
    assert senal.source == "server"


@pytest.mark.asyncio
async def test_pedir_una_sesion_deja_su_senal(entorno):
    http, sesiones, _ = entorno
    respuesta = await http.post(
        "/api/v1/bookings",
        json={"provider_id": CARLOS, "topic": "Carpintería básica"},
    )
    assert respuesta.status_code == 201

    async with sesiones() as db:
        from sqlalchemy import select

        senal = (
            await db.scalars(
                select(BehaviorEvent).where(
                    BehaviorEvent.event_type == "booking_requested"
                )
            )
        ).first()
    assert senal is not None
    assert senal.user_id == ANA and senal.entity_id == CARLOS


@pytest.mark.asyncio
async def test_las_senales_alimentan_el_orden_la_proxima_vez(entorno):
    """El bucle completo: mirar mucho a alguien lo sube. Sin entrenar nada.

    Ana no declara preferencias; solo usa la aplicacion. Andres pasa de estar
    en medio del respaldo a estar el primero.
    """
    http, _, _ = entorno
    antes = (await http.get(f"{API}/people?limit=10")).json()["items"]

    await http.post(
        f"{API}/events",
        json={
            "events": [
                {
                    "event_type": "profile_view",
                    "entity_type": "profile",
                    "entity_id": ANDRES,
                    "event_key": f"v{i}",
                }
                for i in range(6)
            ]
        },
    )
    despues = (await http.get(f"{API}/people?limit=10")).json()["items"]

    posicion_antes = [p["id"] for p in antes].index(ANDRES)
    posicion_despues = [p["id"] for p in despues].index(ANDRES)
    assert posicion_despues < posicion_antes or posicion_despues == 0


@pytest.mark.asyncio
async def test_una_senal_sobre_un_video_cuenta_para_su_autor(entorno):
    http, sesiones, _ = entorno
    async with sesiones() as db:
        from sqlalchemy import select

        post_id = (
            await db.scalars(select(Post.id).where(Post.author_id == LUCIA))
        ).first()

    await http.post(
        f"{API}/events",
        json={
            "events": [
                {
                    "event_type": "content_completed",
                    "entity_type": "post",
                    "entity_id": post_id,
                    "value": 1.0,
                    "event_key": f"c{i}",
                }
                for i in range(5)
            ]
        },
    )
    items = (await http.get(f"{API}/people?limit=10")).json()["items"]
    assert items[0]["id"] == LUCIA


# --------------------------------------------------------------------------- #
# El interruptor de vuelta atras
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_apagar_la_personalizacion_no_rompe_nada(entorno, monkeypatch):
    """Vuelta atras sin borrar una fila: se apaga y la aplicacion sigue.

    Ni 503 ni error: respuestas vacias, que es lo que el movil sabe leer para
    caer a su fuente de siempre.
    """
    from app.core.config import get_settings

    ajustes = get_settings()
    monkeypatch.setattr(ajustes, "feature_recommendations_v1", False)

    http, _, _ = entorno
    personas = await http.get(f"{API}/people?limit=10")
    contenido = await http.get(f"{API}/content?limit=6")
    estado = await http.get(f"{API}/onboarding/status")

    assert personas.status_code == 200 and personas.json()["items"] == []
    assert personas.json()["strategy"] == "disabled"
    assert contenido.status_code == 200 and contenido.json() == []
    assert estado.status_code == 200 and estado.json()["should_show"] is False
