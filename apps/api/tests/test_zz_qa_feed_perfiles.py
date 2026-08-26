"""QA funcional por HTTP: sesion, feed, etiquetas, perfiles, busqueda y orden.

Fichero de trabajo de una pasada de QA. Mismo patron que el resto de la suite
(SQLite en memoria + AsyncClient + ASGITransport), tres identidades y un
interruptor para cambiar de persona sin levantar otra base.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import Settings, get_settings
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.catalog.models import Course
from app.modules.content.models import Post
from app.modules.learning.models import CourseLesson, CourseModule
from app.modules.notifications.models import Notification
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.modules.social_graph.models import UserBlock
from app.shared.database import Base, get_db

POSTS = "/api/v1/posts"
PROFILES = "/api/v1/profiles"
HASHTAGS = "/api/v1/hashtags"
RECO = "/api/v1/recommendations"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"
CARLA = "aaaaaaaa-0000-0000-0000-000000000003"

SECRETO = "secreto-de-pruebas-solo-en-memoria"


async def _crear_tablas(engine) -> None:
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
        from app.modules.recommendations import models as _r  # noqa: F401
        from app.modules.reviews import models as _rv  # noqa: F401
        from app.modules.social_graph import models as _s  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)


@pytest_asyncio.fixture
async def entorno():
    """Tres personas, sesion sustituida por un interruptor de identidad."""
    cache.vaciar()
    esquema.olvidar()

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    await _crear_tablas(engine)

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
        return AuthUser(id=identidad["uid"], email="quien@ejemplo.com", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override
    # TAMBIEN el opcional: el feed, el detalle y el perfil ajeno lo usan, y sin
    # sustituirlo la sesion se pierde justo donde se comprueban los bloqueos y
    # el «ya le sigo». Una prueba que lo olvide mide a un anonimo creyendo que
    # mide a alguien con sesion.
    app.dependency_overrides[get_optional_user] = _usuario_override
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, identidad
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    await engine.dispose()


@pytest_asyncio.fixture
async def entorno_con_token():
    """Como el anterior, pero con la validacion de JWT DE VERDAD.

    Aqui NO se sustituye `get_current_user`: se firma un token HS256 con el
    mismo secreto que la configuracion, que es como llega el de Supabase.
    """
    cache.vaciar()
    esquema.olvidar()

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    await _crear_tablas(engine)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana Ruiz", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno Diaz", username="bruno"))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    def _ajustes_override() -> Settings:
        # Todo explicito: `apps/api/.env` existe en la maquina de desarrollo y
        # trae el emisor real del proyecto. Heredarlo haria que un token de
        # prueba sin `iss` se rechazara y la prueba mediria el fichero .env.
        return Settings(
            supabase_jwt_secret=SECRETO,
            supabase_url="",
            supabase_jwt_issuer="",
            supabase_jwt_audience="authenticated",
        )

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_settings] = _ajustes_override
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_settings, None)
    await engine.dispose()


def _token(sub: str, *, expira_en: int = 3600) -> str:
    ahora = datetime.now(timezone.utc)
    return jwt.encode(
        {
            "sub": sub,
            "aud": "authenticated",
            "role": "authenticated",
            "email": "quien@ejemplo.com",
            "iat": ahora,
            "exp": ahora + timedelta(seconds=expira_en),
        },
        SECRETO,
        algorithm="HS256",
    )


def _cabecera(sub: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_token(sub)}"}


async def _publicar(http: AsyncClient, texto: str, **extra) -> dict:
    respuesta = await http.post(POSTS, json={"body": texto, **extra})
    assert respuesta.status_code == 201, respuesta.text
    return respuesta.json()


async def _fechar(sesiones, post_id: str, cuando: datetime) -> None:
    """Fecha a mano: contra SQLite dos publicaciones de la misma prueba
    comparten `created_at` al milisegundo y el orden lo decidiria el UUID."""
    async with sesiones() as db:
        await db.execute(
            update(Post).where(Post.id == post_id).values(created_at=cuando)
        )
        await db.commit()


# =========================================================================== #
# 1. AUTENTICACION
# =========================================================================== #
@pytest.mark.asyncio
async def test_sin_token_un_endpoint_protegido_responde_401(entorno_con_token):
    http, _ = entorno_con_token
    respuesta = await http.get(f"{PROFILES}/me")
    assert respuesta.status_code == 401
    assert respuesta.json()["error"]["code"] == "unauthorized"


@pytest.mark.asyncio
async def test_publicar_sin_token_no_se_deja(entorno_con_token):
    http, sesiones = entorno_con_token
    respuesta = await http.post(POSTS, json={"body": "Hola"})
    assert respuesta.status_code == 401
    async with sesiones() as db:
        assert (await db.scalars(select(Post.id))).all() == []


@pytest.mark.asyncio
async def test_un_token_con_basura_responde_401_y_no_500(entorno_con_token):
    http, _ = entorno_con_token
    respuesta = await http.get(
        f"{PROFILES}/me", headers={"Authorization": "Bearer no-es-un-token"}
    )
    assert respuesta.status_code == 401
    assert respuesta.json()["error"]["code"] == "invalid_token"


@pytest.mark.asyncio
async def test_un_token_firmado_con_otro_secreto_no_vale(entorno_con_token):
    """Es el caso importante: la FORMA es correcta, la FIRMA no."""
    http, _ = entorno_con_token
    falso = jwt.encode(
        {"sub": ANA, "aud": "authenticated"}, "otro-secreto", algorithm="HS256"
    )
    respuesta = await http.get(
        f"{PROFILES}/me", headers={"Authorization": f"Bearer {falso}"}
    )
    assert respuesta.status_code == 401


@pytest.mark.asyncio
async def test_un_token_caducado_lo_dice(entorno_con_token):
    http, _ = entorno_con_token
    caducado = _token(ANA, expira_en=-7200)
    respuesta = await http.get(
        f"{PROFILES}/me", headers={"Authorization": f"Bearer {caducado}"}
    )
    assert respuesta.status_code == 401
    assert respuesta.json()["error"]["code"] == "token_expired"


@pytest.mark.asyncio
async def test_el_token_de_otra_persona_devuelve_el_perfil_de_esa_persona(
    entorno_con_token,
):
    """La identidad sale del JWT: con el token de Bruno se es Bruno."""
    http, _ = entorno_con_token
    mio = (await http.get(f"{PROFILES}/me", headers=_cabecera(ANA))).json()
    ajeno = (await http.get(f"{PROFILES}/me", headers=_cabecera(BRUNO))).json()
    assert mio["id"] == ANA
    assert ajeno["id"] == BRUNO


@pytest.mark.asyncio
async def test_el_autor_sale_del_token_y_no_del_cuerpo(entorno_con_token):
    """Mandar `author_id` no cambia de quien es la publicacion."""
    http, _ = entorno_con_token
    creada = await http.post(
        POSTS,
        json={"body": "Firmada por quien la manda", "author_id": BRUNO},
        headers=_cabecera(ANA),
    )
    assert creada.status_code == 201
    assert creada.json()["author"]["id"] == ANA


@pytest.mark.asyncio
async def test_el_feed_se_lee_sin_sesion_y_con_un_token_invalido(entorno_con_token):
    """El muro es publico (0018): un token roto no puede tumbarlo."""
    http, _ = entorno_con_token
    await http.post(POSTS, json={"body": "Publica"}, headers=_cabecera(ANA))

    anonimo = await http.get(POSTS)
    con_basura = await http.get(POSTS, headers={"Authorization": "Bearer roto"})
    assert anonimo.status_code == 200 and len(anonimo.json()) == 1
    assert con_basura.status_code == 200 and len(con_basura.json()) == 1
    assert anonimo.json()[0]["liked_by_me"] is False


# =========================================================================== #
# 2. FEED Y PUBLICACIONES
# =========================================================================== #
@pytest.mark.asyncio
async def test_el_feed_vacio_es_una_lista_vacia_y_no_un_error(entorno):
    http, _, _ = entorno
    respuesta = await http.get(POSTS)
    assert respuesta.status_code == 200
    assert respuesta.json() == []


@pytest.mark.asyncio
async def test_publicar_solo_texto(entorno):
    http, _, _ = entorno
    publicacion = await _publicar(http, "Solo texto, sin adjunto")
    assert publicacion["body"] == "Solo texto, sin adjunto"
    assert publicacion["media"] == []
    assert publicacion["author"]["full_name"] == "Ana Ruiz"


@pytest.mark.asyncio
async def test_publicar_texto_mas_imagen(entorno):
    http, _, _ = entorno
    publicacion = await _publicar(
        http,
        "Con foto",
        media=[{"storage_path": f"{ANA}/foto.jpg", "media_type": "image"}],
    )
    assert [m["media_type"] for m in publicacion["media"]] == ["image"]
    # Y sigue estando al releerla: el adjunto se guardo, no se pinto de paso.
    detalle = (await http.get(f"{POSTS}/{publicacion['id']}")).json()
    assert detalle["media"][0]["storage_path"] == f"{ANA}/foto.jpg"


@pytest.mark.asyncio
async def test_publicar_texto_mas_video_conserva_su_metadata(entorno):
    http, _, _ = entorno
    publicacion = await _publicar(
        http,
        "Con video",
        media=[
            {
                "storage_path": f"{ANA}/clip.mp4",
                "media_type": "video",
                "width": 1080,
                "height": 1920,
                "duration_s": 12.5,
                "poster_path": f"{ANA}/clip.jpg",
            }
        ],
    )
    medio = publicacion["media"][0]
    assert medio["media_type"] == "video"
    assert (medio["width"], medio["height"]) == (1080, 1920)
    assert medio["poster_path"] == f"{ANA}/clip.jpg"


@pytest.mark.asyncio
async def test_una_publicacion_vacia_del_todo_se_rechaza(entorno):
    http, _, _ = entorno
    respuesta = await http.post(POSTS, json={"body": "   "})
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_solo_una_foto_sin_texto_si_se_publica(entorno):
    """Un reel se explica solo: exigir descripcion era un requisito nuestro."""
    http, _, _ = entorno
    publicacion = await _publicar(
        http, "", media=[{"storage_path": f"{ANA}/reel.mp4", "media_type": "video"}]
    )
    assert publicacion["body"] == ""


@pytest.mark.asyncio
async def test_abrir_una_publicacion_por_su_id(entorno):
    http, _, _ = entorno
    publicacion = await _publicar(http, "Para abrirla")
    detalle = await http.get(f"{POSTS}/{publicacion['id']}")
    assert detalle.status_code == 200
    assert detalle.json()["id"] == publicacion["id"]


@pytest.mark.asyncio
async def test_abrir_una_publicacion_que_no_existe_es_404(entorno):
    http, _, _ = entorno
    respuesta = await http.get(f"{POSTS}/aaaaaaaa-0000-0000-0000-00000000dead")
    assert respuesta.status_code == 404


@pytest.mark.asyncio
async def test_un_id_que_no_es_uuid_da_404_y_no_500(entorno):
    """La trampa del repo: sin `ensure_uuid` esto llegaria al driver."""
    http, _, _ = entorno
    respuesta = await http.get(f"{POSTS}/pantalla-antigua")
    assert respuesta.status_code == 404


@pytest.mark.asyncio
async def test_el_feed_llega_de_la_mas_nueva_a_la_mas_vieja(entorno):
    http, sesiones, _ = entorno
    vieja = await _publicar(http, "La vieja")
    nueva = await _publicar(http, "La nueva")
    await _fechar(sesiones, vieja["id"], datetime(2026, 1, 1, tzinfo=timezone.utc))
    await _fechar(sesiones, nueva["id"], datetime(2026, 6, 1, tzinfo=timezone.utc))

    ids = [p["id"] for p in (await http.get(POSTS)).json()]
    assert ids == [nueva["id"], vieja["id"]]


@pytest.mark.asyncio
async def test_la_paginacion_por_offset_no_repite(entorno):
    http, sesiones, _ = entorno
    for i in range(5):
        creada = await _publicar(http, f"Numero {i}")
        await _fechar(
            sesiones, creada["id"], datetime(2026, 1, i + 1, tzinfo=timezone.utc)
        )

    primera = (await http.get(f"{POSTS}?limit=2&offset=0")).json()
    segunda = (await http.get(f"{POSTS}?limit=2&offset=2")).json()
    assert len(primera) == 2 and len(segunda) == 2
    assert not {p["id"] for p in primera} & {p["id"] for p in segunda}


@pytest.mark.asyncio
async def test_la_paginacion_por_cursor_continua_donde_quedo(entorno):
    http, sesiones, _ = entorno
    creadas = []
    for i in range(4):
        creada = await _publicar(http, f"Numero {i}")
        await _fechar(
            sesiones, creada["id"], datetime(2026, 1, i + 1, tzinfo=timezone.utc)
        )
        creadas.append(creada["id"])

    primera = (await http.get(f"{POSTS}?limit=2")).json()
    ultima = primera[-1]
    segunda = (
        await http.get(
            f"{POSTS}?limit=2&before_created_at={ultima['created_at']}"
            f"&before_id={ultima['id']}"
        )
    ).json()
    assert [p["id"] for p in primera] == [creadas[3], creadas[2]]
    assert [p["id"] for p in segunda] == [creadas[1], creadas[0]]


@pytest.mark.asyncio
async def test_un_cursor_con_basura_es_422_y_no_500(entorno):
    http, _, _ = entorno
    respuesta = await http.get(f"{POSTS}?before_created_at=ayer")
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_editar_lo_propio_cambia_el_texto(entorno):
    http, _, _ = entorno
    publicacion = await _publicar(http, "Antes")
    editada = await http.patch(f"{POSTS}/{publicacion['id']}", json={"body": "Despues"})
    assert editada.status_code == 200
    assert editada.json()["body"] == "Despues"
    assert (await http.get(f"{POSTS}/{publicacion['id']}")).json()["body"] == "Despues"


@pytest.mark.asyncio
async def test_nadie_edita_la_publicacion_de_otra_persona(entorno):
    http, _, identidad = entorno
    publicacion = await _publicar(http, "De Ana")
    identidad["uid"] = BRUNO
    respuesta = await http.patch(f"{POSTS}/{publicacion['id']}", json={"body": "Mia"})
    assert respuesta.status_code == 403


@pytest.mark.asyncio
async def test_borrar_lo_propio_lo_saca_del_feed_y_del_detalle(entorno):
    http, _, _ = entorno
    publicacion = await _publicar(http, "Condenada")
    assert (await http.delete(f"{POSTS}/{publicacion['id']}")).status_code == 204
    assert (await http.get(POSTS)).json() == []
    assert (await http.get(f"{POSTS}/{publicacion['id']}")).status_code == 404


@pytest.mark.asyncio
async def test_nadie_borra_la_publicacion_de_otra_persona(entorno):
    http, _, identidad = entorno
    publicacion = await _publicar(http, "De Ana")
    identidad["uid"] = BRUNO
    assert (await http.delete(f"{POSTS}/{publicacion['id']}")).status_code == 403


@pytest.mark.asyncio
async def test_borrar_con_un_id_que_no_es_uuid_da_404_y_no_500(entorno):
    http, _, _ = entorno
    respuesta = await http.delete(f"{POSTS}/pantalla-antigua")
    assert respuesta.status_code == 404


@pytest.mark.asyncio
async def test_dar_me_gusta_con_un_id_que_no_es_uuid_da_404_y_no_500(entorno):
    http, _, _ = entorno
    assert (await http.post(f"{POSTS}/no-uuid/like")).status_code == 404
    assert (await http.post(f"{POSTS}/no-uuid/save")).status_code == 404


@pytest.mark.asyncio
async def test_una_publicacion_antigua_sin_temas_ni_etiquetas_se_lee_igual(entorno):
    """Lo anterior a la 0027/0031/0032: listas vacias, no huecos ni errores."""
    http, sesiones, _ = entorno
    async with sesiones() as db:
        antigua = Post(author_id=BRUNO, body="Publicada hace anos", status="published")
        db.add(antigua)
        await db.commit()
        post_id = antigua.id

    detalle = (await http.get(f"{POSTS}/{post_id}")).json()
    assert detalle["topic_ids"] == []
    assert detalle["hashtags"] == []
    assert detalle["mentions"] == []
    assert detalle["author"]["id"] == BRUNO
    assert any(p["id"] == post_id for p in (await http.get(POSTS)).json())


@pytest.mark.asyncio
async def test_dar_me_gusta_y_comentar_avisan_con_el_nombre_del_PERFIL(entorno):
    """La trampa numero 3 del proyecto, vigilada donde ocurrio.

    Leer `current_user.full_name` lanzaba AttributeError DESPUES del commit —un
    500 que el navegador reporta como error de CORS— porque `AuthUser` no tiene
    ese campo. El nombre sale de `profiles`, y el aviso tiene que apuntar a la
    publicacion, no al perfil de quien reacciono.
    """
    http, sesiones, identidad = entorno
    identidad["uid"] = BRUNO
    publicacion = await _publicar(http, "De Bruno")
    identidad["uid"] = ANA

    assert (await http.post(f"{POSTS}/{publicacion['id']}/like")).status_code == 200
    comentario = await http.post(
        f"{POSTS}/{publicacion['id']}/comments", json={"body": "Que bueno"}
    )
    assert comentario.status_code == 201
    assert comentario.json()["author"]["full_name"] == "Ana Ruiz"

    async with sesiones() as db:
        avisos = (
            await db.scalars(select(Notification).where(Notification.user_id == BRUNO))
        ).all()
    assert {a.type for a in avisos} == {"like", "comment"}
    assert {a.entity_id for a in avisos} == {publicacion["id"]}

    identidad["uid"] = BRUNO
    listado = (await http.get("/api/v1/notifications")).json()
    assert {n["actor"]["full_name"] for n in listado} == {"Ana Ruiz"}


@pytest.mark.asyncio
async def test_el_feed_de_siguiendo_solo_trae_a_quien_se_sigue(entorno):
    http, _, identidad = entorno
    identidad["uid"] = BRUNO
    de_bruno = await _publicar(http, "De Bruno")
    identidad["uid"] = CARLA
    await _publicar(http, "De Carla")
    identidad["uid"] = ANA

    assert (await http.get(f"{POSTS}?feed=following")).json() == []
    await http.post(f"/api/v1/profiles/{BRUNO}/follow")
    siguiendo = (await http.get(f"{POSTS}?feed=following")).json()
    assert [p["id"] for p in siguiendo] == [de_bruno["id"]]


@pytest.mark.asyncio
async def test_el_feed_de_un_perfil_solo_trae_lo_suyo(entorno):
    http, _, identidad = entorno
    de_ana = await _publicar(http, "De Ana")
    identidad["uid"] = BRUNO
    await _publicar(http, "De Bruno")

    galeria = (await http.get(f"{POSTS}?author_id={ANA}")).json()
    assert [p["id"] for p in galeria] == [de_ana["id"]]


@pytest.mark.asyncio
async def test_un_autor_con_id_invalido_da_404_y_no_500(entorno):
    http, _, _ = entorno
    assert (await http.get(f"{POSTS}?author_id=no-uuid")).status_code == 404


@pytest.mark.asyncio
async def test_un_bloqueo_corta_el_feed_en_los_dos_sentidos(entorno):
    http, sesiones, identidad = entorno
    identidad["uid"] = BRUNO
    await _publicar(http, "De Bruno")
    identidad["uid"] = ANA
    mia = await _publicar(http, "De Ana")

    async with sesiones() as db:
        db.add(UserBlock(blocker_id=BRUNO, blocked_id=ANA))
        await db.commit()

    # Ana no ve a quien la bloqueo...
    assert [p["id"] for p in (await http.get(POSTS)).json()] == [mia["id"]]
    # ...y Bruno tampoco ve a quien bloqueo.
    identidad["uid"] = BRUNO
    assert mia["id"] not in {p["id"] for p in (await http.get(POSTS)).json()}


# =========================================================================== #
# 3. HASHTAGS
# =========================================================================== #
@pytest.mark.asyncio
async def test_la_etiqueta_sale_del_texto_y_no_del_json(entorno):
    http, _, _ = entorno
    publicacion = await _publicar(http, "Nada de eso", hashtags=["python"])
    assert publicacion["hashtags"] == []
    assert (await http.get(f"{HASHTAGS}/python")).json()["posts_count"] == 0


@pytest.mark.asyncio
async def test_mayusculas_y_minusculas_son_la_misma_etiqueta(entorno):
    http, _, identidad = entorno
    await _publicar(http, "Sobre #IA")
    identidad["uid"] = BRUNO
    await _publicar(http, "Tambien sobre #ia")

    detalle = (await http.get(f"{HASHTAGS}/Ia")).json()
    assert detalle["tag"] == "ia"
    assert detalle["posts_count"] == 2
    assert len((await http.get(f"{HASHTAGS}/ia/posts")).json()) == 2


@pytest.mark.asyncio
async def test_el_tope_de_diez_etiquetas_no_impide_publicar(entorno):
    http, _, _ = entorno
    texto = " ".join(f"#tema{i}" for i in range(14))
    publicacion = await _publicar(http, texto)
    assert len(publicacion["hashtags"]) == 10
    assert publicacion["body"] == texto


@pytest.mark.asyncio
async def test_buscar_etiquetas_sin_resultados_devuelve_lista_vacia(entorno):
    http, _, _ = entorno
    await _publicar(http, "De #cocina")
    respuesta = await http.get(f"{HASHTAGS}/search?q=zzzz")
    assert respuesta.status_code == 200
    assert respuesta.json() == []


@pytest.mark.asyncio
async def test_buscar_con_un_termino_que_no_es_etiqueta_no_revienta(entorno):
    http, _, _ = entorno
    respuesta = await http.get(f"{HASHTAGS}/search?q=%23%23%23")
    assert respuesta.status_code == 200
    assert respuesta.json() == []


@pytest.mark.asyncio
async def test_una_etiqueta_sin_publicaciones_responde_cero_y_lista_vacia(entorno):
    http, _, _ = entorno
    detalle = await http.get(f"{HASHTAGS}/nadielausa")
    listado = await http.get(f"{HASHTAGS}/nadielausa/posts")
    assert detalle.status_code == 200 and detalle.json()["posts_count"] == 0
    assert listado.status_code == 200 and listado.json() == []


@pytest.mark.asyncio
async def test_las_publicaciones_de_una_etiqueta_llegan_como_las_del_feed(entorno):
    http, _, _ = entorno
    publicacion = await _publicar(
        http,
        "Con foto de #cocina",
        media=[{"storage_path": f"{ANA}/plato.jpg", "media_type": "image"}],
    )
    listado = (await http.get(f"{HASHTAGS}/cocina/posts")).json()
    assert listado[0]["id"] == publicacion["id"]
    assert listado[0]["author"]["username"] == "ana"
    assert listado[0]["media"][0]["media_type"] == "image"


# =========================================================================== #
# 4. MENCIONES (lo que no cubre ya test_menciones_api.py)
# =========================================================================== #
@pytest.mark.asyncio
async def test_uno_mismo_puede_salir_en_sus_propios_candidatos(entorno):
    """Etiquetarse en la foto de grupo es legitimo; el aviso es lo que no."""
    http, _, _ = entorno
    encontrados = (await http.get("/api/v1/mentions/candidates?q=Ana")).json()
    assert ANA in {c["id"] for c in encontrados}


@pytest.mark.asyncio
async def test_el_aviso_de_mencion_apunta_a_la_publicacion(entorno):
    http, sesiones, _ = entorno
    publicacion = await _publicar(http, "Mira esto", mentioned_user_ids=[BRUNO])
    async with sesiones() as db:
        aviso = (
            await db.scalars(
                select(Notification).where(Notification.user_id == BRUNO)
            )
        ).one()
    assert (aviso.type, aviso.entity_type, aviso.entity_id) == (
        "post_mention",
        "post",
        publicacion["id"],
    )


@pytest.mark.asyncio
async def test_editar_avisa_solo_a_quien_se_anade(entorno):
    http, sesiones, _ = entorno
    publicacion = await _publicar(http, "Version 1", mentioned_user_ids=[BRUNO])
    editada = await http.patch(
        f"{POSTS}/{publicacion['id']}",
        json={"body": "Version 2", "mentioned_user_ids": [BRUNO, CARLA]},
    )
    assert editada.status_code == 200

    async with sesiones() as db:
        de_bruno = (
            await db.scalars(select(Notification).where(Notification.user_id == BRUNO))
        ).all()
        de_carla = (
            await db.scalars(select(Notification).where(Notification.user_id == CARLA))
        ).all()
    assert len(de_bruno) == 1  # No se le vuelve a avisar por una edicion.
    assert len(de_carla) == 1


@pytest.mark.asyncio
async def test_etiquetarse_a_uno_mismo_no_manda_aviso(entorno):
    http, sesiones, _ = entorno
    await _publicar(http, "Aqui salgo yo", mentioned_user_ids=[ANA])
    async with sesiones() as db:
        avisos = (
            await db.scalars(select(Notification).where(Notification.user_id == ANA))
        ).all()
    assert avisos == []


@pytest.mark.asyncio
async def test_los_candidatos_a_mencion_exigen_sesion(entorno_con_token):
    http, _ = entorno_con_token
    assert (await http.get("/api/v1/mentions/candidates?q=an")).status_code == 401


# =========================================================================== #
# 5. PERFILES Y RESENAS
# =========================================================================== #
@pytest.mark.asyncio
async def test_el_perfil_propio_trae_sus_contadores(entorno):
    http, _, _ = entorno
    await _publicar(http, "Una")
    await _publicar(http, "Otra")
    mio = (await http.get(f"{PROFILES}/me")).json()
    assert mio["id"] == ANA
    assert mio["posts_count"] == 2
    assert mio["is_following"] is False


@pytest.mark.asyncio
async def test_un_perfil_ajeno_dice_si_lo_sigo(entorno):
    http, _, _ = entorno
    ajeno = (await http.get(f"{PROFILES}/{BRUNO}")).json()
    assert ajeno["id"] == BRUNO and ajeno["is_following"] is False
    assert (await http.post(f"/api/v1/profiles/{BRUNO}/follow")).status_code in (
        200,
        201,
        204,
    )
    assert (await http.get(f"{PROFILES}/{BRUNO}")).json()["is_following"] is True


@pytest.mark.asyncio
async def test_un_perfil_que_no_existe_es_404_y_uno_con_basura_tambien(entorno):
    http, _, _ = entorno
    assert (
        await http.get(f"{PROFILES}/aaaaaaaa-0000-0000-0000-00000000dead")
    ).status_code == 404
    assert (await http.get(f"{PROFILES}/no-uuid")).status_code == 404


@pytest.mark.asyncio
async def test_editar_el_perfil_propio_y_su_avatar(entorno):
    http, _, _ = entorno
    editado = await http.patch(
        f"{PROFILES}/me",
        json={"full_name": "Ana R.", "bio": "Carpinteria", "avatar_path": f"{ANA}/yo.jpg"},
    )
    assert editado.status_code == 200
    assert editado.json()["full_name"] == "Ana R."
    assert editado.json()["avatar_path"] == f"{ANA}/yo.jpg"

    # Cadena vacia = quitar la imagen y volver a la de por defecto.
    quitado = await http.patch(f"{PROFILES}/me", json={"avatar_path": ""})
    assert quitado.json()["avatar_path"] is None


@pytest.mark.asyncio
async def test_el_avatar_editado_se_ve_en_las_publicaciones(entorno):
    http, _, _ = entorno
    await http.patch(f"{PROFILES}/me", json={"avatar_path": f"{ANA}/yo.jpg"})
    publicacion = await _publicar(http, "Con avatar nuevo")
    assert publicacion["author"]["avatar_path"] == f"{ANA}/yo.jpg"


@pytest.mark.asyncio
async def test_quien_no_tiene_nombre_de_usuario_puede_guardar_su_perfil(entorno):
    """REGRESION. El registro NO pide nombre de usuario, asi que en la base
    queda NULL y la pantalla de editar perfil lo manda vacio. Con `min_length=3`
    la peticion ENTERA se rechazaba con un 422 y esa persona no podia guardar
    tampoco su nombre ni su biografia."""
    http, sesiones, identidad = entorno
    async with sesiones() as db:
        await db.execute(update(Profile).where(Profile.id == ANA).values(username=None))
        await db.commit()

    guardado = await http.patch(
        f"{PROFILES}/me",
        json={"full_name": "Ana Ruiz", "username": "", "bio": "Hola"},
    )
    assert guardado.status_code == 200, guardado.text
    assert guardado.json()["full_name"] == "Ana Ruiz"
    assert guardado.json()["bio"] == "Hola"
    assert guardado.json()["username"] is None


@pytest.mark.asyncio
async def test_un_nombre_de_usuario_ya_cogido_es_409_y_no_un_500(entorno):
    """REGRESION. Chocaba contra el indice unico DESPUES del commit: un
    IntegrityError sin capturar, o sea un 500 que en el navegador se disfraza de
    fallo de red. La pantalla ya sabe pintar el 409 en el propio campo."""
    http, _, _ = entorno
    respuesta = await http.patch(f"{PROFILES}/me", json={"username": "bruno"})
    assert respuesta.status_code == 409
    assert respuesta.json()["error"]["code"] == "username_taken"
    # Y no se quedo escrito nada a medias.
    assert (await http.get(f"{PROFILES}/me")).json()["username"] == "ana"


@pytest.mark.asyncio
async def test_quedarse_con_el_nombre_de_usuario_propio_no_es_un_choque(entorno):
    http, _, _ = entorno
    respuesta = await http.patch(
        f"{PROFILES}/me", json={"username": "ana", "bio": "Otra bio"}
    )
    assert respuesta.status_code == 200
    assert respuesta.json()["username"] == "ana"


@pytest.mark.asyncio
async def test_un_nombre_de_usuario_demasiado_corto_o_raro_se_sigue_rechazando(entorno):
    http, _, _ = entorno
    assert (await http.patch(f"{PROFILES}/me", json={"username": "ab"})).status_code == 422
    assert (
        await http.patch(f"{PROFILES}/me", json={"username": "con espacio"})
    ).status_code == 422


@pytest.mark.asyncio
async def test_nadie_se_asciende_a_si_mismo_editando_su_perfil(entorno):
    """El rol y lo destacado no son campos del perfil editable."""
    http, _, _ = entorno
    editado = await http.patch(
        f"{PROFILES}/me", json={"role": "admin", "is_featured": True}
    )
    assert editado.status_code == 200
    assert editado.json()["role"] == "user"
    assert editado.json()["is_featured"] is False


@pytest.mark.asyncio
async def test_editar_el_perfil_no_toca_el_de_nadie_mas(entorno):
    http, _, _ = entorno
    await http.patch(f"{PROFILES}/me", json={"full_name": "Ana R."})
    assert (await http.get(f"{PROFILES}/{BRUNO}")).json()["full_name"] == "Bruno Diaz"


@pytest.mark.asyncio
async def test_ana_resena_a_bruno_y_solo_ana_puede_borrarla(entorno):
    http, _, identidad = entorno
    creada = await http.post(
        "/api/v1/reviews", json={"reviewed_user_id": BRUNO, "body": "Gran trabajo"}
    )
    assert creada.status_code == 201, creada.text
    review_id = creada.json()["id"]

    recibidas = (await http.get(f"/api/v1/reviews/received/{BRUNO}")).json()
    assert [r["id"] for r in recibidas] == [review_id]

    # Bruno la ve, pero no puede tocarla.
    identidad["uid"] = BRUNO
    suyas = (await http.get(f"/api/v1/reviews/received/{BRUNO}")).json()
    assert suyas[0]["can_manage"] is False
    assert (await http.delete(f"/api/v1/reviews/{review_id}")).status_code == 403
    assert (
        await http.patch(f"/api/v1/reviews/{review_id}", json={"body": "Regular"})
    ).status_code == 403

    # Carla tampoco.
    identidad["uid"] = CARLA
    assert (await http.delete(f"/api/v1/reviews/{review_id}")).status_code == 403

    # Ana si.
    identidad["uid"] = ANA
    assert (await http.delete(f"/api/v1/reviews/{review_id}")).status_code == 204
    assert (await http.get(f"/api/v1/reviews/received/{BRUNO}")).json() == []


@pytest.mark.asyncio
async def test_nadie_se_resena_a_si_mismo(entorno):
    http, _, _ = entorno
    respuesta = await http.post(
        "/api/v1/reviews", json={"reviewed_user_id": ANA, "body": "Soy genial"}
    )
    assert respuesta.status_code == 422
    assert respuesta.json()["error"]["code"] == "review_self_not_allowed"


@pytest.mark.asyncio
async def test_un_perfil_sin_resenas_devuelve_lista_vacia(entorno):
    http, _, _ = entorno
    respuesta = await http.get(f"/api/v1/reviews/received/{CARLA}")
    assert respuesta.status_code == 200 and respuesta.json() == []


# =========================================================================== #
# 6. BUSCAR / EXPLORAR
# =========================================================================== #
@pytest.mark.asyncio
async def test_buscar_personas_por_nombre_y_por_usuario(entorno):
    http, _, _ = entorno
    por_nombre = (await http.get(f"{PROFILES}/search?q=Bruno")).json()
    por_usuario = (await http.get(f"{PROFILES}/search?q=carlita")).json()
    assert [p["id"] for p in por_nombre] == [BRUNO]
    assert [p["id"] for p in por_usuario] == [CARLA]


@pytest.mark.asyncio
async def test_buscar_personas_sin_coincidencias_es_una_lista_vacia(entorno):
    http, _, _ = entorno
    respuesta = await http.get(f"{PROFILES}/search?q=zzzzzz")
    assert respuesta.status_code == 200 and respuesta.json() == []


@pytest.mark.asyncio
async def test_buscar_con_una_sola_letra_no_devuelve_medio_directorio(entorno):
    http, _, _ = entorno
    respuesta = await http.get(f"{PROFILES}/search?q=a")
    assert respuesta.status_code == 200 and respuesta.json() == []


@pytest.mark.asyncio
async def test_buscar_una_cadena_vacia_no_revienta(entorno):
    http, _, _ = entorno
    assert (await http.get(f"{PROFILES}/search?q=")).status_code == 422
    assert (await http.get(f"{HASHTAGS}/search?q=")).status_code == 422


@pytest.mark.asyncio
async def test_explorar_devuelve_las_tres_pestanas_aunque_esten_vacias(entorno):
    """Personas, contenido y etiquetas: ninguna puede dejar la pantalla en blanco."""
    http, _, _ = entorno
    personas = await http.get(f"{PROFILES}/search?q=zzz")
    contenido = await http.get(f"{POSTS}?limit=10")
    etiquetas = await http.get(f"{HASHTAGS}/search?q=zzz")
    assert [personas.status_code, contenido.status_code, etiquetas.status_code] == [
        200,
        200,
        200,
    ]
    assert personas.json() == [] and contenido.json() == [] and etiquetas.json() == []


# =========================================================================== #
# 7. RECOMENDACIONES: uno mismo nunca se recomienda
# =========================================================================== #
@pytest.mark.asyncio
async def test_nadie_se_recomienda_a_si_mismo_como_persona(entorno):
    http, _, _ = entorno
    items = (await http.get(f"{RECO}/people?limit=20")).json()["items"]
    assert ANA not in {p["id"] for p in items}


@pytest.mark.asyncio
async def test_uno_mismo_tampoco_sale_entre_los_perfiles_destacados(entorno):
    """La otra lista de «personas sugeridas», la del registro."""
    http, sesiones, _ = entorno
    async with sesiones() as db:
        await db.execute(update(Profile).values(is_featured=True))
        await db.commit()

    destacados = (await http.get(f"{PROFILES}/featured")).json()
    ids = {p["id"] for p in destacados}
    assert BRUNO in ids and CARLA in ids
    assert ANA not in ids


@pytest.mark.asyncio
async def test_el_contenido_propio_no_se_recomienda_a_su_autor(entorno):
    """«Para ti» es descubrimiento: lo que uno acaba de publicar ya lo conoce."""
    http, _, identidad = entorno
    mia = await _publicar(http, "La escribi yo")
    identidad["uid"] = BRUNO
    de_bruno = await _publicar(http, "La escribio Bruno")
    identidad["uid"] = ANA

    items = (await http.get(f"{RECO}/content?limit=20")).json()["items"]
    ids = {p["id"] for p in items}
    assert de_bruno["id"] in ids
    assert mia["id"] not in ids


@pytest.mark.asyncio
async def test_el_contenido_de_un_bloqueado_no_se_recomienda(entorno):
    http, sesiones, identidad = entorno
    identidad["uid"] = BRUNO
    de_bruno = await _publicar(http, "De Bruno")
    identidad["uid"] = CARLA
    de_carla = await _publicar(http, "De Carla")
    identidad["uid"] = ANA

    async with sesiones() as db:
        db.add(UserBlock(blocker_id=ANA, blocked_id=BRUNO))
        await db.commit()

    ids = {
        p["id"] for p in (await http.get(f"{RECO}/content?limit=20")).json()["items"]
    }
    assert de_carla["id"] in ids
    assert de_bruno["id"] not in ids


@pytest.mark.asyncio
async def test_lo_descartado_no_vuelve_a_recomendarse(entorno):
    http, _, identidad = entorno
    identidad["uid"] = BRUNO
    rechazada = await _publicar(http, "No me interesa")
    otra = await _publicar(http, "Esta si")
    identidad["uid"] = ANA

    aceptado = await http.post(
        f"{RECO}/events",
        json={
            "events": [
                {
                    "event_type": "not_interested",
                    "entity_type": "post",
                    "entity_id": rechazada["id"],
                }
            ]
        },
    )
    assert aceptado.status_code == 200

    ids = {
        p["id"] for p in (await http.get(f"{RECO}/content?limit=20")).json()["items"]
    }
    assert otra["id"] in ids
    assert rechazada["id"] not in ids


@pytest.mark.asyncio
async def test_los_cursos_propios_no_se_recomiendan(entorno):
    """La tercera superficie: tampoco los cursos de uno mismo."""
    http, sesiones, _ = entorno
    async with sesiones() as db:
        for course_id, autor in (
            ("cccccccc-0000-0000-0000-000000000001", ANA),
            ("cccccccc-0000-0000-0000-000000000002", BRUNO),
        ):
            db.add(
                Course(
                    id=course_id,
                    author_id=autor,
                    title=f"Curso de {autor[-1]}",
                    description="Una descripcion larga de verdad.",
                    price_minor=0,
                    currency="PEN",
                    status="published",
                )
            )
            await db.flush()
            modulo = CourseModule(course_id=course_id, title="Modulo", sort_order=0)
            db.add(modulo)
            await db.flush()
            db.add(
                CourseLesson(
                    module_id=modulo.id,
                    title="Leccion",
                    duration_seconds=600,
                    sort_order=0,
                )
            )
        await db.commit()

    items = (await http.get(f"{RECO}/courses?limit=10")).json()["items"]
    autores = {c["author_id"] for c in items}
    assert BRUNO in autores
    assert ANA not in autores


@pytest.mark.asyncio
async def test_un_curso_de_alguien_bloqueado_no_se_recomienda(entorno):
    http, sesiones, _ = entorno
    async with sesiones() as db:
        course_id = "cccccccc-0000-0000-0000-000000000003"
        db.add(
            Course(
                id=course_id,
                author_id=BRUNO,
                title="Curso de Bruno",
                description="Una descripcion larga de verdad.",
                price_minor=0,
                currency="PEN",
                status="published",
            )
        )
        await db.flush()
        modulo = CourseModule(course_id=course_id, title="Modulo", sort_order=0)
        db.add(modulo)
        await db.flush()
        db.add(
            CourseLesson(
                module_id=modulo.id, title="Leccion", duration_seconds=600, sort_order=0
            )
        )
        db.add(UserBlock(blocker_id=ANA, blocked_id=BRUNO))
        await db.commit()

    items = (await http.get(f"{RECO}/courses?limit=10")).json()["items"]
    assert items == []
