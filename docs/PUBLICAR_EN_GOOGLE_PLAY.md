# Publicar Z en Google Play — paso a paso

Desde Windows, con la cuenta de Expo de RenaserLab (`owner: renaser`). EAS
compila en la nube: no hace falta Android Studio. Los formularios de Play
Console están en `docs/PLAY_CONSOLE_RESPUESTAS.md` y los textos e imágenes de
la ficha en `docs/FICHA_PLAY_STORE.md`.

> **Por qué hay que compilar ya.** Las apps repartidas hasta el 23/09/2026 llevan
> grabada la API de la cuenta de AWS de Ricardo, que se dio de baja. No hay forma
> de redirigirla: solo funcionan instalando una build nueva. Ver §13 de
> `docs/AWS_MIGRACION_RENASERLAB.md`.

---

## Lo que YA está hecho

| Qué | Dónde |
| --- | --- |
| La API de RenaserLab en los tres perfiles (`development`, `preview`, `production`) | `apps/mobile/eas.json`, vigilado por `src/config/perfilesDeCompilacion.test.mts` |
| `expo-updates` con un canal por perfil; versión de ejecución = `expo.version` | `app.json` y `eas.json` |
| Paquete `com.renaser.zeta`, `targetSdkVersion` 36 (Play pide 35 o más) | `app.json` |
| `versionCode` que sube solo en cada build (`appVersionSource: remote`) | `eas.json` |
| Borrar la cuenta desde la app y desde la web | *Ajustes › Eliminar cuenta* y `/eliminar-cuenta.html` |
| Política de privacidad y condiciones en HTML estático | `/politicas.html` y `/terminos.html` en la web de Vercel |
| `expo-doctor`: 18 de 18; batería del móvil: 3106 de 3106 | — |

---

## Paso 0 — Seguridad de la cuenta de Expo (antes que nada)

Con `expo-updates`, **quien controle la cuenta de Expo puede mandar código a
todos los teléfonos sin pasar por la tienda**, y EAS guarda la clave con la que
se firma la app. Este equipo estuvo expuesto a malware el 23/09/2026.

1. En expo.dev, cambiar la contraseña de la cuenta de RenaserLab y activar
   **2FA**.
2. *Account settings › Access tokens*: revocar los que no se reconozcan.
3. En este equipo, cerrar la sesión vieja y abrir una nueva:

```bash
npx eas-cli@latest logout
```

```bash
npx eas-cli@latest login
```

---

## Paso 1 — Llevar `Edson` a `main`

1. Subir la rama y abrir el PR (`Edson` → `main`).
2. Esperar el CI en verde: `api`, `mobile` y `migraciones`.
3. Fusionar con **«Create a merge commit»** y no borrar `Edson`.

Al fusionar, GitHub vuelve a desplegar la API en RenaserLab y Vercel publica la
web. **Las apps NO se compilan solas:** eso es el paso 3.

---

## Paso 2 — Comprobar la clave de firma (5 minutos)

Los APK que ya están repartidos se firmaron con una clave que guarda EAS. Hay
que **seguir usando esa misma**, o los teléfonos no aceptarán la versión nueva
por encima de la vieja.

```bash
cd apps/mobile
npx eas-cli@latest credentials -p android
```

- Elegir el perfil `production` y comprobar que ya hay un *Keystore*. **No
  generar uno nuevo.**
- *Download credentials*: guardar una copia del keystore **fuera del
  repositorio**, en el gestor de contraseñas o almacenamiento de la empresa.

---

## Paso 3 — Compilar

Desde `apps/mobile` y siempre **desde `main` actualizado**: EAS sube el código
de la carpeta tal como está.

**APK**, para quien ya usa la app mientras llega Google Play:

```bash
npx eas-cli@latest build -p android --profile preview
```

**AAB**, para Google Play:

```bash
npx eas-cli@latest build -p android --profile production
```

Cada build tarda entre 15 y 40 minutos y deja un enlace de descarga en
expo.dev.

**Probar el APK antes de repartirlo**, en un teléfono real:

- instalarlo **por encima** del anterior: si pide desinstalar, la clave no es
  la misma (volver al paso 2);
- iniciar sesión y comprobar que cargan el inicio, un perfil, cursos y
  eventos;
- si algo falla con «no hay conexión», la dirección de la API no es la buena.

Después, mandar el enlace del APK a quienes usan la app.

---

## Paso 4 — Google Play Console

### 4.1 Tipo de cuenta de desarrollador

| Cuenta | Qué pide Google antes de producción |
| --- | --- |
| **Organización** (con D-U-N-S) | Nada extra. |
| **Personal** creada después de noviembre de 2023 | Una **prueba cerrada con al menos 12 personas durante 14 días seguidos** antes de poder pedir acceso a producción. |

Si la cuenta es personal, la prueba cerrada marca el calendario: conviene
empezarla el mismo día que se sube el primer AAB.

### 4.2 Crear la app

