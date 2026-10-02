"""La migración 0096: rutas opacas para las imágenes del catálogo (P29).

1. ESTÁTICA: es la última y sigue a la 0095; una sola transacción que
   comprueba lo anterior antes de cambiar nada; SOLO SUSTITUYE EL CUERPO DE UNA
   FUNCIÓN (ni tablas, ni columnas, ni disparadores, ni permisos, ni el
   depósito, ni ningún archivo); la forma de la ruta que admite es la que arma
   la API, y la huella de su cuerpo es la que exige la puerta del catálogo; y
   TODAVÍA NO CONSTA COMO APLICADA.
2. CONTRA POSTGRESQL: cerrada; la ruta nueva entra y no lleva el perfil; una
   ruta con la forma anterior YA NO SE REGISTRA, ni una de otro servicio, ni
   una que se parezca; una ruta anterior que ya existía se COPIA a otra versión
   del mismo servicio y a ningún otro sitio; y lo demás del disparador sigue
   igual.
3. LA APLICACIÓN: sobre la 0095 vacía y con imágenes anteriores no toca
   ninguna fila (y dice cuántas hay), se puede reejecutar, un fallo a mitad no
   deja nada, se niega a terminar incompleta, sin cada una de sus dependencias
   no empieza, y si alguien reejecuta la 0090 encima se vuelve a aplicar.
"""

from __future__ import annotations

import hashlib
import re
import uuid

import pytest

from app.modules.services import catalogo_imagenes, esquema
from tests.test_migraciones_reales import MIGRACIONES
from tests.test_servicios_migracion_0090 import (
    APLICADAS,
    SIN_POSTGRES,
    _categoria,
    _enviada,
    _falla,
    _foto,
    _hacer,
    _montar,
    _persona,
    _publicada,
    _servicio,
    _todas,
    _uno,
    pg,  # noqa: F401 - el montaje de la base, compartido
)

ARCHIVO = MIGRACIONES / "0096_servicios_rutas_opacas.sql"
TEXTO = ARCHIVO.read_text(encoding="utf-8").replace("\r\n", "\n")
SQL = re.sub(r"--[^\n]*", "", TEXTO)

FUNCION = "service_version_images_solo_en_borrador"
DISPARADOR = "service_version_images_solo_en_borrador"
CUERPO_DE_LA_0090 = "b8aa892aaaf500ceaf19e4ae52a457af"
CUERPO_DE_LA_0096 = esquema.CUERPO_DE_LAS_IMAGENES

_HUELLA = (
    "select md5(replace(p.prosrc, E'\\r', '')) from pg_catalog.pg_proc p "
    f"where p.oid = to_regprocedure('public.{FUNCION}()')"
)
_INSERTAR = (
    "insert into public.service_version_images (version_id, service_id, storage_path, alt_text, content_type, "
    "byte_size, width, height, checksum_sha256) values (%s, %s, %s, 'Una foto', 'image/png', 10, 4, 4, "
    "repeat('a', 64)) returning id"
)


def _cuerpo(sql: str) -> str:
    """El texto entre los `$$` de la función, como lo guarda PostgreSQL."""
    inicio = sql.index(f"create or replace function public.{FUNCION}()")
    abre = sql.index("as $$", inicio) + len("as $$")
    return sql[abre:sql.index("$$;", abre)]


def _opaca(servicio: str, extension: str = "png") -> str:
    return f"{servicio}/{uuid.uuid4().hex}.{extension}"


def _anterior(perfil: str, servicio: str, version: str) -> str:
    return f"{perfil}/{servicio}/{version}/{uuid.uuid4()}.png"


# =========================================================================== #
# 1. Estática
# =========================================================================== #
def test_es_la_ultima_y_sigue_a_la_0095() -> None:
    nombres = sorted(p.name for p in MIGRACIONES.glob("*.sql"))
    assert nombres[-1] == ARCHIVO.name
    assert nombres[-2].startswith("0095_")


def test_consta_como_aplicada_y_ya_no_se_edita() -> None:
    """Ejecutada a mano en Supabase y verificada el 02/10/2026 (19:51 UTC),
    sin divergencias: su huella consta en `APLICADAS` y el fichero es ese,
    byte a byte. Su cabecera sigue diciendo «SIN APLICAR», como las
    anteriores: cambiarla sería editar lo aplicado."""
    assert APLICADAS[ARCHIVO.name] == "f1abca52f0a48c0d92e346666fff7dfb763661c7"
    contenido = ARCHIVO.read_bytes().replace(b"\r\n", b"\n")
    assert hashlib.sha1(f"blob {len(contenido)}\0".encode() + contenido).hexdigest() == APLICADAS[ARCHIVO.name]
    assert "-- SIN APLICAR." in TEXTO


