# Productos de Excelencia Z · Incrementos 1 a 8

Qué se construyó, qué se decidió en cerrado y qué sigue esperando a una
persona. Escrito el 12/09/2026, ampliado el 17/09/2026 con el Incremento 4
—fotografías reales, inventario y carrito— y el mismo día con el Incremento 5
—política por jurisdicción, pedido físico y reserva—, el 21/09/2026 con el
Incremento 6 —preparación, despacho y entrega—, el mismo día con el
Incremento 7 —las reclamaciones posventa— y el 22/09/2026 con el Incremento 8:
las valoraciones verificadas.

## Estado, en seis líneas (22/09/2026)

| | |
|---|---|
| **Incrementos 1 a 8** | **terminados.** Dominio y ciclo, admisión y evaluación, catálogo, fotografías, inventario, bolsa, condiciones de venta, pedido con reserva, entrega, reclamaciones y **valoraciones verificadas** |
| **Migraciones 0070–0078** | **aplicadas y verificadas** contra la base gestionada, en sesión de solo lectura y con cero divergencias |
| **Migraciones 0079 y 0080** | **APLICADAS.** La 0079 esta verificada contra la base gestionada en sesion de solo lectura demostrada, con **cero divergencias**; ver §17 |
| **Migración 0081** | **SIN APLICAR.** Probada desde cero y re-ejecutada en PostgreSQL 16 desechable, con el ORM comparado contra el esquema real, y **corregida tras la revisión independiente**: lleva el disparador que impide moderar lo propio. **Se entrega para aplicarla a mano**; ver §16 |
| **Ventas reales** | **apagadas.** `feature_product_sales`, `payments_enabled`, `stripe_payments_enabled`, `PRODUCT_RESERVATION_MINUTES` y la clave de Stripe, las cinco. Y `product_policies` está vacía |
| **Dinero de vuelta** | **no existe.** Una reclamación resuelta dice QUÉ se decidió y deja el efecto en `PENDING`. Nadie lo ejecuta: eso es el Incremento 9 |
| **Siguiente incremento** | **el 9: finanzas y cierre operativo.** Reutiliza `owner_sale_balances`, que desde la 0068 ya admite dos orígenes; hace falta un tercero. Y **la comisión no está decidida** |

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

## 3. Las doce migraciones, y en este orden

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
| `0079_productos_envios.sql` | `product_shipments`, `product_shipment_items`, `product_shipment_events` · **aplicada y verificada** |
| `0080_productos_incidencias.sql` | el depósito `product-incidents`, `product_incidents`, `product_incident_evidence`, `product_incident_events` · **aplicada** |
| `0081_productos_resenas.sql` | `product_reviews`, `product_review_replies`, `product_review_moderation` y tres índices únicos redundantes sobre `product_orders`, `product_order_items` y `product_shipments` · **SIN APLICAR** |

**LAS NUEVE PRIMERAS ESTÁN APLICADAS Y VERIFICADAS.** El 17/09/2026 se comprobaron las
seis primeras contra la base gestionada en una sesión de solo lectura demostrada
—una escritura fue rechazada antes de la primera consulta—: tablas, columnas
contra el ORM, tipos, nulabilidad, claves primarias y ajenas con su `ON DELETE`,
restricciones, índices con su unicidad y su parcialidad, el disparador con su
cuerpo comparado carácter a carácter, RLS activa, cero políticas y cero
permisos para `anon` y `authenticated`. El 18/09/2026 se repitió la misma
verificación sobre la 0076, la 0077 y la 0078. **Cero divergencias en las dos
rondas.**

**LA 0079 Y LA 0080 YA ESTAN APLICADAS.** La 0079 se verifico despues contra la
base gestionada en una sesion de solo lectura **demostrada** —el guardia puesto
con una sentencia explicita, comprobado con `show`, y una escritura de prueba
inofensiva rechazada con `ReadOnlySqlTransaction`— con **cero divergencias**.
Ver §17 y [D136].

Lo que esa verificacion NO demuestra: las tres tablas tienen **cero filas**, asi
que las comprobaciones de huerfanos e incoherencias son ciertas por vacio.

La 0080 sí está aplicada **en el PostgreSQL local de demostración**, que es
donde se comprobó que su bloque de verificación pasa, que las tres tablas
quedan con RLS y sin una sola política, que `anon` y `authenticated` no tienen
ni un permiso, y que el depósito `product-incidents` es privado, con tope de
diez megas y lista de tipos cerrada.

Las cabeceras de los `.sql` ya aplicados siguen diciendo «SIN APLICAR» a
propósito: una migración aplicada no se reescribe, y el estado vive en esta
documentación.

**Y LAS PUERTAS DE ESQUEMA SIGUEN HACIENDO FALTA.** Que la base gestionada las
tenga no significa que las tenga la de al lado: una local, una de pruebas o la
de quien acaba de clonar pueden no tenerlas. Sin ellas, cada ruta contesta
**503 con su propio código** —`products_not_available`,
`product_admission_not_available`, `product_saves_not_available`,
`product_media_not_available`, `product_inventory_not_available`,
`product_cart_not_available`, `product_policies_not_available`,
`product_orders_not_available`, `product_shipments_not_available`,
`product_incidents_not_available`, `product_reviews_not_available`— y no 404, que
haría pensar que la ruta está mal escrita, ni 500, que haría pensar que algo se
rompió.

**Con UNA excepción, y es deliberada: el resumen de valoraciones de la ficha.**
Sin la 0081 contesta un resumen vacío en vez de 503, por lo mismo que la portada:
un bloque de la ficha no puede tumbar la ficha. Ver D153.

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

## 13.4. La entrega: preparar, despachar y que llegue (Incremento 6, 0079)

