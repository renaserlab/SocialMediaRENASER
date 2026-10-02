"""Las Condiciones piloto v1 de Z Servicios: el texto y su publicación.

PREPARADAS, NO PUBLICADAS. El texto está en
`docs/Z_SERVICIOS_CONDICIONES_PILOTO_V1.txt`, pendiente de aprobación
empresarial y legal; se publica con las rutas de administración que ya
existen (`booking_terms`), sin tabla, esquema ni migración nuevos.

LO QUE SE COMPRUEBA:

  * sin base: que el texto está entero, cabe en una política, no esconde nada,
    no promete lo que no existe, no inventa un canal de soporte, dice los
    mismos plazos que la configuración de fábrica, y que su huella es la que
    consta en el documento; y que el guion que lo prepara se niega mientras
    lleve un marcador pendiente;
  * con PostgreSQL y por la API real: el procedimiento de publicación de punta
    a punta, y que lo aceptado en una reserva es lo que el servidor tenía
    vigente —su versión y su huella—, nunca lo que diga el cuerpo de la
    petición.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import re
import unicodedata
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.core.config import Settings
from app.modules.services import politicas
from app.modules.services.schemas import PoliticaBorradorCrear
from tests.test_baja_de_cuenta_postgres import SIN_POSTGRES, _filas, _persona, _sembrar, _uno
from tests.test_servicios_agenda_api import _codigo, _dia, _pedir
from tests.test_servicios_descubrimiento_api import base_aplicada, entorno, mundo  # noqa: F401 - montajes compartidos
from tests.test_servicios_reserva_api import (  # noqa: F401 - montajes compartidos
    ADMIN_SERVICIOS,
    MIS_RESERVAS,
    RETENCIONES,
    _aceptando,
    _clave,
    _confirmar,
    _horarios,
    _resumen,
    _retener,
    _servicio,
    reservas,
)

pytestmark = pytest.mark.asyncio

RAIZ = Path(__file__).resolve().parents[3]
DOCUMENTO = RAIZ / "docs" / "Z_SERVICIOS_CONDICIONES_PILOTO_V1.md"
GUION = RAIZ / "apps" / "api" / "scripts" / "condiciones_del_piloto.py"
POLITICAS = f"{ADMIN_SERVICIOS}/policies"


def _guion():
    especificacion = importlib.util.spec_from_file_location("condiciones_del_piloto", GUION)
    modulo = importlib.util.module_from_spec(especificacion)
    especificacion.loader.exec_module(modulo)
    return modulo


guion = _guion()
TEXTO = guion.leer()
#: Los diecisiete apartados, en orden.
APARTADOS = (
    "NATURALEZA DEL PILOTO", "PARTICIPANTES", "EL PAPEL DE Z", "ALCANCE", "DINERO", "LA RESERVA", "CANCELACIÓN",
    "CAMBIO DE HORARIO", "LA ATENCIÓN", "INCIDENCIAS", "APELACIÓN", "RESEÑAS", "DATOS PERSONALES",
    "SERVICIOS VIRTUALES", "SUSPENSIÓN", "SOPORTE", "VIGENCIA",
)


def _apartado(numero: int) -> str:
    """El texto de un apartado, sin su título."""
    inicio = TEXTO.index(f"\n{numero}. {APARTADOS[numero - 1]}\n")
    fin = TEXTO.index(f"\n{numero + 1}. ", inicio) if numero < len(APARTADOS) else len(TEXTO)
    return TEXTO[inicio:fin]


# =========================================================================== #
# 1. El texto, sin base
# =========================================================================== #
async def test_el_texto_cabe_en_una_politica_y_llega_al_servidor_tal_cual() -> None:
    """Lo que prepara el guion pasa la validación del borrador SIN CAMBIAR:
    la huella que se calcula aquí es la que tendrá en el servidor."""
    cuerpo = guion.peticion(TEXTO)
    validado = PoliticaBorradorCrear(**cuerpo)
    assert (validado.country_code, validado.category, validado.parameters) == ("PE", None, {})
    assert validado.title == guion.TITULO == "Condiciones del piloto de Z Servicios"
    assert validado.body == TEXTO and 50 <= len(TEXTO) <= 100_000
    assert guion.huella(TEXTO) == politicas.huella(validado.body)
    # Con saltos de línea de Windows (así lo deja Git aquí) es el mismo texto.
    assert "\r" not in TEXTO and TEXTO == TEXTO.strip()


async def test_la_huella_del_borrador_es_la_que_consta_en_el_documento() -> None:
    documento = DOCUMENTO.read_text(encoding="utf-8")
    assert f"`{guion.huella(TEXTO)}`" in documento
    assert f"{len(TEXTO)} caracteres" in documento


async def test_los_diecisiete_apartados_estan_y_en_orden() -> None:
    titulos = re.findall(r"^(\d+)\. ([^\n]+)$", TEXTO, flags=re.M)
    assert titulos == [(str(n), nombre) for n, nombre in enumerate(APARTADOS, start=1)]
    for numero in range(1, len(APARTADOS) + 1):
        assert len(_apartado(numero).split()) >= 15, APARTADOS[numero - 1]


async def test_no_esconde_nada() -> None:
    """Texto plano, entero y a la vista: ni caracteres invisibles o de control,
    ni marcas de formato, ni comentarios, ni restos de plantilla. Los ÚNICOS
    marcadores son los dos que se ven, entre corchetes."""
    for caracter in TEXTO:
        if caracter != "\n":
            assert unicodedata.category(caracter)[0] != "C", repr(caracter)
            assert unicodedata.category(caracter) not in ("Zl", "Zp"), repr(caracter)
    assert "\t" not in TEXTO and "  " not in TEXTO
    for resto in ("<!--", "-->", "<", ">", "{{", "}}", "TODO", "FIXME", "XXX", "lorem", "Lorem", "**", "##", "`"):
        assert resto not in TEXTO, resto
    marcadores = guion.pendientes(TEXTO)
    assert len(marcadores) == 2 and TEXTO.count("[") == TEXTO.count("]") == 2
    assert marcadores[0].startswith("[BORRADOR PENDIENTE DE REVISIÓN Y APROBACIÓN EMPRESARIAL Y LEGAL")
    assert TEXTO.startswith(marcadores[0])
    assert marcadores[1] == "[CANAL DE SOPORTE PENDIENTE DE COMPLETAR ANTES DE PUBLICAR]"
    assert marcadores[1] in _apartado(16)


async def test_no_inventa_un_canal_de_soporte_ni_un_contacto() -> None:
    assert "@" not in TEXTO and not re.search(r"https?://|www\.|\.com\b|\.pe\b|whatsapp|telegram", TEXTO, flags=re.I)
    assert not re.search(r"\d[\d \-]{6,}", TEXTO), "ningún teléfono ni número largo"
    assert not re.search(r"\b(Av\.|Avenida|Jr\.|Calle)\b", TEXTO)


async def test_no_promete_lo_que_no_existe_ni_se_presenta_como_lo_que_no_es() -> None:
    minusculas = TEXTO.lower()
    for promesa in ("reembols", "garant", "indemniz", "seguro ", "seguros", "póliza", "entidad financiera",
                    "banco", "pasarela", "saldo", "billetera", "legalmente", "por ley", "la ley exige", "obligación legal",
                    "compensa", "reintegr", "resarc", "cobertura", "aseguramos", "nos hacemos responsables"):
        assert promesa not in minusculas, promesa
    # «Devoluciones» solo aparece para decir que NO las hay.
    assert minusculas.count("devoluc") == 1 and "no gestiona devoluciones económicas" in minusculas
    # Lo que el sistema no hace no se promete (hallazgos de la revisión del 02/10/2026): conservar «el
    # tiempo mínimo», avisar de seguridad «en cualquier momento», ni suspender una cuenta cualquiera.
    for de_mas in ("tiempo mínimo necesario", "en cualquier momento", "suspender a un prestador, un servicio o una cuenta",
                   "contenido falso"):
        assert de_mas not in TEXTO, de_mas
    # No oculta que el piloto no procesa dinero: lo dice con todas las letras.
    dinero = _apartado(5)
    # Habla de Z Servicios, no de toda la plataforma (Cursos, Eventos y Productos tienen su propio dinero).
    for frase in ("no hay pagos en Z Servicios", "Por los servicios de este piloto", "no cobra", "ni transfiere dinero", "no cobra comisión",
                  "no emite comprobantes", "no gestiona devoluciones económicas", "servicios gratuitos",
                  "precio a consultar", "es solo información"):
        assert frase in dinero, frase
    assert "como si Z lo hubiera procesado" in dinero


async def test_dice_el_alcance_y_las_reglas_de_la_primera_version() -> None:
    assert "personas mayores de edad" in _apartado(2) and "no la compartas" in _apartado(2)
    alcance = _apartado(4)
    for frase in ("en el Perú", "virtuales o presenciales", "No hay atención a domicilio",
                  "categorías reguladas ni de alto riesgo",
                  # La lista de lo prohibido (P8) tiene que constar en las condiciones.
                  "Están prohibidos", "actividades ilegales", "el fraude", "la falsificación", "las armas",
                  "la explotación de personas", "el contenido sexual", "servicios financieros no autorizados",
                  "riesgo inmediato a una persona"):
        assert frase in alcance, frase
    assert "piloto" in _apartado(1) and "acceso es limitado" in _apartado(1)
    assert "El prestador debe indicar el motivo" in _apartado(7) and "no tiene penalidad económica" in _apartado(7)
    virtuales = _apartado(14)
    for frase in ("no ofrece una sala propia", "no graba", "ni almacena grabaciones", "de forma segura"):
        assert frase in virtuales, frase
    datos = _apartado(13)
    for frase in ("son privados", "enlaces temporales", "conservar solo lo necesario",
                  "se conserva mientras exista tu cuenta", "los plazos de conservación están por definir",
                  "pedir a soporte", "no se elimina de forma automática", "de forma restringida o sin identificarte"):
        assert frase in datos, frase
    for causa in ("seguridad", "fraude", "incumplimiento", "riesgo"):
        assert causa in _apartado(15), causa
    # Lo que Z puede hacer de verdad: suspender prestadores y servicios, y sacar una cuenta del piloto.
    assert "suspender a un prestador o un servicio, y retirar una cuenta del piloto" in _apartado(15)
    # Cambiar el horario y avisar de seguridad, como los deja el servidor.
    assert "mientras el servicio siga publicado y su ficha no haya cambiado" in _apartado(8)
    assert "en una reserva confirmada" in _apartado(10)
    assert "Si el motivo es de seguridad, ese plazo de 48 horas no se aplica" in _apartado(10)
    assert "no se abre otra a la vez, ni después de que Z la decida" in _apartado(10)
    for frase in ("amenazas", "extorsión", "datos personales de otras personas", "discriminación",
                  "afirmaciones falsas", "que no trate de la atención"):
        assert frase in _apartado(12), frase
    assert "no cambia" in _apartado(17) and "versión nueva" in _apartado(17)


async def test_los_plazos_que_dice_son_los_de_la_configuracion_de_fabrica() -> None:
    """Las condiciones no pueden decir una cosa y el servidor hacer otra: cada
    plazo del texto es el valor de fábrica de su ajuste. Cambiar uno sin
    publicar unas condiciones nuevas pone esto en rojo."""
    de_fabrica = {nombre: campo.default for nombre, campo in Settings.model_fields.items()}

    def dice(numero: int, frase: str) -> None:
        assert frase in _apartado(numero), (APARTADOS[numero - 1], frase)

    assert de_fabrica["services_booking_reschedule_max"] == 1
    dice(8, "una vez")
    dice(8, f"al menos {de_fabrica['services_booking_reschedule_min_hours']} horas de anticipación")
    dice(9, f"Desde {de_fabrica['services_attention_checkin_minutes']} minutos antes de la hora de inicio")
    dice(9, f"en las {de_fabrica['services_attention_confirmation_hours']} horas siguientes")
    dice(9, f"pasados {de_fabrica['services_attention_tolerance_minutes']} minutos de la hora de inicio")
    dice(10, f"hasta {de_fabrica['services_incident_window_hours']} horas después del término")
    assert de_fabrica["services_incident_appeals_max"] == 1
    dice(11, "una sola vez")
    dice(11, f"dentro de los {de_fabrica['services_incident_appeal_days']} días siguientes")
    dice(11, "una persona distinta de la que decidió")
    dice(11, "la aplicación no ofrecerá la apelación")
    dice(12, f"hasta {de_fabrica['services_review_window_days']} días después")
    assert de_fabrica["services_reviews_premoderation"] is True
    dice(12, "se revisan antes de publicarse")
    # Y los únicos números del texto son esos y los de los apartados.
    cifras = sorted({int(n) for n in re.findall(r"(?<![\d.])(\d+)(?= (?:minutos|horas|días))", TEXTO)})
    assert cifras == [5, 15, 24, 30, 48]


async def test_el_guion_se_niega_mientras_haya_un_marcador_y_no_abre_conexiones(tmp_path, capsys) -> None:
    salida = tmp_path / "peticion.json"
    assert guion.main(["--salida", str(salida)]) == 1
    assert not salida.exists()
    assert "no se publican" in capsys.readouterr().err
    # Para ensayar sí, y dice que no se publica.
    assert guion.main(["--borrador", "--salida", str(salida)]) == 0
    assert json.loads(salida.read_text(encoding="utf-8")) == {
        "country_code": "PE", "title": guion.TITULO, "body": TEXTO,
    }
    assert "SOLO PARA ENSAYAR" in capsys.readouterr().err
    # Con el texto aprobado (sin marcadores), prepara la petición y dice SU huella.
    aprobado = tmp_path / "aprobado.txt"
    aprobado.write_bytes(_aprobado().replace("\n", "\r\n").encode("utf-8") + b"\r\n")
    assert guion.main(["--texto", str(aprobado), "--salida", str(salida)]) == 0
    assert json.loads(salida.read_text(encoding="utf-8"))["body"] == _aprobado()
    assert politicas.huella(_aprobado()) in capsys.readouterr().out
    # No toca la red, la base ni la configuración.
    fuente = GUION.read_text(encoding="utf-8")
    for prohibido in ("import httpx", "import requests", "urllib", "sqlalchemy", "psycopg", "asyncpg", "from app",
                      "import app", "os.environ", "dotenv"):
        assert prohibido not in fuente, prohibido


def _aprobado() -> str:
    """Como quedaría el texto al aprobarlo: sin la línea del borrador y con el
    canal de soporte que diga la empresa (aquí, uno de prueba)."""
    primera, canal = guion.pendientes(TEXTO)
    return TEXTO.replace(primera, "").replace(canal, "el canal de soporte de prueba").strip()


async def test_un_borrador_con_parametros_o_sin_cuerpo_no_pasa() -> None:
    with pytest.raises(ValidationError):
        PoliticaBorradorCrear(country_code="PE", title=guion.TITULO, body="corto")
    with pytest.raises(politicas.ParametrosInvalidos):
        politicas.validar_parametros({"required_documents": ["identity"]}, "booking_terms")


# =========================================================================== #
# 2. La publicación y la aceptación, por la API real (PostgreSQL)
# =========================================================================== #
async def _vigente(motor) -> tuple | None:
    filas = await _filas(motor, "select id::text, version, body_sha256 from public.service_policies "
                                "where kind = 'booking_terms' and country_code = 'PE' and status = 'published'")
    assert len(filas) <= 1
    return filas[0] if filas else None


async def _sin_condiciones(motor) -> None:
    """Como está producción hoy: ninguna condición de contratación vigente."""
    await _sembrar(motor, "update public.service_policies set status = 'superseded' "
                          "where kind = 'booking_terms' and status = 'published'")
    await _sembrar(motor, "delete from public.service_policies where kind = 'booking_terms' and status = 'draft'")


async def _publicar_las_del_piloto(app, jefa: str, texto: str) -> dict:
    """EL PROCEDIMIENTO del documento, paso a paso: borrador, comprobar la
    huella en la vista previa y, solo entonces, publicar."""
    cuerpo = guion.peticion(texto)
    r = await _pedir(app, "POST", f"{POLITICAS}/booking-terms/draft", jefa, cuerpo)
    assert r.status_code == 201, r.text
    borrador = r.json()
    assert (borrador["status"], borrador["kind"], borrador["country_code"]) == ("draft", "booking_terms", "PE")
    # Pedirlo otra vez devuelve el mismo borrador, sin tocarlo.
    r = await _pedir(app, "POST", f"{POLITICAS}/booking-terms/draft", jefa, {**cuerpo, "body": cuerpo["body"] + " Otra."})
    assert r.status_code == 200 and r.json()["id"] == borrador["id"] and r.json()["body"] == texto, r.text
    vista = await _pedir(app, "GET", f"{POLITICAS}/{borrador['id']}/preview", jefa)
    assert vista.status_code == 200, vista.text
    assert vista.json()["sha256"] == guion.huella(texto) and vista.json()["body"] == texto
    r = await _pedir(app, "POST", f"{POLITICAS}/{borrador['id']}/publish", jefa)
    assert r.status_code == 200, r.text
    return r.json()


async def _con_retencion(app, motor, servicio: str, dias: int = 7) -> tuple[str, str]:
    cliente = await _persona(motor)
    inicio = (await _horarios(app, servicio, _dia(dias)))[0]["starts_at"]
    r = await _retener(app, cliente, servicio, inicio)
    assert r.status_code == 201, r.text
    return cliente, r.json()["id"]


async def _aceptado(motor, reserva_id: str) -> list[tuple]:
    return await _filas(
        motor, "select a.kind, a.policy_id::text, a.policy_version, a.sha256, a.accepted_by::text "
               "from public.service_booking_acceptances a join public.service_bookings b on b.order_id = a.order_id "
               "where b.id = cast(:b as uuid) and a.kind = 'booking_terms'", b=reserva_id)


@SIN_POSTGRES
async def test_el_procedimiento_de_publicacion_de_punta_a_punta(reservas) -> None:  # noqa: F811
    app, motor, _ = reservas
    texto = _aprobado()
    _perfil, servicio, jefa, moderador = await _servicio(app, motor)
    await _sin_condiciones(motor)
    cliente, retencion = await _con_retencion(app, motor, servicio)

    # (a) SIN CONDICIONES PUBLICADAS NO SE RESERVA: el resumen lo dice y confirmar se niega.
    resumen = await _resumen(app, cliente, retencion)
    assert resumen["terms"] is None and resumen["contract"]["terms_available"] is False
    assert resumen["contract"]["confirmable"] is False and "terms_unavailable" in resumen["contract"]["blockers"]
    r = await _confirmar(app, cliente, retencion, {"terms_policy_id": "x" * 36, "terms_sha256": "a" * 64})
    assert r.status_code == 409 and _codigo(r) == "service_booking_terms_unavailable", r.text

    # Solo administración prepara y publica.
    for quien in (cliente, moderador):
        r = await _pedir(app, "POST", f"{POLITICAS}/booking-terms/draft", quien, guion.peticion(texto))
        assert r.status_code == 403, r.text
    antes = await _uno(motor, "select coalesce(max(version), 0) from public.service_policies "
                              "where kind = 'booking_terms' and country_code = 'PE' and category is null")

    # (f) UN BORRADOR NO SE PUEDE ACEPTAR: con su id y su huella, sigue sin haber condiciones.
    r = await _pedir(app, "POST", f"{POLITICAS}/booking-terms/draft", jefa, guion.peticion(texto))
    assert r.status_code == 201, r.text
    borrador = r.json()
    assert (await _resumen(app, cliente, retencion))["terms"] is None
    r = await _confirmar(app, cliente, retencion,
                         {"terms_policy_id": borrador["id"], "terms_sha256": borrador["body_sha256"]})
    assert r.status_code == 409 and _codigo(r) == "service_booking_terms_unavailable", r.text
    await _sembrar(motor, "delete from public.service_policies where id = cast(:p as uuid)", p=borrador["id"])

    publicada = await _publicar_las_del_piloto(app, jefa, texto)
    assert (publicada["status"], publicada["version"]) == ("published", antes + 1)
    assert publicada["body_sha256"] == guion.huella(texto) and publicada["body"] == texto
    assert publicada["title"] == guion.TITULO and publicada["category"] is None
    # Queda en la auditoría quién la publicó (y quién preparó el borrador).
    for accion in ("service_policy.draft_created", "service_policy.published"):
        assert await _uno(motor, "select count(*) from public.audit_events where action = :a "
                                 "and entity_id = cast(:p as uuid) and actor_id = cast(:j as uuid)",
                          a=accion, p=publicada["id"], j=jefa) == 1, accion
    # Publicar otra vez lo mismo no crea otra versión ni cambia la vigente.
    r = await _pedir(app, "POST", f"{POLITICAS}/{publicada['id']}/publish", jefa)
    assert r.status_code == 200 and r.json()["version"] == publicada["version"]
    assert await _vigente(motor) == (publicada["id"], publicada["version"], publicada["body_sha256"])

    # (g) LA PRESENTACIÓN: el resumen enseña el texto entero, su versión y su huella.
    resumen = await _resumen(app, cliente, retencion)
    assert resumen["terms"] == {"policy_id": publicada["id"], "version": publicada["version"],
                                "title": guion.TITULO, "body": texto, "sha256": guion.huella(texto)}
    assert resumen["contract"]["terms_available"] is True

    # (b) LA RESERVA GUARDA VERSIÓN Y HUELLA, las del servidor.
    clave = _clave()
    r = await _confirmar(app, cliente, retencion, _aceptando(resumen), clave=clave)
    assert r.status_code == 201, r.text
    reserva = r.json()
    aceptadas = [a for a in reserva["acceptances"] if a["kind"] == "booking_terms"]
    assert [(a["version"], a["sha256"]) for a in aceptadas] == [(publicada["version"], guion.huella(texto))]
    fila = [("booking_terms", publicada["id"], publicada["version"], guion.huella(texto), cliente)]
    assert await _aceptado(motor, reserva["id"]) == fila
    # (i) UN REINTENTO con la misma clave devuelve la misma reserva y NO crea otra aceptación.
    r = await _confirmar(app, cliente, retencion, _aceptando(resumen), clave=clave)
    assert r.status_code in (200, 201) and r.json()["id"] == reserva["id"], r.text
    assert await _aceptado(motor, reserva["id"]) == fila
    assert await _uno(motor, "select count(*) from public.service_booking_acceptances where accepted_by = cast(:u as uuid)",
                      u=cliente) == len(reserva["acceptances"])

    # (c) (d) UNA VERSIÓN NUEVA no cambia lo ya aceptado ni el texto que se aceptó.
    nueva = await _publicar_las_del_piloto(app, jefa, texto + "\n\n18. OTRA COSA\nUna regla que llega después.")
    assert nueva["version"] == publicada["version"] + 1 and nueva["body_sha256"] != publicada["body_sha256"]
    assert await _aceptado(motor, reserva["id"]) == fila
    assert await _filas(motor, "select status, body_sha256, body = :t from public.service_policies "
                               "where id = cast(:p as uuid)", p=publicada["id"], t=texto) == [
        ("superseded", guion.huella(texto), True)]
    detalle = (await _pedir(app, "GET", f"{MIS_RESERVAS}/{reserva['id']}", cliente)).json()
    assert [(a["version"], a["sha256"]) for a in detalle["acceptances"] if a["kind"] == "booking_terms"] == [
        (publicada["version"], guion.huella(texto))]

    # (f) LA SUSTITUIDA ya no se puede aceptar: hay que leer y aceptar la nueva.
    otro, otra_retencion = await _con_retencion(app, motor, servicio, dias=8)
    r = await _confirmar(app, otro, otra_retencion,
                         {"terms_policy_id": publicada["id"], "terms_sha256": publicada["body_sha256"]})
    assert r.status_code == 409 and _codigo(r) == "service_booking_terms_changed", r.text
    assert r.json()["error"]["details"] == {"kind": "booking_terms", "policy_id": nueva["id"], "version": nueva["version"]}
    assert (await _resumen(app, otro, otra_retencion))["terms"]["version"] == nueva["version"]

    # (f) Y UNA RETIRADA, tampoco: sin vigente, no se reserva.
    await _sembrar(motor, "update public.service_policies set status = 'withdrawn' where id = cast(:p as uuid)", p=nueva["id"])
    assert (await _resumen(app, otro, otra_retencion))["terms"] is None
    r = await _confirmar(app, otro, otra_retencion, {"terms_policy_id": nueva["id"], "terms_sha256": nueva["body_sha256"]})
    assert r.status_code == 409 and _codigo(r) == "service_booking_terms_unavailable", r.text
    assert await _uno(motor, "select count(*) from public.service_bookings where client_id = cast(:u as uuid)", u=otro) == 0


@SIN_POSTGRES
async def test_el_cuerpo_de_la_peticion_no_inventa_la_version_ni_la_huella_ni_acepta_en_silencio(reservas) -> None:  # noqa: F811
    """(e) y (h). Lo que se acepta es lo que el servidor tiene vigente: con
    otra huella, con otro id o con una versión escrita a mano, no se confirma;
    y sin decir qué se acepta, tampoco. Ninguno deja nada escrito."""
    app, motor, _ = reservas
    _perfil, servicio, jefa, _moderador = await _servicio(app, motor)
    await _sin_condiciones(motor)
    publicada = await _publicar_las_del_piloto(app, jefa, _aprobado())
    cliente, retencion = await _con_retencion(app, motor, servicio)
    bueno = _aceptando(await _resumen(app, cliente, retencion))
    assert bueno["terms_policy_id"] == publicada["id"] and bueno["terms_sha256"] == publicada["body_sha256"]

    for cuerpo, estado, codigo in (
        # La vigente con otra huella, y otra política con la huella vigente.
        ({**bueno, "terms_sha256": "0" * 64}, 409, "service_booking_terms_changed"),
        ({**bueno, "terms_policy_id": "00000000-0000-4000-8000-000000000000"}, 409, "service_booking_terms_changed"),
        # Una versión o una huella «a mano»: el cuerpo no tiene esos campos.
        ({**bueno, "terms_version": 99}, 422, "validation_error"),
        ({**bueno, "policy_version": publicada["version"]}, 422, "validation_error"),
        ({**bueno, "sha256": publicada["body_sha256"]}, 422, "validation_error"),
        ({**bueno, "accepted_at": "2020-01-01T00:00:00Z"}, 422, "validation_error"),
        # SIN ACEPTACIÓN NO HAY RESERVA: ni callando, ni a medias, ni vacía.
        ({}, 422, "validation_error"),
        ({"terms_policy_id": bueno["terms_policy_id"]}, 422, "validation_error"),
        ({"terms_sha256": bueno["terms_sha256"]}, 422, "validation_error"),
        ({**bueno, "terms_sha256": ""}, 422, "validation_error"),
        ({**bueno, "terms_policy_id": None}, 422, "validation_error"),
    ):
        r = await _confirmar(app, cliente, retencion, cuerpo)
        assert (r.status_code, _codigo(r)) == (estado, codigo), (cuerpo, r.text)
    r = await _pedir(app, "POST", f"{RETENCIONES}/{retencion}/confirm", cliente, None, _clave())
    assert r.status_code == 422, r.text
    for tabla in ("service_orders", "service_bookings"):
        assert await _uno(motor, f"select count(*) from public.{tabla} where client_id = cast(:u as uuid)", u=cliente) == 0
    assert await _uno(motor, "select count(*) from public.service_booking_acceptances where accepted_by = cast(:u as uuid)",
                      u=cliente) == 0
    # Y con lo que el servidor enseñó, sí.
    assert (await _confirmar(app, cliente, retencion, bueno)).status_code == 201


@SIN_POSTGRES
async def test_dos_publicaciones_a_la_vez_dejan_una_sola_vigente(reservas) -> None:  # noqa: F811
    app, motor, _ = reservas
    _perfil, _servicio_id, jefa, _moderador = await _servicio(app, motor)
    await _sin_condiciones(motor)
    r = await _pedir(app, "POST", f"{POLITICAS}/booking-terms/draft", jefa, guion.peticion(_aprobado()))
    assert r.status_code == 201, r.text
    borrador = r.json()["id"]
    respuestas = await asyncio.gather(*(_pedir(app, "POST", f"{POLITICAS}/{borrador}/publish", jefa) for _ in range(4)))
    assert [r.status_code for r in respuestas] == [200] * 4, [r.text for r in respuestas]
    assert len({r.json()["version"] for r in respuestas}) == 1
    assert (await _vigente(motor))[0] == borrador
    # Dos borradores a la vez: uno solo.
    respuestas = await asyncio.gather(*(
        _pedir(app, "POST", f"{POLITICAS}/booking-terms/draft", jefa, guion.peticion(_aprobado() + f" {n}"))
        for n in range(4)))
    assert sorted(r.status_code for r in respuestas) == [200, 200, 200, 201], [r.text for r in respuestas]
    assert len({r.json()["id"] for r in respuestas}) == 1


@SIN_POSTGRES
async def test_publicar_mientras_alguien_confirma_deja_lo_aceptado_coherente(reservas) -> None:  # noqa: F811
    """Quien confirma mientras se publica una versión nueva: o aceptó la que
    leyó (y así queda escrito), o se le pide que lea la nueva. Nunca una
    reserva con la versión de una y la huella de otra, y nunca un 500."""
    app, motor, _ = reservas
    _perfil, servicio, jefa, _moderador = await _servicio(app, motor)
    await _sin_condiciones(motor)
    primera = await _publicar_las_del_piloto(app, jefa, _aprobado())
    vistos = set()
    for ronda in range(4):
        cliente, retencion = await _con_retencion(app, motor, servicio, dias=7 + ronda)
        leido = await _resumen(app, cliente, retencion)
        r = await _pedir(app, "POST", f"{POLITICAS}/booking-terms/draft", jefa,
                         guion.peticion(_aprobado() + f"\n\nRonda {ronda}."))
        assert r.status_code == 201, r.text
        confirmada, publicada = await asyncio.gather(
            _confirmar(app, cliente, retencion, _aceptando(leido)),
            _pedir(app, "POST", f"{POLITICAS}/{r.json()['id']}/publish", jefa),
        )
        assert publicada.status_code == 200, publicada.text
        assert confirmada.status_code in (201, 409), confirmada.text
        if confirmada.status_code == 201:
            assert await _aceptado(motor, confirmada.json()["id"]) == [
                ("booking_terms", leido["terms"]["policy_id"], leido["terms"]["version"], leido["terms"]["sha256"], cliente)]
        else:
            assert _codigo(confirmada) == "service_booking_terms_changed", confirmada.text
            assert await _uno(motor, "select count(*) from public.service_bookings where client_id = cast(:u as uuid)",
                              u=cliente) == 0
        vistos.add(confirmada.status_code)
        # Toda aceptación escrita casa con SU política: la huella es la de esa versión.
        assert await _uno(motor, "select count(*) from public.service_booking_acceptances a join public.service_policies p "
                                 "on p.id = a.policy_id where a.kind = 'booking_terms' "
                                 "and (a.sha256 <> p.body_sha256 or a.policy_version <> p.version)") == 0
    assert primera["version"] >= 1 and vistos <= {201, 409}
