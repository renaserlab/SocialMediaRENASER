"""Las garantías que protegen el temario cuando se edita por la API.

QUÉ SE CIERRA AQUÍ. El editor del móvil escribía `course_modules` y
`course_lessons` DIRECTAMENTE contra PostgREST. Funcionaba —la RLS de la 0012
decide quién puede—, pero pasaba por encima de todo lo demás: un autor podía
reescribir el temario de un curso ya vendido y no quedaba ni una línea diciendo
que ocurrió. `test_una_orden_historica_se_queda_sin_version` lo dejó escrito con
todas las letras: «no hay forma de saber qué contenido se vendió».

LAS TRES COSAS QUE ESTE MÓDULO SOSTIENE, y ninguna es un adorno:

  * **La versión vigente no se toca.** Editar el temario NO crea una versión
    nueva —eso pasa al PUBLICAR, y ya está resuelto en `versiones.py`— pero
    tampoco puede reescribir la que hay: es lo que alguien compró, y el
    disparador `course_versions_inmutable` de la 0050 lo rechaza en la base. Lo
    que sí queda es la nota de auditoría, con el estado del curso y el número
    de versión sobre la que se editó.
  * **Un doble toque no crea dos módulos.** Y no con un «mira si existe y si no
    inserta», que dos peticiones simultáneas se pasan por delante: el id de la
    fila SE DERIVA de la clave de idempotencia, así que la segunda inserción
    choca contra la clave primaria. Lo garantiza la base, no un `if`.
  * **Nadie guarda encima de lo que otro cambió.** `If-Match` con la huella de
    la versión vigente convierte «se me borró el módulo que acababa de escribir»
    en un 409 que dice qué esperaba el cliente y qué hay de verdad.
"""

from __future__ import annotations

import uuid

from sqlalchemy import ColumnElement, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, ValidationAppError
from app.modules.catalog import versiones
from app.modules.catalog.models import Course, CourseVersion

#: Espacio de nombres de los identificadores derivados. ES UNA CONSTANTE Y NO
#: SE CAMBIA: cambiarlo haría que la misma clave de idempotencia produjera otro
#: id, y el reintento que llega después del despliegue crearía el módulo
#: duplicado que esto existe para evitar.
_ESPACIO = uuid.UUID("0f6a3f0e-6b7d-5a4b-9c1e-2d8f7a1b4c30")


def id_idempotente(ambito: str, actor_id: str, clave: str | None) -> str | None:
    """El id que le toca a esta creación, o `None` si nadie mandó clave.

    POR QUÉ SE DERIVA EL ID Y NO SE GUARDA LA CLAVE EN UNA TABLA APARTE. Porque
    una tabla nueva es una migración, y las migraciones de este proyecto se
    aplican a mano y esperan aprobación. Derivando el id, la unicidad la sostiene
    la CLAVE PRIMARIA que ya existe: la segunda inserción con la misma clave
    revienta contra ella y quien llama devuelve la fila que ya estaba.

    EL ÁMBITO Y EL ACTOR ENTRAN EN LA HUELLA. Sin el ámbito, la misma clave
    reusada en otro curso devolvería el módulo del primero. Sin el actor, una
    administración y el autor mandando por casualidad la misma cadena —«1», que
    es lo que manda un cliente mal escrito— se pisarían el módulo.

    Es `uuid5` y no un hash cualquiera porque la columna es UUID: cualquier otra
    cosa la rechaza el propio tipo.
    """
    if not clave or not clave.strip():
        return None
    return str(uuid.uuid5(_ESPACIO, f"{ambito}:{actor_id}:{clave.strip()}"))


