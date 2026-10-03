import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { importeConMoneda } from '@/lib/dinero';
import {
  MODOS_OFRECIDOS,
  claveDeErrorDeEntradas,
  claveDelModo,
  enteroEscrito,
  motivoParaNoGuardarTipo,
  vendeEntradas,
} from '@/lib/entradasDeEvento';
import { toast } from '@/lib/toast';
import {
  EventTicketAdminRepository,
  type ConfiguracionDeVenta,
  type TipoDelOrganizador,
} from '@/repositories/EventTicketRepository';
import { EventOrganizerRepository } from '@/repositories/EventOrganizerRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

const vacio = () => ({ nombre: '', descripcion: '', precio: '', cupo: '', minimo: '1', maximo: '10' });

/**
 * La consola de entradas del organizador. NO es una consola financiera.
 *
 * Lo que hay: el modo de acceso, la moneda y los tipos de entrada con su
 * precio, su cupo y sus topes. Lo que no hay: ventas, saldos, comisiones,
 * liquidaciones ni conciliación, porque no existe ninguna de esas cosas.
 *
 * LA SUMA DE LOS CUPOS FRENTE AL AFORO se enseña siempre, porque es la
 * comprobación que nadie hace de cabeza: tres tipos de cien en una sala de
 * doscientos venden cien entradas que no caben.
 */
