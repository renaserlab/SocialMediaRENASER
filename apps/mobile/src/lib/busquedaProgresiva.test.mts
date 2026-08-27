/**
 * La carrera de respuestas de la pantalla de buscar.
 *
 * LO QUE DE VERDAD SE FIJA AQUI es que una respuesta lenta NUNCA pise a una mas
 * nueva. Es el fallo caro de cualquier buscador que va escribiendo: no da error,
 * no aparece en los logs y no se reproduce en una red buena, porque ahi las
 * respuestas casi siempre vuelven en el orden en que salieron. Se manifiesta
 * como «busque una cosa y me salio otra», que es imposible de depurar contando
 * con que alguien lo cuente bien.
 *
 * Por eso las pruebas simulan el desorden a mano: se lanzan dos busquedas y se
 * resuelve ANTES la vieja. Si algun dia se cambia `aplicar` para «ir mas
 * rapido», estas pruebas son lo que impide que el cambio se lleve por delante
 * el descarte.
 *
 * Se ejecutan con `npm run test` (el runner de Node, sin dependencias).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ampliar,
  anotarTecleo,
  aplicar,
  debeDecirSinResultados,
  esBuscable,
  esVigente,
  estadoInicial,
  estaOcupado,
  hayBusquedaPendiente,
  lanzar,
  limpiar,
  marcarFallo,
  MINIMO_DE_TERMINO,
  normalizarTermino,
  totalDeResultados,
  type EstadoDeBusqueda,
  type PersonaDto,
  type PublicacionDto,
  type RespuestaDeBusqueda,
} from './busquedaProgresiva.ts';

/** Una persona de mentira, con lo justo para distinguirla de otra. */
function persona(id: string): PersonaDto {
  return {
    id,
    full_name: `Persona ${id}`,
    username: id,
    avatar_path: null,
    bio: '',
    offer_topics: [],
  };
}

/** Una publicacion de mentira. */
function publicacion(id: string): PublicacionDto {
  return {
    id,
    body: `cuerpo ${id}`,
    author_id: 'a1',
    author_name: 'Autora',
    author_username: 'autora',
    author_avatar_path: null,
    created_at: null,
    topics: [],
  };
}

/** Una respuesta con solo las personas que se le pasen. */
function conPersonas(ids: string[], siguiente: number | null = null): RespuestaDeBusqueda {
  return { people: ids.map(persona), next_offset: { people: siguiente } };
}

/** El estado tras buscar «carpinteria» y recibir su respuesta. */
function conUnaBusquedaHecha(): { estado: EstadoDeBusqueda } {
  const lanzada = lanzar(estadoInicial(), 'carpinteria');
  return { estado: aplicar(lanzada.estado, lanzada.sello, conPersonas(['c1', 'c2'], 10)) };
}

