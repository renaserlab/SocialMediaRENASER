# Arquitectura

Este documento describe **lo que hay**, no lo que se planeó. Si algo de aquí no
coincide con el código, el que se equivoca es el documento: corrígelo.

## Forma general

Un **monolito modular**. Una API desplegable, dividida por dentro en dominios
que no se importan entre sí a la ligera. No hay microservicios y no está
previsto que los haya: la complejidad operativa no la paga nadie hoy.

```text
App Expo (móvil y web)
        |
        +--> Supabase Auth          identidad y sesión
        +--> Supabase PostgreSQL    datos, con RLS por tabla
        +--> Supabase Storage       medios, con URL firmada
        +--> FastAPI                todo lo sensible: dinero, permisos, estados
        +--> 100ms                  vídeo de los directos (apagado)
```

### Las capas, y qué decide cada una

| Capa | De qué responde |
|---|---|
| Experiencia | Pantallas, navegación, accesibilidad, estados de carga y error, i18n. |
| API y casos de uso | Orquestación, permisos, idempotencia, límites de transacción. |
| Dominios | Cursos, eventos, reservas, contenido, mensajería, directos. Reglas y estados propios. |
| Capacidades compartidas | Identidad, perfiles, notificaciones, búsqueda, moderación, recomendación. |
| Primitivas comerciales | Orden, cobro, derecho, reembolso, saldo, transferencia. |
| Adaptadores externos | Stripe, RevenueCat, 100ms, almacenamiento. Detrás de una interfaz sustituible. |

**Lo que no se unifica:** no hay ni habrá una única máquina de estados
comercial. El acceso a un curso, la entrada a un evento y la cita de un
servicio tienen ciclos y obligaciones distintos. Se comparten las primitivas
—orden, pago, saldo—; cada dominio decide cuándo aplican y qué significan.

## Cómo está el código

```text
apps/api/app/
  core/           configuración, seguridad, excepciones, registro
  shared/         base de datos, permisos, paginación, identificadores
  modules/
    identity, profiles, social_graph   quién es quién
    content, stories, communities      lo que se publica
    messaging, notifications           lo que se comunica
    catalog, learning                  cursos: ficha, revisión, temario, progreso
    events                             eventos: admisión, entradas, posventa, finanzas
    products                           productos físicos: admisión, catálogo,
                                       inventario, bolsa, políticas, pedidos
                                       y entrega
    commerce                           orden, derecho, saldo, transferencia
    payments                           Stripe, RevenueCat, webhooks
    refunds                            garantía, solicitud, expediente, reembolso
    gobernanza                         políticas versionadas, consentimientos, auditoría
    reviews, moderation                reputación
    recommendations, search            descubrimiento
    bookings                           reservas de eventos y citas
    live                               directos
apps/mobile/
  app/            rutas (expo-router); son envoltorios finos
  src/screens/    las pantallas de verdad
  src/components/ piezas reutilizables
  src/repositories/ el habla con la API
  src/navigation/ pestañas, gestos y el botón Atrás de Android
  src/i18n/       es / en / pt
```

Las rutas de `apps/mobile/app/` son envoltorios: la pantalla vive en
`src/screens/`. Buscar código en `app/` y no encontrarlo es normal.

## Versiones reales

| | |
|---|---|
| Expo SDK | 54 |
| React Native | 0.81.5 |
| React | 19.1.0 |
| expo-router | 6 |
| Nueva arquitectura | **activada** (`newArchEnabled: true`) |
| Backend | FastAPI + SQLAlchemy asíncrono |
| Base de datos | PostgreSQL (Supabase) en producción; SQLite en las pruebas |

## Persistencia

**No es local-first.** Lo fue en el prototipo y ya no: los datos viven en el
servidor y el teléfono los pide. AsyncStorage guarda sesión, preferencias y
borradores, nunca el historial de compras ni el acceso a un curso: allí no hay
forma de saber si algo se devolvió, y quien reinstale se quedaría sin nada.

Las migraciones son ficheros SQL numerados en `supabase/migrations/`, aditivos y
aplicados **a mano**, pegándolas en el editor de Supabase: no hay herramienta de
migración. Por eso el código siempre pregunta si su migración está aplicada
antes de usarla, y sigue funcionando cuando no lo está. Al 29/09/2026 la
última **aplicada** es la **0087** (retirada de postulaciones de Servicios) y la
última **escrita** es la **0088** (documentos y envíos de Servicios), **pendiente
de aplicación manual**; ver [`Z_SERVICIOS_ARQUITECTURA.md` §9](Z_SERVICIOS_ARQUITECTURA.md).
Hasta el 22/09/2026 la última escrita y aplicada era la **0082** (finanzas de Productos).
De la 0070 en adelante son la vertical de Productos, y las cuatro que quedaban
—0079 envíos, 0080 reclamaciones, 0081 valoraciones y 0082 finanzas— se
aplicaron a mano y se verificaron después contra la base gestionada en una
sesión de solo lectura demostrada. **No queda ninguna pendiente.**

