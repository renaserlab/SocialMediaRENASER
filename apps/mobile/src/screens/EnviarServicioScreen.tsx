import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { ContenidoDelServicio } from '@/components/ContenidoDelServicio';
import { EstadoDelCatalogo } from '@/components/EstadoDelCatalogo';
import { ListRow } from '@/components/ListRow';
import { SectionTitle } from '@/components/SectionTitle';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { nuevaClave } from '@/lib/serviciosAdmision';
import {
  claveDelRequisito,
  esReenvio,
  nombreDeLaCategoria,
  type FalloDelCatalogo,
  type ServicioPrivado,
} from '@/lib/serviciosCatalogo';
import { leerFalloDelCatalogo, useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { ServiceCatalogRepository } from '@/repositories/ServiceCatalogRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/** Qué pantalla arregla cada requisito. */
function arreglaEn(codigo: string): 'imagenes' | 'editar' | null {
  if (codigo === 'cover_image' || codigo === 'too_many_images') return 'imagenes';
  if (codigo === 'provider_not_active' || codigo === 'category_inactive') return null;
  return 'editar';
}

/**
 * «Revisar requisitos → Enviar»: cómo se verá, qué falta y el envío.
 *
 * - LO QUE FALTA SE PIDE AL SERVIDOR al llegar (`/draft/requirements`): es la
 *   autoridad, y cada cosa lleva a la pantalla que la arregla.
 * - EL BOTÓN SOLO SE ACTIVA si el servidor dice que se puede (`can_submit`) y
 *   no falta nada. Enviar congela esta versión y avisa al equipo de Z; lo
 *   publicado, si lo hay, sigue visible hasta que Z publique la nueva.
 * - La clave de idempotencia es del INTENTO.
 */
export function EnviarServicioScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('serviceId');
  const { f, idioma } = useTextosDeServicios('catalogo');
  const [servicio, setServicio] = useState<ServicioPrivado | null>(null);
  const [faltan, setFaltan] = useState<string[]>([]);
  const [fallo, setFallo] = useState<FalloDelCatalogo | null>(null);
  const clave = useRef(nuevaClave());

  const cargar = useCallback(async () => {
    setFallo(null);
    try {
      const leido = await ServiceCatalogRepository.servicio(id);
      setServicio(leido);
      setFaltan(leido.can_edit ? (await ServiceCatalogRepository.requisitos(id)).missing : []);
    } catch (error) {
      setFallo(leerFalloDelCatalogo(error));
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );
  const { ocupado, correr } = useCerrojo(cargar, 'catalogo');

  const ruta = `/servicios/prestador/catalogo/${id}`;
  const volver = () => (router.canGoBack() ? router.back() : router.replace(ruta as never));
  const titulo = f('servicios.catalogo.revisarYEnviar');

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
          title={f('servicios.catalogo.enviar.nadaQueEnviar')}
          description={f('servicios.catalogo.enviar.nadaQueEnviarCuerpo')}
          actionLabel={f('servicios.catalogo.servicio')}
          onAction={() => router.replace(ruta as never)}
        />
      </AppScreen>
    );
  }

  const version = servicio.open_version;
  const reenvio = esReenvio(servicio);
  const puede = servicio.can_submit && faltan.length === 0;

  const enviar = () =>
    void correr(async () => {
      const si = await confirm({
        title: f(reenvio ? 'servicios.catalogo.enviar.reenviarTitulo' : 'servicios.catalogo.enviar.enviarTitulo'),
        message: f(
          servicio.published_version
            ? 'servicios.catalogo.enviar.avisoConPublicada'
            : 'servicios.catalogo.enviar.aviso',
        ),
        confirmLabel: f(reenvio ? 'servicios.catalogo.enviar.reenviar' : 'servicios.catalogo.enviar.enviar'),
      });
      if (!si) return;
      await ServiceCatalogRepository.enviar(servicio.id, clave.current);
      clave.current = nuevaClave();
      toast(f(reenvio ? 'servicios.catalogo.enviar.reenviado' : 'servicios.catalogo.enviar.enviado'));
      router.replace(ruta as never);
    });

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />

      {faltan.length > 0 ? (
        <View style={[styles.tarjeta, { borderColor: colors.danger }]}>
          <Text weight="700">{f('servicios.catalogo.faltan')}</Text>
          {faltan.map((codigo) => {
            const donde = arreglaEn(codigo);
            return donde ? (
              <ListRow
                key={codigo}
                title={f(claveDelRequisito(codigo))}
                rightIcon="chevron-right"
                onPress={() => router.push(`${ruta}/${donde}` as never)}
              />
            ) : (
              <Text key={codigo} variant="secondary">
                {`• ${f(claveDelRequisito(codigo))}`}
              </Text>
            );
          })}
        </View>
      ) : (
        <View style={[styles.tarjeta, { borderColor: colors.primary }]}>
          <Text weight="700">{f('servicios.catalogo.enviar.listo')}</Text>
          <Text variant="secondary">{f('servicios.catalogo.enviar.queRevisaZ')}</Text>
        </View>
      )}

      <SectionTitle title={f('servicios.catalogo.enviar.asiSeVera')} />
      <ContenidoDelServicio
        contenido={version}
        categoria={nombreDeLaCategoria(servicio.category, idioma)}
        imagenes={version.images}
      />

      <Button
        label={f(reenvio ? 'servicios.catalogo.enviar.reenviar' : 'servicios.catalogo.enviar.enviar')}
        icon="send"
        loading={ocupado}
        disabled={!puede || ocupado}
        onPress={enviar}
      />
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.catalogo.enviar.congela')}
      </Text>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  tarjeta: { gap: spacing.xs, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
});