**Aquí es donde `inventory.despachar` deja de ser código sin llamar.** Era lo
único de los cinco movimientos del almacén que no llamaba nadie, y lo decía el
Incremento 4 con esas palabras.

### Por qué el envío no cabe en `product_orders.status`

Un pedido tiene **cinco cosas que cambian por su cuenta**:

    estado del pedido      ¿existe, sigue vivo, se canceló?
    estado del pago        ¿pendiente, cobrado, fallido, en revisión?
    estado del envío       ¿preparando, despachado, entregado?      <- el nuevo
    estado de incidencia   ¿hay un caso abierto?          (Incremento 7)
    estado financiero      ¿retenido, liberado, devuelto? (Incremento 9)

Meterlas en un solo enum obliga a inventar valores como
`PAID_PREPARING_WITH_INCIDENT`: el número de valores crece **multiplicando** en
vez de sumando, y —peor— al escribir uno se pierde el otro. Un pedido que pasa a
«despachado» no deja de estar pagado.

`product_orders.status` sigue significando dónde está el **cobro** y la 0079 no
le añade ni un valor. Lo vigilan dos cosas: la verificación de la propia
migración y una prueba.

### Un pedido, un paquete, y sale entero

**No hay envíos parciales.** Repartir un pedido en dos paquetes obliga a decidir
quién paga el segundo porte y qué pasa con lo que no salió, y ninguna política
publicada lo dice. Un paquete sale entero o no sale, y el 409 dice qué línea
falta y cuánto.

Esa comprobación vive en **`mover`**, no en la función de cerrar. Estaba en la
función de cerrar y la revisión independiente encontró que se podía rodear por
la ruta de intervención de administración: quedaba un paquete «listo» con la
caja vacía y después un despacho que sacaba unidades que nadie había contado.
*Una invariante comprobada en la puerta y no en el paso se rodea el día que
alguien añade una puerta nueva.*

### La fila del envío nace tarde

No se crea al cobrar: se crea con la primera acción. Un pedido pagado sin fila
se lee como `PENDING`, que es exactamente lo que es. Crearla en el webhook
metería una escritura más en el camino del cobro para no ganar nada, y
`exists: false` distingue «nadie lo ha tocado» de «falta algo».

### La reserva se consume AL SALIR, y exactamente una vez

Al cobrar, las unidades siguen en la caja: la reserva deja de estar sujeta al
vencimiento pero no se suelta ni se despacha. Solo el salto `READY → DISPATCHED`
las saca, y baja **las dos cuentas** —lo que hay y lo comprometido—.

**Tres capas, y cada una para en un sitio distinto.** Se comprobó quitándolas de
una en una y mirando qué prueba se ponía roja:

| Capa | Qué para | Qué pasa si se quita |
|---|---|---|
| El **estado** bajo el cerrojo de la fila | el segundo despacho de dos simultáneos | la prueba de concurrencia se pone roja: el segundo contesta `product_inventory_insufficient` en vez de un éxito tranquilo |
| La **clave de idempotencia** del movimiento, derivada del pedido | el caso en que el mismo SKU tiene unidades apartadas por **otro** pedido | el almacén baja dos veces y se lleva por delante la reserva de otra persona: (6,2) pasó a (4,0) |
| La **aritmética** de `inventory.mover` | que lo comprometido quede negativo | es la última y no depende de este módulo |

`dispatch_settled_at` **no es ninguna de las tres**: es la marca que deja dicho
que esto ya se decidió, y lo que sostiene el CHECK que impide un envío
despachado sin salida de almacén. La primera mutación que se intentó fue
quitarla, y **no puso nada rojo**: por eso hubo que escribir una prueba que baja
hasta el consumo con dos pedidos sobre el mismo SKU, que es el único escenario
en que la clave llega a hacer falta.

### Quién puede qué, y qué no puede nadie

| Quién | Puede | No puede |
|---|---|---|
| Proveedor | preparar, cerrar, reabrir con motivo, **despachar**, registrar entrega y fallo, reintentar | ver un pedido ajeno (404), despachar sin pagar |
| Comprador | ver el seguimiento, **confirmar que lo recibió** | nada que mueva el almacén |
| Administración (`admin`) | reabrir un paquete que no ha salido, registrar un fallo de entrega, registrar un reintento; **siempre con motivo** | **despachar** y **escribir «entregado»** |
| Moderación | leer la cola de envíos sin cerrar | intervenir: 403 |

**Despachar es solo del proveedor** porque es el único que puede afirmar que la
caja salió de su almacén. **Administración no fabrica una entrega**: no tiene
cómo saberlo, y escribirlo arrancaría plazos de posventa que nadie ha cumplido.
**Moderación no entra** porque un envío mueve inventario, que es la misma línea
que ya separa el ajuste de existencias.

### Confirmar que llegó no es dar la conformidad

La diferencia no es sutil. Confirmar que llegó es un hecho de logística; dar la
conformidad es decir que el producto está bien, y en el blueprint §9 eso
**libera el dinero** al proveedor. Lo segundo no existe: no hay transferencias,
ni comisión, ni plazo aprobado. La pantalla lo dice con palabras bajo el botón,
para que nadie confirme creyendo que renuncia a algo o que ha pagado a alguien.

**Se guarda quién afirma la entrega** —`seller` o `buyer`— porque el blueprint
contempla que el transportista la marque y quien compró la niegue, y esa
discusión (Incremento 7) no se puede tener sin saber quién lo dijo.

### El motivo de una entrega fallida NO sale del pedido

Es texto libre que escribe quien vende, y lo primero que escribe cualquiera al
reportar una entrega fallida es **dónde fue y a quién buscaba**. La revisión
independiente lo encontró viajando en dos sitios donde no podía estar: la cola
de envíos de administración —que la lee curaduría— y `audit_events`, que la leen
otros módulos y otras personas.

