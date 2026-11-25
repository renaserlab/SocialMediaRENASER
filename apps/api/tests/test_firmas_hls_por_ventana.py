"""Listas HLS de Supabase con firmas estables por ventana.

Medido el 24/11/2026: cada pedido de lista refirmaba los segmentos, la firma
es parte de la clave de cache del CDN de Supabase, y el primer segmento daba
siempre MISS (1,1 s al primer byte contra 0,13 s con acierto). Lo que se
prueba: dentro de una ventana la lista sale IDENTICA y se firma una sola vez;
al cambiar de ventana se refirma; la firma nunca vence antes de lo que puede
guardarse la lista.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

from app.modules.content import hls_supabase as hs
from app.modules.content import router as content_router

T0 = 1_800_000_000  # inicio exacto de una ventana (multiplo de 1800)


def test_la_firma_vence_al_final_de_la_ventana_mas_una_hora():
    assert T0 % hs.VENTANA_S == 0
    assert hs.segundos_de_firma(T0) == hs.VENTANA_S + hs.VIDA_TRAS_VENTANA_S
    assert hs.segundos_de_firma(T0 + 1000) == hs.VENTANA_S + hs.VIDA_TRAS_VENTANA_S - 1000
    # Mismo vencimiento ABSOLUTO para toda la ventana.
    assert {t + hs.segundos_de_firma(t) for t in (T0, T0 + 1, T0 + 1799)} == {
        T0 + hs.VENTANA_S + hs.VIDA_TRAS_VENTANA_S
    }


def test_lo_que_se_guarda_nunca_lleva_una_firma_vencida():
    for t in range(T0, T0 + hs.VENTANA_S, 37):
        assert hs.max_age(t) <= hs.MAX_AGE_S
        assert hs.max_age(t) >= 1
        # Lo guardado caduca bastante antes que la firma que lleva.
        assert t + hs.max_age(t) + 3600 <= t + hs.segundos_de_firma(t)


def test_max_age_no_cruza_la_ventana():
    assert hs.max_age(T0) == hs.MAX_AGE_S
    assert hs.max_age(T0 + hs.VENTANA_S - 10) == 10


@pytest.mark.asyncio
async def test_dentro_de_la_ventana_se_firma_una_vez_y_sale_identica():
    cache = hs.CacheDeListas()
    llamadas: list[int] = []

    async def armar(expira_en: int) -> str:
        llamadas.append(expira_en)
        return f"lista firmada #{len(llamadas)}"

    a = await cache.obtener("u/derived/m/hls", "360p.m3u8", armar, ahora=T0 + 5)
    b = await cache.obtener("u/derived/m/hls", "360p.m3u8", armar, ahora=T0 + 1700)
    assert a == b == "lista firmada #1"
    assert len(llamadas) == 1
    # Otra ventana: firmas nuevas.
    c = await cache.obtener("u/derived/m/hls", "360p.m3u8", armar, ahora=T0 + hs.VENTANA_S)
    assert c == "lista firmada #2"
    # Otra lista del mismo video: su propia entrada.
    await cache.obtener("u/derived/m/hls", "720p.m3u8", armar, ahora=T0 + hs.VENTANA_S)
    assert len(llamadas) == 3


@pytest.mark.asyncio
async def test_diez_pedidos_a_la_vez_firman_una_sola_vez():
    cache = hs.CacheDeListas()
    llamadas = 0

    async def armar(expira_en: int) -> str:
        nonlocal llamadas
        llamadas += 1
        await asyncio.sleep(0.01)
        return "x"

    resultados = await asyncio.gather(
        *(cache.obtener("r", "master.m3u8", armar, ahora=T0) for _ in range(10))
    )
    assert resultados == ["x"] * 10
    assert llamadas == 1


@pytest.mark.asyncio
async def test_una_lista_que_no_existe_no_se_recuerda():
    cache = hs.CacheDeListas()
    respuestas = iter([None, "ya existe"])

    async def armar(expira_en: int):
        return next(respuestas)

    assert await cache.obtener("r", "a.m3u8", armar, ahora=T0) is None
    assert await cache.obtener("r", "a.m3u8", armar, ahora=T0) == "ya existe"


@pytest.mark.asyncio
async def test_la_cache_tiene_tope():
    cache = hs.CacheDeListas(maximo=2)

    async def armar(expira_en: int) -> str:
        return "x"

    for i in range(5):
        await cache.obtener(f"r{i}", "a.m3u8", armar, ahora=T0)
    assert len(cache._datos) == 2


@pytest.mark.asyncio
async def test_todos_los_segmentos_se_firman_con_el_vencimiento_de_la_ventana(monkeypatch):
    pedidos: list[dict] = []
    lista = "#EXTM3U\n#EXTINF:4.0,\n360p_000.ts\n#EXTINF:4.0,\n360p_001.ts\n#EXT-X-ENDLIST"

    def responder(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, text=lista)
        cuerpo = json.loads(request.content)
        pedidos.append(cuerpo)
        return httpx.Response(
            200,
            json=[
                {"path": p, "signedURL": f"/object/sign/post-media/{p}?token=T"}
                for p in cuerpo["paths"]
            ],
        )

    async def firmar(client, ruta, expires=600):
        return "https://supabase.test/lista"

    monkeypatch.setattr(content_router._mp, "_signed_url", firmar)
    monkeypatch.setattr(content_router._mp, "_headers", lambda: {})
    monkeypatch.setattr(
        content_router, "get_settings", lambda: SimpleNamespace(supabase_url="https://supabase.test")
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(responder)) as client:
        cuerpo = await content_router._armar_lista_supabase(client, "u/derived/m/hls", "360p.m3u8", 4321)
    assert pedidos == [
        {"paths": ["u/derived/m/hls/360p_000.ts", "u/derived/m/hls/360p_001.ts"], "expiresIn": 4321}
    ]
    assert "https://supabase.test/storage/v1/object/sign/post-media/u/derived/m/hls/360p_000.ts?token=T" in cuerpo
    assert "#EXT-X-ENDLIST" in cuerpo


@pytest.mark.asyncio
async def test_la_lista_que_falta_da_none(monkeypatch):
    async def firmar(client, ruta, expires=600):
        return "https://supabase.test/lista"

    monkeypatch.setattr(content_router._mp, "_signed_url", firmar)
    transporte = httpx.MockTransport(lambda r: httpx.Response(404))
    async with httpx.AsyncClient(transport=transporte) as client:
        assert await content_router._armar_lista_supabase(client, "r", "x.m3u8", 10) is None
