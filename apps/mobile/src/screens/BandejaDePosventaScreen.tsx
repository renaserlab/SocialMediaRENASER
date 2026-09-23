import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  ESTADOS_DE_EXPEDIENTE,
  claveDelEstadoDeExpediente,
  claveDelTipoDeExpediente,
  esPosventaApagada,
  expedienteCerrado,
} from '@/lib/posventaDeEventos';
import {
  LIMITE_INICIAL,
  claveDeFaseDelDinero,
  faseDelDinero,
  filtroDeEvento,
  llegoAlTope,
  siguienteLimite,
  tonoDeLaFase,
} from '@/lib/posventaAdmin';
import {
  EventAftersaleAdminRepository,
  type ExpedienteDeAdministracion,
} from '@/repositories/EventAftersaleAdminRepository';
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
 * La bandeja de posventa: los expedientes que hay que revisar.
 *
 * QUIÉN PUEDE ABRIRLA LO DECIDE EL SERVIDOR. Esta pantalla no comprueba ningún
 * rol: quien no administra el dinero recibe un 403 y aquí se enseña el aviso
 * correspondiente. Ocultar la pantalla sería comodidad, no protección; y
 * convertir el 403 en un «no hay nada» diría algo distinto de lo que pasa.
 *
 * NO PAGINA, Y SE DICE. El servidor acepta un `limit` de hasta 200 y no manda
 * cursor: fingir un «cargar más» infinito haría creer que se está viendo todo.
 * Se sube el tope, se enseña cuál es, y se invita a filtrar.
 *
 * LA FILA NO DICE «DEVUELTO» POR ESTAR APROBADA. Cada expediente que ha tocado
 * dinero enseña en qué punto está —aprobado, pedido al proveedor, en curso o
 * confirmado—, porque los cuatro se leen distinto y solo el último significa
 * que el dinero volvió.
 */