Hoy vive **solo** en `product_shipment_events`, que es de ese pedido y lo leen
quien compró y quien vende, que ya conocen esa dirección porque es la suya. En
la auditoría compartida queda anotado **que hubo un motivo**, sin decir cuál.

### Cancelar un pedido pagado no se puede, y se dice por qué

El salto está declarado en la máquina —con su actor, que es administración y
nadie más— y la liberación del inventario está escrita con su marca y su clave.
El servicio lo para con `product_shipment_cancellation_not_configured` y la
lista de las tres decisiones que faltan: política de reembolso, quién paga el
porte de vuelta y cuándo se repone el stock. *Devolver el dinero no lo decide el
código.*

### Lo que no se inventa, y es la mitad del trabajo

| Lo que no hay | Qué se hace en su lugar |
|---|---|
| Transportista | texto libre opcional; **nulo es «no lo dijeron»**, nunca «N/A» |
| Enlace de seguimiento | ninguno: construirlo exige saber el transportista |
| Fecha prevista de llegada | ninguna: exige plazos de transporte que nadie fijó |
| Coste de envío e impuestos | ninguna línea: un cero es una promesa de envío gratis |
| «Atrasado» | **el tiempo transcurrido**, que es un hecho: ninguna política publica un plazo de despacho |
| Reposición automática | ninguna: dónde está una unidad no entregada es inspección de posventa |

### Lo que queda sin pantalla, a propósito

`POST /admin/products/shipments/{order_id}/transition` existe, está probada y
exige motivo, pero **no tiene pantalla**. Lo único que administración puede
hacer con ella también lo hace quien vende desde la suya, y cuándo escala una
cosa a la otra es una decisión operativa que nadie ha tomado. Un método de
cliente sin pantalla detrás es código muerto que parece una función.

### Una limitación conocida de los avisos

Un **segundo** intento de entrega fallido del mismo pedido no vuelve a sonar: la
barrera anti-repetición deduplica por `(persona, tipo, pedido)`. Aflojarla haría
que un webhook reintentado avisara dos veces del mismo hecho y rompería el
enlace del aviso al pedido. Entre callar una repetición y gritar dos veces lo
mismo, se calla; el estado del pedido lo dice entero cuando se abre.

## 13.5. La reclamación: qué llegó mal, y quién decide (Incremento 7, 0080)

Alguien recibe el paquete y algo no está bien. Esto es el expediente de eso.

**Dos frases lo gobiernan todo, y están escritas en las pantallas, no solo
aquí:**

* **Abrir no es aprobar.** Abrir un caso anota que alguien *dice* que algo llegó
  mal. No le da la razón, no descuenta nada y no avisa a nadie todavía.
* **Resolver no es pagar.** Una resolución dice **qué se decidió**. El efecto
  financiero nace `PENDING` y **nadie lo ejecuta**: no hay ni una línea que
  llame a un adaptador de reembolsos, porque ese adaptador es del Incremento 9.

### Las tres tablas

| Tabla | Qué guarda |
|---|---|
| `product_incidents` | el caso: de qué pedido y de qué línea, por qué, la descripción, el estado, los plazos, la propuesta del proveedor y la decisión de Z |
| `product_incident_evidence` | las fotografías, por su ruta privada y su huella. **Solo se añaden** |
| `product_incident_events` | el historial. **Solo se añade** |

Los dos «solo se añade» los imponen disparadores, no la buena voluntad del
código. Aquí pesa más que en ningún otro sitio: esto es lo que se mira cuando
dos personas cuentan lo mismo de dos maneras.

### El recorrido

1. **Se abre.** Uno de ocho motivos —siete del blueprint §10 más «consta
   entregado y no lo recibí»—, una descripción de 20 caracteres como mínimo y,
   salvo en ese último motivo, la línea del pedido de la que se habla.
2. **Se le cuelgan las pruebas.** De 2 a 6 fotografías. El archivo viaja a la
   API, que mira los bytes de verdad y decide el nombre.
3. **Se envía.** Aquí —y no al abrir— el proveedor recibe el aviso y empiezan a
   correr sus 48 horas, que el blueprint cuenta «desde la notificación». Antes
   de esto **el proveedor no ve el caso**: un borrador no es suyo todavía, y su
   descripción cuenta lo que le pasó a alguien en su casa.
4. **El proveedor responde**: propone una de las cinco salidas, o pide más
   pruebas, lo que **para su reloj** mientras espera.
5. **Z decide.** Registra la resolución con su explicación. El efecto queda
   pendiente.
6. **Se puede apelar una vez**, dentro de 48 horas y con pruebas **nuevas**
   —posteriores a la resolución—. Si alguien gastó las seis fotografías antes de
   que se resolviera su caso, las dos reglas del blueprint chocan y el salto
   **deja de ofrecerse** en vez de prometerse y fallar: si el tope de seis
   cuenta el expediente entero o solo la reclamación inicial es una decisión que
   nadie ha tomado. Ver D131 y §14.

Y el silencio **no cierra nada**: pasa a mediación, no a rechazado. Cuando eso
ocurre **se avisa a las dos partes**, porque es el único paso del expediente que
sucede sin que nadie lo pida.

**UN CASO NO SALE DE `OPEN` SIN SUS FOTOGRAFÍAS**, y la comprobación vive en
`mover`, que es la única puerta. Tenerla solo dentro de `enviar` dejaba
esquivarla pidiendo mediación —lo encontró la revisión independiente, D128—.
Retirar el propio borrador sí se puede: obligar a documentar una reclamación que
ya no se quiere hacer no protege a nadie.

### Los siete estados, y por qué son suyos

