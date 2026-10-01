import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import {
  EJES_DE_LA_RESENA,
  claveDelEje,
  estrellas,
  momentoLegible,
  recomendacionLegible,
  type PaginaDeResenas,
  type Resena,
} from '@/lib/serviciosAtencion';
import { useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceCareRepository } from '@/repositories/ServiceCareRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * LAS RESEÑAS PUBLICADAS de un servicio, bajo su resumen en la ficha: cada una
 * VERIFICADA (de una atención que se realizó), con su comentario y, si la
 * hay, la respuesta del prestador.
 *
 * Si el servidor dice que todavía no hay reseñas que enseñar (`available:
 * false`), si no hay ninguna o si no se pudieron leer, NO SE ENSEÑA NADA: la
 * ficha ya dice «todavía no hay reseñas», y aquí no se inventa una nota.
 */
export function ListaDeResenasDelServicio({ servicio }: { servicio: string }) {
  const { colors } = useAppTheme();
  const { f } = useTextosDeServicios('reserva');
  const [pagina, setPagina] = useState<PaginaDeResenas | null>(null);
  const [resenas, setResenas] = useState<Resena[]>([]);
  const [cargandoMas, setCargandoMas] = useState(false);
  const vigente = useRef(0);

  useEffect(() => {
    const esta = ++vigente.current;
    setPagina(null);
    setResenas([]);
    ServiceCareRepository.resenasDelServicio(servicio, null)
      .then((p) => {
        if (esta !== vigente.current) return;
        setPagina(p);
        setResenas(p.items);
      })
      .catch(() => {
        // La ficha sigue sin esta sección; su resumen ya lo dijo el servidor.
      });
  }, [servicio]);

  const mas = useCallback(async () => {
    if (!pagina?.next_cursor || cargandoMas) return;
    const esta = vigente.current;
    setCargandoMas(true);
    try {
      const p = await ServiceCareRepository.resenasDelServicio(servicio, pagina.next_cursor);
      if (esta !== vigente.current) return;
      setPagina(p);
      setResenas((ya) => [...ya, ...p.items.filter((x) => !ya.some((y) => y.id === x.id))]);
    } catch {
      // Se queda con lo que ya se ve.
    } finally {
      setCargandoMas(false);
    }
  }, [cargandoMas, pagina, servicio]);

  if (pagina === null || !pagina.available || resenas.length === 0) return null;

  const recomiendan = recomendacionLegible(pagina.summary);
  const ejes = EJES_DE_LA_RESENA.filter((eje) => typeof pagina.summary?.by_axis[eje] === 'number');

  return (
    <View style={styles.bloque}>
      {recomiendan ? <Text variant="secondary">{f(recomiendan.clave, recomiendan.params)}</Text> : null}
      {ejes.length > 0 ? (
        <Text variant="caption" color={colors.textMuted}>
          {ejes.map((eje) => `${f(claveDelEje(eje))} ${(pagina.summary?.by_axis[eje] as number).toFixed(1)}`).join(' · ')}
        </Text>
      ) : null}
      {resenas.map((r) => (
        <View key={r.id} style={[styles.resena, { borderColor: colors.border }]}>
          <Text accessibilityLabel={f('servicios.atencion.resena.notaLeida', { n: r.rating })}>{estrellas(r.rating)}</Text>
          <Text variant="secondary">{r.comment}</Text>
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.atencion.resenas.verificada', { fecha: momentoLegible(r.created_at) })}
          </Text>
          {r.reply ? (
            <Text variant="secondary">{f('servicios.atencion.resena.respuesta', { texto: r.reply })}</Text>
          ) : null}
        </View>
      ))}
      {pagina.next_cursor ? (
        <Button
          label={f('servicios.reserva.verMas')}
          variant="ghost"
          loading={cargandoMas}
          disabled={cargandoMas}
          onPress={() => void mas()}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bloque: { gap: spacing.sm },
  resena: { gap: spacing.xs, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.sm },
});
