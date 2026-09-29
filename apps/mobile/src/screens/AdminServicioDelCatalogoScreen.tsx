import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { ContenidoDelServicio } from '@/components/ContenidoDelServicio';
import { EstadoDelCatalogo } from '@/components/EstadoDelCatalogo';
import { Input } from '@/components/Input';
import { ListRow } from '@/components/ListRow';
import { SectionTitle } from '@/components/SectionTitle';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { alternar, claveDelTipoDePrestador, fechaCorta, nuevaClave } from '@/lib/serviciosAdmision';
import {
  CAMPOS_SENALABLES,
  LARGOS,
  claveDeLaAccion,
  claveDelCampo,
  claveDelEstadoDeLaVersion,
  claveDelEstadoDelServicio,
  claveDelSuceso,
  cuerpoDeLaDecision,
  esDestructiva,
  exigeMotivo,
  nombreDeLaCategoria,
  revisarMotivo,
  type FalloDelCatalogo,
  type ServicioAdmin,
} from '@/lib/serviciosCatalogo';
import { leerFalloDelCatalogo, useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { ServiceCatalogAdminRepository } from '@/repositories/ServiceCatalogAdminRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type QueSeMira = 'propuesta' | 'publicada';

/**
 * Un servicio del catálogo, para el equipo de Z: la propuesta frente a lo
 * publicado, y las decisiones.
 *
 * - LA PROPUESTA SE LEE CON LO QUE CAMBIA MARCADO (`changed_fields`, del
 *   servidor), y se puede comparar con lo que hoy ve el público.
 * - LAS DECISIONES SON LAS QUE EL SERVIDOR OFRECE A QUIEN MIRA (`actions`):
 *   moderación inicia la revisión y pide cambios; solo administración
 *   aprueba, publica, suspende, reactiva y retira. APROBAR NO PUBLICA: son
 *   dos pasos. Nadie decide lo propio (`own`).
 * - Cada decisión pide confirmación; pedir cambios, suspender, reactivar y
 *   retirar exigen un motivo que el prestador lee. La nota interna, no.
 * - Si alguien decidió antes (409), se vuelve a leer en vez de suponer.
 */
export function AdminServicioDelCatalogoScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('serviceId');
  const { f, idioma } = useTextosDeServicios('catalogo');
  const [servicio, setServicio] = useState<ServicioAdmin | null>(null);
  const [fallo, setFallo] = useState<FalloDelCatalogo | null>(null);
  const [mirando, setMirando] = useState<QueSeMira>('propuesta');
  const [accion, setAccion] = useState<string | null>(null);
  const [motivo, setMotivo] = useState('');
  const [notaInterna, setNotaInterna] = useState('');
  const [campos, setCampos] = useState<string[]>([]);
  const [errorDeMotivo, setErrorDeMotivo] = useState<string | null>(null);
  const clave = useRef(nuevaClave());

  const cargar = useCallback(async () => {
    setFallo(null);
    try {
      setServicio(await ServiceCatalogAdminRepository.servicio(id));
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

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/admin/servicios/catalogo' as never);
  const titulo = f('servicios.catalogo.admin.servicio');

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
  const p = s.provider;
  const propuesta = s.proposed_version;
  const publicada = s.published_version;
  const vista = mirando === 'publicada' && publicada ? publicada : (propuesta ?? publicada);
  const tarjeta = [styles.tarjeta, { borderColor: colors.border }];

  const abrirDecision = (a: string) => {
    setAccion(a);
    setMotivo('');
    setNotaInterna('');
    setCampos([]);
    setErrorDeMotivo(null);
    clave.current = nuevaClave();
  };

  const decidir = () => {
    if (accion === null) return;
    const problema = revisarMotivo(accion, motivo);
    setErrorDeMotivo(problema);
    if (problema) return;
    const esta = accion;
    void correr(async () => {
      const si = await confirm({
        title: f(claveDeLaAccion(esta)),
        message: f(`servicios.catalogo.admin.confirmar.${esta}`),
        confirmLabel: f(claveDeLaAccion(esta)),
        destructive: esDestructiva(esta),
      });
      if (!si) return;
      const nuevo = await ServiceCatalogAdminRepository.decidir(
        s.id,
        esta,
        propuesta?.id ?? null,
        cuerpoDeLaDecision(esta, { motivo, notaInterna, campos }),
        clave.current,
      );
      setServicio(nuevo);
      setAccion(null);
      toast(f('servicios.admin.decisionGuardada'));
    });
  };

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />

      <View style={tarjeta}>
        <Text variant="titleMedium">
          {propuesta?.title ?? publicada?.title ?? f('servicios.catalogo.sinTitulo')}
        </Text>
        <Text variant="secondary">
          {`${f(claveDelEstadoDelServicio(s.status))} · ${nombreDeLaCategoria(s.category, idioma)}`}
        </Text>
        <Text variant="secondary">
          {`${p.display_name} · ${f(claveDelTipoDePrestador(p.provider_type))}${p.country_code ? ` · ${p.country_code}` : ''}`}
        </Text>
        <Text variant="caption" color={p.status === 'active' ? colors.textMuted : colors.danger}>
          {f('servicios.admin.prestadorEstado', { estado: f(`servicios.prestadorEstado.${p.status}`) })}
        </Text>
        <Text variant="caption" color={s.publicly_visible ? colors.primary : colors.textMuted}>
          {f(s.publicly_visible ? 'servicios.catalogo.visible' : 'servicios.catalogo.noVisible')}
        </Text>
      </View>

      {s.own ? <StateView state="empty" icon="alert-triangle" title={f('servicios.catalogo.error.propio')} /> : null}

      {s.last_observation ? (
        <View style={tarjeta}>
          <Text weight="700">{f('servicios.catalogo.admin.ultimoMotivo')}</Text>
          <Text variant="caption" color={colors.textMuted}>
            {`${f(claveDelSuceso(s.last_observation.action))} · ${fechaCorta(s.last_observation.created_at)}`}
          </Text>
          <Text variant="secondary">{s.last_observation.note}</Text>
        </View>
      ) : null}

      {propuesta && publicada ? (
        <View style={styles.acciones} accessibilityRole="radiogroup">
          <Chip
            rol="radio"
            label={f('servicios.catalogo.admin.verPropuesta', { n: propuesta.version })}
            selected={mirando === 'propuesta'}
            onPress={() => setMirando('propuesta')}
          />
          <Chip
            rol="radio"
            label={f('servicios.catalogo.admin.verPublicada', { n: publicada.version })}
            selected={mirando === 'publicada'}
            onPress={() => setMirando('publicada')}
          />
        </View>
      ) : null}

      {vista ? (
        <>
          <SectionTitle
            title={`${f('servicios.catalogo.versionN', { n: vista.version })} · ${f(claveDelEstadoDeLaVersion(vista.status))}`}
          />
          {vista === propuesta && s.changed_fields.length > 0 ? (
            <Text variant="secondary">
              {f('servicios.catalogo.admin.queCambia', {
                campos: s.changed_fields.map((c) => f(claveDelCampo(c))).join(', '),
              })}
            </Text>
          ) : null}
          <ContenidoDelServicio
            contenido={vista}
            categoria={nombreDeLaCategoria(s.category, idioma)}
            imagenes={vista.images}
            resaltar={vista === propuesta ? s.changed_fields : []}
          />
        </>
      ) : (
        <Text variant="secondary">{f('servicios.catalogo.admin.sinVersiones')}</Text>
      )}

      <SectionTitle title={f('servicios.admin.decisiones')} />
      {s.actions.length === 0 ? (
        <Text variant="secondary">{f('servicios.admin.sinAcciones')}</Text>
      ) : (
        <View style={styles.acciones}>
          {s.actions.map((a) => (
            <Button
              key={a}
              label={f(claveDeLaAccion(a))}
              variant={esDestructiva(a) ? 'secondary' : 'primary'}
              disabled={ocupado}
              onPress={() => abrirDecision(a)}
            />
          ))}
        </View>
      )}

      {accion !== null ? (
        <View style={[styles.tarjeta, { borderColor: esDestructiva(accion) ? colors.danger : colors.primary }]}>
          <Text weight="700">{f(claveDeLaAccion(accion))}</Text>
          <Text variant="secondary">{f(`servicios.catalogo.admin.explica.${accion}`)}</Text>
          {exigeMotivo(accion) ? (
            <Input
              label={f('servicios.catalogo.admin.motivo')}
              value={motivo}
              onChangeText={setMotivo}
              multiline
              maxLength={LARGOS.nota[1]}
              error={errorDeMotivo ? f(errorDeMotivo) : undefined}
            />
          ) : null}
          {accion === 'request_changes' ? (
            <>
              <Text variant="secondary">{f('servicios.catalogo.admin.camposACorregir')}</Text>
              <View style={styles.acciones}>
                {CAMPOS_SENALABLES.map((campo) => (
                  <Chip
                    key={campo}
                    rol="checkbox"
                    label={f(claveDelCampo(campo))}
                    selected={campos.includes(campo)}
                    onPress={() => setCampos((actuales) => alternar(actuales, campo))}
                  />
                ))}
              </View>
            </>
          ) : null}
          <Input
            label={f('servicios.admin.notaInterna')}
            value={notaInterna}
            onChangeText={setNotaInterna}
            multiline
            maxLength={LARGOS.notaInterna[1]}
          />
          <View style={styles.acciones}>
            <Button label={f(claveDeLaAccion(accion))} loading={ocupado} disabled={ocupado} onPress={decidir} />
            <Button label={f('servicios.retirar.cancelar')} variant="ghost" onPress={() => setAccion(null)} />
          </View>
        </View>
      ) : null}

      <SectionTitle title={f('servicios.catalogo.admin.versiones')} />
      {s.versions.map((v) => (
        <ListRow
          key={v.id}
          title={`${f('servicios.catalogo.versionN', { n: v.version })} · ${f(claveDelEstadoDeLaVersion(v.status))}`}
          subtitle={fechaCorta(v.published_at ?? v.decided_at ?? v.submitted_at)}
          leftIcon="layers"
          rightIcon="chevron-right"
          onPress={() => router.push(`/admin/servicios/catalogo/${s.id}/version/${v.id}` as never)}
        />
      ))}

      <ListRow
        title={f('servicios.historial.completo')}
        leftIcon="clock"
        rightIcon="chevron-right"
        onPress={() => router.push(`/admin/servicios/catalogo/${s.id}/historial` as never)}
      />
      {s.publicly_visible ? (
        <ListRow
          title={f('servicios.catalogo.verFicha')}
          leftIcon="external-link"
          rightIcon="chevron-right"
          onPress={() => router.push(`/servicios/ficha/${s.id}` as never)}
        />
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  tarjeta: { gap: spacing.xs, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
  acciones: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
});
