# Contratos — Cursos V2 y comercio

Documento de coordinación. **Ningún agente cambia lo que hay aquí sin decírselo
al coordinador.** Si algo no encaja al implementarlo, se avisa; no se improvisa
otro nombre.

## Reparto de migraciones (números cerrados)

| Fichero | Dueño | Contenido |
|---|---|---|
| `0034_cursos_v2.sql` | A | Metadatos de curso, revisión, módulos y lecciones |
| `0035_comercio.sql` | B | Dominio comercial neutral |
| `0036_acceso_v2.sql` | B | `has_course_access` v2, `has_lesson_access`, Storage, trasvase de `purchases` |

Ninguna se ejecuta contra producción.

## Reparto de ficheros (no se cruzan)

- **A** — `app/modules/catalog/*`, `app/modules/learning/*` (curso, módulo, lección, progreso), pantallas de CREAR/EDITAR curso en móvil.
- **B** — `app/modules/commerce/*` (nuevo), migraciones 0035 y 0036.
- **C** — `app/modules/payments/*`, `services/` de compra en móvil, `CourseScreen` (parte de compra).
- **D** — solo ficheros de prueba nuevos.

## Nombres de tabla y columna (definitivos)

### 0034 — cursos

`courses` **añade**: `subtitle`, `promo_video_path`, `primary_topic_id`
(FK `topics`), `language` (por defecto `es`), `level`
(`beginner|intermediate|advanced`), `learning_outcomes text[]`,
`target_audience text[]`, `prerequisites text[]`, `review_status`
(`draft|pending_review|approved|rejected`, por defecto `draft`),
`submitted_at`, `reviewed_at`, `reviewed_by`, `rejection_reason`.

`status` **no se toca**: sigue siendo el enum compartido `content_status` y sigue
significando visibilidad. La revisión es un eje aparte. Mezclarlos rompería
posts, eventos y audios, que comparten el mismo enum.

`highlights` ya existe y **se reutiliza** para «lo que aprenderás». No se crea
una columna duplicada.

`course_modules` añade `description`.
`course_lessons` añade `kind` (`video|text`, por defecto `video`) e `is_preview`
(por defecto `false`).

### 0035 — comercio

```
commerce_products(id, kind, course_id, active, created_at, updated_at)
  kind check ('course_lifetime')          -- hoy solo uno; la columna existe
  course_id FK courses, unique parcial cuando kind='course_lifetime'

provider_products(id, commerce_product_id, provider, environment,
                  external_product_id, active, created_at)
  provider check ('revenuecat_test','google','apple','stripe')
  environment check ('sandbox','production')
  unique (provider, environment, external_product_id)
  unique (commerce_product_id, provider, environment)

orders(id, user_id, commerce_product_id, provider, channel, environment,
       status, amount_minor, currency, created_at, updated_at, paid_at)
  channel check ('ios','android','web')
  status check ('pending','paid','failed','cancelled','refunded')

payment_transactions(id, order_id, provider, environment, external_transaction_id,
                     kind, amount_minor, currency, created_at)
  kind check ('purchase','refund')
  unique (provider, environment, external_transaction_id)   -- idempotencia

payment_events(id, provider, external_event_id, event_type, environment,
               payload jsonb, processed_at, error, created_at)
  unique (provider, external_event_id)                      -- anti-replay

entitlements(id, user_id, commerce_product_id, status, source_provider,
             transaction_id, granted_at, revoked_at, expires_at)
  status check ('active','revoked','expired')
  unique parcial (user_id, commerce_product_id) where status='active'

course_enrollments(user_id, course_id, source, created_at)
  source check ('free','entitlement','author','admin','legacy')
  primary key (user_id, course_id)
```

`expires_at` es nulo para compra única. La columna existe porque el día que haya
suscripción no se puede añadir a una tabla con entitlements ya concedidos sin
decidir qué significan los antiguos.

### RLS del comercio

Lectura: cada quien la suya (`user_id = auth.uid()`), y `provider_products` solo
administración. **Escritura: NINGUNA política para usuarios.** Conceder y revocar
pasa por el backend con identidad de servicio. Un usuario que pueda insertarse un
entitlement desde Supabase se regala el catálogo entero.

`payment_events` no lo lee ni lo escribe nadie salvo el backend.

### 0036 — acceso

`has_course_access(course_id)` pasa a ser cierto si: curso gratuito, autor,
administración, **entitlement activo**, o —durante el trasvase— una fila de
`purchases` en `paid`. El respaldo a `purchases` se conserva: quien ya tenía
acceso lo conserva.

Nuevo `has_lesson_access(lesson_id)`: `lesson.is_preview = true` **o**
`has_course_access(su curso)`.

Storage: `course-media` sigue privado y sus políticas pasan a consultar
`has_lesson_access` para que una preview se pueda reproducir sin comprar.

## Reglas que no se negocian

1. **El acceso lo decide `entitlements`, no el proveedor.** RevenueCat y Stripe
   validan la compra; la fuente de verdad es nuestra tabla.
2. **Un «success» del cliente no concede nada.** La petición del móvil solo
   dispara una sincronización servidor a servidor.
3. **El importe nunca llega del frontend.** Se lee del servidor.
4. `price_minor` sigue en unidad menor y **nunca** pasa a coma flotante. En
   tienda manda el precio localizado del `StoreProduct`; `price_minor` es
   referencia de catálogo, precio web y dato administrativo.
5. Compra **única y permanente**. No hay suscripción, ni `Z Pro`, ni mensual.
6. Sin producto configurado para la plataforma, la interfaz dice que la compra
   no está disponible ahí. **Nunca un botón muerto.**
7. Todo apagado por defecto.
