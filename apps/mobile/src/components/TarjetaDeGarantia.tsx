import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import {
  partesDeCuentaAtras,
  useGarantia,
} from '@/hooks/useGarantia';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * La garantía de 7 días de un curso comprado.
 *
 * LO QUE TIENE QUE DECIR SIEMPRE es en qué situación está la garantía, y no
 * solo cuando se puede usar. Una tarjeta que aparece únicamente mientras queda
 * plazo deja sin explicación los tres casos en los que alguien va a buscarla:
 * la que todavía no ha empezado, la que venció y la que ya se gastó.
 *
 * LO QUE NO SE ENSEÑA NUNCA: identificadores de pedido, URLs de la pasarela ni
 * códigos internos. El `reason_code` del servidor se traduce a una frase; el
 * `order_id` viaja a la pantalla siguiente sin pasar por la vista.
 *
 * La cuenta atrás sale del reloj del SERVIDOR (ver `hooks/useGarantia.ts`).
 */

type Props = {
  courseId: string;
  /**
   * Si hay una compra de pago con acceso. Apaga la consulta cuando no hay nada
   * que preguntar (curso gratis, sin comprar, o de quien lo gestiona).
   */
  hayCompraPagada: boolean;
};

/** Fecha y hora legibles, en el idioma y la zona del dispositivo. */
function fechaLegible(iso: string | null): string {
  if (!iso) return '';
  const momento = new Date(iso);
  if (Number.isNaN(momento.getTime())) return '';
  return momento.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function TarjetaDeGarantia({ courseId, hayCompraPagada }: Props) {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { t } = useTranslation();
  const { estado, cargando, error, restantes, recargar } = useGarantia(
    courseId,
    hayCompraPagada,
  );

  if (!hayCompraPagada) return null;
  if (cargando && !estado) return null;

  if (error && !estado) {
    return (
      <View style={[styles.tarjeta, { borderColor: colors.border, backgroundColor: colors.surface }]}>
        <Cabecera titulo={t('garantia.titulo')} icono="shield" />
        <Text style={[styles.cuerpo, { color: colors.textMuted }]}>
          {t('garantia.errorCuerpo')}
        </Text>
        <Pressable
          onPress={recargar}
          accessibilityRole="button"
          accessibilityLabel={t('common.retry')}
          style={styles.enlace}
        >
          <Feather name="refresh-cw" size={14} color={colors.text} />
          <Text style={[styles.enlaceTexto, { color: colors.text }]}>{t('common.retry')}</Text>
        </Pressable>
      </View>
    );
  }

  if (!estado) return null;

  /*
    Con la función apagada —o sin la migración— no hay garantía que anunciar, y
    tampoco hay un error que contar: la ficha del curso se pinta igual y esta
    tarjeta simplemente no existe. Lo mismo si el servidor no ve compra: quien
    llega por autoría, por administración o por la beta no compró nada.
  */
  if (estado.motivo === 'disabled' || estado.motivo === 'no_purchase') return null;

  const cuerpo = (() => {
    // 1. Solicitud en curso. Va la primera: mientras haya expediente vivo, lo
    // que importa es en qué punto está, no cuánto plazo quedaba.
    if (estado.solicitudActivaId) {
      const nombreDelEstado = t(
        `devolucion.estado.${estado.solicitudActivaEstado ?? 'requested'}`,
      );
      return (
        <React.Fragment>
          <Text style={[styles.destacado, { color: colors.text }]}>
            {t('garantia.enCurso')}
          </Text>
          <Text style={[styles.cuerpo, { color: colors.textMuted }]}>
            {t('garantia.enCursoCuerpo', { estado: nombreDelEstado })}
          </Text>
          <Pressable
            onPress={() => router.push('/compras' as never)}
            accessibilityRole="button"
            accessibilityLabel={t('garantia.verSolicitud')}
            style={styles.enlace}
          >
            <Feather name="arrow-right" size={14} color={colors.text} />
            <Text style={[styles.enlaceTexto, { color: colors.text }]}>
              {t('garantia.verSolicitud')}
            </Text>
          </Pressable>
        </React.Fragment>
      );
    }

    // 2. Ya se usó. No hay segunda garantía para este curso.
    if (estado.garantiaUsada || estado.motivo === 'already_refunded') {
      return (
        <React.Fragment>
          <Text style={[styles.destacado, { color: colors.text }]}>{t('garantia.usada')}</Text>
          <Text style={[styles.cuerpo, { color: colors.textMuted }]}>
            {t('garantia.usadaCuerpo', { fecha: fechaLegible(estado.garantiaUsadaEn) })}
          </Text>
        </React.Fragment>
      );
    }

    // 3. Todavía no ha empezado: el plazo nace con el primer acceso, no con el
    // pago. Decirlo aquí evita que alguien crea que se le está agotando.
    if (estado.motivo === 'not_started' || !estado.primerAccesoEn) {
      return (
        <React.Fragment>
          <Text style={[styles.destacado, { color: colors.text }]}>
            {t('garantia.noIniciada')}
          </Text>
          <Text style={[styles.cuerpo, { color: colors.textMuted }]}>
            {t('garantia.noIniciadaCuerpo')}
          </Text>
        </React.Fragment>
      );
    }

    // 4. Vencida.
    if (estado.motivo === 'expired' || (!estado.elegible && restantes <= 0)) {
      return (
        <React.Fragment>
          <Text style={[styles.destacado, { color: colors.text }]}>{t('garantia.vencida')}</Text>
          <Text style={[styles.cuerpo, { color: colors.textMuted }]}>
            {t('garantia.vencidaCuerpo', { fecha: fechaLegible(estado.venceEn) })}
          </Text>
        </React.Fragment>
      );
    }

    // 5. Vigente, con cuenta atrás. El botón solo aquí: es el único caso en el
    // que el servidor dijo que sí.
    const { dias, horas, minutos, segundos } = partesDeCuentaAtras(restantes);
    const cuentaAtras =
      dias > 0
        ? t('garantia.restanteConDias', { dias, horas })
        : horas > 0
          ? t('garantia.restanteConHoras', { horas, minutos })
          : t('garantia.restanteConMinutos', { minutos, segundos });

    return (
      <React.Fragment>
        <Text
          style={[styles.destacado, { color: colors.text }]}
          // La cuenta atrás cambia cada segundo: sin esto, un lector de
          // pantalla la leería entera una y otra vez encima de lo que se esté
          // leyendo. Se anuncia solo cuando el foco llega a ella.
          accessibilityLiveRegion="none"
        >
          {cuentaAtras}
        </Text>
        <Text style={[styles.cuerpo, { color: colors.textMuted }]}>
          {t('garantia.inicio', { fecha: fechaLegible(estado.primerAccesoEn) })}
        </Text>
        <Text style={[styles.cuerpo, { color: colors.textMuted }]}>
          {t('garantia.vence', { fecha: fechaLegible(estado.venceEn) })}
        </Text>
        {estado.elegible ? (
          <Button
            label={t('garantia.solicitar')}
            variant="secondary"
            onPress={() =>
              router.push(
                `/devoluciones/nueva?curso=${encodeURIComponent(courseId)}` as never,
              )
            }
            style={styles.boton}
          />
        ) : null}
      </React.Fragment>
    );
  })();

  return (
    <View
      style={[styles.tarjeta, { borderColor: colors.border, backgroundColor: colors.surface }]}
      accessibilityRole="summary"
      accessibilityLabel={t('garantia.titulo')}
    >
      <Cabecera titulo={t('garantia.titulo')} icono="shield" />
      {/* La regla de los 7 días se dice SIEMPRE, en todos los estados: es la
          frase que responde «¿y esto desde cuándo cuenta?». */}
      <Text style={[styles.explicacion, { color: colors.textMuted }]}>
        {t('garantia.explicacion')}
      </Text>
      {cuerpo}
    </View>
  );
}

function Cabecera({
  titulo,
  icono,
}: {
  titulo: string;
  icono: keyof typeof Feather.glyphMap;
}) {
  const { colors } = useAppTheme();
  return (
    <View style={styles.cabecera}>
      <Feather name={icono} size={16} color={colors.text} />
      <Text style={[styles.titulo, { color: colors.text }]}>{titulo}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tarjeta: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.xs,
    marginTop: spacing.xl,
  },
  cabecera: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  titulo: { fontSize: 14, fontWeight: '800' },
  explicacion: { fontSize: 12, lineHeight: 17, marginBottom: spacing.xs },
  destacado: { fontSize: 15, fontWeight: '800', marginTop: spacing.xs },
  cuerpo: { fontSize: 12, lineHeight: 17 },
  boton: { marginTop: spacing.md },
  enlace: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
  },
  enlaceTexto: { fontSize: 13, fontWeight: '700' },
});
