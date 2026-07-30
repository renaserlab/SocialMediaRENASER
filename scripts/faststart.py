# -*- coding: utf-8 -*-
"""
Mueve el indice de un MP4 (`moov`) del final al principio.

Un MP4 guarda por un lado los fotogramas (`mdat`) y por otro el indice que dice
donde empieza cada uno (`moov`). Si el indice esta al final, el reproductor no
puede empezar hasta ir a buscarlo: un viaje extra que con mala cobertura se
nota, y que con un archivo grande retrasa el arranque varios segundos.

Colocarlo delante es lo que se llama «faststart». NO recodifica nada: se
reordenan bloques y se corrigen las tablas de posiciones, asi que la calidad es
exactamente la misma y el tamano practicamente identico.

Portado del clasico `qt-faststart.c`, con una diferencia: en vez de suponer que
todo se desplaza lo mismo, se calcula el desplazamiento de CADA bloque. Asi
tambien vale para archivos con bloques sueltos entre medias.
"""

import struct


def _leer_atomos(datos):
    """Lista de (tipo, inicio, fin) de los bloques de primer nivel."""
    atomos = []
    i = 0
    n = len(datos)
    while i + 8 <= n:
        tam = struct.unpack('>I', datos[i:i + 4])[0]
        tipo = datos[i + 4:i + 8]
        cab = 8
        if tam == 1:                       # tamano de 64 bits
            if i + 16 > n:
                break
            tam = struct.unpack('>Q', datos[i + 8:i + 16])[0]
            cab = 16
        elif tam == 0:                     # se extiende hasta el final
            tam = n - i
        if tam < cab or i + tam > n:
            break
        atomos.append((tipo, i, i + tam))
        i += tam
    return atomos


def _ajustar_tablas(moov, mover):
    """
    Suma el desplazamiento a las tablas de posiciones dentro del indice.

    `stco` guarda posiciones de 32 bits y `co64` de 64. Apuntan a sitios
    absolutos del archivo, asi que al mover bloques dejan de valer y hay que
    corregirlas una a una: es justamente lo que se rompe si uno se limita a
    recolocar el indice sin tocar nada mas.

    `mover` recibe la posicion vieja y devuelve la nueva.
    """
    salida = bytearray(moov)
    corregidas = 0
    for etiqueta, ancho, empaqueta in ((b'stco', 4, '>I'), (b'co64', 8, '>Q')):
        desde = 0
        while True:
            i = salida.find(etiqueta, desde)
            if i < 0:
                break
            desde = i + 4
            # Tras el nombre van version+banderas (4) y el numero de entradas (4).
            base = i + 8
            if base + 4 > len(salida):
                continue
            cuantas = struct.unpack('>I', salida[base:base + 4])[0]
            fin = base + 4 + cuantas * ancho
            if cuantas == 0 or fin > len(salida):
                continue
            for k in range(cuantas):
                p = base + 4 + k * ancho
                viejo = struct.unpack(empaqueta, salida[p:p + ancho])[0]
                nuevo = mover(viejo)
                if ancho == 4 and nuevo > 0xFFFFFFFF:
                    raise ValueError('la nueva posicion no cabe en 32 bits')
                salida[p:p + ancho] = struct.pack(empaqueta, nuevo)
                corregidas += 1
    return bytes(salida), corregidas


def reordenar(datos):
    """
    Devuelve (nuevo_contenido, informe).

    Si el indice ya esta delante, devuelve el contenido sin tocar.
    """
    atomos = _leer_atomos(datos)
    tipos = [t.decode('latin1') for t, _, _ in atomos]
    if not any(t == b'moov' for t, _, _ in atomos):
        raise ValueError(f'no se encontro el indice (bloques: {tipos})')
    if not any(t == b'mdat' for t, _, _ in atomos):
        raise ValueError(f'no se encontraron los datos (bloques: {tipos})')

    pos_moov = next(k for k, (t, _, _) in enumerate(atomos) if t == b'moov')
    pos_mdat = next(k for k, (t, _, _) in enumerate(atomos) if t == b'mdat')
    if pos_moov < pos_mdat:
        return datos, {'ya_estaba': True, 'bloques': tipos}

    _, ini_moov, fin_moov = atomos[pos_moov]
    moov = datos[ini_moov:fin_moov]
    largo_moov = fin_moov - ini_moov

    # Orden nuevo: primero los bloques de cabecera (ftyp y demas), luego el
    # indice y despues todo lo restante en el mismo orden en que estaba.
    cabecera = [a for a in atomos[:pos_mdat] if a[0] != b'moov']
    cuerpo = [a for a in atomos[pos_mdat:] if a[0] != b'moov']

    # Se descartan los bloques de relleno: dejan de tener sentido al reordenar y
    # su presencia solo desplazaria los datos sin aportar nada.
    cuerpo = [a for a in cuerpo if a[0] not in (b'free', b'skip')]

    destino = {}
    cursor = sum(f - i for _, i, f in cabecera)
    cursor += largo_moov
    for tipo, i, f in cuerpo:
        destino[i] = cursor
        cursor += f - i

    def mover(viejo):
        # A que bloque pertenece esta posicion, para aplicarle SU desplazamiento.
        for tipo, i, f in cuerpo:
            if i <= viejo < f:
                return destino[i] + (viejo - i)
        raise ValueError(f'posicion {viejo} fuera de todo bloque conocido')

    moov_ok, corregidas = _ajustar_tablas(moov, mover)
    if len(moov_ok) != largo_moov:
        raise ValueError('el indice cambio de tamano; se aborta por seguridad')

    trozos = [datos[i:f] for _, i, f in cabecera]
    trozos.append(moov_ok)
    trozos.extend(datos[i:f] for _, i, f in cuerpo)
    nuevo = b''.join(trozos)

    return nuevo, {
        'ya_estaba': False,
        'bloques': tipos,
        'posiciones_corregidas': corregidas,
        'tamano_antes': len(datos),
        'tamano_despues': len(nuevo),
        'indice_mb': round(largo_moov / 1024 / 1024, 3),
    }


def comprobar(datos):
    """Comprueba que el indice quedo delante de los datos."""
    atomos = _leer_atomos(datos)
    orden = [t.decode('latin1') for t, _, _ in atomos]
    im = orden.index('moov') if 'moov' in orden else -1
    id_ = orden.index('mdat') if 'mdat' in orden else -1
    return {'orden': orden, 'indice_delante': 0 <= im < id_}
