"""Abstracción del proveedor de directo.

Todavía no hay proveedor elegido (LiveKit, Mux, Cloudflare Stream, Amazon IVS,
Agora...), así que el resto del módulo no habla con ninguno en concreto: habla
con esta interfaz. El día que se decida, se escribe una clase que la implemente
y se registra en `PROVEEDORES`; nada más del código de directos cambia.

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
    #: A dónde conectarse. Cada proveedor tiene la suya y puede cambiar.
    url: str
    #: Segundos que dura. Corta a propósito: un permiso eterno es una llave
    #: que se puede compartir por mensaje y seguir funcionando mañana.
    expira_en: int
    #: Si permite EMITIR o solo VER. Nunca se deduce en el cliente.
    puede_emitir: bool


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
        self, *, room_id: str, user_id: str, puede_emitir: bool
    ) -> Credencial:
        """Emite un permiso temporal para esa persona en esa sala."""


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
        self, *, room_id: str, user_id: str, puede_emitir: bool
    ) -> Credencial:
        raise NotImplementedError(
            "No hay proveedor de directo configurado; no se pueden emitir "
            "credenciales de sala."
        )


#: Proveedores disponibles, por nombre. Al implementar uno real se añade aquí.
PROVEEDORES: dict[str, ProveedorDeDirecto] = {
    "none": ProveedorNoConfigurado(),
}


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
