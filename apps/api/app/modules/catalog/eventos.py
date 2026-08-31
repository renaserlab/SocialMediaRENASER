"""Cuándo ocurre un evento: si todavía está por llegar, si ya pasó o si no
tiene fecha.

POR QUÉ ESTO VIVE EN EL SERVIDOR. Lo que se veía en Explorar era un evento del
19 de agosto anunciado bajo «Próximos eventos», al lado de otro que aún no ha
ocurrido. Distinguirlos en el móvil habría obligado a mirar el texto ya
formateado —«19 ago.»—, que es una cadena pensada para LEERSE y no para
compararse: cambia con el idioma, no siempre lleva año y no sabe nada de
`ends_at`. La fecha real la tiene la base de datos; la comparación se hace aquí,
una vez, y viaja ya resuelta en `time_state`.

LAS TRES RESPUESTAS POSIBLES, y la tercera pesa tanto como las otras dos.
`starts_at` y `ends_at` son las dos anulables porque un evento puede anunciarse
«por confirmar». Meter esos eventos con los próximos sería inventarles un
futuro, y meterlos con los anteriores, un pasado. Se dicen por su nombre.

LA REGLA, en este orden:

  1. hay `ends_at`   -> pasado cuando `ends_at < ahora`
  2. solo `starts_at`-> pasado cuando `starts_at < ahora`
  3. ninguna fecha   -> sin fecha definida

`ends_at` manda sobre `starts_at` a propósito: un congreso de tres días que
empezó ayer y termina mañana está ocurriendo, no ha pasado. Con la regla al
revés desaparecería de «próximos» justo el día que más importa.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import ColumnElement, Integer, and_, case, cast, func, null, or_

from app.modules.catalog.models import Event

#: Los tres estados, tal y como viajan en `EventRead.time_state`. En inglés
#: como el resto del contrato HTTP (`coming_soon`, `reserved_by_me`); el nombre
#: interno de cada constante va en español, como el resto del código.
PROXIMO = "upcoming"
ANTERIOR = "past"
SIN_FECHA = "undated"

#: Valores admitidos por el parámetro `when` del listado.
TODOS = "all"
CUANDO = f"^({PROXIMO}|{ANTERIOR}|{SIN_FECHA}|{TODOS})$"

#: Orden de los grupos cuando se piden todos de una vez. Lo vigente primero:
#: quien abre la agenda viene a ver a qué puede ir, no a repasar el histórico.
#: Además evita que con muchos eventos pasados los próximos se caigan de la
#: primera página, que es como el problema volvería por otra puerta.
_RANGO_PROXIMO = 0
_RANGO_SIN_FECHA = 1
_RANGO_ANTERIOR = 2


def ahora() -> datetime:
    """El momento actual, con zona horaria.

    Se pasa como parámetro a todo lo demás para que las pruebas puedan situarse
    en un instante concreto sin tocar el reloj del sistema.
    """
    return datetime.now(timezone.utc)


def _con_zona(valor: datetime, referencia: datetime) -> datetime:
    """`valor` comparable con `referencia`, aunque una de las dos sea ingenua.

    En PostgreSQL la columna es `timestamptz` y vuelve con zona; en SQLite —la
    base de las pruebas— el dialecto guarda la hora de pared y la devuelve sin
    zona. Comparar las dos formas directamente lanza `TypeError`, y ese error
    aparecería solo en un entorno de los dos. Lo que se guarda es UTC en ambos,
    así que asumirlo aquí no inventa nada.
    """
    if valor.tzinfo is None and referencia.tzinfo is not None:
        return valor.replace(tzinfo=timezone.utc)
    if valor.tzinfo is not None and referencia.tzinfo is None:
        return valor.replace(tzinfo=timezone.utc).replace(tzinfo=None)
    return valor


def estado_temporal(
    starts_at: datetime | None, ends_at: datetime | None, momento: datetime
) -> str:
    """`upcoming`, `past` o `undated` para UN evento. Sin tocar la base."""
    if ends_at is not None:
        return ANTERIOR if _con_zona(ends_at, momento) < momento else PROXIMO
    if starts_at is not None:
        return ANTERIOR if _con_zona(starts_at, momento) < momento else PROXIMO
    return SIN_FECHA


def estado_de(evento: Event, momento: datetime) -> str:
    """Lo mismo, leyendo el evento. Azúcar para el router."""
    return estado_temporal(evento.starts_at, evento.ends_at, momento)


def _es_anterior(momento: datetime) -> ColumnElement[bool]:
    """La misma regla que `estado_temporal`, escrita en SQL.

    Está escrita dos veces —Python y SQL— porque hacen falta las dos: filtrar en
    la base (para que la paginación signifique algo) y etiquetar cada fila de la
    respuesta. `tests/test_eventos_por_fecha.py` comprueba que dicen lo mismo,
    que es la única forma de que no se separen con el tiempo.

    LOS `is_not(None)` NO SOBRAN, aunque parezcan redundantes. En SQL, comparar
    contra NULL no da FALSO: da NULL. Escrito como `ends_at < ahora` sin más, un
    evento futuro sin `ends_at` producía NULL, y su NEGACIÓN —que es lo que
    usa el filtro de «próximos»— seguía siendo NULL, así que la fila no entraba
    en NINGÚN grupo y el evento desaparecía del catálogo. La lógica de tres
    valores de SQL no es la de Python; con los `is_not` cada rama vale VERDADERO
    o FALSO y nunca desconocido.
    """
    return or_(
        and_(Event.ends_at.is_not(None), Event.ends_at < momento),
        and_(
            Event.ends_at.is_(None),
            Event.starts_at.is_not(None),
            Event.starts_at < momento,
        ),
    )


def _sin_fecha() -> ColumnElement[bool]:
    return and_(Event.starts_at.is_(None), Event.ends_at.is_(None))


def condicion(cuando: str, momento: datetime) -> ColumnElement[bool] | None:
    """El filtro del grupo pedido. `None` para «todos», que no filtra nada."""
    if cuando == ANTERIOR:
        return _es_anterior(momento)
    if cuando == SIN_FECHA:
        return _sin_fecha()
    if cuando == PROXIMO:
        # Ni pasado ni sin fecha: tiene fecha y no ha terminado.
        return and_(~_es_anterior(momento), ~_sin_fecha())
    return None


def _rango(momento: datetime) -> ColumnElement[int]:
    """A qué grupo pertenece cada fila, como número, para poder ordenar."""
    return case(
        (_sin_fecha(), cast(_RANGO_SIN_FECHA, Integer)),
        (_es_anterior(momento), cast(_RANGO_ANTERIOR, Integer)),
        else_=cast(_RANGO_PROXIMO, Integer),
    )


def orden(momento: datetime) -> list:
    """Cómo se ordena el listado: por grupo, y dentro de cada grupo con sentido.

    - **Próximos**: lo más cercano primero. Es la pregunta que trae a alguien a
      la agenda («¿a qué puedo ir?»).
    - **Sin fecha**: lo anunciado más recientemente primero; no hay otra cosa
      que comparar.
    - **Anteriores**: lo más reciente primero. Un histórico se lee hacia atrás;
      empezarlo por el evento más antiguo de la historia no sirve a nadie.

    Las dos claves de fecha se anulan mutuamente por grupo: la ascendente vale
    `NULL` en el histórico y la descendente vale `NULL` en el resto, así que
    cada grupo se ordena solo por la suya. Sale en UNA consulta, y por eso la
    paginación sigue siendo coherente.
    """
    fecha = func.coalesce(Event.starts_at, Event.ends_at)
    rango = _rango(momento)
    return [
        rango.asc(),
        case((rango == _RANGO_ANTERIOR, null()), else_=fecha).asc().nulls_last(),
        case((rango == _RANGO_ANTERIOR, fecha), else_=null()).desc().nulls_last(),
        # Desempate estable: sin él, dos eventos del mismo día pueden salir en
        # orden distinto en cada página y repetirse o perderse al paginar.
        Event.created_at.desc(),
        Event.id.desc(),
    ]
