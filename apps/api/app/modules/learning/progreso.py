"""Cuando una leccion cuenta como vista, y cuanto se guarda de ella.

POR QUE UN FICHERO PARA ESTO. Porque «completada» es UNA regla y tiene que
haber UN sitio donde este escrita. Repartida por el reproductor, por la pantalla
de la leccion y por el endpoint, acaba siendo tres reglas parecidas que no
coinciden: el video se marca completado al 90 %, el temario lo pinta al 95 % y
el curso no se cierra nunca. Aqui es una constante y una funcion, y se puede
cambiar en un sitio.

LAS DOS DECISIONES QUE FIJA:

1. **El umbral.** 92 % del video. Ni 100 % —los ultimos segundos suelen ser
   creditos, y quien se los salta ha visto la leccion igual— ni 80 %, que se
   alcanza dejandolo de fondo. Es configurable porque es una decision de
   producto, no una ley.

2. **Que el servidor no se cree lo que le cuentan.** El movil manda segundos;
   el servidor los acota a la duracion real de la leccion. Sin eso, mandar
   999999 marcaria cualquier curso como terminado, y un curso «completado» sin
   haberlo visto envenena justo lo que se quiere medir: si la recomendacion
   sirvio para algo.
"""

from __future__ import annotations

#: Fraccion del video a partir de la cual la leccion cuenta como completada.
UMBRAL_DE_COMPLETADO = 0.92

#: Tope absoluto de segundos que se aceptan para una leccion sin duracion
#: declarada. Doce horas: cualquier cosa por encima es un error o un intento.
SEGUNDOS_MAXIMOS_SIN_DURACION = 12 * 60 * 60


def segundos_validos(enviados: int, duracion: int) -> int:
    """Los segundos que de verdad se guardan.

    Se acota por arriba a la duracion de la leccion, no se rechaza: un
    reproductor que informa 901 sobre un video de 900 no esta mintiendo, esta
    redondeando. Rechazarlo perderia el progreso de alguien por un segundo.
    """
    if enviados < 0:
        return 0
    tope = duracion if duracion > 0 else SEGUNDOS_MAXIMOS_SIN_DURACION
    return min(enviados, tope)


def esta_completa(*, segundos: int, duracion: int, declarado: bool = False) -> bool:
    """Si la leccion cuenta como vista.

    `declarado` es el reproductor diciendo «se acabo el video»: eso lo sabe el
    cliente mejor que nadie y no hay motivo para discutirselo. El umbral cubre
    el otro caso, el de quien sale a falta de un minuto.

    Una leccion sin duracion declarada NO se completa sola por segundos: no hay
    contra que comparar, y suponer que 60 segundos son el 100 % de algo que no
    se sabe cuanto dura seria inventarselo. Se completa solo si lo dicen.
    """
    if declarado:
        return True
    if duracion <= 0:
        return False
    return segundos >= duracion * UMBRAL_DE_COMPLETADO


def porcentaje(completadas: int, total: int) -> int:
    """El avance del curso, en entero, sin mentir en los extremos.

    Un curso empezado no muestra 0 % y uno al que le falta una leccion no
    muestra 100 %: las dos cifras invitan a cerrar la pantalla por motivos
    opuestos y las dos son falsas.
    """
    if total <= 0:
        return 0
    if completadas <= 0:
        return 0
    if completadas >= total:
        return 100
    return max(1, min(99, round(completadas * 100 / total)))
