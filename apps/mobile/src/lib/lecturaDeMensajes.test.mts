import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  COLOR_DE_LEIDO,
  cuantosLoLeyeron,
  estadoDeEntrega,
  huellaDeMarcas,
  leerDetalles,
  leerMarcas,
  llevaFranjaDeHora,
  seAnimaElPaso,
  loLeyo,
  tieneDetalles,
} from './lecturaDeMensajes.ts';

/*
  La confirmación de lectura (12/10/2026). Lo esencial: «leído» sale de hasta
  dónde leyó cada persona, en un grupo exige a todos, y no se finge nada que
  el servidor no sepa.
*/

const ENVIO = '2026-10-12T15:00:00+00:00';
const ANTES = '2026-10-12T14:59:59+00:00';
const DESPUES = '2026-10-12T15:00:01+00:00';

test('leer es haber abierto el chat después del mensaje', () => {
  assert.ok(loLeyo(DESPUES, ENVIO));
  // El mismo instante cuenta.
  assert.ok(loLeyo(ENVIO, ENVIO));
  assert.ok(!loLeyo(ANTES, ENVIO));
  // Sin marca, nunca abrió la conversación.
  assert.ok(!loLeyo(null, ENVIO));
  // Con otra forma de escribir la misma hora (la «Z» de PostgreSQL), igual.
  assert.ok(loLeyo('2026-10-12T15:00:00Z', ENVIO));
  // Lo que no es una fecha no cuenta como leído.
  assert.ok(!loLeyo('ayer', ENVIO));
  assert.ok(!loLeyo(DESPUES, undefined));
  assert.ok(!loLeyo(DESPUES, 'sin fecha'));
});

test('en un chat de dos, leído es que lo leyó la otra persona', () => {
  const mensaje = { createdAtIso: ENVIO };
  assert.equal(estadoDeEntrega(mensaje, [{ usuarioId: 'b', leidoHasta: null }]), 'enviado');
  assert.equal(estadoDeEntrega(mensaje, [{ usuarioId: 'b', leidoHasta: ANTES }]), 'enviado');
  assert.equal(estadoDeEntrega(mensaje, [{ usuarioId: 'b', leidoHasta: DESPUES }]), 'leido');
});

test('en un grupo, leído exige a TODOS los demás', () => {
  const mensaje = { createdAtIso: ENVIO };
  const unoFalta = [
    { usuarioId: 'b', leidoHasta: DESPUES },
    { usuarioId: 'c', leidoHasta: ANTES },
    { usuarioId: 'd', leidoHasta: DESPUES },
  ];
  assert.equal(cuantosLoLeyeron(unoFalta, ENVIO), 2);
  assert.equal(estadoDeEntrega(mensaje, unoFalta), 'enviado');

  const todos = unoFalta.map((marca) => ({ ...marca, leidoHasta: DESPUES }));
  assert.equal(cuantosLoLeyeron(todos, ENVIO), 3);
  assert.equal(estadoDeEntrega(mensaje, todos), 'leido');
});

test('lo que se está enviando o falló no llega a «enviado»', () => {
  const leidoPorTodos = [{ usuarioId: 'b', leidoHasta: DESPUES }];
  assert.equal(estadoDeEntrega({ estado: 'enviando', createdAtIso: ENVIO }, leidoPorTodos), 'enviando');
  assert.equal(estadoDeEntrega({ estado: 'error', createdAtIso: ENVIO }, leidoPorTodos), 'fallido');
});

test('sin nadie a quien esperar, o sin respuesta del servidor, es «enviado»', () => {
  // Antes de que llegue la primera respuesta no hay marcas: no se presume nada.
  assert.equal(estadoDeEntrega({ createdAtIso: ENVIO }, []), 'enviado');
  // Un mensaje sin su fecha del servidor no se puede comparar.
  assert.equal(estadoDeEntrega({}, [{ usuarioId: 'b', leidoHasta: DESPUES }]), 'enviado');
});

test('las marcas del servidor se leen sin fiarse de nada', () => {
  assert.deepEqual(
    leerMarcas({
      members: [
        { user_id: 'b', last_read_at: DESPUES },
        { user_id: 'c', last_read_at: null },
        { user_id: 'd' },
        { user_id: '', last_read_at: DESPUES },
        { last_read_at: DESPUES },
        'texto',
        null,
      ],
    }),
    [
      { usuarioId: 'b', leidoHasta: DESPUES },
      { usuarioId: 'c', leidoHasta: null },
      { usuarioId: 'd', leidoHasta: null },
    ],
  );
  for (const raro of [null, undefined, 'x', 7, [], {}, { members: 'no' }]) {
    assert.deepEqual(leerMarcas(raro), [], JSON.stringify(raro));
  }
});

test('la huella de las marcas no depende del orden y cambia cuando alguien lee', () => {
  const a = [
    { usuarioId: 'b', leidoHasta: ANTES },
    { usuarioId: 'c', leidoHasta: null },
  ];
  const elMismoEnOtroOrden = [a[1]!, a[0]!];
  assert.equal(huellaDeMarcas(a), huellaDeMarcas(elMismoEnOtroOrden));
  const alguienLeyo = [{ usuarioId: 'b', leidoHasta: ANTES }, { usuarioId: 'c', leidoHasta: DESPUES }];
  assert.notEqual(huellaDeMarcas(a), huellaDeMarcas(alguienLeyo));
  assert.equal(huellaDeMarcas([]), '');
});

