"""Z Servicios: el dominio de quien ofrece su tiempo, conocimiento o capacidad.

Monolito modular, igual que Eventos y Productos: Servicios posee sus datos y
sus reglas, y usa las capacidades comunes de Z (identidad, perfiles,
notificaciones, almacenamiento, auditoría) por sus interfaces.

HOY (Incremento 1) existe la ADMISIÓN DEL PRESTADOR, completa: estados y saltos
(`states`), tablas (`models`, migraciones 0086–0088), quién puede qué
(`permissions`), condiciones versionadas (`politicas`), qué se exige para
enviar y para aprobar (`requisitos`), documentos privados (`documentos`),
credenciales (`credenciales`), el flujo con su historial, envíos congelados y
auditoría (`admision`), los avisos (`avisos`), la puerta de bandera y de
esquema (`esquema`), los contratos (`schemas`), las lecturas (`service`) y las
rutas (`router`). Todo apagado por `FEATURE_SERVICES`.

NO HAY catálogo de servicios, ni reservas, ni agenda, ni pagos: eso es de
incrementos posteriores y ninguna tabla de aquí lo anticipa.
"""
