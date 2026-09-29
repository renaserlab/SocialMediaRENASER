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
async def test_un_fallo_de_storage_se_dice_y_no_borra_nada(monkeypatch, con_credenciales):
    """CAMBIO DE CONTRATO (0089, 29/09/2026). Antes esto NO lanzaba: la cuenta
    ya estaba borrada y el fallo se tragaba, así que la baja contestaba 204 con
    los archivos dentro. Ahora la baja borra los archivos ANTES de confirmar, y
    un fallo de Storage tiene que llegarle para deshacerla."""

    class ClienteQueFalla(_ClienteFalso):
        async def post(self, *a, **k):
            raise httpx.ConnectError("sin red")

    cliente = ClienteQueFalla({})
    _instalar_cliente(monkeypatch, cliente)

    with pytest.raises(storage.BorradoIncompleto) as error:
        await storage.delete_user_files("u")
    assert cliente.borrados == []
    # El mensaje nombra depósitos, nunca rutas.
    assert "u/" not in str(error.value)


@pytest.mark.asyncio
async def test_sin_credenciales_avisa_y_no_llama(monkeypatch):
    """Configuracion incompleta: se registra el aviso en vez de reventar."""
    monkeypatch.setattr(storage, "storage_configured", lambda: False)

    assert await storage.delete_user_files("u") == 0


def test_los_buckets_declarados_son_los_que_usa_el_movil():
    """Si el movil sube a un bucket nuevo, hay que anadirlo aqui o quedara sin limpiar.

    `seller-documents` (0085) guarda los documentos de la postulacion bajo
    `<perfil>/...`: al borrar la cuenta se van con ella. Igual
    `service-provider-documents` (0088), los de las postulaciones de Servicios.
    """
    assert set(storage.USER_BUCKETS) == {
        "post-media",
        "avatars",
        "course-media",
        "seller-documents",
        "service-provider-documents",
    }


class _SupabaseFalso:
    """Se comporta como el listado de Supabase: NO es recursivo. Una carpeta
    llega como una entrada con `id: null`, y borrar quita nombres exactos."""

    def __init__(self, objetos):
        self.objetos = objetos
        self.pedidos_de_borrado = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def post(self, url, headers=None, json=None):
        bucket = url.rsplit("/", 1)[-1]
        prefijo = json["prefix"].rstrip("/") + "/"
        nivel = {}
        for nombre in self.objetos.get(bucket, []):
            if nombre.startswith(prefijo):
                resto = nombre[len(prefijo):]
                cabeza = resto.split("/", 1)[0]
                nivel[cabeza] = None if "/" in resto else f"id-{cabeza}"
        pagina = [{"name": k, "id": v} for k, v in sorted(nivel.items())]
        desde = json.get("offset", 0)
        return _RespuestaFalsa(pagina[desde : desde + json["limit"]])

    async def request(self, metodo, url, headers=None, json=None):
        bucket = url.rsplit("/", 1)[-1]
        self.pedidos_de_borrado.append(list(json["prefixes"]))
        self.objetos[bucket] = [n for n in self.objetos.get(bucket, []) if n not in json["prefixes"]]
        return _RespuestaFalsa({})


@pytest.mark.asyncio
async def test_baja_tambien_las_carpetas_de_postulaciones(monkeypatch, con_credenciales):
    """Los documentos de Servicios (y los de proveedor de Productos) van en
    `<perfil>/<postulacion>/<archivo>`. El listado de Supabase no es
    recursivo: sin bajar a las carpetas, el borrado de la cuenta pedia borrar
    la CARPETA —que no es un objeto— y los documentos de identidad se quedaban."""
    cliente = _SupabaseFalso(
        {
            "service-provider-documents": ["u-1/app-1/dni.png", "u-1/app-1/poder.pdf", "u-1/app-2/dni.pdf"],
            "seller-documents": ["u-1/app-9/ruc.pdf"],
            "post-media": ["u-1/foto.jpg", "u-2/ajena.jpg"],
        }
    )
    _instalar_cliente(monkeypatch, cliente)

    total = await storage.delete_user_files("u-1")

    assert total == 5
    assert cliente.objetos["service-provider-documents"] == []
    assert cliente.objetos["seller-documents"] == []
    assert cliente.objetos["post-media"] == ["u-2/ajena.jpg"]
    for pedido in cliente.pedidos_de_borrado:
        assert all(r.startswith("u-1/") and r.rsplit("/", 1)[-1] for r in pedido)


