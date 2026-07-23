/**
 * Direcciones de las páginas legales publicadas.
 *
 * Google Play exige una política de privacidad accesible desde la ficha, y es
 * buena práctica ofrecerla también dentro de la aplicación. Los documentos ya
 * están redactados en la carpeta `legal/` del repositorio; lo único que falta
 * es el dominio donde se alojen.
 *
 * Mientras estas constantes estén vacías, Ajustes NO muestra los enlaces: es
 * preferible no ofrecerlos a mandar a alguien a una página que no existe.
 * En cuanto se rellenen, aparecen solos.
 *
 * Al completarlas, usar la URL final y pública, por ejemplo:
 *   export const PRIVACY_URL = 'https://renaser.com/legal/privacidad.html';
 */

/** Política de Privacidad. La misma URL que se declara en Play Console. */
export const PRIVACY_URL = '';

/** Condiciones de Uso. */
export const TERMS_URL = '';

/**
 * Página de eliminación de cuenta. Play la pide accesible sin instalar la app,
 * y va declarada en Seguridad de los datos → Eliminación de cuenta.
 */
export const DELETE_ACCOUNT_URL = '';

/** `true` si hay al menos un documento publicado que mostrar. */
export const hasLegalLinks = (): boolean =>
  [PRIVACY_URL, TERMS_URL, DELETE_ACCOUNT_URL].some((url) => url.length > 0);
