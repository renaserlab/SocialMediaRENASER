# Matriz de vistas: qué enseña la referencia y qué puede sostener el servidor

Una fila por cada pantalla que aparece en las capturas de referencia. Sirve para
una sola cosa: **impedir que una vista se dé por terminada porque se parece a la
captura**.

Cómo se lee cada columna, y esto no es negociable:

- **Existe** solo si hay ruta de expo-router *y* la pantalla se pinta con datos
  que vienen del servidor. Si el dato lo pone el teléfono, un `mockData` o una
  constante, no existe.
- **Parcial**: la pantalla está y pinta datos reales, pero enseña además algo que
  el servidor no puede respaldar. Ese algo se nombra en «Contrato faltante».
- **Backend disponible** nombra el endpoint real (`GET /api/v1/...`) o dice «no
  existe». Nunca «sí».
- **Contrato faltante** es lo más valioso de la tabla: el campo concreto y dónde
  tendría que nacer.
- **Acción de esta fase** solo puede ser `implementar`, `adaptar`,
  `documentar y no tocar` o `bloqueado por contrato`. Esta fase implementa
  **únicamente Cursos y los accesos de Explorar**; Eventos, Servicios y Productos
  son siempre `documentar y no tocar`, por decisión de
  [`Z_ALCANCE_POSTERIOR.md`](Z_ALCANCE_POSTERIOR.md).

Las secciones de cada vertical cubren catálogo, ficha y compra —lo que se ve
antes de tener el derecho—. Lo que se ve **después** de comprar está en
«alumno/comprador», aunque la captura venga de la serie de Cursos.

Todas las rutas llevan el prefijo `/api/v1`. Fuentes de verdad del estado actual:
[`Z_REQUISITOS_Y_DECISIONES.md`](Z_REQUISITOS_Y_DECISIONES.md) y
[`Z_ALCANCE_POSTERIOR.md`](Z_ALCANCE_POSTERIOR.md).

---

## 1. Exploración general

| Vista de referencia | Captura | Existe | Parcial | No existe | Backend disponible | Contrato faltante | Acción de esta fase | Fase posterior |
|---|---|:--:|:--:|:--:|---|---|---|---|
| Explorar · muro «Para ti / Siguiendo» | p01 | x | | | `GET /posts?feed=for_you\|following`, `GET /recommendations/content` | — | documentar y no tocar | — |
| Explorar · carrusel de historias | p01 | x | | | `GET /stories`, `GET /stories?feed=following` | — | documentar y no tocar | — |
| Explorar · buscador «Personas, publicaciones o temas» | p01 | x | | | `GET /search?q=&type=` | — | documentar y no tocar | — |
| Explorar · fila de accesos Cursos / Eventos / Servicios / Productos | p01 | | | x | Cursos: `GET /catalog/courses`. Eventos: `GET /catalog/events`. Servicios y Productos: **no existe** | La fila de chips no está en `ExploreScreen.tsx`. Servicios y Productos no tienen catálogo: no hay tabla, modelo ni endpoint | implementar (solo los cuatro accesos; Servicios y Productos como destino inhabilitado o ausente, nunca como pantalla vacía) | Habilitar Servicios y Productos cuando exista su catálogo |
| Explorar · barra inferior Inicio / Explorar / Crear / Mensajes / Perfil | p01, p05, p09, p10 | x | | | `app/(tabs)/_layout.tsx` sobre `/posts`, `/conversations`, `/profiles/me` | En p12_1 la barra cambia a «Mis cursos» en tercer lugar: esa variante no existe | documentar y no tocar | Decidir si «Mis cursos» sube a pestaña |

## 2. Cursos

| Vista de referencia | Captura | Existe | Parcial | No existe | Backend disponible | Contrato faltante | Acción de esta fase | Fase posterior |
|---|---|:--:|:--:|:--:|---|---|---|---|
| Portada de Cursos (pantalla propia, cabecera «Cursos» + buscador) | p02, p11_0-1 | | | x | `GET /catalog/courses` (sin filtros), `GET /recommendations/courses` | No hay ruta de expo-router para una portada de Cursos; hoy son bloques dentro de `explore.tsx` | implementar | — |
| Portada · banner «Recomendado para ti / Ver ruta» | p02, p11_0-1 | | | x | `GET /recommendations/courses` devuelve cursos sueltos | Entidad **ruta/itinerario** (`learning_path`: id, título, cursos ordenados, criterio de selección). No existe en ninguna migración | bloqueado por contrato | Diseñar rutas después de cerrar Cursos |
| Portada · chips «Elige tu objetivo» (Liderar/Vender/Crear/Bienestar) | p02, p11_0-1 | | x | | `GET /recommendations/onboarding/catalog` devuelve `goals`; `GET /catalog/courses` **no acepta filtro por objetivo ni por tema** | Filtro `topic_id` / `goal` en el listado de catálogo. Hoy no hay forma de pedir «los cursos de Liderar» | implementar (filtro en `GET /catalog/courses`) | — |
| Portada · «Continúa aprendiendo» con % completado | p02, p11_0-1 | x | | | `GET /learning/me/courses` (`progress_percent`, `next_lesson_id`, `state`) | — | adaptar (reubicar en la portada nueva) | — |
| Portada · «Cursos para ti» (tarjetas con duración, nivel, 4.9 (1.2k), precio) | p02, p11_0-1 | | x | | `GET /recommendations/courses`, `GET /catalog/courses` | **Valoración media y número de valoraciones: no existen** (ver §Reseñas de `Z_REQUISITOS_Y_DECISIONES.md`). **Duración total**: solo en `GET /learning/courses/{id}` (`duration_seconds_total`), no en el listado. `level` sí viaja en `CourseRead` | adaptar (pintar solo duración, nivel y precio; nunca estrella ni recuento) | Agregado de valoración cuando exista reseña de curso |
| Resultados de cursos («12 resultados · Ordenar por: Recomendados») | p11_0-2 | | | x | `GET /search?q=&type=course` devuelve coincidencias sin orden elegible | Recuento total de resultados; parámetro `sort` (`recommended\|recent\|price`); mismos campos de tarjeta que arriba | implementar (lista y recuento; el orden, solo con los criterios que el servidor sabe calcular) | Orden por valoración cuando exista |
| Filtros de cursos (Objetivo, Nivel, Duración, Idioma, Garantía) | p11_0-3 | | | x | `GET /catalog/courses` no acepta **ningún** parámetro de filtro; `GET /search` solo `q`, `type`, `limit`, `offset` | Parámetros `goal`/`topic_id`, `level`, `duration_bucket`, `language` sobre `GET /catalog/courses`. **«Con garantía de satisfacción» no es filtrable**: la garantía es de 168 h fija e igual para todos (D2), así que el filtro no separaría nada | implementar los cuatro primeros; el de garantía, bloqueado por contrato | Filtro de garantía cuando la garantía sea por oferta (D2) |
| Guardados (cursos con marcador) | p11_0-4 | | | x | `GET /saved-posts` guarda **publicaciones**, no cursos | Tabla y endpoints de curso guardado (`saved_courses`: usuario, curso, fecha) más `saved_by_me` en `CourseRead` | implementar | Extender a eventos, servicios y productos |
| Detalle del curso | p11_1-5 | | x | | `GET /learning/courses/{id}` (título, subtítulo, descripción, `highlights`, `level`, `language`, `duration_seconds_total`, módulos y lecciones, `has_access`, `price_minor`) | **«EXPERTO VERIFICADO»**: no hay campo de verificación en `profiles` ni en `identity`; `VerificationScreen.tsx` es estado local del teléfono. **«4.9 · 1.248 valoraciones»**: no existe. **«Este curso incluye: 12 lecciones en vídeo, materiales descargables»**: el recuento se puede derivar, los materiales viven en `course_lesson_resources` y **no los devuelve ningún endpoint**. **Vídeo de presentación**: `promo_video_path` existe en el contrato | adaptar (quitar estrella y sello; añadir «incluye» solo con lo derivable) | Sello de experto y valoración agregada |
| Contenido / temario público con vistas previa y candado | p11_1-6 | x | | | `GET /learning/courses/{id}` → `modules[].lessons[]` con `is_preview`, `has_media`, `duration_seconds` | — | documentar y no tocar | — |
| Experto (perfil del autor: experiencia, trayectoria, especialidades) | p11_1-7 | | x | | `GET /profiles/{id}`, `GET /recommendations/profiles/{id}/offer` (temas que declara aportar) | **«EXPERTO VERIFICADO»** y **«4.9 · Valoración general»**: ninguno existe. «Experiencia» y «Trayectoria» como campos estructurados no existen (solo `bio`). `ProfileOffer` es explícitamente una **declaración**, no una credencial | bloqueado por contrato (el sello) / adaptar (enlazar al perfil real) | Credenciales verificadas del creador |
| Valoraciones del curso (4.9, histograma 5→1, filtros, «Compra verificada · Curso completado 100 %») | p11_1-8 | | | x | `GET /reviews/received/{user_id}` son reseñas **de persona**, sin puntuación numérica, con `course_id` opcional (0041) | **No hay estrellas en ninguna parte del modelo**: `ReviewRead` no tiene `rating`. Faltan: puntuación 1–5, media por curso, histograma, `completion_percent` de quien opina, y la regla «una por persona y curso con consumo mínimo» del blueprint (§7). Decisión **D6** abierta: entidad propia o endurecer el enlace de la reseña de perfil | bloqueado por contrato | Reseña de curso (D6) |
| Compra protegida · pantalla de pago con tarjeta y PayPal | p12_0-9 | | x | | `POST /payments/stripe/checkout` (Stripe Checkout alojado, en navegador), `POST /payments/native/sync` (tienda), `GET /payments/courses/{id}/product` | La captura pinta un **formulario de tarjeta propio**: no existe ni debe existir (no hay PCI ni intención de tenerlo). **PayPal**: no hay proveedor. **`PLATFORM_FEE_BPS = -1`**: las compras están apagadas (D4) | adaptar (mantener el desvío a Stripe/tienda; no dibujar campos de tarjeta) | PayPal, si se decide |
| Condiciones de esta compra (vendido por Z, acceso 2 años, garantía 7 días, versión del curso) | p12_0-10 | | x | | `GET /payments/courses/{id}/repurchase-notice` (texto versionado), `GET /policies/{policy_type}`, `GET /catalog/courses/{id}/version` | **«Vendido por Z»**: no hay entidad vendedora decidida (D4, modelo A/B del blueprint §2.1). **«Acceso por 2 años»**: no existe caducidad de derecho; `entitlements` no guarda vencimiento. **Términos de compra**: `policy_versions` existe pero **no hay texto aprobado** (D5) | bloqueado por contrato | Términos por jurisdicción (D5) |
| Compra confirmada (nº de pedido, monto, acceso, garantía «elegible hasta») | p12_0-11 | | x | | `GET /payments/orders/{order_id}`, `GET /payments/courses/{id}/refund-eligibility` (`expires_at`, `seconds_remaining`) | La pantalla actual (`ConfirmationScreen.tsx`) **no enseña ni pedido ni importe**, y promete «te enviamos un correo» cuando **no hay proveedor de correo transaccional** (R22). «Acceso: por 2 años» no tiene respaldo. La garantía sí, pero arranca en el **primer acceso protegido** (D1), no en la compra: la fecha no se puede fijar aquí | adaptar (pedido e importe reales; quitar la promesa de correo; explicar que la garantía arranca al entrar) | Correo transaccional (R22) |

