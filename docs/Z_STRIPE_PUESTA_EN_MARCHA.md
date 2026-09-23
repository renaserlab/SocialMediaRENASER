# Stripe: qué hay que hacer el día que llegue la cuenta

Este documento existe para que encender los cobros **no sea un desarrollo**.
Todo lo que hay debajo es configuración: poner credenciales, registrar una URL,
marcar unos eventos, encender unas banderas y probar. Si al seguirlo hiciera
falta escribir código, es que este documento está mal y hay que corregirlo.

**Nada de lo que hay aquí está hecho.** No hay cuenta de Stripe, no hay
credenciales y todas las banderas financieras nacen apagadas.

---

## 1. Lo que ya está resuelto, para que no se rehaga

| Pieza | Dónde vive | Estado |
| --- | --- | --- |
| Abrir el cobro (Checkout alojado) | `payments/stripe_provider.py` | hecho |
| Verificar la firma del aviso | `payments/stripe_provider.py` · `verificar_firma` | hecho |
| Traducir el aviso a nuestro vocabulario | `payments/stripe_provider.py` · `traducir_evento` | hecho |
| Repartir el aviso entre Cursos, Eventos y Productos | `payments/router.py` | hecho |
| Barrera anti-repetición | índice único `(provider, external_event_id)` | hecho |
| Devolución total | `payments/stripe_refunds.py` · `create_full_refund` | hecho |
| Devolución parcial | `payments/stripe_refunds.py` · `create_partial_refund` | hecho |
| Confirmar una devolución que llegó pendiente | `products/pagos.py` · `_aviso_de_devolucion` | hecho |
| Registrar un contracargo y congelar el saldo | `products/disputas.py` | hecho |

**No se usa el paquete `stripe`.** Solo hacen falta HTTP y HMAC, y los dos ya
están en las dependencias. Una dependencia menos que auditar en la ruta más
sensible del proyecto.

**No hay clave pública.** Checkout es alojado: la sesión se crea en el servidor
y se manda a la persona a la URL que devuelve Stripe. Un formulario de tarjeta
propio arrastraría el cumplimiento PCI entero.

---

## 2. Las variables, con su nombre exacto

Todas van en el entorno del backend. **Ninguna lleva el prefijo
`EXPO_PUBLIC_`**: con la clave secreta se cobra, se devuelve y se consulta
cualquier cobro de la cuenta.

### Credenciales

| Variable | Qué es | Forma |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | clave secreta de la cuenta | `sk_test_…` en pruebas, `sk_live_…` en producción |
| `STRIPE_WEBHOOK_SECRET` | secreto **de ese endpoint** de webhook | `whsec_…` |
| `STRIPE_API_BASE` | base de la API | `https://api.stripe.com`; solo se cambia para apuntar a un doble en pruebas |

**El secreto del webhook es por endpoint.** El de pruebas y el de producción son
distintos, y el de la línea de órdenes (`stripe listen`) es un tercero. Usar el
que no toca hace que todos los avisos se rechacen por firma: es el fallo
correcto, pero desconcierta.

### Banderas

| Variable | Qué enciende | Nace en |
| --- | --- | --- |
| `PAYMENTS_ENABLED` | interruptor general de cobros | `false` |
| `STRIPE_PAYMENTS_ENABLED` | cobrar por Stripe (web) | `false` |
| `FEATURE_PRODUCTS` | mirar el catálogo de productos | `true` |
| `FEATURE_PRODUCT_SALES` | **vender** un producto físico | `false` |
| `PRODUCT_RESERVATION_MINUTES` | minutos que un pedido aparta su inventario | `0` = sin configurar |
| `FEATURE_COURSE_REFUNDS` | garantía y solicitudes de devolución de cursos | `false` |
| `STRIPE_REFUNDS_ENABLED` | **ejecutar** la devolución contra la pasarela | `false` |
| `STRIPE_CONNECT_ENABLED` | cuentas conectadas | `false` |
| `CREATOR_TRANSFERS_ENABLED` | transferir de verdad a quien vende | `false` |
| `FEATURE_EVENT_TICKETING` | tipos de entrada y reservas de eventos | `false` |
| `FEATURE_EVENT_PAYMENTS` | cobrar una entrada | `false` |
| `EVENT_PAYMENTS_PROVIDER` | qué pasarela cobra las entradas | `none` |
| `BETA_FREE_ACCESS_ENABLED` | regalar un curso de pago | `false` |

### Comisión y moneda

| Variable | Qué es | Nace en |
| --- | --- | --- |
| `PLATFORM_FEE_BPS` | comisión en **puntos básicos** (100 = 1 %) | `-1` = **sin configurar** |
| `FEE_RULES_VERSION` | versión de las reglas, congelada en cada venta | `v1` |

`-1` no es cero. Con cero, olvidarse de ponerla haría que Z se quedara con nada
y transfiriera el bruto, y ese error no lo delata ninguna prueba porque el
resultado cuadra. Con `-1` **no se escribe ni un saldo**.

