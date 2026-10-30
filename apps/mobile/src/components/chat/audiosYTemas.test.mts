import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Audios y temas (30/10/2026): lo que no se puede ejecutar aquí —pantallas,
 * repositorios, el selector del sistema— se cuida sobre el TEXTO, como el
 * resto del chat. La lógica pura está en `lib/nombresDeAdjuntos.test.mts` y
 * `lib/temasEnContenido.test.mts`.
 *
 * Son los cerrojos de lo que el contrato fija (`docs/CONTRATOS_AUDIOS_Y_TEMAS.md`)
 * y cuya ruptura no daría ningún error: una ruta mal escrita responde 404 y
 * la pantalla se queda sin etiquetas; un selector abierto encima de una hoja
 * que se cierra no se abre en iOS, y nadie se entera.
 */

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
}

const MAPEO = fuente('mappers/messageMapper.ts');
const MENSAJES = fuente('repositories/MessageRepository.ts');
const TEMAS = fuente('repositories/TemasRepository.ts');
const ENVIO = fuente('services/messageMedia.ts');
const CHAT = fuente('screens/ChatScreen.tsx');
const VOZ = fuente('components/BurbujaDeNotaDeVoz.tsx');
const ARCHIVO = fuente('components/chat/ArchivoDeChat.tsx');
const HOJA_DE_TEMAS = fuente('components/chat/HojaDeTemas.tsx');
const GRABADORA = fuente('hooks/useGrabadoraDeVoz.ts');
const BOTON = fuente('components/BotonDeNotaDeVoz.tsx');

describe('lo que llega del servidor', () => {
  it('cada adjunto trae su nombre y si es nota de voz; una foto nunca tiene nombre', () => {
    assert.match(MAPEO, /title: dto\.kind === 'image' \? null : leerTitulo\(dto\.title\),/);
    assert.match(MAPEO, /voiceNote: leerNotaDeVoz\(dto\.kind, dto\.voice_note\),/);
  });

  it('cada mensaje trae sus temas, salvo una lápida', () => {
    assert.match(MAPEO, /temas: dto\.deleted_at \? undefined : temasDe\(dto\),/);
    assert.match(MENSAJES, /temas: leerTemasDeMensaje\(fila\.topics\),/);
  });
});

describe('las rutas del contrato', () => {
  it('el nombre se cambia con PATCH sobre el adjunto, y `null` lo borra', () => {
    assert.match(
      MENSAJES,
      /`\$\{API_V1\}\/conversations\/\$\{conversationId\}\/messages\/\$\{messageId\}\/attachments\/\$\{attachmentId\}`,\s*\{ method: 'PATCH', body: JSON\.stringify\(\{ title: titulo \}\) \}/,
    );
  });

  it('agregar varios es un PUT por lotes a los ítems del tema, con `message_ids`', () => {
    assert.match(
      TEMAS,
      /`\$\{base\(grupoId\)\}\/\$\{temaId\}\/items`,\s*\{ method: 'PUT', body: JSON\.stringify\(\{ message_ids: ids \}\) \}/,
    );
    assert.match(TEMAS, /export const MAX_MENSAJES_POR_LOTE = 50;/);
  });

  it('las etiquetas se refrescan con `of-messages`, hasta cien de una vez', () => {
    assert.match(TEMAS, /`\$\{base\(grupoId\)\}\/of-messages\?ids=\$\{ids\.map\(encodeURIComponent\)\.join\(','\)\}`/);
    assert.match(TEMAS, /\.slice\(-MAX_CONSULTA_DE_TEMAS\)/);
  });
});