## 3. Eventos

| Vista de referencia | Captura | Existe | Parcial | No existe | Backend disponible | Contrato faltante | Acción de esta fase | Fase posterior |
|---|---|:--:|:--:|:--:|---|---|---|---|
| Portada de Eventos (ubicación, «Este mes», Cerca de ti, Porque sigues a X) | p03 | | x | | `GET /catalog/events?when=upcoming\|past\|undated`; `EventsScreen.tsx` cae a `mockData` cuando Supabase está apagado | **Distancia («A 2 km de ti», «1.8 km»)**: no hay coordenadas; `events.location` es texto libre. **Filtro por ubicación y por mes**: no existen parámetros. **«Porque sigues a Darren»**: no hay recomendación de eventos por grafo social. **«Más de 300 asistentes»**: `registrations_count` existe, pero cuenta reservas de la mecánica actual, no asistencia | documentar y no tocar | Eventos v2: geolocalización, filtros y recomendación |
| Portada de Eventos · alternador mapa / lista | p03 | | | x | no existe | Coordenadas del recinto (`venue.lat/lng`) y entidad recinto | documentar y no tocar | Eventos v2 |
| Portada de Eventos · guardar evento (corazón) | p03 | | | x | `POST /catalog/events/{id}/reserve` es **reservar**, no guardar | Guardado de evento, separado de la reserva | documentar y no tocar | Eventos v2 |
| Detalle del evento («Seleccionado por Z», aforo verificado, organizador verificado, agenda por horas) | p07 | | x | | `GET /catalog/events` (título, descripción, `starts_at`/`ends_at`, `location`, `capacity`, `registrations_count`, `event_type`) | **«Seleccionado por Z»**: no hay curaduría ni estado de admisión. **«Aforo verificado · 420 personas»**: `capacity` es un número escrito por quien crea el evento, sin documento ni validación. **«Organizador verificado»** y **«Plan de seguridad validado»**: no existen. **«Lo que vivirás» (agenda por franjas)**: no hay entidad programa. **«Desde S/ 180»**: los eventos **no tienen precio** en el modelo | documentar y no tocar | Eventos v2: admisión, curaduría, versión del evento |
| Elige tus entradas (tipos, cantidades, «Quedan 18», «Agotado», máximo por persona) | p08 | | | x | `POST /catalog/events/{id}/reserve` reserva **una plaza sin precio ni tipo** | Entidades **tipo de entrada** (nombre, descripción, precio, cupo) e **inventario transaccional**. Reserva atómica sin sobreventa y retención de 10 min (§Eventos v2). Tope por persona | documentar y no tocar | Eventos v2 |


---

## 3 bis. Eventos: estado real tras los Incrementos 1–6

**Esta sección sustituye a lo que la sección 3 decía sobre Eventos.** Aquella se
escribió en la fase de Cursos, cuando un evento no tenía entradas ni puerta.

Las categorías son cinco y significan cosas distintas:

- **terminada** — ruta, pantalla, enlace de entrada y datos del servidor, con
  carga, vacío, error y sin conexión.
- **parcial** — existe y pinta datos reales, pero le falta algo construible hoy.
- **no implementada** — no hay ruta ni pantalla.
- **bloqueada por decisión** — el backend está y lo que falta es que la empresa
  decida. La pantalla puede existir; lo que no puede es inventar el dato.
- **fuera del alcance** — necesita un contrato que no existe (geolocalización,
  recinto, wallet).

**Una vista sin enlace no está terminada.** Una ruta alcanzable solo tecleando
la URL no existe para quien usa la aplicación, y esta matriz lo cuenta como tal.

### Comprador

| Vista | Ruta | Endpoint | Estado | Carga/error/vacío | Brecha frente a las capturas |
|---|---|---|---|---|---|
| Portada de Eventos | `/eventos` | `GET /catalog/events` | terminada | sí | distancia, mapa y «porque sigues a X»: **fuera del alcance**, no hay coordenadas |
| Detalle del evento | `/eventos/[id]` | `GET /catalog/events` | terminada | sí | agenda por franjas: fuera del alcance |
| Elegir entradas | `/entradas/[id]` | `GET /events/{id}/ticket-types` | terminada | sí | — |
| Reserva temporal | `/reserva/[id]` | `POST /events/{id}/ticket-holds` | terminada | sí | — |
| Pedido de entradas | `/pedido/[id]` | `POST /events/ticket-holds/{id}/orders` | terminada | sí | el importe se dice BRUTO y se explica; no es factura, y lo dice |
| Mis entradas | `/mis-entradas` | `GET /events/me/tickets` | terminada | sí | — |
| Mi entrada (QR) | `/mi-entrada/[id]` | `POST /events/tickets/{id}/credential` | terminada | sí | Apple Wallet y «cómo llegar»: fuera del alcance |
| Solicitar posventa | `/posventa/nueva/[orderId]` | `GET …/aftersale-eligibility` + `POST /events/aftersale-cases` | terminada | sí | el importe a devolver **no se anticipa**: sin política no hay porcentaje |
| Mis solicitudes | `/posventa` | `GET /events/me/aftersale-cases` | terminada | sí | — |
| Expediente y línea de tiempo | `/posventa/[id]` | `GET /events/aftersale-cases/{id}` + `/history` + `/tickets` | terminada | sí | sin notas internas, a propósito |
| Responder información | `/posventa/[id]` | `POST …/{id}/respond` | terminada | sí | — |
| Escribir reseña | `/resenas/nueva/[eventId]` | `GET …/can-review` + `POST …/reviews` | terminada | sí | **apagada por política**: sin `review_window` publicada dice por qué |
| Reseñas del evento | `/resenas/[eventId]` | `…/reviews` + `/summary` + `/mine` | terminada | sí | no se enseña el nombre de quien opina: el contrato solo trae el identificador, y **quién aparece es una decisión de privacidad sin tomar** |
| Condiciones antes de pagar | `/pedido/[id]` | `GET /events/{id}/policies/terms` | **no implementada** | el backend está, es anónimo y ya manda el `mandato` de Z con lo que queda sin efecto; la pantalla de pedido todavía no las enseña |
| Qué aceptó mi compra | — | `GET /events/orders/{id}/policies` | **no implementada** | el backend está |

### Organizador

