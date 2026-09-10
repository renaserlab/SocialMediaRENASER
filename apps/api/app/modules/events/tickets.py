"""Entradas emitidas, credencial del QR y check-in.

LA CREDENCIAL NO SE GUARDA. Se guarda su `sha256`. El valor en claro se le
entrega UNA VEZ a quien compró, viaja dentro del QR de su teléfono y no vuelve
a existir en el servidor. Quien consiga leer la tabla —una copia de seguridad,
un volcado, una consulta de más— no puede fabricar un QR con lo que ve.

QUÉ VA DENTRO DEL QR. Un token opaco y nada más: ni nombre, ni correo, ni
precio, ni el identificador de la entrada. Un QR se fotografía, se comparte por
mensajería y acaba en la galería de fotos; cuanto menos diga, menos cuenta.

QUÉ NO ES ESTO. No hay reventa, ni transferencia, ni devolución de entradas.
Una entrada emitida es de quien la compró, y revocarla es una decisión de
administración con motivo, no un botón del comprador.
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import distinct, false as sa_false, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppError, NotFoundError
from app.modules.catalog.models import Event
from app.modules.events import inventory, states
from app.modules.events.models import (
    ENTRADA_REVOCADA,
    ENTRADA_USADA,
    ENTRADA_VALIDA,
    EventCheckin,
    EventOperations,
    EventOrder,
    EventOrderItem,
    EventTicket,
)

#: El alfabeto del código que se TECLEA. Sin `I`, `O`, `0` ni `1`: quien copia a
#: mano un código de la pantalla de otro teléfono los confunde, y un código mal
#: tecleado en la puerta es una cola.
_ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_LARGO_DEL_CODIGO = 14


def ahora() -> datetime:
    return datetime.now(timezone.utc)


def _codigo() -> str:
    return "".join(secrets.choice(_ALFABETO) for _ in range(_LARGO_DEL_CODIGO))


def _credencial() -> str:
    """El secreto que viaja en el QR. 256 bits, opaco y sin estructura."""
    return secrets.token_urlsafe(32)


def resumir(credencial: str) -> str:
    """`sha256` en hexadecimal. Es lo único que se guarda."""
    return hashlib.sha256(credencial.strip().encode("utf-8")).hexdigest()


class EntradaNoEncontrada(NotFoundError):
    code = "event_ticket_not_found"
    message = "Entrada no encontrada."


class NoSeAdmiteTodavia(AppError):
    status_code = 409
    code = "event_not_admitting"
    message = "Este evento no está admitiendo entradas ahora mismo."


# --------------------------------------------------------------------------- #
# Emisión
# --------------------------------------------------------------------------- #
@dataclass
class EntradaEmitida:
    """Una entrada recién creada y su credencial EN CLARO.

    La credencial solo existe aquí y en la respuesta que la lleva al teléfono.
    No se guarda, no se registra y no se vuelve a poder consultar.
    """

    entrada: EventTicket
    credencial: str


async def emitir(
    db: AsyncSession, *, orden: EventOrder, momento: datetime | None = None
) -> list[EventTicket]:
    """Emite EXACTAMENTE las entradas compradas. Sin `commit`.

    IDEMPOTENTE. Si la orden ya tiene entradas emitidas, no emite otras: un
    aviso repetido del proveedor no puede duplicar el aforo. La barrera de
    verdad no es este `if` —dos avisos a la vez lo pasarían los dos— sino el
    cerrojo de la fila de la orden que toma quien llama, y el disparador
    diferido de la 0062, que al confirmar cuenta entradas contra cantidades.
    """
    momento = momento or ahora()
    ya = await db.scalar(
        select(func.count()).select_from(EventTicket).where(EventTicket.order_id == orden.id)
    )
    if ya:
        return []

    lineas = list(
        await db.scalars(
            select(EventOrderItem)
            .where(EventOrderItem.order_id == orden.id)
            .order_by(EventOrderItem.ticket_type_id.asc())
        )
    )
    emitidas: list[EventTicket] = []
    for linea in lineas:
        for _ in range(int(linea.quantity)):
            entrada = EventTicket(
                event_id=orden.event_id,
                order_id=orden.id,
                order_item_id=linea.id,
                owner_id=orden.buyer_id,
                ticket_type_id=linea.ticket_type_id,
                ticket_type_name_snapshot=linea.ticket_type_name_snapshot,
                code=_codigo(),
                credential_hash=resumir(_credencial()),
                status=ENTRADA_VALIDA,
                issued_at=momento,
            )
            db.add(entrada)
            emitidas.append(entrada)
    await db.flush()
    return emitidas


async def credencial_de(
    db: AsyncSession, *, entrada_id: str, usuario_id: str
) -> tuple[EventTicket, str]:
    """Rota la credencial de una entrada y devuelve la nueva EN CLARO.

    POR QUÉ SE ROTA EN VEZ DE GUARDARLA. La credencial no está en la base, así
    que no se puede «volver a consultar»: pedir el QR otra vez —otro teléfono,
    la aplicación reinstalada— genera una nueva y deja la anterior inservible.
    Es un efecto buscado: un QR fotografiado y compartido deja de valer en
    cuanto la persona abre su entrada de nuevo.

    Y EL CÓDIGO ROTA CON ELLA. El código escrito debajo del QR también admite
    —es el camino de cuando la cámara falla— y viaja en la misma pantalla: quien
    fotografía la entrada se lleva los dos. Rotar solo el QR dejaba la defensa a
    medias, y la migración prometía lo contrario.
    """
    entrada = await db.scalar(
        select(EventTicket).where(EventTicket.id == entrada_id).with_for_update()
    )
    if entrada is None or entrada.owner_id != usuario_id:
        await db.rollback()
        raise EntradaNoEncontrada()
    if entrada.status != ENTRADA_VALIDA:
        # Una entrada usada o revocada no tiene credencial que dar: enseñar un
        # QR que la puerta va a rechazar es peor que decirlo aquí.
        await db.rollback()
        raise EntradaNoEncontrada(
            "Esa entrada ya no es válida.", code="event_ticket_not_valid"
        )
    credencial = _credencial()
    entrada.credential_hash = resumir(credencial)
    entrada.code = _codigo()

    # SE AUDITA, porque invalida el QR anterior. Una sesión robada que pida una
    # credencial nueva justo antes del evento deja a quien compró en la puerta
    # con una entrada que ya no vale, y hasta ahora eso no dejaba ni una línea.
    # NI LA CREDENCIAL NI EL CÓDIGO ENTRAN AQUÍ: es un rastro consultable.
    from app.modules.gobernanza import auditoria

    await auditoria.anotar(
        db,
        actor_id=usuario_id,
        actor_role="user",
        action="event.ticket.credential_rotated",
        entity_type="event_ticket",
        entity_id=entrada.id,
        payload={"evento": entrada.event_id},
    )
    await db.commit()
    return entrada, credencial


# --------------------------------------------------------------------------- #
# Verificación y check-in
# --------------------------------------------------------------------------- #
#: Lo que la puerta puede recibir como respuesta. Son los mismos valores que
#: guarda `event_checkins.result`, para que el histórico y la pantalla hablen
#: el mismo idioma.
OK = "OK"
YA_USADA = "ALREADY_USED"
REVOCADA = "REVOKED"
NO_EXISTE = "NOT_FOUND"
OTRO_EVENTO = "WRONG_EVENT"
SIN_ADMISION = "NOT_ADMITTING"


@dataclass
class Veredicto:
    """Lo que la puerta necesita saber, y NADA que no necesite.

    No lleva el nombre ni el correo de quien compró: el operador de la puerta
    tiene que decidir si pasa, no conocer a la persona. Lleva el tipo de entrada
    porque de eso depende por dónde entra.
    """

    resultado: str
    entrada_id: str | None = None
    tipo: str | None = None
    usada_a_las: datetime | None = None


#: Por dónde entró la credencial. Lo decide el SERVIDOR, mirando cuál de las
#: dos búsquedas encontró la fila; no lo declara el cliente.
#:
#: POR QUÉ IMPORTA. El camino tecleado es el débil —un código copiado de una
#: pantalla admite igual que el QR— y es justo el que no dejaba huella
#: distinguible: doscientos check-ins a mano desde la trastienda eran, en el
#: histórico, idénticos a doscientos escaneos legítimos. La pregunta que se hace
#: cuando algo va mal es «¿cuántos de estos entraron por teclado?», y no tenía
#: respuesta posible.
POR_QR = "qr"
POR_CODIGO = "code"
SIN_CANAL = "none"


async def _buscar(
    db: AsyncSession, *, credencial: str
) -> tuple[EventTicket | None, str]:
    """Por el `sha256` de la credencial, o por el código tecleado.

    Los dos caminos llevan a la misma fila. El código existe para cuando la
    cámara no funciona, y tiene su propia entropía: no es un número de serie.

    Devuelve TAMBIÉN por cuál de los dos entró, que es un dato del servidor y
    no una declaración del cliente: quien teclea no puede decir que escaneó.
    """
    limpia = (credencial or "").strip()
    if not limpia:
        return None, SIN_CANAL
    entrada = await db.scalar(
        select(EventTicket).where(EventTicket.credential_hash == resumir(limpia))
    )
    if entrada is not None:
        return entrada, POR_QR
    tecleada = await db.scalar(
        select(EventTicket).where(EventTicket.code == limpia.upper())
    )
    return tecleada, POR_CODIGO if tecleada is not None else SIN_CANAL


async def verificar(
    db: AsyncSession, *, evento_id: str, credencial: str, momento: datetime | None = None
) -> Veredicto:
    """Mira si esta credencial vale AHORA. No escribe nada.

    Existe aparte del check-in porque son dos preguntas distintas: «¿esto vale?»
    se puede hacer mil veces sin consecuencias, y «déjala pasar» solo una.
    """
    momento = momento or ahora()
    entrada, _canal = await _buscar(db, credencial=credencial)
    if entrada is None:
        return Veredicto(NO_EXISTE)
    if entrada.event_id != evento_id:
        # NO SE DICE DE QUÉ EVENTO ES. Quien está en la puerta de un sitio no
        # tiene por qué enterarse de a qué otro evento va esa persona.
        return Veredicto(OTRO_EVENTO)
    if entrada.status == ENTRADA_REVOCADA:
        return Veredicto(REVOCADA, entrada_id=entrada.id, tipo=entrada.ticket_type_name_snapshot)
    if entrada.status == ENTRADA_USADA:
        return Veredicto(
            YA_USADA,
            entrada_id=entrada.id,
            tipo=entrada.ticket_type_name_snapshot,
            usada_a_las=entrada.checked_in_at,
        )
    if not await _admite_entrada(db, entrada.event_id, momento):
        return Veredicto(SIN_ADMISION, entrada_id=entrada.id)
    return Veredicto(OK, entrada_id=entrada.id, tipo=entrada.ticket_type_name_snapshot)


async def check_in(
    db: AsyncSession,
    *,
    evento_id: str,
    credencial: str,
    operador_id: str,
    momento: datetime | None = None,
) -> Veredicto:
    """Deja pasar, UNA vez. Idempotente y con rastro.

    LA CARRERA REAL: dos lectores escaneando el mismo QR en el mismo segundo.
    Los dos leen `VALID`, los dos deciden dejar pasar. Lo que impide que las dos
    escrituras cuenten no es el `if` sino el `UPDATE ... WHERE status = 'VALID'`,
    que la base resuelve fila a fila: uno cambia una fila y el otro cero. Y por
    debajo, el índice único parcial de la 0062 sobre el check-in correcto.

    UN SEGUNDO ESCANEO NO VUELVE A ESCRIBIR: devuelve «ya utilizada» con la hora
    a la que entró, que es lo que la puerta necesita para decidir.
    """
    momento = momento or ahora()
    entrada, canal = await _buscar(db, credencial=credencial)
    if entrada is None:
        await _anotar(db, evento_id=evento_id, entrada=None, operador_id=operador_id,
                      resultado=NO_EXISTE, momento=momento, canal=canal)
        await db.commit()
        return Veredicto(NO_EXISTE)

    if entrada.event_id != evento_id:
        # SIN LA ENTRADA. Se deja constancia del INTENTO en el registro de ESTE
        # evento, no del identificador de una entrada de otro: escribirlo aquí
        # mezcla los historiales y acaba enseñando en la pantalla de un evento
        # identificadores que pertenecen a otro.
        await _anotar(db, evento_id=evento_id, entrada=None, operador_id=operador_id,
                      resultado=OTRO_EVENTO, momento=momento, canal=canal)
        await db.commit()
        return Veredicto(OTRO_EVENTO)

    if not await _admite_entrada(db, entrada.event_id, momento):
        suya = entrada.id
        await _anotar(db, evento_id=evento_id, entrada=entrada, operador_id=operador_id,
                      resultado=SIN_ADMISION, momento=momento, canal=canal)
        await db.commit()
        return Veredicto(SIN_ADMISION, entrada_id=suya)

    # LA ESCRITURA CONDICIONAL. Aquí está la garantía, no en las comprobaciones
    # de arriba: `where status = 'VALID'` deja pasar exactamente a uno.
    resultado = await db.execute(
        update(EventTicket)
        .where(EventTicket.id == entrada.id, EventTicket.status == ENTRADA_VALIDA)
        .values(status=ENTRADA_USADA, checked_in_at=momento, checked_in_by=operador_id)
    )
    # EL VEREDICTO SE ARMA ANTES DEL `commit`. Confirmar expira los objetos de
    # la sesión, y leerles un atributo después dispara una carga perezosa que en
    # asíncrono revienta con `MissingGreenlet`: la puerta recibiría un 500 sobre
    # un check-in que sí funcionó.
    identificador = entrada.id
    nombre = entrada.ticket_type_name_snapshot

    if resultado.rowcount == 1:
        await _anotar(db, evento_id=evento_id, entrada=entrada, operador_id=operador_id,
                      resultado=OK, momento=momento, canal=canal)
        await db.commit()
        return Veredicto(OK, entrada_id=identificador, tipo=nombre, usada_a_las=momento)

    # No se cambió ninguna fila: alguien llegó antes, o la entrada está
    # revocada. Se vuelve a leer para decir cuál de las dos cosas es.
    await db.rollback()
    fresca = await db.get(EventTicket, identificador)
    estado = fresca.status if fresca is not None else None
    entro_a_las = fresca.checked_in_at if fresca is not None else None
    if fresca is not None:
        nombre = fresca.ticket_type_name_snapshot

    if estado == ENTRADA_REVOCADA:
        await _anotar(db, evento_id=evento_id, entrada=fresca, operador_id=operador_id,
                      resultado=REVOCADA, momento=momento, canal=canal)
        await db.commit()
        return Veredicto(REVOCADA, entrada_id=identificador, tipo=nombre)

    await _anotar(db, evento_id=evento_id, entrada=fresca, operador_id=operador_id,
                  resultado=YA_USADA, momento=momento, canal=canal)
    await db.commit()
    return Veredicto(
        YA_USADA, entrada_id=identificador, tipo=nombre, usada_a_las=entro_a_las
    )


async def _anotar(
    db: AsyncSession,
    *,
    evento_id: str,
    entrada: EventTicket | None,
    operador_id: str,
    resultado: str,
    momento: datetime,
    canal: str = SIN_CANAL,
) -> None:
    """Cada intento queda, el bueno y los malos.

    Un `OK` repetido chocaría con el índice único parcial de la 0062, que es
    justo la invariante: se registra a lo sumo un check-in correcto por entrada.

    LO QUE DICE LA FILA, DICHO EN LOS CAMPOS QUE SE CONSULTAN. Antes todo se
    archivaba con `outcome='ok'` y `actor_role='system'`, así que un intento
    rechazado era indistinguible de uno correcto para cualquier consulta que no
    leyera el texto libre: una alerta de «intentos rechazados por operador» no
    disparaba nunca. Y cuando no hay entrada, la fila decía ser sobre una
    entrada y llevaba el identificador de un evento.
    """
    db.add(
        EventCheckin(
            ticket_id=entrada.id if entrada is not None else None,
            event_id=evento_id,
            operator_id=operador_id,
            result=resultado,
            created_at=momento,
        )
    )
    from app.modules.gobernanza import auditoria

    await auditoria.anotar(
        db,
        actor_id=operador_id,
        actor_role="user",
        action="event.checkin",
        # SIN ENTRADA, NO ES UNA ENTRADA. Una credencial inventada o de otro
        # evento no tiene fila que señalar aquí.
        entity_type="event_ticket" if entrada is not None else "event",
        entity_id=entrada.id if entrada is not None else evento_id,
        outcome="ok" if resultado == OK else "denied",
        new_state=resultado,
        payload={"evento": evento_id, "canal": canal},
    )


async def _admite_entrada(db: AsyncSession, evento_id: str, momento: datetime) -> bool:
    """Si el evento está admitiendo gente ahora mismo.

    Publicado y no suspendido. NO se exige que la hora de inicio haya llegado:
    la gente entra antes de que empiece, que es de lo que va abrir puertas.
    """
    evento = await db.get(Event, evento_id)
    if evento is None:
        return False
    operacion = await db.get(EventOperations, evento_id)
    workflow = operacion.workflow_status if operacion else None
    if not states.es_publico_de_verdad(workflow, evento.status):
        return False
    return not inventory.es_pasado(evento, momento)


# --------------------------------------------------------------------------- #
# Revocación
# --------------------------------------------------------------------------- #
async def revocar(
    db: AsyncSession,
    *,
    entrada_id: str,
    usuario_id: str,
    motivo: str,
    momento: datetime | None = None,
) -> EventTicket:
    """Retira una entrada. Con motivo, y sin borrarla.

    UNA ENTRADA USADA NO SE REVOCA: la persona ya entró, y cambiar el registro
    después convierte el histórico en algo que no se puede usar para nada.
    """
    momento = momento or ahora()
    entrada = await db.scalar(
        select(EventTicket).where(EventTicket.id == entrada_id).with_for_update()
    )
    if entrada is None:
        await db.rollback()
        raise EntradaNoEncontrada()
    if entrada.status == ENTRADA_REVOCADA:
        await db.commit()
        return entrada
    if entrada.status == ENTRADA_USADA:
        await db.rollback()
        raise AppError(
            "Esa entrada ya se usó: no se puede revocar.",
            code="event_ticket_already_used",
        )

    entrada.status = ENTRADA_REVOCADA
    entrada.revoked_at = momento
    entrada.revoked_reason = (motivo or "").strip()[:200]

    from app.modules.gobernanza import auditoria

    await auditoria.anotar(
        db,
        actor_id=usuario_id,
        action="event.ticket_revoked",
        entity_type="event_ticket",
        entity_id=entrada.id,
        previous_state=ENTRADA_VALIDA,
        new_state=ENTRADA_REVOCADA,
        reason=entrada.revoked_reason,
    )
    await db.commit()
    return entrada


# --------------------------------------------------------------------------- #
# Lectura
# --------------------------------------------------------------------------- #
async def mis_entradas(
    db: AsyncSession, *, usuario_id: str, limite: int = 20, cursor: str | None = None
) -> list[EventTicket]:
    """Las entradas de quien pregunta. Orden estable con desempate por `id`."""
    consulta = select(EventTicket).where(EventTicket.owner_id == usuario_id)
    if cursor:
        fecha, ident = _cursor_partido(cursor)
        consulta = consulta.where(
            (EventTicket.issued_at < fecha)
            | ((EventTicket.issued_at == fecha) & (EventTicket.id < ident))
        )
    consulta = consulta.order_by(
        EventTicket.issued_at.desc(), EventTicket.id.desc()
    ).limit(max(1, min(int(limite), 100)))
    return list(await db.scalars(consulta))


async def leer_entrada(
    db: AsyncSession, *, entrada_id: str, usuario_id: str
) -> EventTicket:
    entrada = await db.get(EventTicket, entrada_id)
    if entrada is None or entrada.owner_id != usuario_id:
        raise EntradaNoEncontrada()
    return entrada


#: Lo minimo que hay que teclear para buscar por codigo.
#:
#: NO ES UNA MOLESTIA GRATUITA. Sin minimo, el prefijo se recorre letra a
#: letra: 32 peticiones por posicion y el codigo entero sale en un rato. Con
#: seis caracteres hay que acertar uno de 32^6 antes de poder empezar a
#: alargarlo, y el recorrido deja de valer. El codigo tiene 14, asi que quien
#: lo dicta en la puerta no nota nada.
LARGO_MINIMO_DE_BUSQUEDA = 6


def _literal(texto: str) -> str:
    """El texto tal cual dentro de un `LIKE`, sin comodines.

    `_` es «un caracter cualquiera» y `%` es «lo que sea». Colandolos en la
    busqueda, la lista de asistentes contestaba «que entradas llevan una A en
    la cuarta letra»: 448 peticiones y se tienen los codigos COMPLETOS de todo
    el evento. Y un codigo admite por si solo, asi que con eso se marcan como
    usadas las entradas de todo el mundo.
    """
    return texto.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


async def asistentes(
    db: AsyncSession,
    *,
    evento_id: str,
    limite: int = 50,
    cursor: str | None = None,
    estado: str | None = None,
    busqueda: str | None = None,
) -> list[EventTicket]:
    """Las entradas de un evento, para la puerta.

    SE FILTRA EN LA BASE, ANTES DEL LÍMITE. Traer la página y filtrarla en
    memoria devuelve páginas de tamaños distintos y se salta resultados.
    """
    consulta = select(EventTicket).where(EventTicket.event_id == evento_id)
    if estado:
        consulta = consulta.where(EventTicket.status == estado)
    if busqueda:
        limpia = busqueda.strip().upper()
        if len(limpia) >= LARGO_MINIMO_DE_BUSQUEDA:
            consulta = consulta.where(
                EventTicket.code.like(f"{_literal(limpia)}%", escape="\\")
            )
        elif limpia:
            # Un prefijo mas corto no se busca: se devuelve vacio en vez de la
            # lista entera, que es lo que haria pensar que la busqueda no filtro.
            consulta = consulta.where(sa_false())
    if cursor:
        fecha, ident = _cursor_partido(cursor)
        consulta = consulta.where(
            (EventTicket.issued_at < fecha)
            | ((EventTicket.issued_at == fecha) & (EventTicket.id < ident))
        )
    consulta = consulta.order_by(
        EventTicket.issued_at.desc(), EventTicket.id.desc()
    ).limit(max(1, min(int(limite), 100)))
    return list(await db.scalars(consulta))


async def cuantos_entraron(db: AsyncSession, evento_id: str) -> int:
    """Cuánta gente hay dentro: check-ins correctos DISTINTOS.

    Se cuentan entradas, no filas. El índice único parcial de la 0062 ya impide
    dos `OK` sobre la misma entrada, pero solo cuando `ticket_id` no es nulo, y
    en PostgreSQL un índice único no restringe los nulos: dos filas `OK` sin
    entrada convivirían y sumarían dos asistentes que no existen.

    Y NO SE DERIVA DE OTRA COSA. Ni de pedidos, ni de reservas, ni de
    compradores, ni de una suma guardada a mano: quien entró es quien pasó por
    la puerta.
    """
    valor = await db.scalar(
        select(func.count(distinct(EventCheckin.ticket_id))).where(
            EventCheckin.event_id == evento_id,
            EventCheckin.result == OK,
            EventCheckin.ticket_id.is_not(None),
        )
    )
    return valor or 0


def cursor_de(fecha: datetime, ident: str) -> str:
    return f"{fecha.isoformat()}|{ident}"


def _cursor_partido(cursor: str) -> tuple[datetime, str]:
    """La fecha Y el identificador. Los dos se validan.

    El identificador va a una columna `uuid`: dejar pasar cualquier cosa hace que
    la comparación falle dentro de la base, y eso llega como un 500 por un
    parámetro mal escrito.
    """
    fecha, _, ident = cursor.partition("|")
    try:
        momento = datetime.fromisoformat(fecha)
        UUID(ident)
    except ValueError:
        raise NotFoundError("Cursor no válido.", code="invalid_cursor") from None
    if momento.tzinfo is None:
        momento = momento.replace(tzinfo=timezone.utc)
    return momento, ident
