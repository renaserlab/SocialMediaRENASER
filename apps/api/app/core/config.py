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
