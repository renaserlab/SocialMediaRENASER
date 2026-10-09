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

---

## Incremento 3 · pedido, QR y control de acceso

Nada de esto se ha probado en un teléfono. Lo que sigue **solo** se puede
comprobar con dispositivos reales y, para el check-in, con dos a la vez.

### El pedido

- [ ] De la reserva al pedido: el resumen enseña lo mismo que se apartó, con los
      precios congelados.
- [ ] La cuenta atrás del pedido corre y, al llegar a cero, el pedido deja de
      ofrecer pagar.
- [ ] **Doble toque** en «Ir a pagar»: no se abren dos cobros.
- [ ] Cancelar el pedido y volver: no se puede pagar uno cancelado.
- [ ] El texto dice que **no es una factura ni una boleta**.

### El QR, que es lo que solo se ve en un teléfono

- [ ] El QR se dibuja y **lo lee un lector de verdad**. Esto es lo único que no
      se puede dar por bueno desde una prueba automática.
- [ ] En **modo oscuro**: el QR sigue sobre fondo blanco y se lee.
- [ ] Con **brillo bajo** y con la pantalla sucia.
- [ ] El código escrito debajo se puede **dictar por teléfono** y teclear sin
      equivocarse.
- [ ] Abrir la entrada otra vez: el QR **cambia**, y el anterior —fotografiado
      antes— ya no vale.
- [ ] Una entrada usada o anulada **no enseña QR**.

### El check-in, con dos teléfonos

- [ ] Escanear una entrada válida: verde, y ocupa la pantalla.
- [ ] Escanearla otra vez: «ya utilizada», con la hora a la que entró.
- [ ] **Dos teléfonos escaneando el mismo QR a la vez**: uno pasa y el otro dice
      «ya utilizada». Ninguno de los dos se queda cargando.
- [ ] Dejar el QR delante de la cámara diez segundos: **no se manda una petición
      por fotograma**.
- [ ] Escribir el código a mano cuando la cámara falla.
- [ ] Un QR de otro evento: «no es de este evento», sin decir de cuál.
- [ ] **Poner el teléfono en modo avión** y escanear: dice que no se pudo
      comprobar y **no** deja pasar.
- [ ] Sin permiso de cámara: se explica y se ofrece escribir el código.

### El organizador

- [ ] Las ventas dicen «ingreso bruto» y explican que no es lo que va a cobrar.
- [ ] Sin ventas todavía: no se escribe ningún importe.
- [ ] La lista de asistentes **no enseña quién compró** ni ningún código.
- [ ] Buscar por el código que enseña una persona lo encuentra.

### Idiomas, modo oscuro y accesibilidad

- [ ] Las seis pantallas nuevas en **es / en / pt**.
- [ ] Con **fuente grande** del sistema: nada se corta ni se solapa.
- [ ] Con lector de pantalla: el resultado del check-in se anuncia solo, y el
      código de la entrada se lee carácter a carácter.

### Con todo apagado, que es como se entrega

- [ ] Con la 0062 **sin aplicar**: pedidos y entradas dicen que la función
      todavía no está, y el catálogo, la ficha, la reserva gratuita y las
      reservas temporales funcionan igual.
- [ ] Con la 0062 aplicada y **`FEATURE_EVENT_TICKETING` apagada**: lo mismo.
- [ ] Con las entradas encendidas y **`FEATURE_EVENT_PAYMENTS` apagada**: se
      puede pedir y no se puede pagar, y una cortesía de precio cero **sí** se
      confirma y emite su entrada.


## Incremento 4 — la puerta, en un teléfono de verdad

**Nada de esto se ha ejecutado.** No hay dispositivos en este entorno, y una
prueba automática no puede responder a ninguna de las dos preguntas que de
verdad importan aquí: si un lector lee el QR, y qué pasa cuando dos teléfonos
escanean el mismo código a la vez.

### Android real

- [ ] Permiso **concedido**: al abrir el control de acceso aparece el visor sin
      pasar por ningún aviso de «sin cámara», ni siquiera un parpadeo.
- [ ] Permiso **rechazado**: el aviso explica y el botón abre el diálogo del
      sistema.
- [ ] Permiso **bloqueado** (rechazado dos veces): el texto dice que el
      teléfono ya no va a preguntar, y el botón abre **los ajustes de la
      aplicación**. Al volver de los ajustes con el permiso dado, el visor
      aparece sin reiniciar la aplicación.
- [ ] Con el permiso bloqueado se puede escribir el código a mano y admitir.

### El QR, de un teléfono a otro

- [ ] Entrada abierta en un teléfono, escaneada desde otro: **admite a la
      primera**.
- [ ] Brillo del teléfono que enseña al **mínimo**: ¿lee? Anotar a qué
      distancia.
- [ ] Brillo al **máximo** y pantalla en modo oscuro: el recuadro del QR sigue
      siendo blanco con margen.
- [ ] Con protector de pantalla mate o grasa, y con el teléfono ligeramente
      inclinado.
- [ ] **Captura de pantalla** del QR, enseñada desde la galería: admite igual
      que la pantalla viva. (Es lo esperado: la defensa contra compartir no es
      que no se pueda fotografiar, es la rotación.)
- [ ] Tras **volver a abrir la entrada**, la captura anterior **ya no admite**.
      Esta es la prueba de que la rotación sirve para algo.
- [ ] El **código tecleado** de la captura anterior tampoco admite.

### Dos teléfonos a la vez

- [ ] Dos operadores escanean el **mismo** QR en el mismo segundo: uno ve verde
      y el otro «ya utilizada» con la hora. Nunca dos verdes.
- [ ] Repetirlo cinco veces con entradas distintas.
- [ ] Comprobar en la base: exactamente **un** `event_checkins` con
      `result = 'OK'` por entrada.

### Mientras la puerta trabaja

- [ ] Alguien compra una entrada del mismo evento mientras se escanea: los
      escaneos siguen respondiendo, y si alguno se cruza dice «vuelve a
      intentarlo», no se queda colgado ni da un error del servidor.
- [ ] Escanear el QR de **otro evento**: dice que no es de este evento y **no**
      revela cuál.
- [ ] Escanear una entrada **anulada**.
- [ ] Escanear algo que no es una entrada (un QR de una web cualquiera).

### Sin conexión, y volviendo

- [ ] En modo avión, escanear: sale «no dejes pasar todavía», **nunca** verde.
- [ ] Quitar el modo avión y **volver a acercar el mismo QR**: se manda y
      responde. (Antes se descartaba en silencio para siempre.)
- [ ] Cortar la red **justo después** de escanear, cuando la respuesta ya
      viajaba: al recuperar, la puerta dice el estado real de la entrada, no
      «sin conexión».
- [ ] En la pantalla de la entrada, sin conexión: hay un botón para reintentar.

### Ciclo de vida

- [ ] Con el visor abierto, irse al escritorio: el **piloto de la cámara se
      apaga**. Al volver, el visor sigue funcionando.
- [ ] Con el visor abierto, atender una llamada.
- [ ] Navegar a otra pantalla desde el control de acceso y volver.
- [ ] Cerrar la aplicación por completo y reabrirla en la entrada.
- [ ] Girar el teléfono con el visor abierto.

### Cómo se ve

- [ ] Modo claro y modo oscuro, en las seis pantallas.
- [ ] **Fuente del sistema al máximo**: el resultado del check-in sigue
      cabiendo y el código de la entrada no se parte.
- [ ] Con lector de pantalla (TalkBack): al escanear, el resultado **se
      anuncia solo**. Es el dato más importante de la pantalla.
- [ ] El visor de la cámara se anuncia y dice qué hay que encuadrar.
- [ ] Verde y rojo se distinguen también sin color: icono y texto.

### La lista y los números

- [ ] Buscar por código completo encuentra a la persona.
- [ ] Escribir menos de seis caracteres: la pantalla lo dice **antes** de
      mandar nada.
- [ ] «Traer más» con la red cortada: lo ya leído se queda y se avisa.
- [ ] El número de **presentes** sube al hacer check-in y **no** vuelve a subir
      al escanear la misma entrada otra vez.
- [ ] Apartadas, emitidas, válidas, usadas y presentes se leen como cinco cosas
      distintas y ninguna miente.


## Incremento 5 — Posventa

**NADA DE ESTO SE HA PROBADO EN UN DISPOSITIVO.** Y una parte ni siquiera se
puede probar todavía: las vistas móviles de posventa no existen. Lo que sigue
separa lo que se podrá comprobar en cuanto existan de lo que ya se puede
comprobar hoy contra la API.

### Se puede comprobar HOY, contra la API

- [ ] Con la 0064 y la 0065 aplicadas, un escaneo normal sigue dando `OK`.
- [ ] **Con la 0064 aplicada y la 0065 NO**, un escaneo sigue funcionando y no
      devuelve 500. Es el orden natural de despliegue y es donde estaba el
      agujero.
- [ ] Sin ninguna política publicada, pedir la elegibilidad de un pedido
      responde `policy_not_configured` —no «no»—.
- [ ] Sin política, aprobar un expediente responde 409
      `event_policy_not_configured`, no un 500.
- [ ] Publicar una política con `refund_bps: 9999999` se rechaza.
- [ ] Un moderador de contenido recibe 403 en todas las rutas de
      `/admin/events/`.
- [ ] Un comprador que pide el expediente de otra persona recibe **404**, no 403.
- [ ] La respuesta del expediente al comprador **no** trae `internal_notes`.

### Cuando existan las vistas

- [ ] Solicitar una cancelación desde la entrada y desde el historial.
- [ ] La pantalla dice **por qué** el botón está apagado cuando la política no
      está definida, en vez de esconderlo sin explicación.
- [ ] Doble pulsación en «enviar solicitud»: un solo expediente.
- [ ] Seguimiento: número de expediente, estado, línea de tiempo y fecha de
      última actualización.
- [ ] Un expediente `approved` **no** dice «devuelto» en ninguna parte.
- [ ] Retirar la solicitud desde el móvil y ver el estado cambiar.
- [ ] La línea de tiempo **no** muestra notas internas.
- [ ] es / en / pt en todas las pantallas nuevas, incluido el veredicto
      `ON_HOLD`.
- [ ] Lector de pantalla sobre la línea de tiempo.
- [ ] Modo claro y modo oscuro.
- [ ] Sin conexión: la pantalla lo dice y no inventa un estado.

### Con dos dispositivos

- [ ] Una entrada **retenida** por un expediente: el escáner dice «retenida» y
      **no** la consume. Comprobar después que sigue `VALID`.
- [ ] Retener la entrada desde administración **mientras** alguien la escanea:
      o entra antes, o no entra. Nunca las dos cosas.
- [ ] Dos administradores resolviendo el mismo expediente a la vez: uno lo
      mueve, el otro recibe «alguien lo movió, vuelve a mirarlo».
- [ ] Una entrada restaurada **no** admite con el QR de antes: hay que reabrir
      la entrada para obtener uno nuevo.

## Incrementos 5 y 6 — lo que exige dispositivo

**NADA DE ESTO SE HA PROBADO EN UN TELÉFONO.**

### Posventa del comprador

- [ ] Desde «Tu entrada», la tarjeta «¿Necesitas ayuda?» abre la solicitud.
- [ ] Sin política publicada: el botón se ve **desactivado con la explicación
      al lado**, no escondido.
- [ ] Doble pulsación en «enviar»: un solo expediente.
- [ ] La línea de tiempo **no** muestra notas internas.
- [ ] Un expediente `approved` **no** dice en ninguna parte que el dinero volvió.
- [ ] Ninguna pantalla enseña una fecha de devolución.
- [ ] Responder a una petición de información y ver el estado cambiar.
- [ ] es / en / pt en las tres pantallas nuevas.
- [ ] Modo claro y oscuro, fuente ampliada, lector de pantalla.
- [ ] Sin conexión: lo dice y no inventa un estado.

### Reseñas

- [ ] Solo aparece el formulario a quien tiene check-in en ese evento.
- [ ] El sello «asistencia verificada» se ve y no se puede tocar.
- [ ] Un evento sin reseñas **no** muestra `0.0` ni estrellas vacías.
- [ ] Los cinco ejes se pueden dejar en blanco.

### Finanzas del organizador

- [ ] Con `platform_fee_bps = -1`: la pantalla dice «pendiente de
      configuración» y **no** `S/ 0.00`, ni `-1`, ni un porcentaje.
- [ ] El motivo por el que un saldo no está disponible se lee y se entiende.
- [ ] No aparece la cuenta de cobro por ninguna parte.

### Con dos dispositivos

- [ ] Dos administradores resolviendo el mismo expediente: el segundo ve el
      conflicto, se recarga y puede reintentar.
- [ ] Una entrada retenida: el escáner dice «retenida» y **no** la consume.

## Lo que añadieron los Incrementos 5 y 6, ya con pantalla

Estas no se podían escribir antes porque las pantallas no existían.

### Reseñas, en el teléfono

- [ ] Desde la ficha del evento se llega a las reseñas en un toque.
- [ ] Sin `review_window` publicada, la pantalla dice **por qué** no se puede
      opinar todavía, y no ofrece un botón que vaya a fallar.
- [ ] Con la política publicada y sin check-in: dice que solo opina quien pasó
      el control de acceso.
- [ ] La puntuación general y los cinco ejes se pueden poner con el pulgar, sin
      zoom, y el objetivo táctil llega a 44 puntos.
- [ ] Editar la reseña propia la recupera tal como se escribió, comentario
      incluido.
- [ ] Una reseña escondida por moderación **la sigue viendo su autor**, y dice
      que está escondida.
- [ ] Quien organiza ve la caja de responder; quien no, no la ve.
- [ ] Sin `organizer_reply` publicada, responder falla diciendo exactamente eso
      —no «ha ocurrido un error»—.
- [ ] La respuesta del organizador se lee debajo de su reseña, no en otra parte.
- [ ] Con el teléfono en inglés y en portugués: ningún texto sale en español.

### Finanzas, en el teléfono

- [ ] Desde la pantalla de quien organiza se llega a «Ventas y saldo».
- [ ] Un evento **sin ninguna venta** enseña el estado vacío y **no** «0,00».
- [ ] Con `platform_fee_bps = -1`: bruto sí, comisión y neto dicen «pendiente de
      configuración». En ningún sitio aparece un cero ni un `-1`.
- [ ] El motivo de bloqueo se lee como frase; **el código crudo no aparece**.
- [ ] Sin las migraciones 0066–0068 aplicadas: la pantalla dice «todavía no está
      disponible», no un error.
- [ ] Desde «Mis eventos» se llega a las dos bandejas de plataforma, y quien no
      tiene permiso ve el mensaje de permiso —no una lista vacía—.
- [ ] En el panel financiero, **ningún botón promete pagar**. El de
      transferencias dice que hoy no mueve nada y enumera qué falta.
- [ ] Soltar una retención dice, antes de confirmar, que **no mueve dinero**.
- [ ] Conciliar devuelve hallazgos agrupados y **no corrige nada**: se ejecuta
      dos veces y el resultado es el mismo.

### Avisos, con el teléfono de verdad

- [ ] El aviso llega en el idioma del **dispositivo**, no del servidor.
- [ ] Con dos teléfonos de la misma persona: llega a los dos, **una vez cada
      uno**.
- [ ] Ningún aviso promete un plazo ni dice un importe.
- [ ] Con el proceso de la cola ejecutado dos veces seguidas: el teléfono
      **no** suena dos veces.
- [ ] Desinstalando la aplicación y vaciando la cola: la entrega acaba en
      `failed` con su motivo, y no se queda reintentando para siempre.

## Políticas del organizador, cancelación y moderación

### Políticas, en el teléfono

- [ ] Desde la pantalla del evento se llega a «Mis políticas» en un toque.
- [ ] Un evento sin políticas propias lo dice como «todavía no has definido tus
      condiciones», **nunca** como «no se devuelve nada».
- [ ] Ningún campo del formulario nace con un valor puesto: los sí/no empiezan
      sin decidir y los números en blanco.
- [ ] Un borrador se edita; una publicada **no ofrece editar** por ningún lado.
- [ ] Publicar pide confirmación y el texto dice que las compras anteriores
      conservan la versión que aceptaron.
- [ ] Crear una versión nueva copia los parámetros y deja el nombre **vacío**.
- [ ] La previsualización coincide, palabra por palabra, con lo que devuelve
      `/policies/terms`.
- [ ] Publicar algo contradictorio —revocar en parcial y no en total— se rechaza
      con su motivo concreto, no con un error genérico.
- [ ] El historial se lee y no se puede tocar.
- [ ] Con el teléfono en inglés y en portugués: ningún texto sale en español.

### Cancelar un evento

- [ ] Pide motivo escrito y una confirmación aparte.
- [ ] El aviso dice: deja de venderse, se abre un caso por compra, el importe
      queda **retenido y en revisión**, y **no se devuelve nada
      automáticamente**.
- [ ] Después de cancelar, la pantalla enseña cuántos casos se abrieron y
      cuántos importes se retuvieron, con los números del servidor.
- [ ] Con muchas compras: la pantalla dice cuántas quedan por atender y deja
      continuar. El evento ya figura cancelado desde la primera vez.
- [ ] Cancelar dos veces seguidas no abre dos casos ni avisa dos veces.
- [ ] El comprador recibe **un** aviso; quien organiza recibe **uno**, no uno
      por compra.
- [ ] Ningún aviso menciona un importe, un plazo ni una devolución.

### Moderar reseñas

- [ ] Desde la cola de revisión se llega a la moderación en un toque.
- [ ] Se ven las visibles **y las ocultas**, y se pueden filtrar.
- [ ] Ocultar sin motivo no deja continuar, y el rechazo ocurre antes de llamar
      al servidor.
- [ ] El texto dice que ocultar **no borra**.
- [ ] No hay ninguna acción de borrado en ninguna parte de la pantalla.
- [ ] La puntuación y el autor se ven y no se pueden editar.
- [ ] Restaurar vuelve a mostrarla y deja rastro en el historial.
- [ ] Doble toque en ocultar no ejecuta la acción dos veces.
- [ ] Sin permiso: mensaje de permiso, no una lista vacía.

### Supervisión de políticas

- [ ] Desde «Mis eventos» se llega al panel.
- [ ] La pestaña de «sin política» enseña los eventos publicados que venden sin
      condiciones escritas, y se puede abrir el evento.
- [ ] No hay ningún botón de aprobar, rechazar, suspender, editar o borrar.
- [ ] Una clave de parámetro desconocida se ve tal cual y no rompe la pantalla.
- [ ] Un porcentaje de `0` se lee como «0 %», no como «sin definir».
- [ ] Moderación de contenido **no** ve las políticas de dinero de la
      plataforma.

## Productos, Incrementos 1–3 (12/09/2026)

Nada de esto se puede comprobar sin un teléfono real y sin las migraciones 0070,
0071 y 0072 aplicadas. **Ninguna de estas casillas está marcada.**

### El recorrido del comprador

- [ ] Explorar enseña el chip de **Productos** con la bolsa, y lleva a `/productos`.
- [ ] La portada carga con las migraciones SIN aplicar y dice que no está disponible, en vez de fallar.
- [ ] El manifiesto se lee centrado y no parece un banner.
- [ ] Las tarjetas caben a dos columnas en un teléfono estrecho, sin que el nombre se corte a mitad de palabra.
- [ ] El precio se escribe con la moneda que manda el servidor, y un producto sin precio dice «sin precio configurado» en vez de «0».
- [ ] La bolsa NO enseña contador con cero guardados, y sí lo enseña con uno.
- [ ] El corazón de la tarjeta guarda y quita, y sobrevive a cerrar y abrir la aplicación.
- [ ] El buscador no busca con una sola letra, y lo dice.
- [ ] Al volver Atrás desde una ficha, la búsqueda conserva el texto y la posición del desplazamiento.
- [ ] La paginación por cursor no repite ni se salta productos al bajar tres páginas.
- [ ] Las categorías se enseñan vacías sin parecer un error.
- [ ] La ficha respeta el orden de la captura 6: galería, creador, nombre, precio, sello, «Por qué está en Z», variantes, descripción, materiales y origen.
- [ ] La galería enseña el contador «1/5» y se desliza sin quedarse a medias.
- [ ] El sello abre el informe de evaluación.
- [ ] Las tres razones llevan el icono que corresponde a su dimensión.
- [ ] NO aparece ninguna valoración, ni estrellas, ni «compras verificadas».
- [ ] NO aparece ningún plazo de entrega ni de devolución.
- [ ] NO aparece ningún botón de comprar, ni una barra fija con precio.
- [ ] El informe escribe la puntuación con coma (90,00) y no en centésimas (9000).
- [ ] Un producto suspendido deja de abrirse por enlace directo.

### El recorrido del proveedor

- [ ] Quien no es proveedor ve el acceso a postular, y quien ya lo es ve sus productos.
- [ ] El formulario de postulación nace VACÍO, sin ningún valor precargado.
- [ ] Una propuesta corta se señala antes de mandarla.
- [ ] Una postulación enviada deja de ser editable y la pantalla lo dice.
- [ ] Un rechazo enseña su motivo a quien postuló.
- [ ] Crear un producto con precio y sin moneda se rechaza en la pantalla, no en el servidor.
- [ ] Dos variantes con el mismo SKU se señalan antes de mandarlas.
- [ ] Un producto enviado a admisión deja de tener botón de editar.
- [ ] La galería rechaza una URL pegada a mano.

