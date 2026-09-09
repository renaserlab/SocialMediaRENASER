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
  startsAt: new Date('2026-11-20T19:00:00Z'),
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

  it('sin fecha', () => {
    assert.equal(motivoParaNoEnviar(completo({ startsAt: null })), 'miEvento.faltaFecha');
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
      { startsAt: new Date('2027-01-01T19:00:00Z') },
    ];
    for (const cambio of campos) {
      assert.equal(
        hayCambiosSinGuardar(completo(cambio), completo()),
        true,
        JSON.stringify(cambio),
      );
    }
  });

  it('dos fechas iguales en objetos distintos no son un cambio', () => {
    // Comparar las referencias diría que sí y el botón «Guardar» se quedaría
    // encendido para siempre.
    assert.equal(
      hayCambiosSinGuardar(
        completo({ startsAt: new Date('2026-11-20T19:00:00Z') }),
        completo({ startsAt: new Date('2026-11-20T19:00:00Z') }),
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
