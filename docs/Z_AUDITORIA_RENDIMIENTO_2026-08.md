# Auditoría de rendimiento de Z — 27 de agosto de 2026

Documento de diagnóstico. Cada afirmación de aquí va con la medición que la
sostiene, y lo que no se pudo medir está marcado como tal.

Lo que se buscaba responder: **por qué Z se sigue sintiendo lenta después de
haber migrado el backend de Render a AWS.**

La respuesta corta: se sentía lenta por tres motivos distintos que no tenían
nada que ver entre sí, y ninguno de los tres era la base de datos.

1. **Las imágenes.** Una pantalla de Inicio descargaba ~24,7 MB de fotos,
   porque se sirve el fichero original de la cámara. Ocho avatares reales
   sumaban 10,12 MB para pintarse en círculos de 40 píxeles.
2. **El móvil seguía hablando con Render.** Toda la migración a AWS llegó a la
   web y no llegó a ningún teléfono. Render duerme: 21,5 s medidos.
3. **Peticiones repetidas y trabajo en el sitio equivocado.** Cosas que se
   pedían dos veces en cada arranque, avisos push enviados dentro de la
   petición, y un lote de señales que costaba hasta 50 viajes a la base.

Lo que **no** era: no había N+1 en los listados del backend, los payloads no
eran grandes, y AWS responde bien. Los tres se comprobaron y se descartan más
abajo, con números.

---

## 1. Cómo se midió

- **Latencia de API**: `curl` contra los dos backends desplegados, varias veces.
- **Cascada de red real**: la web publicada, cargada en un navegador, leyendo
  la Resource Timing API del propio navegador (`performance.getEntriesByType`).
- **Tamaño e impacto de las imágenes**: `naturalWidth/naturalHeight` de cada
  `<img>` contra su tamaño real en pantalla, y descarga de cada fichero para
  pesarlo.
- **Consultas SQL por endpoint**: banco de pruebas temporal con un escucha
  `before_cursor_execute` de SQLAlchemy sobre una base en memoria, midiendo
  cada endpoint con **dos tamaños de conjunto** (6 y 60 publicaciones). Si el
  número de consultas crece con el conjunto, hay N+1. Es la misma técnica que
  ya usaban `test_mensajes_rendimiento.py` y `test_feed_recomendado_rendimiento.py`.
- **Estado real de los datos**: leyendo la API pública de producción. Solo
  lecturas.

El banco de medición fue temporal y **no** se ha dejado en el repositorio. La
instrumentación que sí queda es la que ya existía (`src/lib/perf.ts`), apagada
salvo con `EXPO_PUBLIC_PERFORMANCE_DEBUG=1`.

---

## 2. Qué backend usa cada superficie

Esto era la primera pregunta y la respuesta era mala.

| Superficie | Antes | Ahora | Cómo se comprobó |
|---|---|---|---|
| Web (Vercel) | **AWS** ✅ | AWS | Descargando el bundle publicado y buscando la URL base dentro |
| EAS `production` | **Render** ❌ | AWS | `apps/mobile/eas.json` |
| EAS `preview` | **Render** ❌ | AWS | `apps/mobile/eas.json` |
| EAS `development` | **`localhost:8000`** ❌ | AWS | El perfil no tenía bloque `env` ninguno |
| Desarrollo local | `localhost:8000` | igual | `apps/mobile/.env` |

La web ya iba a AWS. **Ningún teléfono iba.** La URL de AWS
(`https://d33u17ka1rcaax.cloudfront.net`) no estaba escrita en ningún fichero
del repositorio: vivía solo en el panel de Vercel.

### Lo que costaba

| | Render | AWS (CloudFront) |
|---|---|---|
| `/health`, instancia dormida | **21,47 s** | no duerme |
| `/health`, ya despierta | 0,38 – 0,78 s | **0,29 – 0,66 s** |

Los dos backends servían el **mismo código**: el `openapi.json` de los dos era
idéntico byte a byte (171 753 bytes, 97 rutas). O sea que la diferencia no era
de versión: era que uno se duerme y el otro no.

El perfil `development` merece mención aparte. Sin bloque `env`, una build de
desarrollo salía con `localhost:8000` **y sin claves de Supabase**, que es
justo la condición que enciende el modo demostración con datos inventados
(`mockData.ts`). Una build así parece una aplicación que funciona, llena de
gente y contenido que no existen.

