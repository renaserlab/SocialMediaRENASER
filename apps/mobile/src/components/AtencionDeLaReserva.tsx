import React, { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { confirm } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { nuevaClave } from '@/lib/serviciosAdmision';
import {
  LARGOS_DE_LA_ATENCION,
  PREGUNTAS_DE_LA_ATENCION,
  claveDelCierre,
  claveDelEstadoDeLaAtencion,
  claveDelEstadoDeLaReserva,
  claveDelEstadoDeLaResena,
  claveDelEstadoDelCaso,
  claveDelEstadoDelEfecto,
  claveDelMotivoDeCancelacion,
  codigoLimpio,
  estrellas,
  llavero,
  momentoLegible,
  peticionDeRespuesta,
  puede,
  rutaDeCancelar,
  rutaDeHorariosParaReprogramar,
  rutaDeLaResena,
  rutaDelCaso,
  type ConCuidado,
  type Parte,
  type PreguntaDeLaAtencion,
} from '@/lib/serviciosAtencion';
import type { ReservaDetalle } from '@/lib/serviciosReserva';
import { useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceCareRepository } from '@/repositories/ServiceCareRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  rol: Parte;
  reserva: ConCuidado<ReservaDetalle>;
  /** La reserva FRESCA que devolvió el servidor tras una acción. */
  alCambiar: (fresca: ConCuidado<ReservaDetalle>) => void;
  /** Volver a leerla (tras un 409: alguien llegó antes). */
  recargar: () => Promise<void>;
};

/**
 * LA ATENCIÓN de una reserva, para una de sus dos partes: en qué está, sus
 * plazos y LO QUE SE PUEDE HACER AHORA.
 *
 * Las acciones son las que manda el servidor (`care.available_actions`): aquí
 * no se mira la hora del teléfono ni se deduce nada del estado. Sin `care`
 * (la base todavía sin la 0094) no se enseña nada.
 *
 * EL DINERO NO SE MUEVE: cancelar, declarar una inasistencia o resolver un
 * caso dicen en qué quedó lo económico, y hoy siempre es «no aplica».
 */