### El recorrido del evaluador

- [ ] Un moderador puede evaluar y NO ve botón de publicar.
- [ ] Nadie evalúa su propio producto, y el mensaje lo dice con claridad.
- [ ] La pantalla enseña qué dimensiones faltan por puntuar y cuáles no tienen evidencia.
- [ ] Con cinco dimensiones puntuadas NO aparece ninguna puntuación total.
- [ ] Las tres razones solo se pueden elegir de la evidencia registrada.
- [ ] Marcar una falla crítica deja claro que el resultado será rechazo.
- [ ] Un 86 deja el producto en «aprobado con condiciones» y la pantalla explica por qué no se puede publicar.
- [ ] Publicar con dos razones se rechaza y dice que faltan tres.
- [ ] Suspender exige motivo, y el motivo llega al proveedor.

## Productos, Incremento 4 (17/09/2026)

**NADA DE ESTO SE HA MARCADO.** Son las comprobaciones que un teléfono de verdad
tiene que hacer sobre las fotografías, el inventario y la bolsa, y ninguna la
puede hacer una prueba automática.

### Fotografías, con la cámara y el carrete de verdad

- [ ] Subir una foto desde el carrete en iOS deja ver el selector: no se queda la pantalla congelada.
- [ ] Subir desde la cámara en Android funciona igual.
- [ ] Una foto de 12 MP del teléfono se sube o se rechaza por peso con un mensaje que se entiende; no se queda colgada.
- [ ] Con la red cortada a mitad de una subida, el error dice qué pasó y se puede reintentar.
- [ ] Reintentar la misma subida NO deja dos fotografías iguales.
- [ ] Renombrar un vídeo a `.jpg` y subirlo lo rechaza el servidor, no solo la pantalla.
- [ ] El texto alternativo es obligatorio y el teclado no tapa el campo.
- [ ] Una fotografía pendiente se distingue de una aprobada SIN mirar el color: hay icono y texto.
- [ ] Una rechazada enseña el motivo escrito por quien la rechazó.
- [ ] Reordenar las fotografías se ve reflejado en la ficha pública tras publicar.
- [ ] Quitar una fotografía pide confirmación y no se lleva ninguna otra.
- [ ] Con VoiceOver / TalkBack, cada fotografía se anuncia con su texto alternativo.
- [ ] El catálogo NO enseña ninguna fotografía pendiente ni rechazada.
- [ ] Una URL firmada caducada no deja la tarjeta rota: se vuelve a firmar al recargar.

### Inventario, en el teléfono de quien vende

- [ ] Una variante sin existencias cargadas dice «sin existencias cargadas», NUNCA «agotado» ni «0».
- [ ] Cargar una entrada con doble toque rápido carga UNA vez, no dos.
- [ ] Un ajuste sin motivo tiene el botón apagado, y se ve por qué.
- [ ] Un ajuste que dejaría la existencia negativa se rechaza con un mensaje que dice cuánto hay.
- [ ] El historial se lee de arriba abajo y se entiende sin explicación.
- [ ] El historial no ofrece editar ni borrar ninguna línea.
- [ ] Con el teclado abierto, el campo de cantidad sigue visible.
- [ ] Los tres números —disponible, en existencia y comprometidas— caben a 320 px sin cortarse.

### La bolsa

- [ ] La bolsa vacía NO enseña «0.00» ni ningún importe.
- [ ] El contador de la bolsa y el de guardados son dos números distintos y se entiende cuál es cuál.
- [ ] Guardar un producto NO cambia el contador de la bolsa.
- [ ] Añadir dos veces el mismo producto ajusta la cantidad; no aparecen dos líneas.
- [ ] Doble toque rápido en «Añadir a la bolsa» suma UNA unidad.
- [ ] El «+» está apagado cuando no quedan más unidades, y se explica.
- [ ] Bajar de 1 quita la línea y la pantalla lo dice antes o lo deshace.
- [ ] Un producto suspendido sigue siendo identificable en la bolsa y no se puede comprar.
- [ ] Un precio que cambió se ve tachado junto al nuevo, sin que la línea se bloquee.
- [ ] **NO HAY NINGÚN BOTÓN DE PAGAR, COMPRAR NI CONTINUAR** en toda la pantalla.
- [ ] El pie dice con palabras que la compra todavía no está habilitada.
- [ ] Con la red cortada, la bolsa dice «sin conexión» y ofrece reintentar; no se vacía.
- [ ] Cerrar la aplicación y volver a entrar conserva la bolsa entera.

### Las tres migraciones sin aplicar

- [ ] Con la 0073 sin aplicar, la pantalla de fotografías dice que no está disponible; no revienta.
- [ ] Con la 0074 sin aplicar, la de inventario dice lo mismo.
- [ ] Con la 0075 sin aplicar, la bolsa dice lo mismo y el catálogo se sigue recorriendo entero.

### En las cuatro anchuras y los tres idiomas

- [ ] La bolsa, el inventario y las fotografías a 320, 375, 390 y 768 px, sin desbordes.
- [ ] En claro y en oscuro.
- [ ] En español, inglés y portugués: ninguna clave cruda en pantalla.
- [ ] Con el texto del sistema ampliado al máximo, ningún botón queda fuera de alcance.
- [ ] Todas las áreas táctiles llegan a 44×44.

---

## Productos, Incremento 5 (17/09/2026)

**Nada de esta lista esta comprobado.** Son las cosas del pedido que ninguna
prueba automatica puede ver: el teclado tapando un campo, el navegador que se
abre y vuelve, el doble toque de verdad y lo que pasa cuando alguien deja el
checkout a medias.

**Antes de empezar:** la 0076, la 0077 y la 0078 tienen que estar aplicadas, la
API reiniciada despues, y tiene que haber una politica de venta publicada para
el pais con el que se pruebe. Sin eso, lo unico que se puede comprobar es que
las pantallas lo dicen, que tambien esta en esta lista.

### Lo que falta, dicho con palabras

- [ ] Con la venta apagada, el checkout enseña **la lista de lo que falta** y no
      un error: se leen las cinco condiciones, cada una con su frase.
- [ ] Sin politica publicada para ese pais, el checkout lo dice y **no** deja
      seguir.
- [ ] Con la 0078 sin aplicar, el checkout y «Mis pedidos» dicen que todavia no
      estan disponibles, y el catalogo, las fotografias, el inventario y la
      bolsa se siguen usando enteros.
- [ ] En ninguna de las tres pantallas aparece «Envio: 0,00» ni «Impuestos:
      0,00».
- [ ] Sin plazo de incidencias en la politica, **no** aparece «compra
      protegida».

### El formulario de la direccion

- [ ] Con el teclado abierto se puede llegar a todos los campos y al boton.
- [ ] El teclado del telefono sale numerico en el campo de telefono.
- [ ] Faltando varios campos, el pie los nombra **todos**, no el primero.
- [ ] En Peru, sin distrito no deja seguir; en un pais sin ese nivel, si.
- [ ] Cambiar el pais borra la aceptacion de las condiciones y vuelve a
      pedirlas.
- [ ] Girar el telefono a medias no borra lo escrito.
- [ ] En ningun sitio se pide la ubicacion, ni se abre un mapa, ni se piden
      documentos de identidad.

### Las condiciones

- [ ] «Leer las condiciones completas» abre el texto entero y se puede
      desplazar.
- [ ] Sin marcar la casilla, el boton de reservar esta desactivado.
- [ ] Con el lector de pantalla, la casilla se anuncia como casilla y dice si
      esta marcada.

### Reservar

- [ ] **Doble toque real** en «Reservar y continuar»: se crea **un** pedido, y
      el inventario baja **una** vez.
- [ ] Con dos telefonos y una sola unidad: uno reserva y el otro recibe un
      mensaje que se entiende.
- [ ] Con un pedido ya abierto, el segundo intento dice cual es y deja ir a el.
- [ ] Matar la aplicacion justo despues de reservar y volver a entrar: el pedido
      esta en «Mis pedidos» y el inventario cuadra.

### Pagar, volver y cancelar

- [ ] «Ir a pagar» abre el **navegador del sistema**, no una vista dentro de la
      aplicacion.
- [ ] Volver del navegador **sin haber pagado** no deja el pedido como pagado.
- [ ] Volver con la ruta de cancelacion enseña el aviso de cancelado y el estado
      real debajo.
- [ ] Sin conexion, «Ir a pagar» falla con un mensaje que se entiende y el
      pedido no cambia de estado.
- [ ] Cancelar pregunta antes, y cancelar dos veces seguidas no da error.
- [ ] Tras cancelar, las unidades vuelven a estar disponibles en la ficha.
- [ ] En un pedido pagado **no hay** boton de cancelar.

### La reserva y su reloj

- [ ] Los minutos que quedan bajan al volver a la pantalla, y en cero el boton
      de pagar se apaga.
- [ ] Con el reloj del telefono adelantado una hora, la pantalla no marca nada
      como vencido por su cuenta: quien vence es el servidor.

### Lo que NO puede aparecer

- [ ] En ninguna pantalla hay campo de tarjeta, CVV, caducidad ni PayPal.
- [ ] En ninguna pantalla se promete correo de confirmacion.
- [ ] El detalle del pedido no promete transportista ni seguimiento: lo dice.

### En las cuatro anchuras y los tres idiomas

- [ ] Checkout, «Mis pedidos» y detalle a 320, 375, 390 y 768 px, sin desbordes.
- [ ] En claro y en oscuro.
- [ ] En español, ingles y portugues: ninguna clave cruda en pantalla.
- [ ] Atras funciona en las tres y ninguna deja atrapado.
- [ ] Todas las areas tactiles llegan a 44x44.
## Productos, Incremento 6 — la entrega (21/09/2026)

**Nada de esta lista esta comprobado.** Son las cosas de la preparacion, el
despacho y la entrega que ninguna prueba automatica puede ver: el conteo de una
caja con el teclado delante, el doble toque de verdad sobre un boton que saca
unidades del almacen, y los dos telefonos a la vez.

**Antes de empezar:** la 0079 tiene que estar aplicada y **la API reiniciada
despues** —la puerta de esquema guarda el «no» en memoria del proceso—, y tiene
que haber un pedido **pagado** de verdad. Sin pasarela encendida no hay forma de
llegar a uno desde la aplicacion: el unico camino honesto para probar esto en
aparato es sembrar el pedido pagado desde el servidor.

**Dos cuentas distintas y dos telefonos.** La mitad de esta lista no se puede
comprobar con una sola sesion: quien vende y quien compra tienen que ser dos
personas en dos aparatos.

### El recorrido de quien vende, en el telefono

- [ ] «Mis productos» lleva a los pedidos de la tienda, y la lista vacia explica
      que todavia no hay nada que preparar en vez de parecer rota.
- [ ] Un pedido pagado aparece como pendiente de preparacion.
- [ ] Los botones de sumar y restar unidades llegan a 44x44 y se aciertan con el
      pulgar, sin ampliar.
- [ ] Con el teclado abierto, el conteo de la caja sigue viendose.
- [ ] Meter y sacar unidades actualiza el avance sin recargar la pantalla entera.
- [ ] Con una linea a medias, **cerrar el paquete esta apagado** y se lee por que.
- [ ] Cerrado el paquete, reabrirlo **pide motivo** y no deja seguir sin el.
- [ ] Despachar **pregunta antes** y el dialogo dice que las unidades saldran del
      almacen y que no se deshace.
- [ ] **Doble toque de verdad** sobre «Despachar»: dos pulsaciones rapidas dejan
      UNA sola salida. Comprobar despues el inventario del producto.
- [ ] Transportista y referencia se pueden dejar **vacios**, y al volver a entrar
      la pantalla dice que no se indicaron, **no** «N/A» ni un hueco.
- [ ] Con transportista escrito, se ve en el seguimiento de quien compro.
- [ ] Registrar una entrega fallida **pide motivo**.
- [ ] Reintentar la entrega no devuelve nada al almacen: comprobarlo en la ficha
      del producto.

### El recorrido de quien compra, en el otro telefono

- [ ] «Mis pedidos» lleva al detalle, y el detalle trae el seguimiento **dentro**,
      sin un segundo salto ni un parpadeo con el pedido a medio pintar.
- [ ] El estado del envio cambia en el telefono de quien compro **despues** de
      que quien vende lo mueva en el suyo, al recargar.
- [ ] La linea de tiempo mezcla el pago y el envio en orden, y se entiende de que
      habla cada paso.
- [ ] **No aparece ninguna fecha de llegada**, ningun enlace de seguimiento,
      ningun coste de envio y ningun impuesto.
- [ ] Sin transportista escrito, se dice que quien despacho no lo indico.
- [ ] Con el paquete despachado, «Confirmo que lo recibi» aparece.
- [ ] **Con el paquete ya entregado por quien vende, «Confirmo que lo recibi»
      sigue apareciendo** —hasta que se pulsa— y despues ya no.
- [ ] El texto bajo ese boton dice que confirmar **no** es dar la conformidad y
      que no libera ningun pago.
- [ ] Doble toque sobre confirmar: se guarda una sola vez y no sale error.

### Administracion

- [ ] El acceso esta en la administracion de Productos y la cola se abre.
- [ ] En la cola **no** hay direccion, ni nombre de quien compro, ni importe, ni
      el motivo de una entrega fallida.
- [ ] El tiempo transcurrido se lee como un hecho: **en ningun sitio pone
      «atrasado»** ni nada parecido.
- [ ] Un pedido entregado **desaparece** de la cola.

### Los dos telefonos a la vez

- [ ] Quien vende despacha mientras quien compra tiene el pedido abierto: al
      recargar, quien compra ve el cambio.
- [ ] Quien vende y quien compra registran la entrega **casi a la vez**: no sale
      error en ninguno de los dos y el historial guarda **quien la afirmo
      primero**.
- [ ] Con la conexion cortada a mitad de un despacho, al recuperarla el pedido
      **no** aparece despachado dos veces y el inventario cuadra.

### Atras, teclado y lo que solo falla en aparato

- [ ] El Atras de Android funciona en las cinco pantallas y ninguna deja
      atrapado.
- [ ] Salir del detalle del pedido y volver no pierde el estado del envio.
- [ ] Con la aplicacion en segundo plano un rato y de vuelta, no se queda una
      pantalla en blanco.
- [ ] Con conexion lenta o intermitente: la pantalla dice que esta cargando, y al
      fallar ofrece reintentar en vez de quedarse vacia.

### Accesibilidad

- [ ] Con el lector de pantalla: cada estado del envio se **lee**, no se deduce
      del color. Los botones de sumar y restar se anuncian con lo que hacen.
- [ ] Con la fuente del sistema al maximo, el conteo de la caja y el avance
      siguen leyendose y nada se solapa.
- [ ] Ningun estado se distingue **solo** por color: siempre icono y texto.

### Avisos

- [ ] Al despachar, a quien compro le llega el aviso dentro de la aplicacion.
- [ ] Al registrar la entrega, igual.
- [ ] **Limitacion conocida:** un segundo intento de entrega fallido del mismo
      pedido **no** vuelve a sonar. Es deliberado (ver D108); comprobar que el
      estado del pedido si lo cuenta entero al abrirlo.

### En las cuatro anchuras y los tres idiomas

- [ ] Las cinco pantallas a 320, 375, 390 y 768 px, sin desbordes.
- [ ] En claro y en oscuro.
- [ ] En espanol, ingles y portugues: ninguna clave cruda en pantalla.
- [ ] Todas las areas tactiles llegan a 44x44.

### Con la 0079 SIN aplicar, que es como se entrega

- [ ] Las pantallas de la entrega dicen que **todavia no esta desplegada**, con
      esas palabras, y no un error.
- [ ] El catalogo, las fotografias, el inventario, la bolsa y el pedido siguen
      funcionando.

## Productos, Incremento 8 — las valoraciones (22/09/2026)

**Nada de esta lista esta comprobado.** Son las cosas de valorar una compra que
ninguna prueba automatica puede ver: acertar una estrella con el pulgar, el
teclado tapando el contador del comentario, y las dos personas a la vez —quien
opina y quien responde— en dos aparatos.

**Antes de empezar:** la 0081 tiene que estar aplicada y **la API reiniciada
despues** —la puerta de esquema guarda el «no» en memoria del proceso—, y tiene
que haber un pedido pagado, despachado y **entregado** de verdad. Sin pasarela
encendida el unico camino honesto es sembrarlo desde el servidor, igual que en
el Incremento 6.

**Dos cuentas distintas y dos telefonos.** Quien opina y quien vende tienen que
ser dos personas en dos aparatos: la mitad de esta lista es ver como le llega a
la otra parte.

### El recorrido de quien compro

- [ ] En la ficha del pedido entregado aparece el bloque de valorar, y **no**
      aparece antes de que llegue.
- [ ] Con las lineas ya valoradas, el bloque dice que no queda nada por valorar
      en vez de llevar a una pantalla vacia.
- [ ] Las cinco estrellas se aciertan con el pulgar sin ampliar: cada una llega
      a 44x44 y las cinco caben en una fila a 320 px.
- [ ] Con el lector de pantalla encendido, cada estrella se anuncia como «3 de
      5» y el grupo dice de que eje habla.
- [ ] Con el teclado abierto, el contador del comentario sigue viendose y el
      boton de publicar se alcanza.
- [ ] El boton de publicar esta apagado hasta que estan las seis respuestas, y
      **encima dice cual falta**.
- [ ] **Doble toque de verdad** sobre «Publicar valoracion»: dos pulsaciones
      rapidas dejan UNA sola valoracion, no dos, y la segunda no deja un error
      rojo sin explicacion.
- [ ] Con conexion lenta (Network Link Conditioner o modo avion a medias): el
      boton se queda en carga y no se puede pulsar dos veces.
- [ ] Publicada, se llega a la propia y se puede editar.
- [ ] En un pedido con **dos lineas** se puede valorar cada una aparte, y la
      segunda no arrastra la puntuacion de la primera.
- [ ] **Atras** desde el formulario a medias vuelve al pedido sin dejar nada
      escrito a medias.

### El recorrido de quien vende, en el otro telefono

- [ ] «Mis productos» lleva a «Lo que opinan de mi tienda», y la lista vacia
      explica que todavia no hay valoraciones en vez de parecer rota.
- [ ] La bandeja **solo** ensena valoraciones de sus productos.
- [ ] Responder publica una respuesta, y el boton **desaparece** despues: una
      sola respuesta visible por valoracion.
- [ ] No hay ningun boton para cambiar ni ocultar lo que escribio quien compro,
      y la pantalla lo dice con palabras.
- [ ] Con la capacidad comercial **suspendida**, la bandeja contesta que no le
      toca y no un error.

### La ficha del producto

- [ ] Sin valoraciones, el bloque dice que todavia no lo ha valorado nadie:
      **ni un 0,0, ni cinco estrellas vacias, ni un «0 %»**.
- [ ] Con una sola valoracion, la puntuacion ajustada se ensena y **debajo se
      explica** que se apoya en una referencia general.
- [ ] «Ver todas» lleva a la lista, y la lista pagina sin repetir ni saltarse
      filas al bajar.
- [ ] La lista **no** dice de que pedido sale cada opinion.
- [ ] Con la 0081 aplicada pero sin ninguna valoracion, el resto de la ficha se
      ve entero.

### Moderacion

- [ ] La cola solo la abre administracion; con una cuenta de moderacion dice que
      no le toca.
- [ ] Ocultar **no cambia** la puntuacion, el texto ni el autor: se comprueba
      volviendo a mostrarla y leyendola.
- [ ] El historial cuenta los dos pasos, en orden.
- [ ] Ocultar la respuesta del proveedor es una accion aparte de ocultar la
      valoracion.
- [ ] A quien la escribio se le sigue ensenando entera, con el aviso de que esta
      oculta.

### Entre los dos telefonos

- [ ] Al publicar una valoracion, a quien vende le aparece en su bandeja al
      recargar. **Limitacion conocida:** no hay aviso dentro de la aplicacion
      para esto, y es deliberado: nadie ha decidido si valorar debe notificar.
- [ ] Al responder, quien opino ve la respuesta en su valoracion al recargar.

### En las cuatro anchuras y los tres idiomas

- [ ] Las cinco pantallas a 320, 375, 390 y 768 px, sin desbordes. Ojo a la fila
      de cinco estrellas y a las barras del histograma a 320 px.
- [ ] En claro y en oscuro.
- [ ] En espanol, ingles y portugues: ninguna clave cruda en pantalla.
- [ ] Todas las areas tactiles llegan a 44x44.

### Con la 0081 SIN aplicar, que es como se entrega

- [ ] Las pantallas de valoraciones dicen que **todavia no esta desplegado**,
      con esas palabras, y no un error.
- [ ] **La ficha del producto se sigue viendo entera**, solo sin el bloque de
      valoracion: se lee en su propia peticion a proposito.
- [ ] La ficha del pedido se sigue viendo entera, solo sin el bloque de valorar.
- [ ] El catalogo, las fotografias, el inventario, la bolsa, el pedido, la
      entrega y las reclamaciones siguen funcionando.

