const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

// ─── Rutas del monorepo ───────────────────────────────────────────────────────
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const appRoot = path.resolve(projectRoot, 'app');

// Inyectar para cualquier uso de process.env en código Node (e.g. scripts)
process.env.EXPO_ROUTER_APP_ROOT = appRoot;

const config = getDefaultConfig(projectRoot);

// ─── 1. Watch folders del monorepo ───────────────────────────────────────────
config.watchFolders = [...(config.watchFolders || []), workspaceRoot];

// ─── 2. Resolución de node_modules en monorepo ───────────────────────────────
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// ─── 3. Shim de require.context para TODAS las plataformas ───────────────────
//
// El problema: expo-router/_ctx*.js usa require.context(process.env.EXPO_ROUTER_APP_ROOT, ...)
// Metro necesita que el primer argumento sea un STRING LITERAL estático en tiempo de parseo.
// En un monorepo, la variable llega como undefined a los workers de Babel → crash:
//   "First argument of require.context should be a string"
//
// Solución: interceptar el import 'expo-router/_ctx' y redirigir a un shim local
// que tiene '../app' hardcodeado. Un shim por grupo de plataforma (web / nativo).
//
const ctxWebShim = path.resolve(projectRoot, 'web-shims', '_ctx.web.js');
const ctxNativeShim = path.resolve(projectRoot, 'web-shims', '_ctx.native.js');

// ─── 4. Fix de import.meta para web (zustand devtools) ───────────────────────
//
// Zustand y otros paquetes tienen exports condicionales:
//   "import" → esm/*.mjs   (contiene import.meta.env.MODE → crash en web no-module)
//   "react-native" → *.js  (CJS limpio, sin import.meta)
//
// Cuando Metro sirve en web, resuelve la condición "import" y carga el .mjs,
// lo cual genera "Uncaught SyntaxError: Cannot use 'import.meta' outside a module".
//
// Solución: en resolveRequest, cuando la plataforma es "web" y el módulo pertenece
// a paquetes con este problema, forzar la resolución CJS directamente.
//
const ESM_PACKAGES_TO_CJS = ['zustand'];

const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Shim para expo-router/_ctx (todas las plataformas)
  if (moduleName === 'expo-router/_ctx') {
    const shim = platform === 'web' ? ctxWebShim : ctxNativeShim;
    return { filePath: shim, type: 'sourceFile' };
  }

  // Para web: forzar CJS en paquetes que usan import.meta en su build ESM
  if (platform === 'web') {
    for (const pkg of ESM_PACKAGES_TO_CJS) {
      if (moduleName === pkg || moduleName.startsWith(pkg + '/')) {
        const subpath = moduleName === pkg ? '' : '/' + moduleName.slice(pkg.length + 1);
        const cjsPath = require.resolve(
          path.join(workspaceRoot, 'node_modules', pkg, subpath || 'index.js')
        );
        return { filePath: cjsPath, type: 'sourceFile' };
      }
    }
  }

  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
