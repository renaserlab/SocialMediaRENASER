# Videos de publicaciones en S3 + CloudFront (opción B)

Implementación de la spec «Zeta · Spec: videos en S3 + CloudFront (opción B)»
(v3, aprobada tras dos revisiones de QA). Este documento dice qué hay en el
código, cómo se despliega por fases y cómo se activa. El porqué de cada
decisión está en la spec y en los comentarios del código.

> **Regla:** el bucket no lo lee nadie más que CloudFront, y CloudFront solo
> entrega con una firma que da la API después de revisar la visibilidad.

> **Todo nace apagado.** Desplegar este código sin tocar ninguna bandera no
> cambia nada para nadie: los videos siguen yendo a Supabase, la API no firma
> nada en CloudFront y los endpoints de publicaciones responden igual que
> antes. Todo lo que toca producción (pilas, migración, secreto, banderas y el
> script de la fase 4) se ejecuta solo con el OK explícito de Luis, fase por
> fase.

## Qué hay en el código

| Pieza | Dónde |
| --- | --- |
| Migración 0116: `post_media.almacen`, `medios_subidas`, `post_media_respaldo_supabase` (RLS cerrada, idempotente, con vuelta atrás comentada) | `supabase/migrations/0116_medios_en_s3.sql` |
| Banderas y configuración | `apps/api/app/core/config.py` (bloque «Videos de publicaciones en S3») |
| Predicado común de visibilidad | `apps/api/app/modules/content/visibilidad.py` |
| Firma de CloudFront (comodín por carpeta, ventanas de 1 h + 6 h, RSA-SHA256, LRU) y token del HLS | `apps/api/app/modules/medios/firma.py` |
| Hidratación única (`media_url`, `poster_url`, `stream_url`, `urls_expiran`, `almacen`) | `apps/api/app/modules/medios/hidratacion.py`, llamada desde `content/router._load_media_map` |
| `AlmacenDeMedios` (`SupabaseStorage` / `S3Storage`) | `apps/api/app/modules/medios/almacen.py` |
| Publicar/editar/borrar con S3, baja de cuenta | `apps/api/app/modules/medios/publicacion.py` |
| Subidas, limpieza diaria, salud | `apps/api/app/modules/medios/router.py`, `limpieza.py` |
| Procesado leyendo y escribiendo en S3 (derivados versionados) | `apps/api/app/modules/content/media_processing.py` |
| HLS con token y reescritura de master y variantes | `content/router.media_hls_playlist` → `_hls_de_s3` |
| App: cabecera, URLs de la API, re-pedido de vencidas, subida a S3 | `apps/mobile/src/lib/mediosS3.ts`, `feed/urlsDeMedios.ts`, `services/subidaDeVideoS3*.ts`, `services/api.ts`, `services/plataforma.ts` |
| Infra (sin desplegar) | `infra/aws/03-medios.yaml`, cambios en `infra/aws/02-plataforma.yaml` y perfiles |

### Endpoints nuevos

| Método y ruta | Quién | Qué |
| --- | --- | --- |
| `POST /api/v1/medios/subidas` | sesión + bandera | `{tipo, content_type, bytes, grupo}` → PUT prefirmado (≤ 50 MB) o multipart de 10 MiB |
| `POST /api/v1/medios/subidas/{id}/partes` | sesión + bandera | URLs de partes por tandas (15 min, tamaño exacto firmado) |
| `GET /api/v1/medios/subidas/{id}` | sesión + bandera | partes ya subidas (`ListParts`) para reanudar |
| `POST /api/v1/medios/subidas/{id}/completar` | sesión + bandera | cierra el multipart; en una simple, comprueba que el archivo llegó |
| `DELETE /api/v1/medios/subidas/{id}` | sesión | cancela |
| `GET /api/v1/posts?ids=a,b` | cualquiera | hasta 50 publicaciones concretas (re-pedir URLs vencidas) |
| `POST /api/v1/tareas/medios/limpieza` | `X-Medios-Tareas-Token` | limpieza diaria (contesta 202 y trabaja en segundo plano) |
| `GET /api/v1/admin/medios/salud` | administración | listado del bucket + firma de prueba + GET a CloudFront |

`POST /posts` y `PATCH /posts/{id}` aceptan `media[].id_de_subida` y
`media[].id_de_subida_poster`. `/platform/config` trae `medios_s3_subida`
(para quien pregunta) y `medios_s3_lectura`.