### Lo que anadio la revision independiente del Incremento 8

- [ ] Con una cuenta de proveedor **a la que se le ha dado rol de moderacion**,
      entrar en la cola de valoraciones e intentar ocultar una de un producto
      propio: la pantalla dice que nadie modera lo suyo, y **no** un error
      generico de permisos.
- [ ] Ocultar una valoracion, pulsar «ver las ocultas» y **volver a mostrarla**:
      el recorrido entero, en la pantalla, sin escribir ninguna URL.
- [ ] Escribir un motivo en una valoracion, **no enviarlo**, bajar a otra y
      ocultarla: el motivo de la primera **no** viaja con la segunda.
- [ ] Un producto con **una sola** valoracion de una estrella: la ficha NO
      enseña cuatro estrellas. Enseña el numero ajustado, la puntuacion real al
      lado y la linea que explica la referencia.
- [ ] Con mas de veinte valoraciones en la tienda, «ver mas» trae las
      siguientes y no repite ninguna.
- [ ] Con el lector de pantalla encendido, las barras del histograma se leen
      «tres de cinco estrellas» y no «3».


## Productos, Incremento 9 — el dinero y el cierre operativo (22/09/2026)

**NADA DE ESTO ESTA COMPROBADO.** Son dos telefonos de verdad, y lo que se mira
aqui es dinero: una cifra de mas o de menos en una pantalla no es un defecto
cosmetico. Ninguna casilla se marca sin haberlo hecho.

**Y hace falta la 0082 aplicada para casi todo.** El ultimo apartado es el unico
que se comprueba sin aplicarla, y es como se entrega hoy.

### Sin comision configurada, que es el estado de hoy

- [ ] En «Mi saldo», con ventas pagadas y entregadas detras: la pantalla dice
      **«pendiente de configuracion»** y **no** enseña ningun importe.
- [ ] Concretamente: **no aparece ningun `0,00` en ninguna parte** de esa
      pantalla. Ni en disponible, ni en retenido, ni en el desglose.
- [ ] La pantalla distingue «todavia no has vendido» de «falta decidir la
      comision»: son dos textos distintos y no el mismo.
- [ ] En el panel de administracion, «salud financiera» dice que falta el
      porcentaje de comision, con esas palabras.
- [ ] Y **no hay ningun saldo escrito**: la lista de movimientos esta vacia
      porque no hay filas, no porque no se pinten.

### El recorrido de quien compro

- [ ] Un pedido pagado y entregado enseña el bloque de conformidad.
- [ ] El texto explica que **no hace falta darla**: si no se dice nada, el plazo
      vence solo. Leerlo y comprobar que no suena a obligacion.
- [ ] Dar la conformidad: la pantalla lo refleja sin recargar a mano.
- [ ] **Volver a entrar**: ya no ofrece darla otra vez, dice que esta dada.
- [ ] Con una reclamacion abierta sobre ese pedido, el boton **no se ofrece**, y
      se explica por que.
- [ ] La conformidad y «confirmar que llego» se ven como **dos cosas
      distintas** en la pantalla, no como el mismo boton con dos nombres.

### El dinero que vuelve, en el telefono de quien compro

- [ ] Con una devolucion en «aprobada»: la pantalla **no** dice que el dinero
      volvio. Dice que esta aprobada.
- [ ] Con una en «en curso»: igual, y con un icono distinto del de confirmada.
- [ ] Con una **confirmada**: ahi si, y con su importe y su moneda.
- [ ] Ningun importe aparece sin su moneda al lado.

### El recorrido de quien vende, en el otro telefono

- [ ] Con la comision configurada y una venta entregada: «Mi saldo» enseña
      disponible, retenido y el desglose de bruto, comision y neto.
- [ ] Los tres importes llevan **su moneda**, y cuadran: bruto − comision = neto.
- [ ] Un saldo bloqueado dice **por que** y **que hacer**, y las dos frases son
      distintas entre si.
- [ ] Con un pedido entregado hace poco: el bloqueo es **el reloj**, no la
      cuenta de cobro. Y dice cuantas horas faltan.
- [ ] Con un pedido **sin entregar**: el bloqueo es la entrega. **No** dice que
      falte la cuenta de cobro.
- [ ] **No hay ningun boton de transferir**, y la pantalla explica que el alta de
      la cuenta de cobro todavia no esta abierta.
- [ ] Con mas de veinte movimientos, «ver mas» trae los siguientes y no repite.

### El panel financiero de administracion

- [ ] Dice con palabras que **desde ahi no se mueve dinero**.
- [ ] Dice que **aprobar no es pagar**.
- [ ] Dice que **quien absorbe la comision de la pasarela esta por decidir**.
- [ ] Los seis contadores salen, y un cero se ve como cero (aqui **si** es cero).
- [ ] Aprobar una devolucion: queda en «aprobada», y **el dinero no se ha
      movido**. Comprobarlo mirando el saldo del proveedor en el otro telefono.
- [ ] Pedirla a la pasarela **con Stripe apagado**: falla, queda reintentable, y
      **nunca** dice «confirmada».
- [ ] El historial de esa devolucion enseña los dos movimientos **en orden**.
- [ ] Intentar aprobar por **mas** del importe del pedido: lo rechaza y enseña
      el tope de verdad, no uno estimado.
- [ ] Lanzar «liberar los vencidos» con una reclamacion abierta sobre un saldo
      vencido: **ese saldo no se libera**, y el motivo lo dice.
- [ ] Lanzarlo **dos veces seguidas**: la segunda no mueve nada.

### Quien puede que

- [ ] Con una cuenta de **moderacion** (no `admin`): el panel financiero
      contesta que no, y la pantalla lo dice con palabras.
- [ ] Con la cuenta de un proveedor: ve **su** saldo y **ninguno ajeno**.
- [ ] Con la cuenta de quien compro: ve las devoluciones de **sus** pedidos y
      ninguna otra.

### En las cuatro anchuras y los tres idiomas

- [ ] 320, 360, 390 y 430 px: ningun importe se parte ni se sale, y la fila de
      un saldo bloqueado cabe con su motivo.
- [ ] En claro y en oscuro.
- [ ] En espanol, ingles y portugues: ninguna clave cruda en pantalla.
- [ ] Todas las areas tactiles llegan a 44x44.
- [ ] Con el lector de pantalla encendido, un importe se lee entero y con su
      moneda, no como una lista de numeros sueltos.

### Con la 0082 SIN aplicar, que es como se entrega

- [ ] «Mi saldo» y el panel financiero dicen que **todavia no esta desplegado**,
      con esas palabras, y no un error.
- [ ] **La ficha del pedido se sigue viendo entera**, solo sin el bloque de
      conformidad y sin el del dinero devuelto.
- [ ] El catalogo, las fotografias, el inventario, la bolsa, el pedido, la
      entrega, las reclamaciones y las valoraciones siguen funcionando.
- [ ] Un pago de prueba **se sigue confirmando**: que las finanzas no esten
      desplegadas no puede romper el cobro.


---

## Productos, cierre de la vertical (22/09/2026)

**Nada de esta lista esta comprobado.** Son las comprobaciones que quedan
despues del cierre tecnico, y son POCAS a proposito: se han dejado fuera las que
ya cubre la bateria automatica. Lo que queda aqui es lo que necesita una cuenta
de Stripe de verdad, dos aparatos o una persona mirando la pantalla.

**Antes de empezar:** las ochenta y dos migraciones estan aplicadas, asi que ya
no hay que comprobar ninguna puerta de esquema contra la base gestionada. Lo que
si hay que hacer es **reiniciar la API** despues de cada cambio de variables: los
ajustes se leen una vez por proceso.

### Con Stripe en modo de PRUEBA, y solo ahi

Estas veinte estan detalladas en `Z_STRIPE_PUESTA_EN_MARCHA.md` §5 y no se
repiten aqui. Ninguna se hace contra la cuenta real hasta que la empresa lo
autorice.

- [ ] Las veinte del apartado 5 del documento de puesta en marcha, en orden.
- [ ] Y una mas que no esta alli: con la clave secreta puesta pero **el webhook
      sin registrar**, una compra se queda pagada en la pasarela y el pedido NO
      pasa a pagado. Es el fallo mas probable de la puesta en marcha y conviene
      haberlo visto una vez.

### La reposicion entregada, que es la pantalla nueva

- [ ] Con una reclamacion resuelta como **reposicion**, la pantalla de decidir
      ofrece «Registrar que llego» y explica que el dinero sigue retenido hasta
      entonces.
- [ ] Con una resuelta como **reembolso** (cualquiera de las tres), ese bloque
      **no aparece**.
- [ ] Sin escribir motivo, el boton esta apagado.
- [ ] Al pulsar, **pregunta antes** y el dialogo dice que no se deshace y que no
      devuelve dinero.
- [ ] Despues de registrarla, el bloque desaparece y el paso queda en el
      historial con su texto.
- [ ] **Doble toque de verdad**: dos pulsaciones rapidas dejan UN solo renglon.
- [ ] Con una cuenta de **moderacion** (no financiera): la aplicacion dice que no
      puede, con palabras y no con un codigo.
- [ ] En espanol, ingles y portugues.

### El saldo que se devolvio en parte

- [ ] Con una devolucion parcial confirmada, «Mi saldo» dice que **se devolvio
      una parte de esta venta** y que quien la asume esta sin decidir. **No dice
      que haya una devolucion en marcha.**
- [ ] El importe apartado y el disponible cuadran con lo que se ve en el detalle.
- [ ] En los tres idiomas.

### Lo que sigue necesitando dos personas y dos telefonos

- [ ] El recorrido entero de quien compra y quien vende, de pagado a entregado,
      con los dos aparatos a la vez. (Ver la seccion del Incremento 6.)
- [ ] Una reclamacion abierta desde un telefono y respondida desde el otro, con
      fotografias hechas con la camara de verdad.
- [ ] Los avisos dentro de la aplicacion, que no se pueden comprobar sin dos
      sesiones.

### Lo que NO se puede comprobar en ningun aparato

Se deja escrito para que nadie lo marque por error:

- [ ] ~~El transportista, la tarifa y el plazo de entrega~~ — no hay
      transportista elegido. **El Incremento 6 no es un entregable comercial
      terminado hasta que lo haya.**
- [ ] ~~El impuesto y el comprobante~~ — no hay entidad legal decidida.
- [ ] ~~La transferencia a quien vende~~ — no existe el alta de cuenta conectada.
- [ ] ~~Quien absorbe un contracargo perdido~~ — sin decidir.

---

## Z Servicios · Incremento 1 — admisión de prestadores (29/09/2026)

**Nada de esta sección está comprobado en un teléfono.** Las pruebas
automáticas cubren la API, PostgreSQL y el código de las pantallas, pero no un
aparato, ni el selector de archivos, ni el lector de pantalla.

Antes de empezar:

- La **0088** y la **0089** ya están aplicadas en Supabase (29/09/2026; la
  0089, verificada sin divergencias). Si se usa otra base de pruebas,
  aplicarle la **0089 completa** (`Z_BAJA_DE_CUENTA.md` §10) antes de probar
  la eliminación de cuenta.
- La API de ese entorno tiene que correr el código de `Edson` (todavía sin
  desplegar). Reiniciarla después de cualquier migración: la puerta de la
  baja recuerda lo que vio al arrancar.
- Encender `FEATURE_SERVICES=true` **solo en ese entorno**.
- Publicar unas condiciones del prestador para el país de prueba, desde
  Administración › Servicios › Condiciones del prestador.

Hacen falta **dos cuentas en dos teléfonos**: quien postula (`user`) y una de
administración (`admin`). Si se puede, una tercera de moderación
(`moderator`), para ver que no aprueba.

### Con la bandera apagada, que es como se entrega

- [ ] El menú del perfil es **exactamente** el de antes: no aparece «Ofrecer un servicio».
- [ ] El panel de administración es exactamente el de antes: no aparece la sección Servicios.
- [ ] Cursos, Eventos y Productos se comportan igual que antes.

### Quien postula

- [ ] Perfil › «Ofrecer un servicio» abre la explicación. No aparece ningún
      precio, catálogo ni reserva.
- [ ] Persona o empresa, más el nombre. Tocar «Continuar» dos veces seguidas
      crea UNA sola postulación.
- [ ] Información básica: se guarda y, al volver atrás, sigue ahí. Con
      «Empresa» aparecen el registro tributario y el representante.
- [ ] Condiciones:
  - sin país, lo pide;
  - sin condiciones publicadas, lo dice con palabras;
  - con ellas, enseña la versión y la huella;
  - aceptar exige marcar «He leído».
- [ ] Documentos:
  - subir una **foto hecha con la cámara**;
  - subir un **PDF**;
  - un archivo de más de 10 MB lo rechaza **antes** de subirlo;
  - «Ver» abre el documento, y el enlace deja de servir **a los 2 minutos**.
- [ ] Documentos: reemplazar uno; quitar uno que no se ha enviado.
- [ ] Credenciales:
  - declarar una con número: después solo se ve `••••` y los 4 últimos;
  - elegir la evidencia;
  - editarla;
  - quitarla.
- [ ] Resumen:
  - enseña lo que falta en palabras, nunca un código;
  - «Enviar» no se activa sin la declaración de veracidad.
- [ ] Enviar con **conexión cortada** a mitad: dice que no hay conexión y, al
      reintentar, **no** envía dos veces.
- [ ] Tras enviar ya no se puede editar nada. El estado dice «Enviada».

### Administración (segundo teléfono)

- [ ] Panel › Servicios › Postulaciones: la bandeja enseña la enviada. Los
      filtros de estado y tipo funcionan. «Ver más» pagina sin repetir filas.
- [ ] Tomar para revisión. Abrir cada documento («Ver», 2 minutos) y la
      evidencia de la credencial.
- [ ] Observar un documento con motivo. Sin motivo, no deja.
- [ ] Pedir correcciones:
  - marcar un dato;
  - pide confirmación;
  - un doble toque decide una sola vez.
- [ ] Con moderación: puede tomar y pedir correcciones, pero **no** aprobar,
      rechazar ni suspender. Esos botones no aparecen.

### Correcciones y reenvío (primer teléfono)

- [ ] Llega el aviso «Z te pidió correcciones». Al tocarlo, abre la postulación.
- [ ] Se ven el mensaje de Z y el dato por corregir. Reemplazar el documento
      observado y corregir el dato.
- [ ] Reenviar sin corregir lo pedido: dice qué falta. Corregido, se reenvía.

### Decisiones

- [ ] Aprobar sin aceptar todos los documentos: dice qué lo impide.
- [ ] Aprobar con todo aceptado: quien postula recibe el aviso y ve «Aprobada».
- [ ] Suspender (con motivo): el estado del prestador pasa a suspendido. Llega
      el aviso.
- [ ] Devolver a revisión la suspendida: el botón dice «Devolver a revisión».
- [ ] En ese momento quien postula **no** puede retirarse: no aparece la opción.
- [ ] Rechazar (con motivo): quien postula ve el motivo.
- [ ] Postular de nuevo tras un rechazo:
  - si las condiciones no lo deciden, lo dice;
  - si lo permiten, empieza una nueva.
- [ ] Dos personas de administración deciden **a la vez** sobre la misma
      postulación: una gana y la otra ve «esto cambió mientras tanto», con el
      estado real.

### Retirada

- [ ] Retirar desde el borrador, desde enviada y desde «correcciones pedidas»:
      pide confirmación y explica que es definitivo.
- [ ] Tras retirarse, la nueva postulación empieza vacía: sin documentos ni
      condiciones aceptadas.

### Idiomas, accesibilidad y web

- [ ] Todo el recorrido, en español, en inglés y en portugués. Ningún texto sale
      en otro idioma ni como código.
- [ ] Con el lector de pantalla (TalkBack/VoiceOver):
  - los grupos de opciones se anuncian como botones de opción;
  - los botones desactivados se anuncian desactivados.
- [ ] Modo oscuro: se lee todo.
- [ ] Web: el mismo recorrido en el navegador. Subir un archivo abre el
      selector del sistema.
- [ ] Atrás de Android en cada paso: no pierde lo escrito ni reenvía nada.

### Eliminación de cuenta

**Con la 0089 completa** (en Supabase lo está desde el 29/09/2026) **y la API
con el código de `Edson`**. Corregido en el código y probado contra
PostgreSQL y con la API local de verdad (`Z_BAJA_DE_CUENTA.md` §15), pero
**no en un teléfono**. Usar cuentas de prueba desechables, nunca una real.

- [ ] En un entorno con la 0089 a medias (sin los frenos de las órdenes con
      dinero) y la API reiniciada: la baja **no se hace** (503
      `account_deletion_unavailable`), el teléfono dice «No se pudo eliminar
      la cuenta · Inténtalo de nuevo en unos momentos. Tu cuenta sigue
      activa.», y no se pierde ningún archivo. Solo en una base de pruebas.

- [ ] Borrar la cuenta de quien postuló, desde Ajustes › Eliminar cuenta:
  - la app vuelve a la portada y la sesión se cierra;
  - su postulación, sus documentos y sus archivos desaparecen: el enlace de un
    documento abierto antes deja de funcionar;
  - volver a entrar con esa cuenta no es posible.
- [ ] Desde administración, lo que se decidió sobre esa postulación sigue en
      la auditoría, sin nombrar a quien postuló.
- [ ] Borrar la cuenta de alguien de moderación o administración que decidió
      algo: se borra; sus decisiones siguen, sin su nombre.
- [ ] Una cuenta que haya enviado adjuntos por chat: tras borrarla, la otra
      persona ya no ve esos adjuntos, y los suyos propios siguen.
- [ ] Una cuenta con un producto creado (vendedor): **no se borra**, y el
      teléfono dice que tiene ventas, pedidos o reclamos y que escriba a
      soporte, **no** «inténtalo de nuevo». Revisar el texto en los tres
      idiomas.
- [ ] Sin conexión a mitad del borrado: el aviso dice que **no se pudo
      confirmar** (no que la cuenta sigue activa), y al reintentar con
      conexión se borra o se cierra la sesión si ya estaba borrada.
- [ ] Una cuenta con muchos vídeos: la baja termina sin cortarse (espera de
      hasta 90 s). Un vídeo recién subido que se está procesando: tras la
      baja no queda su miniatura ni su versión reducida.
- [ ] Una cuenta que compró una entrada **pagada** (cuando se enciendan los
      pagos): no se borra, y dice que escriba a soporte.
- [ ] Doble toque en «Sí, eliminar»: una sola baja, sin errores.

## Z Servicios · Incremento 2 — catálogo y publicación de servicios (29/09/2026)

**Nada de esta sección está comprobado en un teléfono.** Las pruebas
automáticas cubren la API, PostgreSQL y el código de las pantallas, no un
aparato, ni el selector de imágenes, ni el lector de pantalla. **Es lo único
que queda del Incremento 2**: la 0090 está aplicada en Supabase y verificada
sin divergencias (29/09/2026), y la puerta de esquema la reconoce con el rol
real de la API (`Z_SERVICIOS_ARQUITECTURA.md` §32).

Antes de empezar:

- La 0090 ya está aplicada y verificada en Supabase. En otra base de pruebas,
  aplicarla y verificarla (`Z_SERVICIOS_ARQUITECTURA.md` §26–§27) y
  **reiniciar la API** después.
- La API de ese entorno tiene que correr el código de `Edson` (sin desplegar).
- Encender `FEATURE_SERVICES=true` **solo en ese entorno**.
- Tener un prestador **aprobado** por la admisión del Incremento 1.

Hacen falta **tres cuentas**: el prestador (`user` con su postulación
aprobada), una de administración (`admin`) y una de moderación (`moderator`).
Si se puede, en dos teléfonos distintos (Android e iPhone) y una prueba en el
navegador.

### Con la bandera apagada, que es como se entrega

- [ ] El perfil, la postulación y el panel de administración son exactamente
      los de antes: no aparecen «Mis servicios», «Catálogo de servicios» ni
      «Categorías de servicios».
- [ ] Cursos, Eventos y Productos se comportan igual que antes.

### Sin la 0090 (solo en una base de pruebas que no la tenga)

- [ ] Con la bandera encendida, «Mis servicios» dice que Servicios aún no está
      disponible, sin error rojo ni reintento. Tras aplicar la 0090 **y
      reiniciar la API**, funciona.

### Administración: categorías

- [ ] Panel › Servicios › Categorías de servicios: vacía, con el texto de que
      sin categorías nadie puede crear servicios.
- [ ] Crear una categoría de primer nivel y otra dentro de ella; el
      identificador mal escrito (mayúsculas, espacios) se señala antes de
      enviar; uno repetido lo rechaza el servidor con palabras.
- [ ] Editar el nombre en inglés y en portugués; el identificador no se puede
      cambiar.
- [ ] Moderación ve las categorías pero **no** puede crearlas ni cambiarlas.
- [ ] Desactivar pide confirmación; la categoría deja de ofrecerse al crear un
      servicio.

### El prestador

- [ ] Quien **no** es prestador activo no ve «Mis servicios» en su
      postulación.
