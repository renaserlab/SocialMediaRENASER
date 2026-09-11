import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  LIMITE_INICIAL,
  cifraDeImporte,
  cifraDeLaComision,
  cifraDeLaComisionDelSaldo,
  cifraDelBruto,
  cifraDelNeto,
  cifraDelNetoDelSaldo,
  claveDeBloqueo,
  claveDeQueHacerConElBloqueo,
  claveDelEstadoDeSaldo,
  esFinanzasNoDisponible,
  llegoAlTope,
  motivoQueManda,
  motivosVisibles,
  siguienteLimite,
  sinVentas,
  tieneReserva,
  tonoDelEstadoDeSaldo,
  type Cifra,
  type ResumenFinanciero,
  type SaldoDeVenta,
} from '@/lib/finanzasDeEventos';
import {
  EventFinanceRepository,
} from '@/repositories/EventFinanceRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/** La fecha, en el idioma del sistema. Vacía si el servidor mandó algo raro. */
function fechaLegible(iso: string | null): string {
  if (!iso) return '';
  const momento = new Date(iso);
  if (Number.isNaN(momento.getTime())) return '';
  return momento.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Ventas y saldo de un evento, para quien lo organiza.
 *
 * SIN COMISIÓN CONFIGURADA NO SE ESCRIBE NINGÚN NETO. El servidor manda
 * `comision_configurada: false` y aquí se lee «pendiente de configuración»:
 * nunca un cero —que diría que Z no se queda nada—, nunca un `-1`, nunca un
 * porcentaje. El BRUTO sí se enseña: cuánto se ha vendido sí se sabe, y es la
 * única cifra de esta pantalla que hoy significa algo.
 *
 * NO HAY NINGUNA FECHA DE COBRO, y no es un olvido. El servidor no manda
 * ninguna —`available_at` llega vacío mientras no haya política de retención— y
 * escribir «te llegará en unos días» sería inventarse un compromiso de la
 * empresa. Lo que sí se dice es POR QUÉ no hay nada disponible todavía, con el
 * motivo que manda el servidor.
 *
 * AQUÍ NO SE MUEVE DINERO NI HAY BOTÓN QUE LO PROMETA. Quien organiza lee lo
 * suyo; soltar una reserva, conciliar o ejecutar transferencias son de
 * administración financiera y ni siquiera se nombran aquí.
 *
 * SIN MONEDA ES ESTADO VACÍO. `currency: null` significa que no hay ni una
 * venta registrada, no que se vendió por cero.
 */
export function VentasYSaldoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { eventId } = useLocalSearchParams<{ eventId: string }>();

  /*
    Las claves de finanzas se están escribiendo en las tablas de idiomas en
    paralelo. El molde es el mismo `t`: cuando lleguen, esto no cambia.
  */
  const f = useCallback(
    (clave: string, params?: Record<string, string | number>) =>
      t(clave as TranslationKey, params),
    [t],
  );

  const [resumen, setResumen] = useState<ResumenFinanciero | null>(null);
  const [saldos, setSaldos] = useState<SaldoDeVenta[]>([]);
  const [limite, setLimite] = useState<number>(LIMITE_INICIAL);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'sinPermiso' | 'noEncontrado' | 'noDisponible' | null
  >(null);

  const cargar = useCallback(async () => {
    if (!eventId) return;
    setCargando(true);
    setFallo(null);
    try {
      const datos = await EventFinanceRepository.resumen(eventId);
      setResumen(datos);
      // El detalle no tumba la pantalla: el resumen ya se leyó.
      setSaldos(await EventFinanceRepository.saldos(eventId, limite).catch(() => []));
    } catch (error) {
      if (error instanceof ApiError && esFinanzasNoDisponible(error.code)) {
        setFallo('noDisponible');
      } else if (error instanceof ApiError && error.status === 403) {
        setFallo('sinPermiso');
      } else if (error instanceof ApiError && error.status === 404) {
        // 404 AL EVENTO AJENO, y así se cuenta: el servidor no confirma que el
        // evento de otra persona exista, y aquí tampoco.
        setFallo('noEncontrado');
      } else if (error instanceof ApiError && esFalloDeRed(error.code)) {
        setFallo('sinConexion');
      } else {
        setFallo('red');
      }
    } finally {
      setCargando(false);
    }
  }, [eventId, limite]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/mis-eventos' as never);

  /** Un hueco de número: la cifra, o por qué no hay ninguna. */
  const textoDeCifra = (cifra: Cifra): string => {
    if (cifra.estado === 'cifra') return cifra.texto;
    if (cifra.estado === 'pendienteDeConfiguracion') {
      return f('finanzasEvento.pendienteDeConfiguracion');
    }
    return f('finanzasEvento.sinCifra');
  };

  const linea = (etiqueta: string, cifra: Cifra, atenuada = false) => (
    <View style={styles.linea}>
      <Text variant="secondary" color={colors.textMuted}>
        {etiqueta}
      </Text>
      <Text
        variant="secondary"
        weight="700"
        color={
          atenuada || cifra.estado !== 'cifra' ? colors.textMuted : colors.text
        }
      >
        {textoDeCifra(cifra)}
      </Text>
    </View>
  );

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('finanzasEvento.tituloOrganizador')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || resumen === null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('finanzasEvento.tituloOrganizador')} onBack={volver} />
        {fallo === 'noDisponible' || fallo === 'sinPermiso' || fallo === 'noEncontrado' ? (
          <StateView
            state="empty"
            icon={
              fallo === 'noDisponible'
                ? 'clock'
                : fallo === 'sinPermiso'
                  ? 'lock'
                  : 'inbox'
            }
            title={
              fallo === 'noDisponible'
                ? f('finanzasEvento.noDisponible')
                : fallo === 'sinPermiso'
                  ? f('finanzasEvento.sinPermiso')
                  : f('finanzasEvento.eventoNoEncontrado')
            }
            description={
              fallo === 'noDisponible'
                ? f('finanzasEvento.noDisponibleCuerpo')
                : fallo === 'sinPermiso'
                  ? f('finanzasEvento.sinPermisoCuerpo')
                  : f('finanzasEvento.eventoNoEncontradoCuerpo')
            }
          />
        ) : (
          <StateView
            state={fallo === 'sinConexion' ? 'offline' : 'error'}
            description={fallo === 'sinConexion' ? undefined : t('common.loadFailed')}
            onRetry={() => void cargar()}
          />
        )}
      </AppScreen>
    );
  }

  const vacio = sinVentas(resumen);
  const motivos = motivosVisibles(resumen.motivos);
  const motivoPrincipal = motivoQueManda(resumen.motivos);
  const masArriba = siguienteLimite(limite);
  const tope = llegoAlTope(saldos.length, limite);

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('finanzasEvento.tituloOrganizador')} onBack={volver} />

      {/* LA COMISIÓN SIN DECIDIR SE DICE LA PRIMERA. Lo que se lee debajo
          depende de ella, y leer un neto vacío sin saber por qué desconcierta. */}
      {!resumen.comision_configurada ? (
        <View style={[styles.recuadro, { borderColor: colors.border }]}>
          <Text variant="secondary" weight="700">
            {f('finanzasEvento.comisionPendiente')}
          </Text>
          <Text variant="caption" color={colors.textMuted}>
            {f('finanzasEvento.comisionPendienteCuerpo')}
          </Text>
        </View>
      ) : null}

      {vacio ? (
        <StateView
          state="empty"
          icon="inbox"
          title={f('finanzasEvento.sinVentas')}
          description={f('finanzasEvento.sinVentasCuerpo')}
          onRetry={() => void cargar()}
        />
      ) : (
        <View style={[styles.recuadro, { borderColor: colors.border }]}>
          <Text variant="caption" color={colors.textMuted}>
            {f('finanzasEvento.ventas', { n: resumen.ventas })}
          </Text>
          {linea(f('finanzasEvento.bruto'), cifraDelBruto(resumen))}
          {linea(f('finanzasEvento.comision'), cifraDeLaComision(resumen))}
          {linea(f('finanzasEvento.neto'), cifraDelNeto(resumen))}
        </View>
      )}

      {!vacio ? (
        <View style={[styles.recuadro, { borderColor: colors.border }]}>
          <Text variant="secondary" weight="700">
            {f('finanzasEvento.dondeEsta')}
          </Text>
          {linea(
            f('finanzasEvento.retenido'),
            cifraDeImporte(resumen.retenido_minor, resumen.currency),
          )}
          {linea(
            f('finanzasEvento.reservado'),
            cifraDeImporte(resumen.reservado_minor, resumen.currency),
          )}
          {linea(
            f('finanzasEvento.disponible'),
            cifraDeImporte(resumen.disponible_minor, resumen.currency),
          )}
          {linea(
            f('finanzasEvento.transferido'),
            cifraDeImporte(resumen.transferido_minor, resumen.currency),
          )}
          {/* NI UNA FECHA DE PAGO. El servidor no manda ninguna. */}
          <Text variant="caption" color={colors.textMuted}>
            {f('finanzasEvento.sinFechaDePago')}
          </Text>
        </View>
      ) : null}

      {/* EL MOTIVO QUE MANDA, UNO, EN FRASE. El código crudo no se enseña. */}
      {motivoPrincipal !== null ? (
        <View style={[styles.recuadro, { borderColor: colors.border }]}>
          <Text variant="secondary" weight="700">
            {f('finanzasEvento.porQueNoSeLibera')}
          </Text>
          <Text variant="secondary">
            {f(claveDeBloqueo(motivoPrincipal))}
          </Text>
          <Text variant="caption" color={colors.textMuted}>
            {f(claveDeQueHacerConElBloqueo(motivoPrincipal))}
          </Text>
          {motivos.slice(1).map((motivo) => (
            <Text key={motivo} variant="caption" color={colors.textMuted}>
              {f(claveDeBloqueo(motivo))}
            </Text>
          ))}
        </View>
      ) : null}

      {!vacio ? (
        <Text variant="caption" color={colors.textMuted}>
          {f('finanzasEvento.detalleTitulo')}
        </Text>
      ) : null}

      {!vacio && saldos.length === 0 ? (
        <Text variant="secondary" color={colors.textMuted}>
          {f('finanzasEvento.detalleVacio')}
        </Text>
      ) : null}

      {saldos.map((saldo) => {
        const tono = tonoDelEstadoDeSaldo(saldo.status);
        const colorDelEstado =
          tono === 'bueno'
            ? colors.success
            : tono === 'malo'
              ? colors.danger
              : colors.textMuted;
        const fecha = fechaLegible(saldo.created_at);
        return (
          <View key={saldo.id} style={[styles.fila, { borderColor: colors.border }]}>
            <Text variant="secondary" weight="700" color={colorDelEstado}>
              {f(claveDelEstadoDeSaldo(saldo.status))}
            </Text>
            {linea(
              f('finanzasEvento.bruto'),
              cifraDeImporte(saldo.gross_amount_minor, saldo.currency),
            )}
            {linea(f('finanzasEvento.comision'), cifraDeLaComisionDelSaldo(saldo))}
            {linea(f('finanzasEvento.neto'), cifraDelNetoDelSaldo(saldo))}
            {tieneReserva(saldo) ? (
              <Text variant="caption" color={colors.textMuted}>
                {f('finanzasEvento.reservadoDeEsteSaldo', {
                  importe:
                    textoDeCifra(cifraDeImporte(saldo.reserved_minor, saldo.currency)),
                })}
              </Text>
            ) : null}
            {/* UN SOLO MOTIVO, EL DEL SERVIDOR, EN FRASE. */}
            {saldo.bloqueo !== null ? (
              <Text variant="caption" color={colors.textMuted}>
                {f(claveDeBloqueo(saldo.bloqueo))}
              </Text>
            ) : null}
            {fecha !== '' ? (
              <Text variant="caption" color={colors.textMuted}>
                {f('finanzasEvento.vendidoEl', { fecha })}
              </Text>
            ) : null}
          </View>
        );
      })}

      {/* EL TOPE SE DICE: el servidor no pagina esta lista. */}
      {tope ? (
        <Text variant="caption" color={colors.textMuted}>
          {f('finanzasEvento.tope', { n: limite })}
        </Text>
      ) : null}
      {tope && masArriba !== null ? (
        <Button
          label={f('finanzasEvento.verMas', { n: masArriba })}
          variant="secondary"
          onPress={() => setLimite(masArriba)}
        />
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  recuadro: {
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  fila: {
    gap: 4,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  linea: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
});
