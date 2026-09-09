# QA en aparato físico — lo que sigue sin validar

**Nada de esta lista está comprobado.** No se da por bueno ningún punto: hacen
falta teléfonos reales y una persona mirando. Las pruebas automáticas no tocan
ninguna de estas cosas, y varias de ellas —el micrófono, el Atrás de Android, el
lector de pantalla— solo fallan en el aparato.

Última revisión de esta lista: 8 de septiembre de 2026.

Cómo usarla: marcar `[x]` solo lo que se haya visto funcionar con los ojos, en un
teléfono, anotando modelo y versión del sistema. Si algo falla, anotar qué se
esperaba y qué pasó; no dejarlo en «no va».

---

## 1. Navegación de Android

- [ ] **Botón Atrás físico** en cada pantalla del recorrido de compra: ficha del
      curso → aviso de recompra → checkout → confirmación. Que ninguna deje
      atrapado, y que Atrás desde la confirmación no vuelva a lanzar el pago.
- [ ] **Predictive Back** (Android 14+): la animación de arrastre muestra la
      pantalla anterior correcta, y soltar a medias no navega.
- [ ] Atrás en el detalle de un expediente de la bandeja de administración
      vuelve a la lista, no a la raíz.
- [ ] Atrás con un diálogo de confirmación abierto cierra el diálogo, no la
      pantalla.

## 2. Permisos y micrófono

- [ ] Micrófono **concedido**: grabar una nota de voz y enviarla.
- [ ] Micrófono **denegado** en el momento: el aviso dice dónde activarlo, y no
      se queda un botón muerto.
- [ ] Micrófono **bloqueado para siempre** («no volver a preguntar»): el aviso
      lleva a los ajustes del sistema.
- [ ] Volver de los ajustes con el permiso ya concedido: la pantalla se entera
      sin reiniciar la aplicación.

## 3. Multimedia

- [ ] Grabar audio, escucharlo antes de enviar, cancelar sin enviar.
- [ ] Enviar la nota de voz y que se reproduzca en el otro lado.
- [ ] Cámara: hacer una foto y adjuntarla.
- [ ] Adjuntos desde la galería y desde el explorador de archivos, incluido un
      archivo con ruta `content://` (Android), que es el caso que se copiaba mal.
- [ ] Recorte de imagen: aceptar, cancelar, y girar el teléfono a media edición.
- [ ] Un archivo demasiado grande da un mensaje que dice el límite, no un fallo
      genérico.

## 4. Accesibilidad

- [ ] **Tipografía ampliada** al máximo del sistema: la ficha del curso, la
      tarjeta de garantía, el formulario de devolución y la casilla de recompra
      siguen leyéndose y ningún botón queda fuera de pantalla ni se solapa.
- [ ] **Lector de pantalla real** (TalkBack y VoiceOver), no el simulador:
  - [ ] El orden de foco en la ficha del curso es el de lectura.
  - [ ] La casilla de recompra se anuncia como casilla, con su estado.
  - [ ] Los botones deshabilitados se anuncian como deshabilitados.
  - [ ] El estado de carga y el de error se **anuncian solos** al aparecer.
        (Hay un hallazgo abierto sobre esto: `StateView` no declara región viva.)
  - [ ] El texto legal de la recompra se lee entero antes que la casilla.
- [ ] **Modo claro y modo oscuro** en las pantallas de compra, garantía,
      devolución y administración: contraste suficiente y nada ilegible.
- [ ] Cambiar de modo con la aplicación abierta no rompe ninguna pantalla.

## 5. Directo (100ms)

- [ ] Sala con **dos teléfonos distintos**, no dos ventanas del mismo.
- [ ] La **superficie de vídeo** se ve en los dos, y sigue viéndose al girar el
      teléfono y al bloquear y desbloquear la pantalla.
- [ ] Salir y volver a entrar no deja la cámara tomada.
- [ ] Una llamada entrante durante el directo: al volver, el vídeo se recupera.

> No tocar la integración de 100ms salvo que una regresión venga demostrada de
> esta lista.

## 6. Recorrido de dinero, en aparato

Solo cuando las compras se enciendan. **Hoy están apagadas y este bloque no se
puede ejecutar.** Antes de intentarlo hay que resolver los dos pendientes de
negocio: la ruta de vuelta de Stripe y la aceptación de recompra en las tiendas
(ver [`Z_VERIFICACION_0051_0052.md` §10](Z_VERIFICACION_0051_0052.md)).

- [ ] Comprar en la tienda y volver a la aplicación: el acceso aparece sin
      cerrar y abrir.
- [ ] **Doble toque real** en Comprar, con el dedo, no simulado: una sola compra.
- [ ] Restaurar compras **sin** compras en esa cuenta de la tienda: el mensaje
      dice que no hay ninguna, no «restauradas».
- [ ] Restaurar compras tras reinstalar: el acceso vuelve.
- [ ] Pagar por web desde el teléfono y volver: no se cae en una ruta que no
      existe.
- [ ] Quedarse sin red a media compra y recuperarla.

## 7. Eventos · admisión (Incremento 1)

Ninguna de estas casillas la puede marcar una prueba automática: hacen falta un
Android real, dos cuentas distintas y, para la última, dos teléfonos.

### Organizador