`OPEN`, `MORE_EVIDENCE_REQUESTED`, `SELLER_RESPONDED`, `MEDIATION`, `RESOLVED`,
`APPEALED`, `WITHDRAWN`. Es la cuarta máquina del pedido, y no un valor más de
las anteriores: un caso vivo tiene que poder bloquear acciones del envío sin que
escribir el estado del caso pueda perder el del paquete. El bloque de
verificación de la 0080 falla si algún estado de incidencia aparece en los CHECK
de `product_orders` o `product_shipments`.

### Quién puede qué

| | Comprador | Proveedor | `admin` | Moderación |
|---|---|---|---|---|
| Abrir, probar, enviar, retirar | **sí** | no | no | no |
| Proponer una salida, pedir más pruebas | no | **sí** | no | no |
| Pedir que lo mire Z | **sí** | no | **sí** | no |
| **Registrar la decisión** | no | no | **sí** | **no: 403** |

**El proveedor propone; resolver es solo de Z.** Las cinco salidas mueven
dinero, mueven mercancía o niegan la reclamación, y ninguna la decide en
solitario quien tiene el conflicto. No existe ninguna ruta de proveedor que
escriba `resolution`, y hay una prueba que recorre las rutas para que siga sin
existir. Y quien resuelve es `FINANCE_ROLES` —`admin` a secas—, no `is_admin`:
moderación cura contenido y aquí recibe 403.

### Lo que este módulo NO hace, y se ejecuta

**No importa `inventory`.** Dónde está una unidad dañada lo decide una persona:
reponerla al resolver la pondría a la venta estando en casa de alguien. Una
prueba recorre el árbol de sintaxis de `incidencias.py` y falla si aparece el
import.

**No mueve dinero ni guarda un importe.** Ni cuánto se devuelve ni cuánto se
pagó: el molde del servidor no trae ninguna cifra, y una prueba lo comprueba
para que si alguien la añade haga falta una decisión en vez de que aparezca
sola.

**No da fecha para la decisión de Z.** El blueprint dice «tres días hábiles», y
«hábil» depende de un calendario de festivos que nadie ha definido. El caso se
enseña «en revisión» y la pantalla explica por qué no hay fecha.

**No deja confirmar una recepción mientras hay un caso vivo.** Quien dice que no
le llegó el paquete no puede a la vez decir que sí.

### El plazo para reclamar, que sí existe

`incident_report_hours` de la política publicada que quien compra aceptó,
congelada en el pedido por su `policy_id` y su versión. Se cuenta desde la
entrega —o desde que se supo que el paquete no iba a llegar—. **No es un plazo
inventado: es el que la empresa publicó**, y el CHECK de la 0077 no deja
publicar una política sin él. Se lee la del pedido y no la vigente hoy:
acortársela después le quitaría un derecho que ya tenía.

### Un solo caso vivo, con dos índices

En PostgreSQL los nulos no chocan entre sí, así que un único índice sobre
`(order_id, order_item_id)` no habría impedido dos «no me llegó» sobre el mismo
pedido. Son dos índices únicos parciales: uno por línea y otro por pedido.

### Las pruebas, en su propio depósito

`product-incidents`, separado de `product-media`. Aquel se firma para cualquiera
que mire un producto; esto son las fotos del salón de quien compró. Lista de
tipos cerrada —sin `image/*`, que dejaría pasar SVG—, el servidor decide el
nombre, mira los bytes abriendo la imagen, y las URL se firman al pintar y no se
guardan. **Ni siquiera quien la subió puede quitarla después.**

### El texto libre no sale del expediente

La descripción la escribe quien reclama y suele llevar dentro dónde vive.
Aparece en el expediente —que leen las tres personas que ya conocen el caso— y
en ninguna lista: ni en la del comprador, ni en la del proveedor, ni en la cola
de Z. Es la misma corrección que la revisión del Incremento 6 encontró en el
motivo de una entrega fallida, aplicada antes de que volviera a pasar.

### La escalada por silencio se lanza a mano, y es a propósito

No hay temporizador dentro de FastAPI: la API puede correr con varias réplicas y
se ejecutaría una vez por cada una. Hay una ruta de administración
**idempotente** —dos llamadas seguidas devuelven cero la segunda—, igual que el
vencimiento de reservas, y se lanza desde la pantalla de administración hasta
que exista un planificador externo. Eso sigue esperando a una persona: ver §14.

### Las seis pantallas, y desde dónde se llega

| Pantalla | Ruta | Se llega desde |
|---|---|---|
| Reportar un problema | `/productos/pedidos/[orderId]/reportar` | la ficha del pedido, una vez entregado |
| El expediente | `/productos/reclamaciones/[incidentId]` | la ficha del pedido, que pinta sus casos |
| Reclamaciones de mi tienda | `/proveedor/reclamaciones` | «Mis productos» |
| Responder una | `/proveedor/reclamaciones/[incidentId]` | esa bandeja |
| Reclamaciones por revisar | `/admin/productos/reclamaciones` | administración de productos |
| Decidir una | `/admin/productos/reclamaciones/[incidentId]` | esa cola |

**Ninguna funciona solo escribiendo la URL**, y hay pruebas que lo comprueban.
El resumen de los casos viaja **dentro del pedido**, por lo mismo que ya viajaba
el envío: quien reclamó tiene que ver su caso donde está el pedido del que
habla.

## 13.6. La valoración: quién opinó, y por qué se le cree (Incremento 8, 0081)

Llegó el paquete y quien lo compró cuenta qué tal. Esto es eso, y lo que lo hace
distinto de una reseña cualquiera es **por qué se le cree**.

**Dos frases lo gobiernan todo, y están escritas en las pantallas:**

