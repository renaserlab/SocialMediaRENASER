"""Qué puede hacer cada persona dentro de una sala, y quién lo decide.

LO DECIDE EL SERVIDOR, SIEMPRE. El cliente pide una credencial; no pide un rol.
Si el rol viniera en la petición, cualquier espectador se declararía anfitrión de
la emisión de otro y se pondría a publicar en su sala.

POR QUÉ ESTA TRADUCCIÓN VIVE EN SU PROPIO FICHERO. Los roles de Z son de
producto —propietario, moderador, invitado, espectador— y los del proveedor son
de infraestructura. Mantenerlos separados es lo que permite cambiar de proveedor
sin tocar los permisos: el día que haya otro, se añade su tabla aquí y nada más
del módulo cambia.

Los nombres del lado del proveedor tienen que existir EN LA PLANTILLA de 100ms.
Si allí se llaman de otra forma, se cambia aquí y en ningún otro sitio.
"""

from __future__ import annotations

from enum import StrEnum


class RolDeZ(StrEnum):
    """Qué es esta persona respecto a ESTA emisión."""

    #: Quien la creó. Publica y manda.
    PROPIETARIO = "propietario"
    #: Administración con permiso explícito, o un moderador designado.
    MODERADOR = "moderador"
    #: Alguien invitado a intervenir. Publica, pero no manda.
    INVITADO = "invitado"
    #: El público. Ve y escucha.
    ESPECTADOR = "espectador"


#: Nombre del rol EN LA PLANTILLA del proveedor.
EN_EL_PROVEEDOR: dict[RolDeZ, str] = {
    RolDeZ.PROPIETARIO: "host",
    RolDeZ.MODERADOR: "moderator",
    RolDeZ.INVITADO: "guest",
    RolDeZ.ESPECTADOR: "viewer",
}

#: Quién puede publicar cámara y micrófono.
#:
#: Es una lista cerrada y no una negación de `ESPECTADOR`: el día que aparezca
#: un rol nuevo, lo seguro es que NO publique hasta que alguien lo decida.
PUBLICAN: frozenset[RolDeZ] = frozenset({
    RolDeZ.PROPIETARIO,
    RolDeZ.MODERADOR,
    RolDeZ.INVITADO,
})

#: Quién puede moderar: esconder mensajes y cerrar la sala.
MODERAN: frozenset[RolDeZ] = frozenset({RolDeZ.PROPIETARIO, RolDeZ.MODERADOR})


def puede_publicar(rol: RolDeZ) -> bool:
    return rol in PUBLICAN


def puede_moderar(rol: RolDeZ) -> bool:
    return rol in MODERAN


def nombre_en_el_proveedor(rol: RolDeZ) -> str:
    """El rol traducido. Un rol desconocido cae a espectador, nunca al revés."""
    return EN_EL_PROVEEDOR.get(rol, EN_EL_PROVEEDOR[RolDeZ.ESPECTADOR])


def resolver(
    *,
    user_id: str,
    host_id: str,
    es_admin: bool = False,
    invitados: frozenset[str] | set[str] | None = None,
) -> RolDeZ:
    """El rol de esta persona en esta emisión.

    EL ORDEN IMPORTA. Ser el propietario manda sobre todo lo demás: si quien
    emite es además administración, sigue siendo el anfitrión de lo suyo y no un
    moderador de su propia sala.

    Administración NO entra como moderadora por el hecho de serlo en Z: hace
    falta que quien llama lo pida explícitamente pasando `es_admin`, que es lo
    que obliga a que el permiso se compruebe arriba y no se herede sin querer.
    """
    if user_id == host_id:
        return RolDeZ.PROPIETARIO
    if es_admin:
        return RolDeZ.MODERADOR
    if invitados and user_id in invitados:
        return RolDeZ.INVITADO
    return RolDeZ.ESPECTADOR
