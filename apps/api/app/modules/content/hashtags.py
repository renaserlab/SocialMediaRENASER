"""Etiquetas sociales: extraerlas del texto, normalizarlas y contarlas.

POR QUE ESTA APARTE. Es la MISMA lecccion que `temas_de_contenido.py`: lo
escribe el router de contenido (al publicar y al editar) y lo lee tambien la
busqueda y la pantalla de una etiqueta. Metido en el router, cualquiera que
necesitara normalizar una etiqueta tendria que importar medio modulo de
endpoints. Aqui solo hay texto, validacion y escritura.

NO CONFUNDIR CON LOS TEMAS. `topics`/`post_topics` (migracion 0027) es la
taxonomia CERRADA del producto: 25 temas sembrados, elegidos de una lista, y es
lo que el recomendador cruza con lo que cada persona dijo que busca. Los
hashtags son vocabulario ABIERTO de la gente: nacen al escribirlos. Conviven,
y este fichero no toca `post_topics` ni de lejos.

EL SERVIDOR EXTRAE, EL CLIENTE NO MANDA LISTA. Y no es desconfianza gratuita:
si el cliente mandara la lista, cualquiera podria colgar su publicacion de
#python sin que la palabra aparezca en el texto. Eso es la definicion de spam
de etiquetas, y la unica forma de que no ocurra es que la etiqueta y el texto
salgan de la misma fuente.
"""

from __future__ import annotations

import re
import unicodedata

from sqlalchemy import delete, func, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.content.models import Hashtag, Post, PostHashtag, _uuid
from app.modules.recommendations import esquema

#: Cuantas etiquetas se INDEXAN por publicacion.
#:
#: POR QUE 10, Y POR QUE HAY UN LIMITE. El cuerpo admite 3.000 caracteres, asi
#: que sin tope una sola publicacion podria escribir doscientas etiquetas y
#: meter doscientas filas en `post_hashtags`. Eso no es un problema de tamano:
#: es el patron clasico de spam de etiquetas —«#sigueme #like #f4f»— con el que
#: una publicacion irrelevante aparece en todas las busquedas a la vez.
#:
#: Diez es holgado para lo que hace la gente de verdad (la mayoria usa entre
#: una y cinco) y estrecho para quien quiera inundar. Instagram permite 30 y
#: por eso las publicaciones de Instagram llevan 30.
MAX_HASHTAGS_POR_PUBLICACION = 10

#: Longitud maxima de una etiqueta, sin la almohadilla. Cincuenta es mas de lo
#: que mide cualquier etiqueta real; el tope existe para que un texto sin
#: espacios no acabe siendo una etiqueta de dos mil caracteres en un indice.
MAX_LONGITUD = 50

#: Que se reconoce como etiqueta dentro del texto.
#:
#: - La almohadilla tiene que ir precedida de algo que NO sea parte de una
#:   palabra. Asi «C#» no crea la etiqueta «#» ni «correo#interno» crea una
#:   etiqueta a mitad de palabra.
#: - Despues, letras (de cualquier alfabeto: `\w` con Unicode), digitos y guion
#:   bajo. Se corta en el primer espacio, punto, coma o almohadilla siguiente,
#:   que es como lo escribe todo el mundo.
#:
#: Deliberadamente NO incluye el guion medio: «#salud-mental» son en la practica
#: dos palabras, y aceptarlo obligaria a decidir si «#salud-mental» y
#: «#saludmental» son la misma etiqueta, que es una discusion sin final.
_ETIQUETA = re.compile(r"(?<!\w)#(\w{1,%d})" % MAX_LONGITUD, re.UNICODE)

#: Marcador temporal para proteger la eñe mientras se quitan las tildes.
#: Un caracter de uso privado de Unicode: no puede aparecer en un texto real.
_ENE = "\ue000"


