"""Videos de publicaciones en S3 + CloudFront (spec «opción B», v3).

S3 y CloudFront SIMULADOS con `moto`: ninguna prueba habla con AWS. La firma
de CloudFront se comprueba de verdad (RSA-SHA256 con una clave generada aquí y
verificada con su pública).

Cubre las pruebas que la spec pide antes de la fase 2: firma con comodín y
ventanas, sin URL para `followers` sin permiso, presign con tipo y tamaño
fijados, multipart completo, publicar con subida ajena (403), límite por hora,
borrado de publicación y de cuenta, cliente viejo sin filas `s3`, la lista HLS
con la query en cada línea, el token HLS, PATCH con video nuevo, borrado
diferido de 30 días con denuncia abierta y la limpieza diaria.
"""

from __future__ import annotations

import base64
import json
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import pytest
import pytest_asyncio
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

# `moto` va en requirements.txt: si faltara, la prueba tiene que FALLAR (la
# puerta del despliegue no admite pruebas omitidas), no saltarse.
from moto import mock_aws  # noqa: E402

from app.core.config import get_settings  # noqa: E402
from app.core.security import AuthUser, get_current_user, get_optional_user  # noqa: E402
from app.main import app  # noqa: E402
from app.modules.content import media_processing as mp  # noqa: E402
from app.modules.content.models import Post, PostMedia  # noqa: E402
from app.modules.content.router import reescribir_lista_hls  # noqa: E402
from app.modules.medios import almacen, firma, limpieza, publicacion  # noqa: E402
from app.modules.medios.models import MedioSubida  # noqa: E402
from app.modules.moderation.models import Report  # noqa: E402
from app.modules.profiles.models import Profile  # noqa: E402
from app.modules.social_graph.models import Follow  # noqa: E402
from app.shared.database import Base, get_db  # noqa: E402

BUCKET = "zexcelencia-medios-prueba-000000000000"
DOMINIO = "d111111abcdef8.cloudfront.net"
KEY_PAIR_ID = "K2JCJMDEHXQW5F"

ANA = str(uuid4())  # publica
BETO = str(uuid4())  # la sigue
CARLA = str(uuid4())  # no la sigue

_CLAVE = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_CLAVE_B64 = base64.b64encode(
    _CLAVE.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
).decode()


def _des_b64(valor: str) -> bytes:
    return base64.b64decode(valor.replace("-", "+").replace("_", "=").replace("~", "/"))


def _verificar_url(url: str) -> dict:
    """Comprueba la firma de una URL como lo haría CloudFront; devuelve la
    política."""
    query = parse_qs(urlsplit(url).query)
    assert query["Key-Pair-Id"] == [KEY_PAIR_ID]
    assert query["Hash-Algorithm"] == ["SHA256"]
    politica = _des_b64(query["Policy"][0])
    _CLAVE.public_key().verify(
        _des_b64(query["Signature"][0]), politica, padding.PKCS1v15(), hashes.SHA256()
    )
    return json.loads(politica)


# --------------------------------------------------------------------------- #
# Entorno
# --------------------------------------------------------------------------- #
@pytest.fixture
def ajustes(monkeypatch):
    a = get_settings()
    for nombre, valor in {
        "medios_s3_bucket": BUCKET,
        "medios_s3_region": "us-east-1",
        "medios_s3_subida": "todos",
        "medios_s3_lectura": True,
        "cloudfront_medios_dominio": DOMINIO,
        "cloudfront_medios_distribucion_id": "E2EXAMPLE",
        "cloudfront_medios_key_pair_id": KEY_PAIR_ID,
        "cloudfront_medios_private_key_b64": _CLAVE_B64,
        "medios_tareas_token": "t" * 40,
    }.items():
        monkeypatch.setattr(a, nombre, valor)
    for variable in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
        monkeypatch.setenv(variable, "prueba")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    return a


@pytest.fixture
def s3(ajustes, monkeypatch):
    with mock_aws():
        almacen._cliente_s3.cache_clear()
        almacen._cliente_cloudfront.cache_clear()
        cliente = almacen.cliente_s3()
        cliente.create_bucket(Bucket=BUCKET)
        invalidaciones: list[list[str]] = []
        monkeypatch.setattr(
            almacen, "invalidar_sync", lambda rutas: invalidaciones.append(list(rutas)) or "I1"
        )
        cliente.invalidaciones = invalidaciones  # type: ignore[attr-defined]
        yield cliente
        almacen._cliente_s3.cache_clear()


async def _crear_base(con_0116: bool = True):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        from app.modules.catalog import models as _c  # noqa: F401
        from app.modules.communities import models as _co  # noqa: F401
        from app.modules.learning import models as _l  # noqa: F401
        from app.modules.messaging import models as _m  # noqa: F401
        from app.modules.notifications import device_tokens as _dt  # noqa: F401
        from app.modules.notifications import models as _n  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)
        if con_0116:
            # La columna de la 0116 NO está en el modelo a propósito (ver
            # `medios/models.py`): aquí se añade como la añade la migración.
            await conn.execute(
                text(
                    "ALTER TABLE post_media ADD COLUMN almacen TEXT NOT NULL DEFAULT 'supabase'"
                )
            )
    return engine


@pytest_asyncio.fixture
async def entorno(s3):
    engine = await _crear_base()
    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add_all(
            [
                Profile(id=ANA, full_name="Ana", username="ana"),
                Profile(id=BETO, full_name="Beto", username="beto"),
                Profile(id=CARLA, full_name="Carla", username="carla"),
                Follow(follower_id=BETO, following_id=ANA),
            ]
        )
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    app.dependency_overrides[get_db] = _db_override
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, sesiones, s3
    app.dependency_overrides.clear()
    await engine.dispose()