def test_es_una_unica_transaccion_que_comprueba_antes_de_cambiar() -> None:
    sentencias = [s.strip() for s in SQL.split(";") if s.strip()]
    assert sentencias[0] == "begin" and sentencias[-1] == "commit"
    assert SQL.count("\nbegin;") == 1 and SQL.count("\ncommit;") == 1
    assert SQL.index("raise exception 'La 0096 requiere") < SQL.index("create or replace function")
    # Y verifica lo que dejó DESPUÉS de cambiarlo, antes de confirmar.
    assert SQL.index("create or replace function") < SQL.index("raise exception 'La 0096 no dejó") < SQL.index("\ncommit;")


def test_solo_sustituye_el_cuerpo_de_una_funcion() -> None:
    minusculas = SQL.lower()
    for prohibido in (
        r"\bgrant\b", r"drop\s+table", r"drop\s+column", r"delete\s+from", r"\bupdate\s+(public|storage)\.",
        r"\btruncate\s+(table\s+)?\w", r"create\s+table", r"alter\s+table", r"create\s+policy", r"drop\s+policy",
        r"security\s+definer", r"disable\s+trigger", r"disable\s+row\s+level\s+security", r"session_replication_role",
        r"drop\s+function", r"insert\s+into", r"create\s+trigger", r"drop\s+trigger", r"create\s+(unique\s+)?index",
        r"drop\s+index", r"add\s+column", r"storage\.objects",
    ):
        assert not re.search(prohibido, minusculas), prohibido
    assert re.findall(r"create or replace function public\.(\w+)\(", minusculas) == [FUNCION]
    # La misma función: `security invoker` y el `search_path` fijo.
    definicion = SQL[SQL.index("create or replace function"):SQL.index("as $$")]
    assert "returns trigger" in definicion and "security invoker" in definicion
    assert "set search_path = public, pg_temp" in definicion
    # Lo único que revoca es la ejecución de esa función; no concede nada.
    assert re.findall(r"revoke all on (.+?) from", minusculas) == [f"function public.{FUNCION}()"]


def test_no_trae_dinero_ni_pasarela() -> None:
    minusculas = SQL.lower()
    for palabra in ("stripe", "payment", "refund", "transfer", "balance", "commission", "payout", "amount", "price",
                    "currency", "fee"):
        assert palabra not in minusculas, palabra


def test_la_ruta_que_admite_es_la_que_arma_la_api() -> None:
    """La base y la API tienen que estar de acuerdo en qué es una ruta nueva:
    si no, subir una imagen chocaría con el disparador."""
    patron = re.search(r"new\.storage_path ~ \('\^' \|\| new\.service_id::text \|\| '(.+?)'\)", SQL).group(1)
    assert patron == "/[0-9a-f]{32}[.](jpg|png|webp)$"
    servicio = str(uuid.uuid4())
    de_la_base = re.compile("^" + re.escape(servicio) + patron)
    for tipo, extension in catalogo_imagenes._EXTENSION.items():
        ruta = catalogo_imagenes.ruta_nueva(servicio, tipo)
        assert de_la_base.match(ruta) and catalogo_imagenes.RUTA_OPACA.match(ruta), ruta
        assert ruta.endswith(f".{extension}")
    assert set(re.search(r"\((\w+(?:\|\w+)+)\)", patron).group(1).split("|")) == set(
        catalogo_imagenes._EXTENSION.values())
    # 128 bits al azar: dos rutas del mismo servicio nunca coinciden.
    assert len({catalogo_imagenes.ruta_nueva(servicio, "image/png") for _ in range(2000)}) == 2000


