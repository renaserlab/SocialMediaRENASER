"""Memoria corta del ranking de personas.

POR QUE EXISTE, Y SOLO DESPUES DE MEDIRLO. Ordenar personas cuesta unas quince
consultas: preferencias, relaciones, bloqueos, senales, candidatos, actividad.
Ninguna es un N+1 —su numero no crece con los candidatos— pero son quince viajes
a la base de datos, y el feed de Inicio necesita ese mismo ranking para saber a
quien pertenece cada video.

Medido: el feed cronologico resolvia una pagina con 2 consultas y el
personalizado con 21. Peor todavia, cada pagina siguiente del scroll infinito
repetia las 21 para obtener exactamente el mismo orden. Eso es lo que corrige
esto: la primera pagina paga el ranking y las siguientes lo reutilizan.

QUE **NO** ES. No es Redis ni un servicio aparte. Es un diccionario en el
proceso, con caducidad y con techo. Si hay varios procesos, cada uno tendra el
suyo y no pasa nada: lo peor que puede ocurrir es calcularlo dos veces.

LA CADUCIDAD ES CORTA A PROPOSITO, y ademas se INVALIDA a mano en cuanto ocurre
algo que cambia lo que se le debe recomendar a alguien: guardar preferencias,
seguir a una persona, decir «no me interesa». Sin eso, alguien contestaria el
cuestionario y veria durante un minuto las recomendaciones de antes de
contestarlo, que es justo el momento en el que hay que demostrar que sirve.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from typing import Any

#: Cuanto vale una entrada. Corto: es una ayuda para el scroll y para que dos
#: pantallas seguidas no repitan el trabajo, no un almacen de resultados.
VIGENCIA_S = 60.0

#: Cuantas personas caben. Con techo para que la memoria del proceso no crezca
#: con el numero de usuarios activos.
MAXIMO = 500

_entradas: "OrderedDict[str, tuple[float, Any]]" = OrderedDict()


def _clave(user_id: str, semilla: str) -> str:
    # La semilla entra en la clave porque al cambiar de dia cambia la
    # exploracion: sin ella, el resultado de ayer sobreviviria a la medianoche.
    return f"{user_id}|{semilla}"


def obtener(user_id: str, semilla: str) -> Any | None:
    clave = _clave(user_id, semilla)
    entrada = _entradas.get(clave)
    if entrada is None:
        return None
    guardado_en, valor = entrada
    if time.monotonic() - guardado_en > VIGENCIA_S:
        _entradas.pop(clave, None)
        return None
    _entradas.move_to_end(clave)
    return valor


def guardar(user_id: str, semilla: str, valor: Any) -> None:
    clave = _clave(user_id, semilla)
    _entradas[clave] = (time.monotonic(), valor)
    _entradas.move_to_end(clave)
    while len(_entradas) > MAXIMO:
        # Se descarta lo mas antiguo sin usar. Perder una entrada solo cuesta
        # recalcularla.
        _entradas.popitem(last=False)


def invalidar(user_id: str) -> None:
    """Lo que sabiamos de esta persona ya no vale.

    Se llama cuando ocurre algo que cambia lo que hay que recomendarle:
    responde el cuestionario, sigue a alguien, pide una sesion o dice que algo
    no le interesa. Es lo que hace que el efecto se vea AL MOMENTO y no dentro
    de un minuto.
    """
    for clave in [k for k in _entradas if k.startswith(f"{user_id}|")]:
        _entradas.pop(clave, None)


def vaciar() -> None:
    """Solo para los tests: que uno no herede el estado del anterior."""
    _entradas.clear()
