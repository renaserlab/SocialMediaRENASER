# RENASER Universo — Estado del proyecto (todo lo trabajado)

> Documento vivo con **absolutamente todo** lo construido: arquitectura, backend,
> app móvil, base de datos, configuración, despliegue y cómo probarlo.
> Rama de trabajo: **`Edson`** (todo subido a GitHub: `renaserlab/SocialMediaRENASER`).

---

## 1. Resumen ejecutivo

Se transformó un prototipo con **datos mock/locales** en una app **multiusuario real**
conectada a **Supabase**, sin alterar el diseño de las vistas. Se implementaron las
**7 fases** del plan (auth, perfil, feed, social, mensajería, catálogo, notificaciones),
todas verificadas contra la base de datos real.

- **Frontend:** React Native + Expo (SDK 54), Expo Router, Zustand. Modo claro/oscuro.
- **Backend:** FastAPI como **monolito modular por dominios** (10 módulos).
- **Datos/identidad:** Supabase (PostgreSQL, Auth, Storage, Realtime).
- **Degradado a demo:** si faltan las claves de Supabase, la app sigue funcionando con
  datos locales (no se rompe).

---

## 2. Arquitectura

```
App (React Native + Expo)
   ├──► Supabase DIRECTO:   Auth (login/registro), Realtime (chat en vivo),
   │                        Storage (subir imágenes)
   └──► Backend FastAPI ──► Supabase PostgreSQL
          (feed, posts, likes, comentarios, seguir/bloquear, búsqueda,
           mensajería, eventos, círculos, cursos, notificaciones, reportes)
```

- **Monolito modular:** un solo despliegue, separado internamente por dominios.
- **Seguridad:** el backend valida el **JWT de Supabase** y toma la identidad del token
  (`current_user.id`); el cliente **nunca** decide el `author_id`.
- **La app no hace CRUD libre** sobre Supabase: las operaciones de negocio pasan por
  FastAPI. Supabase directo solo para auth, subida a Storage y suscripción Realtime.

### Estructura del backend (`apps/api/app/`)
```
core/       config, security (JWT/JWKS), exceptions (envelope uniforme), logging
shared/     database (async, sin create_all en prod), pagination, enums
modules/    identity, profiles, social_graph, content, messaging,
            catalog, communities, learning, notifications, moderation
main.py     factory FastAPI, CORS, /health, registro de routers
```

### Estructura de datos de la app (`apps/mobile/src/`)
```
services/       api.ts (fetch + JWT + errores tipados), supabase.ts, storage.ts, realtime.ts
repositories/   AuthRepository, ProfileRepository, PostRepository, MessageRepository,
                CatalogRepository, NotificationRepository, ReportRepository
mappers/        profileMapper, postMapper, messageMapper, catalogMapper, notificationMapper
store/          useAppStore (feed/estado), useAuthStore (sesión + bootstrap)
screens/        pantallas (diseño original intacto)
```
> Patrón: **Pantalla → Store/Hook → Repository → api.ts/Supabase → Mapper → modelo de vista.**
> Así las vistas no cambian aunque el backend responda otro formato.

---

## 3. Rol de Supabase

| Servicio | Uso |
|---|---|
| **Auth** | Registro, login, sesión (JWT **ES256**, validado por el backend vía **JWKS**). |
| **PostgreSQL** | Única fuente de verdad. 23 tablas + tipos enum + triggers + RLS. |
| **Storage** | Buckets `avatars`, `post-media`, `course-media`, `audio-private`. Subida directa desde el cliente (RLS por carpeta de usuario) + URL firmada para mostrar. |
| **Realtime** | Entrega de mensajes en vivo (`postgres_changes` sobre `messages`). |

- Proyecto: `jbdlqzimfwyrmmatztqu` · región **us-east-1**.
- **Conexión a la BBDD:** vía **Session Pooler (IPv4)** — la conexión directa no resuelve
  por DNS. `postgresql+asyncpg://postgres.<ref>:<pwd_con_%23>@aws-0-us-east-1.pooler.supabase.com:5432/postgres`.
- Claves: `anon/publishable` puede ir en la app; `service_role`/secret **solo backend**.

---

## 4. Endpoints del backend (todos probados)

Base: `/api/v1`. Todo lo protegido requiere `Authorization: Bearer <jwt>`.

**identity**
- `GET /auth/me` — identidad del token.

**profiles**
- `GET /profiles/me` · `PATCH /profiles/me` — perfil propio (con contadores).
- `GET /profiles/search?q=` — buscar por nombre/usuario.
- `GET /profiles` · `GET /profiles/{id}` — listar / perfil público (con `is_following`).