*Crear app*: nombre **Z**, idioma español, **App**, **Gratis**. El nombre de
paquete lo fija el primer AAB (`com.renaser.zeta`) y ya no se puede cambiar.

### 4.3 Contenido de la app (bloquea la publicación hasta completarlo)

Todo está respondido en `docs/PLAY_CONSOLE_RESPUESTAS.md`:

- Política de privacidad: `https://social-media-renaser.vercel.app/politicas.html`.
  **Antes de enviar hay que actualizarla con Productos**: dirección de envío,
  teléfono, pedidos y Stripe como encargado del pago. Es un texto legal y lo
  revisa una persona.
- Seguridad de los datos (§1), con las filas nuevas de Productos.
- Eliminación de cuenta: `https://social-media-renaser.vercel.app/eliminar-cuenta.html`.
- *Acceso a la aplicación*: un correo y una contraseña de una **cuenta de prueba**
  que funcione. Sin ella, Google rechaza porque no puede entrar.
- Clasificación IARC, público objetivo (18+) y anuncios (no).
- **Declaraciones de permisos (§7):** fotos y vídeos, con el texto preparado, y
  servicio en primer plano, con un vídeo corto.

### 4.4 Ficha de la tienda

Textos y medidas en `docs/FICHA_PLAY_STORE.md`: icono de 512×512, gráfico
destacado de 1024×500 y un mínimo de 2 capturas.

### 4.5 Primera versión: pruebas internas

*Pruebas › Pruebas internas › Crear versión* y subir el `.aab` del paso 3.

- **Firma de apps de Google Play:** aceptar la opción por defecto. Google guarda
  la clave de la app y la de EAS pasa a ser la «clave de subida».
- Añadir a los probadores por correo y compartirles el enlace de suscripción.

> **Quien tenga el APK instalado tendrá que desinstalarlo una vez** antes de
> instalar desde Play: Google firma con su propia clave y Android no mezcla
> firmas. Los datos están en el servidor: solo hay que volver a iniciar sesión.

### 4.6 Prueba cerrada y producción

Pruebas internas → prueba cerrada (si la cuenta es personal, los 12 probadores
y 14 días) → *Producción › Crear versión* con el mismo AAB → enviar a revisión.
La primera revisión puede tardar de horas a unos 7 días.

---

## Paso 5 — Actualizaciones sin pasar por la tienda (a partir de ahora)

Solo sirve para cambios de **JavaScript** (pantallas, textos, la dirección de la
API). Un módulo nativo nuevo o un permiso nuevo exigen otra build.

> **Peligro: el `.env` local.** `eas update` empaqueta el código **en tu equipo**
> y NO lee el `env` de `eas.json` (eso solo lo usan las builds). El
> `apps/mobile/.env` de desarrollo apunta a `http://localhost:8000`: una
> actualización publicada así dejaría sin servicio a todos los teléfonos.

Una vez, en expo.dev (*Project › Environment variables*), crear para el entorno
`production` las mismas variables `EXPO_PUBLIC_*` del perfil `production` de
`eas.json`. Después, publicar siempre así:

```bash
npx eas-cli@latest update --channel production --environment production --message "Qué cambia"
```

Probar primero en el canal `preview`, con `--channel preview --environment preview`,
sobre el APK interno.

La app descarga la actualización al abrirse y la aplica **la siguiente vez**
que se abre. Una actualización llega a **todas** las builds con la misma
`expo.version` de `app.json` (hoy `1.0.0`).

> **Al cambiar algo nativo** (un módulo nuevo, un permiso, las opciones de un
> plugin) hay que **subir `expo.version`** antes de compilar. Si no, una
> actualización posterior llegaría a builds sin ese módulo y la app se cerraría
> al abrirse. La prueba `perfilesDeCompilacion.test.mts` guarda la lista nativa
> de cada versión y falla si cambia sin subirla.
>
> Se descartó calcularla por huella (`fingerprint`): el 23/09/2026 las dos
> primeras builds fallaron porque la huella local y la de EAS no coincidían.

---

## Paso 6 — Dominio propio (para que esto no se repita)

Con `api.<dominio-de-la-empresa>` apuntando a CloudFront, el próximo cambio de
cuenta será un cambio de DNS. Gracias a `expo-updates`, las apps pasarán a ese
dominio con una actualización del paso 5, sin volver a la tienda. Ver la vía C
en `docs/AWS_MIGRACION_RENASERLAB.md`.

---

## Avisos

- **Compilaciones y actualizaciones tienen cupo** en el plan gratuito de Expo:
  un número de builds al mes y de usuarios activos de actualizaciones. Hay que
  revisar expo.dev/pricing antes de repartir a mucha gente.
- **No compilar en local commits que no se hayan revisado.** EAS compila en la
  nube, pero `npm install` y `expo export` ejecutan código de configuración
  (babel, metro). Ver el incidente del commit `5a5440e`.
- **iOS** tiene su propia guía: `docs/PUBLICAR_EN_APP_STORE.md`. La dirección
  de la API de `eas.json` vale para las dos plataformas.
