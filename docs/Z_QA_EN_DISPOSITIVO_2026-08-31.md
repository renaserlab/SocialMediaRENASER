# Comprobación en dispositivo — ronda del 31 de agosto de 2026

Lo que las pruebas automáticas **no pueden ver**, y por qué cada punto está aquí.

Las pruebas de este repositorio son `pytest` sobre SQLite y `node --test` sobre
los ficheros fuente. Eso deja fuera tres cosas enteras: **el renderizado**
(React Native no se monta en las pruebas), **los permisos y el hardware del
teléfono** (micrófono, teclado, cámara) y **PostgreSQL de verdad** (las
políticas RLS están escritas y revisadas, pero se ejecutan en Postgres, no en
SQLite).

Cada punto dice **qué mirar** y **qué significa si falla**. Sin lo segundo, una
lista de comprobación es una lista de deseos.

> **Antes de empezar.** La API tiene que haberse reiniciado después de aplicar la
> 0044 y la 0046. `messaging/esquema.py` pregunta por el esquema **una vez por
> proceso**: con el «no» de antes en memoria, las notas de voz y las respuestas a
> historias no se ofrecen y la búsqueda no mira dentro de los mensajes. No estaría
> roto — estaría desactivado, que se parece mucho y se diagnostica fatal.

---

## 1. Perfil

| Qué mirar | Si falla |
|---|---|
| **Perfil propio**: foto, nombre, @usuario, cifras, **descripción centrada**, **audio**, «Lo que puede aportar», accesos, contenido. En ese orden. | El orden nuevo no se aplicó. El anterior ponía el audio antes de la descripción. |
| Una **bio larga** (más de tres líneas). Debe pasar a alineación izquierda, no seguir centrada. | Se mide con `onTextLayout`, no contando caracteres. En web puede no dispararse: entonces se queda centrada, que es el caso bueno. |
| **«Lo que puede aportar» llega plegado.** Se abre y se cierra al pulsar. | Debe llegar cerrado: el motivo del cambio era que ocupaba media pantalla. |
| El acceso a **Reseñas** lleva **comillas**, no una estrella. | Primera vez que la aplicación usa `MaterialCommunityIcons`. Mira el primer arranque en frío por si la fuente parpadea. |
| **Perfil ajeno de alguien SIN cursos**: dice «*Nombre* aún no tiene cursos publicados» y **no hay botón «Ver cursos de Z»**. | Antes decía «Aún no *tienes* cursos»: le hablaba de sí mismo a quien mira el perfil de otro. |
| **Perfil ajeno de alguien CON cursos publicados**: se ven. | Éste es el importante. La condición no miraba si había contenido, así que los cursos de otra persona **no se veían nunca**. |
| Lo mismo en la sección de **Eventos** de un perfil ajeno. | Tenía el defecto gemelo, en el mismo bloque. |

## 2. Cursos

| Qué mirar | Si falla |
|---|---|
| Un curso con **«Próximamente»**, mirado por un alumno: **no** hay contadores de módulos/lecciones, **no** sale el globo «toca aquí» y **no** hay botón «Empezar curso». | Era la incoherencia de la captura: anunciaba contenido y decía no tenerlo. |
| El **autor** del mismo curso lo sigue viendo todo. | Es como comprueba lo que va subiendo. Sin esto no podría montarlo. |
| Abrir por **enlace directo** una lección de ese curso (`/lesson/<id>`): se ve el título, **no** se reproduce el vídeo. | Era la puerta de atrás: la pantalla dejó de enlazar ahí, pero el enlace directo seguía entregando el vídeo — y en un curso **gratuito**, a cualquiera. |
| El **interruptor** de «Próximamente» en el editor dice lo que hace. | Antes estaba rotulado **«Ocultar»**, con un texto del módulo de directos. Un toque sin confirmación dejaba el temario invisible para todos los alumnos. |
| Un curso **normal** (sin «Próximamente») se ve entero. | Que la comprobación no se lleve por delante lo que sí funciona. |

## 3. Eventos