def _como(uid: str | None) -> None:
    if uid is None:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides[get_optional_user] = lambda: None
        return
    usuario = AuthUser(id=uid, email=f"{uid}@ejemplo.com", role="authenticated")
    app.dependency_overrides[get_current_user] = lambda: usuario
    app.dependency_overrides[get_optional_user] = lambda: usuario


NUEVA = {"X-Zeta-Medios": "s3"}


async def _post_s3(
    sesiones, s3, *, autor=ANA, visibilidad="public", con_feed=True, con_hls=False, estado="published"
) -> tuple[str, str]:
    """Una publicación con un video ya en S3. Devuelve (post_id, media_id)."""
    media_id = str(uuid4())
    carpeta = f"videos/{autor}/{media_id}"
    for nombre in ("original.mp4", "poster-v1.jpg", "feed-720-v1.mp4"):
        s3.put_object(Bucket=BUCKET, Key=f"{carpeta}/{nombre}", Body=b"x")
    async with sesiones() as db:
        post = Post(author_id=autor, body="video", visibility=visibilidad, status=estado)
        db.add(post)
        await db.flush()
        db.add(
            PostMedia(
                id=media_id,
                post_id=post.id,
                storage_path=f"{carpeta}/original.mp4",
                poster_path=f"{carpeta}/poster-v1.jpg",
                feed_path=f"{carpeta}/feed-720-v1.mp4" if con_feed else None,
                stream_path=f"{carpeta}/hls-v1" if con_hls else None,
                media_type="video",
            )
        )
        await db.flush()
        await publicacion.marcar_s3(db, media_id)
        await db.commit()
        return post.id, media_id


async def _post_supabase(sesiones, autor=ANA) -> str:
    async with sesiones() as db:
        post = Post(author_id=autor, body="foto")
        db.add(post)
        await db.flush()
        db.add(PostMedia(post_id=post.id, storage_path=f"{autor}/foto.jpg", media_type="image"))
        await db.commit()
        return post.id


# --------------------------------------------------------------------------- #
# 1. La firma
# --------------------------------------------------------------------------- #
def test_la_firma_usa_comodin_por_carpeta_y_sha256(ajustes):
    vence = firma.vencimiento_de_ventana()
    query = firma.query_de_carpeta(f"videos/{ANA}/m1", vence)
    url = firma.url_firmada(f"videos/{ANA}/m1/feed-720-v1.mp4", query)
    politica = _verificar_url(url)
    declaracion = politica["Statement"][0]
    assert declaracion["Resource"] == f"https://{DOMINIO}/videos/{ANA}/m1/*"
    assert declaracion["Condition"]["DateLessThan"]["AWS:EpochTime"] == vence


def test_dentro_de_la_hora_la_url_es_identica_y_vive_entre_5_y_6_horas(ajustes):
    inicio = 1_795_000_000 // 3600 * 3600
    a = firma.vencimiento_de_ventana(inicio + 5)
    b = firma.vencimiento_de_ventana(inicio + 3500)
    assert a == b == inicio + 6 * 3600
    assert firma.query_de_carpeta("videos/u/m", a) == firma.query_de_carpeta("videos/u/m", b)
    # La hora siguiente, otra ventana.
    assert firma.vencimiento_de_ventana(inicio + 3600) == a + 3600


def test_sin_clave_o_con_clave_rota_no_se_firma(ajustes, monkeypatch):
    monkeypatch.setattr(ajustes, "cloudfront_medios_private_key_b64", "esto-no-es-una-clave")
    firma.olvidar()
    assert firma.query_de_carpeta("videos/u/m") is None
    monkeypatch.setattr(ajustes, "cloudfront_medios_private_key_b64", "")
    firma.olvidar()
    assert firma.query_de_carpeta("videos/u/m") is None


def test_el_token_hls_ata_medio_persona_y_vencimiento(ajustes):
    token = firma.token_hls("m1", BETO)
    assert firma.validar_token_hls("m1", token) == (firma.vencimiento_de_ventana(), BETO)
    assert firma.validar_token_hls("m2", token) is None  # otro media_id
    vence, quien, mac = token.split(".")
    assert firma.validar_token_hls("m1", f"{vence}.{CARLA}.{mac}") is None  # otra persona
    viejo = firma.token_hls("m1", BETO, vence=int(time.time()) - 1)
    assert firma.validar_token_hls("m1", viejo) is None  # vencido
    anonimo = firma.token_hls("m1", None)
    assert firma.validar_token_hls("m1", anonimo)[1] is None


# --------------------------------------------------------------------------- #
# 2. Lectura: hidratación, cliente viejo, lectura apagada, visibilidad
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_cliente_nuevo_recibe_las_urls_firmadas(entorno):
    http, sesiones, s3 = entorno
    post_id, media_id = await _post_s3(sesiones, s3)
    _como(None)
    lista = (await http.get("/api/v1/posts", headers=NUEVA)).json()
    medio = next(p for p in lista if p["id"] == post_id)["media"][0]
    assert medio["almacen"] == "s3"
    assert urlsplit(medio["media_url"]).path == f"/videos/{ANA}/{media_id}/feed-720-v1.mp4"
    assert urlsplit(medio["poster_url"]).path == f"/videos/{ANA}/{media_id}/poster-v1.jpg"
    _verificar_url(medio["media_url"])
    assert medio["urls_expiran"]
    assert medio["stream_url"] is None


