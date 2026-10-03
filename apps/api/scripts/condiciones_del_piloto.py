"""Prepara las condiciones del piloto de Z Servicios para publicarlas.

Son dos textos, cada uno con su tipo de política:

    contratacion   `booking_terms`    las acepta quien contrata, al confirmar
                                      una reserva
    prestador      `provider_terms`   las acepta quien presta, antes de
                                      enviar su postulación

NO PUBLICA NADA. No abre ninguna conexión, ni a la base ni a la API, y no lee
la configuración: solo lee el texto, lo comprueba y dice su huella. Publicar
lo hace `publicar_condiciones.py` con las rutas de administración que ya
existen (`docs/Z_SERVICIOS_CONDICIONES_PILOTO_V1.md`, «Cómo se publican»).

PARA QUÉ. La huella de unas condiciones es el SHA-256 del texto EXACTO que
guarda el servidor (`services/politicas.py`, sin normalizar): un salto de
línea de Windows o un espacio al final dan otra huella. Pegar el texto a mano
puede cambiarlo sin que se note. Aquí el texto se deja como el servidor lo va
a guardar —saltos de línea `\\n`, sin espacios al principio ni al final— y se
calcula la huella que el borrador tiene que enseñar ANTES de publicarlo.

    python scripts/condiciones_del_piloto.py --tipo prestador
        Comprueba el texto y dice su título, su tamaño y su huella.

    python scripts/condiciones_del_piloto.py --tipo contratacion --salida c.json
        Además escribe el cuerpo de la petición del borrador.

SE NIEGA si el texto todavía lleva un marcador entre corchetes con la palabra
PENDIENTE: unas condiciones con un marcador no se publican. `--borrador` lo
permite, solo para ensayar.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[3]
PAIS = "PE"
#: Los de `PoliticaBorradorCrear` (`services/schemas.py`).
TITULO_MINIMO, TITULO_MAXIMO = 3, 200
CUERPO_MINIMO, CUERPO_MAXIMO = 50, 100_000
_MARCADOR = re.compile(r"\[[^\]\n]*PENDIENTE[^\]\n]*\]")


@dataclass(frozen=True)
class Condiciones:
    #: El tipo de política y el trozo de la ruta de administración que la crea.
    tipo: str
    ruta: str
    titulo: str
    texto: Path


CONDICIONES = {
    "contratacion": Condiciones(
        tipo="booking_terms", ruta="booking-terms", titulo="Condiciones del piloto de Z Servicios",
        texto=RAIZ / "docs" / "Z_SERVICIOS_CONDICIONES_PILOTO_V1.txt",
    ),
    "prestador": Condiciones(
        tipo="provider_terms", ruta="provider-terms",
        titulo="Condiciones del prestador de Z Servicios — Piloto gratuito v1",
        texto=RAIZ / "docs" / "Z_SERVICIOS_CONDICIONES_PRESTADOR_V1.txt",
    ),
}
#: Las de la contratación, por su nombre de siempre.
TEXTO = CONDICIONES["contratacion"].texto
TITULO = CONDICIONES["contratacion"].titulo


def leer(ruta: Path = TEXTO) -> str:
    """El texto como lo va a guardar el servidor: en UTF-8, con `\\n` y sin
    espacios al principio ni al final."""
    return ruta.read_bytes().decode("utf-8").replace("\r\n", "\n").replace("\r", "\n").strip()


def pendientes(texto: str) -> list[str]:
    """Los marcadores que alguien tiene que completar o retirar."""
    return _MARCADOR.findall(texto)


def huella(texto: str) -> str:
    """La misma de `politicas.huella`: el SHA-256 del texto exacto."""
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()


def peticion(texto: str, cual: str = "contratacion") -> dict:
    """El cuerpo del borrador. Sin `category` (son las generales del país) y
    sin `parameters`: las de contratación no los admiten, y las del prestador
    no exigen en el piloto más documentos que los mínimos."""
    titulo = CONDICIONES[cual].titulo
    if not TITULO_MINIMO <= len(titulo) <= TITULO_MAXIMO:
        raise ValueError("El título no cabe en los límites de una política.")
    if not CUERPO_MINIMO <= len(texto) <= CUERPO_MAXIMO:
        raise ValueError(f"El texto tiene {len(texto)} caracteres: tiene que tener entre {CUERPO_MINIMO} y {CUERPO_MAXIMO}.")
    return {"country_code": PAIS, "title": titulo, "body": texto}


def main(argumentos: list[str] | None = None) -> int:
    analizador = argparse.ArgumentParser(description="Comprueba unas condiciones del piloto y dice su huella. No publica.")
    analizador.add_argument("--tipo", choices=sorted(CONDICIONES), default="contratacion", help="Qué condiciones.")
    analizador.add_argument("--texto", type=Path, help="Otro fichero de texto (por defecto, el de docs/).")
    analizador.add_argument("--salida", type=Path, help="Dónde escribir el cuerpo de la petición del borrador (JSON).")
    analizador.add_argument("--borrador", action="store_true", help="Admite marcadores PENDIENTE. Solo para ensayar.")
    opciones = analizador.parse_args(argumentos)

    cual = CONDICIONES[opciones.tipo]
    texto = leer(opciones.texto or cual.texto)
    cuerpo = peticion(texto, opciones.tipo)
    faltan = pendientes(texto)
    print(f"Tipo:    {cual.tipo}")
    print(f"Título:  {cual.titulo}")
    print(f"País:    {PAIS}")
    print(f"Tamaño:  {len(texto)} caracteres")
    print(f"Huella:  {huella(texto)}")
    if faltan:
        print(f"\nEl texto lleva {len(faltan)} marcador(es) por completar o retirar:", file=sys.stderr)
        for marcador in faltan:
            print(f"  {marcador}", file=sys.stderr)
        if not opciones.borrador:
            print("\nNo se prepara nada: unas condiciones con un marcador no se publican.", file=sys.stderr)
            return 1
        print("\n--borrador: se sigue, SOLO PARA ENSAYAR. Esto no se publica.", file=sys.stderr)
    if opciones.salida:
        opciones.salida.write_text(json.dumps(cuerpo, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
        print(f"Petición del borrador: {opciones.salida}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
