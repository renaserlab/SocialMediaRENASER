# Flujo de trabajo

1. Crear una tarea con criterios de aceptación.
2. Crear rama `feature/nombre-corto` desde `develop`.
3. Mantener cambios pequeños y con tipos estrictos.
4. Ejecutar `npm run mobile:check` y pruebas del backend.
5. Abrir Pull Request con capturas de Android e iOS.
6. Revisión de código obligatoria antes de merge.
7. Probar en `staging` antes de pasar a `main`.

## Convenciones

- Componentes y tipos en inglés; textos visibles en español.
- No guardar secretos en Git.
- No utilizar la service role de Supabase dentro de la app móvil.
- Toda tabla nueva debe incluir RLS y pruebas de permisos.
- Pagos, moderación y generación de tokens deben pasar por backend.
