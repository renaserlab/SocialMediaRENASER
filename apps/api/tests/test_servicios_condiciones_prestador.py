"""Las Condiciones del prestador de Z Servicios (piloto gratuito v1): el texto
y su publicación.

El texto está en `docs/Z_SERVICIOS_CONDICIONES_PRESTADOR_V1.txt`. Es el que
acepta quien presta ANTES de enviar su postulación (`provider_terms`); el de
`Z_SERVICIOS_CONDICIONES_PILOTO_V1.txt` lo acepta quien contrata. Se publica
con las rutas de administración que ya existían, sin tabla ni migración
nuevas.

LO QUE SE COMPRUEBA, con la aplicación de verdad (y sin PostgreSQL: la
admisión corre en los dos motores):

  * el texto: entero, sin marcadores, sin nada escondido, con el canal de
    soporte que la aplicación ya tiene, sin prometer lo que no existe, y con
    la huella que consta en su documento;
  * el recorrido: sin condiciones publicadas no se postula; se publican con el
    guion; no hay aceptación silenciosa; no se acepta una versión inventada,
    sustituida, retirada o en borrador; la aceptación guarda versión y huella;
    y una versión nueva no cambia lo que ya se aceptó.
"""

from __future__ import annotations

import re

import pytest
from sqlalchemy import select, update

from app.modules.services import politicas
from app.modules.services.models import (
    ServicePolicy,
    ServiceProviderApplication,
    ServiceProviderApplicationSubmission,
)
from app.modules.services.schemas import PoliticaBorradorCrear
from tests.test_servicios_admision_api import (  # noqa: F401 - montajes compartidos
    ADMIN,
    JEFA,
    MIA,
    MODERADOR,
    OTRA,
    PDF,
    PRESTADORA,
    RESUMEN,
    TERMINOS,
    _codigo,
    _como,
    _documento,
    almacen,
    encendida,
    entorno,
)
from tests.test_servicios_condiciones_piloto import (
    RAIZ,
    guion,
    provisional_y_sin_presumir,
    publicador,
    sin_nada_escondido,
    solo_el_canal_de_la_app,
)

pytestmark = pytest.mark.asyncio

DOCUMENTO = RAIZ / "docs" / "Z_SERVICIOS_CONDICIONES_PRESTADOR_V1.md"
DATOS = guion.CONDICIONES["prestador"]
TEXTO = guion.leer(DATOS.texto)
HUELLA = guion.huella(TEXTO)
POLITICAS = f"{ADMIN}/policies"
#: Los diecinueve apartados, en orden.
APARTADOS = (
    "NATURALEZA DEL PILOTO", "QUIÉN PUEDE SER PRESTADOR", "INDEPENDENCIA", "EXACTITUD DE LO QUE PUBLICAS",
    "EXPERIENCIA Y CREDENCIALES", "SERVICIOS QUE NO SE ADMITEN", "PUBLICACIÓN Y MODERACIÓN", "AGENDA",
    "LA ATENCIÓN", "SERVICIOS VIRTUALES", "ATENCIÓN PRESENCIAL", "CANCELACIONES, INASISTENCIAS E INCIDENCIAS",
    "CONTENIDO E IMÁGENES", "DATOS PERSONALES DE QUIEN CONTRATA", "RESEÑAS", "SUSPENSIÓN", "BAJA DE LA CUENTA",
    "SOPORTE", "VIGENCIA Y CAMBIOS",
)


def _apartado(numero: int) -> str:
    inicio = TEXTO.index(f"\n{numero}. {APARTADOS[numero - 1]}\n")
    fin = TEXTO.index(f"\n{numero + 1}. ", inicio) if numero < len(APARTADOS) else len(TEXTO)
    return TEXTO[inicio:fin]


# =========================================================================== #
# 1. El texto
# =========================================================================== #
async def test_el_texto_cabe_en_una_politica_y_llega_al_servidor_tal_cual() -> None:
    cuerpo = guion.peticion(TEXTO, "prestador")
    validado = PoliticaBorradorCrear(**cuerpo)
    assert validado.title == DATOS.titulo == "Condiciones del prestador de Z Servicios — Piloto gratuito v1"
    assert (validado.country_code, validado.category, validado.parameters) == ("PE", None, {})
    assert validado.body == TEXTO and HUELLA == politicas.huella(validado.body)
    assert (DATOS.tipo, DATOS.ruta) == ("provider_terms", "provider-terms")
    # Sin parámetros: en el piloto no se exige más que lo mínimo, y volver a
    # postular tras un rechazo sigue sin decidirse (no se inventa).
    assert politicas.validar_parametros(validado.parameters, "provider_terms") == {}


