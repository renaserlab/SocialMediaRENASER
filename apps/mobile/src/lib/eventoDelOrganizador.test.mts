/**
 * La consola del organizador: qué se puede editar, qué falta para enviar y qué
 * significa un aforo en blanco.
 *
 * La prueba que más importa es la del aforo: VACÍO NO ES CERO. En blanco
 * significa «sin límite»; cero significa «no cabe nadie», y convertir lo
 * primero en lo segundo cierra un evento que nadie quiso cerrar.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CATEGORIAS,
  aforoEscrito,
  claveDeCategoria,
  estaEnRevision,
  estaPublicado,
  fechaDeInicio,
  hayCambiosSinGuardar,
  motivoParaNoEnviar,
  sePuedeEditar,
  type CamposDelBorrador,
} from './eventoDelOrganizador.ts';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const completo = (extra: Partial<CamposDelBorrador> = {}): CamposDelBorrador => ({
  title: 'Cena de autor',
  description: 'Una cena de siete tiempos con la chef, en su propia cocina.',
  promise: 'Cenarás lo que la chef cocina para su familia.',
  category: 'gastronomia',
  location: 'Barranco, Lima',
  eventType: 'presential',
  dia: '20/11/2026',
  hora: '19:00',
  capacity: '20',
  ...extra,
});

describe('qué se puede editar', () => {
  it('un borrador, sí', () => {
    assert.equal(sePuedeEditar('DRAFT'), true);
  });

  it('un condicional también: tiene que poder corregir', () => {
    assert.equal(sePuedeEditar('CONDITIONAL'), true);
  });

  it('lo enviado NO', () => {
    // Lo que curaduría revisa es la versión congelada; cambiarla por debajo
    // convierte la revisión en una foto de algo que ya no existe.
    assert.equal(sePuedeEditar('SUBMITTED'), false);
  });

  it('ni lo aprobado ni lo publicado', () => {
    assert.equal(sePuedeEditar('APPROVED'), false);
    assert.equal(sePuedeEditar('PUBLISHED'), false);
  });
});

describe('qué está esperando a otra persona', () => {
  it('lo enviado y lo condicional', () => {
    assert.equal(estaEnRevision('SUBMITTED'), true);
    assert.equal(estaEnRevision('CONDITIONAL'), true);
  });

  it('un borrador no espera a nadie', () => {
    assert.equal(estaEnRevision('DRAFT'), false);
  });
});

describe('qué está a la vista del público', () => {
  it('publicado y agotado', () => {
    assert.equal(estaPublicado('PUBLISHED'), true);
    assert.equal(estaPublicado('SOLD_OUT'), true);
  });

  it('aprobado NO es publicado', () => {
    // Es la distinción que hace que aprobar y publicar sean dos decisiones.
    assert.equal(estaPublicado('APPROVED'), false);
  });

  it('suspendido tampoco', () => {
    assert.equal(estaPublicado('SUSPENDED'), false);
  });
});

describe('qué falta para poder enviarlo', () => {
  it('con todo puesto, nada', () => {
    assert.equal(motivoParaNoEnviar(completo()), null);
  });

  it('sin título', () => {
    assert.equal(motivoParaNoEnviar(completo({ title: '  ' })), 'miEvento.faltaTitulo');
  });

  it('con una descripción demasiado corta para revisarla', () => {
    assert.equal(
      motivoParaNoEnviar(completo({ description: 'Está guay' })),
      'miEvento.faltaDescripcion',
    );
  });

  it('sin promesa', () => {
    assert.equal(motivoParaNoEnviar(completo({ promise: '' })), 'miEvento.faltaPromesa');
  });

  it('sin categoría', () => {
    assert.equal(motivoParaNoEnviar(completo({ category: '' })), 'miEvento.faltaCategoria');
  });

  it('sin día', () => {
    assert.equal(motivoParaNoEnviar(completo({ dia: '' })), 'miEvento.faltaFecha');
  });

  it('sin hora', () => {
    // LA HORA NO SE INVENTA. La primera versión componía la fecha a las 19:00
    // «por poner algo», y esa hora se publicaba en la ficha.
    assert.equal(motivoParaNoEnviar(completo({ hora: '' })), 'miEvento.faltaHora');
  });

  it('con una fecha que no existe', () => {
    assert.equal(
      motivoParaNoEnviar(completo({ dia: '31/02/2026' })),
      'miEvento.fechaImposible',
    );
    assert.equal(
      motivoParaNoEnviar(completo({ hora: '25:00' })),
      'miEvento.fechaImposible',
    );
  });

  it('presencial sin recinto', () => {
    assert.equal(
      motivoParaNoEnviar(completo({ location: '' })),
      'miEvento.faltaRecinto',
    );
  });

  it('en línea SIN recinto sí se puede: no hay recinto que dar', () => {
    assert.equal(
      motivoParaNoEnviar(completo({ eventType: 'online', location: '' })),
      null,
    );
  });

  it('NO se pide nada que no se pueda guardar', () => {
    // El programa detallado y la lista de participantes no tienen dónde
    // escribirse todavía. Exigirlos sería un requisito imposible.
    const reglas = fuente('lib/eventoDelOrganizador.ts');
    for (const inventado of ['programa', 'participantes', 'accesibilidad', 'seguro']) {
      assert.ok(!reglas.includes(`miEvento.falta${inventado}`), inventado);
    }
  });
});

describe('la fecha de inicio NO se inventa', () => {
  it('con día y hora, la fecha que se escribió', () => {
    const f = fechaDeInicio('20/11/2026', '19:30');
    assert.ok(f !== null);
    assert.equal(f!.getFullYear(), 2026);
    assert.equal(f!.getMonth(), 10);
    assert.equal(f!.getDate(), 20);
    assert.equal(f!.getHours(), 19);
    assert.equal(f!.getMinutes(), 30);
  });

  it('sin hora NO hay fecha, y no se pone una por defecto', () => {
    /*
      EL FALLO. La pantalla solo pedía el día y componía
      `new Date(a, m - 1, d, 19, 0, 0)`: las siete de la tarde, porque sí. Y esa
      hora se publicaba —la ficha la imprime con `toLocaleTimeString`—, así que
      quien abría el evento leía «07:00 p. m.» sin que nadie la hubiera escrito.
    */
    assert.equal(fechaDeInicio('20/11/2026', ''), null);
    assert.equal(fechaDeInicio('20/11/2026', '  '), null);
  });

  it('sin día tampoco', () => {
    assert.equal(fechaDeInicio('', '19:00'), null);
  });

  it('un día que no existe no se normaliza en silencio', () => {
    // `new Date(2026, 1, 31)` da el 3 de marzo sin protestar.
    assert.equal(fechaDeInicio('31/02/2026', '19:00'), null);
  });

  it('una hora que no existe tampoco', () => {
    assert.equal(fechaDeInicio('20/11/2026', '25:00'), null);
    assert.equal(fechaDeInicio('20/11/2026', '10:71'), null);
  });

  it('una fecha mal escrita no se adivina', () => {
    assert.equal(fechaDeInicio('20-11-2026', '19:00'), null);
    assert.equal(fechaDeInicio('mañana', '19:00'), null);
  });
});