| Vista | Ruta | Endpoint | Estado | Carga/error/vacío | Brecha |
|---|---|---|---|---|---|
| Mis eventos | `/mis-eventos` | `GET /events/mine` | terminada | sí | — |
| Editar evento | `/editar-evento/[id]` | `PATCH /events/{id}` | terminada | sí | — |
| Configurar entradas | `/configurar-entradas/[id]` | `GET/POST /events/{id}/ticket-types` | terminada | sí | — |
| Ventas del evento | `/ventas/[id]` | `GET /events/{id}/sales` | parcial | sí | enseña bruto y lo llama bruto; **no** hay comisión ni neto porque `platform_fee_bps = -1` |
| **Ventas y saldo** | `/finanzas/[eventId]` | `GET /events/{id}/finance` + `/balances` | terminada | sí | con la comisión sin decidir escribe «pendiente de configuración», nunca un cero |
| Posventa de mi evento | `/posventa-evento/[id]` | `GET /events/{id}/aftersale-cases` | terminada | sí | subconjunto a propósito: sin comprador, sin motivo, sin notas internas |
| Responder una reseña | `/resenas/[eventId]` | `POST /events/reviews/{id}/reply` | terminada | sí | **apagada por política**: sin `organizer_reply` publicada el servidor lo rechaza con su código y la pantalla lo dice |
| **Mis políticas** | `/politicas/[eventId]` | `GET/PUT /events/{id}/policies…` | terminada | sí | decide lo que le promete a quien compra; **no** cómo se mueve el dinero de la plataforma |
| **Cancelar el evento** | `/politicas/[eventId]` | `POST /events/{id}/cancel` | terminada | sí | retiene, abre expediente y **deja decidido el 100 %** por mandato de Z. Decidido no es pagado: eso lo confirma el proveedor |
| Asistentes | `/asistentes/[id]` | `GET /events/{id}/attendees` | terminada | sí | la búsqueda es exacta desde la 0063, y es a propósito |
| Control de acceso | `/check-in/[id]` | `POST /events/{id}/check-ins` | terminada | sí | **pendiente de QA físico**: cámara real y dos teléfonos |

### Administración

| Vista | Ruta | Endpoint | Estado | Brecha |
|---|---|---|---|---|
| Admisión de eventos | `/admin/eventos` | `GET /admin/events/admission` | terminada | — |
| Revisar evento | `/admin/eventos/[id]` | `POST /admin/events/{id}/decision` | terminada | — |
| Bandeja de posventa | `/admin/posventa` | `GET /admin/events/aftersale-cases` | terminada | — |
| Expediente y acciones | `/admin/posventa/[id]` | `.../review`, `/approve`, `/reject`, `/history`, `/tickets` | terminada | aprobar **no** es haber pagado, y solo el sistema cierra con el aviso del proveedor |
| Clasificar cambios | `/admin/posventa/[id]` | `POST /admin/events/changes/{id}/classify` | terminada | vive dentro del expediente, que es donde se necesita |
| **Panel financiero** | `/admin/finanzas` | `/health`, `/reconcile`, `/disputes`, `/reserves`, `/transfers/run` | terminada | desde ahí **no se mueve dinero**, y los textos lo dicen |
| **Moderar reseñas** | `/admin/resenas` | `GET /admin/events/reviews` + `/moderate` | terminada | esconder no borra, y no toca autor ni puntuación |
| **Supervisar políticas** | `/admin/politicas` | `/admin/events/policies/{overview,missing}` | terminada | supervisión y trazabilidad, **no** aprobación: ni un botón que escriba |
| Publicar política de plataforma | — | `POST /admin/events/policies` | **no implementada** | las siete de dinero —retención, reserva, disputa, saldo negativo, ejecución, ventana de reseña, respuesta— siguen sin pantalla. Es lo único que queda |

### Lo que esta matriz dice, en una frase

Quien organiza ya puede escribir sus propias condiciones y cancelar su evento, y
administración ya puede moderar y supervisar. Lo que queda es de plataforma:
**publicar las siete políticas de dinero**, sin las cuales la retención, la
reserva, la responsabilidad de una disputa y la ventana de reseñas siguen
contestando «pendiente de configuración». Y dos pantallas del comprador que solo
LEEN lo que el servidor ya sabe decir: las condiciones antes de pagar y lo que su
compra aceptó.

## 4. Servicios

| Vista de referencia | Captura | Existe | Parcial | No existe | Backend disponible | Contrato faltante | Acción de esta fase | Fase posterior |
|---|---|:--:|:--:|:--:|---|---|---|---|
| Portada de Servicios («¿Qué necesitas resolver?», dictado, necesidades frecuentes, recomendados) | p04, p14_0-1 | | | x | no existe (no hay catálogo de servicios) | Entidades **prestador**, **servicio** y **variante**. «Identidad verificada», «4.9 (128)», «Responde en 10 min», «Consulta desde S/ 120» y «Por qué te lo recomendamos»: ninguno tiene columna | documentar y no tocar | Servicios v1 |
| Necesidades (árbol de categorías: Negocio, Hogar, Legal, Bienestar, Tecnología, Educación, Eventos, Salud) | p14_0-2 | | | x | `topics` (0026) es la taxonomía de contenido, **no** de servicios | Taxonomía de familias de servicio del blueprint §1.3, con categorías reguladas marcadas | documentar y no tocar | Servicios v1 |
| Resultados de profesionales (Virtual/Presencial, precio, «Disponible mañana») | p14_0-3 | | | x | no existe | Búsqueda por familia + modalidad + disponibilidad; el «disponible mañana» exige agenda calculada en servidor | documentar y no tocar | Servicios v1 |
| Filtros de servicios (modalidad, ubicación, fecha, precio, calificación, credencial verificada) | p14_0-4 | | | x | no existe | Todos. La «credencial verificada» necesita la entidad credencial con evidencia documental y jurisdicción | documentar y no tocar | Servicios v1 |
| Perfil profesional (verificado, 4.9, atenciones, pestañas Sobre mí / Servicios / Reseñas) | p14_0-5 | | x | | `GET /profiles/{id}`, `GET /reviews/received/{user_id}` | Sello de verificación, puntuación numérica, recuento de atenciones: ninguno existe. La reseña actual es de persona y **no tiene estrellas** | documentar y no tocar | Servicios v1 |
| Detalle del servicio (duración, precio, incluye / no incluye, horario disponible) | p14_0-6 | | | x | no existe | Entidad servicio con alcance, exclusiones, duración y precio; y disponibilidad real | documentar y no tocar | Servicios v1 |
| Reseñas verificadas (4.9, histograma) | p14_0-7 | | x | | `GET /reviews/received/{user_id}`, `GET /reviews/availability` | Puntuación 1–5 e histograma. El sello «interacción verificada» sí existe (`verified_source`: `booking`\|`course`) | documentar y no tocar | Servicios v1 |
| Cuéntanos lo necesario (descripción del caso, adjuntos, modalidad) | p14_0-8 | | | x | no existe | Entidad **solicitud/cotización** (`REQUEST` del blueprint §2). Límite ético: la IA describe, **no diagnostica**, y la persona puede corregir lo que escribió | documentar y no tocar | Servicios v1 |
| Elige un horario (calendario, huecos por franja, zona horaria) | p14_0-9 | | | x | `POST /bookings` acepta un `scheduled_at` **propuesto por el cliente**, sin comprobar hueco | Reglas y excepciones de disponibilidad, retención de hueco con caducidad, zona horaria IANA guardada con la reserva. Es el punto más caro de la vertical: concurrencia, no pantallas | documentar y no tocar | Servicios v1 |
| Revisa y confirma (resumen, política de cancelación, pago protegido) | p14_0-10 | | | x | no existe (los pagos de servicios no están modelados) | Política de cancelación por categoría, retención del importe, y las cuatro máquinas de estado separadas (`booking`, `payment`, `transfer`, `review`) | documentar y no tocar | Servicios v1 |
| Reserva confirmada (código de reserva, añadir al calendario) | p14_0-11 | | x | | `POST /bookings` devuelve `BookingRead` | Código legible de reserva, exportación de calendario, y el vínculo con un pago que hoy no hay | documentar y no tocar | Servicios v1 |

## 5. Productos

Reescrita el 12/09/2026, ampliada el 17/09/2026 con los Incrementos 4 y 5, el
21/09/2026 con el 6 y el 7, y el 22/09/2026 con el 8. La vertical existe: hay
dominio, admisión con evaluación, catálogo con **fotografías reales**,
**inventario**, **bolsa**, **condiciones de venta por jurisdicción**, **pedido
con reserva**, **entrega**, **reclamaciones** y **valoraciones verificadas**.

Lo que sigue sin haber es **cobrar de verdad**: el recorrido llega hasta la
puerta de la pasarela y ahí se para, porque hacen falta cinco banderas
encendidas, una clave de Stripe y una política publicada, y ninguna de esas
decisiones la toma el código. La pantalla no lo disimula: dice con palabras qué
falta.

Y la entrega funciona entera **sobre un pedido pagado**, que hoy solo existe en
local: se prepara, se cierra, se despacha —y ahí, y solo ahí, salen unidades del
almacén—, se registra la entrega o su fallo y quien compró puede confirmar que
lo recibió. **Sin transportista, sin fecha de llegada y sin «atrasado»**: nada
de eso está decidido, y la pantalla lo dice con palabras en vez de inventarlo.

### Comprador

