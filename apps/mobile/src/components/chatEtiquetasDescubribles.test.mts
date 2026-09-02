import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Las etiquetas de conversación ya existían: lo que faltaba era ENCONTRARLAS.
 *
 * Esta prueba no cubre el CRM —eso lo hace `etiquetasPrivadas.test.mts`— sino
 * lo que hacía que nadie lo usara: una fila con un botón «Crear etiqueta» y
 * nada que dijera qué es eso, a qué se le pone ni quién lo ve.
 *
 * Y fija de paso lo que NO son, porque las dos confusiones cuestan caro:
 *
 *  - NO son menciones `@`. Una mención avisa a alguien; una etiqueta es un
 *    juicio privado que esa persona no ve jamás.
 *  - NO se ponen a un mensaje suelto. Se ponen a la CONVERSACIÓN entera, que es
 *    lo que guarda `conversation_label_assignments` (migración 0045).
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

const CHIPS = fuente('components/ChipsDeEtiquetas.tsx');
const REPOSITORIO = fuente('repositories/EtiquetasRepository.ts');

describe('encontrar las etiquetas', () => {
  it('la fila explica qué son mientras no hay ninguna', () => {
    /*
      Es el único momento en que hace falta: sin etiquetas creadas, la fila es
      un botón suelto sin contexto. Con una ya creada el cartel sobra y sólo
      robaría la altura de la primera conversación, todos los días.
    */
    assert.ok(
      /etiquetas\.length === 0 && alGestionar \? \(/.test(CHIPS),
      'Falta la explicación de la primera vez, o se pinta siempre.',
    );
    assert.ok(
      CHIPS.includes("t('label.explain')"),
      'La fila tiene que decir a la vista que son privadas: quien no lo sabe, ' +
        'o no las usa por no etiquetar a alguien delante de él, o las usa ' +
        'creyendo que se comparten.',
    );
  });

  it('el control de crear y administrar es visible y se explica solo', () => {
    assert.ok(
      /alGestionar \? \(/.test(CHIPS),
      'Se ha perdido el botón que abre el gestor desde la propia fila.',
    );
    assert.ok(
      /accessibilityHint=\{t\('label\.explain'\)\}/.test(CHIPS),
      'Con lector de pantalla el botón era sólo «Etiquetas»: hace falta decir ' +
        'qué son y quién las ve.',
    );
    assert.ok(
      /t\('label\.createShort'\)[\s\S]{0,80}t\('label\.manageShort'\)/.test(CHIPS),
      'El botón tiene que decir «Crear etiqueta» cuando no hay ninguna y ' +
        '«Etiquetas» después: son dos momentos distintos.',
    );
  });

  it('los chips siguen siendo el filtro, y filtra el servidor', () => {
    assert.ok(
      /alSeleccionar\(null\)/.test(CHIPS) && /alSeleccionar\(\s*\n?\s*seleccionada === etiqueta\.id \? null : etiqueta\.id/.test(CHIPS),
      'Se ha perdido «Todos» o el camino corto de vuelta quitando el filtro.',
    );
  });
});

describe('lo que las etiquetas NO son', () => {
  it('no se ha construido un segundo sistema encima del que ya existe', () => {
    // Las siete rutas son las de `messaging/etiquetas.py`. Nada más.
    for (const llamada of ['listar', 'crear', 'renombrar', 'borrar', 'deLaConversacion', 'asignar', 'quitar']) {
      assert.ok(
        REPOSITORIO.includes(`async ${llamada}(`),
        `El repositorio ha perdido \`${llamada}\`.`,
      );
    }
    assert.ok(
      !/messages\/\$\{|\/messages\//.test(REPOSITORIO),
      'Una etiqueta no se le pone a un mensaje suelto: se le pone a la ' +
        'conversación entera.',
    );
  });

  it('no se confunden con menciones', () => {
    for (const texto of [CHIPS, REPOSITORIO]) {
      assert.ok(
        !/menci[óo]n|mention|@\{/.test(texto),
        'El CRM de etiquetas no tiene nada que ver con las menciones `@`: una ' +
          'mención avisa a alguien y una etiqueta es privada.',
      );
    }
  });
});