describe('al enviar', () => {
  it('«Archivo» deja elegir varios, y un audio reproducible va como audio que no es nota de voz', () => {
    const elegir = ENVIO.slice(ENVIO.indexOf('export async function elegirArchivo('));
    assert.match(elegir, /multiple: maximo > 1,/);
    // Sin la 0113 (`audios: false`) todo va como documento, como antes.
    assert.match(
      elegir,
      /const kind = audios \? tipoDeArchivoElegido\(asset\.mimeType, asset\.name\) : 'document';/,
    );
    assert.match(elegir, /\.\.\.\(kind === 'audio' \? \{ voiceNote: false \} : \{\}\),/);
    assert.match(elegir, /sobran: Math\.max\(0, todos\.length - tope\),/);
  });

  it('el nombre y `voice_note` solo viajan si hay algo que decir: lo viejo sale igual que antes', () => {
    const campos = ENVIO.slice(ENVIO.indexOf('function camposDeNombre('));
    assert.match(campos, /const titulo = adjunto\.kind === 'image' \? null : limpiarTitulo\(adjunto\.title\);/);
    assert.match(campos, /\.\.\.\(titulo \? \{ title: titulo \} : \{\}\),/);
    assert.match(
      campos,
      /\.\.\.\(adjunto\.kind === 'audio' && adjunto\.voiceNote === false \? \{ voice_note: false \} : \{\}\),/,
    );
  });

  it('el selector de archivos se abre DESPUÉS de que el menú se haya ido (iOS)', () => {
    const elegir = CHAT.slice(
      CHAT.indexOf('const elegirArchivosConNombre = useCallback('),
      CHAT.indexOf('const quitarElegido'),
    );
    assert.ok(
      elegir.indexOf('setMenuAbierto(false);') < elegir.indexOf('await afterSheetClose();') &&
        elegir.indexOf('await afterSheetClose();') <
          elegir.indexOf('await elegirArchivo(MAX_ARCHIVOS_DE_UNA_VEZ, { audios: funciones.nombres })'),
      'Con la hoja todavía cerrándose, el selector del sistema no se abre en iOS y falla callado.',
    );
    assert.match(CHAT, /onPress=\{\(\) => void elegirArchivosConNombre\(\)\}/);
    // Y lo mismo con fotos, recorte y cámara.
    const conOtros = CHAT.slice(CHAT.indexOf('const elegirCon = useCallback('));
    assert.ok(conOtros.indexOf('await afterSheetClose();') < conOtros.indexOf('await accion();'));
  });

  it('un mensaje por archivo, de uno en uno, cada uno con su reintento', () => {
    const enviar = CHAT.slice(
      CHAT.indexOf('const enviarArchivos = useCallback('),
      CHAT.indexOf('/** La cita de un mensaje que se va a responder'),
    );
    assert.match(enviar, /for \(const archivo of archivos\) \{/);
    assert.match(enviar, /const envio: EnvioPendiente = \{ texto: '', archivos: \[archivo\] \};/);
    assert.match(enviar, /await enviar\(envio, idTemporal\);/);
    assert.match(enviar, /title: archivo\.title \?\? null,/);
  });

  it('la nota de voz lleva el nombre de la previa como su `title`, y se olvida al enviarse o tirarse', () => {
    const enviar = GRABADORA.slice(GRABADORA.indexOf('const enviar = useCallback('));
    assert.match(enviar, /const titulo = limpiarTitulo\(nombre\);/);
    assert.match(enviar, /const pendiente: AdjuntoElegido = titulo \? \{ \.\.\.nota, title: titulo \} : nota;/);
    const eliminar = GRABADORA.slice(GRABADORA.indexOf('const eliminar = useCallback('));
    assert.match(eliminar.slice(0, 400), /setNombre\(''\);/);
    assert.match(BOTON, /placeholder=\{t\('voiceName\.placeholder'\)\}/);
    assert.match(BOTON, /maxLength=\{MAX_TITULO_DE_ADJUNTO\}/);
    assert.match(CHAT, /alCambiarNombre=\{funciones\.nombres \? grabadora\.setNombre : undefined\}/);
  });
});

describe('la tarjeta', () => {
  it('sin nombre, la nota de voz se ve exactamente como antes', () => {
    assert.match(
      VOZ,
      /identidad\.titulo \? \(\s*<View style=\{styles\.tarjeta\}>\s*<CabeceraDeAdjunto adjunto=\{adjunto\} mio=\{mio\} \/>\s*\{reproductor\}\s*<\/View>\s*\) : \(\s*reproductor\s*\)/,
    );
  });

  it('el documento con nombre: la cabecera es hermana de la descarga, no la envuelve', () => {
    const tarjeta = ARCHIVO.slice(ARCHIVO.indexOf('if (titulo) {'), ARCHIVO.indexOf('<View style={[styles.fila, style]}>'));
    assert.ok(tarjeta.indexOf('</Pulsable>') < tarjeta.indexOf('{descargaDeLaTarjeta}'));
    assert.match(tarjeta, /\[nombre, detalle\]\.filter\(Boolean\)\.join\(' · '\)/);
  });

  it('un video con nombre lleva la cabecera encima, y sin nombre se devuelve tal cual', () => {
    assert.match(CHAT, /if \(!titulado\) return medio;/);
    assert.match(CHAT, /<CabeceraDeAdjunto\s+adjunto=\{adjunto\}\s+mio=\{mio\}/);
  });

  it('las piezas nuevas solo usan tokens del tema', () => {
    for (const rel of [
      'components/chat/CabeceraDeAdjunto.tsx',
      'components/chat/EtiquetaDeTemas.tsx',
      'components/chat/HojaDeNombre.tsx',
      'components/chat/HojaDeEnviarArchivos.tsx',
    ]) {
      assert.doesNotMatch(fuente(rel), /#[0-9A-Fa-f]{3,8}\b|rgba?\(/, rel);
    }
  });
});

describe('el menú del mensaje y la etiqueta', () => {
  it('ponerle nombre: quien lo envió y quien administra (la regla de borrar)', () => {
    assert.match(
      CHAT,
      /puedeNombrar\(\{\s*mio: accionesDe\.sender === 'me',\s*administra: puedoBorrarAjenos,\s*adjunto: adjuntoNombrable\(accionesDe\.attachments\),\s*\}\)/,
    );
    assert.match(CHAT, /\? 'attachmentName\.rename'\s*: 'attachmentName\.name'/);
  });

  it('ir al tema o ver en cuáles está: para todos, sin mirar quién administra', () => {
    assert.match(
      CHAT,
      /\{accionesDe && etiquetaDeTemas\(accionesDe\.temas\)\.tipo !== 'ninguna' \? \(/,
    );
    const ir = CHAT.slice(CHAT.indexOf('const temasDesdeElMenu = useCallback('));
    assert.ok(ir.indexOf('setAccionesDe(null);') < ir.indexOf('await afterSheetClose();'));
  });

  it('las hojas que salen del menú se abren tras cerrarlo (iOS)', () => {
    const nombrar = CHAT.slice(CHAT.indexOf('const nombrarDesdeElMenu = useCallback('));
    assert.ok(nombrar.indexOf('setAccionesDe(null);') < nombrar.indexOf('await afterSheetClose();'));
    assert.ok(nombrar.indexOf('await afterSheetClose();') < nombrar.indexOf('setNombrando({'));
  });

  it('el chat escucha `chat-temas` solo en General de una comunidad con temas, y pregunta por lo cargado', () => {
    assert.match(
      CHAT,
      /const conEtiquetasDeTemas =\s*supabaseEnabled && !!params\.id && esGrupoDePrimerNivel && disponibilidadDeTemas\.temas;/,
    );
    assert.match(CHAT, /const canal = avisosDeTemas\(params\.id, \(\) => \{/);
    assert.match(CHAT, /TemasRepository\.temasDeMensajes\(params\.id, ids\)/);
    assert.match(CHAT, /const siguiente = aplicarTemas\(mensajesRef\.current, ids, porMensaje\);/);
  });

  it('la etiqueta va fuera de la burbuja, como hermana', () => {
    const fin = CHAT.indexOf('</DeslizarParaResponder>');
    assert.ok(fin > 0 && CHAT.indexOf('<EtiquetaDeTemas', fin) > fin);
  });
});

describe('agregar a un tema desde el chat', () => {
  it('el ✓ sale de `contains`, y lo marcado dice que tocarlo lo quita', () => {
    assert.match(HOJA_DE_TEMAS, /TemasRepository\.listar\(grupoId, \{ mensajeId \}\)/);
    assert.match(HOJA_DE_TEMAS, /\{t\('groupTopics\.alreadyHere'\)\}/);
  });

  it('el nombre opcional solo si no tiene, y se guarda con «Listo»', () => {
    assert.match(CHAT, /return adjunto && !adjunto\.title \? adjunto : null;/);
    const listo = HOJA_DE_TEMAS.slice(HOJA_DE_TEMAS.indexOf('const listo = async'));
    assert.match(listo, /MessageRepository\.nombrarAdjunto\(\s*grupoId,\s*mensajeId,\s*adjuntoSinNombre\.id,\s*nuevo,\s*\)/);
    // Un «no» se dice dentro de la hoja: encima de un Modal no se vería en iOS.
    assert.match(listo, /setFallo\(/);
  });
});

describe('sin la 0113 no hay nombres (`attachment_titles`)', () => {
  const FUNCIONES = MENSAJES.slice(MENSAJES.indexOf('async funciones()'));

  it('se lee de `/availability`, y sin el campo vale `false`', () => {
    assert.match(FUNCIONES, /nombres: dto\.attachment_titles === true,/);
    assert.match(MENSAJES, /lecturas: false,\s*nombres: false,\s*\};/);
  });

  it('sin ella no hay «Ponerle nombre», ni campo en «Agregar a un tema», ni en la nota de voz', () => {
    assert.match(CHAT, /\{funciones\.nombres &&\s*accionesDe &&\s*puedeNombrar\(/);
    assert.match(CHAT, /if \(!funciones\.nombres\) return null;\s*const adjunto = adjuntoNombrable\(temasPara\?\.attachments\);/);
  });

  it('ni en «Enviar N archivos», que entonces manda cada archivo sin nombre y el audio como documento', () => {
    const hoja = fuente('components/chat/HojaDeEnviarArchivos.tsx');
    assert.match(CHAT, /conNombres=\{funciones\.nombres\}/);
    assert.match(hoja, /title: conNombres \? limpiarTitulo\(nombre\) : null,/);
    assert.equal((hoja.match(/\{conNombres \? \(/g) ?? []).length, 2);
    assert.match(CHAT, /await elegirArchivo\(MAX_ARCHIVOS_DE_UNA_VEZ, \{ audios: funciones\.nombres \}\)/);
  });

  it('un video de la galería lleva su campo de nombre, y una foto no', () => {
    assert.match(
      CHAT,
      /\{funciones\.nombres && elegidos\.some\(\(archivo\) => archivo\.kind === 'video'\) \? \(/,
    );
    assert.match(CHAT, /videos=\{elegidos\.filter\(\(archivo\) => archivo\.kind === 'video'\)\}/);
    // Lo escrito se lee al enviar, desde una referencia: teclear no repinta la pantalla.
    assert.match(CHAT, /archivo\.kind === 'video' && nombresDeVideos\.current\[archivo\.uri\]/);
    assert.match(CHAT, /nombres\.current = \{ \.\.\.nombres\.current, \[video\.uri\]: texto \};/);
  });
});