@pytest.mark.asyncio
async def test_sin_derivado_la_url_es_la_del_original(entorno):
    http, sesiones, s3 = entorno
    post_id, media_id = await _post_s3(sesiones, s3, con_feed=False)
    _como(None)
    detalle = (await http.get(f"/api/v1/posts/{post_id}", headers=NUEVA)).json()
    assert urlsplit(detalle["media"][0]["media_url"]).path.endswith("/original.mp4")


@pytest.mark.asyncio
async def test_el_cliente_viejo_no_recibe_filas_s3_en_ningun_endpoint(entorno):
    http, sesiones, s3 = entorno
    post_id, _ = await _post_s3(sesiones, s3)
    otra = await _post_supabase(sesiones)
    _como(BETO)
    await http.post(f"/api/v1/posts/{post_id}/save")
    lista = (await http.get("/api/v1/posts")).json()
    assert [p["id"] for p in lista] == [otra]
    # Detalle desde un enlace o un aviso: 404 limpio.
    assert (await http.get(f"/api/v1/posts/{post_id}")).status_code == 404
    assert (await http.get(f"/api/v1/posts?ids={post_id}")).json() == []
    assert (await http.get("/api/v1/saved-posts")).json() == []
    # Y la imagen de Supabase sale igual que siempre, sin URL de la API.
    assert lista[0]["media"][0]["almacen"] == "supabase"
    assert lista[0]["media"][0]["media_url"] is None


@pytest.mark.asyncio
async def test_con_la_lectura_apagada_no_sale_para_nadie(entorno, ajustes):
    http, sesiones, s3 = entorno
    post_id, _ = await _post_s3(sesiones, s3)
    ajustes.medios_s3_lectura = False
    _como(ANA)
    assert (await http.get(f"/api/v1/posts/{post_id}", headers=NUEVA)).status_code == 404
    assert post_id not in [p["id"] for p in (await http.get("/api/v1/posts", headers=NUEVA)).json()]


@pytest.mark.asyncio
async def test_sin_url_para_followers_sin_permiso_aunque_la_visibilidad_sea_abierta(entorno):
    """Las publicaciones con video en S3 pasan SIEMPRE por el predicado."""
    assert get_settings().publicaciones_visibilidad == "abierta"
    http, sesiones, s3 = entorno
    post_id, _ = await _post_s3(sesiones, s3, visibilidad="followers")
    _como(CARLA)
    assert (await http.get(f"/api/v1/posts/{post_id}", headers=NUEVA)).status_code == 404
    _como(None)
    assert (await http.get(f"/api/v1/posts/{post_id}", headers=NUEVA)).status_code == 404
    _como(BETO)
    detalle = (await http.get(f"/api/v1/posts/{post_id}", headers=NUEVA)).json()
    assert detalle["media"][0]["media_url"]


@pytest.mark.asyncio
async def test_sin_la_migracion_0116_todo_sigue_como_antes(s3):
    engine = await _crear_base(con_0116=False)
    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        await db.commit()
    post_id = await _post_supabase(sesiones)

    async def _db_override():
        async with sesiones() as session:
            yield session

    app.dependency_overrides[get_db] = _db_override
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
            _como(ANA)
            lista = (await http.get("/api/v1/posts", headers=NUEVA)).json()
            assert [p["id"] for p in lista] == [post_id]
            assert lista[0]["media"][0]["almacen"] == "supabase"
            r = await http.post(
                "/api/v1/medios/subidas",
                json={"tipo": "video", "content_type": "video/mp4", "bytes": 10, "grupo": str(uuid4())},
            )
            assert r.status_code == 403
            assert (await http.get("/api/v1/platform/config")).json()["medios_s3_subida"] is False
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# --------------------------------------------------------------------------- #
# 3. Subidas
# --------------------------------------------------------------------------- #
def _nueva_subida(tipo="video", ct="video/mp4", bytes_=1000, grupo=None) -> dict:
    return {"tipo": tipo, "content_type": ct, "bytes": bytes_, "grupo": grupo or str(uuid4())}


@pytest.mark.asyncio
async def test_el_put_simple_fija_tipo_y_tamano_en_la_firma(entorno):
    http, sesiones, _ = entorno
    _como(ANA)
    r = await http.post("/api/v1/medios/subidas", json=_nueva_subida(bytes_=1234))
    assert r.status_code == 201
    cuerpo = r.json()
    assert cuerpo["modo"] == "simple"
    assert cuerpo["clave_pendiente"].startswith(f"pendientes/{ANA}/")
    firmadas = parse_qs(urlsplit(cuerpo["url"]).query)["X-Amz-SignedHeaders"][0].split(";")
    assert {"content-length", "content-type", "host"} <= set(firmadas)
    assert parse_qs(urlsplit(cuerpo["url"]).query)["X-Amz-Expires"] == ["900"]
    assert cuerpo["cabeceras"] == {"Content-Type": "video/mp4"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "pedido",
    [
        _nueva_subida(ct="video/webm"),
        _nueva_subida(tipo="poster", ct="video/mp4"),
        _nueva_subida(bytes_=501 * 1024 * 1024),
        _nueva_subida(tipo="poster", ct="image/jpeg", bytes_=11 * 1024 * 1024),
    ],
)
async def test_tipo_o_tamano_invalido_se_rechaza(entorno, pedido):
    http, _, _ = entorno
    _como(ANA)
    assert (await http.post("/api/v1/medios/subidas", json=pedido)).status_code == 422


