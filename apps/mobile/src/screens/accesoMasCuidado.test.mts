import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AMPLITUD_DE_SACUDIDA, DURACION } from '../lib/movimiento.ts';

/**
 * ENTRAR Y CREAR LA CUENTA SON LAS PRIMERAS PANTALLAS QUE VE TODO EL MUNDO.
 *
 * Lo reportado: «se ven demasiado básicas». Y en el navegador, además, rotas:
 * dos marcos uno dentro del otro al enfocar un campo, y un bloque celeste del
 * autorrelleno en mitad del tema negro.
 *
 * Aquí se fija lo que se rehízo sin poder montar los componentes: se lee el
 * código, como en el resto de las baterías de pantallas.
 */

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const sinComentarios = (codigo: string) =>
  codigo.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CAMPO = sinComentarios(fuente('components/Input.tsx'));
const CONTRASENA = sinComentarios(fuente('components/CampoDeContrasena.tsx'));
const CABECERA = sinComentarios(fuente('components/CabeceraDeAcceso.tsx'));
const ACCESO = sinComentarios(fuente('screens/LoginScreen.tsx'));
const ALTA = sinComentarios(fuente('screens/RegisterScreen.tsx'));

describe('el campo', () => {
  it('lleva el icono y el accesorio DENTRO de la caja', () => {
    assert.match(CAMPO, /icono\?: keyof typeof Feather\.glyphMap;/);
    assert.match(CAMPO, /accesorio\?: React\.ReactNode;/);
    // En fila, y el campo cede sitio: nada queda colocado a mano encima.
    const caja = CAMPO.slice(CAMPO.indexOf('inputWrapper: {'), CAMPO.indexOf('pastilla: {'));
    assert.match(caja, /flexDirection: 'row'/);
    assert.match(CAMPO, /\{icono \? <Feather name=\{icono\}/);
    assert.match(CAMPO, /\{accesorio\}\s*<\/Animated\.View>/);
    assert.match(CAMPO, /flex: 1,\s*minWidth: 0,/);
  });

  it('lo escrito sale con la letra de la aplicación', () => {
    const letra = CAMPO.slice(CAMPO.indexOf('  input: {'), CAMPO.indexOf('inputDestacado: {'));
    assert.match(letra, /\.\.\.getTextStyle\('400'\),/);
  });

  it('en web no pinta dos marcos al enfocarse', () => {
    // El ESTILO a `none`, no el grosor a cero: el anillo del navegador es
    // `outline: auto` y con `auto` el grosor se ignora. Se comprobó en el
    // navegador: con `outlineWidth: 0` el anillo seguía saliendo.
    assert.match(CAMPO, /Platform\.OS === 'web' \? \(\{ outlineStyle: 'none' \}/);
    assert.match(CAMPO, /SIN_ANILLO_DEL_NAVEGADOR,\s*\{ color: colors\.text \},/);
    assert.ok(!/outlineWidth/.test(CAMPO));
    // El foco lo sigue diciendo la caja.
    assert.match(CAMPO, /borderColor: error \? colors\.danger : focused \? colors\.primary : colors\.border/);
  });

  it('el autorrelleno del navegador no rompe el tema, y solo se toca en web', () => {
    assert.match(CAMPO, /Platform\.OS === 'web' && typeof document !== 'undefined'/);
    assert.match(CAMPO, /:-webkit-autofill/);
    assert.match(CAMPO, /transition: background-color 100000s/);
    // La letra sale de la paleta, por tema: ni un color escrito a mano.
    assert.match(CAMPO, /palette\(modo\)\.text/);
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(CAMPO), 'hay un color escrito a mano en el campo');
    assert.match(CAMPO, /Platform\.OS === 'web' \? \{ dataSet: \{ campo: modo \} \} : \{\}/);
  });

  it('se sacude solo cuando el error APARECE, y nunca con «reducir movimiento»', () => {
    assert.match(CAMPO, /const habiaError = useRef\(Boolean\(error\)\);/, 'montado con error no se mueve');
    assert.match(CAMPO, /if \(hay && !habiaError\.current && !reducir\)/);
    assert.match(CAMPO, /useReducedMotion\(\)/);
    // Solo se traslada: no obliga a recolocar nada.
    assert.match(CAMPO, /transform: \[\{ translateX: desplazamiento\.value \}\]/);
  });

  it('la sacudida es corta y pequeña', () => {
    assert.ok(AMPLITUD_DE_SACUDIDA > 0 && AMPLITUD_DE_SACUDIDA <= 8, 'es un «no», no un susto');
    assert.ok(DURACION.normal <= 260, 'cabe en una transición normal');
  });

  it('las cajas de siempre no cambian de aspecto', () => {
    assert.match(CAMPO, /forma = 'caja',/);
    assert.match(CAMPO, /backgroundColor: forma === 'caja' \? colors\.background : colors\.surfaceAlt/);
    assert.match(CAMPO, /minHeight: 48,\s*borderRadius: radius\.sm,/);
  });
});

describe('la contraseña', () => {
  it('trae su ojo como accesorio, sin posiciones a mano', () => {
    assert.match(CONTRASENA, /secureTextEntry=\{oculta\}/);
    assert.match(CONTRASENA, /accesorio=\{\s*<Pulsable/);
    assert.ok(!/position: 'absolute'/.test(CONTRASENA));
    assert.ok(!/position: 'absolute'|eyeButton/.test(ACCESO + ALTA), 'queda un ojo colocado encima del campo');
  });

  it('el ojo dice lo que hará y se puede pulsar con el dedo', () => {
    assert.match(CONTRASENA, /accessibilityLabel=\{oculta \? t\('auth\.showPassword'\) : t\('auth\.hidePassword'\)\}/);
    assert.match(CONTRASENA, /accessibilityRole="button"/);
    assert.match(CONTRASENA, /width: 40,\s*height: 40,/);
    assert.match(CONTRASENA, /hitSlop=\{6\}/);
  });

  it('quien la usa no puede dejarla a la vista por descuido', () => {
    // `secureTextEntry` va DESPUÉS de las propiedades recibidas.
    assert.ok(CONTRASENA.indexOf('{...props}') < CONTRASENA.indexOf('secureTextEntry={oculta}'));
    assert.match(CONTRASENA, /Omit<React\.ComponentProps<typeof Input>, 'secureTextEntry' \| 'accesorio'>/);
  });
});

describe('la cabecera', () => {
  it('la marca llega UNA vez y no se queda animada', () => {
    assert.match(CABECERA, /withSpring\(1, MUELLE_DE_PANEL\)/);
    assert.ok(!/withRepeat/.test(CABECERA), 'nada de animaciones permanentes');
    assert.match(CABECERA, /\}, \[\]\);/, 'solo al montar');
  });

  it('con «reducir movimiento» está en su sitio y sin onda', () => {
    assert.match(CABECERA, /const llegada = useSharedValue\(reducir \? 1 : 0\);/);
    assert.match(CABECERA, /const onda = useSharedValue\(reducir \? 1 : 0\);/);
    assert.match(CABECERA, /if \(reducir\) return;/);
    // Con la onda en 1 su opacidad es 0.
    assert.match(CABECERA, /opacity: \(1 - onda\.value\) \* 0\.5/);
  });

  it('el título es un encabezado y la onda no estorba al toque', () => {
    assert.match(CABECERA, /accessibilityRole="header"/);
    assert.match(CABECERA, /pointerEvents="none"/);
  });
});