export function AtencionDeLaReserva({ rol, reserva, alCambiar, recargar }: Props) {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { f } = useTextosDeServicios('reserva');
  const { ocupado, correr } = useCerrojo(recargar, 'reserva');
  const [codigo, setCodigo] = useState('');
  const [respuesta, setRespuesta] = useState('');
  // UNA CLAVE POR PETICIÓN: repetir el mismo toque es repetir lo mismo.
  const llaves = useRef(llavero(nuevaClave)).current;

  const cuidado = reserva.care;
  if (!cuidado) return null;

  const id = reserva.id;
  const a = cuidado.attendance;
  const p = cuidado.deadlines;
  const tarjeta = [styles.tarjeta, { borderColor: colors.border }];
  const esCliente = rol === 'client';

  const preguntar = (cual: PreguntaDeLaAtencion) => {
    const p = PREGUNTAS_DE_LA_ATENCION[cual];
    return confirm({ title: f(p.titulo), message: f(p.aviso), confirmLabel: f(p.si) });
  };

  const pedirCodigo = () =>
    void correr(async () => {
      await ServiceCareRepository.pedirCodigo(id, llaves.de('codigo'));
      llaves.hecho('codigo');
      await recargar();
    });

  const iniciar = (conCodigo: boolean) =>
    void correr(async () => {
      if (!conCodigo && !(await preguntar('sinCodigo'))) return;
      const escrito = conCodigo ? codigo : null;
      alCambiar(await ServiceCareRepository.iniciar(id, escrito, llaves.de('iniciar', escrito)));
      llaves.hecho('iniciar');
      setCodigo('');
      toast(f('servicios.atencion.iniciada'));
    });

  const terminar = () =>
    void correr(async () => {
      if (!(await preguntar('terminar'))) return;
      alCambiar(await ServiceCareRepository.terminar(id, llaves.de('terminar')));
      llaves.hecho('terminar');
      toast(f('servicios.atencion.terminada'));
    });

  const confirmar = () =>
    void correr(async () => {
      if (!(await preguntar('confirmar'))) return;
      alCambiar(await ServiceCareRepository.confirmar(id, llaves.de('confirmar')));
      llaves.hecho('confirmar');
      toast(f('servicios.atencion.confirmada'));
    });

  const reportarAusencia = () =>
    void correr(async () => {
      if (!(await preguntar(esCliente ? 'ausenciaDelPrestador' : 'ausenciaDelCliente'))) return;
      alCambiar(await ServiceCareRepository.reportarAusencia(rol, id, llaves.de('ausencia')));
      llaves.hecho('ausencia');
      toast(f('servicios.atencion.ausenciaReportada'));
    });

  const responder = () =>
    void correr(async () => {
      const { peticion, fallo } = peticionDeRespuesta(respuesta);
      if (peticion === null) {
        toast(f(fallo ?? 'servicios.atencion.error.vacio'), 'alert-circle');
        return;
      }
      if (!(await preguntar('responder'))) return;
      alCambiar(await ServiceCareRepository.responderResena(id, peticion, llaves.de('responder', peticion)));
      llaves.hecho('responder');
      setRespuesta('');
      toast(f('servicios.atencion.respondida'));
    });

  const cancelada = cuidado.cancellation;
  const caso = cuidado.incident;
  const resena = cuidado.review;

  return (
    <>
      <View style={tarjeta} accessibilityLiveRegion="polite">
        <Text weight="700">{f('servicios.atencion.titulo')}</Text>
        {cancelada ? (
          <>
            <Text weight="600" color={colors.danger}>
              {f(claveDelEstadoDeLaReserva(reserva.status))}
            </Text>
            <Text variant="secondary">
              {f(cancelada.by === 'provider' ? 'servicios.atencion.cancelada.porElPrestador' : 'servicios.atencion.cancelada.porQuienContrata', {
                fecha: momentoLegible(cancelada.at),
                motivo: f(claveDelMotivoDeCancelacion(cancelada.reason)),
              })}
            </Text>
            {cancelada.note ? <Text variant="secondary">{cancelada.note}</Text> : null}
            <Text variant="caption" color={colors.textMuted}>
              {f('servicios.atencion.dinero.deLaCancelacion', {
                estado: f(claveDelEstadoDelEfecto(cancelada.financial_effect_status)),
              })}
            </Text>
          </>
        ) : (
          <>
            <Text weight="600">{f(claveDelEstadoDeLaAtencion(a?.status))}</Text>
            {a?.status === 'closed' ? (
              <Text variant="secondary">
                {f(claveDelCierre(a.closed_by), { fecha: momentoLegible(a.closed_at) })}
              </Text>
            ) : null}
            {a?.started_at ? (
              <Text variant="caption" color={colors.textMuted}>
                {f(a.with_code ? 'servicios.atencion.conCodigo' : 'servicios.atencion.sinCodigo', {
                  fecha: momentoLegible(a.started_at),
                })}
              </Text>
            ) : null}
          </>
        )}
        {cuidado.reschedules.map((c) => (
          <Text key={c.at} variant="caption" color={colors.textMuted}>
            {f('servicios.atencion.reprogramada', {
              antes: momentoLegible(c.from_starts_at),
              ahora: momentoLegible(c.to_starts_at),
            })}
          </Text>
        ))}
      </View>

      {esCliente && a?.checkin_code ? (
        <View style={[styles.tarjeta, { borderColor: colors.primary }]} accessibilityRole="summary">
          <Text weight="700">{f('servicios.atencion.codigo.titulo')}</Text>
          <Text variant="display" accessibilityLabel={f('servicios.atencion.codigo.leido', { codigo: a.checkin_code.split('').join(' ') })}>
            {a.checkin_code}
          </Text>
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.atencion.codigo.ayuda')}
          </Text>
        </View>
      ) : null}

      {puede(cuidado, 'issue_code') && !a?.checkin_code ? (
        <View style={tarjeta}>
          <Text variant="secondary">{f('servicios.atencion.codigo.explica')}</Text>
          <Button
            label={f('servicios.atencion.codigo.pedir')}
            icon="key"
            loading={ocupado}
            disabled={ocupado}
            onPress={pedirCodigo}
          />
        </View>
      ) : null}

      {puede(cuidado, 'start') ? (
        <View style={tarjeta}>
          <Text weight="700">{f('servicios.atencion.iniciar.titulo')}</Text>
          <Text variant="secondary">{f('servicios.atencion.iniciar.explica')}</Text>
          {a?.code_attempts_left !== null && a?.code_attempts_left !== undefined ? (
            <Text variant="caption" color={colors.textMuted}>
              {f('servicios.atencion.iniciar.intentos', { n: a.code_attempts_left })}
            </Text>
          ) : null}
          <Input
            label={f('servicios.atencion.iniciar.codigo')}
            value={codigo}
            onChangeText={(texto) => setCodigo(codigoLimpio(texto))}
            keyboardType="number-pad"
            maxLength={LARGOS_DE_LA_ATENCION.codigo}
          />
          <Button
            label={f('servicios.atencion.iniciar.conCodigo')}
            icon="play"
            loading={ocupado}
            disabled={ocupado || codigo.length !== LARGOS_DE_LA_ATENCION.codigo}
            onPress={() => iniciar(true)}
          />
          <Button
            label={f('servicios.atencion.iniciar.sinCodigo')}
            variant="ghost"
            disabled={ocupado}
            onPress={() => iniciar(false)}
          />
        </View>
      ) : null}

      {puede(cuidado, 'complete') ? (
        <Button label={f('servicios.atencion.terminar')} icon="check" loading={ocupado} disabled={ocupado} onPress={terminar} />
      ) : null}

      {puede(cuidado, 'confirm') ? (
        <View style={tarjeta}>
          <Text variant="secondary">{f('servicios.atencion.confirmar.explica')}</Text>
          <Button
            label={f('servicios.atencion.confirmar')}
            icon="check-circle"
            loading={ocupado}
            disabled={ocupado}
            onPress={confirmar}
          />
        </View>
      ) : null}

      {puede(cuidado, 'report_absence') ? (
        <Button
          label={f(esCliente ? 'servicios.atencion.ausenciaDelPrestador' : 'servicios.atencion.ausenciaDelCliente')}
          variant="secondary"
          icon="user-x"
          disabled={ocupado}
          onPress={reportarAusencia}
        />
      ) : null}

      {puede(cuidado, 'reschedule') || puede(cuidado, 'cancel') ? (
        <View style={tarjeta}>
          <Text weight="700">{f('servicios.atencion.cambios.titulo')}</Text>
          {puede(cuidado, 'reschedule') ? (
            <>
              <Text variant="caption" color={colors.textMuted}>
                {f('servicios.atencion.cambios.reprogramarHasta', {
                  fecha: momentoLegible(p.reschedule_until),
                  n: p.reschedules_left,
                })}
              </Text>
              <Button
                label={f('servicios.atencion.reprogramar')}
                variant="secondary"
                icon="calendar"
                disabled={ocupado}
                onPress={() => router.push(rutaDeHorariosParaReprogramar(reserva.service_id, id) as never)}
              />
            </>
          ) : null}
          {puede(cuidado, 'cancel') ? (
            <>
              <Text variant="caption" color={colors.textMuted}>
                {f('servicios.atencion.cambios.cancelarHasta', { fecha: momentoLegible(p.cancel_until) })}
              </Text>
              <Button
                label={f('servicios.atencion.cancelar')}
                variant="ghost"
                icon="x-circle"
                disabled={ocupado}
                onPress={() => router.push(rutaDeCancelar(rol, id) as never)}
              />
            </>
          ) : null}
        </View>
      ) : null}

      {caso || puede(cuidado, 'open_incident') ? (
        <View style={tarjeta}>
          <Text weight="700">{f('servicios.atencion.caso.titulo')}</Text>
          {caso ? (
            <Text variant="secondary">{f(claveDelEstadoDelCaso(caso.status))}</Text>
          ) : (
            <Text variant="caption" color={colors.textMuted}>
              {f('servicios.atencion.caso.hasta', { fecha: momentoLegible(p.incident_until) })}
            </Text>
          )}
          <Button
            label={f(caso ? 'servicios.atencion.caso.ver' : 'servicios.atencion.caso.abrir')}
            variant="secondary"
            icon="alert-triangle"
            disabled={ocupado}
            onPress={() => router.push(rutaDelCaso(rol, id) as never)}
          />
        </View>
      ) : null}

      {resena || puede(cuidado, 'review') ? (
        <View style={tarjeta}>
          <Text weight="700">{f('servicios.atencion.resena.titulo')}</Text>
          {resena ? (
            <>
              <Text accessibilityLabel={f('servicios.atencion.resena.notaLeida', { n: resena.rating })}>
                {estrellas(resena.rating)}
              </Text>
              <Text variant="secondary">{resena.comment}</Text>
              {esCliente && resena.status ? (
                <Text variant="caption" color={colors.textMuted}>
                  {f(claveDelEstadoDeLaResena(resena.status))}
                </Text>
              ) : null}
              {resena.reply ? (
                <Text variant="secondary">{f('servicios.atencion.resena.respuesta', { texto: resena.reply })}</Text>
              ) : null}
            </>
          ) : (
            <>
              <Text variant="caption" color={colors.textMuted}>
                {f('servicios.atencion.resena.hasta', { fecha: momentoLegible(p.review_until) })}
              </Text>
              <Button
                label={f('servicios.atencion.resena.escribir')}
                icon="star"
                disabled={ocupado}
                onPress={() => router.push(rutaDeLaResena(id) as never)}
              />
            </>
          )}
          {puede(cuidado, 'reply_review') ? (
            <>
              <Input
                label={f('servicios.atencion.resena.tuRespuesta')}
                placeholder={f('servicios.atencion.resena.respuestaAyuda')}
                value={respuesta}
                onChangeText={setRespuesta}
                maxLength={LARGOS_DE_LA_ATENCION.respuesta}
                multiline
              />
              <Button
                label={f('servicios.atencion.resena.responder')}
                variant="secondary"
                icon="message-circle"
                loading={ocupado}
                disabled={ocupado || !respuesta.trim()}
                onPress={responder}
              />
            </>
          ) : null}
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  tarjeta: { gap: spacing.xs, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
});
