"""Las cuentas de «Enlaces» y de `own` de un tema, con sus valores EXACTOS.

Auditoría de rendimiento, § 5.7 (28/10/2026). Las dos cuentas recorrían el
historial entero de la conversación, y la migración 0111 les dio un índice
parcial a cada una. Lo que aquí se protege es que el arreglo no cambie NI UN
NÚMERO de lo que contesta la API:

  · los dos se enseñan tal cual —«37 escritos aquí» en un tema, y la pantalla
    «Contenido» del 09/10 pintaba «Enlaces · 1234»—, y la aplicación nativa no
    se actualiza al instante: nada de topes («99+») ni de redondeos;
  · qué es «llevar un enlace» no cambia: `http://`, `https://` o `www.`, en
    mayúsculas o minúsculas, en cualquier parte del texto; lo demás, no;
  · la cuenta y la lista de la pestaña dicen lo mismo;
  · los borrados, otras conversaciones y lo anterior a vaciar el chat no
    cuentan, y `own` no mezcla General ni las referencias.

Corren en SQLite, siempre. Las mismas cuentas contra PostgreSQL de verdad, con
la 0111 aplicada y mirando que el planificador use sus índices, están en
`test_cuentas_de_temas_y_enlaces_postgres.py`.
"""

from __future__ import annotations

import re
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import event, update

# `app.main` primero, como en `test_temas_de_grupo.py`.
from app.main import app  # noqa: F401, I001
from app.modules.messaging import vistas
from app.modules.messaging.models import ConversationPreference, Message
from tests.test_temas_de_grupo import _del_tema, _referenciar, _tema, entorno  # noqa: F401
from tests.test_vistas_de_conversacion import (
    ANA,
    API,
    BASE,
    BRUNO,
    GRUPO,
    OTRO_GRUPO,
    _mensaje,
)

MIGRACION_0111 = (
    Path(__file__).resolve().parents[3]
    / "supabase"
    / "migrations"
    / "0111_cuentas_de_temas_y_enlaces.sql"
)

#: (texto, ¿cuenta como enlace?). Es la definición que YA tenía la API
#: (`_MARCAS_DE_ENLACE`), escrita como casos: si una optimización la cambiara,
#: aquí se vería en qué texto. La usa también la prueba de PostgreSQL.
CASOS_DE_ENLACE: list[tuple[str, bool]] = [
    ("http://renaser.pe", True),
    ("https://renaser.pe/curso", True),
    ("www.renaser.pe", True),
    ("HTTP://RENASER.PE", True),
    ("HTTPS://RENASER.PE/CLASE", True),
    ("WWW.RENASER.PE", True),
    ("Mirad Https://Renaser.pe/Clase antes del examen", True),
    ("hTtP://mezcla.example", True),
    ("dos enlaces: https://a.example y www.b.example", True),
    ("arriba el texto\ny abajo https://en-otra-linea.example", True),
    # «Contiene www.», no «empieza por»: siempre fue así, y así se queda.
    ("awww.que lindo", True),
    ("http:/renaser.pe", False),
    ("https:renaser.pe", False),
    ("http//renaser.pe", False),
    ("ftp://renaser.pe", False),
    ("ww.renaser.pe", False),
    # El punto de `www.` es un punto, no un comodín.
    ("wwwXrenaser", False),
    # Los dominios a pelo no cuentan aquí (ver `_MARCAS_DE_ENLACE`).
    ("renaser.pe", False),
    ("hola a todos", False),
    ("", False),
]


async def _cuentas(http, conv: str = GRUPO) -> dict[str, int]:
    respuesta = await http.get(f"{API}/{conv}/views")
    assert respuesta.status_code == 200, respuesta.text
    return {c["key"]: c["count"] for c in respuesta.json()["categories"]}


