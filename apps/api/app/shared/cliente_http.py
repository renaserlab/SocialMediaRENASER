"""Un cliente HTTP por proceso para hablar con Storage, Expo y compañía.

EL PROBLEMA, medido en la auditoría del 27-28/10/2026. Cada firma de Storage,
cada subida y cada lote de push abría su propio `httpx.AsyncClient` y lo cerraba
al terminar. Construir uno no es gratis: carga los certificados raíz y monta el
contexto TLS (unos 18 ms de CPU de mediana), y ese trabajo es SÍNCRONO, así que
mientras se hace el bucle de eventos no atiende a nadie más. Además, al cerrarlo
se tiraba la conexión: la siguiente llamada al mismo Storage volvía a pagar
DNS, TCP y el saludo TLS.

LO QUE SE HACE. El arranque de la aplicación (`main.lifespan`) abre UN cliente
y lo cierra al apagar. Los caminos calientes piden su cliente con
`cliente_http(plazo)` y reciben ese, con las conexiones ya abiertas.

TRES CUIDADOS:

  * EL PLAZO SIGUE SIENDO EL DE CADA LLAMADA. Storage esperaba 15 s, Expo 10 s
    y la playlist HLS 30 s. El compartido no tiene un plazo «de todos»: se pasa
    el de quien llama en cada petición (`_ConPlazo`).
  * FUERA DEL ARRANQUE SE PORTA COMO ANTES. Una prueba, un guion o una tarea
    que no pasó por `lifespan` no tiene cliente compartido, y entonces se abre
    uno propio para esa llamada, exactamente como se hacía hasta ahora. Por eso
    las pruebas que sustituyen `httpx.AsyncClient` por uno de mentira siguen
    funcionando: en ellas nunca hay compartido y se construye con su clase.
  * SOLO DESDE EL BUCLE QUE LO CREÓ. Las conexiones de httpx pertenecen a un
    bucle de eventos; usarlas desde otro revienta de formas poco claras. Si
    algo llama desde un bucle distinto (un hilo con su `asyncio.run`), recibe
    uno propio y no se entera.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx

logger = logging.getLogger(__name__)

#: Cuántas conexiones guarda abiertas a la vez el cliente compartido. Los de
#: fábrica de httpx (100 en total, 20 en reposo, 5 s de reposo máximo) ya
#: sobran para una API que habla con dos o tres servicios; se escriben para que
#: sea una decisión. Los 5 s NO se alargan a propósito: lo caro era construir
#: el cliente, no reconectar, y una conexión que lleva mucho en reposo es la
#: que el otro lado cierra justo cuando se le manda algo.
LIMITES = httpx.Limits(max_connections=100, max_keepalive_connections=20, keepalive_expiry=5.0)

_compartido: httpx.AsyncClient | None = None
_bucle: asyncio.AbstractEventLoop | None = None


async def abrir() -> None:
    """Abre el cliente del proceso. Lo llama `main.lifespan` al arrancar."""
    global _compartido, _bucle
    if _compartido is not None and not _compartido.is_closed:
        return
    # Sin plazo propio: el de cada llamada lo pone `_ConPlazo`. Si alguien lo
    # usara a pelo, mejor que espere poco que para siempre.
    _compartido = httpx.AsyncClient(timeout=httpx.Timeout(15.0), limits=LIMITES)
    _bucle = asyncio.get_running_loop()


async def cerrar() -> None:
    """Cierra el cliente del proceso. Lo llama `main.lifespan` al apagar.

    Lo que siga en vuelo (una pasada de la cola de avisos) falla como cualquier
    otro error de red y lo reintenta su cola; lo que llegue después ya no ve
    compartido y abre uno propio.
    """
    global _compartido, _bucle
    cliente, _compartido, _bucle = _compartido, None, None
    if cliente is not None:
        await cliente.aclose()


def compartido() -> httpx.AsyncClient | None:
    """El cliente del proceso si se puede usar DESDE AQUÍ, o `None`."""
    cliente = _compartido
    if cliente is None or cliente.is_closed:
        return None
    try:
        bucle = asyncio.get_running_loop()
    except RuntimeError:
        return None
    return cliente if bucle is _bucle else None


class _ConPlazo:
    """El cliente compartido con el plazo de UNA llamada.

    Solo los métodos que usan los caminos calientes. `timeout` se pone si quien
    llama no lo puso: una llamada que pide su propio plazo lo conserva.
    """

    __slots__ = ("_cliente", "_plazo")

    def __init__(self, cliente: httpx.AsyncClient, plazo: httpx.Timeout | float) -> None:
        self._cliente = cliente
        self._plazo = plazo

    async def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        kwargs.setdefault("timeout", self._plazo)
        return await self._cliente.request(method, url, **kwargs)

    async def get(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("GET", url, **kwargs)

    async def post(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("POST", url, **kwargs)

    async def put(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("PUT", url, **kwargs)

    async def delete(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("DELETE", url, **kwargs)


@asynccontextmanager
async def cliente_http(plazo: httpx.Timeout | float) -> AsyncIterator[httpx.AsyncClient]:
    """El cliente para UNA operación, con el plazo que esa operación tenía.

    Con el compartido abierto, ese (sin cerrarlo al salir). Si no, uno propio
    que se cierra al salir: el comportamiento de siempre.
    """
    cliente = compartido()
    if cliente is not None:
        # Mismo contrato que `httpx.AsyncClient` en lo que usan los llamantes.
        yield _ConPlazo(cliente, plazo)  # type: ignore[misc]
        return
    # `httpx.AsyncClient` se busca AQUÍ y en el módulo `httpx`, no se guarda al
    # importar: las pruebas lo sustituyen con `monkeypatch` y tienen que verlo.
    async with httpx.AsyncClient(timeout=plazo) as propio:
        yield propio