describe('el aforo escrito', () => {
  it('en blanco es SIN LÍMITE, no cero', () => {
    assert.equal(aforoEscrito(''), null);
    assert.equal(aforoEscrito('   '), null);
  });

  it('cero es cero: «no cabe nadie» es otra cosa', () => {
    assert.equal(aforoEscrito('0'), 0);
  });

  it('un número normal', () => {
    assert.equal(aforoEscrito('120'), 120);
  });

  it('lo que no es un número no se convierte en cero', () => {
    assert.equal(aforoEscrito('muchos'), null);
    assert.equal(aforoEscrito('12a'), null);
    assert.equal(aforoEscrito('-5'), null);
  });
});

describe('los cambios sin guardar', () => {
  it('lo mismo es lo mismo', () => {
    assert.equal(hayCambiosSinGuardar(completo(), completo()), false);
  });

  it('cualquier campo distinto cuenta', () => {
    const campos: Array<Partial<CamposDelBorrador>> = [
      { title: 'Otro' },
      { description: 'x'.repeat(50) },
      { promise: 'Otra' },
      { category: 'cultura' },
      { location: 'Miraflores' },
      { eventType: 'online' },
      { capacity: '30' },
      { dia: '01/01/2027' },
      { hora: '20:30' },
    ];
    for (const cambio of campos) {
      assert.equal(
        hayCambiosSinGuardar(completo(cambio), completo()),
        true,
        JSON.stringify(cambio),
      );
    }
  });

  it('la misma fecha escrita dos veces no es un cambio', () => {
    // Cuando la fecha era un `Date`, comparar las referencias decía que sí y
    // el botón «Guardar» se quedaba encendido para siempre. En texto no puede
    // pasar, y por eso el formulario habla en texto.
    assert.equal(
      hayCambiosSinGuardar(
        completo({ dia: '20/11/2026', hora: '19:00' }),
        completo({ dia: '20/11/2026', hora: '19:00' }),
      ),
      false,
    );
  });
});

