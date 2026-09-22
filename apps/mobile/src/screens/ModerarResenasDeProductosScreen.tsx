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
  cursorDeLaPagina,
  esResenasApagadas,
  estaEscondida,
  fusionarPaginas,
  hayMasPaginas,
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
 * HAY DOS LADOS, Y ESO ES LO QUE HACE QUE ESCONDER SE PUEDA DESHACER. La
 * primera versión solo pedía las visibles, así que la rama de «volver a
 * mostrar» era código muerto: una valoración escondida por error no se podía
 * volver a encontrar. Lo encontró la revisión independiente del Incremento 8.
 *
 * EL MOTIVO ES DE CADA FILA, Y ES INTERNO. Antes había un solo recuadro para
 * toda la lista, así que un motivo escrito en una valoración y no enviado se
 * pegaba a la siguiente que se tocara —en una tabla que un disparador hace
 * inmutable, así que no se podía corregir nunca—. Ahora cada fila guarda el
 * suyo, y el de la respuesta del proveedor es otro campo distinto.
 *
 * Y NO VIAJA A LA AUDITORÍA COMPARTIDA: puede llevar dentro una cita de lo que
 * escribió quien opinó. Vive en el historial de esta cola.
 */
export function ModerarResenasDeProductosScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();

  const [escondidas, setEscondidas] = useState(false);
  const [resenas, setResenas] = useState<ResenaDeProducto[]>([]);
  const [abierta, setAbierta] = useState<string | null>(null);
  /** El motivo DE CADA FILA, y el de su respuesta aparte. */
  const [motivos, setMotivos] = useState<Record<string, string>>({});
  const [motivosDeRespuesta, setMotivosDeRespuesta] = useState<
    Record<string, string>
  >({});
  const [historial, setHistorial] = useState<MovimientoDeModeracion[]>([]);
  const [cargando, setCargando] = useState(true);
  const [ocupado, setOcupado] = useState(false);
  const [hayMas, setHayMas] = useState(false);
  const [pidiendoMas, setPidiendoMas] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'sinSesion' | 'sinPermiso' | 'noDisponible' | null
  >(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    setAbierta(null);
    try {
      const filas = await ProductReviewModerationRepository.cola({
        hidden: escondidas,
      });
      setResenas(filas);
      setHayMas(hayMasPaginas(filas.length));
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
  }, [escondidas]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const verMas = async () => {
    const cursor = cursorDeLaPagina(resenas);
    if (!cursor) return;
    setPidiendoMas(true);
    try {
      const siguiente = await ProductReviewModerationRepository.cola({
        hidden: escondidas,
        before: cursor.before,
        beforeId: cursor.before_id,
      });
      setResenas((antes) => fusionarPaginas(antes, siguiente));
      setHayMas(hayMasPaginas(siguiente.length));
    } catch {
      /* UN FALLO AL PEDIR MÁS NO VACÍA LO QUE YA SE LEÍA. */
      setHayMas(true);
    } finally {
      setPidiendoMas(false);
    }
  };

  const abrir = async (reviewId: string) => {
    setAbierta(reviewId);
    setError(null);
    setHistorial([]);
    try {
      setHistorial(await ProductReviewModerationRepository.historial(reviewId));
    } catch {
      /* EL HISTORIAL ES INFORMACIÓN DE APOYO. Si no llega, la cola sigue
         funcionando: no se bloquea moderar por no poder leerlo. */
    }
  };

  const mover = async (reviewId: string, ocultar: boolean) => {
    setOcupado(true);
    setError(null);
    try {
      await ProductReviewModerationRepository.moderar(reviewId, {
        hidden: ocultar,
        reason: (motivos[reviewId] ?? '').trim() || null,
      });
      setMotivos((antes) => ({ ...antes, [reviewId]: '' }));
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
        reason: (motivosDeRespuesta[replyId] ?? '').trim() || null,
      });
      setMotivosDeRespuesta((antes) => ({ ...antes, [replyId]: '' }));
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

  const cambiarDeLado = (
    <Button
      label={
        escondidas
          ? f('resenaDeProducto.moderar.verVisibles')
          : f('resenaDeProducto.moderar.verEscondidas')
      }
      variant="secondary"
      onPress={() => setEscondidas((antes) => !antes)}
      disabled={ocupado}
    />
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
        <ScrollView contentContainerStyle={styles.cuerpo}>
          <StateView
            state="empty"
            icon="check-circle"
            title={
              escondidas
                ? f('resenaDeProducto.moderar.vaciaEscondidas')
                : f('resenaDeProducto.moderar.vacia')
            }
          />
          {cambiarDeLado}
        </ScrollView>
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
        <Text variant="caption" color="muted">
          {f('resenaDeProducto.moderar.seDeshace')}
        </Text>
        {cambiarDeLado}

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
            {estaEscondida(resena) ? (
              <Text variant="caption" color="muted">
                {f('resenaDeProducto.moderar.ocultada')}
              </Text>
            ) : null}

            {abierta === resena.id ? (
              <View style={styles.bloque}>
                <Text>{f('resenaDeProducto.moderar.motivo')}</Text>
                <Text variant="caption" color="muted">
                  {f('resenaDeProducto.moderar.motivoAyuda')}
                </Text>
                <Input
                  value={motivos[resena.id] ?? ''}
                  onChangeText={(texto) =>
                    setMotivos((antes) => ({ ...antes, [resena.id]: texto }))
                  }
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
                  onPress={() => void mover(resena.id, !estaEscondida(resena))}
                  disabled={ocupado}
                  loading={ocupado}
                />

                {/* LA RESPUESTA DEL PROVEEDOR SE MODERA APARTE, y con su propio
                    motivo: esconder la valoración y esconder lo que le
                    contestaron son dos decisiones distintas. */}
                {tieneRespuesta(resena) ? (
                  <View style={[styles.respuesta, { borderColor: colors.border }]}>
                    <Text variant="caption" color="muted">
                      {f('resenaDeProducto.lista.respuestaDelProveedor')}
                    </Text>
                    <Text>{resena.reply?.body}</Text>
                    <Input
                      value={motivosDeRespuesta[resena.reply?.id ?? ''] ?? ''}
                      onChangeText={(texto) =>
                        setMotivosDeRespuesta((antes) => ({
                          ...antes,
                          [resena.reply?.id ?? '']: texto,
                        }))
                      }
                      multiline
                      numberOfLines={2}
                      maxLength={500}
                      accessibilityLabel={f(
                        'resenaDeProducto.moderar.motivoDeLaRespuesta',
                      )}
                    />
                    <Button
                      label={f('resenaDeProducto.moderar.ocultarRespuesta')}
                      variant="secondary"
                      onPress={() =>
                        void esconderRespuesta(resena.reply?.id as string)
                      }
                      disabled={ocupado}
                    />
                  </View>
                ) : null}

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
                label={
                  estaEscondida(resena)
                    ? f('resenaDeProducto.moderar.restaurar')
                    : f('resenaDeProducto.moderar.esconder')
                }
                variant="secondary"
                onPress={() => void abrir(resena.id)}
                disabled={ocupado}
              />
            )}
          </View>
        ))}

        {hayMas ? (
          <Button
            label={f('resenaDeProducto.lista.verMas')}
            onPress={() => void verMas()}
            loading={pidiendoMas}
            disabled={pidiendoMas || ocupado}
          />
        ) : null}
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
