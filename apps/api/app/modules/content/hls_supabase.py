"""Listas HLS de Supabase con firmas ESTABLES por ventana de tiempo.

EL PROBLEMA (medido el 24/11/2026 con los HLS de Supabase). Cada pedido de una
lista volvia a firmar todos sus segmentos. Supabase mete en cada firma la hora
de emision (`iat` del token), asi que la URL de un segmento salia distinta en
cada pedido. Y la URL entera —firma incluida— es la clave de cache del CDN de
Supabase: el primer segmento daba SIEMPRE `cf-cache-status: MISS` (1,1 s hasta
el primer byte, frente a 0,13 s con acierto). Ademas cada lista costaba un
viaje a Storage (0,45-0,8 s) antes de responder.

LA SOLUCION. Lo mismo que ya hace S3 (`medios/firma.vencimiento_de_ventana`):
la URL tiene que ser identica dentro de una ventana fija. Como la firma de
Supabase no se puede fijar desde fuera (la hora de emision la pone Storage),
lo que se fija es la LISTA ya firmada: la primera peticion de la ventana la
arma y las siguientes de la misma ventana reciben exactamente el mismo texto.
Con eso:

  * el CDN de Supabase falla una vez por segmento y ventana, no en cada
    reproduccion;
  * la lista sale de memoria, sin el viaje a Storage;
  * CloudFront puede guardar la lista (cache de `/media/*/hls/*`, pila 02)
    porque su contenido ya no cambia en cada pedido.

VIGENCIA. Ventana de 30 min; la firma vence al final de la ventana + 1 h. Asi
cualquier URL entregada vale entre 1 h y 1 h 30 min (antes, 1 h justa), y lo
que guarde CloudFront (como mucho `MAX_AGE_S`) nunca entrega una firma vencida.

POR PROCESO. Con dos maquinas detras del balanceador habria dos juegos de URLs
por ventana: dos fallos de CDN en vez de uno. No compensa una cache compartida.
"""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from typing import Awaitable, Callable

#: Ventana de firma (segundos). La lista firmada es la misma toda la ventana.
VENTANA_S = 1800
#: Vida de la firma despues del final de la ventana.
VIDA_TRAS_VENTANA_S = 3600
#: Tope de `max-age` de la lista (lo que puede guardarla CloudFront o el
#: reproductor).
MAX_AGE_S = 300
#: Listas guardadas a la vez. Cada una pesa unos KB; con 3 videos HLS en
#: produccion sobra de largo, y el tope impide que crezca sin limite.
MAXIMO_LISTAS = 512


def inicio_de_ventana(ahora: float) -> int:
    return int(ahora // VENTANA_S) * VENTANA_S


def segundos_de_firma(ahora: float) -> int:
    """`expiresIn` para Supabase: que la firma venza al final de la ventana
    + `VIDA_TRAS_VENTANA_S`, no a una hora contada desde ahora."""
    vence = inicio_de_ventana(ahora) + VENTANA_S + VIDA_TRAS_VENTANA_S
    return max(1, int(vence - ahora))


def max_age(ahora: float) -> int:
    """Cuanto puede guardarse la lista: hasta el final de su ventana, con tope.

    Que no cruce la ventana hace que todos (CloudFront y la API) cambien de
    juego de firmas a la vez; y aun cruzandola, la firma vale una hora mas.
    """
    resto = inicio_de_ventana(ahora) + VENTANA_S - ahora
    return max(1, min(MAX_AGE_S, int(resto)))


class CacheDeListas:
    """Lista firmada por (ruta HLS, lista), valida solo dentro de su ventana."""

    def __init__(self, maximo: int = MAXIMO_LISTAS) -> None:
        self._maximo = maximo
        self._datos: OrderedDict[tuple[str, str], tuple[int, str]] = OrderedDict()
        self._candados: dict[tuple[str, str], asyncio.Lock] = {}

    def olvidar(self) -> None:
        self._datos.clear()
        self._candados.clear()

    def _leer(self, clave: tuple[str, str], ventana: int) -> str | None:
        guardado = self._datos.get(clave)
        if guardado is None or guardado[0] != ventana:
            return None
        self._datos.move_to_end(clave)
        return guardado[1]

    async def obtener(
        self,
        stream_path: str,
        lista: str,
        armar: Callable[[int], Awaitable[str | None]],
        ahora: float | None = None,
    ) -> str | None:
        """La lista de esta ventana; si no esta, `armar(expires_in)` la crea.

        Con candado por lista: si diez reproductores piden la misma lista justo
        al empezar la ventana, se firma UNA vez y los diez reciben las mismas
        URLs (si no, cada uno se llevaria un juego distinto y el CDN fallaria
        diez veces).
        """
        ahora = time.time() if ahora is None else ahora
        ventana = inicio_de_ventana(ahora)
        clave = (stream_path, lista)
        hecho = self._leer(clave, ventana)
        if hecho is not None:
            return hecho
        candado = self._candados.setdefault(clave, asyncio.Lock())
        async with candado:
            hecho = self._leer(clave, ventana)
            if hecho is not None:
                return hecho
            cuerpo = await armar(segundos_de_firma(ahora))
            if cuerpo is None:
                return None
            self._datos[clave] = (ventana, cuerpo)
            self._datos.move_to_end(clave)
            while len(self._datos) > self._maximo:
                viejo, _ = self._datos.popitem(last=False)
                self._candados.pop(viejo, None)
            return cuerpo


#: La del proceso.
LISTAS = CacheDeListas()