* **El sello no es un campo.** «Compra verificada» no es una columna que alguien
  pueda escribir: es una consecuencia de que existan las filas que la respaldan.
* **Sin valoraciones no hay puntuación, y no hay un cero.** Un producto sin
  opiniones no puntúa 0,0: no puntúa. Ni cinco estrellas vacías, ni un «0 %».

### La unidad es la línea de pedido

Lo dice el blueprint §6 con todas las letras: «la valoración solo se habilita
para una línea de pedido entregada y no valorada; una compra genera como máximo
una reseña por línea de pedido». No es por producto ni por variante.

Consecuencia buscada: **quien compró lo mismo dos veces, en dos pedidos, opina
dos veces**, porque le llegaron dos cajas en dos momentos y pueden no parecerse.
Y quien compró dos cosas distintas en el mismo pedido las valora aparte: una
sola puntuación para las dos no diría ninguna de las dos verdades.

### El sello, que lo impone la base y no el servidor

Las cuatro condiciones del blueprint —quien compró, pedido pagado, línea de ese
pedido, paquete entregado— las imponen **tres claves ajenas compuestas**:

| Lo que ata | Contra qué |
|---|---|
| `(order_id, author_id, order_paid_at)` | `product_orders (id, buyer_id, paid_at)` |
| `(order_item_id, order_id, product_id)` | `product_order_items (id, order_id, product_id)` |
| `(order_id, delivered_at)` | `product_shipments (order_id, delivered_at)` |

Las columnas del lado hijo son **NOT NULL**, así que la clave tiene que casar:
un pedido sin `paid_at` o un envío sin `delivered_at` no pueden emparejar con
ninguna reseña, y PostgreSQL rechaza el INSERT. **Tres pruebas escriben el INSERT
a mano**, saltándose el servicio entero, y las tres se rechazan igual: sin
entrega, con otro autor y con una fecha de cobro inventada.

Por eso hacen falta **tres índices únicos redundantes** sobre tablas que ya
existían. Son redundantes de verdad —`id` ya es clave primaria en las tres— y
existen solo porque una clave ajena compuesta exige que el lado padre sea único.
Es el precio de que la verificación viva en la base, y es barato.

**Y HAY UN EFECTO DE VUELTA QUE ES EL QUE MÁS IMPORTA.** Mientras exista la
reseña, esas columnas quedan congeladas: nadie puede poner `paid_at` a nulo ni
borrar la fecha de entrega de un pedido ya valorado. Una reseña es evidencia, y
la evidencia ata también lo que la respalda.

**La única de las cuatro que la base NO puede imponer** es «nadie valora lo
suyo»: el dueño está a dos saltos —producto, vendedor, perfil— y un CHECK no
cruza tablas. Vive en el servicio y tiene su propia prueba.

### Las tres tablas

| Tabla | Qué guarda |
|---|---|
| `product_reviews` | la opinión: de qué línea, de quién, las cinco puntuaciones, si lo recomienda, el texto y su estado |
| `product_review_replies` | la respuesta pública de quien vende. **Una visible por valoración**, por índice parcial |
| `product_review_moderation` | el historial. **Solo se añade**, y lo impone un disparador |

**Ninguna fotografía.** El blueprint §6 marca «Multimedia: solo para
incidencia», así que no hay columna de adjuntos ni depósito nuevo, y el bloque de
verificación de la 0081 falla si aparecen. La pantalla lo dice con palabras: si
algo llegó mal, eso es una reclamación y tiene su propio recorrido.

### Las seis respuestas, y que la general no es la media

Cinco puntuaciones de 1 a 5 —general, calidad, se parece a la descripción,
funcionamiento y vale lo que cuesta— más «¿lo recomendarías?». **Las seis son
obligatorias**: es lo que dice la tabla del blueprint §6, columna «Obligatorio».
El comentario no.

**La general NO es la media de los cuatro ejes.** Responde a otra pregunta
—«¿entregó lo que anunció?»— y promediarlas exigiría decidir cuánto pesa cada
eje, que no lo ha decidido nadie. No hay ninguna función que calcule `overall`,
ni en el servidor ni en el móvil, y una prueba lo comprueba recorriendo el
código.

### La puntuación ajustada, y lo que la pantalla admite de ella

Es la fórmula del blueprint §6.1, literal:

    ajustada = (v / (v + 10)) * promedio + (10 / (v + 10)) * promedioCategoria

Sirve para que un producto con una sola reseña de cinco estrellas no aparezca por
encima de uno con doscientas de cuatro y media.

**De dónde sale ese promedio de categoría es una decisión abierta** —ver D148— y
mientras no se tome se usa el 4,2 del propio blueprint. No se calcula uno por
nuestra cuenta: elegir la fuente es la decisión que falta. Lo que sí se hace es
decirlo, y la pantalla escribe que la puntuación se ajusta con una referencia
general.

**Y con cero reseñas no se publica.** Con `v = 0` la fórmula devuelve el promedio
de categoría entero: una cifra sobre la categoría, no sobre este producto.

### Quién puede qué

| | Comprador | Proveedor | `admin` | Moderación |
|---|---|---|---|---|
| Valorar una compra suya | **sí** | no | no | no |
| Editar lo que escribió | **sí** | no | no | no |
| Responder en público | no | **sí, una vez** | no | no |
| Esconder y restaurar | no | no | **sí** | **sí** |
| Reescribir una valoración | **no, nadie** | **no** | **no** | **no** |

**Nadie reescribe lo que escribió otra persona**, y no es una regla de rol: no
existe ninguna ruta que lo permita, y una prueba recorre el árbol de sintaxis del
servicio exigiendo que las únicas funciones que escriban sean `editar` y las dos
de moderar. El blueprint §15 lo dice de Mediador Z —«no puede editar la reseña
del comprador»— y aquí vale para todo el mundo.

