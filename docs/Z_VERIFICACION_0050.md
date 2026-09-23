# Verificación de la migración 0050 aplicada a mano

**Fecha de la verificación:** 7 de septiembre de 2026
**Rama:** `Edson`. Sin `push`, sin `merge`, `main` sin tocar.
**Cómo se aplicó la 0050:** a mano, en el editor SQL, por una persona. No hay
herramienta de migraciones ni tabla de control: por eso esta verificación existe.

> **LO QUE ESTE DOCUMENTO NO DICE.** No dice que la 0050 se aplicara sin errores
> porque el comando no los mostrara. Dice qué objetos hay en la base **hoy**,
> comprobados uno a uno, y en qué se diferencian del fichero del repositorio.

---

## 1. Cómo se miró, y por qué así

La conexión se abrió **en solo lectura** (`default_transaction_read_only = on`)
y todas las consultas fueron de lectura sobre catálogos del sistema
(`information_schema`, `pg_indexes`, `pg_trigger`, `pg_policies`, `pg_proc`) y
recuentos.

**No se creó ni un dato de prueba, no se ejecutó nada destructivo, no se probó
concurrencia y no se sembró ninguna política.** El motivo es simple: no se puede
descartar que esa base sea la que usan personas reales, y una comprobación no
justifica escribir en ella. Lo que hacía falta escribir para poder afirmarlo
queda declarado como pendiente en el punto 7, no como aprobado.

No se recoge aquí la cadena de conexión, ni el servidor, ni el usuario.

---

## 2. Lo que se encontró — estructura

| Qué | Esperado por la 0050 | Encontrado |
|---|---|---|
| Tablas nuevas | `course_versions`, `policy_versions`, `consent_records`, `audit_events` | Las 4 |
| Columnas en `orders` | `course_version_id`, `guarantee_hours`, `guarantee_policy`, `terms_version`, `offer_hash`, `snapshot_origin` | Las 6, con tipo, nulabilidad y valor por defecto correctos |
| Columna en `entitlements` | `course_version_id` | Presente |
| Reglas de borrado de las claves ajenas | `set null` donde toca | Correctas |
| Índices | los de la migración, **incluidos los 4 únicos parciales** | Todos |
| Disparadores de inmutabilidad | 6 | Los 6 |
| RLS | activada en las 4 tablas | Activada |
| Políticas de escritura en tablas de dinero | ninguna | Ninguna |

Los **índices únicos parciales** son el punto que más importa de esa lista: son
lo que de verdad impide dos versiones vigentes del mismo curso o dos
consentimientos pendientes del mismo tipo. Un `if` en Python no lo impide, porque
dos peticiones a la vez pasan las dos por el `if`.

## 3. Lo que se encontró — datos

* **Reconstrucción de versiones (backfill): 4 de 4.** Los cuatro cursos
  publicados tienen su versión 1. Sin huérfanos, sin duplicados y sin
  fotografías inválidas.
* **Cero filas** en `orders`, `entitlements`, `policy_versions`,
  `consent_records` y `audit_events`. Es decir: **no hay ninguna compra real en
  juego** en esta base, y ninguna política sembrada todavía.

## 4. Lo que se encontró — el código contra el esquema real

* El ORM consulta las **17 tablas** contra el esquema real sin error de columna
  ni de tipo.
* La aplicación importa y registra sus **137 rutas** con ese esquema delante.

---

## 5. Las dos diferencias entre la base y el repositorio

Aquí está el valor de haber mirado. **La 0050 que corrió no es exactamente la
que hoy está en el repositorio: es una revisión anterior.**

### 5.1 Las huellas de la reconstrucción son SHA-256 corriente

La versión del fichero marca las fotografías reconstruidas con un centinela; en
la base son huellas normales. **No se corrige tocando datos.** Una versión
reconstruida describe el estado actual del curso, no lo que alguien compró, y
reescribir su huella para «arreglarla» sería justo lo contrario de lo que hace
falta.

