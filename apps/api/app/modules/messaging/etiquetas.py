"""CRM ligero de la bandeja: etiquetas PRIVADAS de conversación (migración 0045).

QUÉ ES. Que cada persona ordene su bandeja con sus propias categorías
—«Seguimiento», «Interesado», «Alumno», las que necesite— y pueda filtrar por
ellas desde una fila de chips en la parte de arriba, al estilo de Instagram.

QUÉ NO ES, y esto importa tanto como lo anterior: no hay embudo de ventas, ni
oportunidades, ni importes, ni puntuación de contactos, ni recordatorios
comerciales. Un CRM V1 son categorías persistentes puestas por una persona.
Todo lo demás arrastraría tablas y reglas que nadie ha pedido.

TAMPOCO SON ETIQUETAS «No leídos» ni «No respondidos». Ésos son ESTADOS
DERIVADOS —se calculan de los mensajes y cambian solos— y viven en el parámetro
`filtro` del listado. Guardar un estado derivado como una categoría manual es lo
que convierte un CRM en un cajón de sastre: nadie vuelve a marcar «leído» a
mano, así que la etiqueta miente a los dos días.

-------------------------------------------------------------------------------
LA REGLA QUE JUSTIFICA TODO ESTE FICHERO: SON PRIVADAS
-------------------------------------------------------------------------------
La etiqueta que Darren le pone a su conversación con Edson es de Darren, y
**Edson no puede enterarse jamás**: ni en el detalle de la conversación, ni en
la lista, ni en un contador, ni por la diferencia entre dos códigos de error.

No es una preferencia de producto. Una etiqueta es un juicio sobre otra persona
(«Pendiente», «No interesado»), y una herramienta de trabajo que filtra ese
juicio hacia el juzgado deja de ser una herramienta de trabajo.

Se sostiene sobre tres cosas, y las tres tienen que seguir siendo verdad:

  1. TODA consulta de este fichero filtra por `owner_id == uid`, donde `uid`
     sale del JWT y nunca del cuerpo de la petición. No hay un solo `select`
     aquí que pueda devolver la etiqueta de otra persona.
  2. NINGÚN endpoint de fuera de este fichero devuelve etiquetas. `lectura.py`
     no las conoce, `ConversationRead` no las lleva. Lo que se junta con la
     conversación se junta en el listado, y ahí sólo se juntan las de quien
     pregunta (ver `etiquetas_por_conversacion`).
  3. Las respuestas NO DISTINGUEN «no existe» de «no es tuya». Si lo hicieran,
     probar identificadores al azar diría cuáles existen sin necesidad de poder
     leer nada: la respuesta ya sería la información.

Y la RLS de la 0045 dice lo mismo otra vez, por si algún día estas tablas se
leen directamente desde el móvil.

-------------------------------------------------------------------------------
POR QUÉ UN FICHERO APARTE Y NO DENTRO DE `router.py`
-------------------------------------------------------------------------------
Lo mismo que explica `content/router_etiquetas.py`: `messaging/router.py` es lo
que toca cualquier cambio de la bandeja y del chat a la vez. Todo el CRM cabe
aquí —modelos, esquemas, endpoints y las dos funciones que consume el listado—
y `router.py` sólo gana la línea que lo monta.

-------------------------------------------------------------------------------
SIN LA 0045 APLICADA NO SE ROMPE NADA
-------------------------------------------------------------------------------
Quien lo comprueba es `esquema.hay_etiquetas_de_conversacion`:

  - Listar etiquetas responde `[]`. No es un error: no hay etiquetas.
  - Crear, renombrar, asignar y quitar responden 503
    `conversation_labels_not_available`. 503 y no 404 —que haría pensar que la
    ruta está mal escrita— ni 500 —que sale por Starlette sin cabeceras CORS y
    el navegador lo enseña como un fallo de red, mandando a mirar al sitio
    equivocado—.
  - La bandeja sigue funcionando exactamente igual, porque las etiquetas son
    una capa encima de las conversaciones y no una parte de ellas.

Y la aplicación, al ver la lista vacía y el 503, no ofrece la función: nunca un
botón muerto.
"""