---

## 3. La causa principal: las imágenes

### La medición

Cargando Inicio en la web publicada, con datos reales:

- **43 peticiones**, 19 de ellas a Supabase Storage.
- **24,69 MB de imágenes** en una sola pantalla.
- **14 imágenes, 0 con derivado.** Todas eran el fichero original.

Comparando el tamaño real del fichero con el tamaño al que se pinta:

| Fichero original | Se pinta a | Desperdicio |
|---|---|---|
| 4284×5712 (24,5 Mpx) | 40×40 | **3 823×** |
| 3024×4032 (12,2 Mpx) | 40×40 | 1 905× |
| 1170×2532 (3,0 Mpx) | 40×40 | 463× |

Una sola foto del muro pesaba **6,16 MB**. Tres avatares pesaban 3,9 MB,
3,5 MB y 2,2 MB — para tres círculos de 40 píxeles.

### Por qué pasaba

Dos causas distintas, y conviene no confundirlas:

**(a) Ningún medio publicado tiene derivados.** Consultando la API de
producción: **16 de 16 medios** con `feed_path`, `poster_path`, `stream_path`,
`width`, `height` y `bytes` todos a `null`. Los 3 vídeos, sin póster y sin HLS.

Y sin embargo los 16 están marcados `processing_status = 'ready'`. Ahí está el
fallo silencioso: la migración `0021` añadió la columna con
`default 'ready'`, así que **todo lo que ya existía quedó marcado como
procesado sin estarlo**. Como el sistema cree que están listos, nunca se
reintenta. Todo el contenido actual es anterior a que existiera el procesado.

**(b) Los avatares no tienen procesado en absoluto.** El pipeline
(`media_processing.py`) trabaja sobre el bucket `post-media`. Los avatares
viven en `avatars` y nunca pasan por ahí. Además, la compresión en el cliente
(`compressionAvailable`) es **falsa en web y en Expo Go**, así que una foto de
perfil subida desde el navegador se guarda tal cual sale de la cámara.

### Qué se hizo

Se pide la misma ruta por el endpoint de transformación de Storage
(`render/image`), que devuelve la versión ya escalada. El original no se toca.

Medido sobre los **8 avatares reales que hay en producción**:

| | Antes | Ahora |
|---|---|---|
| 8 avatares | **10,12 MB** | **34 KB** |

**305 veces menos**, 10,08 MB ahorrados en una pantalla. Caso extremo: uno pasa
de 3 909 KB a 3,6 KB (1 091×).

La URL lleva parámetros fijos, así que sigue siendo estable y la caché en disco
de `expo-image` sigue acertando. Volver atrás es quitar las opciones de una
llamada.

> **Decisión de negocio pendiente.** Las transformaciones de imagen de Supabase
> están **ya activadas** en este proyecto (se comprobó: responden 200 y
> redimensionan de verdad) pero se facturan por uso. No es un proveedor nuevo
> ni una CDN nueva; es una función del proveedor que ya se usa. Aun así,
> conviene mirar el consumo.

### Lo que esto NO arregla

Las **fotos y vídeos del muro** siguen sirviéndose enteros. El bucket
`post-media` es privado y se firma **por lotes**, y la API de firma por lotes
de Supabase no admite transformaciones (solo la de firma individual, que
volvería a ser una petición por imagen — justo el cuello de botella que se
quitó en su día).

Se probó si bastaba con añadir los parámetros a una URL ya firmada: **no**. Se
comprobó midiendo, y las dimensiones volvían intactas (3000×4000 pidiendo 400).
La transformación tiene que ir dentro del token firmado.

Para el muro el camino correcto es el que ya está diseñado: **rellenar los
derivados** con `scripts/procesar_media.py`. Son 16 medios, es barato, y
necesita la `service_role` key. Está en «Pendientes».

---

## 4. El vídeo se descargaba tres veces

En una sola visita a Inicio, el mismo `.mp4` se descargó **tres veces**, con
tres URLs firmadas distintas (4 827 ms, 3 918 ms y 559 ms).

La causa: al arrancar hay tres llamadas simultáneas con rutas que se solapan
—la instantánea del feed, la primera página de red y el feed de vídeo—. Las
tres calculaban qué les faltaba **antes** de que ninguna hubiera escrito en la
caché de firmas, así que la misma ruta se firmaba tres veces.

