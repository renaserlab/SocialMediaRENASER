# -*- coding: utf-8 -*-
"""
Coloca el indice al principio en los videos ya subidos que arrancan lento.

POR QUE
-------
Un MP4 guarda los fotogramas por un lado y, por otro, el indice que dice donde
empieza cada uno. Si ese indice esta al final, el reproductor no puede empezar
hasta ir a buscarlo: hace un viaje extra a la ultima parte del archivo antes de
mostrar nada. Con buena cobertura son decimas; con mala, segundos de pantalla
en negro.

Los videos que suben desde la aplicacion instalada ya salen bien: el compresor
coloca el indice delante. Los que se colaron sin comprimir —desde el navegador
o desde Expo Go— no, y son los que hay que arreglar aqui.

NO se recodifica nada: se mueven bloques y se corrigen las tablas de
posiciones. Los fotogramas quedan byte a byte iguales y el archivo pesa lo
mismo. La calidad no cambia; lo unico que cambia es cuanto tarda en empezar.

COMO SE USA
-----------
Hace falta la clave de servicio del proyecto, porque hay que reemplazar
archivos que son de otras personas. Se lee del entorno y NO se escribe en
ningun sitio:

    export SUPABASE_URL=https://<proyecto>.supabase.co
    export SUPABASE_SERVICE_ROLE_KEY=<clave de servicio>
    python scripts/arreglar_arranque_videos.py --revisar     # solo mira
    python scripts/arreglar_arranque_videos.py --aplicar     # ya modifica

PRECAUCIONES
------------
- `--revisar` no toca nada: dice cuales estan mal y termina.
- Antes de reemplazar, cada original se guarda FUERA del repositorio (carpeta
  temporal del sistema, o `RESPALDO_VIDEOS_DIR` si se indica otra).
- El archivo se reemplaza en su MISMA ruta, para que las publicaciones que ya
  lo enlazan sigan funcionando.
- Se comprueba el resultado ANTES de subirlo: si el indice no quedo delante, si
  el tamano cambio o si los fotogramas no coinciden, ese video se salta.
"""

import argparse
import hashlib
import json
import os
import pathlib
import struct
import sys
import tempfile
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import faststart  # noqa: 

BUCKET = 'post-media'

# Las copias NO van dentro del repositorio: son cientos de megas de contenido y
# no forman parte del proyecto. Se dejan en la carpeta temporal del sistema, o
# donde diga RESPALDO_VIDEOS_DIR si se prefiere otro sitio.
RESPALDO = pathlib.Path(
    os.environ.get('RESPALDO_VIDEOS_DIR') or (pathlib.Path(tempfile.gettempdir()) / 'z-respaldo-videos')
)


def _peticion(url, metodo='GET', cuerpo=None, cabeceras=None, tiempo=900):
    req = urllib.request.Request(url, data=cuerpo, method=metodo)
    for k, v in (cabeceras or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=tiempo) as r:
        return r.read()


def _auth(clave):
    return {'apikey': clave, 'Authorization': f'Bearer {clave}'}


def listar_videos(url, clave):
    """Todos los videos del bucket, recorriendo la carpeta de cada persona."""
    carpetas = json.loads(_peticion(
        f'{url}/storage/v1/object/list/{BUCKET}', 'POST',
        json.dumps({'prefix': '', 'limit': 1000}).encode(),
        {**_auth(clave), 'Content-Type': 'application/json'}, 120))
    videos = []
    for c in carpetas:
        objetos = json.loads(_peticion(
            f'{url}/storage/v1/object/list/{BUCKET}', 'POST',
            json.dumps({'prefix': c['name'], 'limit': 1000}).encode(),
            {**_auth(clave), 'Content-Type': 'application/json'}, 120))
        for o in objetos:
            meta = o.get('metadata') or {}
            if 'video' in (meta.get('mimetype') or ''):
                videos.append({
                    'ruta': f"{c['name']}/{o['name']}",
                    'tam': meta.get('size', 0),
                    'tipo': meta['mimetype'],
                })
    return videos


def indice_al_final(cabecera):
    """True si en los primeros bytes aparecen los datos antes que el indice."""
    i = 0
    while i + 8 <= len(cabecera):
        tam = struct.unpack('>I', cabecera[i:i + 4])[0]
        nombre = cabecera[i + 4:i + 8]
        salto = 8
        if tam == 1:
            if i + 16 > len(cabecera):
                break
            tam = struct.unpack('>Q', cabecera[i + 8:i + 16])[0]
            salto = 16
        if tam < salto:
            break
        if nombre == b'moov':
            return False
        if nombre == b'mdat':
            return True
        i += tam
    return False