| Vista | Ruta | Backend | Estado | Qué falta |
|---|---|---|---|---|
| Portada de Productos Z | `/productos` | `GET /products` | terminada | el **título editorial** de «Selección Z» no tiene campo ni decisión: el bloque se pinta con el rótulo y las tarjetas, sin título inventado |
| Buscador y filtros | `/productos/buscar` | `GET /products/search` | terminada | nada. Filtra en el servidor y pagina por cursor |
| Categorías | dentro del buscador | `GET /products/categories` | terminada | **la tabla nace vacía**: las categorías iniciales las decide la empresa |
| Ficha del producto | `/productos/[productId]` | `GET /products/{id}` + `GET /products/{id}/reviews/summary` | terminada | **la valoración real ya tiene datos** (Incremento 8) y se lee en su propia petición: sin la 0081 la ficha se ve entera, solo sin ese bloque. Siguen FUERA dos bloques de la captura 6: compra protegida y la barra de comprar |
| Informe de evaluación | `/productos/[productId]/evaluacion` | `GET /products/{id}/evaluation` | terminada | nada. El sello lo abre, y enseña la evidencia por dimensión sin la nota interna |
| Guardados | `/productos/guardados` | `GET /products/saved` + `POST/DELETE .../save` | terminada | nada. Guardar es idempotente y **no es un carrito** |
| Bolsa con contador | encabezado | `GET /products/counts` | terminada | **la bolsa lleva al CARRITO** y cuenta unidades; guardados tiene su propio acceso al lado y cuenta productos marcados |
| Tu bolsa | `/productos/carrito` | `GET/DELETE /products/cart`, `POST /products/cart/items`, `PUT/DELETE .../items/{id}` | terminada | el botón de continuar **solo aparece si el servidor dice que se puede**; si no, el pie sigue diciendo con palabras que todavía no se compra |
| Comprar (revisar, dirección y condiciones) | `/productos/checkout` | `GET /products/checkout/preparation`, `GET /products/policies`, `POST /products/orders` | terminada | **no cobra**: reserva y deja el pedido esperando pago. Sin política publicada enseña qué falta |
| Mis pedidos | `/productos/pedidos` | `GET /products/orders` | terminada | nada |
| Detalle del pedido y vuelta del pago | `/productos/pedidos/[orderId]` | `GET /products/orders/{id}`, `POST .../checkout`, `POST .../cancel` | terminada | **la vuelta del navegador no confirma dinero**: la pantalla pregunta el estado al servidor |
| Valoración real (4,8 · 184 compras verificadas) | dentro de `/productos/[productId]` | `GET /products/{id}/reviews/summary` | terminada | **sin valoraciones no se pinta ninguna puntuación**: ni un 0,0, ni cinco estrellas vacías, ni un «0 %». La puntuación ajustada es la fórmula del blueprint §6.1, y cuando se apoya en la referencia general —porque de dónde sale el promedio de categoría no lo ha decidido nadie— la pantalla lo dice |
| Lo que opinan | `/productos/[productId]/resenas` | `GET /products/{id}/reviews` | terminada | pagina por `(created_at, id)` y **no dice de qué compra sale cada opinión**: el pedido y la línea atan a una persona con un importe y una dirección. El sello de compra verificada dice lo único que hace falta |
| Valorar lo que compré | `/productos/pedidos/[orderId]/valorar` | `GET /products/orders/{id}/reviewable`, `POST /products/order-items/{id}/review` | terminada | **la unidad es la línea del pedido**, no el pedido: dos artículos comprados juntos se valoran aparte. Las seis respuestas del blueprint son obligatorias y el botón dice cuál falta. **Aquí no se suben fotografías**: eso es una reclamación |
| Mi valoración | `/productos/resenas/[reviewId]` | `GET/PATCH /products/reviews/{id}` | terminada | se edita la puntuación y el texto, **nunca de qué compra habla**. Una oculta por moderación **se sigue viendo entera** —es suya— pero no se edita: reescribirla y dejarla oculta no sirve, y dejarla visible sería saltarse la moderación escribiendo |
| Quién opinó, con nombre y cara | — | — | **no existe** | viaja el identificador público del perfil y nada más, igual que en las reseñas de evento. **Cómo se identifica públicamente a quien opina es una decisión abierta** (ver D143): deducir un nombre completo sería publicarlo sin que nadie lo haya decidido |
| Índice de permanencia (blueprint §7) | — | — | **no existe** | tres de sus siete componentes —devoluciones atribuibles, reclamos válidos y garantías atendidas— no existen hasta el Incremento 9. Calcularlo con cuatro de siete daría un número que parece el del blueprint y no lo es |
| Compra protegida y plazos | dentro del checkout y del pedido | `GET /products/policies` | **parcial** | los plazos salen de la política publicada. **Sin plazo de incidencias NO se dice «compra protegida»**: se dice que esa jurisdicción todavía no lo fija |
| Barra fija de compra | — | — | **no existe** | en la ficha hay «Añadir a la bolsa», que NO es comprar. Comprar vive en la bolsa y lleva al checkout |
| Impuestos y envío | — | — | **no existen** | entidad fiscal, transportista y tarifas. **No se pintan como cero**: el checkout dice con palabras que están sin decidir |
| Seguimiento del pedido | dentro de `/productos/pedidos/[orderId]` | `GET /products/orders/{id}` (campo `shipment`) | terminada | viaja **dentro del pedido**: una ruta aparte obligaría a dos viajes para pintar una ficha. Enseña el estado, lo que escribió quien despachó y una línea de tiempo que mezcla pago y envío **solo al pintar** |
| Confirmar que llegó | dentro del detalle del pedido | `POST .../shipment/confirm-receipt` | terminada | **NO es dar la conformidad**, y el texto bajo el botón lo dice: eso liberaría el dinero al proveedor y no existe. Solo se ofrece sobre algo que ya salió y que esa persona no ha confirmado |
| Transportista y fecha de llegada | — | — | **no existen** | la empresa no ha elegido transportista ni hay plazos acordados. El campo del transportista es texto libre y **nulo se dice con palabras**; no hay enlace de seguimiento ni fecha prevista |
| Reclamaciones de este pedido | dentro de `/productos/pedidos/[orderId]` | `GET /products/orders/{id}` (campo `incidents`) | terminada | viajan **dentro del pedido**, como el seguimiento: quien reclamó tiene que ver su caso donde está el pedido del que habla. **Solo el resumen**: la descripción se lee entrando |
| Reportar un problema | `/productos/pedidos/[orderId]/reportar` | `POST /products/orders/{id}/incidents` | terminada | **abrir no es que te den la razón**, y lo dice arriba del formulario. Ocho motivos; «consta entregado y no lo recibí» habla del pedido entero y no pide artículo. Ningún importe junto al botón |
| El expediente | `/productos/reclamaciones/[incidentId]` | `GET /products/incidents/{id}` + `evidence`/`submit`/`reply`/`escalate`/`appeal`/`withdraw` | terminada | de 2 a 6 fotografías, y **una vez añadida no se quita**: la otra parte ya la vio. El plazo del proveedor se dice como un hecho y **nunca** como un incumplimiento; nulo es «ahora no le toca a él» |
| Cuánto se devuelve, y cuándo | — | — | **no existe** | una decisión registrada dice QUÉ se acordó, no CUÁNTO. El efecto queda `PENDING` y **nadie lo ejecuta**: Incremento 9 |
| Fecha de la decisión de Z | — | — | **no existe** | el blueprint dice «tres días hábiles» y «hábil» depende de un calendario que nadie definió. Se dice «en revisión», y la pantalla explica por qué no hay fecha |
| Devolución, reembolso y garantía ejecutados | — | — | **no existen** | Incremento 9. Un aviso de devolución se anota para conciliar y **no deshace nada** |

### Proveedor

| Vista | Ruta | Backend | Estado | Qué falta |
|---|---|---|---|---|
| Postular como proveedor | `/proveedor/postular` | `GET/PUT /products/seller/application` + `submit`/`withdraw` | terminada | qué documentación exige la empresa: los tipos están, el requisito no |
| Mis productos | `/proveedor/productos` | `GET /products/seller/products` | terminada | nada |
| Crear y editar un producto | `/proveedor/productos/{nuevo,[productId]}` | `POST /products/seller/products`, `PUT .../draft`, `POST .../submit` | terminada | el borrador **ya no lleva galería**: las fotos tienen su pantalla |
| Fotografías del producto | `/proveedor/productos/[productId]/fotos` | `GET/POST .../media`, `PUT .../media/order`, `DELETE .../media/{id}` | terminada | **el archivo lo sube la API**, no el móvil; nace pendiente de aprobación |
| Inventario del producto | `/proveedor/productos/[productId]/inventario` | `GET .../inventory`, `POST .../inventory/{intake,adjust}`, `GET .../inventory/{sku}/movements` | terminada | reservar y liberar los llama el pedido, y **despachar lo llama el envío** desde el Incremento 6: el único salto que saca unidades es `READY → DISPATCHED` |
| Pedidos de mi tienda | `/proveedor/pedidos` | `GET /products/seller/orders` | terminada | **solo los PAGADOS, y sin el cobro ni el comprador**. Se llega desde «Mis productos», y se enseña siempre: la lista vacía explica que todavía no hay nada que preparar |
| Preparar y despachar | `/proveedor/pedidos/[orderId]` | `GET/POST .../seller/orders/{id}/shipment/*` | terminada | es la **única pantalla de Productos donde salen unidades del almacén**, y por eso despachar pregunta antes. Transportista y referencia son opcionales |
| Reclamaciones de mi tienda | `/proveedor/reclamaciones` | `GET /products/seller/incidents` | terminada | **sin la descripción**: ese texto lo escribe quien reclama y suele llevar dentro dónde vive. Se llega desde «Mis productos» y se enseña siempre |
| Responder una reclamación | `/proveedor/reclamaciones/[incidentId]` | `GET .../seller/incidents/{id}`, `POST .../respond`, `POST .../request-evidence` | terminada | **propone, no resuelve**, y no existe ruta ni botón que resuelva: las cinco salidas mueven dinero o mercancía. Pedir más pruebas **para su reloj**. Ni un dato de quien compró |
| Lo que opinan de mi tienda | `/proveedor/resenas` | `GET /products/seller/reviews` | terminada | **solo las de sus productos y solo las visibles**. Se llega desde «Mis productos», y la lista vacía lo explica en vez de parecer rota |
| Responder una valoración | dentro de esa bandeja | `POST /products/seller/reviews/{id}/reply` | terminada | **responder es lo único que puede hacer**, y la pantalla lo dice: no hay ruta ni botón para cambiar ni ocultar lo que escribió quien compró. **Una respuesta visible por valoración**: varias serían una forma de insistirle a quien opinó |
| Saldos del proveedor | — | — | **no existen** | Incremento 9. No hay pantalla vacía que los simule |