from __future__ import annotations

from datetime import datetime
from typing import Sequence
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field
from sqlalchemy import (
    DateTime,
    ForeignKey,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    delete,
    false,
    func,
    insert,
    select,
    update,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql.elements import ColumnElement

from app.core.exceptions import (
    ConflictError,
    ForbiddenError,
    NotFoundError,
    ServiceUnavailableError,
    ValidationAppError,
)
from app.core.security import AuthUser, get_current_user
from app.modules.messaging import esquema
from app.modules.messaging.models import Conversation, ConversationMember
from app.shared.database import Base
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid

router = APIRouter(tags=["messaging"])


def _uuid() -> str:
    return str(uuid4())


#: Cuántas etiquetas puede tener una persona.
#:
#: NO es una limitación técnica: es lo que permite que `GET /labels` devuelva la
#: lista ENTERA en una respuesta y que los chips de arriba se puedan pintar sin
#: paginar una fila horizontal —que es una cosa que nadie sabe usar—. Cincuenta
#: es mucho más de lo que ordena una bandeja; a partir de ahí la fila de chips
#: deja de ser un índice y pasa a ser otra lista que hay que buscar.
#:
#: El tope se comprueba al CREAR. Quien ya tuviera más (no puede pasar hoy)
#: sigue viéndolas todas: el límite nunca esconde lo que ya está.
MAX_ETIQUETAS = 50

#: Lo que cabe en un chip sin partirlo. Es el mismo número que el `check` de la
#: 0045, y tiene que seguir siéndolo: si aquí subiera, la base rechazaría el
#: nombre y saldría un 500 en vez del 422 que corresponde.
MAX_NOMBRE = 40


# --------------------------------------------------------------------------- #
# Modelos
# --------------------------------------------------------------------------- #
class ConversationLabel(Base):
    """Una etiqueta de la bandeja de UNA persona (migración 0045).

    TABLA NUEVA Y NINGUNA COLUMNA NUEVA EN `conversations`, por lo mismo que
    explican `MessageAttachment` y `DirectConversationPair`: un
    `select(Entidad)` de SQLAlchemy pide TODAS las columnas mapeadas, así que
    añadir una a una tabla tan consultada rompe producción en cuanto el modelo
    se adelanta a la migración.

    Pero aquí hay además una razón de privacidad, y es la de peso: una columna
    en `conversations` la leen los DOS miembros de la conversación. La etiqueta
    cuelga de su dueño precisamente para que no pueda haber una lectura
    compartida ni por accidente.
    """

    __tablename__ = "conversation_labels"

    #: LA RESTRICCION VA TAMBIEN EN EL MODELO, no solo en la 0045. En produccion
    #: la pone la migracion, pero `create_all` —el SQLite de las pruebas y el de
    #: desarrollo local— construye la tabla desde AQUI: sin esta linea, la
    #: unicidad existiria en produccion y no donde se prueba, que es la peor
    #: forma de tenerla. Se descubrio asi: la prueba del nombre repetido
    #: devolvia 201.
    __table_args__ = (
        UniqueConstraint(
            "owner_id", "nombre_normalizado", name="conversation_labels_unicas"
        ),
    )

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    #: Quien organiza SU bandeja. Nunca «la persona etiquetada»: eso no existe.
    owner_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    #: Como lo escribió su dueño. Es lo que se pinta.
    nombre: Mapped[str] = mapped_column(String(MAX_NOMBRE))
    #: El mismo nombre en minúsculas y sin espacios de sobra. NO se pinta: existe
    #: solo para que `unique (owner_id, nombre_normalizado)` pueda decidir que
    #: «Seguimiento» y «seguimiento » son la misma etiqueta.
    nombre_normalizado: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ConversationLabelAssignment(Base):
    """Que esta conversación lleva esta etiqueta (migración 0045).

    NO LLEVA `owner_id`, y es deliberado: el dueño sale SIEMPRE de la etiqueta.
    Repetirlo aquí crearía dos fuentes de verdad que pueden discrepar, y el día
    que discreparan la que decide quién ve qué sería la equivocada.

    LA CLAVE PRIMARIA COMPUESTA ES LO QUE HACE IDEMPOTENTE ASIGNAR DOS VECES.
    Por eso `asignar` no comprueba nada a mano: un `select` antes del `insert`
    deja siempre una ventana entre los dos —el doble toque, el reintento de una
    red lenta—, que es exactamente el fallo que la 0039 y la 0043 tuvieron que
    cerrar en otras tablas.
    """

    __tablename__ = "conversation_label_assignments"

    label_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("conversation_labels.id", ondelete="CASCADE"),
        primary_key=True,
    )
    conversation_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        primary_key=True,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