test('los detalles separan quién leyó de quién no', () => {
  const detalles = leerDetalles({
    message_id: 'm',
    sent_at: ENVIO,
    read_by: [{ id: 'b', full_name: ' Bruno ', username: 'bruno', avatar_path: 'b/foto.jpg' }],
    pending: [{ id: 'c', full_name: 'Carla', username: null, avatar_path: null }, { full_name: 'Sin id' }],
  });
  assert.deepEqual(detalles, {
    leyeron: [{ id: 'b', nombre: 'Bruno', usuario: 'bruno', avatarPath: 'b/foto.jpg' }],
    faltan: [{ id: 'c', nombre: 'Carla' }],
  });
  // Una respuesta que no trae las dos listas no se da por buena.
  for (const raro of [null, 'x', {}, { read_by: [] }, { pending: [] }, { read_by: 'a', pending: [] }]) {
    assert.equal(leerDetalles(raro), null, JSON.stringify(raro));
  }
});

test('solo un mensaje propio, enviado y sin borrar tiene detalles', () => {
  assert.ok(tieneDetalles({ sender: 'me' }));
  assert.ok(!tieneDetalles({ sender: 'them' }));
  assert.ok(!tieneDetalles({ sender: 'me', estado: 'enviando' }));
  assert.ok(!tieneDetalles({ sender: 'me', estado: 'error' }));
  assert.ok(!tieneDetalles({ sender: 'me', eliminado: true }));
  // La tarjeta de una sesión la escribe el servidor: no es un mensaje.
  assert.ok(!tieneDetalles({ sender: 'me', esSesion: true }));
});

test('todo mensaje propio enseña su marca, también a mitad de ráfaga', () => {
  const base = { agrupado: true, tieneTexto: true, tieneEstado: false };
  // Lo propio, siempre: «deben haber dos aspas para todo, sea el mensaje que sea».
  assert.ok(llevaFranjaDeHora({ ...base, esMio: true }));
  assert.ok(llevaFranjaDeHora({ ...base, esMio: true, tieneTexto: false }));
  assert.ok(llevaFranjaDeHora({ ...base, esMio: true, agrupado: false }));
  // Lo ajeno no tiene marca: dentro de una ráfaga la hora sigue sin repetirse…
  assert.ok(!llevaFranjaDeHora({ ...base, esMio: false }));
  // …y la lleva donde siempre: el primero de la ráfaga, lo que no trae texto
  // y lo que se está enviando.
  assert.ok(llevaFranjaDeHora({ ...base, agrupado: false, esMio: false }));
  assert.ok(llevaFranjaDeHora({ ...base, tieneTexto: false, esMio: false }));
  assert.ok(llevaFranjaDeHora({ ...base, tieneEstado: true, esMio: false }));
});

test('la marca se anima cuando el mensaje avanza, no cuando falla', () => {
  assert.ok(seAnimaElPaso('enviando', 'enviado'));
  assert.ok(seAnimaElPaso('enviado', 'leido'));
  // De golpe: quien lo recibe tenía el chat abierto.
  assert.ok(seAnimaElPaso('enviando', 'leido'));
  // Un «no se envió» no se celebra, ni el reintento que viene después.
  assert.ok(!seAnimaElPaso('enviando', 'fallido'));
  assert.ok(!seAnimaElPaso('fallido', 'enviando'));
  assert.ok(!seAnimaElPaso('fallido', 'enviado'));
  // Y lo que no cambia, o retrocede, tampoco.
  assert.ok(!seAnimaElPaso('enviado', 'enviado'));
  assert.ok(!seAnimaElPaso('leido', 'enviado'));
});

test('el color de leído tiene contraste sobre las dos burbujas', () => {
  // Luminancia relativa (WCAG) de un color `#RRGGBB`.
  const luminancia = (hex: string) => {
    const canal = (i: number) => {
      const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * canal(0) + 0.7152 * canal(1) + 0.0722 * canal(2);
  };
  const contraste = (a: string, b: string) => {
    const [claro, oscuro] = [luminancia(a), luminancia(b)].sort((x, y) => y - x) as [number, number];
    return (claro + 0.05) / (oscuro + 0.05);
  };
  // La burbuja propia es negra en el tema claro y blanca en el oscuro. Un
  // icono necesita al menos 3:1.
  assert.ok(contraste(COLOR_DE_LEIDO.sobreOscuro, '#000000') >= 3);
  assert.ok(contraste(COLOR_DE_LEIDO.sobreClaro, '#FFFFFF') >= 3);
  // Y se distinguen del blanco y del negro de la marca de «enviado».
  assert.ok(contraste(COLOR_DE_LEIDO.sobreOscuro, '#FFFFFF') >= 1.5);
  assert.ok(contraste(COLOR_DE_LEIDO.sobreClaro, '#000000') >= 3);
});