def test_las_huellas_que_nombra_son_las_de_los_dos_cuerpos() -> None:
    """La que exige al empezar es la del cuerpo de la 0090; la que exige al
    terminar es la de SU cuerpo, que es la misma que mira la puerta."""
    de_la_0090 = next(MIGRACIONES.glob("0090_*.sql")).read_text(encoding="utf-8").replace("\r\n", "\n")
    assert hashlib.md5(_cuerpo(de_la_0090).encode()).hexdigest() == CUERPO_DE_LA_0090
    assert hashlib.md5(_cuerpo(TEXTO).encode()).hexdigest() == CUERPO_DE_LA_0096
    assert sorted(set(re.findall(r"'([0-9a-f]{32})'", SQL))) == sorted({CUERPO_DE_LA_0090, CUERPO_DE_LA_0096})
    # Al empezar admite las dos (la segunda, por si es una reejecución); al
    # terminar, solo la suya.
    antes, despues = SQL.split("create or replace function", 1)
    assert CUERPO_DE_LA_0090 in antes and CUERPO_DE_LA_0096 in antes
    assert CUERPO_DE_LA_0090 not in despues and CUERPO_DE_LA_0096 in despues


# =========================================================================== #
# 2. Contra PostgreSQL
# =========================================================================== #
@pytest.fixture(scope="module")
def completa(pg):  # noqa: F811
    _montar(pg)
    return pg


@SIN_POSTGRES
def test_desde_cero_queda_cerrada(completa) -> None:
    pg = completa  # noqa: F811
    assert _uno(pg, _HUELLA) == CUERPO_DE_LA_0096
    assert _todas(
        pg, "select t.tgtype, t.tgenabled, p.prosecdef, p.proconfig from pg_trigger t join pg_proc p on p.oid = t.tgfoid "
            "where t.tgrelid = 'public.service_version_images'::regclass and not t.tgisinternal"
    ) == [(31, "O", False, ["search_path=public, pg_temp"])]
    assert _uno(pg, "select relrowsecurity from pg_class where oid = 'public.service_version_images'::regclass")
    assert _uno(pg, "select count(*) from pg_policy where polrelid = 'public.service_version_images'::regclass") == 0
    for rol in ("anon", "authenticated"):
        assert not _uno(pg, f"select has_function_privilege(%s, 'public.{FUNCION}()', 'EXECUTE')", rol)
        assert not _uno(
            pg, "select has_table_privilege(%s, 'public.service_version_images', "
                "'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')", rol)
    assert _uno(pg, "select not public from storage.buckets where id = 'service-media'")


@SIN_POSTGRES
def test_la_ruta_nueva_entra_y_no_lleva_el_perfil(completa) -> None:
    pg = completa  # noqa: F811
    perfil, _, servicio, version = _servicio(pg)
    for extension in ("png", "jpg", "webp"):
        ruta = _opaca(servicio, extension)
        assert perfil not in ruta
        assert _uno(pg, _INSERTAR, version, servicio, ruta) is not None
    assert _uno(pg, "select count(*) from public.service_version_images where service_id = %s", servicio) == 3


@SIN_POSTGRES
def test_una_ruta_que_no_es_la_nueva_no_se_registra(completa) -> None:
    pg = completa  # noqa: F811
    perfil, _, servicio, version = _servicio(pg)
    _, _, otro, _ = _servicio(pg)
    hexa = uuid.uuid4().hex
    for ruta in (
        # LA DE LA 0090, que hasta ayer era la buena.
        _anterior(perfil, servicio, version),
        # De otro servicio, aunque tenga la forma nueva.
        _opaca(otro),
        # El perfil delante de una ruta nueva.
        f"{perfil}/{_opaca(servicio)}",
        f"{perfil}/{hexa}.png",
        # Casi iguales: mayúsculas, un carácter de menos o de más, otra extensión, sin ella.
        f"{servicio}/{hexa.upper()}.png",
        f"{servicio}/{hexa[:-1]}.png",
        f"{servicio}/{hexa}0.png",
        f"{servicio}/{hexa}.gif",
        f"{servicio}/{hexa}.PNG",
        f"{servicio}/{hexa}",
        f"{servicio}/{hexa}.png.exe",
        f"{servicio}/{hexa}xpng",
        # Carpetas dentro, o un nombre legible.
        f"{servicio}/{version}/{hexa}.png",
        f"{servicio}/portada-de-ana.png",
        f"{servicio.upper()}/{hexa}.png",
        f" {servicio}/{hexa}.png",
        f"{servicio}/{hexa}.png\n",
        f"https://almacen.test/{servicio}/{hexa}.png",
    ):
        error = _falla(pg, _INSERTAR, version, servicio, ruta)
        assert "La ruta de una imagen" in error or "service_version_images_ruta" in error, (ruta, error)
    assert _uno(pg, "select count(*) from public.service_version_images where service_id = %s", servicio) == 0


