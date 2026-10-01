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

**Nada de esta sección está comprobado en un teléfono: el QA físico está
pendiente.** Y, a diferencia de los incrementos anteriores, **la 0094 NO está
aplicada** en Supabase: sin ella nada de esto se puede probar fuera de una
base local. Las pruebas automáticas cubren la migración, el dominio, las
carreras contra PostgreSQL, la API, el recorrido con la API real reiniciada
(89 de 89 comprobaciones) y el código de las pantallas
(`Z_SERVICIOS_ARQUITECTURA.md` §98).

Antes de empezar:

- Aplicar la **0094** en la base del QA y verificarla
  (`Z_SERVICIOS_ARQUITECTURA.md` §96–§97), **antes** de arrancar el código
  nuevo, y **reiniciar la API** después: la puerta recuerda el «no».
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
      **privado** y sus archivos no tienen URL pública.

### Accesibilidad e idiomas

- [ ] Con TalkBack y VoiceOver: las opciones de motivo, resultado y efecto se
      anuncian como opciones; el código de asistencia se lee cifra a cifra;
      las estrellas de la reseña dicen su valor.
- [ ] En inglés y portugués no queda ningún texto en español ni códigos
      (`service_…`, `incident_…`), ni un «0,0» donde no hay reseñas, ni
      «devuelto» o «reembolsado» en ningún estado.
