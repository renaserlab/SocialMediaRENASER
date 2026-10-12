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

  it('la marca tiene tres caras: reloj, una y dos', () => {
    assert.match(MARCA, /name=\{estado === 'enviando' \? 'clock' : 'alert-circle'\}/);
    assert.match(MARCA, /if \(estado === 'enviado'\) \{\s*return <Feather name="check"/);
    // Las dos de «leído» van dibujadas, con su color propio.
    assert.equal([...MARCA.matchAll(/stroke=\{colorDeLeido\}/g)].length, 2);
  });

  it('lo último que uno mandó enseña siempre su marca', () => {
    assert.match(CHAT, /const mostrarHora = llevaFranjaDeHora\(\{/);
    assert.match(
      CHAT,
      /cierraLaRafaga:\s*!siguiente \|\| !mismaRafaga\(siguiente, item\) \|\| diaDe\(siguiente\) !== dia,/,
    );
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
    // La animación arranca al montar y se detiene al desmontar.
    assert.match(INDICADOR, /vuelta\.start\(\);\s*return \(\) => vuelta\.stop\(\);/);
    // Con «reducir movimiento» no se mueve nada.
    assert.match(INDICADOR, /if \(reduceMotion\) return;/);
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
