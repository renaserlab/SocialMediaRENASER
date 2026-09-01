# QA manual — ronda «OBSERVACIONES Z»

Lo que las pruebas automáticas **no ven**. Las de esta ronda miran el código
fuente o ejecutan lógica pura: **no montan la interfaz**.

Lo comprobado en el navegador (web, sesión anónima, API local) queda marcado
como ✔; el resto está sin ejecutar, y lo digo porque no tengo un teléfono
delante.

---

## 1. La hoja de comentarios

- ✔ Pulsar «Comentar» → sube una **hoja**; la publicación se queda detrás.
- ✔ Tocar fuera la cierra y se vuelve al **mismo punto del feed**.
- Cerrar también **arrastrando** y con **atrás de Android**. Los dos.
- La barra inferior sigue visible mientras la hoja está arriba.
- **Con el teclado abierto el campo no queda tapado.** Es lo que más se rompe:
  probar en un teléfono real, no en el navegador.
- **Con más de 50 comentarios:** el scroll debe reciclar. Si va a tirones, la
  lista virtualizada perdió su altura dentro de la hoja.
- **Con las herramientas de red abiertas:** abrir el feed y NO tocar nada tiene
  que dar **cero** peticiones de comentarios. Si hay una por publicación
  visible, la guarda de `visible && postId` dejó de funcionar.
- ✔ **La ruta directa sigue viva:** `/comments/{id}` a mano, con cabecera y
  flecha de volver. Es a donde llevan los avisos.

## 2. Navegar desde un comentario

- ✔ Tocar el **nombre** abre el perfil real de esa persona (por ID).
- Tocar el **avatar** hace lo mismo.
- ✔ Desde la HOJA: al llegar al perfil **no queda ninguna hoja encima**.
  (El panel de «Crear cuenta» que sale sin sesión es otra cosa, y ya existía.)

## 3. Respuestas

- ✔ «Responder» → sale «Respondiendo a *Nombre*» y el campo cambia a «Escribe
  una respuesta…».
- ✔ «Cancelar» quita el destino y el campo vuelve a lo de siempre.
- Enviar una respuesta → aparece **debajo** del comentario, sangrada.
- **Responder a una respuesta** → cuelga del **mismo comentario raíz**, no más
  adentro. El sangrado no crece nunca.
- **Con el avión puesto:** la respuesta se retira y sale error, **y el destino
  se conserva** para reintentar sin volver a elegirlo.
- El autor del comentario recibe **un** aviso; si además es el autor de la
  publicación, sigue siendo **uno solo**.
- Responderse a uno mismo **no** avisa a uno mismo.

## 4. Reacciones a comentarios — la 0048 **ya está aplicada**

Aplicada el 1 de septiembre de 2026, y la API reiniciada después (hace falta:
el sondeo del esquema se cachea por proceso). Comprobado en la base: tabla
creada, RLS activada, tres políticas, dos índices; `post_likes` y `comments`
sin tocar.

- Pulsar el corazón → se enciende y el número sube **al momento**.
- Pulsar otra vez → se apaga y baja.
- Salir de la app y volver → el estado persiste. Es lo único que distingue esto
  de un efecto visual.
- **Con el avión puesto:** vuelve solo a su sitio **y sale un error**.
- Reaccionar a **tu propio** comentario no te avisa a ti.
- Quitar y volver a poner **no** deja dos avisos en la bandeja.
- Reaccionar a **dos comentarios del mismo hilo** → dos avisos, uno por autor.
  (Era lo que fallaba si la clave de deduplicación fuera la publicación.)
- El aviso «A *X* le gustó tu comentario» abre **la publicación**, no el perfil.
- **Con 20 comentarios en pantalla:** abrir la lista tiene que ser **una**
  petición, no veintiuna. Mirarlo en las herramientas de red.
- Desde **otra cuenta**: el contador sube para los dos, pero el corazón solo
  sale encendido en la que reaccionó.

## 5. Lo que NO debe haberse roto

- Comentar desde `/comments/{id}` sigue igual: cursor, estados, vuelta atrás.
- El contador de comentarios del muro sube al comentar, en Inicio y en Perfil.
- La hoja de **reacciones** sigue funcionando como en la ronda anterior.
- Los avisos existentes (`like`, `comment`, `post_mention`, agenda) se siguen
  leyendo y llevando a donde llevaban.
