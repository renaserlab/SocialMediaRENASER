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
