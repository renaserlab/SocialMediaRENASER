"""Etiquetar personas, de extremo a extremo, sobre una base de datos de verdad.

SQLite en memoria, mismo patron que el resto. Las personas de estos escenarios
viven los milisegundos que dura cada prueba: NUNCA llegan a Supabase, y NINGUNA
notificacion push sale de aqui —el envio a Expo se comprueba mirando la tabla
`notifications`, que es lo que decide a quien se avisa; el HTTP a Expo esta
apagado por la configuracion de `conftest.py` y ademas no hay dispositivos
registrados—.

LAS TRES COSAS QUE SE ROMPEN SOLAS SI NADIE LAS VIGILA:

  1. Editar una publicacion vuelve a avisar a todo el mundo. Es el fallo por
     defecto: si `fijar` borrara antes de leer, todo pareceria nuevo.
  2. Uno se manda notificaciones a si mismo al etiquetarse en su propia foto.
  3. El bloqueo deja de servir de nada, porque una mencion es justo una via
     para hacerle llegar algo a alguien.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.content.models import PostMention
from app.modules.notifications.models import Notification
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.modules.social_graph.models import UserBlock
from app.shared.database import Base, get_db

POSTS = "/api/v1/posts"
CANDIDATOS = "/api/v1/mentions/candidates"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"
CARLA = "aaaaaaaa-0000-0000-0000-000000000003"


@pytest_asyncio.fixture
async def entorno():
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

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana Ruiz", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno Diaz", username="bruno"))
        db.add(Profile(id=CARLA, full_name="Carla Soto", username="carlita"))
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


async def _publicar(http: AsyncClient, texto: str, menciona: list[str]) -> dict:
    respuesta = await http.post(
        POSTS, json={"body": texto, "mentioned_user_ids": menciona}
    )
    assert respuesta.status_code == 201, respuesta.text
    return respuesta.json()


async def _avisos_de(sesiones, uid: str) -> list[Notification]:
    async with sesiones() as db:
        return list(
            (
                await db.scalars(
                    select(Notification).where(
                        Notification.user_id == uid,
                        Notification.type == "post_mention",
                    )
                )
            ).all()
        )


async def _mencionados(sesiones, post_id: str) -> set[str]:
    async with sesiones() as db:
        return set(
            (
                await db.scalars(
                    select(PostMention.mentioned_user_id).where(
                        PostMention.post_id == post_id
                    )
                )
            ).all()
        )


# --------------------------------------------------------------------------- #
# Se guardan y se avisa
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_etiquetar_a_alguien_guarda_la_mencion(entorno):
    http, sesiones, _ = entorno
    publicacion = await _publicar(http, "Con el equipo", [BRUNO])
    assert await _mencionados(sesiones, publicacion["id"]) == {BRUNO}


@pytest.mark.asyncio
async def test_la_respuesta_devuelve_a_quien_se_etiqueto(entorno):
    http, _, _ = entorno
    publicacion = await _publicar(http, "Con el equipo", [BRUNO])
    assert [m["id"] for m in publicacion["mentions"]] == [BRUNO]
    # Con lo justo para pintar la etiqueta sin pedir otra cosa.
    assert publicacion["mentions"][0]["full_name"] == "Bruno Diaz"
    assert publicacion["mentions"][0]["username"] == "bruno"


@pytest.mark.asyncio
async def test_etiquetar_manda_una_notificacion(entorno):
    http, sesiones, _ = entorno
    publicacion = await _publicar(http, "Con el equipo", [BRUNO])

    avisos = await _avisos_de(sesiones, BRUNO)
    assert len(avisos) == 1
    assert avisos[0].actor_id == ANA
    # `entity_type` + `entity_id` son lo que hace que tocar el aviso abra
    # /post/{id} y no el perfil de quien etiqueto, donde no esta la publicacion.
    assert avisos[0].entity_type == "post"
    assert avisos[0].entity_id == publicacion["id"]


@pytest.mark.asyncio
async def test_se_puede_etiquetar_a_varias_personas(entorno):
    http, sesiones, _ = entorno
    publicacion = await _publicar(http, "Con el equipo", [BRUNO, CARLA])
    assert await _mencionados(sesiones, publicacion["id"]) == {BRUNO, CARLA}
    assert len(await _avisos_de(sesiones, BRUNO)) == 1
    assert len(await _avisos_de(sesiones, CARLA)) == 1


@pytest.mark.asyncio
async def test_publicar_sin_etiquetar_a_nadie_no_avisa(entorno):
    http, sesiones, _ = entorno
    await _publicar(http, "Solo texto", [])
    assert await _avisos_de(sesiones, BRUNO) == []


@pytest.mark.asyncio
async def test_no_se_duplica_una_mencion_repetida_en_la_peticion(entorno):
    """Mandar el mismo id dos veces no puede sonar dos veces."""
    http, sesiones, _ = entorno
    publicacion = await _publicar(http, "Con Bruno", [BRUNO, BRUNO, BRUNO])

    async with sesiones() as db:
        cuantas = await db.scalar(
            select(func.count())
            .select_from(PostMention)
            .where(PostMention.post_id == publicacion["id"])
        )
    assert cuantas == 1
    assert len(await _avisos_de(sesiones, BRUNO)) == 1


# --------------------------------------------------------------------------- #
# La auto-mencion: se guarda, NO se avisa
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_etiquetarse_a_uno_mismo_no_manda_notificacion(entorno):
    """Salir en la propia foto es legitimo; avisarse a uno mismo, absurdo."""
    http, sesiones, _ = entorno
    await _publicar(http, "Aqui estoy yo", [ANA])
    assert await _avisos_de(sesiones, ANA) == []


@pytest.mark.asyncio
async def test_la_auto_mencion_si_se_guarda(entorno):
    """Se guarda: etiquetarse en la propia publicacion es una cosa normal."""
    http, sesiones, _ = entorno
    publicacion = await _publicar(http, "Aqui estamos", [ANA, BRUNO])
    assert await _mencionados(sesiones, publicacion["id"]) == {ANA, BRUNO}


@pytest.mark.asyncio
async def test_la_auto_mencion_no_impide_avisar_a_los_demas(entorno):
    http, sesiones, _ = entorno
    await _publicar(http, "Aqui estamos", [ANA, BRUNO])
    assert len(await _avisos_de(sesiones, BRUNO)) == 1


# --------------------------------------------------------------------------- #
# Bloqueos: simetricos, y en silencio
# --------------------------------------------------------------------------- #
async def _bloquear(sesiones, quien: str, a_quien: str) -> None:
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=quien, blocked_id=a_quien))
        await db.commit()


@pytest.mark.asyncio
async def test_no_se_puede_etiquetar_a_quien_has_bloqueado(entorno):
    http, sesiones, _ = entorno
    await _bloquear(sesiones, ANA, BRUNO)

    publicacion = await _publicar(http, "Con el equipo", [BRUNO])
    assert await _mencionados(sesiones, publicacion["id"]) == set()
    assert await _avisos_de(sesiones, BRUNO) == []


@pytest.mark.asyncio
async def test_no_se_puede_etiquetar_a_quien_te_ha_bloqueado(entorno):
    """EL SENTIDO CONTRARIO, que es el que se olvida.

    Si solo se cortara «a quien yo bloquee», a Bruno le bastaria con no
    bloquear de vuelta para seguir recibiendo avisos de Ana. Un bloqueo que
    solo funciona en un sentido no protege de nada.
    """
    http, sesiones, _ = entorno
    await _bloquear(sesiones, BRUNO, ANA)

    publicacion = await _publicar(http, "Con el equipo", [BRUNO])
    assert await _mencionados(sesiones, publicacion["id"]) == set()
    assert await _avisos_de(sesiones, BRUNO) == []


@pytest.mark.asyncio
async def test_el_bloqueo_no_impide_publicar_ni_avisa_del_bloqueo(entorno):
    """SE CAE EN SILENCIO, y es una decision de privacidad.

    Un 400 diciendo «no puedes etiquetar a esta persona» revelaria que existe un
    bloqueo, y quien bloquea no tiene por que anunciarlo. La publicacion sale,
    y esa mencion sencillamente no esta.
    """
    http, sesiones, _ = entorno
    await _bloquear(sesiones, ANA, BRUNO)

    respuesta = await http.post(
        POSTS, json={"body": "Con el equipo", "mentioned_user_ids": [BRUNO, CARLA]}
    )
    assert respuesta.status_code == 201
    # Y Carla, que no tiene nada que ver, se etiqueta igual.
    assert [m["id"] for m in respuesta.json()["mentions"]] == [CARLA]


@pytest.mark.asyncio
async def test_un_bloqueado_no_sale_en_los_candidatos(entorno):
    """El limite se nota donde tiene que notarse: la persona no aparece."""
    http, sesiones, _ = entorno
    await _bloquear(sesiones, ANA, BRUNO)

    encontrados = (await http.get(f"{CANDIDATOS}?q=bru")).json()
    assert encontrados == []


# --------------------------------------------------------------------------- #
# EDITAR: solo se avisa de lo NUEVO
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_editar_sin_cambiar_las_menciones_no_vuelve_a_avisar(entorno):
    """EL FALLO POR DEFECTO DE TODO ESTO.

    Corregir una falta de ortografia en una publicacion con gente etiquetada no
    puede volver a hacer sonar sus telefonos. Si `fijar` borrara antes de leer
    las anteriores, todo pareceria nuevo y esta prueba veria dos avisos.
    """
    http, sesiones, _ = entorno
    publicacion = await _publicar(http, "Con el equipo", [BRUNO])
    assert len(await _avisos_de(sesiones, BRUNO)) == 1

    editada = await http.patch(
        f"{POSTS}/{publicacion['id']}",
        json={"body": "Con el equipo!", "mentioned_user_ids": [BRUNO]},
    )
    assert editada.status_code == 200
    assert len(await _avisos_de(sesiones, BRUNO)) == 1


@pytest.mark.asyncio
async def test_editar_avisa_SOLO_a_quien_se_anade(entorno):
    http, sesiones, _ = entorno
    publicacion = await _publicar(http, "Con el equipo", [BRUNO])

    await http.patch(
        f"{POSTS}/{publicacion['id']}",
        json={"mentioned_user_ids": [BRUNO, CARLA]},
    )
    # Bruno ya estaba: sigue con uno. Carla es nueva: recibe el suyo.
    assert len(await _avisos_de(sesiones, BRUNO)) == 1
    assert len(await _avisos_de(sesiones, CARLA)) == 1


@pytest.mark.asyncio
async def test_editar_puede_desetiquetar(entorno):
    """Una lista vacia quita a todo el mundo: hay que poder corregir un error."""
    http, sesiones, _ = entorno
    publicacion = await _publicar(http, "Con el equipo", [BRUNO])

    editada = await http.patch(
        f"{POSTS}/{publicacion['id']}", json={"mentioned_user_ids": []}
    )
    assert editada.status_code == 200
    assert await _mencionados(sesiones, publicacion["id"]) == set()
    # Quitar a alguien NO manda ningun aviso nuevo.
    assert len(await _avisos_de(sesiones, BRUNO)) == 1


@pytest.mark.asyncio
async def test_desetiquetar_y_volver_a_etiquetar_si_vuelve_a_avisar(entorno):
    """No es un aviso repetido: es una mencion nueva sobre la misma publicacion."""
    http, sesiones, _ = entorno
    publicacion = await _publicar(http, "Con el equipo", [BRUNO])
    await http.patch(f"{POSTS}/{publicacion['id']}", json={"mentioned_user_ids": []})
    await http.patch(
        f"{POSTS}/{publicacion['id']}", json={"mentioned_user_ids": [BRUNO]}
    )
    assert len(await _avisos_de(sesiones, BRUNO)) == 2


@pytest.mark.asyncio
async def test_editar_sin_mencionar_el_campo_deja_las_menciones(entorno):
    """Ausente = no se toca. Cambiar el texto no puede desetiquetar a nadie."""
    http, sesiones, _ = entorno
    publicacion = await _publicar(http, "Con el equipo", [BRUNO])

    await http.patch(f"{POSTS}/{publicacion['id']}", json={"body": "Otro texto"})
    assert await _mencionados(sesiones, publicacion["id"]) == {BRUNO}
    assert len(await _avisos_de(sesiones, BRUNO)) == 1


@pytest.mark.asyncio
async def test_nadie_edita_las_menciones_de_una_publicacion_ajena(entorno):
    http, sesiones, identidad = entorno
    publicacion = await _publicar(http, "Mia", [BRUNO])

    identidad["uid"] = CARLA
    respuesta = await http.patch(
        f"{POSTS}/{publicacion['id']}", json={"mentioned_user_ids": [CARLA]}
    )
    assert respuesta.status_code == 403
    assert await _mencionados(sesiones, publicacion["id"]) == {BRUNO}


# --------------------------------------------------------------------------- #
# Limites y entradas raras
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_pasarse_del_tope_se_rechaza(entorno):
    """AQUI SI SE RECHAZA, al contrario que con los hashtags.

    La lista la eligio la persona de un selector que ensena el limite, asi que
    pasarse solo puede venir de un cliente que lo ignoro. Con los hashtags la
    lista sale del propio texto y rechazar seria perder el texto entero.
    """
    http, _, _ = entorno
    demasiados = [str(__import__("uuid").uuid4()) for _ in range(11)]
    respuesta = await http.post(
        POSTS, json={"body": "Con todos", "mentioned_user_ids": demasiados}
    )
    assert respuesta.status_code in (400, 422)


@pytest.mark.asyncio
async def test_un_perfil_que_no_existe_se_descarta_sin_romper(entorno):
    """Una cuenta borrada entre elegirla y publicar no puede tirar la publicacion."""
    http, sesiones, _ = entorno
    fantasma = "aaaaaaaa-0000-0000-0000-0000000000ff"
    publicacion = await _publicar(http, "Con el equipo", [fantasma, BRUNO])
    assert await _mencionados(sesiones, publicacion["id"]) == {BRUNO}


@pytest.mark.asyncio
async def test_un_id_con_otro_formato_no_llega_a_la_consulta(entorno):
    """TRAMPA CONOCIDA: en PostgreSQL un id mal formado revienta la consulta.

    Se descarta antes de consultar, y publicar sigue funcionando: quien no tiene
    la culpa es quien esta publicando.
    """
    http, sesiones, _ = entorno
    publicacion = await _publicar(http, "Con el equipo", ["no-es-un-uuid", BRUNO])
    assert await _mencionados(sesiones, publicacion["id"]) == {BRUNO}


# --------------------------------------------------------------------------- #
# Buscar a quien etiquetar
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_los_candidatos_se_buscan_por_nombre(entorno):
    http, _, _ = entorno
    encontrados = (await http.get(f"{CANDIDATOS}?q=Bruno")).json()
    assert [p["id"] for p in encontrados] == [BRUNO]


@pytest.mark.asyncio
async def test_los_candidatos_se_buscan_tambien_por_usuario(entorno):
    """Carla se llama «Carla Soto» pero su usuario es «carlita»."""
    http, _, _ = entorno
    encontrados = (await http.get(f"{CANDIDATOS}?q=carlita")).json()
    assert [p["id"] for p in encontrados] == [CARLA]


@pytest.mark.asyncio
async def test_los_candidatos_traen_el_avatar(entorno):
    """Para no tener que elegir entre dos nombres parecidos a ciegas."""
    http, sesiones, _ = entorno
    async with sesiones() as db:
        perfil = await db.get(Profile, BRUNO)
        perfil.avatar_path = "bruno/avatar.jpg"
        await db.commit()

    encontrados = (await http.get(f"{CANDIDATOS}?q=bruno")).json()
    assert encontrados[0]["avatar_path"] == "bruno/avatar.jpg"


@pytest.mark.asyncio
async def test_con_una_sola_letra_no_se_busca(entorno):
    """El resultado seria «casi todo el mundo», que no ayuda a elegir."""
    http, _, _ = entorno
    assert (await http.get(f"{CANDIDATOS}?q=a")).json() == []


@pytest.mark.asyncio
async def test_los_candidatos_exigen_sesion(entorno):
    """El resultado DEPENDE de quien pregunta: excluye sus bloqueos.

    Sin identidad la respuesta no significaria nada, y ademas poder pedir «los
    candidatos de otra persona» diria a quien tiene bloqueado.
    """
    http, _, _ = entorno
    app.dependency_overrides.pop(get_current_user, None)
    respuesta = await http.get(f"{CANDIDATOS}?q=bruno")
    assert respuesta.status_code == 401
