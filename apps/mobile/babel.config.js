const path = require('path');

// Ruta absoluta del directorio app/ — debe coincidir con metro.config.js
const appRoot = path.resolve(__dirname, 'app');

// Inyectar la variable ANTES de que babel-preset-expo la lea
process.env.EXPO_ROUTER_APP_ROOT = appRoot;

module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [],
  };
};
