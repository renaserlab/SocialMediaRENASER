import type { ImageRequireSource } from 'react-native';

import type { TranslationKey } from '@/i18n';

/**
 * LOS FONDOS VIRTUALES QUE TRAE LA APLICACION. Lista cerrada.
 *
 * SON LOCALES Y SON DE Z. Imagenes generadas para esto —tres estudios, una
 * pantalla verde y dos paisajes dibujados (07/10/2026)—, sin fotografias ni
 * recursos de terceros. Un paisaje FOTOGRAFICO necesita una foto con derechos de
 * uso: cuando la empresa las entregue, se anaden aqui igual que estas. Viajan dentro de la aplicacion: NO se descarga
 * ninguna imagen para usarla de fondo, ni de un servidor propio ni de una
 * direccion que alguien pegue. Una imagen arbitraria detras de una persona, en
 * una emision publica, es contenido sin revisar; y descargarla en mitad de un
 * directo es una peticion mas que puede fallar con la camara encendida.
 *
 * Añadir un fondo es añadir una entrada AQUI y su imagen en
 * `assets/live/fondos/`. El `id` es lo que viaja por el contrato de la sala
 * (`EfectoDeVideo`), y no se reutiliza: quitar un fondo no puede convertir el
 * efecto guardado de alguien en otra imagen.
 *
 * Nombres de fichero en minusculas y con guion bajo: en una compilacion de
 * Android la imagen se busca como recurso por su nombre, y un recurso no
 * admite guiones ni mayusculas.
 */
export type FondoVirtual = {
  id: string;
  /** Como se llama en la hoja de efectos. Clave de traduccion. */
  nombre: TranslationKey;
  imagen: ImageRequireSource;
};

export const FONDOS_VIRTUALES: readonly FondoVirtual[] = [
  {
    id: 'estudio-oscuro',
    nombre: 'live.effectBackgroundDark',
    imagen: require('../../assets/live/fondos/estudio_oscuro.png') as ImageRequireSource,
  },
  {
    id: 'estudio-claro',
    nombre: 'live.effectBackgroundLight',
    imagen: require('../../assets/live/fondos/estudio_claro.png') as ImageRequireSource,
  },
  {
    id: 'sala-gris',
    nombre: 'live.effectBackgroundRoom',
    imagen: require('../../assets/live/fondos/sala_gris.png') as ImageRequireSource,
  },
  {
    // El verde de croma, liso: para quien quiere cambiar el fondo despues, al
    // editar el video.
    id: 'pantalla-verde',
    nombre: 'live.effectBackgroundGreen',
    imagen: require('../../assets/live/fondos/pantalla_verde.png') as ImageRequireSource,
  },
  {
    id: 'atardecer',
    nombre: 'live.effectBackgroundSunset',
    imagen: require('../../assets/live/fondos/atardecer.png') as ImageRequireSource,
  },
  {
    id: 'montanas',
    nombre: 'live.effectBackgroundMountains',
    imagen: require('../../assets/live/fondos/montanas.png') as ImageRequireSource,
  },
];

/** Los ids, que es lo unico que conoce el contrato de la sala. */
export const IDS_DE_FONDOS: readonly string[] = FONDOS_VIRTUALES.map((fondo) => fondo.id);

/** El fondo de un id, o `undefined` si la aplicacion no lo trae. */
export function fondoPorId(id: string): FondoVirtual | undefined {
  return FONDOS_VIRTUALES.find((fondo) => fondo.id === id);
}
