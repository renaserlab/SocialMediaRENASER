"""Hablar con la API de 100ms. Nada más.

AQUÍ NO HAY NI UNA REGLA DE NEGOCIO. Este fichero sabe firmar tokens y hacer
peticiones HTTP; no sabe quién puede emitir, ni cuándo una emisión está viva, ni
qué pasa si falla. Eso vive en `proveedor_100ms.py` y en el router.

Separarlos es lo que permite cambiar de proveedor sin tocar los permisos, y lo
que hace que este fichero se pueda probar con un cliente HTTP falso sin montar
media aplicación.

LOS DOS TOKENS DE 100ms, que se confunden con facilidad y no son lo mismo:

  * **Management token**: lo usa el SERVIDOR para administrar salas. Da acceso a
    toda la cuenta. No sale de aquí jamás.
  * **Auth token**: lo usa el CLIENTE para entrar en UNA sala con UN rol. Es el
    único que se entrega, dura poco y va acotado a esa persona y esa sala.

Los dos se firman con el mismo secreto de la aplicación, y por eso ese secreto
solo puede vivir en el servidor: quien lo tenga puede firmarse un token de
anfitrión de la sala de cualquiera.
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass

import httpx
import jwt

logger = logging.getLogger("renaser.live")

#: Cuánto se espera a la API antes de darla por no disponible.
ESPERA_MAXIMA = 15.0

#: Cuánto dura el token de administración. Corto: se firma en cada llamada, así
#: que no hay motivo para que sobreviva a la petición que lo necesitó.
TTL_MANAGEMENT = 300


class ErrorDe100ms(RuntimeError):
    """Algo salió mal hablando con el proveedor.

    Lleva `codigo` para poder decidir si se reintenta, y `estado` con el código
    HTTP cuando lo hubo. El mensaje NUNCA sale al cliente tal cual: lo traduce
    el adaptador.
    """

    def __init__(self, mensaje: str, *, codigo: str, estado: int | None = None) -> None:
        super().__init__(mensaje)
        self.codigo = codigo
        self.estado = estado


@dataclass(frozen=True)
class Configuracion100ms:
    """Lo que hace falta para hablar con la cuenta. Sin valores por defecto."""

    access_key: str
    app_secret: str
    template_id: str
    api_base: str = "https://api.100ms.live/v2"
    region: str = ""

    def completa(self) -> bool:
        return bool(
            self.access_key.strip()
            and self.app_secret.strip()
            and self.template_id.strip()
        )


def token_de_administracion(config: Configuracion100ms) -> str:
    """El token con el que el servidor administra salas.

    DA ACCESO A TODA LA CUENTA, así que no se guarda, no se registra y no se
    devuelve: se firma justo antes de usarlo y caduca en minutos.
    """
    ahora = int(time.time())
    return jwt.encode(
        {
            "access_key": config.access_key,
            "type": "management",
            "version": 2,
            "jti": str(uuid.uuid4()),
            "iat": ahora,
            # Un minuto de margen hacia atrás: los relojes de dos máquinas no
            # coinciden al segundo, y un `nbf` en el futuro se rechaza entero.
            "nbf": ahora - 60,
            "exp": ahora + TTL_MANAGEMENT,
        },
        config.app_secret,
        algorithm="HS256",
    )


def token_de_sala(
    config: Configuracion100ms,
    *,
    room_id: str,
    user_id: str,
    rol: str,
    ttl_segundos: int,
) -> str:
    """El permiso para que UNA persona entre en UNA sala con UN rol.

    Es lo único que se le entrega al cliente. Va acotado a los tres, así que
    reenviarlo a otra persona no le sirve de nada distinto: entraría con la
    identidad de quien lo pidió, que es lo que queremos poder auditar.
    """
    ahora = int(time.time())
    return jwt.encode(
        {
            "access_key": config.access_key,
            "room_id": room_id,
            "user_id": user_id,
            "role": rol,
            "type": "app",
            "version": 2,
            "jti": str(uuid.uuid4()),
            "iat": ahora,
            "nbf": ahora - 60,
            "exp": ahora + max(ttl_segundos, 60),
        },
        config.app_secret,
        algorithm="HS256",
    )


class Cliente100ms:
    """Las cuatro llamadas HTTP que necesita el módulo."""

    def __init__(
        self,
        config: Configuracion100ms,
        *,
        cliente_http: httpx.AsyncClient | None = None,
    ) -> None:
        self._config = config
        #: Inyectable para probar sin salir a la red. En producción es `None` y
        #: se abre un cliente por llamada.
        self._http = cliente_http

    async def crear_sala(self, *, nombre: str, descripcion: str = "") -> dict:
        """Crea la sala. `nombre` tiene que ser único en la cuenta.

        Se usa el identificador de la emisión como nombre a propósito: si dos
        peticiones simultáneas intentan crear la misma, 100ms rechaza la segunda
        por nombre repetido y el adaptador recupera la que ya existe. Esa es la
        idempotencia, y la garantiza el proveedor, no una comprobación nuestra
        que dos procesos pasarían a la vez.
        """
        return await self._pedir(
            "POST",
            "/rooms",
            json={
                "name": nombre,
                "description": descripcion[:1000],
                "template_id": self._config.template_id,
            },
        )

    async def sala_por_nombre(self, *, nombre: str) -> dict | None:
        """La sala que ya existe con ese nombre, o `None`."""
        datos = await self._pedir("GET", "/rooms", params={"name": nombre})
        salas = datos.get("data")
        if isinstance(salas, list):
            for sala in salas:
                if isinstance(sala, dict) and sala.get("name") == nombre:
                    return sala
        return None

    async def sala(self, *, room_id: str) -> dict:
        return await self._pedir("GET", f"/rooms/{room_id}")

    async def deshabilitar_sala(self, *, room_id: str) -> dict:
        """Cierra la sala para que no entre nadie más.

        No borra nada: 100ms conserva la sala deshabilitada, que es lo que hace
        falta para poder conciliar después qué pasó.
        """
        return await self._pedir("POST", f"/rooms/{room_id}", json={"enabled": False})

    # ------------------------------------------------------------------ #

    async def _pedir(
        self, metodo: str, ruta: str, *, json: dict | None = None, params: dict | None = None
    ) -> dict:
        cabeceras = {
            "Authorization": f"Bearer {token_de_administracion(self._config)}",
            "Content-Type": "application/json",
        }
        url = f"{self._config.api_base.rstrip('/')}{ruta}"
        try:
            if self._http is not None:
                respuesta = await self._http.request(
                    metodo, url, json=json, params=params,
                    headers=cabeceras, timeout=ESPERA_MAXIMA,
                )
            else:  # pragma: no cover - salida real
                async with httpx.AsyncClient(timeout=ESPERA_MAXIMA) as cliente:
                    respuesta = await cliente.request(
                        metodo, url, json=json, params=params, headers=cabeceras
                    )
        except httpx.HTTPError as error:
            # AMBIGUO, no fallido. Un tiempo de espera agotado no dice si la
            # sala se creó: quien llama tiene que consultar antes de reintentar.
            logger.error("[live] 100ms no responde a %s %s: %s", metodo, ruta, error)
            raise ErrorDe100ms(
                "El proveedor de vídeo no responde.", codigo="network_timeout"
            ) from error

        if respuesta.status_code >= 400:
            # NO se registra el cuerpo: puede llevar el nombre de la plantilla y
            # datos de la cuenta.
            logger.error(
                "[live] 100ms rechazo %s %s con %s", metodo, ruta, respuesta.status_code
            )
            raise ErrorDe100ms(
                "El proveedor de vídeo rechazó la petición.",
                codigo=f"http_{respuesta.status_code}",
                estado=respuesta.status_code,
            )

        try:
            datos = respuesta.json()
        except Exception as error:  # el parser no promete un tipo concreto
            raise ErrorDe100ms(
                "El proveedor de vídeo contestó algo ilegible.",
                codigo="unreadable_response",
            ) from error
        if not isinstance(datos, dict):
            raise ErrorDe100ms(
                "El proveedor de vídeo contestó algo ilegible.",
                codigo="unreadable_response",
            )
        return datos
