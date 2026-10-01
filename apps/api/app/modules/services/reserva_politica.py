"""LOS LÍMITES DE LA RESERVA Y DE LA ATENCIÓN DE SERVICIOS (Incrementos 5 y
6), EN UN SOLO SITIO.

Dos clases de número, y no se mezclan:

  * LOS PROVISIONALES DE LA EMPRESA, configurables por entorno y acotados
    aquí: cuánto dura una retención (`services_booking_hold_minutes`, 10 del
    documento de reglas §6.1), cuántas activas puede tener una persona
    (`services_booking_max_active_holds`, 3, §6.5) y qué modalidades se
    confirman solas (`services_booking_instant_modalities`). No se deciden
    aquí: se leen de la configuración.
  * LOS TÉCNICOS: los largos de lo que escribe quien contrata, las páginas,
    el lote del barrido y cuánto se espera un cerrojo. Los mismos que impone
    la 0093 donde la base los conoce.

Y UNA PREGUNTA: ¿se puede cobrar un servicio? Hoy NO, y la respuesta vive
solo aquí (`cobro_disponible`).
"""

from __future__ import annotations

from dataclasses import dataclass

from app.core.config import Settings, get_settings
from app.modules.services.catalogo_models import MODALIDADES

# --------------------------------------------------------------------------- #
# Técnicos
# --------------------------------------------------------------------------- #
#: Lo que escribe quien contrata (los mismos que la 0093).
NOTA_MAXIMA = 500
DISTRITO_MAXIMO = 100
DIRECCION_MAXIMA = 200
REFERENCIA_MAXIMA = 200
#: Las listas de reservas y de retenciones.
RESERVAS_POR_PAGINA = 20
RESERVAS_MAXIMAS_POR_PAGINA = 50
#: El barrido de retenciones vencidas: cuántas en una llamada.
LOTE_DEL_BARRIDO = 200
LOTE_MAXIMO_DEL_BARRIDO = 1000
#: Cuánto espera una petición a que otra suelte el servicio antes de un 409.
ESPERA_DEL_CERROJO_MS = 5000
#: El código de una reserva: 8 caracteres sin los que se confunden (0/O, 1/I).
ALFABETO_DEL_CODIGO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

#: Cotas de los provisionales: un entorno mal configurado no aparta un horario
#: durante horas ni deja a nadie sin poder retener.
_RETENCION_MINUTOS = (1, 60)
_RETENCIONES_ACTIVAS = (1, 20)


@dataclass(frozen=True)
class Politica:
    """Lo configurable, ya leído y acotado."""

    retencion_minutos: int
    retenciones_activas: int
    modalidades_inmediatas: frozenset[str]

    @classmethod
    def de(cls, ajustes: Settings | None = None) -> "Politica":
        a = ajustes or get_settings()
        inmediatas = frozenset(
            m.strip() for m in str(a.services_booking_instant_modalities or "").split(",") if m.strip()
        ) & frozenset(MODALIDADES)
        return cls(
            retencion_minutos=min(max(int(a.services_booking_hold_minutes), _RETENCION_MINUTOS[0]),
                                  _RETENCION_MINUTOS[1]),
            retenciones_activas=min(max(int(a.services_booking_max_active_holds), _RETENCIONES_ACTIVAS[0]),
                                    _RETENCIONES_ACTIVAS[1]),
            modalidades_inmediatas=inmediatas,
        )


# --------------------------------------------------------------------------- #
# La atención y la posventa (Incremento 6)
# --------------------------------------------------------------------------- #
#: TÉCNICOS (los mismos que impone la 0094 donde la base los conoce).
CODIGO_DE_ASISTENCIA_CIFRAS = 6
INTENTOS_DEL_CODIGO = 5
DESCRIPCION_DEL_CASO = (20, 2000)
ENTRADA_MAXIMA = 2000
MOTIVO_MAXIMO = 500
#: Por PARTE, no por caso: que una llene su cupo no deja a la otra sin el suyo.
EVIDENCIAS_POR_PARTE = 10
COMENTARIO_DE_RESENA = (20, 2000)
RESPUESTA_MAXIMA = 1000
#: Los barridos de la atención: cuántas filas en una llamada.
LOTE_DE_TAREAS = 200
LOTE_MAXIMO_DE_TAREAS = 1000

