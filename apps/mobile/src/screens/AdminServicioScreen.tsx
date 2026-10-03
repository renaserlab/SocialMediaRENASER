import React, { useCallback, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { Input } from '@/components/Input';
import { ListRow } from '@/components/ListRow';
import { SectionTitle } from '@/components/SectionTitle';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import {
  CAMPOS_OBSERVABLES,
  bloqueo,
  claveDeLaAccion,
  claveDelCampo,
  claveDelEstado,
  claveDelEstadoDeCredencial,
  claveDelEstadoDeDocumento,
  claveDelTipoDeCredencial,
  claveDelTipoDeDocumento,
  claveDelTipoDePrestador,
  esDestructiva,
  exigeMotivo,
  fechaCorta,
  nuevaClave,
  pesoLegible,
  revisarMotivo,
  revisarNota,
  type FalloDeCarga,
  type SolicitudAdmin,
} from '@/lib/serviciosAdmision';
import { leerFallo, useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceAdmissionRepository } from '@/repositories/ServiceAdmissionRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Observando = { que: 'documento' | 'credencial'; id: string; accion: 'observe' | 'reject' };

/**
 * El expediente de una postulación, para el equipo de Z.
 *
 * - LOS DOCUMENTOS SE MIRAN con un enlace de DOS MINUTOS, uno por toque, que
 *   no se guarda; el servidor apunta en la auditoría quién lo pidió.
 * - LA EVIDENCIA SE REVISA solo con la postulación en revisión.
 * - LAS DECISIONES son las que el servidor ofrece a QUIEN MIRA
 *   (`available_actions`): moderación toma y pide correcciones; solo
 *   administración aprueba, rechaza y suspende; nadie decide lo propio. Cada
 *   una pide confirmación, exige motivo donde toca y, si alguien decidió
 *   antes (409), se vuelve a leer en vez de suponer.
 */
export function AdminServicioScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { applicationId } = useLocalSearchParams<{ applicationId?: string }>();
  const id = typeof applicationId === 'string' ? applicationId : '';
  const { f } = useTextosDeServicios();
  const [expediente, setExpediente] = useState<SolicitudAdmin | null>(null);
  const [fallo, setFallo] = useState<FalloDeCarga | null>(null);
  const [observando, setObservando] = useState<Observando | null>(null);
  const [nota, setNota] = useState('');
  const [errorDeNota, setErrorDeNota] = useState<string | null>(null);
  const [accion, setAccion] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState('');
  const [notaInterna, setNotaInterna] = useState('');
  const [campos, setCampos] = useState<string[]>([]);
  const [errorDeMensaje, setErrorDeMensaje] = useState<string | null>(null);
  const clave = useRef(nuevaClave());

  const cargar = useCallback(async () => {
    setFallo(null);
    try {
      setExpediente(await ServiceAdmissionRepository.expediente(id));
    } catch (error) {
      setFallo(leerFallo(error));
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );
  const { ocupado, correr } = useCerrojo(cargar);

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/admin/servicios' as never));
  const titulo = f('servicios.admin.expediente');

  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <EstadoDeServicios fallo={fallo} onRetry={() => void cargar()} />
      </AppScreen>
    );
  }
  if (expediente === null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  const e = expediente;
  const p = e.provider;
  const enRevision = e.status === 'under_review' && !e.is_own;
  const tarjeta = [styles.tarjeta, { borderColor: colors.border }];

  const ver = (documentoId: string) =>
    void correr(async () => {
      const enlace = await ServiceAdmissionRepository.verDocumento(e.id, documentoId);
      await Linking.openURL(enlace.url);
    });

  const aceptarDocumento = (documentoId: string) =>
    void correr(async () => {
      setExpediente(await ServiceAdmissionRepository.aceptarDocumento(e.id, documentoId));
      toast(f('servicios.admin.documentoAceptado'));
    });

  const verificar = (credencialId: string) =>
    void correr(async () => {
      setExpediente(await ServiceAdmissionRepository.verificarCredencial(e.id, credencialId));
      toast(f('servicios.admin.credencialVerificada'));
    });

  const enviarObservacion = () => {
    if (observando === null) return;
    const problema = revisarNota(nota);
    setErrorDeNota(problema);
    if (problema) return;
    const actual = observando;
    void correr(async () => {
      if (actual.accion === 'reject') {
        const si = await confirm({
          title: f('servicios.admin.rechazarCredencialTitulo'),
          message: f('servicios.admin.rechazarCredencialAviso'),
          confirmLabel: f('servicios.admin.rechazar'),
          destructive: true,
        });
        if (!si) return;
      }
      const nuevo =
        actual.que === 'documento'
          ? await ServiceAdmissionRepository.observarDocumento(e.id, actual.id, nota)
          : actual.accion === 'reject'
            ? await ServiceAdmissionRepository.rechazarCredencial(e.id, actual.id, nota)
            : await ServiceAdmissionRepository.observarCredencial(e.id, actual.id, nota);
      setExpediente(nuevo);
      setObservando(null);
      setNota('');
      toast(f('servicios.admin.observacionGuardada'));
    });
  };

  const abrirDecision = (a: string) => {
    setAccion(a);
    setMensaje('');
    setNotaInterna('');
    setCampos([]);
    setErrorDeMensaje(null);
    clave.current = nuevaClave();
  };

  const decidir = () => {
    if (accion === null) return;
    const problema = revisarMotivo(accion, mensaje);
    setErrorDeMensaje(problema);
    if (problema) return;
    const esta = accion;
    void correr(async () => {
      const si = await confirm({
        title: f(claveDeLaAccion(esta, e.status)),
        message: f(`servicios.admin.confirmar.${esta}`),
        confirmLabel: f(claveDeLaAccion(esta, e.status)),
        destructive: esDestructiva(esta),
      });
      if (!si) return;
      const nuevo = await ServiceAdmissionRepository.decidir(
        e.id,
        esta,
        { mensaje, notaInterna, campos },
        clave.current,
      );
      setExpediente(nuevo);
      setAccion(null);
      toast(f('servicios.admin.decisionGuardada'));
    });
  };

  return (
    <AppScreen teclado contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />

      <View style={tarjeta}>
        <Text variant="titleMedium">{p.display_name}</Text>
        <Text variant="secondary">
          {`${f(claveDelEstado(e.status))} · ${f(claveDelTipoDePrestador(p.provider_type))}`}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('servicios.admin.prestadorEstado', { estado: f(`servicios.prestadorEstado.${p.status}`) })}
        </Text>
      </View>

      {e.is_own ? (
        <StateView state="empty" icon="alert-triangle" title={f('servicios.error.propia')} />
      ) : null}

      <SectionTitle title={f('servicios.paso.datos')} />
      <View style={tarjeta}>
        {p.legal_name ? <Text>{`${f('servicios.campo.legal_name')}: ${p.legal_name}`}</Text> : null}
        {p.country_code ? <Text>{`${f('servicios.campo.country_code')}: ${p.country_code}`}</Text> : null}
        {p.tax_id ? <Text>{`${f('servicios.campo.tax_id')}: ${p.tax_id}`}</Text> : null}
        {p.representative_name ? (
          <Text>{`${f('servicios.campo.representative_name')}: ${p.representative_name}`}</Text>
        ) : null}
        {e.requested_category ? (
          <Text>{`${f('servicios.campo.requested_category')}: ${e.requested_category}`}</Text>
        ) : null}
        {e.summary ? <Text variant="secondary">{e.summary}</Text> : null}
        <Text variant="caption" color={colors.textMuted}>
          {f('servicios.admin.condicionesAceptadas', {
            version: e.terms_version ?? '—',
            fecha: fechaCorta(e.terms_accepted_at),
          })}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('servicios.admin.envios', {
            envios: e.submissions.length,
            fecha: fechaCorta(e.last_submitted_at),
          })}
        </Text>
      </View>

      {e.applicant_message ? (
        <View style={tarjeta}>
          <Text weight="700">{f('servicios.admin.mensajeAlPostulante')}</Text>
          <Text>{e.applicant_message}</Text>
        </View>
      ) : null}
      {e.internal_notes ? (
        <View style={tarjeta}>
          <Text weight="700">{f('servicios.admin.notasInternas')}</Text>
          <Text variant="secondary">{e.internal_notes}</Text>
        </View>
      ) : null}

      {e.approval_blockers.length > 0 ? (
        <View style={[styles.tarjeta, { borderColor: colors.danger }]}>
          <Text weight="700">{f('servicios.admin.bloqueos')}</Text>
          {e.approval_blockers.map((codigo) => {
            const b = bloqueo(codigo);
            return (
              <Text key={codigo} variant="secondary">
                {`• ${f(b.clave, b.nombre ? { nombre: f(b.nombre) } : undefined)}`}
              </Text>
            );
          })}
        </View>
      ) : null}

      <SectionTitle title={f('servicios.paso.documentos')} />
      {e.documents.length === 0 ? (
        <Text variant="secondary">{f('servicios.documentos.ninguno')}</Text>
      ) : (
        e.documents.map((d) => (
          <View key={d.id} style={tarjeta}>
            <Text weight="600">{f(claveDelTipoDeDocumento(d.kind))}</Text>
            <Text variant="caption" color={d.review_status === 'rejected' ? colors.danger : colors.textMuted}>
              {`${f(claveDelEstadoDeDocumento(d.review_status))} · ${pesoLegible(d.byte_size)} · ${fechaCorta(d.created_at)}`}
            </Text>
            {d.review_note ? <Text variant="secondary">{d.review_note}</Text> : null}
            <View style={styles.acciones}>
              <Button
                label={f('servicios.admin.verTemporal')}
                variant="ghost"
                icon="external-link"
                disabled={ocupado}
                onPress={() => ver(d.id)}
              />
              {enRevision && d.review_status !== 'accepted' ? (
                <Button
                  label={f('servicios.admin.aceptar')}
                  variant="ghost"
                  icon="check"
                  disabled={ocupado}
                  onPress={() => aceptarDocumento(d.id)}
                />
              ) : null}
              {enRevision ? (
                <Button
                  label={f('servicios.admin.observar')}
                  variant="ghost"
                  icon="edit-3"
                  disabled={ocupado}
                  onPress={() => {
                    setObservando({ que: 'documento', id: d.id, accion: 'observe' });
                    setNota('');
                    setErrorDeNota(null);
                  }}
                />
              ) : null}
            </View>
          </View>
        ))
      )}
      {e.replaced_documents.length > 0 ? (
        <View style={tarjeta}>
          <Text weight="600">{f('servicios.admin.reemplazados')}</Text>
          {e.replaced_documents.map((d) => (
            <ListRow
              key={d.id}
              title={f(claveDelTipoDeDocumento(d.kind))}
              subtitle={fechaCorta(d.created_at)}
              leftIcon="archive"
              rightIcon="external-link"
              onPress={() => ver(d.id)}
            />
          ))}
        </View>
      ) : null}

      <SectionTitle title={f('servicios.paso.credenciales')} />
      {e.credentials.length === 0 ? (
        <Text variant="secondary">{f('servicios.credenciales.ninguna')}</Text>
      ) : (
        e.credentials.map((c) => (
          <View key={c.id} style={tarjeta}>
            <Text weight="600">{c.title}</Text>
            <Text variant="caption" color={colors.textMuted}>
              {`${f(claveDelTipoDeCredencial(c.kind))} · ${c.issuer}${c.jurisdiction ? ` · ${c.jurisdiction}` : ''}${
                c.number_masked ? ` · ${c.number_masked}` : ''
              }`}
            </Text>
            <Text variant="caption" color={c.display_status === 'rejected' || c.display_status === 'expired' ? colors.danger : colors.textMuted}>
              {`${f(claveDelEstadoDeCredencial(c.display_status))}${c.expires_on ? ` · ${f('servicios.credenciales.vence', { fecha: fechaCorta(c.expires_on) })}` : ''}`}
            </Text>
            {c.review_note ? <Text variant="secondary">{c.review_note}</Text> : null}
            <View style={styles.acciones}>
              {c.evidence_document_id ? (
                <Button
                  label={f('servicios.admin.verEvidencia')}
                  variant="ghost"
                  icon="external-link"
                  disabled={ocupado}
                  onPress={() => ver(c.evidence_document_id as string)}
                />
              ) : (
                <Text variant="caption" color={colors.danger}>
                  {f('servicios.falta.evidencia')}
                </Text>
              )}
              {enRevision && c.status === 'declared' ? (
                <>
                  <Button label={f('servicios.admin.verificar')} variant="ghost" icon="check" disabled={ocupado} onPress={() => verificar(c.id)} />
                  <Button
                    label={f('servicios.admin.observar')}
                    variant="ghost"
                    icon="edit-3"
                    disabled={ocupado}
                    onPress={() => {
                      setObservando({ que: 'credencial', id: c.id, accion: 'observe' });
                      setNota('');
                      setErrorDeNota(null);
                    }}
                  />
                  <Button
                    label={f('servicios.admin.rechazar')}
                    variant="ghost"
                    icon="x"
                    disabled={ocupado}
                    onPress={() => {
                      setObservando({ que: 'credencial', id: c.id, accion: 'reject' });
                      setNota('');
                      setErrorDeNota(null);
                    }}
                  />
                </>
              ) : null}
            </View>
          </View>
        ))
      )}

      {observando !== null ? (
        <View style={[styles.tarjeta, { borderColor: colors.primary }]}>
          <Input
            label={f('servicios.admin.motivoDeLaObservacion')}
            value={nota}
            onChangeText={setNota}
            multiline
            maxLength={1000}
            error={errorDeNota ? f(errorDeNota) : undefined}
          />
          <View style={styles.acciones}>
            <Button
              label={f(observando.accion === 'reject' ? 'servicios.admin.rechazar' : 'servicios.admin.observar')}
              loading={ocupado}
              disabled={ocupado}
              onPress={enviarObservacion}
            />
            <Button label={f('servicios.retirar.cancelar')} variant="ghost" onPress={() => setObservando(null)} />
          </View>
        </View>
      ) : null}

      <SectionTitle title={f('servicios.admin.decisiones')} />
      {e.available_actions.length === 0 ? (
        <Text variant="secondary">{f('servicios.admin.sinAcciones')}</Text>
      ) : (
        <View style={styles.acciones}>
          {e.available_actions.map((a) => (
            <Button
              key={a}
              label={f(claveDeLaAccion(a, e.status))}
              variant={esDestructiva(a) ? 'secondary' : 'primary'}
              disabled={ocupado}
              onPress={() => abrirDecision(a)}
            />
          ))}
        </View>
      )}

      {accion !== null ? (
        <View style={[styles.tarjeta, { borderColor: esDestructiva(accion) ? colors.danger : colors.primary }]}>
          <Text weight="700">{f(claveDeLaAccion(accion, e.status))}</Text>
          {accion !== 'start_review' ? (
            <Input
              label={f(exigeMotivo(accion) ? 'servicios.admin.motivoObligatorio' : 'servicios.admin.mensajeOpcional')}
              value={mensaje}
              onChangeText={setMensaje}
              multiline
              maxLength={2000}
              error={errorDeMensaje ? f(errorDeMensaje) : undefined}
            />
          ) : null}
          {accion === 'request_changes' ? (
            <>
              <Text variant="secondary">{f('servicios.admin.camposACorregir')}</Text>
              <View style={styles.acciones}>
                {CAMPOS_OBSERVABLES.map((campo) => (
                  <Chip
                    key={campo}
                    label={f(claveDelCampo(campo))}
                    selected={campos.includes(campo)}
                    onPress={() =>
                      setCampos((actuales) =>
                        actuales.includes(campo) ? actuales.filter((c) => c !== campo) : [...actuales, campo],
                      )
                    }
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
            maxLength={4000}
          />
          <View style={styles.acciones}>
            <Button
              label={f(claveDeLaAccion(accion, e.status))}
              loading={ocupado}
              disabled={ocupado}
              onPress={decidir}
            />
            <Button label={f('servicios.retirar.cancelar')} variant="ghost" onPress={() => setAccion(null)} />
          </View>
        </View>
      ) : null}

      <ListRow
        title={f('servicios.historial.completo')}
        leftIcon="clock"
        rightIcon="chevron-right"
        onPress={() => router.push(`/admin/servicios/historial/${e.id}` as never)}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  tarjeta: { gap: spacing.xs, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
  acciones: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
});