def normalizar(bruto: str) -> str | None:
    """La forma unica de una etiqueta, o `None` si eso no es una etiqueta.

    QUE HACE Y POR QUE, en orden:

    1. Minusculas. #IA, #ia y #Ia tienen que ser LA MISMA etiqueta. Si no lo
       fueran, la etiqueta se parte en tres y ninguna de las tres tiene
       publicaciones suficientes para servir de nada. Esto es lo unico que
       pidio el encargo y es lo mas importante que hace esta funcion.

    2. Quita las tildes, PERO NO LA EÑE. Esto no es un capricho: en un teclado
       de movil «#programacion» se escribe sin tilde la mitad de las veces, y
       una etiqueta que se parte en dos por un acento esta rota. Pero la eñe NO
       es una ene con un adorno, es otra letra: colapsarla convertiria «#años»
       en «#anos», que ademas de ser otra palabra es una palabra desafortunada.
       Por eso se protege antes de descomponer y se restaura despues. La
       dieresis si se quita («#pinguino» = «#pingüino»), porque ahi si es una
       marca de pronunciacion sobre la misma letra.

    3. Exige AL MENOS UN CARACTER QUE NO SEA DIGITO. En castellano se escribe
       «Consejo #1, consejo #2» constantemente: sin esta regla, cada lista
       numerada de la aplicacion crearia etiquetas basura «#1» y «#2» que no
       significan nada y que ademas se mezclarian entre publicaciones que no
       tienen nada que ver. Es la misma regla que usa Twitter, y por lo mismo.

    Devuelve la etiqueta SIN almohadilla. `None` significa «esto no llega a ser
    una etiqueta», y quien llama lo descarta sin dar error: no se escribe para
    complacer a un validador.
    """
    limpio = (bruto or "").strip().lstrip("#").strip()
    if not limpio:
        return None

    # Se protege la eñe ANTES de descomponer; si no, NFD la parte en n + tilde
    # y el paso siguiente se llevaria la tilde por delante.
    protegido = limpio.replace("ñ", _ENE).replace("Ñ", _ENE)
    descompuesto = unicodedata.normalize("NFD", protegido)
    sin_tildes = "".join(c for c in descompuesto if unicodedata.category(c) != "Mn")
    plano = unicodedata.normalize("NFC", sin_tildes).replace(_ENE, "ñ").lower()

    # Se queda solo con lo que vale dentro de una etiqueta. Lo demas no se
    # sustituye por nada: «#salud.mental» se corto ya en la extraccion, y aqui
    # solo llega texto que alguien escribio a mano en una URL o en un test.
    valido = "".join(c for c in plano if c.isalnum() or c == "_")
    if not valido or len(valido) > MAX_LONGITUD:
        return None
    if valido.isdigit():
        # «#1», «#2024»: numeracion, no etiqueta. Ver el punto 3 de arriba.
        return None
    return valido


def extraer(texto: str) -> list[tuple[str, str]]:
    """Las etiquetas de un texto: `(normalizada, como se escribio)`.

    EN ORDEN DE APARICION y SIN REPETIR. Escribir «#ia» tres veces en el mismo
    texto es enfasis, no tres etiquetas: la primera aparicion es la que manda,
    y es tambien la que decide como se muestra si la etiqueta es nueva.

    Se corta en `MAX_HASHTAGS_POR_PUBLICACION`, y esa decision merece
    explicacion: se quedan las PRIMERAS y las demas se ignoran, en vez de
    rechazar la publicacion entera.

    Rechazarla habria sido lo coherente con `temas_de_contenido.validar`, pero
    ahi la lista la eligio la persona de un selector y devolversela tiene
    sentido. Aqui la lista sale de su propio texto: negarse a publicar porque
    alguien escribio once almohadillas es perder el texto entero por una
    costumbre de formato. Y nada de lo que escribio se pierde —el cuerpo se
    guarda tal cual, con sus once almohadillas visibles—: lo unico que se corta
    es el indexado. El movil avisa del tope MIENTRAS se escribe (ver
    `EtiquetasDelTexto`), que es donde el aviso sirve para algo.
    """
    vistas: dict[str, str] = {}
    for encontrado in _ETIQUETA.finditer(texto or ""):
        bruto = encontrado.group(1)
        clave = normalizar(bruto)
        if clave is None or clave in vistas:
            continue
        vistas[clave] = bruto
        if len(vistas) >= MAX_HASHTAGS_POR_PUBLICACION:
            break
    return list(vistas.items())


