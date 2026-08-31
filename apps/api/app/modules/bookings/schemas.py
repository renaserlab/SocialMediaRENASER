"""Esquemas de la agenda y, sobre todo, QUE transiciones de estado valen."""

from datetime import datetime, timezone as tz

from pydantic import BaseModel, ConfigDict, Field

from app.modules.profiles.schemas import ProfileSummary

#: Estados de una sesion. Un enum de verdad y no cadenas sueltas repartidas por
#: el codigo: con textos libres basta una errata en un sitio para que una sesion
#: quede en un estado que nadie sabe leer.
ESTADOS = (
    "pending",
    "accepted",
    "rejected",
    "cancelled",
    "reschedule_requested",
    "completed",
    "expired",
)

#: Que puede hacer CADA PARTE desde cada estado.
#:
#: Se declara como una tabla y no como una cadena de `if` porque estas reglas
#: son el producto, no un detalle: quien recibe la solicitud acepta o rechaza;
#: quien la pidio no puede aceptarse a si mismo; una sesion rechazada no se
#: "descancela"; y completar solo tiene sentido sobre algo aceptado.
TRANSICIONES: dict[str, dict[str, set[str]]] = {
    # estado actual -> { rol -> estados a los que puede pasar }
    "pending": {
        "provider": {"accepted", "rejected", "reschedule_requested"},
        "requester": {"cancelled", "reschedule_requested"},
    },
    "reschedule_requested": {
        "provider": {"accepted", "rejected", "reschedule_requested"},
        "requester": {"accepted", "cancelled", "reschedule_requested"},
    },
    "accepted": {
        # Completar la puede marcar cualquiera de las dos: la sesion ocurrio
        # para ambas. Si solo pudiera una, bastaria con que se despistara para
        # que la otra no pudiera dejar resena nunca.
        "provider": {"completed", "cancelled", "reschedule_requested"},
        "requester": {"completed", "cancelled", "reschedule_requested"},
    },
    # Finales: no se sale de ellos. Una sesion rechazada o cancelada se vuelve
    # a pedir creando otra, para que quede la historia de las dos.
    "rejected": {},
    "cancelled": {},
    "completed": {},
    "expired": {},
}


def transicion_permitida(actual: str, siguiente: str, rol: str) -> bool:
    return siguiente in TRANSICIONES.get(actual, {}).get(rol, set())


def es_momento_futuro(momento: datetime | None, ahora: datetime) -> bool:
    """Si `momento` todavia no ha pasado, medido contra `ahora`.

    QUE PROBLEMA RESUELVE. Nada impedia proponer una sesion para el martes
    pasado: la fila se creaba, salia en la agenda de las dos partes y se podia
    aceptar. Una agenda que admite fechas que ya ocurrieron no es una agenda.

    DOS DECISIONES QUE NO SON UN DETALLE:

    1. SE COMPARAN INSTANTES, NUNCA CADENAS. «02/09/2026» y «2026-09-02» son la
       misma fecha y dos cadenas distintas, y `'10:00' < '9:00'` es cierto como
       texto. Comparar fechas escritas es un fallo que parece funcionar hasta
       que cambia el formato o llega otra zona horaria.

    2. `ahora` SE RECIBE, no se lee aqui. Quien manda es el reloj del SERVIDOR
       —el del telefono lo elige quien lo lleva, y adelantarlo un dia seria todo
       lo que hace falta para colar una fecha pasada—; pasarlo por parametro
       ademas deja esta regla comprobable en el limite exacto sin esperar a que
       pase el tiempo de verdad.

    ZONA HORARIA. Un instante sin zona no dice cuando ocurre: las 17:00 de Lima
    y las 17:00 de Madrid son momentos distintos. La aplicacion manda siempre
    UTC (`toISOString`), pero si llegara uno sin zona se interpreta como UTC en
    vez de rechazarlo: `datetime.now(utc) > naive` revienta con TypeError, y un
    500 sin cabeceras CORS se lee en el navegador como un fallo de red.
    """
    if momento is None:
        # Sin fecha no hay nada que validar: la sesion se acuerda por chat, que
        # es un caso legitimo y el que existia antes de que hubiera selector.
        return True
    if momento.tzinfo is None:
        momento = momento.replace(tzinfo=tz.utc)
    return momento > ahora


class BookingCreate(BaseModel):
    """Solicitar una sesion. Quien la pide sale del token, nunca del cuerpo."""

    provider_id: str
    topic: str = Field(min_length=1, max_length=200)
    note: str = Field(default="", max_length=1000)
    scheduled_at: datetime | None = None
    #: Zona horaria IANA de quien propone ("America/Lima").
    timezone: str | None = Field(default=None, max_length=64)


class BookingUpdate(BaseModel):
    """Cambio de estado y, si se reprograma, la nueva fecha."""

    status: str = Field(pattern=r"^(accepted|rejected|cancelled|reschedule_requested|completed)$")
    scheduled_at: datetime | None = None
    timezone: str | None = Field(default=None, max_length=64)


class BookingRead(BaseModel):
    id: str
    topic: str
    note: str = ""
    status: str
    scheduled_at: datetime | None = None
    timezone: str | None = None
    conversation_id: str | None = None
    completed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    #: Las dos partes, ya resueltas: la agenda tiene que poder pintar el nombre
    #: y la foto sin pedir un perfil por fila.
    requester: ProfileSummary
    provider: ProfileSummary
    #: "provider" si quien pregunta es a quien se lo piden; "requester" si es
    #: quien lo pidio. Evita que el movil tenga que compararlo por su cuenta.
    my_role: str

    model_config = ConfigDict(from_attributes=True)
