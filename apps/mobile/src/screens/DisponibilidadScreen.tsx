import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { Pulsable } from '@/components/Pulsable';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { TimeField } from '@/components/TimeField';
import { toHumanTime } from '@/components/TimeField.types';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { describeError } from '@/lib/describeError';
import {
  DIAS_DE_LA_SEMANA,
  juzgarFranja,
  ordenarFranjas,
  type Franja,
  type JuicioDeFranja,
} from '@/lib/disponibilidad';
import { toast } from '@/lib/toast';
import { AvailabilityRepository } from '@/repositories/AvailabilityRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const NOMBRE_DEL_DIA: TranslationKey[] = [
  'availability.day0',
  'availability.day1',
  'availability.day2',
  'availability.day3',
  'availability.day4',
  'availability.day5',
  'availability.day6',
];

const nombreDelDia = (dia: number): TranslationKey =>
  NOMBRE_DEL_DIA[dia] ?? 'availability.day0';

const MOTIVO: Record<Exclude<JuicioDeFranja, 'vale'>, TranslationKey> = {
  hora: 'availability.needTimes',
  corta: 'availability.tooShort',
  se_pisa: 'availability.overlap',
  llena: 'availability.dayFull',
};

/**
 * «Mi disponibilidad»: en qué días y a qué horas se me puede pedir una sesión.
 *
 * PROTOTIPO (09/10/2026). Una semana tipo que se repite. Se edita entera en la
 * pantalla y se guarda de una vez: no hay guardado franja a franja que pueda
 * dejar la semana a medias.
 *
 * Las horas son las del teléfono de quien las pone; quien pide la sesión las ve
 * convertidas a las suyas.
 */
export function DisponibilidadScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();

  const [estado, setEstado] = useState<'cargando' | 'lista' | 'error' | 'sin_funcion'>('cargando');
  const [franjas, setFranjas] = useState<Franja[]>([]);
  const [cambiada, setCambiada] = useState(false);
  const [guardando, setGuardando] = useState(false);
  /** El día al que se le está añadiendo una franja, y lo escrito. */
  const [abierto, setAbierto] = useState<number | null>(null);
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setEstado('cargando');
    try {
      const mia = await AvailabilityRepository.mia();
      setFranjas(mia.franjas);
      setCambiada(false);
      setEstado(mia.disponible ? 'lista' : 'sin_funcion');
    } catch {
      setEstado('error');
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const abrir = (dia: number) => {
    setAbierto(dia);
    setDesde('');
    setHasta('');
    setError(null);
  };

  const anadir = () => {
    if (abierto === null) return;
    const nueva: Franja = { dia: abierto, desde, hasta };
    const juicio = juzgarFranja(nueva, franjas);
    if (juicio !== 'vale') {
      setError(t(MOTIVO[juicio]));
      return;
    }
    setFranjas(ordenarFranjas([...franjas, nueva]));
    setCambiada(true);
    setAbierto(null);
    setError(null);
  };

  const quitar = (franja: Franja) => {
    setFranjas(franjas.filter((f) => f !== franja));
    setCambiada(true);
  };

  const guardar = async () => {
    setGuardando(true);
    setError(null);
    try {
      const guardada = await AvailabilityRepository.guardar(franjas);
      setFranjas(guardada.franjas);
      setCambiada(false);
      toast(t('availability.saved'));
    } catch (e) {
      setError(describeError(e, t('availability.saveFailed')));
    } finally {
      setGuardando(false);
    }
  };

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/agenda' as never));

  if (estado !== 'lista') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title={t('availability.title')} onBack={volver} />
        {estado === 'cargando' ? (
          <StateView state="loading" />
        ) : estado === 'sin_funcion' ? (
          <StateView
            state="empty"
            icon="calendar"
            title={t('availability.unavailableTitle')}
            description={t('availability.unavailableBody')}
          />
        ) : (
          <StateView
            state="error"
            title={t('availability.loadFailed')}
            actionLabel={t('common.retry')}
            onAction={() => void cargar()}
          />
        )}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title={t('availability.title')} onBack={volver} />
      <AppScreen contentStyle={{ paddingBottom: 140 }}>
        <View style={estilos.columna}>
          <Text variant="secondary" color={colors.textMuted}>
            {t('availability.body')}
          </Text>

          {DIAS_DE_LA_SEMANA.map((dia) => {
            const delDia = franjas.filter((f) => f.dia === dia);
            return (
              <View key={dia} style={[estilos.dia, { borderColor: colors.border }]}>
                <View style={estilos.cabeceraDelDia}>
                  <Text variant="body" weight="800">
                    {t(nombreDelDia(dia))}
                  </Text>
                  <Pulsable
                    onPress={() => (abierto === dia ? setAbierto(null) : abrir(dia))}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('availability.addTo', { dia: t(nombreDelDia(dia)) })}
                    style={[estilos.anadir, { borderColor: colors.text }]}
                  >
                    <Feather name={abierto === dia ? 'x' : 'plus'} size={14} color={colors.text} />
                    <Text variant="caption" weight="800">
                      {abierto === dia ? t('common.cancel') : t('availability.add')}
                    </Text>
                  </Pulsable>
                </View>

                {delDia.length === 0 ? (
                  <Text variant="caption" color={colors.textMuted}>
                    {t('availability.none')}
                  </Text>
                ) : (
                  <View style={estilos.franjas}>
                    {delDia.map((franja) => {
                      const texto = `${toHumanTime(franja.desde)} – ${toHumanTime(franja.hasta)}`;
                      return (
                        <View
                          key={`${franja.desde}-${franja.hasta}`}
                          style={[estilos.franja, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}
                        >
                          <Text variant="secondary" weight="700">
                            {texto}
                          </Text>
                          <Pulsable
                            onPress={() => quitar(franja)}
                            hitSlop={10}
                            accessibilityRole="button"
                            accessibilityLabel={t('availability.remove', { franja: texto })}
                          >
                            <Feather name="x" size={15} color={colors.textMuted} />
                          </Pulsable>
                        </View>
                      );
                    })}
                  </View>
                )}

                {abierto === dia ? (
                  <View style={estilos.nueva}>
                    <View style={estilos.horas}>
                      <View style={estilos.mitad}>
                        <TimeField label={t('availability.from')} value={desde} onChange={setDesde} />
                      </View>
                      <View style={estilos.mitad}>
                        <TimeField label={t('availability.to')} value={hasta} onChange={setHasta} />
                      </View>
                    </View>
                    <InlineError message={error} />
                    <Button
                      label={t('availability.addRange')}
                      variant="secondary"
                      icon="plus"
                      onPress={anadir}
                      disabled={!desde || !hasta}
                    />
                  </View>
                ) : null}
              </View>
            );
          })}

          {abierto === null ? <InlineError message={error} /> : null}
          <Button
            label={t('availability.save')}
            icon="check"
            onPress={guardar}
            loading={guardando}
            disabled={!cambiada || guardando}
          />
          <Text variant="caption" color={colors.textMuted}>
            {t('availability.note')}
          </Text>
        </View>
      </AppScreen>
    </View>
  );
}

const estilos = StyleSheet.create({
  columna: { gap: spacing.md, padding: spacing.lg },
  dia: { borderWidth: 1, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm },
  cabeceraDelDia: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  anadir: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 32,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
  },
  franjas: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  franja: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 36,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
  },
  nueva: { gap: spacing.sm },
  horas: { flexDirection: 'row', gap: spacing.sm },
  mitad: { flex: 1 },
});
