"""EL CÁLCULO DE HORARIOS: una función pura, sin base de datos.

ES LA ÚNICA AUTORIDAD para cuatro cosas, y nadie más las repite:

  * CONVERTIR ZONAS: una hora local de la agenda a un instante UTC
    (`instante`) y al revés (`reloj`), con `zoneinfo` y la base de zonas
    `tzdata` que viaja con la API (la misma en Windows y en el contenedor).
    Nunca se suma un desplazamiento a mano.
  * DECIDIR QUÉ FRANJAS TIENE UNA FECHA, con esta precedencia:
      1. lo que CIERRA gana siempre: un bloqueo, una fecha cerrada entera o
         una franja cerrada;
      2. las excepciones de esa fecha: `replace` sustituye la semana ese día;
         `extra` añade lo que la semana no tenía;
      3. la regla semanal de ese día de la semana;
      4. la configuración general (duración, preparación, descanso,
         intervalo, antelación y horizonte).
  * GENERAR LOS HORARIOS de una franja: cada uno ocupa preparación +
    duración + descanso, y ese bloque ENTERO cabe en la franja y no toca un
    cierre ni un bloqueo. Sin intervalo propio van uno detrás de otro; con él,
    son inicios alternativos.
  * LA CAPACIDAD TEÓRICA: la de la franja, nunca más que la del servicio.
  * LO QUE YA ESTÁ OCUPADO (Incremento 5): cada retención viva y cada reserva
    ocupa su SESIÓN (su inicio) con la separación que tenía al retenerse. Un
    horario desaparece si su bloque ENTERO toca otra sesión, o si su propia
    sesión ya no tiene plazas. Es la MISMA regla que impone la 0093 (dos
    sesiones distintas no se pisan; una plaza no se da dos veces): lo que
    aquí se ofrece es lo que la base dejará retener.

LOS CRUCES NO SE DECIDEN AQUÍ: los impide la base (restricciones de exclusión
de la 0092). Si aun así llegaran franjas que se pisan, se juntan: nunca se
duplica un horario.

HORARIO DE VERANO: una hora local que NO EXISTE (el reloj salta) se lleva al
primer instante que sí existe; una que SE REPITE (el reloj vuelve) es la
primera vez. Los horarios se generan en tiempo real desde el inicio de la
franja: nunca se solapan, y en la noche del cambio sale el que corresponde.
"""

from __future__ import annotations

import re
from bisect import bisect_left
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.modules.services import agenda_politica as limites
from app.modules.services.agenda_models import CERRADA, EXTRA, SUSTITUYE

UTC = timezone.utc

#: La forma de una zona IANA de verdad: «Área/Lugar» (o «Área/País/Lugar»).
#: Sin «Etc/» (son desplazamientos fijos: «Etc/GMT+5») ni «UTC-5».
_FORMA_DE_ZONA = re.compile(r"^[A-Z][A-Za-z]*(?:/[A-Za-z0-9_+-]+){1,2}$")


# --------------------------------------------------------------------------- #
# Zonas y relojes
# --------------------------------------------------------------------------- #
def zona(nombre: str | None) -> ZoneInfo | None:
    """La zona, o `None` si no es una IANA con lugar que exista."""
    if not isinstance(nombre, str) or len(nombre) > limites.ZONA_MAXIMA:
        return None
    if not _FORMA_DE_ZONA.match(nombre) or nombre.startswith("Etc/"):
        return None
    try:
        return ZoneInfo(nombre)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return None


def _existe(ingenuo: datetime, z: ZoneInfo) -> bool:
    utc = ingenuo.replace(tzinfo=z).astimezone(UTC)
    return utc.astimezone(z).replace(tzinfo=None) == ingenuo