async def _ids_de(db: AsyncSession, etiquetas: list[tuple[str, str]]) -> list[str]:
    """Los ids de esas etiquetas, creando las que todavia no existen.

    Se leen primero las que ya hay y solo se insertan las que faltan, en vez de
    intentar insertarlas todas y capturar el conflicto: en PostgreSQL una
    sentencia fallida deja la transaccion inservible, asi que un choque a mitad
    de publicar se llevaria la publicacion por delante.

    Queda una ventana pequeña —dos personas estrenando la misma etiqueta en el
    mismo instante— y ahi manda el indice unico de la migracion: uno de los dos
    recibe el conflicto y reintenta publicar. Es preferible a que la etiqueta
    se duplique en silencio y se parta en dos para siempre.
    """
    if not etiquetas:
        # TRAMPA CONOCIDA: `columna.in_([])` cuela en SQLite y PostgreSQL lo
        # rechaza, y el manejador de DBAPIError lo convierte en un 404 mudo.
        # Lista vacia = no se consulta.
        return []

    claves = [clave for clave, _ in etiquetas]
    existentes = {
        fila.tag: fila.id
        for fila in (
            await db.execute(select(Hashtag.id, Hashtag.tag).where(Hashtag.tag.in_(claves)))
        ).all()
    }

    nuevas = [(c, m) for c, m in etiquetas if c not in existentes]
    if nuevas:
        # `insert()` con columnas EXPLICITAS y no `db.add(Hashtag(...))`: el ORM
        # insertaria todas las columnas del modelo, asi que el dia que la tabla
        # real tenga una columna que este fichero no conoce, publicar
        # reventaria en produccion y funcionaria en las pruebas.
        #
        # El id se genera aqui en vez de dejarselo a `gen_random_uuid()` porque
        # hace falta INMEDIATAMENTE para escribir `post_hashtags`, y pedirselo
        # a la base obligaria a un RETURNING que no se comporta igual en
        # PostgreSQL y en SQLite.
        filas = [
            {"id": _uuid(), "tag": clave, "display_tag": escrita[:MAX_LONGITUD]}
            for clave, escrita in nuevas
        ]
        await db.execute(insert(Hashtag), filas)
        for fila in filas:
            existentes[fila["tag"]] = fila["id"]

    # En el orden en que se escribieron, que es el que decidio quien publica.
    return [existentes[clave] for clave in claves if clave in existentes]


async def fijar(db: AsyncSession, post_id: str, texto: str) -> None:
    """Deja la publicacion con EXACTAMENTE las etiquetas de su texto. No hace commit.

    Es un reemplazo, no una suma: editar un texto para QUITAR una almohadilla
    tiene que quitar la etiqueta. Y borra solo las de ESTA publicacion.

    El commit lo hace quien llama, para que la publicacion y sus etiquetas
    entren juntas: una publicacion guardada sin sus etiquetas no aparece en
    ninguna busqueda y nadie se entera de que falta.
    """
    if not await esquema.hay_hashtags(db):
        # Sin la 0031 no hay donde guardarlas. Se publica igual —el texto con
        # sus almohadillas se guarda tal cual— y no se indexa nada. Lo que no
        # puede pasar es que no se pueda publicar por esto.
        return

    await db.execute(delete(PostHashtag).where(PostHashtag.post_id == post_id))
    ids = await _ids_de(db, extraer(texto))
    if ids:
        await db.execute(
            insert(PostHashtag),
            [{"post_id": post_id, "hashtag_id": hid} for hid in ids],
        )


async def leer(db: AsyncSession, post_ids: list[str]) -> dict[str, list[str]]:
    """Las etiquetas de varias publicaciones, de UNA consulta.

    Devuelve la forma que se PINTA (`display_tag`), porque es lo que va a la
    tarjeta del feed. Lo consume el feed entero de golpe: con veinte
    publicaciones, una consulta por fila serian veinte viajes para pintar unas
    etiquetas.
    """
    if not post_ids:
        return {}
    if not await esquema.hay_hashtags(db):
        # Ninguna publicacion tiene etiquetas porque la tabla no existe. Vacio
        # es la respuesta correcta, no un error.
        return {}
    filas = (
        await db.execute(
            select(PostHashtag.post_id, Hashtag.display_tag)
            .join(Hashtag, Hashtag.id == PostHashtag.hashtag_id)
            .where(PostHashtag.post_id.in_(post_ids))
            .order_by(PostHashtag.created_at, Hashtag.tag)
        )
    ).all()
    salida: dict[str, list[str]] = {}
    for post_id, display in filas:
        salida.setdefault(post_id, []).append(display)
    return salida