Y cada firma de la misma ruta devuelve una **URL distinta**. `expo-image` y
`expo-video` cachean **por URL**, así que tres firmas del mismo vídeo son tres
descargas del mismo vídeo. Exactamente lo que la caché de firmas existía para
evitar.

Arreglado con un mapa de firmas en vuelo: quien llega segundo espera el
resultado del primero.

---

## 5. Lo que se descartó midiendo

Estas tres hipótesis eran las «obvias» y las tres son falsas. Se dejan escritas
para que nadie vuelva a perseguirlas.

### «Es la base de datos / hay N+1»

Se midieron 21 endpoints con dos tamaños de conjunto (6 y 60 publicaciones,
3 y 15 conversaciones). **El número de consultas no creció en ninguno**:

| Endpoint | Consultas con 6 | Consultas con 60 | ¿Crece? |
|---|---|---|---|
| Muro (`/posts`, 20 elementos) | 5 | 5 | no |
| «Para ti» (`/recommendations/content`) | 5 | 5 | no |
| Conversaciones | 4 | 4 | no |
| Notificaciones | 1 | 1 | no |
| Perfil propio / ajeno | 1 | 1 | no |
| Seguidores / siguiendo | 1 | 1 | no |
| Buscar perfiles | 1 | 1 | no |

Los listados calientes están bien construidos. La optimización de Mensajes
(1+3N → 4) sigue funcionando y su prueba la sigue vigilando.

### «Los payloads son enormes»

20 publicaciones del muro con sus autores, medios, etiquetas y menciones:
**13,5 KB de JSON**. No es el problema. (Sí hay margen en las fichas de curso,
que llevan `description` completa en los listados — está en «No corregido».)

### «Es AWS / es CloudFront»

AWS responde en 0,29–0,66 s. Y CloudFront está bien configurado: usa las
políticas gestionadas `Managed-CachingDisabled`
(`4135ea2d-6df8-44a3-9df3-4b5a84be39ad`) y `Managed-AllViewerExceptHostHeader`
(`b689b0a8-53d0-40ab-baf2-68738e2966ac`). Es decir: **no cachea respuestas
autenticadas** y sí reenvía `Authorization`. No hay fuga de sesión entre
usuarios por caché.

---

## 6. Arranque: lo que se pagaba siempre

| Qué | Antes | Ahora |
|---|---|---|
| `/profiles/me` en cada arranque | **2×** | 1× |
| Estado del cuestionario en cada arranque | **2×** | 1× |
| Peticiones al renovar el token (y al volver a primer plano) | **4** | 0 |
| `/catalog/courses/mine` al abrir Biblioteca | **2×** | 1× |
| Llamada a `/health` al arrancar | 1 (1 s medido) | 0 |
| `OPTIONS` previo en cada GET anónimo | 1 por petición | 0 |
| Fuentes cargadas en iOS antes de pintar | 6 (ninguna se usa) | 0 |

`supabase-js` emite `INITIAL_SESSION` nada más suscribirse, y el oyente hacía
lo mismo que `bootstrap` justo después. `TOKEN_REFRESHED` era peor: repetía las
cuatro peticiones cada vez que caducaba el token.

Lo de las fuentes: `theme/tokens.ts` devuelve `'System'` para los seis pesos
cuando la plataforma es iOS. Ni un texto pedía Inter, y aun así se registraban
las seis y el splash las esperaba. En web y Android sí se usan y se siguen
cargando.

---

## 7. Backend: trabajo en el sitio equivocado

### Los avisos push bloqueaban la conexión a la base

`send_push` lee los tokens y luego habla con `exp.host` con una espera de hasta
10 segundos — y se llamaba con `await` **dentro** del handler.

Lo grave no es que el «me gusta» tardara. Es que la sesión de la petición
mantiene su conexión **ocupada** durante toda esa llamada de red. El pool son 5
conexiones más 5 de reserva: con diez interacciones a la vez y Expo lento, se
agota y **cualquier otra petición** —el muro, el perfil, los mensajes— espera
turno. Un aviso que no le importa a nadie podía tumbar cosas que sí.

Además, etiquetar a diez personas hacía diez lecturas de tokens y diez
peticiones a Expo, en fila.

