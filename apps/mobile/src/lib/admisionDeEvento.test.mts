/**
 * Las reglas de admisión, ejecutadas.
 *
 * La que más importa es la de la falla crítica: con un `if total >= 85` delante,
 * un evento sin plan de emergencias y con 98 puntos entra igual. Aquí se
 * comprueba que no entra, y en el servidor lo comprueban otra vez
 * `test_admision_de_eventos.py` y un CHECK de la 0060.
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
  CRITERIOS,
  ORDEN_DE_CRITERIOS,
  TOTAL_POSIBLE,
  UMBRAL_APROBACION,
  UMBRAL_CONDICIONAL,
  claveDelEstado,
  daSelloZ,
  decisionPosible,
  dentroDelTope,
  motivoParaNoDecidir,
  motivoParaNoEvaluar,
  puntajesVacios,
  total,
  type Criterio,
  type Puntajes,
} from './admisionDeEvento.ts';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const con = (valores: Partial<Puntajes>): Puntajes => ({
  ...puntajesVacios(),
  ...valores,
});

/** Un puntaje que suma exactamente `objetivo`, repartido por los ocho topes. */
function reparte(objetivo: number): Puntajes {
  const puntajes = puntajesVacios();
  let queda = objetivo;
  for (const criterio of ORDEN_DE_CRITERIOS) {
    const cabe = Math.min(CRITERIOS[criterio], queda);
    puntajes[criterio] = cabe;
    queda -= cabe;
  }
  assert.equal(queda, 0, `no se pueden repartir ${objetivo} puntos`);
  return puntajes;
}

describe('los ocho criterios del blueprint', () => {
  it('suman exactamente 100', () => {
    assert.equal(
      ORDEN_DE_CRITERIOS.reduce((s, c) => s + CRITERIOS[c], 0),
      TOTAL_POSIBLE,
    );
  });

  it('con los pesos que dice el blueprint', () => {
    assert.deepEqual(CRITERIOS, {
      propuesta: 20,
      trayectoria: 15,
      programa: 15,
      recinto: 15,
      seguridad: 15,
      precio: 10,
      accesibilidad: 5,
      afinidad: 5,
    });
  });

  it('el total es la suma, no una media', () => {
    assert.equal(total(reparte(90)), 90);
    assert.equal(total(puntajesVacios()), 0);
  });
});

describe('el tope de cada criterio', () => {
  it('no se pasa por arriba', () => {
    assert.equal(dentroDelTope('propuesta', 25), 20);
    assert.equal(dentroDelTope('afinidad', 9), 5);
  });

  it('ni por abajo', () => {
    assert.equal(dentroDelTope('propuesta', -3), 0);
  });

  it('un valor que no es un número se trata como cero', () => {
    assert.equal(dentroDelTope('recinto', Number.NaN), 0);
  });
});

describe('hasta dónde llega un puntaje', () => {
  it('85 o más, aprobar', () => {
    assert.equal(decisionPosible(reparte(85), false), 'approved');
    assert.equal(decisionPosible(reparte(100), false), 'approved');
  });

  it('de 80 a 84, solo condicional', () => {
    assert.equal(decisionPosible(reparte(80), false), 'conditional');
    assert.equal(decisionPosible(reparte(84), false), 'conditional');
  });

  it('por debajo de 80, no alcanza', () => {
    assert.equal(decisionPosible(reparte(79), false), 'rejected');
    assert.equal(decisionPosible(puntajesVacios(), false), 'rejected');
  });

  it('UNA FALLA CRÍTICA MANDA SOBRE EL PUNTAJE', () => {
    // 100 sobre 100 y sin plan de emergencias sigue siendo no. Es la regla
    // que un `if total >= 85` puesto delante se lleva por delante.
    assert.equal(decisionPosible(reparte(100), true), 'rejected');
    assert.equal(decisionPosible(reparte(85), true), 'rejected');
  });

  it('los umbrales son los del blueprint', () => {
    assert.equal(UMBRAL_APROBACION, 85);
    assert.equal(UMBRAL_CONDICIONAL, 80);
  });
});

describe('el sello Z', () => {
  it('solo con una aprobación', () => {
    assert.equal(daSelloZ('approved'), true);
  });

  it('un condicional NO lo lleva', () => {
    // Todavía tiene un pendiente por subsanar; el sello dice «aprobado», no
    // «casi aprobado».
    assert.equal(daSelloZ('conditional'), false);
  });

  it('ni un rechazo ni una petición de correcciones', () => {
    assert.equal(daSelloZ('rejected'), false);
    assert.equal(daSelloZ('changes_requested'), false);
  });
});