#: Cotas de los PROVISIONALES de la atención (política operativa v1 del
#: alcance; ninguno es una decisión tomada aquí). Un entorno mal configurado
#: no deja una atención sin poder empezar ni un caso sin plazo.
_COTAS_DE_LA_ATENCION = {
    "services_attention_checkin_minutes": (0, 240),
    "services_attention_tolerance_minutes": (0, 240),
    "services_attention_confirmation_hours": (1, 720),
    "services_booking_reschedule_max": (0, 10),
    "services_booking_reschedule_min_hours": (0, 720),
    "services_booking_reminder_hours": (1, 168),
    "services_incident_window_hours": (1, 720),
    "services_incident_appeal_days": (1, 60),
    # Dos resoluciones como mucho por caso (0094): una apelación, o ninguna.
    "services_incident_appeals_max": (0, 1),
    "services_review_window_days": (1, 365),
}


@dataclass(frozen=True)
class PoliticaDeAtencion:
    """Lo configurable de la atención, ya leído y acotado. TODO PROVISIONAL."""

    #: Cuántos minutos antes de la hora se abre la llegada (código, iniciar).
    llegada_minutos: int
    #: La tolerancia: pasada la hora, cuándo se puede reportar una ausencia.
    tolerancia_minutos: int
    #: Cuánto tiene quien contrata para confirmar que se realizó.
    confirmacion_horas: int
    #: Cuántas veces reprograma quien contrata, y con cuánta antelación.
    reprogramaciones: int
    reprogramar_horas_antes: int
    recordatorio_horas: int
    #: Cuánto hay para abrir un caso, y para apelar su resolución.
    caso_horas: int
    apelacion_dias: int
    apelaciones: int
    #: Cuánto hay para reseñar, y si una reseña espera a moderación.
    resena_dias: int
    resena_con_moderacion_previa: bool

    @classmethod
    def de(cls, ajustes: Settings | None = None) -> "PoliticaDeAtencion":
        a = ajustes or get_settings()

        def acotado(nombre: str) -> int:
            minimo, maximo = _COTAS_DE_LA_ATENCION[nombre]
            return min(max(int(getattr(a, nombre)), minimo), maximo)

        return cls(
            llegada_minutos=acotado("services_attention_checkin_minutes"),
            tolerancia_minutos=acotado("services_attention_tolerance_minutes"),
            confirmacion_horas=acotado("services_attention_confirmation_hours"),
            reprogramaciones=acotado("services_booking_reschedule_max"),
            reprogramar_horas_antes=acotado("services_booking_reschedule_min_hours"),
            recordatorio_horas=acotado("services_booking_reminder_hours"),
            caso_horas=acotado("services_incident_window_hours"),
            apelacion_dias=acotado("services_incident_appeal_days"),
            apelaciones=acotado("services_incident_appeals_max"),
            resena_dias=acotado("services_review_window_days"),
            resena_con_moderacion_previa=bool(a.services_reviews_premoderation),
        )


#: Los adaptadores de cobro de Servicios. NINGUNO: no existe ninguno.
ADAPTADORES_DE_COBRO: dict[str, object] = {}


def cobro_disponible(ajustes: Settings | None = None) -> bool:
    """¿Se puede cobrar un servicio? HOY NO, y por tres razones a la vez: las
    banderas están apagadas, la pasarela es `none` y no existe adaptador. Con
    las tres, tampoco: la 0093 solo admite pedidos gratuitos. Un servicio con
    precio contesta `service_booking_payments_not_configured` y NUNCA se da por
    cobrado."""
    a = ajustes or get_settings()
    return bool(
        a.feature_service_payments
        and a.service_payments_provider != "none"
        and a.service_payments_provider in ADAPTADORES_DE_COBRO
    )


__all__ = [
    "ADAPTADORES_DE_COBRO",
    "ALFABETO_DEL_CODIGO",
    "CODIGO_DE_ASISTENCIA_CIFRAS",
    "COMENTARIO_DE_RESENA",
    "DESCRIPCION_DEL_CASO",
    "ENTRADA_MAXIMA",
    "EVIDENCIAS_POR_PARTE",
    "INTENTOS_DEL_CODIGO",
    "LOTE_DE_TAREAS",
    "LOTE_MAXIMO_DE_TAREAS",
    "MOTIVO_MAXIMO",
    "PoliticaDeAtencion",
    "RESPUESTA_MAXIMA",
    "DIRECCION_MAXIMA",
    "DISTRITO_MAXIMO",
    "ESPERA_DEL_CERROJO_MS",
    "LOTE_DEL_BARRIDO",
    "LOTE_MAXIMO_DEL_BARRIDO",
    "NOTA_MAXIMA",
    "Politica",
    "REFERENCIA_MAXIMA",
    "RESERVAS_MAXIMAS_POR_PAGINA",
    "RESERVAS_POR_PAGINA",
    "cobro_disponible",
]
