"""Limpieza de Storage al eliminar una cuenta.

La politica de privacidad promete que las fotos, videos y audios se borran. Sin
estas pruebas nada garantiza que se cumpla: el borrado de la cuenta pasaria
igual de verde aunque los ficheros quedaran en los buckets.

No se llama a Supabase de verdad; se sustituye el cliente HTTP para comprobar
QUE se pide y COMO se reacciona ante fallos.
"""

import httpx
import pytest

from app.shared import storage


class _RespuestaFalsa:
    def __init__(self, datos):
        self._datos = datos

    def json(self):
        return self._datos

    def raise_for_status(self):
        return None


class _ClienteFalso:
    """Cliente HTTP de mentira que anota las llamadas recibidas."""

    def __init__(self, por_bucket):
        self.por_bucket = por_bucket
        self.borrados = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def post(self, url, headers=None, json=None):
        bucket = url.rsplit("/", 1)[-1]
        offset = json.get("offset", 0)
        # Se devuelve la pagina que toque para poder probar el recorrido.
        pagina = self.por_bucket.get(bucket, [])[offset : offset + json["limit"]]
        return _RespuestaFalsa([{"name": n} for n in pagina])

    async def request(self, metodo, url, headers=None, json=None):
        self.borrados.append((url.rsplit("/", 1)[-1], json["prefixes"]))
        return _RespuestaFalsa({})


@pytest.fixture
def con_credenciales(monkeypatch):
    monkeypatch.setattr(storage, "storage_configured", lambda: True)
    monkeypatch.setattr(
        storage, "get_settings", lambda: type("S", (), {"supabase_url": "https://x.supabase.co", "supabase_service_role_key": "k"})()
    )


def _instalar_cliente(monkeypatch, cliente):
    monkeypatch.setattr(storage.httpx, "AsyncClient", lambda **_: cliente)


@pytest.mark.asyncio
async def test_borra_los_archivos_de_los_tres_buckets(monkeypatch, con_credenciales):
    cliente = _ClienteFalso(
        {
            "post-media": ["foto.jpg", "video.mp4"],
            "avatars": ["avatar-1.jpg"],
            "course-media": [],
        }
    )
    _instalar_cliente(monkeypatch, cliente)

    total = await storage.delete_user_files("usuario-1")

    assert total == 3
    borrados = dict(cliente.borrados)
    assert borrados["post-media"] == ["usuario-1/foto.jpg", "usuario-1/video.mp4"]
    assert borrados["avatars"] == ["usuario-1/avatar-1.jpg"]
    # Un bucket sin archivos no genera peticion de borrado.
    assert "course-media" not in borrados


@pytest.mark.asyncio
async def test_las_rutas_van_bajo_el_prefijo_del_usuario(monkeypatch, con_credenciales):
    """Sin el prefijo se borrarian archivos de otra persona."""
    cliente = _ClienteFalso({"post-media": ["a.jpg"], "avatars": [], "course-media": []})
    _instalar_cliente(monkeypatch, cliente)

    await storage.delete_user_files("abc-123")

    _, rutas = cliente.borrados[0]
    assert all(r.startswith("abc-123/") for r in rutas)


@pytest.mark.asyncio
async def test_recorre_todas_las_paginas(monkeypatch, con_credenciales):
    """Con mas de 100 archivos, quedarse en la primera pagina dejaria restos."""
    muchos = [f"f{i}.jpg" for i in range(250)]
    cliente = _ClienteFalso({"post-media": muchos, "avatars": [], "course-media": []})
    _instalar_cliente(monkeypatch, cliente)

    total = await storage.delete_user_files("u")

    assert total == 250


@pytest.mark.asyncio
async def test_un_fallo_de_storage_no_rompe_el_borrado(monkeypatch, con_credenciales):
    """La cuenta ya se ha borrado: fallar aqui no puede propagar una excepcion."""

    class ClienteQueFalla(_ClienteFalso):
        async def post(self, *a, **k):
            raise httpx.ConnectError("sin red")

    _instalar_cliente(monkeypatch, ClienteQueFalla({}))

    assert await storage.delete_user_files("u") == 0  # no lanza


@pytest.mark.asyncio
async def test_sin_credenciales_avisa_y_no_llama(monkeypatch):
    """Configuracion incompleta: se registra el aviso en vez de reventar."""
    monkeypatch.setattr(storage, "storage_configured", lambda: False)

    assert await storage.delete_user_files("u") == 0


def test_los_buckets_declarados_son_los_que_usa_el_movil():
    """Si el movil sube a un bucket nuevo, hay que anadirlo aqui o quedara sin limpiar.

    `seller-documents` (0085) guarda los documentos de la postulacion bajo
    `<perfil>/...`: al borrar la cuenta se van con ella.
    """
    assert set(storage.USER_BUCKETS) == {
        "post-media",
        "avatars",
        "course-media",
        "seller-documents",
    }
