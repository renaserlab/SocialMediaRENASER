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
antes de usarla, y sigue funcionando cuando no lo está. Al 01/10/2026 la
última **escrita** es la **0094** (atención, posventa y cierre, Incremento 6
de Servicios), que **NO está aplicada**: se probó solo contra PostgreSQL
local, y sin ella la contratación sigue y la atención contesta 503; hay que
aplicarla **antes** de desplegar el código y reiniciar la API después (ver
[`Z_SERVICIOS_ARQUITECTURA.md` §96](Z_SERVICIOS_ARQUITECTURA.md)). La
última **escrita y aplicada** es la **0093** (reserva y contratación,
Incremento 5 de Servicios): ejecutada a mano en Supabase y verificada en solo
lectura **sin divergencias**, también con las puertas de esquema y la conexión
y el rol reales de la API; ver [`Z_SERVICIOS_ARQUITECTURA.md` §80](Z_SERVICIOS_ARQUITECTURA.md).
El código que la usa está en `Edson`, **sin desplegar**: producción todavía no
la conoce, y al desplegarlo la API arranca de nuevo (la puerta recuerda lo que
vio al mirar). La anterior, la **0092** (disponibilidad y agenda, Incremento 4
de Servicios), se aplicó y verificó igual el 30/09/2026; ver
[`Z_SERVICIOS_ARQUITECTURA.md` §61](Z_SERVICIOS_ARQUITECTURA.md).
La API de producción todavía corre el backend anterior, que no la usa:
**cuando se despliegue `Edson`, reiniciarla** (el despliegue lo hace), porque
la puerta recuerda el «no». La **0091** (servicios guardados, Incremento 3 de
Servicios) se ejecutó a mano y se verificó el 29/09/2026 en solo lectura **sin
divergencias**; ver [`Z_SERVICIOS_ARQUITECTURA.md` §49](Z_SERVICIOS_ARQUITECTURA.md).
La **0090** (catálogo y publicación de servicios) también está aplicada y
verificada (§32 del mismo documento). La anterior,
la **0089** (borrar una cuenta sin borrar la historia), también está aplicada y
verificada; ver [`Z_BAJA_DE_CUENTA.md` §15](Z_BAJA_DE_CUENTA.md). Las
aplicadas no se editan: las pruebas vigilan su huella git.
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
| `feature_services` | Z Servicios: la admisión de prestadores, el catálogo, el descubrimiento, la agenda y la reserva (Incrementos 1–5). **Apagada por defecto** (`False`). Apagada, sus rutas contestan 503 `services_disabled` y el acceso de Explorar solo avisa de que aún no está. **No enciende pagos ni la contratación**: esta necesita además `feature_service_booking`. Ver [`Z_SERVICIOS_ARQUITECTURA.md`](Z_SERVICIOS_ARQUITECTURA.md). |
| `feature_service_booking` | Contratar Servicios: apartar un horario, confirmar lo **gratuito** y consultar reservas (Incremento 5), y **atenderlas**: cancelar, reprogramar, asistencia, casos y reseñas (Incremento 6, que además necesita la **0094, sin aplicar**; sin ella, 503 `services_not_ready` solo en lo nuevo). **Apagada por defecto.** Necesita `feature_services` y la 0093; apagada, sus rutas contestan 503 `service_booking_disabled` sin mirar la base y los horarios no ofrecen «Continuar». **No cobra nada.** |
| `feature_service_payments` | Cobrar un servicio. **Apagada.** Encenderla no basta: no hay adaptador (`ADAPTADORES_DE_COBRO` vacío) y la 0093 solo admite pedidos gratuitos. Lo que tiene precio contesta 503 `service_booking_payments_not_configured`. |
| `service_payments_provider` | La pasarela de Servicios. **`none`**. |
| `services_booking_hold_minutes` | Cuánto dura un horario apartado. **10** (provisional; decisión F1). |
| `services_booking_max_active_holds` | Cuántos horarios apartados a la vez por persona. **3** (provisional; decisión F2). |
| `services_booking_instant_modalities` | Modalidades que se confirman sin el prestador. **`virtual,in_person`**: a domicilio necesita su aprobación, que no existe (decisión F3). |
| `services_attention_checkin_minutes` · `services_attention_tolerance_minutes` | Cuándo se abre la llegada de una atención y la tolerancia antes de poder declarar una ausencia. **15** y **15** (provisionales; decisión G3). |
| `services_attention_confirmation_hours` | Plazo de quien contrata para confirmar; pasado, un barrido cierra la atención **solo** si empezó con el código y no tiene un caso vivo. **24** (provisional; G4). |
| `services_booking_reschedule_max` · `services_booking_reschedule_min_hours` | Cuántas veces reprograma quien contrata y con qué antelación. **1** y **24** (provisionales; G2). |
| `services_booking_reminder_hours` | Con cuánta antelación se recuerda una reserva, **si alguien lanza el barrido** (nadie lo llama). **24** (provisional; G12). |
| `services_incident_window_hours` · `services_incident_appeal_days` · `services_incident_appeals_max` | Plazo para abrir un caso, plazo para apelar y cuántas apelaciones (0 o 1; con una sola persona en administración no se ofrece). **48**, **5** y **1** (provisionales; G7, G8). |
| `services_review_window_days` · `services_reviews_premoderation` | Plazo para reseñar una atención cerrada y si la reseña espera a moderación. **30** y **`True`** (provisionales; G11). |
| `services_agenda_notice_minutes` | Antelación mínima de un horario de Servicios. **120** (provisional del documento de reglas; decisión E1). |
| `services_agenda_horizon_days` | Hasta cuántos días por delante se ofrecen horarios. **60** (provisional; decisión E2). |
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
