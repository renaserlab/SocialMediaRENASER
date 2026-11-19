"""La compuerta de S3 DENTRO de la baja de cuenta (corrección M2 del QA).

Con `MEDIOS_S3_BUCKET` puesto y el contenedor sin credenciales del rol (hop
limit 1), cualquier llamada a S3 falla. La baja de quien nunca subió nada a S3
no puede caer por eso: `baja.borrar_cuenta` mira la base ANTES de la cascada
y, sin rastro de la cuenta en S3, no llama a S3. Con rastro, S3 tiene que
borrar o la baja no se confirma (como con Supabase).

Se ejerce el endpoint de verdad (`DELETE /auth/me`) con el entorno de
`test_baja_de_cuenta.py`, y S3 simulado con una función que falla o apunta.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from app.core.config import get_settings
from app.modules.content.models import Post, PostMedia
from app.modules.medios import publicacion
from app.modules.medios.models import MedioSubida
from tests.test_baja_de_cuenta import ANA, _borrar, _existe, entorno  # noqa: F401 — fixture

pytestmark = pytest.mark.asyncio


@pytest.fixture
def s3_sin_credenciales(monkeypatch):
    """Bucket configurado y S3 inalcanzable: cada llamada se apunta y falla."""
    monkeypatch.setattr(get_settings(), "medios_s3_bucket", "zexcelencia-medios-prueba-000000000000")
    llamadas: list[str] = []

    async def _sin_credenciales(uid: str) -> int:
        llamadas.append(uid)
        raise RuntimeError("NoCredentialsError: el contenedor no llega al rol")

    monkeypatch.setattr(publicacion, "borrar_cuenta", _sin_credenciales)
    return llamadas


async def _con_la_0116(sesiones) -> None:
    async with sesiones() as db:
        await db.execute(
            text("ALTER TABLE post_media ADD COLUMN almacen TEXT NOT NULL DEFAULT 'supabase'")
        )
        await db.commit()


async def _video_en_s3(sesiones, uid: str) -> None:
    async with sesiones() as db:
        post = Post(author_id=uid, body="video")
        db.add(post)
        await db.flush()
        medio = PostMedia(
            post_id=post.id, storage_path=f"videos/{uid}/m/original.mp4", media_type="video"
        )
        db.add(medio)
        await db.flush()
        await publicacion.marcar_s3(db, medio.id)
        await db.commit()


async def test_sin_rastro_en_s3_la_baja_no_habla_con_s3(entorno, s3_sin_credenciales) -> None:  # noqa: F811
    app, sesiones, _, _ = entorno
    await _con_la_0116(sesiones)
    r = await _borrar(app)
    assert r.status_code == 204, r.text
    assert not await _existe(sesiones, ANA)
    assert s3_sin_credenciales == []


async def test_sin_la_0116_tampoco(entorno, s3_sin_credenciales) -> None:  # noqa: F811
    app, sesiones, _, _ = entorno
    r = await _borrar(app)
    assert r.status_code == 204, r.text
    assert s3_sin_credenciales == []


async def test_con_un_video_en_s3_y_s3_caido_la_baja_no_se_confirma(entorno, s3_sin_credenciales) -> None:  # noqa: F811
    app, sesiones, _, _ = entorno
    await _con_la_0116(sesiones)
    await _video_en_s3(sesiones, ANA)
    r = await _borrar(app)
    assert r.status_code == 503 and r.json()["error"]["code"] == "account_deletion_storage_failed", r.text
    assert await _existe(sesiones, ANA)
    assert s3_sin_credenciales == [ANA]


async def test_con_una_subida_registrada_tambien_se_borra_en_s3(entorno, monkeypatch) -> None:  # noqa: F811
    app, sesiones, _, _ = entorno
    monkeypatch.setattr(get_settings(), "medios_s3_bucket", "zexcelencia-medios-prueba-000000000000")
    borradas: list[str] = []

    async def _borra(uid: str) -> int:
        borradas.append(uid)
        return 1

    monkeypatch.setattr(publicacion, "borrar_cuenta", _borra)
    await _con_la_0116(sesiones)
    async with sesiones() as db:
        db.add(
            MedioSubida(
                uid=ANA,
                grupo="33333333-3333-4333-8333-333333333333",
                tipo="video",
                clave_pendiente=f"pendientes/{ANA}/x.mp4",
                content_type="video/mp4",
                bytes_declarados=1,
                expira=datetime.now(timezone.utc) + timedelta(hours=1),
            )
        )
        await db.commit()
    r = await _borrar(app)
    assert r.status_code == 204, r.text
    assert borradas == [ANA]
    assert not await _existe(sesiones, ANA)
