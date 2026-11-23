"""Regenera la portada (poster) de los videos YA publicados sin fotograma negro.

POR QUE HACE FALTA. Desde el PR #56 el poster de los videos NUEVOS es el
primer fotograma no negro de los 3 primeros segundos (`comandos_de_poster` en
`app/modules/content/media_processing.py`). Los videos de antes conservan el
suyo, sacado fijo en 0.1 s (o por el telefono), y en los que arrancan con un
fundido es un rectangulo negro en el muro. Este guion les aplica la regla
nueva, llamando a las MISMAS funciones de la API (`_extraer_poster`,
`comandos_de_poster`, `POSTER_MAX_NEGRO`), no a una copia.

REGLAS DEL PIPELINE QUE RESPETA
- El original nunca se toca: ffmpeg solo lo LEE por una URL temporal.
- La portada nueva va a una RUTA NUEVA. La app cachea la portada por su ruta
  (`cacheKey = poster_path`): reescribir el mismo archivo no se veria en los
  telefonos que ya la tienen en disco. En S3 ademas CloudFront sirve cada
  objeto como inmutable durante un año.
    Supabase: `<dueño>/derived/<media_id>/poster-v<n>.jpg` (n >= 2)
    S3:       `videos/<uid>/<media_id>/poster-v<n+1>.jpg` (`rutas_de_derivados`)
- La base solo cambia `post_media.poster_path`, y con un «compara y cambia»:
  si la fila cambio mientras tanto (se reproceso, se edito, se borro) no se
  pisa nada y queda anotado como conflicto.
- La portada vieja no se borra. En S3 la limpieza diaria borra los
  `poster-v<n>` que la fila ya no nombra (a los 7 dias de ESCRITOS, o sea, a la
  primera pasada), asi que antes de cambiar la fila se copia a
  `videos/<uid>/<media_id>/respaldo-portada/`, que la limpieza no toca.
- Cada cambio se anota en un registro JSONL (ruta vieja, ruta nueva) que es lo
  que usa `--revertir`.

QUE SE EXCLUYE: publicaciones borradas, datos E2E (ids que empiezan por
`e2e`, autores o textos que terminan en « Prueba») y medios que se estan
procesando ahora mismo (`process_media` reescribiria la ruta vieja al acabar).

MODOS
  (por defecto) --simulacro  Solo LEE: lista que haria, baja las portadas
                             viejas (unos KB) para ver cuales son negras y
                             prueba la extraccion en `--muestra` videos, en
                             local, para estimar tiempo y trafico.
  --aplicar                  Sube las portadas nuevas y cambia las filas.
  --revertir                 Devuelve cada fila del registro a su ruta vieja
                             (en simulacro salvo que vaya con --aplicar).

Reanudable e idempotente: lo que el registro ya da por aplicado se salta, asi
que cortarlo y relanzarlo continua donde iba.

CREDENCIALES. Las mismas que usa la API: DATABASE_URL, SUPABASE_URL,
SUPABASE_SERVICE_ROLE_KEY por entorno, o `--secreto-aws <nombre>` para
leerlas del secreto de la API en Secrets Manager con el perfil de AWS
(`--perfil-aws`). Nunca se imprimen. Para los videos en S3 hacen falta ademas
el bucket (`--bucket-s3` o MEDIOS_S3_BUCKET) y un perfil con permiso sobre el.

  .venv/bin/python scripts/regenerar_portadas.py \\
      --secreto-aws zexcelencia/produccion/api --perfil-aws prod \\
      --bucket-s3 zexcelencia-medios-produccion-302277511407
  ... --aplicar --limite 1        # primero uno
  ... --aplicar --solo-negras     # luego las negras
  ... --revertir --aplicar        # vuelta atras con el registro
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shutil
import statistics
import sys
import tempfile
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

# El script vive en `scripts/` pero importa `app`, que cuelga de `apps/api`.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

#: Donde queda el registro si no se dice otra cosa. Fuera del repo y fuera de
#: temporales: es lo que permite revertir, tiene que sobrevivir.
REGISTRO_POR_DEFECTO = Path.home() / ".local/share/zeta/regenerar_portadas/registro.jsonl"

#: Estados de `processing_status` en los que `process_media` esta trabajando
#: la fila: al terminar escribe el `poster_path` que leyo al empezar.
ESTADOS_EN_CURSO = frozenset({"pending", "processing"})

#: Carpeta (dentro de la del medio en S3) donde se guarda la portada vieja.
#: No empieza por `poster-v`: la limpieza diaria solo borra esos.
CARPETA_RESPALDO_S3 = "respaldo-portada"

_TERMINA_EN_PRUEBA = re.compile(r"\sprueba\s*$", re.IGNORECASE)
_PBLACK = re.compile(r"lavfi\.blackframe\.pblack=(\d+(?:\.\d+)?)")
_BYTES_LEIDOS = re.compile(r"Statistics: (\d+) bytes read")


def _mp():
    """El modulo de la API, importado tarde: `app.shared.database` crea el
    motor con DATABASE_URL al importarse, y el entorno se rellena antes."""
    from app.modules.content import media_processing

    return media_processing


# --------------------------------------------------------------------------- #
# Logica pura (probada en tests/test_regenerar_portadas.py)
# --------------------------------------------------------------------------- #
@dataclass
class Video:
    media_id: str
    post_id: str
    author_id: str
    storage_path: str
    poster_path: str | None
    almacen: str
    processing_status: str
    estado_post: str
    texto: str = ""
    autor: str = ""
    bytes: int | None = None
    duration_s: float | None = None


def motivo_de_exclusion(v: Video) -> str | None:
    """Por que este video NO se toca, o None si es candidato."""
    if v.estado_post == "deleted":
        return "borrado"
    if any((x or "").lower().startswith("e2e") for x in (v.media_id, v.post_id, v.author_id)):
        return "e2e"
    if _TERMINA_EN_PRUEBA.search(v.autor or "") or _TERMINA_EN_PRUEBA.search(v.texto or ""):
        return "prueba"
    if v.processing_status in ESTADOS_EN_CURSO:
        return "procesando"
    if not v.storage_path:
        return "sin_original"
    return None


def ruta_nueva(v: Video) -> str:
    """Donde va la portada regenerada. Siempre distinta de la actual."""
    mp = _mp()
    actual = v.poster_path
    if v.almacen == "s3":
        # La misma funcion que usa el procesado: v<n+1> sobre la que nombra
        # la fila, que es lo que CloudFront no tiene en cache.
        class _Fila:
            id = v.media_id
            poster_path = actual
            feed_path = None
            stream_path = None

        ruta = mp.rutas_de_derivados(_Fila, "s3", v.author_id)[0]
    else:
        # En Supabase el procesado escribe `poster.jpg` sin version (o el
        # telefono `<uid>/poster-<azar>.jpg`). La primera regeneracion es la
        # v2 y cada una despues suma uno.
        dueno = v.storage_path.split("/", 1)[0]
        n = max(mp._version(actual), 1) + 1
        ruta = f"{dueno}/derived/{v.media_id}/poster-v{n}.jpg"
    if ruta == actual:  # no deberia pasar nunca; si pasa, no se pisa
        raise ValueError(f"la ruta nueva coincide con la actual: {ruta}")
    return ruta


def ruta_respaldo_s3(v: Video) -> str | None:
    """Copia de la portada vieja en S3 que la limpieza diaria no borra."""
    if v.almacen != "s3" or not v.poster_path:
        return None
    carpeta = f"videos/{v.author_id}/{v.media_id}"
    if not v.poster_path.startswith(f"{carpeta}/"):
        return None
    return f"{carpeta}/{CARPETA_RESPALDO_S3}/{v.poster_path.rsplit('/', 1)[-1]}"


def comando_pblack(ffmpeg: str, imagen: str) -> list[str]:
    """Mide que porcentaje de la imagen es negro con el MISMO filtro y umbral
    de pixel que elige el poster de la API."""
    mp = _mp()
    return [
        ffmpeg, "-v", "info", "-i", imagen,
        "-vf",
        f"blackframe=amount=0:threshold={mp.POSTER_UMBRAL_PIXEL},metadata=mode=print",
        "-frames:v", "1", "-f", "null", "-",
    ]


def pblack_de_salida(salida: str) -> float | None:
    coincidencias = _PBLACK.findall(salida)
    return float(coincidencias[-1]) if coincidencias else None


def es_negra(pblack: float | None) -> bool:
    """Negra = la que la API descartaria como poster (pblack >= 90)."""
    return pblack is not None and pblack >= _mp().POSTER_MAX_NEGRO


def bytes_leidos(salida: str) -> int:
    return sum(int(n) for n in _BYTES_LEIDOS.findall(salida))


def clasificar_vieja(v: Video, pblack: float | None, leida: bool) -> str:
    if not v.poster_path:
        return "sin_portada"
    if not leida:
        return "ilegible"
    return "negra" if es_negra(pblack) else "ok"


def merece_regenerar(clase_vieja: str, solo_negras: bool) -> bool:
    """`--solo-negras` toma las negras y las que en la app se ven igual de
    negras: sin portada o con una que no se puede leer."""
    if not solo_negras:
        return True
    return clase_vieja in ("negra", "sin_portada", "ilegible")


def adoptar_nueva(clase_vieja: str, pblack_nueva: float | None) -> bool:
    """Si la nueva tambien es negra (video negro de verdad) y habia una
    portada legible, cambiarla solo vaciaria las caches de los telefonos."""
    if clase_vieja in ("sin_portada", "ilegible"):
        return True
    return not es_negra(pblack_nueva)


def leer_registro(ruta: Path) -> list[dict]:
    if not ruta.exists():
        return []
    lineas = []
    for linea in ruta.read_text(encoding="utf-8").splitlines():
        linea = linea.strip()
        if linea:
            try:
                lineas.append(json.loads(linea))
            except json.JSONDecodeError:
                continue  # una linea cortada por un corte de luz no invalida el resto
    return lineas


def ultimo_por_medio(lineas: list[dict]) -> dict[str, dict]:
    ultimo: dict[str, dict] = {}
    for linea in lineas:
        ultimo[linea["media_id"]] = linea
    return ultimo


def ya_aplicados(lineas: list[dict]) -> set[str]:
    return {m for m, l in ultimo_por_medio(lineas).items() if l.get("estado") == "aplicado"}


def para_revertir(lineas: list[dict]) -> list[dict]:
    return [l for l in ultimo_por_medio(lineas).values() if l.get("estado") == "aplicado"]


def estimar(
    n: int, muestras: list[dict], concurrencia: int, bytes_portadas_viejas: int
) -> dict:
    """Tiempo y trafico de `--aplicar` a partir de las extracciones de prueba."""
    if not muestras or n == 0:
        return {"videos": n, "segundos": None, "bytes": None}
    seg = statistics.mean(m["segundos"] for m in muestras)
    leidos = statistics.mean(m["bytes_leidos"] for m in muestras)
    subida = statistics.mean(m["bytes_poster"] for m in muestras)
    # + ~1 s por video de firma, subida y escritura en la base.
    return {
        "videos": n,
        "segundos": round(n * (seg + 1.0) / max(concurrencia, 1)),
        "bytes": round(n * (leidos + subida) + bytes_portadas_viejas),
        "media_segundos_por_video": round(seg, 2),
        "media_bytes_leidos_por_video": round(leidos),
    }


# --------------------------------------------------------------------------- #
# Entorno
# --------------------------------------------------------------------------- #
CLAVES_DEL_SECRETO = ("DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")


def cargar_entorno(args) -> None:
    """Rellena lo que falte del entorno SIN imprimir ningun valor."""
    if args.perfil_aws:
        os.environ["AWS_PROFILE"] = args.perfil_aws
    if args.bucket_s3:
        os.environ["MEDIOS_S3_BUCKET"] = args.bucket_s3
    os.environ.setdefault("MEDIOS_S3_REGION", "us-east-1")
    if args.secreto_aws:
        import boto3

        sesion = boto3.Session(profile_name=args.perfil_aws or None)
        valor = sesion.client("secretsmanager", region_name="us-east-1").get_secret_value(
            SecretId=args.secreto_aws
        )["SecretString"]
        datos = json.loads(valor)
        for clave in CLAVES_DEL_SECRETO:
            if clave in datos and not os.environ.get(clave):
                os.environ[clave] = datos[clave]
        del datos, valor
    faltan = [c for c in CLAVES_DEL_SECRETO if not os.environ.get(c)]
    if faltan:
        raise SystemExit(f"Faltan credenciales: {', '.join(faltan)} (ver --secreto-aws).")
    if os.environ["DATABASE_URL"].startswith("postgresql://"):
        # La API usa asyncpg; el secreto puede traer la URL generica.
        os.environ["DATABASE_URL"] = "postgresql+asyncpg://" + os.environ["DATABASE_URL"][13:]


# --------------------------------------------------------------------------- #
# Base de datos
# --------------------------------------------------------------------------- #
_CONSULTA = """
select pm.id::text as media_id, pm.post_id::text as post_id, p.author_id::text as author_id,
       pm.storage_path, pm.poster_path, coalesce(pm.almacen, 'supabase') as almacen,
       pm.processing_status, p.status::text as estado_post, coalesce(p.body, '') as texto,
       coalesce(pr.full_name, '') as autor, pm.bytes, pm.duration_s