### Administración

| Vista | Ruta | Backend | Estado | Qué falta |
|---|---|---|---|---|
| Bandeja de postulaciones | `/admin/productos/admision` | `GET /admin/products/applications` + `take`/`decide` | terminada | nada. Aceptar crea la capacidad comercial en la misma transacción |
| Evaluar un producto | `/admin/productos/evaluar/[evaluationId]` | siete rutas de `/admin/products/evaluations` | terminada | nada. Seis dimensiones, evidencia por dimensión y tres razones respaldadas |
| Listado y permanencia | `/admin/productos` | `GET /admin/products` + `transition`/`publish`/`suspend` | terminada | las condiciones de una **aprobación condicionada**: sin ellas ese estado no publica |
| Fotografías pendientes | `/admin/productos/fotos` | `GET /admin/products/media/pending`, `POST .../media/{id}/decide` | terminada | nada. Un rechazo exige motivo, y nadie aprueba la foto de su propio producto |
| Intervenir el inventario | dentro del listado | `GET/POST /admin/products/{id}/inventory[/adjust]` | terminada | solo `admin`, con motivo y con rastro. Moderación no mueve inventario |
| Publicar las condiciones de venta de un país | — (ruta de API) | `GET/POST /admin/products/policies`, `POST .../policies/{id}/retire` | **backend terminado, sin pantalla** | el texto legal lo escribe una persona con su abogado; una pantalla para redactarlo invitaría a improvisarlo. **Sin política publicada no se vende** |
| Pedidos que necesitan una persona | — (ruta de API) | `GET /admin/products/orders/review` | **backend terminado, sin pantalla** | hoy solo caen ahí los pagos tardíos, y no hay ninguno: la venta está apagada |
| Vencer reservas caducadas | — (planificador externo) | `POST /admin/products/orders/expire` | terminada | **no es un temporizador dentro de FastAPI**: la API puede tener varias réplicas. Lo llama un planificador de fuera |
| Envíos sin cerrar | `/admin/productos/envios` | `GET /admin/products/shipments` | terminada | **ni un dato personal**: ni dirección, ni nombre, ni importe, ni el motivo de un fallo —que es texto libre y suele llevar la calle dentro—. **No marca nada como atrasado**: ninguna política publica un plazo de despacho, así que da el tiempo transcurrido |
| Reclamaciones por revisar | `/admin/productos/reclamaciones` | `GET /admin/products/incidents` | terminada | **solo `admin`, no `is_admin`**: moderación recibe 403 y la pantalla lo dice. Ni un dato personal en la cola |
| Decidir una reclamación | `/admin/productos/reclamaciones/[incidentId]` | `GET /admin/products/incidents/{id}`, `POST .../resolve` | terminada | **registrar no es ejecutar**: no mueve dinero ni devuelve nada al almacén, y lo dice antes de pulsar. La explicación es obligatoria y el expediente no se reescribe |
| Escalar las reclamaciones vencidas | dentro de esa cola | `POST /admin/products/incidents/escalate-overdue` | terminada | **idempotente**, y se lanza a mano: un temporizador dentro de FastAPI se ejecutaría una vez por réplica. Espera un planificador externo, como el vencimiento de reservas |
| Valoraciones por revisar | `/admin/productos/resenas` | `GET /admin/products/reviews?hidden=`, `POST .../reviews/{id}/moderate`, `POST .../review-replies/{id}/moderate`, `GET .../reviews/{id}/moderation` | terminada | **moderar es esconder, nunca reescribir**: la puntuación, el texto y el autor se quedan enteros, y el historial solo se añade. **Dos lados, para que esconder se pueda deshacer.** Nadie modera lo suyo, ni con rol de curaduría. El motivo es interno, es de cada fila y **no viaja a la auditoría compartida**: puede llevar dentro una cita de lo que escribió quien opinó. Y la cola **no lleva la línea de pedido** |
| Intervenir un envío parado | — (ruta de API) | `POST /admin/products/shipments/{id}/transition` | **backend terminado, sin pantalla** | lo único que permite —reabrir, registrar un fallo, registrar un reintento— también lo hace quien vende desde la suya, y **cuándo escala una cosa a la otra es una decisión operativa que nadie ha tomado**. No puede despachar ni escribir «entregado» |

### Lo que esta matriz dice, en una frase

El recorrido está completo en las dos direcciones: **Explorar → Productos →
buscar → ficha de un producto aprobado → añadir a la bolsa → ver la bolsa →
comprar → dirección y condiciones → pedido reservado → mis pedidos**, y **el
proveedor postula → sube fotos → Z las aprueba → Z evalúa → Z publica → el
proveedor carga existencias**.

Y desde el Incremento 6 el recorrido sigue: **pedido pagado → el proveedor lo ve
en su tienda → mete lo que va en la caja → cierra el paquete → lo despacha, y
ahí salen las unidades → registra que llegó o que no se pudo → quien compró lo
ve en su pedido y confirma que lo recibió**.

Y desde el Incremento 7 tiene su ramal de posventa: **algo llegó mal → se
reporta desde el pedido → se le cuelgan las fotografías → se envía y arranca el
plazo del proveedor → el proveedor propone o pide más pruebas → Z registra qué
se decidió**. Ahí se para, y se para diciéndolo: **el dinero de vuelta no
existe**. Una decisión registrada deja el efecto `PENDING` y nadie lo ejecuta.

Y desde el Incremento 8 el recorrido se cierra por donde empezó: **llegó → se
valora la línea que llegó → la puntuación aparece en la ficha del producto → el
proveedor responde en público → moderación puede esconder, nunca reescribir**.
La valoración real era la primera diferencia con la captura 6 y ya no lo es.

Lo que queda fuera no es una pantalla sin conectar. Son: **el cobro**, que llega
hasta la puerta de la pasarela y ahí se para porque faltan cinco banderas, una
clave y una política, y la pantalla lo dice; **la ejecución del reembolso y los
saldos**, que son del Incremento 9; **el índice de permanencia**, que necesita
tres datos que nacen con esos saldos; y **el acceso de Servicios**, que sigue
siendo el único de los cuatro chips que no lleva a ninguna parte, a propósito y
avisando.

## 6. Alumno / comprador

