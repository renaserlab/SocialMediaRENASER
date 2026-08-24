"""Que sabemos de cada candidato, en numeros comparables.

Este fichero contesta a «¿que sabemos de esta persona respecto a lo que la otra
necesita?». No decide el orden —eso es del ranker— ni consulta nada —eso es del
repositorio—. Recibe datos y devuelve rasgos entre 0 y 1.

Todo lo de aqui son FUNCIONES PURAS: mismas entradas, mismas salidas, sin reloj
del sistema ni azar. Es lo que permite escribir «Ana quiere aprender
carpinteria, Carlos la ensena, Lucia hace marketing» y comprobar el resultado
sin base de datos y sin inventar usuarios en ningun sitio.

Un rasgo a `None` significa NO APLICA, que no es lo mismo que cero. Si alguien
no dijo que formatos prefiere, su preferencia de formato no puede puntuar ni a
favor ni en contra: se saca del reparto en vez de dar un cero a todo el mundo,
que solo serviria para hundir los numeros sin cambiar el orden.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timezone

from app.modules.recommendations.config import (
    RELACION_POR_CONEXION,
    RELACIONES_DE_OFERTA,
    SATURACION_DE_SENALES,
    VENTANA_DE_ACTIVIDAD_DIAS,
)
from app.modules.recommendations.repository import ActividadDeAutor

#: Cuanto vale que coincida un tema que la persona dijo querer APRENDER frente
#: a uno que solo marco como interes. Querer aprender algo es una peticion;
#: marcar un interes es una pista.
PESO_DEMANDA_FUERTE = 1.0
PESO_DEMANDA_SUAVE = 0.6

#: Con cuantos temas coincidentes se considera cubierta la necesidad. Mas alla
#: de tres, coincidir en un cuarto no hace a nadie mucho mas relevante, y sin
#: techo quien marca veinte temas aplastaria a quien marco dos.
TEMAS_PARA_SATURAR = 3


@dataclass(frozen=True)
class PerfilDeDemanda:
    """Lo que la persona que mira necesita. Se construye una vez por peticion."""

    usuario_id: str
    #: Temas que declaro querer aprender o sobre los que busca orientacion.
    temas_a_aprender: frozenset[str] = frozenset()
    #: Temas marcados solo como interes.
    intereses: frozenset[str] = frozenset()
    #: Que relaciones busca en la otra persona, derivadas del tipo de conexion
    #: que pidio ("un mentor" -> ensena / puede ayudar).
    relaciones_buscadas: frozenset[str] = frozenset()
    #: Si pidio explicitamente «personas con intereses parecidos».
    busca_afines: bool = False
    #: Formatos en los que prefiere aprender o conectar.
    formatos: frozenset[str] = frozenset()
    #: Afinidad por tema acumulada por el uso. Es el bucle de aprendizaje: sube
    #: sola segun lo que la persona abre, sin que nadie reentrene nada.
    afinidad_por_tema: dict[str, float] = field(default_factory=dict)
    #: Si esta persona tiene alguna senal registrada. Sin ninguna, el
    #: componente de comportamiento no aplica en vez de valer cero.
    tiene_senales: bool = False

    @property
    def temas_buscados(self) -> frozenset[str]:
        return self.temas_a_aprender | self.intereses

    @property
    def tiene_demanda(self) -> bool:
        return bool(self.temas_buscados)


@dataclass(frozen=True)
class Candidato:
    """Lo que se sabe de una persona que podria aportar valor."""

    id: str
    #: relacion -> temas. Solo el lado de la OFERTA se usa para explicar.
    oferta: dict[str, frozenset[str]] = field(default_factory=dict)
    #: Temas que le interesan. Se usan para detectar afinidad, NUNCA para
    #: nombrarlos en un motivo: no los declaro en publico.
    intereses: frozenset[str] = frozenset()
    actividad: ActividadDeAutor = field(default_factory=ActividadDeAutor)
    #: Cuanto ha interactuado ya el usuario con esta persona o su contenido.
    afinidad: float = 0.0
    ya_seguido: bool = False

    def temas_ofrecidos(self) -> frozenset[str]:
        salida: set[str] = set()
        for relacion in RELACIONES_DE_OFERTA:
            salida |= self.oferta.get(relacion, frozenset())
        return frozenset(salida)


@dataclass(frozen=True)
class Rasgos:
    """El candidato medido. `None` = no aplica (ver la cabecera del fichero)."""

    tema: float | None
    intencion: float | None
    formato: float | None
    actividad: float
    comportamiento: float | None
    reputacion: float | None
    exploracion: float

    #: Pruebas de lo anterior, para poder explicarlo despues.
    temas_coincidentes: tuple[str, ...] = ()
    relaciones_coincidentes: tuple[str, ...] = ()
    formatos_coincidentes: tuple[str, ...] = ()
    interes_comun: bool = False
    ya_seguido: bool = False
    activo: bool = False


def _saturar(valor: float, techo: float) -> float:
    """Lleva un contador sin techo a 0..1 sin que un valor enorme lo domine."""
    if techo <= 0:
        return 0.0
    return min(1.0, valor / techo)


def exploracion_de(usuario_id: str, candidato_id: str, semilla: str) -> float:
    """Un numero estable en 0..1 para dar sitio a quien todavia no tiene senales.

    Por que un hash y no azar: el azar haria que dos peticiones seguidas
    devolvieran ordenes distintos —la lista bailaria al desplazarse— y que las
    pruebas no pudieran comprobar nada. Con un hash, la misma pareja de
    personas obtiene siempre el mismo valor dentro de la misma semilla, y basta
    cambiar la semilla (por dia, por ejemplo) para que la rueda gire.

    Se usa blake2b y no `hash()`: el hash de Python lleva una sal distinta en
    cada proceso, asi que el mismo usuario veria otro orden en cada reinicio
    del servidor y ningun test podria fijarlo.
    """
    material = f"{usuario_id}|{candidato_id}|{semilla}".encode("utf-8")
    digest = hashlib.blake2b(material, digest_size=8).digest()
    return int.from_bytes(digest, "big") / float(1 << 64)


def _rasgo_de_tema(
    demanda: PerfilDeDemanda, ofrecidos: frozenset[str]
) -> tuple[float | None, tuple[str, ...]]:
    """Cuanto de lo que la persona busca cubre este candidato."""
    if not demanda.tiene_demanda:
        return None, ()
    fuertes = demanda.temas_a_aprender & ofrecidos
    suaves = (demanda.intereses - demanda.temas_a_aprender) & ofrecidos
    if not fuertes and not suaves:
        return 0.0, ()
    bruto = len(fuertes) * PESO_DEMANDA_FUERTE + len(suaves) * PESO_DEMANDA_SUAVE
    objetivo = min(TEMAS_PARA_SATURAR, max(1, len(demanda.temas_buscados)))
    # Los fuertes primero: si hay que recortar la lista al explicar, que
    # sobrevivan los temas que la persona dijo querer aprender.
    coincidentes = tuple(sorted(fuertes)) + tuple(sorted(suaves))
    return min(1.0, bruto / objetivo), coincidentes


def _rasgo_de_intencion(
    demanda: PerfilDeDemanda, candidato: Candidato, temas_coincidentes: tuple[str, ...]
) -> tuple[float | None, tuple[str, ...]]:
    """Si el candidato ofrece lo que se le pidio, y SOBRE los temas que importan.

    El matiz «sobre los temas que importan» es lo que separa esto de un filtro
    tonto: alguien que ensena fotografia no es «un mentor» para quien busca
    carpinteria, aunque las dos etiquetas digan «ensena».
    """
    if not demanda.relaciones_buscadas:
        return None, ()
    relevantes = set(temas_coincidentes) or set(demanda.temas_buscados)
    cumplidas = [
        relacion
        for relacion in sorted(demanda.relaciones_buscadas)
        if candidato.oferta.get(relacion, frozenset()) & relevantes
    ]
    if not cumplidas:
        return 0.0, ()
    return len(cumplidas) / len(demanda.relaciones_buscadas), tuple(cumplidas)


def _rasgo_de_formato(
    demanda: PerfilDeDemanda, candidato: Candidato
) -> tuple[float | None, tuple[str, ...]]:
    """Si esta persona publica donde la otra prefiere encontrarse.

    Se mira lo que HACE, no lo que dice: los formatos salen de sus
    publicaciones, sus cursos y sus sesiones atendidas.
    """
    if not demanda.formatos:
        return None, ()
    equivalencias = {
        "video": {"video"},
        "audio": {"audio"},
        "publicacion": {"publicacion", "image"},
        "curso": {"curso"},
        "sesion_1a1": {"sesion_1a1"},
        # Mensajes y comunidades no se pueden verificar desde el contenido
        # publicado, asi que no puntuan: preferirlos no debe premiar a nadie
        # por algo que no consta.
        "mensaje": set(),
        "comunidad": set(),
    }
    comprobables = [f for f in demanda.formatos if equivalencias.get(f)]
    if not comprobables:
        return None, ()
    cumplidos = [
        formato
        for formato in sorted(comprobables)
        if equivalencias[formato] & candidato.actividad.formatos
    ]
    return len(cumplidos) / len(comprobables), tuple(cumplidos)


def _rasgo_de_actividad(actividad: ActividadDeAutor, ahora: datetime) -> tuple[float, bool]:
    """Que la persona exista de verdad: publica, atiende, esta.

    NO es calidad ni reputacion. Y las reacciones recibidas pesan poco y con
    techo bajo a proposito: si mandaran, el recomendador acabaria siendo un
    ranking de popularidad y una persona nueva con conocimiento util no
    aparecería jamas.
    """
    reciente = 0.0
    if actividad.ultima_publicacion is not None:
        ultima = actividad.ultima_publicacion
        if ultima.tzinfo is None:
            ultima = ultima.replace(tzinfo=timezone.utc)
        dias = max(0.0, (ahora - ultima).total_seconds() / 86400.0)
        reciente = max(0.0, 1.0 - dias / VENTANA_DE_ACTIVIDAD_DIAS)

    volumen = _saturar(actividad.publicaciones, 5)
    sesiones = _saturar(actividad.sesiones_dadas, 3)
    reacciones = _saturar(actividad.reacciones, 50)

    valor = 0.40 * reciente + 0.25 * volumen + 0.25 * sesiones + 0.10 * reacciones
    activo = actividad.publicaciones > 0 or actividad.sesiones_dadas > 0
    return min(1.0, valor), activo


def _rasgo_de_comportamiento(
    demanda: PerfilDeDemanda, candidato: Candidato, ofrecidos: frozenset[str]
) -> float | None:
    """Lo que el propio usuario ya ha hecho, convertido en preferencia.

    Dos vias, y las dos importan:
      - lo que ha hecho con ESTA persona (abrio su perfil, vio su contenido);
      - lo que ha hecho con estos TEMAS, aunque fuera con otra gente. Es lo que
        permite que alguien que empezo interesado en negocios y acaba abriendo
        perfiles de programacion empiece a ver tecnologia sin tocar nada.
    """
    if not demanda.tiene_senales:
        return None
    directo = _saturar(candidato.afinidad, SATURACION_DE_SENALES)
    por_tema = 0.0
    if demanda.afinidad_por_tema and ofrecidos:
        acumulado = sum(demanda.afinidad_por_tema.get(t, 0.0) for t in ofrecidos)
        por_tema = _saturar(acumulado, SATURACION_DE_SENALES)
    return min(1.0, 0.65 * directo + 0.35 * por_tema)


def construir(
    candidato: Candidato,
    demanda: PerfilDeDemanda,
    *,
    ahora: datetime,
    semilla: str,
) -> Rasgos:
    """Mide a un candidato frente a lo que la persona necesita."""
    ofrecidos = candidato.temas_ofrecidos()
    tema, temas_coincidentes = _rasgo_de_tema(demanda, ofrecidos)
    intencion, relaciones = _rasgo_de_intencion(demanda, candidato, temas_coincidentes)
    formato, formatos = _rasgo_de_formato(demanda, candidato)
    actividad, activo = _rasgo_de_actividad(candidato.actividad, ahora)
    comportamiento = _rasgo_de_comportamiento(demanda, candidato, ofrecidos)

    interes_comun = bool(demanda.temas_buscados & candidato.intereses)

    return Rasgos(
        tema=tema,
        intencion=intencion,
        formato=formato,
        actividad=actividad,
        comportamiento=comportamiento,
        # Hoy NO hay reputacion comprobable: el sistema de resenas verificadas
        # no existe y los testimonios actuales no lo son. Devolver `None` deja
        # el hueco hecho sin fabricar una confianza que nadie ha ganado.
        reputacion=None,
        exploracion=exploracion_de(demanda.usuario_id, candidato.id, semilla),
        temas_coincidentes=temas_coincidentes,
        relaciones_coincidentes=relaciones,
        formatos_coincidentes=formatos,
        interes_comun=interes_comun,
        ya_seguido=candidato.ya_seguido,
        activo=activo,
    )
