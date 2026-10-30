"""Esquemas de mensajería."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.modules.content.schemas import AuthorSummary
from app.modules.messaging.etiquetas import EtiquetaBreve

#: Los filtros de la bandeja. Son ESTADOS DERIVADOS: se calculan de los mensajes
#: y cambian solos. No son etiquetas, y por eso viajan en un parámetro distinto
#: (`filtro`) del de las etiquetas (`label_id`), que sí son categorías que pone
#: una persona a mano. Se pueden combinar; no se mezclan.
#:
#: Mezclar los dos ejes —guardar «no leído» como una etiqueta manual— es lo que
#: convierte un CRM en un cajón de sastre: nadie vuelve a desmarcarla a mano, así
#: que a los dos días la etiqueta miente.
#:
#: SON EXACTAMENTE TRES. La bandeja de Instagram ofrece además «verificados» y
#: «más de 10 000 seguidores»; aquí no se copian porque no responden a ninguna
#: pregunta que se haga quien atiende su bandeja en esta aplicación.
FILTROS_DE_BANDEJA = ("unread", "unanswered", "story_replies")

FiltroDeBandeja = Literal["unread", "unanswered", "story_replies"]

#: Cuánto texto se acepta buscando. Ochenta caracteres son más que cualquier
#: nombre real; el tope está para que nadie mande un `LIKE` de diez kilobytes.
MAX_BUSQUEDA = 80

#: Los tipos de adjunto que la interfaz sabe pintar: una foto, un vídeo, un
#: archivo que se descarga o una nota de voz. Aceptar un tipo más aquí sería
#: guardar filas que ninguna pantalla puede mostrar.
#:
#: `audio` LO AÑADE LA 0044, y por eso no basta con nombrarlo aquí: mientras esa
#: migración no esté aplicada, el `CHECK` de `message_attachments.kind` sigue
#: rechazándolo y escribirlo sería una violación de restricción, o sea un 500
#: que en el navegador aparece disfrazado de error de CORS. El router lo corta
#: antes con un 503 legible (ver `audio.exigir_esquema_de_audio`) y la interfaz
#: ni siquiera ofrece grabar hasta que `GET /conversations/availability` dice
#: que sí.
TIPOS_DE_ADJUNTO = ("image", "video", "document", "audio")

#: Cuántos archivos caben en un mensaje. Diez es holgado para mandar un puñado
#: de fotos de una vez y evita que una sola petición encole cien subidas.
MAX_ADJUNTOS = 10

#: Cuántos caracteres puede tener el nombre de un adjunto (0113). El mismo
#: número que el `CHECK` de la migración: si aquí fuera mayor, la base
#: rechazaría el nombre y saldría un 500 en vez del 422 que corresponde.
MAX_TITULO_DE_ADJUNTO = 80

#: Lo que se acepta CRUDO antes de recortar. No es el tope de verdad —ese es
#: `MAX_TITULO_DE_ADJUNTO`, después de recortar, con su código propio
#: (`attachment_title_too_long`)—: solo impide que alguien mande diez
#: kilobytes de espacios.
MAX_TITULO_CRUDO = 1000

#: Los tipos que NO llevan nombre: una foto ya tiene el texto del mensaje
#: (decisión del 30/10/2026). Al enviar se ignora; al ponérselo después, 422.
TIPOS_SIN_NOMBRE = ("image",)


def titulo_recortado(valor: str | None) -> str | None:
    """El nombre como se guarda: sin espacios en los extremos, y vacío es «sin nombre».

    Solo los EXTREMOS, como dice la spec: lo de dentro es de quien lo escribe.
    Una cadena vacía no se guarda nunca —el `CHECK` de la 0113 la rechaza—,
    porque «sin nombre» ya tiene su forma, que es nulo, y dos formas de decir
    lo mismo acaban en dos pantallas que no se ponen de acuerdo.
    """
    if valor is None:
        return None
    limpio = valor.strip()
    return limpio or None


class DirectConversationCreate(BaseModel):
    user_id: str


class ConversationRead(BaseModel):
    id: str
    kind: str
    title: str | None = None
    # Para chats directos: el otro participante.
    other: AuthorSummary | None = None
    #: La foto de un GRUPO (ruta del almacenamiento). En un chat directo va
    #: a nulo: la foto es la de `other`. Nulo tambien sin la migracion 0104.
    avatar_path: str | None = None
    last_message: str | None = None
    last_message_at: datetime | None = None
    unread_count: int = 0
    #: Quien pregunta la tiene silenciada: no recibe sus avisos. Es SUYO: a
    #: los demás miembros no les dice nada. `false` sin la migración 0107.
    muted: bool = False
    updated_at: datetime

    #: Las etiquetas del CRM que QUIEN PREGUNTA le ha puesto a esta conversación.
    #:
    #: SON PRIVADAS Y ESO SE DECIDE AQUÍ, no en la pantalla. La etiqueta que Ana
    #: le pone a su conversación con Bruno, Bruno no la ve jamás: el filtro por
    #: dueño está en `etiquetas_por_conversacion`, así que esta lista sale ya
    #: recortada y NO hay ningún camino por el que la del otro lado pueda
    #: colarse. Esconderla en el móvil no serviría: lo que sale del servidor
    #: acaba viéndose en la respuesta cruda, en otro cliente o en un registro.
    #:
    #: VIENEN DENTRO DE LA FILA y no en una petición aparte por conversación:
    #: son UNA consulta más con un `IN` sobre los identificadores de la página
    #: —el mismo patrón que `otros_participantes` y `no_leidos`— en vez de una
    #: por fila, que con veinte filas serían veinticuatro consultas.
    #:
    #: Lista vacía mientras la 0045 espere aprobación, y eso es la verdad: sin
    #: la tabla no hay etiquetas, no hay un error que contar.
    labels: list[EtiquetaBreve] = Field(default_factory=list)

    #: Si es una COMUNIDAD, el grupo del que cuelga (0109). `None` en todo lo
    #: demás. Sin `grouped`, las comunidades salen como filas propias y esto es
    #: lo que deja a la aplicación decir «Valorant · en Aula».
    parent_id: str | None = None
    #: Cuántos temas vivos tiene el grupo (0108). Solo con `?grouped=true`.
    topics_count: int = 0
    #: Cuántas comunidades vivas tiene el grupo (0109). Solo con `?grouped=true`.
    subgroups_count: int = 0
    #: El globo de la fila. Con `?grouped=true`, en un grupo suma lo no leído
    #: de General, de sus comunidades donde está quien pregunta y de sus temas:
    #: las comunidades no salen sueltas (D12), así que si no se sumaran aquí no
    #: se verían en ningún sitio. Sin `grouped`, y en un chat de dos, es igual a
    #: `unread_count`.
    total_unread: int = 0
    #: Cuántas personas hay en un GRUPO, contando a quien pregunta. `None` en
    #: un chat de dos, que siempre son dos.
    #:
    #: EXISTE PARA QUE EL TELÉFONO NO PREGUNTE NADA MÁS. La bandeja solo atiende
    #: «está escribiendo» en los grupos pequeños: en uno grande, cada aviso de
    #: escritura se multiplica por todos los que lo tienen en su bandeja, y
    #: Supabase cobra cada entrega contra el tope de mensajes por segundo del
    #: plan (auditoría del 28/10, §10). Sin este número el teléfono tendría que
    #: pedir la ficha de cada grupo para saber su tamaño. Es UNA consulta con un
    #: `GROUP BY` sobre los grupos de la página, y ninguna si no hay grupos.
    members_count: int | None = None

    model_config = ConfigDict(from_attributes=True)


class AttachmentCreate(BaseModel):
    """Un archivo YA SUBIDO a Storage que se quiere colgar de un mensaje.

    Los bytes NO pasan por el backend: la aplicación sube directamente al bucket
    `message-media` con su propio token, igual que hace con las publicaciones, y
    aquí solo llega la ruta. Es lo que permite subir un vídeo grande por trozos
    reanudables sin que la API tenga que sostener la conexión mientras tanto.

    Que la ruta sea legítima —que apunte a ESTA conversación y a la carpeta de
    quien la manda— lo comprueba el router antes de guardar nada.
    """

    storage_path: str = Field(min_length=1, max_length=512)
    kind: str
    mime_type: str | None = Field(default=None, max_length=255)
    file_name: str | None = Field(default=None, max_length=255)
    bytes: int | None = Field(default=None, ge=0)
    width: int | None = Field(default=None, ge=0)
    height: int | None = Field(default=None, ge=0)
    duration_s: float | None = Field(default=None, ge=0)
    #: El nombre que le pone quien lo manda (0113). Recortado; vacío es `None`.
    #: El tope de 80 lo comprueba el router con su código propio
    #: (`attachment_title_too_long`), no aquí: un `ValueError` de Pydantic
    #: saldría como un `validation_error` genérico. En una foto se ignora.
    title: str | None = Field(default=None, max_length=MAX_TITULO_CRUDO)
    #: Si un `audio` es una nota de voz grabada en el chat (`true`) o un
    #: archivo de audio elegido del teléfono (`false`). SI NO VIENE, VALE
    #: `kind == "audio"`: las aplicaciones que ya están en los teléfonos no lo
    #: mandan, y todo lo que mandan como audio es una nota de voz. En lo que no
    #: es audio no significa nada y se guarda `false`.
    voice_note: bool | None = None

    @field_validator("title")
    @classmethod
    def _titulo(cls, v: str | None) -> str | None:
        return titulo_recortado(v)

    @model_validator(mode="after")
    def _tipo_conocido(self) -> "AttachmentCreate":
        if self.kind not in TIPOS_DE_ADJUNTO:
            raise ValueError(
                f"Tipo de adjunto no admitido: {self.kind}. "
                f"Admitidos: {', '.join(TIPOS_DE_ADJUNTO)}."
            )
        if self.kind in TIPOS_SIN_NOMBRE:
            # Se ignora y no se rechaza: una aplicación que mande el mismo
            # formulario para todo no tiene por qué fallar por una foto.
            self.title = None
        if self.kind != "audio":
            self.voice_note = False
        elif self.voice_note is None:
            self.voice_note = True
        return self


class AttachmentRead(BaseModel):
    id: str
    storage_path: str
    kind: str
    mime_type: str | None = None
    file_name: str | None = None
    bytes: int | None = None
    width: int | None = None
    height: int | None = None
    duration_s: float | None = None
    #: El nombre (0113). `None` es «sin nombre», y también mientras la 0113
    #: espere: sin la columna no hay nombre que devolver.
    title: str | None = None
    #: Si es una nota de voz (micrófono) o un archivo de audio (nota musical).
    #: `false` en todo lo que no es audio. Sin la 0113 vale `kind == "audio"`,
    #: que era la verdad hasta entonces.
    voice_note: bool = False

    model_config = ConfigDict(from_attributes=True)


class TituloDeAdjunto(BaseModel):
    """`PATCH …/attachments/{id}`: el nombre nuevo, o `null` para quitarlo.

    `title` es OBLIGATORIO aunque admita nulo: un cuerpo vacío por un fallo
    del cliente no puede borrar el nombre de nadie sin que nadie lo pidiera.
    """

    title: str | None = Field(max_length=MAX_TITULO_CRUDO)

    @field_validator("title")
    @classmethod
    def _titulo(cls, v: str | None) -> str | None:
        return titulo_recortado(v)


class TemaBreve(BaseModel):
    """Un tema en el que está un mensaje: lo que pinta su etiqueta («# Anuncios»)."""

    id: str
    name: str


class StoryContextRead(BaseModel):
    """De qué historia era respuesta un mensaje. Siempre puede estar degradado.

    NO ES UN ENLACE DENTRO DEL TEXTO, y esa es la diferencia que importa. El
    cuerpo del mensaje es de quien lo escribe; meter ahí la URL de la historia
    haría imposible distinguir una respuesta de verdad de alguien que pegó un
    enlace, obligaría a la bandeja a buscar cadenas dentro de los mensajes de
    todo el mundo para filtrar «Respuestas a historias», y dejaría un enlace
    muerto en medio de la frase en cuanto la historia caducara.

    `story_id` VIENE A NULO EN CUANTO LA HISTORIA DEJA DE EXISTIR, que es el
    caso normal y no la excepción: una historia dura un día y el mensaje que la
    responde dura para siempre. Entonces `available` es `false`, el medio y el
    pie no vienen, y la burbuja escribe «Historia no disponible». Lo que NUNCA
    se pierde es `story_owner`: sin él no se podría ni decir de quién era.
    """

    #: `None` cuando la historia ya no existe (caducada o borrada por su autor).
    story_id: str | None = None
    #: De quién era la historia. Se conserva aunque la historia desaparezca.
    story_owner: AuthorSummary
    #: `story_id is not None`. Se manda explícito para que la pantalla no tenga
    #: que deducir de un nulo qué debe pintar.
    available: bool = False
    #: Solo mientras la historia exista. Se firma en el móvil, como los adjuntos.
    media_path: str | None = None
    media_type: str | None = None
    caption: str | None = None

    model_config = ConfigDict(from_attributes=True)


class MessageCreate(BaseModel):
    """Un mensaje: solo texto, solo archivo, o texto y archivo.

    `body` admite la cadena vacía —antes exigía al menos un carácter— porque
    mandar una foto sin escribir nada es lo normal en un chat. Lo que NO se
    admite es un mensaje que no diga nada: sin texto y sin archivos no hay nada
    que entregar, y guardar una burbuja vacía solo sirve para confundir a quien
    la recibe.
    """

    body: str = Field(default="", max_length=5000)
    attachments: list[AttachmentCreate] = Field(
        default_factory=list, max_length=MAX_ADJUNTOS
    )
    #: El mensaje de ESTA conversación al que se responde, si se responde a uno.
    #:
    #: Solo el identificador: de quién era y qué decía lo lee el servidor. Si
    #: no es de esta conversación, o la 0106 no está, el mensaje se manda
    #: igual, sin cita.
    reply_to_id: str | None = None
    #: La historia que se está respondiendo, cuando el mensaje sale del visor.
    #:
    #: SOLO EL IDENTIFICADOR. De quién es la historia lo averigua el servidor
    #: leyendo la fila; aceptarlo de la petición dejaría que cualquiera
    #: atribuyera su mensaje a la historia de otra persona, y ese dato es
    #: justamente el que sobrevive cuando la historia desaparece.
    #:
    #: Que la historia ya no exista NO invalida el mensaje: se manda igual, sin
    #: contexto. Ver `historias.guardar_contexto`.
    story_id: str | None = None

    @model_validator(mode="after")
    def _no_vacio(self) -> "MessageCreate":
        if not self.body.strip() and not self.attachments:
            raise ValueError("Escribe algo o adjunta un archivo.")
        return self


class ReactionRead(BaseModel):
    """Una reacción a un mensaje, agrupada: «❤ 3»."""

    emoji: str
    count: int = 1
    #: Una de ellas es de quien pregunta.
    mine: bool = False


class ReplyRead(BaseModel):
    """La cita de un mensaje que responde a otro.

    `excerpt` va vacío y `deleted` a `true` cuando el original se borró: el
    texto de un mensaje eliminado no viaja, tampoco dentro de una cita.
    `kind` es el tipo de su primer adjunto, para poder decir «Foto» cuando
    no tenía texto.
    """

    id: str
    sender_id: str
    sender_name: str = ""
    excerpt: str = ""
    kind: str | None = None
    #: Con `kind == "audio"`: nota de voz (`true`, «Nota de voz») o archivo de
    #: audio (`false`, «Audio»), para que la cita sin texto ni nombre diga lo
    #: que es; la etiqueta la pone la aplicacion, traducida. `false` en lo
    #: demas; sin la 0113, todo audio es nota de voz.
    voice_note: bool = False
    deleted: bool = False


class MessageRead(BaseModel):
    id: str
    conversation_id: str
    sender: AuthorSummary
    body: str
    created_at: datetime
    #: Vacía cuando el mensaje es solo texto, y también mientras la migración
    #: 0033 espere aprobación: sin la tabla no hay adjuntos que devolver.
    attachments: list[AttachmentRead] = Field(default_factory=list)

    #: Cuándo lo borró quien lo escribió. `None` en la inmensa mayoría.
    #:
    #: POR QUÉ EL MENSAJE BORRADO SE SIGUE ENTREGANDO. Porque si desapareciera
    #: sin dejar hueco, la conversación mentiría: quien está al otro lado leyó
    #: algo que ahora no está y no sabría que se ha borrado ni que hubo algo
    #: ahí. Se entrega la marca y NADA MÁS —`body` vacío y sin adjuntos, ver
    #: `list_messages`—, y la aplicación pinta «Mensaje eliminado». El texto
    #: original no viaja: borrar para todos tiene que borrar de verdad para
    #: todos, y un cliente distinto del nuestro leería lo que le llegara.
    deleted_at: datetime | None = None

    #: A qué historia respondía este mensaje, si respondía a alguna.
    #:
    #: `None` en la inmensa mayoría, y también mientras la 0044 espere
    #: aprobación: sin la tabla no hay contexto que devolver. Un mensaje que SÍ
    #: respondía a una historia ya borrada no llega aquí como `None`, sino con
    #: `available: false` — la diferencia entre «esto no era una respuesta» y
    #: «esto respondía a algo que ya no está» es justo lo que la burbuja tiene
    #: que saber para escribir «Historia no disponible».
    story_context: StoryContextRead | None = None

    #: De qué sesión 1:1 habla este mensaje, si habla de alguna.
    #:
    #: `None` en la inmensa mayoría, y también mientras la 0097 espere: sin la
    #: tabla el mensaje sale como texto normal. Ver `BookingContextRead`.
    booking_context: "BookingContextRead | None" = None

    #: Las reacciones, agrupadas. Vacía en la inmensa mayoría, y también
    #: mientras la 0106 espere aprobación o si el mensaje está borrado.
    reactions: list[ReactionRead] = Field(default_factory=list)
    #: A qué mensaje responde, si responde a alguno.
    reply_to: ReplyRead | None = None

    #: Los temas VIVOS en los que está este mensaje, en el orden de la lista de
    #: temas. Solo se rellena en General de una comunidad con temas (es lo
    #: único que un tema puede referenciar); vacía en todo lo demás, en un
    #: mensaje borrado y mientras la 0108 espere. La ven todos los miembros.
    #:
    #: Se carga UNA VEZ POR PÁGINA, como los adjuntos y las reacciones
    #: (`temas.temas_por_mensaje`): nunca una consulta por burbuja.
    topics: list[TemaBreve] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class BookingContextRead(BaseModel):
    """La sesión de la que habla un mensaje, con su estado de HOY.

    `event` ES LO QUE PASÓ EN ESTE MENSAJE (se pidió, se aceptó, se canceló…) y
    no cambia nunca. `status` ES CÓMO ESTÁ LA SESIÓN AHORA y sí cambia: por eso
    la tarjeta de una solicitud ya aceptada deja de ofrecer «Aceptar» aunque el
    mensaje sea el mismo. El estado sale de `bookings` en cada lectura; aquí no
    se guarda copia que pueda quedarse vieja.

    `my_role` evita que el móvil compare identificadores para saber qué botones
    le tocan a quien mira.
    """

    booking_id: str
    event: str
    status: str
    topic: str
    note: str = ""
    scheduled_at: datetime | None = None
    timezone: str | None = None
    #: "provider" si a quien mira se la pidieron; "requester" si la pidió.
    my_role: str
    updated_at: datetime | None = None


MessageRead.model_rebuild()


class MessagingAvailability(BaseModel):
    """Qué funciones del chat existen en ESTA instalación.

    POR QUÉ SE PREGUNTA EN VEZ DE PROBAR. Sin esto, la única forma de saber si
    se puede mandar una nota de voz sería grabarla, subirla y recibir un 503:
    el botón parecería funcionar, la persona hablaría treinta segundos y lo
    perdería todo. Se pregunta antes y, mientras la respuesta sea `false`, la
    interfaz no ofrece grabar. Nunca un botón muerto.

    Mismo patrón que `GET /reviews/availability` para la 0030.
    """

    #: Se puede adjuntar `kind: audio` (migración 0044 aplicada).
    voice_notes: bool = False
    #: Se guarda la referencia a la historia respondida (misma migración).
    #: Es también lo que decide si la bandeja ofrece el filtro
    #: «Respuestas a historias».
    story_replies: bool = False
    #: Se puede reaccionar a un mensaje y responder a uno concreto (0106).
    reactions: bool = False
    #: Se puede silenciar una conversación y vaciarla para uno mismo (0107).
    preferences: bool = False
    #: El servidor dice quién leyó cada mensaje (`lecturas.py`, sin migración).
    read_receipts: bool = False
    #: Un grupo puede tener temas (0108).
    topics: bool = False
    #: Un grupo puede tener comunidades (0109).
    subgroups: bool = False
    #: Los adjuntos guardan su nombre y si un audio es nota de voz (0113). Con
    #: `false`, la aplicacion no ofrece «Ponerle nombre» ni los campos de
    #: nombre: el nombre se ignoraria al mandar y ponerlo despues responde 503.
    attachment_titles: bool = False
