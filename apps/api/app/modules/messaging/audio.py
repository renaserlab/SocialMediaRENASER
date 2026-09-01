"""Notas de voz: lo que distingue un `kind: audio` de cualquier otro adjunto.

UNA NOTA DE VOZ ES UN ADJUNTO MAS, y eso es deliberado. Viaja por el mismo
`POST /conversations/{id}/messages`, se sube al mismo bucket privado
`message-media` con la misma forma de ruta —`<conversacion>/<quien sube>/<fichero>`,
que es lo que lleva el permiso—, se firma igual para escucharla y se borra igual.
Lo unico propio es esto: el tipo `audio` y las reglas de abajo.

LO QUE ESTE FICHERO IMPIDE, POR ORDEN DE GRAVEDAD:

1. ESCRIBIR `'audio'` ANTES DE QUE LA 0044 ESTE APLICADA. El `CHECK` de
   `message_attachments.kind` todavia diria ('image','video','document') y la
   insercion seria una violacion de restriccion: un 500 sin capturar, que sale
   de Starlette SIN cabeceras CORS y que el navegador enseña como un fallo de
   red. Horas buscando en el sitio equivocado por una migracion que faltaba. Se
   corta antes, con un 503 y un codigo que la aplicacion entiende.

2. GUARDAR EL AUDIO COMO `document` PARA NO TOCAR EL `CHECK`. Es el parche que
   el encargo prohibe y ni siquiera es comodo: la burbuja no sabria que eso se
   reproduce, `duration_s` no significaria nada, y no habria forma de
   distinguir una nota de voz de un PDF. No se hace en ningun sitio, y la
   ausencia es intencionada.

3. UNA NOTA DE VOZ SIN DURACION. Sin `duration_s` la burbuja no puede pintar ni
   la duracion ni una barra de progreso con sentido, y no hay forma de
   recuperarla sin descargar el fichero entero —que es justo lo que no se quiere
   hacer para pintar una lista—. Se exige al guardar, que es cuando el que graba
   la conoce de sobra.

POR QUE NO HAY AQUI NI SUBIDA NI TRANSCODIFICACION. Los bytes no pasan por el
backend: se suben directamente a Storage desde el telefono con el token de la
persona, igual que las fotos. Aqui solo llega la ruta. Y el formato lo elige el
grabador del sistema (`expo-audio`), que ya da algo que cualquier telefono sabe
reproducir; convertirlo en el servidor seria pagar CPU por un problema que no
existe.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ServiceUnavailableError, ValidationAppError
from app.modules.messaging import esquema
from app.modules.messaging.schemas import AttachmentCreate

#: El tipo de adjunto de una nota de voz. Se nombra una vez para que nadie lo
#: escriba a mano en dos sitios y uno de los dos se quede sin actualizar.
KIND_AUDIO = "audio"

#: Cuanto puede durar una nota de voz, en segundos.
#:
#: Cinco minutos. No es un limite tecnico sino de lo que es razonable escuchar
#: en un chat: mas alla de eso lo que se quiere mandar es un archivo, y para eso
#: ya esta el boton de adjuntar. Ademas acota lo que puede ocupar una sola
#: conversacion en un bucket que nadie modera.
MAX_DURACION_S = 5 * 60

#: Margen que se le perdona a la duracion declarada.
#:
#: EXISTE POR UN CASO REAL Y NO POR PRUDENCIA GENERICA: el contador que ve quien
#: graba y la duracion del fichero que escribe el codificador no coinciden al
#: milisegundo, asi que soltar el dedo justo en el limite producia un rechazo
#: que desde fuera parecia un fallo. Se admite un segundo de mas; lo que se
#: quiere evitar es una nota de media hora, no una de 300,4 segundos.
MARGEN_DE_DURACION_S = 1.0


def es_audio(adjunto: AttachmentCreate) -> bool:
    return adjunto.kind == KIND_AUDIO


def hay_audio(adjuntos: list[AttachmentCreate]) -> bool:
    return any(es_audio(a) for a in adjuntos)


async def exigir_esquema_de_audio(
    db: AsyncSession, adjuntos: list[AttachmentCreate]
) -> None:
    """503 mientras la 0044 espere aprobacion, nunca un 500.

    Solo mira si HAY algun audio: un mensaje con fotos no puede dejar de
    funcionar porque falte una migracion que no le afecta.

    503 y no 404 —que haria pensar que la ruta esta mal escrita— ni 422 —que
    haria pensar que el dato es invalido, cuando es correcto y sencillamente
    todavia no cabe—. Con un codigo propio para que la aplicacion pueda decir
    «las notas de voz todavia no estan disponibles» en vez de un error generico.

    EN LA PRACTICA ESTO NO DEBERIA DISPARARSE NUNCA, y aun asi tiene que estar.
    La interfaz consulta `GET /conversations/availability` y no ofrece grabar
    mientras la respuesta sea `false`, asi que nadie deberia llegar hasta aqui
    con un audio. Pero «la pantalla ya lo comprueba» no es una defensa: basta
    una version antigua de la aplicacion en el telefono de alguien, o un
    reintento guardado de antes, para que llegue igual. La ultima palabra la
    tiene el servidor.
    """
    if not adjuntos or not hay_audio(adjuntos):
        return
    if not await esquema.hay_notas_de_voz(db):
        raise ServiceUnavailableError(
            "Las notas de voz todavía no están disponibles.",
            code="voice_notes_not_available",
        )


def validar_audio(adjuntos: list[AttachmentCreate]) -> None:
    """Las reglas propias de una nota de voz. 422 con un texto que se entiende.

    SE VALIDA AQUI Y NO EN EL ESQUEMA de Pydantic porque son reglas que solo
    valen para `kind: audio`: exigirle `duration_s` a `AttachmentCreate` a secas
    rompeia los documentos y las fotos, que no la tienen ni la necesitan.

    Un audio SIN duracion se rechaza en vez de guardarse con nulo. Guardarlo
    dejaria una burbuja que no puede decir cuanto dura ni pintar una barra, y
    averiguarlo despues obligaria a descargar el fichero entero solo para
    pintar la lista. Quien graba la conoce en el momento; es el unico sitio
    donde sale gratis.
    """
    for adjunto in adjuntos:
        if not es_audio(adjunto):
            continue

        if adjunto.duration_s is None:
            raise ValidationAppError(
                "Una nota de voz tiene que decir cuánto dura.",
                code="voice_note_without_duration",
            )
        # Cero es tan invalido como nulo: es el dedo que resbala, no una nota.
        # Se rechaza aqui para no dejar en el chat una burbuja de audio que al
        # pulsarla no suena nada.
        if adjunto.duration_s <= 0:
            raise ValidationAppError(
                "La nota de voz está vacía.",
                code="voice_note_empty",
            )
        if adjunto.duration_s > MAX_DURACION_S + MARGEN_DE_DURACION_S:
            raise ValidationAppError(
                f"Una nota de voz puede durar hasta {MAX_DURACION_S // 60} minutos.",
                code="voice_note_too_long",
            )

        # El tipo declarado tiene que ser de audio SI VIENE. Se admite que falte
        # —hay grabadores que no lo informan y el fichero es bueno igual— pero no
        # que diga otra cosa: `image/png` marcado como nota de voz solo puede ser
        # un error de quien lo manda o un intento de colar algo por la puerta que
        # menos se mira.
        if adjunto.mime_type and not adjunto.mime_type.lower().startswith("audio/"):
            raise ValidationAppError(
                "Ese archivo no es un audio.",
                code="voice_note_bad_type",
            )