describe('descartar respuestas viejas', () => {
  it('tira la respuesta de la busqueda anterior aunque llegue despues', () => {
    // El caso real: se escribe «carp», se sigue escribiendo hasta
    // «carpinteria», y la primera respuesta —lenta— llega la ultima.
    const primera = lanzar(estadoInicial(), 'carp');
    const segunda = lanzar(primera.estado, 'carpinteria');

    const conLaNueva = aplicar(segunda.estado, segunda.sello, conPersonas(['nueva']));
    const conLaVieja = aplicar(conLaNueva, primera.sello, conPersonas(['vieja']));

    assert.deepEqual(
      conLaVieja.resultados.people.map((p) => p.id),
      ['nueva'],
      'la respuesta de «carp» piso a la de «carpinteria»',
    );
  });

  it('deja el estado EXACTAMENTE igual, no solo parecido', () => {
    // Devolver un objeto nuevo equivalente bastaria para no perder datos, pero
    // haria repintar la lista entera en cada respuesta caducada.
    const primera = lanzar(estadoInicial(), 'carp');
    const segunda = lanzar(primera.estado, 'carpinteria');
    const pintada = aplicar(segunda.estado, segunda.sello, conPersonas(['nueva']));

    assert.equal(aplicar(pintada, primera.sello, conPersonas(['vieja'])), pintada);
  });

  it('acepta la respuesta que si es la ultima lanzada', () => {
    const { estado, sello } = lanzar(estadoInicial(), 'carpinteria');
    const pintada = aplicar(estado, sello, conPersonas(['c1']));
    assert.deepEqual(pintada.resultados.people.map((p) => p.id), ['c1']);
    assert.equal(pintada.cargando, false);
  });

  it('no vuelve a llenar la lista despues de vaciar el buscador', () => {
    // Escribir y borrar de golpe: la peticion ya salio y no se puede
    // desconvocar, asi que lo unico que evita ver resultados sobre un buscador
    // vacio es que su sello haya caducado.
    const { estado, sello } = lanzar(estadoInicial(), 'carpinteria');
    const vaciado = limpiar(estado);

    const despues = aplicar(vaciado, sello, conPersonas(['c1']));
    assert.equal(totalDeResultados(despues), 0);
    assert.equal(despues.cargando, false);
  });

  it('tampoco pinta el ERROR de una busqueda que ya no interesa', () => {
    // Si el fallo de «carp» se pintara, cambiar de termino dejaria un aviso de
    // error encima de unos resultados perfectamente validos.
    const primera = lanzar(estadoInicial(), 'carp');
    const segunda = lanzar(primera.estado, 'carpinteria');
    const pintada = aplicar(segunda.estado, segunda.sello, conPersonas(['nueva']));

    const conFalloViejo = marcarFallo(pintada, primera.sello);
    assert.equal(conFalloViejo.fallo, false);
    assert.deepEqual(conFalloViejo.resultados.people.map((p) => p.id), ['nueva']);
  });

  it('un «ver mas» caduca en cuanto se busca otra cosa', () => {
    // Se pulsa «ver mas» y, antes de que conteste, se escribe otro termino: esa
    // pagina pertenece a una busqueda que ya no esta en pantalla.
    const { estado } = conUnaBusquedaHecha();
    const ampliada = ampliar(estado, 'people');
    assert.ok(ampliada, 'deberia poder ampliar: el backend dijo que hay mas');

    const otra = lanzar(ampliada.estado, 'ceramica');
    const conLaOtra = aplicar(otra.estado, otra.sello, conPersonas(['z1']));
    const conLaPagina = aplicar(conLaOtra, ampliada.sello, conPersonas(['c3', 'c4']));

    assert.deepEqual(conLaPagina.resultados.people.map((p) => p.id), ['z1']);
  });

  it('el numero de orden nunca se repite ni retrocede', () => {
    // Toda la regla se apoya en que el numero suba SIEMPRE. Si vaciar o ampliar
    // no gastaran uno, dos peticiones distintas compartirian sello y la de
    // antes podria colarse como si fuera la de ahora.
    let estado = estadoInicial();
    const vistos: number[] = [];

    const a = lanzar(estado, 'carp');
    vistos.push(a.sello.id);
    estado = aplicar(a.estado, a.sello, conPersonas(['c1'], 10));

    const mas = ampliar(estado, 'people');
    assert.ok(mas);
    vistos.push(mas.sello.id);
    estado = mas.estado;

    estado = limpiar(estado);
    vistos.push(estado.secuencia);

    const b = lanzar(estado, 'ceramica');
    vistos.push(b.sello.id);

    for (let i = 1; i < vistos.length; i += 1) {
      assert.ok(vistos[i]! > vistos[i - 1]!, `el sello ${vistos[i]} no supera al anterior`);
    }
  });

  it('mira tambien el termino, no solo el numero', () => {
    // Cinturon y tirantes: si algun dia se manda una peticion sin pasar por
    // `lanzar`, el termino la delata igual.
    const { estado, sello } = lanzar(estadoInicial(), 'carpinteria');
    assert.equal(esVigente(estado, sello), true);
    assert.equal(esVigente(estado, { ...sello, termino: 'otra cosa' }), false);
  });
});

describe('paginar un grupo sin tocar los demas', () => {
  it('añade la pagina al final y deja los otros grupos como estaban', () => {
    const lanzada = lanzar(estadoInicial(), 'carpinteria');
    const primera = aplicar(lanzada.estado, lanzada.sello, {
      people: [persona('c1')],
      posts: [publicacion('p1')],
      next_offset: { people: 10, posts: null },
    });

    const mas = ampliar(primera, 'people');
    assert.ok(mas);
    const segunda = aplicar(mas.estado, mas.sello, conPersonas(['c2'], null));

    assert.deepEqual(segunda.resultados.people.map((p) => p.id), ['c1', 'c2']);
    assert.deepEqual(segunda.resultados.posts.map((p) => p.id), ['p1']);
    assert.equal(segunda.resultados.siguiente.people, null);
    assert.equal(segunda.resultados.siguiente.posts, null);
    assert.equal(segunda.ampliando, null);
  });

  it('no repite una fila que reaparece en la pagina siguiente', () => {
    // Entre dos paginas alguien publica y el orden se mueve: la fila del borde
    // vuelve a salir. Repetida daria dos claves iguales en la lista.
    const lanzada = lanzar(estadoInicial(), 'carpinteria');
    const primera = aplicar(lanzada.estado, lanzada.sello, conPersonas(['c1', 'c2'], 2));

    const mas = ampliar(primera, 'people');
    assert.ok(mas);
    const segunda = aplicar(mas.estado, mas.sello, conPersonas(['c2', 'c3']));

    assert.deepEqual(segunda.resultados.people.map((p) => p.id), ['c1', 'c2', 'c3']);
  });

  it('no deja pedir mas cuando el backend dijo que no queda nada', () => {
    const lanzada = lanzar(estadoInicial(), 'carpinteria');
    const estado = aplicar(lanzada.estado, lanzada.sello, conPersonas(['c1'], null));
    assert.equal(ampliar(estado, 'people'), null);
    assert.equal(ampliar(estado, 'courses'), null, 'un grupo sin `next_offset` tampoco amplia');
  });

  it('un «ver mas» que falla no borra lo que ya se veia', () => {
    const { estado } = conUnaBusquedaHecha();
    const mas = ampliar(estado, 'people');
    assert.ok(mas);

    const tras = marcarFallo(mas.estado, mas.sello);
    assert.equal(tras.fallo, false, 'ampliar mal no convierte la busqueda en un error');
    assert.equal(tras.ampliando, null);
    assert.equal(totalDeResultados(tras), 2);
  });
});