**Lo que sí se corrigió está en el código:** había una rama que, al republicar,
adoptaba una versión reconstruida reescribiendo su `content_hash`. Eso el
disparador lo rechaza —y hace bien—. Ahora una versión reconstruida se deja
intacta y la primera publicación real crea una **v2 completa**. Se comprobó
revirtiendo el cambio: sin él, la operación falla contra la base de verdad. Una
prueba en SQLite nunca lo habría visto, porque SQLite no tiene disparadores.

### 5.2 El disparador no protegía `origin`

En la base, `impedir_reescritura_de_version` protege `snapshot`, `content_hash`,
`version` y `course_id`, pero **no** `origin`. Los otros cinco disparadores
coinciden con el fichero carácter por carácter.

`origin` es lo que distingue una versión publicada de verdad de una reconstruida.
Con un `update ... set origin = 'publish'`, una fotografía armada en SQL a partir
del estado actual pasaría a presentarse como prueba de lo que se vendió.

**Corregido en la migración `0051`**, que añade `origin`, `published_at` y
`published_by` a la lista. No se editó la 0050: **una corrección posterior a una
migración ya aplicada es siempre otra migración**, o quedan dos versiones del
mismo fichero y nadie sabe cuál corrió en cada base.

---

## 6. Fugas de lectura encontradas al verificar, y la 0052

La verificación destapó algo que las pruebas de la API no podían destapar: **la
API no es el único camino a estas tablas.** El móvil habla con PostgREST, así que
quien decide qué se lee es la RLS, no el esquema de salida de FastAPI. Confirmado
contra la base: `is_admin()` incluye a `moderator`, y `anon` / `authenticated`
tienen concesiones de `select` sobre las tablas nuevas.

Dos formas de la misma fuga:

1. **Nueve políticas** de tablas de dinero decidían con `is_admin()`, que incluye
   a `moderator`. Con su propio JWT y la clave anónima, la cuenta creada para
   ocultar una publicación llegaba a `refund_requests.explanation` —el motivo
   privado que escribe cada alumno, la columna que la 0049 marca «PRIVADO»—, a
   las notas internas de revisión, a los saldos brutos y netos de cada autor, y
   a `audit_events` entero. La API separa moderar de mover dinero desde hace
   tiempo; la RLS no lo hacía, y la RLS es la que decide por PostgREST.
2. Columnas de más en filas que sí corresponden: `consent_records` entregaba a
   cada persona su fila **con** `ip_hash`, `ip_prefix` y `user_agent_family`, y
   `refund_requests` (0049) entregaba al alumno el identificador del reembolso
   en la pasarela y el uuid de quien revisó su expediente. Los esquemas de
   salida omiten los dos grupos a propósito.

**Corregido en la migración `0052`**, por columnas —lo que sobra son columnas,
no filas: quitar la fila dejaría a la persona sin ver su propio consentimiento—
y con una función `puede_mover_dinero()` en SQL, equivalente a `FINANCE_ROLES`.
`is_admin()` no se toca: la usan veinte políticas de moderación.

**Un detalle de la 0052 que conviene no perder.** La primera versión de esa
migración usaba `revoke select (columna) ... from anon, authenticated` y **no
habría servido de nada**: en PostgreSQL los permisos sobre una columna son la
*suma* de los de columna y los de tabla, y Supabase concede `select` sobre la
tabla entera a `anon` y `authenticated` por defecto. La concesión de tabla habría
seguido en pie y las columnas se leerían igual. La versión que queda retira la
concesión de tabla y vuelve a conceder la lista explícita de columnas visibles,
calculada del catálogo para que no envejezca. Efecto secundario buscado: una
columna que se añada en el futuro no queda concedida hasta que alguien lo
decida.

**Qué riesgo tiene ese cambio para la aplicación: ninguno hoy.** Se comprobó qué
tablas lee el móvil directamente por PostgREST —`courses`, `course_modules`,
`course_lessons`, `course_lesson_resources`, `lessons`, `stories`,
`story_views`, `testimonials`, `device_tokens`— y **ninguna de las tres que toca
la 0052 está en esa lista**. Todo lo que la aplicación sabe de consentimientos,
auditoría y devoluciones lo pide a la API, que entra con otro rol y decide con
sus propios esquemas de salida. La 0052 cierra una puerta que hoy no usa nadie;
lo que impide es que se use mañana sin darse cuenta.

