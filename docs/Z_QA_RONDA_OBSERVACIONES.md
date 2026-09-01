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

## 4. Reacciones a comentarios — la 0048 NO está aplicada

**Hoy, sin la migración:** el contador sale 0, el corazón se pinta pero al
pulsarlo el servidor responde 404 y el corazón **vuelve solo** a su sitio con un
aviso de error. ✔ La lista de comentarios se sigue leyendo sin fallar.

Lo de abajo **solo se puede probar DESPUÉS de aplicar la 0048** (y de reiniciar
la API, porque el sondeo del esquema se cachea por proceso):

- Pulsar el corazón → se enciende y el número sube **al momento**.
- Pulsar otra vez → se apaga y baja.
- Salir y volver → el estado persiste.
- **Con el avión puesto:** vuelve solo a su sitio **y sale un error**.
- Reaccionar a **tu propio** comentario no te avisa a ti.
- Quitar y volver a poner **no** deja dos avisos.
- Reaccionar a **dos comentarios del mismo hilo** → dos avisos, uno por autor.
- **Con 20 comentarios en pantalla:** abrir la lista tiene que ser **una**
  petición, no veintiuna.

## 5. Lo que NO debe haberse roto

- Comentar desde `/comments/{id}` sigue igual: cursor, estados, vuelta atrás.
- El contador de comentarios del muro sube al comentar, en Inicio y en Perfil.
- La hoja de **reacciones** sigue funcionando como en la ronda anterior.
- Los avisos existentes (`like`, `comment`, `post_mention`, agenda) se siguen
  leyendo y llevando a donde llevaban.
