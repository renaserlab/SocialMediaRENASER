# Productos de Excelencia Z · Incrementos 1 a 3

Qué se construyó, qué se decidió en cerrado y qué sigue esperando a una
persona. Escrito el 12/09/2026.

## 1. Lo que NO es

Productos **no es un marketplace**. Solo se publica lo que Z evaluó y aprobó,
cada producto tiene un responsable comercial identificable, y el catálogo lo
sirve el servidor: la aplicación no decide qué cuenta como publicado. Si lo
decidiera ella, bastaría una versión vieja instalada en un teléfono para que
apareciera algo que Z retiró.

Y **no vende**. No hay carrito, ni pedido, ni existencias, ni envío, ni
devolución, ni transferencia. `feature_product_sales` nace apagada y **no hay
código detrás**: encenderla no haría que se pudiera comprar, solo dejaría de ser
verdad que no se puede.

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

## 3. Las tres migraciones, y en este orden

| Fichero | Qué trae |
|---|---|
| `0070_productos_dominio.sql` | `product_sellers`, `product_categories`, `products`, `product_versions`, `product_variants`, `product_media` |
| `0071_productos_admision.sql` | `seller_applications`, `seller_application_documents`, `product_evaluations`, `product_evaluation_scores`, `product_evaluation_evidence`, `product_approval_reasons` |
| `0072_productos_guardados.sql` | `saved_products` |

**ENTREGADAS SIN APLICAR.** Las tres se escribieron y se probaron en PostgreSQL
16 desechable, incluida su reejecución. Ninguna se aplicó a la base gestionada.

Sin ellas, cada ruta contesta **503 con su propio código** —`products_not_available`,
`product_admission_not_available`, `product_saves_not_available`— y no 404, que
haría pensar que la ruta está mal escrita, ni 500, que haría pensar que algo se
rompió. La portada es la excepción: contesta `disponible: false` con los bloques
vacíos, porque es la puerta de entrada y un error ahí parecería que la
aplicación está rota.

**Tres puertas y no una** porque las migraciones se aplican en orden: con la
0070 puesta el dominio ya funciona aunque la admisión no esté.

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
    products/models.py        las trece tablas
    products/states.py        el ciclo, lógica pura
    products/permissions.py   quién puede qué
    products/esquema.py       las tres puertas de migración
    products/service.py       el ciclo del producto y de su versión
    products/applications.py  la postulación del proveedor
    products/evaluations.py   la matriz, la evidencia y las razones
    products/catalog.py       portada, búsqueda, ficha y guardados
    products/schemas.py       los contratos
    products/router.py        29 rutas

**No existen** `inventory.py`, `carts.py`, `orders.py`, `shipments.py`,
`incidents.py`, `returns.py`, `warranties.py`, `reviews.py`, `performance.py` ni
`finance.py`. La arquitectura los propone para incrementos posteriores, y un
fichero vacío hoy es una capa que hay que mantener sin que haga nada.

`service.py` no está en la lista de la arquitectura y sí en el árbol: lo que
falta ahí es **quién escribe el producto y su versión**, y eso no es catálogo ni
admisión.

## 13. Lo que sigue esperando a una persona

| Qué | Quién |
|---|---|
| Aplicar 0070, 0071 y 0072 en la base gestionada, en ese orden | operación |
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
| Fila de cuatro chips en Explorar (Cursos · Eventos · Servicios · Productos) | producto |

**Sobre el mazo de capturas:** de sus catorce páginas, ninguna es de Productos.
Cubre Cursos, Eventos y Servicios. Lo único que dice de Productos es **dónde va
el acceso**: una fila de cuatro chips bajo el buscador de Explorar. Para la
portada y la ficha la única referencia es el texto del blueprint, y es el que se
siguió.
