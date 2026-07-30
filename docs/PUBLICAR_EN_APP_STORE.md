# Publicar Z en la App Store — paso a paso

Escrito para una cuenta de **empresa creada desde cero** (la app pertenece a la
sociedad, no a una persona) y trabajando **desde Windows**.

> **No hace falta un Mac.** EAS compila en servidores macOS de Expo y envia el
> binario a Apple. Todo lo de esta guia sale de Windows. Un Mac solo ahorraria
> tiempo si quisieras depurar en el simulador de iOS.

---

## Lo que YA esta hecho

Nada de esto hay que volver a tocarlo:

- Bloquear usuarios, reportar contenido y eliminar la cuenta desde la app
  (son requisitos de las directrices 1.2 y 5.1.1, y los tres estan resueltos).
- Sin flujos de compra a medias: `FEATURE_PURCHASES = false`.
- Sign in with Apple no aplica, porque no se ofrece ningun login social.
- `/privacy` y `/terms` publicadas y respondiendo.
- Icono 1024x1024 sin canal alfa, `supportsTablet: false`, declaracion de
  cifrado.
- Perfil `production` de EAS listo (`distribution: store`, `autoIncrement`).

**No queda trabajo de programacion.** Lo que sigue son tramites.

---

## El camino critico: el numero D-U-N-S

> **Solo aplica si la cuenta es de Organizacion.** Con cuenta Individual este
> apartado entero se salta y se pasa directo al paso 2. Ver la comparativa al
> final de esta seccion antes de decidir.

Esto es lo primero y lo mas lento. **Empezar hoy.**

Apple exige que una cuenta de **Organizacion** este respaldada por un numero
D-U-N-S, que identifica a la empresa. Es gratuito, lo emite Dun & Bradstreet, y
es el unico paso cuyo plazo no controlas.

1. Comprobar si la empresa ya lo tiene:
   https://developer.apple.com/enroll/duns-lookup/
2. Si no aparece, solicitarlo desde ese mismo formulario.
3. Plazo tipico: **de 5 a 14 dias habiles.** Puede alargarse si los datos de la
   empresa no coinciden exactamente con los del registro mercantil.

**Que hace que se retrase:** que el nombre legal, la direccion o el telefono no
coincidan al caracter con lo registrado. Merece la pena tener a mano la
escritura o el RUC antes de rellenarlo.

### Individual vs Organizacion — la decision que marca el plazo

| | Individual | Organizacion |
|---|---|---|
| D-U-N-S | **No hace falta** | Obligatorio (5-14 dias habiles) |
| Alta | **24-48 h** | +1-2 dias tras el D-U-N-S |
| **Hasta poder subir** | **2-3 dias** | **2-4 semanas** |
| Vendedor visible en la tienda | Nombre personal | Nombre de la empresa |
| Propiedad legal de la app | De la persona | De la sociedad |

**El D-U-N-S es lo unico que convierte esto en un proceso de semanas.** Si la
cuenta va a ser Individual, todo el camino critico desaparece.

### Publicar como Individual y transferir despues

Es una estrategia valida y la mas rapida: se publica ya a nombre personal y,
cuando la empresa tenga su cuenta de Organizacion, se usa **App Transfer** para
mover la app.

Condiciones a tener en cuenta antes de contar con ello:

- La app debe estar **ya publicada**; no se transfiere algo que sigue en
  revision.
- La cuenta que **recibe** debe estar dada de alta y al corriente.
- No todo viaja: los probadores de TestFlight, por ejemplo, se pierden.
- Las reglas de Apple sobre transferencias cambian. **Verificar en su
  documentacion vigente** antes de apoyar una decision de negocio en esto.

El riesgo es bajo y el ahorro es de semanas, pero conviene decidirlo a
conciencia y no por defecto.

---

## Secuencia completa

### Paso 1 — D-U-N-S (dia 1, esperar 5-14 dias habiles)

Ver arriba. Mientras se espera, se puede avanzar con todo lo demas.

### Paso 2 — Apple Developer Program (1-2 dias tras tener el D-U-N-S)

1. https://developer.apple.com/programs/enroll/
2. Entrar con un **Apple ID de la empresa**, creado para esto y no reutilizando
   el personal de nadie.
3. Elegir **Company / Organization** e introducir el D-U-N-S.
4. Pagar 99 USD/ano.
5. Apple verifica por telefono o correo que quien solicita puede firmar en
   nombre de la empresa. **Plazo: 24-48 h**, a veces mas si llaman.

### El Apple ID de la empresa

Un correo de Gmail vale: Apple no exige un dominio corporativo. Lo que importa
no es el dominio, sino **quien controla el acceso**.

- Crear una cuenta NUEVA y dedicada (`zapp.desarrollo@gmail.com`), nunca la
  personal de alguien del equipo.
- La verificacion en dos pasos es obligatoria en Apple ID. **Si el telefono de
  recuperacion es el movil personal de una persona, esa persona controla la
  cuenta de hecho**, por mucho que el correo se llame "de la empresa". Es el
  mismo problema de propiedad que se queria evitar, solo que desplazado.
- Contrasena y codigos de recuperacion en un gestor al que acceda mas de una
  persona de confianza.

**Efecto secundario del correo generico:** en el alta como Organizacion, Apple
comprueba que quien solicita representa a la empresa mirando el D-U-N-S, la
documentacion legal y **el sitio web**. Con un Gmail esa verificacion suele ser
mas lenta o pedir documentacion extra. Tener la web en un dominio propio de la
empresa (en vez de una URL `.vercel.app`) refuerza bastante ese paso, asi que
si se va a configurar el dominio, conviene hacerlo ANTES del alta.

