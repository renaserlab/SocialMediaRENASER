"""Esquemas de las transmisiones en vivo."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

#: Los cinco tipos de reaccion. Un catalogo corto es lo que hace que la fila se
#: lea de un vistazo; con veinte, elegir cuesta mas que reaccionar. Tiene que
#: coincidir con el CHECK de `live_reaction_totals` (migracion 0029).
REACCIONES = ("corazon", "aplauso", "fuego", "asombro", "risa")

#: Los estados de una emision. Coincide con el CHECK de `live_sessions`.
ESTADOS = ("scheduled", "live", "ended", "cancelled")


class LiveSessionCreate(BaseModel):
    """Anunciar o empezar una emision."""

    title: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=1000)
    #: Cuando empieza. Si no viene, la emision se crea ya EMITIENDO: es el
    #: caso normal —alguien pulsa «emitir» y emite— y obligar a programar
    #: primero seria un paso de mas para el camino mas frecuente.
    scheduled_for: datetime | None = None


class LiveSessionUpdate(BaseModel):
    """Editar lo que se puede editar de una emision.

    `status` NO esta aqui a proposito: empezar, terminar y cancelar tienen
    validaciones propias y viven en sus endpoints. Dejar cambiar el estado con
    un PATCH permitiria saltarse el orden —terminar algo que no empezo— y
    dejaria la sala del proveedor abierta.
    """

    title: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=1000)
    scheduled_for: datetime | None = None


class LiveSessionRead(BaseModel):
    id: str
    host_id: str
    #: Se resuelve en el servidor: la tarjeta necesita un nombre, y pedir el
    #: perfil por separado seria una peticion por emision.
    host_name: str = ""
    host_username: str | None = None
    host_avatar_path: str | None = None

    title: str
    description: str
    status: str
    scheduled_for: datetime | None = None
    started_at: datetime | None = None
    ended_at: datetime | None = None

    #: Quien sirve el video. `none` mientras no haya proveedor elegido.
    provider: str = "none"
    #: Si HOY se puede ver la imagen. Es false mientras no exista proveedor, y
    #: la aplicacion lo usa para decir la verdad en vez de dejar un reproductor
    #: girando para siempre.
    playback_available: bool = False
    recording_path: str | None = None
    viewer_peak: int = 0

    #: Totales por tipo. Los que nadie ha pulsado salen a 0, no ausentes.
    reactions: dict[str, int] = Field(default_factory=dict)

    #: Si quien pregunta puede gestionar esta emision: quien emite o la
    #: administracion. Lo decide el servidor y se vuelve a comprobar en cada
    #: escritura; aqui solo sirve para no ensenar botones que van a dar 403.
    can_manage: bool = False

    model_config = ConfigDict(from_attributes=True)


class LiveMessageCreate(BaseModel):
    #: 300 caracteres, igual que el CHECK de la base. Un chat en directo se lee
    #: de reojo; un parrafo ahi no lo lee nadie y empuja fuera de pantalla lo
    #: que si estaban leyendo los demas.
    body: str = Field(min_length=1, max_length=300)

    @field_validator("body")
    @classmethod
    def _no_vacio(cls, v: str) -> str:
        limpio = v.strip()
        if not limpio:
            raise ValueError("El mensaje no puede estar vacío.")
        return limpio


class LiveMessageRead(BaseModel):
    id: str
    session_id: str
    user_id: str
    user_name: str = ""
    user_avatar_path: str | None = None
    body: str
    created_at: datetime
    #: Escondido por moderacion. Solo lo ve quien lo escribio y quien modera;
    #: para el resto ni siquiera llega.
    hidden: bool = False

    model_config = ConfigDict(from_attributes=True)


class ReactionFlush(BaseModel):
    """Las reacciones acumuladas que el cliente manda cada pocos segundos.

    NO es una reaccion: es el RESUMEN de las que se pulsaron desde el ultimo
    envio. Los corazones que flotan por la pantalla ya viajaron por Broadcast y
    no tocaron la base; esto solo actualiza el contador.
    """

    #: tipo -> cuantas. El servidor acota el total; ver `LIMITE_POR_ENVIO`.
    counts: dict[str, int] = Field(min_length=1)

    @field_validator("counts")
    @classmethod
    def _tipos_conocidos(cls, v: dict[str, int]) -> dict[str, int]:
        for tipo, cuantas in v.items():
            if tipo not in REACCIONES:
                raise ValueError(f"Reacción no reconocida: '{tipo}'.")
            if cuantas < 0:
                raise ValueError("Una cuenta de reacciones no puede ser negativa.")
        return v


class ReactionTotals(BaseModel):
    session_id: str
    totals: dict[str, int]


class LiveAvailability(BaseModel):
    """Si en este momento se puede emitir con imagen.

    Es lo que consulta la app antes de ofrecer «Vivo». Sin esto la app llevaba
    la respuesta escrita a fuego (`FEATURE_LIVE = false`) y encender los
    directos exigía otra build aunque el servidor ya tuviera proveedor.
    """

    #: `True` solo con un proveedor real registrado (configuración completa).
    video: bool
    #: `'100ms'` o `'none'`. Nunca viaja nada de la cuenta.
    provider: str


class LiveCredential(BaseModel):
    """Permiso temporal para entrar en la sala del proveedor.

    LO MINIMO PARA CONECTARSE, y nada mas. Aqui no viaja la clave de la cuenta,
    ni la plantilla, ni la configuracion, ni quien mas esta dentro.
    """

    #: Con cual de los proveedores hay que conectarse. La pantalla lo necesita
    #: para saber que SDK usar; no es un secreto.
    provider: str = "none"
    token: str
    #: Vacia en los proveedores que llevan la sala dentro del token.
    url: str
    expires_in: int
    can_publish: bool
    #: El rol RESUELTO POR EL SERVIDOR. Viaja para que la pantalla sepa que
    #: controles pintar; lo que manda es lo que va firmado dentro del token.
    role: str = ""
    #: Identificador publico de la sala, para correlacionar registros.
    room_id: str = ""
