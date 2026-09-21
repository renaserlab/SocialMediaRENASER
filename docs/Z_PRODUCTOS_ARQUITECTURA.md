# Productos de Excelencia Z · Incrementos 1 a 5

Qué se construyó, qué se decidió en cerrado y qué sigue esperando a una
persona. Escrito el 12/09/2026, ampliado el 17/09/2026 con el Incremento 4
—fotografías reales, inventario y carrito— y el mismo día con el Incremento 5:
política por jurisdicción, pedido físico y reserva.

## Estado, en cuatro líneas (21/09/2026)

| | |
|---|---|
| **Incrementos 1 a 5** | **terminados.** Dominio y ciclo, admisión y evaluación, catálogo, fotografías, inventario, bolsa, condiciones de venta y pedido con reserva |
| **Migraciones 0070–0078** | **aplicadas y verificadas** contra la base gestionada, en sesión de solo lectura y con cero divergencias |
| **Ventas reales** | **apagadas.** `feature_product_sales`, `payments_enabled`, `stripe_payments_enabled`, `PRODUCT_RESERVATION_MINUTES` y la clave de Stripe, las cinco. Y `product_policies` está vacía |
| **Siguiente incremento** | **el 6: entrega.** Preparación, despacho y entrega del pedido pagado. Es donde `inventory.despachar` deja de ser código sin llamar |

Lo que la verificación del 18/09 confirma: el índice del vencimiento quedó en su
versión corregida —por la reserva y no por el estado—, `inventory_movements` ya
no tiene clave ajena a `profiles`, y `product_policies` está **vacía**. Esto
último no es un fallo: es la regla. Sin política publicada no se vende.

## 1. Lo que NO es

Productos **no es un marketplace**. Solo se publica lo que Z evaluó y aprobó,
cada producto tiene un responsable comercial identificable, y el catálogo lo
sirve el servidor: la aplicación no decide qué cuenta como publicado. Si lo
decidiera ella, bastaría una versión vieja instalada en un teléfono para que
apareciera algo que Z retiró.

Y **sigue sin cobrar**. Desde el Incremento 5 hay condiciones de venta por
jurisdicción, pedido, dirección congelada y reserva de inventario; lo que no hay
es **dinero, envío, entrega, incidencia, devolución ni transferencia**.

`feature_product_sales` sigue apagada, y **ya tiene código detrás**: apagada, el
checkout contesta 503 con la lista de lo que falta en vez de fingir que la
compra no existe. Encenderla sola tampoco bastaría —hacen falta cinco banderas,
una clave de la pasarela y una política publicada y vigente para el país de
entrega—, y la pantalla del carrito enseña el botón de continuar **solo cuando
el servidor dice que se puede**; si no, el pie lo dice con palabras.

## 2. Por qué no se reutilizó `commerce_products`

Esa tabla **no representa un producto físico**: representa el derecho digital
que se compra para acceder a un curso (`kind = 'course_lifetime'`).
Convertirla en catálogo físico mezclaría dos cosas que no comparten ciclo de
vida, ni entrega, ni devolución, y rompería el acceso de quien ya compró un
curso.

Lo que **sí** se reutilizó, entero y sin tocar: perfiles, autenticación,
permisos por rol, auditoría (`audit_events`), almacenamiento, avisos, y los
patrones ya probados en Cursos y Eventos —versiones inmutables con huella,
puertas de esquema, `UPDATE` condicional, 404 para lo ajeno—.

Y **no hay tabla de «creador»**. Un creador es un perfil con una capacidad
comercial añadida, y eso es `product_sellers`. Una tabla aparte crearía una
segunda identidad que se desincroniza del perfil: dos nombres, dos fotos y dos
verdades sobre quién es esa persona.

## 3. Las nueve migraciones, y en este orden