El mismo reparto se corrigió en la API, donde el resumen de ventas de un curso
ajeno se abría con `is_admin()`: moderar contenido y mirar la caja de otra
persona son dos permisos distintos.

---

## 6 bis. Lo que encontró la revisión independiente

Una revisión hecha por quien no implementó nada de esto, sobre el diff completo
de la fase. Ocho hallazgos, todos comprobados por mí antes de tocar nada, y
todos corregidos:

| Gravedad | Qué | Cómo se cerró |
|---|---|---|
| Grave | Ocho políticas de dinero más seguían con `is_admin()`; solo se había corregido una | Sección 2 bis de la 0052, y una prueba que recorre todas las migraciones en orden y mira **cómo termina** cada política |
| Grave | El filtro nuevo comparaba por subcadena y se comía en silencio `body_sha256` —el único campo que dice **qué** texto se publicó—, además de `description`, `subscription_id`, `zip`, `discard`… | Los trozos cortos (`ip`, `body`, `card`, `raw`…) pasan a compararse como segmento completo del nombre; la clave de la nota se llama ahora `policy_hash` |
| Media | `test_migraciones_reales` fijaba la última migración en `0051` con la 0052 ya en el cambio: verde solo porque el módulo se salta sin PostgreSQL, rojo en cuanto CI tenga uno | Corregido, con el motivo escrito al lado |
| Media | El contexto de origen quedaba inerte en el despliegue: sin sal, `ip_hash` es `NULL`; y sin proxy declarado, `ip_prefix` era la /24 interna de la plataforma, **la misma para todo el mundo** | Las direcciones internas ya no se guardan como origen —un dato idéntico en todas las filas no es un dato pobre, es falso—, y las dos variables quedan declaradas en `render.yaml` sin valor |
| Baja | El filtro detectaba IPv4 y correos, pero no IPv6, que el sistema sí maneja | Añadido, preguntándole a `ipaddress` en vez de con una expresión regular aproximada |
| Baja | Una constante de pruebas declarada y nunca usada | Ahora sostiene una regla: una migración correctora no crea tablas y dice cómo deshacerse |
| Baja | La 0051 no cambia nada en una base nueva, y el fichero no lo decía | Dicho en su cabecera |
| Baja | La separación de savepoints no tenía prueba | Tres pruebas; comprobadas fusionando de nuevo los savepoints, con lo que dos de las tres fallan |

---

## 7. Lo que queda pendiente, y por qué

Nada de esto está aprobado. Está pendiente.

### 7.1 Sembrar la política de recompra — **bloqueado**

No se sembró porque **no se puede descartar que esa base sea la de producción**,
y sembrar es escribir. Es lo único que falta para que el circuito de
consentimientos funcione de punta a punta.

Cuando haya una decisión sobre el entorno, esto es lo que hay que hacer, con una
cuenta de rol `admin` (no `moderator`):

```
POST /api/v1/admin/policies/seed-refund-repurchase
```

Es idempotente: llamarlo dos veces devuelve la misma fila y **solo la primera
deja nota en la auditoría**. Si la 0050 no estuviera aplicada, responde 404 con
`governance_not_available` en vez de escribir nada.

### 7.2 Las pruebas sobre PostgreSQL de verdad — **pendientes**

Las pruebas corren sobre SQLite, y SQLite **no tiene RLS, ni disparadores, ni
concurrencia real** (la base en memoria comparte una sola conexión) e ignora las
claves ajenas por defecto. Todo lo que esta fase afirma sobre invariantes en
concurrencia necesita un PostgreSQL desechable.

El demonio de Docker no arranca en esta máquina, así que **estas pruebas no se
ejecutaron y no se dan por aprobadas.** Quedan sin ejecutar:

