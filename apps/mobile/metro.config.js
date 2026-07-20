const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const fs = require('fs');

// ─── Rutas del monorepo con capitalización real (Windows fix) ────────────────
const currentDir = fs.realpathSync(__dirname);
const workspaceRoot = fs.realpathSync(path.resolve(currentDir, '../..'));
const appRoot = fs.realpathSync(path.resolve(currentDir, 'app'));

// Establecemos el projectRoot al subproyecto local de la app
const projectRoot = currentDir;

// Inyectar para que expo-router encuentre el directorio app correcto de mobile
process.env.EXPO_ROUTER_APP_ROOT = appRoot;

const config = getDefaultConfig(projectRoot);

// ─── 1. Watch folders del monorepo con rutas reales (extendiendo los defaults)
config.watchFolders = [
  ...(config.watchFolders || []),
  projectRoot,
  workspaceRoot,
];

// ─── 2. Resolución de node_modules en monorepo ───────────────────────────────
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// ─── 3. Shim de require.context para TODAS las plataformas ───────────────────
const ctxWebShim = path.resolve(projectRoot, 'web-shims', '_ctx.web.js');
const ctxNativeShim = path.resolve(projectRoot, 'web-shims', '_ctx.native.js');

// ─── 4. Aliases y Deduplicación de React / React Native / React DOM ───────────
//
// Para evitar múltiples copias de React (Invalid hook call), forzamos a Metro
// a resolver los imports de raíz del módulo a la carpeta local de apps/mobile/node_modules/.
// Al usar extraNodeModules, Metro maneja la resolución nativa de los puntos de
// entrada (index.js, package.json) de forma limpia y robusta.
//
const forcedModules = {
  'react': path.resolve(projectRoot, 'node_modules/react'),
  'react-dom': path.resolve(projectRoot, 'node_modules/react-dom'),
  'react-native': path.resolve(projectRoot, 'node_modules/react-native'),
  'react-native-web': path.resolve(projectRoot, 'node_modules/react-native-web'),
};

config.resolver.extraNodeModules = forcedModules;

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
