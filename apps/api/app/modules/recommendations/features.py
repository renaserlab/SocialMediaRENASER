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
    COMPATIBILIDAD,
    INTENSIDAD_DE_DEMANDA,
    RELACIONES_DE_OFERTA,
    SATURACION_DE_SENALES,
    VENTANA_DE_ACTIVIDAD_DIAS,
)
from app.modules.recommendations.repository import ActividadDeAutor

#: Con cuantos temas coincidentes se considera cubierta la necesidad. Mas alla
#: de tres, coincidir en un cuarto no hace a nadie mucho mas relevante, y sin
#: techo quien marca veinte temas aplastaria a quien marco dos.
TEMAS_PARA_SATURAR = 3


@dataclass(frozen=True)
class PerfilDeDemanda:
    """Lo que la persona que mira necesita. Se construye una vez por peticion.

    Las tres necesidades van SEPARADAS y no en un saco comun. Es el cambio que
    permite emparejarlas con la oferta correcta: quien quiere aprender necesita
    a alguien que explique, y quien busca orientacion necesita a alguien que ya
    haya pasado por ahi. Ver `COMPATIBILIDAD` en `config.py`.
    """

    usuario_id: str
    #: `learn` — quiero aprender esto.
    aprender: frozenset[str] = frozenset()
    #: `seek_guidance` — busco orientacion sobre esto.
    orientacion: frozenset[str] = frozenset()
    #: `interest` — me interesa. Es una pista, no una peticion.
    intereses: frozenset[str] = frozenset()
    #: Que relaciones busca en la otra persona, derivadas del tipo de conexion
    #: que pidio ("un mentor" -> ensena / puede ayudar).
    relaciones_buscadas: frozenset[str] = frozenset()
    #: Si pidio explicitamente «personas con intereses parecidos».
    busca_afines: bool = False
    #: Formatos en los que prefiere aprender o conectar.
    formatos: frozenset[str] = frozenset()
    #: Lo que dijo que venia a hacer. No se usa para personas —ahi manda el
    #: tipo de conexion— pero si para cursos: quien respondio «encontrar
    #: cursos» esta pidiendo justo esta superficie.
    objetivos: frozenset[str] = frozenset()
    #: Afinidad por tema acumulada por el uso. Es el bucle de aprendizaje: sube
    #: sola segun lo que la persona abre, sin que nadie reentrene nada.
    afinidad_por_tema: dict[str, float] = field(default_factory=dict)
    #: Castigo por tema, de 0 a 1, acumulado por los «no me interesa». Resta
    #: relevancia sin borrar el tema: la persona cambia, y un sistema que no le
    #: deja volver deja de servirle.
    penalizacion_por_tema: dict[str, float] = field(default_factory=dict)
    #: Si esta persona tiene alguna senal registrada. Sin ninguna, el
    #: componente de comportamiento no aplica en vez de valer cero.
    tiene_senales: bool = False

    @property
    def por_relacion(self) -> dict[str, frozenset[str]]:
        """La demanda tal y como la consume la matriz de compatibilidad."""
        return {
            "learn": self.aprender,
            "seek_guidance": self.orientacion,
            "interest": self.intereses,
        }

    @property
    def temas_a_aprender(self) -> frozenset[str]:
        """Lo que la persona PIDE (frente a lo que solo le interesa)."""
        return self.aprender | self.orientacion

    @property
    def temas_buscados(self) -> frozenset[str]:
        return self.aprender | self.orientacion | self.intereses

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

    @property
    def tiene_oferta(self) -> bool:
        """Si esta persona ha declarado que puede aportar algo.

        Lo usa la explicacion: a quien nunca dijo que ensena no se le puede
        presentar como alguien «que puede ensenarte». Aparecera igual —por
        afinidad, por actividad o por exploracion— pero el motivo dira la
        verdad.
        """
        return bool(self.temas_ofrecidos())


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
    demanda: PerfilDeDemanda, candidato: Candidato
) -> tuple[float | None, tuple[str, ...], tuple[str, ...]]:
    """Cuanto de lo que la persona NECESITA resuelve lo que este candidato OFRECE.

    Aqui esta el cambio de fondo de la V1.1. Antes se cruzaban dos conjuntos:
    «los temas que busco» contra «los temas que ofrece». Eso trataba igual a
    quien ENSENA carpinteria y a quien dice tener experiencia en carpinteria,
    frente a alguien que quiere APRENDERLA. Y son cosas distintas: para
    aprender hace falta quien explique; para orientarse, quien ya lo vivio.

    Ahora se cruzan PARES (necesidad, oferta) y cada par tiene su valor en
    `COMPATIBILIDAD`. De cada tema se queda el mejor par, porque una persona
    que ademas de ensenar tiene experiencia no cubre el tema «dos veces»: lo
    cubre por su mejor via.

    Devuelve tambien QUE relaciones de oferta produjeron las coincidencias, que
    es lo unico con lo que se puede escribir un motivo verdadero: «ensena X»
    solo se puede decir de quien declaro `teach` sobre X.
    """
    if not demanda.tiene_demanda:
        return None, (), ()

    mejor_por_tema: dict[str, float] = {}
    relaciones: set[str] = set()

    for relacion_demanda, temas in demanda.por_relacion.items():
        if not temas:
            continue
        intensidad = INTENSIDAD_DE_DEMANDA.get(relacion_demanda, 0.0)
        compatibles = COMPATIBILIDAD.get(relacion_demanda, {})
        for tema in temas:
            for relacion_oferta, factor in compatibles.items():
                if tema not in candidato.oferta.get(relacion_oferta, frozenset()):
                    continue
                valor = intensidad * factor
                if valor > mejor_por_tema.get(tema, 0.0):
                    mejor_por_tema[tema] = valor
                relaciones.add(relacion_oferta)

    if not mejor_por_tema:
        return 0.0, (), ()

    # El castigo por «no me interesa» resta relevancia al tema, no lo borra.
    for tema in list(mejor_por_tema):
        castigo = demanda.penalizacion_por_tema.get(tema, 0.0)
        if castigo:
            mejor_por_tema[tema] *= max(0.0, 1.0 - castigo)

    # De mas a menos fuerte: si hay que recortar la lista al explicar, que
    # sobrevivan los temas que mas resuelven.
    ordenados = sorted(mejor_por_tema.items(), key=lambda par: (-par[1], par[0]))
    bruto = sum(valor for _, valor in ordenados[:TEMAS_PARA_SATURAR])
    objetivo = min(TEMAS_PARA_SATURAR, max(1, len(demanda.temas_buscados)))
    return (
        min(1.0, bruto / objetivo),
        tuple(tema for tema, _ in ordenados),
        tuple(sorted(relaciones)),
    )


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


