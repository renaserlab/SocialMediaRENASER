# Probar la app en un iPhone

Dos caminos. El primero funciona hoy desde Windows; el segundo necesita un Mac
pero da la app real.

---

## 1. Expo Go — sin Mac, sin coste

Sirve para validar navegacion, disenio, subidas y todo el backend real.

1. Instalar **Expo Go** desde la App Store.
2. iPhone y PC en la **misma red Wi-Fi**.
3. En el PC: `cd apps/mobile && npx expo start`
4. Escanear el QR con la camara del iPhone.

**Que NO cubre:** la compresion de video antes de subir. `react-native-compressor`
es un modulo nativo que no viaja dentro de Expo Go, asi que
`services/mediaCompressor.ts` lo carga de forma protegida y, si no esta, sube el
archivo sin comprimir. Los videos tardan mas, nada mas.

Tampoco se aplican los ajustes de los config plugins (por ejemplo
`enableBackgroundPlayback` de expo-audio): Expo Go trae un runtime fijo.

---

## 2. Build nativa en un Mac — la app real

### Por que hace falta el Mac

`npx expo prebuild --platform ios` **se niega a ejecutarse en Windows**:

```
Skipping generating the iOS native project files.
Run npx expo prebuild again from macOS or Linux.
```

El proyecto usa generacion nativa continua (CNG): `apps/mobile/ios/` esta en
`.gitignore` a proposito y se genera en cada maquina. No hay nada que preparar
por adelantado desde Windows; la configuracion ya esta validada y lista.

### Coste real

| Objetivo | Cuenta de Apple | Caducidad |
|---|---|---|
| Simulador de iOS | ninguna | — |
| Tu propio iPhone | **Apple ID gratuito** | 7 dias, se reinstala |
| TestFlight / repartir a otros | Developer Program (99 USD/ano) | 1 ano |

Para prototipar basta el Apple ID gratuito.

### Pasos en el Mac — primera vez, en orden

Todo esto se hace una sola vez. Los comandos van en la app **Terminal**
(Launchpad → Otros → Terminal, o Cmd+Espacio y escribir "Terminal").

**1. Xcode.** Instalar **Xcode** desde la App Store (~10 GB, tarda). Abrirlo una
vez para que acepte la licencia, y luego instalar las herramientas de linea de
comandos:

```bash
xcode-select --install
```

**2. Homebrew + Node** (si el Mac no los trae). Homebrew es el gestor de
paquetes de macOS:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node git watchman
```

`watchman` no es obligatorio pero hace que Metro vaya mas fino.

**3. Clonar el repositorio e instalar dependencias:**

```bash
git clone https://github.com/renaserlab/SocialMediaRENASER.git
cd SocialMediaRENASER
npm install
```

**4. Variables de entorno** (ver Aviso 1 mas abajo — es el error mas facil de
cometer):

```bash
cp apps/mobile/.env.example apps/mobile/.env
```

Luego abrir ese `.env` (`open -e apps/mobile/.env`) y pegar los valores reales.
Sin ellos la app arranca con datos inventados.

**5. Preparar el iPhone** (una vez):

- Conectarlo al Mac por cable y, en el iPhone, tocar **Confiar** cuando pregunte.
- Activar el **Modo desarrollador**: Ajustes → Privacidad y seguridad → Modo
  de desarrollador → activar → el iPhone se reinicia. (Solo aparece a partir de
  iOS 16; en versiones anteriores no hace falta.)

**6. Compilar e instalar en el iPhone conectado:**

```bash
cd apps/mobile
npx expo run:ios --device
```

Preguntara en cual dispositivo instalar; elegir el iPhone. `run:ios` hace por si
solo el `prebuild` (genera la carpeta `ios/`), el `pod install` y la
instalacion. La primera vez tarda bastante; las siguientes van rapidas.

**7. Firma (solo la primera compilacion).** Si falla pidiendo un equipo de firma:

1. Se abre el proyecto en Xcode: `open ios/*.xcworkspace`
2. **Xcode → Settings → Accounts → +** → añadir tu Apple ID (el gratuito vale).
3. En el panel izquierdo, seleccionar el proyecto → destino
   **RenaserSocialMedia** → pestaña **Signing & Capabilities** → marcar
   *Automatically manage signing* y en *Team* elegir tu cuenta personal.
4. Volver a la Terminal y repetir `npx expo run:ios --device`.

**8. Confiar en el certificado en el iPhone** (solo con Apple ID gratuito). La
primera vez la app no abre y dice que el desarrollador no es de confianza:
Ajustes → General → VPN y gestion de dispositivos → tocar tu Apple ID →
**Confiar**. Ya abre.

Con Apple ID gratuito la firma **caduca a los 7 dias**: pasado ese plazo la app
deja de abrir y hay que volver a hacer el paso 6 para reinstalarla. Es lo normal
para prototipar; solo el Developer Program (99 USD/año) evita esa caducidad.

### Cuando ya funciona: recompilar tras cambios

- Cambios solo de **JavaScript/React** (lo habitual): no hace falta recompilar.
  `cd apps/mobile && npx expo start`, y la app instalada recarga sola. Incluso
  desde Windows con `--tunnel`, como venimos haciendo.
- Cambios en **dependencias nativas o configuracion** (`app.json`, un plugin,
  un modulo nuevo): repetir `npx expo run:ios --device`.

### ⚠️ Aviso 1: el `.env` NO esta en el repositorio

Esta en `.gitignore` (contiene claves). Sin el, la app arranca en **modo
demostracion**: datos falsos, sin backend. Ya paso una vez y cuesta un buen rato
darse cuenta, porque la app funciona "bien" pero muestra contenido inventado.

Las variables necesarias estan en `apps/mobile/.env.example`. Los valores reales
de desarrollo tambien viven en `eas.json`, dentro del perfil `preview`.

Se incrustan **al compilar**, no se leen en caliente: si se cambian, hay que
volver a compilar.

### ⚠️ Aviso 2: el identificador puede chocar

`com.renaser.universo` puede estar ya registrado en la cuenta de Apple del
equipo. Con un Apple ID gratuito, si Xcode se queja, basta cambiarlo en
`app.json` a algo como `com.renaser.universo.dev` **solo para pruebas locales**
(sin commitear ese cambio).

---

## 3. EAS Build — instalar sin cable

Alternativa al Mac, pero **exige el Developer Program (99 USD/ano)**: registrar
el UDID del iPhone y firmar un perfil ad-hoc requiere cuenta de pago.

```bash
eas device:create                              # registrar el iPhone
eas build --platform ios --profile preview     # compila en la nube (macOS)
```

`eas.json` ya trae los perfiles `preview` (dispositivo),
`preview-ios-simulator` y `production`.

**Pendiente antes de usarlo:** `app.json` declara `owner: ggderbor` (la cuenta
de Edson). Quien compile debe pertenecer a esa cuenta, o cambiar `owner` y
`extra.eas.projectId` por los suyos — teniendo en cuenta que ese archivo es
compartido y el cambio choca en el proximo merge.