# --------------------------------------------------------------------------- #
# Esquemas de la API
# --------------------------------------------------------------------------- #
class EtiquetaBreve(BaseModel):
    """Lo mínimo para pintar un chip: identificador y texto."""

    id: str
    nombre: str


class EtiquetaRead(EtiquetaBreve):
    """Una etiqueta con cuántas conversaciones lleva.

    La cuenta es SIEMPRE la de quien pregunta y no puede ser otra cosa: sólo
    entran las conversaciones a las que él mismo le puso la etiqueta.
    """

    conversaciones: int


class EtiquetaCreate(BaseModel):
    nombre: str = Field(min_length=1, max_length=MAX_NOMBRE)


class EtiquetaRename(BaseModel):
    nombre: str = Field(min_length=1, max_length=MAX_NOMBRE)


# --------------------------------------------------------------------------- #
# Ayudantes
# --------------------------------------------------------------------------- #
def mostrar(bruto: str) -> str:
    """El nombre tal y como se guardará y se pintará.

    Colapsa los espacios de sobra —`str.split()` sin argumentos parte por
    cualquier hueco y descarta los vacíos— porque «Nuevo  contacto» y «Nuevo
    contacto» son la misma etiqueta escrita con el pulgar torcido, y dos chips
    con el mismo texto aparente son peor que no tener chips.
    """
    return " ".join(bruto.split())


def normalizar(bruto: str) -> str:
    """La forma con la que se decide si dos nombres son EL MISMO.

    Es la regla de producto, y por eso vive en el código y no escondida en un
    índice sobre una expresión: aquí se lee y se prueba. La base guarda lo que
    devuelve esto en `nombre_normalizado`, así que la consulta de «¿ya existe?»
    compara exactamente lo mismo que comparó la restricción al escribir.

    `lower()` y no `casefold()`: `lower()` es lo que haría un `lower()` de SQL
    si algún día alguien reconstruye esta columna a mano desde la base, y que
    las dos formas coincidan vale más que el puñado de casos —la ß alemana— en
    los que `casefold` afina más.
    """
    return mostrar(bruto).lower()


def _insert_con_conflicto(db: AsyncSession):
    """El `insert` del dialecto que toque, con `on conflict do nothing`.

    Hace falta elegir porque `on conflict` no está en el `insert` genérico de
    SQLAlchemy: lo traen los dialectos. Es el mismo ayudante que
    `commerce/service.py`, escrito otra vez aquí en vez de importado porque el
    comercio y la mensajería no tienen por qué compartir destino.
    """
    nombre = db.get_bind().dialect.name
    if nombre == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as insert_pg

        return insert_pg
    if nombre == "sqlite":
        from sqlalchemy.dialects.sqlite import insert as insert_sqlite

        return insert_sqlite
    raise RuntimeError(
        f"Dialecto '{nombre}' sin soporte de `on conflict`: la idempotencia de "
        "asignar una etiqueta depende de él y sustituirlo por una comprobación "
        "en Python abriría la carrera que la clave primaria cierra."
    )


async def _exigir_esquema(db: AsyncSession) -> None:
    """503 mientras la 0045 espere aprobación, nunca un 500.

    503 y no 404: la ruta existe y está bien escrita, lo que falta es que la
    migración esté puesta. Y con un código propio para que la aplicación pueda
    decir «las etiquetas todavía no están disponibles» y esconder el botón, en
    vez de enseñar un error genérico sobre algo que no se ha roto.
    """
    if not await esquema.hay_etiquetas_de_conversacion(db):
        raise ServiceUnavailableError(
            "Las etiquetas de conversación todavía no están disponibles.",
            code="conversation_labels_not_available",
        )


