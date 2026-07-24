"""Reglas del grafo social reutilizables por otros modulos.

Viven aparte del router para que content, profiles o cualquier otro modulo
puedan aplicar el bloqueo sin importar endpoints ni crear dependencias
circulares.
"""

from sqlalchemy import Select, select

from app.modules.social_graph.models import UserBlock


def blocked_either_way(viewer_id: str) -> Select:
    """Ids de perfiles que `viewer_id` no debe ver, ni que le vean a el.

    Devuelve una subconsulta pensada para usarse con `NOT IN`, de modo que quien
    la use la incruste en su propia consulta y el filtrado ocurra en la base de
    datos: filtrar despues, ya en memoria, descuadraria la paginacion.

    El corte es SIMETRICO a proposito:

    - a quien has bloqueado, para que deje de aparecerte;
    - y a quien te ha bloqueado, para que no puedas seguir leyendole.

    Si solo se cortara el primer sentido, bloquear no protegeria de nada: a la
    persona bloqueada le bastaria con no bloquear a su vez para seguir viendo
    todo lo que publica la otra.
    """
    return select(UserBlock.blocked_id).where(
        UserBlock.blocker_id == viewer_id
    ).union(select(UserBlock.blocker_id).where(UserBlock.blocked_id == viewer_id))


def is_blocked_column(viewer_id: str | None, profile_id_column):
    """Columna booleana: si `viewer_id` ha bloqueado al perfil de cada fila.

    Permite pintar «Bloquear» o «Desbloquear» sin una peticion aparte. La
    columna del perfil se recibe como parametro para no importar el modelo de
    otro modulo desde aqui.
    """
    if not viewer_id:
        return None
    return (
        select(UserBlock.blocked_id)
        .where(
            UserBlock.blocker_id == viewer_id,
            UserBlock.blocked_id == profile_id_column,
        )
        .exists()
    )
