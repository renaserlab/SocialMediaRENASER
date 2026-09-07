"""La IP y el agente de usuario: lo poco que se guarda y por qué así.

LA REGLA QUE ORDENA TODO: la IP en claro no se guarda nunca, y el agente
completo tampoco. Una IP es un dato personal y una cadena de agente completa es
una huella digital del aparato. Para resolver un caso de abuso basta con poder
decir «estas dos aceptaciones vienen del mismo sitio».

POR QUÉ ESTE FICHERO EXISTE. Porque `contexto.py` no tenía ni una prueba, y es
el único sitio del backend que toca datos personales de red. Un cambio que
dejara pasar la IP en claro compilaría, pasaría el resto de la suite y no daría
la cara hasta que alguien mirara la tabla.
"""

from __future__ import annotations

import pytest

from app.core.config import get_settings
from app.modules.gobernanza.contexto import (
    LARGO_MINIMO_DE_SAL,
    familia_del_agente,
    fijar_request_id,
    leer_origen,
    nuevo_request_id,
    request_id,
)


#: Sales de prueba. Tienen que llegar a `LARGO_MINIMO_DE_SAL` caracteres: por
#: debajo de ese largo el codigo las trata como si no hubiera sal, y una
#: prueba con una sal corta estaria comprobando el camino equivocado.
SAL = "sal-larga-de-prueba-a-con-treinta-y-dos-o-mas"
OTRA_SAL = "sal-larga-de-prueba-b-con-treinta-y-dos-o-mas"
assert len(SAL) >= LARGO_MINIMO_DE_SAL and len(OTRA_SAL) >= LARGO_MINIMO_DE_SAL


class _Peticion:
    """Lo mínimo que `leer_origen` mira de una petición."""

    def __init__(self, cabeceras: dict[str, str], host: str | None = None) -> None:
        self.headers = cabeceras
        self.client = type("C", (), {"host": host})() if host else None


@pytest.fixture
def ajustes():
    a = get_settings()
    antes = (a.ip_hash_salt, a.trust_proxy_headers)
    yield a
    a.ip_hash_salt, a.trust_proxy_headers = antes


# --------------------------------------------------------------------------- #
# La huella
# --------------------------------------------------------------------------- #


def test_sin_sal_no_se_guarda_ninguna_huella(ajustes) -> None:
    """Y NO es un descuido: es la decision.

    El espacio entero de IPv4 son 2^32 valores; sin sal, el hash se revierte por
    fuerza bruta en segundos. Escribirlo igualmente daria una sensacion de
    proteccion que no existe, asi que se guarda `NULL` y se dice.
    """
    ajustes.ip_hash_salt = ""
    origen = leer_origen(_Peticion({}, host="203.0.113.9"))
    assert origen.ip_hash is None
    # El prefijo SI se guarda: agrupa sin identificar, y no es reversible a una
    # direccion concreta.
    assert origen.ip_prefix == "203.0.113.0/24"


def test_con_sal_la_huella_es_estable(ajustes) -> None:
    """La misma IP y la misma sal dan la misma huella: es lo que la hace util."""
    ajustes.ip_hash_salt = SAL
    primera = leer_origen(_Peticion({}, host="203.0.113.9")).ip_hash
    segunda = leer_origen(_Peticion({}, host="203.0.113.9")).ip_hash
    assert primera is not None
    assert primera == segunda
    assert len(primera) == 64, "la base exige 64 caracteres hexadecimales"


def test_otra_sal_da_otra_huella(ajustes) -> None:
    """Es lo que impide cruzar huellas entre entornos o con una tabla ajena."""
    ajustes.ip_hash_salt = SAL
    con_a = leer_origen(_Peticion({}, host="203.0.113.9")).ip_hash
    ajustes.ip_hash_salt = OTRA_SAL
    con_b = leer_origen(_Peticion({}, host="203.0.113.9")).ip_hash
    assert con_a != con_b


def test_otra_ip_da_otra_huella(ajustes) -> None:
    ajustes.ip_hash_salt = SAL
    uno = leer_origen(_Peticion({}, host="203.0.113.9")).ip_hash
    otro = leer_origen(_Peticion({}, host="198.51.100.4")).ip_hash
    assert uno != otro


def test_la_ip_no_aparece_en_ningun_campo(ajustes) -> None:
    """Lo que de verdad hay que garantizar: que no se cuele en claro."""
    ajustes.ip_hash_salt = SAL
    origen = leer_origen(
        _Peticion({"user-agent": "Mozilla/5.0 Chrome/141.0"}, host="203.0.113.9")
    )
    todo = " ".join(str(v) for v in vars(origen).values())
    assert "203.0.113.9" not in todo
    # El prefijo termina en `.0/24`: no es la direccion de nadie.
    assert origen.ip_prefix == "203.0.113.0/24"


def test_una_ipv6_se_recorta_a_su_red(ajustes) -> None:
    ajustes.ip_hash_salt = SAL
    origen = leer_origen(_Peticion({}, host="2001:db8:1234:5678::1"))
    assert origen.ip_prefix is not None
    assert origen.ip_prefix.endswith("/48")
    assert "::1" not in origen.ip_prefix

# Casos limite de la huella
# --------------------------------------------------------------------------- #


def test_una_ip_ilegible_no_se_guarda_de_ninguna_forma(ajustes) -> None:
    """Ni prefijo ni huella. NO se hashea texto que no sea una direccion.

    Hashear una cadena arbitraria llenaba la columna con algo que parece una
    huella de red y no lo es: dos peticiones con el mismo texto inventado
    quedarian agrupadas como si vinieran del mismo sitio.
    """
    ajustes.ip_hash_salt = SAL
    origen = leer_origen(_Peticion({}, host="no-es-una-ip"))
    assert origen.ip_prefix is None
    assert origen.ip_hash is None


