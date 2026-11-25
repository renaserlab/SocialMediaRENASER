"""Fabrica, para las pruebas, un MP4 SIN intercalar como los que sube Android.

El MediaMuxer de Android (lo que usa el compresor de la app) escribe primero
TODO el video y despues TODO el audio. ffmpeg no sabe producir eso a proposito
(siempre intercala), asi que aqui se toma un MP4 normal y se reordenan sus
trozos: cada pista entera, una detras de otra, corrigiendo las tablas de
posiciones (`stco`/`co64`). Los fotogramas no cambian; solo su sitio.

Solo para pruebas: no cubre todo el formato (fragmentados, pistas en otros
archivos...), cubre lo que ffmpeg genera en las pruebas.
"""

from __future__ import annotations

import struct

_CONTENEDORES = {b"moov", b"trak", b"mdia", b"minf", b"stbl"}


def _hijos(datos: bytes, inicio: int, fin: int):
    i = inicio
    while i + 8 <= fin:
        tam, tipo = struct.unpack(">I4s", datos[i : i + 8])
        cab = 8
        if tam == 1:
            tam = struct.unpack(">Q", datos[i + 8 : i + 16])[0]
            cab = 16
        elif tam == 0:
            tam = fin - i
        yield tipo, i, i + cab, i + tam
        i += tam


def _buscar(datos: bytes, inicio: int, fin: int, tipo: bytes):
    for t, ini, cuerpo, f in _hijos(datos, inicio, fin):
        if t == tipo:
            return ini, cuerpo, f
    return None


def _pistas(datos: bytes, moov: tuple[int, int, int]):
    """[(tipo_hdlr, [(pos_stco, ancho)], [(offset, tamano) por trozo])]."""
    _, cuerpo, fin = moov
    pistas = []
    for t, _, c_trak, f_trak in _hijos(datos, cuerpo, fin):
        if t != b"trak":
            continue
        mdia = _buscar(datos, c_trak, f_trak, b"mdia")
        hdlr = _buscar(datos, mdia[1], mdia[2], b"hdlr")
        tipo = datos[hdlr[1] + 8 : hdlr[1] + 12]
        minf = _buscar(datos, mdia[1], mdia[2], b"minf")
        stbl = _buscar(datos, minf[1], minf[2], b"stbl")
        stsc = _buscar(datos, stbl[1], stbl[2], b"stsc")
        stsz = _buscar(datos, stbl[1], stbl[2], b"stsz")
        stco = _buscar(datos, stbl[1], stbl[2], b"stco")
        ancho = 4
        if stco is None:
            stco = _buscar(datos, stbl[1], stbl[2], b"co64")
            ancho = 8
        # stsc: (primer_trozo, muestras_por_trozo, desc)
        n = struct.unpack(">I", datos[stsc[1] + 4 : stsc[1] + 8])[0]
        reglas = [
            struct.unpack(">III", datos[stsc[1] + 8 + 12 * k : stsc[1] + 20 + 12 * k])
            for k in range(n)
        ]
        tam_fijo, cuantas = struct.unpack(">II", datos[stsz[1] + 4 : stsz[1] + 12])
        tamanos = (
            [tam_fijo] * cuantas
            if tam_fijo
            else list(struct.unpack(f">{cuantas}I", datos[stsz[1] + 12 : stsz[1] + 12 + 4 * cuantas]))
        )
        n_trozos = struct.unpack(">I", datos[stco[1] + 4 : stco[1] + 8])[0]
        fmt = ">I" if ancho == 4 else ">Q"
        posiciones = [stco[1] + 8 + ancho * k for k in range(n_trozos)]
        offsets = [struct.unpack(fmt, datos[p : p + ancho])[0] for p in posiciones]
        trozos = []
        muestra = 0
        for k in range(n_trozos):
            numero = k + 1
            por_trozo = next(r[1] for r in reversed(reglas) if r[0] <= numero)
            tam = sum(tamanos[muestra : muestra + por_trozo])
            muestra += por_trozo
            trozos.append((offsets[k], tam))
        pistas.append((tipo, [(p, ancho) for p in posiciones], trozos))
    return pistas


def desintercalar(datos: bytes, moov_delante: bool = False) -> bytes:
    """Devuelve el mismo MP4 con el video entero primero y el audio al final."""
    arriba = list(_hijos(datos, 0, len(datos)))
    ftyp = next(a for a in arriba if a[0] == b"ftyp")
    moov = next(a for a in arriba if a[0] == b"moov")
    moov_ini, moov_fin = moov[1], moov[3]
    pistas = _pistas(datos, (moov_ini, moov[2], moov_fin))
    # El video primero, como Android.
    pistas.sort(key=lambda p: 0 if p[0] == b"vide" else 1)

    cabecera = datos[ftyp[1] : ftyp[3]]
    largo_moov = moov_fin - moov_ini
    total_trozos = sum(t for p in pistas for _, t in p[2])
    cab_mdat = 16  # tamano de 64 bits: no hay que pensar si cabe en 32
    base = len(cabecera) + (largo_moov if moov_delante else 0) + cab_mdat

    moov_nuevo = bytearray(datos[moov_ini:moov_fin])
    cuerpo = bytearray()
    for _, posiciones, trozos in pistas:
        for (pos, ancho), (offset, tam) in zip(posiciones, trozos):
            nuevo = base + len(cuerpo)
            cuerpo += datos[offset : offset + tam]
            fmt = ">I" if ancho == 4 else ">Q"
            rel = pos - moov_ini
            moov_nuevo[rel : rel + ancho] = struct.pack(fmt, nuevo)
    assert len(cuerpo) == total_trozos
    mdat = struct.pack(">I4sQ", 1, b"mdat", cab_mdat + len(cuerpo)) + bytes(cuerpo)
    if moov_delante:
        return bytes(cabecera) + bytes(moov_nuevo) + mdat
    return bytes(cabecera) + mdat + bytes(moov_nuevo)