@pytest.mark.asyncio
async def test_sin_bandera_para_la_cuenta_no_se_sube(entorno, ajustes):
    http, _, _ = entorno
    ajustes.medios_s3_subida = "lista"
    ajustes.medios_s3_subida_cuentas = BETO
    _como(ANA)
    r = await http.post("/api/v1/medios/subidas", json=_nueva_subida())
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "medios_s3_no_habilitado"
    assert (await http.get("/api/v1/platform/config")).json()["medios_s3_subida"] is False
    _como(BETO)
    assert (await http.post("/api/v1/medios/subidas", json=_nueva_subida())).status_code == 201
    assert (await http.get("/api/v1/platform/config")).json()["medios_s3_subida"] is True
    ajustes.medios_s3_subida = "nadie"
    assert (await http.post("/api/v1/medios/subidas", json=_nueva_subida())).status_code == 403


@pytest.mark.asyncio
async def test_el_limite_cuenta_publicaciones_por_grupo(entorno, ajustes):
    http, _, _ = entorno
    ajustes.medios_publicaciones_con_video_por_hora = 3
    _como(ANA)
    grupos = [str(uuid4()) for _ in range(3)]
    for grupo in grupos:
        assert (await http.post("/api/v1/medios/subidas", json=_nueva_subida(grupo=grupo))).status_code == 201
        # El póster del mismo grupo, y un reintento, no cuentan.
        poster = _nueva_subida(tipo="poster", ct="image/jpeg", grupo=grupo)
        assert (await http.post("/api/v1/medios/subidas", json=poster)).status_code == 201
        assert (await http.post("/api/v1/medios/subidas", json=_nueva_subida(grupo=grupo))).status_code == 201
    r = await http.post("/api/v1/medios/subidas", json=_nueva_subida())
    assert r.status_code == 429
    # Otra cuenta no hereda el límite.
    _como(BETO)
    assert (await http.post("/api/v1/medios/subidas", json=_nueva_subida())).status_code == 201


@pytest.mark.asyncio
async def test_multipart_completo_reanudar_y_publicar(entorno, monkeypatch):
    http, sesiones, s3 = entorno
    # El corte real son 50 MB; se baja para no mover 50 MB por la memoria en
    # cada corrida. Lo que se prueba es el camino por partes.
    monkeypatch.setattr("app.modules.medios.router.LIMITE_SIMPLE", 20 * 1024 * 1024)
    _como(ANA)
    tamano = 25 * 1024 * 1024 + 7  # 3 partes: 10 + 10 + 5 MiB y 7 bytes
    grupo = str(uuid4())
    creada = (await http.post("/api/v1/medios/subidas", json=_nueva_subida(bytes_=tamano, grupo=grupo))).json()
    assert creada["modo"] == "partes"
    assert creada["partes_totales"] == 3 and creada["tamano_parte"] == 10 * 1024 * 1024
    sid = creada["id_de_subida"]

    partes = (await http.post(f"/api/v1/medios/subidas/{sid}/partes", json={"numeros": [1, 2, 3]})).json()["partes"]
    assert [p["bytes"] for p in partes] == [10 * 1024 * 1024, 10 * 1024 * 1024, 5 * 1024 * 1024 + 7]
    for p in partes:
        firmadas = parse_qs(urlsplit(p["url"]).query)["X-Amz-SignedHeaders"][0]
        assert "content-length" in firmadas
    fuera = await http.post(f"/api/v1/medios/subidas/{sid}/partes", json={"numeros": [4]})
    assert fuera.status_code == 422

    # El teléfono sube dos partes y se cierra la app (la subida en sí la
    # simula boto3 contra moto: las URLs prefirmadas no pasan por botocore).
    etags = {}
    for p in partes[:2]:
        etags[p["numero"]] = s3.upload_part(
            Bucket=BUCKET, Key=creada["clave_pendiente"], UploadId=creada["upload_id"],
            PartNumber=p["numero"], Body=b"a" * p["bytes"],
        )["ETag"]
    estado = (await http.get(f"/api/v1/medios/subidas/{sid}")).json()
    assert [p["numero"] for p in estado["partes_hechas"]] == [1, 2]
    assert estado["estado"] == "abierta"
    # Reanuda con la tercera.
    etags[3] = s3.upload_part(
        Bucket=BUCKET, Key=creada["clave_pendiente"], UploadId=creada["upload_id"],
        PartNumber=3, Body=b"a" * partes[2]["bytes"],
    )["ETag"]
    incompleto = await http.post(
        f"/api/v1/medios/subidas/{sid}/completar",
        json={"partes": [{"numero": 1, "etag": etags[1]}]},
    )
    assert incompleto.status_code == 422
    hecho = await http.post(
        f"/api/v1/medios/subidas/{sid}/completar",
        json={"partes": [{"numero": n, "etag": e} for n, e in etags.items()]},
    )
    assert hecho.json()["estado"] == "subida"

    # Publicar con la subida.
    r = await http.post(
        "/api/v1/posts",
        headers=NUEVA,
        json={"body": "", "media": [{"media_type": "video", "id_de_subida": sid}]},
    )
    assert r.status_code == 201, r.text
    medio = r.json()["media"][0]
    assert medio["almacen"] == "s3"
    assert medio["storage_path"] == f"videos/{ANA}/{medio['id']}/original.mp4"
    assert s3.head_object(Bucket=BUCKET, Key=medio["storage_path"])["ContentLength"] == tamano
    assert s3.head_object(Bucket=BUCKET, Key=medio["storage_path"])["CacheControl"].endswith("immutable")
    assert "Contents" not in s3.list_objects_v2(Bucket=BUCKET, Prefix="pendientes/")
    assert medio["media_url"]
    async with sesiones() as db:
        subida = await db.get(MedioSubida, sid)
        assert subida.estado == "usada" and subida.media_id == medio["id"]
    # Una subida usada no se puede volver a publicar.
    otra = await http.post(
        "/api/v1/posts", json={"body": "x", "media": [{"media_type": "video", "id_de_subida": sid}]}
    )
    assert otra.status_code == 409