### Banderas y configuración

Variables de entorno de la API (en producción, las de la plantilla las escribe
el arranque de la pila 02; las secretas van en `zexcelencia/produccion/api`):

| Variable | De fábrica | Dónde | Qué hace |
| --- | --- | --- | --- |
| `MEDIOS_S3_SUBIDA` | `nadie` | plantilla 02 (`MediosS3Subida`) | `nadie` / `lista` / `todos`: quién sube sus videos de Reel, Publicación y Edición a S3 |
| `MEDIOS_S3_SUBIDA_CUENTAS` | vacío | secreto | uid separados por comas para `lista` |
| `MEDIOS_S3_LECTURA` | `false` | plantilla 02 (`MediosS3Lectura`) | si la API firma y devuelve las publicaciones con videos en S3 (interruptor de emergencia) |
| `PUBLICACIONES_VISIBILIDAD` | `abierta` | plantilla 02 (`PublicacionesVisibilidad`) | `estricta` aplica el predicado a todas las publicaciones |
| `MEDIOS_S3_BUCKET`, `MEDIOS_S3_REGION` | vacío, `us-east-1` | plantilla 02 | sin bucket, todo lo de S3 está apagado |
| `CLOUDFRONT_MEDIOS_DOMINIO`, `CLOUDFRONT_MEDIOS_DISTRIBUCION_ID` | vacío | plantilla 02 | firmar e invalidar |
| `CLOUDFRONT_MEDIOS_KEY_PAIR_ID` | vacío | secreto | id de la clave pública del grupo de claves |
| `CLOUDFRONT_MEDIOS_PRIVATE_KEY_B64` | vacío | secreto | PEM privada en **base64 de una línea** (el arranque trunca las multilínea) |
| `MEDIOS_TAREAS_TOKEN` | vacío | secreto | ≥ 32 caracteres; sin él, la limpieza responde 503 |
| `MEDIOS_MAX_VIDEO_MB`, `MEDIOS_PUBLICACIONES_CON_VIDEO_POR_HORA` | 500, 20 | — | topes |

## Cómo se despliega por fases

Cada fase se revierte sola y la siguiente no empieza sin pasar su puerta.

### Fase −1 · Telemetría

Se despliega `feature/medicion-video-en-telefono` (migración 0115, tramo con
`almacen`). La API de esta rama ya devuelve `media[].almacen`, que es de donde
la app de telemetría saca `post.mediaAlmacen`.

### Fase 0 · Infra de prueba

1. Generar un par RSA 2048 para la prueba:
   `openssl genrsa -out prueba.pem 2048 && openssl rsa -in prueba.pem -pubout -out prueba.pub.pem`.
2. Crear la pila de prueba con `infra/aws/03-medios.yaml`, `Variante=prueba`,
   `ClavePublicaA=<contenido de prueba.pub.pem>` (y `ExpectedAccountId`).
   Validar antes con `cfn-lint infra/aws/03-medios.yaml`.
3. API local con un perfil SSO / assume-role acotado a ese bucket (sin claves
   de larga vida) y un `.env` local con: `MEDIOS_S3_BUCKET`,
   `CLOUDFRONT_MEDIOS_DOMINIO`, `CLOUDFRONT_MEDIOS_DISTRIBUCION_ID`,
   `CLOUDFRONT_MEDIOS_KEY_PAIR_ID` (salida `IdDeLaClavePublicaA`),
   `CLOUDFRONT_MEDIOS_PRIVATE_KEY_B64=$(base64 -w0 prueba.pem)`,
   `MEDIOS_S3_SUBIDA=todos`, `MEDIOS_S3_LECTURA=true`,
   `PUBLICACIONES_VISIBILIDAD=estricta`. Migración 0116 en una base local.
4. Comprobar (spec, fase 0): 403 sin firma, 200 con firma, 403 directo al
   bucket, `x-cache: Hit from cloudfront` y `x-amz-cf-pop` LIM/GRU en la
   segunda pedida, subida simple y por partes con reanudación, procesado, HLS
   reescrito en iPhone y Android, borrado diferido e invalidación, y que los
   logs v2 llegan al bucket de logs.

*Rollback:* borrar la pila de prueba (los buckets van con `Retain`: vaciarlos
y borrarlos a mano).

### Fase 1 · Backend y app capaces, sin subidas

