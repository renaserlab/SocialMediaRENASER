# Validación de entrega

Comprobaciones ejecutadas antes de empaquetar:

- Validación estática de los archivos TypeScript/TSX con modo estricto y resolución de alias.
- Compilación sintáctica de todos los módulos Python de FastAPI.
- Validación de todos los archivos JSON.
- Revisión básica de la migración SQL: tablas, políticas y RLS.
- Verificación de formatos de imágenes, iconos y audio incluidos.

## Importante

El entorno usado para generar esta entrega no tuvo acceso al registro de paquetes, por lo que no fue posible ejecutar `npm install`, levantar Expo ni descargar las dependencias de Python. La primera ejecución completa debe realizarse siguiendo el README en una máquina con Internet.

Las funciones de pago, transmisión en vivo, autenticación remota y sincronización con Supabase están representadas como flujo de MVP o adaptadores preparados. Para producción deben conectarse proveedores reales, credenciales, políticas, moderación, facturación y pruebas en dispositivos físicos.
