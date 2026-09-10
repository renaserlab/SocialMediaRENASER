"""Contratos de Eventos: los del organizador y los de la revisión.

DOS FAMILIAS SEPARADAS, como en la evaluación de cursos, y por la misma razón
estructural: `EventoDelOrganizador` NO declara los ocho puntajes. No es que se
filtren y se quiten; es que no caben. Así, añadir un campo al expediente interno
no puede publicarlo por descuido en la respuesta que ve quien organiza.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.modules.events import admission

MODALIDAD = "^(online|presential|live)$"


class BorradorCreate(BaseModel):
    """Lo que hace falta para empezar. Casi todo opcional a propósito.

    Un borrador se guarda a medias: obligar a rellenarlo entero para poder
    guardar es lo que hace que la gente escriba el evento en otro sitio y lo
    pegue de una vez.
    """

    title: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)
    #: Qué vivirá quien vaya. Es lo segundo de la ficha del blueprint.
    promise: str | None = Field(default=None, max_length=200)
    category: str | None = Field(default=None, max_length=48)
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    #: La zona horaria REAL del evento (`America/Lima`). `starts_at` guarda el
    #: instante; sin esto no se puede escribir «19:00 hora de Lima» sin mentir.
    timezone: str | None = Field(default=None, max_length=64)
    location: str | None = Field(default=None, max_length=200)
    cover_path: str | None = Field(default=None, max_length=500)
    whatsapp_url: str | None = Field(default=None, max_length=500)
    event_type: str = Field(default="presential", pattern=MODALIDAD)
    capacity: int | None = Field(default=None, ge=0, le=1_000_000)


class BorradorUpdate(BaseModel):
    """Todo opcional: un PATCH cambia lo que trae y deja lo demás."""

    title: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=2000)
    promise: str | None = Field(default=None, max_length=200)
    category: str | None = Field(default=None, max_length=48)
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    timezone: str | None = Field(default=None, max_length=64)
    location: str | None = Field(default=None, max_length=200)
    cover_path: str | None = Field(default=None, max_length=500)
    whatsapp_url: str | None = Field(default=None, max_length=500)
    event_type: str | None = Field(default=None, pattern=MODALIDAD)
    capacity: int | None = Field(default=None, ge=0, le=1_000_000)
    #: `workflow_status` y `selection_status` NO están, y no es un olvido: el
    #: ciclo se mueve con acciones con nombre, no con un campo editable.


class EnvioARevision(BaseModel):
    motivo: str = Field(default="", max_length=500)


class VersionRead(BaseModel):
    version: int
    status: str
    reason: str = ""
    changed_fields: list[str] = Field(default_factory=list)
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ObservacionRead(BaseModel):
    """Lo que el organizador ve de una decisión: qué pasó y por qué.

    NO LLEVA LOS PUNTAJES. La evaluación interna es la deliberación de
    curaduría; enseñarla convierte la revisión en un regateo por dos puntos.
    """

    decision: str
    reason: str
    version: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class EventoDelOrganizador(BaseModel):
    """Su evento, tal y como lo ve quien lo organiza."""

    id: str
    title: str
    description: str
    promise: str | None = None
    category: str | None = None
    timezone: str | None = None
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    location: str | None = None
    cover_path: str | None = None
    whatsapp_url: str | None = None
    event_type: str
    capacity: int | None = None
    approved_capacity: int | None = None
    #: El estado con los derivados resueltos (`SOLD_OUT`, `COMPLETED_PENDING`).
    workflow_status: str
    #: `none`, `pending`, `approved` o `rejected`. El sello solo con `approved`.
    selection_status: str
    #: Verdadero solo si el servidor lo confirma. La app NO lo deduce.
    seleccionado_por_z: bool = False
    current_version: int | None = None
    registrations_count: int = 0
    #: Por qué no se puede enviar todavía. `None` cuando sí se puede.
    motivo_para_no_enviar: str | None = None
    #: Si el evento admite edición ahora mismo.
    editable: bool = False
    ultima_observacion: ObservacionRead | None = None


class PuntajesDeAdmision(BaseModel):
    """Los ocho criterios del blueprint, cada uno con su tope."""

    propuesta: int = Field(ge=0, le=admission.CRITERIOS["propuesta"])
    trayectoria: int = Field(ge=0, le=admission.CRITERIOS["trayectoria"])
    programa: int = Field(ge=0, le=admission.CRITERIOS["programa"])
    recinto: int = Field(ge=0, le=admission.CRITERIOS["recinto"])
    seguridad: int = Field(ge=0, le=admission.CRITERIOS["seguridad"])
    precio: int = Field(ge=0, le=admission.CRITERIOS["precio"])
    accesibilidad: int = Field(ge=0, le=admission.CRITERIOS["accesibilidad"])
    afinidad: int = Field(ge=0, le=admission.CRITERIOS["afinidad"])


class EvaluacionCreate(PuntajesDeAdmision):
    #: Evidencia obligatoria: una nota sin por qué no es evidencia.
    evidencia: str = Field(min_length=1, max_length=2000)
    falla_critica: bool = False
    motivo_de_la_falla: str = Field(default="", max_length=500)


class EvaluacionRead(PuntajesDeAdmision):
    version: int
    total: int
    falla_critica: bool
    motivo_de_la_falla: str = ""
    evidencia: str
    #: Hasta dónde permite llegar este puntaje. No es la decisión.
    decision_posible: str
    updated_at: datetime


class DecisionCreate(BaseModel):
    decision: str = Field(pattern="^(approved|conditional|rejected|changes_requested)$")
    #: Obligatorio. Sin motivo no hay decisión de admisión.
    motivo: str = Field(min_length=1, max_length=1000)


class MotivoObligatorio(BaseModel):
    motivo: str = Field(min_length=1, max_length=1000)


class DocumentoUpsert(BaseModel):
    kind: str = Field(min_length=1, max_length=48)
    status: str = Field(
        default="pending", pattern="^(pending|received|approved|rejected|expired)$"
    )
    expires_at: datetime | None = None
    required: bool = True
    blocks_publication: bool = True
    note: str = Field(default="", max_length=500)
    file_path: str | None = Field(default=None, max_length=500)


class DocumentoRead(BaseModel):
    kind: str
    status: str
    expires_at: datetime | None = None
    required: bool
    blocks_publication: bool
    note: str = ""

    model_config = ConfigDict(from_attributes=True)


class ExpedienteRead(EventoDelOrganizador):
    """La ficha de revisión. Añade lo que solo ve quien revisa."""

    organizer_id: str
    origin: str
    submitted_at: datetime | None = None
    evaluacion: EvaluacionRead | None = None
    documentos: list[DocumentoRead] = Field(default_factory=list)
    #: Los requisitos que hoy impedirían publicar.
    bloqueos_para_publicar: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Entradas e inventario (Incremento 2)
#
# EL CLIENTE NO MANDA PRECIOS. `HoldCreate` lleva tipo y cantidad, y nada más:
# lo que cuesta cada entrada lo lee el servidor de la base. No es que se ignore
# un precio que llegue; es que no cabe en el contrato.
# --------------------------------------------------------------------------- #


class TicketingRead(BaseModel):
    """La configuración de venta de un evento."""

    access_mode: str
    currency: str
    max_per_order: int | None = None
    sales_open_at: datetime | None = None
    sales_close_at: datetime | None = None


class TicketingUpsert(BaseModel):
    access_mode: str = Field(pattern="^(FREE_RSVP|TICKETED|INVITATION_ONLY)$")
    currency: str = Field(default="PEN", pattern="^[A-Z]{3}$")
    max_per_order: int | None = Field(default=None, ge=1, le=100)
    sales_open_at: datetime | None = None
    sales_close_at: datetime | None = None


class TicketTypeRead(BaseModel):
    """Un tipo de entrada, como lo ve quien compra.

    NO LLEVA EL CUPO. `quota` es inventario del organizador; lo que necesita
    quien elige es cuántas quedan, y eso viaja en `disponibles`.
    """

    id: str
    name: str
    description: str = ""
    price_minor: int
    currency: str
    min_per_order: int
    max_per_order: int
    inclusions: list[str] = Field(default_factory=list)
    restrictions: list[str] = Field(default_factory=list)
    sort_order: int = 0
    disponibles: int = 0


class TicketTypeDelOrganizador(TicketTypeRead):
    """El mismo tipo, con lo que solo le importa a quien lo administra."""

    quota: int
    status: str


class TicketTypeCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    #: En unidad MENOR y entero. 4900 son S/ 49.00. Cero vale: una cortesía.
    #:
    #: EL TOPE NO ES ARBITRARIO. Las columnas son `bigint`, pero el tope del
    #: contrato tiene que dejar sitio a la multiplicación: con 100 entradas por
    #: operación y 20 líneas, un precio de mil millones desbordaría cualquier
    #: entero. Diez millones de céntimos son cien mil soles por entrada, que es
    #: mucho más de lo que cuesta cualquier evento real.
    price_minor: int = Field(ge=0, le=10_000_000)
    quota: int = Field(ge=1, le=1_000_000)
    min_per_order: int = Field(default=1, ge=1, le=100)
    max_per_order: int = Field(default=10, ge=1, le=100)
    inclusions: list[str] = Field(default_factory=list, max_length=20)
    restrictions: list[str] = Field(default_factory=list, max_length=20)
    status: str = Field(default="draft", pattern="^(draft|on_sale|paused|retired)$")
    sort_order: int = Field(default=0, ge=0, le=1000)
    #: `currency` NO está: la pone el evento. Un tipo en otra moneda dentro del
    #: mismo evento lo rechaza una clave ajena compuesta de la 0061.


class TicketTypeUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    price_minor: int | None = Field(default=None, ge=0, le=10_000_000)
    quota: int | None = Field(default=None, ge=1, le=1_000_000)
    min_per_order: int | None = Field(default=None, ge=1, le=100)
    max_per_order: int | None = Field(default=None, ge=1, le=100)
    inclusions: list[str] | None = Field(default=None, max_length=20)
    restrictions: list[str] | None = Field(default=None, max_length=20)
    status: str | None = Field(default=None, pattern="^(draft|on_sale|paused|retired)$")
    sort_order: int | None = Field(default=None, ge=0, le=1000)


class DisponibilidadRead(BaseModel):
    """Lo que queda ahora mismo. Se calcula; no hay contador que mantener."""

    #: `None` cuando el evento no tiene aforo: mandan solo los cupos por tipo.
    general: int | None = None
    por_tipo: dict[str, int] = Field(default_factory=dict)
    #: El tope de entradas por operación del EVENTO. `None` si no hay uno propio.
    #:
    #: Viaja aquí porque sin él la pantalla dejaba pulsar «+» hasta agotar las
    #: existencias y el servidor rechazaba la operación entera: un botón que
    #: lleva a un callejón. No es inventario, es una regla que quien compra
    #: necesita saber antes de elegir.
    max_per_order: int | None = None


class LineaPedida(BaseModel):
    ticket_type_id: str
    quantity: int = Field(ge=1, le=100)


class HoldCreate(BaseModel):
    """Lo que el cliente manda para apartar entradas.

    Tipo y cantidad. Ni precio, ni moneda, ni subtotal, ni total: eso lo decide
    el servidor y el contrato no ofrece dónde escribirlo.
    """

    items: list[LineaPedida] = Field(min_length=1, max_length=20)


class LineaDeHold(BaseModel):
    ticket_type_id: str
    #: El nombre CONGELADO. Si el organizador lo cambia, el resumen no cambia.
    name: str
    quantity: int
    unit_price_minor: int
    subtotal_minor: int


class HoldRead(BaseModel):
    """Una reserva temporal. NO ES UNA COMPRA, y el contrato no lo insinúa."""

    id: str
    event_id: str
    #: `ACTIVE`, `EXPIRED`, `RELEASED` o `CONSUMED`, con el reloj ya aplicado:
    #: un `ACTIVE` pasado de hora llega como `EXPIRED`.
    status: str
    currency: str
    #: SOLO LAS ENTRADAS. No es el total a pagar: faltan comisión, impuestos y
    #: condiciones, que la empresa no ha definido. Ver `docs/`.
    subtotal_minor: int
    items: list[LineaDeHold] = Field(default_factory=list)
    expires_at: datetime
    #: Segundos que quedan según el SERVIDOR. El contador del cliente es
    #: informativo; quien decide si venció es esto.
    segundos_restantes: int = 0


class VencidosRead(BaseModel):
    procesados: int


# --------------------------------------------------------------------------- #
# Órdenes, entradas y check-in (Incremento 3)
# --------------------------------------------------------------------------- #
class LineaDeOrden(BaseModel):
    ticket_type_id: str
    #: CONGELADO al comprar. El organizador puede renombrar el tipo después.
    name: str
    quantity: int
    unit_price_minor: int
    subtotal_minor: int


class OrdenRead(BaseModel):
    """Un pedido de entradas.

    NO ES UNA ENTRADA hasta que `status` es `PAID`, y no es una factura nunca:
    faltan comisión, impuestos y entidad vendedora, que la empresa no ha
    decidido. La pantalla lo llama pedido y lo dice.
    """

    id: str
    event_id: str
    #: `PENDING_PAYMENT`, `PAYMENT_PROCESSING`, `PAID`, `PAYMENT_FAILED`,
    #: `EXPIRED` o `CANCELLED`.
    status: str
    currency: str
    subtotal_minor: int
    #: HOY IGUAL AL SUBTOTAL. Existe aparte porque comisión e impuestos suman
    #: por encima cuando existan, no para insinuar que hoy hay cargos ocultos.
    total_minor: int
    items: list[LineaDeOrden] = Field(default_factory=list)
    created_at: datetime
    paid_at: datetime | None = None
    #: Cuánto le queda a la reserva que sostiene este pedido. Cero significa que
    #: el pedido ya no se puede pagar aunque su estado tarde en reflejarlo.
    segundos_restantes: int = 0
    #: NUNCA la referencia del proveedor ni notas internas: quien compra no
    #: necesita el `pi_...` y publicarlo solo ayuda a quien quiera cruzarlo.


class IntentoDePagoRead(BaseModel):
    """A dónde ir a pagar. El importe no viaja: lo sabe el servidor."""

    order_id: str
    provider: str
    checkout_url: str


class EntradaRead(BaseModel):
    """Una entrada emitida, sin su credencial.

    La credencial se pide aparte y se entrega una sola vez: ver
    `CredencialRead`.
    """

    id: str
    event_id: str
    order_id: str
    ticket_type_id: str
    name: str
    #: `VALID`, `USED` o `REVOKED`.
    status: str
    #: El código que se teclea si la cámara falla. No es secuencial.
    #:
    #: `null` cuando quien pregunta NO es el dueño: el código admite por sí solo,
    #: así que devolvérselo al organizador que revoca es repartir una entrada.
    code: str | None = None
    issued_at: datetime
    checked_in_at: datetime | None = None


class CredencialRead(BaseModel):
    """El valor que va DENTRO del QR, entregado una vez.

    No se guarda en el servidor —solo su `sha256`— y pedirla otra vez genera
    una nueva, dejando la anterior inservible. Es lo que hace que un QR
    fotografiado y compartido deje de valer.

    LA IMAGEN LA DIBUJA EL CLIENTE. Aquí viaja el valor, no un PNG: guardar
    imágenes de QR en la base es guardar entradas.
    """

    ticket_id: str
    #: Opaco. Ni nombre, ni correo, ni precio, ni el identificador de la entrada.
    credential: str
    code: str


class VerificarRequest(BaseModel):
    #: Lo que leyó la cámara, o lo que se tecleó.
    credential: str = Field(min_length=1, max_length=200)


class CheckinRequest(BaseModel):
    credential: str = Field(min_length=1, max_length=200)


class CambioPublicadoRequest(BaseModel):
    """Editar un evento YA PUBLICADO. Exige motivo.

    `expected_version` es el control de concurrencia: si quien edita traia una
    version distinta de la vigente, se le dice en vez de pisar lo que otro
    acaba de guardar.
    """

    reason: str = Field(min_length=1, max_length=500)
    expected_version: int | None = None
    title: str | None = None
    description: str | None = None
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    location: str | None = None
    event_type: str | None = None
    capacity: int | None = None
    promise: str | None = None
    category: str | None = None
    timezone: str | None = None


class CambioRegistradoRead(BaseModel):
    """Lo que quedo anotado. SIN clasificar, y se dice."""

    version: int
    #: Los campos que cambiaron. Cada uno deja una fila pendiente de mirar.
    campos: list[str] = Field(default_factory=list)
    #: Cuantos cambios de este evento esperan clasificacion, contando estos.
    sin_clasificar: int = 0


class VeredictoRead(BaseModel):
    """Lo que la puerta necesita saber, y NADA que no necesite.

    Sin nombre ni correo de quien compró: el operador decide si pasa, no
    conoce a la persona.
    """

    #: `OK`, `ALREADY_USED`, `REVOKED`, `NOT_FOUND`, `WRONG_EVENT` o
    #: `NOT_ADMITTING`.
    result: str
    ticket_id: str | None = None
    name: str | None = None
    checked_in_at: datetime | None = None


class AsistenteRead(BaseModel):
    """Una fila de la lista de asistentes, para el organizador.

    LLEVA EL TIPO Y EL ESTADO, NO AL COMPRADOR. Quién compró cada entrada no le
    hace falta a la puerta, y el organizador no necesita el correo de nadie para
    dejarle pasar.

    Y NO LLEVA EL CÓDIGO. El código admite por sí solo, así que volcarlos todos
    en una lista es repartir entradas: con ella se podría marcar como usada
    cualquiera sin que la persona esté delante. Se sigue pudiendo BUSCAR por
    código —el parámetro `q` filtra en la base—, que es lo que la pantalla de
    respaldo necesita: se teclea el que la persona enseña.
    """

    ticket_id: str
    ticket_type_id: str
    name: str
    status: str
    checked_in_at: datetime | None = None


class VentasRead(BaseModel):
    """El resumen del evento para quien lo organiza.

    `ingresos_brutos_minor` cuenta SOLO pedidos pagados, y es BRUTO: no es lo
    que el organizador va a cobrar. Faltan comisión, impuestos y liquidación,
    que son decisiones que nadie ha tomado todavía. La pantalla lo dice con
    esas palabras en vez de enseñar una cifra que parece un ingreso.
    """

    #: `null` si el evento no declaró aforo.
    aforo: int | None = None
    entradas_apartadas: int = 0
    entradas_emitidas: int
    entradas_validas: int = 0
    entradas_usadas: int
    entradas_revocadas: int
    ordenes_pagadas: int
    ordenes_pendientes: int
    ingresos_brutos_minor: int
    currency: str | None = None
    #: Gente DENTRO: check-ins correctos distintos. No pedidos, no compradores.
    checkins: int = 0


class PaginaDeOrdenes(BaseModel):
    items: list[OrdenRead] = Field(default_factory=list)
    #: `null` cuando no hay más. Se pagina por cursor y no por número de página:
    #: con filas que se crean mientras alguien mira, el desplazamiento repite y
    #: se salta resultados.
    next_cursor: str | None = None


class PaginaDeEntradas(BaseModel):
    items: list[EntradaRead] = Field(default_factory=list)
    next_cursor: str | None = None


class PaginaDeAsistentes(BaseModel):
    items: list[AsistenteRead] = Field(default_factory=list)
    next_cursor: str | None = None


class RevocarRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=200)
