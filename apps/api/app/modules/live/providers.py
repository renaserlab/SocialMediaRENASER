"""Abstracción del proveedor de directo.

**Primera fase: 100ms.** La arquitectura es neutral respecto al proveedor: el
resto del módulo no habla con ninguno en concreto, habla con esta interfaz. Amazon
IVS queda como alternativa futura y NO está implementada. Ver
`docs/Z_DIRECTOS_100MS.md`.

Es la MISMA forma que `payments/providers.py`, y a propósito. Las dos son la
misma situación —una pieza que cuesta dinero y que solo puede elegir el dueño
del producto— y resolverlas de dos maneras distintas obligaría a aprender dos
veces lo mismo.

LAS DOS OPERACIONES que necesita cualquier proveedor:

1. **Abrir la sala**: se le dice qué emisión es y devuelve dónde vive.
2. **Repartir credenciales**: un permiso para EMITIR (solo para quien emite) y
   otro para VER (para el público). Son dos permisos distintos, y confundirlos
   es dejar que cualquier espectador se ponga a emitir en la sala de otra
   persona.

POR QUÉ EL TOKEN SE EMITE EN EL SERVIDOR, siempre. La clave secreta del
proveedor no puede vivir en la aplicación: un `.apk` se abre con un editor de
texto. Y aunque no se pudiera, el permiso de emitir depende de QUIÉN pregunta,
y eso solo lo sabe con certeza quien verificó el token de sesión.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass(frozen=True)
class SalaCreada:
    """Lo que devuelve el proveedor al abrir una sala."""

    #: Identificador de la sala EN EL PROVEEDOR. Se guarda en
    #: `live_sessions.provider_room_id` para poder volver a hablar de ella.
    room_id: str


@dataclass(frozen=True)
class Credencial:
    """Permiso temporal para entrar en una sala."""

    #: El token que consume el SDK del proveedor.
    token: str
    #: A dónde conectarse. Cada proveedor tiene la suya y puede cambiar. Vacía
    #: en los que llevan la sala dentro del token, como 100ms.
    url: str
    #: Segundos que dura. Corta a propósito: un permiso eterno es una llave
    #: que se puede compartir por mensaje y seguir funcionando mañana.
    expira_en: int
    #: Si permite EMITIR o solo VER. Nunca se deduce en el cliente.
    puede_emitir: bool
    #: El rol RESUELTO POR EL SERVIDOR, con el nombre que tiene en el proveedor.
    #: Viaja al cliente para que la pantalla sepa qué controles pintar, no para
    #: que lo decida: lo que manda es lo que va firmado dentro del token.
    rol: str = ""
    #: Identificador público de la sala. Sirve para correlacionar registros; no
    #: es un secreto y no basta para entrar.
    room_id: str = ""


@dataclass(frozen=True)
class EstadoDeSala:
    """Lo que el proveedor dice de una sala. Para conciliar, no para confiar."""

    existe: bool
    activa: bool


@dataclass(frozen=True)
class EventoDeProveedor:
    """Un aviso del proveedor, ya traducido a vocabulario de Z."""

    #: Identificador del AVISO, no de la sala. Es la clave contra repeticiones.
    event_id: str
    #: El nombre tal cual lo manda el proveedor, para poder investigar después.
    tipo: str
    #: Qué significa para nosotros. Ver `EVENTOS` en el adaptador.
    significado: str
    room_id: str
    #: Nuestro identificador de emisión, que es como se vuelve del aviso a la
    #: fila. Puede llegar vacío: entonces el aviso no se puede atribuir.
    session_id: str
    external_session_id: str = ""
    ocurrido_en: str = ""


class ProveedorDeDirecto(ABC):
    """Contrato que debe cumplir cualquier proveedor de directo."""

    #: Identificador corto. Se guarda en `live_sessions.provider`.
    nombre: str

    @abstractmethod
    async def abrir_sala(self, *, session_id: str, titulo: str) -> SalaCreada:
        """Prepara la sala y devuelve su identificador en el proveedor."""

    @abstractmethod
    async def cerrar_sala(self, *, room_id: str) -> None:
        """Cierra la sala. DEBE poder llamarse dos veces sin fallar.

        Terminar una emisión no puede depender de que el proveedor responda
        bien: si cerrar fallara y eso impidiera marcar la emisión como
        terminada, la sala se quedaría «en directo» para siempre en la
        pantalla de todo el mundo.
        """

    @abstractmethod
    async def credencial(
        self, *, room_id: str, user_id: str, puede_emitir: bool, rol: str = ""
    ) -> Credencial:
        """Emite un permiso temporal para esa persona en esa sala.

        `rol` llega YA RESUELTO por el servidor. Un proveedor no decide
        permisos: los aplica.
        """

    async def estado_de_sala(self, *, room_id: str) -> EstadoDeSala:
        """Qué dice el proveedor de esta sala.

        NO es abstracto: un proveedor que no sepa contestarlo sigue siendo
        usable, solo que su estado no se puede conciliar. Por defecto se admite
        que existe y está activa, que es lo que hacía el módulo antes de que
        esto existiera.
        """
        return EstadoDeSala(existe=True, activa=True)

    def interpretar_evento(self, cuerpo: dict) -> EventoDeProveedor | None:
        """De un aviso del proveedor a algo que el dominio entiende.

        `None` para lo que no nos incumbe, que es la mayoría. Por defecto, nada:
        un proveedor sin webhooks no puede mover ninguna emisión.
        """
        return None


class ProveedorNoConfigurado(ProveedorDeDirecto):
    """Marcador de posición mientras no se elige proveedor.

    Existe para que el módulo entero se pueda desplegar, probar y revisar sin
    haber decidido nada. Falla de forma EXPLÍCITA en vez de simular una
    emisión, que es exactamente el error que llevó a borrar la pantalla de
    directo anterior: reproducía un vídeo de ejemplo con un chat guardado en
    memoria y lo enseñaba como si alguien estuviera emitiendo.

    Que esto lance no rompe nada de lo demás: la sala se crea, el chat
    funciona y las reacciones también. Lo único que no hay es imagen.
    """

    nombre = "none"

    async def abrir_sala(self, *, session_id: str, titulo: str) -> SalaCreada:
        raise NotImplementedError(
            "No hay proveedor de directo configurado. Implementa "
            "ProveedorDeDirecto para el elegido y regístralo en PROVEEDORES."
        )

    async def cerrar_sala(self, *, room_id: str) -> None:
        # Cerrar lo que nunca se abrió no es un error: no queda nada abierto.
        # Lanzar aquí impediría terminar una emisión que sí existe como sala.
        return None

    async def credencial(
        self, *, room_id: str, user_id: str, puede_emitir: bool, rol: str = ""
    ) -> Credencial:
        raise NotImplementedError(
            "No hay proveedor de directo configurado; no se pueden emitir "
            "credenciales de sala."
        )

    async def estado_de_sala(self, *, room_id: str) -> EstadoDeSala:
        # No hay sala que consultar. Se dice, en vez de fingir que la hay.
        return EstadoDeSala(existe=False, activa=False)


#: Proveedores disponibles, por nombre.
#:
#: El real se registra AL ARRANCAR y solo si la configuración está completa (ver
#: `registrar_desde_configuracion`). Que la bandera esté encendida no basta: con
#: la clave puesta y la plantilla sin poner, crear una sala falla a mitad de
#: camino y deja una emisión sin sala.
PROVEEDORES: dict[str, ProveedorDeDirecto] = {
    "none": ProveedorNoConfigurado(),
}


def registrar_desde_configuracion() -> str:
    """Deja registrado el proveedor real si se puede, y dice cuál quedó.

    Falla en cerrado y en silencio: sin configuración completa no se registra
    nada y el módulo sigue funcionando sin imagen, que es su estado de fábrica.
    """
    from app.core.config import get_settings

    ajustes = get_settings()
    PROVEEDORES.pop("100ms", None)
    if not ajustes.live_configurado:
        return "none"

    from app.modules.live.hms_client import Configuracion100ms
    from app.modules.live.proveedor_100ms import Proveedor100ms

    PROVEEDORES["100ms"] = Proveedor100ms(
        Configuracion100ms(
            access_key=ajustes.hms_app_access_key,
            app_secret=ajustes.hms_app_secret,
            template_id=ajustes.hms_template_id,
            api_base=ajustes.hms_api_base,
            region=ajustes.hms_region,
        ),
        ttl_credencial=ajustes.live_credential_ttl_seconds,
    )
    return "100ms"


def obtener_proveedor(nombre: str) -> ProveedorDeDirecto | None:
    return PROVEEDORES.get(nombre)


def proveedor_activo() -> ProveedorDeDirecto | None:
    """El proveedor real que se usará para abrir salas nuevas.

    Devuelve `None` mientras solo esté el marcador de posición. Existe porque
    buscarlo por su nombre no sirve: el nombre solo se sabe DESPUÉS de haber
    elegido uno, y quien abre una sala todavía no lo conoce.

    Si algún día hay más de uno registrado, se coge el primero: elegir entre
    varios sería una decisión de producto —cuál para qué— y hasta que exista
    esa decisión, inventarse un criterio de desempate aquí sería peor que no
    tener ninguno.
    """
    for proveedor in PROVEEDORES.values():
        if not isinstance(proveedor, ProveedorNoConfigurado):
            return proveedor
    return None


def hay_proveedor_real() -> bool:
    """Si existe algún proveedor que no sea el marcador de posición.

    Lo consulta el endpoint para responder «esto todavía no se puede hacer» en
    vez de dejar que reviente a mitad de camino.
    """
    return proveedor_activo() is not None
