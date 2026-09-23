"""Configuracion central del backend RENASER.

Todas las variables se leen de entorno (.env en desarrollo). Los secretos
(SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET, DATABASE_URL) SOLO viven aqui,
en el backend. Nunca en la app movil ni en git.
"""

from functools import lru_cache
from typing import ClassVar, Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

Environment = Literal["development", "staging", "production"]


class Settings(BaseSettings):
    # --- App ---
    app_name: str = "RENASER Social Media API"
    environment: Environment = "development"
    api_v1_prefix: str = "/api/v1"

    # --- Base de datos (Supabase PostgreSQL = unica fuente de verdad) ---
    # Ej: postgresql+asyncpg://postgres:<pwd>@db.<ref>.supabase.co:5432/postgres
    # En desarrollo sin Supabase, arranca con SQLite para poder levantar la app.
    database_url: str = "sqlite+aiosqlite:///./renaser_dev.db"

    # --- Supabase ---
    supabase_url: str = ""
    supabase_anon_key: str = ""
    # Secreto: solo backend. Da acceso saltandose RLS.
    supabase_service_role_key: str = ""

    # --- Validacion de JWT emitido por Supabase Auth ---
    # HS256 usa el "JWT secret" del proyecto (Settings > API > JWT Settings).
    # Nota: NO es la service_role key ni la anon key.
    supabase_jwt_secret: str = ""
    supabase_jwt_algorithm: str = "HS256"
    supabase_jwt_audience: str = "authenticated"
    # Opcional para verificar el emisor: https://<ref>.supabase.co/auth/v1
    supabase_jwt_issuer: str = ""

    # --- Pagos ---
    #: Portal de pagos de los cursos. APAGADO por defecto: el modulo esta
    #: construido pero no hay pasarela elegida, y un cobro que no se completa es
    #: motivo de rechazo en las tiendas. Encenderlo exige haber implementado un
    #: PaymentProvider real (ver modules/payments/providers.py).
    payments_enabled: bool = False

    #: A donde vuelve el usuario despues de pagar. Es una pagina de la WEB, no
    #: de la app: cobrar dentro de la aplicacion obliga a usar las compras
    #: integradas de Apple y Google, con su comision.
    payments_return_url: str = "https://social-media-renaser.vercel.app/pago"

    #: A donde vuelve quien CANCELA el pago en Stripe. Distinta de la anterior a
    #: proposito: volver a la pagina de "gracias por tu compra" despues de darle
    #: a cancelar es mentirle a la persona sobre lo que acaba de pasar.
    payments_cancel_url: str = "https://social-media-renaser.vercel.app/pago/cancelado"

    #: Donde se verifica un certificado. Es una pagina de la WEB porque el
    #: destinatario de un certificado —una empresa, alguien que contrata— no
    #: tiene la aplicacion instalada, y pedirle que se la instale para
    #: comprobar un codigo es no ofrecer verificacion.
    certificates_verify_url: str = (
        "https://social-media-renaser.vercel.app/verificar"
    )

    # --- Eventos ---
    #: Cuanto espera una reserva a que se suelte el cerrojo del evento, en
    #: milisegundos. CERO lo desactiva.
    #:
    #: Sin limite, dos peticiones por el mismo evento esperan indefinidamente y
    #: cada una ocupa una conexion del pool: un evento popular con gente
    #: reintentando encadena esperas hasta agotarlo, y entonces se para la API
    #: entera y no ese evento. Cinco segundos es mucho mas de lo que tarda una
    #: reserva y mucho menos de lo que aguanta quien mira la pantalla.
    #:
    #: Se aplica con `SET LOCAL`, asi que vale para ESA transaccion y no cambia
    #: nada en la base.
    inventory_lock_timeout_ms: int = 5000

    #: La venta de entradas de eventos. APAGADA: el flujo esta construido hasta
    #: la reserva temporal, pero no hay cobro, ni entrada emitida, ni
    #: liquidacion. Encenderla sin eso ofreceria un carrito que no lleva a
    #: ninguna parte.
    feature_event_ticketing: bool = False

    #: Cobrar una entrada de evento. SEPARADA de `feature_event_ticketing` a
    #: propósito: apagarla detiene la VENTA y deja intactos los tipos de
    #: entrada, la disponibilidad y las reservas temporales, que siguen siendo
    #: útiles sin cobro. Y separada de las de Cursos, cuya semántica es otra:
    #: allí `stripe_payments_enabled` gobierna la compra de un curso.
    #:
    #: APAGADA NO PARA EL DINERO YA EN CURSO. Un webhook verificado de una orden
    #: que ya se inició se sigue procesando: apagar la venta significa «no se
    #: abren cobros nuevos», no «el que pagó se queda sin su entrada».
    feature_event_payments: bool = False

    #: Qué pasarela cobra las entradas: `none` o `stripe`. Con `none` no se
    #: puede iniciar un pago, y decirlo es más honesto que fallar al llamar.
    event_payments_provider: str = "none"


    # --- Pagos: nativo (RevenueCat) ---
    #: Verificacion servidor a servidor de las compras de las tiendas. APAGADA
    #: por defecto. Mientras este en false, `POST /payments/native/sync`
    #: responde 503 y NO concede nada: un "exito" del cliente jamas basta.
    revenuecat_verification_enabled: bool = False

    #: Webhook de RevenueCat. Bandera propia y aparte porque todavia no sabemos
    #: si vamos a tener webhooks configurados. Las devoluciones NO dependen de
    #: el: la reconciliacion de `native/sync` ya revoca por su cuenta.
    revenuecat_webhook_enabled: bool = False

    #: Clave SECRETA de RevenueCat (prefijo `sk_`). Solo backend. Jamas con
    #: prefijo EXPO_PUBLIC_: con ella se pueden conceder entitlements y borrar
    #: subscriptores de todo el proyecto.
    revenuecat_secret_api_key: str = ""
    #: Identificador del proyecto en RevenueCat (`proj...`). La API v2 va
    #: siempre acotada a un proyecto.
    revenuecat_project_id: str = ""
    #: Secreto compartido que se declara en el webhook de RevenueCat y llega en
    #: la cabecera Authorization. Sin el, el webhook no se acepta.
    revenuecat_webhook_secret: str = ""
    #: Base de la API v2. Se deja configurable para poder apuntarla a un doble
    #: en las pruebas de integracion sin tocar codigo.
    revenuecat_api_base: str = "https://api.revenuecat.com/v2"

    # --- Pagos: web (Stripe) ---
    #: Cobro por Stripe Checkout alojado. APAGADO por defecto. Solo WEB: en el
    #: movil se compra con las tiendas, y meter Stripe ahi es motivo de rechazo.
    stripe_payments_enabled: bool = False
    #: Secretos de Stripe. Solo backend, nunca en el cliente.
    stripe_secret_key: str = ""
    stripe_webhook_secret: str = ""
    stripe_api_base: str = "https://api.stripe.com"

    # --- Devoluciones y liquidacion al propietario (migracion 0049) ---
    #: Garantia de 7 dias y solicitudes de devolucion. APAGADO por defecto.
    #:
    #: Apagarlo NO borra historial ni revoca accesos: solo deja de arrancar
    #: garantias nuevas y de aceptar solicitudes. Lo ya concedido sigue.
    feature_course_refunds: bool = False
    #: Ejecutar el reembolso CONTRA LA PASARELA. Separado del anterior a
    #: proposito: con el primero encendido y este apagado, todo el circuito
    #: interno —solicitud, revision, aprobacion— se puede probar de punta a
    #: punta sin que salga un euro de ninguna cuenta.
    stripe_refunds_enabled: bool = False
    #: Cuentas conectadas de los propietarios. APAGADO.
    stripe_connect_enabled: bool = False
    #: Transferir de verdad a los propietarios. APAGADO, y ademas exige que la
    #: comision este configurada: sin ella no hay neto que transferir.
    creator_transfers_enabled: bool = False

    #: Comision de la plataforma, en PUNTOS BASICOS (100 = 1 %).
    #:
    #: `-1` significa SIN CONFIGURAR, y es el valor de fabrica. No es cero: con
    #: cero, olvidarse de ponerla haria que Z se quedara con nada y transfiriera
    #: el bruto, y ese error no lo delata ninguna prueba porque el resultado
    #: cuadra. Con `-1` las transferencias quedan bloqueadas hasta que alguien
    #: decida el numero, que es una decision de negocio y no de despliegue.
    platform_fee_bps: int = -1
    #: Version de las reglas de comision. Se guarda en cada venta para que
    #: cambiarlas no reescriba lo ya liquidado.
    fee_rules_version: str = "v1"

    # ----------------------------------------------------------------- #
    # Transmisiones en vivo
    # ----------------------------------------------------------------- #

    #: PRODUCTOS FISICOS. Encendida, el catalogo se puede mirar: portada,
    #: busqueda, categorias y ficha. NO habilita comprar nada.
    #:
    #: Nace ENCENDIDA porque un catalogo de solo lectura no promete nada: lo que
    #: promete es el boton de comprar, y ese esta en la otra bandera. Y si no
    #: hay migraciones aplicadas la portada contesta `disponible: false` sola.
    feature_products: bool = True

    #: VENDER UN PRODUCTO FISICO. APAGADA, y no hay codigo detras: no existen
    #: carrito, pedido, existencias, envio ni devolucion de productos.
    #:
    #: SEPARADA DE `feature_products` a proposito. Ademas de que falta el
    #: codigo, faltan decisiones de la empresa sin las cuales no se puede
    #: vender: entidad legal que emite el comprobante, paises, impuestos,
    #: transportista, cobertura, tarifas de envio y moneda. Encenderla no haria
    #: que se pudiera comprar; solo dejaria de ser verdad que no se puede.
    feature_product_sales: bool = False

    #: CUANTOS MINUTOS APARTA UN PEDIDO SU INVENTARIO antes de vencer.
    #:
    #: CERO SIGNIFICA «SIN CONFIGURAR», Y SIN CONFIGURAR NO SE VENDE. No hay
    #: numero de fabrica a proposito: cuanto tiempo se le guarda a alguien la
    #: ultima unidad mientras paga es una decision comercial —afecta a cuantas
    #: ventas se pierden y a cuanto stock queda congelado— y escribir aqui «15»
    #: seria tomarla en nombre de la empresa, en silencio y para siempre.
    #:
    #: Las pruebas lo fijan explicitamente. Un despliegue tiene que ponerlo.
    product_reservation_minutes: int = 0

    #: Interruptor general de los directos CON VIDEO. Apagado, el modulo entero
    #: sigue funcionando —sala, chat, reacciones, moderacion— y lo unico que no
    #: hay es imagen: es exactamente el estado en el que lleva viviendo el
    #: modulo desde que se escribio.
    feature_live: bool = False

    #: Quien sirve el video. `none` es el marcador de posicion que falla en
    #: cerrado; `100ms` es el primer proveedor real.
    live_provider: str = "none"

    #: Credenciales de 100ms. SOLO BACKEND: la clave secreta firma los tokens de
    #: sala, asi que meterla en la aplicacion seria repartir la llave con la que
    #: cualquiera se declara anfitrion de la emision de otro.
    hms_app_access_key: str = ""
    hms_app_secret: str = ""
    #: La plantilla decide roles, calidad y grabacion. Sin ella no se puede
    #: crear una sala, y suponerla seria crear salas con permisos por defecto.
    hms_template_id: str = ""
    #: Lo que se compara con la cabecera de autorizacion de los webhooks.
    hms_webhook_secret: str = ""
    hms_region: str = ""
    hms_api_base: str = "https://api.100ms.live/v2"

    #: Cuanto dura la credencial de sala. Corta a proposito: un permiso eterno
    #: es una llave que se reenvia por mensaje y sigue abriendo mañana.
    live_credential_ttl_seconds: int = 3600

    #: Techo de emisiones simultaneas. Existe para que un fallo o un abuso no se
    #: traduzca en una factura: cada sala viva cuesta minutos de proveedor.
    live_max_concurrent: int = 3
    #: Duracion maxima de una emision. Pasada, se puede cerrar por conciliacion.
    live_max_duration_minutes: int = 180

    @property
    def live_configurado(self) -> bool:
        """Si hay con que hablarle al proveedor de verdad.

        Se comprueba entero y no por partes: con la clave puesta y la plantilla
        sin poner, crear una sala falla a mitad de camino y deja una emision sin
        sala. Es preferible no empezar.
        """
        if not self.feature_live or self.live_provider != "100ms":
            return False
        return bool(
            (self.hms_app_access_key or "").strip()
            and (self.hms_app_secret or "").strip()
            and (self.hms_template_id or "").strip()
        )

    @property
    def reserva_de_productos_configurada(self) -> bool:
        """Si la duracion de la reserva esta decidida. Sin ella no se vende.

        El tope de arriba no es una regla comercial: esta para que un despiste
        —un valor en segundos, o en dias— no deje inventario apartado durante
        semanas sin que nadie se entere.
        """
        return 1 <= self.product_reservation_minutes <= 1440

    @property
    def venta_de_productos_habilitada(self) -> bool:
        """Si HOY se puede cobrar un producto fisico. Todas, no una.

        CINCO CONDICIONES, Y ENCENDER UNA NO BASTA. Estan escritas juntas aqui
        para que nadie pueda habilitar la venta tocando un solo interruptor, y
        para que la razon por la que no se puede se pueda contar entera.
        """
        return bool(
            self.feature_product_sales
            and self.payments_enabled
            and self.stripe_payments_enabled
            and self.reserva_de_productos_configurada
            and (self.stripe_secret_key or "").strip()
        )

    @property
    def comision_configurada(self) -> bool:
        """Si hay comision valida. Sin ella no se transfiere nada."""
        return 0 <= self.platform_fee_bps <= 10_000

    # ----------------------------------------------------------------- #
    # Contexto de las peticiones (0050)
    # ----------------------------------------------------------------- #

    #: Sal para la huella de la IP que se guarda con un consentimiento.
    #:
    #: VACIA POR DEFECTO, Y ESO APAGA LA HUELLA. Sin sal, el hash de una IPv4 se
    #: revierte por fuerza bruta en segundos: el espacio entero son 2^32 valores.
    #: Escribirlo igualmente daria una sensacion de proteccion que no existe, asi
    #: que sin sal se guarda `NULL` y se dice. Es un secreto: solo backend.
    ip_hash_salt: str = ""

    #: Si hay un proxy DE CONFIANZA delante que escriba `X-Forwarded-For`.
    #:
    #: APAGADO POR DEFECTO porque esa cabecera la puede mandar cualquiera: con
    #: esto encendido sin un proxy que la reescriba, quien pide elige que IP se
    #: le apunta. Se enciende cuando se sabe que hay un balanceador delante.
    trust_proxy_headers: bool = False

    # --- Beta gratuita ---
    #: Durante la BETA, un curso de pago se puede conceder GRATIS a quien lo
    #: pide. APAGADO por defecto.
    #:
    #: POR QUE EL VALOR SEGURO ES `False`. Encendido regala el catalogo entero,
    #: y un interruptor cuyo valor por defecto es «regalar» acaba encendido en
    #: produccion el dia que alguien despliegue sin poner la variable, o cuando
    #: la beta termine y nadie se acuerde de apagarlo. Olvidarse tiene que
    #: costar que un usuario de prueba no entre a un curso —se enciende y
    #: listo—, nunca que se regale lo que se vende. Es la misma regla que
    #: `payments_enabled` y `stripe_payments_enabled`: lo que mueve dinero nace
    #: apagado y se enciende a mano.
    #:
    #: NO ES UN PAGO Y NO FINGE SERLO. No crea orden, ni `payment_transaction`,
    #: ni evento de ninguna pasarela, y NO toca `price_minor`: el curso sigue
    #: costando lo que cuesta. Lo unico que escribe es un derecho en
    #: `entitlements` con `source_provider='beta_free'` y sin `transaction_id`,
    #: que es exactamente para lo que la 0035 dejo esa via abierta («un regalo,
    #: una beca o una compensacion se pueden conceder sin inventarse un cobro
    #: que no existio»). Asi la concesion se distingue de una compra para
    #: siempre y con una sola consulta.
    #:
    #: APAGARLO NO REVOCA NADA. Los derechos ya concedidos siguen activos y
    #: `has_course_access()` no mira de donde vienen: quien entro durante la
    #: beta conserva su curso. Lo unico que cambia es que a partir de ahi no se
    #: concede ninguno mas, y los nuevos vuelven a la monetizacion de verdad.
    beta_free_access_enabled: bool = False

    # --- Procesado de media (derivados) ---
    #: Genera en segundo plano la version ligera de las imagenes nuevas y el
    #: poster de los videos que suban sin el. Necesita la service_role key.
    #: Es barato (Pillow sobre una foto, un fotograma con ffmpeg) y corre tras
    #: responder la peticion, asi que no anade latencia a publicar.
    media_processing_enabled: bool = True

    #: Transcodificar VIDEO en el servidor (720p H.264). ENCENDIDO desde el
    #: 27/08/2026.
    #:
    #: Estuvo apagado porque «en el plan gratuito de Render (0.1 CPU, 512 MB)
    #: un video de un minuto tardaria decenas de minutos». Era cierto. Hoy el
    #: backend corre en AWS sobre una t3.small (2 vCPU, 2 GiB) y ese
    #: razonamiento ya no aplica.
    #:
    #: Sin esto, un video subido DESDE LA WEB se quedaba a tamano original: la
    #: libreria que comprime en el telefono no existe en navegador, asi que la
    #: web era el unico camino por el que entraba un video de 100+ MB.
    video_transcode_enabled: bool = True

    #: Generar tambien la escalera HLS (360/540/720 en segmentos de 4 s).
    #: APAGADO por defecto, y no por inercia: HLS son TRES codificaciones del
    #: mismo video en vez de una, y la t3.small usa creditos de CPU
    #: (`CpuCredits: standard`, 24/hora). Agotarlos no ralentiza solo el
    #: procesado: frena la maquina entera, o sea toda la API.
    #:
    #: El MP4 de 720p ya da el ahorro grande de bytes. HLS anade calidad
    #: adaptativa, que es una mejora real pero no urgente.
    #:
    #: QUE TIENE QUE CUMPLIRSE ANTES DE PONERLO EN True:
    #:  1. Que la alarma `creditos-de-cpu-bajando` (infra/aws/02-plataforma.yaml)
    #:     este desplegada y llegando a alguien que la lea. Sin ese aviso,
    #:     encenderlo es apostar: el sintoma que nota la gente no es «falta HLS»
    #:     sino «la aplicacion va lenta», y para entonces ya es tarde.
    #:  2. Que con el MP4 ya encendido el saldo de creditos lleve un dia entero
    #:     plano. Si UNA codificacion ya lo hace bajar, tres lo triplican.
    #:  3. Que `video_jobs_concurrentes` siga en 1.
    #:
    #: Aun cumpliendose, el gasto se acota a los videos donde la adaptacion se
    #: nota (`video_hls_duracion_minima_s`, `video_hls_lado_menor_minimo`). La
    #: salida definitiva sigue siendo la misma: que el procesado viva en su
    #: propia maquina o en una cola aparte, sin compartir CPU con las peticiones.
    video_hls_enabled: bool = False

    #: Duracion minima para que un video merezca escalera HLS.
    #:
    #: HLS son tres codificaciones a cambio de calidad ADAPTATIVA, y adaptarse
    #: lleva tiempo: los segmentos son de 4 s y el reproductor necesita varios
    #: para medir la red y cambiar de variante. En un clip de 15 s el video se
    #: acaba antes de que ese cambio se note, pero las tres codificaciones se
    #: pagan enteras igual. 30 s son unos siete segmentos: por debajo se paga
    #: todo el coste a cambio de nada.
    video_hls_duracion_minima_s: float = 30.0

    #: Lado menor minimo del original para generar HLS. 720 es el peldano ALTO
    #: de `HLS_LADDER`.
    #:
    #: Con un original de 480p los tres peldanos salen del mismo material y el
    #: de arriba es un reescalado hacia arriba: triple de CPU para tres copias
    #: que no se distinguen. La adaptacion solo sirve si hay diferencia real
    #: entre variantes, y eso empieza cuando el original da para el peldano alto.
    video_hls_lado_menor_minimo: int = 720

    #: Cuantos videos se procesan A LA VEZ en este proceso.
    #:
    #: ES EL FRENO QUE PROTEGE LA API. `BackgroundTasks` no limita nada por su
    #: cuenta: si diez personas publican un video a la vez, se lanzan diez
    #: ffmpeg simultaneos sobre 2 vCPU, se agotan los creditos y CUALQUIER
    #: peticion —el muro, el perfil, los mensajes— se arrastra.
    #:
    #: Con 1, los videos se procesan en fila. Tardan mas en estar listos, y da
    #: igual: mientras tanto se sirve el original, que es exactamente lo que
    #: pasaba antes. Lo que no puede pasar es que publicar un video degrade la
    #: aplicacion para quien no esta publicando nada.
    video_jobs_concurrentes: int = 1

    #: Por encima de estos bits por segundo, un video merece transcodificarse.
    #:
    #: El movil ya sube a ~2.5 Mbps (`VIDEO_OPCIONES` en mediaCompressor.ts),
    #: asi que con este umbral los videos de la app se saltan el trabajo: ya
    #: estan bien. Solo se transcodifica lo que llega gordo de verdad, que en
    #: la practica es lo subido desde la web.
    video_bitrate_umbral: int = 3_500_000

    # --- Recomendaciones ---
    #: Personalizacion (onboarding + "Personas para ti" + "Para ti" ordenado).
    #: ENCENDIDO por defecto, y apagable en caliente desde una variable de
    #: entorno sin desplegar nada.
    #:
    #: Es el plan de vuelta atras de esta fase: apagarlo devuelve la aplicacion
    #: al comportamiento anterior —feed cronologico, sin cuestionario— sin
    #: borrar una sola fila. Las tablas nuevas se quedan donde estan, quietas.
    #: Un rollback que exija borrar informacion de gente real no es un rollback.
    feature_recommendations_v1: bool = True
    #: «Cursos para ti». Interruptor propio y no el de siempre: apagar los
    #: cursos si algo sale mal no puede llevarse por delante las personas y el
    #: feed, que llevan funcionando desde antes. Apagado, Explorar vuelve al
    #: catalogo publico sin borrar una sola fila.
    feature_course_recommendations_v1: bool = True

    # --- CORS ---
    cors_origins: str = "*"

    #: Origenes propios del producto, permitidos en produccion aunque nadie haya
    #: configurado CORS_ORIGINS.
    #:
    #: Cerrar el comodin dejo la API denegando TODAS las peticiones de navegador
    #: y tumbo la web, porque la variable no estaba puesta en el servidor. Que la
    #: seguridad dependa de recordar una variable de entorno es fragil: si se
    #: olvida, el sistema no falla al desplegar sino mas tarde y en otro sitio.
    #: Declarar aqui los dominios conocidos hace que funcione de fabrica, y sigue
    #: siendo seguro porque es una lista concreta, no un comodin.
    #:
    #: CORS_ORIGINS los sustituye cuando se define (dominio propio, previews...).
    DEFAULT_PRODUCTION_ORIGINS: ClassVar[tuple[str, ...]] = (
        "https://social-media-renaser.vercel.app",
    )

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def payments_environment(self) -> str:
        """'sandbox' o 'production', para casar con `provider_products`.

        Se deriva del entorno del despliegue en vez de leerse de una variable
        propia: una variable mas es una variable mas que se puede olvidar, y
        olvidarla aqui significaria buscar los productos de pruebas en el
        servidor de verdad (o al reves, que es peor: conceder cursos por una
        compra de juguete).
        """
        return "production" if self.is_production else "sandbox"

    @property
    def uses_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")

    @property
    def cors_origin_list(self) -> list[str]:
        """Origenes de navegador autorizados a llamar a esta API.

        En produccion el comodin NO se acepta: dejaria que cualquier web
        llamara a la API desde el navegador de alguien con la sesion abierta.
        Si no se declara nada se usan los dominios propios del producto
        (DEFAULT_PRODUCTION_ORIGINS), de modo que la web funciona sin depender
        de que alguien se acuerde de configurar la variable. Para anadir otros
        —un dominio propio, las vistas previa de Vercel— se declaran en
        CORS_ORIGINS separados por comas, y esa lista sustituye a la de por
        defecto.

        Esto no afecta a la aplicacion movil: CORS es una restriccion que
        aplican los navegadores, no los clientes nativos.
        """
        raw = self.cors_origins.strip()
        if raw == "*":
            # Sin configurar: comodin en local, dominios propios en produccion.
            return list(self.DEFAULT_PRODUCTION_ORIGINS) if self.is_production else ["*"]
        origins = [o.strip() for o in raw.split(",") if o.strip()]
        # El comodin tambien puede venir mezclado con dominios reales
        # ("*, https://..."), y ahi seguiria abriendo la API entera.
        if self.is_production:
            origins = [o for o in origins if o != "*"]
        return origins

    @property
    def auth_configured(self) -> bool:
        """True cuando hay como validar tokens de Supabase (JWKS o HS256)."""
        return bool(self.supabase_url or self.supabase_jwt_secret)


@lru_cache
def get_settings() -> Settings:
    return Settings()