async def _toda_la_pestana(http, conv: str = GRUPO, **params) -> list[str]:
    """La pestaña «Enlaces» ENTERA, pasando todas sus páginas."""
    ids: list[str] = []
    cursor: dict = {}
    while True:
        respuesta = await http.get(
            f"{API}/{conv}/views/messages",
            params={"category": "link", "limit": 60, **cursor, **params},
        )
        assert respuesta.status_code == 200, respuesta.text
        cuerpo = respuesta.json()
        ids += [m["id"] for m in cuerpo["items"]]
        if not cuerpo["next_before"]:
            return ids
        cursor = {"before": cuerpo["next_before"], "before_id": cuerpo["next_before_id"]}


# --------------------------------------------------------------------------- #
# «Enlaces»
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
@pytest.mark.parametrize(("texto", "es_enlace"), CASOS_DE_ENLACE)
async def test_que_cuenta_como_enlace(entorno, texto, es_enlace):
    http, sesiones, _ = entorno
    mid = await _mensaje(sesiones, texto=texto, adjuntos=() if texto else ("image",))
    assert (await _cuentas(http))["link"] == (1 if es_enlace else 0)
    assert await _toda_la_pestana(http) == ([mid] if es_enlace else [])


@pytest.mark.asyncio
async def test_la_cuenta_y_la_pestana_dicen_lo_mismo(entorno):
    http, sesiones, _ = entorno
    esperados = set()
    for minuto, (texto, es_enlace) in enumerate(CASOS_DE_ENLACE):
        mid = await _mensaje(sesiones, texto=texto, minuto=minuto)
        if es_enlace:
            esperados.add(mid)
    assert (await _cuentas(http))["link"] == len(esperados) == 11
    assert set(await _toda_la_pestana(http)) == esperados


@pytest.mark.asyncio
async def test_la_cuenta_de_enlaces_no_tiene_tope(entorno):
    """150 es 150, no «99+» ni 100: la aplicación lo enseña tal cual."""
    http, sesiones, _ = entorno
    async with sesiones() as db:
        for i in range(150):
            db.add(
                Message(
                    id=str(uuid4()),
                    conversation_id=GRUPO,
                    sender_id=ANA,
                    body=f"material {i}: https://renaser.pe/{i}",
                    created_at=BASE + timedelta(seconds=i),
                )
            )
        for i in range(30):
            db.add(
                Message(
                    id=str(uuid4()),
                    conversation_id=GRUPO,
                    sender_id=BRUNO,
                    body=f"gracias {i}",
                    created_at=BASE + timedelta(seconds=200 + i),
                )
            )
        await db.commit()
    assert (await _cuentas(http))["link"] == 150
    assert len(set(await _toda_la_pestana(http))) == 150


@pytest.mark.asyncio
async def test_borrados_otras_conversaciones_y_lo_vaciado_no_cuentan(entorno):
    http, sesiones, identidad = entorno
    await _mensaje(sesiones, texto="https://antes.example", minuto=5)
    justo = await _mensaje(sesiones, texto="https://justo-al-vaciar.example", minuto=10)
    despues = await _mensaje(
        sesiones, texto="www.despues.example", cuando=BASE + timedelta(minutes=10, seconds=1)
    )
    await _mensaje(sesiones, texto="https://borrado.example", minuto=20, borrado=True)
    await _mensaje(sesiones, texto="http://otro-grupo.example", en=OTRO_GRUPO, de=BRUNO, minuto=30)

    # Sin vaciar: los tres vivos del grupo. Ni el borrado ni el de otro grupo.
    assert (await _cuentas(http))["link"] == 3

    # Ana vacía el chat a los 10 minutos: lo de ESE instante tampoco se le
    # cuenta (`created_at > cleared_at`, estricto), lo de un segundo después sí.
    async with sesiones() as db:
        db.add(
            ConversationPreference(
                conversation_id=GRUPO, user_id=ANA, cleared_at=BASE + timedelta(minutes=10)
            )
        )
        await db.commit()
    assert (await _cuentas(http))["link"] == 1
    assert await _toda_la_pestana(http) == [despues]

    # Vaciar es de cada cual: a Bruno le siguen contando los tres.
    identidad["uid"] = BRUNO
    assert (await _cuentas(http))["link"] == 3
    assert justo in await _toda_la_pestana(http)

    # Y borrar uno por la API lo descuenta para todos.
    identidad["uid"] = ANA
    assert (await http.delete(f"{API}/{GRUPO}/messages/{despues}")).status_code == 204
    assert (await _cuentas(http))["link"] == 0
    identidad["uid"] = BRUNO
    assert (await _cuentas(http))["link"] == 2