1. Pila 02: `BucketDeMedios`, `DistribucionDeMedios`, `DominioDeMedios` con los
   de la pila 03 de producción; `SaltosDeMetadatosDelContenedor=2` **solo si
   Luis lo aprueba** (sin eso el contenedor no obtiene credenciales del rol y
   la API no llega a S3; ver la nota del parámetro); `MediosS3Lectura=true`;
   `MediosS3Subida=nadie`; `PlanificadorDeMedios=Si`. Cambiar la plantilla
   de arranque renueva las máquinas (instance refresh).
2. Pila 03 de producción (`Variante=produccion`) y en el secreto:
   `CLOUDFRONT_MEDIOS_KEY_PAIR_ID`, `CLOUDFRONT_MEDIOS_PRIVATE_KEY_B64`,
   `MEDIOS_TAREAS_TOKEN`. El secreto solo se lee al arrancar una instancia.
3. Pegar la migración 0116 en el editor de Supabase (la API la ve en ≤ 1 min).
4. Desplegar la API y publicar la app por EAS Update (si `runtimeVersion` no
   cambia). Las versiones anteriores a la 1.2.4 cuentan como clientes viejos.
5. **Prueba de humo** justo después del instance refresh:
   `GET /api/v1/admin/medios/salud` con una sesión de administración debe dar
   `bucket: "ok"`, `firma: true`, `cloudfront: 200`.
6. Encender `PublicacionesVisibilidad=estricta` (la spec lo pone en la fase 1;
   aquí va por separado para poder revertirlo solo).

*Puerta:* tests verdes, salud en verde, ≥ 95 % de sesiones con la versión nueva
y ningún error nuevo en 72 h. *Rollback:* imagen anterior de la API; la
migración es aditiva y se queda.

### Fase 2 · Subidas nuevas a S3

1. `MediosS3Subida=lista` y los uid internos en `MEDIOS_S3_SUBIDA_CUENTAS`.
2. Cuando pasen 20 videos internos sin errores: `MediosS3Subida=todos`.

*Rollback:* `MediosS3Subida=nadie` (lo ya subido se sigue sirviendo);
`MediosS3Lectura=false` lo oculta.

### Fase 3 · Medir

`medir.mjs`, `sondear.mjs` y la telemetría por `almacen`.

### Fase 4 · Migrar los existentes — **no implementada en esta rama**

El script de migración (`apps/api/scripts/`) no está escrito: la tabla
`post_media_respaldo_supabase` ya existe para él. Debe saltar las filas en
`processing`, copiar original, póster y 720p (HLS solo si la fase 0 aprobó la
reescritura), verificar tamaño y checksum, y en una transacción guardar las
rutas viejas en el respaldo y cambiar la fila a `almacen = 's3'`.

### Fase 5 · Limpieza

Sin código nuevo: borrar de `post-media` los migrados a los 30 días.

## Rotación de la clave de firma

1. Poner la pública nueva en el hueco libre (`ClavePublicaB` si la actual está
   en `A`) y actualizar la pila 03.
2. Actualizar `CLOUDFRONT_MEDIOS_KEY_PAIR_ID` y `..._PRIVATE_KEY_B64` en el
   secreto.
3. Instance refresh del ASG.
4. Más de 6 h después de reemplazada la última instancia vieja, vaciar el
   hueco viejo.

## Riesgos conocidos

- **La web paga un `OPTIONS` extra.** La cabecera `X-Zeta-Medios` va en todas
  las peticiones de la app, también en los GET anónimos de la web, y una
  cabecera propia obliga a la comprobación previa de CORS (el navegador la
  guarda `max_age` = 10 min por URL).
- **`/tmp` del contenedor mide 256 MB** (`--tmpfs /tmp:size=256m` en la pila
  02) y el procesado caro baja el original entero a disco: un video de más de
  ~250 MB que necesite 720p o HLS fallará igual que hoy con Supabase. No lo
  cambia esta rama.
- **Copiar y luego guardar.** Al publicar, el video se copia a `videos/…`
  antes de confirmar la fila; si la base falla en medio, la carpeta queda sin
  fila. La limpieza diaria la mueve a `borrados/` a los 7 días (y se borra a
  los 30).
- **Restaurar** una publicación borrada: la función existe
  (`publicacion.restaurar`) pero hoy ningún endpoint deshace un borrado.
