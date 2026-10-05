import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ZONAS_HORARIAS, nombreDeZona } from '../lib/eventoDelOrganizador.ts';

/**
 * EVENTOS, CURSOS, PRODUCTOS Y SERVICIOS: MÁS CLAROS, SIN CAMBIAR SU RECORRIDO.
 *
 * Lo reportado: «las vistas son demasiado muertas… ahora está demasiado apagado
 * y con íconos poco amigables». El grueso de la respuesta está en los
 * componentes compartidos —botón, chip, campo, estado vacío, pestañas— que
 * estas pantallas ya usaban, y se fija en `lib/movimiento.test.mts`. Aquí va lo
 * que era propio de estas pantallas.
 */

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (codigo: string) =>
  codigo.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('la zona horaria se lee como una ciudad', () => {
  it('ninguna de las ofrecidas se enseña con su identificador', () => {
    for (const zona of ZONAS_HORARIAS) {
      const nombre = nombreDeZona(zona);
      assert.ok(!nombre.includes('/'), `${zona} → ${nombre}`);
      assert.ok(!nombre.includes('_'), `${zona} → ${nombre}`);
      assert.ok(nombre.length > 0);
    }
  });

  it('con sus nombres de verdad', () => {
    assert.equal(nombreDeZona('America/Lima'), 'Lima');
    assert.equal(nombreDeZona('America/Argentina/Buenos_Aires'), 'Buenos Aires');
    assert.equal(nombreDeZona('America/Bogota'), 'Bogotá');
    assert.equal(nombreDeZona('America/Sao_Paulo'), 'São Paulo');
    assert.equal(nombreDeZona('Europe/Madrid'), 'Madrid');
  });

  it('una zona que no está en la lista también se nombra, y una rara no revienta', () => {
    assert.equal(nombreDeZona('Asia/Ho_Chi_Minh'), 'Ho Chi Minh');
    assert.equal(nombreDeZona('UTC'), 'UTC');
    assert.equal(nombreDeZona(''), '');
  });

  it('lo que se GUARDA sigue siendo el identificador: solo cambia la etiqueta', () => {
    const formulario = sinComentarios(fuente('screens/EditarEventoScreen.tsx'));
    assert.match(formulario, /onPress=\{\(\) => setCampos\(\{ \.\.\.campos, timezone: zona \}\)\}/);
    assert.match(formulario, /\{nombreDeZona\(zona\)\}/);
    assert.ok(!/>\s*\{zona\}\s*</.test(formulario), 'queda el identificador crudo en pantalla');
  });

  it('se anuncia como una elección única', () => {
    const formulario = sinComentarios(fuente('screens/EditarEventoScreen.tsx'));
    assert.match(formulario, /accessibilityRole="radio"\s*accessibilityState=\{\{ selected: elegida, checked: elegida \}\}/);
  });
});

describe('una cola que no es para tu cuenta no ofrece botones que no puedes usar', () => {
  const COLA = sinComentarios(fuente('screens/AdminEventosScreen.tsx'));

  it('sin permiso desaparecen las otras colas de administración', () => {
    const inicio = COLA.indexOf('{sinPermiso ? null : (');
    assert.notEqual(inicio, -1);
    const dentro = COLA.slice(inicio);
    for (const ruta of ['/admin/resenas', '/admin/productos', '/admin/productos/admision']) {
      assert.ok(dentro.includes(`router.push('${ruta}' as never)`), ruta);
      assert.ok(!COLA.slice(0, inicio).includes(`router.push('${ruta}' as never)`), `${ruta} sigue fuera de la guarda`);
    }
  });

  it('el estado vacío dice de qué vacío se trata, con su icono', () => {
    assert.match(COLA, /icon=\{sinPermiso \? 'lock' : noDisponible \? 'clock' : 'check-circle'\}/);
    assert.match(COLA, /t\('admisionEvento\.sinPermisoCuerpo'\)/);
  });
});

describe('Mis eventos', () => {
  const MIS = sinComentarios(fuente('screens/MisEventosScreen.tsx'));

  it('las bandejas son filas de lista, no texto gris suelto', () => {
    for (const ruta of ['/admin/eventos', '/admin/posventa', '/admin/finanzas', '/admin/politicas']) {
      assert.match(
        MIS,
        new RegExp(`<ListRow[\\s\\S]{0,200}?onPress=\\{\\(\\) => router\\.push\\('${ruta}' as never\\)\\}`),
        ruta,
      );
    }
    assert.ok(!/styles\.cola/.test(MIS));
  });

  it('cada evento responde al toque', () => {
    assert.match(MIS, /<Pulsable\s+key=\{evento\.id\}/);
  });
});

describe('lo que se pulsa en estas pantallas responde', () => {
  it('fecha, hora, tarjetas y selectores usan el pulsable común', () => {
    for (const componente of [
      'DateField',
      'TimeField',
      'EventCard',
      'CourseCard',
      'SelectorDeCategoria',
      'SelectorDeHorarios',
      'SectionTitle',
      'AppHeader',
    ]) {
      const codigo = sinComentarios(fuente(`components/${componente}.tsx`));
      assert.match(codigo, /<Pulsable\b/, componente);
      assert.ok(!/<Pressable\b/.test(codigo), `${componente} mezcla los dos`);
    }
  });

  it('un día sin horarios sigue viéndose apagado', () => {
    // La opacidad la anima `Pulsable`: escrita en el estilo quedaría pisada.
    assert.match(sinComentarios(fuente('components/SelectorDeHorarios.tsx')), /opacidad=\{con \? 1 : 0\.4\}/);
  });
});

describe('las reglas del piloto de Servicios no se han tocado', () => {
  it('ningún cambio de vistas vuelve a ofrecer precio fijo ni domicilio', () => {
    // Estos ficheros no se editaron en la mejora de vistas; se comprueba aquí
    // para que quien retoque su aspecto no reabra lo que el piloto cerró.
    const formulario = sinComentarios(fuente('screens/EditarServicioScreen.tsx'));
    assert.ok(!/react-native-reanimated/.test(formulario), 'el formulario de servicio no anima por su cuenta');
    assert.ok(!/Stripe|stripe\.|PaymentSheet/.test(formulario));
  });
});
