"""100ms como proveedor de directo: el contrato, los roles y los avisos.

NADA DE ESTO LLAMA A 100ms. El cliente HTTP se inyecta, así que estas pruebas
comprueban lo que hacemos con lo que contesta el proveedor, no que el proveedor
conteste. Una prueba que salga a la red del tercero falla los lunes por motivos
que no son nuestros.

LO QUE SE PROTEGE AQUÍ:

1. Que sin configuración completa no se emita ni una credencial.
2. Que el rol lo decida el servidor y no la petición.
3. Que dos peticiones simultáneas no creen dos salas.
4. Que un aviso repetido, tardío o desordenado no cambie nada.
5. Que no se le filtre al cliente nada de la cuenta.
"""

from __future__ import annotations

import json

import httpx
import jwt
import pytest

from app.core.config import get_settings
from app.modules.live import providers, roles, webhooks
from app.modules.live.hms_client import (
    Cliente100ms,
    Configuracion100ms,
    ErrorDe100ms,
    token_de_administracion,
    token_de_sala,
)
from app.modules.live.proveedor_100ms import Proveedor100ms, traducir_error

CONFIG = Configuracion100ms(
    access_key="clave_de_prueba",
    app_secret="secreto_de_prueba",
    template_id="plantilla_de_prueba",
    api_base="https://api.100ms.test/v2",
)


class _Http:
    """Un cliente HTTP que contesta lo que se le diga y apunta lo que le piden."""

    def __init__(self, respuestas: list[httpx.Response]) -> None:
        self.respuestas = respuestas
        self.peticiones: list[tuple[str, str, dict | None]] = []

    async def request(self, metodo, url, *, json=None, params=None, **_kw):
        self.peticiones.append((metodo, url, json or params))
        if not self.respuestas:
            raise AssertionError(f"peticion inesperada: {metodo} {url}")
        return self.respuestas.pop(0)


def _respuesta(codigo: int, cuerpo: dict | None = None) -> httpx.Response:
    return httpx.Response(
        codigo,
        json=cuerpo if cuerpo is not None else {},
        request=httpx.Request("POST", "https://api.100ms.test/v2/rooms"),
    )


def _proveedor(respuestas: list[httpx.Response]) -> tuple[Proveedor100ms, _Http]:
    http = _Http(respuestas)
    return Proveedor100ms(CONFIG, cliente=Cliente100ms(CONFIG, cliente_http=http)), http


# --------------------------------------------------------------------------- #
# 1. Sin configuración no se hace nada
# --------------------------------------------------------------------------- #


def test_de_fabrica_no_hay_proveedor_real():
    """El estado de fábrica: el módulo entero funciona sin imagen."""
    assert providers.registrar_desde_configuracion() == "none"
    assert providers.hay_proveedor_real() is False


@pytest.mark.parametrize(
    "falta", ["hms_app_access_key", "hms_app_secret", "hms_template_id"]
)
def test_una_configuracion_a_medias_no_registra_nada(falta):
    """Con la clave puesta y la plantilla sin poner, crear una sala falla a
    mitad de camino y deja una emisión sin sala. Es preferible no empezar."""
    ajustes = get_settings()
    previos = {
        c: getattr(ajustes, c)
        for c in (
            "feature_live", "live_provider",
            "hms_app_access_key", "hms_app_secret", "hms_template_id",
        )
    }
    ajustes.feature_live = True
    ajustes.live_provider = "100ms"
    ajustes.hms_app_access_key = "x"
    ajustes.hms_app_secret = "y"
    ajustes.hms_template_id = "z"
    setattr(ajustes, falta, "")
    try:
        assert ajustes.live_configurado is False
        assert providers.registrar_desde_configuracion() == "none"
    finally:
        for clave, valor in previos.items():
            setattr(ajustes, clave, valor)
        providers.registrar_desde_configuracion()


