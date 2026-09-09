"""El aforo, y la única forma de que dos personas no se lleven el mismo asiento.

EL FALLO QUE ESTO CIERRA. La reserva hacía tres cosas en este orden:

    contar inscritos  ->  comparar con `capacity`  ->  insertar la reserva

Entre el conteo y la inserción no había nada. Dos peticiones simultáneas leían
las dos el mismo conteo, las dos veían un hueco libre y las dos insertaban. La
clave única `(event_id, user_id)` impedía que UNA persona se duplicara, y por
eso el fallo no se veía probando a mano: hacen falta dos cuentas distintas
pulsando a la vez. El resultado eran 51 inscritos en un aforo de 50, sin ningún
error en el registro.

POR QUÉ NO SIRVE UN CERROJO EN MEMORIA. Un `asyncio.Lock` solo ordena las
corrutinas de UN proceso. La API corre con varios trabajadores y puede correr
con varias réplicas; dos procesos distintos no comparten ese cerrojo y el
problema vuelve entero. El árbitro tiene que ser la base de datos, que es lo
único que los dos ven.

POR QUÉ NO UN ÍNDICE. Un índice único puede impedir que dos filas sean iguales,
pero no puede contar cuántas hay: «como mucho N» no es una propiedad de una
fila, es una propiedad del conjunto. Eso solo lo sostiene una transacción que
serialice a quien escribe.

LA SOLUCIÓN, en una transacción y en este orden:

    1. `select ... for update` sobre la FILA DEL EVENTO
    2. ¿se puede reservar?  (publicado, no pasado, no suspendido)
    3. ¿ya está inscrita esta persona?  -> se le devuelve la suya
    4. contar reservas activas
    5. comparar con el aforo aprobado
    6. insertar
    7. confirmar

El bloqueo de la fila del evento es lo que ordena a los competidores: la segunda
petición se queda esperando en el paso 1 y no llega al paso 4 hasta que la
primera ha confirmado, así que cuenta lo que hay DESPUÉS y ve el aforo lleno.

EL EVENTO SE BLOQUEA TAMBIÉN PARA CANCELAR, y por el mismo motivo: si cancelar
no tomara el cerrojo, una cancelación podría colarse entre el conteo y la
inserción y el hueco que libera se contaría dos veces.

EN SQLITE NO HAY `FOR UPDATE` y SQLAlchemy lo omite al compilar. Las pruebas de
SQLite comprueban LAS REGLAS —lleno, pasado, no publicado, doble toque—; que la
carrera se serialice de verdad solo se puede probar contra PostgreSQL, y eso
está en `tests/test_aforo_concurrente_postgres.py`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError
from app.modules.catalog import eventos
from app.modules.catalog.models import Event, EventRegistration
from app.modules.events import esquema, states

#: Las reservas que ocupan sitio. `cancelled` no ocupa: quien cancela devuelve
#: su plaza, y contarla dejaría el evento lleno para siempre.
ACTIVAS = ("confirmed",)


@dataclass(frozen=True)
class Resultado:
    """Cómo quedó el evento después de la operación.

    Se devuelve el conteo YA LEÍDO dentro de la transacción que lo cambió: pedir
    el número otra vez fuera del bloqueo da un valor que puede haber cambiado y
    convierte la respuesta en una aproximación.
    """

    evento: Event
    inscritos: int
    reservada: bool
    #: La fila operativa, para que quien responda pueda decir si lleva sello.
    operacion: object | None = None


def aforo_de(evento: Event, aprobado: int | None = None) -> int | None:
    """El aforo que manda, o `None` si el evento no tiene límite.

    `approved_capacity` es lo que la admisión autorizó y `capacity` lo que el
    organizador declaró. Mandan en ese orden porque no significan lo mismo: un
    evento puede pedir 300 y recibir permiso para 200, y admitir 300 sería
    admitir lo que nadie aprobó.

    Cero NO es «sin límite»: es «no cabe nadie». Se respeta tal cual.
    """
    if aprobado is not None:
        return int(aprobado)
    if evento.capacity is not None:
        return int(evento.capacity)
    return None


async def _operacion(db: AsyncSession, evento_id: str):
    """La fila operativa del evento, o `None` sin la 0060 aplicada.

    Se lee DENTRO del bloqueo, no antes: el aforo aprobado y el estado del
    ciclo son justo lo que hay que mirar sin que nadie los cambie a la vez.
    """
    if not await esquema.hay_eventos_v2(db):
        return None
    from app.modules.events.models import EventOperations

    return await db.get(EventOperations, evento_id)


async def bloquear_evento(db: AsyncSession, evento_id: str) -> Event:
    """La fila del evento, bloqueada hasta que la transacción termine.

    Este es el punto de serialización de todo el módulo. Todas las rutas que
    crean o cancelan reservas pasan por aquí y en el mismo orden, que es lo que
    evita que dos operaciones se bloqueen la una a la otra.
    """
    evento = await db.scalar(
        select(Event).where(Event.id == evento_id).with_for_update()
    )
    if evento is None:
        raise NotFoundError("Evento no encontrado.")
    return evento


async def contar(db: AsyncSession, evento_id: str) -> int:
    """Las reservas que ocupan sitio ahora mismo."""
    valor = await db.scalar(
        select(func.count())
        .select_from(EventRegistration)
        .where(
            EventRegistration.event_id == evento_id,
            EventRegistration.status.in_(ACTIVAS),
        )
    )
    return valor or 0


async def _mia(db: AsyncSession, evento_id: str, usuario_id: str) -> EventRegistration | None:
    return await db.scalar(
        select(EventRegistration).where(
            EventRegistration.event_id == evento_id,
            EventRegistration.user_id == usuario_id,
        )
    )


async def reservar(
    db: AsyncSession, *, evento_id: str, usuario_id: str, momento: datetime
) -> Resultado:
    """Apunta a alguien, o explica por qué no.

    REPETIR LA MISMA PETICIÓN NO CONSUME OTRO CUPO: si esa persona ya está
    inscrita se le devuelve su reserva y el conteo sin tocar nada. Es lo que
    hace que un doble toque, un reintento de la red o un botón pulsado dos veces
    den la misma respuesta.
    """
    evento = await bloquear_evento(db, evento_id)
    operacion = await _operacion(db, evento_id)

    ya = await _mia(db, evento_id, usuario_id)
    if ya is not None and ya.status in ACTIVAS:
        # Nada que escribir. Se CONFIRMA igual —no se hace `rollback`— porque
        # confirmar suelta el cerrojo sin expirar los objetos ya leídos, y
        # quien llama todavía necesita leer el evento para responder.
        inscritos = await contar(db, evento_id)
        await db.commit()
        return Resultado(evento, inscritos, True, operacion)

    workflow = operacion.workflow_status if operacion else None
    if not states.se_puede_saber_que_existe(workflow, evento.status):
        # 404 Y NO 409. Un borrador ajeno no existe para quien no lo organiza:
        # contestar «no admite reservas» ya cuenta que alguien prepara algo.
        await db.rollback()
        raise NotFoundError("Evento no encontrado.")

    motivo = states.motivo_para_no_reservar(evento, momento, workflow)
    if motivo is not None:
        # SE SUELTA EL CERROJO ANTES DE LANZAR. Sin esto, la fila del evento
        # sigue bloqueada mientras FastAPI serializa la respuesta de error, y
        # un evento popular con gente reintentando encadena esperas hasta
        # agotar el pool de conexiones: se para la API entera, no ese evento.
        await db.rollback()
        raise ConflictError(motivo)

    aforo = aforo_de(evento, operacion.approved_capacity if operacion else None)
    if aforo is not None and await contar(db, evento_id) >= aforo:
        await db.rollback()
        raise ConflictError("El evento alcanzó su capacidad máxima.")

    if ya is not None:
        # Una reserva cancelada que se reactiva. No se inserta otra fila: la
        # clave es `(event_id, user_id)` y ya existe.
        ya.status = "confirmed"
    else:
        try:
            # SAVEPOINT, no la transacción entera. Si el choque ocurre —y con el
            # bloqueo puesto solo puede ocurrir por un camino que no pase por
            # aquí— se deshace ESTA inserción y no el trabajo de nadie más.
            async with db.begin_nested():
                db.add(
                    EventRegistration(
                        event_id=evento_id, user_id=usuario_id, status="confirmed"
                    )
                )
        except IntegrityError:
            # La única colisión que esta operación puede provocar es la clave
            # `(event_id, user_id)`, y significa exactamente «ya estaba». No se
            # silencia ningún otro error: cualquier otro sube.
            #
            # ESTA RAMA NO ESTÁ PROBADA, Y NO SE PUEDE PROBAR. Con el cerrojo
            # puesto y siendo estas dos funciones las únicas que escriben en
            # `event_registrations`, el choque no puede ocurrir: nadie más llega
            # a insertar mientras la fila del evento está tomada. Se deja porque
            # el día que aparezca otro escritor —una lista de espera, una
            # importación— el fallo sería una plaza perdida y no un error
            # visible. Que quede dicho que es defensa sin verificar.
            existente = await _mia(db, evento_id, usuario_id)
            if existente is None:
                raise
            existente.status = "confirmed"

    # EL CONTEO SE LEE DENTRO DEL CERROJO, antes de confirmar. Leerlo después
    # abre una transacción nueva y devuelve un número que ya ha cambiado: quien
    # acaba de apuntarse recibiría el conteo de los que entraron detrás.
    await db.flush()
    inscritos = await contar(db, evento_id)
    await db.commit()
    return Resultado(evento, inscritos, True, operacion)


async def cancelar(
    db: AsyncSession, *, evento_id: str, usuario_id: str
) -> Resultado:
    """Devuelve la plaza. Cancelar lo que no existe no es un error.

    Toma el MISMO cerrojo que reservar, en el mismo orden: sin él, la plaza que
    se libera podría contarse dos veces por dos reservas simultáneas.
    """
    evento = await bloquear_evento(db, evento_id)
    operacion = await _operacion(db, evento_id)
    # LA MISMA PUERTA QUE AL RESERVAR, y faltaba. `cancelar` devuelve la ficha
    # entera del evento —titulo, descripcion, recinto, aforo, organizador—, asi
    # que sin esta comprobacion bastaba con tener el id de un borrador ajeno
    # para leerlo: 200 aqui y 404 en la ficha decian cosas distintas del mismo
    # evento.
    if not states.se_puede_saber_que_existe(
        operacion.workflow_status if operacion else None, evento.status
    ):
        await db.rollback()
        raise NotFoundError("Evento no encontrado.")

    ya = await _mia(db, evento_id, usuario_id)
    if ya is not None:
        await db.delete(ya)
        await db.flush()
    inscritos = await contar(db, evento_id)
    await db.commit()
    return Resultado(evento, inscritos, False, operacion)


async def esta_lleno(
    db: AsyncSession, evento: Event, aprobado: int | None = None
) -> bool:
    """Si ya no quedan plazas. Sin aforo, nunca.

    Es lo que hace que `SOLD_OUT` se DERIVE del aforo en vez de escribirse a
    mano: un estado guardado se queda mintiendo en cuanto alguien cancela.
    """
    aforo = aforo_de(evento, aprobado)
    if aforo is None:
        return False
    return await contar(db, evento.id) >= aforo


def es_pasado(evento: Event, momento: datetime) -> bool:
    return eventos.estado_de(evento, momento) == eventos.ANTERIOR