| Fichero | Qué trae |
|---|---|
| `0070_productos_dominio.sql` | `product_sellers`, `product_categories`, `products`, `product_versions`, `product_variants`, `product_media` |
| `0071_productos_admision.sql` | `seller_applications`, `seller_application_documents`, `product_evaluations`, `product_evaluation_scores`, `product_evaluation_evidence`, `product_approval_reasons` |
| `0072_productos_guardados.sql` | `saved_products` |
| `0073_productos_fotografias.sql` | el depósito `product-media` y nueve columnas de `product_media` |
| `0074_productos_inventario.sql` | `product_inventory`, `inventory_movements` |
| `0075_productos_carrito.sql` | `product_carts`, `product_cart_items` |
| `0076_productos_inventario_claves.sql` | quita dos claves ajenas que dejaban una cuenta sin poder borrarse |
| `0077_productos_politicas.sql` | `product_policies` |
| `0078_productos_pedidos.sql` | `product_orders`, `product_order_items`, `product_order_addresses`, `product_order_events` |

**LAS NUEVE ESTÁN APLICADAS Y VERIFICADAS.** El 17/09/2026 se comprobaron las
seis primeras contra la base gestionada en una sesión de solo lectura demostrada
—una escritura fue rechazada antes de la primera consulta—: tablas, columnas
contra el ORM, tipos, nulabilidad, claves primarias y ajenas con su `ON DELETE`,
restricciones, índices con su unicidad y su parcialidad, el disparador con su
cuerpo comparado carácter a carácter, RLS activa, cero políticas y cero
permisos para `anon` y `authenticated`. El 18/09/2026 se repitió la misma
verificación sobre las tres últimas. **Cero divergencias en las dos rondas.**

Las cabeceras de los `.sql` siguen diciendo «SIN APLICAR» a propósito: una
migración aplicada no se reescribe, y el estado vive en esta documentación.

**Y LAS PUERTAS DE ESQUEMA SIGUEN HACIENDO FALTA.** Que la base gestionada las
tenga no significa que las tenga la de al lado: una local, una de pruebas o la
de quien acaba de clonar pueden no tenerlas. Sin ellas, cada ruta contesta
**503 con su propio código** —`products_not_available`,
`product_admission_not_available`, `product_saves_not_available`,
`product_media_not_available`, `product_inventory_not_available`,
`product_cart_not_available`, `product_policies_not_available`,
`product_orders_not_available`— y no 404, que haría pensar que la ruta está mal
escrita, ni 500, que haría pensar que algo se rompió.

La puerta de las **fotografías mira una columna**, no una tabla: la 0073 no crea
ninguna, le añade estado y medidas a `product_media`, y preguntar por la tabla
diría que sí sin que exista nada de lo que hace falta. La portada es la excepción: contesta `disponible: false` con los bloques
vacíos, porque es la puerta de entrada y un error ahí parecería que la
aplicación está rota.

**Una puerta por migración y no una sola** porque se aplican en orden: con la
0074 puesta el inventario ya funciona aunque el carrito no esté, y quien vende
puede seguir cargando existencias mientras tanto.

## 4. Por qué las variantes y la galería cuelgan de la versión

Lo que se publica es una **versión inmutable**, y «lo publicado» incluye las
fotos aprobadas y las opciones ofrecidas. Si colgaran del producto, cambiar una
foto reescribiría en silencio lo que se evaluó y lo que vio quien compró. Una
versión nueva copia las filas que conserva —la misma ruta de almacenamiento, sin
volver a subir el archivo— y eso es barato.

La galería guarda la **ruta** del almacenamiento, nunca una URL: una firmada
caduca, y guardarla haría que la galería dejara de cargar sin que nadie tocara
nada. Hay una validación que rechaza cualquier cosa con `://`.

## 5. Lo que no se trajo, y es deliberado

* **Ningún impuesto, ninguna comisión, ningún transportista y ningún plazo de
  garantía.** La empresa no ha definido entidad legal que vende, países,
  comprobantes, cobertura ni tarifas de envío.
* **Ninguna categoría.** `product_categories` nace VACÍA. Vacía significa que la
  pantalla de categorías no enseña nada, y eso es la verdad.
