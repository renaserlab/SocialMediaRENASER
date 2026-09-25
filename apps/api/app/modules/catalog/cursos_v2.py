"""Las columnas que anade la 0034, leidas y escritas SIN el ORM compartido.

POR QUE NO ESTAN EN `models.py` CON LAS DEMAS, y es la trampa mas cara de este
repositorio:

    `select(Course)` pide TODAS las columnas mapeadas, y `db.add(Course(...))`
    escribe TODAS las columnas mapeadas.

Mapear aqui `review_status` significaria que CADA listado de cursos, cada
`db.get(Course, id)` y cada recomendacion pediria una columna que en produccion
todavia no existe. La 0034 espera aprobacion humana, asi que el dia del
despliegue el catalogo entero devolveria un 500 —y el navegador lo llamaria
error de CORS, porque Starlette no pone cabeceras en una excepcion sin
capturar—. Ya paso con la 0027 y con la 0033.

La solucion es nombrar las columnas. Estas tablas viven en su PROPIO `MetaData`,
separado del `Base` declarativo, por dos razones:

  1. No colisionan con las que ya declara `models.py` para la misma tabla.
  2. `Base.metadata.create_all` (los tests) NO las crea, asi que la base de una
     prueba es, por defecto, produccion de HOY: sin la 0034. Una prueba que
     quiera la 0034 la aplica ella, con los mismos `alter table` del script.
     Eso convierte «funciona sin la migracion» en algo que se comprueba en vez
     de algo que se promete.

Todo lo que hay aqui esta guardado por `esquema.hay_cursos_v2`. Sin la 0034,
leer devuelve la ficha vacia y escribir no hace nada: el curso se crea, se
edita y se publica exactamente igual que antes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    MetaData,
    Table,
    Text,
    Uuid,
    exists,
    select,
    update,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.catalog import esquema

#: `text[]` en PostgreSQL, JSON en SQLite (la base de los tests).
_LISTA_DE_TEXTO = ARRAY(Text).with_variant(JSON, "sqlite")

#: Deliberadamente APARTE de `Base.metadata`. Ver el docstring del modulo.
METADATOS = MetaData()

#: Solo la clave y lo que anade la 0034. Nada mas: cualquier columna de mas
#: aqui volveria a ser una columna de mas en cada consulta.
CURSOS = Table(
    "courses",
    METADATOS,
    Column("id", Uuid(as_uuid=False), primary_key=True),
    Column("subtitle", Text),
    Column("promo_video_path", Text),
    Column("primary_topic_id", Uuid(as_uuid=False)),
    Column("language", Text),
    Column("level", Text),
    Column("target_audience", _LISTA_DE_TEXTO),
    Column("prerequisites", _LISTA_DE_TEXTO),
    Column("review_status", Text),
    Column("submitted_at", DateTime(timezone=True)),
    Column("reviewed_at", DateTime(timezone=True)),
    Column("reviewed_by", Uuid(as_uuid=False)),
    Column("rejection_reason", Text),
)

MODULOS = Table(
    "course_modules",
    METADATOS,
    Column("id", Uuid(as_uuid=False), primary_key=True),
    Column("course_id", Uuid(as_uuid=False)),
    Column("description", Text),
)

LECCIONES = Table(
    "course_lessons",
    METADATOS,
    Column("id", Uuid(as_uuid=False), primary_key=True),
    Column("module_id", Uuid(as_uuid=False)),
    Column("kind", Text),
    Column("is_preview", Boolean),
)

#: Los unicos estados de revision. `status` (visibilidad) es OTRO eje.
BORRADOR = "draft"
EN_REVISION = "pending_review"
APROBADO = "approved"
RECHAZADO = "rejected"
ESTADOS_DE_REVISION = (BORRADOR, EN_REVISION, APROBADO, RECHAZADO)

#: Lo que la interfaz sabe pintar. La columna admite crecer; el CHECK de la
#: 0034 y esta tupla tienen que decir lo mismo, y las dos se cambian el dia que
#: exista una pantalla para el tipo nuevo. Un tipo que nadie sabe abrir es una
#: leccion rota, no una funcion adelantada.
TIPOS_DE_LECCION = ("video", "text")

NIVELES = ("beginner", "intermediate", "advanced")

#: Los campos de la ficha que el cliente puede escribir. `review_status` y sus
#: acompanantes NO estan: los mueve el flujo de revision, nunca un PATCH.
CAMPOS_EDITABLES = (
    "subtitle",
    "promo_video_path",
    "primary_topic_id",
    "language",
    "level",
    "target_audience",
    "prerequisites",
)

#: Lo que la 0034 anade a un modulo y a una leccion y que el cliente puede
#: escribir. Van aparte de `CAMPOS_EDITABLES` porque son de OTRA tabla: mezclar
#: las tres listas haria que un `description` de modulo acabara en un `update`
#: sobre `courses`.
CAMPOS_EDITABLES_DE_MODULO = ("description",)
CAMPOS_EDITABLES_DE_LECCION = ("kind", "is_preview")


@dataclass
class FichaDeCurso:
    """Lo que la 0034 anade a un curso. Vacia cuando la migracion no esta."""

    subtitle: str | None = None
    promo_video_path: str | None = None
    primary_topic_id: str | None = None
    language: str = "es"
    level: str | None = None
    target_audience: list[str] = field(default_factory=list)
    prerequisites: list[str] = field(default_factory=list)
    review_status: str = BORRADOR
    submitted_at: datetime | None = None
    reviewed_at: datetime | None = None
    reviewed_by: str | None = None
    rejection_reason: str | None = None


#: La ficha de un curso en una base sin la 0034. Se devuelve tal cual, sin
#: tocar la base: no hay nada que preguntar.
FICHA_VACIA = FichaDeCurso()


def _lista(valor) -> list[str]:  # noqa: ANN001
    """`text[]` en PostgreSQL, JSON en SQLite, `None` en una fila antigua."""
    if not valor:
        return []
    return [str(x) for x in valor]


async def leer(db: AsyncSession, course_ids: list[str]) -> dict[str, FichaDeCurso]:
    """Las fichas de VARIOS cursos, de UNA consulta.

    Lo consume el catalogo (un listado entero) y el detalle. Una consulta por
    curso convertiria el catalogo en veinte viajes para pintar unas etiquetas,
    que es el mismo error que ya se corrigio con los temas.
    """
    if not course_ids or not await esquema.hay_cursos_v2(db):
        return {}
    filas = (
        await db.execute(select(CURSOS).where(CURSOS.c.id.in_(course_ids)))
    ).mappings()
    return {
        fila["id"]: FichaDeCurso(
            subtitle=fila["subtitle"],
            promo_video_path=fila["promo_video_path"],
            primary_topic_id=fila["primary_topic_id"],
            language=fila["language"] or "es",
            level=fila["level"],
            target_audience=_lista(fila["target_audience"]),
            prerequisites=_lista(fila["prerequisites"]),
            review_status=fila["review_status"] or BORRADOR,
            submitted_at=fila["submitted_at"],
            reviewed_at=fila["reviewed_at"],
            reviewed_by=fila["reviewed_by"],
            rejection_reason=fila["rejection_reason"],
        )
        for fila in filas
    }


async def leer_una(db: AsyncSession, course_id: str) -> FichaDeCurso:
    """La ficha de un curso. `FICHA_VACIA` si la 0034 no esta aplicada."""
    fichas = await leer(db, [course_id])
    return fichas.get(course_id, FichaDeCurso())


async def guardar(db: AsyncSession, course_id: str, cambios: dict) -> None:
    """Escribe SOLO los campos de ficha que llegaron. No hace commit.

    Sin la 0034 no hace nada y no falla: el resto de la edicion (titulo,
    descripcion, precio, temas) se guarda igual. Que no se pueda guardar el
    nivel no puede impedir cambiar el titulo.
    """
    valores = {k: v for k, v in cambios.items() if k in CAMPOS_EDITABLES}
    if not valores or not await esquema.hay_cursos_v2(db):
        return
    await db.execute(update(CURSOS).where(CURSOS.c.id == course_id).values(**valores))


async def guardar_modulo(db: AsyncSession, module_id: str, cambios: dict) -> None:
    """La descripcion de un modulo. No hace commit.

    Sin la 0034 no hace nada y no falla, igual que `guardar`: que no se pueda
    guardar de que va el bloque no puede impedir crear el bloque. Es la misma
    degradacion que hace hoy el movil antes de mandar la fila a PostgREST.
    """
    valores = {k: v for k, v in cambios.items() if k in CAMPOS_EDITABLES_DE_MODULO}
    if not valores or not await esquema.hay_cursos_v2(db):
        return
    await db.execute(update(MODULOS).where(MODULOS.c.id == module_id).values(**valores))


async def guardar_leccion(db: AsyncSession, lesson_id: str, cambios: dict) -> None:
    """El tipo y la condicion de muestra de una leccion. No hace commit.

    SE ESCRIBE EN UNA SENTENCIA APARTE, DESPUES DE INSERTAR LA FILA, y no es un
    descuido: `kind` e `is_preview` NO estan en el ORM a proposito —ver el
    docstring del modulo— asi que el `insert` del ORM no puede llevarlas. Dos
    sentencias en la MISMA transaccion, que es lo unico que importa: o entran
    las dos o no entra ninguna.
    """
    valores = {k: v for k, v in cambios.items() if k in CAMPOS_EDITABLES_DE_LECCION}
    if not valores or not await esquema.hay_cursos_v2(db):
        return
    await db.execute(
        update(LECCIONES).where(LECCIONES.c.id == lesson_id).values(**valores)
    )


def ids_de_cursos_con(*, level: str | None = None, language: str | None = None):
    """Los ids de los cursos que casan con el nivel y el idioma pedidos.

    DEVUELVE UNA SUBCONSULTA, no una lista: el filtro tiene que aplicarse ANTES
    de paginar, y traerse los ids a Python para meterlos en un `IN` seria
    recorrer el catalogo entero en cada pagina.

    Es la MISMA TABLA `courses` vista desde el otro `MetaData`. Parece un rodeo
    y no lo es: `Course.level` no existe en el ORM justamente para que ningun
    `select(Course)` la pida contra una base sin la 0034, asi que la unica forma
    de filtrar por ella es nombrarla aqui.

    QUIEN LLAMA COMPRUEBA `hay_cursos_v2` ANTES. No se hace dentro porque esto
    no es `async` —es una expresion SQL, no una consulta— y porque sin la
    migracion la respuesta correcta no es «ninguno»: es decirle al cliente que
    ese filtro todavia no existe.
    """
    condiciones = []
    if level is not None:
        condiciones.append(CURSOS.c.level == level)
    if language is not None:
        condiciones.append(CURSOS.c.language == language)
    return select(CURSOS.c.id).where(*condiciones)


async def enviar_a_revision(db: AsyncSession, course_id: str) -> None:
    """Pasa el curso a `pending_review`. No hace commit.

    Se limpia el motivo del rechazo anterior: la peticion nueva no arrastra el
    «no» de la anterior, que ya esta resuelto por definicion.
    """
    await db.execute(
        update(CURSOS)
        .where(CURSOS.c.id == course_id)
        .values(
            review_status=EN_REVISION,
            submitted_at=datetime.now(timezone.utc),
            rejection_reason=None,
        )
    )


async def resolver_revision(
    db: AsyncSession,
    course_id: str,
    *,
    aprobado: bool,
    revisor_id: str | None,
    motivo: str | None = None,
) -> None:
    """Aprueba o rechaza. No hace commit.

    Queda escrito QUIEN reviso y CUANDO: una decision sobre el trabajo de otra
    persona sin firma no se puede ni explicar ni revisar. `revisor_id=None`
    solo lo usa el MODO FLEXIBLE, donde aprueba el sistema: la columna admite
    nulo y la auditoria lo apunta como tal.
    """
    await db.execute(
        update(CURSOS)
        .where(CURSOS.c.id == course_id)
        .values(
            review_status=APROBADO if aprobado else RECHAZADO,
            reviewed_at=datetime.now(timezone.utc),
            reviewed_by=revisor_id,
            rejection_reason=None if aprobado else motivo,
        )
    )


async def en_revision(db: AsyncSession, limite: int, salto: int) -> list[str]:
    """La cola de administracion: los cursos esperando, por orden de llegada.

    Primero el que lleva mas tiempo esperando. Ordenar al reves seria dejar
    para siempre al que llego primero, que es como se pierde a un creador.
    """
    if not await esquema.hay_cursos_v2(db):
        return []
    return list(
        await db.scalars(
            select(CURSOS.c.id)
            .where(CURSOS.c.review_status == EN_REVISION)
            .order_by(CURSOS.c.submitted_at.asc())
            .limit(limite)
            .offset(salto)
        )
    )


async def descripciones_de_modulos(
    db: AsyncSession, module_ids: list[str]
) -> dict[str, str]:
    """La descripcion de varios modulos, de UNA consulta."""
    if not module_ids or not await esquema.hay_cursos_v2(db):
        return {}
    filas = (
        await db.execute(
            select(MODULOS.c.id, MODULOS.c.description).where(
                MODULOS.c.id.in_(module_ids)
            )
        )
    ).all()
    return {mid: (texto or "") for mid, texto in filas}


async def tipos_de_lecciones(
    db: AsyncSession, lesson_ids: list[str]
) -> dict[str, tuple[str, bool]]:
    """`(kind, is_preview)` de varias lecciones, de UNA consulta.

    Sin la 0034 devuelve vacio, y quien llama entiende lo correcto: todas son de
    video y NINGUNA es muestra. Es exactamente lo que hay hoy, y ademas es el
    lado seguro: una leccion que no consta como muestra no entrega su video sin
    acceso.
    """
    if not lesson_ids or not await esquema.hay_cursos_v2(db):
        return {}
    filas = (
        await db.execute(
            select(LECCIONES.c.id, LECCIONES.c.kind, LECCIONES.c.is_preview).where(
                LECCIONES.c.id.in_(lesson_ids)
            )
        )
    ).all()
    return {lid: (kind or "video", bool(preview)) for lid, kind, preview in filas}


async def tiene_leccion_de_pago(db: AsyncSession, course_id: str) -> bool:
    """Si queda al menos una leccion FUERA de la muestra.

    Es lo que hace que una compra desbloquee algo. Sin la 0034 no existe la
    columna, asi que ninguna leccion es muestra y basta con que haya lecciones:
    lo comprueba quien llama, que ya las ha contado.
    """
    if not await esquema.hay_cursos_v2(db):
        return True
    return bool(
        await db.scalar(
            select(
                exists().where(
                    LECCIONES.c.module_id.in_(
                        select(MODULOS.c.id).where(MODULOS.c.course_id == course_id)
                    ),
                    LECCIONES.c.is_preview.is_(False),
                )
            )
        )
    )


async def tiene_muestra(db: AsyncSession, course_id: str) -> bool:
    """Si alguna leccion esta marcada como muestra."""
    if not await esquema.hay_cursos_v2(db):
        return False
    return bool(
        await db.scalar(
            select(
                exists().where(
                    LECCIONES.c.module_id.in_(
                        select(MODULOS.c.id).where(MODULOS.c.course_id == course_id)
                    ),
                    LECCIONES.c.is_preview.is_(True),
                )
            )
        )
    )