@SIN_POSTGRES
def test_tampoco_se_cambia_una_ruta_nueva_por_una_anterior(completa) -> None:
    pg = completa  # noqa: F811
    perfil, _, servicio, version = _servicio(pg)
    imagen = _uno(pg, _INSERTAR, version, servicio, _opaca(servicio))
    assert "La ruta de una imagen" in _falla(
        pg, "update public.service_version_images set storage_path = %s where id = %s",
        _anterior(perfil, servicio, version), imagen,
    )
    # Por otra ruta nueva del mismo servicio, sí; y lo que no es la ruta se sigue pudiendo editar.
    _hacer(pg, "update public.service_version_images set storage_path = %s where id = %s", _opaca(servicio), imagen)
    _hacer(pg, "update public.service_version_images set alt_text = 'Otra descripción' where id = %s", imagen)


@SIN_POSTGRES
def test_lo_demas_del_disparador_sigue_igual(completa) -> None:
    """Las imágenes solo cambian en un borrador, y fuera de él no se quitan."""
    pg = completa  # noqa: F811
    _, _, servicio, version = _enviada(pg)
    assert "solo cambian en un borrador" in _falla(pg, _INSERTAR, version, servicio, _opaca(servicio))
    imagen = _uno(pg, "select id from public.service_version_images where version_id = %s", version)
    assert "no se quita" in _falla(pg, "delete from public.service_version_images where id = %s", imagen)
    assert "solo cambian en un borrador" in _falla(
        pg, "update public.service_version_images set alt_text = 'Otra' where id = %s", imagen)
    # En un borrador se quita sin problema.
    _, _, servicio2, borrador = _servicio(pg)
    suya = _uno(pg, _INSERTAR, borrador, servicio2, _opaca(servicio2))
    _hacer(pg, "delete from public.service_version_images where id = %s", suya)


# =========================================================================== #
# 3. La aplicación
# =========================================================================== #
def _con_imagen_anterior(pg) -> tuple[str, str, str, str, str]:  # noqa: F811
    """Sobre la 0095: un servicio PUBLICADO con una imagen de ruta anterior.
    `(perfil, prestador, servicio, versión publicada, ruta)`."""
    admin = _persona(pg, "admin")
    perfil, prestador, servicio, version = _publicada(pg, admin)
    ruta = _uno(pg, "select storage_path from public.service_version_images where version_id = %s", version)
    assert ruta.startswith(f"{perfil}/{servicio}/{version}/")
    return perfil, prestador, servicio, version, ruta


def _filas(pg) -> dict:  # noqa: F811
    return {
        tabla: _uno(pg, f"select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.{tabla} t")
        for tabla in ("services", "service_versions", "service_version_images", "service_events", "service_providers")
    }


@SIN_POSTGRES
def test_sobre_la_0095_no_toca_ninguna_fila_y_dice_cuantas_anteriores_hay(pg) -> None:  # noqa: F811
    _montar(pg, hasta="0095")
    _con_imagen_anterior(pg)
    _con_imagen_anterior(pg)
    antes, foto = _filas(pg), _foto(pg)
    avisos: list[str] = []

    def _apuntar(aviso) -> None:  # noqa: ANN001
        avisos.append(aviso.message_primary)

    pg.add_notice_handler(_apuntar)
    try:
        _hacer(pg, TEXTO)
    finally:
        pg.remove_notice_handler(_apuntar)
    assert _filas(pg) == antes
    assert any("La 0096: 2 imagen(es) con ruta anterior" in a for a in avisos), avisos
    # Lo único que cambia en todo el esquema es el cuerpo de esa función.
    despues = _foto(pg)
    assert {k: v for k, v in despues.items() if k != "funciones"} == {k: v for k, v in foto.items() if k != "funciones"}
    distintas = set(despues["funciones"]) ^ set(foto["funciones"])
    assert {nombre for nombre, _ in distintas} == {FUNCION}
    assert _uno(pg, _HUELLA) == CUERPO_DE_LA_0096


