import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { ResenasDelServicio, SenalesDeConfianza } from '@/components/ConfianzaEnServicios';
import { EstadoDelCatalogo } from '@/components/EstadoDelCatalogo';
import { StateView } from '@/components/StateView';
import { TarjetaDeServicio } from '@/components/TarjetaDeServicio';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { claveDeLaModalidad, nombreDeLaCategoria, type FalloDelCatalogo } from '@/lib/serviciosCatalogo';
import {
  claveDelTipoDePrestador,
  juntarSinRepetir,
  type PerfilDePrestador,
  type TarjetaDeServicio as Tarjeta,
} from '@/lib/serviciosDescubrimiento';
import { leerFalloDelCatalogo, useTextosDeServicios } from '@/hooks/useServicios';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { ServiceDiscoveryRepository } from '@/repositories/ServiceDiscoveryRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * El perfil PÚBLICO de un prestador: solo lo autorizado.
 *
 * Su nombre público y su tipo, lo que Z comprobó (con las mismas palabras
 * exactas de la ficha), en qué categorías, modalidades y zonas generales
 * presta, sus reseñas (todavía ninguna) y sus servicios publicados.
 *
 * NUNCA su nombre legal, documentos, número de credencial, contacto ni su
 * perfil social: el servidor no los manda. Un prestador sin nada publicado, o
 * suspendido, es el mismo «no lo encontramos».
 */
export function PrestadorPublicoScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('providerId');
  const { f, textoDelError, idioma } = useTextosDeServicios('descubrimiento');
  const [perfil, setPerfil] = useState<PerfilDePrestador | null>(null);
  const [servicios, setServicios] = useState<Tarjeta[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [fallo, setFallo] = useState<FalloDelCatalogo | null>(null);
  const [masCargando, setMasCargando] = useState(false);
  const pedido = useRef(0);

  const cargar = useCallback(async () => {
    const este = ++pedido.current;
    setFallo(null);
    try {
      const [datos, pagina] = await Promise.all([
        ServiceDiscoveryRepository.prestador(id),
        ServiceDiscoveryRepository.serviciosDelPrestador(id, null),
      ]);
      if (este !== pedido.current) return;
      setPerfil(datos);
      setServicios(pagina.items);
      setCursor(pagina.next_cursor);
    } catch (error) {
      if (este === pedido.current) setFallo(leerFalloDelCatalogo(error));
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  const verMas = async () => {
    if (!cursor || masCargando) return;
    setMasCargando(true);
    try {
      const pagina = await ServiceDiscoveryRepository.serviciosDelPrestador(id, cursor);
      setServicios((actuales) => juntarSinRepetir(actuales, pagina.items));
      setCursor(pagina.next_cursor);
    } catch (error) {
      notify(f('servicios.noSePudo'), textoDelError(error));
    } finally {
      setMasCargando(false);
    }
  };

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/servicios' as never));

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('servicios.descubrir.perfil.titulo')} onBack={volver} />
      {fallo === 'noEncontrada' ? (
        <StateView
          state="empty"
          icon="user-x"
          title={f('servicios.descubrir.error.prestadorNoEncontrado')}
          description={f('servicios.descubrir.perfil.noEncontradoCuerpo')}
        />
      ) : fallo !== null ? (
        <EstadoDelCatalogo fallo={fallo} onRetry={() => void cargar()} />
      ) : perfil === null ? (
        <StateView state="loading" />
      ) : (
        <>
          <View style={styles.bloque}>
            <Text variant="title" accessibilityRole="header">
              {perfil.display_name}
            </Text>
            <Text variant="secondary">{f(claveDelTipoDePrestador(perfil.provider_type))}</Text>
          </View>
          <SenalesDeConfianza confianza={perfil.trust} />

          {perfil.categories.length > 0 ? (
            <View style={styles.bloque}>
              <Text weight="700">{f('servicios.descubrir.perfil.categorias')}</Text>
              <View style={styles.chips}>
                {perfil.categories.map((c) => (
                  <Chip
                    key={c.id}
                    label={nombreDeLaCategoria(c, idioma)}
                    onPress={() => router.push({ pathname: '/servicios', params: { categoria: c.id } } as never)}
                  />
                ))}
              </View>
            </View>
          ) : null}
          <View style={styles.bloque}>
            <Text weight="700">{f('servicios.descubrir.perfil.comoPresta')}</Text>
            <Text variant="secondary">
              {perfil.modalities.length > 0
                ? perfil.modalities.map((m) => f(claveDeLaModalidad(m))).join(' · ')
                : f('servicios.descubrir.perfil.sinDato')}
            </Text>
            {perfil.areas.length > 0 ? (
              <Text variant="secondary">{f('servicios.descubrir.perfil.zonas', { zonas: perfil.areas.join(' · ') })}</Text>
            ) : null}
          </View>

          <ResenasDelServicio resenas={perfil.reviews} delPrestador />

          <View style={styles.bloque}>
            <Text weight="700" accessibilityRole="header">
              {f('servicios.descubrir.perfil.servicios')}
            </Text>
            {servicios.length === 0 ? (
              <Text variant="secondary">{f('servicios.descubrir.vacio')}</Text>
            ) : (
              servicios.map((t) => (
                <TarjetaDeServicio key={t.id} tarjeta={t} alAbrir={() => router.push(`/servicios/ficha/${t.id}` as never)} />
              ))
            )}
            {cursor ? (
              <Button
                label={f('servicios.admin.verMas')}
                variant="secondary"
                loading={masCargando}
                disabled={masCargando}
                onPress={() => void verMas()}
              />
            ) : null}
          </View>
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.descubrir.perfil.soloAutorizado')}
          </Text>
        </>
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  bloque: { gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
});
