import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import { toast } from '@/lib/toast';
import {
  ESTADOS_DE_DISPUTA,
  LARGO_MAXIMO_DEL_MOTIVO,
  LIMITE_DE_CONCILIACION,
  LIMITE_INICIAL,
  agruparHallazgos,
  cifraDeImporte,
  claveDeBloqueoDeTransferencia,
  claveDeContador,
  claveDeHallazgo,
  claveDelAvisoDeSoltar,
  claveDelEstadoDeDisputa,
  esFinanzasNoDisponible,
  esperaAlgo,
  filasDeSalud,
  leerMotivoDeSoltar,
  llegoAlTope,
  nadaSeMovio,
  plazoDePruebasVencido,
  saludNoDisponible,
  siguienteLimite,
  type Disputa,
  type GrupoDeHallazgos,
  type ResultadoDeTransferencias,
} from '@/lib/finanzasDeEventos';
import { EventFinanceAdminRepository } from '@/repositories/EventFinanceAdminRepository';
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
 * El panel financiero de administración.
 *
 * QUIÉN PUEDE ABRIRLO LO DECIDE EL SERVIDOR, con `puede_mover_dinero`. Esta
 * pantalla no comprueba ningún rol: quien no lo tenga recibe un 403 y aquí se
 * lee el aviso. Ocultar la pantalla sería comodidad, no protección.
 *
 * NADA DE LO QUE HAY AQUÍ MUEVE DINERO, y las tres acciones lo dicen:
 *
 *   - Conciliar COMPARA Y REPORTA. Una diferencia de dinero no se arregla
 *     escribiendo el número que falta: se cuenta con su código y una persona la
 *     mira. No hay ningún botón de «corregir».
 *   - Soltar una reserva LEVANTA UNA RETENCIÓN. No transfiere, no devuelve, no
 *     cobra: deja de retener y anota por qué, para poder auditarlo después.
 *   - Ejecutar transferencias ES LA RUTA QUE ALGÚN DÍA PAGARÍA. Hoy contesta
 *     cero ejecutadas y la lista de banderas apagadas, y eso es literalmente lo
 *     que se enseña. No se promete ningún pago ni ninguna fecha.
 *
 * NO SE INVENTA NINGÚN NÚMERO. Los contadores son los del servidor, tal cual;
 * no hay umbrales, ni semáforos, ni «lo normal es X»: nadie ha decidido
 * ninguno.
 */