@SIN_POSTGRES
def test_una_ruta_anterior_se_copia_a_otra_version_del_mismo_servicio_y_a_ningun_otro_sitio(pg) -> None:  # noqa: F811
    """Lo que hace la API al abrir un borrador sobre lo publicado: copia las
    filas con su misma ruta. Un servicio con imágenes de antes de la 0096
    tiene que poder seguir editándose."""
    _montar(pg, hasta="0095")
    perfil, prestador, servicio, _, ruta = _con_imagen_anterior(pg)
    _hacer(pg, TEXTO)
    borrador = str(_uno(
        pg, "insert into public.service_versions (service_id, version) values (%s, 2) returning id", servicio))
    # LA COPIA entra: la ruta ya la nombra otra fila de este servicio.
    assert _uno(pg, _INSERTAR, borrador, servicio, ruta) is not None
    # Una ruta anterior NUEVA, no: nadie la nombraba.
    assert "La ruta de una imagen" in _falla(pg, _INSERTAR, borrador, servicio, _anterior(perfil, servicio, borrador))
    # En OTRO servicio del mismo prestador, tampoco: la ruta es de aquel.
    otro = str(_uno(
        pg, "insert into public.services (provider_id, category_id) values (%s, %s) returning id",
        prestador, _categoria(pg)))
    otro_borrador = str(_uno(
        pg, "insert into public.service_versions (service_id, version) values (%s, 1) returning id", otro))
    assert "La ruta de una imagen" in _falla(pg, _INSERTAR, otro_borrador, otro, ruta)
    # Y en el borrador conviven la copiada y una nueva, opaca.
    assert _uno(pg, _INSERTAR, borrador, servicio, _opaca(servicio)) is not None
    assert _uno(pg, "select count(*) from public.service_version_images where version_id = %s", borrador) == 2


@SIN_POSTGRES
def test_la_cuenta_se_sigue_borrando_con_sus_imagenes_anteriores_y_nuevas(pg) -> None:  # noqa: F811
    _montar(pg, hasta="0095")
    perfil, _, servicio, _, _ = _con_imagen_anterior(pg)
    _hacer(pg, TEXTO)
    borrador = str(_uno(
        pg, "insert into public.service_versions (service_id, version) values (%s, 2) returning id", servicio))
    _uno(pg, _INSERTAR, borrador, servicio, _opaca(servicio))
    _hacer(pg, "delete from auth.users where id = %s", perfil)
    for tabla in ("services", "service_versions", "service_version_images"):
        columna = "id" if tabla == "services" else "service_id"
        assert _uno(pg, f"select count(*) from public.{tabla} where {columna} = %s", servicio) == 0


@SIN_POSTGRES
def test_reejecutarla_deja_exactamente_lo_mismo(pg) -> None:  # noqa: F811
    _montar(pg)
    _con_imagen = _servicio(pg)
    _uno(pg, _INSERTAR, _con_imagen[3], _con_imagen[2], _opaca(_con_imagen[2]))
    antes, filas = _foto(pg), _filas(pg)
    _hacer(pg, TEXTO)
    _hacer(pg, TEXTO)
    assert _foto(pg) == antes and _filas(pg) == filas


@SIN_POSTGRES
def test_un_fallo_a_mitad_no_deja_nada(pg) -> None:  # noqa: F811
    import psycopg

    _montar(pg, hasta="0095")
    foto = _foto(pg)
    rota = TEXTO.replace("notify pgrst, 'reload schema';", "select 1 / 0;")
    assert rota != TEXTO
    with pytest.raises(psycopg.Error):
        _hacer(pg, rota)
    _hacer(pg, "rollback")
    assert _foto(pg) == foto and _uno(pg, _HUELLA) == CUERPO_DE_LA_0090


@SIN_POSTGRES
def test_se_niega_a_terminar_incompleta(pg) -> None:  # noqa: F811
    import psycopg

    _montar(pg, hasta="0095")
    foto = _foto(pg)
    revocar = f"revoke all on function public.{FUNCION}() from public, anon, authenticated;"
    for viciada, mensaje in (
        # Otro cuerpo que el que la migración dice dejar.
        (TEXTO.replace("[0-9a-f]{32}[.](jpg|png|webp)$') then\n      return new;",
                       "[0-9a-f]{32}[.](jpg|png|webp|gif)$') then\n      return new;"), "no dejó el cuerpo esperado"),
        (TEXTO.replace("security invoker\nset search_path = public, pg_temp\nas $$\ndeclare\n  estado text;\n  perfil uuid;",
                       "security definer\nset search_path = public, pg_temp\nas $$\ndeclare\n  estado text;\n  perfil uuid;"),
         "cambió de seguridad"),
        (TEXTO.replace(revocar, revocar + f"\nalter table public.service_version_images disable trigger {DISPARADOR};"),
         "no dejó el disparador"),
        (TEXTO.replace(revocar, f"grant execute on function public.{FUNCION}() to anon;"), "ejecutable desde fuera"),
        (TEXTO.replace(revocar, revocar + "\nalter table public.service_version_images disable row level security;"),
         "sin RLS"),
        (TEXTO.replace(revocar, revocar + "\ncreate policy abierta on public.service_version_images for select "
                                          "to anon using (true);"), "tiene políticas"),
        (TEXTO.replace(revocar, revocar + "\ngrant select (storage_path) on public.service_version_images to "
                                          "authenticated;"), "permisos sueltos"),
        (TEXTO.replace(revocar, revocar + "\nupdate storage.buckets set public = true where id = 'service-media';"),
         "dejó de ser privado"),
    ):
        assert viciada != TEXTO, mensaje
        with pytest.raises(psycopg.Error) as error:
            _hacer(pg, viciada)
        assert mensaje in str(error.value), (mensaje, str(error.value))
        _hacer(pg, "rollback")
        assert _foto(pg) == foto and _uno(pg, _HUELLA) == CUERPO_DE_LA_0090


