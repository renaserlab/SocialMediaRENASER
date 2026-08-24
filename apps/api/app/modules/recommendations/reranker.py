"""Diversidad y exploracion: que la lista no se convierta en una sola cosa.

El ranker hace bien su trabajo y precisamente por eso hace falta esto. Ordenar
solo por score produce listas monotematicas —las diez personas del mismo tema,
o los cinco videos seguidos de la misma persona—, y una lista asi es peor que
la suma de sus partes: quien la mira ya vio la primera, y las otras nueve no
le anaden nada.

Tampoco puede ser una barajada. Todo lo de aqui es determinista: la misma
entrada produce siempre la misma salida, para que la lista no baile al
desplazarse y para que los tests puedan comprobarla.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Protocol, Sequence, TypeVar


class ConScore(Protocol):
    score: float


T = TypeVar("T")


@dataclass(frozen=True)
class Diversificado:
    """Resultado de reordenar, con lo que se aparto por si hace falta."""

    elegidos: list
    apartados: list


def por_grupo(
    elementos: Sequence[T],
    *,
    grupo_de,
    maximo_por_grupo: int,
    limite: int,
) -> list[T]:
    """Recorre la lista ordenada dejando pasar como mucho N por grupo.

    Los que se apartan NO se tiran: se guardan y se vuelven a intentar al final,
    en su orden original. Con poco catalogo —tres videos y un creador— tirarlos
    dejaria la pantalla medio vacia para «no repetir», que es exactamente el
    problema contrario.
    """
    if maximo_por_grupo <= 0:
        return list(elementos)[:limite]

    elegidos: list[T] = []
    apartados: list[T] = []
    cuenta: dict[object, int] = {}

    for elemento in elementos:
        if len(elegidos) >= limite:
            break
        clave = grupo_de(elemento)
        if cuenta.get(clave, 0) >= maximo_por_grupo:
            apartados.append(elemento)
            continue
        cuenta[clave] = cuenta.get(clave, 0) + 1
        elegidos.append(elemento)

    # Rellenar con lo apartado antes que devolver una lista corta.
    for elemento in apartados:
        if len(elegidos) >= limite:
            break
        elegidos.append(elemento)
    return elegidos


def sin_rachas(
    elementos: Sequence[T], *, grupo_de, maximo_seguidos: int
) -> list[T]:
    """Evita ver N seguidos del mismo autor, sin sacarlo de la lista.

    Diferencia con `por_grupo`, y es importante: aqui nadie se queda fuera. Se
    cambia el ORDEN para intercalar. Si solo publica una persona, la lista sale
    igual que entro: no hay con quien intercalar y dejar huecos seria peor.
    """
    if maximo_seguidos <= 0:
        return list(elementos)

    pendientes = list(elementos)
    salida: list[T] = []
    ultimo: object = object()
    seguidos = 0

    while pendientes:
        indice = 0
        if seguidos >= maximo_seguidos:
            # Busca el primero que rompa la racha; si no hay ninguno, sigue
            # con el que tocaba.
            for i, elemento in enumerate(pendientes):
                if grupo_de(elemento) != ultimo:
                    indice = i
                    break
        elegido = pendientes.pop(indice)
        clave = grupo_de(elegido)
        seguidos = seguidos + 1 if clave == ultimo else 1
        ultimo = clave
        salida.append(elegido)
    return salida


def reservar_hueco(
    principales: Sequence[T],
    exploratorios: Iterable[T],
    *,
    cada: int,
    limite: int,
) -> list[T]:
    """Intercala candidatos de exploracion cada N posiciones.

    Sin esto, la exploracion queda enterrada al final de la lista y no la ve
    nadie: pesar un 10 % en el score no sirve de nada si ese 10 % nunca alcanza
    para entrar en la primera pantalla. Una persona nueva con conocimiento
    relevante tiene que poder aparecer arriba alguna vez.
    """
    if cada <= 0:
        return list(principales)[:limite]

    resto = list(exploratorios)
    salida: list[T] = []
    for indice, elemento in enumerate(principales):
        if len(salida) >= limite:
            break
        salida.append(elemento)
        if resto and (indice + 1) % cada == 0 and len(salida) < limite:
            salida.append(resto.pop(0))
    for elemento in resto:
        if len(salida) >= limite:
            break
        salida.append(elemento)
    return salida[:limite]