describe('las categorías', () => {
  it('son las siete del blueprint', () => {
    assert.deepEqual([...CATEGORIAS], [
      'negocios',
      'cultura',
      'bienestar',
      'gastronomia',
      'conocimiento',
      'comunidad',
      'experiencias',
    ]);
  });

  it('una que no existe no se inventa', () => {
    assert.equal(claveDeCategoria('criptomonedas'), 'categoriaDeEvento.sinDefinir');
    assert.equal(claveDeCategoria(null), 'categoriaDeEvento.sinDefinir');
  });

  it('una de las siete tiene su clave', () => {
    assert.equal(claveDeCategoria('bienestar'), 'categoriaDeEvento.bienestar');
  });
});

describe('la pantalla del borrador', () => {
  const PANTALLA = fuente('screens/EditarEventoScreen.tsx');

  it('no ofrece publicar', () => {
    // Publicar es de la admisión. Un botón aquí prometería un flujo que esta
    // pantalla no tiene.
    assert.ok(!PANTALLA.includes("t('admisionEvento.publicar')"));
    assert.ok(!PANTALLA.includes('publicar()'));
  });

  it('avisa de que enviar no publica ANTES de enviar', () => {
    const cuerpo = PANTALLA.slice(PANTALLA.indexOf('const enviar ='));
    const aviso = cuerpo.indexOf("t('miEvento.enviarCuerpo')");
    const envio = cuerpo.indexOf('enviarARevision');
    assert.ok(aviso !== -1 && aviso < envio);
  });

  it('guarda antes de enviar, y no envía si el guardado falla', () => {
    assert.ok(PANTALLA.includes('if (sinGuardar && !(await guardar())) return;'));
  });

  it('dos toques no mandan dos envíos', () => {
    const cuerpo = PANTALLA.slice(PANTALLA.indexOf('const enviar ='));
    assert.ok(cuerpo.includes('if (!id || ocupadoRef.current) return;'));
  });

  it('la hora se pide, no se inventa', () => {
    assert.ok(PANTALLA.includes('<TimeField'));
    assert.ok(!PANTALLA.includes('19, 0, 0'));
  });

  it('la fecha no se puede tocar en solo lectura', () => {
    // `DateField` no acepta `editable`, así que en un evento que ya no se
    // puede guardar se pintaba igual y el cambio se perdía sin avisar.
    assert.ok(PANTALLA.includes('{editable ? (\n        <>\n          <DateField'));
  });

  it('salir con cambios sin guardar avisa', () => {
    assert.ok(PANTALLA.includes("t('miEvento.salirSinGuardar')"));
  });

  it('el teclado no tapa lo que se escribe', () => {
    // El proyecto tiene UN componente para esto y todas las pantallas con
    // formulario lo usan.
    assert.ok(PANTALLA.includes('<SinTecladoDelante>'));
  });

  it('no hay ningún control que escriba el estado', () => {
    assert.ok(!PANTALLA.includes('workflow_status:'));
    assert.ok(!PANTALLA.includes('selection_status:'));
  });

  it('lo que no se puede editar se pone en solo lectura', () => {
    assert.ok(PANTALLA.includes('editable && !ocupado'));
    assert.ok(PANTALLA.includes("t('miEvento.soloLectura')"));
  });
});

describe('el sello Z, en la ficha pública', () => {
  it('solo se pinta si el servidor lo confirma', () => {
    const ficha = fuente('screens/EventoScreen.tsx');
    assert.ok(ficha.includes('evento.seleccionadoPorZ ?'));
    // Y no se deduce de ninguna otra cosa.
    assert.ok(!ficha.includes("selection_status ==="));
    assert.ok(!ficha.includes("workflow_status ==="));
  });

  it('un servidor que no manda el campo NO tiene sello', () => {
    // `=== true` y no un valor por defecto: `undefined` no puede acabar
    // pintándolo.
    const mapper = fuente('mappers/catalogMapper.ts');
    assert.ok(mapper.includes('seleccionadoPorZ: dto.seleccionado_por_z === true'));
  });
});