**Y NADIE MODERA LO SUYO.** Es la misma regla que gobierna evaluar y publicar
desde el Incremento 2 —«nadie evalúa ni publica su propio producto, ni siendo
administrador»— y **faltaba aquí**: `profiles.role` incluye `moderator`, así que
a un proveedor al que se le diera rol de curaduría le bastaba la ruta de
moderación para enterrar todas las valoraciones malas de su catálogo. Lo encontró
la revisión independiente, y era el único bloqueante del incremento.

Se cierra en **dos capas**: la ruta lo comprueba **antes que el rol** —para dar
el motivo de verdad y para que relajar el rol no abra la puerta— y un
**disparador** de la 0081 lo impone en la base, que es la capa que no se
esquiva. Un CHECK no servía: el dueño está a dos saltos y un CHECK no cruza
tablas. Cada capa tiene su propia prueba y su propia mutación.

Moderar es `is_admin` —curaduría mira contenido— y responder exige **capacidad
comercial activa**: un proveedor suspendido no publica respuestas. Lo encontró
la batería de mutaciones, porque la comprobación de propiedad ya tapaba el caso
del proveedor ajeno y nadie miraba el del suspendido.

### Lo que este módulo NO hace, y se ejecuta

**No importa `pagos`, ni `finanzas`, ni `inventory`.** Una valoración no mueve un
céntimo y no toca el almacén. Una prueba recorre el árbol de sintaxis de
`resenas.py` y falla si aparece cualquiera de esos imports.

**No calcula el índice de permanencia.** Tres de sus siete componentes
—devoluciones atribuibles, reclamos válidos y garantías atendidas— no existen
hasta el Incremento 9, y ese número mueve ventas: de él dependen suspender y
retirar un producto. Ver D154.

**No publica el nombre de quien opinó.** Viaja el identificador del perfil y nada
más, igual que en las reseñas de evento. Ver D143.

**No avisa a nadie.** El blueprint §9 lista notificaciones obligatorias para el
dinero y los plazos, y ninguna para las valoraciones. Ver D155.

### La paginación, y por qué no es un número de página

El cursor es `(created_at, id)`. Con un desplazamiento numérico, una valoración
nueva mientras alguien lee corre todas las demás una posición: la página
siguiente repite una fila y se salta otra. El `id` desempata porque dos
valoraciones pueden compartir el mismo instante.

Hay una prueba que lo demuestra de verdad: cuatro personas distintas compran el
mismo producto, se pide una página de dos, **entra la cuarta entre las dos
páginas** y se comprueba que la segunda no repite ni se salta nada. Moverlas de
producto con un `update` para montar la prueba no vale: la clave ajena compuesta
lo rechaza, que es justo lo que tiene que hacer.

### Contra el N+1

El resumen de varios productos son **dos consultas**, no dos por producto, y hay
una prueba que las cuenta interceptando el cursor. Las respuestas de una página
de valoraciones se leen **en lote**: preguntar la de cada una serían veintiuna
consultas para pintar veinte opiniones.

### Esconder se puede deshacer, y por eso la cola tiene dos lados

La primera versión traía solo las visibles, con el índice parcial a juego. Eso
convertía esconder en una decisión **de un solo sentido**: una valoración
escondida por error no se podía volver a encontrar sin haber apuntado su
identificador a mano, y el botón de «volver a mostrar» de la pantalla era código
muerto, porque el estado que leía era siempre `visible`. Lo encontró la revisión
independiente.

Hay dos colas y dos índices, y la pantalla cambia de lado con un botón.

### Y las tres bandejas paginan

También lo encontró la revisión: solo la lista pública tenía cursor. Las otras
tres —lo que opinan de mi tienda, la cola de moderación y las mías— topaban en
veinte sin forma de pedir más, así que un proveedor con más de veinte
valoraciones no podía responder las demás y quien moderara no podía trabajar más
allá de las veinte más nuevas. Las cuatro usan ahora el mismo cursor.

### El candado de fila, y las dos carreras que cerró

Sin él pasaban dos cosas, las dos reproducidas por la revisión:

1. **Editar mientras se modera.** El moderador acababa escondiendo un texto
   distinto del que juzgó, con un motivo que ya no se refería a nada.
2. **Dos moderaciones a la vez.** El historial —que un disparador protege para
   que solo se añada— guardaba dos veces el paso `visible → hidden`, con dos
   actores y dos motivos, cuando solo hubo una transición. Quien auditara después
   no podía distinguir «se escondió dos veces» de «dos personas pulsaron a la
   vez».

`editar`, `moderar` y `moderar_respuesta` leen la fila **con candado**, y las dos
pruebas usan una barrera: comprueban que la segunda tarea **se queda esperando**,
que es lo único que demuestra que el candado existe.

### La puntuación que se enseña, y la que no

El blueprint manda enseñar la ajustada, y se enseña. Lo que la primera versión
hacía además era **dibujar estrellas redondeándola**, y eso miente con pocas
valoraciones: una sola de UNA estrella daba 3,9 y encendía **cuatro**, porque el
91 % de esa cifra es la referencia general que nadie ha decidido. Lo encontró la
revisión independiente.

Fuera las estrellas del resumen —la captura pide un número y un recuento, no
estrellas— y dentro **la puntuación real al lado**. Las estrellas de cada persona
siguen en su valoración, donde son suyas.

### Las cinco pantallas, y desde dónde se llega