async def test_la_huella_es_la_que_consta_en_el_documento() -> None:
    documento = DOCUMENTO.read_text(encoding="utf-8")
    assert f"`{HUELLA}`" in documento and f"{len(TEXTO)} caracteres" in documento


async def test_los_diecinueve_apartados_estan_y_en_orden() -> None:
    titulos = re.findall(r"^(\d+)\. ([^\n]+)$", TEXTO, flags=re.M)
    assert titulos == [(str(n), nombre) for n, nombre in enumerate(APARTADOS, start=1)]
    assert TEXTO.startswith("CONDICIONES DEL PRESTADOR DE Z SERVICIOS — PILOTO GRATUITO V1\n")
    for numero in range(1, len(APARTADOS) + 1):
        assert len(_apartado(numero).split()) >= 15, APARTADOS[numero - 1]


async def test_no_esconde_nada_el_canal_es_el_de_la_app_y_es_provisional() -> None:
    sin_nada_escondido(TEXTO)
    solo_el_canal_de_la_app(TEXTO, _apartado(18))
    provisional_y_sin_presumir(TEXTO)


async def test_dice_lo_que_tiene_que_decir_y_nada_que_el_sistema_no_haga() -> None:
    def dice(numero: int, *frases: str) -> None:
        for frase in frases:
            assert frase in _apartado(numero), (APARTADOS[numero - 1], frase)

    dice(1, "piloto gratuito y cerrado", "no hay pagos dentro de Z Servicios", "no cobra comisión",
         "solo se reservan servicios gratuitos", "cambiar, suspender o dar por terminado")
    dice(2, "persona natural o como empresa", "persona adulta", "real, estar actualizada y poder comprobarse",
         "una sola identidad")
    dice(3, "por cuenta propia", "no es tu empleador ni tu representante")
    dice(4, "tienen que ser verdaderos", "información engañosa", "corrígelo")
    dice(5, "que tienes de verdad", "Una credencial vencida deja de mostrarse como vigente")
    dice(6, "ilegales, peligrosos, fraudulentos o discriminatorios", "servicios sexuales", "suplanten una identidad",
         "propiedad intelectual", "emergencias", "médicos, legales o financieros", "menores de edad")
    dice(7, "se revisan antes de publicarse", "suspender, retirar u ocultar",
         "su propia postulación ni su propio servicio", "no es una sanción económica")
    dice(8, "disponibilidad al día", "Respeta las reservas confirmadas", "hasta antes de su hora de inicio",
         "explicar el motivo")
    dice(9, "puntualidad", "código de asistencia", "no pidas datos que no necesitas")
    dice(10, "todavía no ofrece una sala propia", "de forma segura", "no publiques enlaces privados",
         "Z no graba", "consentimiento expreso")
    dice(11, "lugar seguro", "No publiques un domicilio particular", "no hay atención a domicilio")
    dice(12, "Conserva la evidencia", "No manipules evidencias ni declaraciones")
    dice(13, "propios o que tengas autorización", "Sigues siendo el titular", "solo le das el permiso necesario")
    dice(14, "solo para prestarle el servicio", "No los vendas, no los publiques")
    dice(15, "No fabriques reseñas", "ni recompenses", "responder una vez", "se moderan")
    dice(16, "fraude", "identidad falsa", "documentación inválida", "cancelaciones reiteradas", "trato abusivo")
    dice(17, "no se elimina de forma automática", "La eliminación no es inmediata", "todavía está pendiente")
    dice(19, "de forma expresa", "su versión y su huella", "no cambia lo que ya aceptaste")
    # Lo que el sistema no hace no se promete.
    minusculas = TEXTO.lower()
    for de_mas in ("z garantiza", "z verific", "cumplimiento legal", "cumple con la ley", "protección total",
                   "sala de z", "grabación de z", "a domicilio se", "comisión del", "factura", "comprobante", "igv",
                   "impuesto", "tribut"):
        assert de_mas not in minusculas, de_mas


async def test_los_dos_textos_dicen_lo_mismo_donde_coinciden() -> None:
    """Quien presta y quien contrata leen reglas compatibles."""
    del_piloto = guion.leer(guion.CONDICIONES["contratacion"].texto)
    for texto in (TEXTO, del_piloto):
        assert "renaserlab@gmail.com" in texto and "«Soporte y preguntas frecuentes»" in texto
        assert "atención a domicilio" in texto and "menores de edad" in texto
        assert "no se elimina de forma automática" in texto and "sala propia" in texto
    # El prestador da el motivo al cancelar, y la cancelación llega hasta la hora de inicio: en los dos.
    assert "El prestador debe indicar el motivo" in del_piloto and "explicar el motivo" in TEXTO
    assert "hasta antes de su hora de inicio" in del_piloto and "hasta antes de su hora de inicio" in TEXTO