- [ ] Mis servicios vacío → Crear servicio → elegir categoría → nace el
      borrador y se abre «Completar información».
- [ ] Solo se ofrecen las categorías del país del prestador (o de todos), y no
      las que están dentro de una categoría desactivada.
- [ ] Completar a medias y guardar: no pide nada; debajo aparece lo que falta.
- [ ] Salir con cambios sin guardar pregunta antes; «Descartar» vuelve sin
      guardar.
- [ ] Precio: «Gratis» no pide importe; «Precio fijo» pide importe y moneda;
      «120,50» se guarda como 120.50; un importe de cero o con letras se
      señala antes de enviar.
- [ ] Presencial o a domicilio piden la zona; virtual no.
- [ ] Imágenes: sin descripción no deja elegir; con ella, abre la galería. Una
      imagen de más de 5 MB o un GIF se rechazan con palabras. Permiso de
      fotos denegado: el aviso lo dice.
- [ ] La primera imagen es la portada; «Usar como portada», subir y bajar
      funcionan; quitar pregunta antes.
- [ ] Revisar y enviar: cada cosa que falta lleva a donde se arregla; el botón
      solo se activa sin faltantes; «Así se verá» coincide con lo escrito.
- [ ] Enviar pide confirmación; después ya no se puede editar (la pantalla lo
      dice) y se puede retirar la versión (pide confirmación).
- [ ] Doble toque en enviar, crear y subir: una sola vez.

### La revisión

- [ ] A moderación y administración les llega «Nuevo servicio para revisar»;
      tocarlo **en la bandeja** abre la revisión.
- [ ] Bandeja: por revisar, filtros por estado de la versión, modalidad y
      categoría; «Ver más».
- [ ] Moderación inicia la revisión y pide cambios con motivo y campos; **no**
      ve «Aprobar» ni «Publicar».
- [ ] Al prestador le llega «Tu servicio necesita cambios»; tocarlo abre su
      servicio con el motivo y los campos. No ve la nota interna.
- [ ] En «Mis servicios», ese servicio conserva su título y dice «Con cambios
      pedidos», con otro icono.
- [ ] «Corregir y reenviar» abre la versión 2 con el contenido y las imágenes
      de la 1, y los campos señalados marcados; reenviar.
- [ ] Administración aprueba (el público todavía no lo ve) y publica; al
      prestador le llega «Tu servicio está publicado», que abre la ficha.
- [ ] Una administradora que también es prestadora abre su propio servicio en
      la bandeja: «es tuyo», sin decisiones.

### La ficha y lo publicado

- [ ] La ficha enseña portada, imágenes, precio con el código de la moneda,
      duración, modalidad, qué incluye y qué no, y el nombre público del
      prestador. No hay botón de contratar.
- [ ] Editar lo publicado abre la versión 2; la ficha sigue enseñando la 1
      hasta que Z publique la 2. En la revisión se marca lo que cambia.
- [ ] Suspender (con motivo, confirmación destructiva): la ficha dice que no
      lo encontramos; el prestador lee el motivo. Levantar la suspensión la
      devuelve.
- [ ] Retirar del catálogo: definitivo; el prestador ya no puede editarlo.
- [ ] Con el servicio suspendido, publicar una versión corregida: la
      confirmación avisa de que **no** se verá todavía; al prestador le llega
      «Tu versión nueva está lista», que abre su servicio (no la ficha).
      Levantar la suspensión la hace visible.

### Los avisos: bandeja y push

- [ ] En la bandeja, cada aviso del catálogo lleva a su sitio: los del
      prestador, a su servicio; «publicado», a la ficha; los del equipo, a
      la revisión.
- [ ] Un aviso de un servicio que ya no se ve (suspendido o retirado después)
      o abierto con otra cuenta: la pantalla dice «No encontramos ese
      servicio» o que no hay permiso, sin error rojo ni pantalla en blanco.
- [ ] **Tocar el push** (con la app cerrada y en segundo plano) abre la
      aplicación **sin llevar al servicio**. Es la limitación conocida
      (`Z_SERVICIOS_ARQUITECTURA.md` §32), la misma que en los demás avisos
      al creador: anotar si alguien lo espera distinto, no como fallo.
- [ ] El push llega en el idioma del teléfono (es, en, pt) y sin códigos.

### Accesibilidad, idiomas y cuenta

- [ ] Con TalkBack y VoiceOver, cada imagen se lee por su descripción, y las
      opciones de categoría, modalidad, precio y moneda se anuncian como
      botones de opción.
- [ ] En inglés y en portugués no queda ningún texto en español ni ningún
      código interno.
- [ ] Borrar la cuenta del prestador (Ajustes › Eliminar cuenta): sus
      servicios desaparecen de la bandeja y la ficha deja de existir; el
      enlace de una imagen abierta antes deja de funcionar.

## Z Servicios · Incremento 3 — descubrimiento y confianza (29/09/2026)

**Nada de esta sección está comprobado en un teléfono.** Las pruebas
automáticas cubren la API contra PostgreSQL y el código de las pantallas, y el
cierre técnico (§49 de la arquitectura) recorrió además la API real, reiniciada,
en local. Falta el teléfono.

Antes de empezar:

- La 0091 ya está **aplicada y verificada** en Supabase (29/09/2026,
  `Z_SERVICIOS_ARQUITECTURA.md` §49). Si el QA usa otra base, aplicarla allí,
  verificarla (§44–§45) y **reiniciar la API**.
- La API de ese entorno corre el código de `Edson` y tiene
  `FEATURE_SERVICES=true` **solo allí**.
- Tener al menos dos prestadores aprobados con servicios publicados en dos
  categorías, uno con una credencial verificada y otro sin ella; un servicio
  gratis, uno a consultar y uno con precio.

### Con la bandera apagada

- [ ] Explorar › «Servicios» sigue avisando de que aún no está, sin abrir
      nada. Cursos, Eventos y Productos, igual que antes.

### Entrar y buscar

- [ ] Explorar › «Servicios» abre el catálogo; «Atrás» vuelve a Explorar.
- [ ] Sin buscar: las categorías (cuatro y «Ver todas») y, si hay, las
      sugerencias con su razón; si no hay ninguna razón, no sale la sección.
- [ ] Buscar con mayúsculas, sin tildes y con espacios de más da lo mismo,
      también en palabras cortas («cafe» encuentra «Café», «peru» a
      «Perú»); varias palabras acotan; una sola letra o solo guiones bajos
      avisan sin buscar.
- [ ] Un servicio con la palabra en el título sale antes que otro que la
      tiene en la categoría, el resumen y la descripción.
- [ ] Abrir un enlace con una búsqueda que el servidor no acepta: se explica
      y ofrece «Limpiar filtros», nunca «Reintentar».
- [ ] Cada resultado dice dónde coincidió (título, categoría…).
- [ ] Sin resultados: el texto lo dice y «Limpiar filtros» devuelve todo.

### Filtros y orden

- [ ] Abrir filtros, elegir modalidad, «Con precio», una moneda y un rango;
      aplicar: el botón dice cuántos hay y los resultados cambian.
- [ ] Un rango sin moneda o «desde» mayor que «hasta» se avisan antes.
- [ ] La hoja de filtros avisa de que el rango incluye los precios «desde»
      por su importe mínimo.
- [ ] Gratis y a consultar no piden moneda ni rango.
- [ ] Ordenar por precio solo aparece con una moneda.
- [ ] Abrir una ficha y volver: la búsqueda y los filtros siguen ahí.
- [ ] «Ver más» trae la página siguiente sin repetir tarjetas.

### Ficha, prestador y confianza

- [ ] La ficha: contenido, quien lo ofrece (lleva a su perfil), «Lo que Z
      comprobó» solo con lo verdadero, «servicio revisado y aprobado por Z»
      con fecha, qué declara el prestador, y «Todavía no hay reseñas
      verificadas» sin estrellas. Sin botón de contratar.
- [ ] Más servicios del prestador y de la misma categoría, con su razón.
      Quien ofrece el servicio no ve lo suyo como «más de este prestador».
- [ ] La insignia de la tarjeta dice «Prestador con credencial verificada».
- [ ] Administración desactiva una categoría con servicios publicados: la
      confirmación avisa de que dejan de verse; el catálogo ya no los
      muestra; la prestadora los ve como «no visibles»; al reactivarla
      vuelven.
- [ ] El perfil del prestador: nombre, tipo, lo que Z comprobó, categorías,
      modalidades, zonas y servicios. Nunca documentos, números ni contacto.
- [ ] Un prestador con todo suspendido: «No encontramos a ese prestador».

### Guardados

- [ ] Guardar desde la tarjeta y desde la ficha; el marcador cambia. Doble
      toque: una sola vez.
- [ ] Cabecera › Guardados: la lista, lo más reciente primero, «Solo tú ves
      esta lista».
- [ ] Suspender un servicio guardado: en la lista sale «Ya no está
      disponible», sin imagen ni enlace, y se puede quitar.
- [ ] Mientras sigue suspendido, publicar una versión con otro título: la
      lista sigue enseñando el título que tenía al guardarse.
- [ ] Guardar no avisa al prestador (ningún aviso nuevo en su bandeja).

### Accesibilidad e idiomas

- [ ] Con TalkBack y VoiceOver: cada tarjeta se anuncia con título,
      prestador y precio; el marcador dice «Guardar» o «Quitar de
      guardados»; las opciones de filtro se anuncian como opciones; el
      icono de la cabecera se anuncia como «Guardados» y los chips que
      navegan (categorías, «Ver todas»), como botones.
- [ ] En inglés y portugués no queda ningún texto en español ni códigos.
- [ ] En web y móvil, la hoja de filtros se desplaza y se cierra.

## Z Servicios · Incremento 4 — disponibilidad y agenda (30/09/2026)

**Nada de esta sección está comprobado en un teléfono.** La 0092 **ya está
aplicada en Supabase** y se verificó el 30/09/2026 en solo lectura, sin
divergencias y con la puerta de esquema diciendo «sí» con el rol real de la
API (`Z_SERVICIOS_ARQUITECTURA.md` §61). Las pruebas automáticas cubren el
cálculo, la API contra PostgreSQL (con carreras reales), el recorrido
integral con la API real reiniciada (103 de 103) y el código de las
pantallas. **Falta el teléfono**: es lo único pendiente del Incremento 4.

Antes de empezar:

- Si la base del QA no es Supabase, **aplicar la 0092** en ella y
  verificarla (§56–§57). En cualquier caso, la API del QA tiene que correr el
  código de `Edson` y haberse **reiniciado después** de que la 0092 existiera
  en su base: la puerta recuerda el «no». Lo mismo vale para producción el
  día que se despliegue `Edson`.
- La API de ese entorno corre el código de `Edson` y tiene
  `FEATURE_SERVICES=true` **solo allí**.
- Un prestador aprobado con un servicio publicado (virtual, 60 min) y otro en
  borrador; un segundo prestador; una persona sin prestador; y el teléfono en
  otra zona horaria para una de las pruebas.

### Con la bandera apagada o sin la 0092

- [ ] Con la bandera apagada, nada cambia: ni la entrada a la agenda ni la
      sección de disponibilidad en la ficha. Cursos, Eventos y Productos,
      igual que antes.
- [ ] Con la bandera encendida y SIN la 0092: el servicio propio no enseña
      «Disponibilidad y agenda» y la ficha no enseña la sección; nada se rompe.

### El prestador

- [ ] Mis servicios › un servicio › «Disponibilidad y agenda»: «Tu agenda
      todavía no está configurada» y «Configurar agenda».
- [ ] Ajustes: la zona NO viene elegida sola; elegir «America/Lima»,
      descanso 15; guardar. El resumen enseña zona, duración, separación,
      modalidad y estado.
- [ ] Horario semanal: añadir lunes 09:00–12:00. Añadir otra de 11:00 a
      13:00 el lunes: «Se cruza con otra franja de ese día». 12:00–14:00 sí.
- [ ] Una hora como 09:07, o un fin antes del inicio, se avisa antes de
      enviar. Un servicio individual no pide capacidad.
- [ ] Desactivar una franja y volver a activarla; quitar una (pide
      confirmación).
- [ ] Excepciones: cerrar un día entero; en otra fecha, sustituir el horario
      por 15:00–18:00; en otra, añadir una franja. Otra excepción en el día
      cerrado se rechaza. La explicación de la precedencia se entiende.
- [ ] Bloqueos: bloquear 10:30–10:35 con un motivo; la lista lo enseña con
      «Motivo privado». Quitarlo pide confirmación.
- [ ] Vista previa: lo que vería una persona, y arriba por qué el público aún
      no lo ve (en el borrador: «El servicio todavía no es público»).
- [ ] Cambiar la zona con franjas: pide confirmación y lo explica; los
      bloqueos conservan su hora exacta (cambia la hora local que se lee).
- [ ] Doble toque en «Guardar» o en «Añadir»: una sola vez.
- [ ] Un prestador suspendido abre la agenda pero no la cambia; un servicio
      retirado ya no ofrece la entrada.

### Quien busca un servicio

- [ ] La ficha enseña «Disponibilidad» con el próximo horario y la zona;
      «Ver horarios» abre el selector. Sin agenda: «Este servicio todavía no
      tiene horarios publicados». En pausa: «no está ofreciendo horarios».
- [ ] El selector: los días sin horarios, apagados; elegir un día enseña sus
      horarios (09:00 y 10:15 con 60 min y 15 de descanso). «Fechas
      siguientes» avanza sin pasar del horizonte.
- [ ] Un horario bloqueado o en un día cerrado no aparece; un horario a menos
      de dos horas, tampoco.
- [ ] Elegir un horario lo marca y enseña «Horario elegido … Todavía no se
      puede contratar desde Z: este horario no queda apartado». No hay botón
      de reservar ni de pagar. «Atrás» vuelve a la ficha.
- [ ] Con el teléfono en otra zona: las horas son las de la agenda y se avisa
      de la del teléfono.
- [ ] Suspender el servicio con la pantalla abierta: al recargar, «Este
      servicio no está disponible ahora».
- [ ] Alguien bloqueado con el prestador no ve la ficha ni los horarios.
- [ ] El motivo de un bloqueo no aparece en ninguna parte fuera de la agenda
      del prestador.

### Accesibilidad e idiomas

- [ ] Con TalkBack y VoiceOver: cada fecha se anuncia con su día y cuántos
      horarios tiene (o «sin horarios», apagada); cada horario, «De 09:00 a
      10:00», y el elegido como seleccionado; las opciones de día, tipo,
      zona y modalidad se anuncian como opciones.
- [ ] Todas las áreas táctiles se tocan con el pulgar (fechas y horarios de
      al menos 44 puntos).
- [ ] En inglés y portugués no queda ningún texto en español ni códigos.

## Z Servicios · Incremento 5 — reserva y contratación (30/09/2026)

**Nada de esta sección está comprobado en un teléfono: el QA físico sigue
pendiente.** La 0093 **sí está aplicada** en Supabase y verificada en solo
lectura el 01/10/2026, sin divergencias; el incremento está técnicamente
cerrado (`Z_SERVICIOS_ARQUITECTURA.md` §80). El código sigue sin desplegar y
las banderas, apagadas. Las pruebas automáticas cubren la migración, el
dominio, las carreras contra PostgreSQL, la API, el recorrido integral con la
API real reiniciada (100 de 100 comprobaciones en el cierre) y el código de
las pantallas (§76 y §80).

Antes de empezar:

- La **0093** ya está en Supabase (§80). Si el QA usa **otra** base,
  aplicarla y verificarla allí (`Z_SERVICIOS_ARQUITECTURA.md` §74–§75) y
  **reiniciar la API** después: la puerta recuerda el «no».
- La API de ese entorno corre el código de `Edson` con `FEATURE_SERVICES=true`
  y `FEATURE_SERVICE_BOOKING=true` **solo allí**. `FEATURE_SERVICE_PAYMENTS`
  apagada y `SERVICE_PAYMENTS_PROVIDER=none`, como en todas partes.
- En administración, **publicar unas condiciones de contratación de prueba**
  para el país del prestador de ese entorno (no las de producción: el texto
  real es de la empresa, F9).
- Un prestador aprobado con: un servicio **gratuito** en línea (60 min, 15 de
  descanso, agenda de 09:00 a 12:00), uno con **precio fijo**, uno **a
  consultar** y uno **de grupo** (2 plazas). Dos personas sin prestador, con
  dos teléfonos.

### Con una bandera apagada o sin la 0093

- [ ] Con `FEATURE_SERVICE_BOOKING` apagada: los horarios se ven como en el
      Incremento 4, con «Todavía no se puede contratar desde Z» y sin
      «Continuar». «Mis reservas» dice que las reservas aún no están
      disponibles. Nada se rompe.
- [ ] Con la bandera encendida y SIN la 0093: igual; en administración,
      «Nuevo borrador» de las condiciones de contratación dice que no se
      pudo, sin cerrarse la app.

### Contratar lo gratuito

- [ ] Ficha › «Ver horarios» › elegir las 09:00: «Elegido, todavía no
      apartado» y «Apartar este horario y continuar».
- [ ] Continuar: «Tus datos» con la cuenta atrás desde 10:00 («Apartado para
      ti…»). En línea no pide dirección.
- [ ] En el otro teléfono, ese día ya no ofrece las 09:00.
- [ ] Escribir una nota › «Revisar el resumen»: servicio, día y hora con su
      zona, modalidad, duración, «Gratis», versión y huella de las
      condiciones. «Leer las condiciones completas» y volver: las casillas
      siguen como estaban.
- [ ] «Confirmar» sin marcar las casillas: apagado. Marcarlas y confirmar:
      «Tu reserva está confirmada», el código y «No se cobró nada».
- [ ] Con la casilla marcada, publicar desde administración otra versión de
      las condiciones y volver al resumen (o salir de la app y volver): la
      casilla aparece **sin marcar**, con la versión nueva; «Confirmar»,
      apagado hasta volver a marcarla.
- [ ] Doble toque en «Confirmar» o en «Apartar»: una sola reserva y una sola
      retención.
- [ ] Mis reservas › «Por venir»: la reserva; su detalle, con lo aceptado y
      el historial («Horario apartado», «Se confirmó la reserva»).
- [ ] La bandeja de avisos: «Tu reserva está confirmada» lleva a la reserva.
      El prestador recibe «Tienes una reserva nueva», que lleva a la de su
      bandeja. Ningún aviso dice la nota.

### Lo que se detiene, vence o cambia

- [ ] Precio fijo: se aparta, el resumen dice «Todavía no se puede pagar en
      Z» y no hay «Confirmar»; «Soltar este horario» lo libera. Nada se cobra
      ni se pide una tarjeta.
- [ ] «A consultar»: los horarios no ofrecen «Continuar».
- [ ] Dejar vencer los 10 minutos en «Tus datos»: «El tiempo para confirmar
      terminó» y «Elegir otro horario». El otro teléfono vuelve a ver la hora.
- [ ] Con el teléfono con la hora mal puesta (adelantada 1 hora), la cuenta
      atrás sigue diciendo 10 minutos.
- [ ] Los dos teléfonos tocan «Apartar» a la vez en el mismo horario: uno lo
      consigue; al otro le dice «Otra persona tomó ese horario» y vuelve a
      elegir.
- [ ] El grupo de 2 plazas: dos personas lo consiguen; la tercera, no.
- [ ] Mientras alguien lee el resumen, publicar en administración otra
      versión de las condiciones: al confirmar, «Algo cambió…» y el resumen
      enseña la versión nueva.
- [ ] Sin condiciones publicadas para el país: el resumen dice «Todavía no
      hay condiciones de contratación» y no se confirma.
- [ ] Con la app cerrada a mitad (en «Tus datos»), al volver lo escrito no
      está (a propósito) y la retención sigue o venció, según el tiempo.

### El prestador y administración

- [ ] Área del prestador › «Reservas de mis servicios»: la reserva, con el
      nombre público de quien contrata y su nota; nunca su correo ni su
      teléfono. Otro prestador no la ve (no aparece; con el enlace, «No
      encontramos esa reserva»).
- [ ] Con el prestador **suspendido** desde administración: su área sigue
      enseñando «Reservas de mis servicios» y sus reservas por venir.
- [ ] Administración › Servicios › «Reservas y retenciones»: reservas y
      retenciones por estado, sin nombres, notas ni direcciones. «Liberar las
      vencidas» pide confirmación y dice cuántas marcó; repetirlo, 0.
- [ ] Administración › «Condiciones de contratación»: crear, editar,
      previsualizar y publicar sin campos de documentos ni credenciales.
- [ ] Una persona con una reserva por venir intenta borrar su cuenta: no se
      puede todavía, y se le dice.

### Accesibilidad e idiomas

- [ ] Con TalkBack y VoiceOver: la cuenta atrás no se anuncia cada segundo,
      sí al vencer; las casillas de las condiciones se anuncian como casillas;
      las pestañas «Por venir» y «Pasadas», como opciones.
- [ ] En inglés y portugués no queda ningún texto en español ni códigos
      (`service_…`, `hold_…`), ni un «0» o «Gratis» donde el precio es a
      consultar.

## Z Servicios · Incremento 6 — atención, posventa y cierre (01/10/2026)