describe('cuándo NO se puede guardar la evaluación', () => {
  it('sin evidencia', () => {
    assert.equal(motivoParaNoEvaluar('   ', false, ''), 'admisionEvento.faltaEvidencia');
  });

  it('con falla crítica y sin decir cuál', () => {
    assert.equal(
      motivoParaNoEvaluar('Todo revisado', true, '  '),
      'admisionEvento.faltaMotivoDeLaFalla',
    );
  });

  it('con evidencia, se puede', () => {
    assert.equal(motivoParaNoEvaluar('Recinto confirmado', false, ''), null);
  });
});

describe('cuándo NO se puede decidir', () => {
  const bueno = reparte(90);

  it('sin motivo, ninguna decisión', () => {
    for (const decision of ['approved', 'conditional', 'rejected'] as const) {
      assert.equal(
        motivoParaNoDecidir(decision, true, bueno, false, '   '),
        'admisionEvento.faltaMotivo',
        decision,
      );
    }
  });

  it('aprobar sin evaluar, no', () => {
    assert.equal(
      motivoParaNoDecidir('approved', false, null, false, 'Me gusta'),
      'admisionEvento.sinEvaluar',
    );
  });

  it('aprobar con falla crítica, no', () => {
    assert.equal(
      motivoParaNoDecidir('approved', true, bueno, true, 'Es buenísimo'),
      'admisionEvento.hayFallaCritica',
    );
  });

  it('aprobar por debajo de 85, no', () => {
    assert.equal(
      motivoParaNoDecidir('approved', true, reparte(84), false, 'Aun así'),
      'admisionEvento.noLlegaAAprobado',
    );
  });

  it('condicional fuera de 80–84, no', () => {
    assert.equal(
      motivoParaNoDecidir('conditional', true, reparte(90), false, 'Por si acaso'),
      'admisionEvento.fueraDeCondicional',
    );
    assert.equal(
      motivoParaNoDecidir('conditional', true, reparte(79), false, 'Por si acaso'),
      'admisionEvento.fueraDeCondicional',
    );
  });

  it('rechazar NO depende del puntaje', () => {
    // Se puede rechazar un evento de 92: la decisión es de quien administra.
    assert.equal(
      motivoParaNoDecidir('rejected', true, reparte(92), false, 'No encaja'),
      null,
    );
    // Y también sin haberlo evaluado.
    assert.equal(
      motivoParaNoDecidir('rejected', false, null, false, 'No encaja'),
      null,
    );
  });

  it('con 85 y sin falla, aprobar se puede', () => {
    assert.equal(
      motivoParaNoDecidir('approved', true, reparte(85), false, 'Cumple'),
      null,
    );
  });
});

describe('la clave del estado', () => {
  it('los doce del contrato', () => {
    for (const estado of [
      'DRAFT',
      'SUBMITTED',
      'CONDITIONAL',
      'APPROVED',
      'PUBLISHED',
      'SOLD_OUT',
      'SUSPENDED',
      'CANCELLED',
      'IN_PROGRESS',
      'COMPLETED_PENDING',
      'MODIFIED',
      'SETTLED',
    ]) {
      assert.equal(claveDelEstado(estado), `estadoDeEvento.${estado}`);
    }
  });

  it('uno que no existe no se inventa', () => {
    assert.equal(claveDelEstado('CASI_PUBLICADO'), 'estadoDeEvento.desconocido');
  });
});

describe('la pantalla de revisión', () => {
  const PANTALLA = fuente('screens/RevisarEventoScreen.tsx');

  it('no escribe el estado a mano en ningún sitio', () => {
    // El ciclo se mueve con acciones con nombre. Un control que escriba
    // `workflow_status` es la puerta que la máquina de estados cierra.
    assert.ok(!PANTALLA.includes('workflow_status:'));
    assert.ok(!PANTALLA.includes('selection_status:'));
  });

  it('publicar solo aparece con el evento aprobado', () => {
    assert.ok(PANTALLA.includes("expediente.workflow_status === 'APPROVED'"));
  });

  it('y no se ofrece con requisitos pendientes', () => {
    assert.ok(PANTALLA.includes('bloqueos.length > 0'));
  });

  it('dos toques no mandan dos decisiones', () => {
    const cuerpo = PANTALLA.slice(PANTALLA.indexOf('const conCerrojo ='));
    const cerrojo = cuerpo.indexOf('ocupadoRef.current = true');
    assert.ok(cerrojo !== -1 && cerrojo < cuerpo.indexOf('await accion()'));
  });

  it('la decisión se confirma antes de tomarse', () => {
    assert.ok(PANTALLA.includes('await confirm({'));
    assert.ok(PANTALLA.includes("destructive: decision === 'rejected'"));
  });
});