# =========================================================================== #
# 2. La publicación y la aceptación, por la API real
# =========================================================================== #
def _pedir_como(http, quien: dict, uid: str):
    async def pedir(metodo: str, ruta: str, cuerpo: dict | None):
        anterior = quien["uid"]
        _como(quien, uid)
        try:
            r = await http.request(metodo, ruta, json=cuerpo)
        finally:
            _como(quien, anterior)
        try:
            return r.status_code, r.json()
        except ValueError:
            return r.status_code, None

    return pedir


async def _postulando(http, quien, uid: str = PRESTADORA) -> None:
    """Una postulación con todo menos las condiciones."""
    _como(quien, uid)
    r = await http.post(MIA, json={"provider_type": "individual", "display_name": "Ana Guitarra"})
    assert r.status_code in (200, 201), r.text
    r = await http.patch(MIA, json={"legal_name": "Ana María Quispe", "country_code": "PE", "summary": RESUMEN})
    assert r.status_code == 200, r.text
    assert (await _documento(http)).status_code in (200, 201)


async def _aceptar(http, **cuerpo):
    return await http.post(f"{MIA}/terms", json=cuerpo)


async def _enviar(http):
    return await http.post(f"{MIA}/submit", json={"declare_truthfulness": True})


async def test_el_recorrido_de_publicacion_y_aceptacion_de_punta_a_punta(entorno, encendida, almacen) -> None:  # noqa: F811
    http, quien, sesiones, _ = entorno
    await _postulando(http, quien)

    # SIN CONDICIONES PUBLICADAS NO SE POSTULA: ni se pueden leer, ni se envía.
    r = await http.get(TERMINOS)
    assert r.status_code == 409 and _codigo(r) == "provider_terms_not_published", r.text
    r = await _enviar(http)
    assert r.status_code == 422 and "provider_terms_not_published" in r.json()["error"]["details"]["missing"], r.text

    # UN BORRADOR NO SE PUEDE ACEPTAR: sigue sin haber condiciones.
    dicho: list[str] = []
    hecho = await publicador.publicar(_pedir_como(http, quien, JEFA), "prestador", de_verdad=False, decir=dicho.append)
    assert hecho == {"estado": "draft_ready", "version": 1, "huella": HUELLA}
    async with sesiones() as db:
        borrador = (await db.scalars(select(ServicePolicy))).one()
    assert (borrador.status, borrador.kind, borrador.body_sha256) == ("draft", "provider_terms", HUELLA)
    assert (await http.get(TERMINOS)).status_code == 409
    r = await _aceptar(http, terms_policy_id=borrador.id, terms_sha256=HUELLA)
    assert r.status_code == 409 and _codigo(r) == "provider_terms_not_published", r.text

    # Solo administración publica: moderación no, y quien postula tampoco.
    for uid in (MODERADOR, PRESTADORA):
        with pytest.raises(publicador.NoSePublica):
            await publicador.publicar(_pedir_como(http, quien, uid), "prestador", de_verdad=True, decir=dicho.append)
    hecho = await publicador.publicar(_pedir_como(http, quien, JEFA), "prestador", de_verdad=True, decir=dicho.append)
    assert hecho == {"estado": "published", "version": 1, "huella": HUELLA}
    assert "NATURALEZA DEL PILOTO" not in "\n".join(dicho) and HUELLA in "\n".join(dicho)

    # LO QUE SE ENSEÑA es el texto entero, con su versión y su huella.
    terminos = (await http.get(TERMINOS)).json()
    assert (terminos["version"], terminos["sha256"], terminos["title"], terminos["body"]) == (
        1, HUELLA, DATOS.titulo, TEXTO)
    assert terminos["policy_id"] == borrador.id and terminos["country_code"] == "PE"

    # NO HAY ACEPTACIÓN SILENCIOSA: sin aceptarlas, la postulación no se envía.
    r = await _enviar(http)
    assert r.status_code == 422 and "provider_terms_not_accepted" in r.json()["error"]["details"]["missing"], r.text
    # Ni con una huella inventada, ni con otro id, ni escribiendo la versión a mano, ni a medias.
    for cuerpo, estado in (
        ({"terms_policy_id": terminos["policy_id"], "terms_sha256": "0" * 64}, 409),
        ({"terms_policy_id": "00000000-0000-4000-8000-000000000000", "terms_sha256": HUELLA}, 409),
        ({"terms_policy_id": terminos["policy_id"], "terms_sha256": HUELLA, "terms_version": 7}, 422),
        ({"terms_policy_id": terminos["policy_id"]}, 422),
        ({"terms_sha256": HUELLA}, 422),
        ({}, 422),
    ):
        r = await _aceptar(http, **cuerpo)
        assert r.status_code == estado, (cuerpo, r.text)
    assert "provider_terms_not_accepted" in (await http.get(MIA)).json()["missing"]

    # CON LA VIGENTE, SÍ; y la aceptación guarda la versión y la huella del servidor.
    r = await _aceptar(http, terms_policy_id=terminos["policy_id"], terms_sha256=HUELLA)
    assert r.status_code == 200 and r.json()["terms"]["version"] == 1, r.text
    assert (await _enviar(http)).status_code == 200
    async with sesiones() as db:
        solicitud = (await db.scalars(select(ServiceProviderApplication))).one()
        envio = (await db.scalars(select(ServiceProviderApplicationSubmission))).one()
    assert (solicitud.terms_policy_id, solicitud.terms_sha256) == (borrador.id, HUELLA)
    assert solicitud.terms_accepted_at is not None
    assert (envio.terms_policy_id, envio.terms_version, envio.terms_sha256) == (borrador.id, 1, HUELLA)

    # UNA VERSIÓN NUEVA no cambia lo que ya se aceptó ni el texto que se aceptó.
    _como(quien, JEFA)
    r = await http.post(f"{POLITICAS}/provider-terms/draft",
                        json={"country_code": "PE", "title": DATOS.titulo, "body": TEXTO + "\n\n20. OTRA COSA\nUna regla posterior."})
    assert r.status_code == 201, r.text
    nueva = r.json()
    assert (await http.post(f"{POLITICAS}/{nueva['id']}/publish")).status_code == 200
    async with sesiones() as db:
        anterior = await db.get(ServicePolicy, borrador.id)
        solicitud = (await db.scalars(select(ServiceProviderApplication))).one()
        envio = (await db.scalars(select(ServiceProviderApplicationSubmission))).one()
    assert (anterior.status, anterior.body_sha256, anterior.body) == ("superseded", HUELLA, TEXTO)
    assert (solicitud.terms_policy_id, solicitud.terms_sha256) == (borrador.id, HUELLA)
    assert (envio.terms_policy_id, envio.terms_version, envio.terms_sha256) == (borrador.id, 1, HUELLA)

    # LA SUSTITUIDA ya no se acepta: otra persona tiene que leer la nueva.
    await _postulando(http, quien, OTRA)
    r = await _aceptar(http, terms_policy_id=borrador.id, terms_sha256=HUELLA)
    assert r.status_code == 409 and _codigo(r) == "provider_terms_changed", r.text
    assert (await http.get(TERMINOS)).json()["version"] == 2

    # Y UNA RETIRADA, tampoco: sin vigente, no se postula.
    async with sesiones() as db:
        await db.execute(update(ServicePolicy).where(ServicePolicy.id == nueva["id"]).values(status="withdrawn"))
        await db.commit()
    assert (await http.get(TERMINOS)).status_code == 409
    r = await _aceptar(http, terms_policy_id=nueva["id"], terms_sha256=nueva["body_sha256"])
    assert r.status_code == 409 and _codigo(r) == "provider_terms_not_published", r.text
    r = await _enviar(http)
    assert r.status_code == 422 and "provider_terms_not_published" in r.json()["error"]["details"]["missing"]


async def test_publicar_dos_veces_no_crea_otra_version(entorno, encendida) -> None:  # noqa: F811
    http, quien, sesiones, _ = entorno
    pedir = _pedir_como(http, quien, JEFA)
    primera = await publicador.publicar(pedir, "prestador", de_verdad=True, decir=lambda _: None)
    segunda = await publicador.publicar(pedir, "prestador", de_verdad=True, decir=lambda _: None)
    assert primera["estado"] == "published" and segunda == {**primera, "estado": "already_published"}
    async with sesiones() as db:
        politicas_guardadas = (await db.scalars(select(ServicePolicy))).all()
    assert [(p.kind, p.status, p.version) for p in politicas_guardadas] == [("provider_terms", "published", 1)]
