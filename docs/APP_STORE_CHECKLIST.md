# Checklist para publicar en la App Store

Estado verificado contra el codigo el 23 de julio de 2026, en la rama `andy`
(commit `ce4a668`). Lo marcado con ✅ esta comprobado en el repositorio, no
supuesto.

---

## A. Bloqueantes — sin esto hay rechazo

| # | Requisito | Estado | Donde |
|---|---|---|---|
| A1 | **Bloquear usuarios abusivos** (directriz 1.2) | ✅ | pantalla `/blocked`, bloqueo desde perfil y publicacion, via API (`ProfileRepository.block`) |
| A2 | Reportar contenido ofensivo | ✅ | `ReportRepository` + menu de `PostCard` |
| A3 | Eliminar la cuenta desde la app | ✅ | `AuthRepository.deleteAccount` + Ajustes, con doble confirmacion |
| A4 | Politica de privacidad en URL publica | ⚠️ escrita, sin publicar | `/privacy`; se publica al mergear a `main` |
| A5 | Terminos / EULA con tolerancia cero y respuesta en 24 h | ⚠️ escrita, sin publicar | `/terms` |
| A6 | Cuenta de demostracion para los revisores | ❌ **FALTA** | la app exige inicio de sesion |
| A7 | Sin flujos de compra no funcionales | ✅ | la pasarela simulada se elimino; `FEATURE_PURCHASES = false` oculta precios |
| A8 | Sign in with Apple si hay login social | ✅ no aplica | el login social esta oculto a proposito |
| A9 | Apple Developer Program activo | ❌ **FALTA** | 99 USD/ano |

**Ya no queda nada de codigo pendiente.** A1 se resolvio en `e133847`, lo que
tambien deja correcto el texto de `/terms`, que promete poder bloquear.

---

## B. Configuracion tecnica — ya resuelta

| Requisito | Estado |
|---|---|
| Icono 1024×1024 sin canal alfa | ✅ verificado: RGB, sin alfa |
| `ITSAppUsesNonExemptEncryption: false` | ✅ evita el tramite de cifrado |
| `supportsTablet: false` | ✅ no hay que mantener ni justificar iPad |
| Textos de permisos (camara, microfono, fotos) | ✅ los tres, en espanol |
| Numero de build automatico | ✅ `appVersionSource: remote` + `autoIncrement` |
| `expo-doctor` | ✅ 18/18 |
| Compila para iOS y web | ✅ `expo export` en ambas |

---

## C. Material para App Store Connect — trabajo manual

Nada de esto es codigo; se prepara aparte y suele ser lo que mas tarda.

- [ ] Capturas de pantalla de iPhone 6.7" (minimo un tamano)
- [ ] Nombre, subtitulo y descripcion
- [ ] Categoria y palabras clave
- [ ] **URL de soporte** (obligatoria; hoy no existe ninguna)
- [ ] URL de la politica de privacidad → sale de A4
- [ ] Cuestionario de privacidad: declarar correo, contenido de usuario, fotos y uso
- [ ] Clasificacion por edad (la app declara 18+ en sus terminos)
- [ ] Cumplimiento de exportacion → ya cubierto por `ITSAppUsesNonExemptEncryption`

---

## D. Decisiones pendientes

| Decision | Situacion |
|---|---|
| Cuenta de Apple: individual u organizacion | La organizacion muestra "RENASER" como vendedor pero exige numero D-U-N-S, que tarda dias. Empezarlo pronto si se quiere esa via. |
| `owner` de Expo | `app.json` declara `ggderbor`, la cuenta de Edson. O te agregan como miembro, o se cambia `owner` y `extra.eas.projectId`. |
| Proyecto Supabase de produccion | `eas.json` usa **el mismo proyecto en `preview` y en `production`**: los usuarios reales compartirian base de datos con las pruebas. |
| Moderacion operativa | El compromiso de 24 h esta por escrito; hace falta que alguien revise de verdad los reportes en ese plazo. |

---

## E. Orden sugerido

1. Mergear a `main` para publicar `/privacy` y `/terms` (A4, A5).
2. Contratar el Developer Program (A9) y decidir la cuenta (D).
3. Crear la cuenta de demostracion (A6).
4. Separar el proyecto Supabase de produccion (D).
5. Preparar el material de la ficha (C).

**Nada de esto depende de programar**: son tramites, decisiones y contenido.
