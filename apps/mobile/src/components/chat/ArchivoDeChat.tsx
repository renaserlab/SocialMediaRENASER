import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { CabeceraDeAdjunto } from '@/components/chat/CabeceraDeAdjunto';
import { useTranslation } from '@/i18n/useTranslation';
import { confirm, notify } from '@/lib/confirm';
import { mantenerAccesible } from '@/lib/mantenerAccesible';
import {
  MAX_BYTES_A_CARPETA,
  aspectoDeArchivo,
  detalleDeArchivo,
  pesoLegible,
  type TonoDeArchivo,
} from '@/lib/mediosDeChat';
import { descargarAlTelefono, hayQueElegirCarpeta } from '@/services/descargarArchivo';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { MessageAttachment } from '@/types';

type Props = {
  adjunto: MessageAttachment;
  /** Va dentro de una burbuja propia: el texto usa el color de esa burbuja. */
  mio?: boolean;
  /**
   * Si el archivo es en realidad una foto o un video, lo que hace tocarlo:
   * verlo en el visor de la aplicación. Sin esto, tocarlo lo descarga.
   */
  alVer?: () => void;
  /** Mantener presionado: el menú del mensaje. */
  alMantener?: () => void;
  /**
   * Mantener presionado abre EL MENÚ DEL MENSAJE (en el chat y en un tema), y
   * así se le dice al lector de pantalla. En Contenido es elegir, y no se dice.
   */
  mantenerAbreElMenu?: boolean;
  /**
   * Una línea más bajo el peso. En la pestaña «Archivos» dice quién lo mandó
   * y cuándo; en la burbuja eso ya lo dice el propio mensaje.
   */
  pie?: string;
  style?: StyleProp<ViewStyle>;
};

/** El color del recuadro de cada tipo. Sobre todos se lee el blanco. */
const TONOS: Record<TonoDeArchivo, string> = {
  rojo: '#D64545',
  azul: '#3B7DD8',
  verde: '#2E9461',
  ambar: '#C98212',
  morado: '#7C5AC7',
  gris: '#6B7280',
};

/**
 * Lo ya descargado en esta sesión, por su ruta en el almacén: para que la
 * marca de «descargado» siga puesta al volver a pasar por el mensaje. Se
 * pierde al cerrar la aplicación, y está bien: el archivo sigue en el teléfono
 * y volver a tocarlo solo lo descarga otra vez.
 */
const descargados = new Set<string>();

/**
 * Un archivo en el chat: qué es, cómo se llama, cuánto pesa y un botón para
 * descargarlo.
 *
 * LO PEDIDO (12/10/2026, con captura). Antes era una ficha con borde dentro
 * de la burbuja, y tocarla abría el archivo en el navegador, fuera de Z.
 * Ahora:
 *
 *  - se reconoce de un vistazo, por un recuadro de color con su tipo;
 *  - lleva al lado un botón de descargar, que lo guarda en el teléfono sin
 *    salir de la aplicación y enseña el avance;
 *  - si en realidad es una foto o un video, tocarlo lo abre en el visor.
 *
 * El recuadro y el botón van como HERMANOS, no uno dentro de otro: en la web
 * cada zona que se toca es un botón, y un botón dentro de otro es HTML
 * inválido.
 *
 * MANTENER PULSADO, EN CUALQUIER PARTE (31/10/2026). Lo pidió el usuario: en
 * un archivo solo abría el menú del mensaje la ficha; el botón de descargar, la
 * línea del nombre del archivo y los huecos no. Peor aún, mantener el botón de
 * descargar DESCARGABA al soltar (un `Pressable` sin `onLongPress` da el toque
 * por bueno aunque dure). Ahora:
 *
 *  - los dos botones llevan `onLongPress`: tocar descarga o abre, como antes;
 *    mantener abre el menú;
 *  - lo que no es un botón (la raya, la línea del nombre, los huecos) no se
 *    queda con el dedo (`pointerEvents`), y el toque llega a lo de debajo: la
 *    capa de mantener de la burbuja del chat.
 */