| Pantalla | Ruta | Se llega desde |
|---|---|---|
| Valorar lo que compré | `/productos/pedidos/[orderId]/valorar` | la ficha del pedido, una vez entregado y si queda algo por valorar |
| Mi valoración | `/productos/resenas/[reviewId]` | la ficha del pedido, y al publicar |
| Lo que opinan | `/productos/[productId]/resenas` | el bloque de valoración de la ficha |
| Lo que opinan de mi tienda | `/proveedor/resenas` | «Mis productos» |
| Valoraciones por revisar | `/admin/productos/resenas` | administración de productos |

**Ninguna funciona solo escribiendo la URL**, y hay pruebas que lo comprueban.

El bloque «Valoración real» de la ficha **estaba reservado desde el Incremento
3** y salía como una línea honesta; ahora tiene datos detrás, y cuando no los
tiene sigue saliendo esa misma línea. Se lee **en su propia petición**: si la
0081 no está aplicada, el resto de la ficha se ve entero.

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
| **Plazo de despacho** (cuántas horas antes de llamar tarde a un paquete parado) | la empresa |
| **Si se puede cancelar un pedido ya pagado**, con qué plazo y en qué casos | la empresa + abogado |
| **Quién paga el porte de vuelta** de una cancelación o devolución | la empresa |
| **Cuándo vuelve al almacén** una unidad no entregada, dañada o devuelta | la empresa |
| Si administración debe poder intervenir un envío desde una pantalla, y cuándo escala | operación |
| **Planificador externo** que llame al barrido de reclamaciones vencidas (hoy se lanza a mano) | operación |
| **Qué significa «tres días hábiles»**: calendario de festivos y jornada | la empresa |
| **Si el tope de seis fotografías cuenta el expediente entero o solo la reclamación inicial** (hoy cierra la apelación a quien las gastó) | la empresa |
| **Cuánto se devuelve** en cada una de las cinco salidas, y quién ejecuta el pago | la empresa + Incremento 9 |
| Comisión de Productos | la empresa |
| Cuenta Stripe Connect del proveedor | la empresa |
| **Fuente del promedio de categoría** (hoy la referencia 4,2 del blueprint, y se dice que es una referencia) | la empresa |
| **Cómo se identifica públicamente a quien opina** (hoy solo el identificador del perfil) | la empresa |
| **Si valorar debe avisar a quien vende, y responder a quien opinó** | producto |
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
| «Valoración real 4,8 · 184 compras verificadas» | **el bloque, con datos de verdad** | ya existe (Incremento 8). Sin valoraciones sigue saliendo la línea honesta |
| «Compra protegida · 3 días para reportar» | el bloque, fuera | no hay entrega ni condiciones |
| Barra fija con «Comprar» | el precio, guardar y **añadir a la bolsa** | existe la bolsa; **no existe la compra** |

La última es la diferencia más visible de todas, y es la que no se disimula. Con
el Incremento 4 la bolsa existe, así que la ficha ofrece **«Añadir a la bolsa»**
—que no dice comprar, ni pagar, ni adquirir en ninguno de los tres idiomas— y la
bolsa termina en un pie que dice con palabras que la compra todavía no está
habilitada. Un botón que prometa pagar sin recorrido detrás cuesta más confianza
que su ausencia.

Y las fotografías **ya no son un marcador**: la primera diferencia con la
captura que se ha cerrado del todo. La segunda es **la valoración real**, que el
Incremento 8 cierra: la ficha enseña la puntuación ajustada, cuántas compras
verificadas hay detrás y qué porcentaje lo recomienda, y cuando no hay ninguna lo
dice en vez de inventarlo. Lo que sigue faltando ahí es el título editorial de
«Selección Z», que no tiene campo.

Y el chip de Explorar ya existía: `AccesosAVerticales` pintaba los cuatro
—Cursos, Eventos, Servicios y Productos— con Productos apagado. Lo único que
hizo falta fue encenderlo.

## 16. Qué se aplicó a mano, y en qué orden

### LA 0081 ESTÁ SIN APLICAR, y es lo único que queda pendiente

**Se entrega para aplicarla una persona.** Qué se comprobó antes de entregarla:

* corre **desde cero** sobre PostgreSQL 16, con las ochenta y una migraciones en
  orden, y el bloque de verificación del final pasa;
* corre **dos veces** sin fallar: se declara re-ejecutable y lo cumple;
* el ORM y el esquema real dicen lo mismo, columna por columna, y esa comparación
  la hace la prueba que ya existía para las anteriores.

**Y no enciende ninguna venta.** Aplicarla solo hace que doce rutas dejen de
contestar 503; sin las cinco banderas, sin clave de pasarela y sin política
publicada no se puede crear un pedido, y sin pedido entregado no hay nada que
valorar.

#### El orden, para la 0081

1. **Comprobar que están la 0070, la 0078 y la 0079.** La 0081 referencia
   `products`, `product_orders`, `product_order_items` y `product_shipments`. Si
   falta alguna, la migración se para sola en la primera clave ajena.
2. **Pegar `supabase/migrations/0081_productos_resenas.sql` entero** en el editor
   de Supabase. El editor lo corre como una transacción: o entra todo o no entra
   nada.
3. **REINICIAR LA API.** No es opcional, por lo mismo que las anteriores: sin
   reiniciar, las rutas de valoraciones siguen contestando **503
   `product_reviews_not_available`** aunque las tablas ya estén. La excepción es
   el resumen de la ficha, que contesta vacío y no 503 —ver D153—, así que **el
   síntoma de no haber reiniciado es que la ficha no enseña valoraciones y las
   demás pantallas dicen que no está desplegado**.

#### Qué comprobar después de la 0081

