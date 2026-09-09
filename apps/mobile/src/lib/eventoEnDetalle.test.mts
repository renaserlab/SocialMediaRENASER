/**
 * La ficha de un evento, con las reglas ejecutadas de verdad.
 *
 * La prueba que más importa es la del aforo: `null` y `0` NO son lo mismo. Sin
 * aforo puesto la pantalla dice cuántos van; con aforo cero diría «0 de 0
 * plazas», que es otra afirmación y además falsa.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { en } from '../i18n/en.ts';
import { es } from '../i18n/es.ts';
import { pt } from '../i18n/pt.ts';
import {
  aforoCompleto,
  aforoDelEvento,
  fechaLargaDelEvento,
  modalidadDelEvento,
  sePuedeReservar,
} from './eventoEnDetalle.ts';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('cuándo se ofrece reservar', () => {
  it('solo con fecha por llegar', () => {
    assert.equal(sePuedeReservar({ timeState: 'upcoming' }), true);
  });

  it('un evento pasado no se reserva', () => {
    // Lo rechaza el servidor; ofrecerlo sería mandar a alguien a un error.
    assert.equal(sePuedeReservar({ timeState: 'past' }), false);
  });

  it('uno sin fecha tampoco', () => {
    // No se sabe a qué se estaría apuntando nadie.
    assert.equal(sePuedeReservar({ timeState: 'undated' }), false);
  });

  it('y sin saberlo, no se ofrece', () => {
    assert.equal(sePuedeReservar({}), false);
  });
});

describe('el aforo', () => {
  it('null cuando el organizador no lo puso', () => {
    assert.equal(aforoDelEvento({}), null);
    assert.equal(aforoDelEvento({ capacity: null }), null);
  });

  it('cero NO es un aforo', () => {
    // «0 de 0 plazas» sería una afirmación distinta, y falsa.
    assert.equal(aforoDelEvento({ capacity: 0 }), null);
  });

  it('un número real sí', () => {
    assert.equal(aforoDelEvento({ capacity: 40 }), 40);
  });

  it('sin aforo nunca está completo', () => {
    assert.equal(aforoCompleto({ registrationsCount: 999 }), false);
  });

  it('con aforo, se compara contra el conteo real', () => {
    assert.equal(aforoCompleto({ capacity: 2, registrationsCount: 1 }), false);
    assert.equal(aforoCompleto({ capacity: 2, registrationsCount: 2 }), true);
    assert.equal(aforoCompleto({ capacity: 2, registrationsCount: 3 }), true);
  });
});

describe('la fecha larga', () => {
  const inicio = new Date('2026-09-18T18:00:00Z');

  it('sin fecha no se escribe nada', () => {
    assert.equal(fechaLargaDelEvento({}), '');
    assert.equal(fechaLargaDelEvento({ startsAtDate: new Date('no es fecha') }), '');
  });

  it('con fecha se escribe día y hora', () => {
    const texto = fechaLargaDelEvento({ startsAtDate: inicio });
    assert.ok(texto.length > 0);
    assert.ok(!texto.includes('–'), 'sin fin no hay rango');
  });

  it('con fin el mismo día, un rango de horas', () => {
    const texto = fechaLargaDelEvento({
      startsAtDate: inicio,
      endsAtDate: new Date('2026-09-18T21:00:00Z'),
    });
    assert.ok(texto.includes('–'));
  });

  it('con fin en otro día, las dos fechas completas', () => {
    const texto = fechaLargaDelEvento({
      startsAtDate: inicio,
      endsAtDate: new Date('2026-09-20T21:00:00Z'),
    });
    assert.ok(texto.includes('–'));
    // Dos días distintos: aparecen los dos números de día.
    assert.ok(/18/.test(texto) && /20/.test(texto));
  });

  it('un fin roto no rompe la fecha de inicio', () => {
    const texto = fechaLargaDelEvento({
      startsAtDate: inicio,
      endsAtDate: new Date('tampoco'),
    });
    assert.ok(texto.length > 0);
    assert.ok(!texto.includes('Invalid'));
  });

  it('NO se añade una zona horaria', () => {
    // `starts_at` guarda el instante, no la zona del evento: escribir
    // «(hora de Lima)» sería una afirmación que el dato no sostiene.
    const texto = fechaLargaDelEvento({ startsAtDate: inicio });
    for (const rastro of ['GMT', 'UTC', 'PET', '+0']) {
      assert.ok(!texto.includes(rastro), `«${rastro}» no puede salir: ${texto}`);
    }
  });
});

describe('la modalidad', () => {
  it('las tres del modelo', () => {
    assert.equal(modalidadDelEvento({ type: 'presencial' }), 'evento.modalidad.presencial');
    assert.equal(modalidadDelEvento({ type: 'webinar' }), 'evento.modalidad.online');
    assert.equal(modalidadDelEvento({ type: 'live' }), 'evento.modalidad.live');
  });

  it('una que el modelo no tiene no se inventa', () => {
    assert.equal(modalidadDelEvento({}), 'evento.modalidad.desconocida');
  });
});

describe('lo que la ficha NO pinta', () => {
  const BLOQUE = new RegExp('/\\*[\\s\\S]*?\\*/', 'g');
  const LINEA = new RegExp('//[^\\n]*', 'g');
  const PANTALLA = fuente('screens/EventoScreen.tsx')
    .replace(BLOQUE, ' ')
    .replace(LINEA, ' ');

  it('ni distancia ni ubicación aproximada: no hay coordenadas', () => {
    for (const palabra of ['distancia', 'km', 'latitud', 'longitud', 'Cerca de ti']) {
      assert.ok(
        !PANTALLA.toLowerCase().includes(palabra.toLowerCase()),
        `«${palabra}» no tiene con qué calcularse`,
      );
    }
  });

  it('el precio solo cuando el evento vende entradas', () => {
    /*
      ESTA PRUEBA DECÍA LO CONTRARIO, y tenía razón entonces: los eventos no
      tenían precio ni entradas, así que cualquier mención prometía un flujo
      que no existía. Ahora existe, y lo que hay que defender es otra cosa: que
      el precio no aparezca en un evento GRATUITO.

      La condición es `vendeEntradas(evento.accessMode)`, y `accessMode` a
      `null` —que es lo que llega del listado— NO vende entradas.
    */
    assert.ok(PANTALLA.includes('vendeEntradas(evento.accessMode)'));
    // Y sigue sin haber compra: ni pasarela, ni total, ni «comprar».
    for (const palabra of ['comprar', 'checkout', 'Stripe', 'pagar']) {
      assert.ok(
        !PANTALLA.toLowerCase().includes(palabra.toLowerCase()),
        `«${palabra}» prometería un flujo que no existe`,
      );
    }
  });

  it('ni sello de curaduría: no hay `selection_status`', () => {
    for (const palabra of ['Seleccionado por Z', 'selection', 'curad', 'verificado']) {
      assert.ok(!PANTALLA.toLowerCase().includes(palabra.toLowerCase()), palabra);
    }
  });

  it('el conteo de inscritos es el real, no un redondeo', () => {
    assert.ok(PANTALLA.includes('registrationsCount'));
    assert.ok(!PANTALLA.includes('Más de'));
  });

  it('dos toques no mandan dos reservas', () => {
    const cuerpo = PANTALLA.slice(PANTALLA.indexOf('const alternarReserva ='));
    const cerrojo = cuerpo.indexOf('reservandoRef.current = true');
    assert.ok(cerrojo !== -1 && cerrojo < cuerpo.indexOf('await'));
  });

  it('cancelar una reserva pide confirmación', () => {
    assert.ok(PANTALLA.includes('destructive: true'));
  });

  it('el organizador lleva a su perfil real', () => {
    assert.ok(PANTALLA.includes('irAlPerfil(router'));
  });
});