Ahora va en segundo plano con su propia sesión, y las menciones salen en un
solo envío (Expo admite 100 mensajes por petición).

### Un lote de señales costaba hasta 50 INSERT

`POST /recommendations/events` hacía el `INSERT` **dentro del bucle**. El móvil
manda hasta 25 señales por lote y el esquema admite 50: a ~70 ms por viaje
contra Supabase, eran hasta **3,5 s** de ir y venir mientras la persona sigue
bajando el feed. Era la única N+1 de escritura que quedaba.

Ahora son **2 como mucho** (dos y no uno porque las señales con contexto de
recomendación traen tres columnas más). Hay prueba que lo fija.

### Un fallo del recomendador tumbaba la pantalla

Los tres endpoints llamaban al servicio sin red de seguridad, así que un fallo
dentro salía como **500**. Y un 500 sin manejar de Starlette **no lleva
cabeceras CORS**: en la web el navegador no lo lee como error del servidor, lo
lee como «sin conexión». Un fallo al *ordenar* el muro se veía igual que
quedarse sin internet.

Ahora se degrada a 200 con lista vacía y `strategy="fallback"`, que es lo que
el propio docstring decía que tenía que pasar. `fallback` se distingue de
`disabled` a propósito: apagado es una decisión, caído es un fallo.

---

## 8. Un despliegue que borraba la entrada de producción

`infra/aws/parametros/alta-disponibilidad.json` **no llevaba**
`FrenteHttpsDeEmergencia`. Al desplegar con ese fichero, CloudFormation aplica
el valor por defecto de la plantilla (`'No'`) y **elimina la distribución de
CloudFront**.

Esa distribución es hoy la única entrada HTTPS de la API, y su dominio va
escrito dentro de la web publicada y de las builds del móvil. Borrarla no se
arregla redesplegando: una distribución nueva nace con **otro dominio**.

Y `docs/AWS_DESPLIEGUE.md` invita a hacer ese cambio diciendo que es «un
parámetro y unos 5 minutos».

El mismo fichero dejaba `CorreoDeAlertas` vacío: sin suscripción, nadie recibe
las alarmas.

Corregido. Los dos ficheros tienen ahora el mismo juego de claves.

---

## 9. Estado de las pruebas

| | Antes | Después |
|---|---|---|
| `pytest` | 1049 ✅ | **1057** ✅ |
| Pruebas de móvil | 259 ✅ | **264** ✅ |
| TypeScript (`tsc --noEmit`) | limpio ✅ | limpio ✅ |
| Export web | correcto ✅ | correcto ✅ |

Las 13 pruebas nuevas cubren: el coste de guardar señales, la idempotencia al
agruparlas, la degradación de los tres endpoints de recomendación, la ausencia
de `Content-Type` en los GET sin cuerpo, y la deduplicación de firmas.

---

## 10. Pendientes reales

Solo lo que necesita algo que no está en el repositorio.

1. **Rellenar los derivados de los 16 medios publicados**, con
   `scripts/procesar_media.py`. Necesita la `service_role` key. Es lo que hace
   que las fotos y vídeos del muro dejen de servirse enteros. **Es el pendiente
   con más impacto que queda.** Conviene hacerlo primero en seco.
2. **Comprobar `EXPO_PUBLIC_API_URL` en el panel de Vercel.** Es lo único que
   hace que la web hable con AWS y no está escrito en ningún fichero.
3. **Reconstruir las builds de EAS** para que el cambio de `eas.json` llegue a
   los teléfonos. Hasta entonces, las que estén instaladas siguen usando
   Render, así que **Render no se puede apagar todavía**.
4. **Medir en un Android real**: arranque, Inicio, Perfil, Mensajes, Reels,
   scroll, FPS y memoria. No se puede hacer desde aquí y no se van a inventar
   los números.
5. **Aplicar (o no) la migración `0037`**, que está preparada y sin aplicar.
   Solo crea índices.
6. **Decidir sobre el coste de las transformaciones de imagen** de Supabase.
7. **`aws login`**, si se quiere comprobar el estado real de la infraestructura
   (qué commit está desplegado, si la alarma por correo está confirmada, si el
   balanceador es alcanzable por HTTP desde fuera). La sesión de la CLI estaba
   caducada.
