"""Lo que un grupo tiene ademas de sus mensajes: foto, enlace y solicitudes.

Aqui solo hay LECTURAS Y UTILIDADES sobre `group_settings` y
`group_join_requests` (migracion 0104). Las rutas estan en
`entrada_a_grupos.py`; este fichero existe aparte para que `grupos.py` y
`lectura.py` puedan leer la foto de un grupo sin depender de esas rutas.

SIN LA 0104 TODO ESTO DEVUELVE «NADA» SIN TOCAR LA BASE: un grupo sin foto,
sin enlace y sin solicitudes, que es exactamente lo que habia antes.

COMUNIDADES EN EL PERFIL (30/10/2026, migracion 0112,
`docs/CONTRATOS_COMUNIDADES_EN_EL_PERFIL.md`). Dos cosas nuevas:

  · `entrada`: `open` (se entra de un toque) o `request` (se pide, como
    siempre). Sin fila de ajustes, `request`.
  · «En mi perfil» deja de ser un dato del grupo y pasa a ser de CADA
    persona (`GroupProfileListing`). `listed_on_profile` conserva su nombre
    en las respuestas, pero ahora dice si sale en el perfil de QUIEN
    PREGUNTA. La columna del mismo nombre se sigue escribiendo a la vez, para
    que volver a la API anterior no pierda ningun perfil.

SIN LA 0112, LO DE ANTES. La API puede llegar antes que la migracion: todo lo
de aqui pregunta antes `esquema.hay_comunidades_en_el_perfil` (una vez por
proceso, no por peticion) y, si falta, cada comunidad es `request` y «en mi
perfil» es la columna `listed_on_profile`, que es exactamente lo que se leia.
"""

from __future__ import annotations

import secrets
from typing import Literal

from pydantic import BaseModel
from sqlalchemy import Text, delete, func, literal_column, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.messaging import esquema
from app.modules.messaging.models import (
    ENTRADA,
    ConversationMember,
    GroupJoinRequest,
    GroupProfileListing,
    GroupSettings,
)


class AjustesLeidos(BaseModel):
    """Como esta configurada la entrada a un grupo. Solo lo ve quien lo administra."""

    #: Sale en el perfil de QUIEN PREGUNTA (0112). Antes decia «en el perfil
    #: de quien lo administra»; con una sola persona administrando, que es lo
    #: que hay hoy, es lo mismo.
    listed_on_profile: bool = False
    #: El enlace del grupo esta activo.
    invite_enabled: bool = False
    #: El codigo del enlace. `None` hasta que se activa por primera vez.
    invite_code: str | None = None
    #: Como se entra (0112): `open`, de un toque; `request`, pidiendolo.
    #: `None` si este servidor todavia no puede guardarlo (falta la 0112): asi
    #: la aplicacion no ofrece elegirlo para responder despues con un 503.
    entrada: Literal["open", "request"] | None = "request"


def codigo_nuevo() -> str:
    """Un codigo de enlace que no se adivina: 24 caracteres seguros para una URL.

    Sale de `secrets`, no de `random`: quien conoce un enlace no puede deducir
    el de otro grupo. Solo lleva letras, cifras, `-` y `_`, que es lo que
    admite la restriccion de la tabla.
    """
    return secrets.token_urlsafe(18)


async def fila_de(db: AsyncSession, conversation_id: str) -> GroupSettings | None:
    if not await esquema.hay_puertas_de_grupo(db):
        return None
    return (
        await db.execute(
            select(GroupSettings).where(GroupSettings.conversation_id == conversation_id)
        )
    ).scalar_one_or_none()


async def asegurar_fila(db: AsyncSession, conversation_id: str) -> GroupSettings:
    """La fila de ajustes del grupo, creandola si es la primera vez.

    Dos peticiones a la vez pueden intentar crearla: la que pierde se encuentra
    con la clave primaria ocupada y lee la de la ganadora.
    """
    fila = await fila_de(db, conversation_id)
    if fila is not None:
        return fila
    fila = GroupSettings(conversation_id=conversation_id)
    db.add(fila)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        fila = await fila_de(db, conversation_id)
        assert fila is not None  # el conflicto prueba que existe
    return fila


def entrada_leida(valor: str | None) -> Literal["open", "request"]:
    """`open` solo si la base lo dice. Sin fila, sin la 0112 o con cualquier otra
    cosa, `request`.

    Lo seguro es lo de siempre: una comunidad de la que no se sabe nada se
    trata como «con solicitud», nunca como abierta.
    """
    return "open" if valor == "open" else "request"


