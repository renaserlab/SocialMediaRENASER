"""La columna que anade la 0043, escrita SIN el ORM compartido.

POR QUE `dedupe_key` NO ESTA EN `models.py` CON LAS DEMAS. Es la trampa mas
cara de este repositorio, escrita ya en `catalog/cursos_v2.py`:

    `select(Entidad)` pide TODAS las columnas mapeadas.

`list_notifications` hace `select(Notification, Profile)`. Mapear aqui
`dedupe_key` significaria que la bandeja entera pide una columna que en
produccion todavia no existe —la 0043 espera aprobacion, como debe ser— y el
dia del despliegue las notificaciones devolverian un 500 que ademas el
navegador reporta como error de CORS. Ya paso con la 0027 y con la 0033.

La tabla vive en su PROPIO `MetaData`, aparte del `Base` declarativo, por dos
razones: no colisiona con la que ya declara `models.py` para el mismo nombre, y
`Base.metadata.create_all` (los tests) NO la crea, asi que la base de una prueba
es por defecto produccion de HOY, sin la 0043. La prueba que quiera la 0043 la
aplica ella con los mismos `alter table` del script, y asi «funciona sin la
migracion» es algo que se comprueba y no algo que se promete.

POR QUE UNA COLUMNA NUEVA Y NO UN INDICE UNICO SOBRE LAS QUE YA HAY. Porque en
la base real ya hay duplicados guardados, y un indice unico sobre
`(user_id, type, actor_id, entity_id)` NO SE PUEDE CREAR mientras existan: para
crearlo habria que borrar filas primero, y una migracion no puede exigir borrar
informacion de nadie. En `dedupe_key` las filas viejas se quedan a NULL, y en
PostgreSQL —y en SQLite— dos NULL no son iguales para un indice unico: ni una
sola fila existente choca con otra, el indice se crea con la tabla llena, y solo
los avisos nuevos entran en el reparto.
"""

from __future__ import annotations

from uuid import uuid4

from sqlalchemy import JSON, Column, MetaData, Table, Text, Uuid, select
from sqlalchemy.ext.asyncio import AsyncSession

#: Deliberadamente APARTE de `Base.metadata`. Ver el docstring del modulo.
METADATOS = MetaData()

#: Las columnas que hacen falta para ESCRIBIR un aviso, y `dedupe_key`. Ni una
#: mas: `read_at` y `created_at` los pone la base con su valor por defecto, y
#: nombrarlos aqui solo daria ocasion de escribirlos mal.
AVISOS = Table(
    "notifications",
    METADATOS,
    Column("id", Uuid(as_uuid=False), primary_key=True),
    Column("user_id", Uuid(as_uuid=False), nullable=False),
    Column("actor_id", Uuid(as_uuid=False)),
    Column("type", Text, nullable=False),
    Column("entity_type", Text),
    Column("entity_id", Uuid(as_uuid=False)),
    Column("payload", JSON, nullable=False),
    Column("dedupe_key", Text),
)


def _insert_que_ignora_el_choque(dialecto: str):
    """El `INSERT … ON CONFLICT DO NOTHING` del dialecto que toque.

    PostgreSQL y SQLite lo escriben distinto y SQLAlchemy tiene un constructor
    para cada uno. Se elige por el nombre del dialecto y no con un `try`, porque
    en PostgreSQL una sentencia que falla deja la transaccion inservible: el
    aviso se llevaria por delante el «me gusta» que lo provoco.

    Cualquier otro dialecto devuelve `None` y se cae al respaldo: insertar
    despues de comprobar. Se encuentra menos y se sigue avisando.
    """
    if dialecto == "postgresql":
        from sqlalchemy.dialects.postgresql import insert

        return insert
    if dialecto == "sqlite":
        from sqlalchemy.dialects.sqlite import insert

        return insert
    return None


async def insertar(
    db: AsyncSession,
    *,
    user_id: str,
    actor_id: str | None,
    type: str,
    entity_type: str | None,
    entity_id: str | None,
    payload: dict,
    clave: str,
) -> bool:
    """Escribe el aviso solo si su clave no estaba. Devuelve si lo escribio.

    NO HACE COMMIT: la fila entra en la MISMA transaccion que la accion que la
    provoco, igual que antes, para que no pueda quedar un aviso de algo que no
    llego a guardarse.

    El `DO NOTHING` es lo que convierte la idempotencia en una propiedad de la
    base: dos peticiones simultaneas de «seguir» ejecutan las dos su INSERT, y
    la segunda no escribe nada porque el indice unico se lo impide. Un `if`
    previo, por cuidadoso que sea, deja la ventana abierta entre la comprobacion
    y la escritura.
    """
    conexion = await db.connection()
    constructor = _insert_que_ignora_el_choque(conexion.dialect.name)
    if constructor is None:
        return await _insertar_comprobando(
            db,
            user_id=user_id,
            actor_id=actor_id,
            type=type,
            entity_type=entity_type,
            entity_id=entity_id,
            payload=payload,
            clave=clave,
        )

    sentencia = (
        constructor(AVISOS)
        .values(
            id=str(uuid4()),
            user_id=user_id,
            actor_id=actor_id,
            type=type,
            entity_type=entity_type,
            entity_id=entity_id,
            payload=payload,
            dedupe_key=clave,
        )
        .on_conflict_do_nothing(index_elements=["dedupe_key"])
    )
    resultado = await db.execute(sentencia)
    # `rowcount` es 0 cuando el choque lo descarto y 1 cuando entro. Es el dato
    # que necesita quien llama para decidir si ademas manda el push: un aviso
    # que no se ha creado no puede hacer sonar un telefono.
    return (resultado.rowcount or 0) > 0


async def _insertar_comprobando(db: AsyncSession, *, clave: str, **fila) -> bool:
    """Respaldo para un dialecto sin `ON CONFLICT`. Comprueba y escribe."""
    ya = await db.scalar(select(AVISOS.c.id).where(AVISOS.c.dedupe_key == clave))
    if ya is not None:
        return False
    await db.execute(AVISOS.insert().values(id=str(uuid4()), dedupe_key=clave, **fila))
    return True
