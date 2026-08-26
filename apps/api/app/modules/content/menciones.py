"""Etiquetar personas en una publicacion: quien se puede, quien se avisa.

POR QUE ESTA APARTE, igual que `hashtags.py` y `temas_de_contenido.py`: lo
escribe el router de contenido (al publicar y al editar), lo lee el feed, y la
busqueda de candidatos la necesita la pantalla de Crear. Metido en el router,
cualquiera que quisiera comprobar un bloqueo tendria que importar medio modulo
de endpoints.

LAS DOS REGLAS QUE JUSTIFICAN ESTE FICHERO ENTERO.

1. EL BLOQUEO MANDA. Una mencion es una via para hacerle llegar algo a alguien
   —le sale un aviso y una notificacion push—, o sea exactamente lo que un
   bloqueo tiene que cortar. Y se comprueba en los DOS sentidos: si solo se
   cortara «a quien yo bloquee», bastaria con no bloquear de vuelta para
   seguir mandando avisos a alguien que ya dijo que no.

2. AL EDITAR SOLO SE AVISA DE LO NUEVO. Corregir una falta de ortografia en una
   publicacion con cinco personas etiquetadas no puede mandar cinco avisos otra
   vez. Por eso `fijar` LEE lo que habia ANTES de borrarlo y devuelve la
   diferencia; el orden de esas dos operaciones es todo el asunto, y es
   facilisimo escribirlo al reves.

POR QUE SE ELIGEN Y NO SE EXTRAEN DEL TEXTO. Una etiqueta mal extraida crea una
fila de mas: molesta. Una mencion mal extraida manda una notificacion a la
persona equivocada. «@ana» es ambiguo —hay varias Anas, los nombres de usuario
cambian, y un correo lleva una arroba que no menciona a nadie—, y con una
notificacion de por medio adivinar no es aceptable.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import delete, insert, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ValidationAppError
from app.modules.content.models import PostMention
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema
from app.modules.social_graph.service import blocked_either_way

#: A cuanta gente se puede etiquetar en una publicacion.
#:
#: POR QUE 10. El coste de una mencion no es una fila: es UNA NOTIFICACION Y UN
#: PUSH. Diez menciones son diez telefonos sonando por una sola publicacion, y
#: ese es justo el vector de abuso —etiquetar en masa para que algo llegue a
#: mucha gente sin que nadie lo haya pedido—. Diez es de sobra para una foto de
#: grupo o para dar credito a quien participo, y demasiado poco para usar las
#: menciones como lista de difusion.
#:
#: Coincide con el tope de hashtags por casualidad, no por simetria: alli lo que
#: se acota es el indexado, aqui lo que se acota es a cuanta gente se molesta.
MAX_MENCIONES_POR_PUBLICACION = 10


def _solo_uuids(ids: list[str]) -> list[str]:
    """Descarta lo que no sea un UUID, sin dar error.

    TRAMPA CONOCIDA DE ESTE REPO: un identificador con otro formato viaja tal
    cual hasta Postgres y asyncpg revienta la consulta; el manejador de
    DBAPIError lo convierte despues en un 404 mudo que no dice nada. Se filtra
    ANTES de consultar.

    Se descarta en vez de rechazar la peticion porque un id con mala forma solo
    puede venir de un cliente roto, y tirar la publicacion entera de alguien por
    eso seria castigar a quien no tiene la culpa.
    """
    limpios: list[str] = []
    for valor in ids:
        try:
            UUID(valor)
        except (ValueError, AttributeError, TypeError):
            continue
        limpios.append(valor)
    return limpios


async def resolver(db: AsyncSession, autor_id: str, ids: list[str]) -> list[str]:
    """De los ids pedidos, los que SI se pueden mencionar. En el orden pedido.

    Se cae de la lista, en silencio, quien:

    - no existe (una cuenta borrada entre elegirla y publicar);
    - bloqueo al autor, o a quien el autor bloqueo.

    EN SILENCIO Y NO CON UN ERROR, y esto es una decision de privacidad, no de
    comodidad: un 400 diciendo «no puedes mencionar a esta persona» revela que
    existe un bloqueo. Quien bloquea no tiene por que anunciarlo, asi que la
    publicacion sale y esa mencion sencillamente no esta. Ademas la lista de
    candidatos ya excluye a esa gente (`buscar_candidatos`), asi que en la
    practica esto solo salta si el bloqueo ocurrio mientras se escribia.

    Lo que SI da error es pasarse del tope: eso no es una carrera, es un cliente
    que ignoro un limite que su propia pantalla ensena.
    """
    unicos = list(dict.fromkeys(_solo_uuids(ids)))
    if not unicos:
        # TRAMPA CONOCIDA: `columna_uuid.in_([])` cuela en SQLite y PostgreSQL
        # lo rechaza. Lista vacia = no se consulta.
        return []
    if len(unicos) > MAX_MENCIONES_POR_PUBLICACION:
        raise ValidationAppError(
            f"Puedes etiquetar como máximo a {MAX_MENCIONES_POR_PUBLICACION} personas."
        )

    permitidos = set(
        (
            await db.scalars(
                select(Profile.id).where(
                    Profile.id.in_(unicos),
                    # El corte simetrico, en la consulta y no despues en
                    # memoria: `blocked_either_way` ya devuelve los dos
                    # sentidos (a quien bloqueaste y quien te bloqueo).
                    Profile.id.not_in(blocked_either_way(autor_id)),
                )
            )
        ).all()
    )
    return [uid for uid in unicos if uid in permitidos]


async def fijar(
    db: AsyncSession, post_id: str, autor_id: str, ids: list[str]
) -> list[str]:
    """Deja la publicacion con EXACTAMENTE esas menciones. Devuelve las NUEVAS.

    «Nuevas» significa: las que no estaban ya guardadas en esta publicacion. Es
    lo unico de lo que hay que avisar, y por eso se leen ANTES de borrar. Si se
    borrara primero, todo pareceria nuevo y editar una coma volveria a avisar a
    las cinco personas etiquetadas.

    La AUTO-MENCION se guarda pero NUNCA se devuelve como nueva: etiquetarse en
    la propia publicacion es legitimo —una foto de grupo en la que uno tambien
    sale— pero mandarse una notificacion a uno mismo no tiene ningun sentido.

    No hace commit: lo hace quien llama, para que la publicacion y sus menciones
    entren juntas. Una publicacion guardada sin sus menciones dejaria a gente
    esperando un aviso que nunca llega.
    """
    if not await esquema.hay_menciones(db):
        # Sin la 0032 no hay donde guardarlas. Se publica igual y no se etiqueta
        # a nadie. Lo que no puede pasar es que no se pueda publicar por esto, ni
        # que se avise de una mencion que no llego a guardarse.
        return []

    permitidos = await resolver(db, autor_id, ids)

    # PRIMERO leer, DESPUES borrar. Al reves, editar avisaria de todo otra vez.
    anteriores = set(
        (
            await db.scalars(
                select(PostMention.mentioned_user_id).where(
                    PostMention.post_id == post_id
                )
            )
        ).all()
    )

    await db.execute(delete(PostMention).where(PostMention.post_id == post_id))
    if permitidos:
        # `insert().values()` y no `db.add(PostMention(...))`: el ORM insertaria
        # TODAS las columnas del modelo, asi que el dia que la tabla real tenga
        # una que este fichero no conoce, publicar reventaria en produccion y
        # funcionaria en las pruebas.
        await db.execute(
            insert(PostMention),
            [{"post_id": post_id, "mentioned_user_id": uid} for uid in permitidos],
        )

    return [
        uid for uid in permitidos if uid not in anteriores and uid != autor_id
    ]


async def leer(db: AsyncSession, post_ids: list[str]) -> dict[str, list[dict]]:
    """A quien menciona cada publicacion, de UNA consulta.

    Devuelve lo justo para pintar la etiqueta y poder tocarla: id, nombre,
    usuario y avatar. Lo consume el feed entero de golpe; una consulta por fila
    serian veinte viajes para pintar unos nombres.
    """
    if not post_ids:
        return {}
    if not await esquema.hay_menciones(db):
        return {}
    filas = (
        await db.execute(
            select(
                PostMention.post_id,
                Profile.id,
                Profile.full_name,
                Profile.username,
                Profile.avatar_path,
            )
            .join(Profile, Profile.id == PostMention.mentioned_user_id)
            .where(PostMention.post_id.in_(post_ids))
            .order_by(PostMention.created_at, Profile.full_name)
        )
    ).all()
    salida: dict[str, list[dict]] = {}
    for post_id, uid, nombre, usuario, avatar in filas:
        salida.setdefault(post_id, []).append(
            {
                "id": uid,
                "full_name": nombre,
                "username": usuario,
                "avatar_path": avatar,
            }
        )
    return salida


async def buscar_candidatos(
    db: AsyncSession, viewer_id: str, termino: str, limite: int = 20
) -> list[dict]:
    """Perfiles a los que `viewer_id` puede etiquetar, buscando por texto.

    Busca por NOMBRE y por USUARIO a la vez, porque en una lista de contactos
    la gente recuerda una cosa o la otra, y devuelve el avatar para que la
    eleccion no dependa de leer dos nombres parecidos.

    Excluye a quien esta bloqueado en cualquiera de los dos sentidos: es lo que
    hace que el limite se note en el sitio correcto —la persona no aparece— en
    vez de en un error al publicar. Es la misma comprobacion que `resolver`
    repite despues, y esa repeticion es deliberada: esta lista puede quedarse
    vieja mientras alguien escribe.

    Existe aparte de `/profiles/search` porque aquella no filtra bloqueos —es
    un buscador general— y porque cambiarla habria alterado el comportamiento
    de una pantalla que no tiene nada que ver con etiquetar.
    """
    limpio = (termino or "").strip()
    if len(limpio) < 2:
        # Con una sola letra el resultado es «casi todo el mundo», que no ayuda
        # a elegir y ademas recorre la tabla entera en cada pulsacion.
        return []
    patron = f"%{limpio}%"
    filas = (
        await db.execute(
            select(
                Profile.id, Profile.full_name, Profile.username, Profile.avatar_path
            )
            .where(
                or_(Profile.username.ilike(patron), Profile.full_name.ilike(patron)),
                Profile.id.not_in(blocked_either_way(viewer_id)),
            )
            .order_by(Profile.full_name)
            .limit(limite)
        )
    ).all()
    return [
        {"id": uid, "full_name": nombre, "username": usuario, "avatar_path": avatar}
        for uid, nombre, usuario, avatar in filas
    ]