def _publicaciones_visibles():
    """Subconsulta: cuantas publicaciones PUBLICADAS tiene cada etiqueta.

    Que sean solo las publicadas no es un detalle de rendimiento: si contara
    tambien los borradores y lo retirado, la pantalla de una etiqueta diria
    «12 publicaciones» y ensenaria ocho. Un numero que no cuadra con la lista
    que hay debajo es peor que no poner numero.
    """
    return (
        select(func.count())
        .select_from(PostHashtag)
        .join(Post, Post.id == PostHashtag.post_id)
        .where(PostHashtag.hashtag_id == Hashtag.id, Post.status == "published")
        .scalar_subquery()
    )


async def buscar(db: AsyncSession, termino: str, limite: int = 10) -> list[dict]:
    """Etiquetas que empiezan por el termino, las mas usadas primero.

    POR PREFIJO Y NO POR «CONTIENE». Quien escribe «pyt» busca «#python», no
    «#micropython»: el prefijo es lo que la gente espera y ademas es lo unico
    que puede usar el indice. Un `%pyt%` recorreria la tabla entera.

    Se ordena por numero de publicaciones porque una etiqueta con 200
    publicaciones es mas util que una que uso una persona una vez, y con el
    empate resuelto por nombre para que el orden sea estable entre peticiones.
    """
    if not await esquema.hay_hashtags(db):
        return []
    clave = normalizar(termino)
    if not clave:
        return []
    cuenta = _publicaciones_visibles()
    filas = (
        await db.execute(
            select(Hashtag.tag, Hashtag.display_tag, cuenta.label("total"))
            # `like` y no `ilike`: `tag` ya esta en minusculas por construccion,
            # asi que `ilike` solo anadiria trabajo y estropearia el indice.
            .where(Hashtag.tag.like(f"{clave}%"))
            .order_by(cuenta.desc(), Hashtag.tag)
            .limit(limite)
        )
    ).all()
    return [
        {"tag": tag, "display_tag": display, "posts_count": total or 0}
        for tag, display, total in filas
    ]


async def detalle(db: AsyncSession, nombre: str) -> dict | None:
    """La etiqueta y su cuenta REAL de publicaciones, o `None` si no existe.

    `None` no es un error: una etiqueta que nadie ha usado todavia no existe
    como fila, y la pantalla sabe decir «todavia no hay publicaciones» sin
    necesidad de un 404 que pareceria una ruta mal escrita.
    """
    if not await esquema.hay_hashtags(db):
        return None
    clave = normalizar(nombre)
    if not clave:
        return None
    cuenta = _publicaciones_visibles()
    fila = (
        await db.execute(
            select(Hashtag.tag, Hashtag.display_tag, cuenta.label("total")).where(
                Hashtag.tag == clave
            )
        )
    ).first()
    if fila is None:
        return None
    return {"tag": fila[0], "display_tag": fila[1], "posts_count": fila[2] or 0}


async def ids_de_publicaciones(
    db: AsyncSession, nombre: str, *, limite: int, desplazamiento: int
) -> list[str]:
    """Ids de las publicaciones de una etiqueta, de la mas nueva a la mas vieja.

    Devuelve IDS y no publicaciones montadas: quien llama ya sabe armar una
    tarjeta de feed con su autor, sus medios y sus contadores
    (`leer_posts_por_id`), y duplicar esas cuatro consultas aqui seria pedir
    que se desincronicen.
    """
    if not await esquema.hay_hashtags(db):
        return []
    clave = normalizar(nombre)
    if not clave:
        return []
    filas = (
        await db.execute(
            select(Post.id)
            .join(PostHashtag, PostHashtag.post_id == Post.id)
            .join(Hashtag, Hashtag.id == PostHashtag.hashtag_id)
            .where(Hashtag.tag == clave, Post.status == "published")
            # Desempate por id: dos publicaciones pueden compartir instante y
            # sin un orden total la paginacion podria saltarse una o repetirla.
            .order_by(Post.created_at.desc(), Post.id.desc())
            .limit(limite)
            .offset(desplazamiento)
        )
    ).all()
    return [fila[0] for fila in filas]
