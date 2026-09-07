"""Lo que NUNCA debe acabar en `audit_events.payload`.

POR QUE ESTE FICHERO EXISTE APARTE. Porque `payload` sale por
`GET /admin/audit-events`: lo que se cuele aqui se sirve por una API. El filtro
es la unica barrera entre «quiero poder reconstruir que paso» y «he archivado la
peticion entera, con su cabecera de autorizacion dentro».

Y porque un fallo aqui NO DA LA CARA. Si el filtro deja de casar, todo sigue
funcionando: las notas se escriben, los endpoints responden y nadie se entera
hasta que alguien mira la tabla. Ya paso una vez: una expresion regular con un
caracter de control invisible dentro dejo de casar ninguna IP y las pruebas de
entonces no lo vieron porque no habia.
"""

from __future__ import annotations

import pytest

from app.modules.gobernanza.auditoria import _limpio
from app.modules.gobernanza.contexto import identificador_admisible


# --------------------------------------------------------------------------- #
# Por el nombre de la clave
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "clave",
    [
        "authorization",
        "AUTHORIZATION",
        "auth_header",
        "cookie",
        "access_token",
        "refresh_token",
        "secret",
        "api_key",
        "apikey",
        "password",
        "clave",
        "signature",
        "firma",
        "client_ip",
        "remote_addr",
        "user_agent",
        "user_email",
        "correo",
        "telefono",
        "phone",
        "dni",
        "direccion",
        "tarjeta",
        "card_last4",
        "raw_body",
    ],
)
def test_una_clave_sensible_no_pasa(clave) -> None:
    """SE COMPARA POR TROZO, no por igualdad.

    Comparando nombres completos, `access_token` pasaba porque no se llama
    `token` a secas. Los nombres reales llevan prefijo casi siempre.
    """
    assert _limpio({clave: "lo que sea", "order_id": "abc"}) == {"order_id": "abc"}


def test_lo_que_si_debe_pasar_pasa() -> None:
    """El filtro no puede ser tan estrecho que vacie la nota.

    Sin identificadores ni codigos, la auditoria no reconstruye nada y se
    convierte en una lista de fechas.
    """
    dentro = {
        "order_id": "0e2f",
        "course_id": "77a1",
        "version": 3,
        "amount_cents": 4900,
        "currency": "PEN",
        "policy_type": "refund_repurchase",
        "status": "paid",
        "activo": True,
        "nada": None,
    }
    assert _limpio(dentro) == dentro


# --------------------------------------------------------------------------- #
# Por la forma del valor
# --------------------------------------------------------------------------- #


def test_una_ip_dentro_de_un_texto_inocente_no_pasa() -> None:
    """Filtrar solo por el nombre deja pasar `{"nota": "vino de 1.2.3.4"}`."""
    assert _limpio({"nota": "vino de 203.0.113.9", "id": "x"}) == {"id": "x"}


def test_un_correo_dentro_de_un_texto_inocente_no_pasa() -> None:
    assert _limpio({"detalle": "aviso a juan@ejemplo.com", "id": "x"}) == {"id": "x"}


def test_un_numero_de_version_corriente_no_se_confunde_con_una_ip() -> None:
    """El filtro no puede ser tan ancho que borre lo util.

    `version 1.2.3` no es una direccion: le faltan grupos. Un numero de version
    normal sobrevive, que es lo que hace la nota legible.
    """
    dentro = {"nota": "version 1.2.3", "sdk": "expo 54.0.12", "n": 4}
    assert _limpio(dentro) == dentro


def test_cuatro_grupos_de_digitos_se_descartan_aunque_sean_una_version() -> None:
    """FALSO POSITIVO A PROPOSITO, y conviene dejarlo escrito.

    `sdk-4.5.6.7-beta` es una version, no una direccion, y aun asi se descarta:
    tiene la forma exacta de una IPv4 y el guion no la separa de nada. Preferir
    perder un dato decorativo antes que guardar una direccion es la decision
    correcta en una tabla que existe para no guardar datos personales.
    """
    assert _limpio({"sdk": "sdk-4.5.6.7-beta", "id": "x"}) == {"id": "x"}


def test_un_correo_dentro_de_una_lista_no_pasa() -> None:
    salida = _limpio({"avisados": ["ana", "juan@ejemplo.com", "luis"]})
    assert salida == {"avisados": ["ana", "luis"]}


# --------------------------------------------------------------------------- #
# En profundidad
# --------------------------------------------------------------------------- #


def test_un_diccionario_anidado_tambien_se_filtra() -> None:
    """FILTRAR SOLO EL PRIMER NIVEL NO SIRVE DE NADA.

    `{"contexto": {"authorization": "..."}}` pasaba entero: el diccionario de
    dentro no se llama como ninguna clave prohibida.
    """
    salida = _limpio(
        {
            "order_id": "abc",
            "contexto": {"authorization": "Bearer x", "remote_addr": "10.0.0.1", "n": 2},
        }
    )
    assert salida == {"order_id": "abc", "contexto": {"n": 2}}


def test_un_documento_hondo_no_cabe_en_una_nota() -> None:
    """Algo con cuatro niveles no es un identificador ni un codigo: es la
    peticion entera, y la peticion entera no se archiva aqui."""
    hondo = {"a": {"b": {"c": {"d": {"secreto_escondido": 1}}}}}
    salida = _limpio(hondo)
    assert "d" not in str(salida)


def test_un_texto_larguisimo_se_recorta() -> None:
    salida = _limpio({"nota": "x" * 5000})
    assert len(salida["nota"]) == 300


def test_sin_payload_no_hay_nota_vacia_rara() -> None:
    assert _limpio(None) == {}
    assert _limpio({}) == {}


# --------------------------------------------------------------------------- #
# El identificador de peticion que viene de fuera
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "valor",
    [
        "hola mundo",
        "a\nb",
        "a\rb",
        "a\x00b",
        "traza-\u00f1",
        "x" * 65,
        "<script>",
        "a;b",
        "",
        None,
    ],
)
def test_un_identificador_impresentable_se_descarta_entero(valor) -> None:
    """SE RECHAZA, NO SE LIMPIA.

    Un valor saneado a medias sigue siendo texto elegido por quien pide, y este
    dato viaja a la tabla de auditoria, a cada linea de registro y de vuelta en
    una cabecera de respuesta. Un salto de linea ahi rompe la lectura del
    registro; algo fuera de latin-1 revienta al escribir la respuesta.
    """
    assert identificador_admisible(valor) is None


@pytest.mark.parametrize(
    "valor",
    [
        "0f8c1e4a9b2d4c3e8f7a6b5c4d3e2f10",
        "01JB4Z7Q9K",
        "req-2026-09-07_01",
        "a.b.c",
    ],
)
def test_un_identificador_razonable_se_conserva(valor) -> None:
    """Lo que generan los proxys habituales sigue valiendo: es lo que permite
    cruzar una incidencia del cliente con la fila de auditoria."""
    assert identificador_admisible(valor) == valor