**La moneda no es una variable.** Sale de la política publicada para cada
jurisdicción y viaja congelada en el pedido. Una moneda global sería decidir en
qué cobra un país que todavía no se ha abierto.

### URLs de vuelta

| Variable | Qué es |
| --- | --- |
| `PAYMENTS_RETURN_URL` | a dónde vuelve quien pagó |
| `PAYMENTS_CANCEL_URL` | a dónde vuelve quien **canceló** |

Distintas a propósito: mandar a «gracias por tu compra» a quien acaba de
cancelar es mentirle sobre lo que acaba de pasar. **Las pone el servidor**; no
se acepta una URL del cliente. Y la vuelta del navegador **no confirma dinero**:
la pantalla de retorno le pregunta al servidor por el estado.

### Entorno

No hay variable propia. `payments_environment` se deriva de `ENVIRONMENT`:
`production` si el despliegue es de producción, `sandbox` si no. Un aviso de
pruebas **no concede nada** en producción, ni al revés. Una variable más es una
variable más que se puede olvidar, y olvidarla aquí significaría conceder por
una compra de juguete.

### Cuenta Connect

**No hay variable de cuenta conectada, y no hay alta.** `STRIPE_CONNECT_ENABLED`
es un interruptor sin nada detrás todavía: no existe el flujo de alta de la
cuenta de quien vende. Mientras no exista, un saldo que haya cumplido todo lo
demás se queda bloqueado con el código `payout_account_incomplete`, que es la
respuesta honesta.

---

## 3. El webhook

### La URL que hay que registrar

```
{BASE_DE_LA_API}/api/v1/payments/webhook/stripe
```

Uno para pruebas y otro para producción, cada uno con su `whsec_`.

### Los eventos que hay que marcar

Son los que el código traduce. **Marcar de menos es el fallo caro**: un evento
que no llega no produce ningún efecto y nadie se entera.

**Cobro**

- `checkout.session.completed` — la sesión terminó. **No implica cobrado**: con
  métodos de pago diferidos llega con `payment_status` en `unpaid`.
- `checkout.session.async_payment_succeeded` — el pago diferido sí llegó.
- `checkout.session.async_payment_failed` — no llegó.
- `checkout.session.expired` — caducó sin pagar.

**Devolución**

- `charge.refunded`
- `refund.created`
- `refund.updated`
- `refund.failed`
- `charge.refund.updated`

Se escuchan las cinco porque cuál llega depende del método de pago. Un aviso de
devolución **no es** una devolución: solo retira acceso el que está completado y
es total.

**Disputa**

- `charge.dispute.created`
- `charge.dispute.funds_withdrawn`
- `charge.dispute.closed`

**Los tres de disputa son obligatorios.** Sin ellos, un contracargo no se
registra, el saldo no se congela y se puede pagar a quien vende sobre un dinero
que el banco ya retiró. Además, antes de estar en la tabla de traducción
provocaban un `503` que Stripe reintentaba en bucle hasta deshabilitar el
endpoint entero, dejando de entregar también las compras legítimas.

Marcar eventos de más no rompe nada: lo que no está en la tabla se ignora sin
fallar.

### Lo que el endpoint garantiza

- La firma se verifica **antes** de producir ningún efecto, con
  `hmac.compare_digest` y una ventana de cinco minutos.
- Falla **cerrado**: sin secreto, sin cabecera o con firma que no cuadra, se
  rechaza.
- Deduplicación por índice único `(provider, external_event_id)`, no por un
  `if`: dos avisos simultáneos pasarían los dos por una comprobación en Python.
- La barrera **sobrevive al fallo**: lo que se aplica va en un savepoint, así
  que un error deshace el efecto y deja en pie la fila del aviso con su motivo.
- Los avisos se reparten por dominio, y cuando el aviso no trae dominio —un
  `refund.*` o un `charge.dispute.*` llevan metadata propia, vacía si se hizo
  desde el panel— se le pregunta a nuestras propias tablas por la referencia del
  cobro.

---

## 4. El orden de encendido

No se encienden todas a la vez. Cada paso se comprueba antes del siguiente.

1. **Credenciales de PRUEBA.** `STRIPE_SECRET_KEY=sk_test_…`,
   `STRIPE_WEBHOOK_SECRET=whsec_…` del endpoint de pruebas, `ENVIRONMENT`
   distinto de `production`.
2. **Registrar el webhook de pruebas** y marcar los doce eventos.
3. **Decidir la comisión** y ponerla en `PLATFORM_FEE_BPS`. Hasta aquí no se
   escribe ni un saldo, así que este paso va antes de la primera venta o la
   primera venta se queda sin fotografía financiera.
4. **Decidir los minutos de reserva** y ponerlos en
   `PRODUCT_RESERVATION_MINUTES`. El rango admitido es de 1 a 1440.
5. **Encender la compra**: `PAYMENTS_ENABLED=true`,
   `STRIPE_PAYMENTS_ENABLED=true`, `FEATURE_PRODUCT_SALES=true`.
6. **Probar en modo de prueba** la lista del apartado 5.
7. **Encender las devoluciones** cuando el circuito interno esté probado:
   `FEATURE_COURSE_REFUNDS` y `STRIPE_REFUNDS_ENABLED`.