describe('la consola del organizador NO ve la deliberación', () => {
  it('su repositorio no declara ningún puntaje', () => {
    // La separación es estructural, como la del editor de evaluaciones: los
    // ocho criterios no caben en el tipo que ve quien organiza.
    const organizador = fuente('repositories/EventOrganizerRepository.ts');
    for (const criterio of ORDEN_DE_CRITERIOS) {
      assert.ok(!organizador.includes(criterio), criterio);
    }
    assert.ok(!organizador.includes('evidencia'));
    assert.ok(!organizador.includes('falla_critica'));
  });

  it('y el de admisión sí, que es donde viven', () => {
    const admision = fuente('repositories/EventAdmissionRepository.ts');
    for (const criterio of ORDEN_DE_CRITERIOS) {
      assert.ok(admision.includes(criterio), criterio);
    }
  });

  it('«Mis eventos» no importa el repositorio de admisión para leer puntajes', () => {
    const pantalla = fuente('screens/MisEventosScreen.tsx');
    assert.ok(!pantalla.includes('EventAdmissionRepository'));
  });
});

describe('los tres idiomas dicen todo lo que la admisión pregunta', () => {
  it('ninguna clave usada aquí falta en es, en o pt', () => {
    const usadas = [
      ...new Set(
        [
          fuente('screens/RevisarEventoScreen.tsx'),
          fuente('screens/AdminEventosScreen.tsx'),
          fuente('screens/MisEventosScreen.tsx'),
          fuente('screens/EditarEventoScreen.tsx'),
          fuente('lib/admisionDeEvento.ts'),
          fuente('lib/eventoDelOrganizador.ts'),
        ]
          .join('\n')
          .match(
            new RegExp(
              "'(admisionEvento\\.[a-zA-Z._]+|misEventos\\.[a-zA-Z.]+|miEvento\\.[a-zA-Z.]+)'",
              'g',
            ),
          ) ?? [],
      ),
    ].map((m) => m.slice(1, -1));

    assert.ok(usadas.length > 30, `se encontraron ${usadas.length} claves`);
    for (const [nombre, diccionario] of [
      ['es', es],
      ['en', en],
      ['pt', pt],
    ] as Array<[string, Record<string, string>]>) {
      for (const clave of usadas) {
        assert.ok((diccionario[clave] ?? '').trim() !== '', `falta ${clave} en ${nombre}`);
      }
    }
  });

  it('y las claves construidas al vuelo también', () => {
    const construidas = [
      ...ORDEN_DE_CRITERIOS.map((c: Criterio) => `admisionEvento.criterio.${c}`),
      ...['approved', 'conditional', 'rejected'].map((d) => `admisionEvento.posible.${d}`),
      ...['approved', 'conditional', 'rejected', 'changes_requested'].map(
        (d) => `admisionEvento.decision.${d}`,
      ),
      ...['approved', 'conditional', 'rejected', 'publish'].map(
        (d) => `admisionEvento.confirmar.${d}`,
      ),
    ];
    for (const [nombre, diccionario] of [
      ['es', es],
      ['en', en],
      ['pt', pt],
    ] as Array<[string, Record<string, string>]>) {
      for (const clave of construidas) {
        assert.ok((diccionario[clave] ?? '').trim() !== '', `falta ${clave} en ${nombre}`);
      }
    }
  });
});

describe('nada de esto inventa un dato', () => {
  it('un puntaje vacío es cero, no una media', () => {
    const vacio = puntajesVacios();
    assert.deepEqual(
      ORDEN_DE_CRITERIOS.map((c) => vacio[c]),
      ORDEN_DE_CRITERIOS.map(() => 0),
    );
  });

  it('con un solo criterio puntuado, el total es ese', () => {
    assert.equal(total(con({ propuesta: 7 })), 7);
  });
});
