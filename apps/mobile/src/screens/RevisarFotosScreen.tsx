import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import {
  LIMITE_INICIAL,
  claveDelCuerpoDelFallo,
  claveDelFallo,
  falloDeCarga,
  llegoAlTope,
  seReintenta,
  siguienteLimite,
  type FalloDeCarga,
} from '@/lib/evaluacionDeProductos';
import {
  claveDeErrorDeFotos,
  esFotosApagado,
  type FotoPendiente,
} from '@/lib/fotosDeProducto';
import { toast } from '@/lib/toast';
import { ProductMediaRepository } from '@/repositories/ProductMediaRepository';
import { useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * La bandeja de fotografías pendientes. Pantalla INTERNA.
 *
 * APROBAR UNA FOTOGRAFÍA ES PUBLICARLA. El catálogo solo enseña las aprobadas,
 * así que este es el único sitio donde una imagen pasa a verse fuera. Por eso la
 * bandeja existe: aprobar un producto no puede aprobar de paso cualquier imagen
 * que le añadan después.
 *
 * RECHAZAR EXIGE MOTIVO, y no es una formalidad: es LO ÚNICO que le llega a
 * quien la subió. Un rechazo sin motivo deja a alguien mirando una foto que no
 * sabe qué tiene mal, y la vuelve a subir igual. El botón está apagado hasta que
 * hay un motivo escrito, y se dice por qué.
 *
 * NADIE REVISA LO SUYO. El servidor contesta 403 con dos códigos distintos y
 * significan cosas distintas: `product_review_forbidden` es «no eres curaduría»
 * y `product_self_review_forbidden` es «este producto es tuyo». Enseñar el
 * segundo como un fallo de permisos genérico manda a alguien a pedir un permiso
 * que ya tiene.
 *
 * LA URL LLEGA FIRMADA Y CADUCA. Que llegue nula no es una avería: es que no se
 * pudo firmar, y entonces se revisa con el texto alternativo delante, que es
 * justo lo que hay que juzgar cuando la imagen no carga.
 */

/** Cuántos caracteres cabe un motivo de rechazo. */
const LARGO_DEL_MOTIVO = 200;

/** Lo mínimo que tiene que decir un motivo para que sirva de algo. */
const LARGO_MINIMO_DEL_MOTIVO = 3;

export function RevisarFotosScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();

  const [filas, setFilas] = useState<FotoPendiente[]>([]);
  const [limite, setLimite] = useState<number>(LIMITE_INICIAL);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<FalloDeCarga | null>(null);

  /** Sobre cuál se está escribiendo el motivo del rechazo. */
  const [rechazando, setRechazando] = useState<string | null>(null);
  const [motivo, setMotivo] = useState('');

  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  /**
   * El fallo, con el 503 de las fotografías mirado ANTES.
   *
   * `falloDeCarga` no conoce `product_media_not_available` —es de la 0073, que
   * llegó después— y sin esto un despliegue sin migrar se leería como una
   * avería en vez de como una puerta todavía cerrada.
   */
  const leerFallo = (error: unknown): FalloDeCarga => {
    if (error instanceof ApiError) {
      if (esFotosApagado(error.code)) return 'noDisponible';
      return falloDeCarga(error.status, error.code);
    }
    return falloDeCarga(null, null);
  };

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      setFilas(await ProductMediaRepository.pendientes(limite));
    } catch (error) {
      setFallo(leerFallo(error));
    } finally {
      setCargando(false);
    }
  }, [limite]);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  const textoDelError = (error: unknown) => {
    if (error instanceof ApiError) {
      const porCodigo = claveDeErrorDeFotos(error.code);
      if (porCodigo !== null) return f(porCodigo);
      const cual = leerFallo(error);
      if (!seReintenta(cual)) return f(claveDelCuerpoDelFallo(cual));
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
      notify(f('fotos.bandeja.noSePudo'), textoDelError(error));
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  const cerrarRechazo = () => {
    setRechazando(null);
    setMotivo('');
  };

  /** Aprueba. A partir de aquí la fotografía se ve en el catálogo. */
  const aprobar = (foto: FotoPendiente) =>
    void conCerrojo(async () => {
      await ProductMediaRepository.decidir(foto.id, { approved: true });
      cerrarRechazo();
      await cargar();
      toast(f('fotos.bandeja.aprobada'));
    });

  /** Rechaza CON MOTIVO. Sin motivo no se llega hasta aquí. */
  const rechazar = (foto: FotoPendiente) => {
    const limpio = motivo.trim();
    if (limpio.length < LARGO_MINIMO_DEL_MOTIVO) return;
    void conCerrojo(async () => {
      await ProductMediaRepository.decidir(foto.id, { approved: false, reason: limpio });
      cerrarRechazo();
      await cargar();
      toast(f('fotos.bandeja.rechazada'));
    });
  };

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));

  const titulo = f('fotos.bandeja.titulo');
  const masArriba = siguienteLimite(limite);
  const tope = llegoAlTope(filas.length, limite);

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        {seReintenta(fallo) ? (
          <StateView
            state={fallo === 'sinConexion' ? 'offline' : 'error'}
            description={fallo === 'sinConexion' ? undefined : t('common.loadFailed')}
            onRetry={() => void cargar()}
          />
        ) : (
          /* «Es tu propio producto» NO es el mismo 403 que «no eres curaduría»:
             cada uno tiene su texto y su icono. */
          <StateView
            state="empty"
            icon={
              fallo === 'noDisponible'
                ? 'clock'
                : fallo === 'noEncontrada'
                  ? 'inbox'
                  : fallo === 'esTuProducto'
                    ? 'user-x'
                    : 'lock'
            }
            title={f(claveDelFallo(fallo))}
            description={f(claveDelCuerpoDelFallo(fallo))}
          />
        )}
      </AppScreen>
    );
  }

  /** Una fotografía esperando decisión. */
  const pintarFila = (foto: FotoPendiente) => {
    const alternativo =
      foto.alt_text !== null && foto.alt_text.trim() !== '' ? foto.alt_text : null;
    const medidas =
      typeof foto.width === 'number' && typeof foto.height === 'number'
        ? f('fotos.bandeja.medidas', { ancho: foto.width, alto: foto.height })
        : null;
    /* El peso llega en bytes. Se escribe en kilobytes enteros porque es lo que
       se puede juzgar de un vistazo; si no llega, no se escribe nada. */
    const peso =
      typeof foto.byte_size === 'number' && Number.isFinite(foto.byte_size)
        ? f('fotos.bandeja.peso', { kb: Math.max(1, Math.round(foto.byte_size / 1024)) })
        : null;
    const aqui = rechazando === foto.id;
    const motivoSirve = motivo.trim().length >= LARGO_MINIMO_DEL_MOTIVO;

    return (
      <View key={foto.id} style={[styles.fila, { borderColor: colors.border }]}>
        {foto.url !== null ? (
          <Image
            source={{ uri: foto.url, cacheKey: foto.storage_path }}
            style={styles.imagen}
            contentFit="cover"
            accessibilityLabel={alternativo ?? undefined}
          />
        ) : (
          <View style={[styles.marcador, { borderColor: colors.border }]}>
            <Feather name="image" size={24} color={colors.textMuted} />
            <Text variant="caption" color={colors.textMuted}>
              {alternativo ?? f('fotos.sinAlternativo')}
            </Text>
          </View>
        )}

        <Text variant="secondary" weight="700">
          {foto.product_name}
        </Text>
        {alternativo !== null ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('fotos.bandeja.alternativo', { texto: alternativo })}
          </Text>
        ) : null}
        {/* LO QUE NO LLEGA NO SE PINTA: no se calcula ninguna medida. */}
        {medidas !== null ? (
          <Text variant="caption" color={colors.textMuted}>
            {medidas}
          </Text>
        ) : null}
        {peso !== null ? (
          <Text variant="caption" color={colors.textMuted}>
            {peso}
          </Text>
        ) : null}

        {aqui ? (
          <View style={[styles.recuadro, { borderColor: colors.border }]}>
            <Text variant="secondary" weight="700">
              {f('fotos.bandeja.rechazar')}
            </Text>
            {/* POR QUÉ HACE FALTA EL MOTIVO, dicho donde se escribe. */}
            <Text variant="caption" color={colors.textMuted}>
              {f('fotos.bandeja.porQueMotivo')}
            </Text>
            <Input
              label={f('fotos.bandeja.motivoEtiqueta')}
              placeholder={f('fotos.bandeja.motivoAyuda')}
              value={motivo}
              onChangeText={(texto) => setMotivo(texto.slice(0, LARGO_DEL_MOTIVO))}
              maxLength={LARGO_DEL_MOTIVO}
              multiline
              numberOfLines={3}
              style={styles.campoLargo}
              disabled={ocupado}
            />
            {!motivoSirve ? (
              <Text variant="caption" color={colors.textMuted}>
                {f('fotos.bandeja.motivoCorto', { min: LARGO_MINIMO_DEL_MOTIVO })}
              </Text>
            ) : null}
            <Button
              label={f('fotos.bandeja.rechazar')}
              icon="x-circle"
              onPress={() => rechazar(foto)}
              loading={ocupado}
              disabled={ocupado || !motivoSirve}
            />
            <Button
              label={t('common.cancel')}
              variant="ghost"
              onPress={cerrarRechazo}
              disabled={ocupado}
            />
          </View>
        ) : (
          <View style={styles.acciones}>
            <Button
              label={f('fotos.bandeja.aprobar')}
              icon="check-circle"
              onPress={() => aprobar(foto)}
              loading={ocupado}
              disabled={ocupado}
            />
            <Button
              label={f('fotos.bandeja.rechazar')}
              variant="secondary"
              icon="x-circle"
              onPress={() => {
                setRechazando(foto.id);
                setMotivo('');
              }}
              disabled={ocupado}
            />
          </View>
        )}
      </View>
    );
  };

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />

      <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
        <Feather name="image" size={16} color={colors.textMuted} />
        <View style={styles.crece}>
          <Text variant="secondary" weight="700">
            {f('fotos.bandeja.titulo')}
          </Text>
          <Text variant="caption" color={colors.textMuted}>
            {f('fotos.bandeja.cuerpo')}
          </Text>
          <Text variant="caption" color={colors.textMuted}>
            {f('productosAdmin.sinDinero')}
          </Text>
        </View>
      </View>

      {filas.length === 0 ? (
        <StateView
          state="empty"
          icon="check-circle"
          title={f('fotos.bandeja.vacio')}
          description={f('fotos.bandeja.vacioCuerpo')}
          onRetry={() => void cargar()}
        />
      ) : (
        filas.map(pintarFila)
      )}

      {/* EL TOPE SE DICE: «cincuenta» no es «todas». */}
      {tope ? (
        <Text variant="caption" color={colors.textMuted}>
          {f('fotos.bandeja.tope', { n: limite })}
        </Text>
      ) : null}
      {tope && masArriba !== null ? (
        <Button
          label={f('fotos.bandeja.verMas', { n: masArriba })}
          variant="secondary"
          onPress={() => setLimite(masArriba)}
          disabled={ocupado}
        />
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  crece: { flex: 1, gap: 4 },
  acciones: { gap: spacing.sm },
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
  aviso: {
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