def instante(fecha: date, minuto: int, z: ZoneInfo) -> datetime:
    """El instante UTC de «`fecha` a los `minuto` minutos» en la zona `z`.

    `minuto` puede ser 1440: las 24:00, que es la medianoche del día siguiente.
    Una hora que se repite es la primera vez; una que no existe, el primer
    instante que sí existe después (el del salto).
    """
    ingenuo = datetime.combine(fecha, time()) + timedelta(minutes=minuto)
    paso = ingenuo
    for _ in range(24 * 60):
        if _existe(paso, z):
            return paso.replace(tzinfo=z, fold=0).astimezone(UTC)
        paso += timedelta(minutes=1)
    raise ValueError("hora local imposible")  # pragma: no cover - ninguna zona salta un día


def existe(fecha: date, minuto: int, z: ZoneInfo) -> bool:
    """¿Existe esa hora local ese día? (No, dentro del salto de verano.)"""
    return _existe(datetime.combine(fecha, time()) + timedelta(minutes=minuto), z)


def reloj(momento: datetime, z: ZoneInfo) -> datetime:
    """El instante, en la hora local de la zona (con su desplazamiento)."""
    return momento.astimezone(z)


def hoy(z: ZoneInfo, ahora: datetime) -> date:
    return reloj(ahora, z).date()


def hora(minuto: int) -> str:
    """«09:30». 1440 es «24:00»."""
    return f"{minuto // 60:02d}:{minuto % 60:02d}"


def minuto_de(texto: str | None, *, admite_24: bool) -> int | None:
    """«09:30» → 570, o `None` si no es una hora de la rejilla."""
    if not isinstance(texto, str):
        return None
    m = re.fullmatch(r"([01]\d|2[0-4]):([0-5]\d)", texto.strip())
    if not m:
        return None
    total = int(m.group(1)) * 60 + int(m.group(2))
    if total > limites.MINUTOS_DEL_DIA or (total == limites.MINUTOS_DEL_DIA and not admite_24):
        return None
    if total % limites.REJILLA_MINUTOS:
        return None
    return total


def desplazamiento(momento: datetime) -> str:
    """«-05:00», el desplazamiento de un instante ya en su zona."""
    delta = momento.utcoffset() or timedelta(0)
    signo = "-" if delta < timedelta(0) else "+"
    minutos = abs(int(delta.total_seconds())) // 60
    return f"{signo}{minutos // 60:02d}:{minutos % 60:02d}"


# --------------------------------------------------------------------------- #
# Lo que entra
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Configuracion:
    zona: ZoneInfo
    preparacion: int
    descanso: int
    intervalo: int | None


@dataclass(frozen=True)
class Servicio:
    """Lo que dice la versión: cuánto dura, cómo se atiende y a cuántos."""

    duracion: int
    modalidad: str
    capacidad: int


@dataclass(frozen=True)
class Regla:
    dia: int
    inicio: int
    fin: int
    modalidad: str
    capacidad: int
    activa: bool = True


@dataclass(frozen=True)
class Excepcion:
    fecha: date
    tipo: str
    inicio: int | None = None
    fin: int | None = None
    modalidad: str | None = None
    capacidad: int | None = None


@dataclass(frozen=True)
class Bloqueo:
    inicio: datetime
    fin: datetime


@dataclass(frozen=True)
class Ocupacion:
    """Una SESIÓN ya ocupada: su inicio, lo que ocupa (con la preparación y
    el descanso congelados al retener) y cuántas plazas tiene tomadas."""

    inicio: datetime
    desde: datetime
    hasta: datetime
    plazas: int = 1


@dataclass(frozen=True)
class Franja:
    inicio: int
    fin: int
    modalidad: str
    capacidad: int


@dataclass(frozen=True)
class Horario:
    fecha: date
    inicio: datetime
    fin: datetime
    capacidad: int
    #: Plazas ya tomadas en ESA sesión (retenciones vivas y reservas).
    ocupadas: int = 0


