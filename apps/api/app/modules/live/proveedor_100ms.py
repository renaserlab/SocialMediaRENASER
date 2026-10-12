"""100ms como proveedor de directo.

ES EL ÚNICO SITIO DEL PROYECTO QUE SABE QUE EXISTE 100ms. Ni los routers, ni los
modelos, ni las pantallas: todos hablan con `ProveedorDeDirecto`. El día que se
cambie de proveedor se escribe otro fichero como este y no se toca nada más.

LO QUE ESTE ADAPTADOR GARANTIZA:

1. **Una sala por emisión, pase lo que pase.** El nombre de la sala en 100ms es
   el identificador de la emisión, así que dos peticiones simultáneas no pueden
   crear dos salas: la segunda choca por nombre repetido y recupera la primera.
2. **El rol lo decide el servidor.** Aquí llega ya resuelto; este fichero solo
   lo traduce al nombre que tiene en la plantilla.
3. **Nada crudo sale hacia el cliente.** Los errores del proveedor se traducen a
   códigos nuestros, y las respuestas se recortan a lo que hace falta.
"""

from __future__ import annotations

import logging

from app.modules.live.hms_client import (
    Cliente100ms,
    Configuracion100ms,
    ErrorDe100ms,
    token_de_sala,
)
from app.modules.live.providers import (
    Credencial,
    EstadoDeSala,
    EventoDeProveedor,
    GrabacionAvisada,
    ProveedorDeDirecto,
    SalaCreada,
)

logger = logging.getLogger("renaser.live")

#: Nombre corto. Se guarda en `live_sessions.provider`, que admite 24 caracteres.
NOMBRE = "100ms"

#: Qué eventos de 100ms nos incumben y qué significan para Z.
#:
#: Se traduce por CONTENIDO además de por nombre: el nombre dice de qué habla el
#: aviso, no lo que hay que hacer. Lo que no esté aquí se ignora sin fallar —el
#: proveedor manda muchos avisos y la mayoría no nos incumben— y eso es distinto
#: de fallar: ignorar no puede dejar una emisión a medias.
EVENTOS: dict[str, str] = {
    "session.open.success": "sesion_abierta",
    "session.close.success": "sesion_cerrada",
    "peer.join.success": "participante_entro",
    "peer.leave.success": "participante_salio",
    "session.failure": "fallo",
    "room.end.success": "sala_cerrada",
    # La grabacion ya esta preparada y se puede bajar. Dos nombres porque 100ms
    # avisa con uno u otro segun como grabe: `beam.recording.success` para la
    # grabacion compuesta (la que se enciende en el panel) y `recording.success`
    # para la del servidor de medios. Los campos que se leen son los mismos.
    "beam.recording.success": "grabacion_lista",
    "recording.success": "grabacion_lista",
}


def _entero(valor) -> int | None:
    """Un numero no negativo, o nada. Lo que llega en un aviso no se da por bueno."""
    if isinstance(valor, bool) or not isinstance(valor, (int, float)):
        return None
    return int(valor) if valor >= 0 else None


def _grabacion(datos: dict) -> GrabacionAvisada:
    return GrabacionAvisada(
        recording_id=str(datos.get("recording_id") or datos.get("beam_id") or ""),
        ruta=str(datos.get("recording_path") or ""),
        url=str(datos.get("recording_presigned_url") or ""),
        duracion_s=_entero(datos.get("duration")),
        tamano_bytes=_entero(datos.get("size")),
    )


