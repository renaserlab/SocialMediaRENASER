"""El expediente de algo que llegó mal. La 0080.

QUÉ RESUELVE ESTE FICHERO, EN ORDEN DE IMPORTANCIA:

  1. ABRIR NO ES APROBAR, Y RESOLVER NO ES PAGAR. Abrir un caso solo anota que
     alguien dice que algo llegó mal. Resolverlo dice qué se decidió. Que el
     dinero se haya movido es del Incremento 9 y NO EXISTE: el efecto
     financiero nace pendiente y no hay una sola línea que llame a un
     adaptador de reembolsos.

  2. EL PROVEEDOR PROPONE; RESOLVER ES DE Z. Las cinco salidas del blueprint
     mueven dinero, mueven mercancía o niegan la reclamación, y ninguna de las
     tres puede decidirla en solitario quien tiene el conflicto. No hay ninguna
     ruta por la que el proveedor escriba `resolution`.

  3. NADA VUELVE AL ALMACÉN POR SU CUENTA. Este módulo NO IMPORTA `inventory`, y
     eso es deliberado y comprobable: dónde está una unidad dañada lo decide
     una persona. Reponerla aquí la pondría a la venta estando en casa de
     alguien.

  4. UN CASO VIVO BLOQUEA LO INCOMPATIBLE. Quien dice que no le llegó el
     paquete no puede a la vez confirmar que lo recibió, y no se pueden abrir
     dos casos vivos sobre la misma línea. Lo primero lo comprueba el envío;
     lo segundo, dos índices únicos parciales de la base.

  5. EL EXPEDIENTE NO SE REESCRIBE. Ni el historial ni la evidencia: lo imponen
     dos disparadores. Aquí pesa más que en ningún otro sitio, porque esto es
     lo que se mira cuando dos personas cuentan lo mismo de dos maneras.

LOS PLAZOS QUE HAY Y EL QUE NO:

  * LAS 48 HORAS DEL PROVEEDOR son del blueprint §10.1, exactas y sin
    ambigüedad. Se transcriben. El reloj corre SOLO mientras la pelota es suya:
    si pidió más evidencia, no puede correrle el plazo mientras espera.
  * LAS 48 HORAS DE LA APELACIÓN, del mismo sitio, y una sola apelación.
  * LOS «TRES DÍAS HÁBILES» DE Z NO SE PUEDEN CALCULAR, y por eso no hay
    ninguna fecha límite de la decisión: «hábil» depende de un calendario de
    festivos que nadie ha definido. El caso se enseña «en revisión» y punto.

Y LA ESCALADA POR SILENCIO NO ES UN TEMPORIZADOR DENTRO DE FASTAPI. La API
puede correr con varias réplicas; hay una ruta de administración idempotente
preparada para un planificador externo, igual que el vencimiento de reservas.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    AppError,
    ConflictError,
    ForbiddenError,
    NotFoundError,
    ValidationAppError,
)
from app.modules.gobernanza import auditoria
from app.modules.products import avisos, esquema, estados_de_incidencia as maquina
from app.modules.products import envios, pedidos
from app.modules.products.models import (
    HORAS_PARA_APELAR,
    HORAS_PARA_RESPONDER,
    MAXIMO_DE_FOTOS_DE_INCIDENCIA,
    PEDIR_MAS_EVIDENCIA,
    PEDIDO_PAGADO,
    ProductIncident,
    ProductIncidentEvent,
    ProductIncidentEvidence,
    ProductOrder,
    ProductOrderItem,
    ProductPolicy,
    ProductSeller,
    ProductShipment,
)
from app.shared import storage
from app.shared.permissions import FINANCE_ROLES, get_role

logger = logging.getLogger("renaser.products")

#: Cómo se llama cada actor en la auditoría compartida. `audit_events.actor_role`
#: solo admite `user`, `admin`, `moderator` y `system` (0050, aplicada).
ROL_DE_AUDITORIA = {
    maquina.COMPRADOR: "user",
    maquina.PROVEEDOR: "user",
    maquina.ADMINISTRACION: "admin",
    maquina.SISTEMA: "system",
}


# --------------------------------------------------------------------------- #
# Los fallos, con su código
# --------------------------------------------------------------------------- #
class CasoNoEncontrado(NotFoundError):
    """404 también para el ajeno: decir «existe pero no es tuyo» ya cuenta que
    alguien abrió una disputa sobre ese pedido."""

    code = "product_incident_not_found"


class NoHayNadaQueReclamar(ConflictError):
    """No se reclama sobre algo que no llegó a entregarse.

    409 Y CON EL ESTADO DENTRO. Una incidencia habla de cómo llegó el producto;
    si el paquete no ha salido todavía, lo que hay que mirar es el envío.
    """

    code = "product_incident_not_deliverable"


class YaHayUnCaso(ConflictError):
    code = "product_incident_already_open"


class MotivoInvalido(ValidationAppError):
    code = "product_incident_reason_invalid"


class FaltaEvidencia(ConflictError):
    """El blueprint pide 2–6 fotografías, y sin ellas el caso no se envía."""

    code = "product_incident_evidence_required"


class DemasiadaEvidencia(ConflictError):
    code = "product_incident_evidence_too_many"


class NoLeToca(ConflictError):
    """Ese paso existe pero no en este momento del expediente."""

    code = "product_incident_not_your_turn"


class ApelacionFueraDePlazo(ConflictError):
    code = "product_incident_appeal_late"


class ApelacionSinEvidenciaNueva(ConflictError):
    """El blueprint pide evidencia NUEVA, y nueva es posterior a la resolución.

    Sin esa condición, apelar sería repetir la misma frase más alto.
    """

    code = "product_incident_appeal_without_evidence"


class ApelacionAgotada(ConflictError):
    code = "product_incident_appeal_used"


class ResolucionInvalida(ValidationAppError):
    code = "product_incident_resolution_invalid"


class PlazoParaReclamarVencido(ConflictError):
    """Pasó el plazo que la política del pedido concede para reclamar.

    ESTE PLAZO NO SE LO INVENTA NADIE: es `incident_report_hours` de la política
    publicada que quien compró aceptó, congelada en el pedido por su `policy_id`
    y su versión. El CHECK de la 0077 no deja publicar una política sin él, así
    que un pedido real siempre lo tiene.

    Y NO ES LO MISMO QUE NO TENER POLÍTICA. Si por lo que sea el pedido apunta a
    una fila sin horas —una base a medio sembrar—, no se cierra la puerta: se
    deja abrir el caso, porque negar el derecho a reclamar por un dato que falta
    sería inventarse el plazo al revés.
    """

    code = "product_incident_report_window_closed"


# --------------------------------------------------------------------------- #
# Piezas
# --------------------------------------------------------------------------- #
def ahora() -> datetime:
    return datetime.now(timezone.utc)


async def puede_mediar(db: AsyncSession, user_id: str) -> bool:
    """Quién resuelve una incidencia. SOLO `admin`.

    NO `is_admin`, que incluye a moderación. Resolver decide sobre dinero y
    sobre mercancía: es el mismo conjunto estrecho que ya decide quién publica
    y quién ajusta existencias.
    """
    return await get_role(db, user_id) in FINANCE_ROLES


async def exigir_mediador(db: AsyncSession, user_id: str) -> None:
    if not await puede_mediar(db, user_id):
        raise ForbiddenError(
            "Solo administración resuelve una incidencia.",
            code="product_incident_mediate_forbidden",
        )


def _texto(valor: str | None, maximo: int) -> str | None:
    limpio = (valor or "").strip()
    return limpio[:maximo] or None


#: El depósito privado de la evidencia. OTRO distinto del del catálogo: aquel se
#: firma para cualquiera que mire un producto, y esto son las fotos del salón de
#: quien compró.
DEPOSITO = "product-incidents"

_EXTENSION = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}


def ruta_de(*, incidencia_id: str, prueba_id: str, tipo: str) -> str:
    """`incidencia/identificador.ext`. LA GENERA EL SERVIDOR.

    Nada de esto viene del cliente: ni el nombre, ni la extensión, ni las
    carpetas. Un nombre elegido por quien sube puede traer `../`, un punto de
    más o el nombre de un archivo ajeno.

    Y NO LLEVA NI EL PEDIDO NI A QUIEN COMPRÓ EN LA RUTA. Una ruta de
    almacenamiento se ve en cualquier registro y en cualquier traza; que el
    nombre del archivo diga de quién es el caso es contarlo sin querer.
    """
    return f"{incidencia_id}/{prueba_id}.{_EXTENSION[tipo]}"


#: CINCO MINUTOS, Y NO MÁS. La firma de una foto del catálogo puede durar lo
#: que dure una sesión de navegación; esta es la foto del salón de alguien
#: dentro de una disputa, y una URL firmada que se comparte por error es una
#: URL que funciona para cualquiera que la tenga mientras dure.
SEGUNDOS_DE_LA_FIRMA = 300


async def firmar(rutas: list[str]) -> dict[str, str]:
    """`ruta -> URL firmada` de las que se puedan firmar. NUNCA lanza.

    SE FIRMA AL PINTAR Y NUNCA SE GUARDA: una URL firmada caduca, y guardarla
    haría que la evidencia de una disputa dejara de cargar sin que nadie tocara
    nada.

    Y SI EL ALMACENAMIENTO NO CONTESTA, el expediente se abre igual con la
    lista de pruebas y sin las imágenes. Un caso que no se puede leer porque un
    tercero está caído es peor que uno que se lee a medias.
    """
    if not rutas:
        return {}
    try:
        return await storage.firmar_objetos(
            DEPOSITO, rutas, segundos=SEGUNDOS_DE_LA_FIRMA
        )
    except storage.StorageNoConfigurado:
        return {}
    except Exception:  # noqa: BLE001 - ver la cabecera
        logger.warning("No se pudieron firmar %d evidencias", len(rutas))
        return {}


# --------------------------------------------------------------------------- #
# Leer
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Prueba:
    """Una evidencia del caso, sin la URL: se firma al pintarla."""

    id: str
    uploaded_role: str
    storage_path: str
    content_type: str
    byte_size: int
    width: int
    height: int
    caption: str | None
    created_at: datetime


@dataclass(frozen=True)
class Caso:
    """El expediente tal como lo lee una pantalla."""

    id: str
    order_id: str
    order_item_id: str | None
    reason: str
    description: str
    status: str
    seller_response_due_at: datetime | None
    seller_responded_at: datetime | None
    seller_proposal: str | None
    resolution: str | None
    resolved_at: datetime | None
    financial_effect: str | None
    appeal_due_at: datetime | None
    appealed_at: datetime | None
    appeals_used: int
    withdrawn_at: datetime | None
    created_at: datetime
    evidence: list[Prueba] = field(default_factory=list)
    history: list[ProductIncidentEvent] = field(default_factory=list)


def _leido(fila: ProductIncident, pruebas: list[Prueba], historial: list) -> Caso:
    return Caso(
        id=fila.id,
        order_id=fila.order_id,
        order_item_id=fila.order_item_id,
        reason=fila.reason,
        description=fila.description,
        status=fila.status,
        seller_response_due_at=fila.seller_response_due_at,
        seller_responded_at=fila.seller_responded_at,
        seller_proposal=fila.seller_proposal,
        resolution=fila.resolution,
        resolved_at=fila.resolved_at,
        financial_effect=fila.financial_effect,
        appeal_due_at=fila.appeal_due_at,
        appealed_at=fila.appealed_at,
        appeals_used=int(fila.appeals_used),
        withdrawn_at=fila.withdrawn_at,
        created_at=fila.created_at,
        evidence=pruebas,
        history=historial,
    )


async def _pruebas(db: AsyncSession, incidencia_id: str) -> list[Prueba]:
    filas = await db.scalars(
        select(ProductIncidentEvidence)
        .where(ProductIncidentEvidence.incident_id == incidencia_id)
        .order_by(ProductIncidentEvidence.created_at, ProductIncidentEvidence.id)
    )
    return [
        Prueba(
            id=f.id,
            uploaded_role=f.uploaded_role,
            storage_path=f.storage_path,
            content_type=f.content_type,
            byte_size=int(f.byte_size),
            width=int(f.width),
            height=int(f.height),
            caption=f.caption,
            created_at=f.created_at,
        )
        for f in filas
    ]


async def _historial(db: AsyncSession, incidencia_id: str) -> list:
    return list(
        await db.scalars(
            select(ProductIncidentEvent)
            .where(ProductIncidentEvent.incident_id == incidencia_id)
            .order_by(ProductIncidentEvent.created_at, ProductIncidentEvent.id)
        )
    )


async def leer(db: AsyncSession, *, incidencia_id: str) -> Caso:
    """El expediente entero. QUIÉN PUEDE VERLO LO DECIDE QUIEN LLAMA."""
    await esquema.exigir_incidencias(db)
    fila = await db.get(ProductIncident, incidencia_id)
    if fila is None:
        raise CasoNoEncontrado("Incidencia no encontrada.")
    return _leido(
        fila,
        await _pruebas(db, incidencia_id),
        await _historial(db, incidencia_id),
    )


async def de_quien_compra(
    db: AsyncSession, *, incidencia_id: str, usuario_id: str
) -> ProductIncident:
    """El caso de esta persona. 404 para el ajeno."""
    await esquema.exigir_incidencias(db)
    fila = await db.get(ProductIncident, incidencia_id)
    if fila is None or fila.buyer_id != usuario_id:
        raise CasoNoEncontrado("Incidencia no encontrada.")
    return fila


async def de_quien_vende(
    db: AsyncSession, *, incidencia_id: str, usuario_id: str
) -> ProductIncident:
    """El caso de MI tienda. 404 para el de otra."""
    from app.modules.products import permissions as permisos

    vendedor = await permisos.exigir_vendedor_activo(db, usuario_id)
    await esquema.exigir_incidencias(db)
    fila = await db.get(ProductIncident, incidencia_id)
    if fila is None or fila.seller_id != vendedor.id:
        raise CasoNoEncontrado("Incidencia no encontrada.")
    #: 404 TAMBIÉN PARA EL BORRADOR QUE TODAVÍA NO LE MANDARON. Es de su tienda,
    #: pero aún no es suyo: decir «existe pero no puedes» ya contaría que
    #: alguien está preparando una reclamación contra él.
    if fila.seller_response_due_at is None and fila.status in (
        maquina.ABIERTA,
        maquina.RETIRADA,
    ):
        raise CasoNoEncontrado("Incidencia no encontrada.")
    return fila


async def del_pedido(
    db: AsyncSession, *, orden_id: str
) -> list[ProductIncident]:
    """Los casos de ese pedido, del más nuevo al más viejo."""
    if not await esquema.hay_incidencias(db):
        return []
    return list(
        await db.scalars(
            select(ProductIncident)
            .where(ProductIncident.order_id == orden_id)
            .order_by(ProductIncident.created_at.desc(), ProductIncident.id.desc())
        )
    )


async def hay_caso_vivo(db: AsyncSession, *, orden_id: str) -> bool:
    """Si ese pedido tiene un caso que todavía espera a alguien.

    LO USA EL ENVÍO para no dejar confirmar una recepción mientras se discute si
    el paquete llegó, y lo usará el Incremento 9 para no liberar el saldo.
    """
    if not await esquema.hay_incidencias(db):
        return False
    return bool(
        await db.scalar(
            select(func.count())
            .select_from(ProductIncident)
            .where(
                ProductIncident.order_id == orden_id,
                ProductIncident.status.in_(tuple(maquina.VIVAS)),
            )
        )
    )


async def bloquea_el_dinero(db: AsyncSession, *, orden_id: str) -> bool:
    """Si algún caso de ese pedido impide liberar su saldo.

    DOS COSAS LO BLOQUEAN, Y LA SEGUNDA ES LA QUE SE OLVIDA. Un caso vivo,
    evidentemente; pero también uno YA RESUELTO cuya resolución dejó algo
    debiendo —dinero o mercancía— y todavía no se ha ejecutado. Liberar el
    dinero al proveedor con un reembolso aprobado y sin pagar es pagarle dos
    veces.

    NO LO LLAMA NADIE TODAVÍA: las transferencias son del Incremento 9. Está
    aquí, escrito y probado, porque es la pregunta que ese incremento tendrá
    que hacer y este es el sitio donde vive la respuesta.
    """
    if not await esquema.hay_incidencias(db):
        return False
    for caso in await del_pedido(db, orden_id=orden_id):
        if maquina.bloquea_el_dinero(
            caso.status, caso.resolution, caso.financial_effect
        ):
            return True
    return False


# --------------------------------------------------------------------------- #
# Abrir
# --------------------------------------------------------------------------- #
async def _anotar(
    db: AsyncSession,
    *,
    incidencia_id: str,
    desde: str | None,
    hasta: str,
    actor_id: str | None,
    actor_rol: str,
    nota: str | None,
    momento: datetime,
) -> None:
    db.add(
        ProductIncidentEvent(
            incident_id=incidencia_id,
            from_status=desde,
            to_status=hasta,
            actor_id=actor_id,
            actor_role=actor_rol,
            note=nota,
            created_at=momento,
        )
    )


async def _entregado(db: AsyncSession, *, orden: ProductOrder) -> ProductShipment:
    """El envío de ese pedido, exigiendo que haya llegado a su destino.

    NO SE RECLAMA SOBRE ALGO QUE NO SALIÓ. Una incidencia habla de cómo llegó
    el producto; si el paquete sigue en el almacén, lo que hay que mirar es el
    envío, y decirlo así ahorra que alguien abra un caso contra quien todavía
    no ha hecho nada mal.
    """
    await esquema.exigir_envios(db)
    envio = await db.get(ProductShipment, orden.id)
    estado = envio.status if envio is not None else "PENDING"
    if estado not in ("DELIVERED", "DELIVERY_FAILED"):
        raise NoHayNadaQueReclamar(
            "Todavía no hay nada que reclamar de este pedido.",
            details={"shipment_status": estado},
        )
    return envio


def desde_cuando_corre(envio: ProductShipment) -> datetime | None:
    """Desde cuándo se cuenta el plazo para reclamar.

    DESDE QUE LLEGÓ, o desde que se supo que no iba a llegar. Son los dos únicos
    momentos en los que quien compró puede saber que tiene algo que reclamar, y
    antes de cualquiera de ellos no habría empezado a correr nada.
    """
    return envio.delivered_at or envio.failed_at


async def _dentro_del_plazo(
    db: AsyncSession, *, orden: ProductOrder, envio: ProductShipment, momento: datetime
) -> None:
    """Exige que no haya pasado el plazo de la política congelada en el pedido.

    SE LEE LA POLÍTICA DEL PEDIDO, no la vigente hoy. Quien compró aceptó unas
    condiciones concretas; cambiarlas después a su espalda —acortando el plazo
    de una política nueva— le quitaría un derecho que ya tenía.
    """
    politica = await db.get(ProductPolicy, orden.policy_id)
    horas = politica.incident_report_hours if politica is not None else None
    if horas is None:
        return
    arranque = pedidos.comparable(desde_cuando_corre(envio), momento)
    if arranque is None:
        return
    #: POR `comparable`, COMO EL RESTO DEL MODULO. Lo señaló la revisión
    #: independiente: era la única comparación de fechas que no pasaba por ahí.
    #: Contra PostgreSQL no rompe porque `timestamptz` siempre trae zona, pero
    #: una fecha ingenua comparada con una consciente lanza `TypeError`, y este
    #: es justo el sitio donde eso cerraría el derecho a reclamar de alguien.
    limite = arranque + timedelta(hours=int(horas))
    if momento > limite:
        raise PlazoParaReclamarVencido(
            "El plazo para reclamar este pedido ya terminó.",
            details={"hours": int(horas), "closed_at": limite.isoformat()},
        )


async def abrir(
    db: AsyncSession,
    *,
    orden_id: str,
    usuario_id: str,
    motivo: str,
    descripcion: str,
    order_item_id: str | None = None,
    momento: datetime | None = None,
) -> ProductIncident:
    """Abre un caso. ABRIR NO ES APROBAR NADA.

    EL EXPEDIENTE NACE SIN EVIDENCIA Y SIN PLAZO CORRIENDO. El blueprint pide
    2–6 fotografías, y exigirlas en esta llamada obligaría a subirlas antes de
    que el caso exista, que es donde irían colgadas. Así que el caso nace, se
    le añaden las pruebas y **se envía** con `enviar`, que es donde se
    comprueba el mínimo y donde empieza a correr el plazo del proveedor.

    LA ENTREGA NEGADA ES EL CASO DEL PEDIDO ENTERO y no lleva línea: no hay una
    línea concreta de la que quejarse porque no llegó nada. Lo impone también un
    CHECK de la base.
    """
    await esquema.exigir_incidencias(db)
    momento = momento or ahora()

    if motivo not in maquina.MOTIVOS:
        raise MotivoInvalido(
            "Ese no es uno de los motivos.",
            details={"allowed": list(maquina.MOTIVOS)},
        )

    orden = await pedidos.leer(db, orden_id=orden_id, usuario_id=usuario_id)
    if orden.status != PEDIDO_PAGADO:
        raise NoHayNadaQueReclamar(
            "Ese pedido no está pagado.", details={"order_status": orden.status}
        )
    envio = await _entregado(db, orden=orden)
    await _dentro_del_plazo(db, orden=orden, envio=envio, momento=momento)

    limpia = (descripcion or "").strip()
    if not (
        maquina.DESCRIPCION_MINIMA <= len(limpia) <= maquina.DESCRIPCION_MAXIMA
    ):
        raise ValidationAppError(
            "Cuéntanos qué pasó con algo más de detalle.",
            code="product_incident_description_invalid",
            details={
                "field": "description",
                "min": maquina.DESCRIPCION_MINIMA,
                "max": maquina.DESCRIPCION_MAXIMA,
            },
        )

    #: LA ENTREGA NEGADA NO LLEVA LÍNEA; CUALQUIER OTRO MOTIVO SÍ.
    if motivo == maquina.ENTREGA_NEGADA:
        order_item_id = None
    elif order_item_id is None:
        raise ValidationAppError(
            "Dinos de qué artículo hablas.",
            code="product_incident_item_required",
            details={"field": "order_item_id"},
        )
    else:
        linea = await db.get(ProductOrderItem, order_item_id)
        if linea is None or linea.order_id != orden.id:
            raise ValidationAppError(
                "Ese artículo no es de este pedido.",
                code="product_incident_item_not_in_order",
                details={"order_item_id": order_item_id},
            )

    caso = ProductIncident(
        order_id=orden.id,
        order_item_id=order_item_id,
        buyer_id=usuario_id,
        seller_id=orden.seller_id,
        reason=motivo,
        description=limpia,
        status=maquina.ABIERTA,
        #: EL PLAZO NO EMPIEZA AL ABRIR. Empieza al enviarlo, que es cuando el
        #: proveedor recibe el aviso: el blueprint dice «desde la notificación».
        seller_response_due_at=None,
        created_at=momento,
        updated_at=momento,
    )
    try:
        async with db.begin_nested():
            db.add(caso)
            await db.flush()
    except IntegrityError as choque:
        #: UN CASO VIVO POR LÍNEA, Y UNO POR PEDIDO. Lo imponen dos índices
        #: únicos parciales de la base, no un `if` nuestro: dos toques a la vez
        #: se pasarían por delante de cualquier comprobación previa.
        raise YaHayUnCaso(
            "Ya hay una incidencia abierta sobre esto.",
            details={"order_id": orden.id, "order_item_id": order_item_id},
        ) from choque

    await _anotar(
        db,
        incidencia_id=caso.id,
        desde=None,
        hasta=maquina.ABIERTA,
        actor_id=usuario_id,
        actor_rol=maquina.COMPRADOR,
        nota=None,
        momento=momento,
    )
    await db.flush()
    return caso


async def cuantas_pruebas(db: AsyncSession, *, incidencia_id: str) -> int:
    return int(
        await db.scalar(
            select(func.count())
            .select_from(ProductIncidentEvidence)
            .where(ProductIncidentEvidence.incident_id == incidencia_id)
        )
        or 0
    )


async def anadir_prueba(
    db: AsyncSession,
    *,
    caso: ProductIncident,
    medida,
    actor_id: str,
    actor_rol: str,
    pie: str | None = None,
    momento: datetime | None = None,
    ruta: str | None = None,
) -> ProductIncidentEvidence:
    """Cuelga una prueba del expediente. SOLO SE AÑADE, y no se quita.

    LOS BYTES YA SE MIRARON. `medida` viene de `media.medir`, que abre la imagen
    de verdad en vez de creerse la cabecera: una cabecera de JPEG se puede pegar
    delante de cualquier cosa.

    EL MISMO ARCHIVO NO CUENTA DOS VECES. Lo impone un índice único por huella,
    porque subir dos veces la misma foto para llegar al mínimo de dos no es
    aportar dos evidencias.
    """
    await esquema.exigir_incidencias(db)
    momento = momento or ahora()

    #: SE CUENTA CON LA FILA DEL CASO BLOQUEADA, y no a pelo. Lo señaló la
    #: revisión independiente: dos subidas a la vez veían cinco y metían siete.
    #: El cerrojo va sobre el caso —no sobre las pruebas, que se están
    #: insertando— y serializa a quienes cuelgan algo del mismo expediente.
    #:
    #: LA HUELLA ÚNICA NO BASTABA: solo impide repetir el MISMO archivo, y dos
    #: fotografías distintas pasan las dos. El tope de seis es el único
    #: cuantificador del blueprint sin respaldo en la base, así que lo sostiene
    #: el cerrojo.
    if await _bloqueado(db, caso.id) is None:
        raise CasoNoEncontrado("Incidencia no encontrada.")

    cuantas = await cuantas_pruebas(db, incidencia_id=caso.id)
    if cuantas >= MAXIMO_DE_FOTOS_DE_INCIDENCIA:
        raise DemasiadaEvidencia(
            "Este caso ya tiene todas las fotografías que admite.",
            details={"max": MAXIMO_DE_FOTOS_DE_INCIDENCIA, "current": cuantas},
        )

    #: EL IDENTIFICADOR SE GENERA AQUI, ANTES DE INSERTAR, para poder escribir
    #: la ruta en la misma fila. Antes se insertaba con la ruta vacia y se
    #: rellenaba despues: la fila intermedia violaba el CHECK de la ruta, y el
    #: `IntegrityError` que eso provocaba se contaba como «foto duplicada».
    #: Dos errores en uno, y el segundo tapaba al primero.
    import uuid as _uuid

    prueba_id = str(_uuid.uuid4())
    prueba = ProductIncidentEvidence(
        id=prueba_id,
        incident_id=caso.id,
        uploaded_by=actor_id,
        uploaded_role=actor_rol,
        storage_path=ruta
        or ruta_de(
            incidencia_id=caso.id,
            prueba_id=prueba_id,
            tipo=medida.content_type,
        ),
        content_type=medida.content_type,
        byte_size=medida.byte_size,
        checksum_sha256=medida.checksum_sha256,
        width=medida.width,
        height=medida.height,
        caption=_texto(pie, 300),
        created_at=momento,
    )
    try:
        async with db.begin_nested():
            db.add(prueba)
            await db.flush()
    except IntegrityError as choque:
        #: SOLO ES UN DUPLICADO SI DE VERDAD LO ES. Contestar «esa fotografía ya
        #: está» ante cualquier choque de la base esconde el fallo real detrás
        #: de un mensaje tranquilizador, y quien sube se queda sin saber qué
        #: pasó. Se comprueba mirando si esa huella ya estaba.
        ya_estaba = await db.scalar(
            select(func.count())
            .select_from(ProductIncidentEvidence)
            .where(
                ProductIncidentEvidence.incident_id == caso.id,
                ProductIncidentEvidence.checksum_sha256 == medida.checksum_sha256,
            )
        )
        if not ya_estaba:
            raise
        raise ConflictError(
            "Esa fotografía ya está en el expediente.",
            code="product_incident_evidence_duplicated",
        ) from choque
    return prueba


async def enviar(
    db: AsyncSession,
    *,
    caso: ProductIncident,
    usuario_id: str,
    momento: datetime | None = None,
) -> ProductIncident:
    """Manda el caso al proveedor y ARRANCA SU PLAZO.

    AQUÍ SE COMPRUEBA EL MÍNIMO DE FOTOGRAFÍAS, y no al abrir: las pruebas
    cuelgan del caso, así que el caso tiene que existir antes. El blueprint pide
    2–6, y a la entrega negada no se le pueden pedir dos: no hay nada que
    fotografiar porque el paquete no está.

    EL PLAZO EMPIEZA AQUÍ porque el blueprint dice «48 horas desde la
    notificación», y la notificación sale de aquí.
    """
    await esquema.exigir_incidencias(db)
    momento = momento or ahora()

    if caso.status != maquina.ABIERTA:
        raise NoLeToca(
            f"Ese caso ya no se puede enviar: está {caso.status}.",
            details={"status": caso.status},
        )
    if caso.seller_response_due_at is not None:
        #: YA ESTABA ENVIADO. Repetir el envío no reinicia el plazo del
        #: proveedor: sería una forma de darle menos tiempo del que tiene.
        return caso

    hacen_falta = maquina.fotos_exigidas(caso.reason)
    if hacen_falta:
        cuantas = await cuantas_pruebas(db, incidencia_id=caso.id)
        if cuantas < hacen_falta:
            raise FaltaEvidencia(
                "Hacen falta fotografías para poder revisarlo.",
                details={"required": hacen_falta, "current": cuantas},
            )

    caso.seller_response_due_at = momento + timedelta(hours=HORAS_PARA_RESPONDER)
    caso.updated_at = momento
    await db.flush()
    return caso


# --------------------------------------------------------------------------- #
# La única puerta por la que se mueve un caso
# --------------------------------------------------------------------------- #
async def _bloqueado(db: AsyncSession, incidencia_id: str) -> ProductIncident | None:
    """El caso con su fila bloqueada y REFRESCADA.

    `populate_existing` no es un adorno: sin él SQLAlchemy devuelve el objeto
    que ya tiene en el mapa de identidad y el cerrojo habría tomado la fila para
    leer una foto anterior.
    """
    return await db.scalar(
        select(ProductIncident)
        .where(ProductIncident.id == incidencia_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


async def _exigir_sitio_para_revivir(
    db: AsyncSession, *, caso: ProductIncident
) -> None:
    """Que no haya YA otro caso vivo sobre lo mismo.

    Lo que impone la base son dos índices únicos parciales —uno por línea y otro
    por pedido, porque en PostgreSQL los nulos no chocan entre sí—; esto
    pregunta lo mismo con antelación para poder contestar 409 en vez de
    estrellarse.
    """
    condiciones = [
        ProductIncident.id != caso.id,
        ProductIncident.status.in_(list(maquina.VIVAS)),
    ]
    if caso.order_item_id is None:
        #: EL CASO DEL PEDIDO ENTERO choca con cualquier otro del pedido entero.
        condiciones += [
            ProductIncident.order_id == caso.order_id,
            ProductIncident.order_item_id.is_(None),
        ]
    else:
        condiciones.append(ProductIncident.order_item_id == caso.order_item_id)

    if await db.scalar(select(func.count()).select_from(ProductIncident).where(*condiciones)):
        raise YaHayUnCaso(
            "Ya hay otra reclamación abierta sobre esto.",
            details={
                "order_id": caso.order_id,
                "order_item_id": caso.order_item_id,
            },
        )


async def mover(
    db: AsyncSession,
    *,
    incidencia_id: str,
    hasta: str,
    actor_id: str | None,
    actor_rol: str,
    nota: str | None = None,
    propuesta: str | None = None,
    resolucion: str | None = None,
    momento: datetime | None = None,
) -> ProductIncident:
    """Da un paso del expediente. LA ÚNICA FORMA de cambiarlo.

    REPARTIR ESTAS COMPROBACIONES ENTRE LAS RUTAS ES CÓMO SE RESUELVE UN CASO
    SIN PERMISO el día que alguien añade un camino nuevo. Aquí, y en este orden:

      1. la migración está puesta;
      2. la fila, bloqueada y refrescada;
      3. la máquina: ¿existe el salto, es de quien lo pide, lleva explicación?;
      4. lo que ese salto en concreto exige —una propuesta, una resolución—;
      5. las fechas y el renglón del historial.

    NO CONFIRMA NI DESHACE LA TRANSACCIÓN. Quien llama decide, y así un aviso
    encolado vive o muere con el hecho que lo provocó.
    """
    await esquema.exigir_incidencias(db)
    momento = momento or ahora()

    caso = await _bloqueado(db, incidencia_id)
    if caso is None:
        raise CasoNoEncontrado("Incidencia no encontrada.")

    desde = caso.status
    limpia = maquina.exigir(desde, hasta, actor_rol, nota)

    # --- UN CASO NO SALE DE ABIERTO SIN SUS FOTOGRAFÍAS ------------------- #
    #
    # LO ENCONTRÓ LA REVISIÓN INDEPENDIENTE. El mínimo del blueprint vivía solo
    # dentro de `enviar`, así que se esquivaba entero pidiendo mediación: la
    # pantalla pintaba deshabilitado el botón de enviar y habilitado el de «que
    # lo mire Z», porque el servidor ofrecía ese salto desde ABIERTA. Quien no
    # quisiera subir fotos tenía un botón activo para saltárselas, y la persona
    # de Z acababa decidiendo sobre un expediente vacío.
    #
    # AQUÍ Y NO EN LAS RUTAS, que es lo que evita que el agujero vuelva a
    # abrirse el día que alguien añada un camino nuevo. Cierra también que el
    # proveedor se adelante sobre un borrador que todavía no ha visto.
    #
    # RETIRARLO NO CUENTA: exigir fotografías para abandonar algo que nadie ha
    # visto sería obligar a documentar una reclamación que ya no se quiere
    # hacer. Y la entrega negada exige cero, que es lo que dice `fotos_exigidas`.
    if desde == maquina.ABIERTA and hasta != maquina.RETIRADA:
        hacen_falta = maquina.fotos_exigidas(caso.reason)
        if hacen_falta:
            cuantas = await cuantas_pruebas(db, incidencia_id=caso.id)
            if cuantas < hacen_falta:
                raise FaltaEvidencia(
                    "Hacen falta fotografías para poder revisarlo.",
                    details={"required": hacen_falta, "current": cuantas},
                )

    # --- Lo que ese salto en concreto exige ------------------------------- #
    if hasta == maquina.RESPONDIDA:
        if propuesta not in maquina.RESOLUCIONES:
            #: EL PROVEEDOR PROPONE UNA DE LAS CINCO SALIDAS. Pedir más
            #: evidencia es otro salto, no una respuesta con propuesta.
            raise ResolucionInvalida(
                "Esa no es una de las salidas que puedes proponer.",
                details={"allowed": list(maquina.RESOLUCIONES)},
            )
        caso.seller_proposal = propuesta
        caso.seller_responded_at = momento
    elif hasta == maquina.MAS_EVIDENCIA:
        caso.seller_proposal = PEDIR_MAS_EVIDENCIA
        caso.seller_responded_at = momento
        #: EL RELOJ DEL PROVEEDOR SE PARA. No puede correrle el plazo mientras
        #: espera la evidencia que él mismo pidió.
        caso.seller_response_due_at = None
    elif hasta == maquina.ABIERTA:
        #: LA PELOTA VUELVE, Y EL PLAZO EMPIEZA DE NUEVO.
        caso.seller_response_due_at = momento + timedelta(hours=HORAS_PARA_RESPONDER)
    elif hasta == maquina.RESUELTA:
        if resolucion not in maquina.RESOLUCIONES:
            raise ResolucionInvalida(
                "Esa no es una de las cinco salidas.",
                details={"allowed": list(maquina.RESOLUCIONES)},
            )
        caso.resolution = resolucion
        caso.resolved_at = momento
        caso.resolved_by = actor_id
        #: RESOLVER NO ES PAGAR. El efecto nace PENDIENTE y nadie lo ejecuta:
        #: mover el dinero es del Incremento 9 y no existe. Las que no deben
        #: nada —rechazar la reclamación— nacen «no aplica».
        caso.financial_effect = (
            maquina.EFECTO_PENDIENTE
            if maquina.deja_deuda(resolucion)
            else maquina.EFECTO_NO_APLICA
        )
        caso.appeal_due_at = momento + timedelta(hours=HORAS_PARA_APELAR)
    elif hasta == maquina.APELADA:
        await _exigir_apelacion_valida(db, caso=caso, momento=momento)
        #: APELAR VUELVE A PONER VIVO ESTE CASO, y sobre esta misma línea puede
        #: haber otro que se abrió mientras este estaba resuelto —abrirlo era
        #: legal, porque `RESOLVED` no está entre los vivos—.
        #:
        #: LO ENCONTRÓ LA REVISIÓN INDEPENDIENTE: sin esta comprobación el
        #: `UPDATE` chocaba contra el índice único parcial y salía un
        #: `IntegrityError` sin envolver —500 sin texto en el móvil— que además
        #: gastaba la única apelación de quien reclama por un choque ajeno.
        #:
        #: SE PREGUNTA ANTES DE ESCRIBIR, y no se deja al índice: un fallo de
        #: `flush` deja la sesión entera inservible aunque se envuelva en un
        #: punto de guardado, y con ella se perdería el renglón del historial.
        #: El índice sigue ahí de último recurso.
        await _exigir_sitio_para_revivir(db, caso=caso)
        caso.appealed_at = momento
        caso.appeals_used = int(caso.appeals_used) + 1
    elif hasta == maquina.RETIRADA:
        caso.withdrawn_at = momento
    elif hasta == maquina.MEDIACION:
        #: EN MEDIACIÓN NO CORRE EL PLAZO DEL PROVEEDOR: ya no es su turno.
        caso.seller_response_due_at = None

    caso.status = hasta
    caso.updated_at = momento

    await _anotar(
        db,
        incidencia_id=caso.id,
        desde=desde,
        hasta=hasta,
        actor_id=actor_id,
        actor_rol=actor_rol,
        nota=limpia,
        momento=momento,
    )
    await db.flush()

    await auditoria.anotar(
        db,
        actor_id=actor_id,
        actor_role=ROL_DE_AUDITORIA[actor_rol],
        action=f"product_incident.{hasta.lower()}",
        entity_type="product_order",
        entity_id=caso.order_id,
        #: NI LA NOTA NI LA DESCRIPCIÓN. Son texto libre que escriben quien
        #: reclama y quien responde, y ahí va lo que le pasó a esa persona en su
        #: casa. `audit_events` la leen otros módulos y otras personas: el
        #: expediente se lee entrando a él, que es donde se comprueba quién
        #: puede. Aquí queda de dónde a dónde se movió y qué se decidió.
        payload={
            "from": desde,
            "to": hasta,
            "incident_id": caso.id,
            "reason": caso.reason,
            "resolution": caso.resolution,
        },
    )
    return caso


async def _exigir_apelacion_valida(
    db: AsyncSession, *, caso: ProductIncident, momento: datetime
) -> None:
    """Una sola apelación, dentro del plazo y CON EVIDENCIA NUEVA.

    «NUEVA» ES «POSTERIOR A LA RESOLUCIÓN», y se sabe mirando las fechas. Sin
    esa condición, apelar sería repetir la misma frase más alto: el blueprint
    pide evidencia nueva precisamente para que la segunda vuelta mire algo que
    la primera no vio.
    """
    if int(caso.appeals_used) >= 1:
        raise ApelacionAgotada("Ya apelaste este caso una vez.")

    limite = pedidos.comparable(caso.appeal_due_at, momento)
    if limite is None or limite <= momento:
        raise ApelacionFueraDePlazo(
            "El plazo para apelar ya pasó.",
            details={"appeal_due_at": str(caso.appeal_due_at)},
        )

    resuelto = pedidos.comparable(caso.resolved_at, momento)
    nuevas = await db.scalar(
        select(func.count())
        .select_from(ProductIncidentEvidence)
        .where(
            ProductIncidentEvidence.incident_id == caso.id,
            ProductIncidentEvidence.created_at > resuelto,
        )
    )
    if not nuevas:
        raise ApelacionSinEvidenciaNueva(
            "Para apelar hace falta aportar algo que no estuviera antes."
        )


# --------------------------------------------------------------------------- #
# La escalada por silencio. NO ES UN TEMPORIZADOR
# --------------------------------------------------------------------------- #
async def escalar_las_vencidas(
    db: AsyncSession, *, momento: datetime | None = None, lote: int = 200
) -> int:
    """Manda a mediación los casos cuyo plazo del proveedor venció. Idempotente.

    EL SILENCIO NO CIERRA NADA: pasa a mediación, no a «rechazado» ni a
    «aceptado». Lo dice el blueprint §10.1 y es lo razonable: que el proveedor
    no conteste no significa que tenga razón ni que no la tenga.

    NO HAY NINGÚN TEMPORIZADOR DENTRO DE FASTAPI, y no es un olvido: la API
    puede correr con varias réplicas, y un temporizador por réplica es el mismo
    barrido ejecutándose tantas veces como procesos haya. Esto lo llama un
    planificador de fuera, igual que el vencimiento de reservas.

    UNO A UNO Y CON SU CERROJO. Un `update ... where` masivo no dejaría el
    renglón del historial de cada uno, y ese renglón es el que explica después
    por qué un caso está en mediación sin que nadie lo pidiera.
    """
    await esquema.exigir_incidencias(db)
    momento = momento or ahora()
    candidatos = list(
        await db.scalars(
            select(ProductIncident.id)
            .where(
                ProductIncident.status == maquina.ABIERTA,
                ProductIncident.seller_response_due_at.is_not(None),
                ProductIncident.seller_response_due_at <= momento,
            )
            .order_by(ProductIncident.seller_response_due_at)
            .limit(lote)
        )
    )
    escalados = 0
    for incidencia_id in candidatos:
        caso = await _bloqueado(db, incidencia_id)
        if caso is None or caso.status != maquina.ABIERTA:
            continue
        #: RECOMPROBADO BAJO EL CERROJO. Entre la lista y el cerrojo el
        #: proveedor puede haber contestado, y escalarlo entonces le quitaría
        #: una respuesta que sí llegó a tiempo.
        limite = pedidos.comparable(caso.seller_response_due_at, momento)
        if limite is None or limite > momento:
            continue
        await mover(
            db,
            incidencia_id=incidencia_id,
            hasta=maquina.MEDIACION,
            actor_id=None,
            actor_rol=maquina.SISTEMA,
            nota=None,
            momento=momento,
        )
        #: SE AVISA, Y ES EL PASO QUE MÁS LO NECESITA. Lo encontró la revisión
        #: independiente: el escalado por silencio es el único que ocurre SIN
        #: QUE NADIE LO PIDA, y era justo el que no se comunicaba. Quien reclama
        #: no sabía que su caso había cambiado de manos, y el proveedor no sabía
        #: que había perdido el turno.
        #:
        #: DENTRO DE LA TRANSACCIÓN DE ESE CASO, antes del `commit`: un aviso de
        #: algo que después no se guarda es peor que no avisar.
        await avisar(db, caso=caso, estado=maquina.MEDIACION)
        await db.commit()
        escalados += 1
    return escalados


# --------------------------------------------------------------------------- #
# Las listas
# --------------------------------------------------------------------------- #
async def mias(
    db: AsyncSession, *, usuario_id: str, limite: int = 50
) -> list[ProductIncident]:
    await esquema.exigir_incidencias(db)
    return list(
        await db.scalars(
            select(ProductIncident)
            .where(ProductIncident.buyer_id == usuario_id)
            .order_by(ProductIncident.created_at.desc(), ProductIncident.id.desc())
            .limit(max(1, min(int(limite), 200)))
        )
    )


#: QUÉ CASOS HA VISTO YA QUIEN VENDE. Los que se le enviaron, y ninguno más.
#:
#: LO ENCONTRÓ LA REVISIÓN INDEPENDIENTE: un caso recién abierto —un borrador,
#: sin fotografías y sin aviso— aparecía en la lista del proveedor con la
#: descripción entera dentro. La documentación dice que el proveedor se entera
#: en el paso 3, al enviarse; aquí lo leía en el paso 1.
#:
#: SE DEDUCE, Y SE PUEDE DEDUCIR, porque `enviar` es lo único que pone el plazo
#: y porque desde el Incremento 7 un caso no sale de ABIERTA sin sus
#: fotografías. Así que: con plazo puesto, se envió; en cualquier estado que no
#: sea ABIERTA ni RETIRADA, se envió —para llegar ahí hubo que pasar la puerta—;
#: y un borrador retirado no llegó a salir de las manos de quien lo abrió.
def _ya_se_lo_enviaron(consulta):
    return consulta.where(
        or_(
            ProductIncident.seller_response_due_at.is_not(None),
            ProductIncident.status.not_in(
                [maquina.ABIERTA, maquina.RETIRADA]
            ),
        )
    )


async def de_mi_tienda(
    db: AsyncSession, *, seller_id: str, limite: int = 50
) -> list[ProductIncident]:
    """Los casos de MI tienda que YA SE ME ENVIARON.

    Un borrador que quien compró está preparando no es mío todavía, y su
    descripción es texto libre que cuenta lo que le pasó en su casa.
    """
    await esquema.exigir_incidencias(db)
    return list(
        await db.scalars(
            _ya_se_lo_enviaron(
                select(ProductIncident).where(
                    ProductIncident.seller_id == seller_id
                )
            )
            .order_by(ProductIncident.created_at.desc(), ProductIncident.id.desc())
            .limit(max(1, min(int(limite), 200)))
        )
    )


async def en_mediacion(
    db: AsyncSession, *, limite: int = 50
) -> list[ProductIncident]:
    """La cola de Z: lo que espera a una persona.

    LOS QUE MÁS LLEVAN ESPERANDO, PRIMERO. Y NO SE MARCA NINGUNO COMO FUERA DE
    PLAZO: el blueprint pide que Z decida en «tres días hábiles» y «hábil»
    depende de un calendario de festivos que nadie ha definido.
    """
    await esquema.exigir_incidencias(db)
    return list(
        await db.scalars(
            select(ProductIncident)
            .where(
                ProductIncident.status.in_((maquina.MEDIACION, maquina.APELADA))
            )
            .order_by(ProductIncident.created_at, ProductIncident.id)
            .limit(max(1, min(int(limite), 200)))
        )
    )


# --------------------------------------------------------------------------- #
# Los avisos. DESPUÉS del hecho, y sin prometer nada
# --------------------------------------------------------------------------- #
async def avisar(
    db: AsyncSession, *, caso: ProductIncident, estado: str, lo_hizo: str | None = None
) -> None:
    """Le cuenta a quien toca lo que acaba de pasar con el caso.

    A QUIEN NO LO HIZO. Contarle a quien acaba de escribir algo que eso ha
    pasado es contarle lo que acaba de hacer, y por eso `lo_hizo` deja fuera a
    quien dio el paso.

    NINGÚN TEXTO PROMETE DINERO. «Resuelta» dice que hay una decisión, no que
    haya un reembolso hecho: eso no existe.
    """
    if estado == maquina.ABIERTA:
        #: AL PROVEEDOR, que es quien tiene que contestar. Hace falta su perfil.
        vendedor = await db.get(ProductSeller, caso.seller_id)
        if vendedor is not None:
            await avisos.encolar(
                db,
                usuario_id=vendedor.profile_id,
                tipo=avisos.INCIDENCIA_ABIERTA,
                entidad_id=caso.id,
            )
        return
    tipo = {
        maquina.RESPONDIDA: avisos.INCIDENCIA_RESPONDIDA,
        maquina.MAS_EVIDENCIA: avisos.INCIDENCIA_MAS_EVIDENCIA,
        maquina.MEDIACION: avisos.INCIDENCIA_EN_MEDIACION,
        maquina.RESUELTA: avisos.INCIDENCIA_RESUELTA,
    }.get(estado)
    if tipo is None:
        return

    #: PASAR A MEDIACIÓN LO TIENEN QUE SABER LOS DOS, y es el único paso del que
    #: hay que avisar a quien vende además de a quien compra: pierde el turno.
    #:
    #: LO ENCONTRÓ LA REVISIÓN INDEPENDIENTE, y el caso que más lo necesita es
    #: el escalado por silencio: es el único paso que ocurre SIN QUE NADIE LO
    #: PIDA, y era justo el que no se contaba. Quien reclama no sabía que su
    #: caso había cambiado de manos y el proveedor no sabía que ya no era suyo.
    destinatarios: list[str] = [caso.buyer_id]
    if estado == maquina.MEDIACION:
        vendedor = await db.get(ProductSeller, caso.seller_id)
        if vendedor is not None:
            destinatarios.append(vendedor.profile_id)

    for quien in destinatarios:
        if quien == lo_hizo:
            continue
        await avisos.encolar(db, usuario_id=quien, tipo=tipo, entidad_id=caso.id)


__all__ = [
    "ApelacionAgotada",
    "ApelacionFueraDePlazo",
    "ApelacionSinEvidenciaNueva",
    "Caso",
    "CasoNoEncontrado",
    "DemasiadaEvidencia",
    "FaltaEvidencia",
    "MotivoInvalido",
    "NoHayNadaQueReclamar",
    "NoLeToca",
    "DEPOSITO",
    "Prueba",
    "ROL_DE_AUDITORIA",
    "ResolucionInvalida",
    "YaHayUnCaso",
    "abrir",
    "ahora",
    "anadir_prueba",
    "avisar",
    "bloquea_el_dinero",
    "cuantas_pruebas",
    "de_mi_tienda",
    "de_quien_compra",
    "de_quien_vende",
    "del_pedido",
    "en_mediacion",
    "enviar",
    "escalar_las_vencidas",
    "firmar",
    "exigir_mediador",
    "hay_caso_vivo",
    "leer",
    "ruta_de",
    "mias",
    "mover",
    "puede_mediar",
]