8. **Producción**, después de aprobación: credenciales `sk_live_`, endpoint de
   producción con su propio `whsec_`, `ENVIRONMENT=production`.
9. **Las transferencias, al final y solo si existe el alta de Connect.**
   `STRIPE_CONNECT_ENABLED` y `CREATOR_TRANSFERS_ENABLED` siguen sin nada
   detrás: encenderlas hoy no transferiría nada.

**Reiniciar la API después de cada cambio de variables.** Los ajustes se leen
una vez por proceso, igual que las puertas de esquema.

**Lo que cambia solo, sin tocar código, al encender la venta:** la ficha deja de
decir «en Z todavía no se compran productos» —lo decide el servidor con las
mismas cinco condiciones que la ruta de pago— y la bolsa ofrece continuar.

**Y antes de fusionar a `main`:** el flujo de despliegue ejecuta la batería
entera con PostgreSQL y no publica nada si falta o se omite una sola prueba.

---

## 5. Las pruebas en modo de prueba, una por una

Con las tarjetas de prueba de Stripe. **Ninguna de estas exige escribir código.**

| # | Qué se prueba | Qué tiene que pasar |
| --- | --- | --- |
| 1 | Compra con tarjeta que aprueba | pedido pagado, inventario descontado, saldo escrito con su comisión |
| 2 | Compra con tarjeta que rechaza | pedido fallido, **la reserva sigue viva**, se puede reintentar |
| 3 | Tarjeta con autenticación adicional | el pedido no queda pagado hasta que el aviso lo confirma |
| 4 | Método de pago diferido | `checkout.session.completed` con `unpaid` **no** entrega nada; entrega el `checkout.session.async_payment_succeeded` |
| 5 | Abandonar el checkout | vuelve a `PAYMENTS_CANCEL_URL`, el pedido no queda pagado |
| 6 | Dejar caducar la sesión | `checkout.session.expired`, pedido fallido, reserva intacta |
| 7 | Reenviar el mismo aviso desde el panel | **un solo efecto**; el segundo se para en el índice único |
| 8 | Aviso con la firma manipulada | rechazado, sin efecto |
| 9 | Devolución **total** desde administración | expediente confirmado, saldo cancelado |
| 10 | Devolución **parcial** | sale con `amount`, el expediente guarda el importe, el saldo retiene ese importe |
| 11 | Dos parciales sucesivas | la segunda solo admite hasta lo que queda |
| 12 | Parcial que pasa de lo cobrado | rechazada **antes** de salir a la red |
| 13 | Devolución que Stripe deja pendiente | expediente en curso; lo confirma el `refund.updated` posterior |
| 14 | Reintentar una devolución fallida | misma clave de idempotencia si el fallo fue ambiguo; clave nueva **solo** si fue concluyente |
| 15 | Abrir una disputa desde el panel | se registra, el saldo se congela y el importe queda apartado |
| 16 | Cerrar la disputa ganada | deja de bloquear |
| 17 | Cerrar la disputa perdida | queda anotada la responsabilidad; **no se cobra a nadie** |
| 18 | Dos disputas sobre el mismo cobro | dos filas, cada una con su identificador propio |
| 19 | Liberar con una reclamación abierta | **no se libera**, y dice por qué |
| 20 | Liberar sin cuenta de cobro dada de alta | **no se libera** |

**Nada de esto se hace contra la cuenta real** hasta que la empresa lo autorice.

---

## 6. Lo que sigue sin existir, y no lo trae Stripe

Encender los cobros **no** cierra estas decisiones, que son de la empresa:

- **Transportista, tarifas de envío, zonas y quién paga el envío.** Sin esto, el
  Incremento 6 no es un entregable comercial terminado.
- **Impuestos y entidad legal que emite el comprobante.**
- **Política de devoluciones de productos**: si el dinero vuelve, si la
  mercancía también, y quién paga el retorno.
- **Quién absorbe el coste de un contracargo perdido.**
- **El alta de cuenta de Connect**, sin la cual no se transfiere nada.
- **Plazo de protección** por jurisdicción, que es lo que decide cuándo un saldo
  se puede liberar.

---

## 7. Cómo se vuelve atrás

Apagar `STRIPE_PAYMENTS_ENABLED` y `FEATURE_PRODUCT_SALES` detiene **cobros
nuevos** y no toca una sola fila. Lo ya cobrado sigue: los avisos verificados de
un cobro ya abierto se siguen atendiendo a propósito, porque rechazarlos dejaría
a quien pagó sin su pedido y a Stripe reintentando en bucle.

Apagar `STRIPE_REFUNDS_ENABLED` detiene la ejecución contra la pasarela y deja
el circuito interno funcionando: el adaptador falla **en cerrado** y el
expediente queda fallido con su motivo, nunca en «procesando» para siempre.

**Los avisos de disputa no se pueden apagar, y es deliberado.** Un contracargo
se registra y congela el saldo aunque las ventas estén apagadas: no anotarlo
sería la única forma segura de perder ese dinero.