**Nada de esta sección está comprobado en un teléfono: el QA físico sigue
pendiente.** La 0094 **sí está aplicada** en Supabase y verificada en solo
lectura el 01/10/2026, sin divergencias; el incremento está técnicamente
cerrado (`Z_SERVICIOS_ARQUITECTURA.md` §102). El código sigue sin desplegar y
las banderas, apagadas. Las pruebas automáticas cubren la migración, el
dominio, las carreras contra PostgreSQL, la API, el recorrido integral con la
API real reiniciada (116 de 116 comprobaciones en el cierre) y el código de
las pantallas (§98 y §102).

Antes de empezar:

- La **0094** ya está en Supabase (§102). Si el QA usa **otra** base,
  aplicarla y verificarla allí (`Z_SERVICIOS_ARQUITECTURA.md` §96–§97),
  **antes** de arrancar el código nuevo, y **reiniciar la API** después: la
  puerta recuerda el «no».
- La API de ese entorno corre el código de `Edson` con `FEATURE_SERVICES=true`
  y `FEATURE_SERVICE_BOOKING=true` **solo allí**. `FEATURE_SERVICE_PAYMENTS`
  apagada y `SERVICE_PAYMENTS_PROVIDER=none`, como en todas partes.
- Lo del Incremento 5: condiciones de contratación **de prueba** publicadas y
  un prestador aprobado con un servicio **gratuito** en línea (60 min) y su
  agenda.
- **Dos personas en administración** (para la apelación), una de moderación,
  el prestador y dos personas sin prestador, con al menos dos teléfonos.
- Para no esperar: reservar un horario **cercano** (la llegada se abre 15
  minutos antes) o bajar las ventanas en ese entorno
  (`SERVICES_ATTENTION_CHECKIN_MINUTES`, `SERVICES_ATTENTION_TOLERANCE_MINUTES`,
  `SERVICES_ATTENTION_CONFIRMATION_HOURS`). Nadie llama a los barridos: se
  lanzan a mano desde administración.

### Con una bandera apagada o sin la 0094

- [ ] Sin la 0094 (y con las banderas encendidas): se contrata como en el
      Incremento 5; la reserva se ve **sin** el panel de la atención y sin
      botones de cancelar, cambiar el horario ni reportar. La ficha no enseña
      la sección de reseñas. Nada se cierra ni da error.
- [ ] Aplicada la 0094 **sin reiniciar** la API: sigue igual. Reiniciada:
      aparece el panel.
- [ ] Con `FEATURE_SERVICE_BOOKING` apagada: «Mis reservas» dice que aún no
      están disponibles; la ficha sigue, sin reseñas.

### Cancelar y cambiar el horario

- [ ] Reserva a varios días: el panel ofrece «Cancelar la reserva» y cambiar
      el horario, con hasta cuándo se puede cada cosa y «no tiene costo».
- [ ] Cambiar el horario: lleva a los horarios del servicio, se elige otro, se
      confirma el cambio. La reserva conserva su **código**, sus condiciones y
      su precio; el horario anterior vuelve a ofrecerse en el otro teléfono.
      Un segundo cambio ya no se ofrece.
- [ ] El prestador recibe el aviso del cambio y, al tocarlo en la bandeja,
      llega a la reserva.
- [ ] Cancelar como quien contrata: pide confirmación, deja elegir un motivo;
      la reserva queda «Cancelada», sin acciones, y el horario vuelve.
- [ ] Cancelar como prestador: no deja enviar sin explicar por qué. Quien
      contrata recibe el aviso.
- [ ] De una reserva **cancelada**, el prestador ya no ve la nota de quien
      contrató; quien la escribió, sí.
- [ ] Pasada la hora de inicio, cancelar ya no se ofrece.
- [ ] Doble toque en «Cancelar» o en «Confirmar el cambio»: una sola vez.

### La atención

- [ ] Quince minutos antes: quien contrata ve «Mostrar mi código de
      asistencia»; el código tiene seis cifras y es el mismo al volver a
      pedirlo. En el teléfono del prestador **no aparece**.
- [ ] El prestador escribe un código equivocado: se le dice, con los intentos
      que quedan; al quinto, ya no vale ni el bueno.
- [ ] «Empezar con el código» con el correcto: «En curso». «Empezar sin el
      código» pide confirmación y lo explica.
- [ ] El prestador termina: quien contrata recibe el aviso de que falta su
      confirmación. Confirma: «Cerrada», y aparece la reseña.
- [ ] Una atención empezada **sin** código y que nadie confirma: tras lanzar
      «Recordar y cerrar lo pendiente», sigue sin cerrarse y el resultado la
      cuenta como «sin verificar».
- [ ] Una empezada **con** código y pasado el plazo: el barrido la cierra una
      vez; lanzarlo otra vez no hace nada.
- [ ] Un prestador **suspendido** no ve «Empezar».
- [ ] Pasada la tolerancia sin que nadie empiece: las dos partes ven «no se
      presentó»; declararlo pide confirmación y la otra parte recibe el aviso.

### El caso

- [ ] Con la atención empezada: «Reportar un problema con esta atención». Los
      motivos son los de esa parte; una descripción corta no se envía.
- [ ] Abierto: la otra parte recibe el aviso y ya no puede abrir otro; puede
      escribir en ese. Quien contrata ya no puede confirmar.
- [ ] «Añadir una evidencia»: una foto y un PDF entran; un archivo que no es
      ni lo uno ni lo otro, no. Abrirla la muestra; el enlace deja de servir a
      los dos minutos.
- [ ] Una persona ajena con el enlace de la reserva: «No encontramos esa
      reserva».
- [ ] Administración › Servicios › «Casos»: el caso aparece, sin la
      descripción en la lista. Dentro: el expediente entero. Una **nota
      interna** no la ve ninguna de las partes.
- [ ] Resolver: se elige qué se decide, el efecto en la atención y el efecto
      económico solicitado; el texto deja claro que **no se mueve dinero**. Las
      dos partes reciben el aviso y ven el estado «no aplica».
- [ ] Apelar: una parte lo hace una vez. La persona que resolvió ve que la
      apelación la resuelve otra; la otra persona la resuelve, y solo se le
      ofrecen los efectos que el servidor acepta. Cerrado, ya no se apela.
- [ ] Con **una sola** persona en administración, «Apelar la resolución» no
      se ofrece.
- [ ] Una persona de administración que es parte de la reserva no puede abrir
      el expediente desde administración.
- [ ] «Retirar el caso»: avisa de que ya no podrá abrir otro y de que la otra
      parte conserva el suyo. Retirado, la otra parte sí puede reportar.
- [ ] Pasado el plazo para reportar, solo se ofrece el motivo de seguridad.

### La reseña

- [ ] Con la atención cerrada: «Reseña» pide nota, si lo recomienda y un
      comentario; los ejes son opcionales. Enviada, dice que está en revisión.
- [ ] Antes de publicarse no aparece en la ficha y el prestador no la ve.
- [ ] Administración › Servicios › «Reseñas»: publicarla. Aparece en la ficha
      con su promedio, **sin el nombre** de quien la escribió. Sin reseñas, la
      ficha dice «todavía no hay reseñas», nunca «0».
- [ ] El prestador responde una vez; la respuesta se ve en la ficha.
- [ ] Esconderla pide un motivo de la lista; deja de verse.
- [ ] Una reserva cancelada o con una inasistencia no ofrece la reseña.

### Avisos, cuenta y registros

- [ ] Cada aviso, en la bandeja, lleva a su reserva o a su caso. El **push
      abre la aplicación**, no la reserva (pendiente conocido).
- [ ] Ningún aviso enseña una nota, un motivo, una dirección ni un código.
- [ ] Quien contrata borra su cuenta con un caso ya pasado: su reseña y el
      caso quedan sin su nombre; su evidencia ya no se puede abrir y la app lo
      dice sin cerrarse.
- [ ] En el panel de Supabase, el depósito `service-incident-evidence` es
      **privado** y sus archivos no tienen URL pública. (Sin archivos está
      comprobado; **con un archivo real**, no: es lo único del depósito que
      el cierre no pudo probar.)
- [ ] Un servicio **virtual**: no hay sala de Z ni enlace en la reserva. Las
      partes se ponen de acuerdo por fuera y quien contrató **dicta** su
      código al prestador. Anotar si eso basta (decisión G17).

### Accesibilidad e idiomas

- [ ] Con TalkBack y VoiceOver: las opciones de motivo, resultado y efecto se
      anuncian como opciones; el código de asistencia se lee cifra a cifra;
      las estrellas de la reseña dicen su valor.
- [ ] En inglés y portugués no queda ningún texto en español ni códigos
      (`service_…`, `incident_…`), ni un «0,0» donde no hay reseñas, ni
      «devuelto» o «reembolsado» en ningún estado.

### La política congelada (corrección G18; la 0095, ya aplicada)

La 0095 está aplicada en Supabase y verificada (01/10/2026). Hace falta un
entorno de pruebas donde se puedan cambiar las variables de la API y
reiniciarla. Nada de esto se probó en un teléfono.

- [ ] *(Solo en una base de pruebas sin la 0095; en Supabase ya no se puede
      reproducir.)* Con las banderas encendidas, «Mis reservas», la bandeja
      del prestador y los horarios de un servicio dicen que todavía no está
      disponible. La app no se cierra ni enseña un error técnico.
- [ ] Con la API **reiniciada** tras la 0095: se contrata con normalidad, y
      el detalle de la reserva enseña hasta cuándo se puede cambiar el horario
      y cuántos cambios quedan.
- [ ] Cambiar `SERVICES_BOOKING_RESCHEDULE_MIN_HOURS` (por ejemplo, de 24 a 2)
      y reiniciar: la reserva **ya hecha** enseña el mismo límite que antes; una
      **nueva** enseña el nuevo.
- [ ] Lo mismo con `SERVICES_ATTENTION_TOLERANCE_MINUTES`: en la reserva ya
      hecha, «no vino» se ofrece con la tolerancia de cuando se confirmó.
- [ ] Lo mismo con `SERVICES_REVIEW_WINDOW_DAYS`: la reseña de una atención ya
      contratada se ofrece durante el plazo de cuando se confirmó.
- [ ] En ninguna pantalla aparece un texto técnico de la política (una huella,
      `operating_policy`, un nombre de variable).

### Las políticas de la primera versión (02/10/2026): qué comprobar antes de encender

Las políticas están en `Z_REQUISITOS_Y_DECISIONES.md`, al comienzo. Cinco se
cerraron en el código ese día (`Z_SERVICIOS_ARQUITECTURA.md`, Parte VIII) y
están probadas contra el servidor y con las baterías del móvil. **Nada de esto
se probó en un teléfono.** La migración 0096 está aplicada y verificada desde
el 02/10/2026 (`Z_SERVICIOS_ARQUITECTURA.md` §131).

**Antes de nada (la 0096).**

- [x] La 0096 está aplicada en Supabase y verificada (`Z_SERVICIOS_ARQUITECTURA.md`
      §131), el 02/10/2026.
- [ ] El código de `Edson` está desplegado en el entorno de la prueba: son
      procesos nuevos, que miran la base al arrancar. *(En una base sin la 0096, todo el
      catálogo de Servicios dice que todavía no está disponible; la app no se
      cierra ni enseña un error técnico.)*

**Las imágenes (P29).**

- [ ] Subir dos fotos a un borrador, publicar, abrir otro borrador y quitar
      una: las fotos se ven en la ficha, en el borrador y en la bandeja de
      administración, y la publicada no pierde la suya.
- [ ] Con un servicio publicado con fotos, borrar la cuenta del prestador:
      termina bien, y la ficha deja de existir.
- [ ] En ninguna pantalla aparece una ruta de archivo.

**Modalidades y moneda (P5 y P2).**

- [ ] El formulario del servicio ofrece **dos** modalidades (en línea y en el
      local). «A domicilio» no aparece.
- [ ] El filtro del catálogo y el de la bandeja de administración ofrecen
      esas dos.
- [ ] Con precio fijo o «desde», la única moneda que se ofrece es **PEN**, en
      el formulario y en el filtro.
- [ ] Un servicio gratuito y uno «a consultar» se guardan, se envían y se ven
      sin moneda ni importe.

**La capacidad (P51).**

- [ ] En un servicio con capacidad para varias personas, la ficha pública no
      dice cuántas caben, y los horarios tampoco.
- [ ] Su prestador sí la ve al editarlo y en su agenda, y administración en la
      revisión.

**El piloto (P101).** Hace falta un entorno donde se puedan cambiar las
variables de la API y reiniciarla, y tres cuentas: una en la lista del piloto,
otra fuera y una de administración.

- [ ] Con Servicios encendido y la **lista vacía**: ninguna de las tres
      cuentas ve entradas de Servicios en Explorar ni en el perfil. La de
      administración sí ve su sección en el panel de administración.
- [ ] Con una cuenta en la lista: esa cuenta ve las entradas y las usa. La
      otra no las ve y, si abre un enlace a un servicio, lee que no está
      disponible.
- [ ] **Sin sesión**, el catálogo y la ficha de un servicio no se ven.
- [ ] Cerrar sesión con la cuenta del piloto y entrar con la otra, sin cerrar
      la app: las entradas desaparecen. Al revés, aparecen.
- [ ] La cuenta de administración que no está en la lista ve la bandeja de
      Servicios en administración y puede revisar, pero no ve el catálogo como
      cliente.
- [ ] La cuenta del piloto que no es de administración no puede abrir ninguna
      pantalla de administración.
- [ ] Con la apertura general encendida, cualquier cuenta ve Servicios.
- [ ] Apagar `FEATURE_SERVICES`: desaparece para todos, también para el piloto
      y para la sección del panel de administración.

### La salida del piloto gratuito (02/10/2026): qué comprobar en un teléfono

Nada de esto se probó en un teléfono. Hace falta un entorno de pruebas con
Servicios y la contratación encendidos, y cuatro cuentas: quien contrata,
quien presta y dos de administración.

**La baja de una cuenta con historia de Servicios (F21).**

- [ ] Quien **contrató** una reserva (por venir, pasada o cancelada) va a
      Ajustes → Eliminar cuenta y confirma las dos veces: lee que no se puede
      cerrar todavía y que escriba a soporte. **No** lee «inténtalo de nuevo
      en unos momentos». Sigue con su sesión y su cuenta.
- [ ] Lo mismo con quien **prestó** esa reserva.
- [ ] Después del aviso, la reserva, el caso, la reseña y las evidencias
      siguen ahí para las dos partes y para administración.
- [ ] Repetir la baja da el mismo aviso.
- [ ] Una cuenta con solo una postulación, o con un servicio publicado que
      nadie contrató, o que solo guardó un servicio: se elimina con
      normalidad.
- [ ] El aviso se lee bien en español, inglés y portugués, y con lector de
      pantalla.

**Las condiciones de contratación.** Con unas condiciones de **prueba**
publicadas en el entorno de pruebas (no las del piloto, que siguen sin
aprobar).

- [ ] El resumen de la contratación enseña la versión y la huella abreviada;
      «Leer las condiciones completas» abre el texto entero, que se lee sin
      cortes ni símbolos raros (es texto plano: los apartados numerados se
      ven como párrafos).
- [ ] La casilla «Leí y acepto…» aparece **sin marcar**, y «Confirmar» no se
      puede tocar hasta marcarla.
- [ ] Con el resumen abierto, publicar otra versión desde administración:
      al confirmar, la aplicación enseña la versión nueva y la casilla vuelve
      a estar sin marcar.
- [ ] El detalle de una reserva hecha enseña qué versión se aceptó, y no
      cambia al publicar otra.
- [ ] En el panel de administración → Servicios → Condiciones de
      contratación: crear el borrador pegando un texto largo, previsualizarlo
      y comparar la huella abreviada con la que dice el guion **antes** de
      publicar. Publicar pide confirmación.
- [ ] Sin ninguna condición publicada, el resumen dice que todavía no se
      puede contratar.

**El piloto gratuito.**

- [ ] En el formulario de un servicio, elegir «precio fijo» o «desde» y
      enviarlo: la lista de lo que falta dice que Z no admite ese tipo de
      precio por ahora, y no se envía. (**Desde el 03/10/2026 el formulario
      ya no los ofrece**: este punto pasa a «el formulario solo ofrece Gratis
      y A consultar», en la sección del cierre del piloto.)
- [ ] Un servicio gratuito se envía, se publica y se reserva. Uno «a
      consultar» se publica y se ve, y al intentar reservar un horario la
      aplicación explica que no se reserva en Z.
- [ ] En ninguna pantalla del recorrido aparece un botón de pagar, un
      importe cobrado, un saldo o una devolución.

**Las tareas sin planificador.** Con la cuenta de administración.

- [ ] En la bandeja de reservas, «vencer retenciones» responde con cuántas
      venció; repetirlo, con cero.
- [ ] En la bandeja de casos, «ejecutar tareas» dice cuántas recordó y
      cerró. Sin lanzarla, nadie recibe el recordatorio: es lo esperado
      mientras no haya planificador.

**Apelaciones.**

- [ ] Con **una** sola cuenta de administración, tras resolver un caso las
      partes no ven «Apelar». Con dos, sí; y quien resolvió no puede resolver
      la apelación.

## Z Servicios · cierre del piloto y mejora de vistas (03/10/2026)

Lo de abajo está comprobado con pruebas que leen el código, con tipos y con la
exportación web. **Nada se ha probado en un teléfono.** Es lo único que queda
por probar antes de encender el piloto, junto con el planificador contra la
cuenta de AWS.

Hace falta: un Android con navegación de tres botones, un iPhone, y tres
cuentas (una prestadora aprobada, una clienta del piloto, una de
administración).

**Primero, lo que más riesgo tiene.**

- [ ] **Nota de voz en Android.** Grabar una nota de 10 segundos: el reloj
      empieza en 0:00 y sube; no se para sola. (Por el código nativo, antes
      se paraba en el primer instante marcando 5:00.)
- [ ] **Audio de presentación en Android** (Perfil › editar): grabar 10
      segundos; se guarda con 10 segundos, no con 60.
- [ ] **El chat se abre por el final.** Una conversación larga se abre en el
      último mensaje. Con dos mensajes, ver dónde quedan (pueden quedar
      pegados abajo: es el efecto del modo de chat).
- [ ] **El teclado no tapa.** En Android y en iPhone, en el formulario de un
      servicio, en cancelar una reserva, en abrir un caso y en escribir una
      reseña: el último campo se ve mientras se escribe, y no queda un hueco
      entre el campo y el teclado.

**Notas de voz y chat.**

- [ ] En una instalación limpia, tocar el micrófono: sale el permiso; al
      concederlo, empieza a grabar sin tener que tocar otra vez.
- [ ] Negar el permiso: explica por qué hace falta y ofrece abrir Ajustes.
- [ ] Mientras graba: un punto que late, la duración y «cancelar».
- [ ] Al parar: se puede escuchar, borrar y enviar. Enviando, lo dice.
- [ ] Con una nota grabada, tocar «atrás» en la cabecera y el Atrás de
      Android: pregunta antes de salir. Cancelar se queda; salir la descarta.
- [ ] Grabando, tocar el nombre de la cabecera (abre el perfil) y volver: el
      micrófono se cerró y la nota está en la previa.
- [ ] Abrir un chat con mala cobertura: se ve «cargando», no una pantalla en
      blanco. Sin red: error con «reintentar». Sin mensajes: lo dice.
- [ ] Dos envíos fallidos (modo avión): reintentar el primero manda el
      primero.
- [ ] Un vídeo y un PDF adjuntos se abren fuera de la aplicación.

**Servicios.**

- [ ] El formulario de un servicio ofrece solo «Gratis» y «A consultar». No
      hay campo de importe ni de moneda.
- [ ] El buscador de servicios no ofrece «con precio», moneda ni rango.
- [ ] En el detalle de una reserva (quien contrata y quien presta), tirar
      hacia abajo la actualiza.
- [ ] Elegir horario sin red y tocar «Reintentar» al volver la red: carga el
      calendario y los horarios del día.
- [ ] Administración › Condiciones: con un borrador ya creado, escribir otro
      y guardar: avisa, lo escrito sigue ahí, y guardar otra vez lo reemplaza.

**Botones y avisos, en cualquier pantalla.**

- [ ] Tocar dos veces rápido un botón que guarda o envía: la acción ocurre
      una vez, y el botón enseña la espera sin cambiar de tamaño.
- [ ] Un aviso breve (toast) sale por debajo de la cámara o la isla, no
      tapado por ella.
- [ ] Con «reducir movimiento» activado: los esqueletos de carga no laten y
      el punto de grabación queda fijo.

**Cursos, Eventos y Productos.**

- [ ] Pagar una entrada o un producto en el navegador y volver a la
      aplicación: el pedido se actualiza solo. Volver sin cobertura: el
      pedido sigue a la vista y sale un aviso breve, no una pantalla de error.
- [ ] El checkout de productos no nace en rojo; tocar «Reservar y continuar»
      con algo sin rellenar marca lo que falta y no envía nada.
- [ ] Sin escribir el país, las condiciones piden el país; con uno sin
      condiciones, dice que no hay; sin red, error con reintento.
