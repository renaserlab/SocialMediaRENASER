import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { bandejaAlDia, sinLeerEn } from './bandeja.ts';

/*
  Reportado el 05/10/2026: «alguien me envió mensaje y entré directamente a su
  chat; cuando salí seguía apareciendo como si no lo hubiese visto». El globo
  de la barra estaba bien; la fila de la bandeja, no.
*/

type Fila = { id: string; unread: number; subtitle?: string };
const fila = (id: string, unread = 0, subtitle = ''): Fila => ({ id, unread, subtitle });

describe('una conversación recién leída deja de verse pendiente', () => {
  it('su fila pasa a cero y las demás no se tocan', () => {
    const antes = [fila('a', 2), fila('b', 1), fila('c')];
    const despues = sinLeerEn(antes, 'b');
    assert.deepEqual(despues, [fila('a', 2), fila('b', 0), fila('c')]);
    // Las que no cambian son EL MISMO objeto: no se repintan.
    assert.equal(despues[0], antes[0]);
    assert.equal(despues[2], antes[2]);
  });

  it('si no había nada pendiente devuelve la misma lista: no repinta', () => {
    const antes = [fila('a', 2), fila('b')];
    assert.equal(sinLeerEn(antes, 'b'), antes);
    assert.equal(sinLeerEn(antes, 'no-esta'), antes);
    assert.equal(sinLeerEn([], 'a').length, 0);
  });
});

describe('la bandeja al día con la lectura fresca del contador', () => {
  it('en la portada se adopta entera, con su orden nuevo', () => {
    const actuales = [fila('a', 1, 'viejo'), fila('b')];
    // Ha llegado algo de «c», que antes ni estaba, y «a» ya se leyó.
    const frescas = [fila('c', 1, 'hola'), fila('a', 0, 'viejo'), fila('b')];
    assert.deepEqual(bandejaAlDia(actuales, frescas, true), frescas);
  });

  it('en la portada se conserva lo ya bajado de páginas siguientes', () => {
    const actuales = [fila('a', 1), fila('b'), fila('pagina-2'), fila('pagina-2b')];
    const frescas = [fila('b', 3), fila('a', 0)];
    assert.deepEqual(
      bandejaAlDia(actuales, frescas, true).map((c) => c.id),
      ['b', 'a', 'pagina-2', 'pagina-2b'],
    );
  });

  it('con búsqueda o filtro: solo se actualizan las que coinciden, sin añadir ni reordenar', () => {
    const actuales = [fila('b', 1), fila('z', 4)];
    const frescas = [fila('a'), fila('b', 0), fila('c', 2)];
    assert.deepEqual(bandejaAlDia(actuales, frescas, false), [fila('b', 0), fila('z', 4)]);
  });

  it('una lectura vacía no borra lo que hay delante', () => {
    const actuales = [fila('a', 1)];
    assert.equal(bandejaAlDia(actuales, [], true), actuales);
    assert.equal(bandejaAlDia(actuales, [], false), actuales);
  });
});

describe('enchufado: el chat avisa y la bandeja escucha', () => {
  const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
  const CHAT = fuente('screens/ChatScreen.tsx');
  const BANDEJA = fuente('screens/MessagesScreen.tsx');
  const CONTADORES = fuente('services/contadores.ts');

  it('el chat marca leído por la puerta que también avisa a la bandeja', () => {
    assert.ok(!/MessageRepository\.markRead\(/.test(CHAT), 'vuelve a marcar leído sin avisar');
    // Al abrir y con cada mensaje que llega con el chat delante, por una sola
    // puerta (28/10/2026). Cuando el servidor ya lo anotó, se avisa a los
    // demás de que se leyó (la confirmación de lectura, 12/10/2026).
    assert.equal(
      CHAT.match(/avisarSiSeAnoto\(await marcarConversacionLeida\(conversationId\)\);/g)?.length,
      1,
    );
    assert.equal(CHAT.match(/marcarConversacionLeida\(conversationId\)/g)?.length, 1);
    // Entrar lee siempre; lo que llega, solo si se está mirando.
    assert.match(CHAT, /\/\/ Entrar es leer[^\n]*\n\s*leer\(\);/);
    assert.match(CHAT, /const leerSiSeVe = \(\) => \{\s*if \(aLaVista\.current && AppState\.currentState === 'active'\) \{\s*leer\(\);/);
  });

  it('marcar leído avisa en el acto, sin esperar al servidor', () => {
    const cuerpo = CONTADORES.slice(CONTADORES.indexOf('export function marcarConversacionLeida'));
    // La petición sale y NO se espera: la bandeja se entera antes de que
    // conteste el servidor. Lo que se devuelve es para quien quiera saber
    // si el servidor lo anotó, y nunca lanza.
    assert.match(
      cuerpo,
      /const anotado = MessageRepository\.markRead\(conversacionId\)\.then\(\s*\(\) => true,\s*\(\) => false,\s*\);/,
    );
    assert.match(cuerpo, /for \(const oyente of oyentesDeLeida\) oyente\(conversacionId\);\s*return anotado;/);
    assert.doesNotMatch(cuerpo.slice(0, cuerpo.indexOf('return anotado;')), /await /);
    assert.match(cuerpo, /^export function marcarConversacionLeida\(conversacionId: string\): Promise<boolean> \{/);
  });

  it('la lectura del contador se le da a quien tenga la bandeja pintada', () => {
    const cuerpo = CONTADORES.slice(
      CONTADORES.indexOf('export async function refrescarMensajes'),
      CONTADORES.indexOf('export function anotarMensajes'),
    );
    assert.match(cuerpo, /for \(const oyente of oyentesDeLaBandeja\) oyente\(conversaciones\);/);
  });

  it('la bandeja escucha las dos cosas y deja de escuchar al desmontarse', () => {
    assert.match(BANDEJA, /alLeerUnaConversacion\(\(conversacionId\) => \{\s*setRemote\(\(actuales\) => sinLeerEn\(actuales, conversacionId\)/);
    assert.match(BANDEJA, /const portada = !hayConsulta\(consultaRef\.current\);\s*setRemote\(\(actuales\) => bandejaAlDia\(actuales, frescas, portada\)/);
    assert.match(
      BANDEJA,
      /return \(\) => \{\s*dejarLasLeidas\(\);\s*dejarLaBandeja\(\);\s*dejarLosCambios\(\);\s*\};/,
    );
    // Lo que llega en vivo se fusiona igual, pero NO cuenta como recién
    // cargado: al enfocar con datos viejos se sigue preguntando (28/10/2026).
    const enVivo = BANDEJA.slice(BANDEJA.indexOf('alCambiarLaBandeja((portadaEnVivo) => {'));
    assert.match(enVivo, /^alCambiarLaBandeja\(\(portadaEnVivo\) => \{\s*const portada = !hayConsulta\(consultaRef\.current\);\s*setRemote\(\(actuales\) => bandejaAlDia\(actuales, portadaEnVivo, portada\) as Conversation\[\]\);\s*\}\);/);
  });
});