def columna_de_entrada(con_la_0112: bool):
    """Lo que se pone en un `select` para leer como se entra, como `entrada`.

    Sin la 0112, la constante `'request'` en el propio SQL (no un parametro:
    asyncpg no sabria de que tipo es un parametro suelto en la lista de
    columnas). Asi cada consulta tiene la misma forma con la columna o sin
    ella, y nadie nombra una columna que no existe.
    """
    if con_la_0112:
        return ENTRADA.label("entrada")
    return literal_column("'request'", Text).label("entrada")


def leer(
    fila: GroupSettings | None,
    *,
    en_mi_perfil: bool,
    entrada: Literal["open", "request"] | None,
) -> AjustesLeidos:
    """Los ajustes tal como los ve quien los pide.

    `en_mi_perfil` y `entrada` son OBLIGATORIOS y sin valor por defecto: desde
    la 0112 no salen de `fila` (el primero depende de quien pregunta y la
    segunda no esta en el modelo), y un valor puesto por olvido diria a quien
    administra algo que no es. `entrada` llega ya leida: `None` solo si falta
    la 0112.
    """
    if fila is None:
        return AjustesLeidos(listed_on_profile=en_mi_perfil, entrada=entrada)
    return AjustesLeidos(
        listed_on_profile=en_mi_perfil,
        invite_enabled=bool(fila.invite_enabled),
        invite_code=fila.invite_code,
        entrada=entrada,
    )


async def leer_para(
    db: AsyncSession, fila: GroupSettings | None, conversation_id: str, uid: str
) -> AjustesLeidos:
    """Los ajustes de una comunidad como los ve `uid`. UNA consulta como mucho.

    Con la 0112, como se entra y si sale en SU perfil se leen juntos, en una
    sola sentencia. Sin ella, ninguna: la columna de siempre, que es lo que
    respondia esta API antes de la 0112, y `entrada = None`, que le dice a la
    aplicacion que aqui todavia no se puede elegir.

    «En mi perfil» es lo que ENSEÑA el perfil (`en_el_perfil_de_quien_la_creo`):
    la fila Y la columna. Si no coinciden, el interruptor sale apagado, y
    encenderlo escribe las dos.
    """
    columna = bool(fila is not None and fila.listed_on_profile)
    if not await esquema.hay_comunidades_en_el_perfil(db):
        return leer(fila, en_mi_perfil=columna, entrada=None)
    entrada = (
        select(ENTRADA)
        .where(GroupSettings.conversation_id == conversation_id)
        .scalar_subquery()
    )
    suya = (
        select(GroupProfileListing.user_id)
        .where(
            GroupProfileListing.conversation_id == conversation_id,
            GroupProfileListing.user_id == uid,
        )
        .exists()
    )
    leido = (await db.execute(select(entrada.label("entrada"), suya.label("suya")))).one()
    return leer(
        fila, en_mi_perfil=columna and bool(leido.suya), entrada=entrada_leida(leido.entrada)
    )


async def en_el_perfil_de_quien_la_creo(
    db: AsyncSession, conversation_id: str, *, columna: bool, creador: str
) -> bool:
    """Si la comunidad sale en el perfil de quien la creo (`columna` es su
    `listed_on_profile`).

    CON LA 0112, LAS DOS: su fila de `group_profile_listings` Y la columna. La
    API de esta ronda escribe siempre las dos, pero no es la unica que escribe:
    la API anterior (mientras se despliega la nueva, o si se vuelve a ella) y
    una que todavia no ha visto la 0112 escriben solo la columna. Si quien
    administra la QUITA de su perfil con una de esas, la fila del relleno se
    queda: con el AND no sale, que es lo que decidio. Si la PONE, falta la
    fila: no sale hasta que la vuelva a poner (el interruptor sale apagado).
    Lo que no puede pasar es que vuelva a salir una que se quito.

    Sin la 0112, la columna, como siempre.

    ESTE AND ES DE AHORA, que solo puede enseñarla quien la creo. Cuando haya
    co-administracion, la columna (una por comunidad) no puede hablar por cada
    persona: se quita y decide solo la fila de cada uno.
    """
    if not columna:
        return False
    if not await esquema.hay_comunidades_en_el_perfil(db):
        return True
    return await esta_en_el_perfil(db, conversation_id, creador)


async def poner_entrada(
    db: AsyncSession, conversation_id: str, entrada: Literal["open", "request"]
) -> None:
    """Cambia como se entra. SIN COMMIT. Quien llama ha comprobado que la 0112
    esta y que la fila de ajustes existe (`asegurar_fila`)."""
    await db.execute(
        update(GroupSettings.__table__)
        .where(GroupSettings.__table__.c.conversation_id == conversation_id)
        .values(entrada=entrada)
    )


