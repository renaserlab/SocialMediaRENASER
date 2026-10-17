import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { DateField } from '@/components/DateField';
import { fromDisplay, toDisplay } from '@/components/DateField.types';
import { InlineError } from '@/components/InlineError';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import type { FiltrosDeCatalogo } from '@/repositories/LearningRepository';
import { spacing } from '@/theme/tokens';

export type FiltrosAdicionalesDeCursos = Pick<FiltrosDeCatalogo, 'puntuacionMinima' | 'orden' | 'desde' | 'antesDe'>;

type Props = {
  valor: FiltrosAdicionalesDeCursos;
  alCambiar: (filtros: FiltrosAdicionalesDeCursos) => void;
};

function ultimoDia(antesDe?: string): string {
  if (!antesDe) return '';
  const fecha = new Date(antesDe);
  fecha.setDate(fecha.getDate() - 1);
  return toDisplay(fecha);
}

/** Se aplican juntos para consultar una sola vez y permitir cancelar la hoja. */
export function FiltrosDeCursos({ valor, alCambiar }: Props) {
  const { t, language } = useTranslation();
  const [abierto, setAbierto] = useState(false);
  const [borrador, setBorrador] = useState<FiltrosAdicionalesDeCursos>({});
  const activos = valor.puntuacionMinima !== undefined || (valor.orden ?? 'recent') !== 'recent' || !!valor.desde || !!valor.antesDe;
  const fechasInvalidas = !!borrador.desde && !!borrador.antesDe && new Date(borrador.desde) >= new Date(borrador.antesDe);
  const estrellas = (n: number) =>
    t('cursos.filtro.estrellas', { n: n.toLocaleString(language) });
  const resumen = [
    valor.puntuacionMinima !== undefined ? estrellas(valor.puntuacionMinima) : null,
    valor.orden && valor.orden !== 'recent' ? t(`cursos.orden.${valor.orden}`) : null,
    valor.desde ? `${t('cursos.filtro.desde')}: ${toDisplay(new Date(valor.desde))}` : null,
    valor.antesDe ? `${t('cursos.filtro.hasta')}: ${ultimoDia(valor.antesDe)}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <View style={styles.raiz}>
      <View style={styles.fila}>
        <Chip
          label={t('cursos.filtro.titulo')}
          icon="sliders"
          rol="button"
          selected={activos}
          onPress={() => {
            setBorrador(valor);
            setAbierto(true);
          }}
        />
        {activos ? (
          <Chip label={t('cursos.filtro.quitar')} rol="button" onPress={() => alCambiar({})} />
        ) : null}
      </View>
      {resumen ? <Text variant="secondary">{resumen}</Text> : null}
      <BottomSheet visible={abierto} onClose={() => setAbierto(false)}>
        <View style={styles.panel}>
          <Text variant="titleMedium" accessibilityRole="header">{t('cursos.filtro.titulo')}</Text>
          <Text variant="secondary">{t('cursos.filtro.alcance')}</Text>
          <DateField
            label={t('cursos.filtro.desde')}
            value={borrador.desde ? toDisplay(new Date(borrador.desde)) : ''}
            onChange={(texto) => setBorrador((previo) => ({ ...previo, desde: fromDisplay(texto)?.toISOString() }))}
          />
          <DateField
            label={t('cursos.filtro.hasta')}
            value={ultimoDia(borrador.antesDe)}
            onChange={(texto) => {
              const fecha = fromDisplay(texto);
              // Medianoche local del día siguiente: incluye el día elegido entero.
              if (fecha) fecha.setDate(fecha.getDate() + 1);
              setBorrador((previo) => ({ ...previo, antesDe: fecha?.toISOString() }));
            }}
          />
          <InlineError message={fechasInvalidas ? t('cursos.filtro.fechasInvalidas') : null} />
          <Text weight="700">{t('cursos.filtro.minima')}</Text>
          <View style={styles.fila}>
            {([undefined, 3, 4, 4.5, 5] as const).map((n) => (
              <Chip
                key={n ?? 'todas'}
                label={n === undefined ? t('cursos.filtro.cualquiera') : estrellas(n)}
                rol="radio"
                selected={borrador.puntuacionMinima === n}
                onPress={() => setBorrador((previo) => ({ ...previo, puntuacionMinima: n }))}
              />
            ))}
          </View>
          <Text weight="700">{t('cursos.filtro.ordenar')}</Text>
          <View style={styles.fila}>
            {(['recent', 'rating', 'reviews'] as const).map((orden) => (
              <Chip
                key={orden}
                label={t(`cursos.orden.${orden}`)}
                rol="radio"
                selected={(borrador.orden ?? 'recent') === orden}
                onPress={() => setBorrador((previo) => ({ ...previo, orden }))}
              />
            ))}
          </View>
          <Button
            label={t('cursos.filtro.aplicar')}
            disabled={fechasInvalidas}
            onPress={() => {
              setAbierto(false);
              alCambiar(borrador);
            }}
          />
          <Button label={t('cursos.filtro.quitar')} variant="secondary" onPress={() => setBorrador({})} />
          <Button label={t('common.cancel')} variant="ghost" onPress={() => setAbierto(false)} />
        </View>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  raiz: { marginHorizontal: spacing.md, marginBottom: spacing.sm, gap: spacing.xs },
  fila: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  panel: { gap: spacing.md },
});
