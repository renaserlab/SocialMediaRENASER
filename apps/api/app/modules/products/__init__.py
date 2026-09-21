"""Productos físicos de Excelencia Z.

NO ES UN MARKETPLACE. Solo se publica lo que Z ha evaluado y aprobado, cada
producto tiene un responsable comercial identificable y el catálogo lo sirve el
servidor: la aplicación no decide qué cuenta como publicado.

QUÉ VIVE AQUÍ YA (Incrementos 1 a 5): dominio y ciclo del producto, admisión y
evaluación, catálogo con fotografías aprobadas, existencias por SKU, bolsa,
condiciones de venta por jurisdicción y pedido con reserva.

QUÉ NO VIVE AQUÍ TODAVÍA: envío, entrega, incidencias, devoluciones, garantías,
valoraciones y transferencias. Son incrementos posteriores.

Y NO SE COBRA. `feature_product_sales` sigue apagada, y ahora SÍ tiene código
detrás: apagada, el checkout contesta 503 con la lista de lo que falta en vez de
fingir que la compra no existe. Hacen falta cinco banderas encendidas, una clave
de la pasarela y una política publicada, y ninguna de esas decisiones la toma el
código.
"""
