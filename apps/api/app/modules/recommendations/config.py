"""Que pregunta el cuestionario y cuanto pesa cada cosa al ordenar.

Todo lo AJUSTABLE del recomendador vive aqui, en un solo sitio y versionado.
Los pesos no son verdad permanente: son un punto de partida que habra que
mover cuando haya datos reales. Repartidos por el codigo, moverlos significaria
buscarlos; aqui se leen de un vistazo, se prueban y se apagan uno a uno.

Nada de este fichero toca la base de datos ni depende de FastAPI: se puede
importar desde un test sin levantar nada.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

# --------------------------------------------------------------------------- #
# Versiones
# --------------------------------------------------------------------------- #
#: Version del cuestionario. Sube cuando cambien las PREGUNTAS, no cuando
#: cambie el texto de una opcion. Quien contesto una version anterior no
#: vuelve a verlo salvo que el producto decida lo contrario: por eso se guarda
#: el numero y no un simple «ya lo hizo».
ONBOARDING_VERSION = 1

#: Version del algoritmo. Viaja en cada respuesta para poder comparar
#: resultados entre versiones el dia que haya una segunda.
RECOMMENDATION_ALGORITHM_VERSION = "people-v1"

#: Version del recomendador de contenido. Va aparte del de personas porque
#: evolucionaran a ritmos distintos.
CONTENT_ALGORITHM_VERSION = "content-v1"


# --------------------------------------------------------------------------- #
# Vocabulario de las relaciones PERSONA -> TEMA
# --------------------------------------------------------------------------- #
#: Lo que la persona BUSCA. Es informacion privada: ver la migracion 0026.
RELACIONES_DE_DEMANDA: tuple[str, ...] = ("interest", "learn", "seek_guidance")

#: Lo que la persona OFRECE. Puede formar parte del perfil publico porque es
#: una declaracion hecha para que la encuentren.
RELACIONES_DE_OFERTA: tuple[str, ...] = ("can_help", "teach", "experienced")

RELACIONES: tuple[str, ...] = RELACIONES_DE_DEMANDA + RELACIONES_DE_OFERTA


# --------------------------------------------------------------------------- #
# Cuestionario (pregunta 1, 3, 4 y 5). Las opciones se sirven al movil desde
# el backend para que anadir una no obligue a publicar una version de la app.
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Opcion:
    """Una respuesta posible. `clave` es lo que se guarda; `etiqueta` lo que se lee."""

    clave: str
    etiqueta: str
    #: Frase corta bajo la etiqueta. Vacia cuando la etiqueta ya se explica sola.
    ayuda: str = ""


#: Pregunta 1 — ¿que te gustaria encontrar en Z?
OBJETIVOS: tuple[Opcion, ...] = (
    Opcion("aprender", "Aprender algo nuevo"),
    Opcion("encontrar_experiencia", "Encontrar personas con experiencia"),
    Opcion("resolver", "Resolver una necesidad o un problema"),
    Opcion("orientacion", "Recibir orientación"),
    Opcion("mejorar_profesionalmente", "Mejorar profesionalmente"),
    Opcion("emprender", "Emprender o hacer crecer un negocio"),
    Opcion("cursos", "Encontrar cursos"),
    Opcion("compartir", "Compartir mi experiencia"),
    Opcion("ensenar", "Enseñar a otras personas"),
    Opcion("conectar", "Conectar con personas afines"),
)

#: Pregunta 3 — ¿que tipo de conexion te seria mas util?
#:
#: Cada opcion dice a QUE relacion de la otra persona corresponde. Ese mapa es
#: lo que convierte una respuesta humana en una consulta: «quiero un mentor»
#: pasa a ser «gente que ensena o puede ayudar».
TIPOS_DE_CONEXION: tuple[Opcion, ...] = (
    Opcion("ensena", "Alguien que pueda enseñarme"),
    Opcion("experiencia_practica", "Alguien con experiencia práctica"),
    Opcion("mentor", "Un mentor"),
    Opcion("profesional", "Un profesional"),
    Opcion("paso_por_lo_mismo", "Alguien que haya pasado por algo similar"),
    Opcion("afines", "Personas con intereses parecidos"),
)

#: A que relacion de la OTRA persona apunta cada tipo de conexion.
RELACION_POR_CONEXION: dict[str, tuple[str, ...]] = {
    "ensena": ("teach",),
    "experiencia_practica": ("experienced",),
    "mentor": ("teach", "can_help"),
    "profesional": ("teach", "experienced"),
    "paso_por_lo_mismo": ("experienced",),
    # «Personas afines» no busca a alguien que ofrezca algo, sino a alguien que
    # quiera lo mismo. Se resuelve aparte, comparando intereses.
    "afines": (),
}

#: Pregunta 4 — ¿como prefieres aprender o conectar?
FORMATOS: tuple[Opcion, ...] = (
    Opcion("video", "Videos"),
    Opcion("publicacion", "Publicaciones"),
    Opcion("audio", "Audios / pódcast"),
    Opcion("curso", "Cursos"),
    Opcion("mensaje", "Mensajes"),
    Opcion("sesion_1a1", "Sesiones 1 a 1"),
    Opcion("comunidad", "Comunidades"),
)

#: Pregunta 5 — ¿en que forma puedes ayudar?
#:
#: Declarar «tengo experiencia» NO es «experto verificado». Estas opciones solo
#: describen lo que alguien dice poder aportar; la reputacion comprobable
#: llegara con las sesiones completadas y las resenas verificadas.
MODOS_DE_OFERTA: tuple[Opcion, ...] = (
    Opcion("puedo_ayudar", "Puedo ayudar", "Respondo dudas y acompaño"),
    Opcion("puedo_ensenar", "Puedo enseñar", "Explico y guío paso a paso"),
    Opcion("tengo_experiencia", "Tengo experiencia práctica", "Lo he hecho, no solo leído"),
    Opcion("creo_contenido", "Creo contenido sobre esto"),
    Opcion("ofrezco_sesiones", "Ofrezco sesiones 1 a 1"),
)

#: Que relacion con el tema implica cada modo de oferta. Los dos ultimos modos
#: no crean relacion: describen el CANAL, no el conocimiento.
RELACION_POR_MODO_DE_OFERTA: dict[str, str | None] = {
    "puedo_ayudar": "can_help",
    "puedo_ensenar": "teach",
    "tengo_experiencia": "experienced",
    "creo_contenido": None,
    "ofrezco_sesiones": None,
}

CLAVES_DE_OBJETIVO = frozenset(o.clave for o in OBJETIVOS)
CLAVES_DE_CONEXION = frozenset(o.clave for o in TIPOS_DE_CONEXION)
CLAVES_DE_FORMATO = frozenset(o.clave for o in FORMATOS)
CLAVES_DE_OFERTA = frozenset(o.clave for o in MODOS_DE_OFERTA)


# --------------------------------------------------------------------------- #
# Pesos del ranker de personas
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class PesosDePersonas:
    """Cuanto suma cada componente del score, y cual esta encendido.

    Poner un peso a 0 APAGA el componente sin borrar su codigo ni sus pruebas:
    es la forma de comprobar en produccion si algo aporta o estorba.

    Los valores no suman 1 por casualidad; se normaliza al final para que el
    score quede en 0..1 y sea comparable entre versiones.
    """

    #: Coincidencia entre lo que el usuario busca y lo que el candidato ofrece.
    #: Es el corazon: sin esto, esto no es un recomendador de personas.
    tema: float = 0.34
    #: Que el TIPO de conexion pedido coincida con lo que el candidato declara.
    intencion: float = 0.18
    #: Que el candidato publique en el formato que la persona prefiere.
    formato: float = 0.08
    #: Que exista de verdad: publica, responde, esta activo.
    actividad: float = 0.12
    #: Lo que el propio usuario ha hecho: perfiles que abrio, contenido que vio.
    comportamiento: float = 0.18
    #: Reputacion COMPROBABLE. Hoy vale 0 a proposito: el sistema de resenas
    #: verificadas no existe todavia y los testimonios actuales no lo son.
    #: El hueco queda hecho para que enchufarlo no toque el resto.
    reputacion: float = 0.0
    #: Exploracion: sitio para quien todavia no tiene senales a su favor.
    exploracion: float = 0.10

    def total(self) -> float:
        return (
            self.tema
            + self.intencion
            + self.formato
            + self.actividad
            + self.comportamiento
            + self.reputacion
            + self.exploracion
        )


PESOS_DE_PERSONAS = PesosDePersonas()


@dataclass(frozen=True)
class PesosDeContenido:
    """Como se ordena el contenido.

    Deliberadamente mas pobre que el de personas, y por un motivo honesto: una
    publicacion no declara de que trata. Lo unico que se sabe de su tema es lo
    que declara QUIEN la publico, asi que la afinidad se hereda del autor. El
    dia que el contenido tenga temas propios (o embeddings) este es el sitio
    donde entran.
    """

    #: Afinidad con el autor (el mismo score de personas, ya calculado).
    autor: float = 0.55
    #: Que sea reciente. Sin esto el feed se congela en lo de siempre.
    recencia: float = 0.25
    #: Que a otra gente le haya interesado.
    interaccion: float = 0.10
    exploracion: float = 0.10

    def total(self) -> float:
        return self.autor + self.recencia + self.interaccion + self.exploracion


PESOS_DE_CONTENIDO = PesosDeContenido()


# --------------------------------------------------------------------------- #
# Diversidad y exploracion
# --------------------------------------------------------------------------- #
#: Cuantas publicaciones seguidas del mismo autor admite el feed antes de
#: apartar la siguiente. Con poco catalogo no puede ser 1: dejaria fuera
#: contenido bueno de la unica persona que publica.
MAX_SEGUIDAS_DEL_MISMO_AUTOR = 2

#: Cuantos candidatos se traen antes de ordenar. Mas amplio que la pagina para
#: que el reordenado tenga con que trabajar; acotado para que la consulta no
#: crezca sin techo.
CANDIDATOS_MAXIMOS = 200

#: Dias que cuentan como «actividad reciente» de un perfil.
VENTANA_DE_ACTIVIDAD_DIAS = 30

#: Dias de senales de uso que alimentan el componente de comportamiento. Mas
#: alla, lo que alguien miro hace meses dice poco de lo que necesita hoy.
VENTANA_DE_COMPORTAMIENTO_DIAS = 45

#: Tope de senales leidas por peticion. Un usuario muy activo no puede hacer
#: que su propia pantalla tarde mas que la de los demas.
SENALES_MAXIMAS = 500

#: Cuantas senales de un mismo tipo bastan para dar por saturado el componente.
#: Sin techo, quien abre veinte veces el mismo perfil lo fijaria en el primer
#: puesto para siempre.
SATURACION_DE_SENALES = 5


def pesos_desde(overrides: dict[str, float] | None = None) -> PesosDePersonas:
    """Copia de los pesos con algunos cambiados. Para pruebas y para A/B."""
    if not overrides:
        return PESOS_DE_PERSONAS
    validos = {k: v for k, v in overrides.items() if hasattr(PESOS_DE_PERSONAS, k)}
    return replace(PESOS_DE_PERSONAS, **validos)
