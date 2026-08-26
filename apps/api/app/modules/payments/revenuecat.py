"""Cliente servidor a servidor de RevenueCat (Developer API v2).

## Por que existe

Un «exito» del cliente no concede nada. La aplicacion movil, cuando la compra
sale bien, solo DISPARA una sincronizacion: es este modulo el que le pregunta a
RevenueCat, con la clave secreta y desde el servidor, que compras tiene de
verdad ese `appUserID`. Lo que diga RevenueCat es lo que se apunta; lo que diga
el telefono no se mira.

## Contra que se ha escrito

Documentacion vigente el 26/08/2026, verificada contra la especificacion
OpenAPI que publica RevenueCat (`Developer API 2.0.0`), no de memoria:

- Base `https://api.revenuecat.com/v2`, cabecera `Authorization: Bearer sk_...`.
- `GET /projects/{project_id}/customers/{customer_id}/purchases`
  → lista paginada `{object, items, next_page, url}` con `starting_after` y
  `limit` (1..100, se recorta sola).
- Cada `purchase` trae: `id`, `customer_id`, `original_customer_id`,
  `product_id`, `purchased_at` (ms desde epoch), `quantity`, `status`
  (**solo** `owned` | `refunded`), `environment` (`production` | `sandbox`),
  `store` (`amazon`, `app_store`, `mac_app_store`, `play_store`,
  `promotional`, `stripe`, `rc_billing`, `external`, `roku`, `paddle`,
  `paypal`, `galaxy`, `test_store`), `store_purchase_identifier` y `ownership`
  (`purchased` | `family_shared`).
- **`product_id` NO es el identificador de la tienda.** Es el id interno de
  RevenueCat (`prod1a2b3c4d5e`). El que hay que casar contra
  `provider_products.external_product_id` es `store_identifier`, y vive en
  `GET /projects/{project_id}/products/{product_id}`. Confundirlos es el error
  silencioso mas facil de cometer aqui: casaria siempre a cero y nadie
  recibiria nunca su curso.

## Lo que NO hace

No se llama en cada peticion de video. Se llama al sincronizar (compra,
restauracion, arranque de sesion) y el resultado se persiste en
`entitlements`. RevenueCat limita el dominio de informacion de cliente a 480
peticiones por minuto y por proyecto; el de configuracion, a 60.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx

logger = logging.getLogger("renaser.payments")

#: Cuanto se espera a RevenueCat. Es una llamada dentro de una peticion de la
#: aplicacion: si tarda mas que esto, mejor fallar y que se reintente que dejar
#: a alguien mirando una rueda.
ESPERA_MAXIMA = 12.0

#: Como se traduce la tienda de RevenueCat al `provider` del contrato
#: (`revenuecat_test`, `google`, `apple`, `stripe`).
_TIENDA_A_PROVEEDOR: dict[str, str] = {
    "play_store": "google",
    "app_store": "apple",
    "mac_app_store": "apple",
    "test_store": "revenuecat_test",
}

#: Y a que canal se apunta el pedido. `test_store` no dice de que plataforma
#: viene, asi que ahi manda lo que declare el cliente (es una etiqueta, no un
#: permiso: no decide nada sobre el acceso).
_TIENDA_A_CANAL: dict[str, str] = {
    "play_store": "android",
    "app_store": "ios",
    "mac_app_store": "ios",
}


class RevenueCatError(RuntimeError):
    """No se pudo preguntar a RevenueCat, o contesto algo que no se entiende.

    Se distingue de «este usuario no tiene compras»: sin respuesta NO se revoca
    nada. Tratar un fallo de red como «no tiene nada» le quitaria el curso a
    quien lo pago en cuanto RevenueCat tuviera un mal minuto.
    """


@dataclass(frozen=True)
class CompraDeTienda:
    """Una compra real, tal y como la ve RevenueCat. Ya traducida."""

    #: `store_purchase_identifier`. Es el identificador de la transaccion en la
    #: tienda y lo que da idempotencia junto a (provider, environment).
    external_transaction_id: str
    #: `store_identifier` del producto: lo que se casa contra
    #: `provider_products.external_product_id`.
    store_product_id: str
    #: 'revenuecat_test' | 'google' | 'apple' | ...
    provider: str
    #: 'sandbox' | 'production'
    environment: str
    #: 'ios' | 'android' | None si la tienda no lo dice (Test Store).
    canal: str | None
    #: True si RevenueCat dice `status == 'refunded'`.
    devuelta: bool
    #: 'purchased' | 'family_shared'
    ownership: str
    purchased_at: datetime | None

    @property
    def concede(self) -> bool:
        """Si esta compra deberia dar acceso.

        Una devuelta, no. Y una compartida en familia tampoco, de momento: el
        uso compartido familiar se activa producto a producto en App Store
        Connect y hoy no esta activado en ninguno, asi que esto solo puede
        llegar por sorpresa. Se prefiere no conceder y enterarse por el registro
        a regalar cursos sin haberlo decidido.
        """
        return not self.devuelta and self.ownership == "purchased"


def _fecha(ms: object) -> datetime | None:
    if not isinstance(ms, (int, float)):
        return None
    return datetime.fromtimestamp(ms / 1000, tz=UTC)


class RevenueCatClient:
    """Habla con la API v2. Una instancia por peticion.

    `cliente_http` se inyecta para poder simular la FRONTERA del proveedor en
    las pruebas —un `httpx.MockTransport`— sin salir a la red de verdad.
    """

    def __init__(
        self,
        *,
        secret_api_key: str,
        project_id: str,
        base_url: str = "https://api.revenuecat.com/v2",
        cliente_http: httpx.AsyncClient | None = None,
    ) -> None:
        if not secret_api_key or not project_id:
            raise RevenueCatError(
                "Faltan REVENUECAT_SECRET_API_KEY o REVENUECAT_PROJECT_ID."
            )
        if not secret_api_key.startswith("sk_"):
            # Las claves publicas del SDK (appl_, goog_, test store...) no
            # sirven aqui y ademas no deberian existir en el servidor. Fallar
            # pronto y con nombre propio ahorra depurar un 401 opaco.
            raise RevenueCatError(
                "REVENUECAT_SECRET_API_KEY no parece una clave secreta: las "
                "secretas empiezan por 'sk_'. Nunca uses aqui la clave publica "
                "del SDK."
            )
        self._key = secret_api_key
        self._project = project_id
        self._base = base_url.rstrip("/")
        self._http = cliente_http
        #: product_id de RevenueCat -> store_identifier. El catalogo cambia
        #: poco y el dominio de configuracion solo admite 60 peticiones por
        #: minuto, asi que no se pregunta dos veces por lo mismo.
        self._productos: dict[str, str | None] = {}

    async def _pedir(self, ruta: str, params: dict[str, object] | None = None) -> dict:
        cabeceras = {
            "Authorization": f"Bearer {self._key}",
            "Accept": "application/json",
        }
        url = ruta if ruta.startswith("http") else f"{self._base}{ruta}"
        try:
            if self._http is not None:
                respuesta = await self._http.get(
                    url, params=params, headers=cabeceras, timeout=ESPERA_MAXIMA
                )
            else:  # pragma: no cover - salida real, no se ejerce en pruebas
                async with httpx.AsyncClient(timeout=ESPERA_MAXIMA) as cliente:
                    respuesta = await cliente.get(url, params=params, headers=cabeceras)
        except httpx.HTTPError as error:
            raise RevenueCatError(f"RevenueCat no responde: {error}") from error

        if respuesta.status_code == 404:
            # Cliente desconocido en RevenueCat: no es un fallo, es que esa
            # persona no ha comprado nunca. Se devuelve lista vacia mas arriba.
            return {}
        if respuesta.status_code >= 400:
            raise RevenueCatError(
                f"RevenueCat respondio {respuesta.status_code} a {ruta}."
            )
        try:
            cuerpo = respuesta.json()
        except ValueError as error:
            raise RevenueCatError("RevenueCat devolvio algo que no es JSON.") from error
        return cuerpo if isinstance(cuerpo, dict) else {}

    async def _store_identifier(self, product_id: str) -> str | None:
        """El identificador EN LA TIENDA de un producto de RevenueCat."""
        if product_id in self._productos:
            return self._productos[product_id]
        cuerpo = await self._pedir(f"/projects/{self._project}/products/{product_id}")
        identificador = cuerpo.get("store_identifier")
        valor = identificador if isinstance(identificador, str) and identificador else None
        self._productos[product_id] = valor
        if valor is None:
            logger.warning(
                "[pagos] el producto %s de RevenueCat no tiene store_identifier",
                product_id,
            )
        return valor

    async def compras(
        self, app_user_id: str, *, canal_declarado: str | None = None
    ) -> list[CompraDeTienda]:
        """Todas las compras de ese `appUserID`, devoluciones incluidas.

        Se piden TODAS, no solo las vigentes, porque una devuelta es justo la
        que hay que ver para revocar. Se recorre la paginacion entera: quedarse
        en la primera pagina significaria que a partir de la compra numero 100
        alguien deja de recibir lo que pago.
        """
        recogidas: list[CompraDeTienda] = []
        ruta: str | None = f"/projects/{self._project}/customers/{app_user_id}/purchases"
        params: dict[str, object] | None = {"limit": 100}
        vueltas = 0
        while ruta and vueltas < 50:
            vueltas += 1
            cuerpo = await self._pedir(ruta, params)
            elementos = cuerpo.get("items")
            if not isinstance(elementos, list):
                break
            for bruto in elementos:
                compra = await self._traducir(bruto, canal_declarado)
                if compra is not None:
                    recogidas.append(compra)
            siguiente = cuerpo.get("next_page")
            if not isinstance(siguiente, str) or not siguiente:
                break
            # `next_page` ya viene con su query montada; volver a mandar
            # `params` duplicaria el limite y perderia el cursor.
            ruta = siguiente if siguiente.startswith("http") else f"{self._base}{siguiente.removeprefix('/v2')}"
            params = None
        return recogidas

    async def _traducir(
        self, bruto: object, canal_declarado: str | None
    ) -> CompraDeTienda | None:
        if not isinstance(bruto, dict):
            return None
        transaccion = bruto.get("store_purchase_identifier")
        producto = bruto.get("product_id")
        tienda = bruto.get("store")
        entorno = bruto.get("environment")
        if not all(isinstance(v, str) and v for v in (producto, tienda, entorno)):
            return None
        # El OpenAPI lo declara string, pero el ejemplo de la propia
        # documentacion lo pinta como numero. Se acepta lo que venga y se
        # normaliza a texto: es una clave, no una cantidad.
        if transaccion is None or transaccion == "":
            return None
        proveedor = _TIENDA_A_PROVEEDOR.get(tienda)
        if proveedor is None:
            # amazon, stripe, rc_billing, promotional... No son nuestro flujo
            # nativo. No se ignoran en silencio: si algun dia aparecen es que
            # alguien configuro una tienda que no esperabamos.
            logger.info("[pagos] compra de RevenueCat en tienda no soportada: %s", tienda)
            return None
        store_product_id = await self._store_identifier(producto)
        if store_product_id is None:
            return None
        return CompraDeTienda(
            external_transaction_id=str(transaccion),
            store_product_id=store_product_id,
            provider=proveedor,
            environment=entorno,
            canal=_TIENDA_A_CANAL.get(tienda) or canal_declarado,
            devuelta=bruto.get("status") == "refunded",
            ownership=str(bruto.get("ownership") or "purchased"),
            purchased_at=_fecha(bruto.get("purchased_at")),
        )