def test_la_profundidad_de_la_bajada_tiene_tope():
    """Holgado (lo más hondo que escribe la aplicación son cuatro niveles),
    pero con tope. Pasarlo NO se calla: ver la prueba de la carpeta honda."""
    assert 4 <= storage.PROFUNDIDAD_MAXIMA <= 32


@pytest.mark.asyncio
async def test_si_no_se_puede_borrar_un_objeto_el_registro_no_dice_la_ruta(monkeypatch, con_credenciales, caplog):
    import logging

    class _Respuesta:
        status_code = 500

    class _Cliente:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def request(self, *a, **k):
            return _Respuesta()

    monkeypatch.setattr(storage.httpx, "AsyncClient", lambda **_: _Cliente())
    ruta = "11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/abc.pdf"
    with caplog.at_level(logging.WARNING):
        assert await storage.borrar_objeto("service-provider-documents", ruta) is False
    assert caplog.records, "el fallo se registra"
    assert not any(ruta in r.getMessage() or "abc.pdf" in r.getMessage() for r in caplog.records)


@pytest.mark.asyncio
async def test_si_un_deposito_no_se_deja_listar_no_se_borra_en_ninguno(monkeypatch, con_credenciales):
    """Se lista todo antes de borrar nada: con Storage a medias, la cuenta se
    queda entera y con todos sus archivos."""
    cliente = _SupabaseFalso({"post-media": ["u-1/foto.jpg"], "avatars": ["u-1/a.jpg"]})

    async def post(url, headers=None, json=None):
        if url.endswith("/avatars"):
            raise httpx.ConnectError("sin red")
        return await _SupabaseFalso.post(cliente, url, headers=headers, json=json)

    cliente.post = post
    _instalar_cliente(monkeypatch, cliente)

    with pytest.raises(storage.BorradoIncompleto):
        await storage.delete_user_files("u-1")
    assert cliente.pedidos_de_borrado == []
    assert cliente.objetos["post-media"] == ["u-1/foto.jpg"]


@pytest.mark.asyncio
async def test_si_un_deposito_no_se_deja_borrar_se_limpian_los_demas_y_se_dice(monkeypatch, con_credenciales):
    cliente = _SupabaseFalso({"post-media": ["u-1/foto.jpg"], "avatars": ["u-1/a.jpg"]})

    async def request(metodo, url, headers=None, json=None):
        if url.endswith("/post-media"):
            return _RespuestaQueFalla()
        return await _SupabaseFalso.request(cliente, metodo, url, headers=headers, json=json)

    cliente.request = request
    _instalar_cliente(monkeypatch, cliente)

    with pytest.raises(storage.BorradoIncompleto) as error:
        await storage.delete_user_files("u-1")
    assert "post-media" in str(error.value)
    assert cliente.objetos["avatars"] == []
    assert cliente.objetos["post-media"] == ["u-1/foto.jpg"]


class _RespuestaQueFalla(_RespuestaFalsa):
    def __init__(self):
        super().__init__({})

    def raise_for_status(self):
        raise httpx.HTTPStatusError("500", request=httpx.Request("DELETE", "https://x"), response=httpx.Response(500))


@pytest.mark.asyncio
async def test_se_borra_en_lotes_de_cien(monkeypatch, con_credenciales):
    """Un solo DELETE con miles de nombres es una petición que Storage puede
    rechazar entera."""
    muchos = [f"u-1/f{i:03}.jpg" for i in range(250)]
    cliente = _SupabaseFalso({"post-media": list(muchos)})
    _instalar_cliente(monkeypatch, cliente)

    assert await storage.delete_user_files("u-1") == 250
    assert [len(p) for p in cliente.pedidos_de_borrado] == [100, 100, 50]
    assert cliente.objetos["post-media"] == []