- [ ] La galería de un producto para en cada foto.
- [ ] En Eventos, la tarjeta destacada abre la ficha, y hay una fila a «Mis
      entradas».
- [ ] Al volver a una ficha de curso, de evento o de producto, lo que se
      estaba viendo no desaparece mientras se recarga.

**Cuenta.**

- [ ] Registrarse con confirmación de correo: lleva al acceso.
- [ ] Con el teléfono en inglés, una contraseña equivocada se marca en el
      campo, no en un diálogo.
- [ ] Eliminar la cuenta: tras confirmar dos veces, la fila enseña que está
      en curso y no se puede volver a pulsar.

**Los procesos automáticos**, una vez encendido el planificador
(`Z_SERVICIOS_DESPLIEGUE_Y_ACTIVACION.md`, paso 8).

- [ ] Apartar un horario y no confirmarlo: pasados sus minutos, en menos de
      cinco más aparece como vencido en la bandeja de administración, sin que
      nadie lo lance.
- [ ] Una reserva para mañana: llega el recordatorio.
- [ ] Una atención terminada con código y sin confirmar: a las 24 horas se
      cierra sola.
- [ ] La alarma de los procesos está en `OK`.

Sustituye a «Las tareas sin planificador» de la sección anterior: con el
planificador encendido ya no hace falta lanzarlas a mano (se puede seguir
haciendo). Y a la nota sobre el formulario de precios: ya no ofrece los
cuatro.

---

## Mejora integral de vistas, audio y notificaciones (03/10/2026, noche)

Nada de esto se ha visto en un teléfono. Las pruebas automáticas ejecutan las
reglas —la cola de avisos, las pulsaciones rápidas, el mapa de destinos del
push, el nivel del micrófono— y la exportación web arranca, pero cómo se
SIENTE una animación, si vibra lo justo y si un aviso suena solo se comprueba
con el aparato en la mano. Android e iOS, tema claro y oscuro.

**Antes de empezar.** El push con la aplicación cerrada necesita una
compilación nueva con las credenciales de Firebase (Android) y de Apple (iOS).
Sin ellas, lo de «Push» de abajo no se puede probar; lo demás sí.

**Lo que se pulsa.**

- [ ] Botones, chips, filas y tarjetas se hunden un poco bajo el dedo y
      vuelven. No rebotan como un juguete ni se quedan encogidos.
- [ ] El control de dos opciones (Para ti / Siguiendo, Mis cursos / Mis audios)
      desliza su pastilla; las pestañas deslizan su raya.
- [ ] Con «Reducir movimiento» activado en los ajustes del teléfono: nada se
      desliza ni salta, pero todo sigue cambiando de estado y se entiende.
- [ ] En un Android de gama media, desplazar el muro y el feed de Inicio no va
      a tirones.

**Inicio y Explorar.**

- [ ] El corazón se rellena y salta al reaccionar; el número entra desde abajo
      al subir y desde arriba al bajar.
- [ ] GUARDAR, muchas veces seguidas y rápido: el marcador cambia en cada
      toque, no hay pausa, y al parar queda como en el último toque. Al volver
      a entrar en la aplicación sigue igual.
- [ ] Sale UN aviso por ráfaga, no uno por toque. «Publicación guardada» ofrece
      «Ver lista»; «eliminada de guardados» ofrece «Deshacer», y deshace.
- [ ] Sin conexión, guardar: el marcador vuelve a su sitio y sale un aviso de
      error (no un diálogo).
- [ ] Republicar varias veces seguidas: el botón no se queda apagado.
- [ ] El aviso de arriba se puede quitar arrastrándolo hacia arriba, no tapa la
      muesca y se lee en los dos temas.
- [ ] El `+` de Inicio se ve sobre un vídeo claro y sobre uno oscuro.
- [ ] El menú de una publicación y la hoja de comentarios suben con el fondo
      fundiéndose, no como una persiana.

**Comentarios.**

- [ ] Las respuestas cuelgan de su comentario con una raya a la izquierda.
- [ ] El botón redondo de enviar crece al escribir y enseña la espera dentro.
- [ ] Sin conexión, enviar un comentario: el texto sigue en el campo.

**Búsqueda (Explorar y Mensajes).**

- [ ] Al tocar el campo se marca el borde y aparece «Cancelar»; al pulsarlo se
      borra lo escrito y se cierra el teclado.
- [ ] La X aparece al escribir y vacía el campo.
- [ ] Mientras busca, la lupa es un indicador.
- [ ] Escribir rápido «mar» → «martinez»: no se quedan resultados de «mar».

**Crear.**

- [ ] Sin permiso de cámara: se entiende qué pasa, «Abrir ajustes» abre los
      ajustes y «Elegir del carrete» funciona.
- [ ] Publicación solo de texto, con el campo vacío: «Publicar» está apagado y
      debajo dice por qué.
- [ ] Subiendo un vídeo, la barra avanza sin saltos.

**Mensajes y conversación.**

- [ ] El globo de no leídos aparece en la fila y en la barra inferior, y salta
      al llegar otro mensaje.
- [ ] En la conversación, lo recién enviado sube a su sitio; el historial no se
      anima al desplazar.
- [ ] La hora se lee sobre la burbuja negra. Mis mensajes llevan reloj mientras
      salen, una marca al enviarse y aviso si fallan. Nunca dos marcas.
- [ ] El `+` abre la hoja de Fotos y vídeos / Cámara / Archivo y se cierra al
      elegir.

**Nota de voz.** Es lo más importante de comprobar en Android.

- [ ] Al empezar vibra, la barra cambia entera (borde, «Grabando», reloj) y el
      botón de detener late.
- [ ] LA ONDA RESPONDE A LA VOZ: hablando se mueve, en silencio se queda plana,
      con el micrófono tapado también. Si en algún teléfono salen tres puntos
      en vez de barras, es que ese aparato no mide: anotarlo.
- [ ] El reloj cuenta bien (no arranca en una cifra absurda ni se para solo).
- [ ] Detener vibra; se puede escuchar, eliminar y enviar.
- [ ] Salir del chat o pasar la aplicación a segundo plano mientras graba: la
      grabación se corta, no sigue por detrás.
- [ ] Una llamada entrante mientras graba.
- [ ] Con TalkBack / VoiceOver: se anuncia «Grabando» al empezar.

**Perfil.**

- [ ] «Publicaciones» es el primer círculo y está encendido al entrar.
- [ ] Tocar Podcast, Cursos o Reseñas y volver a Publicaciones con UN toque.
- [ ] Tocar dos veces el mismo círculo no cambia nada.
- [ ] Los cinco círculos caben en un teléfono estrecho sin cortarse.
- [ ] «Lo que puedo aportar» se abre y se cierra con la altura creciendo y la
      flecha girando; lo de debajo no da un salto.

**Eventos y formularios.**

- [ ] La zona horaria se lee como una ciudad («Buenos Aires») y, tras guardar y
      volver a entrar, sigue elegida la misma.
- [ ] «Eventos por revisar» con una cuenta que no es de curaduría: no hay
      botones debajo del aviso.
- [ ] «Mis eventos»: las cuatro bandejas son filas con flecha.

**Notificaciones con la aplicación ABIERTA.** No necesitan la compilación
nueva.

- [ ] Con dos cuentas en dos teléfonos: A escribe a B. A B le sale el aviso
      flotante con el nombre de A en un par de segundos, y sube el globo de
      Mensajes.
- [ ] Si B tiene abierta ESA conversación: no sale aviso; el mensaje aparece en
      la conversación.
- [ ] Tres mensajes seguidos de A: un aviso que se renueva, no tres apilados.
- [ ] A reacciona a una publicación de B, o le pide una sesión: en menos de un
      minuto a B le sale el aviso y se enciende la campana.
- [ ] Tocar el aviso lleva a la conversación, a la publicación o a la agenda.
- [ ] En la bandeja, lo nuevo sale resaltado (círculo relleno, negrita, punto).
      Al volver a entrar ya no.
- [ ] Con más de cincuenta avisos, bajar carga los siguientes.

**Push con la aplicación cerrada.** Con la compilación nueva.

- [ ] Llega con SONIDO y con el icono de Z. En Android, en los ajustes de
      notificaciones de la aplicación hay tres canales (Mensajes,
      Interacciones, Contenido) y ninguno duplicado.
- [ ] El texto dice quién escribe y NO lo que escribió.
- [ ] Tocarlo con la aplicación cerrada del todo abre la conversación, la
      publicación o la agenda correspondiente.
- [ ] Un aviso de Servicios, Eventos o Productos abre la bandeja.
- [ ] B bloquea a A; A escribe en la conversación que ya tenían: a B no le
      suena nada.
- [ ] Cerrar sesión en un teléfono: deja de recibir los avisos de esa cuenta.
- [ ] El icono de la aplicación lleva el número de lo no leído y se limpia al
      abrir la bandeja.

**Entrar y crear la cuenta (04/10/2026).** Rehechas tras verlas en el
navegador; en web se comprobaron los dos temas, el foco, los errores y el
requisito de la contraseña. En teléfono falta:

- [ ] La marca llega una vez (crece y suelta una onda) y no se queda animada.
- [ ] «Siguiente» en el teclado pasa de un campo al otro sin cerrarlo; «Ir» en
      la contraseña entra o crea la cuenta.
- [ ] El gestor de contraseñas del teléfono ofrece rellenar el acceso y
      generar una contraseña en el alta.
- [ ] El ojo muestra y oculta la contraseña sin cambiar la letra ni mover el
      cursor (Android).
- [ ] Enviar con un campo mal: ese campo se mueve un instante a los lados y
      queda el motivo debajo. Con «reducir movimiento» no se mueve.
- [ ] Al enfocar un campo se ve su halo (Android 9 o superior; en versiones
      anteriores solo cambia el borde).
- [ ] Al entrar o crear la cuenta con éxito se nota una vibración corta.
- [ ] En el alta, «Mínimo 6 caracteres» pasa de círculo vacío a círculo
      marcado al llegar a seis.
- [ ] «Términos» y «Política de Privacidad» abren su pantalla; al volver, lo
      escrito sigue ahí.
- [ ] Con el teclado abierto en un teléfono pequeño se llega al botón
      desplazando; nada queda tapado.

**Mensajes, búsqueda y avisos (04/10/2026, tarde).** El buscador se comprobó
en el navegador; la bandeja con conversaciones reales NO (necesita sesión).

- [ ] La bandeja: título «Mensajes» grande a la izquierda, buscador arriba,
      historias debajo, filas sin rayas con la foto grande y la hora pegada al
      último mensaje («Que fue bro · 12:47»).
- [ ] Lo no leído sale en negrita y con el globo; un nombre largo se recorta y
      no empuja el globo fuera.
- [ ] Buscar en Mensajes: la lista se estrecha con cada letra, sin vaciarse ni
      pintar un indicador en medio. Al llegar la respuesta puede aparecer una
      conversación que casa por el texto de un mensaje.
- [ ] Buscar algo que no existe: «Nada por aquí» solo cuando el servidor lo
      confirma.
- [ ] El buscador de Explorar y el de Mensajes: caja rellena, sin marco ni
      recuadro interior al enfocar; «Cancelar» a la derecha.
- [ ] Explorar: buscar, borrar una letra y volver a escribirla se pinta al
      instante.
- [ ] Cursos: tocar el marcador guarda sin abrir el curso; guardado se ve
      relleno, también en tema oscuro.
- [ ] A pide una sesión a B con la aplicación de B abierta: a B le sale el
      aviso con el nombre de A en menos de medio minuto.
- [ ] A bloquea a B. B la sigue, reacciona y comenta: a A no le llega nada.
- [ ] Negar el permiso de notificaciones al entrar, concederlo luego en los
      ajustes del sistema y volver a la aplicación sin cerrarla: el push
      empieza a llegar (con la compilación nueva).

## Directos: reacciones, chat, efectos y calidad (04/10/2026)

**Nada de esto se ha probado en un teléfono.** Las pruebas automáticas montan
tres clientes sobre una red en memoria y comprueban la lógica; la pantalla se
vio en el navegador con datos inventados y sin vídeo. No hay prueba automática
que pueda decir si un desenfoque se ve, si lo recibe otro teléfono o si un
aparato de gama media aguanta.

**Hace falta:** una compilación **1.2.0** (trae el módulo de efectos), la
cuenta de 100ms conectada y `FEATURE_LIVE` encendida donde se pruebe. **Tres
aparatos a la vez:** un anfitrión y dos espectadores.

| Aparato | Para qué |
|---|---|
| Android reciente | Anfitrión con efectos, y espectador |
| Android de gama media o antiguo | Lo mismo: es donde se verá si el efecto es usable |
| iPhone con iOS 16 o posterior | Anfitrión con efectos, y espectador |
| iPhone con iOS 15, si hay | Que NO se ofrezcan los efectos, y lo diga |

**Los efectos no se dan por cerrados hasta ver, en un SEGUNDO teléfono, la
imagen del anfitrión con el efecto puesto.**

### Reacciones

- [ ] Espectador A pulsa un corazón: lo ve A, lo ve el espectador B y lo ve el
      anfitrión. **Era el defecto: antes solo lo veía A.**
- [ ] A ve su corazón UNA vez, no dos.
- [ ] El anfitrión reacciona: lo ven A y B.
- [ ] A y B pulsan a la vez, muchas veces y seguido, durante medio minuto: la
      imagen del anfitrión no va a saltos en ninguno de los tres, las burbujas
      suben por carriles sin taparse y no se amontonan.
- [ ] El número junto a cada reacción sube en los tres y acaba igual en los
      tres al cabo de unos segundos.
- [ ] Salir de la emisión y volver a entrar enseguida: se siguen viendo las
      reacciones de los demás, una vez cada una.
- [ ] Abrir la emisión, salir, volver a entrar: el número es el del servidor
      (no arranca en cero ni duplicado).
- [ ] Dos emisiones a la vez con gente distinta: las reacciones de una no
      aparecen en la otra.
- [ ] Con «Reducir movimiento»: las burbujas aparecen y se apagan sin subir.

### Chat

- [ ] El último mensaje se ve entero al entrar; el chat no tapa la cara de
      quien emite.
- [ ] A escribe: lo ven B y el anfitrión, con el nombre de A, sin duplicarse.
- [ ] Alguien que escribe por primera vez: su mensaje aparece con su nombre
      (nunca con un hueco), un instante después.
- [ ] Estando al final, los mensajes nuevos empujan la lista hacia arriba y se
      sigue viendo el último.
- [ ] Subir a leer mientras los demás escriben: la lista NO baja sola; aparece
      «N mensajes nuevos»; al tocarlo, baja y desaparece.
- [ ] El anfitrión mantiene pulsado un mensaje y lo oculta: desaparece en SU
      pantalla al momento **y no vuelve a aparecer** un segundo después.
- [ ] Ese mismo mensaje desaparece en los dos espectadores en un par de
      segundos. **Es lo que hay que mirar con más cuidado:** al público el
      cambio no le llega por la base, sino por un aviso aparte.
- [ ] El anfitrión oculta el ÚLTIMO mensaje de un chat en el que nadie más
      escribe: también desaparece en los espectadores.
- [ ] A quien escribió el mensaje ocultado también le desaparece.
- [ ] Un espectador que ha bloqueado a otra persona no ve sus mensajes en el
      chat del directo.
- [ ] Un espectador mantiene pulsado un mensaje: no pasa nada.
- [ ] Muchos mensajes seguidos de varias personas: el desplazamiento sigue
      fluido y el vídeo no se resiente.
- [ ] Abrir el teclado: el campo queda a la vista, el chat encoge y la
      cabecera sigue arriba. También en un teléfono pequeño.
- [ ] Modo avión unos segundos y fuera: se ve «Reconectando el chat…», vuelve
      solo y aparecen los mensajes que se escribieron entre medias, sin
      repetirse.
- [ ] Una emisión larga (una hora, para que caduque la sesión por medio): el
      chat y las reacciones siguen llegando al final. Si se quedan en
      «Reconectando…», anotar cuánto tardan en volver.
- [ ] Abrir una emisión desde un enlace con el identificador en MAYÚSCULAS: las
      reacciones se ven igual entre ese teléfono y los demás.
- [ ] Lector de pantalla: cada mensaje se lee «Nombre: texto»; el botón de
      mensajes nuevos se anuncia; quien modera oye la pista de «mantén
      pulsado».
- [ ] Letra grande del sistema: los mensajes se parten en líneas, no se cortan.

### Efectos de cámara (anfitrión)

- [ ] El botón de efectos solo le aparece a quien emite.
- [ ] **Desenfoque:** se ve en la propia pantalla **y en los dos espectadores**.
      El borde de la persona es aceptable.
- [ ] **Cada uno de los tres fondos:** igual, en los dos espectadores.
- [ ] Cambiar de desenfoque a fondo y de un fondo a otro: sin cortes largos ni
      imagen negra.
- [ ] **Ninguno:** vuelve la cámara tal cual, en los tres.
- [ ] En Android, al pasar de «Ninguno» a un fondo: cuánto dura el desenfoque
      intermedio (el complemento arranca desenfocando). Anotarlo.
- [ ] Cambiar de cámara frontal a trasera con un efecto puesto: el efecto
      sigue, en los tres.
- [ ] Apagar y encender la cámara con un efecto puesto: al volver, el efecto
      sigue. **En ningún momento se ve el fondo real en los espectadores.**
- [ ] Mandar la aplicación a segundo plano y volver con un efecto puesto:
      igual.
- [ ] Llamada entrante durante la emisión con un efecto puesto: al colgar, la
      cámara vuelve con el efecto o apagada; nunca sin efecto.
- [ ] Modo avión hasta que la emisión se cae y reconecta: la cámara vuelve
      **apagada** hasta que el efecto está puesto, y entonces se enciende. Si
      el efecto no vuelve, la cámara se queda apagada y sale el aviso.
- [ ] Terminar la emisión con un efecto puesto y salir: el indicador de cámara
      del sistema se apaga.
- [ ] El anfitrión, con desenfoque, pulsa Atrás y sale sin terminar: en los
      espectadores la imagen se corta **sin que se llegue a ver el fondo
      real**, ni un instante.
- [ ] Un intento de entrar que falla (modo avión al abrir) y luego entra bien:
      los efectos se pueden poner y **se ven en los espectadores**. Si la hoja
      marca un efecto y los demás no lo reciben, es el fallo de «la instancia
      vieja».
- [ ] En el Android antiguo, pedir desenfoque y, si tarda y dice «no se pudo»,
      esperar unos segundos: el desenfoque no aparece después por su cuenta. Si
      aparece, «Ninguno» lo quita.
- [ ] El botón de efectos está siempre a la vista de quien emite. En un
      teléfono que no los admite sale atenuado y la hoja explica por qué.
- [ ] En el Android antiguo: fotogramas con cada efecto. Si va a saltos,
      «Ninguno» responde al momento.
- [ ] iPhone: que la imagen publicada con el complemento tiene la **misma
      resolución** que sin él (comparar en un espectador, con y sin efecto).
- [ ] iPhone con iOS 15: no hay botón de efectos.
- [ ] Un binario 1.1.x: no hay botón de efectos y nada falla.
- [ ] Media hora emitiendo con desenfoque: temperatura, batería, y si el
      sistema baja el rendimiento.

### Calidad

- [ ] Sin Simulcast en la plantilla: **no hay botón de calidad**. Es lo
      esperado hoy.
- [ ] Con Simulcast (si se autoriza activarlo): el botón aparece solo a quien
      mira; la hoja enseña la medida real de cada opción.
- [ ] «Ahorrar datos»: la imagen baja de definición en un par de segundos,
      **sin** cortarse ni volver a conectar. «Alta calidad»: sube.
- [ ] «Automática»: en Wi-Fi se ve bien; al pasar a datos con poca cobertura,
      baja sola.
- [ ] Con «Ahorrar datos» elegido, el anfitrión apaga y enciende la cámara: la
      imagen vuelve en baja, no en alta.
- [ ] El anfitrión no tiene botón de calidad.
- [ ] Mala cobertura en un espectador: aparece «Conexión lenta» sobre la
      imagen, sin parpadear, y se quita cuando mejora.
- [ ] Mala cobertura en el anfitrión: qué ven los espectadores. Anotarlo.

### Red, sistema y orientación

- [ ] Todo lo anterior en Wi-Fi y en datos móviles.
- [ ] Segundo plano y vuelta, como espectador: la imagen y el chat se
      recuperan solos.
- [ ] Llamada entrante como espectador: al colgar, se sigue en la emisión.
- [ ] Girar el teléfono: la pantalla se queda en vertical y nada se descoloca.
- [ ] Tema claro y oscuro del sistema: la pantalla del directo es oscura
      siempre; las hojas de efectos y de calidad siguen el tema.
- [ ] Salir de la emisión como espectador: sin diálogo. Como anfitrión:
      pregunta antes.
- [ ] El anfitrión termina la emisión: los dos espectadores ven «terminada»,
      el chat se cierra, las reacciones desaparecen.
- [ ] Un espectador entra con la emisión ya empezada: ve la imagen, los
      últimos mensajes y los totales de reacciones.

### Para medir, no para marcar

Con el teléfono conectado y la emisión en marcha, anotar en cada aparato:

