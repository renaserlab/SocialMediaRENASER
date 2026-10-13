import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TONOS, esUnTono, datosDelTono } from '../../lib/tonosDelChat.ts';

/**
 * La confirmación de lectura y «está escribiendo» (12/10/2026), como en
 * WhatsApp. Aquí se vigila cómo está enchufado: lo que es cálculo puro está en
 * `lib/lecturaDeMensajes.test.mts` y `lib/escribiendo.test.mts`.
 *
 * Lo que no puede romperse sin que alguien se entere:
 *   · no se pinta ni se ofrece nada que el servidor no sepa dar;
 *   · a los demás se les avisa de una lectura cuando el servidor YA la anotó;
 *   · por los canales de difusión no viaja nada que importe, y a un aviso de
 *     escritura no se le cree el nombre;
 *   · en reposo no queda nada animado en la pantalla;
 *   · el tono suena una vez, no en cada aviso.
 */

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const RAIZ = join(SRC, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
}

const CHAT = fuente('screens/ChatScreen.tsx');
const REPO = fuente('repositories/MessageRepository.ts');
const TIEMPO_REAL = fuente('services/realtime.ts');
const LECTURAS = fuente('hooks/useLecturasDelChat.ts');
const ESCRIBIENDO = fuente('hooks/useEscribiendo.ts');
const INDICADOR = fuente('components/chat/IndicadorDeEscritura.tsx');
const DETALLES = fuente('components/chat/DetallesDeMensaje.tsx');
const MARCA = fuente('components/chat/MarcaDeEntrega.tsx');
const PUNTOS = fuente('components/chat/PuntosDeEscritura.tsx');
const FILA = fuente('components/FilaDeConversacion.tsx');
const BANDEJA = fuente('screens/MessagesScreen.tsx');
const EN_BANDEJA = fuente('hooks/useEscribiendoEnBandeja.ts');
const ALMACEN = fuente('store/useEscribiendoEnBandejaStore.ts');

