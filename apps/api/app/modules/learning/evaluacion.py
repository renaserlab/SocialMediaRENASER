"""Cuándo una evaluación se puede publicar, y cómo se califica un intento.

POR QUÉ UN FICHERO PARA ESTO. Porque la nota es la única cifra de este módulo
que decide algo —si el curso se termina y si sale certificado— y tiene que
haber UN sitio donde esté escrita. Repartida entre el endpoint que envía y el
que consulta, acaba siendo dos reglas parecidas que un día no coinciden.

LAS TRES DECISIONES QUE FIJA:

1. **La nota la calcula el servidor.** El cliente manda qué opción eligió, y
   nada más. Que pudiera mandar su propio porcentaje convertiría el certificado
   en un adorno.

2. **Sin responder no es cero por descuido, es cero de verdad.** Una pregunta
   sin respuesta cuenta como fallada: es lo que pasó. Lo que NO se hace es
   dejar de contarla, que subiría la nota de quien deja preguntas en blanco.

3. **Una evaluación a medias no se publica.** Sin preguntas, con una pregunta
   de una sola alternativa o sin marcar la correcta, publicar dejaría a un
   alumno delante de algo que no se puede aprobar. Las condiciones están aquí y
   se comprueban ANTES de tocar el estado.
"""

from __future__ import annotations

#: Alternativas por pregunta. Menos de dos no es una pregunta de opción; más de
#: cinco no cabe en una pantalla de teléfono sin desplazarse.
MINIMO_DE_OPCIONES = 2
MAXIMO_DE_OPCIONES = 5

#: Nota mínima por defecto. Es una decisión de producto, no una ley: cada
#: evaluación puede llevar la suya.
APROBACION_POR_DEFECTO = 70


def puntaje(aciertos: int, total: int) -> int:
    """La nota, en enteros del 0 al 100.

    NO se acota a 1..99 como el avance del curso: allí un 0 % y un 100 % falsos
    invitan a cerrar la pantalla, y aquí los dos extremos son resultados
    legítimos que hay que poder decir. Sacar cero es sacar cero.

    Una evaluación sin preguntas da 0 y no revienta: publicarla ya está
    prohibido, pero una fila antigua no puede tumbar la pantalla de nadie.
    """
    if total <= 0:
        return 0
    acertadas = max(0, min(aciertos, total))
    return round(acertadas * 100 / total)


def aprueba(nota: int, minimo: int) -> bool:
    """Si esa nota basta. El mínimo es de la evaluación, no global."""
    return nota >= minimo


def califica(
    respuestas: dict[str, str], correctas: dict[str, str], minimo: int
) -> tuple[int, bool]:
    """La nota de un intento y si aprueba.

    `respuestas` es {pregunta: opción elegida} y `correctas` {pregunta: opción
    correcta}. El total sale de `correctas`, NUNCA de `respuestas`: contar solo
    lo respondido premiaría dejar preguntas en blanco.

    Una respuesta a una pregunta que no existe se ignora en el numerador porque
    no está en `correctas`; el endpoint la rechaza antes, pero calcular bien
    aunque llegue es más barato que confiar.
    """
    total = len(correctas)
    aciertos = sum(
        1 for pregunta, correcta in correctas.items() if respuestas.get(pregunta) == correcta
    )
    nota = puntaje(aciertos, total)
    return nota, aprueba(nota, minimo)


def motivo_para_no_publicar(
    preguntas: list[tuple[str, list[bool]]],
) -> str | None:
    """Por qué esta evaluación todavía no se puede publicar, o `None`.

    Cada elemento es (id de la pregunta, [si cada alternativa es la correcta]).
    Devuelve un CÓDIGO, que es lo que el móvil traduce; el orden de las
    comprobaciones va de lo más general a lo más concreto para que el primer
    aviso sea el más útil.
    """
    if not preguntas:
        return "quiz_without_questions"
    for _pregunta, marcas in preguntas:
        if len(marcas) < MINIMO_DE_OPCIONES or len(marcas) > MAXIMO_DE_OPCIONES:
            return "quiz_option_count_invalid"
        if sum(1 for m in marcas if m) != 1:
            return "quiz_answer_missing"
    return None