* la secuencia completa de las 50 migraciones sobre una base limpia (el prólogo
  que suple lo que Supabase da por hecho ya está escrito, en
  `supabase/tests/prologo_local.sql`);
* la prueba de dos publicaciones simultáneas del mismo curso, que es la que
  demuestra que el índice único parcial —y no un `if`— es lo que impide dos
  versiones vigentes.

La sustituta que hay hoy comprueba el índice directamente, que es útil pero **no
es la misma prueba**. La base real nunca se usa como sustituto de esto.

### 7.3 Poner la sal y decidir el proxy — **pendiente, es una acción de persona**

`IP_HASH_SALT` y `TRUST_PROXY_HEADERS` quedan declaradas en `render.yaml` sin
valor. Hasta que alguien ponga la sal en el panel —32 caracteres o más, distinta
por entorno— `ip_hash` será `NULL` en todas las filas, a propósito. Y
`TRUST_PROXY_HEADERS` solo se pone en `true` sabiendo cuántos proxys hay
delante: con dos saltos, la última entrada de `X-Forwarded-For` es la del proxy
interior y no la de quien pide.

### 7.4 QA físico — **pendiente**

Sin ejecutar y sin dar por válido: botón atrás de Android, gesto de retroceso
predictivo, micrófono, notas de voz, cámara, adjuntos, recorte, tipografía
ampliada, lector de pantalla real, directo con dos teléfonos y superficie de
vídeo a 100 ms.

---

## 8. El orden de despliegue no es opcional

**Primero la migración, después el código.** Las seis columnas nuevas de `orders`
se leen sin comprobar antes si existen: un despliegue del código contra una base
sin la 0050 rompe la creación de órdenes. El resto del módulo de gobernanza sí
comprueba el esquema y se degrada sin romper nada, pero `orders` no.

Orden correcto: `0050` → `0051` → `0052` → código.

## 9. Cómo se deshace

* **0052:** `grant select` sobre las tres tablas completas, restaurar
  `audit_events_read` con `is_admin()` y `drop function puede_mover_dinero()`.
  Está escrito al principio del fichero. No toca ni una fila.
* **0051:** volver a la definición de la 0050, que es la misma sin las tres
  comparaciones nuevas. No hay datos que deshacer.
* **0050:** no se deshace a la ligera. Si hubiera que hacerlo, primero se
  eliminan los disparadores, después las políticas, después las tablas y por
  último las columnas de `orders` y `entitlements`. Con compras reales en la
  base, **eso borra las fotografías de lo que se vendió**: en ese caso se degrada
  el código, no se borra el esquema.

## 10. Incidencias de la propia verificación

* Una expresión regular del filtro de auditoría se escribió con un carácter de
  control invisible dentro y dejó de casar ninguna dirección IP. **El filtro
  seguía pareciendo correcto y no protegía nada**, y ninguna prueba lo veía
  porque no había. Se detectó revisando el fichero en crudo. Desde entonces ese
  código no se escribe por línea de órdenes, y hay 25 pruebas que lo cubren.
* Una prueba del móvil sobre la versión adquirida era tautológica: comprobaba la
  condición, no la rama `else`, así que pasaba igual con el defecto que decía
  impedir. Corregida, y comprobada inyectando ese defecto.
* Al revertir una prueba de inyección con `git checkout --` sobre un fichero que
  además tenía trabajo sin confirmar, perdí ese trabajo y tuve que rehacerlo.
  Para comprobar que una prueba falla con el defecto puesto, el fichero se copia
  antes a un sitio aparte; `git checkout` restaura la versión confirmada, no la
  que había hace un minuto.
* La primera versión de la 0052 cerraba las columnas con `revoke` de columna
  sobre una concesión de tabla, que en PostgreSQL no quita nada. Se detectó antes
  de aplicarla, comprobando de dónde salen las concesiones de `anon` y
  `authenticated`: no las da ninguna migración de este repositorio, las da
  Supabase por defecto y son de tabla. **Esta es la clase de fallo que se ve
  verde en cualquier prueba**: la migración se aplica sin error y no protege
  nada.
