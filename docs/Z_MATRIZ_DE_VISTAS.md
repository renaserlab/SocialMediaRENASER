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

| Vista de referencia | Captura | Existe | Parcial | No existe | Backend disponible | Contrato faltante | Acción de esta fase | Fase posterior |
|---|---|:--:|:--:|:--:|---|---|---|---|
| Productos Z · portada (manifiesto, Selección Z, Elegidos para ti, Creadores de excelencia) | p05 | | | x | no existe (**vertical entera ausente**) | Entidades producto, variante, vendedor, evaluación. «Aprobado por Z», «98 % lo recomienda», «Garantía 3 años»: ninguno tiene columna | documentar y no tocar | Productos v1 |
| Productos Z · buscador y bolsa | p05 | | | x | no existe | Carrito, pedido y línea de pedido | documentar y no tocar | Productos v1 |
| Detalle del producto (galería, sello Z, razones de aprobación, valoración real, compra protegida) | p06 | | | x | no existe | Orden de bloques del blueprint §4. «Valoración real 4.8 · 184 compras verificadas» con desglose Calidad/Fidelidad/Valor exige reseña de producto con compra verificada. «Garantía de 12 meses» y «3 días para reportar incidencia» exigen política por jurisdicción: **sin política aprobada no se vende** (§Productos v1) | documentar y no tocar | Productos v1 |

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
