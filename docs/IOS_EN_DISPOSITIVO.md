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

### Pasos en el Mac

```bash
# 1. Xcode desde la App Store (~10 GB) y sus herramientas de linea de comandos
xcode-select --install

# 2. El repositorio
git clone <repo> && cd SocialMediaRENASER
npm install

# 3. Variables de entorno (ver aviso mas abajo)
cp apps/mobile/.env.example apps/mobile/.env   # y rellenarlo

# 4. Generar el proyecto nativo, compilar e instalar en el iPhone conectado
cd apps/mobile
npx expo run:ios --device
```

`run:ios` hace por si solo el `prebuild`, el `pod install` y la instalacion.

La primera vez Xcode pedira un equipo de firma: **Xcode → Settings → Accounts**,
anadir el Apple ID, y en el destino `RenaserSocialMedia` elegir ese equipo
personal en *Signing & Capabilities*.

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