* **Ningún precio obligatorio.** `price_minor` y `currency` son nulos hasta que
  alguien los escriba, y **nulo no es gratis**: es «sin precio configurado». La
  moneda inicial también es una decisión abierta, así que no hay valor por
  defecto. Un importe sin moneda se rechaza, y lo impone también un CHECK.
* **Ninguna existencia.** Cuántas hay es inventario, y escribir aquí una columna
  `stock` invitaría a venderla sin reservas ni concurrencia.

## 6. El ciclo del producto

    draft → submitted → document_review → sample_requested → evaluation
          → conditionally_approved → approved → published
          → observation → suspended → removed

Es el del blueprint §5, letra por letra. **Dos cosas que el blueprint no dice y
aquí se deciden en cerrado:**

1. **Una evaluación rechazada devuelve el producto a borrador.** La cadena no
   tiene estado «rechazado», y dejarlo parado en `evaluation` sería un producto
   atascado para siempre. Volver a borrador es lo único que le permite corregir
   lo que falló; retirarlo es una decisión aparte y la toma quien administra.
2. **`conditionally_approved` NO PUEDE PUBLICAR.** Qué condiciones exactas se le
   exigen a un producto aprobado con condiciones es una decisión que la empresa
   no ha tomado. No hay salto a `published` desde ahí: hay que volver a evaluar.

**Y `observation` sigue en catálogo.** Observar es vigilar, no esconder.
`suspended` y `removed` no. Retirado **no vuelve**: quitar algo del catálogo y
devolverlo sin que nadie lo mire otra vez es cómo se cuela lo retirado por un
motivo.

## 7. Quién puede qué

La arquitectura nombra «Evaluador Z», «Mediador Z» y «Finanzas Z», pero
`profiles.role` solo tiene `admin`, `moderator` y `user`, y **quién puede ser
evaluador es una decisión que la empresa no ha tomado**. Añadir roles nuevos
sería tomarla por ella, y exigiría una migración sobre una tabla que usa media
plataforma. Así que se reutiliza la separación que ya existe y ya está probada:

| Qué | Quién | Por qué |
|---|---|---|
| Evaluar y admitir | `is_admin` (admin + moderator) | es curaduría |
| Publicar, retirar, suspender | solo `admin` | es autorizar que algo se venda |
| Mover dinero | nadie, todavía | Productos no mueve dinero |

Es el patrón de Eventos (D34): **curaduría puntúa, administración decide**. Y
**ningún permiso financiero por herencia**: cuando Productos mueva dinero pasará
por `puede_mover_dinero`, que es un conjunto aparte y más estrecho.

**Dos reglas que no son de rol y pesan más:**

1. **Nadie evalúa ni publica su propio producto**, ni siendo administrador. Se
   comprueba **antes** que el rol: si se comprobara después, un administrador
   dueño del producto recibiría un 403 genérico en vez del motivo real, y el día
   que alguien relaje el rol la puerta desaparece. Lo impone además un
   disparador de la 0071, porque un `insert` por otra vía no pasa por el código.
2. **Un producto ajeno es un 404, nunca un 403.** Decir «existe pero no es tuyo»
   ya cuenta que existe.

## 8. La matriz de evaluación

Transcrita del blueprint §5.2, no inventada:

| Dimensión | Peso | Evidencia mínima |
|---|---|---|
| Calidad y funcionamiento | 25 | prueba funcional + inspección |
| Diseño y experiencia | 20 | evaluación de uso |
| Utilidad o impacto | 20 | problema y resultado demostrable |
| Durabilidad | 15 | materiales + prueba o garantía |
| Origen y trazabilidad | 10 | fabricante y lote |
| Garantía y servicio | 10 | política + capacidad operativa |

Decisión automática, en **centésimas de punto** para no arrastrar decimales:
`>= 9000` aprobado, `>= 8500` condicionado, menos rechazado.