| Qué | Android reciente | Android antiguo | iPhone |
|---|---|---|---|
| Fotogramas del anfitrión sin efecto / con desenfoque / con fondo | | | |
| Uso de CPU y memoria a los 10 minutos | | | |
| Temperatura a los 30 minutos | | | |
| Batería gastada en 30 minutos (anfitrión / espectador) | | | |
| Datos consumidos en 10 minutos en «Alta» y en «Ahorrar datos» | | | |
| Retraso entre pulsar una reacción y verla en otro teléfono | | | |

Y una emisión de ensayo con todos los teléfonos que se puedan juntar (20 o 30)
reaccionando a la vez, mirando en el panel de Supabase los mensajes por segundo
y si aparece algún error de límite. Es la medida que falta en
[`Z_DIRECTOS_ESCALA.md`](Z_DIRECTOS_ESCALA.md) §8.

---

## Sesiones en el chat, avisos y fluidez (04/10/2026, noche)

Reportado desde un teléfono con la compilación 1.2.0 de pruebas: no llegó
ningún aviso al pedirle una sesión; no se podía aceptar desde Mensajes ni
quedaba registrado; «Aceptar» seguía ahí después de aceptar; los avisos solo
llegan con la aplicación abierta; y la navegación iba a tirones.

Nada de lo que sigue está visto en un teléfono. Hace falta la API desplegada y
una compilación nueva. Dos cuentas, **A** (pide) y **B** (recibe), en dos
teléfonos.

**La migración 0097 está aplicada en Supabase desde el 05/10/2026** (comprobada
en solo lectura: tabla, RLS, una sola política de lectura, dos índices, cero
filas). Con ella, y con la API reiniciada después —el despliegue renueva las
máquinas—, la tarjeta es el propio mensaje y cada respuesta queda como una
línea. El camino sin ella (la solicitud como texto y la tarjeta **al final de
la conversación**) sigue en el código y es el que se verá hasta que la API
nueva esté desplegada, y en las sesiones pedidas antes. Las tablas de abajo
valen para los dos casos salvo donde se dice.

### Fluidez

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| Desplazar Inicio y Explorar: sin tirones | | | |
| Cambiar de pestaña con la barra inferior: inmediato | | | |
| Abrir y cerrar una pantalla (perfil, chat, publicación) | | | |
| Pulsar un botón, una fila o un icono: se hunde y se atenúa al tocar | | | |
| Dar «me gusta» y guardar: el icono da un salto y el número cambia | | | |
| Llega un mensaje: el globo de la barra da un bote | | | |
| Comparar con la compilación anterior a la mejora de vistas, si se conserva | | | |

Si sigue yendo lento, decir en qué pantalla y con qué gesto: lo que se quitó es
la causa encontrada leyendo el código, no una medida hecha en el teléfono.

### La sesión, en Mensajes

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| A pide una sesión a B: en el chat de los dos aparece una tarjeta con la sesión | | | |
| Sin la 0097: la solicitud es un texto y la tarjeta está al final del chat. Con la 0097: la tarjeta es el mensaje | | | |
| No salen dos tarjetas de la misma sesión | | | |
| La tarjeta de B tiene «Aceptar» y «Rechazar»; la de A, «Cancelar sesión» | | | |
| B acepta desde el chat: los botones cambian en el acto | | | |
| Queda escrito en el chat que se aceptó: con la 0097, «Aceptaste la sesión» (B) / «B aceptó la sesión» (A); sin ella, un mensaje «Sesión aceptada: …» | | | |
| A tiene el chat abierto cuando B le pide OTRA sesión: la tarjeta aparece sin salir | | | |
| La tarjeta del final queda a la vista sin tener que desplazar | | | |
| Pulsar dos veces muy seguidas «Confirmar reserva»: sale UNA solicitud | | | |
| Pedir la sesión desde un teléfono con la aplicación SIN actualizar: en el chat sale una sola vez | | | |
| A ve cambiar su tarjeta sin salir ni recargar | | | |
| La tarjeta aceptada ofrece «Ya la hicimos» y «Cancelar sesión», no «Aceptar» | | | |
| «Cancelar sesión» pregunta antes de cancelar | | | |
| Mantener pulsada la tarjeta o la línea no ofrece borrarla | | | |
| «Ver en la agenda» abre la agenda | | | |
| La conversación sale en la bandeja de B con «Solicitud de sesión 1:1…» | | | |

### La agenda

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| Lo que le piden a B y no ha respondido está en «Solicitudes» | | | |
| Al aceptar, sale de «Solicitudes» y aparece en «Agenda · sesiones», Próximas | | | |
| Ahí ofrece «Ya la hicimos» y «Cancelar sesión» | | | |
| Aceptar en la agenda y volver al chat: la tarjeta ya no ofrece «Aceptar» | | | |
| Aceptar en el chat con la agenda abierta en otro teléfono de la misma cuenta, y pulsar allí «Aceptar»: dice que ya había cambiado y se pone al día | | | |

### Avisos con la aplicación abierta

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| B tiene la aplicación abierta en cualquier pantalla y A le pide una sesión: sale el aviso «A quiere agendar contigo» en uno o dos segundos | | | |
| Sale UN aviso, no dos (el de la sesión, no además «mensaje nuevo») | | | |
| Con Firebase puesto: sigue saliendo UNO (no el de la bandeja y además el del push) | | | |
| Tras aceptar, si esa persona escribe un mensaje normal a los pocos segundos, ese mensaje SÍ avisa | | | |
| Lo mismo con avisos antiguos sin leer en la bandeja | | | |
| Lo mismo después de abrir y cerrar la bandeja de notificaciones | | | |
| A recibe el aviso cuando B acepta, rechaza o cancela | | | |
| Tocar el aviso lleva a la agenda | | | |

### Avisos con la aplicación cerrada (necesita Firebase)

Ver «Push con la aplicación cerrada» en `PUBLICAR_EN_GOOGLE_PLAY.md`. Sin ese
paso esta tabla no puede salir bien.

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| Aplicación cerrada del todo, pantalla apagada: llega el aviso de un mensaje, con el nombre | | | |
| Llega el de una solicitud de sesión | | | |
| Llega el de una sesión aceptada, rechazada o cancelada | | | |
| Llegan el de un seguidor nuevo, una reacción y un comentario | | | |
| Tocar cada aviso abre lo que anuncia | | | |
| Suena y vibra | | | |

---

## Abrir desde una notificación (05/10/2026)

**Lo que pasó.** Con la compilación 44 —la primera con Firebase— la aplicación
dejaba de abrirse después de tocar una notificación: «Algo no ha salido bien ·
Maximum update depth exceeded» en cada arranque, también cerrándola del todo.
Solo se salía reinstalando. Le pasó a todas las cuentas.

**La causa**, en `apps/mobile/src/lib/navegadorMontado.ts`: el código que abre
la aplicación desde un push navegaba antes de que el layout raíz hubiera
montado su navegador, el enrutador volvía a montar el layout entero, y el
layout nuevo leía el mismo toque. No eran las animaciones del 04/10. Estaba
desde el 25/09 y no se había visto porque el push no llegaba en Android.

**Nada de esto se puede probar sin un teléfono**: en web no hay push. La regla
está ejecutada en pruebas y la forma del estado de navegación se comprobó en
la copia web, pero el toque de verdad solo existe en el aparato. Dos cuentas,
**A** y **B**, en dos teléfonos con la compilación nueva.

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| B con la app cerrada del todo. A le escribe. B toca la notificación: se abre el chat de A | | | |
| B cierra la app del todo y la abre DESDE EL ICONO: abre en Inicio, sin error | | | |
| Otra vez, y otra: sigue abriendo, y NO vuelve a meterse sola en aquel chat | | | |
| B con la app en segundo plano. A le escribe. B toca la notificación: se abre el chat | | | |
| B toca una notificación que no es de mensaje (seguidor, reacción): lleva a lo que anuncia; si no anuncia nada concreto, la app se queda en Inicio (ya NO abre Notificaciones) | | | |
| Dos notificaciones seguidas de dos personas: cada una abre su chat, una sola vez | | | |
| Si aun así sale «Algo no ha salido bien»: captura con las líneas «Pantalla», «En» y «Por» | | | |

### La bandeja y el aviso dentro de la aplicación

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| Entrar a un chat con mensajes sin leer y volver a Mensajes enseguida: su fila ya no lleva el globo | | | |
| Lo mismo entrando al chat desde una notificación | | | |
| B con la app abierta en cualquier pantalla. A le escribe: el aviso flotante sale casi al instante, con el nombre, la foto y el texto | | | |
| Tocar el aviso flotante abre ese chat; arrastrarlo hacia arriba lo quita | | | |
| A le pide una sesión a B: sale UN aviso, no dos | | | |
| Con el chat de A delante, A escribe: NO sale aviso flotante | | | |
| Captura del aviso flotante en claro y en oscuro, para valorar su diseño | | | |

---

## Compilación 46 (05/10/2026, tarde): lo que se vio y lo que cambia

**Confirmado en el teléfono con la 46:** la aplicación ya no deja de abrirse
después de tocar una notificación.

**Lo que se reportó con la 46**, y su causa:

| Lo reportado | Causa | Dónde |
|---|---|---|
| «Cada que entro a la aplicación me redirige a notificaciones» (Xiaomi) | En Android la biblioteca de avisos toma por «han tocado un aviso» cualquier dato con que el sistema abra la aplicación, y ese lanzador la abre con datos suyos. Llegaba sin identificador, con un tipo desconocido, y lo desconocido iba a la bandeja | `apps/mobile/src/lib/rutaDelPush.ts` (`destinoDelToque`) |
| «Muestra notificaciones pasadas, ni siquiera se actualiza» | La bandeja no lleva los mensajes de chat (van en Mensajes): se llegaba a ella por el salto de arriba y no había nada nuevo que enseñar | — |
| «Aparece en la bandeja que tengo mensajes, pero no llegaban hasta volver a entrar al chat» / «no llegan instantáneamente» | El chat cargaba UNA vez y después dependía solo de su canal de tiempo real, que no repone lo que se pierde mientras está caído (segundo plano, cambio de red). Con el chat delante no había otro camino | `apps/mobile/src/screens/ChatScreen.tsx` (`ponerAlDia`) |
| «Al inicio no me llegaban hasta que entraba a la app; luego comenzó a funcionarme» | El registro del teléfono para recibir avisos, si fallaba la primera vez, solo se repetía al volver del segundo plano | `apps/mobile/src/hooks/useAvisosEnVivo.ts` |
| El recuadro negro «Ver contenido de Darren gratis aquí» en Notificaciones | Era un aviso fijo de la propia aplicación. Retirado, y con él el punto que encendía en la campana | `apps/mobile/src/screens/NotificationsScreen.tsx` |

**Comprobado sin teléfono** (copia web local, con el tiempo real caído a
propósito): la aplicación arranca en Inicio; salen los avisos de «sin leer»;
Notificaciones no lleva el recuadro; con un chat abierto, un mensaje nuevo
aparece solo en 2–3 s sin salir ni volver a entrar. **Lo que solo existe en el
teléfono** —tocar una notificación, el lanzador de Xiaomi, el push— es esta
lista. Dos cuentas, **A** y **B**, con la compilación nueva.

### Abrir la aplicación

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| Abrir la app desde el icono, cinco veces seguidas (cerrándola del todo entre una y otra): SIEMPRE abre en Inicio, nunca en Notificaciones | | | |
| Lo mismo en el Xiaomi donde se vio el salto | | | |
| Con mensajes sin leer, al abrir sale UN aviso flotante: de una sola persona, con su nombre y su foto; de varias, «Tienes N mensajes sin leer» | | | |
| Con notificaciones sin leer, al abrir sale «Tienes N notificaciones sin leer» (si es una sola, dice cuál) | | | |
| Tocar esos avisos abre Mensajes, ese chat o Notificaciones | | | |
| Salir a otra app y volver SIN que haya llegado nada nuevo: no se repite el aviso | | | |
| Salir, que A escriba, volver: el aviso sale otra vez | | | |
| En Notificaciones no hay ningún recuadro negro encima de la lista | | | |

### El chat, al momento

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| A y B con el mismo chat abierto: lo que escribe uno le aparece al otro en 1–2 s | | | |
| B con el chat de A abierto sale a otra app medio minuto; A le escribe dos mensajes; B vuelve: los dos mensajes están ahí SIN salir del chat | | | |
| B con el chat de A abierto apaga la pantalla un minuto; A escribe; B la enciende: el mensaje está ahí | | | |
| B con el chat de A abierto cambia de wifi a datos; A escribe: el mensaje aparece en pocos segundos | | | |
| B abre el chat de A, entra desde ahí al perfil de A y vuelve atrás; mientras, A escribió: al volver está el mensaje | | | |
| B tiene el chat de A abierto DEBAJO de otra pantalla; A escribe: en Mensajes esa conversación SÍ lleva globo (no se dio por leída sin verla) | | | |

### Avisos con la aplicación cerrada

Si a alguien no le llegan con la aplicación cerrada, **el permiso de
notificaciones no es lo único que cuenta**. Por orden:

1. **¿Tiene la compilación nueva?** Las anteriores a la 44 no llevan Firebase y
   no reciben nada con la aplicación cerrada.
2. **¿Dejó su teléfono el token?** En el editor SQL de Supabase (cambia el
   usuario; no enseña el token, solo si existe):

   ```sql
   select p.username,
          count(d.token)       as aparatos,
          max(d.platform)      as plataforma,
          max(d.last_seen_at)  as ultimo_registro
   from public.profiles p
   left join public.device_tokens d on d.user_id = p.id
   where p.username in ('USUARIO_QUE_NO_RECIBE', 'USUARIO_QUE_SI_RECIBE')
   group by p.username;
   ```

   `aparatos = 0` → el teléfono no se registró: que abra la aplicación, la deje
   abierta un minuto (ahora se reintenta sola cada 30 s) y se repita la
   consulta. Si sigue en 0 con el permiso concedido, es un fallo nuestro.
3. **Con `aparatos ≥ 1`, lo que dice el servidor.** Desde este cambio queda en
   los registros de la API por qué no salió un aviso: `[push] Expo rechazó…`
   con el motivo, o `sin ningún aparato registrado`.
4. **Con todo lo anterior bien, es el teléfono.** Xiaomi, Huawei, Oppo, Vivo y
   otros cierran del todo las aplicaciones al quitarlas de recientes y no dejan
   que el sistema las despierte: el aviso no llega hasta abrirla. No es el
   permiso de notificaciones: es **Inicio automático** (activado) y **Ahorro de
   batería → Sin restricciones** para Z, en los ajustes de la aplicación.

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| Recién instalada: conceder el permiso, usar la app un minuto SIN salir de ella, cerrarla; que A escriba: llega el aviso | | | |
| App cerrada (quitada de recientes) y pantalla apagada 5 minutos; A escribe: suena y se ve en la pantalla de bloqueo | | | |
| Lo mismo en el teléfono de la persona a la que no le llegaban | | | |
| En ese teléfono: marca y modelo, y si Z tiene «Inicio automático» y batería «Sin restricciones» | | | |

### Avisos de Servicios con la aplicación cerrada

Los avisos de Servicios, de la posventa de eventos y de los envíos de
productos se guardaban en una cola que nadie vaciaba: solo se veían dentro de
la aplicación. Desde el 05/10/2026 salen solos al guardarse. Necesita el
servidor desplegado con ese cambio.

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| Quien postuló tiene la app cerrada; administración aprueba su postulación: le llega el aviso al teléfono en segundos | | | |
| Lo mismo al aprobar y publicar su servicio | | | |
| El prestador tiene la app cerrada; un cliente reserva: le llega «Tienes una reserva nueva» | | | |
| Tocar ese aviso abre la app en Inicio, y el aviso flotante dice que hay una notificación sin leer | | | |
| Ningún aviso de estos llega dos veces | | | |

### Vistas de Cursos, Eventos y Servicios (05/10/2026)

Revisadas con datos de prueba en la copia web local; en el teléfono falta
verlas con datos reales, en claro y en oscuro.

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| Cursos: un curso sin imagen enseña un recuadro gris con un libro, no un hueco en blanco (rejilla, «Guardados», «Continúa aprendiendo») | | | |
| Cursos: «Continúa aprendiendo», «Guardados» y «Todo el catálogo» empiezan a la misma altura del borde que las tarjetas | | | |
| Cursos y Eventos: el filtro elegido se rellena igual en las dos (negro en claro, blanco en oscuro) | | | |
| Eventos: todas las filas de la lista miden parecido aunque el título sea largo | | | |
| Ficha de un evento presencial: la modalidad NO lleva el dibujo de una cámara | | | |
| Servicios: una tarjeta sin foto enseña un recuadro gris con un maletín | | | |
| En las tres: tocar una tarjeta o un filtro se nota (se encoge un poco) y hace lo mismo que antes | | | |
| En el inicio (vídeo, fondo negro), el aviso flotante se ve como una caja con borde | | | |
| Todo lo anterior, también en modo oscuro | | | |

## Chat, notas de voz y recorte de fotos (06/10/2026) — versión 1.2.1

Del documento «Z bugs y problemas de vistas». El desplazamiento del chat está
comprobado en la copia web local (abrir, recibir, enviar, encoger la pantalla
y leer el historial). El teclado, los tonos, la nota de voz y la pantalla de
recorte solo existen en el teléfono: nada de eso se ha visto todavía.

**Hace falta una compilación nueva** (la 1.2.1): los tonos y los colores del
recorte van dentro del binario.

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| Abrir una conversación larga: se ve el último mensaje sin deslizar | | | |
| Con el teclado abierto, enviar un mensaje: se ve encima del redactor, sin deslizar | | | |
| Con el teclado abierto, recibir un mensaje: se ve, sin deslizar | | | |
| Abrir el teclado estando abajo: el último mensaje sigue a la vista | | | |
| Cerrar el teclado con el botón Atrás: el redactor vuelve abajo del todo, sin hueco debajo | | | |
| Lo mismo en Comentarios y en un formulario largo (usan el mismo arreglo del teclado) | | | |
| Subir a leer mensajes antiguos y recibir uno: NO salta abajo; aparece un botón redondo con una flecha y un punto | | | |
| Tocar ese botón: baja al último y el botón desaparece | | | |
| Subir a leer y ENVIAR un mensaje: baja al último | | | |
| Llegar arriba del todo sigue cargando mensajes más antiguos, sin saltos | | | |
| Enviar un mensaje: suena un toque corto cuando sale | | | |
| Recibir un mensaje con el chat abierto: suenan dos notas suaves | | | |
| Con el teléfono en silencio o en vibración, ninguno de los dos suena | | | |
| Con música puesta en otra aplicación, los tonos NO la paran | | | |
| Varios mensajes seguidos: no suenan pisándose | | | |
| Los tonos no dejan ningún aviso en la barra de notificaciones ni mueven la campana | | | |
| Ajustes del teléfono › Z › Notificaciones: aparecen «Sonido al enviar un mensaje» y «Sonido al recibir un mensaje», y apagarlos los calla | | | |
| Grabar una nota de voz: la barra de la grabación ocupa el sitio del campo de texto, con la papelera a la izquierda | | | |
| Detener la grabación: papelera a la izquierda, escuchar, duración y enviar a la derecha | | | |
| Tocar la papelera, grabando y en la previa: la nota se borra y vuelve el campo de texto | | | |
| Cambiar la foto de perfil, teléfono en modo claro: la barra de arriba es blanca y «atrás», «girar», «voltear» y «CORTAR» se leen en negro | | | |
| Lo mismo con el teléfono en modo oscuro: barra negra, todo en blanco | | | |

**Lo que este arreglo NO cambia:** la cuadrícula del recorte sigue siendo
blanca y sobre una foto clara apenas se ve. Esa pantalla es de la biblioteca
de fotos y no deja cambiar ese color; hacerlo exige una pantalla de recorte
propia, que necesita añadir un paquete (`expo-image-manipulator`).

## Pantalla gris, teclado, directo, enlaces y portada (07/10/2026)

Del documento «Z bugs y nuevas funcionalidades». No cambia nada del servidor ni
de la base: basta una compilación nueva de la aplicación. La versión sigue
siendo la 1.2.1 (no entra ningún componente nativo nuevo).

En la copia web local se ha visto: el directo con su cabecera nueva, el tema
abajo y el cartel de fin; «Seguir»; la vuelta a Inicio; el enlace dentro de un
mensaje; el perfil sin el botón largo; y la contraseña, que termina en Inicio
con el aviso un instante después de llegar. **La pantalla gris, el teclado y
el número de personas viendo solo se pueden comprobar en teléfono.**

**Anotar en cada fila la versión instalada y el modelo del teléfono.**

### La pantalla gris