def test_con_la_bandera_apagada_no_se_registra_aunque_haya_claves():
    """La bandera es la última palabra: apagarla corta sin borrar credenciales."""
    ajustes = get_settings()
    previos = (ajustes.feature_live, ajustes.live_provider,
               ajustes.hms_app_access_key, ajustes.hms_app_secret,
               ajustes.hms_template_id)
    ajustes.feature_live = False
    ajustes.live_provider = "100ms"
    ajustes.hms_app_access_key = "x"
    ajustes.hms_app_secret = "y"
    ajustes.hms_template_id = "z"
    try:
        assert providers.registrar_desde_configuracion() == "none"
        assert providers.hay_proveedor_real() is False
    finally:
        (ajustes.feature_live, ajustes.live_provider, ajustes.hms_app_access_key,
         ajustes.hms_app_secret, ajustes.hms_template_id) = previos
        providers.registrar_desde_configuracion()


@pytest.mark.asyncio
async def test_el_marcador_de_posicion_no_finge_una_emision():
    """Falla explícitamente en vez de simular. Es el error que llevó a borrar
    la pantalla de directo anterior."""
    marcador = providers.ProveedorNoConfigurado()
    with pytest.raises(NotImplementedError):
        await marcador.abrir_sala(session_id="s1", titulo="t")
    with pytest.raises(NotImplementedError):
        await marcador.credencial(room_id="r", user_id="u", puede_emitir=True)
    # Cerrar lo que nunca se abrió NO es un error: no queda nada abierto.
    assert await marcador.cerrar_sala(room_id="r") is None
    estado = await marcador.estado_de_sala(room_id="r")
    assert (estado.existe, estado.activa) == (False, False)


# --------------------------------------------------------------------------- #
# 2. Los roles los decide el servidor
# --------------------------------------------------------------------------- #


def test_el_propietario_manda_sobre_ser_administracion():
    """Quien emite es el anfitrión de lo suyo, no un moderador de su sala."""
    assert roles.resolver(user_id="ana", host_id="ana", es_admin=True) is roles.RolDeZ.PROPIETARIO


def test_administracion_entra_como_moderadora_solo_si_se_pide():
    assert roles.resolver(user_id="jefa", host_id="ana", es_admin=True) is roles.RolDeZ.MODERADOR
    assert roles.resolver(user_id="jefa", host_id="ana") is roles.RolDeZ.ESPECTADOR


def test_un_invitado_publica_y_un_cualquiera_no():
    invitados = frozenset({"bruno"})
    assert roles.resolver(user_id="bruno", host_id="ana", invitados=invitados) is roles.RolDeZ.INVITADO
    assert roles.resolver(user_id="carla", host_id="ana", invitados=invitados) is roles.RolDeZ.ESPECTADOR


@pytest.mark.parametrize(
    "rol,publica,modera",
    [
        (roles.RolDeZ.PROPIETARIO, True, True),
        (roles.RolDeZ.MODERADOR, True, True),
        (roles.RolDeZ.INVITADO, True, False),
        (roles.RolDeZ.ESPECTADOR, False, False),
    ],
)
def test_quien_publica_y_quien_modera(rol, publica, modera):
    assert roles.puede_publicar(rol) is publica
    assert roles.puede_moderar(rol) is modera


@pytest.mark.asyncio
async def test_un_espectador_no_puede_pedir_ser_anfitrion():
    """EL CASO QUE IMPORTA. El rol va FIRMADO dentro del token; lo que mande el
    cliente no entra aquí. Aunque alguien lograra colar `rol='host'`, el token
    lo firma el servidor con lo que el servidor decidió."""
    proveedor, _ = _proveedor([])
    credencial = await proveedor.credencial(
        room_id="room_1", user_id="carla", puede_emitir=False,
        rol=roles.nombre_en_el_proveedor(roles.RolDeZ.ESPECTADOR),
    )
    reclamos = jwt.decode(credencial.token, CONFIG.app_secret, algorithms=["HS256"])
    assert reclamos["role"] == "viewer"
    assert reclamos["user_id"] == "carla"
    assert reclamos["room_id"] == "room_1"
    assert credencial.puede_emitir is False