export function ArchivoDeChat({
  adjunto,
  mio = false,
  alVer,
  alMantener,
  mantenerAbreElMenu = false,
  pie,
  style,
}: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  /** Lo que el lector de pantalla necesita para abrir el menú desde aquí. */
  const mantenerParaElLector = mantenerAccesible(mantenerAbreElMenu ? alMantener : undefined, {
    pista: t('chat.holdForActions'),
    etiqueta: t('chat.messageActions'),
  });
  /** De 0 a 1 mientras baja; `null` si no está bajando. */
  const [avance, setAvance] = useState<number | null>(null);
  const [hecho, setHecho] = useState(() => descargados.has(adjunto.storagePath));
  // El doble toque: el estado tarda un fotograma en llegar al botón.
  const enCurso = useRef(false);
  const ultimoPintado = useRef(0);

  // Mientras sube, lo que hay es una ruta de este teléfono: nada que descargar.
  const disponible = !!adjunto.url && adjunto.url.startsWith('http');
  const nombre = adjunto.fileName ?? t('chat.file');
  const aspecto = aspectoDeArchivo(adjunto.mimeType, adjunto.fileName);
  const colorTexto = mio ? colors.sobreBurbujaPropia : colors.text;

  const descargar = useCallback(async () => {
    if (!disponible || !adjunto.url || enCurso.current) return;
    if (descargados.has(adjunto.storagePath)) {
      notify(t('chat.downloadedTitle'), t('chat.downloadedAlready'));
      return;
    }
    enCurso.current = true;
    try {
      // El selector de carpetas del sistema, sin aviso, parece un error: se
      // explica antes, la única vez que sale.
      if (await hayQueElegirCarpeta(adjunto.mimeType, adjunto.fileName)) {
        const seguir = await confirm({
          title: t('chat.downloadFolderTitle'),
          message: t('chat.downloadFolderBody'),
          confirmLabel: t('chat.downloadFolderChoose'),
        });
        if (!seguir) return;
      }

      ultimoPintado.current = 0;
      setAvance(0);
      const resultado = await descargarAlTelefono({
        url: adjunto.url,
        nombre: adjunto.fileName,
        mimeType: adjunto.mimeType,
        bytes: adjunto.bytes,
        alAvanzar: (ratio) => {
          // De tres en tres puntos: pintar cada byte que llega no dice más y
          // repinta la burbuja cientos de veces.
          if (ratio - ultimoPintado.current < 0.03 && ratio < 1) return;
          ultimoPintado.current = ratio;
          setAvance(ratio);
        },
      });

      if (resultado.estado === 'guardado') {
        descargados.add(adjunto.storagePath);
        setHecho(true);
        notify(
          t('chat.downloadedTitle'),
          resultado.donde === 'galeria'
            ? t('chat.downloadedToGallery')
            : resultado.carpeta
              ? t('chat.downloadedToFolder', { carpeta: resultado.carpeta })
              : t('chat.downloadedToFolderUnnamed'),
        );
      } else if (resultado.estado === 'sin_permiso') {
        notify(t('chat.saveDeniedTitle'), t('chat.saveDeniedBody'));
      } else if (resultado.estado === 'demasiado_grande') {
        notify(
          t('chat.downloadFailedTitle'),
          t('chat.downloadTooBigBody', { max: pesoLegible(MAX_BYTES_A_CARPETA) }),
        );
      } else if (resultado.estado === 'fallo') {
        notify(t('chat.downloadFailedTitle'), t('common.tryAgainSoon'));
      }
      // `cancelado`, `compartido` y `abierto_fuera` no avisan: la persona
      // cerró el selector, o ya tiene delante la hoja del sistema.
    } finally {
      enCurso.current = false;
      setAvance(null);
    }
  }, [disponible, adjunto, t]);

  const bajando = avance !== null;
  const detalle = bajando
    ? t('chat.downloading', { porcentaje: Math.round((avance ?? 0) * 100) })
    : hecho
      ? t('chat.downloaded')
      : detalleDeArchivo(adjunto.fileName, adjunto.bytes);

  /** La descarga de la tarjeta: la misma, más pequeña, en su línea fina. */
  const descargaDeLaTarjeta = disponible ? (
    <Pulsable
      onPress={() => void descargar()}
      onLongPress={alMantener}
      delayLongPress={400}
      disabled={bajando}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t('chat.downloadFile', { nombre }).trim()}
      accessibilityState={{ busy: bajando }}
      {...mantenerParaElLector}
      style={[styles.boton, styles.botonCompacto, { borderColor: colorTexto }]}
    >
      {bajando ? (
        <ActivityIndicator size="small" color={colorTexto} />
      ) : (
        <Feather name={hecho ? 'check' : 'download'} size={16} color={colorTexto} />
      )}
    </Pulsable>
  ) : null;

  /*
    CON NOMBRE, LA TARJETA (audios y temas, 30/10/2026): el cuadrito con la
    sigla y el nombre que le pusieron arriba, y debajo una línea fina con el
    nombre real del archivo, su peso y la descarga. Tocar la cabecera hace lo
    mismo que tocar el archivo sin nombre: verlo, o bajarlo. Sin nombre, todo
    sigue como antes, más abajo.
  */
  const titulo = adjunto.title?.trim();
  if (titulo) {
    return (
      <View style={[styles.tarjeta, style]} pointerEvents="box-none">
        <Pulsable
          onPress={alVer ?? (() => void descargar())}
          onLongPress={alMantener}
          delayLongPress={400}
          disabled={!disponible}
          accessibilityRole={disponible ? 'button' : undefined}
          accessibilityLabel={
            disponible
              ? t(alVer ? 'chat.openFile' : 'chat.downloadFile', { nombre: titulo }).trim()
              : titulo
          }
          {...mantenerParaElLector}
        >
          <CabeceraDeAdjunto adjunto={adjunto} mio={mio} pie={pie} />
        </Pulsable>
        <View style={[styles.raya, { backgroundColor: colorTexto }]} pointerEvents="none" />
        <View style={styles.lineaFina} pointerEvents="box-none">
          <View style={styles.detalleFino} pointerEvents="none">
            <Text numberOfLines={1} color={colorTexto} style={styles.detalle}>
              {[nombre, detalle].filter(Boolean).join(' · ')}
            </Text>
          </View>
          {descargaDeLaTarjeta}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.fila, style]} pointerEvents="box-none">
      <Pulsable
        onPress={alVer ?? (() => void descargar())}
        onLongPress={alMantener}
        delayLongPress={400}
        disabled={!disponible}
        accessibilityRole={disponible ? 'button' : undefined}
        accessibilityLabel={
          disponible
            ? t(alVer ? 'chat.openFile' : 'chat.downloadFile', { nombre }).trim()
            : nombre
        }
        {...mantenerParaElLector}
        style={styles.cuerpo}
      >
        <View style={[styles.recuadro, { backgroundColor: TONOS[aspecto.tono] }]}>
          {aspecto.icono ? (
            <Feather name={aspecto.icono} size={20} color="#FFF" />
          ) : (
            <Text color="#FFF" weight="800" numberOfLines={1} style={styles.sigla}>
              {aspecto.sigla}
            </Text>
          )}
        </View>
        <View style={styles.textos}>
          <Text numberOfLines={2} weight="600" color={colorTexto} style={styles.nombre}>
            {nombre}
          </Text>
          {detalle ? (
            <Text numberOfLines={1} color={colorTexto} style={styles.detalle}>
              {detalle}
            </Text>
          ) : null}
          {pie ? (
            <Text numberOfLines={1} color={colorTexto} style={styles.detalle}>
              {pie}
            </Text>
          ) : null}
        </View>
      </Pulsable>

      {disponible ? (
        <Pulsable
          onPress={() => void descargar()}
          onLongPress={alMantener}
          delayLongPress={400}
          disabled={bajando}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={t('chat.downloadFile', { nombre }).trim()}
          accessibilityState={{ busy: bajando }}
          {...mantenerParaElLector}
          style={[styles.boton, { borderColor: colorTexto }]}
        >
          {bajando ? (
            <ActivityIndicator size="small" color={colorTexto} />
          ) : (
            <Feather name={hecho ? 'check' : 'download'} size={18} color={colorTexto} />
          )}
        </Pulsable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fila: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, width: 250 },
  cuerpo: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  recuadro: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sigla: { fontSize: 12, lineHeight: 16, letterSpacing: 0.3 },
  textos: { flex: 1, minWidth: 0 },
  nombre: { fontSize: 14, lineHeight: 18 },
  detalle: { fontSize: 12, lineHeight: 16, opacity: 0.75 },
  boton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  botonCompacto: { width: 32, height: 32, borderRadius: 16, borderWidth: 1 },
  tarjeta: { width: 250, gap: spacing.sm },
  // La raya se dibuja con la tinta de la burbuja, rebajada: un token, no un
  // gris escrito a mano que se perdería sobre la burbuja propia.
  raya: { height: StyleSheet.hairlineWidth, opacity: 0.25, marginBottom: -spacing.xs },
  lineaFina: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  detalleFino: { flex: 1, minWidth: 0 },
});
