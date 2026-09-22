import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  type CuentaDeCobro,
  type ResumenFinanciero,
  type SaldoDeProducto,
  claveDelBloqueo,
  claveDelEstadoDeSaldo,
  claveDelMotivoDeRetencion,
  claveDeQueHacer,
  cursorDeLaPagina,
  desglose,
  disponibleLegible,
  esFinanzasApagadas,
  estaBloqueado,
  faltaDecidirLaComision,
  fusionarPaginas,
  hayBalance,
  hayMasPaginas,
  horasQueFaltan,
  importe,
  laCuentaEstaLista,
  queLeFaltaALaCuenta,
  retenidoLegible,
} from '@/lib/finanzasDeProductos';
import { esFaltaDeSesion } from '@/lib/productos';
import {
  ProductFinanceRepository,
  type Retencion,
} from '@/repositories/ProductFinanceRepository';
import { useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Lo que ha vendido quien vende, y cuánto de eso es suyo.
 *
 * SIN COMISIÓN CONFIGURADA NO SE PINTA NI UNA CIFRA, y se explica por qué. Un
 * «0,00» aquí se leería como «vendiste y no cobraste», que es lo contrario de la
 * verdad: lo que pasa es que la empresa no ha decidido cuánto se queda Z, y
 * mientras no lo decida no existe ni un saldo que enseñar.
 *
 * CADA BLOQUEO DICE QUÉ HACER, Y A VECES ES «NADA». Decir «retenido» sin decir
 * por qué deja a quien vende sin saber si tiene que mover un dedo. Y de los
 * catorce motivos, solo dos dependen de una persona —los de la cuenta de
 * cobro— y **aun esos** hoy no se pueden arreglar, porque el alta todavía no
 * está abierta. La pantalla lo dice en vez de mandarle a buscar un botón.
 *
 * NO HAY HISTORIAL DE TRANSFERENCIAS, y se dice con palabras: todavía no se ha
 * hecho ninguna. Una lista vacía con ese título haría pensar que se perdieron.
 *
 * NI UN IMPORTE SIN SU MONEDA. Y si hubiera dos monedas distintas, el servidor
 * manda la moneda nula a propósito y aquí no se pinta un total: sumarlas daría
 * una cifra que no existe.
 */
export function MiSaldoDeProductosScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();

  const [resumen, setResumen] = useState<ResumenFinanciero | null>(null);
  const [movimientos, setMovimientos] = useState<SaldoDeProducto[]>([]);
  const [retenciones, setRetenciones] = useState<Retencion[]>([]);
  const [cuenta, setCuenta] = useState<CuentaDeCobro | null>(null);
  const [cargando, setCargando] = useState(true);
  const [hayMas, setHayMas] = useState(false);
  const [pidiendoMas, setPidiendoMas] = useState(false);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'sinSesion' | 'noDisponible' | 'sinTienda' | null
  >(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      //: EL RESUMEN PRIMERO Y SOLO. Sin comisión configurada no hay nada más
      //: que pedir, y pedirlo daría 503 sobre algo que la pantalla ya sabe
      //: explicar.
      const cabecera = await ProductFinanceRepository.resumen();
      setResumen(cabecera);
      if (!hayBalance(cabecera)) {
        setMovimientos([]);
        setRetenciones([]);
        setCuenta(await _cuentaSegura());
        return;
      }
      const [filas, apartado, donde] = await Promise.all([
        ProductFinanceRepository.movimientos(),
        ProductFinanceRepository.retenciones(),
        _cuentaSegura(),
      ]);
      setMovimientos(filas);
      setHayMas(hayMasPaginas(filas.length));
      setRetenciones(apartado);
      setCuenta(donde);
    } catch (e) {
      if (e instanceof ApiError && esFaltaDeSesion(e.status)) setFallo('sinSesion');
      else if (e instanceof ApiError && esFinanzasApagadas(e.code))
        setFallo('noDisponible');
      /* 404 AQUÍ ES «NO ERES RESPONSABLE COMERCIAL», no «no has vendido»: el
         servidor contesta lo mismo a quien no tiene tienda que a quien pide la
         de otro. No haber vendido es otra cosa y se pinta distinto. */
      else if (e instanceof ApiError && e.status === 404) setFallo('sinTienda');
      else if (e instanceof ApiError && esFalloDeRed(e.code)) setFallo('sinConexion');
      else setFallo('red');
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const verMas = async () => {
    const cursor = cursorDeLaPagina(movimientos);
    if (!cursor) return;
    setPidiendoMas(true);
    try {
      const siguiente = await ProductFinanceRepository.movimientos({
        before: cursor.before,
        beforeId: cursor.before_id,
      });
      setMovimientos((antes) => fusionarPaginas(antes, siguiente));
      setHayMas(hayMasPaginas(siguiente.length));
    } catch {
      /* UN FALLO AL PEDIR MÁS NO VACÍA LO QUE YA SE LEÍA. */
      setHayMas(true);
    } finally {
      setPidiendoMas(false);
    }
  };

  const volver = () =>
    router.canGoBack()
      ? router.back()
      : router.replace('/proveedor/productos' as never);

  const encabezado = <AppHeader title={f('finanzaDeProducto.titulo')} onBack={volver} />;

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
        ) : fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            icon="clock"
            title={f('finanzaDeProducto.apagadas')}
            description={f('finanzaDeProducto.apagadasCuerpo')}
          />
        ) : fallo === 'sinTienda' ? (
          <StateView
            state="empty"
            icon="shopping-bag"
            title={f('envio.proveedor.sinTienda')}
            description={f('envio.proveedor.sinTiendaCuerpo')}
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

  /* SIN COMISIÓN DECIDIDA, LA PANTALLA ES UNA EXPLICACIÓN Y NO UN BALANCE. */
  if (faltaDecidirLaComision(resumen)) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        <ScrollView contentContainerStyle={styles.cuerpo}>
          <StateView
            state="empty"
            icon="clock"
            title={f('finanzaDeProducto.sinConfigurar')}
            description={f('finanzaDeProducto.sinConfigurarCuerpo')}
          />
          {_cuentaPintada(cuenta, f, colors)}
        </ScrollView>
      </AppScreen>
    );
  }

  if (!hayBalance(resumen)) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        <ScrollView contentContainerStyle={styles.cuerpo}>
          <StateView
            state="empty"
            icon="package"
            title={f('finanzaDeProducto.sinVentas')}
          />
          {_cuentaPintada(cuenta, f, colors)}
        </ScrollView>
      </AppScreen>
    );
  }

  const disponible = disponibleLegible(resumen);
  const apartado = retenidoLegible(resumen);

  return (
    <AppScreen contentStyle={styles.contenido}>
      {encabezado}
      <ScrollView contentContainerStyle={styles.cuerpo}>
        <View style={[styles.tarjeta, { borderColor: colors.border }]}>
          <Text variant="caption" color="muted">
            {f('finanzaDeProducto.disponible')}
          </Text>
          {/* SIN MONEDA NO SE PINTA UN NÚMERO: no significaría nada. */}
          {disponible !== null ? (
            <Text variant="display">{disponible}</Text>
          ) : null}
          {apartado !== null ? (
            <Text variant="caption" color="muted">
              {`${f('finanzaDeProducto.retenido')}: ${apartado}`}
            </Text>
          ) : null}
        </View>

        <View style={[styles.tarjeta, { borderColor: colors.border }]}>
          {desglose(resumen).map((fila) => (
            <View key={fila.clave} style={styles.fila}>
              <Text style={styles.crece}>{f(fila.clave)}</Text>
              <Text>{fila.texto}</Text>
            </View>
          ))}
        </View>

        {_cuentaPintada(cuenta, f, colors)}

        {retenciones.length > 0 ? (
          <View style={styles.bloque}>
            <Text variant="titleMedium">{f('finanzaDeProducto.retenciones')}</Text>
            {retenciones.map((r) => (
              <View key={r.id} style={[styles.tarjeta, { borderColor: colors.border }]}>
                <View style={styles.fila}>
                  <Text style={styles.crece}>
                    {f(claveDelMotivoDeRetencion(r.reason))}
                  </Text>
                  {importe(r.amount_minor, r.currency) !== null ? (
                    <Text>{importe(r.amount_minor, r.currency)}</Text>
                  ) : null}
                </View>
                <Text variant="caption" color="muted">
                  {f(claveDelEstadoDeSaldo(r.status))}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        <View style={styles.bloque}>
          <Text variant="titleMedium">{f('finanzaDeProducto.movimientos')}</Text>
          {movimientos.map((saldo) => {
            const horas = horasQueFaltan(saldo);
            return (
              <View
                key={saldo.id}
                style={[styles.tarjeta, { borderColor: colors.border }]}
              >
                <View style={styles.fila}>
                  <Text style={styles.crece}>
                    {f(claveDelEstadoDeSaldo(saldo.status))}
                  </Text>
                  {importe(saldo.net_minor, saldo.currency) !== null ? (
                    <Text>{importe(saldo.net_minor, saldo.currency)}</Text>
                  ) : null}
                </View>
                {/* EL MOTIVO Y QUÉ HACER, LOS DOS. Y «nada» es una respuesta. */}
                {estaBloqueado(saldo) ? (
                  <>
                    <Text variant="caption" color="muted">
                      {f(claveDelBloqueo(saldo.block as string))}
                    </Text>
                    <Text variant="caption" color="muted">
                      {f(claveDeQueHacer(saldo.block as string))}
                    </Text>
                  </>
                ) : null}
                {/* `null` NO ES «YA»: es que todavía no se sabe. */}
                <Text variant="caption" color="muted">
                  {horas === null
                    ? f('finanzaDeProducto.sinFecha')
                    : f('finanzaDeProducto.leQuedan', { n: horas })}
                </Text>
              </View>
            );
          })}
          {hayMas ? (
            <Button
              label={f('finanzaDeProducto.verMas')}
              onPress={() => void verMas()}
              loading={pidiendoMas}
              disabled={pidiendoMas}
            />
          ) : null}
        </View>

        {/* NO HAY HISTORIAL DE TRANSFERENCIAS, y se dice: una lista vacía con
            ese título haría pensar que se perdieron. */}
        <Text variant="caption" color="muted">
          {f('finanzaDeProducto.sinTransferencias')}
        </Text>
      </ScrollView>
    </AppScreen>
  );
}

/** La cuenta de cobro nunca tumba la pantalla: es un bloque de más. */
async function _cuentaSegura(): Promise<CuentaDeCobro | null> {
  try {
    return await ProductFinanceRepository.cuentaDeCobro();
  } catch {
    return null;
  }
}

function _cuentaPintada(
  cuenta: CuentaDeCobro | null,
  f: (clave: string, params?: Record<string, string | number>) => string,
  colors: { border: string },
) {
  if (cuenta === null) return null;
  const faltan = queLeFaltaALaCuenta(cuenta);
  return (
    <View style={[styles.tarjeta, { borderColor: colors.border }]}>
      <Text variant="titleMedium">{f('finanzaDeProducto.cuenta')}</Text>
      {laCuentaEstaLista(cuenta) ? (
        <Text variant="caption" color="muted">
          {f('finanzaDeProducto.cuentaLista')}
        </Text>
      ) : (
        faltan.map((clave) => (
          <Text key={clave} variant="caption" color="muted">
            {f(clave)}
          </Text>
        ))
      )}
    </View>
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
  fila: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  crece: { flex: 1 },
});
