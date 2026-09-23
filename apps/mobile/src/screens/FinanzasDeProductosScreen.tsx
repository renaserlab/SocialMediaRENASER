import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm } from '@/lib/confirm';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  type DevolucionDeProducto,
  type SaldoDeProducto,
  type SaludFinanciera,
  claveDeErrorFinanciero,
  claveDelBloqueo,
  claveDelEstadoDeDevolucion,
  claveDelEstadoDeDisputa,
  contadoresDelPanel,
  elDineroYaVolvio,
  esFinanzasApagadas,
  importe,
  importeDeLaDevolucion,
  puedeMoverDinero,
  queLeFaltaAlPanel,
  sePuedeAnular,
  sePuedePedir,
} from '@/lib/finanzasDeProductos';
import { esFaltaDeSesion } from '@/lib/productos';
import {
  ProductFinanceAdminRepository,
  type Disputa,
} from '@/repositories/ProductFinanceRepository';
import { useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * El panel financiero de Productos.
 *
 * ESTE PANEL NO MUEVE DINERO, y lo dice arriba del todo. Dice cuánto hay, qué
 * está bloqueado y por qué, y qué falta para que el dinero pueda salir. Lo que
 * falta —la comisión, Stripe Connect confirmado para el país y el rubro, las
 * transferencias encendidas— no lo decide el código.
 *
 * NO HAY BOTÓN DE TRANSFERIR. No existe la ruta tampoco: ejecutar una
 * transferencia con Connect sin confirmar devolvería un fallo, pero el botón
 * existiendo ya sería una promesa.
 *
 * APROBAR NO ES PAGAR, y se repite donde se decide. El dinero sale cuando la
 * pasarela lo confirma, y solo entonces la pantalla dice que volvió.
 *
 * QUIÉN ASUME UNA DISPUTA NO ESTÁ DECIDIDO: se ven y se bloquea el importe. No
 * hay ninguna acción que la resuelva, porque resolverla sin regla aprobada es
 * inventarse la regla.
 *
 * NI UN IMPORTE FORMATEADO CON SÍMBOLO NI UN PORCENTAJE. Los números del panel
 * son cuentas de filas, que es lo que se puede afirmar sin decidir nada.
 */
export function FinanzasDeProductosScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();

  const [salud, setSalud] = useState<SaludFinanciera | null>(null);
  const [bloqueos, setBloqueos] = useState<SaldoDeProducto[]>([]);
  const [devoluciones, setDevoluciones] = useState<DevolucionDeProducto[]>([]);
  const [disputas, setDisputas] = useState<Disputa[]>([]);
  const [motivos, setMotivos] = useState<Record<string, string>>({});
  const [cargando, setCargando] = useState(true);
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'sinSesion' | 'sinPermiso' | 'noDisponible' | null
  >(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    setAviso(null);
    try {
      const estado = await ProductFinanceAdminRepository.salud();
      setSalud(estado);
      //: SIN LA MIGRACIÓN, EL PANEL SE VE IGUAL Y DICE QUÉ FALTA. Pedir las
      //: listas daría 503 sobre algo que la cabecera ya explica.
      if ((estado.missing ?? []).includes('migration_0082')) {
        setBloqueos([]);
        setDevoluciones([]);
        setDisputas([]);
        return;
      }
      const [parados, pendientes, contracargos] = await Promise.all([
        ProductFinanceAdminRepository.bloqueos(),
        ProductFinanceAdminRepository.devoluciones(),
        ProductFinanceAdminRepository.disputas(),
      ]);
      setBloqueos(parados);
      setDevoluciones(pendientes);
      setDisputas(contracargos);
    } catch (e) {
      if (e instanceof ApiError && esFaltaDeSesion(e.status)) setFallo('sinSesion');
      else if (e instanceof ApiError && e.status === 403) setFallo('sinPermiso');
      //: «NO DISPONIBLE» ES UN ESTADO, NO UN PANEL VACÍO. Esta rama ponía la
      //: salud a nula y seguía: el cuerpo pintaba las seis cuentas con `0` y el
      //: aviso de arriba sin una sola razón debajo. Quien opera leía «no hay
      //: nada que atender» cuando lo cierto es «no lo sé». La pantalla del
      //: proveedor ya lo hacía bien; esta no. Lo encontró la revisión.
      else if (e instanceof ApiError && esFinanzasApagadas(e.code)) setFallo('noDisponible');
      else if (e instanceof ApiError && esFalloDeRed(e.code)) setFallo('sinConexion');
      else setFallo('red');
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  //: LAS TRES PREGUNTAN ANTES. Liberar marca saldos como cobrables, pedir sale
  //: a la pasarela y anular retira una devolucion decidida: ninguna es un
  //: cambio de pestaña. La revision independiente las encontro a un toque.
  const liberar = async () => {
    const acepta = await confirm({
      title: f('finanzaDeProducto.panel.liberar'),
      message: f('finanzaDeProducto.panel.confirmarLiberar'),
      confirmLabel: f('finanzaDeProducto.panel.liberar'),
    });
    if (!acepta) return;
    return liberarDeVerdad();
  };

  const liberarDeVerdad = async () => {
    setOcupado(true);
    setError(null);
    try {
      const cuenta = await ProductFinanceAdminRepository.liberarVencidos();
      setAviso(f('finanzaDeProducto.panel.liberado', { n: cuenta.released }));
      await cargar();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? claveDeErrorFinanciero(e.code)
          : 'finanzaDeProducto.error.desconocido',
      );
    } finally {
      setOcupado(false);
    }
  };

  const pedir = async (refundId: string) => {
    //: ESTA SALE A LA PASARELA. Es la unica accion del panel que habla con
    //: dinero de verdad fuera de Z, y no se deshace desde aqui.
    const acepta = await confirm({
      title: f('finanzaDeProducto.panel.pedir'),
      message: f('finanzaDeProducto.panel.confirmarPedir'),
      confirmLabel: f('finanzaDeProducto.panel.pedir'),
    });
    if (!acepta) return;
    setOcupado(true);
    setError(null);
    try {
      await ProductFinanceAdminRepository.pedirDevolucion(refundId);
      await cargar();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? claveDeErrorFinanciero(e.code)
          : 'finanzaDeProducto.error.desconocido',
      );
    } finally {
      setOcupado(false);
    }
  };

  const anular = async (refundId: string) => {
    const motivo = (motivos[refundId] ?? '').trim();
    if (motivo.length < 3) return;
    const acepta = await confirm({
      title: f('finanzaDeProducto.panel.anular'),
      message: f('finanzaDeProducto.panel.confirmarAnular'),
      confirmLabel: f('finanzaDeProducto.panel.anular'),
      destructive: true,
    });
    if (!acepta) return;
    setOcupado(true);
    setError(null);
    try {
      await ProductFinanceAdminRepository.anularDevolucion(refundId, motivo);
      setMotivos((antes) => ({ ...antes, [refundId]: '' }));
      await cargar();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? claveDeErrorFinanciero(e.code)
          : 'finanzaDeProducto.error.desconocido',
      );
    } finally {
      setOcupado(false);
    }
  };

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/admin/productos' as never);

  const encabezado = (
    <AppHeader title={f('finanzaDeProducto.panel.titulo')} onBack={volver} />
  );

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        {fallo === 'sinSesion' ? (
          <StateView
            state="empty"
            icon="lock"
            title={f('sesion.entraParaVerlo')}
            description={f('sesion.entraParaVerloCuerpo')}
          />
        ) : fallo === 'sinPermiso' ? (
          <StateView
            state="empty"
            icon="shield"
            title={f('finanzaDeProducto.panel.sinPermiso')}
            description={f('finanzaDeProducto.panel.sinPermisoCuerpo')}
          />
        ) : fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            icon="clock"
            title={f('finanzaDeProducto.apagadas')}
            description={f('finanzaDeProducto.apagadasCuerpo')}
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

  const faltan = queLeFaltaAlPanel(salud);
  //: SIN LA 0082 NO SE OFRECE LIBERAR. El servidor lo rechaza siempre con 503
  //: en ese estado, y un botón que falla siempre no es una acción: es ruido.
  const sinFinanzasDesplegadas = (salud?.missing ?? []).includes('migration_0082');

  return (
    <AppScreen contentStyle={styles.contenido}>
      {encabezado}
      <ScrollView contentContainerStyle={styles.cuerpo} keyboardShouldPersistTaps="handled">
        {/* ESTE PANEL NO MUEVE DINERO, y es lo primero que se lee. */}
        {!puedeMoverDinero(salud) ? (
          <View style={[styles.aviso, { borderColor: colors.border }]}>
            <Text variant="titleMedium">
              {f('finanzaDeProducto.panel.noMueveDinero')}
            </Text>
            <Text variant="caption" color="muted">
              {f('finanzaDeProducto.panel.noMueveDineroCuerpo')}
            </Text>
            {faltan.map((clave) => (
              <Text key={clave} variant="caption" color="muted">
                {f(clave)}
              </Text>
            ))}
          </View>
        ) : null}

        {/* LOS NÚMEROS SON CUENTAS DE FILAS. Aquí un cero SÍ es un cero. */}
        <View style={[styles.tarjeta, { borderColor: colors.border }]}>
          {contadoresDelPanel(salud).map((fila) => (
            <View key={fila.clave} style={styles.fila}>
              <Text style={styles.crece}>{f(fila.clave)}</Text>
              <Text>{String(fila.cuantos)}</Text>
            </View>
          ))}
        </View>

        {aviso !== null ? (
          <Text variant="caption" color="muted">
            {aviso}
          </Text>
        ) : null}
        {error !== null ? <InlineError message={f(error)} /> : null}

        {!sinFinanzasDesplegadas ? (
          <Button
            label={f('finanzaDeProducto.panel.liberar')}
            variant="secondary"
            onPress={() => void liberar()}
            disabled={ocupado}
            loading={ocupado}
          />
        ) : null}

        {/* LOS BLOQUEOS, CON SU MOTIVO. Ni un dato de quien compró. */}
        <View style={styles.bloque}>
          <Text variant="titleMedium">{f('finanzaDeProducto.panel.bloqueados')}</Text>
          {bloqueos.length === 0 ? (
            <Text variant="caption" color="muted">
              {f('finanzaDeProducto.panel.sinBloqueos')}
            </Text>
          ) : (
            bloqueos.map((saldo) => (
              <View
                key={saldo.id}
                style={[styles.tarjeta, { borderColor: colors.border }]}
              >
                <View style={styles.fila}>
                  <Text style={styles.crece}>
                    {f(claveDelBloqueo(saldo.block ?? ''))}
                  </Text>
                  {importe(saldo.net_minor, saldo.currency) !== null ? (
                    <Text>{importe(saldo.net_minor, saldo.currency)}</Text>
                  ) : null}
                </View>
              </View>
            ))
          )}
        </View>

        {/* LAS DEVOLUCIONES. APROBAR NO ES PAGAR, y se dice aquí. */}
        <View style={styles.bloque}>
          <Text variant="titleMedium">{f('finanzaDeProducto.panel.devoluciones')}</Text>
          <Text variant="caption" color="muted">
            {f('finanzaDeProducto.panel.aprobarNoEsPagar')}
          </Text>
          {devoluciones.length === 0 ? (
            <Text variant="caption" color="muted">
              {f('finanzaDeProducto.panel.sinDevoluciones')}
            </Text>
          ) : (
            devoluciones.map((d) => (
              <View key={d.id} style={[styles.tarjeta, { borderColor: colors.border }]}>
                <View style={styles.fila}>
                  <Text style={styles.crece}>
                    {f(claveDelEstadoDeDevolucion(d.status))}
                  </Text>
                  {importeDeLaDevolucion(d) !== null ? (
                    <Text>{importeDeLaDevolucion(d)}</Text>
                  ) : null}
                </View>
                <Text variant="caption" color="muted">
                  {d.decision_reason}
                </Text>
                {/* SOLO `confirmed` DICE QUE EL DINERO VOLVIÓ. */}
                {elDineroYaVolvio(d) ? (
                  <Text variant="caption" color="muted">
                    {f('finanzaDeProducto.devolucion.confirmed')}
                  </Text>
                ) : null}
                {/* EL CÓDIGO DE LA PASARELA, CON SU RÓTULO. Se enseña porque es
                    lo que permite cruzar esta fila con el panel de la pasarela
                    al conciliar; lo que no puede es salir suelto, sin decir qué
                    es, como si fuera un mensaje para quien opera. */}
                {d.failure_code ? (
                  <Text variant="caption" color="muted">
                    {f('finanzaDeProducto.panel.codigoDeLaPasarela', {
                      codigo: d.failure_code,
                    })}
                  </Text>
                ) : null}
                {sePuedePedir(d) ? (
                  <Button
                    label={f('finanzaDeProducto.panel.pedir')}
                    variant="secondary"
                    onPress={() => void pedir(d.id)}
                    disabled={ocupado}
                  />
                ) : null}
                {sePuedeAnular(d) ? (
                  <>
                    <Input
                      value={motivos[d.id] ?? ''}
                      onChangeText={(texto) =>
                        setMotivos((antes) => ({ ...antes, [d.id]: texto }))
                      }
                      multiline
                      numberOfLines={2}
                      maxLength={500}
                      accessibilityLabel={f('finanzaDeProducto.panel.motivo')}
                    />
                    <Button
                      label={f('finanzaDeProducto.panel.anular')}
                      variant="secondary"
                      onPress={() => void anular(d.id)}
                      disabled={ocupado || (motivos[d.id] ?? '').trim().length < 3}
                    />
                  </>
                ) : null}
              </View>
            ))
          )}
        </View>

        {/* LAS DISPUTAS: se ven, y nada más. */}
        <View style={styles.bloque}>
          <Text variant="titleMedium">{f('finanzaDeProducto.panel.disputas')}</Text>
          <Text variant="caption" color="muted">
            {f('finanzaDeProducto.panel.quienPaga')}
          </Text>
          {disputas.length === 0 ? (
            <Text variant="caption" color="muted">
              {f('finanzaDeProducto.panel.sinDisputas')}
            </Text>
          ) : (
            disputas.map((d) => (
              <View key={d.id} style={[styles.tarjeta, { borderColor: colors.border }]}>
                <View style={styles.fila}>
                  <Text style={styles.crece}>
                    {f(claveDelEstadoDeDisputa(d.status))}
                  </Text>
                  {importe(d.amount_minor, d.currency) !== null ? (
                    <Text>{importe(d.amount_minor, d.currency)}</Text>
                  ) : null}
                </View>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { paddingHorizontal: 0 },
  cuerpo: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xl },
  bloque: { gap: spacing.sm },
  tarjeta: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  aviso: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  fila: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  crece: { flex: 1 },
});
