# Flujo de trabajo

1. Trabajar en una rama propia. La rama `main` es producción.
2. Mantener los cambios pequeños, con su prueba y con tipos estrictos.
3. Antes de subir: `npm run mobile:check`, `npm run mobile:test` y, en
   `apps/api`, `python -m pytest`.
4. Abrir una solicitud de integración hacia `main` y esperar a que las
   comprobaciones automáticas estén en verde.
5. Fusionar. Si cambió algo en `apps/api`, el servidor se despliega solo.

No existe un entorno de ensayo separado: lo que llega a `main` llega a
producción.

## Convenciones

- Los textos visibles van en `apps/mobile/src/i18n`, en castellano del Perú,
  con sus traducciones al inglés y al portugués.
- Las reglas que se pueden probar sin pantalla van en `apps/mobile/src/lib`,
  sin dependencias y con su prueba al lado.
- Todo lo nuevo que mueva dinero o abra un apartado nace apagado, con su
  bandera en `apps/api/app/core/config.py`.
- Una migración aplicada no se edita: un cambio posterior es otra migración.
- Al cambiar algo nativo de la aplicación —un permiso, una biblioteca con
  código nativo, un sonido— se sube `expo.version` en `apps/mobile/app.json`.
- No guardar secretos en Git. Ver `SECURITY.md`.