describe('que se enseña mientras se escribe', () => {
  it('mantiene los resultados anteriores mientras llega la respuesta nueva', () => {
    // Si la lista se vaciara en cada tecla, escribir seria un parpadeo.
    const { estado } = conUnaBusquedaHecha();
    const otra = lanzar(estado, 'carpinteria fina');
    assert.equal(totalDeResultados(otra.estado), 2);
    assert.equal(otra.estado.cargando, true);
  });

  it('no dice «sin resultados» antes de haber preguntado', () => {
    const escrito = anotarTecleo(estadoInicial(), 'carpinteria');
    assert.equal(hayBusquedaPendiente(escrito), true);
    assert.equal(estaOcupado(escrito), true);
    assert.equal(debeDecirSinResultados(escrito), false);
  });

  it('no dice «sin resultados» con una busqueda en vuelo', () => {
    const { estado } = lanzar(estadoInicial(), 'carpinteria');
    assert.equal(debeDecirSinResultados(estado), false);
  });

  it('lo dice cuando la respuesta llego de verdad vacia', () => {
    const { estado, sello } = lanzar(estadoInicial(), 'carpinteria');
    const vacia = aplicar(estado, sello, { next_offset: {} });
    assert.equal(debeDecirSinResultados(vacia), true);
  });

  it('no lo dice cuando lo que hubo fue un error', () => {
    // «No encontramos nada» y «no pudimos preguntar» son cosas distintas: la
    // primera invita a probar otra palabra, la segunda a reintentar.
    const { estado, sello } = lanzar(estadoInicial(), 'carpinteria');
    const rota = marcarFallo(estado, sello);
    assert.equal(rota.fallo, true);
    assert.equal(debeDecirSinResultados(rota), false);
  });

  it('sigue sin decirlo mientras se teclea sobre una respuesta vacia', () => {
    const { estado, sello } = lanzar(estadoInicial(), 'carpinteria');
    const vacia = aplicar(estado, sello, { next_offset: {} });
    assert.equal(debeDecirSinResultados(anotarTecleo(vacia, 'carpinteria f')), false);
  });
});

describe('cuando se busca y cuando no', () => {
  it('exige el minimo de letras', () => {
    assert.equal(esBuscable(''), false);
    assert.equal(esBuscable('a'), false);
    assert.equal(esBuscable('ab'), true);
    assert.equal(MINIMO_DE_TERMINO, 2);
  });

  it('los espacios no cuentan como letras', () => {
    assert.equal(esBuscable('  a  '), false);
    assert.equal(normalizarTermino('  carpinteria  '), 'carpinteria');
  });

  it('quedarse por debajo del minimo vacia la pantalla', () => {
    // Ver los resultados de «carpinteria» debajo de una «c» suelta se lee como
    // que la aplicacion se ha quedado colgada.
    const { estado } = conUnaBusquedaHecha();
    const tras = anotarTecleo(estado, 'c');
    assert.equal(totalDeResultados(tras), 0);
    assert.equal(tras.termino, '');
    assert.ok(tras.secuencia > estado.secuencia, 'vaciar tiene que caducar lo que iba en vuelo');
  });

  it('teclear lo mismo no mueve el estado', () => {
    // Sin esto, cada pulsacion que no cambia el texto —repetir, mover el
    // cursor— repintaria la lista entera.
    const escrito = anotarTecleo(estadoInicial(), 'carpinteria');
    assert.equal(anotarTecleo(escrito, 'carpinteria '), escrito);
  });

  it('lanzar cierra la busqueda pendiente', () => {
    const escrito = anotarTecleo(estadoInicial(), 'carpinteria');
    const { estado } = lanzar(escrito, escrito.tecleado);
    assert.equal(hayBusquedaPendiente(estado), false);
    assert.equal(estaOcupado(estado), true, 'sigue ocupado: la peticion esta en vuelo');
  });
});