describe('el recorrido llega a la ficha', () => {
  it('desde Explorar', () => {
    assert.ok(fuente('screens/ExploreScreen.tsx').includes('/eventos/${event.id}'));
  });

  it('desde la búsqueda', () => {
    assert.ok(
      fuente('components/resultadosDeBusqueda.tsx').includes('/eventos/${fila.evento.id}'),
    );
  });

  it('y desde el listado', () => {
    assert.ok(fuente('screens/EventsScreen.tsx').includes('/eventos/${event.id}'));
  });

  it('buscar y filtrar los resuelve el servidor', () => {
    const repo = fuente('repositories/CatalogRepository.ts');
    assert.ok(repo.includes('q=${encodeURIComponent(texto)}'));
    assert.ok(repo.includes('event_type=${filtros.modalidad}'));
    // Y la pantalla NO filtra sobre lo ya descargado.
    const pantalla = fuente('screens/EventsScreen.tsx');
    assert.ok(!pantalla.includes('.filter((e) => e.title'));
  });
});

describe('los tres idiomas dicen todo lo que la ficha pregunta', () => {
  it('ninguna clave usada aquí falta en es, en o pt', () => {
    const usadas = [
      ...new Set(
        [fuente('screens/EventoScreen.tsx'), fuente('lib/eventoEnDetalle.ts')]
          .join('\n')
          .match(new RegExp("'(evento\\.[a-zA-Z.]+|eventos\\.[a-zA-Z.]+)'", 'g')) ?? [],
      ),
    ].map((m) => m.slice(1, -1));

    assert.ok(usadas.length > 8, 'no se encontraron claves, la búsqueda falla');
    for (const [nombre, diccionario] of [
      ['es', es],
      ['en', en],
      ['pt', pt],
    ] as Array<[string, Record<string, string>]>) {
      for (const clave of usadas) {
        assert.ok(
          (diccionario[clave] ?? '').trim() !== '',
          `falta ${clave} en ${nombre}`,
        );
      }
    }
  });
});