- [ ] Crear un evento desde «Mis eventos» y ver que **no aparece** en el
      catálogo ni en Explorar.
- [ ] Guardar el borrador **a medias**, salir de la pantalla y volver: lo escrito
      sigue ahí y no se ha borrado ningún campo por no haberlo tocado.
- [ ] Con el **teclado en pantalla**, la descripción larga sigue visible y el
      botón de guardar es alcanzable.
- [ ] Intentar enviar sin promesa, sin categoría y sin fecha: dice qué falta,
      una cosa cada vez, y no envía nada.
- [ ] **Doble toque real** en «Enviar a revisión», con el dedo: un solo envío.
- [ ] Tras enviar, la pantalla queda en solo lectura y dice que enviado no es
      publicado.
- [ ] Recibir una petición de correcciones, leerla, corregir y reenviar. La
      versión sube a 2.
- [ ] Navegación **Atrás** desde el borrador, desde «Mis eventos» y desde la
      ficha de revisión, con el gesto y con el botón del sistema.

### Curaduría y administración

- [ ] Entrar en la cola con una cuenta **sin permiso**: dice que la cola no es
      para esa cuenta, no «no hay nada».
- [ ] Puntuar los ocho criterios con los botones: ninguno pasa de su tope y
      ninguno baja de cero.
- [ ] Marcar **falla crítica** con 98 puntos: la decisión posible baja a
      «rechazado» y aprobar responde que no.
- [ ] Aprobar con 84: responde que no llega.
- [ ] Aprobar de verdad y comprobar que **aprobado no es publicado**: sigue sin
      verse en el catálogo hasta pulsar Publicar.
- [ ] Publicar y comprobar que el **sello «Seleccionado por Z»** aparece en la
      ficha pública, y que un evento de siempre **no** lo tiene.
- [ ] Suspender: deja de verse y deja de admitir reservas. Reanudar lo devuelve.
- [ ] Con una cuenta de administración que **organiza** su propio evento:
      aprobar y publicar responden que no.

### Aforo

- [ ] **Dos teléfonos a la vez** sobre un evento con una sola plaza: uno entra y
      el otro recibe «alcanzó su capacidad máxima». Nunca los dos.
- [ ] Cancelar en el primero y reservar en el segundo: entra.
- [ ] Un evento **sin aforo** admite a los dos.

### Idiomas y modo oscuro

- [ ] Las cuatro pantallas nuevas en **es / en / pt**, sin frases en español
      dentro del inglés.
- [ ] Las cuatro en modo claro y oscuro, con el sello y la falla crítica
      legibles en los dos.

## 8. Eventos · entradas e inventario (Incremento 2)

**Nada de esto se puede marcar sin la 0061 aplicada y `FEATURE_EVENT_TICKETING`
encendida.** Mientras estén como se entregan, la comprobación que toca es la
última de esta lista.

### Organizador

- [ ] Configurar un evento como **con entradas** y ver que la ficha cambia de
      «Reservar» a «Elegir entradas».
- [ ] Intentar convertir a entradas un evento **con reservas gratuitas**: se
      niega y dice por qué.
- [ ] Crear un tipo, ponerlo a la venta, pausarlo y retirarlo.
- [ ] Comprobar que **la suma de los cupos frente al aforo** se ve, y que se
      pone en rojo cuando se pasa.
- [ ] Crear un tipo con cupo mayor que el aforo aprobado: se niega.
- [ ] Con el **teclado en pantalla**, los campos de precio y cupo siguen
      visibles y el botón de crear es alcanzable.

### Quien compra

- [ ] Elegir entradas de dos tipos y ver el subtotal por tipo y el general.
- [ ] Que en ningún sitio ponga «total», ni aparezca una comisión.
- [ ] **Doble toque real** en «Apartar», con el dedo: una sola reserva.
- [ ] Ver la cuenta atrás bajar y **dejarla llegar a cero**: la pantalla
      pregunta al servidor y dice que venció, sin liberar nada por su cuenta.
- [ ] Liberar una reserva y comprobar que las entradas vuelven a estar
      disponibles **al momento**.
- [ ] Liberar dos veces: no es un error.
- [ ] Poner el reloj del teléfono **adelantado media hora** y abrir una reserva
      recién creada: sigue viva, porque quien decide es el servidor.
- [ ] Quedarse **sin red** a media selección y recuperarla.

### Inventario, con dos teléfonos

- [ ] **Dos teléfonos a la vez** sobre un tipo con una sola entrada: uno la
      aparta y el otro recibe «no quedan entradas suficientes».
- [ ] Dos tipos que suman más que el aforo: no se puede apartar más de lo que
      cabe en la sala.

### Idiomas, modo oscuro y accesibilidad

- [ ] Las tres pantallas nuevas en **es / en / pt**.
- [ ] En modo claro y oscuro, con el importe y la cuenta atrás legibles.
- [ ] Los botones de más y menos con lector de pantalla, y con área táctil
      suficiente.

### Con todo apagado, que es como se entrega

- [ ] Con la 0061 **sin aplicar**: el catálogo, la ficha y la reserva gratuita
      funcionan igual, y las pantallas de entradas dicen que la función todavía
      no está disponible.
- [ ] Con la 0061 aplicada y la **bandera apagada**: lo mismo.