@pytest.mark.asyncio
async def test_los_adjuntos_de_chat_se_barren_por_conversacion(monkeypatch, con_credenciales):
    """`message-media` va en `<conversacion>/<quien sube>/<archivo>`. Antes de
    confirmar la baja, SOLO lo suyo en cada conversación; lo de las demás
    personas en las que se van enteras, después (`borrar_conversaciones`)."""
    cliente = _SupabaseFalso({
        "message-media": [
            "c-ajena/u-1/foto.jpg", "c-ajena/u-1/notas/voz.m4a", "c-ajena/u-2/suya.jpg",
            "c-propia/u-1/a.jpg", "c-propia/u-2/b.jpg",
            "c-otra/u-2/nada-que-ver.jpg",
        ],
    })
    _instalar_cliente(monkeypatch, cliente)

    total = await storage.delete_user_files("u-1", conversaciones=["c-ajena", "c-propia"])

    assert total == 3
    assert cliente.objetos["message-media"] == [
        "c-ajena/u-2/suya.jpg", "c-propia/u-2/b.jpg", "c-otra/u-2/nada-que-ver.jpg",
    ]

    assert await storage.borrar_conversaciones(["c-propia"]) == []
    assert cliente.objetos["message-media"] == ["c-ajena/u-2/suya.jpg", "c-otra/u-2/nada-que-ver.jpg"]


@pytest.mark.asyncio
async def test_lo_que_ya_no_esta_no_es_un_fallo(monkeypatch, con_credenciales):
    """Storage borra nombres exactos y no se queja de los que no existen:
    repetir la baja es seguro."""
    cliente = _SupabaseFalso({"post-media": ["u-1/foto.jpg"]})
    _instalar_cliente(monkeypatch, cliente)

    assert await storage.delete_user_files("u-1") == 1
    assert await storage.delete_user_files("u-1") == 0


@pytest.mark.asyncio
async def test_sin_credenciales_en_produccion_no_se_da_por_borrado(monkeypatch):
    monkeypatch.setattr(storage, "storage_configured", lambda: False)
    monkeypatch.setattr(
        storage, "get_settings", lambda: type("S", (), {"is_production": True})()
    )

    with pytest.raises(storage.StorageNoConfigurado):
        await storage.delete_user_files("u")


@pytest.mark.asyncio
async def test_una_carpeta_mas_honda_que_el_tope_no_se_calla(monkeypatch, con_credenciales):
    """Antes se saltaba en silencio y la baja respondía 204 con el archivo
    dentro. Ahora no se borra nada y se dice."""
    hondo = "u-1/" + "/".join(f"n{i}" for i in range(storage.PROFUNDIDAD_MAXIMA + 2)) + "/x.jpg"
    cliente = _SupabaseFalso({"post-media": ["u-1/foto.jpg", hondo]})
    _instalar_cliente(monkeypatch, cliente)

    with pytest.raises(storage.BorradoIncompleto):
        await storage.delete_user_files("u-1")
    assert cliente.pedidos_de_borrado == []


@pytest.mark.asyncio
async def test_los_listados_van_a_la_vez_con_limite(monkeypatch, con_credenciales):
    """Cada carpeta es una petición: de una en una, cien vídeos procesados
    superaban lo que espera el teléfono."""
    import asyncio

    carpetas = [f"u-1/derived/m{i}/feed.mp4" for i in range(40)]
    cliente = _SupabaseFalso({"post-media": carpetas})
    en_vuelo = {"ahora": 0, "maximo": 0}
    original = cliente.post

    async def post(url, headers=None, json=None):
        en_vuelo["ahora"] += 1
        en_vuelo["maximo"] = max(en_vuelo["maximo"], en_vuelo["ahora"])
        await asyncio.sleep(0.01)
        try:
            return await original(url, headers=headers, json=json)
        finally:
            en_vuelo["ahora"] -= 1

    cliente.post = post
    _instalar_cliente(monkeypatch, cliente)

    assert await storage.delete_user_files("u-1") == 40
    assert 2 <= en_vuelo["maximo"] <= storage.LISTADOS_A_LA_VEZ