| Vista de referencia | Captura | Existe | Parcial | No existe | Backend disponible | Contrato faltante | Acción de esta fase | Fase posterior |
|---|---|:--:|:--:|:--:|---|---|---|---|
| Comprobante de compra (nº, comprador, subtotal, impuestos, total, descargar PDF) | p12_0-12 | | | x | `GET /payments/history` (`amount_minor`, `currency`, `status`, `provider`, `course_version`, `guarantee_hours`) | **Impuestos**: no se calculan ni se guardan (D4). **Entidad vendedora**: sin decidir. **PDF**: no hay generación de documentos. El identificador de orden existe pero no como número legible | bloqueado por contrato | Facturación tras D4/D5 |
| Mis cursos (En progreso / No iniciados / Finalizados, % y «Continuar») | p12_1-13 | x | | | `GET /learning/me/courses` (`state`, `progress_percent`, `next_lesson_id`, `lessons_total/completed`) | «Acceso expira en 12 días» de la tercera tarjeta: **no existe caducidad de derecho** | adaptar (la pantalla es `LibraryScreen`; falta la pestaña «No iniciados» separada y no debe pintar caducidad) | Derecho con vencimiento, si se decide |
| Reproductor de lección (vídeo, 1x, CC, descripción, marcar completada, siguiente) | p12_1-14 | | x | | `GET /learning/lessons/{id}`, `PUT /learning/lessons/{id}/progress`, `POST /learning/lessons/{id}/complete` | **Subtítulos (CC)**: no hay pista de subtítulos ni transcripción (R27). Pestañas «Recursos» y «Notas» del reproductor: ver dos filas más abajo | adaptar (quitar CC mientras no haya pista) | Subtítulos y transcripción |
| Temario y progreso con módulos bloqueados («se desbloquea al completar el módulo 1») | p12_1-15 | | x | | `GET /learning/courses/{id}` devuelve módulos, lecciones y `completed` | **Progresión secuencial**: no existe. Ningún campo dice que un módulo dependa de otro, y el progreso cuenta segundos acotados, **no segundos únicos** (R11): repetir un tramo suma | adaptar (pintar progreso real, sin candados que el servidor no impone) | Prerrequisitos de módulo y segundos únicos |
| Recursos y notas de la lección | p12_1-16 | | x | | Recursos: tabla `course_lesson_resources`, escrita desde el móvil **por PostgREST directo**; ningún endpoint de `learning` los devuelve. Notas: **no existe** | Exponer los recursos en `GET /learning/lessons/{id}` (hoy `LessonDetailRead` no los lleva). Entidad **nota** con marca de tiempo, sincronizada por servidor: la captura promete «Sincronizado» | implementar recursos por API; notas, bloqueado por contrato | Notas del alumno |
| Evaluación de la lección (pregunta 3 de 8, opciones, enviar) | p13_0-17 | | | x | `QuizScreen.tsx` existe pero lee `quizQuestions` de `data/mockData.ts`: es el **cuestionario de onboarding**, no una evaluación de curso | Entidades evaluación, pregunta, opción, intento y resultado, colgadas de la lección o del módulo. Nada de eso está en ninguna migración | bloqueado por contrato | Evaluaciones |
| Curso completado (100 %, ver certificado, valorar, revisar) | p13_0-18 | | x | | `POST /learning/lessons/{id}/complete` devuelve `course_completed` y `course_progress_percent` | No hay pantalla de cierre de curso. «Ver certificado»: **R26 ausente, sin decidir si entra en alcance** | implementar la pantalla; el botón de certificado, bloqueado por contrato | Certificados (R26) |
| Valorar curso (general + Calidad/Claridad/Aplicación, evidencia adjunta) | p13_0-19 | | | x | `POST /reviews` publica una reseña **de persona**, con texto obligatorio, hasta 3 adjuntos y `course_id` opcional | Puntuación 1–5 y sub-puntuaciones: **no hay ninguna columna de rating**. Regla de elegibilidad del blueprint (compra verificada + consumo ≥20 % o ≥30 min únicos) y error `REVIEW_NOT_ELIGIBLE`. Decisión **D6** abierta | bloqueado por contrato | Reseña de curso (D6) |
| Garantía y reembolso (plazo, progreso, motivo, detalles) | p13_0-20 | | x | | `GET /payments/courses/{id}/refund-eligibility` (`server_time`, `eligible`, `expires_at`, `seconds_remaining`, `refund_used`), `POST /payments/refund-requests` con motivo `not_as_expected\|content_quality\|technical_problem\|other` | **«Tu progreso en el curso 12 %» y «solo aplica si tu consumo es menor al 50 %»**: `RefundEligibilityRead` **no devuelve progreso**, y **la regla del 50 % no existe** en `refunds/`. Pintarla sería anunciar una condición que el servidor no aplica. **«Plazo estimado de 2 días hábiles»**: no hay SLA (R14) | adaptar (plazo y elegibilidad reales; sin porcentaje ni umbral inventados) | Umbral de consumo, si se decide, y SLA |
| Certificado de finalización (credencial, QR, verificación pública, PDF) | p13_1-21 | | | x | no existe | Toda la entidad: credencial, emisión, verificación pública, generación de PDF. **R26 ausente y sin decisión de alcance** | bloqueado por contrato | Certificados (R26) |
| Estado de reembolso completado (monto, método, fecha, acceso revocado) | p13_1-24 | | x | | `GET /payments/refund-requests/mine`, `GET /payments/refund-requests/{id}` y el historial con `has_access` | La pantalla de detalle por solicitud no existe: `ComprasYDevolucionesScreen` lista, no detalla. **Fecha de procesamiento y método** viajan en el historial; «tu banco puede tardar 5–10 días» es texto, no dato | adaptar | — |
| Tu entrada (QR dinámico, cómo llegar, Apple Wallet, «¿cambió algo?») | p09 | | | x | `POST /catalog/events/{id}/reserve` marca `reserved_by_me`, sin ticket | Entidades **ticket**, **QR rotatorio**, **evento de check-in** y **transferencia**. Wallet y mapa dependen de recinto con coordenadas | documentar y no tocar | Eventos v2 |
| Comparte tu experiencia · reseña de evento con «asistencia verificada» y cinco ejes | p10 | | | x | `POST /reviews` no tiene puntuación ni eje de asistencia | Puntuación por eje (Contenido, Organización, Recinto, Seguridad, Valor) y el sello **asistencia verificada**, que exige check-in real: «solo un asistente verificado puede reseñar; si la entrada se transfirió, reseña quien entró» | documentar y no tocar | Eventos v2 |
| Mi reserva (estado, unirse a la sesión, reprogramar, cancelar, mensajes) | p14_0-12 | | x | | `GET /bookings?role=`, `PATCH /bookings/{id}` (estados `accepted\|rejected\|cancelled\|reschedule_requested\|completed`), conversación enlazada (`conversation_id`) | «Unirse a la sesión»: no hay sala ni enlace de videollamada asociado a la reserva. Reprogramación **atómica** no existe: hoy es un cambio de `scheduled_at`. Pago protegido: no hay pago de servicios | documentar y no tocar | Servicios v1 |

## 7. Creador / organizador / prestador / vendedor

| Vista de referencia | Captura | Existe | Parcial | No existe | Backend disponible | Contrato faltante | Acción de esta fase | Fase posterior |
|---|---|:--:|:--:|:--:|---|---|---|---|
| Alta profesional · datos legales (nombre legal, documento, país, datos fiscales) | p14_1-1 | | | x | no existe | Entidad prestador con identidad legal y fiscal. Bloqueado además por D4 (entidad que cobra) y por los bloqueos D01–D10 del blueprint de Servicios | documentar y no tocar | Servicios v1 |
| Credenciales profesionales (colegiatura, jurisdicción, evidencia documental, enviar a verificación) | p14_1-2 | | | x | no existe; `VerificationScreen.tsx` es **estado local del teléfono**, sin backend | Entidad credencial (emisor, número, jurisdicción, vigencia, documento) y flujo de verificación. De aquí nacen todos los sellos «verificado» de las capturas | documentar y no tocar | Servicios v1 |
| Mis servicios (publicados/borradores, editar, rendimiento por servicio) | p14_1-3 | | | x | no existe | Catálogo del prestador | documentar y no tocar | Servicios v1 |
| Crear servicio (categoría, tipo de reserva, modalidad, duración, precio fijo o por rango) | p14_1-4 | | | x | no existe | Los cuatro tipos de contratación del blueprint §2: `APPOINTMENT`, `RESERVATION`, `REQUEST`, `PACKAGE` | documentar y no tocar | Servicios v1 |
| Alcance y condiciones (para quién, incluye, no incluye, requisitos, política de cancelación) | p14_1-5 | | | x | no existe | Alcance versionado y política de cancelación por categoría | documentar y no tocar | Servicios v1 |
| Disponibilidad (franjas por día, duración, márgenes, antelación, ventana de reserva) | p14_1-6 | | | x | no existe | Reglas y excepciones de disponibilidad, calculadas en servidor y nunca en el cliente | documentar y no tocar | Servicios v1 |
| Calendarios conectados (Google, Outlook, bloqueo automático) | p14_1-7 | | | x | no existe | Integración externa con sus credenciales; ninguna decisión tomada | documentar y no tocar | Servicios v1 |
| Agenda de hoy (citas por hora, check-in, bloquear tiempo) | p14_1-8 | | x | | `GET /bookings?role=provider` y `AgendaScreen.tsx` pintan las reservas reales | Vista por horas, bloqueo de tiempo y check-in del prestador: nada de eso existe. Las «alertas de sincronización» dependen de calendarios conectados | documentar y no tocar | Servicios v1 |
| Detalle de reserva (resumen, documentos, mensajes, iniciar atención) | p14_1-9 | | x | | `GET /bookings`, `PATCH /bookings/{id}`, conversación enlazada | Documentos adjuntos a la reserva; «iniciar atención» y su registro | documentar y no tocar | Servicios v1 |
| Atención en curso (cronómetro, check-in validado, marcar completada) | p14_1-10 | | x | | `PATCH /bookings/{id}` con `status: completed` fija `completed_at` | Evento de validación de asistencia: hoy el prestador **declara** que terminó. El blueprint exige que el no-show **se determine, no se declare** | documentar y no tocar | Servicios v1 |
| Responder incidencia (motivo, plazo, evidencia, respuesta) | p14_1-11 | | | x | no existe | Entidad incidencia con evidencia y resolución, separada del estado de la reserva | documentar y no tocar | Servicios v1 |
| Rendimiento (servicios completados, puntualidad, cancelación, ingresos, gráfico) | p14_1-12 | | | x | Para **cursos** sí hay equivalente: `GET /commerce/courses/{id}/summary` y `GET /commerce/courses/{id}/sales` | Métricas de prestador: puntualidad, cancelación, recomendación, serie temporal de ingresos. Sin pagos de servicios no hay ingresos que agregar | documentar y no tocar | Servicios v1 |

## 8. Administración y soporte

