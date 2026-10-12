# Seguridad

Este repositorio sufrió tres ataques entre septiembre y octubre de 2026, todos
a través de cuentas de GitHub con permiso de escritura. Lo que sigue son las
reglas que salieron de ahí.

## Cómo fue el ataque

- Un cambio forzado reemplazó la punta de varias ramas por un commit que
  copiaba el autor y el mensaje de uno legítimo.
- El commit escondía código al final de un archivo de configuración que se
  ejecuta solo al compilar o al correr pruebas (`babel.config.js`,
  `postcss.config.mjs`, `vite.config.js`, `jest.config.js`), después de cientos
  de espacios, para que no se viera al abrir el archivo.
- Otra variante usa la carpeta `.vscode` con tareas que se ejecutan al abrir el
  proyecto en Visual Studio Code.
- El código robaba credenciales —entre ellas la sesión de GitHub CLI— y con
  ellas se copiaba a los demás repositorios de esa cuenta.

## Antes de traer cambios o compilar

- No compilar ni instalar un commit que no se ha revisado. Primero `git fetch`,
  después mirar qué viene con `git log` y `git diff --stat`, y recién entonces
  integrar.
- Buscar la marca del ataque, sin ejecutar nada:

  ```bash
  git grep -nE "[[:space:]]{150,}[^[:space:]]" -- "*.js" "*.mjs" "*.cjs" "*.ts" "*.json"
  ```

- Desconfiar de un archivo de configuración que creció sin motivo.
- No fiarse del mensaje de un commit: lo escribe quien lo crea.
- En Visual Studio Code, abrir el repositorio en modo restringido y no permitir
  tareas automáticas.

## Al terminar cada jornada

- Cerrar la sesión de GitHub CLI: `gh auth logout`.
- En GitHub, Settings › Applications: revocar «GitHub CLI» y lo que no se use.
- Revisar las claves de acceso personales, las claves SSH y las sesiones
  abiertas. Lo que no se reconozca se revoca en el acto.

## Reglas del proyecto

- Ningún secreto en el repositorio, en un chat ni en un correo. Los del
  servidor viven en AWS Secrets Manager y se cargan desde un archivo que está
  fuera del repositorio.
- Las variables `EXPO_PUBLIC_` quedan dentro de la aplicación: nunca llevan un
  secreto.
- La clave de servicio de Supabase solo la usa el servidor.
- Toda tabla nueva lleva la seguridad por filas activada. Las que guardan
  dinero, reservas o documentos no admiten acceso directo: solo el servidor.
- Los cobros, la moderación y los permisos de las transmisiones pasan siempre
  por el servidor.
- Verificación en dos pasos en GitHub, Expo, Supabase, AWS y 100ms.
- Después de cualquier incidente se rotan los secretos y se renuevan las
  máquinas.

## Pendiente

- El repositorio es de una cuenta gratuita y no permite proteger ramas: nada
  impide un cambio forzado sobre `main`.
- Revisar periódicamente quién tiene permiso de escritura y retirarlo a quien
  no esté trabajando en el proyecto.