export function PanelFinancieroScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();

  /*
    Las claves de finanzas se están escribiendo en las tablas de idiomas en
    paralelo. El molde es el mismo `t`: cuando lleguen, esto no cambia.
  */
  const f = useCallback(
    (clave: string, params?: Record<string, string | number>) =>
      t(clave as TranslationKey, params),
    [t],
  );

  const [salud, setSalud] = useState<Record<string, unknown> | null>(null);
  const [disputas, setDisputas] = useState<Disputa[]>([]);
  const [estadoDeDisputa, setEstadoDeDisputa] = useState<string | null>(null);
  const [limite, setLimite] = useState<number>(LIMITE_INICIAL);

  const [grupos, setGrupos] = useState<GrupoDeHallazgos[] | null>(null);
  const [totalDeHallazgos, setTotalDeHallazgos] = useState(0);
  const [transferencias, setTransferencias] = useState<ResultadoDeTransferencias | null>(
    null,
  );

  const [reservaId, setReservaId] = useState('');
  const [motivo, setMotivo] = useState('');
  const [consumida, setConsumida] = useState(false);
  const [errorDelFormulario, setErrorDelFormulario] = useState<string | null>(null);

  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'sinPermiso' | 'noDisponible' | null
  >(null);
  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  const leerFallo = (error: unknown) => {
    if (error instanceof ApiError && esFinanzasNoDisponible(error.code)) {
      return 'noDisponible' as const;
    }
    if (error instanceof ApiError && error.status === 403) return 'sinPermiso' as const;
    if (error instanceof ApiError && esFalloDeRed(error.code)) {
      return 'sinConexion' as const;
    }
    return 'red' as const;
  };

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      const contadores = await EventFinanceAdminRepository.salud();
      setSalud(contadores);
      // Las disputas no tumban el panel: los contadores ya se leyeron.
      setDisputas(
        await EventFinanceAdminRepository.disputas({
          estado: estadoDeDisputa,
          limite,
        }).catch(() => []),
      );
    } catch (error) {
      setFallo(leerFallo(error));
    } finally {
      setCargando(false);
    }
  }, [estadoDeDisputa, limite]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const textoDelError = (error: unknown) => {
    if (error instanceof ApiError && esFinanzasNoDisponible(error.code)) {
      return f('finanzasEvento.noDisponibleCuerpo');
    }
    if (error instanceof ApiError && error.status === 403) {
      return f('finanzasEvento.sinPermisoCuerpo');
    }
    return error instanceof Error && error.message.trim() !== ''
      ? error.message
      : t('common.tryAgain');
  };

  const conCerrojo = async (trabajo: () => Promise<void>) => {
    // ANTES DEL PRIMER `await`, que aquí puede ser un diálogo: dos toques
    // rápidos mandarían dos veces la misma orden sobre una retención.
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    setOcupado(true);
    try {
      await trabajo();
    } catch (error) {
      notify(f('finanzasEvento.noSePudo'), textoDelError(error));
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  const conciliar = () =>
    void conCerrojo(async () => {
      const resultado = await EventFinanceAdminRepository.conciliar(
        LIMITE_DE_CONCILIACION,
      );
      setTotalDeHallazgos(resultado.total);
      setGrupos(agruparHallazgos(resultado.hallazgos));
    });

  const comprobarTransferencias = () =>
    void conCerrojo(async () => {
      const resultado = await EventFinanceAdminRepository.ejecutarTransferencias();
      setTransferencias(resultado);
    });

  const soltar = () => {
    const leido = leerMotivoDeSoltar(motivo);
    const identificador = reservaId.trim();
    if (identificador === '') {
      setErrorDelFormulario(f('finanzasEvento.faltaReserva'));
      return;
    }
    if (!leido.ok) {
      setErrorDelFormulario(
        leido.falta === 'vacio'
          ? f('finanzasEvento.faltaMotivo')
          : f('finanzasEvento.motivoCorto', { n: 3 }),
      );
      return;
    }
    setErrorDelFormulario(null);

    void conCerrojo(async () => {
      const aceptado = await confirm({
        title: f('finanzasEvento.soltarTitulo'),
        message: f(claveDelAvisoDeSoltar(consumida)),
        confirmLabel: f('finanzasEvento.soltarBoton'),
        destructive: consumida,
      });
      if (!aceptado) return;
      await EventFinanceAdminRepository.soltarReserva(
        identificador,
        leido.motivo,
        consumida,
      );
      setReservaId('');
      setMotivo('');
      setConsumida(false);
      toast(f('finanzasEvento.soltada'));
      await cargar();
    });
  };

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('finanzasEvento.tituloPanel')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('finanzasEvento.tituloPanel')} onBack={volver} />
        {fallo === 'sinPermiso' || fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            icon={fallo === 'noDisponible' ? 'clock' : 'lock'}
            title={
              fallo === 'noDisponible'
                ? f('finanzasEvento.noDisponible')
                : f('finanzasEvento.sinPermiso')
            }
            description={
              fallo === 'noDisponible'
                ? f('finanzasEvento.noDisponibleCuerpo')
                : f('finanzasEvento.sinPermisoCuerpo')
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

  const filas = filasDeSalud(salud);
  const sinEsquema = saludNoDisponible(salud);
  const masArriba = siguienteLimite(limite);
  const tope = llegoAlTope(disputas.length, limite);

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('finanzasEvento.tituloPanel')} onBack={volver} />

      {/* NADA DE ESTE PANEL MUEVE DINERO. Se dice arriba, una vez y claro. */}
      <View style={[styles.recuadro, { borderColor: colors.border }]}>
        <Text variant="secondary">{f('finanzasEvento.panelIntro')}</Text>
      </View>

      <Text variant="caption" color={colors.textMuted}>
        {f('finanzasEvento.saludTitulo')}
      </Text>
      {sinEsquema ? (
        <StateView
          state="empty"
          icon="clock"
          title={f('finanzasEvento.noDisponible')}
          description={f('finanzasEvento.noDisponibleCuerpo')}
        />
      ) : filas.length === 0 ? (
        <Text variant="secondary" color={colors.textMuted}>
          {f('finanzasEvento.saludVacia')}
        </Text>
      ) : (
        <View style={[styles.recuadro, { borderColor: colors.border }]}>
          {filas.map((fila) => (
            <View key={fila.clave} style={styles.linea}>
              <Text variant="secondary" color={colors.textMuted}>
                {fila.conocido
                  ? f(claveDeContador(fila.clave))
                  : f('finanzasEvento.contador.desconocido', { clave: fila.clave })}
              </Text>
              <Text
                variant="secondary"
                weight="700"
                color={
                  esperaAlgo(fila.clave) && fila.valor > 0
                    ? colors.text
                    : colors.textMuted
                }
              >
                {String(fila.valor)}
              </Text>
            </View>
          ))}
        </View>
      )}

      {/* CONCILIAR COMPARA Y REPORTA. No hay ningún botón que corrija. */}
      <Text variant="caption" color={colors.textMuted}>
        {f('finanzasEvento.conciliacionTitulo')}
      </Text>
      <Text variant="caption" color={colors.textMuted}>
        {f('finanzasEvento.conciliacionCuerpo')}
      </Text>
      <Button
        label={f('finanzasEvento.conciliarBoton')}
        variant="secondary"
        loading={ocupado}
        onPress={conciliar}
      />
      {grupos !== null ? (
        grupos.length === 0 ? (
          <Text variant="secondary" color={colors.textMuted}>
            {f('finanzasEvento.conciliacionSinHallazgos', { n: LIMITE_DE_CONCILIACION })}
          </Text>
        ) : (
          <View style={[styles.recuadro, { borderColor: colors.border }]}>
            <Text variant="caption" color={colors.textMuted}>
              {f('finanzasEvento.conciliacionTotal', { n: totalDeHallazgos })}
            </Text>
            {grupos.map((grupo) => (
              <View key={grupo.codigo} style={styles.grupo}>
                <Text variant="secondary" weight="700">
                  {f('finanzasEvento.hallazgoContado', {
                    n: grupo.cuantos,
                    que: f(claveDeHallazgo(grupo.codigo)),
                  })}
                </Text>
                {grupo.ejemplos.length > 0 ? (
                  <Text variant="caption" color={colors.textMuted}>
                    {f('finanzasEvento.hallazgoEjemplos', {
                      ids: grupo.ejemplos.join(', '),
                    })}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        )
      ) : null}

      {/* LAS DISPUTAS. `liability` llega vacío mientras no haya política. */}
      <Text variant="caption" color={colors.textMuted}>
        {f('finanzasEvento.disputasTitulo')}
      </Text>
      <View style={styles.chips}>
        <Chip
          label={f('finanzasEvento.filtroTodas')}
          selected={estadoDeDisputa === null}
          rol="radio"
          onPress={() => {
            setLimite(LIMITE_INICIAL);
            setEstadoDeDisputa(null);
          }}
        />
        {ESTADOS_DE_DISPUTA.map((valor) => (
          <Chip
            key={valor}
            label={f(claveDelEstadoDeDisputa(valor))}
            selected={estadoDeDisputa === valor}
            rol="radio"
            onPress={() => {
              setLimite(LIMITE_INICIAL);
              setEstadoDeDisputa(valor);
            }}
          />
        ))}
      </View>
      {disputas.length === 0 ? (
        <Text variant="secondary" color={colors.textMuted}>
          {f('finanzasEvento.disputasVacio')}
        </Text>
      ) : (
        disputas.map((disputa) => {
          const vencido = plazoDePruebasVencido(disputa.evidence_due_at);
          const importe = cifraDeImporte(disputa.amount_minor, disputa.currency);
          return (
            <View key={disputa.id} style={[styles.fila, { borderColor: colors.border }]}>
              <Text variant="secondary" weight="700">
                {f(claveDelEstadoDeDisputa(disputa.status))}
              </Text>
              {importe.estado === 'cifra' ? (
                <Text variant="secondary">{importe.texto}</Text>
              ) : null}
              {/* QUIÉN ASUME LA PÉRDIDA NO ESTÁ DECIDIDO SIN POLÍTICA. */}
              <Text variant="caption" color={colors.textMuted}>
                {disputa.liability === null
                  ? f('finanzasEvento.disputaSinResponsable')
                  : f('finanzasEvento.disputaResponsable', { valor: disputa.liability })}
              </Text>
              {vencido !== null ? (
                <Text
                  variant="caption"
                  color={vencido ? colors.danger : colors.textMuted}
                >
                  {vencido
                    ? f('finanzasEvento.plazoVencido', {
                        fecha: fechaLegible(disputa.evidence_due_at),
                      })
                    : f('finanzasEvento.plazoHasta', {
                        fecha: fechaLegible(disputa.evidence_due_at),
                      })}
                </Text>
              ) : null}
              {fechaLegible(disputa.created_at) !== '' ? (
                <Text variant="caption" color={colors.textMuted}>
                  {f('finanzasEvento.abiertaEl', {
                    fecha: fechaLegible(disputa.created_at),
                  })}
                </Text>
              ) : null}
            </View>
          );
        })
      )}
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

      {/* SOLTAR NO MUEVE DINERO, y el formulario lo dice antes de tocarlo. */}
      <Text variant="caption" color={colors.textMuted}>
        {f('finanzasEvento.soltarTitulo')}
      </Text>
      <Text variant="caption" color={colors.textMuted}>
        {f('finanzasEvento.soltarCuerpo')}
      </Text>
      <Input
        label={f('finanzasEvento.reservaEtiqueta')}
        placeholder={f('finanzasEvento.reservaAyuda')}
        value={reservaId}
        onChangeText={setReservaId}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Input
        label={f('finanzasEvento.motivoEtiqueta')}
        placeholder={f('finanzasEvento.motivoAyuda')}
        value={motivo}
        onChangeText={setMotivo}
        multiline
        maxLength={LARGO_MAXIMO_DEL_MOTIVO}
        error={errorDelFormulario ?? undefined}
      />
      <View style={styles.chips}>
        <Chip
          label={f('finanzasEvento.soltarLiberada')}
          selected={!consumida}
          rol="radio"
          onPress={() => setConsumida(false)}
        />
        <Chip
          label={f('finanzasEvento.soltarConsumida')}
          selected={consumida}
          rol="radio"
          onPress={() => setConsumida(true)}
        />
      </View>
      <Text variant="caption" color={colors.textMuted}>
        {f(claveDelAvisoDeSoltar(consumida))}
      </Text>
      <Button
        label={f('finanzasEvento.soltarBoton')}
        variant="secondary"
        loading={ocupado}
        onPress={soltar}
      />

      {/* LA RUTA QUE ALGÚN DÍA PAGARÍA. Hoy contesta cero, y se enseña cero. */}
      <Text variant="caption" color={colors.textMuted}>
        {f('finanzasEvento.transferenciasTitulo')}
      </Text>
      <Text variant="caption" color={colors.textMuted}>
        {f('finanzasEvento.transferenciasCuerpo')}
      </Text>
      <Button
        label={f('finanzasEvento.transferenciasBoton')}
        variant="secondary"
        loading={ocupado}
        onPress={comprobarTransferencias}
      />
      {transferencias !== null ? (
        <View style={[styles.recuadro, { borderColor: colors.border }]}>
          <Text variant="secondary" weight="700">
            {nadaSeMovio(transferencias)
              ? f('finanzasEvento.transferenciasCero')
              : f('finanzasEvento.transferenciasHechas', {
                  n: transferencias.ejecutadas,
                })}
          </Text>
          {transferencias.bloqueos.length === 0 ? (
            <Text variant="caption" color={colors.textMuted}>
              {f('finanzasEvento.transferenciasSinBloqueos')}
            </Text>
          ) : (
            transferencias.bloqueos.map((bloqueo) => (
              <Text key={bloqueo} variant="caption" color={colors.textMuted}>
                {f(claveDeBloqueoDeTransferencia(bloqueo))}
              </Text>
            ))
          )}
        </View>
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
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
  grupo: { gap: 2 },
  linea: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
});