@pytest.mark.asyncio
async def test_las_marcas_de_enlace_viajan_escritas_en_el_sql(entorno):
    """Sin esto, el índice parcial de la 0111 no sirve en un plan genérico.

    PostgreSQL solo usa un índice parcial si puede demostrar, al planificar,
    que la consulta pide lo que él guarda. Con las marcas como parámetros
    (`$2`, `$3`, `$4`) no puede, y asyncpg reutiliza sentencias preparadas.
    Las palabras que escribe una persona, en cambio, siguen yendo como
    parámetros: eso es lo que no se puede escribir en el SQL.
    """
    http, sesiones, _ = entorno
    await _mensaje(sesiones, texto="examen en https://renaser.pe")
    filtro = await http.post(
        f"{API}/{GRUPO}/filters",
        json={"name": "Examen", "criteria": {"types": ["link"], "keywords": ["examen"]}},
    )
    assert filtro.status_code == 201, filtro.text

    vistas_sql: list[tuple[str, object]] = []
    # El motor en memoria de esta prueba: el mismo que usa la API, por `get_db`.
    motor_de_prueba = sesiones.kw["bind"]

    def _apuntar(conn, cursor, sql, params, context, executemany):
        vistas_sql.append((sql, params))

    event.listen(motor_de_prueba.sync_engine, "before_cursor_execute", _apuntar)
    try:
        assert (await _cuentas(http))["link"] == 1
        assert len(await _toda_la_pestana(http)) == 1
        pagina = await http.get(
            f"{API}/{GRUPO}/views/messages", params={"filter_id": filtro.json()["id"]}
        )
        assert len(pagina.json()["items"]) == 1
    finally:
        event.remove(motor_de_prueba.sync_engine, "before_cursor_execute", _apuntar)

    con_enlace = [(sql, params) for sql, params in vistas_sql if "http://" in sql]
    # La cuenta, la pestaña y el filtro: las tres llevan la condicion.
    assert len(con_enlace) >= 3
    for sql, params in con_enlace:
        for marca in vistas._MARCAS_DE_ENLACE:
            assert f"'{marca}'" in sql, (marca, sql)
        valores = params.values() if isinstance(params, dict) else params
        assert not set(valores) & set(vistas._MARCAS_DE_ENLACE), params
    # La palabra del filtro NO va escrita en el SQL: va como parametro.
    del_filtro = [p for s, p in con_enlace if "%examen%" in str(p)]
    assert del_filtro and all("examen" not in s for s, _ in con_enlace)


def _sql_de_la_0111() -> str:
    crudo = MIGRACION_0111.read_text(encoding="utf-8")
    return re.sub(r"--[^\n]*", " ", crudo)


def test_la_0111_guarda_las_mismas_marcas_que_vistas_py():
    """Si divergen, ninguna cuenta sale mal; solo vuelven a ser lentas. Por eso
    se comprueba aquí, sin PostgreSQL, y no se descubre en producción."""
    sql = _sql_de_la_0111()
    indice = re.search(
        r"create index if not exists messages_con_enlace_idx(.*?);", sql, flags=re.S
    )
    assert indice, "la 0111 no crea messages_con_enlace_idx"
    cuerpo = " ".join(indice.group(1).split())
    assert "on public.messages (conversation_id, created_at)" in cuerpo
    assert "deleted_at is null" in cuerpo
    assert set(re.findall(r"body ilike '([^']+)'", cuerpo)) == set(vistas._MARCAS_DE_ENLACE)