@pytest.mark.asyncio
async def test_sin_rol_se_cae_al_mas_restrictivo():
    """Equivocarse hacia «espectador» cuesta que alguien no hable; hacia
    «anfitrión», que cualquiera publique en la sala de otro."""
    proveedor, _ = _proveedor([])
    credencial = await proveedor.credencial(
        room_id="room_1", user_id="carla", puede_emitir=False
    )
    reclamos = jwt.decode(credencial.token, CONFIG.app_secret, algorithms=["HS256"])
    assert reclamos["role"] == "viewer"


def test_un_rol_desconocido_cae_a_espectador():
    assert roles.nombre_en_el_proveedor("lo_que_sea") == "viewer"  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# 3. Los tokens
# --------------------------------------------------------------------------- #


def test_el_token_de_sala_va_acotado_y_caduca():
    token = token_de_sala(
        CONFIG, room_id="r1", user_id="u1", rol="host", ttl_segundos=600
    )
    reclamos = jwt.decode(token, CONFIG.app_secret, algorithms=["HS256"])
    assert reclamos["type"] == "app"
    assert reclamos["version"] == 2
    assert reclamos["exp"] - reclamos["iat"] == 600
    # `nbf` con margen: dos relojes no coinciden al segundo y un `nbf` en el
    # futuro hace que el proveedor rechace el token entero.
    assert reclamos["nbf"] <= reclamos["iat"]


def test_un_ttl_ridiculo_se_sube_a_un_minimo():
    """Un token de un segundo no sirve para conectarse a nada."""
    token = token_de_sala(CONFIG, room_id="r", user_id="u", rol="viewer", ttl_segundos=1)
    reclamos = jwt.decode(token, CONFIG.app_secret, algorithms=["HS256"])
    assert reclamos["exp"] - reclamos["iat"] >= 60


def test_el_token_de_administracion_no_lleva_sala_ni_persona():
    """Da acceso a TODA la cuenta: no se guarda, no se registra, no se entrega."""
    reclamos = jwt.decode(
        token_de_administracion(CONFIG), CONFIG.app_secret, algorithms=["HS256"]
    )
    assert reclamos["type"] == "management"
    assert "room_id" not in reclamos and "user_id" not in reclamos


def test_dos_tokens_seguidos_no_son_el_mismo():
    """Cada uno con su `jti`: reutilizar el identificador impediría revocarlos
    de uno en uno el día que haga falta."""
    uno = jwt.decode(token_de_administracion(CONFIG), CONFIG.app_secret, algorithms=["HS256"])
    otro = jwt.decode(token_de_administracion(CONFIG), CONFIG.app_secret, algorithms=["HS256"])
    assert uno["jti"] != otro["jti"]


# --------------------------------------------------------------------------- #
# 4. Una sala por emisión, pase lo que pase
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_si_la_sala_ya_existe_no_se_crea_otra():
    """Doble pulsación, reintento tras un timeout, dos procesos: una sala."""
    proveedor, http = _proveedor([
        _respuesta(200, {"data": [{"id": "room_1", "name": "sesion_1"}]}),
    ])
    sala = await proveedor.abrir_sala(session_id="sesion_1", titulo="Charla")
    assert sala.room_id == "room_1"
    # Solo consultó; no creó nada.
    assert [m for m, _u, _c in http.peticiones] == ["GET"]