from public.post_media pm
join public.posts p on p.id = pm.post_id
left join public.profiles pr on pr.id = p.author_id
where pm.media_type = 'video' {filtro}
order by pm.created_at desc
"""


async def leer_videos(media_id: str | None) -> list[Video]:
    from sqlalchemy import text

    from app.shared.database import SessionLocal

    filtro = "and pm.id = cast(:mid as uuid)" if media_id else ""
    async with SessionLocal() as db:
        filas = (
            await db.execute(
                text(_CONSULTA.format(filtro=filtro)), {"mid": media_id} if media_id else {}
            )
        ).mappings().all()
    return [Video(**dict(f)) for f in filas]


async def cambiar_ruta(media_id: str, vieja: str | None, nueva: str | None) -> bool:
    """Compara y cambia: solo si la fila sigue con `vieja` y nadie la procesa."""
    from sqlalchemy import text

    from app.shared.database import SessionLocal

    async with SessionLocal() as db:
        fila = (
            await db.execute(
                text(
                    "update public.post_media set poster_path = cast(:nueva as text) "
                    "where id = cast(:mid as uuid) "
                    "and poster_path is not distinct from cast(:vieja as text) "
                    "and processing_status not in ('pending', 'processing') "
                    "returning id"
                ),
                {"mid": media_id, "vieja": vieja, "nueva": nueva},
            )
        ).first()
        await db.commit()
    return fila is not None


# --------------------------------------------------------------------------- #
# Almacen
# --------------------------------------------------------------------------- #
class Almacenes:
    def __init__(self, client) -> None:
        self.client = client

    def _alm(self, v: Video):
        from app.modules.medios.almacen import almacen_para

        return almacen_para(v.almacen, self.client)

    async def url_video(self, v: Video) -> str:
        return await self._alm(v).url_de_lectura_temporal(v.storage_path, 900)

    async def bajar(self, v: Video, ruta: str) -> bytes:
        return await self._alm(v).descargar(ruta)

    async def subir_poster(self, v: Video, ruta: str, datos: bytes) -> None:
        from app.modules.medios.almacen import CACHE_INMUTABLE

        await self._alm(v).subir(ruta, datos, "image/jpeg", cache_control=CACHE_INMUTABLE)

    async def copiar_s3(self, origen: str, destino: str) -> None:
        from app.modules.medios import almacen

        def _copiar() -> None:
            almacen.cliente_s3().copy_object(
                Bucket=almacen.bucket(),
                Key=destino,
                CopySource={"Bucket": almacen.bucket(), "Key": origen},
                MetadataDirective="COPY",
            )

        await asyncio.to_thread(_copiar)

    async def existe_s3(self, clave: str) -> bool:
        from app.modules.medios import almacen

        def _mirar() -> bool:
            try:
                almacen.cliente_s3().head_object(Bucket=almacen.bucket(), Key=clave)
                return True
            except Exception as error:  # noqa: BLE001
                if almacen.es_no_existe(error):
                    return False
                raise

        return await asyncio.to_thread(_mirar)


# --------------------------------------------------------------------------- #
# ffmpeg
# --------------------------------------------------------------------------- #
async def medir_pblack(ffmpeg: str, datos: bytes) -> float | None:
    with tempfile.TemporaryDirectory() as tmp:
        imagen = Path(tmp) / "p.jpg"
        imagen.write_bytes(datos)
        _, _, stderr = await _mp()._run(comando_pblack(ffmpeg, str(imagen)), timeout=60)
    return pblack_de_salida(stderr.decode("utf-8", "replace"))


async def extraer_midiendo(ffmpeg: str, url: str, destino: Path) -> tuple[bool, int]:
    """`_extraer_poster` paso a paso con los mismos comandos y en el mismo
    orden, cambiando SOLO el nivel de log a `verbose` para leer cuantos bytes
    bajo ffmpeg. Se usa solo en el simulacro, para estimar el trafico."""
    mp = _mp()
    leidos = 0
    for cmd in mp.comandos_de_poster(ffmpeg, url, destino):
        cmd = list(cmd)
        cmd[cmd.index("-v") + 1] = "verbose"
        destino.unlink(missing_ok=True)
        codigo, _, stderr = await mp._run(cmd)
        leidos += bytes_leidos(stderr.decode("utf-8", "replace"))
        if codigo == 0 and destino.exists() and destino.stat().st_size > 0:
            return True, leidos
    destino.unlink(missing_ok=True)
    return False, leidos


# --------------------------------------------------------------------------- #
# Registro
# --------------------------------------------------------------------------- #
class Registro:
    def __init__(self, ruta: Path) -> None:
        self.ruta = ruta

    def anotar(self, **datos) -> None:
        self.ruta.parent.mkdir(parents=True, exist_ok=True)
        datos = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), **datos}
        with self.ruta.open("a", encoding="utf-8") as f:
            f.write(json.dumps(datos, ensure_ascii=False) + "\n")
            f.flush()
            os.fsync(f.fileno())


# --------------------------------------------------------------------------- #
# Trabajo por video
# --------------------------------------------------------------------------- #
@dataclass
class Resultado:
    media_id: str
    almacen: str
    ref_vieja: str | None
    clase_vieja: str = ""
    pblack_vieja: float | None = None
    bytes_vieja: int = 0
    accion: str = ""
    ref_nueva: str | None = None
    pblack_nueva: float | None = None
    detalle: str = ""
    extra: dict = field(default_factory=dict)


async def revisar_vieja(alms: Almacenes, ffmpeg: str, v: Video) -> Resultado:
    r = Resultado(v.media_id, v.almacen, v.poster_path)
    leida = False
    if v.poster_path:
        try:
            datos = await alms.bajar(v, v.poster_path)
            r.bytes_vieja = len(datos)
            leida = len(datos) > 0
            if leida:
                r.pblack_vieja = await medir_pblack(ffmpeg, datos)
        except Exception as error:  # noqa: BLE001
            r.detalle = f"portada vieja ilegible: {type(error).__name__}"
    r.clase_vieja = clasificar_vieja(v, r.pblack_vieja, leida)
    return r


async def aplicar_uno(
    alms: Almacenes, ffmpeg: str, v: Video, r: Resultado, registro: Registro
) -> None:
    mp = _mp()
    nueva = ruta_nueva(v)
    with tempfile.TemporaryDirectory() as tmp:
        destino = Path(tmp) / "poster.jpg"
        if not await mp._extraer_poster(ffmpeg, await alms.url_video(v), destino):
            r.accion, r.detalle = "error", "ffmpeg no saco ningun fotograma"
            return
        datos = destino.read_bytes()
    r.pblack_nueva = await medir_pblack(ffmpeg, datos)
    if not adoptar_nueva(r.clase_vieja, r.pblack_nueva):
        r.accion = "saltado_nueva_tambien_negra"
        return

    respaldo = ruta_respaldo_s3(v)
    if respaldo:
        # Antes de que la fila deje de nombrarla: despues la limpieza diaria
        # la borraria y no habria vuelta atras.
        if await alms.existe_s3(v.poster_path):
            await alms.copiar_s3(v.poster_path, respaldo)
        else:
            respaldo = None
    base = dict(
        media_id=v.media_id, post_id=v.post_id, almacen=v.almacen,
        ref_vieja=v.poster_path, ref_nueva=nueva, respaldo=respaldo,
        pblack_vieja=r.pblack_vieja, pblack_nueva=r.pblack_nueva, clase_vieja=r.clase_vieja,
    )
    await alms.subir_poster(v, nueva, datos)
    registro.anotar(estado="subida", **base)
    if await cambiar_ruta(v.media_id, v.poster_path, nueva):
        registro.anotar(estado="aplicado", **base)
        r.accion, r.ref_nueva = "aplicado", nueva
    else:
        # La fila cambio entre la lectura y ahora: no se pisa. El archivo
        # subido queda sin referencia (en S3 lo borra la limpieza diaria).
        registro.anotar(estado="conflicto", **base)
        r.accion, r.detalle = "conflicto", "la fila cambio; no se toco"


# --------------------------------------------------------------------------- #
# Modos
# --------------------------------------------------------------------------- #
def _mb(n: float | None) -> str:
    return "?" if n is None else f"{n / 1048576:.1f} MB"


def _hms(s: float | None) -> str:
    if s is None:
        return "?"
    s = int(s)
    return f"{s // 3600} h {s % 3600 // 60} min {s % 60} s" if s >= 3600 else f"{s // 60} min {s % 60} s"


async def ejecutar(args) -> int:
    import httpx

    mp = _mp()
    ffmpeg = mp._ffmpeg()
    if not ffmpeg:
        raise SystemExit("ffmpeg no esta en el PATH.")
    registro = Registro(Path(args.registro).expanduser())
    lineas = leer_registro(registro.ruta)
    hechos = ya_aplicados(lineas)

    t0 = time.monotonic()
    videos = await leer_videos(args.media_id)
    excluidos: dict[str, int] = {}
    candidatos: list[Video] = []
    for v in videos:
        motivo = motivo_de_exclusion(v)
        if motivo:
            excluidos[motivo] = excluidos.get(motivo, 0) + 1
        elif v.media_id in hechos and not args.forzar:
            excluidos["ya_aplicado"] = excluidos.get("ya_aplicado", 0) + 1
        else:
            candidatos.append(v)
    hay_s3 = any(v.almacen == "s3" for v in candidatos)
    if hay_s3 and not os.environ.get("MEDIOS_S3_BUCKET"):
        raise SystemExit("Hay videos en S3: falta --bucket-s3 (o MEDIOS_S3_BUCKET).")

    modo = "APLICAR" if args.aplicar else "SIMULACRO (no escribe nada)"
    print(f"Modo: {modo}")
    print(f"Registro: {registro.ruta} ({len(hechos)} ya aplicados)")
    print(f"Videos en la base: {len(videos)}")
    for motivo, n in sorted(excluidos.items()):
        print(f"  excluidos por {motivo}: {n}")
    print(f"Candidatos: {len(candidatos)}  "
          f"(supabase {sum(v.almacen != 's3' for v in candidatos)}, "
          f"s3 {sum(v.almacen == 's3' for v in candidatos)})")

    turno = asyncio.Semaphore(max(args.concurrencia, 1))
    resultados: list[Resultado] = []
    procesados = 0

    async with httpx.AsyncClient(timeout=mp._TIMEOUT) as client:
        alms = Almacenes(client)

        # 1. Portadas viejas (solo lectura, unos KB cada una).
        async def _revisar(v: Video) -> Resultado:
            async with turno:
                return await revisar_vieja(alms, ffmpeg, v)

        revisados = await asyncio.gather(*(_revisar(v) for v in candidatos))
        por_id = {v.media_id: v for v in candidatos}
        clases: dict[tuple[str, str], int] = {}
        for r in revisados:
            clases[(r.almacen, r.clase_vieja)] = clases.get((r.almacen, r.clase_vieja), 0) + 1
        print("\nPortadas viejas:")
        for (alm, clase), n in sorted(clases.items()):
            print(f"  {alm:8s} {clase:12s} {n}")
        elegidos = [r for r in revisados if merece_regenerar(r.clase_vieja, args.solo_negras)]
        if args.limite:
            elegidos = elegidos[: args.limite]
        bytes_viejas = sum(r.bytes_vieja for r in revisados)
        print(f"A regenerar{' (solo negras)' if args.solo_negras else ''}: {len(elegidos)}"
              f"   [lectura de portadas viejas: {_mb(bytes_viejas)}, "
              f"{time.monotonic() - t0:.0f} s]")

        if not args.aplicar:
            # 2. Extraccion de prueba EN LOCAL para estimar (no sube nada).
            muestras: list[dict] = []
            carpeta_muestras = Path(args.guardar_muestras).expanduser() if args.guardar_muestras else None
            orden = sorted(elegidos, key=lambda r: r.clase_vieja != "negra")  # negras primero
            for r in orden[: args.muestra]:
                v = por_id[r.media_id]
                with tempfile.TemporaryDirectory() as tmp:
                    destino = Path(tmp) / "poster.jpg"
                    inicio = time.monotonic()
                    try:
                        ok, leidos = await extraer_midiendo(ffmpeg, await alms.url_video(v), destino)
                    except Exception as error:  # noqa: BLE001
                        print(f"  muestra {v.media_id}: error {type(error).__name__}")
                        continue
                    segundos = time.monotonic() - inicio
                    if not ok:
                        print(f"  muestra {v.media_id}: sin fotograma")
                        continue
                    datos = destino.read_bytes()
                pblack = await medir_pblack(ffmpeg, datos)
                muestras.append({"segundos": segundos, "bytes_leidos": leidos, "bytes_poster": len(datos)})
                print(f"  muestra {v.media_id} [{v.almacen}] vieja={r.clase_vieja}"
                      f"({r.pblack_vieja}) nueva pblack={pblack} "
                      f"{segundos:.1f} s, {_mb(leidos)} leidos")
                if carpeta_muestras:
                    carpeta_muestras.mkdir(parents=True, exist_ok=True)
                    (carpeta_muestras / f"{v.media_id}-nueva.jpg").write_bytes(datos)
                    if v.poster_path:
                        try:
                            (carpeta_muestras / f"{v.media_id}-vieja.jpg").write_bytes(
                                await alms.bajar(v, v.poster_path))
                        except Exception:  # noqa: BLE001
                            pass
            est = estimar(len(elegidos), muestras, args.concurrencia, 0)
            print("\nEstimacion de --aplicar"
                  f"{' --solo-negras' if args.solo_negras else ''} "
                  f"(concurrencia {args.concurrencia}, con {len(muestras)} muestras):")
            print(f"  videos: {est['videos']}")
            print(f"  tiempo: ~{_hms(est['segundos'])}")
            print(f"  trafico: ~{_mb(est['bytes'])} (+{_mb(bytes_viejas)} de portadas viejas)")
            for r in elegidos:
                v = por_id[r.media_id]
                r.accion, r.ref_nueva = "regeneraria", ruta_nueva(v)
                resultados.append(r)
            if args.informe:
                _escribir_informe(Path(args.informe).expanduser(), resultados)
                print(f"Informe: {args.informe}")
            return 0

        # 3. Aplicar.
        async def _aplicar(r: Resultado) -> None:
            nonlocal procesados
            v = por_id[r.media_id]
            async with turno:
                try:
                    await aplicar_uno(alms, ffmpeg, v, r, registro)
                except Exception as error:  # noqa: BLE001 — uno roto no para el lote
                    r.accion, r.detalle = "error", f"{type(error).__name__}: {str(error)[:200]}"
                    registro.anotar(estado="error", media_id=v.media_id, almacen=v.almacen,
                                    ref_vieja=v.poster_path, detalle=r.detalle)
            procesados += 1
            print(f"  [{procesados}/{len(elegidos)}] {v.media_id} {r.accion} {r.detalle}".rstrip())
            resultados.append(r)

        await asyncio.gather(*(_aplicar(r) for r in elegidos))

    cuenta: dict[str, int] = {}
    for r in resultados:
        cuenta[r.accion] = cuenta.get(r.accion, 0) + 1
    print(f"\nHecho en {_hms(time.monotonic() - t0)}: {cuenta}")
    if args.informe:
        _escribir_informe(Path(args.informe).expanduser(), resultados)
    return 0 if not cuenta.get("error") else 1


async def revertir(args) -> int:
    import httpx

    mp = _mp()
    registro = Registro(Path(args.registro).expanduser())
    pendientes = para_revertir(leer_registro(registro.ruta))
    if args.media_id:
        pendientes = [l for l in pendientes if l["media_id"] == args.media_id]
    print(f"Revertir ({'APLICAR' if args.aplicar else 'SIMULACRO'}): {len(pendientes)} filas "
          f"del registro {registro.ruta}")
    if not args.aplicar:
        for l in pendientes:
            print(f"  {l['media_id']}: {l['ref_nueva']} -> {l['ref_vieja']}")
        return 0
    cuenta: dict[str, int] = {}
    async with httpx.AsyncClient(timeout=mp._TIMEOUT) as client:
        alms = Almacenes(client)
        for l in pendientes:
            estado = "revertido"
            try:
                # En S3 la vieja pudo borrarla la limpieza diaria: se repone
                # desde el respaldo con el mismo nombre y el mismo contenido.
                if l["almacen"] == "s3" and l.get("ref_vieja") and l.get("respaldo"):
                    if not await alms.existe_s3(l["ref_vieja"]):
                        await alms.copiar_s3(l["respaldo"], l["ref_vieja"])
                if not await cambiar_ruta(l["media_id"], l["ref_nueva"], l.get("ref_vieja")):
                    estado = "conflicto_al_revertir"
            except Exception as error:  # noqa: BLE001
                estado = f"error_al_revertir: {type(error).__name__}"
            registro.anotar(**{**{k: l.get(k) for k in (
                "media_id", "post_id", "almacen", "ref_vieja", "ref_nueva", "respaldo")},
                "estado": "revertido" if estado == "revertido" else estado})
            cuenta[estado] = cuenta.get(estado, 0) + 1
            print(f"  {l['media_id']}: {estado}")
    print(f"Hecho: {cuenta}")
    return 0


def _escribir_informe(ruta: Path, resultados: list[Resultado]) -> None:
    import csv

    ruta.parent.mkdir(parents=True, exist_ok=True)
    campos = ["media_id", "almacen", "ref_vieja", "clase_vieja", "pblack_vieja",
              "accion", "ref_nueva", "pblack_nueva", "detalle"]
    with ruta.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=campos, extrasaction="ignore")
        w.writeheader()
        for r in resultados:
            w.writerow(asdict(r))


def construir_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    modo = p.add_mutually_exclusive_group()
    modo.add_argument("--simulacro", action="store_true", help="(por defecto) solo lee")
    modo.add_argument("--aplicar", action="store_true", help="sube y cambia las filas")
    p.add_argument("--revertir", action="store_true", help="vuelve a la ruta vieja segun el registro")
    p.add_argument("--solo-negras", action="store_true",
                   help="solo portadas negras, ausentes o ilegibles")
    p.add_argument("--limite", type=int, default=0, help="como mucho N videos (0 = todos)")
    p.add_argument("--media-id", help="solo este medio")
    p.add_argument("--forzar", action="store_true", help="rehace tambien los ya aplicados")
    p.add_argument("--concurrencia", type=int, default=2)
    p.add_argument("--muestra", type=int, default=5,
                   help="simulacro: extracciones de prueba en local para estimar")
    p.add_argument("--guardar-muestras", help="simulacro: carpeta LOCAL para las portadas vieja/nueva")
    p.add_argument("--registro", default=str(REGISTRO_POR_DEFECTO))
    p.add_argument("--informe", help="CSV local con lo que se hizo (o haria) por video")
    p.add_argument("--secreto-aws", help="secreto de la API en Secrets Manager")
    p.add_argument("--perfil-aws", help="perfil de AWS (secreto y S3)")
    p.add_argument("--bucket-s3", help="bucket de medios (si no, MEDIOS_S3_BUCKET)")
    return p


def main(argv: list[str] | None = None) -> int:
    args = construir_parser().parse_args(argv)
    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg no esta en el PATH.")
    cargar_entorno(args)
    if args.revertir:
        return asyncio.run(revertir(args))
    return asyncio.run(ejecutar(args))


if __name__ == "__main__":
    sys.exit(main())