@dataclass(frozen=True)
class Datos:
    """Todo lo que el cálculo necesita de una agenda, ya leído."""

    configuracion: Configuracion
    servicio: Servicio
    reglas: tuple[Regla, ...]
    excepciones: tuple[Excepcion, ...]
    bloqueos: tuple[Bloqueo, ...]
    #: Lo ya ocupado (Incremento 5). Vacío sin la 0093.
    ocupaciones: tuple[Ocupacion, ...] = ()


# --------------------------------------------------------------------------- #
# Franjas de una fecha
# --------------------------------------------------------------------------- #
def _restar(tramos: list[tuple[int, int]], quitar: list[tuple[int, int]]) -> list[tuple[int, int]]:
    for q0, q1 in quitar:
        nuevos: list[tuple[int, int]] = []
        for t0, t1 in tramos:
            if q1 <= t0 or q0 >= t1:
                nuevos.append((t0, t1))
                continue
            if t0 < q0:
                nuevos.append((t0, q0))
            if q1 < t1:
                nuevos.append((q1, t1))
        tramos = nuevos
    return tramos


def _juntar(franjas: list[Franja]) -> list[Franja]:
    """Las que se tocan o se pisan con la misma capacidad, en una."""
    salida: list[Franja] = []
    for f in sorted(franjas, key=lambda x: (x.inicio, x.fin)):
        ultima = salida[-1] if salida else None
        if ultima and f.inicio <= ultima.fin and f.capacidad == ultima.capacidad:
            salida[-1] = Franja(ultima.inicio, max(ultima.fin, f.fin), ultima.modalidad, ultima.capacidad)
        elif ultima and f.inicio < ultima.fin:
            # Se pisan con distinta capacidad: la que empezó antes se queda
            # su tramo; esta, solo lo que sobra.
            if f.fin > ultima.fin:
                salida.append(Franja(ultima.fin, f.fin, f.modalidad, f.capacidad))
        else:
            salida.append(f)
    return salida


def franjas_del_dia(
    fecha: date, reglas: tuple[Regla, ...], excepciones: tuple[Excepcion, ...], modalidad: str
) -> tuple[list[Franja], list[tuple[int, int]]]:
    """`(franjas abiertas de esa modalidad, tramos cerrados)` de UNA fecha local."""
    del_dia = [e for e in excepciones if e.fecha == fecha]
    cerradas = [e for e in del_dia if e.tipo == CERRADA]
    if any(e.inicio is None for e in cerradas):
        return [], [(0, limites.MINUTOS_DEL_DIA)]
    tramos_cerrados = [(e.inicio, e.fin) for e in cerradas]  # type: ignore[misc]

    sustituyen = [e for e in del_dia if e.tipo == SUSTITUYE]
    if sustituyen:
        base = [Franja(e.inicio, e.fin, e.modalidad, e.capacidad) for e in sustituyen]  # type: ignore[arg-type]
    else:
        base = [
            Franja(r.inicio, r.fin, r.modalidad, r.capacidad)
            for r in reglas
            if r.activa and r.dia == fecha.isoweekday()
        ]
    # UNA APERTURA EXTRA SOLO AÑADE lo que el día no tenía.
    ocupado = [(f.inicio, f.fin) for f in base]
    extras: list[Franja] = []
    for e in del_dia:
        if e.tipo != EXTRA:
            continue
        for t0, t1 in _restar([(e.inicio, e.fin)], ocupado):  # type: ignore[list-item]
            extras.append(Franja(t0, t1, e.modalidad, e.capacidad))  # type: ignore[arg-type]
    abiertas = _juntar([f for f in base + extras if f.modalidad == modalidad])
    return abiertas, tramos_cerrados


# --------------------------------------------------------------------------- #
# Horarios
# --------------------------------------------------------------------------- #
def _unir(tramos: list[tuple[datetime, datetime]]) -> list[tuple[datetime, datetime]]:
    """Los tramos, ordenados y sin solaparse: los que se tocan o se pisan, en uno."""
    salida: list[tuple[datetime, datetime]] = []
    for t0, t1 in sorted(tramos):
        if salida and t0 <= salida[-1][1]:
            salida[-1] = (salida[-1][0], max(salida[-1][1], t1))
        else:
            salida.append((t0, t1))
    return salida


