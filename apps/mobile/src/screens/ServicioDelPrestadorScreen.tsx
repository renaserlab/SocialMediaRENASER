import React, { useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { EstadoDelCatalogo } from '@/components/EstadoDelCatalogo';
import { ListRow } from '@/components/ListRow';
import { SectionTitle } from '@/components/SectionTitle';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { fechaCorta, nuevaClave } from '@/lib/serviciosAdmision';
import {
  claveDelCampo,
  claveDelCuerpoDelEstado,
  claveDelEstadoDeLaVersion,
  claveDelEstadoDelServicio,
  claveDelRequisito,
  claveDelSuceso,
  esReenvio,
  estaEnManosDeZ,
  nombreDeLaCategoria,
  versionQueSeEnsena,
} from '@/lib/serviciosCatalogo';
import { useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { useParametroDeRuta, useServicioPropio } from '@/hooks/useCatalogoDeServicios';
import { ServiceCatalogRepository } from '@/repositories/ServiceCatalogRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Un servicio propio: dónde está, qué dijo Z y qué se puede hacer ahora.
 *
 * TODO LO QUE SE OFRECE LO DICE EL SERVIDOR (`can_edit`, `can_submit`,
 * `can_withdraw`, `can_open_draft`, `publicly_visible`):
 *
 *  - CON BORRADOR: completar la información, las imágenes y revisar y enviar.
 *  - EN MANOS DE Z (enviado, en revisión, aprobado): esperar, o retirarlo.
 *  - SIN VERSIÓN ABIERTA: editar abre un borrador nuevo que sale de la última
 *    versión; lo publicado sigue visible mientras tanto. Si Z pidió cambios,
 *    el botón lo dice: «Corregir y reenviar».
 *
 * Lo que Z dijo con motivo visible se enseña arriba, con los campos que
 * señaló. Nunca una nota interna: el servidor no la manda.
 */
export function ServicioDelPrestadorScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('serviceId');
  const { f, idioma } = useTextosDeServicios('catalogo');
  const { servicio, setServicio, fallo, cargar } = useServicioPropio(id);
  const { ocupado, correr } = useCerrojo(cargar, 'catalogo');
  const clave = useRef(nuevaClave());

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/servicios/prestador/catalogo' as never);
  const titulo = f('servicios.catalogo.servicio');

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

  const s = servicio;
  const mostrada = versionQueSeEnsena(s);
  const abierta = s.open_version;
  const reenvio = esReenvio(s);
  const tarjeta = [styles.tarjeta, { borderColor: colors.border }];
  const ruta = `/servicios/prestador/catalogo/${s.id}`;
  const corregir = s.last_observation?.action === 'changes_requested';

  const editar = () =>
    void correr(async () => {
      setServicio(await ServiceCatalogRepository.abrirBorrador(s.id));
      router.push(`${ruta}/editar` as never);
    });

  const retirarVersion = () =>
    void correr(async () => {
      const si = await confirm({
        title: f('servicios.catalogo.retirarVersion.titulo'),
        message: f(
          s.published_version
            ? 'servicios.catalogo.retirarVersion.avisoConPublicada'
            : 'servicios.catalogo.retirarVersion.aviso',
        ),
        confirmLabel: f('servicios.catalogo.retirarVersion.confirmar'),
        destructive: true,
      });
      if (!si) return;
      setServicio(await ServiceCatalogRepository.retirarVersion(s.id, clave.current));
      clave.current = nuevaClave();
      toast(f('servicios.catalogo.retirarVersion.hecho'));
    });

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />

      <View style={tarjeta} accessibilityRole="summary">
        <Text variant="titleMedium">{mostrada?.title ?? f('servicios.catalogo.sinTitulo')}</Text>
        <Text variant="caption" color={colors.textMuted}>
          {nombreDeLaCategoria(s.category, idioma)}
        </Text>
        <Text weight="700">{f(claveDelEstadoDelServicio(s.status))}</Text>
        <Text variant="secondary">{f(claveDelCuerpoDelEstado(s.status))}</Text>
        <Text variant="caption" color={s.publicly_visible ? colors.primary : colors.textMuted}>
          {f(s.publicly_visible ? 'servicios.catalogo.visible' : 'servicios.catalogo.noVisible')}
        </Text>
      </View>

      {s.last_observation ? (
        <View style={[styles.tarjeta, { borderColor: colors.primary }]}>
          <Text weight="700">{f('servicios.catalogo.mensajeDeZ')}</Text>
          <Text variant="caption" color={colors.textMuted}>
            {`${f(claveDelSuceso(s.last_observation.action))}${
              s.last_observation.version ? ` · ${f('servicios.catalogo.versionN', { n: s.last_observation.version })}` : ''
            } · ${fechaCorta(s.last_observation.created_at)}`}
          </Text>
          <Text>{s.last_observation.note}</Text>
          {s.last_observation.fields.length > 0 ? (
            <Text variant="secondary">
              {f('servicios.catalogo.camposSenalados', {
                campos: s.last_observation.fields.map((c) => f(claveDelCampo(c))).join(', '),
              })}
            </Text>
          ) : null}
        </View>
      ) : null}

      {abierta ? (
        <View style={styles.seccion}>
          <SectionTitle title={f('servicios.catalogo.versionEnCurso')} />
          <View style={tarjeta}>
            <Text weight="700">
              {`${f('servicios.catalogo.versionN', { n: abierta.version })} · ${f(claveDelEstadoDeLaVersion(abierta.status))}`}
            </Text>
            <Text variant="secondary">
              {f(
                estaEnManosDeZ(s)
                  ? `servicios.catalogo.versionCuerpo.${abierta.status}`
                  : 'servicios.catalogo.versionCuerpo.draft',
              )}
            </Text>
          </View>
          {s.can_edit ? (
            <>
              <ListRow
                title={f('servicios.catalogo.paso.informacion')}
                leftIcon="edit-3"
                rightIcon="chevron-right"
                onPress={() => router.push(`${ruta}/editar` as never)}
              />
              <ListRow
                title={f('servicios.catalogo.paso.imagenes')}
                subtitle={f('servicios.catalogo.imagenes.cuantas', { n: abierta.images.length })}
                leftIcon="image"
                rightIcon="chevron-right"
                onPress={() => router.push(`${ruta}/imagenes` as never)}
              />
              {s.missing.length > 0 ? (
                <View style={tarjeta}>
                  <Text weight="700">{f('servicios.catalogo.faltan')}</Text>
                  {s.missing.map((codigo) => (
                    <Text key={codigo} variant="secondary">
                      {`• ${f(claveDelRequisito(codigo))}`}
                    </Text>
                  ))}
                </View>
              ) : null}
              <Button
                label={f(reenvio ? 'servicios.catalogo.revisarYReenviar' : 'servicios.catalogo.revisarYEnviar')}
                icon="send"
                onPress={() => router.push(`${ruta}/enviar` as never)}
              />
            </>
          ) : null}
        </View>
      ) : null}

      {s.can_open_draft ? (
        <Button
          label={f(corregir ? 'servicios.catalogo.corregirYReenviar' : 'servicios.catalogo.editarServicio')}
          icon="edit-3"
          variant={corregir ? 'primary' : 'secondary'}
          loading={ocupado}
          disabled={ocupado}
          onPress={editar}
        />
      ) : null}
      {s.can_open_draft && s.published_version ? (
        <Text variant="caption" color={colors.textMuted}>
          {f('servicios.catalogo.editarSinPerder')}
        </Text>
      ) : null}

      {s.published_version ? (
        <View style={styles.seccion}>
          <SectionTitle title={f('servicios.catalogo.loPublicado')} />
          <View style={tarjeta}>
            <Text weight="700">
              {`${f('servicios.catalogo.versionN', { n: s.published_version.version })} · ${fechaCorta(
                s.published_version.published_at,
              )}`}
            </Text>
            <Text variant="secondary">{s.published_version.summary ?? ''}</Text>
          </View>
          {s.publicly_visible ? (
            <ListRow
              title={f('servicios.catalogo.verFicha')}
              leftIcon="external-link"
              rightIcon="chevron-right"
              onPress={() => router.push(`/servicios/ficha/${s.id}` as never)}
            />
          ) : null}
        </View>
      ) : null}

      <View style={styles.seccion}>
        <ListRow
          title={f('servicios.historial.titulo')}
          leftIcon="clock"
          rightIcon="chevron-right"
          onPress={() => router.push(`${ruta}/historial` as never)}
        />
        {s.can_withdraw ? (
          <ListRow
            title={f('servicios.catalogo.retirarVersion.titulo')}
            leftIcon="x-circle"
            destructive
            onPress={retirarVersion}
          />
        ) : null}
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  seccion: { gap: spacing.xs },
  tarjeta: { gap: spacing.xs, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
});