@pytest.mark.asyncio
async def test_si_no_existe_se_crea_con_el_id_de_la_emision_como_nombre():
    """El nombre ES la idempotencia: 100ms rechaza el repetido, no nosotros."""
    proveedor, http = _proveedor([
        _respuesta(200, {"data": []}),
        _respuesta(200, {"id": "room_nuevo"}),
    ])
    sala = await proveedor.abrir_sala(session_id="sesion_1", titulo="Charla")
    assert sala.room_id == "room_nuevo"
    _metodo, _url, cuerpo = http.peticiones[-1]
    assert cuerpo["name"] == "sesion_1"
    assert cuerpo["template_id"] == "plantilla_de_prueba"


@pytest.mark.asyncio
async def test_dos_procesos_a_la_vez_acaban_con_la_misma_sala():
    """El caso real: entre nuestra consulta y nuestra creación se cuela otro.

    100ms rechaza el nombre repetido; se recoge el choque y se recupera la que
    ganó. Las dos peticiones acaban con la misma sala, que es lo que importa.
    """
    proveedor, _ = _proveedor([
        _respuesta(200, {"data": []}),           # no existe
        _respuesta(409, {"message": "taken"}),   # otro la creó entre medias
        _respuesta(200, {"data": [{"id": "room_del_otro", "name": "sesion_1"}]}),
    ])
    sala = await proveedor.abrir_sala(session_id="sesion_1", titulo="Charla")
    assert sala.room_id == "room_del_otro"


@pytest.mark.asyncio
async def test_una_sala_creada_sin_identificador_es_un_error():
    """No se inventa uno: sin identificador no hay sala a la que volver."""
    proveedor, _ = _proveedor([
        _respuesta(200, {"data": []}),
        _respuesta(200, {}),
    ])
    with pytest.raises(ErrorDe100ms):
        await proveedor.abrir_sala(session_id="sesion_1", titulo="Charla")


@pytest.mark.asyncio
async def test_cerrar_dos_veces_no_falla():
    """Terminar una emisión no puede depender de que el proveedor responda: si
    fallara, la sala se quedaría «en directo» para siempre en la pantalla de
    todo el mundo."""
    # Cada cierre son dos llamadas: vaciar la sala activa y deshabilitarla. La
    # segunda vez ya no hay nadie dentro ni sala que deshabilitar: dos 404.
    proveedor, _ = _proveedor(
        [_respuesta(200, {}), _respuesta(200, {}), _respuesta(404, {}), _respuesta(404, {})]
    )
    assert await proveedor.cerrar_sala(room_id="room_1") is None
    assert await proveedor.cerrar_sala(room_id="room_1") is None


@pytest.mark.asyncio
async def test_terminar_echa_a_quien_sigue_dentro_y_despues_deshabilita():
    """Deshabilitar solo cierra la puerta a quien llega: el público que ya
    estaba seguía viendo —y la sala facturando— hasta cerrar la app."""
    proveedor, http = _proveedor([_respuesta(200, {}), _respuesta(200, {})])
    await proveedor.cerrar_sala(room_id="room_1")
    assert http.peticiones == [
        (
            "POST",
            "https://api.100ms.test/v2/active-rooms/room_1/end-room",
            {"reason": "La transmisión terminó.", "lock": True},
        ),
        ("POST", "https://api.100ms.test/v2/rooms/room_1", {"enabled": False}),
    ]


@pytest.mark.asyncio
async def test_sin_nadie_dentro_se_deshabilita_igual():
    """100ms contesta 404 a `end-room` cuando no hay sesión activa: es lo normal
    al terminar una emisión que ya se había vaciado, no un fallo."""
    proveedor, http = _proveedor([_respuesta(404, {}), _respuesta(200, {})])
    assert await proveedor.cerrar_sala(room_id="room_1") is None
    assert [url for _m, url, _c in http.peticiones][-1].endswith("/rooms/room_1")


