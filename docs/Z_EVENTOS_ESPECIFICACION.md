# Eventos: especificación del primer incremento vertical

Fuentes: `Z_Eventos_Blueprint_Producto.docx` (§0–§11), la captura de Eventos de
`capturas z excelencia_compressed.pdf`, y el código actual. **Cuando el blueprint
y una captura se contradicen, manda el blueprint**: él mismo lo dice —«las
imágenes son dirección visual; los textos y reglas de este capítulo son la
especificación vinculante»—.

Este documento cubre **solo el primer incremento**: descubrir, buscar, abrir la
ficha y ejecutar la acción que hoy tiene respaldo. No cubre venta de entradas,
curaduría ni liquidación.

---

## 1. Objetivo del incremento

Que una persona pueda recorrer, con datos reales de principio a fin:

    Explorar → Eventos → buscar y filtrar → ficha del evento → reservar

Nada de ese recorrido puede apoyarse en un dato inventado. Lo que el servidor no
sabe, no se pinta.

## 2. Actores

| Actor | Qué puede hoy |
|---|---|
| **Asistente** | Ver los eventos publicados, buscarlos, abrir la ficha, reservar y cancelar su reserva. |
| **Organizador** | Es el `organizer_id` del evento. Hoy lo crea y lo edita desde la hoja de alta del catálogo. |
| **Administración** | Editar cualquier evento (`require_owner_or_admin`). |
| **Curador Z** | **No existe.** El blueprint lo define; el modelo no tiene nada de curaduría. |

## 3. Estados

El blueprint (§5) define doce: `DRAFT`, `SUBMITTED`, `CONDITIONAL`, `APPROVED`,
`PUBLISHED`, `SOLD_OUT`, `SUSPENDED`, `MODIFIED`, `CANCELLED`, `IN_PROGRESS`,
`COMPLETED_PENDING`, `SETTLED`.

**El modelo tiene otra cosa.** `events.status` es el enum `content_status` que
comparte con el resto del contenido: `draft | published | hidden | deleted`. Y en
la práctica **solo se escribe `published`**: `create_event` lo fija y ningún
endpoint permite cambiarlo.

Lo único que sí distingue un evento de otro en el tiempo es `time_state`, que
NO se guarda: se deriva de `starts_at` en cada respuesta y vale `upcoming`,
`past` o `undated` (`catalog/eventos.py`).

**Decisión: este incremento enseña `time_state` y nada más.** Pintar
«Cancelado», «Agotado» o «Seleccionado por Z» sería inventar un estado que
ninguna fila puede tener. Los doce estados del blueprint son una migración y una
máquina de estados que nadie ha aprobado todavía.

## 4. Permisos

| Operación | Quién | Dónde se comprueba |
|---|---|---|
| Listar publicados | Cualquiera, sin sesión | `GET /catalog/events` |
| Ver ficha | Cualquiera, sin sesión | `GET /catalog/events/{id}` |
| Reservar / cancelar | Con sesión | Servidor; la identidad sale del token |
| Crear / editar | Organizador o administración | `require_owner_or_admin` |

El cliente **no escribe** ninguna de estas tablas directamente: todo pasa por la
API, como en Cursos.

## 5. Reglas que sí se aplican hoy

- Un evento **pasado no se reserva**. Lo comprueba el servidor.
- El **aforo** (`capacity`) se comprueba al reservar y responde 409 al llenarse.
  No hay lista de espera aunque la columna admita `waitlist`.
- Reservar es **idempotente**: la clave primaria compuesta `(event_id, user_id)`
  impide dos filas.
- Solo se listan los `published`.

## 6. Recorrido del asistente

1. **Explorar** enseña «Próximos eventos» con las dos primeras tarjetas reales.
2. Tocar una tarjeta abre **la ficha de ese evento**, no el listado.
3. **Eventos** lista lo publicado, agrupado por `time_state`, con buscador y
   filtro de modalidad resueltos **en el servidor**.
4. La **ficha** enseña portada, título, fecha y hora, modalidad, lugar o enlace,
   organizador con acceso a su perfil, descripción y cuántas personas van.
5. La **acción principal** es reservar o cancelar la reserva.

## 7. Recorrido del organizador

Fuera de este incremento salvo lo que ya existe: crear y editar desde la hoja de
alta del catálogo. No se toca.

## 8. Vistas del blueprint · matriz

