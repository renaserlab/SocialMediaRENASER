import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';

import { PortadaVacia } from '@/components/PortadaVacia';
import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { useTextosDeServicios } from '@/hooks/useServicios';
import { claveDeLaModalidad, nombreDeLaCategoria, precioLegible } from '@/lib/serviciosCatalogo';
import { motivoLegible, type TarjetaDeServicio as Tarjeta } from '@/lib/serviciosDescubrimiento';
import { ESCALA_AL_PULSAR } from '@/lib/movimiento';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * UNA TARJETA DE SERVICIO, igual en el catálogo, las sugerencias, la ficha
 * (otros servicios), el perfil del prestador y los guardados.
 *
 * SOLO PINTA lo que manda el servidor: sin portada, un marcador con el texto
 * alternativo; sin precio configurado, lo dice (nunca «gratis»); la zona solo
 * fuera de lo virtual; la credencial solo si Z la verificó; el motivo solo si
 * es uno conocido. NO HAY ESTRELLAS: todavía no existen reseñas verificadas.
 *
 * Guardar es opcional: sin `alGuardar`, no se pinta el marcador.
 */
export function TarjetaDeServicio({
  tarjeta,
  alAbrir,
  alGuardar,
  guardando = false,
}: {
  tarjeta: Tarjeta;
  alAbrir: () => void;
  alGuardar?: () => void;
  guardando?: boolean;
}) {
  const { colors } = useAppTheme();
  const { f, idioma } = useTextosDeServicios('descubrimiento');
  const precio = precioLegible(tarjeta.price);
  const modalidad = f(claveDeLaModalidad(tarjeta.modality));
  const donde =
    tarjeta.location_area && tarjeta.modality !== 'virtual' ? `${modalidad} · ${tarjeta.location_area}` : modalidad;
  const motivo = motivoLegible(tarjeta);
  const titulo = tarjeta.title ?? f('servicios.catalogo.sinTitulo');

  return (
    <View style={[styles.tarjeta, { borderColor: colors.border }]}>
      <Pulsable
        onPress={alAbrir}
        escala={ESCALA_AL_PULSAR.superficie}
        style={styles.cuerpo}
        accessibilityRole="button"
        accessibilityLabel={`${titulo}. ${tarjeta.provider.display_name}. ${f(precio.clave, precio.params)}`}
        accessibilityHint={f('servicios.descubrir.abrirFicha')}
      >
        {tarjeta.cover?.url ? (
          <Image
            source={{ uri: tarjeta.cover.url }}
            style={styles.portada}
            contentFit="cover"
            accessibilityLabel={tarjeta.cover.alt_text}
          />
        ) : (
          // El mismo hueco de portada que en Cursos: se ve que falta la foto
          // y de qué es la tarjeta, en vez de un recuadro vacío con borde.
          <PortadaVacia
            icono="briefcase"
            style={styles.portada}
            etiqueta={tarjeta.cover?.alt_text ?? f('servicios.descubrir.sinImagen')}
          />
        )}
        <View style={styles.textos}>
          <Text weight="700" numberOfLines={2}>
            {titulo}
          </Text>
          <Text variant="secondary" numberOfLines={1}>
            {tarjeta.provider.display_name}
          </Text>
          <Text variant="caption" color={colors.textMuted} numberOfLines={1}>
            {`${nombreDeLaCategoria(tarjeta.category, idioma)} · ${donde}`}
          </Text>
          <Text weight="600">{f(precio.clave, precio.params)}</Text>
          {tarjeta.credential_verified ? (
            <View style={styles.sello}>
              <Feather name="check-circle" size={14} color={colors.text} />
              <Text variant="caption">{f('servicios.descubrir.confianza.credencialCorta')}</Text>
            </View>
          ) : null}
          {motivo ? (
            <Text variant="caption" color={colors.textMuted}>
              {f(motivo.clave, { campos: motivo.campos.map((c) => f(c)).join(', ') })}
            </Text>
          ) : null}
        </View>
      </Pulsable>
      {alGuardar ? (
        <Pressable
          onPress={alGuardar}
          disabled={guardando}
          hitSlop={8}
          style={({ pressed }) => [styles.guardar, { opacity: pressed || guardando ? 0.5 : 1 }]}
          accessibilityRole="button"
          accessibilityState={{ selected: tarjeta.saved, disabled: guardando }}
          accessibilityLabel={
            tarjeta.saved ? f('servicios.descubrir.quitarDeGuardados') : f('servicios.descubrir.guardar')
          }
        >
          <Feather name="bookmark" size={20} color={tarjeta.saved ? colors.primary : colors.textMuted} />
          {tarjeta.saved ? (
            <Text variant="caption" color={colors.primary}>
              {f('servicios.descubrir.guardado')}
            </Text>
          ) : null}
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tarjeta: { flexDirection: 'row', borderWidth: 1, borderRadius: radius.lg, padding: spacing.sm, gap: spacing.sm },
  cuerpo: { flex: 1, flexDirection: 'row', gap: spacing.sm },
  portada: { width: 72, height: 72, borderRadius: radius.md },
  textos: { flex: 1, gap: 2 },
  sello: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  guardar: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'flex-start', paddingTop: spacing.xs },
});
