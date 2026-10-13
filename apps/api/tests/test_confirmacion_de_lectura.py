"""La confirmación de lectura: quién leyó cada mensaje (12/10/2026).

Pedido, con WhatsApp de referencia: ver si leyeron o no mi mensaje, y en sus
detalles, quién sí y quién no. Lo que se protege:

  · «leído» sale de la marca de lectura que ya existía (`last_read_at`), sin
    tabla nueva: quien abrió el chat después del mensaje lo leyó;
  · quien nunca abrió la conversación no ha leído nada;
  · las marcas que se entregan son las de los DEMÁS, nunca la propia;
  · los detalles de un mensaje solo los ve quien lo escribió;
  · nadie que no sea miembro ve nada;
  · el servidor anuncia la función, para que una aplicación nueva contra un
    servidor viejo no pinte marcas que nadie le va a dar.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import update

# `app.main` va primero: ver la nota en `test_grupos_de_mensajeria.py`.
from app.main import app  # noqa: F401, I001
from app.modules.messaging.lecturas import lo_leyo
from app.modules.messaging.models import ConversationMember, Message
from tests.test_vistas_de_conversacion import (  # noqa: F401 - `entorno` es un fixture
    ANA,
    API,
    BRUNO,
    CARLA,
    DAVID,
    DIRECTO,
    GRUPO,
    entorno,
)

AYER = datetime.now(timezone.utc) - timedelta(days=1)
HACE_UNA_HORA = datetime.now(timezone.utc) - timedelta(hours=1)
AHORA = datetime.now(timezone.utc)

MENSAJE = "cccccccc-0000-0000-0000-000000000001"
DE_BRUNO = "cccccccc-0000-0000-0000-000000000002"
BORRADO = "cccccccc-0000-0000-0000-000000000003"
EN_EL_DIRECTO = "cccccccc-0000-0000-0000-000000000004"


async def _sembrar(sesiones) -> None:
    """Ana escribe en el grupo hace una hora; cada quien leyó hasta donde leyó."""
    async with sesiones() as db:
        db.add(Message(id=MENSAJE, conversation_id=GRUPO, sender_id=ANA, body="Reunión el martes", created_at=HACE_UNA_HORA))
        db.add(Message(id=DE_BRUNO, conversation_id=GRUPO, sender_id=BRUNO, body="Voy", created_at=HACE_UNA_HORA))
        db.add(
            Message(
                id=BORRADO,
                conversation_id=GRUPO,
                sender_id=ANA,
                body="",
                created_at=HACE_UNA_HORA,
                deleted_at=AHORA,
            )
        )
        db.add(Message(id=EN_EL_DIRECTO, conversation_id=DIRECTO, sender_id=ANA, body="Hola", created_at=HACE_UNA_HORA))
        await db.commit()


async def _leyo_hasta(sesiones, conversacion: str, persona: str, cuando: datetime | None) -> None:
    async with sesiones() as db:
        await db.execute(
            update(ConversationMember)
            .where(
                ConversationMember.conversation_id == conversacion,
                ConversationMember.user_id == persona,
            )
            .values(last_read_at=cuando)
        )
        await db.commit()


def test_leer_es_haber_abierto_el_chat_despues_del_mensaje():
    assert lo_leyo(AHORA, HACE_UNA_HORA)
    # El mismo instante cuenta: quien lo abrió justo entonces ya lo vio.
    assert lo_leyo(HACE_UNA_HORA, HACE_UNA_HORA)
    assert not lo_leyo(AYER, HACE_UNA_HORA)
    # Sin marca, nunca abrió la conversación.
    assert not lo_leyo(None, HACE_UNA_HORA)
    # SQLite devuelve las fechas sin zona; PostgreSQL, con ella. Da igual.
    assert lo_leyo(AHORA.replace(tzinfo=None), HACE_UNA_HORA)
    assert not lo_leyo(AYER, HACE_UNA_HORA.replace(tzinfo=None))


@pytest.mark.asyncio
async def test_las_marcas_de_lectura_son_las_de_los_demas(entorno):
    http, sesiones, _ = entorno
    await _sembrar(sesiones)
    await _leyo_hasta(sesiones, GRUPO, BRUNO, AHORA)
    await _leyo_hasta(sesiones, GRUPO, ANA, AHORA)

    respuesta = await http.get(f"{API}/{GRUPO}/read-state")
    assert respuesta.status_code == 200, respuesta.text
    marcas = {m["user_id"]: m["last_read_at"] for m in respuesta.json()["members"]}

    # Bruno y Carla; Ana, que es quien pregunta, no sale.
    assert set(marcas) == {BRUNO, CARLA}
    assert marcas[BRUNO] is not None
    # Carla nunca abrió el grupo.
    assert marcas[CARLA] is None


@pytest.mark.asyncio
async def test_los_detalles_dicen_quien_leyo_y_quien_no(entorno):
    http, sesiones, _ = entorno
    await _sembrar(sesiones)
    await _leyo_hasta(sesiones, GRUPO, BRUNO, AHORA)   # abrió el chat después
    await _leyo_hasta(sesiones, GRUPO, CARLA, AYER)    # su última lectura es anterior

    respuesta = await http.get(f"{API}/{GRUPO}/messages/{MENSAJE}/receipts")
    assert respuesta.status_code == 200, respuesta.text
    detalles = respuesta.json()

    assert detalles["message_id"] == MENSAJE
    assert [p["id"] for p in detalles["read_by"]] == [BRUNO]
    assert [p["id"] for p in detalles["pending"]] == [CARLA]
    # Con lo necesario para pintar la lista, y sin nada más.
    assert detalles["read_by"][0] == {
        "id": BRUNO,
        "full_name": "Bruno",
        "username": "bruno",
        "avatar_path": None,
    }
    # Quien escribió el mensaje no aparece en ninguna de las dos listas.
    todos = {p["id"] for p in detalles["read_by"] + detalles["pending"]}
    assert ANA not in todos


@pytest.mark.asyncio
async def test_cuando_todos_lo_leen_no_queda_nadie_pendiente(entorno):
    http, sesiones, _ = entorno
    await _sembrar(sesiones)
    await _leyo_hasta(sesiones, GRUPO, BRUNO, AHORA)
    await _leyo_hasta(sesiones, GRUPO, CARLA, AHORA)

    detalles = (await http.get(f"{API}/{GRUPO}/messages/{MENSAJE}/receipts")).json()
    assert {p["id"] for p in detalles["read_by"]} == {BRUNO, CARLA}
    assert detalles["pending"] == []


@pytest.mark.asyncio
async def test_en_un_chat_de_dos_la_lista_es_la_otra_persona(entorno):
    http, sesiones, _ = entorno
    await _sembrar(sesiones)

    antes = (await http.get(f"{API}/{DIRECTO}/messages/{EN_EL_DIRECTO}/receipts")).json()
    assert antes["read_by"] == []
    assert [p["id"] for p in antes["pending"]] == [BRUNO]

    await _leyo_hasta(sesiones, DIRECTO, BRUNO, AHORA)
    despues = (await http.get(f"{API}/{DIRECTO}/messages/{EN_EL_DIRECTO}/receipts")).json()
    assert [p["id"] for p in despues["read_by"]] == [BRUNO]
    assert despues["pending"] == []


@pytest.mark.asyncio
async def test_abrir_el_chat_es_lo_que_marca_como_leido(entorno):
    """La ruta de siempre (`POST …/read`) es la que mueve la marca."""
    http, sesiones, identidad = entorno
    await _sembrar(sesiones)

    identidad["uid"] = BRUNO
    assert (await http.post(f"{API}/{GRUPO}/read")).status_code == 204

    identidad["uid"] = ANA
    detalles = (await http.get(f"{API}/{GRUPO}/messages/{MENSAJE}/receipts")).json()
    assert [p["id"] for p in detalles["read_by"]] == [BRUNO]
    assert [p["id"] for p in detalles["pending"]] == [CARLA]


@pytest.mark.asyncio
async def test_los_detalles_son_solo_de_quien_escribio_el_mensaje(entorno):
    http, sesiones, identidad = entorno
    await _sembrar(sesiones)

    # Ana no puede ver quién leyó lo que escribió Bruno.
    assert (await http.get(f"{API}/{GRUPO}/messages/{DE_BRUNO}/receipts")).status_code == 404
    # Ni Bruno lo de Ana, aunque los dos estén en el grupo.
    identidad["uid"] = BRUNO
    assert (await http.get(f"{API}/{GRUPO}/messages/{MENSAJE}/receipts")).status_code == 404


@pytest.mark.asyncio
async def test_un_mensaje_borrado_o_de_otra_conversacion_no_tiene_detalles(entorno):
    http, sesiones, _ = entorno
    await _sembrar(sesiones)

    assert (await http.get(f"{API}/{GRUPO}/messages/{BORRADO}/receipts")).status_code == 404
    # El mensaje es de Ana, pero del chat de dos: por el grupo no se llega a él.
    assert (await http.get(f"{API}/{GRUPO}/messages/{EN_EL_DIRECTO}/receipts")).status_code == 404
    assert (await http.get(f"{API}/{GRUPO}/messages/no-es-un-id/receipts")).status_code == 404
    inexistente = "cccccccc-0000-0000-0000-00000000ffff"
    assert (await http.get(f"{API}/{GRUPO}/messages/{inexistente}/receipts")).status_code == 404


@pytest.mark.asyncio
async def test_quien_no_es_miembro_no_ve_nada(entorno):
    http, sesiones, identidad = entorno
    await _sembrar(sesiones)

    identidad["uid"] = DAVID
    assert (await http.get(f"{API}/{GRUPO}/read-state")).status_code == 403
    assert (await http.get(f"{API}/{GRUPO}/messages/{MENSAJE}/receipts")).status_code == 403


@pytest.mark.asyncio
async def test_el_servidor_anuncia_la_confirmacion_de_lectura(entorno):
    http, _, _ = entorno
    respuesta = await http.get(f"{API}/availability")
    assert respuesta.status_code == 200
    assert respuesta.json()["read_receipts"] is True


def test_no_hace_falta_ninguna_migracion():
    """Se apoya en lo que ya había: ni tabla ni columna nuevas."""
    from pathlib import Path

    fuente = (Path(__file__).resolve().parents[1] / "app/modules/messaging/lecturas.py").read_text(
        encoding="utf-8"
    )
    # Solo lee: ni inserta, ni cambia, ni borra.
    for verbo in ("insert(", "update(", "delete(", ".add(", ".commit("):
        assert verbo not in fuente, verbo
    assert "ConversationMember.last_read_at" in fuente
    assert "esquema" not in fuente.split('"""', 2)[2]