**Tres reglas que hacen que el sello signifique algo:**

1. **No se decide una aprobación con dimensiones sin puntuar.** Una ausencia
   leída como cero hundiría a un producto bueno; leída como el máximo aprobaría
   uno que nadie miró. `calcular` devuelve `None`, y **`None` no es cero**.
2. **Cada dimensión puntuada necesita evidencia.** La columna «evidencia
   mínima» no es una sugerencia: una puntuación sin nada detrás es una opinión
   con forma de número.
3. **Una falla crítica rechaza y no compensa con puntaje.** Seguridad,
   falsificación, publicidad engañosa, procedencia no verificable, permisos
   faltantes o evidencia manipulada. Lo dice el blueprint y lo impone un CHECK
   además del código; en ese caso **no se guarda puntuación**, porque la
   decisión no salió de ella.

**El peso se congela en cada fila.** La matriz puede cambiar; lo que ya se
decidió no. Es lo que permite explicar una decisión pasada con sus números.

**Y el veredicto lo escribe el SISTEMA.** Que un producto esté aprobado es
consecuencia de una puntuación con evidencia, no de que alguien pulse «aprobar».
La máquina de estados solo admite `evaluation → approved` al actor `system`.

## 9. Las tres razones de aprobación

`product_approval_reasons.evidence_id` es **NOT NULL**, y la evidencia tiene que
ser de esa misma evaluación. Es lo que hace imposible que «Por qué está en Z»
enseñe una frase que nadie respaldó, generada o escrita a mano.

Son **exactamente tres** (§4.1). El tope lo pone un CHECK de posición 1–3; que
estén las tres al publicar lo comprueba el código, porque «todavía voy por la
segunda» es un estado legítimo de un borrador.

## 10. Publicar no es un botón

`service.por_que_no_se_publica` es **una sola puerta** y devuelve un código.
Repartir estas comprobaciones entre la ruta y la pantalla es cómo se publica algo
sin evaluación el día que alguien añade un camino nuevo. Exige, en orden:

1. el producto en `approved` — `product_not_approved`;
2. una versión borrador — `product_version_missing`;
3. **al menos una foto** — `product_media_required` (§3.1: fotografía real
   aprobada; una ficha sin imagen no es una tarjeta, es un hueco);
4. la 0071 aplicada — `product_admission_not_available`;
5. una **evaluación aprobada de esa versión** — `product_evaluation_required`;
6. **exactamente tres razones** — `product_reasons_required`.

Al publicar, la versión anterior se supersede en la misma transacción: el estado
intermedio de «ninguna vigente» o «dos vigentes» no puede existir.

## 11. Lo que el catálogo NO inventa

El riesgo de este incremento no es que falte un dato: es que se invente uno.

| Bloque del blueprint | Qué viaja | Por qué |
|---|---|---|
| Valoración real | `rating: null` | no hay reseñas de productos todavía. No es cero, ni 4,2, ni 4,8 |
| Entrega y devolución | `delivery: null` | no hay transportista, ni cobertura, ni condiciones aprobadas |
| Barra fija de compra | `purchasable: false` | no existe la compra física |
| Indicador de confianza | solo `origin` | recomendación y compras verificadas necesitan reseñas y pedidos; la garantía necesita condiciones aprobadas |
| Selección Z | orden por puntuación de la evaluación aprobada | es un dato verificado; una lista a dedo sería una decisión que nadie ha tomado |
| Elegidos para ti | `personalized: false` | **no hay recomendador de productos**, y llamar «para ti» a lo más reciente sería mentir con el título |

El `categoryAverage = 4.2` del blueprint **no está escrito en ningún sitio**, ni
en el servidor ni en la aplicación.

El sello viaja del servidor con su texto exacto —«Producto de Excelencia Z ·
Evaluado y aprobado por nuestro estándar»— porque es una promesa de la empresa:
si cada pantalla lo escribiera, tres pantallas dirían tres cosas parecidas.

## 12. Los ficheros que existen, y los que no