def test_la_0111_solo_crea_indices_y_se_puede_repetir():
    sql = _sql_de_la_0111()
    creados = re.findall(r"create index (if not exists )?(\w+)", sql)
    assert creados == [
        ("if not exists ", "messages_vivos_idx"),
        ("if not exists ", "messages_con_enlace_idx"),
    ]
    assert re.search(
        r"create index if not exists messages_vivos_idx\s+on public\.messages "
        r"\(conversation_id, created_at\)\s+where deleted_at is null;",
        sql,
    )
    # Ni tablas, ni columnas, ni filas, ni politicas, ni `concurrently` (que no
    # puede correr dentro de la transaccion del editor de Supabase).
    assert not re.search(
        r"\b(create table|alter table|insert into|update public|delete from|truncate"
        r"|create policy|drop policy|concurrently)\b",
        sql,
    )
    # Termina como manda CLAUDE.md: recarga de PostgREST y un select de comprobacion.
    final = sql[sql.rindex("notify pgrst") :]
    assert final.startswith("notify pgrst, 'reload schema';")
    assert re.search(r"\bselect\b", final)


# --------------------------------------------------------------------------- #
# `own` de un tema
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_own_cuenta_los_mensajes_vivos_de_su_chat_y_nada_mas(entorno):
    http, sesiones, _ = entorno
    anuncios = await _tema(http, "Anuncios", sesiones=sesiones)
    material = await _tema(http, "Material", sesiones=sesiones)
    vacio = await _tema(http, "Vacío", sesiones=sesiones)

    propios = [
        await _mensaje(sesiones, texto=f"Aviso {i}", en=anuncios["chat_id"], minuto=i)
        for i in range(3)
    ]
    for i in range(2):
        await _mensaje(
            sesiones, texto=f"Borrado {i}", en=anuncios["chat_id"], minuto=10 + i, borrado=True
        )
    await _mensaje(sesiones, texto="Guía", en=material["chat_id"], minuto=1)
    # Lo de General no es «propio» de ningún tema, aunque esté referenciado.
    generales = [await _mensaje(sesiones, texto=f"General {i}", minuto=20 + i) for i in range(4)]
    for mid in generales[:2]:
        await _referenciar(sesiones, anuncios["id"], mid, BASE + timedelta(minutes=30))

    fila = await _del_tema(http, anuncios["id"])
    assert (fila["references"], fila["own"]) == (2, 3)
    assert (await _del_tema(http, material["id"]))["own"] == 1
    assert (await _del_tema(http, vacio["id"]))["own"] == 0

    # Borrar uno de los propios lo descuenta; borrar uno de General, no.
    assert (
        await http.delete(f"{API}/{anuncios['chat_id']}/messages/{propios[0]}")
    ).status_code == 204
    assert (await http.delete(f"{API}/{GRUPO}/messages/{generales[3]}")).status_code == 204
    fila = await _del_tema(http, anuncios["id"])
    assert (fila["references"], fila["own"]) == (2, 2)


@pytest.mark.asyncio
async def test_own_no_tiene_tope(entorno):
    """150 es 150: el tema dice «150 escritos aquí» y lo repite al confirmar
    que se elimina. Un tope cambiaria las dos frases."""
    http, sesiones, _ = entorno
    tema = await _tema(http, sesiones=sesiones)
    async with sesiones() as db:
        for i in range(150):
            db.add(
                Message(
                    id=str(uuid4()),
                    conversation_id=tema["chat_id"],
                    sender_id=ANA,
                    body=f"Aviso {i}",
                    created_at=BASE + timedelta(seconds=i),
                )
            )
        await db.commit()
    assert (await _del_tema(http, tema["id"]))["own"] == 150

    # Y lo que devuelve cambiar el tema sale por el MISMO camino.
    cambiado = await http.patch(f"{API}/{GRUPO}/topics/{tema['id']}", json={"name": "Avisos"})
    assert cambiado.status_code == 200, cambiado.text
    assert cambiado.json()["own"] == 150

    async with sesiones() as db:
        await db.execute(
            update(Message)
            .where(
                Message.conversation_id == tema["chat_id"],
                Message.body.in_(["Aviso 0", "Aviso 1"]),
            )
            .values(deleted_at=BASE)
        )
        await db.commit()
    assert (await _del_tema(http, tema["id"]))["own"] == 148