Lo hace el script, pero por si alguien lo trocea: las tres tablas existen, están
las **tres claves ajenas compuestas** —sin ellas «compra verificada» vuelve a
depender de que el servidor se acuerde—, `order_paid_at` y `delivered_at` son
**NOT NULL** —con una nula la clave se cumple sola y la verificación desaparece
sin ruido—, está la restricción de una valoración por línea de pedido, está el
índice de una respuesta visible, el disparador del historial cubre `update` y
`delete`, no hay ninguna columna de sello escribible ni de adjuntos ni de dinero,
ningún estado de valoración se ha colado en los CHECK del pedido, del envío ni de
la incidencia, y `anon` y `authenticated` siguen con **cero** permisos.

#### El rollback de la 0081, y su límite

    drop table public.product_review_moderation;
    drop table public.product_review_replies;
    drop table public.product_reviews;
    drop function public.product_review_moderation_solo_anadir();

Los tres índices únicos redundantes se pueden dejar puestos: no estorban a nadie
y el día que se vuelva a aplicar la 0081 ya están.

**DESHACER ESTO BORRA LO QUE ESCRIBIÓ GENTE.** Las valoraciones no son datos
derivados: son texto y puntuaciones que escribieron personas sobre lo que
compraron, y no se pueden reconstruir. Quien revierta tiene que decidir antes si
las exporta.

### Y las dos anteriores, que ya están

**YA ESTÁN APLICADAS LAS DOS**, la 0079 y la 0080, en ese orden. Lo que sigue se
conserva porque describe el procedimiento —no lo aplica el código: no hay
herramienta de migración en este proyecto y ninguna entra en una base gestionada
sin que una persona lo decida— y porque **hace falta igual en cualquier otra
base**: una local, una de pruebas o la de quien acabe de clonar.

**EL REINICIO NO ES OPCIONAL Y SIGUE SIENDO UNA ACCIÓN MANUAL.** La puerta de
esquema guarda también el «no» en la memoria del proceso. Un backend que llevara
en marcha desde antes de aplicar las migraciones seguirá contestando **503**
aunque las tablas ya estén: no se apaga solo y no hay forma de comprobarlo desde
aquí. Comprobado en local tras reiniciar; en cualquier despliegue remoto, **hay
que reiniciarlo y comprobarlo allí**.

### El orden

1. **Comprobar que la 0078 está puesta.** La 0079 la necesita —referencia
   `product_orders`— y también la 0070 y la 0074. Si falta alguna, la migración
   se para sola en la primera clave ajena.
2. **Pegar `supabase/migrations/0079_productos_envios.sql` entero** en el editor
   de Supabase. El editor corre el script como una transacción: o entra todo o
   no entra nada, y el bloque de verificación del final lanza una excepción con
   el motivo si algo no quedó como debía.
3. **REINICIAR LA API.** No es opcional. La puerta de esquema cachea también el
   «no» en la memoria del proceso: sin reiniciar, las rutas de la entrega siguen
   contestando `503 product_shipments_not_available` aunque las tablas ya estén.
4. **Pegar `supabase/migrations/0080_productos_incidencias.sql` entero.**
   **Después de la 0079 y no antes**: la 0080 referencia `product_shipments`.
   Crea además el depósito privado `product-incidents`.
5. **REINICIAR LA API OTRA VEZ**, por lo mismo: sin reiniciar, las rutas de las
   reclamaciones siguen contestando `503 product_incidents_not_available`.

### Qué comprobar después

Lo hace cada script, pero por si alguien los trocea.

**De la 0079:** las tres tablas existen, el disparador que congela el historial
está puesto, están los dos CHECK que impiden un despacho sin salida de almacén y
soltar lo ya salido, `product_orders_estado` **no** ha ganado ningún valor de
envío, no hay columnas de coste, impuestos, fecha prevista ni URL de
seguimiento, y `anon` y `authenticated` tienen **cero** permisos sobre las tres
tablas.

**De la 0080:** las tres tablas existen, el depósito `product-incidents` es
privado y con su lista de tipos cerrada, el disparador cubre **tanto** el
historial **como** las pruebas y **tanto** `update` **como** `delete`, están los
**dos** índices únicos parciales —uno por línea y otro por pedido, porque los
nulos no chocan entre sí—, no hay columnas de importe devuelto, referencia,
fecha de devolución ni plazo de decisión, ningún estado de incidencia se ha
colado en los CHECK del pedido ni del envío, y `anon` y `authenticated` siguen
con **cero** permisos.

### Qué NO hace falta encender

Nada. Ninguna de las dos enciende una venta: sin las cinco banderas y sin
política publicada no se puede crear un pedido, sin pedido pagado no hay nada
que preparar, y sin paquete entregado no hay nada que reclamar. Aplicarlas solo
hace que esas rutas dejen de contestar 503; el recorrido sigue sin poder
empezar.

Y la 0080 **no enciende ningún reembolso**, porque no existe ninguno: resolver
una reclamación registra qué se decidió y deja el efecto pendiente.

### El rollback, y su límite

    drop table public.product_shipment_events;
    drop table public.product_shipment_items;
    drop table public.product_shipments;
    drop function public.product_shipment_events_solo_se_anaden();

**Deshacer esto NO devuelve al almacén las unidades que se despacharon mientras
estuvo puesta.** El movimiento de salida vive en `inventory_movements`, que es
de la 0074 y solo se añade: un paquete que salió, salió. Quien revierta tiene
que decidir a mano qué hace con esas unidades, y tiene el historial de
movimientos para saber cuáles son.

Y el de la 0080, que hay que deshacer **antes** que el de la 0079:

    drop table public.product_incident_events;
    drop table public.product_incident_evidence;
    drop table public.product_incidents;
    drop function public.product_incident_solo_se_anade();
    -- delete from storage.buckets where id = 'product-incidents';  -- si está vacío

**Borrar el depósito con archivos dentro falla a propósito.** Son las pruebas de
una disputa y no se tiran sin que alguien lo decida.