Se crearon **solo los que tienen lógica usada en este incremento**:

    products/__init__.py      qué es y qué no
    products/models.py        las veintidós tablas
    products/states.py        el ciclo, lógica pura
    products/permissions.py   quién puede qué
    products/esquema.py       las tres puertas de migración
    products/service.py       el ciclo del producto y de su versión
    products/applications.py  la postulación del proveedor
    products/evaluations.py   la matriz, la evidencia y las razones
    products/catalog.py       portada, búsqueda, ficha y guardados
    products/media.py         las fotografías: subir, ordenar, quitar, aprobar
    products/inventory.py     existencias, movimientos y concurrencia
    products/carts.py         la bolsa
    products/politicas.py     las condiciones de venta por jurisdicción
    products/pedidos.py       el pedido, la reserva y la conciliación
    products/pagos.py         el puerto compartido de cobro, para Productos
    products/schemas.py       los contratos
    products/router.py        64 rutas (41 públicas y 23 de administración)

**No existen** `shipments.py`, `incidents.py`, `returns.py`, `warranties.py`,
`reviews.py`, `performance.py` ni `finance.py`. La arquitectura los propone para
incrementos posteriores, y un fichero vacío hoy es una capa que hay que mantener
sin que haga nada.

`orders.py` tampoco existe **con ese nombre**: lo que la arquitectura llama así
es `pedidos.py`, en español como el resto del código.

`media.py` tampoco está en la lista de la arquitectura: lo que faltaba ahí era
**quién recibe el archivo**, y eso no es catálogo, ni admisión, ni ciclo.

`service.py` no está en la lista de la arquitectura y sí en el árbol: lo que
falta ahí es **quién escribe el producto y su versión**, y eso no es catálogo ni
admisión.

## 13. Las fotografías, que ya se ven

**Este era el bloqueo del incremento anterior y está cerrado.** Antes no existía
ningún depósito de productos y quien vendía escribía la ruta a mano: el catálogo
se recorría entero y las imágenes salían como marcador.

Ahora hay un depósito, `product-media` (0073), **privado y sin ninguna política
de almacenamiento**. Al revés que `message-media` —donde la aplicación sube
directamente y las políticas deciden quién puede—, aquí `anon` y `authenticated`
no pueden ni leer ni listar. La única puerta es la API.

**El camino completo, y ninguno de los pasos se salta:**

1. El archivo viaja a la API, no al almacenamiento.
2. Se comprueba de quién es el borrador, y que siga siendo borrador.
3. **Se miran los bytes**: los primeros para descartar barato, y después se abre
   la imagen de verdad, porque una cabecera de JPEG se puede pegar delante de
   cualquier cosa. Tres tipos y ninguno más —JPEG, PNG y WebP—, sin `image/*`,
   que dejaría pasar SVG, que es un documento con scripts.
4. **El nombre lo genera el servidor**: `proveedor/producto/versión/id.ext`. El
   que trae quien sube puede llevar `../`.
5. La fila nace **pendiente**. Subir no es publicar.
6. Quien evalúa aprueba o **rechaza con motivo**.
7. El catálogo firma **solo las aprobadas**, en el momento y con vencimiento.

**Y publicar exige una aprobada.** «Hay fotos y ninguna aprobada» tiene su
propio código —`product_media_not_approved`— porque no es el mismo problema que
no haber subido ninguna: no falta subir nada, falta que alguien las mire.

**Lo que queda por hacer, y no es del servidor:** el depósito solo existe donde
la 0073 esté aplicada. Mientras no lo esté, la subida contesta 503 con su código
y el catálogo se recorre igual, con el texto alternativo donde iría la foto.

## 13.1. El inventario, y por qué cuelga del SKU

`product_inventory` tiene clave `(product_id, sku)` y **ninguna clave ajena a
`product_variants`**. Una variante pertenece a una versión inmutable: publicar la
siguiente crea filas nuevas para las mismas cajas del mismo almacén, y un
inventario colgado de esas filas quedaría huérfano en cada publicación, dejando
el producto agotado sin que nadie hubiera vendido nada. Guardar el número en la
variante tiene el problema contrario: guardar el borrador rehace esas filas.