| Vista de referencia | Captura | Existe | Parcial | No existe | Backend disponible | Contrato faltante | Acción de esta fase | Fase posterior |
|---|---|:--:|:--:|:--:|---|---|---|---|
| Ayuda del curso (tipos de problema, «Mis solicitudes», crear solicitud) | p13_1-22 | | x | | `SupportScreen.tsx` es FAQ + `mailto:` a un buzón. Para dinero sí hay expediente real: `POST /payments/refund-requests`, `GET /payments/refund-requests/mine` | **Sistema de tickets**: no existe para «problema de acceso», «problema con el vídeo» ni «pregunta sobre el contenido». Solo el motivo de reembolso tiene expediente. Además **no hay correo transaccional** (R22): el acuse que la pantalla promete no se envía | adaptar (encaminar solo lo que existe: reembolso al expediente real, el resto al buzón, sin prometer seguimiento) | Tickets con SLA (R14, R23) |
| Detalle de la solicitud (nº legible, línea de tiempo Recibida→En revisión→Resolución, «respuesta estimada 2 días hábiles») | p13_1-23 | | x | | `GET /payments/refund-requests/{id}` (estado y motivo de rechazo), `refund_events` para el historial | **Número de caso legible**: no existe (R13). **SLA y plazo estimado**: no existen (R14). «Añadir información» a un expediente abierto: no hay endpoint | adaptar (línea de tiempo con los estados reales; sin plazo estimado inventado) | Número de caso y SLA |
| Bandeja de devoluciones (administración) | — sin captura | x | | | `GET /admin/refund-requests`, `POST /admin/refund-requests/{id}/take\|approve\|reject\|retry\|reconcile\|cancel` | — | documentar y no tocar | Reembolso parcial, asignación y SLA |

---

## Lista 1 · Datos que las capturas enseñan y HOY no tiene respaldo el servidor

Ordenados por cuántas pantallas caen si se pintan de todos modos.

1. **Puntuación de 1 a 5 y su agregado.** `ReviewRead` no tiene `rating`: no hay
   estrella, ni media, ni histograma, ni recuento, en ninguna vertical. Aparece
   en p02, p04, p11_0-2, p11_0-4, p11_1-5, p11_1-7, p11_1-8, p13_0-19, p14_0-3,
   p14_0-5, p14_0-7 y p06. Nace en el dominio de reseñas, y antes hay que cerrar
   **D6**.
2. **Todos los sellos «verificado».** «Experto verificado», «Identidad
   verificada», «Organizador verificado», «Credencial verificada», «Origen y
   creador verificados». No hay campo de verificación en `profiles` ni en
   `identity`, y `VerificationScreen.tsx` guarda el estado en el teléfono. Nace
   en una entidad credencial con evidencia y jurisdicción.
3. **Número de alumnos, atenciones o compras verificadas** («1.248
   valoraciones», «184 compras verificadas», «128», «Más de 300 asistentes»).
   Hay recuentos internos, pero ninguno es el que la tarjeta promete.
4. **Certificado de finalización.** R26 ausente entero: credencial, QR,
   verificación pública y PDF (p13_0-18, p13_1-21).
5. **Evaluaciones y sus intentos.** La pantalla existe sobre `mockData`; el
   modelo no tiene pregunta, opción ni intento (p13_0-17).
6. **Notas del alumno con marca de tiempo**, y los **recursos de la lección por
   API**: la tabla existe pero ningún endpoint la devuelve (p12_1-16).
7. **Progresión secuencial y segundos únicos.** Los candados de módulo de
   p12_1-15 no los impone el servidor, y el progreso suma repeticiones (R11).
8. **Umbral de consumo del 50 % y progreso en la pantalla de garantía**
   (p13_0-20): `RefundEligibilityRead` no lleva progreso y esa regla no existe.
9. **Impuestos, entidad vendedora, comprobante en PDF y «acceso por 2 años»**
   (p12_0-10, p12_0-11, p12_0-12). Bloqueados por D4 y D5.
10. **Correo transaccional.** Cuatro pantallas prometen un correo que no sale de
    ninguna parte: no hay proveedor en todo el backend (R22).
11. **Número de caso legible y SLA** de cualquier expediente (p13_1-22,
    p13_1-23).
12. **Geolocalización y distancia** («A 2 km de ti», «1.8 km», mapa):
    `events.location` es texto libre, sin coordenadas (p03).
13. **Aforo verificado, tipos de entrada, inventario, precio de evento, ticket,
    QR y check-in** (p07, p08, p09, p10).
14. **Disponibilidad, retención de hueco, zona horaria y pago de servicios**
    (p14_0-9, p14_0-10, p14_1-6).
15. **La vertical de Productos entera** (p05, p06): no hay producto, variante,
    existencias, bolsa, pedido ni política por jurisdicción.
16. **Guardar cursos, eventos, servicios o productos.** `saved_posts` guarda
    publicaciones y nada más (p11_0-4, p03, p05).
17. **Filtros y orden de catálogo.** `GET /catalog/courses` no acepta un solo
    parámetro de filtro y `GET /search` solo `q` y `type` (p11_0-2, p11_0-3,
    p14_0-4).
18. **Rutas / itinerarios de aprendizaje** («Ver ruta», p02).

## Lista 2 · Pantallas que existen en la app y no aparecen en ninguna captura

Rutas de expo-router reales. Que no estén en la referencia no las hace
prescindibles: varias son la única forma de operar lo que ya funciona.

- **Creador de cursos**: `/gestionar-curso/[id]`, `/gestionar-curso/[id]/ventas`,
  `/gestionar-curso/[id]/estudiantes`, `/editar-curso/[id]`. Es todo el lado del
  creador de Cursos, y la referencia solo ilustra el del prestador de Servicios.
- **Compras y devoluciones del comprador**: `/compras`, `/devoluciones/nueva`.
- **Administración de devoluciones**: `/admin/devoluciones`.
- **Social**: `/(tabs)/home`, `/(tabs)/create`, `/post/[id]`, `/edit-post/[id]`,
  `/comments/[id]`, `/reacciones/[id]`, `/hashtag/[name]`, `/reels`,
  `/stories/[id]`, `/stories/nueva`, `/saved`, `/members`, `/circle/[id]`,
  `/followers/[id]`, `/following/[id]`.
- **Mensajería y directos**: `/(tabs)/messages`, `/chat/[id]`, `/live/[id]`,
  `/audio/[id]`.
- **Cuenta y sistema**: `/welcome`, `/login`, `/register`, `/forgot-password`,
  `/reset-password`, `/onboarding`, `/quiz`, `/result`, `/edit-profile`,
  `/settings`, `/language`, `/privacy`, `/terms`, `/blocked`, `/notifications`,
  `/verification`, `/support`, `/dev`.
- **Agenda de reservas**: `/agenda`.

De todas ellas, dos merecen atención en esta fase: `/quiz` y `/result` viven
sobre `mockData` (son el cuestionario de onboarding, no una evaluación), y
`/verification` promete una verificación que no tiene backend.

## Lista 3 · Orden recomendado para los incrementos posteriores

1. **Cerrar Cursos** (filtros y orden de catálogo, guardado de curso, recursos
   por API, pantalla de curso completado, comprobante real). Es lo único que
   esta fase toca y lo que menos depende de decisiones ajenas.
2. **Reseña de curso con puntuación (D6).** Desbloquea, de una vez, la estrella
   y el agregado de once pantallas de la referencia; sin ella toda tarjeta de
   catálogo seguirá siendo incompleta frente al diseño.
3. **Credenciales y verificación de personas.** Es el otro dato que se repite en
   las cuatro verticales, y hasta que exista ningún sello se puede pintar sin
   mentir.
4. **Decisiones de dinero (D4/D5) y correo transaccional (R22).** No son
   pantallas, pero mientras falten, la compra, el comprobante y todo acuse
   siguen bloqueados por contrato, no por código.
5. **Eventos v2.** Va antes que Servicios porque reaprovecha el catálogo que ya
   existe y sus límites son más claros: inventario, ticket y check-in.
6. **Servicios v1.** El más caro: la agenda es concurrencia y husos horarios, no
   pantallas, y arrastra diez decisiones de negocio (D01–D10 de su blueprint).
7. **Productos v1.** El último porque es vertical nueva entera y la que más
   depende de terceros: logística, garantía legal por país y políticas por
   jurisdicción, sin las cuales la venta se bloquea por diseño.
8. **Certificados y evaluaciones (R26).** Deliberadamente al final: son valor
   añadido de Cursos y ni siquiera está decidido que entren en el alcance.

---

## Estado tras el incremento de Cursos (8/09/2026)

Lo que cambió respecto a la tabla de arriba. Solo lo verificable.

### Terminadas

| Vista | Qué la sostiene |
|---|---|
| Explorar con accesos a las cuatro verticales | Cursos y Eventos navegan; Servicios y Productos avisan de que aún no están |
| Portada de Cursos | `GET /catalog/courses` con `q`, `level` y `language`; `GET /learning/me/courses`; `GET /recommendations/courses`; `GET /catalog/courses/saved` |
| Búsqueda y filtro | En el servidor, antes de paginar, con medio segundo de calma |
| Guardados | `PUT`/`DELETE /catalog/courses/{id}/saved`, idempotentes; carrusel y marcador |
| Ficha del detalle | Duración —sumada por el servidor—, idioma, nivel, aprendizajes, público objetivo y requisitos |
| Creador en el detalle | Nombre desde `CourseDetailRead`, enlace al perfil |
| Condiciones antes de pagar | Precio, versión de la oferta y plazo de garantía, los tres del servidor |
| Retorno de compra | `/pago` y `/pago/cancelado` con siete estados |
| Edición del temario | Ocho endpoints; cero escrituras directas a `course_modules`, `course_lessons` y `courses` |