def _penalizacion_media(demanda: PerfilDeDemanda, temas: frozenset[str]) -> float:
    """Cuanto se ha rechazado, de media, lo que ofrece este candidato.

    Se aplica al componente de comportamiento —no al de tema, que ya lleva el
    suyo por tema— para que varios «no me interesa» sobre programacion tambien
    enfrien a quien programa, sin llegar a excluirle.
    """
    if not demanda.penalizacion_por_tema or not temas:
        return 0.0
    castigos = [demanda.penalizacion_por_tema.get(t, 0.0) for t in temas]
    return sum(castigos) / len(castigos)


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
    bruto = min(1.0, 0.65 * directo + 0.35 * por_tema)
    # Lo rechazado enfria, pero no borra: ver `_penalizacion_media`.
    return bruto * max(0.0, 1.0 - _penalizacion_media(demanda, ofrecidos))


def construir(
    candidato: Candidato,
    demanda: PerfilDeDemanda,
    *,
    ahora: datetime,
    semilla: str,
) -> Rasgos:
    """Mide a un candidato frente a lo que la persona necesita."""
    ofrecidos = candidato.temas_ofrecidos()
    tema, temas_coincidentes, relaciones = _rasgo_de_tema(demanda, candidato)
    intencion, _pedidas = _rasgo_de_intencion(demanda, candidato, temas_coincidentes)
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
        # Las relaciones salen de la COINCIDENCIA real, no de lo que se pidio:
        # es lo unico con lo que se puede escribir un motivo verdadero.
        relaciones_coincidentes=relaciones,
        formatos_coincidentes=formatos,
        interes_comun=interes_comun,
        ya_seguido=candidato.ya_seguido,
        activo=activo,
    )