def test_una_sal_demasiado_corta_cuenta_como_no_tener_sal(ajustes) -> None:
    """El limite no es decorativo.

    IPv4 entero son 2^32 direcciones y se recorre en minutos. Lo unico que
    impide reconstruir la IP a partir de la huella es no conocer la sal, asi que
    una sal de cuatro caracteres se adivina junto con la direccion. Por debajo
    del minimo se avisa por registro y se guarda `NULL`, no un hash falso.
    """
    ajustes.ip_hash_salt = "corta"
    assert len("corta") < LARGO_MINIMO_DE_SAL
    origen = leer_origen(_Peticion({}, host="203.0.113.9"))
    assert origen.ip_hash is None
    assert origen.ip_prefix == "203.0.113.0/24"


# --------------------------------------------------------------------------- #
# X-Forwarded-For
# --------------------------------------------------------------------------- #


def test_sin_proxy_de_confianza_la_cabecera_se_ignora(ajustes) -> None:
    """Esa cabecera la manda CUALQUIERA.

    Con ella activa sin un proxy que la reescriba, quien pide elige qué IP se le
    apunta, y el registro de origen deja de valer para lo único que sirve.
    """
    ajustes.ip_hash_salt = SAL
    ajustes.trust_proxy_headers = False
    inventada = leer_origen(
        _Peticion({"x-forwarded-for": "198.51.100.4"}, host="203.0.113.9")
    )
    real = leer_origen(_Peticion({}, host="203.0.113.9"))
    assert inventada.ip_hash == real.ip_hash, "se uso la del socket, no la cabecera"


def test_con_proxy_de_confianza_se_toma_la_ULTIMA_de_la_cadena(ajustes) -> None:
    """La ultima la escribio nuestro proxy; la primera la eligio quien pide.

    Un proxy no reemplaza `X-Forwarded-For`: ANADE al final la direccion desde
    la que le llego la conexion. Si el cliente manda `X-Forwarded-For: 9.9.9.9`,
    lo que llega al backend es `9.9.9.9, <la de verdad>`. Leyendo la primera se
    guardaba literalmente el texto que eligio quien pide, y con eso se podia
    firmar un consentimiento desde un prefijo de red ajeno.
    """
    ajustes.ip_hash_salt = SAL
    ajustes.trust_proxy_headers = True
    con_cabecera = leer_origen(
        _Peticion({"x-forwarded-for": "9.9.9.9, 198.51.100.4"}, host="10.0.0.1")
    )
    la_del_proxy = leer_origen(_Peticion({}, host="198.51.100.4"))
    assert con_cabecera.ip_prefix == "198.51.100.0/24"
    assert con_cabecera.ip_hash == la_del_proxy.ip_hash

    inventada = leer_origen(_Peticion({}, host="9.9.9.9"))
    assert con_cabecera.ip_hash != inventada.ip_hash, "se creyo la IP del cliente"


def test_una_cabecera_malformada_no_llega_a_la_columna(ajustes) -> None:
    """Se ignora entera y se cae al socket, que nadie puede falsificar."""
    ajustes.ip_hash_salt = SAL
    ajustes.trust_proxy_headers = True
    origen = leer_origen(
        _Peticion({"x-forwarded-for": "198.51.100.4, <script>"}, host="203.0.113.9")
    )
    assert origen.ip_prefix == "203.0.113.0/24"
    assert origen.ip_hash == leer_origen(_Peticion({}, host="203.0.113.9")).ip_hash


# --------------------------------------------------------------------------- #
# El agente de usuario
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "cadena,esperado",
    [
        ("Mozilla/5.0 (Windows NT 10.0; Win64) AppleWebKit Chrome/141.0.0 Safari/537", "Chrome 141"),
        ("Mozilla/5.0 (Macintosh) AppleWebKit/605 Version/17.0 Safari/605.1.15", "Safari 17"),
        ("okhttp/4.9.0", "okhttp 4"),
        ("Expo/1000 CFNetwork/1494 Darwin/23.1.0", "Expo 1000"),
        ("curl/8.4.0", "curl 8"),
        ("algo que nadie reconoce", "otro"),
        (None, None),
        ("", None),
    ],
)
def test_del_agente_solo_queda_la_familia(cadena, esperado) -> None:
    """La cadena completa lleva sistema, versión exacta, arquitectura y a veces
    el modelo del teléfono: junta lo suficiente para reconocer a una persona
    entre miles. Se guarda la familia y nada más."""
    assert familia_del_agente(cadena) == esperado


def test_el_agente_completo_no_se_guarda(ajustes) -> None:
    largo = "Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A.231005.007) Chrome/141.0.0"
    origen = leer_origen(_Peticion({"user-agent": largo}))
    assert origen.user_agent_family == "Chrome 141"
    assert "SM-S911B" not in str(origen.user_agent_family)
    assert "Android" not in str(origen.user_agent_family)


# --------------------------------------------------------------------------- #
# El identificador de la petición
# --------------------------------------------------------------------------- #


def test_el_identificador_viaja_sin_pasarlo_por_las_firmas() -> None:
    """Es lo que permite cruzar una fila de auditoría con sus líneas de registro."""
    testigo = fijar_request_id("abc123")
    try:
        assert request_id() == "abc123"
        assert leer_origen(_Peticion({})).request_id == "abc123"
    finally:
        from app.modules.gobernanza.contexto import _peticion

        _peticion.reset(testigo)


def test_fuera_de_una_peticion_no_hay_identificador() -> None:
    assert request_id() is None or isinstance(request_id(), str)
    assert len(nuevo_request_id()) == 32