@pytest.mark.asyncio
async def test_borrar_una_carpeta_sin_dueno(monkeypatch, con_credenciales):
    cliente = _SupabaseFalso({"post-media": [
        "u-1/derived/m1/feed.mp4", "u-1/derived/m1/hls/a.ts", "u-1/derived/m2/feed.mp4",
    ]})
    _instalar_cliente(monkeypatch, cliente)

    assert await storage.borrar_carpeta("post-media", "u-1/derived/m1") == 2
    assert cliente.objetos["post-media"] == ["u-1/derived/m2/feed.mp4"]


#: Depósitos que la baja NO barre, y por qué. Uno nuevo en una migración que no
#: esté aquí ni en `USER_BUCKETS` ni sea el de chat pone esta prueba en rojo.
NO_SE_BARREN = {
    "product-media": "va bajo el vendedor y el producto; un vendedor con productos no puede darse de baja solo (409)",
    "product-incidents": "va bajo la incidencia; una incidencia impide la baja (409)",
    "audio-private": "ningún código escribe en él",
}


def test_cada_deposito_de_las_migraciones_tiene_quien_lo_barra():
    """No es una copia de la constante: los depósitos salen de las migraciones."""
    import re
    from pathlib import Path

    migraciones = Path(__file__).resolve().parents[3] / "supabase" / "migrations"
    depositos = set()
    for ruta in migraciones.glob("*.sql"):
        texto = ruta.read_text(encoding="utf-8")
        for bloque in re.findall(r"insert\s+into\s+storage\.buckets[^;]*", texto, flags=re.I):
            depositos |= set(re.findall(r"\(\s*'([a-z0-9-]+)'\s*,", bloque))
    assert "service-provider-documents" in depositos and "message-media" in depositos
    sin_dueno = depositos - set(storage.USER_BUCKETS) - {storage.DEPOSITO_DE_CHAT} - set(NO_SE_BARREN)
    assert not sin_dueno, f"nadie barre estos depósitos al borrar una cuenta: {sorted(sin_dueno)}"


@pytest.mark.asyncio
async def test_una_conversacion_que_falla_no_impide_retirar_las_demas(monkeypatch, con_credenciales):
    cliente = _SupabaseFalso({"message-media": ["c-1/u-2/a.jpg", "c-2/u-2/b.jpg", "c-3/u-2/c.jpg"]})

    async def post(url, headers=None, json=None):
        if json["prefix"] == "c-2":
            raise httpx.ConnectError("sin red")
        return await _SupabaseFalso.post(cliente, url, headers=headers, json=json)

    cliente.post = post
    _instalar_cliente(monkeypatch, cliente)

    assert await storage.borrar_conversaciones(["c-1", "c-2", "c-3"]) == ["c-2"]
    assert cliente.objetos["message-media"] == ["c-2/u-2/b.jpg"]


@pytest.mark.asyncio
async def test_un_listado_que_falla_no_deja_tareas_colgando(monkeypatch, con_credenciales):
    """`gather` sin esperar a todas dejaba las subcarpetas hermanas corriendo
    con el cliente ya cerrado."""
    import asyncio

    cliente = _SupabaseFalso({"post-media": [f"u-1/m{i}/x.jpg" for i in range(6)]})

    async def post(url, headers=None, json=None):
        if json["prefix"] == "u-1/m0":
            raise httpx.ConnectError("sin red")
        if json["prefix"].startswith("u-1/m"):
            await asyncio.sleep(0.05)
        return await _SupabaseFalso.post(cliente, url, headers=headers, json=json)

    cliente.post = post
    _instalar_cliente(monkeypatch, cliente)
    antes = set(asyncio.all_tasks())

    with pytest.raises(storage.BorradoIncompleto):
        await storage.delete_user_files("u-1")
    assert set(asyncio.all_tasks()) - antes - {asyncio.current_task()} == set()
