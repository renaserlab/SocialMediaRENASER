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
    commerce                           orden, derecho, saldo, transferencia
    payments                           Stripe, RevenueCat, webhooks
    refunds                            garantía, solicitud, expediente, reembolso
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
aplicados a mano. La última es la **0049**. Las pruebas no las ejecutan:
construyen el esquema desde los modelos de SQLAlchemy, así que **una migración
sin aplicar no la detecta ninguna prueba**. Se comprueba mirando la base.

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
| `feature_live` | Vídeo en los directos. |

## Estado de la seguridad

Hecho: autenticación real con renovación, RLS por tabla, moderación y bloqueos,
verificación de compras de Apple y Google, contenido premium protegido con URL
firmada, y auditoría del expediente de devoluciones.

Pendiente, y es real: no hay tabla de auditoría general —solo la de
devoluciones—, no hay envío de correo transaccional, y la observabilidad se
limita a `/health` y a los registros. Ver
[`Z_REQUISITOS_Y_DECISIONES.md`](Z_REQUISITOS_Y_DECISIONES.md).