def _fotogramas(datos):
    """Los bytes de video en bruto, para comprobar que no se han tocado."""
    i = 0
    while i + 8 <= len(datos):
        tam = struct.unpack('>I', datos[i:i + 4])[0]
        nombre = datos[i + 4:i + 8]
        cab = 8
        if tam == 1:
            tam = struct.unpack('>Q', datos[i + 8:i + 16])[0]
            cab = 16
        if nombre == b'mdat':
            return datos[i + cab:i + tam]
        if tam < cab:
            break
        i += tam
    return b''


def main():
    ap = argparse.ArgumentParser(
        description='Coloca el indice al principio en los videos que arrancan lento.')
    # Revisar es lo que hace por defecto. Se admite igualmente como opcion
    # explicita: al ir a corregir algo que es de otras personas, poder escribir
    # «revisar» y ver que pasaria antes de tocar nada da mas tranquilidad que
    # confiar en recordar cual era el comportamiento por defecto.
    ap.add_argument('--revisar', action='store_true',
                    help='solo informa de cuales arrancan lento (es lo que hace por defecto)')
    ap.add_argument('--aplicar', action='store_true',
                    help='reemplaza los videos; guarda antes una copia de cada original')
    args = ap.parse_args()
    if args.revisar and args.aplicar:
        sys.exit('Elige una: --revisar mira, --aplicar modifica.')

    url = (os.environ.get('SUPABASE_URL') or '').rstrip('/')
    clave = os.environ.get('SUPABASE_SERVICE_ROLE_KEY') or ''
    if not url or not clave:
        sys.exit('Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el entorno.')

    videos = listar_videos(url, clave)
    print(f'{len(videos)} videos en el almacen.\n')

    pendientes = []
    for v in videos:
        cab = _peticion(f"{url}/storage/v1/object/{BUCKET}/{v['ruta']}", 'GET', None,
                        {**_auth(clave), 'Range': 'bytes=0-262143'}, 120)
        lento = indice_al_final(cab)
        print(f"  {v['tam']/1024/1024:7.1f} MB  {'ARRANCA LENTO' if lento else 'ya esta bien '}  {v['ruta']}")
        if lento:
            pendientes.append(v)

    print(f'\n{len(pendientes)} de {len(videos)} arrancan lento.')
    if not pendientes:
        return
    if not args.aplicar:
        print('Revision solamente. Vuelve a lanzarlo con --aplicar para corregirlos.')
        return

    RESPALDO.mkdir(parents=True, exist_ok=True)
    arreglados = 0
    for v in pendientes:
        ruta = v['ruta']
        print(f"\n{ruta}")
        original = _peticion(f'{url}/storage/v1/object/{BUCKET}/{ruta}', 'GET', None, _auth(clave))
        if len(original) != v['tam']:
            print('  se salta: la descarga no coincide con el tamano esperado')
            continue

        copia = RESPALDO / ruta.replace('/', '_')
        copia.write_bytes(original)
        print(f'  copia guardada en {copia}')

        try:
            nuevo, info = faststart.reordenar(original)
        except Exception as e:  # noqa: BLE001
            print(f'  se salta: no se pudo reordenar ({e})')
            continue
        if info.get('ya_estaba'):
            print('  se salta: el indice ya estaba delante')
            continue

        # Tres comprobaciones antes de reemplazar nada.
        if not faststart.comprobar(nuevo)['indice_delante']:
            print('  se salta: el indice no quedo delante')
            continue
        if len(nuevo) != len(original):
            print('  se salta: el tamano cambio')
            continue
        if hashlib.sha256(_fotogramas(nuevo)).digest() != hashlib.sha256(_fotogramas(original)).digest():
            print('  se salta: los fotogramas no coinciden')
            continue

        _peticion(f'{url}/storage/v1/object/{BUCKET}/{ruta}', 'PUT', nuevo,
                  {**_auth(clave), 'Content-Type': v['tipo'], 'x-upsert': 'true'})
        print(f"  reemplazado ({info['posiciones_corregidas']} posiciones corregidas)")
        arreglados += 1

    print(f'\nListo: {arreglados} corregidos. Los originales quedan en {RESPALDO}/')


if __name__ == '__main__':
    main()
