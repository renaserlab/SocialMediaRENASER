# Hallazgos E2E — resumen (28-10-2026)

Primera pasada de la suite Maestro sobre `main` (2df306f), en Expo Go contra el
backend local. El detalle de cada uno (pasos, esperado, real, causa, captura)
está en el archivo del módulo. `[disp]` = visto en el emulador; `[código]` =
deducido leyendo el código, sin reproducir todavía.

62 hallazgos en 5 módulos. Varios son el mismo fallo visto desde dos sitios;
abajo van agrupados para arreglarlos de una vez.

## Arreglar primero

| Id | Qué pasa | Dónde |
|---|---|---|
| E0 | Tras reservar un evento gratuito la ficha no ofrece «Cancelar mi reserva»: `getEvent()` pide el evento con `auth: false` y `reserved_by_me` llega siempre falso. En el destacado no hay otra forma de cancelar. `[disp]` | eventos-escuela-crear.md |
| ~~M11~~ | **Corregido en #27.** Buscar en la bandeja descartaba la respuesta del servidor; sin resultados se queda en «Cargando…» para siempre, y una conversación que no está cargada no se encuentra. `[disp]` | mensajes.md |
| ~~S7~~ | **Corregido en #31 (tanda 2).** Un curso sin portada abre con la imagen de respaldo a tamaño real (~1000 dp): el título, el precio y el botón quedan dos pantallas más abajo. `[disp]` | eventos-escuela-crear.md |
| E1 | Un evento con entradas ofrece «Elegir entradas» aunque la venta está apagada en el servidor, y la reserva gratuita también queda bloqueada: nadie puede apuntarse. `[disp]` | eventos-escuela-crear.md |
| H-01 | En una publicación abierta por enlace o notificación, el «me gusta» no mueve el contador y el corazón ignora lo que dice el servidor. `[código]` | inicio-explorar.md |
| PA-06 | Desbloquear desde Ajustes no refresca el perfil: sigue saliendo «Bloqueaste a esta persona» hasta 2 min. `[disp]` | perfil-ajustes.md |
| AUTH-02 | El registro acepta «ana@gmail» y la recuperación de contraseña lo rechaza: quien se equivoca no puede recuperar la cuenta. `[disp]` | auth.md |

## El mismo fallo en varios módulos

- **Publicaciones de solo texto invisibles** (C4, PA-02, H-06; y C1): no salen
  en Inicio ni en el perfil, no se abren desde el muro, y crearlas depende del
  permiso de fotos.
- **Imágenes de respaldo de otro programa** (E7, S9, H-07): eventos, cursos y
  círculos sin portada enseñan «ALQUIMIA», «LÍDER DE TU VIDA» o «LÍDERES
  RENASER», recortados.
- **El botón derecho de la cabecera se anuncia como «Acción derecha»** (H-09,
  M7, PA-03): solo ~12 de 77 usos pasan `rightLabel`.
- **Información solo por color** (M2, H-05, S6; regla 4 de CLAUDE.md):
  «leído», historia vista y lección completada.
- **Textos fuera de i18n** (H-04, M10, PA-04, PA-05, M5): etiquetas y fechas
  en español fijo o en el idioma del teléfono.

## Por módulo

| Módulo | Alta | Media | Baja | Archivo |
|---|---|---|---|---|
| Auth | — | 1 | 3 | auth.md |
| Inicio y Explorar | — | 3 | 10 | inicio-explorar.md |
| Mensajes y notificaciones | 1 | 5 | 6 | mensajes.md |
| Perfil y ajustes | — | 4 | 4 | perfil-ajustes.md |
| Eventos, escuela, crear y productos | 2 | 14 | 9 | eventos-escuela-crear.md |

También conviene mirar pronto PA-08 (rendimiento): escribir en la hoja «Editar perfil» re-renderiza
todo el perfil en cada tecla (~30 veces más lento que `/edit-profile`), y
M12: a veces el chat abre a mitad del historial (intermitente, regresión).
Y H-12: Explorar pinta fotogramas sin parar aunque nada se mueva (medido:
0 fotogramas en reposo en Inicio, Perfil y Mensajes; ~60 cada 5 s en el
emulador en Explorar). Gasta batería y hace que cada toque de Maestro tarde
12–17 s. Causa confirmada el 29-10: el bucle de `CoachMark`. **Corregido en
#31** (tanda 2): 0 fotogramas en reposo, y la suite va más rápida en Explorar.

## Flujos fuera de la suite por defecto

Se corren nombrando el archivo (`correr.sh e2e/flujos/...`) o con
`--etiquetas=pendiente`.

| Flujo | Etiqueta | Por qué |
|---|---|---|
| `inicio-explorar/publicacion-comentarios` | `pendiente` | Maestro se cae escribiendo el comentario (~10 s por tecla); falta medir esa pantalla |
| `eventos-escuela-crear/escuela-catalogo-y-curso` | `pendiente` | Pasa solo, pero en la suite corre después de las lecciones y ve el curso empezado; hace falta otro usuario para las lecciones |
| `perfil-ajustes/02-editar-perfil`, `03-editar-perfil-validaciones` | `pendiente` | Borrar texto en la hoja «Editar perfil» no es fiable (PA-08: ~10 s por tecla) |
| `perfil-ajustes/08-tema-claro-oscuro` | `pendiente` | Pierde la barra de pestañas al volver atrás |
| `eventos-escuela-crear/crear-opciones-y-validacion`, `crear-publicar-texto` | `bloqueado-expo-go` | C5: la galería pide permiso de audio y Expo Go lo rechaza |

## Referencias renovadas tras la tanda 2 (#31)

S7 quedó corregido y las portadas de cursos y eventos pasaron a `expo-image`
con `contentFit="cover"`: la ficha del curso se ve entera al entrar y la
portada del evento destacado ya no sale ampliada. Las capturas de
`escuela-*` y `agenda*` de `referencias/eventos-escuela-crear/` se renovaron el
29-10 con `main` a8d5cb1.

## Flujos que vigilan un fallo conocido

Etiqueta `bug-conocido`. Comprueban el comportamiento actual (el incorrecto) y
fallan en el paso `# ARREGLO:` cuando alguien lo corrige; entonces se invierte
esa comprobación y el flujo pasa a vigilar que no vuelva.

- `auth/bug-registro-correo-sin-dominio.yaml` — AUTH-02
- `eventos-escuela-crear/bug-eventos-reservas.yaml` — E0, E2, E3, E4
- `perfil-ajustes/bug-desbloquear-no-refresca-perfil.yaml` — PA-06