async def _exigir_miembro(db: AsyncSession, conversation_id: str, uid: str) -> None:
    """Que quien etiqueta pertenezca a la conversación.

    ES LA MITAD DE LA PRIVACIDAD Y NO UNA FORMALIDAD. Sin esto, cualquiera
    podría probar identificadores de conversación al azar y AVERIGUAR CUÁLES
    EXISTEN por la diferencia entre «guardado» y «esa conversación no existe».
    No haría falta poder leer un solo mensaje: la respuesta ya sería la
    información.

    Responde lo mismo cuando la conversación no existe y cuando existe pero no
    es tuya, exactamente por eso.
    """
    miembro = await db.get(
        ConversationMember, {"conversation_id": conversation_id, "user_id": uid}
    )
    if miembro is None:
        raise ForbiddenError("No perteneces a esta conversación.")


async def _mi_etiqueta(db: AsyncSession, label_id: str, uid: str) -> str:
    """El identificador de la etiqueta si es MÍA; si no, 404.

    404 —y no 403— cuando existe pero es de otra persona, a propósito: un 403
    confirmaría que ese identificador corresponde a una etiqueta de alguien. Es
    la misma respuesta en los dos casos porque son el mismo caso desde fuera:
    para quien pregunta, esa etiqueta no existe.
    """
    ensure_uuid(label_id, "Etiqueta no encontrada.")
    encontrada = (
        await db.execute(
            select(ConversationLabel.id).where(
                ConversationLabel.id == label_id,
                ConversationLabel.owner_id == uid,
            )
        )
    ).scalar_one_or_none()
    if encontrada is None:
        raise NotFoundError("Etiqueta no encontrada.")
    return encontrada


async def _leer_una(db: AsyncSession, label_id: str) -> EtiquetaRead:
    """La etiqueta recién creada o renombrada, con su cuenta.

    Se vuelve a leer en vez de componerla en memoria para que la respuesta de
    crear y la de listar salgan del MISMO sitio: es como se evita que una diga
    una cosa y la otra otra cuando alguien cambie el cálculo de la cuenta.
    """
    fila = (
        await db.execute(
            select(
                ConversationLabel.id,
                ConversationLabel.nombre,
                func.count(ConversationLabelAssignment.conversation_id),
            )
            .select_from(ConversationLabel)
            .outerjoin(
                ConversationLabelAssignment,
                ConversationLabelAssignment.label_id == ConversationLabel.id,
            )
            .where(ConversationLabel.id == label_id)
            .group_by(ConversationLabel.id, ConversationLabel.nombre)
        )
    ).one()
    return EtiquetaRead(id=fila[0], nombre=fila[1], conversaciones=fila[2])