@pytest.mark.asyncio
async def test_si_vaciar_falla_por_red_se_deshabilita_igual():
    """Si la primera llamada no responde, la segunda es la que impide que entre
    alguien más."""
    class _PrimeroCae:
        def __init__(self) -> None:
            self.peticiones: list[str] = []

        async def request(self, metodo, url, **_kw):
            self.peticiones.append(url)
            if url.endswith("/end-room"):
                raise httpx.ConnectTimeout("sin respuesta")
            return _respuesta(200, {})

    http = _PrimeroCae()
    proveedor = Proveedor100ms(CONFIG, cliente=Cliente100ms(CONFIG, cliente_http=http))
    assert await proveedor.cerrar_sala(room_id="room_1") is None
    assert http.peticiones[-1].endswith("/rooms/room_1")


@pytest.mark.asyncio
async def test_cerrar_sin_sala_no_llama_a_nadie():
    proveedor, http = _proveedor([])
    await proveedor.cerrar_sala(room_id="")
    assert http.peticiones == []


@pytest.mark.asyncio
async def test_una_sala_que_ya_no_existe_se_dice_en_vez_de_reventar():
    proveedor, _ = _proveedor([_respuesta(404, {})])
    estado = await proveedor.estado_de_sala(room_id="room_1")
    assert (estado.existe, estado.activa) == (False, False)


@pytest.mark.asyncio
async def test_un_timeout_no_se_confunde_con_un_fallo():
    """Un tiempo de espera agotado no dice si la sala se creó."""
    class _Cae:
        async def request(self, *_a, **_k):
            raise httpx.ConnectTimeout("sin respuesta")

    proveedor = Proveedor100ms(
        CONFIG, cliente=Cliente100ms(CONFIG, cliente_http=_Cae())
    )
    with pytest.raises(ErrorDe100ms) as fallo:
        await proveedor.abrir_sala(session_id="s", titulo="t")
    assert fallo.value.codigo == "network_timeout"


# --------------------------------------------------------------------------- #
# 5. Los errores no filtran nada de la cuenta
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "estado,codigo,esperado",
    [
        (None, "network_timeout", "live_provider_unavailable"),
        (None, "unreadable_response", "live_provider_unavailable"),
        (404, "http_404", "live_room_missing"),
        (401, "http_401", "live_provider_not_configured"),
        (403, "http_403", "live_provider_not_configured"),
        (429, "http_429", "live_provider_busy"),
        (500, "http_500", "live_provider_error"),
    ],
)
def test_los_errores_se_traducen(estado, codigo, esperado):
    interno, mensaje = traducir_error(
        ErrorDe100ms("lo que sea", codigo=codigo, estado=estado)
    )
    assert interno == esperado
    # Nada de la cuenta ni del proveedor sale hacia quien mira la pantalla.
    for prohibido in ("100ms", "plantilla", "template", "access_key", CONFIG.app_secret):
        assert prohibido.lower() not in mensaje.lower()


@pytest.mark.asyncio
async def test_una_respuesta_ilegible_no_se_da_por_buena():
    respuesta = httpx.Response(
        200, content=b"<html>mantenimiento</html>",
        request=httpx.Request("GET", "https://api.100ms.test/v2/rooms"),
    )
    proveedor, _ = _proveedor([respuesta])
    with pytest.raises(ErrorDe100ms) as fallo:
        await proveedor.estado_de_sala(room_id="r")
    assert fallo.value.codigo == "unreadable_response"


