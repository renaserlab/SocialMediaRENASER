/**
 * Escribir no repinta los mensajes, y un mensaje que llega no pide de más
 * (auditoría de rendimiento del 27/10, §6.1 y §6.2; arreglado el 28/10/2026).
 *
 * POR QUÉ ASÍ. FlashList 2 solo se salta una celda si `renderItem` es LA
 * MISMA función que la vez anterior (`ViewHolder.tsx` de `@shopify/flash-list`)
 * y una `FlatList` de React Native que se vuelve a pintar repinta todas sus
 * filas. Con el texto del campo como estado de la pantalla y `renderItem`
 * escrito en línea, cada tecla repintaba todas las burbujas a la vista: 30 de
 * 30 en el chat, en un tema y en los comentarios, medido ejecutando las
 * pantallas de verdad. Después, 0. Lo que se fija aquí es la forma que lo
 * consigue, para que no vuelva por descuido.
 *
 * Se ejecutan con `npm run test` (el runner de Node, sin dependencias).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (codigo: string) =>
  codigo.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const CHAT = sinComentarios(fuente('screens/ChatScreen.tsx'));
const TEMA = sinComentarios(fuente('screens/TemaScreen.tsx'));
const BURBUJA_DE_TEMA = sinComentarios(fuente('components/chat/BurbujaDeTema.tsx'));
const COMENTARIOS = sinComentarios(fuente('components/ContenidoDeComentarios.tsx'));
const GRABADORA = sinComentarios(fuente('hooks/useGrabadoraDeVoz.ts'));
const BOTON_DE_VOZ = sinComentarios(fuente('components/BotonDeNotaDeVoz.tsx'));

/** El cuerpo de un componente de nivel de módulo, hasta el siguiente. */
function cuerpoDe(codigo: string, inicio: string): string {
  const desde = codigo.indexOf(inicio);
  assert.ok(desde >= 0, `no está «${inicio}»`);
  const siguiente = codigo.slice(desde + inicio.length).search(/\n(?:export )?(?:function|const|type) [A-Z]/);
  return siguiente < 0 ? codigo.slice(desde) : codigo.slice(desde, desde + inicio.length + siguiente);
}

describe('el chat', () => {
  const pantalla = cuerpoDe(CHAT, 'export function ChatScreen()');

  it('el texto del campo vive en el redactor, no en la pantalla', () => {
    assert.doesNotMatch(pantalla, /useState\(''\)/);
    assert.doesNotMatch(pantalla, /onChangeText=/);
    const redactor = cuerpoDe(CHAT, 'function RedactorDelChat(');
    assert.match(redactor, /const \[text, setText\] = useState\(''\);/);
    assert.match(redactor, /onChangeText=\{\(texto\) => \{/);
    assert.match(pantalla, /<RedactorDelChat\b/);
  });

  it('los campos de nombre (nota de voz, videos) tampoco viven en la pantalla', () => {
    /*
      Audios y temas (30/10/2026). La grabadora es un hook de la pantalla: un
      estado suyo es un estado de la pantalla, y el nombre de la nota de voz
      la repintaba entera con cada tecla. Ahora el texto lo lleva cada campo,
      y la grabadora y la pantalla lo guardan en una referencia que leen al
      enviar.
    */
    assert.doesNotMatch(GRABADORA, /useState\(''\)/);
    assert.doesNotMatch(GRABADORA, /\[nombre, setNombre\]/);
    assert.match(GRABADORA, /const nombre = useRef\(''\);/);
    const campo = cuerpoDe(BOTON_DE_VOZ, 'function CampoDeNombreDeLaNota(');
    assert.match(campo, /const \[texto, setTexto\] = useState\(inicial\);/);
    assert.match(campo, /onChangeText=\{\(nuevo\) => \{/);
    const videos = cuerpoDe(CHAT, 'function NombresDeVideos(');
    assert.match(videos, /useState<Record<string, string>>/);
    assert.match(videos, /onChangeText=\{\(texto\) => \{/);
    assert.match(pantalla, /const nombresDeVideos = useRef<Record<string, string>>\(\{\}\);/);
  });

  it('`renderItem` es estable y la burbuja está memorizada', () => {
    assert.match(pantalla, /const renderItem = useCallback\(/);
    assert.match(pantalla, /renderItem=\{renderItem\}/);
    assert.doesNotMatch(pantalla, /renderItem=\{\(/);
    assert.match(CHAT, /const BurbujaDelChat = memo\(function BurbujaDelChat\(/);
    // `reintentar` cambia con `enviando`: a la burbuja le llega uno estable.
    assert.match(pantalla, /reintentar: reintentarDesdeLaBurbuja,/);
  });

  it('a la burbuja le llega lo suyo, no lo de toda la lista', () => {
    // Su nota (no la que suena en otra), su resalte, y una marca solo si es suya.
    assert.match(pantalla, /audioSonando !== null && item\.attachments\?\.some\(\(adjunto\) => adjunto\.id === audioSonando\)/);
    assert.match(pantalla, /resaltado=\{item\.id === resaltado\}/);
    assert.match(pantalla, /entrega=\{item\.sender === 'me' \? entrega : 'enviado'\}/);
  });
});

describe('un tema', () => {
  it('el campo lleva su texto y las burbujas no se repintan al teclear', () => {
    const pantalla = cuerpoDe(TEMA, 'export function TemaScreen()');
    assert.doesNotMatch(pantalla, /\[borrador, setBorrador\]/);
    assert.match(cuerpoDe(TEMA, 'function RedactorDelTema('), /const \[borrador, setBorrador\] = useState\(''\);/);
    assert.match(pantalla, /const renderItem = useCallback\(/);
    assert.match(pantalla, /renderItem=\{renderItem\}/);
    assert.match(BURBUJA_DE_TEMA, /export const BurbujaDeTema = memo\(function BurbujaDeTema\(/);
  });

  it('un mensaje nuevo pide su página y su «visto», no la lista de temas', () => {
    assert.match(TEMA, /conLista \? TemasRepository\.listar\(grupoId\) : Promise\.resolve\(null\)/);
    // El tiempo real de su chat: sin la lista. Reengancharse: con ella.
    assert.match(TEMA, /programar\.current\(false\);\s*\},\s*\(enganchado\) => \{\s*if \(enganchado\) programar\.current\(true\);/);
    // Quien escribe dice en qué tema; un aviso de otro tema no recarga nada.
    assert.match(TEMA, /canal\.current\?\.avisar\(\{ tipo: 'mensaje', tema: temaId \}\);/);
    assert.match(TEMA, /if \(pista && pista\.tema !== temaId\) return;\s*programar\.current\(!pista\);/);
  });
});

describe('los comentarios', () => {
  it('la lista va aparte, memorizada y con acciones estables', () => {
    assert.match(COMENTARIOS, /const ListaDeComentarios = memo\(function ListaDeComentarios\(/);
    const uso = COMENTARIOS.slice(COMENTARIOS.indexOf('<ListaDeComentarios'));
    const props = uso.slice(0, uso.indexOf('/>'));
    // Nada que se rehaga en cada tecla: ni funciones en línea ni el texto.
    assert.doesNotMatch(props, /=>/);
    assert.doesNotMatch(props, /inputText/);
    assert.match(props, /lista=\{estado\.lista\}/);
  });
});