# --------------------------------------------------------------------------- #
# Lo que consume el LISTADO de conversaciones (lo llama el endpoint de B)
# --------------------------------------------------------------------------- #
async def condicion_de_etiqueta(
    db: AsyncSession, *, uid: str, label_id: str
) -> ColumnElement[bool]:
    """La condición SQL «esta conversación lleva MI etiqueta X».

    SE DEVUELVE UNA CONDICIÓN Y NO UNA LISTA DE IDENTIFICADORES, y ésa es toda
    la gracia. El listado la mete en su propio `where` y sigue paginando en la
    base: `limit`/`offset` cuentan las filas que de verdad quedan. Con una lista
    habría dos problemas y los dos son reales: habría que traerla ENTERA para
    poder paginar después (con doscientas conversaciones etiquetadas, eso son
    doscientos identificadores viajando en cada página), y una lista vacía
    acabaría en un `in_([])` — que en este proyecto está prohibido escribir como
    `in_(lista or [""])` porque el `''` pasa en SQLite y asyncpg lo rechaza,
    convirtiendo el error en un 404 silencioso.

    Es un `exists` correlacionado con `Conversation.id`, así que NO añade
    ninguna consulta al listado: entra en la que ya se hacía.

    DEVUELVE `false()` —o sea, ninguna conversación— cuando la etiqueta no es de
    quien pregunta, cuando no existe, cuando el identificador no es un UUID y
    cuando la 0045 todavía no está aplicada. Los cuatro casos responden lo mismo
    A PROPÓSITO: distinguirlos permitiría averiguar qué etiquetas existen
    probando identificadores, sin llegar a leer ninguna.

    Uso desde el endpoint del listado:

        consulta = select(...).join(ConversationMember, ...).where(...)
        if label_id:
            consulta = consulta.where(
                await condicion_de_etiqueta(db, uid=current_user.id, label_id=label_id)
            )
    """
    if not await esquema.hay_etiquetas_de_conversacion(db):
        return false()
    try:
        UUID(label_id)
    except (ValueError, AttributeError, TypeError):
        # Un identificador con otro formato llegaría hasta el driver y asyncpg
        # lo convertiría en un 500. Aquí es simplemente «no hay nada así».
        return false()

    es_mia = (
        await db.execute(
            select(ConversationLabel.id).where(
                ConversationLabel.id == label_id,
                ConversationLabel.owner_id == uid,
            )
        )
    ).scalar_one_or_none()
    if es_mia is None:
        return false()

    return (
        select(ConversationLabelAssignment.conversation_id)
        .where(
            ConversationLabelAssignment.label_id == label_id,
            ConversationLabelAssignment.conversation_id == Conversation.id,
        )
        .exists()
    )


async def etiquetas_por_conversacion(
    db: AsyncSession, *, uid: str, conversation_ids: Sequence[str]
) -> dict[str, list[EtiquetaBreve]]:
    """Las etiquetas DE QUIEN PREGUNTA para una página entera de la bandeja.

    UNA sola consulta para las veinte filas, no una por fila: es el mismo N+1
    que `lectura.py` ya quitó del listado, y volver a meterlo aquí habría
    deshecho ese trabajo.

    El `owner_id == uid` del `where` es lo que impide que una fila de la bandeja
    enseñe la etiqueta que puso el otro lado. Si algún día alguien quita ese
    filtro pensando que las asignaciones ya son privadas, la conversación
    empezaría a contar lo que piensa de uno la otra persona.

    Devuelve `{}` sin la 0045 y también con la lista vacía; ese retorno temprano
    no es un adorno: sin él quedaría un `in_([])`, y la forma de escribirlo que
    circula por ahí —`in_(lista or [""])`— pasa en SQLite y asyncpg la rechaza,
    con lo que el error acaba disfrazado de 404.
    """
    if not conversation_ids:
        return {}
    if not await esquema.hay_etiquetas_de_conversacion(db):
        return {}

    filas = (
        await db.execute(
            select(
                ConversationLabelAssignment.conversation_id,
                ConversationLabel.id,
                ConversationLabel.nombre,
            )
            .join(
                ConversationLabel,
                ConversationLabel.id == ConversationLabelAssignment.label_id,
            )
            .where(
                ConversationLabel.owner_id == uid,
                ConversationLabelAssignment.conversation_id.in_(list(conversation_ids)),
            )
            # El mismo orden que la fila de chips, para que una conversación no
            # enseñe sus etiquetas en un orden distinto cada vez que se recarga.
            .order_by(ConversationLabel.created_at.asc(), ConversationLabel.id.asc())
        )
    ).all()

    por_conversacion: dict[str, list[EtiquetaBreve]] = {}
    for conversation_id, label_id, nombre in filas:
        por_conversacion.setdefault(conversation_id, []).append(
            EtiquetaBreve(id=label_id, nombre=nombre)
        )
    return por_conversacion


# --------------------------------------------------------------------------- #
# Endpoints — las etiquetas
# --------------------------------------------------------------------------- #
#
# OJO CON EL ORDEN. `/labels` va ANTES que `/{conversation_id}/labels`, y este
# sub-router se monta ANTES que las rutas de `router.py`: FastAPI prueba en
# orden de declaración, y el día que alguien añada un `GET /{conversation_id}`
# al listado, sin este orden «labels» se leería como un identificador de
# conversación.