@pytest.mark.asyncio
async def test_el_secreto_no_viaja_en_la_credencial_QUE_FIRMA_EL_PROVEEDOR():
    """La credencial de VERDAD, la que sale del adaptador.

    ANTES ESTA PRUEBA ERA UNA TAUTOLOGIA: construía a mano un `Credencial(token="t")`
    y comprobaba que el secreto no estaba dentro. Comparaba dos constantes que
    nadie había tocado, así que habría pasado igual aunque `Proveedor100ms`
    metiera el secreto en el token.

    Ahora se pide de verdad y se mira lo que sale.
    """
    proveedor, _ = _proveedor([])
    credencial = await proveedor.credencial(
        room_id="room_1", user_id="ana", puede_emitir=True, rol="host"
    )
    serializado = json.dumps(credencial.__dict__)
    for prohibido in (CONFIG.app_secret, CONFIG.access_key, CONFIG.template_id):
        assert prohibido not in serializado

    # Y DENTRO DEL TOKEN tampoco: va firmado CON el secreto, no lo lleva.
    reclamos = jwt.decode(credencial.token, CONFIG.app_secret, algorithms=["HS256"])
    for prohibido in (CONFIG.app_secret, CONFIG.template_id):
        assert prohibido not in json.dumps(reclamos)
    # La clave de acceso SI viaja: 100ms la necesita para saber de qué cuenta es
    # el token, y es pública. El secreto es lo que no puede salir.
    assert reclamos["access_key"] == CONFIG.access_key

    # Y el token no se puede falsificar sin el secreto.
    with pytest.raises(jwt.InvalidSignatureError):
        jwt.decode(credencial.token, "otro_secreto", algorithms=["HS256"])


# --------------------------------------------------------------------------- #
# 6. Los avisos del proveedor
# --------------------------------------------------------------------------- #


def test_un_aviso_sin_autorizacion_se_rechaza():
    with pytest.raises(webhooks.WebhookInvalido):
        webhooks.verificar(cabeceras={}, secreto="s3cr3to")


def test_sin_secreto_configurado_no_se_acepta_ninguno():
    """Dejar la puerta abierta «hasta que se configure» convierte esta URL en la
    forma más cómoda de cerrarle la emisión a cualquiera."""
    with pytest.raises(webhooks.WebhookInvalido):
        webhooks.verificar(cabeceras={"Authorization": "s3cr3to"}, secreto="")


def test_una_autorizacion_que_no_cuadra_se_rechaza():
    with pytest.raises(webhooks.WebhookInvalido):
        webhooks.verificar(cabeceras={"Authorization": "otra"}, secreto="s3cr3to")


@pytest.mark.parametrize("cabecera", ["s3cr3to", "Bearer s3cr3to", "  s3cr3to  "])
def test_la_autorizacion_correcta_pasa(cabecera):
    """El panel de 100ms deja escribir la cabecera entera, así que se admite
    tanto el secreto pelado como con el prefijo."""
    webhooks.verificar(cabeceras={"authorization": cabecera}, secreto="s3cr3to")


def test_la_cabecera_no_distingue_mayusculas():
    webhooks.verificar(cabeceras={"AUTHORIZATION": "s3cr3to"}, secreto="s3cr3to")


def test_un_aviso_que_no_nos_incumbe_se_ignora():
    """Ignorar no es fallar: un aviso que no entendemos no puede mover nada."""
    proveedor, _ = _proveedor([])
    assert proveedor.interpretar_evento({"type": "algo.que.no.existe"}) is None
    assert proveedor.interpretar_evento({}) is None


def test_un_aviso_de_cierre_se_traduce_con_su_emision():
    proveedor, _ = _proveedor([])
    evento = proveedor.interpretar_evento({
        "id": "evt_1",
        "type": "session.close.success",
        "timestamp": "2026-01-01T00:00:00Z",
        "data": {"room_id": "room_1", "room_name": "sesion_1", "session_id": "ses_1"},
    })
    assert evento is not None
    assert evento.significado == "sesion_cerrada"
    # El NOMBRE de la sala es nuestro identificador de emisión: así se vuelve
    # de un aviso del proveedor a una fila nuestra.
    assert evento.session_id == "sesion_1"
    assert evento.event_id == "evt_1"


def test_un_aviso_sin_datos_no_inventa_una_emision():
    proveedor, _ = _proveedor([])
    evento = proveedor.interpretar_evento({"id": "e", "type": "session.close.success"})
    assert evento is not None
    assert evento.session_id == ""
