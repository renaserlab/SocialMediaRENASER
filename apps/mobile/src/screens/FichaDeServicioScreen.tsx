import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { ContenidoDelServicio } from '@/components/ContenidoDelServicio';
import { ResenasDelServicio, SenalesDeConfianza } from '@/components/ConfianzaEnServicios';
import { EstadoDelCatalogo } from '@/components/EstadoDelCatalogo';
import { StateView } from '@/components/StateView';
import { TarjetaDeServicio } from '@/components/TarjetaDeServicio';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { fechaCorta } from '@/lib/serviciosAdmision';
import { nombreDeLaCategoria, type FalloDelCatalogo } from '@/lib/serviciosCatalogo';
import { claveDelTipoDePrestador, type FichaPublica } from '@/lib/serviciosDescubrimiento';
import { leerFalloDelCatalogo, useTextosDeServicios } from '@/hooks/useServicios';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { ServiceCatalogRepository } from '@/repositories/ServiceCatalogRepository';
import { ServiceDiscoveryRepository } from '@/repositories/ServiceDiscoveryRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * La ficha PÚBLICA de un servicio: solo lo publicado, de un prestador activo,
 * en una categoría activa.
 *
 * Lo que no está publicado (borrador, suspendido, retirado) o no existe es el
 * mismo «no lo encontramos»: la ficha no revela que hubo algo.
 *
 * EL ORDEN ES EL DEL BLUEPRINT (S06), sin lo que todavía no existe: contenido
 * (galería, nombre, modalidad y zona, precio, para quién, qué incluye y qué
 * no, duración, requisitos), quien lo ofrece con lo que Z comprobó, el sello
 * de servicio aprobado por Z, las reseñas (todavía ninguna) y otros servicios
 * con su razón.
 *
 * NO HAY BOTÓN DE CONTRATAR: la reserva y el pago no existen todavía. Guardar
 * no reserva nada.
 */
export function FichaDeServicioScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('serviceId');
  const { f, textoDelError, idioma } = useTextosDeServicios('descubrimiento');
  const [ficha, setFicha] = useState<FichaPublica | null>(null);
  const [fallo, setFallo] = useState<FalloDelCatalogo | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    setFallo(null);
    try {
      setFicha(await ServiceCatalogRepository.ficha(id));
    } catch (error) {
      setFallo(leerFalloDelCatalogo(error));
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  const alternarGuardado = async () => {
    if (!ficha || guardando) return;
    setGuardando(true);
    try {
      const r = ficha.saved
        ? await ServiceDiscoveryRepository.quitar(ficha.id)
        : await ServiceDiscoveryRepository.guardar(ficha.id);
      setFicha({ ...ficha, saved: r.saved });
    } catch (error) {
      notify(f('servicios.noSePudo'), textoDelError(error));
    } finally {
      setGuardando(false);
    }
  };

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/servicios' as never));
  const abrir = (servicio: string) => router.push(`/servicios/ficha/${servicio}` as never);
  const abrirPrestador = () =>
    ficha && router.push(`/servicios/prestadores/${ficha.provider.id}` as never);

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('servicios.catalogo.ficha.titulo')} onBack={volver} />
      {fallo !== null ? (
        <EstadoDelCatalogo fallo={fallo} onRetry={() => void cargar()} />
      ) : ficha === null ? (
        <StateView state="loading" />
      ) : (
        <>
          <ContenidoDelServicio
            contenido={ficha}
            categoria={nombreDeLaCategoria(ficha.category, idioma)}
            imagenes={ficha.images}
          />

          <Button
            label={ficha.saved ? f('servicios.descubrir.quitarDeGuardados') : f('servicios.descubrir.guardar')}
            icon="bookmark"
            variant={ficha.saved ? 'secondary' : 'primary'}
            loading={guardando}
            disabled={guardando}
            onPress={() => void alternarGuardado()}
          />
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.descubrir.guardarAviso')}
          </Text>

          <Pressable
            onPress={abrirPrestador}
            style={({ pressed }) => [styles.prestador, { borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}
            accessibilityRole="button"
            accessibilityLabel={f('servicios.descubrir.verPrestador', { nombre: ficha.provider.display_name })}
          >
            <View style={styles.flexible}>
              <Text variant="caption" color={colors.textMuted}>
                {f('servicios.descubrir.loOfrece')}
              </Text>
              <Text weight="700">{ficha.provider.display_name}</Text>
              <Text variant="caption" color={colors.textMuted}>
                {f(claveDelTipoDePrestador(ficha.provider.provider_type))}
              </Text>
            </View>
            <Feather name="chevron-right" size={20} color={colors.textMuted} />
          </Pressable>
          <SenalesDeConfianza confianza={ficha.provider.trust} />

          {ficha.approved_by_z ? (
            <View style={styles.sello}>
              <Feather name="award" size={16} color={colors.text} />
              <Text variant="secondary" style={styles.flexible}>
                {f('servicios.descubrir.aprobadoPorZ', { fecha: fechaCorta(ficha.published_at) })}
              </Text>
            </View>
          ) : null}
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.descubrir.declarado')}
          </Text>

          <ResenasDelServicio resenas={ficha.reviews} />

          {ficha.more_from_provider.length > 0 ? (
            <View style={styles.bloque}>
              <Text weight="700" accessibilityRole="header">
                {f('servicios.descubrir.seccion.same_provider')}
              </Text>
              {ficha.more_from_provider.map((t) => (
                <TarjetaDeServicio key={t.id} tarjeta={t} alAbrir={() => abrir(t.id)} />
              ))}
            </View>
          ) : null}
          {ficha.related.length > 0 ? (
            <View style={styles.bloque}>
              <Text weight="700" accessibilityRole="header">
                {f('servicios.descubrir.seccion.same_category')}
              </Text>
              {ficha.related.map((t) => (
                <TarjetaDeServicio key={t.id} tarjeta={t} alAbrir={() => abrir(t.id)} />
              ))}
            </View>
          ) : null}
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.descubrir.soloDescubrir')}
          </Text>
        </>
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  prestador: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    minHeight: 44,
  },
  flexible: { flex: 1 },
  sello: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  bloque: { gap: spacing.sm },
});