class Proveedor100ms(ProveedorDeDirecto):
    """El adaptador real."""

    nombre = NOMBRE

    def __init__(
        self,
        config: Configuracion100ms,
        *,
        ttl_credencial: int = 3600,
        cliente: Cliente100ms | None = None,
    ) -> None:
        self._config = config
        self._ttl = ttl_credencial
        self._cliente = cliente or Cliente100ms(config)

    # ----------------------------------------------------------- salas -- #

    async def abrir_sala(self, *, session_id: str, titulo: str) -> SalaCreada:
        """La sala de esta emisión, creándola solo si no existía.

        IDEMPOTENTE POR CONSTRUCCIÓN. Se consulta primero por nombre y, si no
        está, se crea. Entre las dos cosas cabe otra petición, así que el choque
        por nombre repetido se recoge y se vuelve a consultar: gana la que
        llegó antes y las dos acaban con la misma sala.
        """
        existente = await self._sala_por_nombre(session_id)
        if existente is not None:
            return existente

        try:
            datos = await self._cliente.crear_sala(nombre=session_id, descripcion=titulo)
        except ErrorDe100ms as error:
            if error.estado in (400, 409):
                # Nombre repetido: alguien la creó entre nuestra consulta y
                # nuestra creación. La suya vale igual que la nuestra.
                recuperada = await self._sala_por_nombre(session_id)
                if recuperada is not None:
                    return recuperada
            raise

        identificador = str(datos.get("id") or "")
        if not identificador:
            raise ErrorDe100ms(
                "El proveedor creó la sala sin devolver identificador.",
                codigo="room_without_id",
            )
        return SalaCreada(room_id=identificador)

    async def _sala_por_nombre(self, nombre: str) -> SalaCreada | None:
        sala = await self._cliente.sala_por_nombre(nombre=nombre)
        if sala is None:
            return None
        identificador = str(sala.get("id") or "")
        return SalaCreada(room_id=identificador) if identificador else None

    async def cerrar_sala(self, *, room_id: str) -> None:
        """Deshabilita la sala. SE PUEDE LLAMAR DOS VECES sin fallar.

        Y no puede impedir terminar la emisión: si el proveedor no contesta, la
        emisión se marca terminada igual. Dejarla «en directo» para siempre en
        la pantalla de todo el mundo porque un tercero no respondió sería
        trasladar su problema a quien emitió.
        """
        if not room_id:
            return
        # PRIMERO SE ECHA A QUIEN SIGUE DENTRO. Deshabilitar solo cierra la
        # puerta a los que llegan: sin esto, terminar la emisión en Z dejaba al
        # público viendo —y la sala facturando— hasta que cada uno cerraba la
        # app. Un 404 aquí es «no había nadie», no un fallo.
        try:
            await self._cliente.terminar_sala_activa(
                room_id=room_id, motivo="La transmisión terminó."
            )
        except ErrorDe100ms as error:
            if error.estado != 404:
                logger.warning(
                    "[live] no se pudo vaciar la sala %s (%s); se deshabilita igual",
                    room_id,
                    error.codigo,
                )
        # Y DESPUÉS SE DESHABILITA, aunque `lock` ya lo haga: si la llamada de
        # arriba falló, esta es la que impide que entre alguien más.
        try:
            await self._cliente.deshabilitar_sala(room_id=room_id)
        except ErrorDe100ms as error:
            logger.warning(
                "[live] no se pudo cerrar la sala %s (%s); la emision se cierra igual",
                room_id,
                error.codigo,
            )

    async def estado_de_sala(self, *, room_id: str) -> EstadoDeSala:
        """Lo que el proveedor dice de esta sala, para poder conciliar."""
        try:
            datos = await self._cliente.sala(room_id=room_id)
        except ErrorDe100ms as error:
            if error.estado == 404:
                return EstadoDeSala(existe=False, activa=False)
            raise
        return EstadoDeSala(
            existe=True,
            activa=bool(datos.get("enabled", False)),
        )

    async def bajar_del_escenario(
        self, *, room_id: str, user_id: str, de_rol: str, a_rol: str
    ) -> int:
        """Pasa a `a_rol` las conexiones de esa persona que siguen en `de_rol`.

        Se le CAMBIA EL ROL en vez de echarla: sigue viendo la emisión, como
        cualquiera del público, y su cámara deja de salir. Echarla le dejaría
        la pantalla en un error del que no se sale solo.

        Sin sesión activa 100ms contesta 404: nadie dentro, nada que bajar.
        """
        try:
            pares = await self._cliente.participantes(room_id=room_id, user_id=user_id)
        except ErrorDe100ms as error:
            if error.estado == 404:
                return 0
            raise
        cambiadas = 0
        for par in pares:
            peer_id = par.get("id")
            if par.get("role") != de_rol or not isinstance(peer_id, str) or not peer_id:
                continue
            try:
                await self._cliente.cambiar_rol(room_id=room_id, peer_id=peer_id, rol=a_rol)
            except ErrorDe100ms as error:
                # Se fue entre que se listó y que se le cambió: ya no publica.
                if error.estado == 404:
                    continue
                raise
            cambiadas += 1
        return cambiadas

    # ---------------------------------------------------- credenciales -- #

    async def credencial(
        self, *, room_id: str, user_id: str, puede_emitir: bool, rol: str = ""
    ) -> Credencial:
        """El permiso para entrar. Firmado aquí, nunca en el cliente.

        `rol` llega YA RESUELTO por el servidor. Si viniera vacío se cae al rol
        más restrictivo que corresponda, nunca al más permisivo: equivocarse
        hacia «espectador» cuesta que alguien no pueda hablar; hacia
        «anfitrión», que cualquiera publique en la sala de otro.
        """
        from app.modules.live.roles import EN_EL_PROVEEDOR, RolDeZ

        if not rol:
            rol = EN_EL_PROVEEDOR[
                RolDeZ.PROPIETARIO if puede_emitir else RolDeZ.ESPECTADOR
            ]
        token = token_de_sala(
            self._config,
            room_id=room_id,
            user_id=user_id,
            rol=rol,
            ttl_segundos=self._ttl,
        )
        return Credencial(
            token=token,
            # 100ms no necesita URL: la sala va dentro del token. Se conserva el
            # campo porque el contrato es común a todos los proveedores y otros
            # sí la usan.
            url="",
            expira_en=self._ttl,
            puede_emitir=puede_emitir,
            rol=rol,
            room_id=room_id,
        )

    # --------------------------------------------------------- webhooks -- #

    def traducir_error(self, error) -> tuple[str, str]:
        """Del fallo de 100ms a un código nuestro. Ver `traducir_error` abajo."""
        return traducir_error(error)

    def interpretar_evento(self, cuerpo: dict) -> EventoDeProveedor | None:
        """De un aviso de 100ms a algo que el dominio entiende.

        Devuelve `None` para lo que no nos incumbe, que es la mayoría. Ignorar
        no es fallar: un aviso que no entendemos no puede mover una emisión.
        """
        tipo = str(cuerpo.get("type") or "")
        significado = EVENTOS.get(tipo)
        if significado is None:
            return None

        datos = cuerpo.get("data")
        datos = datos if isinstance(datos, dict) else {}
        return EventoDeProveedor(
            #: El identificador del AVISO. Es la clave contra repeticiones: si
            #: 100ms lo manda diez veces, se procesa una.
            event_id=str(cuerpo.get("id") or ""),
            tipo=tipo,
            significado=significado,
            room_id=str(datos.get("room_id") or ""),
            #: El NOMBRE de la sala es el identificador de la emisión, que es
            #: como se vuelve de un aviso del proveedor a una fila nuestra.
            session_id=str(datos.get("room_name") or ""),
            external_session_id=str(datos.get("session_id") or ""),
            ocurrido_en=str(cuerpo.get("timestamp") or ""),
            grabacion=_grabacion(datos) if significado == "grabacion_lista" else None,
        )


def traducir_error(error: ErrorDe100ms) -> tuple[str, str]:
    """Del fallo del proveedor a `(codigo_interno, mensaje_para_la_persona)`.

    NO SE FILTRA NADA DEL PROVEEDOR. Ni el cuerpo, ni el nombre de la plantilla,
    ni el identificador de la cuenta: quien está mirando la pantalla no puede
    hacer nada con eso, y quien esté probando la seguridad sí.
    """
    if error.codigo in ("network_timeout", "unreadable_response"):
        return "live_provider_unavailable", "El video no está disponible ahora mismo."
    if error.estado == 404:
        return "live_room_missing", "Esta transmisión ya no tiene sala."
    if error.estado in (401, 403):
        return "live_provider_not_configured", "El video no está configurado."
    if error.estado == 429:
        return "live_provider_busy", "Hay demasiadas peticiones. Inténtalo en un momento."
    return "live_provider_error", "No se pudo preparar el video."