**Lo disponible no se guarda**: es `on_hand - reserved`. La 0074 no tiene esa
columna, y hay una prueba que lo comprueba.

**La concurrencia la resuelve PostgreSQL.** `select ... for update` sobre la
fila, y la decisión con el número ya bloqueado. No hay ningún `asyncio.Lock`:
hay más de un proceso. Se prueba con el orden fijado a mano —A bloquea, B
espera, A se lleva la última, B despierta y ve que no queda—, porque una prueba
que lance N peticiones puede serializarse sola y pasar sin el bloqueo puesto.

**Y sin fila no es cero.** Un SKU que nadie cargó se contesta con
`product_inventory_not_configured`, no con «agotado».

## 13.2. La bolsa, que no es una compra

`reservar`, `liberar` y `despachar` existen, funcionan y están probadas, **y no
las llama ninguna ruta**: son del checkout. El carrito tampoco las llama, y eso
es una decisión: tener algo en la bolsa no se lo quita a nadie, y una reserva sin
caducidad convierte un carrito olvidado en un producto agotado.

**Los importes los calcula el servidor**, con el precio de AHORA. Lo que se veía
al añadir se guarda solo para **avisar** de que cambió; congelar el precio ocurre
al crear el pedido.

**Y no hay botón de pagar.** `purchasable` viaja siempre en `false`, lo escribe
el molde de la respuesta —no un campo copiado— y la pantalla lo dice con
palabras en el pie.

## 13.3. El pedido, la reserva y por qué todavía no se cobra

**SIN POLÍTICA APROBADA PARA LA JURISDICCIÓN, NO SE VENDE.** No es prudencia
nuestra: el blueprint lo dice —«Si `withdrawalDays` es null, la venta se bloquea
en esa jurisdicción hasta aprobación legal»— y es lo razonable. Una tienda que
cobra sin haber publicado su plazo de desistimiento es una tienda que no puede
cumplirlo. La 0077 lo convierte en una regla de la base: el CHECK
`product_policies_publicada_esta_completa` impide que exista una política
publicada sin plazo de desistimiento, sin plazo de incidencias, sin plazo de
devolución y sin decir quién paga cada porte.

**La política se versiona por país y el pedido la congela.** Guarda el
identificador, la versión y la **huella** del texto: con el identificador se lee
entera, con la huella se demuestra que no se tocó por debajo. Publicar la
versión siguiente no le cambia las reglas a quien ya compró, y aceptar un texto
que dejó de regir entre que se leyó y se pulsó comprar **no vale como
aceptación**: el servidor lo nota y para.

### Qué orden sigue una compra, y por qué ese

1. se bloquea el carrito —es la fila que ordena todo lo de esa persona—;
2. se relee producto, versión, variante, precio, moneda y publicación;
3. se comprueba la jurisdicción y que su política esté publicada y **vigente**;
4. se crea el pedido con TODO copiado: nombres, precios y condiciones;
5. se bloquean las filas de inventario **en orden estable** y se reserva;
6. se confirma la transacción entera;
7. **y solo entonces** se intenta abrir el cobro en la pasarela.

El paso 7 va fuera a propósito: abrir el checkout es una llamada HTTP que puede
tardar segundos, y hacerla dentro dejaría las filas de inventario bloqueadas
esperando a un tercero. Si falla, el pedido existe y sigue pendiente de pago,
que es la verdad; no se queda fingiendo que hay un cobro abierto.

El **orden estable** del paso 5 no es estética. Dos compras que tocan las mismas
dos unidades en orden distinto se abrazan: la primera tiene A y quiere B, la
segunda tiene B y quiere A. Ordenar por `(producto, SKU)` hace que ese abrazo no
pueda formarse. Y se suma por `(producto, SKU)` y no por línea, porque dos
variantes pueden compartir la caja del almacén: reservarlas por separado usaría
la misma clave de idempotencia dos veces y la segunda se tragaría como si fuera
un reintento.

