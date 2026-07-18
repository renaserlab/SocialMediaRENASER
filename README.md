# RENASER Social Media — MVP móvil

MVP funcional inspirado en el diseño entregado. La aplicación es **móvil híbrida real** con React Native + Expo y funciona en Android e iOS desde una sola base de código.

## Incluye

- Landing, quiz de 7 preguntas, resultado, registro local y onboarding.
- Feed social con historias, publicaciones, reacciones, guardados y creación de posts.
- Perfil, exploración, círculos privados, eventos y reservas.
- Audio privado reproducible, curso, checkout simulado y confirmación.
- Mensajería local, chat y sala en vivo simulada.
- Persistencia offline con AsyncStorage mediante Zustand.
- Adaptador preparado para Supabase.
- API profesional base con FastAPI + SQLAlchemy asíncrono.
- Migración inicial para Supabase/PostgreSQL con RLS.
- Docker, CI y configuración EAS para Android/iOS.

## Requisitos

- Node.js 22.13 o superior.
- npm 10 o superior.
- Expo Go para una prueba rápida, o Development Build para trabajo profesional.
- Android Studio para emulador Android.
- macOS + Xcode para simulador y publicación iOS.

## Ejecutar la app móvil

```bash
cd renaser-universo-mvp
npm install
npm run mobile
```

Luego:

- Presiona `a` para Android.
- Escanea el QR con Expo Go.
- En macOS presiona `i` para iOS.

También puedes ejecutar:

```bash
npm run mobile:android
npm run mobile:ios
```

## Ejecutar el backend

### Opción rápida con SQLite

```bash
cd apps/api
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Documentación interactiva: `http://localhost:8000/docs`

### Opción Docker + PostgreSQL

```bash
docker compose up --build
```

## Supabase

1. Crea un proyecto en Supabase.
2. Ejecuta `supabase/migrations/0001_initial.sql` en SQL Editor.
3. Copia `apps/mobile/.env.example` como `.env`.
4. Completa `EXPO_PUBLIC_SUPABASE_URL` y `EXPO_PUBLIC_SUPABASE_ANON_KEY`.
5. Cambia gradualmente los repositorios locales por el adaptador remoto de `src/services/supabase.ts`.

El MVP funciona sin Supabase porque los datos se almacenan localmente. La arquitectura deja listo el camino de migración.

## Flujo de prueba

1. Abrir la app y pulsar **Descubrir ahora**.
2. Completar las siete preguntas.
3. Crear cuenta local.
4. Completar onboarding.
5. Probar feed, crear publicación, reservar evento, escuchar audio, comprar curso y enviar mensajes.

## Compilación Android/iOS

```bash
cd apps/mobile
npx eas login
npx eas build:configure
npx eas build --platform android --profile preview
npx eas build --platform ios --profile preview
```

Antes de publicar, cambia los identificadores `com.renaser.universo` por los definitivos de la empresa y configura credenciales, privacidad, moderación, pagos reales y eliminación de cuenta.

## Estructura

```text
apps/mobile   App React Native + Expo
apps/api      API FastAPI
supabase      SQL y políticas RLS
docs          Arquitectura y referencia visual
```
