# Z Excelencia

Red social profesional: publicaciones, mensajería con grupos, transmisiones en
vivo, cursos, eventos, productos y servicios con agenda. Una sola aplicación
para Android, iPhone y web, con servidor propio.

Este archivo es la puerta de entrada. El detalle está en `docs/`.

## Qué hay en el repositorio

```text
apps/mobile          La aplicación (Expo, React Native, TypeScript)
apps/api             El servidor (FastAPI, Python 3.13)
supabase/migrations  Las migraciones de la base de datos, numeradas
infra/aws            Plantillas de CloudFormation y guion de despliegue
docs                 Arquitectura, guías y decisiones
.github/workflows    Comprobaciones y despliegue automáticos
```

## Dónde corre

| Pieza | Dónde |
|---|---|
| Servidor | AWS, desplegado con `infra/aws/` |
| Base de datos, cuentas, archivos y tiempo real | Supabase |
| Aplicación | Se compila con EAS, desde `apps/mobile` |
| Versión web | Vercel, desde la rama `main` |
| Video de las transmisiones | 100ms |

## Requisitos

- Node.js 22.15 o superior y npm 10 o superior.
- Python 3.13 para el servidor.
- Docker, solo para levantar una base PostgreSQL local o construir la imagen.

## Trabajar en un equipo local

```bash
# En la raíz: instala las dependencias de la aplicación
npm install

# La aplicación
npm run mobile

# El servidor, con una base SQLite local
cd apps/api
python -m venv .venv
# Windows: .venv\Scripts\activate    macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Cada parte tiene su `.env.example`. Los archivos `.env` no se suben nunca.

## Pruebas

```bash
# Aplicación: tipos y pruebas (desde la raíz)
npm run mobile:check
npm run mobile:test

# Servidor (desde apps/api); las dependencias de prueba van aparte
pip install -r requirements-dev.txt
python -m pytest
```

Las pruebas del servidor que necesitan PostgreSQL se saltan en local y las
ejecuta GitHub en cada cambio.

## Base de datos

Las migraciones de `supabase/migrations` se aplican **a mano**, en orden, en el
editor SQL de Supabase. Una migración aplicada no se edita: un cambio posterior
es una migración nueva. Después de aplicar una hay que reiniciar el servidor
para que la detecte.

## Cómo llega un cambio a producción

1. Se trabaja en una rama propia.
2. Se abre una solicitud de integración hacia `main`.
3. GitHub ejecuta las comprobaciones (`.github/workflows/ci.yml`).
4. Al fusionar, si cambió algo en `apps/api`, el servidor se despliega solo
   (`.github/workflows/desplegar-aws.yml`).

La infraestructura de AWS solo cambia con `infra/aws/deploy-renaserlab.ps1`.
Guía: `docs/AWS_MIGRACION_RENASERLAB.md`.

## Compilar la aplicación

Siempre desde `apps/mobile`:

```bash
cd apps/mobile
eas build --platform android --profile preview      # APK de pruebas
eas build --platform android --profile production   # AAB para Google Play
```

Guías: `docs/PUBLICAR_EN_GOOGLE_PLAY.md` y `docs/PUBLICAR_EN_APP_STORE.md`.

## Documentación

| Tema | Documento |
|---|---|
| Arquitectura | `docs/ARQUITECTURA.md` |
| Decisiones y requisitos | `docs/Z_REQUISITOS_Y_DECISIONES.md` |
| Despliegue en AWS | `docs/AWS_MIGRACION_RENASERLAB.md` |
| Cursos | `docs/CONTRATOS_CURSOS_V2.md` |
| Eventos | `docs/Z_EVENTOS_ARQUITECTURA.md` |
| Productos | `docs/Z_PRODUCTOS_ARQUITECTURA.md` |
| Servicios | `docs/Z_SERVICIOS_ARQUITECTURA.md` |
| Transmisiones en vivo | `docs/Z_DIRECTOS_100MS.md` |
| Recomendación | `docs/Z_RECOMMENDATION_V1.md` y `docs/Z_RECOMMENDATION_V1_1.md` |
| Pagos | `docs/Z_STRIPE_PUESTA_EN_MARCHA.md` |
| Lo que falta probar en teléfono | `docs/Z_QA_FISICO_PENDIENTE.md` |

Varios documentos son registros por fechas y sus partes más antiguas quedaron
superadas. Si un documento y el código no coinciden, vale el código.

## Seguridad

Antes de traer cambios o compilar, leer `SECURITY.md`.