export function BandejaDePosventaScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();

  const [expedientes, setExpedientes] = useState<ExpedienteDeAdministracion[]>([]);
  const [estado, setEstado] = useState<string | null>(null);
  const [eventoEscrito, setEventoEscrito] = useState('');
  const [eventoFiltrado, setEventoFiltrado] = useState<string | null>(null);
  const [limite, setLimite] = useState<number>(LIMITE_INICIAL);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'sinPermiso' | 'noDisponible' | null
  >(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      const filas = await EventAftersaleAdminRepository.bandeja({
        estado,
        eventoId: eventoFiltrado,
        limite,
      });
      setExpedientes(filas);
    } catch (error) {
      if (error instanceof ApiError && esPosventaApagada(error.code)) {
        setFallo('noDisponible');
      } else if (error instanceof ApiError && error.status === 403) {
        setFallo('sinPermiso');
      } else if (error instanceof ApiError && esFalloDeRed(error.code)) {
        setFallo('sinConexion');
      } else {
        setFallo('red');
      }
    } finally {
      setCargando(false);
    }
  }, [estado, eventoFiltrado, limite]);

  // AL VOLVER SE RECARGA. Quien entra a un expediente y decide algo vuelve
  // aquí: sin esto, la bandeja seguiría diciendo el estado de antes.
  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  const aplicarEvento = () => {
    setLimite(LIMITE_INICIAL);
    setEventoFiltrado(filtroDeEvento(eventoEscrito));
  };

  const quitarEvento = () => {
    setEventoEscrito('');
    setLimite(LIMITE_INICIAL);
    setEventoFiltrado(null);
  };

  const elegirEstado = (valor: string | null) => {
    setLimite(LIMITE_INICIAL);
    setEstado(valor);
  };

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));

  const masArriba = siguienteLimite(limite);
  const tope = llegoAlTope(expedientes.length, limite);

  const filtros = (
    <View style={styles.filtros}>
      <Text variant="caption" color={colors.textMuted}>
        {t('posventaAdmin.filtroEstado')}
      </Text>
      <View style={styles.chips}>
        <Chip
          label={t('posventaAdmin.filtroTodos')}
          selected={estado === null}
          rol="radio"
          onPress={() => elegirEstado(null)}
        />
        {ESTADOS_DE_EXPEDIENTE.map((valor) => (
          <Chip
            key={valor}
            label={t(claveDelEstadoDeExpediente(valor) as TranslationKey)}
            selected={estado === valor}
            rol="radio"
            onPress={() => elegirEstado(valor)}
          />
        ))}
      </View>

      <Input
        label={t('posventaAdmin.filtroEvento')}
        placeholder={t('posventaAdmin.filtroEventoAyuda')}
        value={eventoEscrito}
        onChangeText={setEventoEscrito}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View style={styles.chips}>
        <Button
          label={t('posventaAdmin.filtroAplicar')}
          variant="secondary"
          onPress={aplicarEvento}
          disabled={filtroDeEvento(eventoEscrito) === eventoFiltrado}
        />
        {eventoFiltrado !== null ? (
          <Button
            label={t('posventaAdmin.filtroQuitar')}
            variant="ghost"
            onPress={quitarEvento}
          />
        ) : null}
      </View>
    </View>
  );

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={t('posventaAdmin.tituloBandeja')} onBack={volver} />
        {filtros}
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={t('posventaAdmin.tituloBandeja')} onBack={volver} />
        {fallo === 'sinPermiso' || fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            icon={fallo === 'noDisponible' ? 'clock' : 'lock'}
            title={
              fallo === 'noDisponible'
                ? t('posventaAdmin.noDisponible')
                : t('posventaAdmin.sinPermiso')
            }
            description={
              fallo === 'noDisponible'
                ? t('posventaAdmin.noDisponibleCuerpo')
                : t('posventaAdmin.sinPermisoCuerpo')
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

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={t('posventaAdmin.tituloBandeja')} onBack={volver} />
      {filtros}

      {expedientes.length === 0 ? (
        <StateView
          state="empty"
          title={t('posventaAdmin.bandejaVacia')}
          description={t('posventaAdmin.bandejaVaciaCuerpo')}
          onRetry={() => void cargar()}
        />
      ) : (
        expedientes.map((expediente) => {
          const cerrado = expedienteCerrado(expediente.status);
          const tipo = t(claveDelTipoDeExpediente(expediente.kind) as TranslationKey);
          const fecha = fechaLegible(expediente.created_at);
          const fase = faseDelDinero(expediente.status, expediente.outcome);
          const tono = fase === null ? 'neutro' : tonoDeLaFase(fase);
          const colorDeLaFase =
            tono === 'bueno'
              ? colors.success
              : tono === 'malo'
                ? colors.danger
                : colors.textMuted;
          return (
            <Pressable
              key={expediente.id}
              onPress={() =>
                router.push(
                  `/admin/posventa/${expediente.id}?evento=${expediente.event_id}` as never,
                )
              }
              style={[
                styles.fila,
                { borderColor: colors.border, opacity: cerrado ? 0.6 : 1 },
              ]}
              accessibilityRole="button"
              accessibilityLabel={t('posventaAdmin.abrirExpediente', { tipo })}
            >
              <View style={styles.crece}>
                <Text variant="secondary" weight="700">
                  {tipo}
                </Text>
                <Text variant="caption" color={colors.textMuted}>
                  {t(claveDelEstadoDeExpediente(expediente.status) as TranslationKey)}
                </Text>
                {/* APROBADO NO ES PAGADO, TAMPOCO EN LA LISTA. */}
                {fase !== null ? (
                  <Text variant="caption" color={colorDeLaFase}>
                    {t(claveDeFaseDelDinero(fase) as TranslationKey)}
                  </Text>
                ) : null}
                <Text variant="caption" color={colors.textMuted}>
                  {expediente.assignee_id !== null
                    ? t('posventaAdmin.tomado')
                    : t('posventaAdmin.sinTomar')}
                </Text>
                {fecha !== '' ? (
                  <Text variant="caption" color={colors.textMuted}>
                    {t('posventa.abiertaEl', { fecha })}
                  </Text>
                ) : null}
              </View>
              <Feather name="chevron-right" size={18} color={colors.textMuted} />
            </Pressable>
          );
        })
      )}

      {/* EL TOPE SE DICE. Sin esto, «cincuenta expedientes» se lee como «hay
          cincuenta expedientes», y puede haber trescientos. */}
      {tope ? (
        <Text variant="caption" color={colors.textMuted}>
          {t('posventaAdmin.tope', { n: limite })}
        </Text>
      ) : null}
      {tope && masArriba !== null ? (
        <Button
          label={t('posventaAdmin.verMas', { n: masArriba })}
          variant="secondary"
          onPress={() => setLimite(masArriba)}
        />
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  filtros: { gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  crece: { flex: 1, gap: 4 },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    minHeight: 44,
  },
});