### Paso 3 — Cuenta de Expo de la empresa (30 minutos, se puede hacer YA)

El proyecto ya declara `owner: "renaser"` en `app.json`. Hay que tener acceso a
esa organizacion de Expo para poder compilar.

```bash
npx eas-cli login
npx eas-cli whoami     # debe listar la cuenta que posee el proyecto
```

Si `whoami` no lista `renaser`, pedir a quien la administre que invite al
usuario desde https://expo.dev/accounts/renaser/settings/members

### Paso 4 — Material de la ficha (2-4 horas, se puede hacer YA)

Lo que Apple pide y **todavia no existe**:

- [ ] **Capturas de pantalla de iPhone 6.7"** (1290x2796). Minimo 3,
      recomendable 5-6. Se sacan del simulador o de un iPhone real.
- [ ] **Descripcion** (hasta 4000 caracteres).
- [ ] **Subtitulo** (30 caracteres).
- [ ] **Palabras clave** (100 caracteres, separadas por comas).
- [ ] **URL de soporte** — obligatoria y hoy NO existe ninguna. Vale una pagina
      sencilla en la web con un correo de contacto.
- [ ] **Cuenta de demostracion** para los revisores: usuario y contrasena de una
      cuenta real con contenido visible. La app exige inicio de sesion, asi que
      sin esto el rechazo es seguro.

Se puede reaprovechar de Google Play: `docs/FICHA_PLAY_STORE.md` tiene los
textos, y el icono de 1024 ya esta listo. Las **capturas no se reaprovechan**:
Apple exige sus propios tamanos.

### Paso 5 — Compilar y enviar (2-3 horas el primer dia)

Con la cuenta ya aprobada:

```bash
# 1. Compila en la nube. EAS crea y gestiona los certificados solo.
npx eas-cli build --platform ios --profile production

# 2. Sube el binario a App Store Connect.
npx eas-cli submit --platform ios --profile production
```

La primera compilacion pide iniciar sesion con el Apple ID de la empresa y
tarda **entre 20 y 40 minutos** en la cola de Expo. `eas submit` pedira el Apple
ID y el App Store Connect App ID; despues se pueden guardar en `eas.json`.

> `submit.production` esta vacio a proposito en `eas.json`: se rellena la
> primera vez de forma interactiva.

### Paso 6 — App Store Connect (1-2 horas)

1. https://appstoreconnect.apple.com → **Mis Apps → +**
2. Crear la ficha con el bundle `com.renaser.z`.
3. Rellenar el material del paso 4.
4. **Cuestionario de privacidad**: declarar que se recogen correo, contenido de
   usuario, fotos y datos de uso. Mentir aqui es causa de retirada.
5. **Clasificacion por edad**: los terminos declaran 18+.
6. Adjuntar la build subida en el paso 5.
7. **Enviar a revision.**

### Paso 7 — Revision de Apple (24-72 h de media)

Si rechazan, responden con el motivo concreto en el Resolution Center. Corregir
y reenviar no vuelve a la cola desde cero: suele revisarse mas rapido.

---

## Cuanto se tarda en total

| Fase | Individual | Organizacion |
|---|---|---|
| D-U-N-S | — | 5-14 dias habiles |
| Alta en el Developer Program | 1-2 dias | 1-2 dias |
| Material y capturas | 1 dia de trabajo | 1 dia de trabajo |
| Compilar y enviar | medio dia | medio dia |
| Revision de Apple | 1-3 dias | 1-3 dias |
| **Total realista** | **menos de 1 semana** | **2 a 4 semanas** |

La mayor parte es espera, no trabajo. Con cuenta de Organizacion conviene
**empezar el primer dia por el D-U-N-S** y usar la espera para el material; con
cuenta Individual se puede ir de corrido.

---

## Lo que se puede hacer HOY, sin esperar a nadie

1. Solicitar el D-U-N-S.
2. Crear el Apple ID de la empresa (Gmail dedicado sirve) y dejar la
   verificacion en dos pasos apuntando a algo que controle la empresa, no al
   movil personal de una persona.
3. Conseguir acceso a la cuenta de Expo `renaser`.
4. Preparar descripcion, subtitulo y palabras clave.
5. Crear la cuenta de demostracion en Supabase y anotar sus credenciales.
6. Publicar una pagina de soporte con un correo de contacto.
7. Sacar las capturas de pantalla.

Con eso, el dia que Apple apruebe la cuenta solo quedan dos comandos y rellenar
la ficha.

---

## Avisos

- **Las directrices de Apple cambian.** Antes de dar por buena una decision de
  negocio (sobre todo las 3.1.1 de pagos y 4.8 de login social), contrastar con
  la version vigente en https://developer.apple.com/app-store/review/guidelines/
- **El plan gratuito de Render duerme el servidor** tras unos minutos sin
  trafico. Si un revisor abre la app y la API tarda un minuto en despertar,
  puede interpretarlo como que no funciona. Conviene subir de plan antes de
  enviar a revision.
- **Registrar `z://reset-password` en Supabase** (Authentication → URL
  Configuration). El `scheme` cambio de `renaser` a `z` y sin esto la
  recuperacion de contrasena no funciona en movil: un revisor que lo pruebe lo
  reportara.
