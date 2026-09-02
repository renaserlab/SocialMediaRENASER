import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * RECORTE DE LA FOTO DE PERFIL Y DE LA PORTADA.
 *
 * El informe dice: «los botones superiores para personalización no son
 * fácilmente visibles; no son visibles los iconos del recuadro rojo, y tampoco
 * se puede observar bien el símbolo de cortar».
 *
 * ESA PANTALLA NO ES NUESTRA. La dibuja el sistema operativo: `expo-image-picker`
 * con `allowsEditing: true`. Sus iconos y su tijera no se pueden tematizar
 * desde la aplicacion, asi que lo que se prueba aqui no es que los hayamos
 * arreglado —no se puede— sino que:
 *
 *   1. el diagnostico sigue siendo cierto (el editor sigue siendo el nativo),
 *   2. existe una confirmacion NUESTRA despues, legible sobre cualquier foto,
 *   3. no se ha colado una dependencia nativa nueva para conseguirlo.
 */

const CARPETA = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(CARPETA, '..');
const MOBILE = join(SRC, '..');

function fuente(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. El diagnostico, congelado
// ---------------------------------------------------------------------------

test('el recorte de perfil y portada lo sigue haciendo el editor del sistema', () => {
  const storage = fuente('services/storage.ts');
  /*
    Si algun dia esto deja de ser cierto —porque se pase a `allowsEditing:
    false` o a un recortador propio— hay que revisar el informe: la explicacion
    de por que no se pueden cambiar esos iconos dejaria de valer.
  */
  assert.ok(
    /launchImageLibraryAsync\(\{[\s\S]*?allowsEditing/.test(storage),
    'El selector ya no delega el recorte en el editor nativo: revisa la ' +
      'explicacion de ConfirmarRecorte.',
  );
  assert.ok(
    /allowsEditing = true/.test(storage),
    'El recorte nativo era el comportamiento por defecto de pickImage/takePhoto.',
  );
});

test('la confirmacion no promete haber tematizado los controles del sistema', () => {
  const confirmar = fuente('components/ConfirmarRecorte.tsx');
  assert.ok(
    /NO ES NUESTRA|editor del SISTEMA OPERATIVO/.test(confirmar),
    'ConfirmarRecorte debe dejar dicho que el editor de recorte es del sistema.',
  );
});

// ---------------------------------------------------------------------------
// 2. Las proporciones de cada sitio
// ---------------------------------------------------------------------------

test('el avatar se confirma cuadrado y la portada en 16:9', () => {
  const confirmar = fuente('components/ConfirmarRecorte.tsx');
  assert.ok(
    /avatar: 1,/.test(confirmar),
    'El avatar debe confirmarse en marco cuadrado.',
  );
  assert.ok(
    /portada: 16 \/ 9,/.test(confirmar),
    'La portada debe confirmarse en 16:9; con otro marco se pierden los bordes.',
  );
  assert.ok(
    /aspectRatio: PROPORCION\[forma\]/.test(confirmar),
    'El marco tiene que usar la proporcion de la tabla, no un numero suelto.',
  );
});

test('lo que se ve encuadrado es lo que se vera despues', () => {
  const confirmar = fuente('components/ConfirmarRecorte.tsx');
  /*
    `cover` es el mismo ajuste con el que el perfil pinta el avatar y la
    portada. Con `contain` la confirmacion enseñaria una foto entera que
    despues aparece recortada: seria mentir con la vista previa.
  */
  assert.ok(
    /contentFit="cover"/.test(confirmar),
    'El marco debe encuadrar con cover, igual que el perfil.',
  );
});

// ---------------------------------------------------------------------------
// 3. Se ve sobre cualquier foto, y se puede tocar
// ---------------------------------------------------------------------------

test('las acciones se leen sobre cualquier imagen', () => {
  const confirmar = fuente('components/ConfirmarRecorte.tsx');
  assert.ok(
    confirmar.includes('<ScrimDeMedio'),
    'Los controles van encima de la foto: necesitan la misma capa que el resto ' +
      'del flujo de creacion.',
  );
  assert.ok(
    /borde="arriba"/.test(confirmar),
    'La cabecera es justo la zona que el informe señala como ilegible: tambien ' +
      'necesita su capa.',
  );
});

test('todo lo pulsable tiene rol y etiqueta accesibles', () => {
  const confirmar = fuente('components/ConfirmarRecorte.tsx');
  const pulsables = (confirmar.match(/<Pressable/g) ?? []).length;
  const roles = (confirmar.match(/accessibilityRole="button"/g) ?? []).length;
  const etiquetas = (confirmar.match(/accessibilityLabel=/g) ?? []).length;
  assert.ok(pulsables > 0, 'ConfirmarRecorte no tiene ningun control.');
  assert.equal(
    roles,
    pulsables,
    'Hay Pressables sin accessibilityRole="button" en ConfirmarRecorte.',
  );
  assert.ok(
    etiquetas >= pulsables,
    'Hay controles sin etiqueta accesible en ConfirmarRecorte.',
  );
});

test('se respetan las zonas seguras del aparato', () => {
  const confirmar = fuente('components/ConfirmarRecorte.tsx');
  assert.ok(
    confirmar.includes('useSafeAreaInsets'),
    'Sin zonas seguras, la cabecera queda bajo la muesca y el pie bajo el ' +
      'indicador de inicio.',
  );
  assert.ok(
    /insets\.top/.test(confirmar) && /insets\.bottom/.test(confirmar),
    'Hay que apartar arriba Y abajo.',
  );
});

test('los botones de la confirmacion llegan al minimo tactil', () => {
  const confirmar = fuente('components/ConfirmarRecorte.tsx');
  assert.ok(
    /minHeight: 44/.test(confirmar) && /height: 44/.test(confirmar),
    'Los controles de ConfirmarRecorte bajaron de 44 px.',
  );
});

// ---------------------------------------------------------------------------
// 4. Sin dependencias nativas nuevas
// ---------------------------------------------------------------------------

const PESADAS = [
  'expo-image-manipulator',
  'react-native-image-crop-picker',
  'expo-image-editor',
  '@react-native-community/image-editor',
  'ffmpeg-kit-react-native',
];

test('la confirmacion no arrastra una libreria de recorte', () => {
  const confirmar = fuente('components/ConfirmarRecorte.tsx');
  for (const paquete of PESADAS) {
    /*
      Se busca el IMPORT, no el nombre: el componente explica en un comentario
      por que NO usa `expo-image-manipulator`, y esa explicacion tiene que poder
      seguir escrita.
    */
    assert.ok(
      !new RegExp(`(from|require\\()\\s*['"]${paquete}`).test(confirmar),
      `ConfirmarRecorte importa ${paquete}: eso es una compilacion nativa nueva ` +
        'y rompe Expo Go. La confirmacion solo encuadra, no recorta pixeles.',
    );
  }
});

test('el proyecto sigue sin dependencias nativas de imagen', () => {
  const paquete = JSON.parse(readFileSync(join(MOBILE, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const dependencias = Object.keys(paquete.dependencies ?? {});
  const coladas = PESADAS.filter((p) => dependencias.includes(p));
  assert.deepEqual(
    coladas,
    [],
    'Se ha añadido una dependencia nativa de imagen sin decidirlo: ' +
      `${coladas.join(', ')}.`,
  );
});
