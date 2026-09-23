"""Tumba el trabajo si la batería con PostgreSQL no se ejecutó ENTERA.

Lo usan los dos flujos que tienen PostgreSQL: la integración continua y la
puerta del despliegue a producción. Vive aquí, en un solo sitio, porque
duplicarlo en los dos YAML es exactamente cómo uno se queda viejo sin el otro:
ya pasó con la dependencia del arnés, que se corrigió en `ci.yml` y se quedó
fuera del despliegue durante semanas.

DOS COSAS, Y LAS DOS HACEN FALTA:

1. **Ni una omitida.** Una prueba omitida no es una prueba aprobada. Sin esto,
   borrar la variable que abre la base dejaría el trabajo en verde sin haber
   ejecutado nada contra PostgreSQL: todo omitido, todo «aprobado».
2. **Un suelo.** Con cero omitidas pero la selección acotada —un `-k`, una
   carpeta, un fichero— el trabajo también saldría verde. El suelo está MEDIDO
   y va algo por debajo de lo real, para que añadir o quitar un par de casos no
   tumbe la integración y perder una batería entera sí.

Uso: python scripts/exigir_bateria_completa.py <informe.xml>
"""

from __future__ import annotations

import sys
import xml.etree.ElementTree as ET

#: MEDIDO, no supuesto: la batería entera con PostgreSQL daba 3371 casos el
#: 23/09/2026. Si crece mucho, se sube; si baja de aquí, algo se ha perdido.
SUELO = 3350


def main(ruta: str) -> int:
    raiz = ET.parse(ruta).getroot()
    suite = raiz if raiz.get("tests") is not None else raiz[0]
    total = int(suite.get("tests") or 0)
    omitidas = int(suite.get("skipped") or 0)
    fallidas = int(suite.get("failures") or 0) + int(suite.get("errors") or 0)
    print(f"{total} pruebas, {omitidas} omitidas, {fallidas} fallidas")
    if omitidas:
        print("hay pruebas de PostgreSQL omitidas: omitida no es aprobada")
        return 1
    if total < SUELO:
        print(f"solo se ejecutaron {total} de al menos {SUELO}: falta alguna batería")
        return 1
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