def _se_cruza(inicio: datetime, fin: datetime, tramos: list[tuple[datetime, datetime]], inicios: list[datetime]) -> bool:
    """¿`[inicio, fin)` toca algún tramo? `tramos` viene de `_unir` (ordenados
    y disjuntos, así que sus finales también crecen) e `inicios` son sus
    inicios: basta mirar el último que empieza antes de `fin`."""
    i = bisect_left(inicios, fin) - 1
    return i >= 0 and tramos[i][1] > inicio


def _sesiones(ocupaciones: tuple[Ocupacion, ...], dia0: datetime, dia1: datetime) -> dict[datetime, tuple]:
    """Las sesiones que tocan el día: inicio → (desde, hasta, plazas). Dos
    ocupaciones del MISMO inicio son la misma sesión (sus plazas se suman)."""
    sesiones: dict[datetime, tuple] = {}
    for o in ocupaciones:
        if o.desde >= dia1 or o.hasta <= dia0:
            continue
        previa = sesiones.get(o.inicio)
        if previa is None:
            sesiones[o.inicio] = (o.desde, o.hasta, o.plazas)
        else:
            sesiones[o.inicio] = (min(previa[0], o.desde), max(previa[1], o.hasta), previa[2] + o.plazas)
    return sesiones


def _otra_sesion_se_cruza(
    inicio: datetime, fin: datetime, propia: datetime, otras: list[tuple], inicios: list[datetime]
) -> bool:
    """¿`[inicio, fin)` toca una sesión que NO empieza en `propia`? Las
    sesiones distintas no se pisan entre sí (lo impone la 0093): ordenadas por
    su comienzo, sus finales también crecen, así que basta mirar hacia atrás
    desde la última que empieza antes de `fin` hasta la primera que acaba
    antes de `inicio`."""
    i = bisect_left(inicios, fin) - 1
    while i >= 0:
        desde, hasta, sesion = otras[i]
        if hasta <= inicio:
            return False
        if sesion != propia:
            return True
        i -= 1
    return False


def horarios_del_dia(
    fecha: date,
    datos: Datos,
    *,
    modalidad: str,
    desde: datetime,
    hasta: datetime,
) -> list[Horario]:
    """Los horarios de una fecha LOCAL cuyo inicio cae en `[desde, hasta]`.

    `desde` es «ahora + antelación» y `hasta`, «ahora + horizonte»: lo decide
    quien llama con la política.
    """
    c = datos.configuracion
    s = datos.servicio
    if modalidad != s.modalidad or s.duracion <= 0:
        return []
    franjas, cerradas = franjas_del_dia(fecha, datos.reglas, datos.excepciones, modalidad)
    if not franjas:
        return []
    # LO QUE CIERRA, SOLO EL DE ESTE DÍA Y UNIDO: los bloqueos que no tocan la
    # fecha (con un día de margen) no se miran, y cada horario se comprueba
    # con una búsqueda binaria. Sin esto, 200 bloqueos por 288 inicios por 91
    # días eran millones de comparaciones en una consulta anónima.
    dia0, dia1 = instante(fecha, 0, c.zona) - timedelta(days=1), instante(fecha, 1440, c.zona) + timedelta(days=1)
    fuera = _unir(
        [(instante(fecha, a, c.zona), instante(fecha, b, c.zona)) for a, b in cerradas]
        + [(b.inicio, b.fin) for b in datos.bloqueos if b.inicio < dia1 and b.fin > dia0]
    )
    inicios_fuera = [t0 for t0, _ in fuera]
    sesiones = _sesiones(datos.ocupaciones, dia0, dia1)
    otras = sorted((d, h, s) for s, (d, h, _) in sesiones.items())
    inicios_otras = [d for d, _, _ in otras]
    antes = timedelta(minutes=c.preparacion)
    atencion = timedelta(minutes=s.duracion)
    despues = timedelta(minutes=c.descanso)
    paso = timedelta(minutes=c.intervalo or (c.preparacion + s.duracion + c.descanso))

    salida: list[Horario] = []
    for f in franjas:
        abre = instante(fecha, f.inicio, c.zona)
        cierra = instante(fecha, f.fin, c.zona)
        capacidad = min(f.capacidad, s.capacidad)
        inicio = abre + antes
        while inicio + atencion + despues <= cierra:
            if desde <= inicio <= hasta and not _se_cruza(
                inicio - antes, inicio + atencion + despues, fuera, inicios_fuera
            ) and not _otra_sesion_se_cruza(
                inicio - antes, inicio + atencion + despues, inicio, otras, inicios_otras
            ):
                ocupadas = sesiones[inicio][2] if inicio in sesiones else 0
                if ocupadas < capacidad:
                    salida.append(Horario(fecha, inicio, inicio + atencion, capacidad, ocupadas))
            inicio += paso
    salida.sort(key=lambda h: h.inicio)
    # Dos franjas de distinta capacidad pueden dar el mismo inicio: uno solo.
    unicos: list[Horario] = []
    for h in salida:
        if not unicos or unicos[-1].inicio != h.inicio:
            unicos.append(h)
    return unicos