| Qué mirar | Si falla |
|---|---|
| En **Agenda**: tres secciones —Próximos, Fecha por confirmar, Anteriores—, cada una con su título. | Antes salían mezclados y los vencidos **los primeros**, porque se ordenaba por fecha ascendente sin filtrar. |
| Un evento **finalizado** lleva su etiqueta y **no** ofrece reservar. | |
| En **Explorar**, la tarjeta de eventos enseña solo **vigentes**. | En la captura salían dos, uno ya celebrado, bajo el título «Próximos eventos». |
| Un evento **sin fecha** aparece en su propia sección, no colado entre los próximos. | Meterlo con los futuros sería inventarle una fecha. |
| Buscar un evento pasado: **aparece**, marcado «Finalizado». | Las dos mitades importan: que se encuentre (no se esconde lo histórico) y que se note. |

## 4. Explorar

| Qué mirar | Si falla |
|---|---|
| La **barra de búsqueda**: cápsula, lupa dentro, botón de borrar. En claro y en oscuro. | En Android, comprueba el centrado vertical del texto: `padding: 0` corrige el relleno que Android añade por su cuenta. |
| **Al abrir Explorar, las tarjetas de programa/eventos/círculo se rellenan sin un segundo de texto de relleno.** | Se quitó una espera de 600 ms cuyo motivo —un servidor recién despierto— desapareció al pasar a AWS. |
| Escribir en la barra: la pantalla de abajo **no** parpadea. | Antes se reconstruían la fila de historias, los carruseles y las tres tarjetas **en cada tecla**. |
| Buscar sigue encontrando personas, publicaciones, hashtags, cursos, eventos y temas. | No se tocó la lógica de `8fffb2e`, pero conviene confirmarlo. |

## 5. Mensajes — la bandeja

| Qué mirar | Si falla |
|---|---|
| La pantalla completa: encabezado, historias, buscador, chips de etiquetas, filtros, lista. En Android, iOS **y web**. | |
| **Las historias de arriba son de quien sigues**, y **no** aparece quien tengas bloqueado. | La consulta traía las de todo el mundo. La API lee con identidad de servicio y se salta la RLS: la política de la tabla no protegía nada. |
| Abrir Mensajes **no se siente más lento** que antes de la ronda. | Son cuatro peticiones al montar y salen **en paralelo**. Si alguna se encadenó, se nota. |
| **Buscar a alguien que esté muy abajo en la bandeja** (más allá de la primera página). | Era el fallo original: filtraba las veinte filas ya descargadas. |
| **Buscar una palabra que solo aparece dentro de un mensaje** (tres letras o más). | Es lo que enciende la 0046. Si no encuentra, la API no se ha reiniciado. |
| Buscar **no** desactiva el desplazamiento infinito. | Antes sí lo hacía. |
| Escribir en el buscador **no** repinta la lista entera. | Se sacó a su propio componente por eso. |
| Desplazar rápido: **ningún avatar equivocado** un instante. | Es `recyclingKey` en `expo-image` haciendo su trabajo. |
| Los **tres** filtros, y solo tres: No leídos, No respondidos, Respuestas a historias. | Los de Instagram que salían en la captura —verificados, 10 000 seguidores— no se añadieron a propósito. |
| Cada filtro **con la lista larga**: que siga paginando y no filtre solo lo cargado. | |

## 6. Mensajes — el CRM de etiquetas

| Qué mirar | Si falla |
|---|---|
| **Crear** una etiqueta, **renombrarla**, **borrarla**. | |
| **Asignarla** a una conversación con pulsación larga, y **quitarla**. | En **web** no hay pulsación larga nativa: comprueba que haya forma de llegar. |
| **Filtrar** por esa etiqueta. | |
| **Borrar la etiqueta por la que estabas filtrando**: la bandeja vuelve a «Todos», no se queda vacía. | Sin eso se quedaría vacía para siempre sin forma de deshacerlo. |
| **Desde la otra cuenta**: esa conversación **no** muestra ninguna etiqueta, ni rastro. | Es el requisito central. Hay prueba automática, pero conviene verlo con dos teléfonos. |
| La fila de chips **con nombres largos** en una pantalla estrecha. | |
| Arrastrar la fila de chips **no cambia de pestaña**. | Todo desplazamiento horizontal dentro de las pestañas necesita `SinCambioDeSeccion`. |

## 7. Chat