describe('las dos pantallas', () => {
  for (const [nombre, codigo] of [['acceso', ACCESO], ['alta', ALTA]] as const) {
    it(`${nombre}: marca, campos destacados y entrada en cascada`, () => {
      assert.match(codigo, /<CabeceraDeAcceso/);
      assert.match(codigo, /<CampoDeContrasena\s+forma="destacada"/);
      assert.match(codigo, /<Input\s+forma="destacada"\s+icono="/);
      assert.match(codigo, /<Aparecer retraso=\{retrasoEnCascada\(\d, PASO\)\}/);
    });

    it(`${nombre}: el teclado recorre los campos y el último envía`, () => {
      assert.match(codigo, /onSubmitEditing=\{\(\) => campoDeContrasena\.current\?\.focus\(\)\}/);
      assert.match(codigo, /returnKeyType="go"\s+onSubmitEditing=\{\(\) => void submit\(\)\}/);
    });

    it(`${nombre}: el gestor de contraseñas sabe qué campo es cada uno`, () => {
      assert.match(codigo, /autoComplete="email"\s+textContentType="emailAddress"/);
      assert.match(codigo, /autoComplete="(current|new)-password"/);
    });

    it(`${nombre}: la otra puerta es un botón, no media frase en negrita`, () => {
      assert.match(codigo, /<Button\s+label=\{t\('auth\.(signUp|signIn)'\)\}\s+variant="secondary"/);
      assert.ok(!/fontWeight: '900'/.test(codigo));
    });

    it(`${nombre}: sigue apartando el teclado, una sola vez`, () => {
      assert.match(codigo, /<SinTecladoDelante>/);
      assert.ok(!/<AppScreen teclado\b/.test(codigo));
    });

    it(`${nombre}: no se estira de lado a lado en una ventana ancha`, () => {
      assert.match(codigo, /maxWidth: 440, alignSelf: 'center'/);
    });

    it(`${nombre}: el acceso con Google sigue OCULTO`, () => {
      // Lo protege la App Store (directrices 2.1 y 4.8): se enciende con las
      // credenciales y junto a Apple, nunca por un cambio de aspecto.
      assert.ok(!/continueWithGoogle\(\)\}/.test(codigo), 'el botón de Google ha vuelto a pintarse');
      assert.ok(!/icon="chrome"/.test(codigo));
    });

    it(`${nombre}: no cambia lo que se valida ni a dónde se va`, () => {
      assert.match(codigo, /if \(!email\.includes\('@'\)\)/);
      assert.match(codigo, /router\.replace\(\(await rutaTrasAutenticar\(\)\) as never\)/);
    });
  }

  it('acceso: «¿Olvidaste tu contraseña?» va junto al campo y es un enlace', () => {
    const olvido = ACCESO.indexOf("router.push('/forgot-password' as never)");
    assert.ok(ACCESO.indexOf('<CampoDeContrasena') < olvido && olvido < ACCESO.indexOf('icon="log-in"'));
    assert.match(ACCESO, /accessibilityRole="link"\s+accessibilityLabel=\{t\('auth\.forgot'\)\}/);
  });

  it('alta: el requisito de la contraseña se ve cumplirse, sin depender del color', () => {
    assert.match(ALTA, /const MINIMO_DE_CONTRASENA = 6;/);
    assert.match(ALTA, /const contrasenaSuficiente = password\.length >= MINIMO_DE_CONTRASENA;/);
    // La misma cifra que rechaza el envío: la pista no puede prometer otra cosa.
    assert.match(ALTA, /if \(password\.length < MINIMO_DE_CONTRASENA\)/);
    assert.match(ALTA, /name=\{contrasenaSuficiente \? 'check-circle' : 'circle'\}/);
    assert.match(ALTA, /\{errors\.password \? null : \(/, 'con el error puesto, la pista se calla');
  });

  it('alta: los Términos y la Privacidad se pueden leer desde ahí', () => {
    assert.match(ALTA, /onPress=\{\(\) => router\.push\('\/terms' as never\)\}/);
    assert.match(ALTA, /onPress=\{\(\) => router\.push\('\/privacy' as never\)\}/);
    assert.equal(ALTA.match(/accessibilityRole="link"/g)?.length, 2);
    assert.match(ALTA, /enlace: \{ textDecorationLine: 'underline' \}/);
    // Se abren ENCIMA (push): al volver, el formulario sigue como estaba.
    assert.ok(!/router\.replace\('\/(terms|privacy)'/.test(ALTA));
  });

  it('recuperar y fijar la contraseña usan la misma caja', () => {
    assert.match(sinComentarios(fuente('screens/ForgotPasswordScreen.tsx')), /forma="destacada"\s+icono="mail"/);
    const nueva = sinComentarios(fuente('screens/ResetPasswordScreen.tsx'));
    assert.equal(nueva.match(/<CampoDeContrasena\s+forma="destacada"/g)?.length, 2);
  });
});

describe('las palabras', () => {
  const NUEVAS = [
    'auth.signInHello',
    'auth.signInSubtitle',
    'auth.signUpSubtitle',
    'auth.passwordCreate',
    'auth.legalBefore',
    'auth.legalTerms',
    'auth.legalAnd',
    'auth.legalPrivacy',
  ];

  it('están en los tres idiomas', () => {
    for (const idioma of ['es', 'en', 'pt']) {
      const diccionario = fuente(`i18n/${idioma}.ts`);
      for (const clave of NUEVAS) {
        assert.ok(diccionario.includes(`'${clave}':`), `falta ${clave} en ${idioma}.ts`);
      }
    }
  });

  it('las dos que ya no pide nadie se han retirado de los tres', () => {
    for (const idioma of ['es', 'en', 'pt']) {
      const diccionario = fuente(`i18n/${idioma}.ts`);
      assert.ok(!diccionario.includes("'auth.signInTitle':"));
      assert.ok(!diccionario.includes("'auth.legal':"));
    }
  });
});
