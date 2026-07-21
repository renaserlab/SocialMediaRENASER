/**
 * En web no hay modulo nativo de compresion: react-native-compressor romperia
 * el bundle. Se sube el archivo tal cual (en escritorio el ancho de banda y la
 * bateria no son el cuello de botella que si lo son en movil).
 */
export const compressionAvailable = false;

export async function compressVideo(
  uri: string,
  _onProgress?: (ratio: number) => void,
): Promise<string> {
  return uri;
}

export async function compressImage(uri: string): Promise<string> {
  return uri;
}
