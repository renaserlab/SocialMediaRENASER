"""Z Servicios: el dominio de quien ofrece su tiempo, conocimiento o capacidad.

Monolito modular, igual que Eventos y Productos: Servicios posee sus datos y
sus reglas, y usa las capacidades comunes de Z (identidad, perfiles,
notificaciones, almacenamiento, auditoría) por sus interfaces.

HOY (Incremento 1, Bloque 1A) solo existe la BASE DE LA ADMISIÓN del prestador:
estados y saltos (`states`), tablas (`models`, migración 0086), quién puede qué
(`permissions`), políticas versionadas (`politicas`), la puerta de bandera y de
esquema (`esquema`), los contratos (`schemas`), los casos de uso (`service`) y
las rutas (`router`). Todo apagado por `FEATURE_SERVICES`.
"""