async def _subida_simple(http, s3, uid, tipo="video", ct="video/mp4", cuerpo=b"v" * 100, grupo=None):
    _como(uid)
    creada = (
        await http.post(
            "/api/v1/medios/subidas",
            json=_nueva_subida(tipo=tipo, ct=ct, bytes_=len(cuerpo), grupo=grupo),
        )
    ).json()
    s3.put_object(Bucket=BUCKET, Key=creada["clave_pendiente"], Body=cuerpo, ContentType=ct)
    return creada["id_de_subida"]


@pytest.mark.asyncio
async def test_publicar_con_la_subida_de_otra_persona_es_403(entorno):
    http, sesiones, s3 = entorno
    sid = await _subida_simple(http, s3, BETO)
    _como(ANA)
    r = await http.post("/api/v1/posts", json={"body": "", "media": [{"media_type": "video", "id_de_subida": sid}]})
    assert r.status_code == 403
    async with sesiones() as db:
        assert (await db.scalars(select(Post))).all() == []  # nada a medias


@pytest.mark.asyncio
async def test_publicar_sin_que_el_archivo_haya_llegado_o_con_otro_tamano(entorno):
    http, _, s3 = entorno
    _como(ANA)
    creada = (await http.post("/api/v1/medios/subidas", json=_nueva_subida(bytes_=50))).json()
    r = await http.post(
        "/api/v1/posts", json={"body": "", "media": [{"media_type": "video", "id_de_subida": creada["id_de_subida"]}]}
    )
    assert r.status_code == 409
    s3.put_object(Bucket=BUCKET, Key=creada["clave_pendiente"], Body=b"x" * 49, ContentType="video/mp4")
    r = await http.post(
        "/api/v1/posts", json={"body": "", "media": [{"media_type": "video", "id_de_subida": creada["id_de_subida"]}]}
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_una_ruta_de_s3_del_cliente_no_entra_como_si_fuera_de_supabase(entorno):
    http, _, _ = entorno
    _como(ANA)
    r = await http.post(
        "/api/v1/posts",
        json={"body": "x", "media": [{"media_type": "video", "storage_path": f"videos/{BETO}/m/original.mp4"}]},
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_publicar_con_poster_y_se_encola_el_procesado(entorno, monkeypatch):
    http, _, s3 = entorno
    encolados: list[str] = []

    async def procesar(media_id):
        encolados.append(media_id)

    monkeypatch.setattr("app.modules.content.router.process_media", procesar)
    monkeypatch.setattr(get_settings(), "media_processing_enabled", True)
    grupo = str(uuid4())
    video = await _subida_simple(http, s3, ANA, grupo=grupo)
    poster = await _subida_simple(http, s3, ANA, tipo="poster", ct="image/jpeg", cuerpo=b"j" * 10, grupo=grupo)
    r = await http.post(
        "/api/v1/posts",
        headers=NUEVA,
        json={"body": "", "media": [{"media_type": "video", "id_de_subida": video, "id_de_subida_poster": poster,
                                      "storage_path": "lo-ignora/la-api.mp4"}]},
    )
    assert r.status_code == 201, r.text
    medio = r.json()["media"][0]
    assert medio["poster_path"] == f"videos/{ANA}/{medio['id']}/poster-v1.jpg"
    assert s3.head_object(Bucket=BUCKET, Key=medio["poster_path"])["ContentType"] == "image/jpeg"
    assert encolados == [medio["id"]]


@pytest.mark.asyncio
async def test_completar_una_subida_simple_comprueba_el_archivo(entorno):
    http, sesiones, s3 = entorno
    _como(ANA)
    creada = (await http.post("/api/v1/medios/subidas", json=_nueva_subida(bytes_=10))).json()
    sid = creada["id_de_subida"]
    assert (await http.post(f"/api/v1/medios/subidas/{sid}/completar", json={"partes": []})).status_code == 409
    s3.put_object(Bucket=BUCKET, Key=creada["clave_pendiente"], Body=b"x" * 10, ContentType="video/mp4")
    r = await http.post(f"/api/v1/medios/subidas/{sid}/completar", json={"partes": []})
    assert r.json()["estado"] == "subida"
    # Idempotente.
    r = await http.post(f"/api/v1/medios/subidas/{sid}/completar", json={"partes": []})
    assert r.status_code == 200 and r.json()["estado"] == "subida"
    publicado = await http.post(
        "/api/v1/posts", json={"body": "", "media": [{"media_type": "video", "id_de_subida": sid}]}
    )
    assert publicado.status_code == 201


@pytest.mark.asyncio
async def test_cancelar_borra_la_pendiente(entorno):
    http, sesiones, s3 = entorno
    sid = await _subida_simple(http, s3, ANA)
    assert (await http.delete(f"/api/v1/medios/subidas/{sid}")).status_code == 204
    assert "Contents" not in s3.list_objects_v2(Bucket=BUCKET, Prefix="pendientes/")
    async with sesiones() as db:
        assert (await db.get(MedioSubida, sid)).estado == "cancelada"


# --------------------------------------------------------------------------- #
# 4. Editar y borrar
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_patch_conserva_el_video_que_se_reenvia(entorno):
    http, sesiones, s3 = entorno
    post_id, media_id = await _post_s3(sesiones, s3)
    _como(ANA)
    r = await http.patch(
        f"/api/v1/posts/{post_id}",
        headers=NUEVA,
        json={"body": "nuevo", "media": [{"media_type": "video", "storage_path": f"videos/{ANA}/{media_id}/original.mp4"}]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["media"][0]["id"] == media_id
    assert r.json()["media"][0]["almacen"] == "s3"
    assert s3.invalidaciones == []


@pytest.mark.asyncio
async def test_patch_con_video_nuevo_retira_el_anterior_y_reprocesa(entorno, monkeypatch):
    http, sesiones, s3 = entorno
    encolados: list[str] = []

    async def procesar(media_id):
        encolados.append(media_id)

    monkeypatch.setattr("app.modules.content.router.process_media", procesar)
    monkeypatch.setattr(get_settings(), "media_processing_enabled", True)
    post_id, viejo = await _post_s3(sesiones, s3)
    sid = await _subida_simple(http, s3, ANA)
    r = await http.patch(
        f"/api/v1/posts/{post_id}",
        headers=NUEVA,
        json={"media": [{"media_type": "video", "id_de_subida": sid}]},
    )
    assert r.status_code == 200, r.text
    nuevo = r.json()["media"][0]["id"]
    assert nuevo != viejo and encolados == [nuevo]
    claves = {o["Key"] for o in s3.list_objects_v2(Bucket=BUCKET, Prefix=f"borrados/{ANA}/{viejo}/")["Contents"]}
    assert f"borrados/{ANA}/{viejo}/original.mp4" in claves
    assert "Contents" not in s3.list_objects_v2(Bucket=BUCKET, Prefix=f"videos/{ANA}/{viejo}/")
    assert s3.invalidaciones == [[f"/videos/{ANA}/{viejo}/*"]]


@pytest.mark.asyncio
async def test_borrar_la_publicacion_mueve_a_borrados_e_invalida(entorno):
    http, sesiones, s3 = entorno
    post_id, media_id = await _post_s3(sesiones, s3)
    _como(ANA)
    assert (await http.delete(f"/api/v1/posts/{post_id}")).status_code == 204
    assert "Contents" not in s3.list_objects_v2(Bucket=BUCKET, Prefix=f"videos/{ANA}/{media_id}/")
    marca = s3.get_object(Bucket=BUCKET, Key=f"borrados/{ANA}/{media_id}/{publicacion.MARCA_DE_PUBLICACION}")
    assert marca["Body"].read().decode() == post_id
    assert s3.invalidaciones == [[f"/videos/{ANA}/{media_id}/*"]]
    # Y deja de firmarse al instante.
    assert (await http.get(f"/api/v1/posts/{post_id}", headers=NUEVA)).status_code == 404
    # Restaurar lo devuelve.
    await publicacion.restaurar(ANA, media_id)
    assert s3.head_object(Bucket=BUCKET, Key=f"videos/{ANA}/{media_id}/original.mp4")


@pytest.mark.asyncio
async def test_la_baja_de_cuenta_vacia_los_tres_prefijos(entorno):
    _, sesiones, s3 = entorno
    _, media_id = await _post_s3(sesiones, s3)
    s3.put_object(Bucket=BUCKET, Key=f"borrados/{ANA}/x/original.mp4", Body=b"x")
    s3.put_object(Bucket=BUCKET, Key=f"pendientes/{ANA}/y.mp4", Body=b"x")
    s3.put_object(Bucket=BUCKET, Key=f"videos/{BETO}/z/original.mp4", Body=b"x")
    assert await publicacion.borrar_cuenta(ANA) == 5
    for prefijo in ("videos", "borrados", "pendientes"):
        assert "Contents" not in s3.list_objects_v2(Bucket=BUCKET, Prefix=f"{prefijo}/{ANA}/")
    assert s3.head_object(Bucket=BUCKET, Key=f"videos/{BETO}/z/original.mp4")
    assert s3.invalidaciones == [[f"/videos/{ANA}/*"]]


@pytest.mark.asyncio
async def test_si_s3_falla_la_baja_no_se_confirma(entorno, monkeypatch):
    def _rompe(_uid):
        raise RuntimeError("S3 caido")

    monkeypatch.setattr(publicacion, "_borrar_cuenta_sync", _rompe)
    with pytest.raises(RuntimeError):
        await publicacion.borrar_cuenta(ANA)


# --------------------------------------------------------------------------- #
# 5. HLS
# --------------------------------------------------------------------------- #
MASTER = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=896000,RESOLUTION=360x640\n360p.m3u8\n"
VARIANTE = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\n360p_000.ts\n#EXTINF:4.0,\n360p_001.ts\n#EXT-X-ENDLIST\n"


def test_la_reescritura_firma_cada_segmento_y_encadena_las_variantes(ajustes):
    query = firma.query_de_carpeta("videos/u/m")
    master = reescribir_lista_hls(MASTER, token="TK", carpeta_hls="videos/u/m/hls-v1", query_cloudfront=query)
    assert "360p.m3u8?t=TK" in master.splitlines()
    variante = reescribir_lista_hls(VARIANTE, token="TK", carpeta_hls="videos/u/m/hls-v1", query_cloudfront=query)
    segmentos = [l for l in variante.splitlines() if l and not l.startswith("#")]
    assert len(segmentos) == 2
    for linea in segmentos:
        assert linea.startswith(f"https://{DOMINIO}/videos/u/m/hls-v1/360p_00")
        _verificar_url(linea)


@pytest.mark.asyncio
async def test_el_hls_de_s3_pide_token_valido_y_vuelve_a_mirar_la_visibilidad(entorno):
    http, sesiones, s3 = entorno
    post_id, media_id = await _post_s3(sesiones, s3, visibilidad="followers", con_hls=True)
    carpeta = f"videos/{ANA}/{media_id}/hls-v1"
    s3.put_object(Bucket=BUCKET, Key=f"{carpeta}/master.m3u8", Body=MASTER.encode())
    s3.put_object(Bucket=BUCKET, Key=f"{carpeta}/360p.m3u8", Body=VARIANTE.encode())

    _como(BETO)
    detalle = (await http.get(f"/api/v1/posts/{post_id}", headers=NUEVA)).json()
    stream_url = detalle["media"][0]["stream_url"]
    assert stream_url.startswith(f"/api/v1/media/{media_id}/hls/master.m3u8?t=")
    token = parse_qs(urlsplit(stream_url).query)["t"][0]

    _como(None)  # el reproductor nativo no manda sesión
    master = await http.get(stream_url)
    assert master.status_code == 200
    assert f"360p.m3u8?t={token}" in master.text
    assert master.headers["cache-control"].startswith("private")
    variante = await http.get(f"/api/v1/media/{media_id}/hls/360p.m3u8?t={token}")
    for linea in [l for l in variante.text.splitlines() if l and not l.startswith("#")]:
        politica = _verificar_url(linea)
        assert politica["Statement"][0]["Condition"]["DateLessThan"]["AWS:EpochTime"] <= int(token.split(".")[0])

    # Sin token, con uno de otro medio o con uno inventado: 404.
    assert (await http.get(f"/api/v1/media/{media_id}/hls/master.m3u8")).status_code == 404
    ajeno = firma.token_hls(str(uuid4()), BETO)
    assert (await http.get(f"/api/v1/media/{media_id}/hls/master.m3u8?t={ajeno}")).status_code == 404
    # Un token emitido a quien NO puede verla tampoco sirve.
    de_carla = firma.token_hls(media_id, CARLA)
    assert (await http.get(f"/api/v1/media/{media_id}/hls/master.m3u8?t={de_carla}")).status_code == 404
    # Si Beto deja de seguir a Ana, el mismo token deja de servir al instante.
    async with sesiones() as db:
        await db.execute(text("DELETE FROM follows"))
        await db.commit()
    assert (await http.get(stream_url)).status_code == 404


# --------------------------------------------------------------------------- #
# 6. Limpieza diaria y tareas
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_ruta_de_tareas_exige_el_secreto(entorno, ajustes, monkeypatch):
    http, _, _ = entorno
    corridas: list[int] = []

    async def _corre():
        corridas.append(1)

    monkeypatch.setattr("app.modules.medios.router._limpieza_en_segundo_plano", _corre)
    assert (await http.post("/api/v1/tareas/medios/limpieza")).status_code == 503
    malo = {"X-Medios-Tareas-Token": "x" * 40}
    assert (await http.post("/api/v1/tareas/medios/limpieza", headers=malo)).status_code == 503
    bueno = {"X-Medios-Tareas-Token": "t" * 40}
    assert (await http.post("/api/v1/tareas/medios/limpieza", headers=bueno)).status_code == 202
    assert corridas == [1]
    ajustes.medios_tareas_token = "corto"
    assert (await http.post("/api/v1/tareas/medios/limpieza", headers={"X-Medios-Tareas-Token": "corto"})).status_code == 503


@pytest.mark.asyncio
async def test_la_limpieza_respeta_denuncias_versiones_y_es_idempotente(entorno, monkeypatch):
    http, sesiones, s3 = entorno
    # Una publicación borrada sin denuncia y otra con denuncia abierta.
    libre, m_libre = await _post_s3(sesiones, s3)
    denunciada, m_denunciada = await _post_s3(sesiones, s3)
    _como(ANA)
    await http.delete(f"/api/v1/posts/{libre}")
    await http.delete(f"/api/v1/posts/{denunciada}")
    # Una viva con un derivado de una versión vieja.
    viva, m_viva = await _post_s3(sesiones, s3)
    s3.put_object(Bucket=BUCKET, Key=f"videos/{ANA}/{m_viva}/poster-v0.jpg", Body=b"viejo")
    async with sesiones() as db:
        db.add(Report(reporter_id=BETO, entity_type="post", entity_id=denunciada, reason="x", status="open"))
        # Una subida vencida.
        db.add(MedioSubida(uid=ANA, grupo=str(uuid4()), tipo="video", clave_pendiente=f"pendientes/{ANA}/v.mp4",
                           content_type="video/mp4", bytes_declarados=1,
                           expira=datetime.now(timezone.utc) - timedelta(minutes=1)))
        await db.commit()

    # Hoy: nada tiene edad suficiente.
    async with sesiones() as db:
        hoy = await limpieza.ejecutar(db)
    assert hoy["borrados_purgados"] == 0 and hoy["versiones_viejas"] == 0
    assert hoy["subidas_vencidas"] == 1 and hoy["errores"] == []

    # Dentro de 31 días.
    futuro = datetime.now(timezone.utc) + timedelta(days=31)
    monkeypatch.setattr(limpieza, "_ahora", lambda: futuro)
    async with sesiones() as db:
        resultado = await limpieza.ejecutar(db)
    assert resultado["borrados_purgados"] == 1
    assert "Contents" not in s3.list_objects_v2(Bucket=BUCKET, Prefix=f"borrados/{ANA}/{m_libre}/")
    assert s3.list_objects_v2(Bucket=BUCKET, Prefix=f"borrados/{ANA}/{m_denunciada}/")["KeyCount"] > 0
    assert resultado["versiones_viejas"] == 1
    assert s3.head_object(Bucket=BUCKET, Key=f"videos/{ANA}/{m_viva}/poster-v1.jpg")
    assert "Contents" not in s3.list_objects_v2(Bucket=BUCKET, Prefix=f"videos/{ANA}/{m_viva}/poster-v0")

    # Idempotente: la segunda pasada no encuentra nada.
    async with sesiones() as db:
        otra = await limpieza.ejecutar(db)
    assert otra["borrados_purgados"] == 0 and otra["versiones_viejas"] == 0 and otra["subidas_vencidas"] == 0

    # Resuelta la denuncia, se purga.
    async with sesiones() as db:
        await db.execute(text("UPDATE reports SET status = 'resolved'"))
        await db.commit()
        assert (await limpieza.ejecutar(db))["borrados_purgados"] == 1


@pytest.mark.asyncio
async def test_la_limpieza_reconcilia_un_borrado_que_no_llego_a_moverse(entorno, monkeypatch):
    http, sesiones, s3 = entorno
    post_id, media_id = await _post_s3(sesiones, s3)

    async def _falla(*_a, **_k):
        return False

    monkeypatch.setattr(publicacion, "retirar", _falla)
    _como(ANA)
    await http.delete(f"/api/v1/posts/{post_id}")
    assert s3.list_objects_v2(Bucket=BUCKET, Prefix=f"videos/{ANA}/{media_id}/")["KeyCount"] > 0
    monkeypatch.undo()
    # `undo` deshace también los ajustes: se vuelven a poner los de S3.
    monkeypatch.setattr(get_settings(), "medios_s3_bucket", BUCKET)
    monkeypatch.setattr(almacen, "invalidar_sync", lambda rutas: "I2")
    async with sesiones() as db:
        assert await limpieza.reconciliar(db) == 1
    assert "Contents" not in s3.list_objects_v2(Bucket=BUCKET, Prefix=f"videos/{ANA}/{media_id}/")


# --------------------------------------------------------------------------- #
# 7. Procesado contra S3 (moto)
# --------------------------------------------------------------------------- #
def test_los_derivados_de_s3_van_versionados():
    medio = PostMedia(id="m1", storage_path="videos/u/m1/original.mp4", media_type="video")
    assert mp.rutas_de_derivados(medio, "s3", "u") == (
        "videos/u/m1/poster-v1.jpg",
        "videos/u/m1/feed-720-v1.mp4",
        "videos/u/m1/hls-v1",
    )
    medio.poster_path = "videos/u/m1/poster-v3.jpg"
    medio.stream_path = "videos/u/m1/hls-v2"
    assert mp.rutas_de_derivados(medio, "s3", "u")[0] == "videos/u/m1/poster-v4.jpg"
    assert mp.rutas_de_derivados(medio, "s3", "u")[2] == "videos/u/m1/hls-v3"
    # Supabase, como siempre.
    assert mp.rutas_de_derivados(medio, "supabase", "u")[0] == "u/derived/m1/poster.jpg"


@pytest.mark.asyncio
async def test_s3storage_sube_baja_y_borra(s3, tmp_path):
    alm = almacen.S3Storage()
    await alm.subir("videos/u/m/poster-v1.jpg", b"jpg", "image/jpeg")
    cabeza = s3.head_object(Bucket=BUCKET, Key="videos/u/m/poster-v1.jpg")
    assert cabeza["ContentType"] == "image/jpeg"
    assert cabeza["CacheControl"] == almacen.CACHE_INMUTABLE
    assert await alm.descargar("videos/u/m/poster-v1.jpg") == b"jpg"
    destino = tmp_path / "x"
    await alm.descargar_a_disco("videos/u/m/poster-v1.jpg", destino)
    assert destino.read_bytes() == b"jpg"
    url = await alm.url_de_lectura_temporal("videos/u/m/poster-v1.jpg", 2400)
    assert "X-Amz-Expires=2400" in url
    assert await alm.borrar_prefijo("videos/u/") == 1


@pytest.mark.asyncio
async def test_el_procesado_de_un_video_s3_escribe_en_s3_con_el_dueno_del_post(s3, monkeypatch, tmp_path):
    """Sin ffmpeg real: se simulan la extracción del póster y la sonda. Lo que
    se comprueba es DÓNDE lee y escribe, y que el dueño sale de la
    publicación y no de la clave (que empieza por `videos/`)."""
    medio = PostMedia(id="m9", storage_path="videos/ana/m9/original.mp4", media_type="video",
                      width=720, height=1280, duration_s=5.0, bytes=10)
    s3.put_object(Bucket=BUCKET, Key=medio.storage_path, Body=b"video")

    async def _poster(_ffmpeg, entrada, destino):
        assert entrada.startswith("https://")  # URL prefirmada de S3
        destino.write_bytes(b"jpeg")
        return True

    monkeypatch.setattr(mp, "_ffmpeg", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(mp, "_extraer_poster", _poster)
    import httpx

    async with httpx.AsyncClient() as client:
        await mp._process_video(client, medio, "s3", "ana")
    assert medio.poster_path == "videos/ana/m9/poster-v1.jpg"
    assert s3.get_object(Bucket=BUCKET, Key=medio.poster_path)["Body"].read() == b"jpeg"


@pytest.mark.asyncio
async def test_la_salud_lista_firma_y_pide_a_cloudfront(entorno, monkeypatch):
    http, sesiones, s3 = entorno
    async with sesiones() as db:
        db.add(Profile(id=(admin := str(uuid4())), full_name="Admin", username="adm", role="admin"))
        await db.commit()

    class _Respuesta:
        status_code = 200

    class _Cliente:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            _verificar_url(url)
            return _Respuesta()

    monkeypatch.setattr("app.modules.medios.router.cliente_http", lambda _t: _Cliente())
    _como(CARLA)
    assert (await http.get("/api/v1/admin/medios/salud")).status_code == 403
    _como(admin)
    cuerpo = (await http.get("/api/v1/admin/medios/salud")).json()
    assert cuerpo["bucket"] == "ok" and cuerpo["firma"] is True and cuerpo["cloudfront"] == 200
    assert "privada" not in json.dumps(cuerpo).lower()