def ventana(ahora: datetime, politica: limites.Politica) -> tuple[datetime, datetime]:
    """`(primer inicio posible, último inicio posible)`: antelación y horizonte."""
    return (
        ahora + timedelta(minutes=politica.antelacion_minutos),
        ahora + timedelta(days=politica.horizonte_dias),
    )


def ultima_fecha(z: ZoneInfo, ahora: datetime, politica: limites.Politica) -> date:
    """La última fecha local con algún inicio dentro del horizonte."""
    return reloj(ventana(ahora, politica)[1], z).date()


def fechas(desde: date, hasta: date):
    dia = desde
    while dia <= hasta:
        yield dia
        dia += timedelta(days=1)


def dias(
    datos: Datos,
    *,
    modalidad: str,
    desde_fecha: date,
    hasta_fecha: date,
    ahora: datetime,
    politica: limites.Politica,
) -> dict[date, list[Horario]]:
    """Los horarios de cada fecha del rango (las fechas sin ninguno no salen)."""
    primero, ultimo = ventana(ahora, politica)
    salida: dict[date, list[Horario]] = {}
    for fecha in fechas(desde_fecha, hasta_fecha):
        del_dia = horarios_del_dia(fecha, datos, modalidad=modalidad, desde=primero, hasta=ultimo)
        if del_dia:
            salida[fecha] = del_dia
    return salida


def proximo(
    datos: Datos, *, modalidad: str, ahora: datetime, politica: limites.Politica
) -> Horario | None:
    """El primer horario desde hoy hasta el horizonte, o `None`."""
    z = datos.configuracion.zona
    primero, ultimo = ventana(ahora, politica)
    for fecha in fechas(hoy(z, ahora), ultima_fecha(z, ahora, politica)):
        del_dia = horarios_del_dia(fecha, datos, modalidad=modalidad, desde=primero, hasta=ultimo)
        if del_dia:
            return del_dia[0]
    return None


__all__ = [
    "Bloqueo",
    "Configuracion",
    "Datos",
    "Excepcion",
    "Franja",
    "Horario",
    "Ocupacion",
    "Regla",
    "Servicio",
    "desplazamiento",
    "dias",
    "existe",
    "fechas",
    "franjas_del_dia",
    "hora",
    "horarios_del_dia",
    "hoy",
    "instante",
    "minuto_de",
    "proximo",
    "reloj",
    "ultima_fecha",
    "ventana",
    "zona",
]