**social_graph**
- `POST|DELETE /profiles/{id}/follow` — seguir / dejar de seguir.
- `POST|DELETE /profiles/{id}/block` — bloquear / desbloquear.

**content (feed)**
- `GET /posts` — feed (autor + contadores + `liked_by_me`/`saved_by_me`), paginado.
- `POST /posts` — crear (con `image_paths`). `GET /posts/{id}` · `DELETE /posts/{id}` (soft delete).
- `POST|DELETE /posts/{id}/like` · `POST|DELETE /posts/{id}/save`.
- `GET|POST /posts/{id}/comments`.

**messaging**
- `GET /conversations` — con otro participante, último mensaje y no leídos.
- `POST /conversations/direct` — chat directo get-or-create.
- `GET|POST /conversations/{id}/messages` · `POST /conversations/{id}/read`.

**catalog / communities / learning**
- `GET /catalog/events` · `POST|DELETE /catalog/events/{id}/reserve` (control de capacidad).
- `GET /catalog/courses`.
- `GET /circles` · `GET /circles/{id}` · `POST|DELETE /circles/{id}/join|leave`.
- `GET /learning/courses/{id}` (módulos+lecciones+progreso) · `POST .../enroll` · `POST /learning/lessons/{id}/complete`.

**notifications / moderation**
- `GET /notifications` · `GET /notifications/unread-count` · `POST /notifications/{id}/read` · `POST /notifications/read-all`.
- Notificaciones se generan al **seguir, dar like y comentar**.
- `POST /reports` · `GET /reports/mine`.

**otros**: `GET /health`.

---

## 5. App móvil — pantallas conectadas al backend

| Pantalla | Estado |
|---|---|
| Registro / Login / Verificación | Auth real de Supabase + fallback demo |
| Editar perfil | `PATCH /profiles/me` |
| Home (feed) | feed real, crear post, **imágenes**, like, guardar, "Ver más", estados |
| PostCard | like/guardar/comentar reales, autor navegable, **reportar** (menú ···) |
| Comentarios (inline y pantalla dedicada) | reales + optimista |
| Explorar | **búsqueda** de personas → perfil |
| Perfil público | datos reales + **seguir** (contadores en vivo), botón **Mensaje** |
| Mensajes / Chat | conversaciones reales + **Realtime** + envío optimista |
| Eventos | lista real + **reservar** |
| Notificaciones | reales + marcar leídas |

> Pantallas de **círculo/curso/lección** usan la capa de andy (UI final + datos mock);
> su backend y datos ya existen — falta hacerlas data-driven (pendiente menor).

### Pantallas y mejoras aportadas por la rama `andy` (integradas)
- **7 pantallas nuevas**: `/search`, `/reels`, `/saved`, `/post/[id]`,
  `/followers/[id]`, `/following/[id]`, `/stories/[id]`.
- **Componentes**: `DoubleTapLike` (doble toque = like, estilo IG), `PeopleList`,
  `ShortVideoItem`, `VideoPlayer` (audio/video reales).
- **Utilidades**: `lib/haptics` (vibración táctil), `hooks/useReduceMotion` (accesibilidad).
- **Mejoras combinadas con la integración real** (no la reemplazan):
  - `HomeScreen`: **FlashList** (scroll performante) + **pull-to-refresh** + stories
    navegables, sobre el feed real (`loadFeed`, paginación).
  - `ExploreScreen`: pull-to-refresh y secciones nuevas, conservando la **búsqueda real**.

---

## 6. Base de datos, migraciones y datos sembrados

- `supabase/migrations/0001_initial.sql` — esquema completo (23 tablas, enums, triggers,
  `handle_new_user`, RLS, buckets de Storage). **Aplicada.**
- `supabase/migrations/0002_realtime_messaging.sql` — habilita Realtime para `messages`
  y `conversations`. **Aplicada.**
- **Contenido sembrado** en Supabase para pruebas: 3 eventos, 1 círculo, 1 curso + 3 lecciones.

---

## 7. Configuración y seguridad

- **Backend `apps/api/.env`** (gitignored): `DATABASE_URL` (pooler), `SUPABASE_URL`,
  `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET` (opcional; se usa JWKS), `CORS_ORIGINS`.
- **Móvil `apps/mobile/.env`** (gitignored): `EXPO_PUBLIC_SUPABASE_URL`,
  `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_API_URL`.
- **Seguridad implementada:** validación JWT (ES256/JWKS + HS256 de respaldo), autor desde
  el token, errores uniformes `{"error":{code,message,details}}`, soft delete, reportar/
  bloquear, RLS en la BBDD, secretos fuera de git.

---

## 8. Despliegue y APK

