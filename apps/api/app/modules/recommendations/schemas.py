"""Contratos de entrada y salida del recomendador.

Regla que atraviesa todo el fichero: NINGUN esquema de entrada lleva
`user_id`. La identidad sale del token, siempre. Un `user_id` en el cuerpo es
una invitacion a escribir las preferencias de otra persona.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.modules.recommendations.config import (
    CLAVES_DE_CONEXION,
    CLAVES_DE_FORMATO,
    CLAVES_DE_OBJETIVO,
    CLAVES_DE_OFERTA,
    RELACIONES,
)

# --------------------------------------------------------------------------- #
# Taxonomia
# --------------------------------------------------------------------------- #
class TopicRead(BaseModel):
    id: str
    slug: str
    name: str
    group: str = Field(serialization_alias="group", validation_alias="topic_group")
    position: int = 0

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class OpcionRead(BaseModel):
    """Una opcion del cuestionario, tal y como la pinta el movil."""

    key: str
    label: str
    help: str = ""


class OnboardingCatalog(BaseModel):
    """Todo lo que hace falta para pintar el cuestionario, en UNA peticion.

    Va junto a proposito: cuatro peticiones para cuatro preguntas convertirian
    una pantalla que debe abrirse al instante en cuatro esperas encadenadas.
    """

    onboarding_version: int
    topics: list[TopicRead]
    goals: list[OpcionRead]
    connection_types: list[OpcionRead]
    content_formats: list[OpcionRead]
    offer_modes: list[OpcionRead]


# --------------------------------------------------------------------------- #
# Estado y guardado del onboarding
# --------------------------------------------------------------------------- #
class OnboardingStatus(BaseModel):
    """La pregunta que decide el arranque: ¿hay que ensenar el cuestionario?

    `should_show` la calcula el SERVIDOR y no el movil. Si la decidiera el
    movil, cada cliente tendria que conocer la version vigente y dos versiones
    de la aplicacion podrian discrepar sobre la misma cuenta.
    """

    completed: bool
    should_show: bool
    onboarding_version: int
    current_version: int
    skipped: bool = False
    completed_at: datetime | None = None


def _validar_claves(valor: list[str], validas: frozenset[str], que: str) -> list[str]:
    desconocidas = sorted(set(valor) - validas)
    if desconocidas:
        raise ValueError(f"{que} no reconocidos: {', '.join(desconocidas)}")
    return list(dict.fromkeys(valor))


class PreferencesInput(BaseModel):
    """Lo que envia el cuestionario al terminar: LAS RESPUESTAS, no las reglas.

    El movil manda lo que la persona toco —estos objetivos, estos temas, estas
    formas de ayudar— y es el servidor quien decide que relacion con cada tema
    implica cada respuesta (ver `service.relaciones_derivadas`).

    Se hizo asi a proposito. Si el movil enviara ya las relaciones
    ('learn', 'can_help'...), esa regla de producto viviria en el cliente:
    cambiarla obligaria a publicar una version en dos tiendas y a convivir con
    versiones antiguas escribiendo relaciones distintas sobre la misma tabla.

    Es un REEMPLAZO, no una suma: editar preferencias tiene que poder QUITAR.
    """

    #: Pregunta 1 — que viene a buscar.
    goals: list[str] = Field(default_factory=list, max_length=16)
    #: Pregunta 2 — en que temas quiere crecer, aprender o encontrar personas.
    learning_topic_ids: list[str] = Field(default_factory=list, max_length=20)
    #: Pregunta 3 — que tipo de conexion le seria util.
    connection_types: list[str] = Field(default_factory=list, max_length=12)
    #: Pregunta 4 — como prefiere aprender o conectar.
    content_formats: list[str] = Field(default_factory=list, max_length=12)
    #: Pregunta 5 — en que forma puede ayudar, y sobre que temas.
    offer_modes: list[str] = Field(default_factory=list, max_length=12)
    offer_topic_ids: list[str] = Field(default_factory=list, max_length=20)
    #: true = paso de largo. Se guarda igual para no volver a preguntarle en
    #: cada arranque, pero sin marcar el cuestionario como respondido.
    skipped: bool = False

    @field_validator("goals")
    @classmethod
    def _objetivos(cls, v: list[str]) -> list[str]:
        return _validar_claves(v, CLAVES_DE_OBJETIVO, "Objetivos")

    @field_validator("connection_types")
    @classmethod
    def _conexiones(cls, v: list[str]) -> list[str]:
        return _validar_claves(v, CLAVES_DE_CONEXION, "Tipos de conexión")

    @field_validator("content_formats")
    @classmethod
    def _formatos(cls, v: list[str]) -> list[str]:
        return _validar_claves(v, CLAVES_DE_FORMATO, "Formatos")

    @field_validator("offer_modes")
    @classmethod
    def _oferta(cls, v: list[str]) -> list[str]:
        return _validar_claves(v, CLAVES_DE_OFERTA, "Formas de ayudar")

    @field_validator("learning_topic_ids", "offer_topic_ids")
    @classmethod
    def _sin_repetidos(cls, v: list[str]) -> list[str]:
        return list(dict.fromkeys(v))


class TopicRelationRead(BaseModel):
    """Un tema y lo que la persona declaro sobre el. Solo se devuelve a su dueno."""

    topic_id: str
    relations: list[str]

    @field_validator("relations")
    @classmethod
    def _conocidas(cls, v: list[str]) -> list[str]:
        return [r for r in v if r in RELACIONES]


class PreferencesRead(BaseModel):
    """Lo guardado, en la misma forma en que se envio. Para poder editarlo.

    Van las RESPUESTAS (lo que el cuestionario tiene que volver a marcar) y
    tambien las relaciones derivadas, para que se pueda comprobar que el
    servidor entendio lo que se le dijo.
    """

    goals: list[str]
    learning_topic_ids: list[str]
    connection_types: list[str]
    content_formats: list[str]
    offer_modes: list[str]
    offer_topic_ids: list[str]
    #: Lo que el servidor dedujo. Informativo: el cuestionario no lo envia.
    derived_relations: list[TopicRelationRead] = Field(default_factory=list)
    onboarding_version: int
    completed_at: datetime | None = None
    skipped: bool = False


# --------------------------------------------------------------------------- #
# Recomendaciones de personas
# --------------------------------------------------------------------------- #
class RecommendationReason(BaseModel):
    """Por que aparece alguien, en piezas que la interfaz sabe redactar.

    NO se manda el score. Un «0.8734261» en pantalla no significa nada para
    quien lo lee y da una falsa impresion de precision. El desglose numerico
    existe, pero se consulta en desarrollo (`?debug=1`), no se pinta.
    """

    code: str
    #: Temas que justifican el motivo. Solo se nombran temas del lado PUBLICO
    #: del candidato (lo que ofrece); nunca lo que esa persona busca.
    topics: list[str] = Field(default_factory=list)


class PersonRecommendation(BaseModel):
    id: str
    full_name: str = ""
    username: str | None = None
    avatar_path: str | None = None
    bio: str = ""
    is_following: bool = False
    reasons: list[RecommendationReason] = Field(default_factory=list)
    #: Desglose del score. Solo viaja con `?debug=1` y fuera de produccion.
    debug: dict[str, float] | None = None


class PeopleRecommendations(BaseModel):
    algorithm_version: str
    #: `personalized` = hubo preferencias con las que trabajar.
    #: `cold_start` = no las habia y esto es el respaldo, dicho en voz alta.
    strategy: str
    items: list[PersonRecommendation]


# --------------------------------------------------------------------------- #
# Senales
# --------------------------------------------------------------------------- #
#: Tipos que el CLIENTE puede declarar. Los que implican una accion real en el
#: servidor (seguir, agendar) no estan aqui: los escribe el backend cuando
#: ocurren de verdad, porque el movil no puede demostrarlos.
EVENTOS_DE_CLIENTE = frozenset(
    {
        "content_impression",
        "content_engaged",
        "content_completed",
        "profile_view",
        "search_result_opened",
        "not_interested",
    }
)

ENTIDADES = frozenset({"post", "profile", "course", "booking", "conversation"})


class BehaviorEventInput(BaseModel):
    event_type: str
    entity_type: str
    entity_id: str | None = None
    #: Proporcion vista (0..1).
    value: float | None = Field(default=None, ge=0, le=1)
    #: Tiempo visible en milisegundos, acotado: un reproductor olvidado en
    #: segundo plano no puede contar como una hora de interes.
    dwell_ms: int | None = Field(default=None, ge=0, le=600_000)
    #: Clave de idempotencia. Repetir un lote no debe duplicar sus senales.
    event_key: str | None = Field(default=None, max_length=120)

    @field_validator("event_type")
    @classmethod
    def _tipo_permitido(cls, v: str) -> str:
        if v not in EVENTOS_DE_CLIENTE:
            raise ValueError(f"El cliente no puede declarar '{v}'.")
        return v

    @field_validator("entity_type")
    @classmethod
    def _entidad_permitida(cls, v: str) -> str:
        if v not in ENTIDADES:
            raise ValueError(f"Entidad no reconocida: '{v}'.")
        return v


class BehaviorEventBatch(BaseModel):
    """Un lote de senales.

    Se envian por lotes y no una a una: una peticion por impresion convertiria
    bajar el feed en una tormenta de red, que es justo lo contrario de lo que
    se quiere conseguir midiendo.
    """

    events: list[BehaviorEventInput] = Field(min_length=1, max_length=50)


class BehaviorEventResult(BaseModel):
    #: Cuantas se guardaron de verdad (las repetidas no cuentan).
    accepted: int
    #: Cuantas se descartaron por venir ya registradas.
    duplicated: int