describe('La confirmación de lectura', () => {
  it('solo existe si el servidor la anuncia, con un «sí» explícito', () => {
    assert.match(REPO, /lecturas: dto\.read_receipts === true,/);
    // Y sin eso el chat ni pregunta: una aplicación nueva contra un servidor
    // anterior no pinta marcas que nadie le va a dar.
    assert.match(
      CHAT,
      /useLecturasDelChat\(\s*params\.id,\s*supabaseEnabled && !!params\.id && funciones\.lecturas,\s*\)/,
    );
    assert.match(LECTURAS, /if \(!activo \|\| !conversationId\) return;/);
  });

  it('la burbuja propia pinta lo que dicen las marcas, en los dos sitios', () => {
    assert.match(CHAT, /const entrega = estadoDeEntrega\(item, lecturas\.marcas\);/);
    assert.equal([...CHAT.matchAll(/<MarcaDeEntrega\s+estado=\{entrega\}/g)].length, 2);
    // Ya no queda la marca fija de «enviado» que no decía nada más.
    assert.doesNotMatch(CHAT, /: 'check'\s*\}/);
    // Sobre una foto la franja es oscura en los dos temas.
    assert.match(CHAT, /color="#FFF"\s*colorDeLeido=\{COLOR_DE_LEIDO\.sobreOscuro\}/);
    // En la burbuja depende del tema, y un sticker va al revés.
    assert.match(CHAT, /\(mode === 'dark'\) === comoSticker\s*\? COLOR_DE_LEIDO\.sobreOscuro\s*: COLOR_DE_LEIDO\.sobreClaro/);
  });

  it('la marca: una saliendo, dos enviado, dos en celeste leído, aviso si no salió (12/10/2026)', () => {
    // Pedido: «deben haber dos aspas para todo»; una sola, solo con poca señal.
    const dibujo = MARCA.slice(MARCA.indexOf('function Dibujo('));
    assert.match(dibujo, /if \(estado === 'fallido'\) \{\s*return <Feather name="alert-circle"/);
    // La primera marca está siempre; la segunda, en cuanto el servidor lo tiene.
    assert.match(dibujo, /d="M2 11l5 5L18 4"/);
    assert.match(dibujo, /\{estado === 'enviando' \? null : \(\s*<Path\s+d="M25 4L14 16l-1\.5-1\.5"/);
    // El celeste es solo de «leído»; enviado va en el color de la burbuja.
    assert.match(dibujo, /const tinta = estado === 'leido' \? colorDeLeido : color;/);
    assert.equal([...dibujo.matchAll(/stroke=\{tinta\}/g)].length, 2);
    // La sencilla es la primera de la doble: al pasar a dos no se mueve.
    assert.doesNotMatch(MARCA, /name="check"|'clock'/);
  });

  it('todo mensaje propio enseña su marca: texto, foto, emoji o archivo', () => {
    const llamada = /const mostrarHora = llevaFranjaDeHora\(\{([\s\S]*?)\}\);/.exec(CHAT)?.[1] ?? '';
    assert.match(llamada, /esMio: mine,/);
    // Ya no depende de cerrar la ráfaga: a mitad de ráfaga también la lleva.
    assert.doesNotMatch(llamada, /cierraLaRafaga/);
    // En la burbuja, y encima de la foto que va sin marco.
    assert.equal([...CHAT.matchAll(/<MarcaDeEntrega\b/g)].length, 2);
  });

  it('la marca se anima al avanzar y, terminado el salto, vuelve a ser un dibujo quieto', () => {
    // La regla del proyecto: nada animado montado en reposo. Hay una marca por mensaje.
    assert.match(MARCA, /if \(antes === estado \|\| !seAnimaElPaso\(antes, estado\)\) return;/);
    assert.match(MARCA, /if \(viniendoDe === null \|\| !avance\.current\) \{\s*return <Dibujo /);
    assert.match(MARCA, /if \(finished && vigente\) setViniendoDe\(null\);/);
    // El valor animado no se crea hasta que hace falta.
    assert.match(MARCA, /const avance = useRef<Animated\.Value \| null>\(null\);/);
    assert.match(MARCA, /avance\.current \?\?= new Animated\.Value\(0\)/);
    // Y «reducir movimiento» se pregunta solo entonces: sin una escucha por mensaje.
    assert.doesNotMatch(MARCA, /useReduceMotion\(/);
    assert.match(MARCA, /AccessibilityInfo\.isReduceMotionEnabled\(\)/);
    assert.match(MARCA, /if \(!vigente \|\| reducir\) return;/);
  });

  it('a los demás se les avisa cuando el servidor YA anotó la lectura', () => {
    // Avisar antes haría que preguntaran y recibieran todavía la marca vieja.
    assert.match(
      CHAT,
      /const avisarSiSeAnoto = \(anotado: boolean\) => \{\s*if \(anotado\) lecturas\.avisarQueLei\(\);\s*\};/,
    );
    assert.equal(
      [...CHAT.matchAll(/marcarConversacionLeida\(conversationId\)\.then\(avisarSiSeAnoto\)/g)].length,
      2,
    );
  });

  it('el aviso de lectura no lleva nada, y espera a que el canal esté listo', () => {
    const funcion = TIEMPO_REAL.slice(
      TIEMPO_REAL.indexOf('export function avisosDeLectura('),
      TIEMPO_REAL.indexOf('export function canalDeEscritura('),
    );
    assert.match(funcion, /event: 'leido', payload: \{\} \}/);
    assert.match(funcion, /\.on\('broadcast', \{ event: 'leido' \}, \(\) => alAvisar\(\)\)/);
    // Se avisa al abrir el chat, justo cuando el canal se está uniendo.
    assert.match(funcion, /unido = estado === 'SUBSCRIBED';\s*if \(unido && debeAvisar\) \{\s*debeAvisar = false;\s*mandar\(\);/);
    assert.match(funcion, /if \(unido\) mandar\(\);\s*else debeAvisar = true;/);
  });

  it('varios avisos son una pregunta, y una respuesta igual no repinta', () => {
    assert.match(LECTURAS, /if \(pendiente\) return;\s*pendiente = setTimeout\(/);
    assert.match(LECTURAS, /huellaDeMarcas\(actuales\) === huellaDeMarcas\(nuevas\) \? actuales : nuevas/);
    // Al volver a la aplicación se pregunta: el aviso pudo llegar con el teléfono dormido.
    assert.match(LECTURAS, /if \(estado === 'active'\) preguntar\(\);/);
    // Y al salir se deja todo recogido.
    assert.match(LECTURAS, /alVolver\.remove\(\);\s*canal\.current = null;\s*abierto\.cerrar\(\);/);
    // La lista de mensajes se entera cuando cambian.
    assert.match(CHAT, /marcas: lecturas\.marcas,/);
  });

  it('los detalles se ofrecen solo de lo propio y solo si el servidor los da', () => {
    const menu = CHAT.slice(
      CHAT.indexOf('<BottomSheet visible={!!accionesDe}'),
      CHAT.indexOf('<DetallesDeMensaje'),
    );
    assert.match(
      menu,
      /\{accionesDe &&\s*funciones\.lecturas &&\s*tieneDetalles\(\{ \.\.\.accionesDe, esSesion: accionesDe\.id\.startsWith\('sesion:'\) \}\) \? \(\s*<ListRow\s*title=\{t\('chat\.messageDetails'\)\}/,
    );
    assert.match(CHAT, /<DetallesDeMensaje\s+conversacionId=\{params\.id \?\? ''\}\s+mensaje=\{detallesDe\}/);
  });

  it('la hoja de detalles pregunta cada vez que se abre y dice quién sí y quién no', () => {
    assert.match(DETALLES, /MessageRepository\.detallesDeMensaje\(conversacionId, mensajeId\)/);
    assert.match(DETALLES, /useEffect\(\(\) => preguntar\(\), \[preguntar\]\);/);
    assert.match(DETALLES, /t\('chat\.readBy', \{ n: carga\.detalles\.leyeron\.length \}\)/);
    assert.match(DETALLES, /t\('chat\.notReadYet', \{ n: carga\.detalles\.faltan\.length \}\)/);
    // Si falla se dice y se puede reintentar: no se queda girando.
    assert.match(DETALLES, /t\('chat\.detailsFailed'\)/);
    assert.match(DETALLES, /label=\{t\('common\.retry'\)\}/);
    // No se enseña ninguna hora de lectura: el servidor no la sabe.
    assert.doesNotMatch(DETALLES, /read_at|leidoA|horaDeLectura/);
  });
});

describe('«Está escribiendo»', () => {
  it('se avisa mientras se teclea y se para al enviar y al salir', () => {
    assert.match(CHAT, /onChangeText=\{\(texto\) => \{\s*setText\(texto\);[\s\S]{0,120}escritura\.alEscribir\(texto\);/);
    assert.match(CHAT, /setText\(''\);[\s\S]{0,80}escritura\.alParar\(\);\s*setElegidos\(\[\]\);/);
    // Quien sale del chat a medio escribir deja de escribir para los demás.
    assert.match(
      ESCRIBIENDO,
      /return \(\) => \{[\s\S]{0,120}if \(ultimoAviso\.current !== undefined && quienSoy\.current\) \{\s*abierto\.avisar\(avisoDe\(quienSoy\.current, false\)\);/,
    );
  });

  it('por el canal viaja solo quién, y el nombre sale de los miembros conocidos', () => {
    const funcion = TIEMPO_REAL.slice(TIEMPO_REAL.indexOf('export function canalDeEscritura('));
    assert.match(funcion, /event: 'escribe', payload: aviso \}/);
    // Lo que se manda lo arma `avisoDe`: un identificador y un 0 o un 1.
    assert.equal([...ESCRIBIENDO.matchAll(/\.avisar\(avisoDe\(/g)].length, 4);
    assert.doesNotMatch(ESCRIBIENDO, /nombre/i);
    // Quien recibe decide a quién le cree.
    assert.match(
      ESCRIBIENDO,
      /if \(!aviso \|\| !esDeFiar\(aviso\.usuarioId, quienSoy\.current, losDeAqui\.current\)\) return;/,
    );
    assert.match(CHAT, /escritura\.quienes\.map\(\(id\) => nombreDelAutor\(infoDeConversacion, id\)\)/);
    assert.match(CHAT, /conocidos: miembrosConocidos,/);
  });

  it('en reposo no queda nada animado: el indicador solo existe mientras alguien escribe', () => {
    assert.match(CHAT, /\{fraseDeQuienEscribe \? <IndicadorDeEscritura frase=\{fraseDeQuienEscribe\} \/> : null\}/);
    // Los puntos arrancan al montar y se detienen al desmontar.
    assert.match(PUNTOS, /vuelta\.start\(\);\s*return \(\) => vuelta\.stop\(\);/);
    // Con «reducir movimiento» no se mueve nada: ni los puntos ni la entrada.
    assert.match(PUNTOS, /if \(reduceMotion\) return;/);
    assert.match(INDICADOR, /if \(reduceMotion\) return;/);
    assert.match(INDICADOR, /llegada\.start\(\);\s*return \(\) => llegada\.stop\(\);/);
    // Va sobre la lista y no recibe toques: no mueve ni tapa nada que se pulse.
    assert.match(INDICADOR, /pointerEvents="none"/);
    assert.match(INDICADOR, /position: 'absolute'/);
    // Y el hook no deja temporizadores cuando no escribe nadie.
    assert.match(ESCRIBIENDO, /if \(falta === null\) return;/);
    assert.match(ESCRIBIENDO, /return \(\) => clearTimeout\(reloj\);/);
  });

  it('el tono suena cuando lo decide `suenaElTono`, y nada más', () => {
    assert.equal([...CHAT.matchAll(/sonarTono\('escribiendo'\)/g)].length, 1);
    assert.match(
      CHAT,
      /suenaElTono\(\{\s*antes: escribianAntes\.current,\s*ahora: cuantosEscriben,\s*seEstaMirando: aLaVista\.current && AppState\.currentState === 'active',\s*silenciada: estaSilenciada,/,
    );
    assert.match(CHAT, /ultimoTonoDeEscritura\.current = momento;\s*void sonarTono\('escribiendo'\);/);
  });

  it('el tono es de la aplicación: va en la compilación y no se confunde con un aviso', () => {
    assert.equal(TONOS.escribiendo.fichero, 'alguien_escribe.wav');
    assert.ok(existsSync(join(RAIZ, 'assets', 'sonidos', TONOS.escribiendo.fichero)));
    assert.ok(esUnTono(datosDelTono('escribiendo')));
    // Cada tono con su canal: Android no deja cambiar el sonido de uno creado.
    assert.equal(new Set(Object.values(TONOS).map((tono) => tono.canal)).size, 3);
  });
});

describe('Los textos', () => {
  it('están en los tres idiomas', () => {
    const claves = [
      'chat.messageDetails',
      'chat.detailsOf',
      'chat.detailsSentAt',
      'chat.readBy',
      'chat.notReadYet',
      'chat.readByNobody',
      'chat.readByNobodyDirect',
      'chat.everyoneRead',
      'chat.detailsNote',
      'chat.detailsFailed',
      'chat.someone',
      'chat.typingSolo',
      'chat.typingOne',
      'chat.typingTwo',
      'chat.typingMany',
    ];
    for (const idioma of ['es', 'en', 'pt']) {
      const diccionario = fuente(`i18n/${idioma}.ts`);
      for (const clave of claves) {
        assert.ok(diccionario.includes(`'${clave}':`), `${idioma}: falta ${clave}`);
      }
    }
  });
});

describe('«Escribiendo…» en la bandeja (12/10/2026)', () => {
  it('el canal de una conversación es UNO, lo pida el chat o la bandeja', () => {
    // La librería devuelve el mismo canal a quien pide un tema que ya existe:
    // el segundo no podría añadirle su oyente y el primero que cerrase dejaría
    // sordo al otro.
    const canal = TIEMPO_REAL.slice(TIEMPO_REAL.indexOf('const canalesDeEscritura'));
    assert.match(canal, /let abierto = canalesDeEscritura\.get\(conversationId\);\s*if \(!abierto\) \{/);
    assert.match(canal, /for \(const oyente of \[\.\.\.oyentes\]\) oyente\(mensaje\?\.payload\);/);
    // Se cierra cuando se va el último, no el primero.
    assert.match(canal, /elCanal\.oyentes\.delete\(alRecibir\);\s*if \(elCanal\.oyentes\.size > 0\) return;/);
    assert.match(canal, /if \(canalesDeEscritura\.get\(conversationId\) === elCanal\) \{\s*canalesDeEscritura\.delete\(conversationId\);/);
    // Cerrar dos veces no da de baja a otro oyente.
    assert.match(canal, /if \(cerrado\) return;\s*cerrado = true;/);
    // Un solo sitio abre ese tema.
    assert.equal([...TIEMPO_REAL.matchAll(/chat-escribiendo:/g)].length, 1);
  });

  it('la bandeja abre los canales de sus primeras conversaciones, y solo los que cambian', () => {
    assert.match(BANDEJA, /useEscribiendoEnBandeja\(conversations, yo, supabaseEnabled && signedIn\);/);
    assert.match(EN_BANDEJA, /activo \? lasQueSeAtienden\(conversaciones\.map\(\(c\) => c\.id\)\) : \[\]/);
    assert.match(EN_BANDEJA, /cambioDeAtendidas\(\[\.\.\.abiertos\.current\.keys\(\)\], atendidas\)/);
    assert.match(EN_BANDEJA, /\}, \[huella\]\);/);
    // Al irse la pantalla no queda ningún canal ni nadie «escribiendo».
    assert.match(EN_BANDEJA, /for \(const cerrar of canales\.values\(\)\) cerrar\(\);\s*canales\.clear\(\);/);
    assert.match(EN_BANDEJA, /getState\(\)\.quedarseCon\(\[\]\);/);
  });

  it('a un aviso solo se le cree si viene de quien puede estar escribiendo ahí', () => {
    assert.match(
      EN_BANDEJA,
      /if \(!esDeFiarEnBandeja\(aviso\.usuarioId, quienSoy\.current, conversacion, miembros\)\) return;/,
    );
    // El nombre no viaja: sale de la lista de miembros, pedida una vez por grupo.
    assert.match(EN_BANDEJA, /if \(!conversacion\.esGrupo \|\| info !== undefined \|\| pidiendo\.current\.has\(id\)\) return;/);
    assert.match(EN_BANDEJA, /GroupRepository\.info\(id\)/);
    // Con la lista delante, quien no está en el grupo deja de contar.
    assert.match(EN_BANDEJA, /if \(!dentro\.includes\(usuarioId\)\) ahora\.quitar\(id, usuarioId\);/);
  });

  it('un aviso repinta UNA fila, no la bandeja', () => {
    // Cada fila lee lo suyo del almacén; la pantalla no guarda quién escribe.
    assert.match(EN_BANDEJA, /useEscribiendoEnBandejaStore\(\(estado\) => estado\.porConversacion\[conversacion\.id\]\)/);
    assert.match(FILA, /const escribe = useQuienEscribeEn\(conversacion\);/);
    assert.doesNotMatch(BANDEJA, /useEscribiendoEnBandejaStore/);
    // El almacén no cambia de objeto cuando no cambia nada.
    assert.match(ALMACEN, /if \(ahora === antes\) return;/);
  });

  it('la fila enseña la frase en el sitio del último mensaje, con los puntos', () => {
    assert.match(FILA, /escribe\.clave === 'solo'\s*\? t\('messages\.typingSolo'\)/);
    assert.match(FILA, /t\('messages\.typingOne', \{ nombre: escribe\.nombre \}\)/);
    assert.match(FILA, /\{escribiendo \? \(/);
    assert.match(FILA, /<PuntosDeEscritura color=\{colors\.success\} size=\{5\} \/>/);
    // Quien usa lector de pantalla también se entera.
    assert.match(FILA, /detalle: escribiendo \?\? conversacion\.subtitle,/);
  });

  it('en reposo no corre nada: el único temporizador es el de caducar', () => {
    const relojes = [...ALMACEN.matchAll(/setTimeout\(/g)].length;
    assert.equal(relojes, 1);
    assert.match(ALMACEN, /if \(falta === null\) return;/);
    assert.doesNotMatch(ALMACEN, /setInterval/);
    assert.doesNotMatch(EN_BANDEJA, /setInterval|setTimeout/);
  });
});

describe('el tono de «escribiendo» se oye', () => {
  /** Pico y energía de un WAV mono de 16 bits, sin librerías. */
  const medir = (nombre: string) => {
    const datos = readFileSync(join(RAIZ, 'assets', 'sonidos', nombre));
    const inicio = datos.indexOf(Buffer.from('data')) + 8;
    let pico = 0;
    let suma = 0;
    let muestras = 0;
    for (let i = inicio; i + 1 < datos.length; i += 2) {
      const valor = datos.readInt16LE(i) / 32768;
      pico = Math.max(pico, Math.abs(valor));
      suma += valor * valor;
      muestras += 1;
    }
    return { pico, energia: Math.sqrt(suma / muestras), segundos: muestras / 44100 };
  };

  it('suena al menos tanto como los otros dos tonos del chat', () => {
    // El primero salió a la mitad de volumen que ellos y con siete centésimas
    // de sonido: en el teléfono «la animación no tiene sonido» (12/10/2026).
    const escribe = medir(TONOS.escribiendo.fichero);
    for (const otro of [TONOS.enviado.fichero, TONOS.recibido.fichero]) {
      const referencia = medir(otro);
      assert.ok(escribe.pico >= referencia.pico, `${otro}: pico ${referencia.pico}`);
      assert.ok(escribe.energia >= referencia.energia, `${otro}: energía ${referencia.energia}`);
    }
  });

  it('sin saturar y sin alargarse: es un aviso, no una melodía', () => {
    const escribe = medir(TONOS.escribiendo.fichero);
    assert.ok(escribe.pico <= 0.7, `pico ${escribe.pico}`);
    assert.ok(escribe.segundos <= 0.6, `${escribe.segundos} s`);
  });
});