La suite general construye el esquema desde los modelos de SQLAlchemy, no desde
el SQL. Eso ya no queda sin vigilar: hay una comprobación estática que corre
siempre y otra que **ejecuta las ochenta y dos migraciones** sobre un PostgreSQL
desechable —en CI, o con Docker en local—. Ver
[`Z_VERSIONADO_POLITICAS_Y_AUDITORIA.md` §8](Z_VERSIONADO_POLITICAS_Y_AUDITORIA.md).

Lo que ninguna prueba puede decirte es si una base **externa** las tiene
aplicadas. Eso se mira en esa base, y nunca se aplica nada sobre ella sin
autorización.

## Reglas que sostienen el dinero

Están escritas largo en [`Z_DEVOLUCIONES_Y_LIQUIDACIONES.md`](Z_DEVOLUCIONES_Y_LIQUIDACIONES.md).
En corto:

1. **El importe lo pone el servidor.** `crear_orden` ni siquiera acepta un
   parámetro de importe: lo lee del curso.
2. **La idempotencia la garantiza la base**, con índices únicos, no con un `if`.
3. **Se falla en cerrado.** Un dato ausente —importe, moneda, referencia— se
   rechaza; nunca se sustituye por el que se esperaba.
4. **Escribir dinero es solo del backend.** Ninguna tabla de comercio tiene
   política de INSERT, UPDATE o DELETE en RLS.
5. **Moderar contenido no es mover dinero.** `ADMIN_ROLES` incluye
   `moderator`; `FINANCE_ROLES` no.
6. **Lo que se compró no cambia.** Publicar congela una versión inmutable del
   curso, y la orden apunta a ella.
7. **Lo que se acepta y lo que mueve dinero deja rastro**, en la misma
   transacción que la operación.
8. **Las pruebas no pueden tocar la base real.** El conftest fija
   `DATABASE_URL` a SQLite en memoria antes de importar nada de `app`.

## Banderas

Todas nacen apagadas y se encienden por entorno.

| Bandera | Qué enciende |
|---|---|
| `stripe_payments_enabled` | Cobro por tarjeta en web. |
| `feature_course_refunds` | Garantía de 7 días y solicitudes de devolución. |
| `stripe_refunds_enabled` | Ejecutar el reembolso contra la pasarela. |
| `stripe_connect_enabled` | Cuentas conectadas de los propietarios. |
| `creator_transfers_enabled` | Transferir de verdad al propietario. |
| `platform_fee_bps` | La comisión. `-1` significa **sin configurar**, y bloquea. |
| `feature_event_ticketing` | Entradas de eventos. |
| `feature_event_payments` | Cobrar una entrada. Separada de la anterior a propósito. |
| `feature_product_sales` | Comprar un producto físico. **Encenderla sola no basta**: ver `pedidos.por_que_no_se_puede_vender`. |
| `product_reservation_minutes` | Cuánto aparta un pedido su inventario. **`0` significa sin configurar**, y bloquea. |
| `feature_live` | Vídeo en los directos. |
| `feature_services` | Z Servicios: la admisión de prestadores (Incremento 1). Apagada, sus rutas contestan 503 `services_disabled` y la app no enseña ninguna entrada. **No enciende pagos, reservas ni catálogo.** Ver [`Z_SERVICIOS_ARQUITECTURA.md`](Z_SERVICIOS_ARQUITECTURA.md). |
| `ip_hash_salt` | Sal de la huella de IP. **Vacía apaga la huella**: sin sal es reversible. |
| `trust_proxy_headers` | Creerse `X-Forwarded-For`. Apagada: esa cabecera la manda cualquiera. |

## Estado de la seguridad

Hecho: autenticación real con renovación, RLS por tabla, moderación y bloqueos,
verificación de compras de Apple y Google, contenido premium protegido con URL
firmada, y auditoría del expediente de devoluciones.

Desde la 0050 hay auditoría compartida, políticas versionadas y consentimientos
con contexto de origen normalizado, más un identificador de petición en cada
línea de registro.

Pendiente, y es real: no hay envío de correo transaccional, no hay métricas ni
trazas ni alertas, y no hay términos de compra aprobados. Ver
[`Z_REQUISITOS_Y_DECISIONES.md`](Z_REQUISITOS_Y_DECISIONES.md) y
[`Z_VERSIONADO_POLITICAS_Y_AUDITORIA.md`](Z_VERSIONADO_POLITICAS_Y_AUDITORIA.md).
