import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

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
  EJES,
  LARGO_MAXIMO_DEL_COMENTARIO,
  type BorradorDeResena,
  claveDeErrorDeResena,
  claveDelEje,
  comentarioParaEnviar,
  esResenasApagadas,
  estaEscondida,
  largoDelComentario,
  motivoParaNoEnviar,
  puedeEditar,
  tieneRespuesta,
} from '@/lib/resenasDeProductos';
import {
  ProductReviewRepository,
  type ResenaDeProducto,
} from '@/repositories/ProductReviewRepository';
import { useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Mi valoración: leerla y cambiarla.
 *
 * LA ESCONDIDA SE SIGUE VIENDO AQUÍ, y con todas sus palabras. Moderar es
 * esconder, no borrar ni reescribir: quien la escribió tiene derecho a saber
 * qué pasó con lo que escribió, y a leerlo tal cual lo dejó.
 *
 * UNA ESCONDIDA NO SE EDITA, y la pantalla lo dice en vez de ofrecer un botón
 * que el servidor va a rechazar. Reescribirla y dejarla escondida no sirve de
 * nada, y dejarla visible sería saltarse la moderación escribiendo.
 *
 * NO SE PUEDE CAMBIAR DE QUÉ COMPRA HABLA. Aquí se edita la puntuación y el
 * texto; el pedido, la línea y las dos fechas no aparecen en ningún campo.
 */
export function MiResenaDeProductoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();
  const { reviewId } = useLocalSearchParams<{ reviewId: string }>();

  const [resena, setResena] = useState<ResenaDeProducto | null>(null);
  const [editando, setEditando] = useState(false);
  const [borrador, setBorrador] = useState<BorradorDeResena | null>(null);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'sinSesion' | 'noDisponible' | 'noExiste' | null
  >(null);

  const cargar = useCallback(async () => {
    if (!reviewId) return;
    setCargando(true);
    setFallo(null);
    try {
      const fila = await ProductReviewRepository.leer(String(reviewId));
      setResena(fila);
      setBorrador({
        overall: fila.overall,
        quality: fila.quality,
        fidelity: fila.fidelity,
        functioning: fila.functioning,
        value_for_money: fila.value_for_money,
        recommends: fila.recommends,
        comment: fila.comment ?? '',
      });
    } catch (e) {
      if (e instanceof ApiError && esFaltaDeSesion(e.status)) setFallo('sinSesion');
      else if (e instanceof ApiError && esResenasApagadas(e.code))
        setFallo('noDisponible');
      /* 404 ES «NO ES TUYA» Y TAMBIÉN «NO EXISTE», a propósito: si fueran
         distintos, probar identificadores diría quién opinó sobre qué. */
      else if (e instanceof ApiError && e.status === 404) setFallo('noExiste');
      else if (e instanceof ApiError && esFalloDeRed(e.code)) setFallo('sinConexion');
      else setFallo('red');
    } finally {
      setCargando(false);
    }
  }, [reviewId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const guardar = async () => {
    if (!borrador || !reviewId || motivoParaNoEnviar(borrador) !== null) return;
    setGuardando(true);
    setError(null);
    try {
      const actualizada = await ProductReviewRepository.editar(String(reviewId), {
        overall: borrador.overall as number,
        quality: borrador.quality as number,
        fidelity: borrador.fidelity as number,
        functioning: borrador.functioning as number,
        value_for_money: borrador.value_for_money as number,
        recommends: borrador.recommends as boolean,
        comment: comentarioParaEnviar(borrador.comment),
      });
      setResena(actualizada);
      setEditando(false);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? claveDeErrorDeResena(e.code)
          : 'resenaDeProducto.error.desconocido',
      );
    } finally {
      setGuardando(false);
    }
  };

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/productos/pedidos' as never);

  const encabezado = (
    <AppHeader title={f('resenaDeProducto.mia.titulo')} onBack={volver} />
  );

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || resena === null) {
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
        ) : fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            icon="clock"
            title={f('resenaDeProducto.apagadas')}
            description={f('resenaDeProducto.apagadasCuerpo')}
          />
        ) : fallo === 'noExiste' ? (
          <StateView
            state="empty"
            icon="search"
            title={f('resenaDeProducto.error.product_review_not_found')}
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

  const escondida = estaEscondida(resena);

  return (
    <AppScreen contentStyle={styles.contenido}>
      {encabezado}
      <ScrollView contentContainerStyle={styles.cuerpo} keyboardShouldPersistTaps="handled">
        {/* LA ESCONDIDA SE DICE, y se dice entera: la fila no se tocó. */}
        {escondida ? (
          <View style={[styles.aviso, { borderColor: colors.border }]}>
            <Text variant="titleMedium">{f('resenaDeProducto.mia.escondida')}</Text>
            <Text variant="caption" color="muted">
              {f('resenaDeProducto.mia.escondidaAyuda')}
            </Text>
          </View>
        ) : null}

        {!editando ? (
          <View style={[styles.tarjeta, { borderColor: colors.border }]}>
            <EstrellasDeResena
              valor={resena.overall}
              etiqueta={f('resenaDeProducto.valorar.general')}
              sufijo={f('resenaDeProducto.deCinco')}
            />
            {EJES.map((eje) => (
              <View key={eje} style={styles.ejeFila}>
                <Text style={styles.ejeNombre}>{f(claveDelEje(eje))}</Text>
                <Text>{String(resena[eje])}</Text>
              </View>
            ))}
            <Text variant="caption" color="muted">
              {resena.recommends
                ? f('resenaDeProducto.lista.recomienda')
                : f('resenaDeProducto.lista.noRecomienda')}
            </Text>
            {resena.comment ? <Text>{resena.comment}</Text> : null}
            {tieneRespuesta(resena) ? (
              <View style={[styles.respuesta, { borderColor: colors.border }]}>
                <Text variant="caption" color="muted">
                  {f('resenaDeProducto.lista.respuestaDelProveedor')}
                </Text>
                <Text>{resena.reply?.body}</Text>
              </View>
            ) : null}
            {puedeEditar(resena) ? (
              <Button
                label={f('resenaDeProducto.mia.editar')}
                onPress={() => setEditando(true)}
              />
            ) : null}
          </View>
        ) : (
          <View style={styles.bloque}>
            <Text variant="titleMedium">{f('resenaDeProducto.valorar.general')}</Text>
            <EstrellasDeResena
              valor={borrador?.overall ?? null}
              onElegir={(n) => setBorrador((b) => (b ? { ...b, overall: n } : b))}
              etiqueta={f('resenaDeProducto.valorar.general')}
              sufijo={f('resenaDeProducto.deCinco')}
            />
            {EJES.map((eje) => (
              <View key={eje} style={styles.bloque}>
                <Text>{f(claveDelEje(eje))}</Text>
                <EstrellasDeResena
                  valor={borrador?.[eje] ?? null}
                  onElegir={(n) => setBorrador((b) => (b ? { ...b, [eje]: n } : b))}
                  etiqueta={f(claveDelEje(eje))}
                  sufijo={f('resenaDeProducto.deCinco')}
                />
              </View>
            ))}
            <Text variant="titleMedium">{f('resenaDeProducto.valorar.recomienda')}</Text>
            <View style={styles.opciones}>
              {[true, false].map((valor) => (
                <Pressable
                  key={String(valor)}
                  onPress={() =>
                    setBorrador((b) => (b ? { ...b, recommends: valor } : b))
                  }
                  accessibilityRole="radio"
                  accessibilityState={{ selected: borrador?.recommends === valor }}
                  accessibilityLabel={
                    valor
                      ? f('resenaDeProducto.valorar.si')
                      : f('resenaDeProducto.valorar.no')
                  }
                  style={[
                    styles.opcion,
                    {
                      borderColor:
                        borrador?.recommends === valor ? colors.text : colors.border,
                    },
                  ]}
                >
                  <Text>
                    {valor
                      ? f('resenaDeProducto.valorar.si')
                      : f('resenaDeProducto.valorar.no')}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Input
              value={borrador?.comment ?? ''}
              onChangeText={(texto) =>
                setBorrador((b) => (b ? { ...b, comment: texto } : b))
              }
              multiline
              numberOfLines={4}
              maxLength={LARGO_MAXIMO_DEL_COMENTARIO}
              accessibilityLabel={f('resenaDeProducto.valorar.comentario')}
            />
            <Text variant="caption" color="muted">
              {`${largoDelComentario(borrador?.comment)}/${LARGO_MAXIMO_DEL_COMENTARIO}`}
            </Text>
            {error !== null ? <InlineError message={f(error)} /> : null}
            <Button
              label={f('resenaDeProducto.valorar.guardar')}
              onPress={() => void guardar()}
              disabled={guardando || motivoParaNoEnviar(borrador) !== null}
              loading={guardando}
            />
          </View>
        )}
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
  aviso: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  ejeFila: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  ejeNombre: { flex: 1 },
  respuesta: {
    borderLeftWidth: 2,
    paddingLeft: spacing.sm,
    gap: spacing.xs,
  },
  opciones: { flexDirection: 'row', gap: spacing.sm },
  opcion: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 88,
    alignItems: 'center',
  },
});