### Todo o nada

Si a la tercera línea le falta una unidad, **no se reserva ninguna**: la
transacción entera se deshace. Medio pedido reservado es inventario apartado por
una compra que nadie va a completar.

### La reserva vive en el pedido, no en una tabla de «holds»

Eventos necesita un hold aparte porque se aparta aforo **antes** de existir el
pedido; aquí el carrito no reserva nada y la reserva nace exactamente con el
pedido. Lo que aparta de verdad es `product_inventory.reserved`, con su
movimiento en `inventory_movements` y su clave de idempotencia.

`reserved_until` dice **hasta cuándo**. `reservation_settled_at` dice **que ya
se decidió**, y es lo que hace que liberar ocurra **exactamente una vez** aunque
lleguen a la vez el vencimiento y una cancelación. Dos capas, y las dos hacen
falta: arriba la marca bajo el cerrojo de la fila del pedido; abajo la clave de
idempotencia del movimiento, que es un índice único de la base y aguanta aunque
dos procesos se colaran a la vez por el primero.

**Pagar no suelta la reserva: la consume.** Las unidades siguen comprometidas
hasta que salgan del almacén —eso es del Incremento 6— y el pedido deja de estar
sujeto al vencimiento.

### La duración de la reserva es una decisión que nadie ha tomado

`PRODUCT_RESERVATION_MINUTES` nace en **0**, y cero significa «sin configurar».
No hay número de fábrica a propósito: cuánto tiempo se le guarda a alguien la
última unidad mientras paga afecta a cuántas ventas se pierden y a cuánto stock
queda congelado, y escribir aquí «15» sería tomar esa decisión en nombre de la
empresa, en silencio y para siempre.

### Un pedido, un proveedor

El blueprint no define checkout conjunto de varios proveedores, y repartir un
cobro entre varios sin que nadie lo haya decidido es inventarse la liquidación.
`seller_id` es `not null` y no hay ninguna columna que admita dos: si el carrito
mezcla, el servidor **pide elegir**.

### El vencimiento no es un temporizador

No hay ningún temporizador dentro de FastAPI, y no es un olvido: la API puede
correr con varias réplicas y un temporizador por réplica es el mismo barrido
ejecutándose tantas veces como procesos haya. Hay una ruta de administración
idempotente —`POST /admin/products/orders/expire`— preparada para un
planificador externo.

### El pago que llega tarde

Ni se cobra en silencio ni se niega en silencio. Si el aviso verificado llega
cuando la reserva ya venció, el pedido pasa a `UNDER_REVIEW` con su motivo y lo
resuelve una persona por `GET /admin/products/orders/review`. Inventarse
unidades para no dar una mala noticia es prometer un producto que otra persona
ya compró.

### Lo que NO se hizo, y es deliberado

Un aviso de devolución o de disputa **se anota y no deshace nada**. Devolver el
importe y deshacer la venta son dos decisiones distintas, y la segunda no existe
todavía: devolución, reembolso y garantía son de los Incrementos 8 y 9, y
ninguna política los ha fijado. Soltar el inventario por iniciativa propia sería
inventarse la política.

Tampoco hay transportista, guía, seguimiento, entrega, conformidad de 72 horas,
incidencia, reseña, saldo del proveedor, comisión ni transferencia. Una columna
vacía «para luego» es una columna que alguien rellena con un cero.

### Cinco defensas, y encender una no basta

Para que un producto se pueda cobrar tienen que darse **a la vez**:
`feature_product_sales`, `payments_enabled`, `stripe_payments_enabled`,
`PRODUCT_RESERVATION_MINUTES` configurado y una clave de Stripe presente. Más
una política publicada y vigente para el país de entrega. Las cinco viven juntas
en `venta_de_productos_habilitada` y en `pedidos.por_que_no_se_puede_vender`,
que devuelve **todas** las que faltan y no la primera: una a una, quien configura
enciende una bandera, lo prueba, vuelve a fallar y no sabe cuántas quedan.