- **Backend → Render** (listo): `apps/api/Dockerfile` (usa `$PORT`) + `render.yaml`
  (Blueprint). Secretos como `sync:false` (se ponen en el dashboard).
- **APK → EAS Build**: `apps/mobile/eas.json` perfil `preview` (`buildType: apk`) con
  `env` (Supabase + `EXPO_PUBLIC_API_URL`). Proyecto vinculado a la cuenta de empresa **renaser** (`@renaser/z-app`).
  - Comando: `cd apps/mobile && eas build -p android --profile preview`.
  - Un APK standalone **no depende de Expo Go** → el desfase SDK 54 vs Expo Go 57 no aplica.
  - ✅ **Primer APK compilado con éxito** (build en expo.dev/accounts/renaser).
  - Al instalar, **Google Play Protect** bloquea apps sideload de un desarrollador
    desconocido: tocar **"Más detalles" → "Instalar de todos modos"**. Es normal.
  - ⚠️ Tras cada merge con dependencias nativas nuevas (FlashList, expo-image, haptics)
    hay que **recompilar** el APK para que las incluya.

### iOS
La app **ya es híbrida**: un solo código base compila para Android **e iOS**
(`app.json` tiene `bundleIdentifier`, permisos de cámara/micrófono/fotos y soporte tablet).
El obstáculo no es el código sino Apple:
| Vía | Requisito |
|---|---|
| TestFlight / iPhone real | **Apple Developer Program — $99 USD/año** |
| Build de simulador | Gratis, pero solo corre en simulador (requiere Mac) |
Apple no permite sideload de apps sin cuenta de pago (a diferencia de Android).

---

## 9. Historial de fases y arreglos (rama Edson)

1. **Merge inicial `andy`** + alinear dependencias a **Expo SDK 54** / npm workspaces.
2. **Fase 1** — backend monolito modular + Auth (JWT) + errores uniformes.
3. **Fase 2** — auth + perfil reales, login, editar perfil, estados de carga/error.
4. **Fase 3** — feed real, likes, guardados, comentarios, **imágenes (Storage)**.
5. **fix** — tipar columnas enum de Postgres · **fix** — validar JWT por **JWKS (ES256)**.
6. **Fase 4** — grafo social (seguir/bloquear), perfil público, búsqueda.
7. **Fase 5** — mensajería con **Supabase Realtime**.
8. **Fase 6** — eventos (reservas), círculos, cursos (progreso).
9. **Fase 7** — notificaciones in-app + moderación (reportes).
10. **Merge final `andy`** — pulido de UI (audio/video reales), EAS, tipos.
11. **Arreglos de pruebas web:** back seguro (no quedar atrapado), sesión→home,
    canal Realtime único (crash de chat), etc.
12. **Despliegue:** Dockerfile `$PORT` + `render.yaml`; APK vinculado a cuenta propia
    (`renaser`) y **primer APK compilado**.
13. **Segundo merge `andy`** (limpio, sin conflictos): 7 pantallas sociales nuevas,
    microinteracciones estilo IG (doble toque, haptics), FlashList + pull-to-refresh,
    combinado con la integración real existente.

Verificación en cada fase: smoke tests del backend + `tsc --noEmit` del móvil +
validación end-to-end en web contra Supabase real.

---

## 10. Cómo correr todo (desarrollo)

**Backend (local):**
```bash
cd apps/api
./.venv/Scripts/python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8001
```
**Móvil (web para pruebas rápidas):**
```bash
npm --workspace apps/mobile run start -- --web --port 8082   # http://localhost:8082
```
**Typecheck móvil:** `npm --workspace apps/mobile run check`
**Tests backend:** `cd apps/api && ./.venv/Scripts/python.exe -m pytest -q`

---

## 11. Pendientes / próximos pasos

1. **Desplegar el backend en Render** (config lista: `render.yaml` + Dockerfile).
   Sin esto, el APK no carga datos fuera de la red local. `EXPO_PUBLIC_API_URL` ya
   apunta a `https://renaser-api.onrender.com`.
2. **Recompilar el APK** tras el último merge (trae dependencias nativas nuevas).
3. Conectar a fondo las pantallas de **círculo / curso / lección** (backend y datos listos).
4. Conectar al backend las pantallas nuevas de andy que hoy usan mock:
   `/saved` (ya hay endpoint de guardados), `/followers` y `/following`
   (faltan endpoints de listado), `/post/[id]`, `/reels`, `/stories`.
5. **iOS**: requiere Apple Developer Program ($99/año) para dispositivos reales.
6. **commerce** (pagos reales) — fuera del MVP.
7. Opcional: upgrade a **Expo SDK 57** (para Expo Go) y badge de no-leídos en el Home.