@router.get("/labels", response_model=list[EtiquetaRead])
async def listar_etiquetas(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[EtiquetaRead]:
    """Las etiquetas de quien pregunta, con cuántas conversaciones lleva cada una.

    SIN PAGINAR, y no es un descuido de la regla de que todo se pagina. Lo que
    esa regla evita es traer al teléfono una lista que puede crecer sin
    control; aquí el crecimiento está atado por `MAX_ETIQUETAS`, así que la
    respuesta ES la lista completa. Paginar una fila horizontal de chips sería
    además una función que nadie sabría usar: no se hace scroll infinito en una
    barra de filtros.

    SIN LA 0045 devuelve `[]`. No es un error: no hay etiquetas todavía, y eso
    es exactamente lo que significa una lista vacía. La aplicación, al verla
    vacía, ofrece crear la primera.

    UNA SOLA CONSULTA, con `outer join`: una etiqueta recién creada y sin
    asignar tiene que salir con cero, no desaparecer.
    """
    if not await esquema.hay_etiquetas_de_conversacion(db):
        return []

    filas = (
        await db.execute(
            select(
                ConversationLabel.id,
                ConversationLabel.nombre,
                func.count(ConversationLabelAssignment.conversation_id),
            )
            .select_from(ConversationLabel)
            .outerjoin(
                ConversationLabelAssignment,
                ConversationLabelAssignment.label_id == ConversationLabel.id,
            )
            .where(ConversationLabel.owner_id == current_user.id)
            .group_by(
                ConversationLabel.id,
                ConversationLabel.nombre,
                ConversationLabel.created_at,
            )
            # Por antigüedad: los chips tienen que quedarse donde estaban. Una
            # fila de filtros que se reordena sola —por uso, por cuenta— es una
            # fila en la que no se puede confiar la memoria muscular.
            .order_by(ConversationLabel.created_at.asc(), ConversationLabel.id.asc())
        )
    ).all()
    return [
        EtiquetaRead(id=fila[0], nombre=fila[1], conversaciones=fila[2]) for fila in filas
    ]


@router.post(
    "/labels", response_model=EtiquetaRead, status_code=status.HTTP_201_CREATED
)
async def crear_etiqueta(
    payload: EtiquetaCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EtiquetaRead:
    """Crea una etiqueta propia.

    EL DUEÑO SALE DEL JWT, nunca del cuerpo de la petición. Si viniera de fuera,
    bastaría con mandar el identificador de otra persona para meterle un chip en
    su bandeja.

    EL NOMBRE REPETIDO LO RECHAZA LA BASE, no un `select` previo. Comprobar
    antes de escribir deja una ventana entre las dos sentencias por la que caben
    dos peticiones simultáneas —el doble toque de siempre—, y la restricción
    `unique (owner_id, nombre_normalizado)` de la 0045 no la tiene. Aquí sólo se
    traduce ese choque a un 409 con un motivo legible.
    """
    await _exigir_esquema(db)

    nombre = mostrar(payload.nombre)
    if not nombre:
        # Pydantic ya exige un carácter, pero un nombre de puros espacios lo
        # pasa y llegaría a la base como cadena vacía, contra el `check`.
        raise ValidationAppError("Escribe un nombre para la etiqueta.")

    cuantas = (
        await db.execute(
            select(func.count(ConversationLabel.id)).where(
                ConversationLabel.owner_id == current_user.id
            )
        )
    ).scalar_one()
    if cuantas >= MAX_ETIQUETAS:
        raise ValidationAppError(
            f"Has llegado al máximo de {MAX_ETIQUETAS} etiquetas. "
            "Borra alguna que ya no uses.",
            code="conversation_labels_max",
        )

    try:
        label_id = (
            await db.execute(
                insert(ConversationLabel)
                .values(
                    owner_id=current_user.id,
                    nombre=nombre,
                    nombre_normalizado=normalizar(nombre),
                )
                .returning(ConversationLabel.id)
            )
        ).scalar_one()
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise ConflictError(
            f"Ya tienes una etiqueta que se llama «{nombre}».",
            code="conversation_label_duplicada",
        ) from None

    return await _leer_una(db, label_id)


@router.patch("/labels/{label_id}", response_model=EtiquetaRead)
async def renombrar_etiqueta(
    label_id: str,
    payload: EtiquetaRename,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EtiquetaRead:
    """Cambia el nombre de una etiqueta propia. NO toca sus asignaciones.

    Renombrar «Interesado» a «Interesados» tiene que dejar las conversaciones
    donde estaban: lo que cambia es la palabra, no la clasificación. Por eso se
    actualizan las dos columnas del nombre y ninguna más.
    """
    await _exigir_esquema(db)
    await _mi_etiqueta(db, label_id, current_user.id)

    nombre = mostrar(payload.nombre)
    if not nombre:
        raise ValidationAppError("Escribe un nombre para la etiqueta.")

    try:
        await db.execute(
            update(ConversationLabel)
            # El `owner_id` va también en el `where` del update, y no sólo en la
            # comprobación de arriba: es lo que hace que aunque alguien cambiara
            # esa comprobación, la sentencia siga sin poder tocar una fila ajena.
            .where(
                ConversationLabel.id == label_id,
                ConversationLabel.owner_id == current_user.id,
            )
            .values(nombre=nombre, nombre_normalizado=normalizar(nombre))
        )
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise ConflictError(
            f"Ya tienes una etiqueta que se llama «{nombre}».",
            code="conversation_label_duplicada",
        ) from None

    return await _leer_una(db, label_id)


@router.delete("/labels/{label_id}", status_code=status.HTTP_204_NO_CONTENT)
async def borrar_etiqueta(
    label_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Borra una etiqueta propia. NO BORRA NINGUNA CONVERSACIÓN.

    Se lleva por delante sus asignaciones —la clave ajena de la 0045 es
    `on delete cascade`— y nada más: las conversaciones, sus mensajes y sus
    miembros se quedan exactamente igual. Quitar una carpeta no quita lo que
    había dentro, y esto es lo que más miedo da al pulsarlo, así que la interfaz
    lo dice antes de hacerlo.

    IDEMPOTENTE: borrar dos veces responde 204 las dos. Y responde 204 también
    cuando la etiqueta es de otra persona o no existe, que es lo mismo que ya
    hace `_mi_etiqueta` con el 404: la respuesta no puede servir para averiguar
    qué identificadores corresponden a etiquetas de alguien.
    """
    await _exigir_esquema(db)
    ensure_uuid(label_id, "Etiqueta no encontrada.")

    # LAS ASIGNACIONES SE BORRAN A MANO ADEMÁS DEL `cascade` DE LA 0045, y no es
    # cinturón y tirantes por gusto: SQLite —donde corren las pruebas y el
    # desarrollo local con `create_all_dev`— NO aplica `on delete cascade` salvo
    # que se le encienda `pragma foreign_keys`, y encenderlo en esta base no se
    # puede porque el esquema de pruebas se siembra en una sola transacción y el
    # orden de inserción no lo respeta. Sin estas dos sentencias, borrar una
    # etiqueta dejaría asignaciones huérfanas en desarrollo y no en producción:
    # un comportamiento distinto en el sitio donde se comprueba que en el sitio
    # donde importa, que es la peor forma de tenerlo.
    #
    # Las dos van en la MISMA transacción, así que o se van las dos cosas o no
    # se va ninguna. Y ninguna de las dos toca `conversations` ni `messages`:
    # quitar una carpeta no quita lo que había dentro.
    subconsulta = select(ConversationLabel.id).where(
        ConversationLabel.id == label_id,
        # Sin esta condición, este endpoint borraría las etiquetas de
        # cualquiera con sólo saber su identificador.
        ConversationLabel.owner_id == current_user.id,
    )
    await db.execute(
        delete(ConversationLabelAssignment).where(
            ConversationLabelAssignment.label_id.in_(subconsulta)
        )
    )
    await db.execute(
        delete(ConversationLabel).where(
            ConversationLabel.id == label_id,
            ConversationLabel.owner_id == current_user.id,
        )
    )
    await db.commit()


# --------------------------------------------------------------------------- #
# Endpoints — asignar y quitar
# --------------------------------------------------------------------------- #
@router.get("/{conversation_id}/labels", response_model=list[EtiquetaBreve])
async def etiquetas_de_una_conversacion(
    conversation_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[EtiquetaBreve]:
    """MIS etiquetas en esta conversación. Las del otro lado no salen nunca.

    Éste es el endpoint donde más fácil sería filtrar la privacidad, porque
    quien pregunta es miembro de la conversación y parece natural devolver «las
    etiquetas de la conversación». No existe tal cosa: existen las de cada uno.
    El `owner_id == uid` de `etiquetas_por_conversacion` es lo que lo garantiza,
    y por eso se reutiliza esa función en vez de escribir aquí otra consulta que
    algún día podría olvidárselo.

    Sin la 0045 responde `[]`, no un error.
    """
    ensure_uuid(conversation_id, "Conversación no encontrada.")
    await _exigir_miembro(db, conversation_id, current_user.id)
    por_conversacion = await etiquetas_por_conversacion(
        db, uid=current_user.id, conversation_ids=[conversation_id]
    )
    return por_conversacion.get(conversation_id, [])


@router.put(
    "/{conversation_id}/labels/{label_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def asignar_etiqueta(
    conversation_id: str,
    label_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Pone una etiqueta propia a una conversación de la que se es miembro.

    `PUT` y no `POST` porque es IDEMPOTENTE: pulsarlo dos veces deja el mismo
    estado. Y lo es porque lo garantiza la clave primaria compuesta de la 0045,
    no porque aquí se compruebe antes de escribir — esa comprobación dejaría
    una ventana entre el `select` y el `insert` por la que caben dos peticiones
    simultáneas.

    LAS DOS CONDICIONES:
      - la etiqueta tiene que ser MÍA (`_mi_etiqueta`, 404 si no);
      - y yo tengo que pertenecer a la conversación (`_exigir_miembro`, 403).

    La segunda es la que no es evidente, y sin ella se podrían probar
    identificadores de conversación al azar para averiguar cuáles existen. Va
    ANTES que la de la etiqueta a propósito: si fuera al revés, un 404 de
    etiqueta contra una conversación ajena ya diría que la conversación estaba
    bien.
    """
    await _exigir_esquema(db)
    ensure_uuid(conversation_id, "Conversación no encontrada.")
    await _exigir_miembro(db, conversation_id, current_user.id)
    await _mi_etiqueta(db, label_id, current_user.id)

    inserta = _insert_con_conflicto(db)
    await db.execute(
        inserta(ConversationLabelAssignment)
        .values(label_id=label_id, conversation_id=conversation_id)
        # Volver a asignar no es un error: es querer lo que ya está. Y la fecha
        # NO se sobrescribe, así que sigue siendo la de la primera vez.
        .on_conflict_do_nothing(index_elements=["label_id", "conversation_id"])
    )
    await db.commit()


@router.delete(
    "/{conversation_id}/labels/{label_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def quitar_etiqueta(
    conversation_id: str,
    label_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Quita una etiqueta propia de una conversación. No toca la conversación.

    NO SE EXIGE SEGUIR SIENDO MIEMBRO, al revés que al asignar, y es
    deliberado: a quien lo sacaron de un grupo hay que dejarle limpiar su propia
    bandeja. Aquí no hay nada que averiguar por la respuesta, porque el borrado
    sólo puede alcanzar filas cuya etiqueta ya es suya.

    IDEMPOTENTE: quitar lo que ya no está responde 204 igual.
    """
    await _exigir_esquema(db)
    ensure_uuid(conversation_id, "Conversación no encontrada.")
    label = await _mi_etiqueta(db, label_id, current_user.id)

    await db.execute(
        delete(ConversationLabelAssignment).where(
            ConversationLabelAssignment.label_id == label,
            ConversationLabelAssignment.conversation_id == conversation_id,
        )
    )
    await db.commit()