async def esta_en_el_perfil(db: AsyncSession, conversation_id: str, user_id: str) -> bool:
    """Si esta persona enseña esta comunidad en su perfil, segun la 0112.

    Sin la 0112 (o sin la 0104), `False`: quien pregunta mira antes la columna
    `listed_on_profile`, que es lo unico que habia.

    Una consulta y no `db.get`: `get` contesta desde el mapa de identidad de la
    sesion sin preguntar a la base, y `poner_en_mi_perfil` borra con una
    sentencia que no lo actualiza. Leido despues en la misma peticion, diria
    que sigue en el perfil.
    """
    if not await esquema.hay_puertas_de_grupo(db):
        return False
    if not await esquema.hay_comunidades_en_el_perfil(db):
        return False
    return (
        await db.scalar(
            select(GroupProfileListing.user_id).where(
                GroupProfileListing.conversation_id == conversation_id,
                GroupProfileListing.user_id == user_id,
            )
        )
    ) is not None


def _insert_con_conflicto(db: AsyncSession):
    """El `insert` del dialecto, que es el que sabe `on conflict`.

    Igual que `temas._insert_con_conflicto`, y por lo mismo: que dos toques a
    la vez en «Mostrar en mi perfil» dejen una fila y no un 500 lo da la clave
    primaria, no una comprobacion previa que deja una ventana entre medias.
    """
    nombre = db.get_bind().dialect.name
    if nombre == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as insert_pg

        return insert_pg
    if nombre == "sqlite":
        from sqlalchemy.dialects.sqlite import insert as insert_sqlite

        return insert_sqlite
    raise RuntimeError(
        f"Dialecto '{nombre}' sin soporte de `on conflict`: «en mi perfil» "
        "depende de el."
    )


async def poner_en_mi_perfil(
    db: AsyncSession, conversation_id: str, user_id: str, *, si: bool
) -> None:
    """Enseña o deja de enseñar la comunidad en el perfil de ESA persona. SIN COMMIT.

    Solo su fila: quitarla de un perfil no la quita del de nadie mas. Quien
    llama comprueba antes que la administra y que es de primer nivel, y escribe
    ademas la columna `listed_on_profile`. Sin la 0112 no hay fila que escribir
    y esa columna es todo el ajuste, como antes: no hace nada.
    """
    if not await esquema.hay_comunidades_en_el_perfil(db):
        return
    if si:
        inserta = _insert_con_conflicto(db)
        await db.execute(
            inserta(GroupProfileListing.__table__)
            .values(conversation_id=conversation_id, user_id=user_id)
            .on_conflict_do_nothing(index_elements=["conversation_id", "user_id"])
        )
    else:
        await db.execute(
            delete(GroupProfileListing)
            .where(
                GroupProfileListing.conversation_id == conversation_id,
                GroupProfileListing.user_id == user_id,
            )
            .execution_options(synchronize_session=False)
        )


async def avatares_de(db: AsyncSession, conversation_ids: list[str]) -> dict[str, str]:
    """La foto de VARIOS grupos, en UNA consulta. `{}` sin grupos o sin la 0104.

    Con la lista vacia no se consulta: es lo normal en una bandeja donde todos
    los chats son de dos personas, y no tiene por que costar un viaje a la base.
    """
    if not conversation_ids or not await esquema.hay_puertas_de_grupo(db):
        return {}
    filas = await db.execute(
        select(GroupSettings.conversation_id, GroupSettings.avatar_path).where(
            GroupSettings.conversation_id.in_(conversation_ids),
            GroupSettings.avatar_path.is_not(None),
        )
    )
    return {conversacion: ruta for conversacion, ruta in filas}


async def pendientes_de(db: AsyncSession, conversation_id: str) -> int:
    """Cuantas solicitudes esperan respuesta. No cuenta a quien ya esta dentro.

    Alguien pudo pedir entrar y, antes de que se respondiera, ser añadido a
    mano. Su solicitud sigue «pendiente» en la tabla, pero ya no hay nada que
    decidir: no puede contar como trabajo por hacer.
    """
    if not await esquema.hay_puertas_de_grupo(db):
        return 0
    ya_dentro = (
        select(ConversationMember.user_id)
        .where(
            ConversationMember.conversation_id == conversation_id,
            ConversationMember.user_id == GroupJoinRequest.user_id,
        )
        .correlate(GroupJoinRequest)
        .exists()
    )
    return int(
        await db.scalar(
            select(func.count())
            .select_from(GroupJoinRequest)
            .where(
                GroupJoinRequest.conversation_id == conversation_id,
                GroupJoinRequest.status == "pending",
                ~ya_dentro,
            )
        )
        or 0
    )
