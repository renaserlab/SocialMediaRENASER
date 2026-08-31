"""Esquemas de las resenas entre personas.

LO QUE ESTOS TIPOS FIJAN, Y ES EL CAMBIO DE FONDO respecto a `testimonials`:
el TEXTO es obligatorio y el archivo opcional. En la galeria era al reves
—`storage_path` NOT NULL y `caption` con default ''—, y por eso la hoja de la
aplicacion desactivaba el boton hasta elegir una foto: publicar una opinion
escrita, sin mas, era literalmente imposible.
"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

#: Estados de una resena. Coincide con el CHECK de `profile_reviews` (0030).
ESTADOS = ("published", "hidden", "removed")

#: Tipos de archivo que acompanan a una resena. Coincide con el CHECK de
#: `review_media`. No hay `audio` ni `document` a proposito: una resena se lee,
#: y un adjunto que hay que descargar para entenderla no acompana a nada.
TIPOS_DE_MEDIO = ("image", "video")

#: Cuantos archivos puede llevar una resena. Tres bastan para ensenar lo que se
#: cuenta; sin tope, una sola resena puede empujar fuera de pantalla a las
#: demas del perfil.
MAXIMO_DE_MEDIOS = 3


class ReviewMediaInput(BaseModel):
    """Un archivo YA SUBIDO a Storage que acompana a la resena.

    Viaja la RUTA, no el fichero: la subida la hace la aplicacion directamente
    contra Supabase Storage —asi el archivo no atraviesa la API— y aqui solo se
    guarda donde quedo. Que la ruta sea de quien dice ser se comprueba en el
    router: ver `_exigir_ruta_propia`.
    """

    storage_path: str = Field(min_length=1, max_length=500)
    media_type: str = Field(pattern=r"^(image|video)$")


class ReviewCreate(BaseModel):
    """Publicar una resena sobre otra persona."""

    #: Sobre QUIEN. Sin este campo no hay resena que valga: es exactamente lo
    #: que le faltaba a `testimonials`.
    reviewed_user_id: str = Field(min_length=1)

    #: Lo que se opina. OBLIGATORIO, y con un minimo real: `min_length=1`
    #: dejaria pasar un espacio, y una resena en blanco ocupa el sitio de la
    #: unica que esa persona puede escribir.
    body: str = Field(min_length=1, max_length=2000)

    #: Fotos o videos. Vacio es lo normal y no resta nada.
    media: list[ReviewMediaInput] = Field(default_factory=list, max_length=MAXIMO_DE_MEDIOS)

    #: De QUE CURSO habla, si habla de alguno (migracion 0041). OPCIONAL: la
    #: mayoria de las resenas no van de un curso concreto, y no llevarlo no es
    #: un defecto.
    #:
    #: EL SERVIDOR NO SE FIA DE ESTE VALOR. No basta con que sea un uuid: tiene
    #: que ser un curso REAL y ADEMAS de la persona resenada. Sin esa segunda
    #: condicion, cualquiera podria colgar su opinion sobre Ana del curso de
    #: Bruno, y en el perfil de Bruno apareceria como valoracion de su programa.
    course_id: str | None = None

    @field_validator("body")
    @classmethod
    def _texto_de_verdad(cls, v: str) -> str:
        limpio = v.strip()
        if not limpio:
            raise ValueError("Escribe tu reseña: el texto es obligatorio.")
        return limpio


class ReviewUpdate(BaseModel):
    """Cambiar de opinion sobre lo que ya se escribio.

    Solo el texto y los archivos. `reviewed_user_id` NO esta aqui a proposito:
    permitir cambiarlo convertiria una resena sobre A en una resena sobre B
    conservando su fecha y su sello de verificacion, que es una forma silenciosa
    de mentir. Para opinar de otra persona se escribe otra resena.

    `status` tampoco: esconder es moderacion y tiene su propio endpoint.
    """

    body: str | None = Field(default=None, min_length=1, max_length=2000)
    #: `None` = no se tocan los archivos. Una lista vacia SI los quita todos.
    media: list[ReviewMediaInput] | None = Field(default=None, max_length=MAXIMO_DE_MEDIOS)

    #: El curso del que habla (0041). Aqui `None` NO significa «no lo toques»:
    #: significa «quitalo». La diferencia entre «no lo mandes» y «mandalo vacio»
    #: la resuelve `model_fields_set` en el router, porque con un solo valor por
    #: defecto las dos cosas serian indistinguibles y no habria forma de
    #: desenlazar un curso elegido por error.
    course_id: str | None = None

    @field_validator("body")
    @classmethod
    def _texto_de_verdad(cls, v: str | None) -> str | None:
        if v is None:
            return None
        limpio = v.strip()
        if not limpio:
            raise ValueError("La reseña no puede quedarse sin texto.")
        return limpio


class ReviewMediaRead(BaseModel):
    id: str
    storage_path: str
    media_type: str
    sort_order: int = 0

    model_config = ConfigDict(from_attributes=True)


class ReviewRead(BaseModel):
    id: str
    reviewer_id: str
    reviewed_user_id: str

    #: Se resuelven en el servidor: la tarjeta necesita un nombre y una cara, y
    #: pedir el perfil por separado seria una peticion por resena.
    reviewer_name: str = ""
    reviewer_username: str | None = None
    reviewer_avatar_path: str | None = None

    body: str
    status: str
    media: list[ReviewMediaRead] = Field(default_factory=list)

    #: `booking` | `course` | None. La aplicacion ensena el sello solo cuando
    #: viene con fuente; no se calcula en el cliente porque el cliente no puede
    #: ver las reservas ni las compras de nadie.
    verified_source: str | None = None

    #: El curso del que habla, si habla de alguno (0041). `None` es lo normal.
    course_id: str | None = None
    #: Su titulo, resuelto en el servidor. Sin el, la tarjeta tendria que pedir
    #: el curso por separado —una peticion por resena— solo para pintar un
    #: rotulo. Va vacio cuando no hay curso.
    course_title: str | None = None

    created_at: datetime
    updated_at: datetime

    #: Si quien pregunta puede borrarla o editarla. Lo decide el servidor y se
    #: vuelve a comprobar en cada escritura; aqui solo sirve para no ensenar
    #: botones que van a dar 403.
    #:
    #: OJO: esto es `true` para quien la ESCRIBIO y para la moderacion, NUNCA
    #: para la persona resenada. Que el opinado pudiera borrar lo que no le
    #: gusta vaciaria de sentido la seccion entera.
    can_manage: bool = False

    model_config = ConfigDict(from_attributes=True)


class ReviewsAvailability(BaseModel):
    """Si el dominio de resenas esta montado en ESTA base.

    Existe para que la aplicacion pueda no ensenar el boton «Escribir resena»
    mientras la 0030 espere aprobacion, en vez de ofrecerlo y responder 503 al
    pulsarlo. Es la misma idea que `playback_available` en los directos: decir
    la verdad antes, no despues.
    """

    available: bool

    #: Si ADEMAS se puede decir a que curso se refiere (migracion 0041).
    #:
    #: Va aparte de `available` porque son dos cosas distintas y se aplicaran en
    #: momentos distintos: con la 0030 puesta y la 0041 no, se pueden escribir
    #: resenas pero no enlazarlas a un curso. Ofrecer el selector en ese caso
    #: seria pedir un dato que se va a tirar sin decirlo.
    courses_available: bool = False
