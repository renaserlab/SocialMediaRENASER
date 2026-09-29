import React, { useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { EstadoDelCatalogo } from '@/components/EstadoDelCatalogo';
import { Input } from '@/components/Input';
import { ListRow } from '@/components/ListRow';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { PermisoNegado, elegirEnNativo, elegirEnWeb, type ImagenElegida } from '@/lib/elegirImagen';
import { nuevaClave } from '@/lib/serviciosAdmision';
import {
  LARGOS,
  enOrden,
  moverImagen,
  porQueNoSeSube,
  revisarAlternativo,
  type Imagen,
} from '@/lib/serviciosCatalogo';
import { useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { useParametroDeRuta, useServicioPropio } from '@/hooks/useCatalogoDeServicios';
import { ServiceCatalogRepository } from '@/repositories/ServiceCatalogRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * «Agregar imágenes»: las del BORRADOR.
 *
 * - EL TEXTO ALTERNATIVO SE PIDE ANTES de elegir el archivo: describe la
 *   imagen para quien no la ve, y el servidor no acepta una sin él.
 * - EL ARCHIVO VA A LA API, que abre la imagen, mira sus bytes y pone la ruta.
 *   Aquí solo se mira lo barato (tipo y peso) para no gastar una subida.
 * - LA PRIMERA ES LA PORTADA; se cambia con «Usar como portada». El orden se
 *   manda COMPLETO.
 * - QUITAR PREGUNTA ANTES. Si la imagen también está en lo publicado, lo
 *   publicado la conserva: el servidor no borra un archivo en uso.
 * - Cada subida lleva su clave: un reintento tras perder la conexión no sube
 *   dos veces la misma imagen.
 */
export function ImagenesDelServicioScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('serviceId');
  const { f } = useTextosDeServicios('catalogo');
  const { servicio, setServicio, fallo, cargar } = useServicioPropio(id);
  const { ocupado, correr } = useCerrojo(cargar, 'catalogo');
  const [alternativo, setAlternativo] = useState('');
  const [errorDeSubida, setErrorDeSubida] = useState<string | null>(null);
  const clave = useRef<string | null>(null);

  const ruta = `/servicios/prestador/catalogo/${id}`;
  const volver = () => (router.canGoBack() ? router.back() : router.replace(ruta as never));
  const titulo = f('servicios.catalogo.paso.imagenes');

  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <EstadoDelCatalogo fallo={fallo} onRetry={() => void cargar()} />
      </AppScreen>
    );
  }
  if (servicio === null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }
  if (!servicio.can_edit || !servicio.open_version) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView
          state="empty"
          icon="lock"
          title={f('servicios.catalogo.editar.noEditable')}
          description={f('servicios.catalogo.editar.noEditableCuerpo')}
          actionLabel={f('servicios.catalogo.servicio')}
          onAction={() => router.replace(ruta as never)}
        />
      </AppScreen>
    );
  }

  const imagenes = enOrden(servicio.open_version.images);

  const subir = () => {
    const problema = revisarAlternativo(alternativo);
    setErrorDeSubida(problema);
    if (problema) return;
    void correr(async () => {
      let elegida: ImagenElegida | null;
      try {
        elegida = Platform.OS === 'web' ? await elegirEnWeb() : await elegirEnNativo();
      } catch (error) {
        if (error instanceof PermisoNegado) {
          notify(f('servicios.noSePudo'), f('servicios.catalogo.imagenes.permisoNegado'));
          return;
        }
        throw error;
      }
      if (elegida === null) return;
      const motivo = porQueNoSeSube({ tipo: elegida.tipo, bytes: elegida.bytes });
      if (motivo) {
        setErrorDeSubida(motivo);
        return;
      }
      if (clave.current === null) clave.current = nuevaClave();
      setServicio(
        await ServiceCatalogRepository.subirImagen(servicio.id, {
          archivo: elegida.archivo,
          nombre: elegida.nombre,
          alternativo: alternativo.trim(),
          clave: clave.current,
        }),
      );
      clave.current = null;
      setAlternativo('');
      toast(f('servicios.catalogo.imagenes.subida'));
    });
  };

  const mover = (imagen: Imagen, paso: 1 | -1) =>
    void correr(async () => {
      setServicio(await ServiceCatalogRepository.ordenarImagenes(servicio.id, moverImagen(imagenes, imagen.id, paso), null));
    });

  const hacerPortada = (imagen: Imagen) =>
    void correr(async () => {
      setServicio(
        await ServiceCatalogRepository.ordenarImagenes(
          servicio.id,
          imagenes.map((i) => i.id),
          imagen.id,
        ),
      );
      toast(f('servicios.catalogo.imagenes.portadaCambiada'));
    });

  const quitar = (imagen: Imagen) =>
    void correr(async () => {
      const si = await confirm({
        title: f('servicios.catalogo.imagenes.quitarTitulo'),
        message: f('servicios.catalogo.imagenes.quitarAviso'),
        confirmLabel: f('servicios.catalogo.imagenes.quitar'),
        destructive: true,
      });
      if (!si) return;
      setServicio(await ServiceCatalogRepository.quitarImagen(servicio.id, imagen.id));
      toast(f('servicios.catalogo.imagenes.quitada'));
    });

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />
      <Text variant="secondary">{f('servicios.catalogo.imagenes.intro')}</Text>

      <View style={[styles.tarjeta, { borderColor: colors.border }]}>
        <Text weight="700">{f('servicios.catalogo.imagenes.agregar')}</Text>
        <Input
          label={f('servicios.catalogo.imagenes.alternativo')}
          value={alternativo}
          onChangeText={(texto) => {
            setAlternativo(texto);
            if (errorDeSubida) setErrorDeSubida(null);
          }}
          maxLength={LARGOS.alternativo[1]}
          multiline
          placeholder={f('servicios.catalogo.imagenes.alternativoAyuda')}
          error={errorDeSubida ? f(errorDeSubida) : undefined}
          disabled={ocupado}
        />
        <Text variant="caption" color={colors.textMuted}>
          {f('servicios.catalogo.imagenes.formatos')}
        </Text>
        <Button
          label={f('servicios.catalogo.imagenes.elegir')}
          icon="upload"
          loading={ocupado}
          disabled={ocupado}
          onPress={subir}
        />
      </View>

      {imagenes.length === 0 ? (
        <StateView
          state="empty"
          icon="image"
          title={f('servicios.catalogo.imagenes.ninguna')}
          description={f('servicios.catalogo.imagenes.ningunaCuerpo')}
        />
      ) : (
        imagenes.map((imagen, indice) => (
          <View key={imagen.id} style={[styles.tarjeta, { borderColor: imagen.is_cover ? colors.primary : colors.border }]}>
            {imagen.url ? (
              <Image
                source={{ uri: imagen.url }}
                style={styles.imagen}
                contentFit="cover"
                accessibilityLabel={imagen.alt_text}
              />
            ) : (
              <View style={[styles.imagen, styles.marcador, { borderColor: colors.border }]}>
                <Feather name="image" size={24} color={colors.textMuted} />
              </View>
            )}
            <Text weight="600">
              {imagen.is_cover
                ? `${f('servicios.catalogo.imagenes.portada')} · ${f('servicios.catalogo.imagenes.posicion', { n: indice + 1, total: imagenes.length })}`
                : f('servicios.catalogo.imagenes.posicion', { n: indice + 1, total: imagenes.length })}
            </Text>
            <Text variant="secondary">{imagen.alt_text}</Text>
            <View style={styles.acciones}>
              <Button
                label={f('servicios.catalogo.imagenes.subirOrden')}
                variant="ghost"
                icon="arrow-up"
                disabled={ocupado || indice === 0}
                onPress={() => mover(imagen, -1)}
              />
              <Button
                label={f('servicios.catalogo.imagenes.bajarOrden')}
                variant="ghost"
                icon="arrow-down"
                disabled={ocupado || indice === imagenes.length - 1}
                onPress={() => mover(imagen, 1)}
              />
              {!imagen.is_cover ? (
                <Button
                  label={f('servicios.catalogo.imagenes.usarComoPortada')}
                  variant="ghost"
                  icon="star"
                  disabled={ocupado}
                  onPress={() => hacerPortada(imagen)}
                />
              ) : null}
              <Button
                label={f('servicios.catalogo.imagenes.quitar')}
                variant="ghost"
                icon="trash-2"
                disabled={ocupado}
                onPress={() => quitar(imagen)}
              />
            </View>
          </View>
        ))
      )}

      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.catalogo.imagenes.privadas')}
      </Text>
      <ListRow
        title={f('servicios.catalogo.revisarYEnviar')}
        leftIcon="send"
        rightIcon="chevron-right"
        onPress={() => router.push(`${ruta}/enviar` as never)}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  tarjeta: { gap: spacing.sm, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
  imagen: { width: '100%', aspectRatio: 16 / 9, borderRadius: radius.md },
  marcador: { borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  acciones: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
});
