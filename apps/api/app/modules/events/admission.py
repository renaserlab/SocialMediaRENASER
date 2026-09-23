"""La admisión: puntaje, fallas críticas y decisión. Sin base de datos.

LOS OCHO CRITERIOS Y SUS TOPES son los del blueprint §4.2. Están aquí Y en el
CHECK de la migración, y las dos veces hacen falta: aquí para explicar el
rechazo con una frase útil, y en la base para que ninguna ruta —ni una futura,
ni un script— pueda guardar un 30 sobre 20.

LA REGLA DE APROBACIÓN, también del blueprint:

    aprobado     ->  85 o más y CERO fallas críticas
    condicional  ->  entre 80 y 84, y cero fallas críticas
    rechazado    ->  menos de 80

UNA FALLA CRÍTICA IMPIDE APROBAR AUNQUE EL PUNTAJE SEA ALTO. Es la regla que
más fácil se pierde al programarla: con un `if total >= 85` delante, un evento
sin plan de emergencias y con 98 puntos entra igual.
"""

from __future__ import annotations

from dataclasses import dataclass

#: Criterio -> tope. El orden es el del blueprint y suma 100.
CRITERIOS: dict[str, int] = {
    "propuesta": 20,
    "trayectoria": 15,
    "programa": 15,
    "recinto": 15,
    "seguridad": 15,
    "precio": 10,
    "accesibilidad": 5,
    "afinidad": 5,
}

TOTAL_POSIBLE = sum(CRITERIOS.values())

APROBADO = "approved"
CONDICIONAL = "conditional"
RECHAZADO = "rejected"
CAMBIOS = "changes_requested"

#: Umbrales. `UMBRAL_APROBACION` es «85 o más»; `UMBRAL_CONDICIONAL`, «80 o más».
UMBRAL_APROBACION = 85
UMBRAL_CONDICIONAL = 80


@dataclass(frozen=True)
class Evaluacion:
    """Los ocho puntajes y si hay una falla crítica."""

    puntajes: dict[str, int]
    falla_critica: bool = False

    @property
    def total(self) -> int:
        return sum(self.puntajes.get(nombre, 0) for nombre in CRITERIOS)


def motivo_para_no_puntuar(puntajes: dict[str, int]) -> str | None:
    """Por qué esta evaluación no se puede guardar, o `None`.

    Falta un criterio o se sale de su rango. NO se rellena el que falta con
    cero: un cero es una nota, y darla por sentada convierte un formulario a
    medio llenar en un rechazo que nadie decidió.
    """
    for nombre, tope in CRITERIOS.items():
        if nombre not in puntajes:
            return f"Falta puntuar «{nombre}»."
        valor = puntajes[nombre]
        if not isinstance(valor, int) or isinstance(valor, bool):
            return f"«{nombre}» tiene que ser un número entero."
        if valor < 0 or valor > tope:
            return f"«{nombre}» va de 0 a {tope}; llegó {valor}."
    sobran = set(puntajes) - set(CRITERIOS)
    if sobran:
        return f"Criterios que no existen: {', '.join(sorted(sobran))}."
    return None


def decision_posible(evaluacion: Evaluacion) -> str:
    """La mejor decisión que este puntaje admite.

    No es «la decisión»: quien administra puede rechazar un evento de 92. Lo que
    esto dice es hasta dónde PUEDE llegar, y por debajo de eso no se aprueba.
    """
    if evaluacion.falla_critica:
        return RECHAZADO
    if evaluacion.total >= UMBRAL_APROBACION:
        return APROBADO
    if evaluacion.total >= UMBRAL_CONDICIONAL:
        return CONDICIONAL
    return RECHAZADO


def motivo_para_no_decidir(decision: str, evaluacion: Evaluacion | None) -> str | None:
    """Por qué esa decisión no se puede tomar, o `None` si se puede.

    SIN EVALUACIÓN NO HAY APROBACIÓN. Es lo primero que se comprueba: aprobar
    sin haber puntuado es exactamente lo que el blueprint prohíbe cuando dice
    que nadie altera un puntaje sin motivo, evidencia y registro.
    """
    if decision == CAMBIOS:
        return None
    if decision == RECHAZADO:
        return None
    if evaluacion is None:
        return "No se puede aprobar un evento sin evaluarlo antes."
    if evaluacion.falla_critica:
        return "Hay una falla crítica: no se aprueba aunque el puntaje alcance."
    if decision == APROBADO:
        if evaluacion.total < UMBRAL_APROBACION:
            return (
                f"Aprobar exige {UMBRAL_APROBACION} de {TOTAL_POSIBLE}; "
                f"la evaluación da {evaluacion.total}."
            )
        return None
    if decision == CONDICIONAL:
        if not (UMBRAL_CONDICIONAL <= evaluacion.total < UMBRAL_APROBACION):
            return (
                f"Condicional es de {UMBRAL_CONDICIONAL} a {UMBRAL_APROBACION - 1}; "
                f"la evaluación da {evaluacion.total}."
            )
        return None
    return f"«{decision}» no es una decisión de admisión."


def da_sello_z(decision: str) -> bool:
    """Si esta decisión concede «Seleccionado por Z».

    SOLO `approved`. Un condicional todavía tiene un pendiente por subsanar, y
    el sello dice que la calidad y la operación están aprobadas, no que estén a
    punto de estarlo.
    """
    return decision == APROBADO
