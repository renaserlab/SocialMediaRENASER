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
  LARGO_MAXIMO_DE_LA_RESPUESTA,
  claveDeErrorDeResena,
  compraVerificada,
  cursorDeLaPagina,
  esResenasApagadas,
  fusionarPaginas,
  hayMasPaginas,
  puedeOfrecerResponder,
  respuestaParaEnviar,
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
 * Lo que opinan de mi tienda, y la respuesta pública.
 *
 * RESPONDER ES LO ÚNICO QUE SE PUEDE HACER AQUÍ. No hay botón de ocultar, ni de
 * editar, ni de borrar: no existen esas rutas en el servidor, y la pantalla lo
 * dice con palabras en vez de dejar a nadie buscándolas.
 *
 * UNA RESPUESTA POR VALORACIÓN. Varias sobre la misma serían una forma de
 * insistirle a quien opinó, y lo impide además un índice de la base.
 *
 * A UNA ESCONDIDA NO SE LE OFRECE RESPONDER: la respuesta quedaría colgando de
 * algo que no se ve. Aquí ni siquiera aparecen, porque el servidor solo manda
 * las visibles.
 */
export function ResenasDeMiTiendaScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();

  const [resenas, setResenas] = useState<ResenaDeProducto[]>([]);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [texto, setTexto] = useState('');
  const [cargando, setCargando] = useState(true);
  const [hayMas, setHayMas] = useState(false);
  const [pidiendoMas, setPidiendoMas] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'sinSesion' | 'noDisponible' | 'sinTienda' | null
  >(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      const filas = await ProductReviewRepository.deMiTienda();
      setResenas(filas);
      setHayMas(hayMasPaginas(filas.length));
    } catch (e) {
      if (e instanceof ApiError && esFaltaDeSesion(e.status)) setFallo('sinSesion');
      else if (e instanceof ApiError && esResenasApagadas(e.code))
        setFallo('noDisponible');
      /* 404 AQUÍ ES «NO ERES RESPONSABLE COMERCIAL», no «no hay opiniones»: el
         servidor contesta lo mismo a quien no tiene tienda que a quien pide la
         de otro. Una lista vacía es otra cosa y se pinta distinto. */
      else if (e instanceof ApiError && e.status === 404) setFallo('sinTienda');
      else if (e instanceof ApiError && esFalloDeRed(e.code)) setFallo('sinConexion');
      else setFallo('red');
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const verMas = async () => {
    const cursor = cursorDeLaPagina(resenas);
    if (!cursor) return;
    setPidiendoMas(true);
    try {
      const siguiente = await ProductReviewRepository.deMiTienda({
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

  const responder = async (reviewId: string) => {
    const limpio = respuestaParaEnviar(texto);
    if (limpio === null) return;
    setEnviando(true);
    setError(null);
    try {
      const actualizada = await ProductReviewRepository.responder(reviewId, limpio);
      setResenas((antes) =>
        antes.map((r) => (r.id === reviewId ? actualizada : r)),
      );
      setAbierta(null);
      setTexto('');
    } catch (e) {
      setError(
        e instanceof ApiError
          ? claveDeErrorDeResena(e.code)
          : 'resenaDeProducto.error.desconocido',
      );
    } finally {
      setEnviando(false);
    }
  };

  const volver = () =>
    router.canGoBack()
      ? router.back()
      : router.replace('/proveedor/productos' as never);

  const encabezado = (
    <AppHeader title={f('resenaDeProducto.tienda.titulo')} onBack={volver} />
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
        ) : fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            icon="clock"
            title={f('resenaDeProducto.apagadas')}
            description={f('resenaDeProducto.apagadasCuerpo')}
          />
        ) : fallo === 'sinTienda' ? (
          <StateView
            state="empty"
            icon="shopping-bag"
            title={f('envio.proveedor.sinTienda')}
            description={f('envio.proveedor.sinTiendaCuerpo')}
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
          icon="star"
          title={f('resenaDeProducto.tienda.vacia')}
        />
      </AppScreen>
    );
  }

  return (
    <AppScreen contentStyle={styles.contenido}>
      {encabezado}
      <ScrollView contentContainerStyle={styles.cuerpo} keyboardShouldPersistTaps="handled">
        <Text variant="caption" color="muted">
          {f('resenaDeProducto.tienda.noSePuedeTocar')}
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
                  {f('resenaDeProducto.tienda.respuesta')}
                </Text>
                <Text>{resena.reply?.body}</Text>
              </View>
            ) : null}

            {puedeOfrecerResponder(resena) ? (
              abierta === resena.id ? (
                <View style={styles.bloque}>
                  <Text variant="caption" color="muted">
                    {f('resenaDeProducto.tienda.respuestaAyuda')}
                  </Text>
                  <Input
                    value={texto}
                    onChangeText={setTexto}
                    multiline
                    numberOfLines={3}
                    maxLength={LARGO_MAXIMO_DE_LA_RESPUESTA}
                    accessibilityLabel={f('resenaDeProducto.tienda.respuesta')}
                  />
                  {error !== null ? <InlineError message={f(error)} /> : null}
                  <Button
                    label={f('resenaDeProducto.tienda.publicar')}
                    onPress={() => void responder(resena.id)}
                    disabled={enviando || respuestaParaEnviar(texto) === null}
                    loading={enviando}
                  />
                </View>
              ) : (
                <Button
                  label={f('resenaDeProducto.tienda.responder')}
                  onPress={() => {
                    setAbierta(resena.id);
                    setTexto('');
                    setError(null);
                  }}
                />
              )
            ) : tieneRespuesta(resena) ? (
              <Text variant="caption" color="muted">
                {f('resenaDeProducto.tienda.yaRespondida')}
              </Text>
            ) : null}
          </View>
        ))}

        {hayMas ? (
          <Button
            label={f('resenaDeProducto.lista.verMas')}
            onPress={() => void verMas()}
            loading={pidiendoMas}
            disabled={pidiendoMas || enviando}
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