| Qué mirar | Si falla |
|---|---|
| **El teclado no tapa el campo de escribir**, en Android *edge-to-edge* y en iOS. | Hay un arreglo anterior (`b10dacd`); esto es regresión sobre el diseño nuevo. |
| **Pulsación larga** sobre un mensaje: se abre el **menú de acciones**. | Antes confirmaba el borrado directamente. |
| **Borrar un mensaje propio desde ese menú**, en **iOS**. | Un diálogo sobre un Modal falla **en silencio** en iOS si no se espera a que la hoja cierre. |
| Pulsación larga sobre una burbuja que **solo tiene una foto**. | La hora se oculta dentro de una ráfaga, salvo aquí: es la única zona que queda para pulsar. |
| Subir una imagen y un documento, con su progreso. Reintentar un envío fallido. | Es el motor de siempre; el rediseño no debía tocarlo. |

## 8. Notas de voz

| Qué mirar | Si falla |
|---|---|
| **Mantener pulsado** graba; **soltar** envía; **deslizar** cancela. Un toque simple **no** graba. | |
| El indicador de que está grabando se ve mientras dura. | |
| **Denegar el permiso de micrófono**: se explica cómo continuar, no falla en silencio. | |
| **Después de mandar una nota de voz, el resto de audios de la app suenan igual de alto.** En **iOS**. | Es lo que más fácil se rompe. Activar la grabación cambia la categoría de la sesión y el sistema baja el volumen; hay que apagarla al soltar. |
| Reproducir la nota **de otra persona** (URL firmada real). | En las pruebas el almacenamiento está sustituido. |
| Reproducir una, y **empezar otra**: la primera se para. | Un reproductor por burbuja agotó la memoria de Android una vez ya. |
| Parada automática a los **5 minutos** de grabación. | |

## 9. Responder una historia

| Qué mirar | Si falla |
|---|---|
| Ver la historia de alguien, responder desde el visor, y que **le llegue** el mensaje. | |
| En el chat se **entiende** que fue respuesta a una historia, con su miniatura. | La firma de la miniatura contra el bucket real no se prueba automáticamente. |
| **Esperar a que la historia caduque** (o borrarla) y volver al chat: el mensaje **sigue ahí**, con «Historia no disponible». | El mensaje dura para siempre y la historia un día. Si el chat se rompe aquí, el `on delete set null` no está haciendo su trabajo. |
| El filtro **«Respuestas a historias»** de la bandeja encuentra esa conversación. | |
| El teclado en el **redactor del visor** (es distinto del chat). | |

## 10. Lo que solo se puede comprobar contra PostgreSQL

Las políticas RLS de la 0044 y la 0045 están escritas y revisadas, pero las
pruebas corren sobre SQLite, que **no tiene RLS**. Conviene ejecutar a mano las
comprobaciones comentadas al final de cada migración:

- **0044** — que el `CHECK` de `message_attachments.kind` admita `audio` y no
  quede ninguna otra restricción que lo rechace. *(El propio script aborta si no,
  así que haberlo aplicado sin error ya lo demuestra.)*
- **0045** — las siete políticas de las etiquetas, una a una.
- **0046** — que el índice sea GIN y esté `valid`, y que el planificador lo use.
  Con la tabla casi vacía puede preferir el recorrido secuencial, y eso es
  **correcto**: se fuerza con `set enable_seqscan = off` para verlo.

## 11. Lo que sigue sin poder medirse desde aquí

De `docs/Z_MEDICION_MENSAJES_EXPLORE.md`, y sigue igual:

1. **Si el recomendador devuelve algo en producción.** `/recommendations/people`
   y `/recommendations/courses` son **26 de las 41 consultas** de Explorar, y sus
   secciones desaparecen si vienen vacías. Exigen sesión y devuelven 401 sin
   token. Hasta saberlo, **no se toca**: si suelen traer contenido, el esqueleto
   está haciendo su trabajo, y quitarlo cambiaría un salto de maquetación por
   otro en sentido contrario.
2. **Renders y FPS en un Android real.** Hace falta React DevTools Profiler.
3. **Latencia desde un teléfono en red móvil.** Los 0,42 s medidos son desde red
   fija: son un suelo, no el número de quien usa la aplicación.
