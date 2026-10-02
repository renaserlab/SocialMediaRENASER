"""Prepara las Condiciones piloto v1 de Z Servicios para publicarlas.

NO PUBLICA NADA. No abre ninguna conexión, ni a la base ni a la API, y no lee
la configuración: solo lee el texto, lo comprueba y dice su huella. Publicar
lo hace una persona de administración con las rutas que ya existen
(`docs/Z_SERVICIOS_CONDICIONES_PILOTO_V1.md`, «Cómo se publican»).

PARA QUÉ. La huella de unas condiciones es el SHA-256 del texto EXACTO que
guarda el servidor (`services/politicas.py`, sin normalizar): un salto de
línea de Windows o un espacio al final dan otra huella. Pegar el texto a mano
puede cambiarlo sin que se note. Aquí el texto se deja como el servidor lo va
a guardar —saltos de línea `\\n`, sin espacios al principio ni al final— y se
calcula la huella que el borrador tiene que enseñar ANTES de publicarlo.

    python scripts/condiciones_del_piloto.py
        Comprueba el texto y dice su título, su tamaño y su huella.

    python scripts/condiciones_del_piloto.py --salida condiciones.json
        Además escribe el cuerpo de la petición del borrador
        (`POST /api/v1/admin/services/policies/booking-terms/draft`).

SE NIEGA si el texto todavía lleva un marcador entre corchetes con la palabra
PENDIENTE (la aprobación, el canal de soporte): unas condiciones con un
marcador no se publican. `--borrador` lo permite, solo para ensayar.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[3]
TEXTO = RAIZ / "docs" / "Z_SERVICIOS_CONDICIONES_PILOTO_V1.txt"
TITULO = "Condiciones del piloto de Z Servicios"
PAIS = "PE"
#: Los de `PoliticaBorradorCrear` (`services/schemas.py`).
TITULO_MINIMO, TITULO_MAXIMO = 3, 200
CUERPO_MINIMO, CUERPO_MAXIMO = 50, 100_000
_MARCADOR = re.compile(r"\[[^\]\n]*PENDIENTE[^\]\n]*\]")


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


def peticion(texto: str) -> dict:
    """El cuerpo del borrador. Sin `category`: las condiciones de contratación
    que rigen una reserva son las generales del país del prestador."""
    if not TITULO_MINIMO <= len(TITULO) <= TITULO_MAXIMO:
        raise ValueError("El título no cabe en los límites de una política.")
    if not CUERPO_MINIMO <= len(texto) <= CUERPO_MAXIMO:
        raise ValueError(f"El texto tiene {len(texto)} caracteres: tiene que tener entre {CUERPO_MINIMO} y {CUERPO_MAXIMO}.")
    return {"country_code": PAIS, "title": TITULO, "body": texto}


def main(argumentos: list[str] | None = None) -> int:
    analizador = argparse.ArgumentParser(description="Comprueba las Condiciones piloto v1 y dice su huella. No publica.")
    analizador.add_argument("--texto", type=Path, default=TEXTO, help="El fichero del texto (por defecto, el de docs/).")
    analizador.add_argument("--salida", type=Path, help="Dónde escribir el cuerpo de la petición del borrador (JSON).")
    analizador.add_argument("--borrador", action="store_true", help="Admite marcadores PENDIENTE. Solo para ensayar.")
    opciones = analizador.parse_args(argumentos)

    texto = leer(opciones.texto)
    cuerpo = peticion(texto)
    faltan = pendientes(texto)
    print(f"Título:  {TITULO}")
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