### Qué se reutilizó de pagos, y qué no se duplicó

El adaptador de Stripe, la verificación de firma, la tolerancia de reloj, la
barrera anti-repetición (`payment_events`) y `payment_events.error` como cola de
conciliación. **No hay un segundo cliente de Stripe**, y el webhook compartido
reparte por `metadata.dominio = 'producto'` y, cuando el aviso no lo trae —un
`refund.*` o un `charge.dispute.*` llevan metadata propia, vacía—, preguntando a
nuestra propia tabla por la referencia del cobro.

## 14. Lo que sigue esperando a una persona

| Qué | Quién |
|---|---|
| Entidad legal que vende y emite comprobante | la empresa |
| Países, jurisdicciones, impuestos y comprobantes | la empresa |
| Moneda inicial, y si habrá varias | la empresa |
| Categorías iniciales | la empresa |
| Quién puede ser evaluador (¿un rol propio?) | la empresa |
| Condiciones exactas de una aprobación condicionada | la empresa |
| Transportista, cobertura y tarifas de envío | la empresa |
| Comisión de Productos | la empresa |
| Cuenta Stripe Connect del proveedor | la empresa |
| Fuente del promedio de categoría | la empresa |
| **Publicar la política de venta de cada país** (sin ella no se vende) | la empresa + abogado |
| **Cuántos minutos aparta un pedido su inventario** (`PRODUCT_RESERVATION_MINUTES`) | la empresa |
| Si un carrito con varios proveedores se puede pagar de una vez | la empresa |
| Credenciales de Stripe del entorno que vaya a cobrar | operación |
| Cuántas fotografías admite una versión (hoy cinco, de la captura 6) | producto |
| Cuándo avisar de que quedan pocas unidades | la empresa |
| Título editorial de «Selección Z» (campo nuevo + decisión) | producto |
| Enlace web de un producto, para poder compartirlo | producto |
| El acceso de **Servicios**, el único chip que no lleva a ninguna parte | producto |

## 15. Lo que el mazo de capturas pide y no se pintó

Las capturas 5 (portada) y 6 (ficha) son la referencia visual, y se siguieron
bloque por bloque. Estas cinco diferencias son deliberadas:

| Lo que enseña la captura | Qué se pintó | Por qué |
|---|---|---|
| Un título editorial sobre la imagen de «Selección Z» | el rótulo y las tarjetas | no existe el campo |
| «98 % lo recomienda» / «Garantía 3 años» | el origen | los otros necesitan reseñas o condiciones aprobadas |
| «Valoración real 4,8 · 184 compras verificadas» | el bloque, fuera | no hay reseñas de productos |
| «Compra protegida · 3 días para reportar» | el bloque, fuera | no hay entrega ni condiciones |
| Barra fija con «Comprar» | el precio, guardar y **añadir a la bolsa** | existe la bolsa; **no existe la compra** |

La última es la diferencia más visible de todas, y es la que no se disimula. Con
el Incremento 4 la bolsa existe, así que la ficha ofrece **«Añadir a la bolsa»**
—que no dice comprar, ni pagar, ni adquirir en ninguno de los tres idiomas— y la
bolsa termina en un pie que dice con palabras que la compra todavía no está
habilitada. Un botón que prometa pagar sin recorrido detrás cuesta más confianza
que su ausencia.

Y las fotografías **ya no son un marcador**: la primera diferencia con la
captura que se ha cerrado del todo. Lo que sigue faltando ahí es el título
editorial de «Selección Z», que no tiene campo.

Y el chip de Explorar ya existía: `AccesosAVerticales` pintaba los cuatro
—Cursos, Eventos, Servicios y Productos— con Productos apagado. Lo único que
hizo falta fue encenderlo.
