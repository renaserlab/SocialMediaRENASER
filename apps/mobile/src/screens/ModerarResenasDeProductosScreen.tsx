import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { EstrellasDeResena } from '@/components/EstrellasDeResena';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import { esFaltaDeSesion } from '@/lib/productos';
import {
  claveDeErrorDeResena,
  compraVerificada,
  esResenasApagadas,
  estaEscondida,
  tieneRespuesta,
} from '@/lib/resenasDeProductos';
import {
  ProductReviewModerationRepository,
  type MovimientoDeModeracion,
  type ResenaDeProducto,
} from '@/repositories/ProductReviewRepository';
import { useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * La cola de moderación de valoraciones.
 *
 * MODERAR ES ESCONDER, NUNCA REESCRIBIR, y la pantalla lo dice arriba del todo:
 * la puntuación, el texto y quién lo escribió se quedan exactamente como
 * estaban. Lo único que cambia es si se ve.
 *
 * EL MOTIVO ES INTERNO. No se le enseña a quien opinó ni a quien vende, y no
 * viaja a la auditoría compartida: queda en el historial de esta cola, que es
 * lo que se mira si alguien pregunta por qué se escondió algo.
 *
 * LA RESPUESTA DEL PROVEEDOR SE MODERA APARTE. Esconder la valoración y
 * esconder lo que le contestaron son dos decisiones distintas, y a veces solo
 * hace falta una.
 */
export function ModerarResenasDeProductosScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();

  const [resenas, setResenas] = useState<ResenaDeProducto[]>([]);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [motivo, setMotivo] = useState('');
  const [historial, setHistorial] = useState<MovimientoDeModeracion[]>([]);
  const [cargando, setCargando] = useState(true);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'sinSesion' | 'sinPermiso' | 'noDisponible' | null
  >(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      setResenas(await ProductReviewModerationRepository.cola());
    } catch (e) {
      if (e instanceof ApiError && esFaltaDeSesion(e.status)) setFallo('sinSesion');
      else if (e instanceof ApiError && e.status === 403) setFallo('sinPermiso');
      else if (e instanceof ApiError && esResenasApagadas(e.code))
        setFallo('noDisponible');
      else if (e instanceof ApiError && esFalloDeRed(e.code)) setFallo('sinConexion');
      else setFallo('red');
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const abrir = async (reviewId: string) => {
    setAbierta(reviewId);
    setMotivo('');
    setError(null);
    setHistorial([]);
    try {
      setHistorial(await ProductReviewModerationRepository.historial(reviewId));
    } catch {
      /* EL HISTORIAL ES INFORMACIÓN DE APOYO. Si no llega, la cola sigue
         funcionando: no se bloquea moderar por no poder leerlo. */
    }
  };

  const esconder = async (reviewId: string, ocultar: boolean) => {
    setOcupado(true);
    setError(null);
    try {
      await ProductReviewModerationRepository.moderar(reviewId, {
        hidden: ocultar,
        reason: motivo.trim() || null,
      });
      setAbierta(null);
      setMotivo('');
      await cargar();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? claveDeErrorDeResena(e.code)
          : 'resenaDeProducto.error.desconocido',
      );
    } finally {
      setOcupado(false);
    }
  };

  const esconderRespuesta = async (replyId: string) => {
    setOcupado(true);
    setError(null);
    try {
      await ProductReviewModerationRepository.moderarRespuesta(replyId, {
        hidden: true,
        reason: motivo.trim() || null,
      });
      await cargar();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? claveDeErrorDeResena(e.code)
          : 'resenaDeProducto.error.desconocido',
      );
    } finally {
      setOcupado(false);
    }
  };

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/admin/productos' as never);

  const encabezado = (
    <AppHeader title={f('resenaDeProducto.moderar.titulo')} onBack={volver} />
  );

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        {fallo === 'sinSesion' ? (
          <StateView
            state="empty"
            icon="lock"
            title={f('sesion.entraParaVerlo')}
            description={f('sesion.entraParaVerloCuerpo')}
          />
        ) : fallo === 'sinPermiso' ? (
          <StateView
            state="empty"
            icon="shield"
            title={f('resenaDeProducto.moderar.sinPermiso')}
            description={f('resenaDeProducto.moderar.sinPermisoCuerpo')}
          />
        ) : fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            icon="clock"
            title={f('resenaDeProducto.apagadas')}
            description={f('resenaDeProducto.apagadasCuerpo')}
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

  if (resenas.length === 0) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        <StateView
          state="empty"
          icon="check-circle"
          title={f('resenaDeProducto.moderar.vacia')}
        />
      </AppScreen>
    );
  }

  return (
    <AppScreen contentStyle={styles.contenido}>
      {encabezado}
      <ScrollView contentContainerStyle={styles.cuerpo} keyboardShouldPersistTaps="handled">
        <Text variant="caption" color="muted">
          {f('resenaDeProducto.moderar.noSeReescribe')}
        </Text>
        {resenas.map((resena) => (
          <View key={resena.id} style={[styles.tarjeta, { borderColor: colors.border }]}>
            <EstrellasDeResena
              valor={resena.overall}
              etiqueta={f('resenaDeProducto.ficha.titulo')}
              sufijo={f('resenaDeProducto.deCinco')}
            />
            {compraVerificada(resena) ? (
              <Text variant="caption" color="muted">
                {f('resenaDeProducto.lista.selloCompra')}
              </Text>
            ) : null}
            {resena.comment ? <Text>{resena.comment}</Text> : null}
            {tieneRespuesta(resena) ? (
              <View style={[styles.respuesta, { borderColor: colors.border }]}>
                <Text variant="caption" color="muted">
                  {f('resenaDeProducto.lista.respuestaDelProveedor')}
                </Text>
                <Text>{resena.reply?.body}</Text>
                <Button
                  label={f('resenaDeProducto.moderar.ocultarRespuesta')}
                  onPress={() => void esconderRespuesta(resena.reply?.id as string)}
                  disabled={ocupado}
                />
              </View>
            ) : null}

            {abierta === resena.id ? (
              <View style={styles.bloque}>
                <Text>{f('resenaDeProducto.moderar.motivo')}</Text>
                <Text variant="caption" color="muted">
                  {f('resenaDeProducto.moderar.motivoAyuda')}
                </Text>
                <Input
                  value={motivo}
                  onChangeText={setMotivo}
                  multiline
                  numberOfLines={2}
                  maxLength={500}
                  accessibilityLabel={f('resenaDeProducto.moderar.motivo')}
                />
                {error !== null ? <InlineError message={f(error)} /> : null}
                <Button
                  label={
                    estaEscondida(resena)
                      ? f('resenaDeProducto.moderar.restaurar')
                      : f('resenaDeProducto.moderar.esconder')
                  }
                  onPress={() => void esconder(resena.id, !estaEscondida(resena))}
                  disabled={ocupado}
                  loading={ocupado}
                />
                <Text variant="caption" color="muted">
                  {f('resenaDeProducto.moderar.historial')}
                </Text>
                {historial.length === 0 ? (
                  <Text variant="caption" color="muted">
                    {f('resenaDeProducto.moderar.historialVacio')}
                  </Text>
                ) : (
                  historial.map((paso) => (
                    <Text key={paso.id} variant="caption" color="muted">
                      {paso.to_status === 'hidden'
                        ? f('resenaDeProducto.moderar.ocultada')
                        : f('resenaDeProducto.moderar.restaurada')}
                    </Text>
                  ))
                )}
              </View>
            ) : (
              <Button
                label={f('resenaDeProducto.moderar.esconder')}
                onPress={() => void abrir(resena.id)}
                disabled={ocupado}
              />
            )}
          </View>
        ))}
      </ScrollView>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { paddingHorizontal: 0 },
  cuerpo: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xl },
  bloque: { gap: spacing.xs },
  tarjeta: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  respuesta: { borderLeftWidth: 2, paddingLeft: spacing.sm, gap: spacing.xs },
});
