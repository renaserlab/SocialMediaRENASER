import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { useTextosDeServicios } from '@/hooks/useServicios';
import {
  duracionLegible,
  claveDeLaModalidad,
  enOrden,
  portada,
  precioLegible,
  type Contenido,
  type ImagenPublica,
} from '@/lib/serviciosCatalogo';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type ImagenQueSePinta = ImagenPublica & { id?: string; position?: number };

/**
 * El contenido de UNA versión de un servicio, pintado igual en los tres sitios
 * donde se lee: la ficha pública, la revisión previa de quien lo ofrece y la
 * propuesta que revisa el equipo de Z.
 *
 * SOLO PINTA: no carga, no decide y no sabe de estados. `resaltar` son los
 * campos que cambian respecto de lo publicado (los manda el servidor) y se
 * marcan para que la revisión mire eso primero.
 *
 * UNA IMAGEN SIN URL NO ES UN FALLO: el almacenamiento no la firmó a tiempo, y
 * se enseña su texto alternativo, que para eso es obligatorio.
 */
export function ContenidoDelServicio({
  contenido,
  categoria,
  imagenes,
  resaltar = [],
}: {
  contenido: Contenido;
  categoria: string | null;
  imagenes: ImagenQueSePinta[];
  resaltar?: string[];
}) {
  const { colors } = useAppTheme();
  const { f } = useTextosDeServicios('catalogo');
  const ordenadas = imagenes.every((i) => typeof i.position === 'number')
    ? enOrden(imagenes as (ImagenQueSePinta & { position: number })[])
    : imagenes;
  const principal = portada(ordenadas);
  const resto = ordenadas.filter((i) => i !== principal);
  const precio = precioLegible(contenido.price);
  const duracion = duracionLegible(contenido.duration_minutes);
  const marca = (campo: string) =>
    resaltar.includes(campo) ? [styles.resaltado, { borderLeftColor: colors.primary }] : null;
  const etiqueta = (clave: string, campo: string) =>
    resaltar.includes(campo) ? `${f(clave)} · ${f('servicios.catalogo.admin.cambia')}` : f(clave);

  const pintarImagen = (imagen: ImagenQueSePinta, grande: boolean, indice: number) =>
    imagen.url ? (
      <Image
        key={imagen.id ?? `i${indice}`}
        source={{ uri: imagen.url }}
        style={grande ? styles.portada : styles.miniatura}
        contentFit="cover"
        accessibilityLabel={imagen.alt_text}
      />
    ) : (
      <View
        key={imagen.id ?? `i${indice}`}
        style={[grande ? styles.portada : styles.miniatura, styles.marcador, { borderColor: colors.border }]}
        accessible
        accessibilityLabel={imagen.alt_text}
      >
        <Feather name="image" size={20} color={colors.textMuted} />
        {grande ? (
          <Text variant="caption" color={colors.textMuted}>
            {imagen.alt_text}
          </Text>
        ) : null}
      </View>
    );

  const bloque = (clave: string, campo: string, texto: string | null) =>
    texto ? (
      <View style={[styles.bloque, marca(campo)]}>
        <Text weight="700">{etiqueta(clave, campo)}</Text>
        <Text variant="secondary">{texto}</Text>
      </View>
    ) : null;

  const lista = (clave: string, campo: string, frases: string[]) =>
    frases.length > 0 ? (
      <View style={[styles.bloque, marca(campo)]}>
        <Text weight="700">{etiqueta(clave, campo)}</Text>
        {frases.map((frase, i) => (
          <Text key={`${campo}${i}`} variant="secondary">
            {`• ${frase}`}
          </Text>
        ))}
      </View>
    ) : null;

  return (
    <View style={styles.contenedor}>
      <View style={marca('images')}>
        {principal ? pintarImagen(principal, true, 0) : null}
        {resto.length > 0 ? (
          <View style={styles.miniaturas}>{resto.map((i, n) => pintarImagen(i, false, n + 1))}</View>
        ) : null}
      </View>

      <View style={[styles.bloque, marca('title')]}>
        <Text variant="title">{contenido.title ?? f('servicios.catalogo.sinTitulo')}</Text>
      </View>
      {categoria ? (
        <View style={marca('category')}>
          <Text variant="caption" color={colors.textMuted}>
            {categoria}
          </Text>
        </View>
      ) : null}
      {contenido.summary ? (
        <View style={marca('summary')}>
          <Text variant="secondary">{contenido.summary}</Text>
        </View>
      ) : null}

      <View style={[styles.tarjeta, { borderColor: colors.border }]}>
        <View style={[styles.linea, marca('price')]}>
          <Feather name="tag" size={16} color={colors.textMuted} />
          <Text weight="700">{f(precio.clave, precio.params)}</Text>
        </View>
        <View style={[styles.linea, marca('modality') ?? marca('location_area')]}>
          <Feather name="map-pin" size={16} color={colors.textMuted} />
          <Text variant="secondary">
            {contenido.location_area && contenido.modality !== 'virtual'
              ? `${f(claveDeLaModalidad(contenido.modality))} · ${contenido.location_area}`
              : f(claveDeLaModalidad(contenido.modality))}
          </Text>
        </View>
        <View style={[styles.linea, marca('duration')]}>
          <Feather name="clock" size={16} color={colors.textMuted} />
          <Text variant="secondary">{f(duracion.clave, duracion.params)}</Text>
        </View>
        {contenido.capacity ? (
          <View style={[styles.linea, marca('capacity')]}>
            <Feather name="users" size={16} color={colors.textMuted} />
            <Text variant="secondary">{f('servicios.catalogo.capacidad', { n: contenido.capacity })}</Text>
          </View>
        ) : null}
      </View>

      {bloque('servicios.catalogo.campo.description', 'description', contenido.description)}
      {bloque('servicios.catalogo.campo.scope', 'scope', contenido.scope)}
      {lista('servicios.catalogo.campo.includes', 'includes', contenido.includes)}
      {lista('servicios.catalogo.campo.excludes', 'excludes', contenido.excludes)}
      {bloque('servicios.catalogo.campo.requirements', 'requirements', contenido.requirements)}
      {bloque('servicios.catalogo.campo.conditions', 'conditions', contenido.conditions)}
    </View>
  );
}

const styles = StyleSheet.create({
  contenedor: { gap: spacing.md },
  bloque: { gap: spacing.xs },
  tarjeta: { gap: spacing.sm, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
  linea: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  portada: { width: '100%', aspectRatio: 16 / 9, borderRadius: radius.lg },
  miniaturas: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  miniatura: { width: 72, height: 72, borderRadius: radius.md },
  marcador: { borderWidth: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.xs, padding: spacing.sm },
  resaltado: { borderLeftWidth: 3, paddingLeft: spacing.sm },
});
