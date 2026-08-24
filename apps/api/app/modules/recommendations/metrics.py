"""¿Sirvió de algo lo que mostramos?

Esta es la pregunta que la V1 no podia responder, y sin responderla ajustar los
pesos del ranker es opinion. No hace falta entrenar nada todavia; hace falta
EVIDENCIA.

COMO SE MIDE. Una impresion no es «el backend devolvio este candidato»: es
«esto se le puso delante a alguien». Por eso las impresiones las declara el
cliente cuando el elemento se hace visible de verdad, y llevan encima de que
superficie, con que version del orden y en que puesto.

El embudo se lee asi:

    impresion en people_for_you
        -> profile_view del mismo candidato
        -> follow
        -> message_started
        -> booking_requested
        -> booking_completed

La atribucion es por PAREJA (quien mira, a quien) dentro de una ventana de
dias, no por identificador de peticion. Con un id por peticion la cadena se
rompe en cuanto la persona cierra la aplicacion y vuelve al dia siguiente, que
es justo cuando ocurren las conexiones que mas importan.

LO QUE NO HACE. No es una plataforma de analitica, no guarda nada nuevo, y no
devuelve datos personales: solo cuenta. Si no hay nada, devuelve ceros; no se
fabrica un numero para que la tabla se vea llena.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.recommendations.config import (
    CONTENT_ALGORITHM_VERSION,
    COURSE_ALGORITHM_VERSION,
    RECOMMENDATION_ALGORITHM_VERSION,
    SUPERFICIE_CURSOS,
    SUPERFICIE_FEED,
    SUPERFICIE_PERSONAS,
    VENTANA_DE_ATRIBUCION_DIAS,
)
from app.modules.recommendations.models import BehaviorEvent

#: Cuantas senales se leen como maximo. Con techo porque esto es una consulta
#: de gestion, no una pantalla: nadie la espera, pero tampoco puede tumbar la
#: base de datos el dia que haya millones de filas.
MAXIMO_DE_SENALES = 50_000

#: Los pasos del embudo de PERSONAS, en orden de compromiso creciente. Cada uno
#: cuenta una pareja distinta: no es lo mismo abrir un perfil que agendar.
PASOS_DE_PERSONAS = (
    "profile_view",
    "follow",
    "message_started",
    "booking_requested",
    "booking_completed",
)

#: Los del feed. Aqui la entidad es la publicacion, no una persona.
PASOS_DE_CONTENIDO = ("content_engaged", "content_completed", "not_interested")

#: Los de CURSOS. Mismos tipos, entidad distinta: aqui `content_completed` no
#: es «vio el video entero» sino «termino el curso», y lo afirma el SERVIDOR al
#: quedarse sin lecciones pendientes, no el cliente.
#:
#: NO HAY UN PASO «empezo el curso», y no es un olvido. Ningun evento existente
#: significa eso: `content_engaged` es abrir la tarjeta, que no es lo mismo que
#: ponerse. Anadir un tipo nuevo solo para esta tabla seria inventar una senal
#: para poder ensenar una fila. Cuando haga falta de verdad, se anade con su
#: migracion y se dice por que.
PASOS_DE_CURSOS = ("content_engaged", "content_completed", "not_interested")


def _pasos_de(surface: str) -> tuple[str, ...]:
    """Que pasos tiene el embudo de cada superficie.

    Una funcion y no un `if` repartido: estaba escrito tres veces en este
    fichero, y con tres superficies eso son tres sitios donde olvidarse de la
    cuarta.
    """
    if surface == SUPERFICIE_PERSONAS:
        return PASOS_DE_PERSONAS
    if surface == SUPERFICIE_CURSOS:
        return PASOS_DE_CURSOS
    return PASOS_DE_CONTENIDO


#: Las superficies que el informe ensena aunque no tengan ni una impresion.
#: Verlas a cero dice «esto todavia no ha pasado», que es informacion; que
#: falten dice «esto no se mide», que es otra cosa muy distinta.
SUPERFICIES_ESPERADAS = (SUPERFICIE_PERSONAS, SUPERFICIE_CURSOS, SUPERFICIE_FEED)

#: Que version ordena cada superficie. Solo se usa para las que aun no tienen
#: ni una impresion: en cuanto haya una, la version la dice la propia senal,
#: que es la que de verdad estaba vigente cuando ocurrio.
VERSION_POR_SUPERFICIE = {
    SUPERFICIE_PERSONAS: RECOMMENDATION_ALGORITHM_VERSION,
    SUPERFICIE_CURSOS: COURSE_ALGORITHM_VERSION,
    SUPERFICIE_FEED: CONTENT_ALGORITHM_VERSION,
}


@dataclass
class EmbudoDeSuperficie:
    surface: str
    algorithm_version: str
    impressions: int = 0
    #: Cuantas impresiones acabaron en cada paso, dentro de la ventana.
    conversions: dict[str, int] = field(default_factory=dict)

    def tasas(self) -> dict[str, float]:
        """Proporcion de impresiones que llegaron a cada paso.

        Se devuelve la TASA y no solo el numero porque comparar dos versiones
        exige normalizar: la que se mostro mas veces convierte mas en absoluto
        aunque sea peor.
        """
        if self.impressions <= 0:
            return {paso: 0.0 for paso in self.conversions}
        return {
            paso: round(veces / self.impressions, 4)
            for paso, veces in self.conversions.items()
        }


def _ventana(ahora: datetime) -> timedelta:
    return timedelta(days=VENTANA_DE_ATRIBUCION_DIAS)


async def embudo(
    db: AsyncSession,
    *,
    desde: datetime,
    ahora: datetime | None = None,
) -> list[EmbudoDeSuperficie]:
    """El embudo por superficie y version del algoritmo.

    UNA consulta. Se lee todo el periodo y se cruza en memoria porque el cruce
    es «para cada impresion, ¿hubo despues una accion sobre la misma entidad?»,
    y expresarlo en SQL exigiria una autounion con condiciones de tiempo que en
    la practica es mas lenta y mucho mas dificil de leer que este bucle.
    """
    ahora = ahora or datetime.now(timezone.utc)
    ventana = _ventana(ahora)

    filas = (
        await db.execute(
            select(
                BehaviorEvent.user_id,
                BehaviorEvent.event_type,
                BehaviorEvent.entity_type,
                BehaviorEvent.entity_id,
                BehaviorEvent.surface,
                BehaviorEvent.algorithm_version,
                BehaviorEvent.created_at,
            )
            .where(BehaviorEvent.created_at >= desde)
            .order_by(BehaviorEvent.created_at)
            .limit(MAXIMO_DE_SENALES)
        )
    ).all()

    # 1. Las impresiones, indexadas por (quien, que) para poder cruzarlas.
    #    Se queda la PRIMERA de cada pareja: lo que se mide es «desde que se lo
    #    ensenamos», y contar la ultima haria que ver algo diez veces pareciera
    #    diez oportunidades distintas.
    impresiones: dict[tuple[str, str], tuple[datetime, str, str]] = {}
    grupos: dict[tuple[str, str], EmbudoDeSuperficie] = {}

    for user_id, tipo, entidad, entity_id, surface, version, creado in filas:
        if tipo != "content_impression" or not surface or not entity_id:
            continue
        clave = (user_id, entity_id)
        if clave in impresiones:
            continue
        version = version or "desconocida"
        impresiones[clave] = (creado, surface, version)
        grupo = grupos.setdefault(
            (surface, version), EmbudoDeSuperficie(surface=surface, algorithm_version=version)
        )
        grupo.impressions += 1

    # 2. Las acciones posteriores sobre la misma entidad, dentro de la ventana.
    #    Una pareja solo cuenta UNA vez por paso: seguir a alguien dos veces no
    #    es dos conversiones.
    ya_contadas: set[tuple[str, str, str]] = set()
    for user_id, tipo, entidad, entity_id, _surface, _version, creado in filas:
        if tipo == "content_impression" or not entity_id:
            continue
        impresion = impresiones.get((user_id, entity_id))
        if impresion is None:
            continue
        mostrado_en, surface, version = impresion
        if creado < mostrado_en or (creado - mostrado_en) > ventana:
            continue
        pasos = _pasos_de(surface)
        if tipo not in pasos:
            continue
        marca = (user_id, entity_id, tipo)
        if marca in ya_contadas:
            continue
        ya_contadas.add(marca)
        grupo = grupos[(surface, version)]
        grupo.conversions[tipo] = grupo.conversions.get(tipo, 0) + 1

    # 3. Los pasos que no ocurrieron salen a CERO y no ausentes: «no paso» es
    #    un dato, y un hueco en la tabla se lee como «no se midio».
    for (surface, _version), grupo in grupos.items():
        pasos = _pasos_de(surface)
        for paso in pasos:
            grupo.conversions.setdefault(paso, 0)

    # 4. Las superficies que todavia no han tenido ni una impresion aparecen a
    #    CERO. Verlas asi dice «esto no ha pasado todavia», que es informacion;
    #    que falte la fila dice «esto no se mide», que es otra cosa. Hasta ahora
    #    esta constante estaba declarada y no la usaba nadie, asi que una
    #    superficie recien estrenada simplemente no salia en el informe.
    for surface in SUPERFICIES_ESPERADAS:
        version = VERSION_POR_SUPERFICIE.get(surface, "desconocida")
        if (surface, version) in grupos:
            continue
        grupo = EmbudoDeSuperficie(surface=surface, algorithm_version=version)
        for paso in _pasos_de(surface):
            grupo.conversions[paso] = 0
        grupos[(surface, version)] = grupo

    return sorted(grupos.values(), key=lambda g: (g.surface, g.algorithm_version))



