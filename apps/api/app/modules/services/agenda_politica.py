"""LOS LÍMITES DE LA AGENDA DE SERVICIOS (Incremento 4), EN UN SOLO SITIO.

Dos clases de número, y no se mezclan:

  * LOS PROVISIONALES DE LA EMPRESA, configurables por entorno: la antelación
    mínima (`services_agenda_notice_minutes`) y el horizonte
    (`services_agenda_horizon_days`). Vienen del documento de reglas de la
    reserva (2 h y 60 días) y no se deciden aquí.
  * LOS TÉCNICOS: lo que impide un horario imposible o una consulta abusiva
    (la rejilla de 5 minutos, la separación máxima, cuántas reglas caben,
    cuántos días se piden de una vez). Los mismos que impone la 0092: las
    restricciones del ORM se escriben con estas constantes y una prueba las
    compara con las de la base.

Nadie más escribe uno de estos números: el modelo, el cálculo, el dominio y
los contratos los leen de aquí.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.core.config import Settings, get_settings

# --------------------------------------------------------------------------- #
# Técnicos (los impone también la base)
# --------------------------------------------------------------------------- #
#: Las horas de una regla o una excepción van de 5 en 5 minutos.
REJILLA_MINUTOS = 5
#: Un día, en minutos. Una franja termina como tarde a las 24:00.
MINUTOS_DEL_DIA = 1440
#: Preparación antes y descanso después, cada uno.
SEPARACION_MAXIMA = 240
#: Cada cuánto empieza un horario, si no es «uno detrás de otro».
INTERVALO_MINIMO = 5
INTERVALO_MAXIMO = 1440
#: Personas por horario (la misma cota que `service_versions.capacity`).
CAPACIDAD_MAXIMA = 1000
#: Largo del motivo PRIVADO de un bloqueo.
MOTIVO_MAXIMO = 200
#: Largo de una zona IANA («America/Argentina/Buenos_Aires» tiene 30).
ZONA_MAXIMA = 64

# --------------------------------------------------------------------------- #
# Técnicos (los impone el dominio: dependen de «hoy» o de contar filas)
# --------------------------------------------------------------------------- #
#: Reglas semanales por agenda, activas o no.
REGLAS_MAXIMAS = 50
#: Excepciones y bloqueos que todavía no pasaron, cada uno.
EXCEPCIONES_MAXIMAS = 200
BLOQUEOS_MAXIMOS = 200
#: Cuántos días por delante se puede preparar una excepción o un bloqueo.
ADELANTO_MAXIMO_DIAS = 366
#: Lo que dura un bloqueo como mucho.
BLOQUEO_MAXIMO_DIAS = 31
#: Días por consulta pública de fechas.
DIAS_POR_CONSULTA = 31
#: Horarios por página de un día.
HORARIOS_POR_PAGINA = 48
HORARIOS_MAXIMOS_POR_PAGINA = 96

#: Cotas de los dos provisionales: un entorno mal configurado no abre un
#: horizonte infinito ni una antelación negativa.
_ANTELACION = (0, 7 * 24 * 60)
_HORIZONTE = (1, 365)


@dataclass(frozen=True)
class Politica:
    """Lo configurable, ya leído y acotado."""

    antelacion_minutos: int
    horizonte_dias: int

    @classmethod
    def de(cls, ajustes: Settings | None = None) -> "Politica":
        a = ajustes or get_settings()
        return cls(
            antelacion_minutos=min(max(int(a.services_agenda_notice_minutes), _ANTELACION[0]), _ANTELACION[1]),
            horizonte_dias=min(max(int(a.services_agenda_horizon_days), _HORIZONTE[0]), _HORIZONTE[1]),
        )


__all__ = [
    "ADELANTO_MAXIMO_DIAS",
    "BLOQUEOS_MAXIMOS",
    "BLOQUEO_MAXIMO_DIAS",
    "CAPACIDAD_MAXIMA",
    "DIAS_POR_CONSULTA",
    "EXCEPCIONES_MAXIMAS",
    "HORARIOS_MAXIMOS_POR_PAGINA",
    "HORARIOS_POR_PAGINA",
    "INTERVALO_MAXIMO",
    "INTERVALO_MINIMO",
    "MINUTOS_DEL_DIA",
    "MOTIVO_MAXIMO",
    "Politica",
    "REGLAS_MAXIMAS",
    "REJILLA_MINUTOS",
    "SEPARACION_MAXIMA",
    "ZONA_MAXIMA",
]