### Parciales

- **Resultados y filtros** viven dentro de la portada, no como pantalla aparte.
  Mismo recorrido con una pantalla menos.
- **Constancia de compra**: el historial existe (`/compras`) y
  `GET /payments/orders/{id}` devuelve estado, curso, importe y acceso. Falta la
  pantalla de detalle de una compra. **No se llamará «factura»**: no hay
  integración tributaria, así que es una constancia.

### Bloqueadas por contrato, no por tiempo

- **Valoraciones del curso.** No existe puntuación en el modelo: `ReviewRead` no
  tiene `rating` y las reseñas actuales son de persona a persona. El contrato
  mínimo que haría falta —puntuación de 1 a 5, comentario opcional, ligada a una
  compra verificada, una activa por derecho, editable, media y conteo calculados
  en el servidor— es una tabla nueva y una decisión de producto sobre quién
  puede valorar. **La sección no se pinta**: una estrella inventada vale menos
  que ninguna.
- **Sellos de verificación.** No hay campo de verificación en `profiles` ni en
  `identity`. «Experto verificado» no se muestra.
- **Duración como filtro.** No hay columna: solo `duration_seconds` por lección.
  Sumarla en cada página o desnormalizarla son las dos una migración.
- **Certificado y evaluación.** Fuera del alcance de este incremento.

### Un dato de contenido, no de código

Los cuatro cursos publicados tienen `level = NULL`. El filtro de nivel funciona,
pero hoy devuelve cero para cualquier nivel porque nadie ha rellenado esa
columna.

---

## Vistas de aprendizaje (13–16), estado real

| Vista | Existe | Parcial | Falta | Contrato disponible | Acción |
|---|---|---|---|---|---|
| 13 · Mis cursos | sí | | | `GET /learning/me/courses` con los tres estados y progreso del servidor | ninguna |
| 14 · Reproductor | | sí | siguiente y anterior lección | el temario ya llega en el detalle | implementada aquí |
| 15 · Temario y progreso | sí | | | progreso calculado en servidor; `hasAccess` decide el bloqueo | ninguna |
| 16 · Recursos | sí | | | `LessonResources` con URLs firmadas | ninguna |
| 16 · Notas privadas | | | todo | **no hay modelo** | documentada, no implementada |

**Notas privadas del alumno.** No existe tabla ni endpoint. El contrato mínimo
sería `lesson_notes(user_id, lesson_id, body, updated_at)` con clave única por
las dos primeras y RLS de dueño. Es una migración más, así que queda para el
siguiente incremento: mezclarlas con los comentarios o con los recursos del
instructor sería confundir dos cosas distintas.

**Evaluación y certificado** siguen fuera: no hay modelo y necesitan decisión de
producto sobre qué cuenta como aprobado.

## Nivel de los cursos

El filtro está probado con los cuatro casos reales, incluido `level` nulo: sin
filtro esos cursos siguen visibles, y con filtro no se cuelan en ningún nivel.
El asistente permite completarlo y publicar **no** lo exige.

**Completar el nivel de los cuatro cursos publicados es una tarea de contenido,
no de código.** No se rellena automáticamente.


---

## Vistas 13–24 tras el incremento de aprendizaje (8/09/2026)

Una fila por captura. **Adaptada** significa que la vista está construida pero
se apartó de la referencia por una regla real del producto, y la regla se
nombra: sin nombrarla, «adaptada» es una excusa.

| # | Vista | Estado | Por qué |
|---|---|---|---|
| 13 | Mis cursos | **Terminada** | Tres estados en pestañas, avance real y «Continuar» solo cuando hay lección siguiente. La biblioteca ya se abre desde Cursos: antes solo existía en modo de desarrollo. |
| 14 | Reproductor | **Terminada** | Pestañas Descripción / Recursos / Notas y «Marcar como completada». |
| 15 | Temario y progreso | **Adaptada** | Check por lección y contador por módulo, con el avance del curso arriba. **No hay módulos bloqueados**: nada en el modelo dice que un módulo dependa de otro, y pintar un candado sería inventarse una regla de desbloqueo. |
| 16 | Recursos y notas | **Terminada** | Recursos ya existían; las notas privadas son la 0057. Varias por lección, cada una con su minuto. |
| 17 | Evaluación | **Terminada** | Migración 0058. Sustituye al cuestionario de `mockData.ts`, que no estaba atado a ningún curso. |
| 18 | Curso completado | **Terminada** | No pinta el 100 % hasta que el servidor lo confirma, y si falta algo dice qué. |
| 19 | Valorar curso | **Adaptada** | UNA puntuación, no cuatro. La captura enseña tres subnotas —contenido, claridad, aplicación— y un adjunto de evidencia; la 0056 guarda un solo `rating` y no hay política de moderación para archivos subidos por alumnos. Las subnotas y la evidencia son **decisión de producto pendiente**, no un olvido. |
| 20 | Garantía y reembolso | **Adaptada** | La tarjeta de garantía y el formulario ya existían con el reloj del servidor. La captura enseña «solo aplica si tu consumo es menor al 50 % del contenido»: **esa regla no existe** en el motor de devoluciones —la garantía son 168 horas desde el primer acceso— y escribirla en pantalla sería anunciar una condición que nadie aplica. |
| 21 | Certificado | **Adaptada** | Migración 0059, con verificación pública. **Sin PDF y sin QR**: generarlos pide una dependencia nueva y un servicio que los firme, y la verificación pública ya cubre lo que el PDF prometía. Se comparte el enlace. El identificador NO es «ZC-2025-034892»: un código con año y contador se recorre entero en una tarde. |
| 22 | Ayuda del curso | **Adaptada** | Los cuatro tipos de problema llevan a lo que YA los resuelve. **No hay bandeja de tickets**: montarla era un dominio entero, y «Mis solicitudes» son las devoluciones, que es lo único con expediente propio. |
| 23 | Solicitud recibida | **Terminada** | Línea de tiempo de tres pasos sobre los ocho estados del expediente. Sin identificador técnico, que es la regla que ya fijaba la pantalla de compras. |
| 24 | Reembolso completado | **Terminada** | La misma pantalla que la 23 en su estado final. El aviso de acceso retirado solo con el dinero devuelto: `approved` no es haber pagado. |

### Lo que sigue bloqueado por contrato

- **Consumo mínimo del blueprint** (≥20 % o ≥30 minutos únicos) para poder
  valorar: se apoya en segundos únicos, que no se miden. Exigirlo sería
  inventarse el dato.
- **Módulos con requisitos previos** (captura 15): no hay dependencia entre
  módulos en el modelo.
- **Método de reembolso** en la captura 24 («Visa terminada en 4242»): la orden
  guarda proveedor, no los cuatro últimos dígitos, y no debe guardarlos.

### Estados que se implementaron aunque no salgan en ninguna captura

Cargando, vacío, error con reintento y «esta función no está montada aquí» (503
por migración sin aplicar) en las seis pantallas nuevas. El cuarto es el que más
importa: con la 0057, 0058 o 0059 sin aplicar, cada pantalla lo dice al llegar
en vez de fingir una avería.


---

## Cierre técnico de Cursos (9/09/2026)

Lo que cerró el hueco que quedaba abierto en el incremento anterior.

| Pieza | Estado | Nota |
|---|---|---|
| Editor de la evaluación (creador) | **Terminado** | En «Gestionar curso», no en el asistente: no es parte de la ficha, decide quién aprueba. |
| Autorización de la evaluación | **Cambiada** | Autor o administración con poder real. **Moderación ya no toca las respuestas correctas.** |
| Auditoría del borrador | **Corregida** | La nota se confirma: antes se deshacía sola en la única puerta por la que sale `is_correct`. |
| Invariantes en PostgreSQL | **Escritas, sin ejecutar** | 24 pruebas nuevas. Omitidas aquí por no haber PostgreSQL; CI las corre. |

### La vista del creador, contra la referencia

La captura no incluye una pantalla de autoría de evaluaciones: es una vista que
el producto necesita y la referencia no cubre. Se construyó con los patrones ya
consolidados —cabecera, `Input`, `Button`, confirmación, cerrojos, estados— y no
como un editor genérico de formularios.

Lo que sostiene, y por qué:

- **La correcta es UNA.** Marcar una apaga las demás. La base lo impone con un
  índice único parcial; dejar llegar a dos correctas sería un guardado que
  revienta sin explicación.
- **Al borrar la correcta la pregunta se queda sin correcta.** No se hereda la
  marca: elegir por su cuenta la respuesta buena de un examen es justo lo que
  una interfaz no puede hacer.
- **Se puede guardar a medias.** Las preguntas completamente en blanco no se
  mandan —la base exige texto— y una a medio escribir se señala en vez de tirarse.
- **Mientras se guarda no se escribe.** Al volver el PUT se reemplaza el
  borrador con el eco del servidor; fusionarlo con lo tecleado sería adivinar.
- **Publicar guarda antes.** Publicar lo que está en el servidor mientras la
  pantalla enseña otra cosa es publicar a ciegas.
- **Despublicar al guardar se dice.** Si lo guardado ya no se puede aprobar, el
  servidor la devuelve a borrador: eso deja a los alumnos sin poder hacerla y no
  puede pasar bajo un toast verde.
