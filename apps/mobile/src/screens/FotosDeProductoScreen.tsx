import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  PermisoNegado,
  elegirEnNativo,
  elegirEnWeb,
  type ImagenElegida,
} from '@/lib/elegirImagen';
import {
  LARGO_MAXIMO_DEL_ALTERNATIVO,
  MAXIMO_DE_FOTOS,
  TIPOS_ADMITIDOS,
  aprobadas,
  avisoDeLaGaleria,
  cabeOtraFoto,
  claveDeErrorDeFotos,
  claveDeLaSubida,
  claveDelEstadoDeLaFoto,
  claveDelMotivo,
  enOrden,
  esFotosApagado,
  hayAlgunaAprobada,
  iconoDelEstadoDeLaFoto,
  moverFoto,
  porQueNoSePuedeSubir,
  type FotoDelProveedor,
} from '@/lib/fotosDeProducto';
import { toast } from '@/lib/toast';
import { ProductMediaRepository } from '@/repositories/ProductMediaRepository';
import { useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Las fotografías del borrador de un producto del proveedor.
 *
 * SUBIR NO ES PUBLICAR, y es lo primero que se lee. Una fotografía nace
 * PENDIENTE: quien evalúa la aprueba o la rechaza con motivo, y el catálogo solo
 * enseña las aprobadas. Sin ese estado escrito en la pantalla, quien sube una
 * foto y no la ve en su ficha cree que se perdió.
 *
 * LA APLICACIÓN NO FIRMA NADA. El depósito es privado: la URL llega firmada del
 * servidor y caduca. Que llegue nula NO ES UN ERROR —es que no se pudo firmar—
 * y entonces se enseña un marcador con el texto alternativo, que para eso es
 * obligatorio.
 *
 * EL ORDEN VIAJA ENTERO. `ordenar` manda la lista COMPLETA de identificadores,
 * que es lo que el servidor exige: una lista parcial dejaría a las que faltan en
 * una posición que nadie eligió y el resultado no sería ni el orden viejo ni el
 * nuevo. Por eso el botón llama a `moverFoto`, que devuelve la lista entera.
 *
 * SIN HOJA INFERIOR, A PROPÓSITO. En iOS el selector de fotos es una pantalla
 * nativa y NO se abre encima de un `Modal` que todavía se está cerrando: falla
 * en silencio (está documentado en `CLAUDE.md`, y `afterSheetClose()` es el
 * parche cuando hay hoja). Aquí el formulario del texto alternativo es una
 * tarjeta de la propia pantalla, así que no hay ningún Modal en medio y no hace
 * falta esperar a nada.
 */

export function FotosDeProductoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();
  const { productId } = useLocalSearchParams<{ productId?: string }>();
  const productoId = typeof productId === 'string' ? productId : '';

  const [fotos, setFotos] = useState<FotoDelProveedor[]>([]);
  const [cargando, setCargando] = useState(true);
  /**
   * Si la galería ya se leyó alguna vez. `fotos` nace como lista vacía, así que
   * no sirve para saberlo: una galería sin fotos también está vacía.
   */
  const [yaCargo, setYaCargo] = useState(false);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'sinSesion' | 'sinPermiso' | 'noEncontrado' | 'noDisponible' | null
  >(null);

  const [alternativo, setAlternativo] = useState('');
  const [errorDelFormulario, setErrorDelFormulario] = useState<string | null>(null);

  /**
   * La clave de idempotencia de la subida EN CURSO.
   *
   * Una por pulsación, y sobrevive al fallo: reintentar con la misma es lo que
   * impide que el mismo archivo acabe dos veces en la galería.
   */
  const claveDeLaFoto = useRef<string | null>(null);

  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  const leerFallo = (error: unknown) => {
    if (error instanceof ApiError && esFotosApagado(error.code)) return 'noDisponible' as const;
    if (error instanceof ApiError && error.status === 503) return 'noDisponible' as const;
    if (error instanceof ApiError && error.status === 401) return 'sinSesion' as const;
    if (error instanceof ApiError && error.status === 403) return 'sinPermiso' as const;
    if (error instanceof ApiError && error.status === 404) return 'noEncontrado' as const;
    if (error instanceof ApiError && esFalloDeRed(error.code)) return 'sinConexion' as const;
    return 'red' as const;
  };

  const cargar = useCallback(async () => {
    if (productoId === '') {
      setFallo('noEncontrado');
      setCargando(false);
      return;
    }
    setCargando(true);
    setFallo(null);
    try {
      setFotos(enOrden(await ProductMediaRepository.mias(productoId)));
      setYaCargo(true);
    } catch (error) {
      setFallo(leerFallo(error));
    } finally {
      setCargando(false);
    }
  }, [productoId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const textoDelError = (error: unknown) => {
    if (error instanceof ApiError) {
      const porCodigo = claveDeErrorDeFotos(error.code);
      if (porCodigo !== null) return f(porCodigo);
      if (error.status === 401) return f('fotos.error.sinSesionCuerpo');
      if (error.status === 403) return f('fotos.error.sinPermisoCuerpo');
      if (error.status === 404) return f('fotos.error.noEncontrada');
    }
    return error instanceof Error && error.message.trim() !== ''
      ? error.message
      : t('common.tryAgain');
  };

  /** El cerrojo, cerrado ANTES del primer `await`. */
  const conCerrojo = async (trabajo: () => Promise<void>) => {
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    setOcupado(true);
    try {
      await trabajo();
    } catch (error) {
      if (error instanceof PermisoNegado) {
        notify(f('fotos.noSePudo'), f('fotos.permisoNegado'));
      } else {
        notify(f('fotos.noSePudo'), textoDelError(error));
      }
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  /**
   * Elegir el archivo y subirlo.
   *
   * SE COMPRUEBA DOS VECES A PROPÓSITO: antes de abrir el selector, lo que ya se
   * sabe sin el archivo —que cabe otra y que el texto alternativo sirve—, para
   * no hacer elegir una foto y decir después que faltaba una frase; y con el
   * archivo en la mano, el tipo y el peso. La comprobación de verdad la hace el
   * servidor, que abre la imagen y mira si los bytes son lo que dicen ser.
   */
  const subir = () => {
    const antes = porQueNoSePuedeSubir({
      // Un tipo admitido de mentira para que la comprobación previa solo pueda
      // fallar por lo que todavía no depende del archivo.
      tipo: TIPOS_ADMITIDOS[0],
      bytes: null,
      altText: alternativo,
      yaHay: fotos.length,
    });
    if (antes !== null) {
      setErrorDelFormulario(f(claveDelMotivo(antes)));
      return;
    }
    setErrorDelFormulario(null);

    void conCerrojo(async () => {
      const elegido = Platform.OS === 'web' ? await elegirEnWeb() : await elegirEnNativo();
      if (elegido === null) return;

      const motivo = porQueNoSePuedeSubir({
        tipo: elegido.tipo,
        bytes: elegido.bytes,
        altText: alternativo,
        yaHay: fotos.length,
      });
      if (motivo !== null) {
        setErrorDelFormulario(f(claveDelMotivo(motivo)));
        return;
      }

      if (claveDeLaFoto.current === null) {
        claveDeLaFoto.current = claveDeLaSubida(productoId, Date.now());
      }
      await ProductMediaRepository.subir(productoId, {
        archivo: elegido.archivo,
        nombre: elegido.nombre,
        altText: alternativo.trim(),
        clave: claveDeLaFoto.current,
      });
      claveDeLaFoto.current = null;
      setAlternativo('');
      await cargar();
      toast(f('fotos.subida'));
    });
  };

  /** Mueve una fotografía en el orden. LA LISTA COMPLETA, siempre. */
  const mover = (foto: FotoDelProveedor, paso: 1 | -1) =>
    void conCerrojo(async () => {
      const orden = moverFoto(fotos, foto.id, paso);
      setFotos(enOrden(await ProductMediaRepository.ordenar(productoId, orden)));
      toast(f('fotos.ordenGuardado'));
    });

  /** Quita una fotografía. SE PREGUNTA ANTES: no se deshace. */
  const quitar = (foto: FotoDelProveedor) =>
    void conCerrojo(async () => {
      const aceptado = await confirm({
        title: f('fotos.quitarTitulo'),
        message: f('fotos.quitarCuerpo'),
        confirmLabel: f('fotos.quitar'),
        destructive: true,
      });
      if (!aceptado) return;
      await ProductMediaRepository.quitar(productoId, foto.id);
      await cargar();
      toast(f('fotos.quitada'));
    });

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/proveedor/productos' as never);

  const titulo = f('fotos.titulo');

  // A pantalla completa SOLO la primera vez. Subir o quitar una fotografía
  // vuelve a leer la galería, y cambiarla entera por «Cargando…» hacía
  // parpadear la pantalla después de cada una.
  if (cargando && !yaCargo) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
    const blando =
      fallo === 'noDisponible' ||
      fallo === 'sinPermiso' ||
      fallo === 'sinSesion' ||
      fallo === 'noEncontrado';
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        {blando ? (
          <StateView
            state="empty"
            icon={
              fallo === 'noDisponible' ? 'clock' : fallo === 'noEncontrado' ? 'inbox' : 'lock'
            }
            title={
              fallo === 'noDisponible'
                ? f('fotos.error.noDisponible')
                : fallo === 'sinSesion'
                  ? f('fotos.error.sinSesion')
                  : fallo === 'sinPermiso'
                    ? f('fotos.error.sinPermiso')
                    : f('fotos.error.noEncontrada')
            }
            description={
              fallo === 'noDisponible'
                ? f('fotos.error.noDisponibleCuerpo')
                : fallo === 'sinSesion'
                  ? f('fotos.error.sinSesionCuerpo')
                  : fallo === 'sinPermiso'
                    ? f('fotos.error.sinPermisoCuerpo')
                    : f('fotos.error.noEncontradaCuerpo')
            }
          />
        ) : (
          <StateView
            state={fallo === 'sinConexion' ? 'offline' : 'error'}
            description={fallo === 'sinConexion' ? undefined : t('common.loadFailed')}
            onRetry={() => void cargar()}
          />
        )}
      </AppScreen>
    );
  }

  const aviso = avisoDeLaGaleria(fotos);
  const cabe = cabeOtraFoto(fotos);
  const cuantasAprobadas = aprobadas(fotos).length;

  /** Una fotografía: la imagen o su marcador, el estado y lo que se puede hacer. */
  const pintarFoto = (foto: FotoDelProveedor, indice: number) => {
    const icono = iconoDelEstadoDeLaFoto(foto.status);
    const rechazada = foto.status === 'rejected';
    const colorDelEstado = rechazada
      ? colors.danger
      : foto.status === 'approved'
        ? colors.text
        : colors.textMuted;

    return (
      <View key={foto.id} style={[styles.fila, { borderColor: colors.border }]}>
        {/* SIN URL NO HAY IMAGEN, Y NO ES UN FALLO: es que no se pudo firmar.
            Se enseña el texto alternativo, que para eso es obligatorio. */}
        {foto.url !== null ? (
          <Image
            source={{ uri: foto.url, cacheKey: foto.storage_path }}
            style={styles.imagen}
            contentFit="cover"
            accessibilityLabel={foto.alt_text ?? undefined}
          />
        ) : (
          <View style={[styles.marcador, { borderColor: colors.border }]}>
            <Feather name="image" size={24} color={colors.textMuted} />
            <Text variant="caption" color={colors.textMuted}>
              {foto.alt_text !== null && foto.alt_text.trim() !== ''
                ? foto.alt_text
                : f('fotos.sinAlternativo')}
            </Text>
          </View>
        )}

        <View style={styles.cabecera}>
          {icono !== null ? (
            <Feather
              name={icono as keyof typeof Feather.glyphMap}
              size={18}
              color={colorDelEstado}
            />
          ) : null}
          <View style={styles.crece}>
            <Text variant="secondary" weight="700" color={colorDelEstado}>
              {f(claveDelEstadoDeLaFoto(foto.status))}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {f('fotos.posicion', { n: indice + 1, total: fotos.length })}
            </Text>
          </View>
        </View>

        {/* EL MOTIVO DEL RECHAZO ES LO ÚNICO QUE PERMITE CORREGIRLA. */}
        {rechazada && foto.rejection_reason !== null && foto.rejection_reason.trim() !== '' ? (
          <Text variant="secondary" color={colors.danger}>
            {f('fotos.motivoDelRechazo', { motivo: foto.rejection_reason })}
          </Text>
        ) : null}

        <Button
          label={f('fotos.subirOrden')}
          variant="secondary"
          icon="arrow-up"
          onPress={() => mover(foto, -1)}
          disabled={ocupado || indice === 0}
        />
        <Button
          label={f('fotos.bajarOrden')}
          variant="secondary"
          icon="arrow-down"
          onPress={() => mover(foto, 1)}
          disabled={ocupado || indice === fotos.length - 1}
        />
        <Button
          label={f('fotos.quitar')}
          variant="ghost"
          icon="trash-2"
          onPress={() => quitar(foto)}
          disabled={ocupado}
        />
      </View>
    );
  };

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />

      <View style={[styles.avisoCaja, { backgroundColor: colors.surfaceAlt }]}>
        <Feather name="camera" size={16} color={colors.textMuted} />
        <View style={styles.crece}>
          <Text variant="secondary" weight="700">
            {f('fotos.titulo')}
          </Text>
          {/* SUBIR NO ES PUBLICAR. Lo primero que se lee. */}
          <Text variant="caption" color={colors.textMuted}>
            {f('fotos.subirNoEsPublicar')}
          </Text>
          {/* El aviso del módulo: UNO SOLO, y el más accionable primero. */}
          {aviso !== null ? <Text variant="secondary">{f(aviso)}</Text> : null}
          {hayAlgunaAprobada(fotos) ? (
            <Text variant="caption" color={colors.textMuted}>
              {f('fotos.cuantasAprobadas', { n: cuantasAprobadas, total: fotos.length })}
            </Text>
          ) : null}
        </View>
      </View>

      {/* El texto alternativo se pide ANTES de elegir el archivo. */}
      <View style={[styles.recuadro, { borderColor: colors.border }]}>
        <Text variant="secondary" weight="700">
          {f('fotos.subir')}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('fotos.alternativoPorQue')}
        </Text>
        <Input
          label={f('fotos.alternativoEtiqueta')}
          placeholder={f('fotos.alternativoAyuda')}
          value={alternativo}
          onChangeText={(texto) => {
            setAlternativo(texto.slice(0, LARGO_MAXIMO_DEL_ALTERNATIVO));
            if (errorDelFormulario !== null) setErrorDelFormulario(null);
          }}
          maxLength={LARGO_MAXIMO_DEL_ALTERNATIVO}
          multiline
          numberOfLines={2}
          style={styles.campoLargo}
          disabled={ocupado}
        />
        {errorDelFormulario !== null ? (
          <Text variant="caption" color={colors.danger}>
            {errorDelFormulario}
          </Text>
        ) : null}
        <Button
          label={f('fotos.subir')}
          icon="upload"
          onPress={subir}
          loading={ocupado}
          disabled={ocupado || !cabe}
        />
        {/* EL TOPE SE DICE, no se deja un botón apagado sin explicación. */}
        {!cabe ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('fotos.noCabenMas', { max: MAXIMO_DE_FOTOS })}
          </Text>
        ) : null}
      </View>

      {fotos.length === 0 ? (
        <StateView
          state="empty"
          icon="image"
          title={f('fotos.vacio')}
          description={f('fotos.vacioCuerpo')}
          onRetry={() => void cargar()}
        />
      ) : (
        fotos.map(pintarFoto)
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  crece: { flex: 1, gap: 4 },
  cabecera: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  imagen: { width: '100%', height: 200, borderRadius: radius.md },
  marcador: {
    width: '100%',
    minHeight: 120,
    gap: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.lg,
  },
  avisoCaja: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  fila: {
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  recuadro: {
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  campoLargo: {
    minHeight: 72,
    textAlignVertical: 'top',
    paddingTop: spacing.sm,
  },
});