export function ConfigurarEntradasScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [config, setConfig] = useState<ConfiguracionDeVenta | null>(null);
  const [tipos, setTipos] = useState<TipoDelOrganizador[]>([]);
  const [aforo, setAforo] = useState<number | null>(null);
  const [nuevo, setNuevo] = useState(vacio);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<'red' | 'noDisponible' | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  const cargar = useCallback(async () => {
    if (!id) return;
    setCargando(true);
    setFallo(null);
    try {
      const [ajustes, evento] = await Promise.all([
        EventTicketAdminRepository.configuracion(id),
        EventOrganizerRepository.leer(id),
      ]);
      setConfig(ajustes);
      // EL AFORO APROBADO manda sobre el declarado: se pudo pedir 300 y
      // aprobarse 200, y los cupos tienen que caber en lo aprobado.
      setAforo(evento.approved_capacity ?? evento.capacity);
      setTipos(
        vendeEntradas(ajustes.access_mode)
          ? await EventTicketAdminRepository.tipos(id)
          : [],
      );
    } catch (error) {
      setFallo(
        error instanceof ApiError &&
          error.code === 'event_ticketing_not_available'
          ? 'noDisponible'
          : 'red',
      );
    } finally {
      setCargando(false);
    }
  }, [id]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const conCerrojo = async (accion: () => Promise<void>) => {
    if (ocupadoRef.current || !id) return;
    ocupadoRef.current = true;
    setOcupado(true);
    try {
      await accion();
    } catch (error) {
      // POR CODIGO, no por el texto del servidor, que siempre viene en espanol.
      const clave =
        error instanceof ApiError ? claveDeErrorDeEntradas(error.code) : null;
      notify(
        t('common.saveFailed'),
        clave !== null
          ? t(clave as TranslationKey)
          : error instanceof Error && error.message.trim() !== ''
            ? error.message
            : t('common.tryAgain'),
      );
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  const cambiarModo = (modo: string) =>
    void conCerrojo(async () => {
      const ajustes = await EventTicketAdminRepository.guardarConfiguracion(id as string, {
        access_mode: modo,
        currency: config?.currency ?? 'PEN',
        max_per_order: config?.max_per_order ?? null,
      });
      setConfig(ajustes);
      await cargar();
    });

  const crear = () =>
    void conCerrojo(async () => {
      const falta = motivoParaNoGuardarTipo(nuevo);
      if (falta) {
        notify(t('entradas.noSePuedeGuardar'), t(falta as TranslationKey));
        return;
      }
      await EventTicketAdminRepository.crearTipo(id as string, {
        name: nuevo.nombre.trim(),
        description: nuevo.descripcion.trim(),
        price_minor: enteroEscrito(nuevo.precio) as number,
        quota: enteroEscrito(nuevo.cupo) as number,
        min_per_order: enteroEscrito(nuevo.minimo) as number,
        max_per_order: enteroEscrito(nuevo.maximo) as number,
      });
      setNuevo(vacio());
      toast(t('entradas.tipoCreado'));
      await cargar();
    });

  const alternarVenta = (tipo: TipoDelOrganizador) =>
    void conCerrojo(async () => {
      await EventTicketAdminRepository.editarTipo(id as string, tipo.id, {
        status: tipo.status === 'on_sale' ? 'paused' : 'on_sale',
      });
      await cargar();
    });

  const retirar = (tipo: TipoDelOrganizador) =>
    void conCerrojo(async () => {
      const aceptado = await confirm({
        title: t('entradas.retirarTitulo'),
        message: t('entradas.retirarCuerpo'),
        confirmLabel: t('entradas.retirar'),
        destructive: true,
      });
      if (!aceptado) return;
      await EventTicketAdminRepository.retirarTipo(id as string, tipo.id);
      await cargar();
    });

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/mis-eventos' as never);

  // A pantalla completa SOLO la primera vez: cada cambio vuelve a pedir la
  // configuración, y desmontar el formulario por un «Cargando…» borraba de la
  // vista lo que se acababa de tocar.
  if (cargando && config === null) {
    return (
      <AppScreen>
        <AppHeader title={t('entradas.configurar')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
    return (
      <AppScreen>
        <AppHeader title={t('entradas.configurar')} onBack={volver} />
        {fallo === 'red' ? (
          <StateView
            state="error"
            description={t('common.loadFailed')}
            onRetry={() => void cargar()}
          />
        ) : (
          <StateView
            state="empty"
            title={t('entradas.noDisponible')}
            description={t('entradas.noDisponibleCuerpo')}
          />
        )}
      </AppScreen>
    );
  }

  const vendidos = tipos.filter((tipo) => tipo.status !== 'retired');
  const sumaDeCupos = vendidos.reduce((suma, tipo) => suma + tipo.quota, 0);
  const seLePasa = aforo !== null && sumaDeCupos > aforo;

  return (
    <SinTecladoDelante>
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={t('entradas.configurar')} onBack={volver} />

        <Text variant="caption" color={colors.textMuted}>
          {t('entradas.modoDeAcceso')}
        </Text>
        <View style={styles.fichas}>
          {MODOS_OFRECIDOS.map((modo) => {
            const elegido = config?.access_mode === modo;
            return (
              <Pressable
                key={modo}
                disabled={ocupado}
                onPress={() => cambiarModo(modo)}
                style={[
                  styles.ficha,
                  {
                    borderColor: elegido ? colors.primary : colors.border,
                    backgroundColor: elegido ? colors.primary : 'transparent',
                  },
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected: elegido }}
              >
                <Text variant="caption" color={elegido ? colors.onPrimary : colors.text}>
                  {t(claveDelModo(modo) as TranslationKey)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/*
          UN MODO QUE ESTA PANTALLA NO OFRECE SE NOMBRA. `INVITATION_ONLY` está
          en el contrato y no tiene flujo, así que no aparece entre las fichas;
          si un evento lo tiene puesto por otra vía, las dos fichas salían sin
          seleccionar y debajo se leía «Con reserva gratuita no hay entradas que
          configurar», que no es lo que ese evento es.
        */}
        {config !== null && !MODOS_OFRECIDOS.includes(config.access_mode as never) ? (
          <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
            <Text variant="caption" color={colors.textMuted}>
              {t('entradas.modoSinFlujo', {
                modo: t(claveDelModo(config.access_mode) as TranslationKey),
              })}
            </Text>
          </View>
        ) : !vendeEntradas(config?.access_mode) ? (
          <Text variant="caption" color={colors.textMuted}>
            {t('entradas.gratuitoExplicado')}
          </Text>
        ) : (
          <>
            <Text variant="caption" color={colors.textMuted}>
              {t('entradas.moneda', { moneda: config?.currency ?? 'PEN' })}
            </Text>

            {/* LA SUMA DE LOS CUPOS FRENTE AL AFORO. */}
            <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
              <Feather
                name={seLePasa ? 'alert-triangle' : 'check'}
                size={16}
                color={seLePasa ? colors.danger : colors.textMuted}
              />
              <Text
                variant="caption"
                color={seLePasa ? colors.danger : colors.textMuted}
                style={styles.crece}
              >
                {aforo === null
                  ? t('entradas.sumaSinAforo', { suma: sumaDeCupos })
                  : t('entradas.sumaDeCupos', { suma: sumaDeCupos, aforo })}
              </Text>
            </View>

            {vendidos.map((tipo) => (
              <View key={tipo.id} style={[styles.tipo, { borderColor: colors.border }]}>
                <View style={styles.crece}>
                  <Text variant="secondary" weight="700">
                    {tipo.name}
                  </Text>
                  <Text variant="caption" color={colors.textMuted}>
                    {importeConMoneda(tipo.price_minor, tipo.currency)} ·{' '}
                    {t('entradas.cupoYdisponibles', {
                      cupo: tipo.quota,
                      quedan: tipo.disponibles,
                    })}
                  </Text>
                  <Text variant="caption" color={colors.textMuted}>
                    {t(`entradas.estado.${tipo.status}` as TranslationKey)}
                  </Text>
                </View>
                <Pressable
                  disabled={ocupado}
                  onPress={() => alternarVenta(tipo)}
                  style={[styles.boton, { borderColor: colors.border }]}
                  accessibilityRole="button"
                  accessibilityLabel={t(
                    tipo.status === 'on_sale'
                      ? 'entradas.pausarTipo'
                      : 'entradas.ponerALaVentaTipo',
                    { tipo: tipo.name },
                  )}
                >
                  <Feather
                    name={tipo.status === 'on_sale' ? 'pause' : 'play'}
                    size={16}
                    color={colors.text}
                  />
                </Pressable>
                <Pressable
                  disabled={ocupado}
                  onPress={() => retirar(tipo)}
                  style={[styles.boton, { borderColor: colors.border }]}
                  accessibilityRole="button"
                  accessibilityLabel={t('entradas.retirarTipo', { tipo: tipo.name })}
                >
                  <Feather name="archive" size={16} color={colors.text} />
                </Pressable>
              </View>
            ))}

            <Text variant="secondary" weight="700">
              {t('entradas.nuevoTipo')}
            </Text>
            <Input
              label={t('entradas.campoNombre')}
              value={nuevo.nombre}
              onChangeText={(v) => setNuevo({ ...nuevo, nombre: v })}
              editable={!ocupado}
              maxLength={80}
            />
            <Input
              label={t('entradas.campoDescripcion')}
              value={nuevo.descripcion}
              onChangeText={(v) => setNuevo({ ...nuevo, descripcion: v })}
              editable={!ocupado}
              maxLength={500}
            />
            <Input
              label={t('entradas.campoPrecio', { moneda: config?.currency ?? 'PEN' })}
              value={nuevo.precio}
              onChangeText={(v) => setNuevo({ ...nuevo, precio: v.replace(/[^0-9]/g, '') })}
              editable={!ocupado}
              keyboardType="number-pad"
              maxLength={9}
            />
            <Text variant="caption" color={colors.textMuted}>
              {/* EL EJEMPLO, EN LA MONEDA DEL EVENTO. Fijaba «S/ 49.00»
                  tambien para un evento en dolares. */}
              {t('entradas.precioEnCentavos', {
                ejemplo: importeConMoneda(4900, config?.currency ?? ''),
              })}
            </Text>
            <Input
              label={t('entradas.campoCupo')}
              value={nuevo.cupo}
              onChangeText={(v) => setNuevo({ ...nuevo, cupo: v.replace(/[^0-9]/g, '') })}
              editable={!ocupado}
              keyboardType="number-pad"
              maxLength={7}
            />
            <Input
              label={t('entradas.campoMinimo')}
              value={nuevo.minimo}
              onChangeText={(v) => setNuevo({ ...nuevo, minimo: v.replace(/[^0-9]/g, '') })}
              editable={!ocupado}
              keyboardType="number-pad"
              maxLength={3}
            />
            <Input
              label={t('entradas.campoMaximo')}
              value={nuevo.maximo}
              onChangeText={(v) => setNuevo({ ...nuevo, maximo: v.replace(/[^0-9]/g, '') })}
              editable={!ocupado}
              keyboardType="number-pad"
              maxLength={3}
            />
            <Button
              label={t('entradas.crearTipo')}
              onPress={crear}
              loading={ocupado}
              disabled={ocupado}
            />
          </>
        )}
      </AppScreen>
    </SinTecladoDelante>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  crece: { flex: 1, gap: 4 },
  fichas: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  ficha: {
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    // 44, QUE ES EL MÍNIMO. Con 36 la ficha se pulsaba mal en un teléfono, y
    // aquí lo que se pulsa mal es la decisión de si el evento cobra o no.
    minHeight: 44,
    justifyContent: 'center',
  },
  tipo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  boton: {
    borderWidth: 1,
    borderRadius: radius.lg,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aviso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
});