async def exigir_version_esperada(
    db: AsyncSession, course_id: str, if_match: str | None
) -> CourseVersion | None:
    """La versión vigente del curso, comprobando antes lo que el cliente esperaba.

    SIN `If-Match` NO SE COMPRUEBA NADA, y es a propósito: obligar a mandarla
    rompería a los clientes instalados y convertiría una garantía opcional en
    una barrera. Quien la manda, la cobra.

    409 Y NO 412. El 412 de HTTP es lo canónico para una precondición fallida,
    pero este API tiene UN solo formato de error y el móvil ya sabe leer un 409
    con su `code` y sus `details`; lo que hace falta es que el cliente pueda
    decir «esto cambió por debajo, vuelve a cargarlo», y para eso importa el
    cuerpo, no el número.

    SE ACEPTAN LAS COMILLAS de un ETag (`If-Match: "abc"`) porque cualquier
    cliente que use la cabecera de forma estándar las manda; compararlas con la
    huella pelada daría un 409 en la primera petición correcta.
    """
    vigente = await versiones.vigente(db, course_id)
    if if_match is None:
        return vigente

    esperado = if_match.strip().strip('"')
    actual = vigente.content_hash if vigente is not None else None
    if esperado != actual:
        raise ConflictError(
            "El curso cambió desde que lo abriste. Vuelve a cargarlo antes de guardar.",
            code="course_version_mismatch",
            details={
                "expected": esperado,
                # `None` cuando el curso todavía no tiene versión publicada. Es
                # una respuesta, no un hueco: dice que no hay nada que casar.
                "current": (
                    {"version": vigente.version, "content_hash": vigente.content_hash}
                    if vigente is not None
                    else None
                ),
            },
        )
    return vigente


def nota_de_contexto(curso: Course, version: CourseVersion | None) -> dict:
    """Lo que la auditoría necesita saber de una edición del temario.

    SOLO IDENTIFICADORES Y ESTADOS. Ni títulos ni cuerpos de lección: el rastro
    sirve para reconstruir QUÉ pasó y CUÁNDO, no para archivar el contenido, y
    `audit_events.payload` se sirve por `GET /admin/audit-events`.

    `version` es la clave de todo esto: dice sobre qué fotografía se editó. Un
    curso publicado editado por debajo de su versión vigente es exactamente el
    caso que había que poder investigar.
    """
    return {
        "course_status": curso.status,
        "version": version.version if version is not None else None,
    }


async def siguiente_posicion(
    db: AsyncSession, columna: ColumnElement[int], condicion: ColumnElement[bool]
) -> int:
    """La posición que le toca a lo próximo que se cree: al final de la lista.

    POR QUÉ NO LA ELIGE EL CLIENTE. Porque dos elementos con el mismo
    `sort_order` dejan el temario a merced de cómo devuelva las filas la base,
    que es lo mismo que no tener orden: el alumno ve las lecciones bailar entre
    dos cargas de la misma pantalla. Crear siempre añade al final y el orden se
    cambia en un solo sitio —`reorder`—, que reescribe la lista entera.
    """
    ultima = await db.scalar(select(func.max(columna)).where(condicion))
    return 0 if ultima is None else int(ultima) + 1


def exigir_orden_completo(actuales: list[str], pedidos: list[str]) -> None:
    """Reordenar es mandar la lista ENTERA, sin repetidos ni intrusos.

    UNA REORDENACIÓN PARCIAL NO ES UNA REORDENACIÓN. Si el cliente manda tres de
    los cinco módulos, los otros dos se quedan con la posición que tenían y
    empatan con los nuevos; el resultado no es «casi el orden pedido», es un
    orden que no pidió nadie y que además cambia entre consultas.

    Y se comprueba ANTES de escribir: aceptar la mitad y fallar por el intruso
    dejaría el temario a medio ordenar.
    """
    if len(set(pedidos)) != len(pedidos):
        raise ValidationAppError(
            "La lista de orden trae elementos repetidos.",
            code="course_order_invalid",
        )
    if set(pedidos) != set(actuales):
        raise ValidationAppError(
            "Para reordenar hay que mandar la lista completa y solo sus elementos.",
            code="course_order_invalid",
            details={"expected": len(actuales), "received": len(pedidos)},
        )
