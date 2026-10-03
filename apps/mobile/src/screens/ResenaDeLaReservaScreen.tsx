import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { nuevaClave, type FalloDeCarga } from '@/lib/serviciosAdmision';
import {
  EJES_DE_LA_RESENA,
  LARGOS_DE_LA_ATENCION,
  claveDelEje,
  llavero,
  momentoLegible,
  peticionDeResena,
  puede,
  resenaVacia,
  type ConCuidado,
  type EjeDeLaResena,
  type FormularioDeResena,
} from '@/lib/serviciosAtencion';
import { rutaDeLaReserva, type ReservaDetalle } from '@/lib/serviciosReserva';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { leerFallo, useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceCareRepository } from '@/repositories/ServiceCareRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const NOTAS = [1, 2, 3, 4, 5] as const;

/**
 * LA RESEÑA de una atención cerrada, de quien la contrató: una nota de 1 a 5,
 * si la recomienda y un comentario; los cuatro ejes son opcionales.
 *
 * ES VERIFICADA PORQUE LO DICE EL SERVIDOR: solo deja escribirla a quien
 * contrató, de una atención que se realizó, una vez y dentro de su plazo. Aquí
 * no hay ningún «verificada» que marcar. No se pueden adjuntar archivos.
 */
export function ResenaDeLaReservaScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('bookingId');
  const { f } = useTextosDeServicios('reserva');
  const [reserva, setReserva] = useState<ConCuidado<ReservaDetalle> | null>(null);
  const [fallo, setFallo] = useState<FalloDeCarga | null>(null);
  const [formulario, setFormulario] = useState<FormularioDeResena>(resenaVacia);
  const llaves = useRef(llavero(nuevaClave)).current;

  const cargar = useCallback(async () => {
    setFallo(null);
    try {
      setReserva(await ServiceCareRepository.reserva('client', id));
    } catch (error) {
      setFallo(leerFallo(error));
    }
  }, [id]);
  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );
  const { ocupado, correr } = useCerrojo(cargar, 'reserva');

  const volver = () => (router.canGoBack() ? router.back() : router.replace(rutaDeLaReserva(id) as never));
  const titulo = f('servicios.atencion.resena.escribir');

  const enviar = () =>
    void correr(async () => {
      const { peticion, fallo: falta } = peticionDeResena(formulario);
      if (peticion === null) {
        notify(f('servicios.noSePudo'), f(falta ?? 'servicios.atencion.error.nota'));
        return;
      }
      const fresca = await ServiceCareRepository.resenar(id, peticion, llaves.de('resenar', peticion));
      llaves.hecho('resenar');
      toast(
        f(fresca.care?.review?.status === 'pending' ? 'servicios.atencion.resena.enRevision' : 'servicios.atencion.resena.publicada'),
      );
      router.replace(rutaDeLaReserva(id) as never);
    });

  const ponerEje = (eje: EjeDeLaResena, nota: number) =>
    setFormulario((ya) => ({ ...ya, ejes: { ...ya.ejes, [eje]: ya.ejes[eje] === nota ? 0 : nota } }));

  return (
    <AppScreen teclado contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />
      {fallo !== null ? (
        <EstadoDeServicios fallo={fallo} onRetry={() => void cargar()} />
      ) : reserva === null ? (
        <StateView state="loading" />
      ) : !puede(reserva.care, 'review') ? (
        <StateView
          state="empty"
          icon="star"
          title={f(reserva.care?.review ? 'servicios.atencion.resena.yaEscrita' : 'servicios.atencion.resena.todaviaNo')}
          description={f('servicios.atencion.resena.todaviaNoCuerpo')}
          actionLabel={f('servicios.reserva.verReserva')}
          onAction={() => router.replace(rutaDeLaReserva(id) as never)}
        />
      ) : (
        <>
          <Text variant="titleMedium">{reserva.title}</Text>
          <Text variant="secondary">{reserva.provider_name}</Text>
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.atencion.resena.hasta', { fecha: momentoLegible(reserva.care?.deadlines.review_until) })}
          </Text>

          <Text weight="700">{f('servicios.atencion.resena.nota')}</Text>
          <View style={styles.fila} accessibilityRole="radiogroup">
            {NOTAS.map((n) => (
              <Chip
                key={n}
                rol="radio"
                label={f('servicios.atencion.resena.deCinco', { n })}
                selected={formulario.nota === n}
                onPress={() => setFormulario((ya) => ({ ...ya, nota: n }))}
              />
            ))}
          </View>

          <Text weight="700">{f('servicios.atencion.resena.recomiendas')}</Text>
          <View style={styles.fila} accessibilityRole="radiogroup">
            {([true, false] as const).map((valor) => (
              <Chip
                key={String(valor)}
                rol="radio"
                label={f(valor ? 'servicios.atencion.resena.si' : 'servicios.atencion.resena.no')}
                selected={formulario.recomienda === valor}
                onPress={() => setFormulario((ya) => ({ ...ya, recomienda: valor }))}
              />
            ))}
          </View>

          <Input
            label={f('servicios.atencion.resena.comentario')}
            placeholder={f('servicios.atencion.resena.comentarioAyuda')}
            value={formulario.comentario}
            onChangeText={(comentario) => setFormulario((ya) => ({ ...ya, comentario }))}
            maxLength={LARGOS_DE_LA_ATENCION.comentario}
            multiline
          />

          <Text weight="700">{f('servicios.atencion.resena.ejes')}</Text>
          {EJES_DE_LA_RESENA.map((eje) => (
            <View key={eje} style={styles.eje}>
              <Text variant="secondary">{f(claveDelEje(eje))}</Text>
              <View style={styles.fila} accessibilityRole="radiogroup">
                {NOTAS.map((n) => (
                  <Chip
                    key={n}
                    rol="radio"
                    label={String(n)}
                    selected={formulario.ejes[eje] === n}
                    onPress={() => ponerEje(eje, n)}
                  />
                ))}
              </View>
            </View>
          ))}

          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.atencion.resena.aviso')}
          </Text>
          <Button
            label={f('servicios.atencion.resena.enviar')}
            icon="send"
            loading={ocupado}
            disabled={ocupado || formulario.nota === 0 || formulario.recomienda === null}
            onPress={enviar}
          />
        </>
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  fila: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  eje: { gap: spacing.xs },
});