No se pudo reproducir fuera del teléfono. Se cambió lo que tenían en común los
dos casos (el aviso de «hecho» pedido en el mismo instante en que se sustituía
la pantalla). Si alguna de estas filas vuelve a salir gris, hace falta una
captura y saber si la aplicación estaba abierta de fondo o cerrada.

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| Recuperar contraseña con la aplicación ABIERTA de fondo: tras guardar se llega a Inicio, con contenido | | | |
| Lo mismo con la aplicación CERRADA del todo antes de tocar el enlace del correo | | | |
| El aviso «Contraseña actualizada» aparece ya en Inicio, no antes | | | |
| Desde ese Inicio, «Atrás» NO devuelve a la pantalla de entrar ni a la del correo | | | |
| Crear un curso, completar los pasos y publicarlo: se llega a Cursos, con contenido | | | |
| El curso recién publicado aparece el primero de «Todo el catálogo» | | | |
| Desde Cursos, «Atrás» NO devuelve al asistente del curso | | | |
| Publicar un producto y enviar un servicio a revisión: la pantalla siguiente se ve, y el aviso sale al llegar | | | |

### El teclado

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| Directo: tocar el campo y ESCRIBIR varias letras (sale la fila de sugerencias): el campo sigue entero encima del teclado | | | |
| Directo: abrir el panel de emojis del teclado: el campo sigue a la vista | | | |
| Comentarios de una publicación: lo mismo, escribiendo varias letras | | | |
| Crear › Publicación: escribir la descripción; el campo no queda tapado | | | |
| Cerrar el teclado en cada una: no queda hueco debajo | | | |
| Un formulario largo (crear producto, postular como prestador): al tocar el último campo, se ve encima del teclado | | | |
| Una hoja inferior con campos (crear curso, crear evento desde el perfil): el campo se ve al escribir | | | |
| Entrar con la cuenta y crear cuenta: sin cambios respecto a antes | | | |

### El directo

Hace falta un teléfono que emita y al menos dos que miren.

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| Arriba a la izquierda: foto y nombre de quien emite | | | |
| Quien MIRA y no sigue a quien emite ve «Seguir» debajo del nombre; al tocarlo desaparece y queda siguiéndole | | | |
| Quien EMITE no ve «Seguir» | | | |
| A la izquierda de «EN VIVO»: un ojo con el número de personas viendo | | | |
| Con dos teléfonos mirando marca 2; al salir uno, baja a 1 en unos segundos | | | |
| Quien emite no se cuenta a sí mismo | | | |
| Se ven cuatro comentarios; los anteriores se alcanzan deslizando | | | |
| Al llegar un comentario nuevo estando abajo, la lista lo sigue | | | |
| El título del directo está debajo de los comentarios y encima de las reacciones, en un recuadro claro, sin pegarse a ninguno | | | |
| Un título largo se corta con puntos suspensivos, sin salirse | | | |
| Las reacciones (botones y las que suben) se ven enteras, sin recortar | | | |
| Botón de compartir, a la derecha, para quien emite y para quien mira: abre el menú de compartir con un enlace | | | |
| Abrir ese enlace en otro teléfono lleva a ESE directo | | | |
| Quien emite: «Terminar» es rojo, con un cuadrado; pide confirmación | | | |
| Efectos: aparecen «Pantalla verde», «Atardecer» y «Montañas», y se aplican detrás de la persona | | | |
| Al terminar, quien miraba ve «El directo ha terminado» y una cuenta atrás; a los 8 s vuelve a Inicio | | | |
| «Quedarme a leer el chat» para la cuenta atrás y deja leer | | | |
| «Ir a Inicio» lleva a Inicio; «Atrás» desde ahí no vuelve a la sala | | | |
| Abrir una emisión que ya había terminado: se ve el cartel, SIN cuenta atrás | | | |
| Quien emitía ve el cartel sin cuenta atrás | | | |
| Tras una emisión con público, la ficha guarda el máximo de espectadores | | | |

### Mensajes, eventos y perfil

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| Enviar por chat el enlace de un Meet: sale celeste y subrayado, en la burbuja propia y en la ajena | | | |
| Tocarlo abre la reunión | | | |
| El punto o la coma que va detrás del enlace no forma parte de él | | | |
| Un correo (`nombre@gmail.com`) no sale subrayado | | | |
| Pegar en un chat el enlace de un directo de Z: al tocarlo se abre DENTRO de la aplicación | | | |
| Mantener pulsado un mensaje propio sigue abriendo sus acciones | | | |
| Eventos › Crear evento: arriba hay un recuadro «Portada o flyer del evento»; al tocarlo se elige la imagen | | | |
| Con portada puesta, se ve entera y un botón «Cambiar portada» sobre ella | | | |
| Perfil propio y ajeno: ya no está el botón largo «Publicaciones N»; la cuadrícula empieza justo debajo de los accesos | | | |

**Lo que NO entra en esta entrega** y necesita servidor, una migración o una
decisión: fijar mensajes en el directo, el texto animado de quien emite, la
descarga del directo, los clips con IA, la agenda de disponibilidad y la moneda
de los cursos.

## La barra de Crear (07/10/2026, tarde)

Del documento «Cambio de vista Z». En Crear, los cuatro tipos de publicación
(Publicación · Historia · Reel · Vivo) pasan a una barra abajo del todo, y la
barra de navegación se retira **solo ahí**. Nada de esto cambia el servidor ni
la versión (sigue 1.2.1): hace falta compilar de nuevo para verlo.

En la copia web se comprobó la barra en claro y en oscuro, que cae a la misma
altura en los cuatro tipos, la salida con la `X` y que sin cuenta la barra de
navegación se queda. **La cámara no existe en la web**: todo lo de la cámara de
abajo solo se ve en un teléfono.

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| Al entrar en Crear desaparece la barra de navegación y en su sitio hay una barra con Publicación · Historia · Reel · Vivo | | | |
| Se leen las cuatro palabras enteras, ninguna cortada | | | |
| Con el tema claro: barra blanca y letra negra. Con el oscuro: barra oscura y letra blanca | | | |
| El tipo elegido va en negativo (píldora negra con letra blanca en claro; al revés en oscuro) | | | |
| La barra es más ancha y más alta que la de navegación: no se confunden | | | |
| Tocar cada palabra cambia de tipo; la barra NO se mueve de sitio al cambiar | | | |
| Deslizar de lado sobre la pantalla también cambia de tipo, y no de sección | | | |
| Cámara: de abajo arriba se ven la barra, la pista de ayuda, y la fila de carrete · disparador · girar. Nada se pisa | | | |
| La pista («Toca para una foto · Mantén para grabar · Desliza para acercar») se lee sobre un fondo oscuro, entera, sin salirse por los lados; también apuntando a algo claro | | | |
| El disparador hace foto al tocar y graba al mantener, como antes; el dedo no toca la barra | | | |
| Grabando y deslizando para acercar: el «2.4x» sale encima del disparador, sin tapar nada | | | |
| Carrete: la barra sigue abajo; bajando hasta el final, las últimas fotos quedan por encima de ella y se pueden tocar | | | |
| Carrete en Publicación: «Escribir sin foto» se lee sobre cualquier foto (lleva fondo) | | | |
| Tras elegir una foto o un vídeo ya no hay barra: el botón de publicar queda abajo, a la vista, y se puede pulsar | | | |
| La flecha de volver de ese paso devuelve a la cámara, con la barra otra vez en su sitio | | | |
| Vivo: hay una `X` arriba a la izquierda y lleva a Inicio | | | |
| Sin permiso de cámara: el aviso tiene `X`, y la barra sigue abajo | | | |
| La `X` de la cámara lleva a Inicio y allí vuelve a estar la barra de navegación | | | |
| «Atrás» de Android en Crear vuelve a la sección anterior, con su barra de navegación | | | |
| Inicio, Explorar, Mensajes y Perfil: la barra de navegación sigue como siempre | | | |
| Llegar a Crear DESLIZANDO desde Explorar o Mensajes: durante el arrastre solo se ve la barra de navegación; al soltar, la de Crear | | | |
| Sin cuenta, la pestaña Crear enseña la invitación a registrarse y la barra de navegación NO desaparece | | | |
| Teléfono con botones de Android abajo (no gestos): la barra queda por encima de ellos | | | |

## Invitados en el directo (07/10/2026)

Quien emite invita a otras personas, que salen con su cámara, y la pantalla se
reparte. La migración 0098 ya está aplicada (07/10/2026); falta **el servidor
desplegado y una compilación nueva**. En la copia web se vio el botón de invitar, la hoja con el
buscador, el aviso al invitado y que aceptar y bajarse llegan al servidor.
**El vídeo no existe en la web**: la pantalla repartida, el sonido y el retraso
solo se ven con teléfonos.

Hacen falta tres: uno emite (A), uno es invitado (B) y uno mira (C). **A y B en
habitaciones distintas o con audífonos**: juntos se acoplan y pitan, y eso no
es un fallo de la aplicación.

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| A, emitiendo: a la derecha, debajo de compartir, hay un botón con una persona y un «+» | | | |
| Al tocarlo se abre «Invitar al directo» y dice «Caben 3 personas más» | | | |
| Buscando el nombre de B, sale; A no sale en su propia búsqueda | | | |
| «Invitar» deja a B en la lista con «Invitación enviada» y baja el contador a 2 | | | |
| B, mirando el directo: le sale «A te invita a salir en su directo», con «Ahora no» y «Aceptar y salir» | | | |
| B, con la aplicación cerrada: le llega la notificación «Te invitan a un directo»; al tocarla se abre la sala con la invitación | | | |
| B toca «Ahora no»: la tarjeta desaparece; en la lista de A pasa a «No aceptó» y el sitio vuelve a estar libre | | | |
| A lo invita otra vez y B acepta: se le piden los permisos de cámara y micrófono (la primera vez) y sale en pantalla | | | |
| Mientras B entra solo B ve un corte de uno o dos segundos; a A y a C no se les corta nada | | | |
| C ve la pantalla partida en dos, lado a lado, con A a la izquierda; cada recuadro lleva el nombre | | | |
| A, B y C ven a las personas colocadas en el mismo orden | | | |
| Las caras se ven enteras en los recuadros (no cortadas por arriba) | | | |
| C oye a A y a B a la vez, sin eco y sin que uno vaya claramente por detrás del otro | | | |
| A y B pueden conversar con naturalidad: el retraso es el de una videollamada | | | |
| El chat, las reacciones y el título se ven debajo de la rejilla, sin taparle la cara a nadie | | | |
| B tiene sus botones de cámara, micrófono, girar y efectos; y arriba a la derecha, «Bajarme» | | | |
| B apaga la cámara: su recuadro se queda, con sus iniciales; al encenderla vuelve la imagen | | | |
| B toca «Bajarme»: su cámara se apaga en el acto, la pantalla vuelve a ser solo A y B sigue mirando | | | |
| A, en la lista, toca «Quitar» sobre B: B deja de salir, le aparece «Quien emite te ha quitado de la pantalla» y sigue mirando | | | |
| B, estando arriba, sale de la sala con «atrás»: deja de salir para todos y su sitio queda libre | | | |
| B aceptó, cerró la aplicación a la fuerza y vuelve a entrar al directo: entra MIRANDO, sin que se le encienda la cámara | | | |
| Con dos invitados (tres en pantalla): A a la izquierda a lo alto y los otros dos a la derecha, uno encima de otro | | | |
| Con tres invitados (cuatro en pantalla): cuadrícula de 2×2; el teléfono de C no se calienta ni va a tirones | | | |
| Con tres invitados, el contador dice que no caben más y «Invitar» está apagado | | | |
| A termina el directo: B y C ven el cartel de fin; la cámara de B se apaga | | | |
| C (que solo mira) no ve en ningún momento el botón de invitar ni la lista de invitados | | | |
| Una persona sin cuenta que mira: no ve nada de esto y el directo le funciona igual | | | |
| Un directo sin invitados se ve y se oye exactamente como antes | | | |

## Reel que graba y rojo que se lee (09/10/2026)

Solo de la aplicación: basta una compilación nueva. La versión sigue siendo la
1.2.1.

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| Crear › Reel: un TOQUE en el disparador empieza a grabar (no hace foto) | | | |
| Otro toque termina y lleva a «describe tu reel», con el vídeo reproduciéndose | | | |
| Mantener pulsado graba y al soltar termina | | | |
| Manteniendo pulsado, deslizar el dedo hacia arriba acerca la imagen | | | |
| La primera vez pide el micrófono; al concederlo empieza a grabar sin tener que tocar otra vez | | | |
| La pista dice «Toca para grabar y otra vez para terminar · Mantén y desliza para acercar» | | | |
| Mientras graba no se puede girar la cámara, y el anillo avanza | | | |
| A los tres minutos se corta solo | | | |
| Crear › Historia y Crear › Publicación: un toque sigue haciendo FOTO y mantener graba, como antes | | | |
| En el directo, «EN VIVO» y «Terminar» se leen bien (letra blanca sobre rojo oscuro) | | | |
| La tarjeta de un directo en Inicio y el aviso de «está en directo»: el rótulo rojo se lee igual | | | |

## Mensaje fijado y texto en pantalla (09/10/2026)

Hacen falta **la migración 0099 aplicada, el servidor desplegado y una
compilación nueva**. En la copia web se vio la hoja del texto con su contador
y su vista previa, el texto bajo la cabecera (también en cinta, moviéndose), el
mensaje fijado sobre el chat, el menú al mantener pulsado un mensaje y que quien
mira no tiene ningún control. **Con teléfonos falta ver que le llega a los
demás al momento.**

Hacen falta dos: uno emite (A) y uno mira (B).

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| A, emitiendo: en la columna derecha hay un botón con una «T» | | | |
| Al tocarlo se abre «Texto en pantalla», con el campo, el contador `0/80` y tres formas: Deslizar, Latido, Cinta | | | |
| Al escribir aparece «Así se verá» con el texto tal como saldrá | | | |
| Escribiendo con espacios de más o saltos de línea, la muestra los quita y el contador no los cuenta | | | |
| Con más de 80 caracteres el contador se pone rojo, dice cuántos sobran y «Mostrar a todos» se apaga | | | |
| «Mostrar a todos»: el texto aparece arriba, bajo el nombre, en A y en B, en uno o dos segundos | | | |
| En B el texto entra deslizándose UNA vez; no vuelve a entrar solo cada poco | | | |
| «Latido»: entra y late tres veces; después se queda quieto | | | |
| «Cinta» con un texto largo: corre de lado y se lee entero. Con uno corto, no se mueve | | | |
| A toca el texto: se abre la hoja con lo que hay puesto; «Actualizar el texto» lo cambia para todos | | | |
| «Quitar el texto»: desaparece en A y en B | | | |
| B toca el texto: no pasa nada. B no tiene el botón «T» | | | |
| Con «reducir movimiento» activado en el teléfono de B: el texto aparece sin moverse | | | |
| A mantiene pulsado un mensaje del chat: se abre «Acciones del mensaje» con «Fijar mensaje» y «Ocultar mensaje» | | | |
| «Fijar mensaje»: aparece encima del chat, con chincheta y el nombre de quien lo escribió, en A y en B | | | |
| Llegan mensajes nuevos: el fijado NO se va con la conversación | | | |
| A fija otro mensaje: sustituye al anterior | | | |
| A mantiene pulsado el mensaje fijado: ofrece «Dejar de fijar» | | | |
| A toca la `X` del fijado: desaparece en A y en B | | | |
| A oculta el mensaje que está fijado: deja de estar fijado para todos | | | |
| B entra al directo DESPUÉS de que A fijara y pusiera el texto: ve las dos cosas | | | |
| B pone la aplicación en segundo plano, A cambia el texto, B vuelve: ve el nuevo | | | |
| B mantiene pulsado un mensaje: no pasa nada | | | |
| A termina el directo: no queda ni texto ni mensaje fijado en la pantalla de fin | | | |
| El texto no tapa el nombre de quien emite ni «EN VIVO», ni con invitados en pantalla | | | |

## Precio del curso en soles o en dólares (09/10/2026) — prototipo

Solo de la aplicación. El precio se guarda y se enseña en la moneda elegida,
**sin convertir**: no hay tipo de cambio. Las compras siguen apagadas.

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| Crear curso › De pago: aparece «Moneda» con Soles (S/) y Dólares ($) | | | |
| Con Dólares, el campo dice «Precio (USD)»; con Soles, «Precio (PEN)» | | | |
| Un curso guardado en dólares se ve como `$ 25.00` en Cursos, en su ficha y en la vista previa | | | |
| Uno en soles se sigue viendo como `S/ 25.00` | | | |
| Editar un curso en dólares: la hoja y el asistente abren con Dólares marcado | | | |
| Cambiarlo a soles y guardar: el precio pasa a verse en soles, con la misma cifra | | | |
| Un curso gratuito no enseña el selector y sigue diciendo «Gratis» | | | |

## Disponibilidad para las sesiones 1:1 (09/10/2026) — prototipo

Hacen falta **la migración 0100 aplicada, el servidor desplegado y una
compilación nueva**. Es una semana que se repite, con sesiones de una hora; no
hay excepciones por fecha, y pedir una sesión fuera de los horarios se sigue
pudiendo. En la copia web se vio «Mi disponibilidad» añadir un horario y
guardarlo; **los horarios dentro de la hoja de pedir sesión, no. Sin ver en
teléfono.**

Hacen falta dos cuentas: A pone su semana y B le pide una sesión.

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| A: en Agenda hay una fila «Mi disponibilidad» que abre la pantalla | | | |
| Se ven los siete días, cada uno con «Sin horario» y un botón «Añadir» | | | |
| «Añadir» en martes: aparecen «Desde» y «Hasta»; al elegir 9:00 y 12:00 y añadir, sale la franja | | | |
| Una franja de menos de una hora dice que tiene que durar al menos una hora | | | |
| Una franja que se pisa con otra del mismo día dice que se pisa | | | |
| La quinta franja de un mismo día dice que ya no caben más | | | |
| La `X` de una franja la quita | | | |
| «Guardar disponibilidad» se enciende solo si hay cambios; al guardar dice «Disponibilidad guardada» | | | |
| Salir y volver a entrar: la semana sigue como se guardó | | | |
| B: en el perfil de A, al pedir una sesión, salen «Horarios disponibles de A» de los próximos días | | | |
| Los horarios van de hora en hora y ninguno es de hace un rato ni empieza en menos de una hora | | | |
| Tocar un horario lo marca y rellena el día y la hora de abajo | | | |
| Confirmar crea la sesión como siempre: llega al chat y a la agenda de los dos | | | |
| A acepta esa sesión; B vuelve a abrir la hoja: ese horario ya no se ofrece | | | |
| B puede proponer otro momento con los campos de día y hora, aunque no esté entre los ofrecidos | | | |
| Pedir una sesión a alguien SIN semana puesta: la hoja es la de siempre, sin horarios | | | |
| A vacía su semana y guarda: a B ya no se le ofrece ningún horario | | | |
| B con el teléfono en otra zona horaria: ve los horarios en SU hora | | | |

## Descarga de la grabación del directo (09/10/2026) — prototipo

**No se puede probar hasta que la empresa decida encender la grabación en el
panel de 100ms** (tiene costo por minuto). Además hacen falta la migración
0101 aplicada, el servidor desplegado y una compilación nueva. Sin ver en
teléfono ni con una grabación de verdad.

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| Con la grabación APAGADA en 100ms: al terminar un directo, quien emitió ve «Si la grabación está activada, aparecerá aquí…» y nada más | | | |
| Quien solo miraba no ve nada de la grabación | | | |
| Con la grabación ENCENDIDA: unos minutos después de terminar, «Volver a comprobar» pasa a «Descargar la grabación» | | | |
| Debajo del botón dice cuánto dura y cuánto pesa, y que el enlace caduca | | | |
| Al tocarlo se abre el vídeo fuera de la aplicación y se puede guardar | | | |
| El vídeo dura lo que duró el directo y se oye | | | |
| Anotar cuánto tarda en estar lista y, días después, si el enlace sigue abriendo | | | |
| Un directo sin grabación se termina y se ve exactamente como antes | | | |

## Contenido del chat por vistas (09/10/2026)

Hace falta el servidor desplegado y una compilación nueva. **No hace falta la
migración 0102** para esto: las categorías salen de los mensajes que ya hay.
Sin ver en teléfono ni en la copia web.

| Qué comprobar | Bien | Mal | Notas |
|---|---|---|---|
| En un chat, arriba a la derecha hay un botón de cuadrícula; abre «Contenido» | | | |
| Solo salen las pestañas que tienen algo (más «Todo»), con su número | | | |
| «Fotos» enseña solo mensajes con foto; «Archivos», solo con archivo; igual vídeos, audios y enlaces | | | |
| Un mensaje con foto y enlace sale en «Fotos» y en «Enlaces», una vez en cada una | | | |
| Tocar una foto la amplía; un archivo o un vídeo se abren fuera; una nota de voz suena | | | |
| Buscar una palabra encuentra por el texto y por el nombre del archivo | | | |
| Cambiar deprisa de pestaña no deja la lista de una pestaña en otra | | | |
| Con más de 30 resultados, al bajar se cargan más sin repetirse | | | |
| Con la pantalla abierta, mandar una foto desde otro teléfono la hace aparecer en unos segundos | | | |
| Borrar un mensaje en el chat y volver: ya no está en su pestaña | | | |
| Al volver atrás, el chat está donde se dejó | | | |
| Un chat sin fotos ni archivos enseña solo «Todo» | | | |

**Los filtros personalizados no se pueden probar todavía**: son de los grupos,
y la aplicación no tiene aún forma de crear un grupo.
