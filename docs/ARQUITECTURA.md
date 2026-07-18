# Arquitectura del MVP

## Frontend móvil

- React Native 0.86 con Expo SDK 57.
- TypeScript.
- Expo Router para navegación por archivos.
- Zustand + AsyncStorage para estado persistente offline.
- Expo Audio para audio nativo.
- Componentes propios con diseño monocromático.

## Persistencia

El modo inicial es `local-first`: todos los datos funcionales del prototipo se guardan en AsyncStorage. El estado persistido incluye usuario, onboarding, respuestas, posts, likes, guardados, comentarios, reservas, compras y mensajes.

## Backend

FastAPI expone endpoints de salud, feed, perfiles, eventos, cursos y mensajes. Usa SQLAlchemy asíncrono y puede trabajar con SQLite para desarrollo o PostgreSQL/Supabase en producción.

## Producción

```text
App Expo / React Native
        |
        +--> Supabase Auth
        +--> Supabase PostgreSQL + RLS
        +--> Supabase Storage
        +--> FastAPI para operaciones sensibles
        +--> Servicio especializado de video/live en una fase posterior
```

## Seguridad pendiente antes de producción

- Autenticación real y renovación de sesión.
- RLS probado por rol y tabla.
- Moderación, reportes y bloqueos.
- Rate limiting y auditoría.
- Eliminación de cuenta y exportación de datos.
- Verificación de compras de Apple/Google.
- Protección de contenido premium.
- Sentry, métricas y backups.
