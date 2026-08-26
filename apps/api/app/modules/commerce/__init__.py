"""Dominio comercial: productos, ordenes, cobros y DERECHOS de acceso.

Lo que decide si alguien puede ver un curso vive aqui, no en la pasarela. El
proveedor —RevenueCat, Apple, Google, Stripe— valida que hubo un pago; quien
concede el acceso es `entitlements`. Cambiar de pasarela no mueve ni un derecho
ya concedido.

Las tablas las crea `supabase/migrations/0035_comercio.sql` y el acceso lo
recalcula `0036_acceso_v2.sql`. Mientras esas migraciones esperen aprobacion,
este modulo funciona igual: `esquema.py` lo comprueba una vez por proceso, las
lecturas caen al comportamiento de hoy y las escrituras responden 503 en vez de
reventar con un 500.
"""
