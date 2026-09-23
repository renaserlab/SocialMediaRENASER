"""El paquete de pagos.

AQUÍ SE DAN DE ALTA LAS PASARELAS, y no al final de `providers.py`, que es
donde estaban. `providers` define el contrato y `stripe_provider` lo implementa:
cada uno necesita algo del otro, así que registrar desde `providers` creaba un
ciclo y el orden de importación decidía si la aplicación arrancaba.

Python ejecuta este fichero antes que cualquier submódulo del paquete, así que
es el único sitio desde el que se puede tocar a los dos sin que ninguno esté a
medio construir. El registro sigue siendo ANSIOSO: `PROVIDERS` está completo
desde el primer `import`, sin depender de que alguien haya preguntado antes.
"""

from app.modules.payments.providers import registrar_pasarelas

registrar_pasarelas()