| Vista del blueprint | Ruta propuesta | API requerida | Modelo disponible | Estado | Bloqueo |
|---|---|---|---|---|---|
| §7.1 Explorar eventos | `/events` (existe) | `GET /catalog/events` + `q` y `type` | `events` | **Este incremento** | — |
| §7.2 Detalle | `/eventos/[id]` (nueva) | `GET /catalog/events/{id}` (nuevo) | `events`, `profiles` | **Este incremento** | — |
| §7.1 · Sello «Seleccionado por Z» | — | — | **no existe** `selection_status` | Bloqueado | Migración de curaduría |
| §7.1 · Ubicación y «Cerca de ti» | — | — | **no existe** latitud/longitud | Bloqueado | Migración de geolocalización |
| §7.1 · «Desde S/ …» | — | — | **no existe** precio en `events` | Bloqueado | Decisión comercial + migración |
| §7.2 · «Por qué está en Z» | — | — | **no existen** verificaciones | Bloqueado | Migración de curaduría |
| §7.2 · Tipos de entrada | — | — | **no existe** `tickets` | Bloqueado | Todo el §9 del blueprint |
| §7.2 · Política de cambios y devolución | — | — | **no existe** para eventos | Bloqueado | Decisión legal |
| §6.3 Checkout | — | — | sin precio ni orden | Bloqueado | §9 y §10 completos |
| §6.4 Entrada (QR) | — | — | **no existe** `tickets` | Bloqueado | §9 completo |
| §8.2 Ranking editorial | — | — | sin afinidad ni calidad Z | Bloqueado | Decisión de producto |

## 9. Lo que la captura enseña y NO se pinta

Cada omisión es una decisión, no un olvido:

- **«A 2 km DE TI» y «Cerca de ti».** `events` no tiene coordenadas. La distancia
  es la afirmación más comprobable de toda la pantalla y no hay con qué hacerla.
- **«Arequipa · Cambiar ubicación».** Mismo motivo: no hay ciudad ni radio.
- **«Más de 300 asistentes».** El conteo real sí existe (`registrations_count`)
  y se enseña tal cual. Lo que no se hace es redondearlo a un número de efecto.
- **«Porque sigues a Darren».** El grafo social existe, pero cruzarlo con eventos
  es una sección de recomendación que nadie ha especificado; sin ella, el título
  sería una etiqueta sin regla detrás.
- **Precio «Desde».** No hay precio.
- **Zona horaria.** `starts_at` es `timestamptz`: se guarda el instante, no la
  zona del evento. Se muestra en la del dispositivo, que es lo que de verdad se
  sabe.
- **Alternar mapa / lista.** Sin coordenadas no hay mapa.

## 10. Criterios de aceptación del incremento

1. Desde Explorar se abre la ficha de un evento concreto.
2. El listado busca y filtra **en el servidor**; los filtros no se aplican sobre
   una página ya descargada.
3. La ficha enseña solo campos que vienen del servidor, y omite los que llegan
   vacíos en vez de rellenarlos.
4. El organizador es un enlace a su perfil real.
5. Reservar y cancelar funcionan desde la ficha, con confirmación y sin permitir
   doble toque.
6. Un evento pasado no ofrece reservar.
7. Cargando, vacío, error con reintento y sin resultados están los cuatro.
8. es / en / pt completos.
9. Ni una tabla nueva, ni una migración, ni un dato simulado.

## 11. Decisiones bloqueadas

| Decisión | Opciones | Recomendación | Impacto | Bloquea |
|---|---|---|---|---|
| **Venta de entradas** | (a) gratis por ahora; (b) Stripe como en Cursos; (c) pasarela propia | (a) hasta que Legal apruebe el §10 | Alto: es el §9 y el §10 enteros | Checkout, entrada, liquidación |
| **Curaduría y sello Z** | (a) sin sello; (b) `selection_status` con flujo de admisión | (b), pero después de la venta | Medio | «Seleccionado por Z», ranking |
| **Geolocalización** | (a) sin distancia; (b) lat/long por evento; (c) ciudad como texto | (c) primero: barata y suficiente para filtrar | Medio | «Cerca de ti», mapa, filtro de ciudad |
| **Estados del evento** | (a) `content_status` actual; (b) los doce del blueprint | (b) cuando haya venta: `CANCELLED` sin devoluciones no sirve de nada | Alto | Cambios, cancelación, reembolso |
| **Aforo y lista de espera** | (a) solo `capacity`; (b) `waitlist` real | (a) hasta que haya venta | Bajo | `SOLD_OUT` |