@SIN_POSTGRES
def test_sin_cada_dependencia_se_niega_diciendo_cual_y_no_cambia_nada(pg) -> None:  # noqa: F811
    import psycopg

    ajena = (f"create or replace function public.{FUNCION}() returns trigger language plpgsql "
             "set search_path = public, pg_temp as $$ begin return new; end; $$")
    for preparar, mensaje in (
        (lambda: _montar(pg, hasta="0089"), "faltan services, service_versions, service_version_images"),
        # LA 0095: sin ella entera, o sin su disparador, su función o su columna.
        (lambda: _montar(pg, hasta="0094"), "requiere la 0095 aplicada"),
        (lambda: (_montar(pg, hasta="0095"),
                  _hacer(pg, "drop trigger service_bookings_con_politica on public.service_bookings")),
         "requiere la 0095 aplicada"),
        (lambda: (_montar(pg, hasta="0095"),
                  _hacer(pg, "alter table public.service_bookings disable trigger service_bookings_con_politica")),
         "requiere la 0095 aplicada"),
        # EL DISPARADOR DE LAS IMÁGENES: sin él, apagado, o con otro cuerpo.
        (lambda: (_montar(pg, hasta="0095"),
                  _hacer(pg, f"drop trigger {DISPARADOR} on public.service_version_images")),
         f"el disparador {DISPARADOR} de la 0090, activo"),
        (lambda: (_montar(pg, hasta="0095"),
                  _hacer(pg, f"alter table public.service_version_images disable trigger {DISPARADOR}")),
         f"el disparador {DISPARADOR} de la 0090, activo"),
        (lambda: (_montar(pg, hasta="0095"), _hacer(pg, ajena)), "con el cuerpo de la 0090"),
        # El depósito: sin él, o público.
        (lambda: (_montar(pg, hasta="0095"),
                  _hacer(pg, "delete from storage.buckets where id = 'service-media'")),
         "el depósito privado service-media"),
        (lambda: (_montar(pg, hasta="0095"),
                  _hacer(pg, "update storage.buckets set public = true where id = 'service-media'")),
         "el depósito privado service-media"),
    ):
        preparar()
        foto = _foto(pg)
        with pytest.raises(psycopg.Error) as error:
            _hacer(pg, TEXTO)
        assert "La 0096 requiere" in str(error.value) and mensaje in str(error.value), (mensaje, str(error.value))
        _hacer(pg, "rollback")
        assert _foto(pg) == foto


@SIN_POSTGRES
def test_reejecutar_la_0090_encima_deshace_la_ruta_opaca_y_esta_se_vuelve_a_aplicar(pg) -> None:  # noqa: F811
    """La 0090 es reejecutable y define esta misma función: si alguien la
    vuelve a ejecutar, vuelve el cuerpo anterior. No es silencioso —la puerta
    del catálogo lo nota y contesta 503— y se arregla reaplicando la 0096."""
    _montar(pg)
    assert _uno(pg, _HUELLA) == CUERPO_DE_LA_0096
    _hacer(pg, next(MIGRACIONES.glob("0090_*.sql")).read_text(encoding="utf-8"))
    assert _uno(pg, _HUELLA) == CUERPO_DE_LA_0090 != esquema.CUERPO_DE_LAS_IMAGENES
    _hacer(pg, TEXTO)
    assert _uno(pg, _HUELLA) == CUERPO_DE_LA_0096
