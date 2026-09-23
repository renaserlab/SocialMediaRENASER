import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  LARGO_MAXIMO_DEL_MOTIVO,
  claveDeErrorDePosventa,
  claveDelActor,
  claveDelDesenlace,
  claveDelEfecto,
  claveDelEstadoDeEntradaAfectada,
  claveDelEstadoDeExpediente,
  claveDelTipoDeExpediente,
  elDineroYaVolvio,
  esPosventaApagada,
  importeDeLaDevolucion,
  largoDelMotivo,
  motivoUtil,
  puedeResponder,
  puedeRetirar,
  tonoDelEstado,
} from '@/lib/posventaDeEventos';
import {
  EventAftersaleRepository,
  type EntradaAfectada,
  type Expediente,
  type LineaDeHistorial,
  type PoliticaAplicada,
} from '@/repositories/EventAftersaleRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/** La fecha y la hora de un paso. Vacía si el servidor mandó algo raro. */
function momentoLegible(iso: string | null): string {
  if (!iso) return '';
  const momento = new Date(iso);
  if (Number.isNaN(momento.getTime())) return '';
  return `${momento.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })} · ${momento.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

/**
 * Un expediente de posventa: qué se pidió, qué ha pasado y cómo quedaron las
 * entradas.
 *
 * APROBADO NO ES DEVUELTO, y aquí es donde más importa. `approved`,
 * `refund_pending` y `refund_processing` llevan un recordatorio explícito de
 * que el dinero todavía no ha vuelto; solo `resolved` con un desenlace de
 * devolución dice que el movimiento está confirmado, porque ese estado solo lo
 * alcanza un aviso verificado del proveedor. Y NO SE PROMETEN FECHAS: cuándo
 * llega el dinero al banco depende de la entidad de cada persona.
 *
 * LOS BOTONES LOS DICTA EL SERVIDOR. `acciones[]` viene de la máquina de
 * estados de `posventa_estados.py`; la pantalla no deduce por su cuenta si algo
 * se puede retirar. Una tabla escrita aquí se desviaría de la de allí en el
 * primer cambio y ofrecería botones que contestan 403.
 *
 * LA POLÍTICA PUEDE NO EXISTIR TODAVÍA. El servidor contesta 404 mientras nadie
 * ha decidido, y eso NO es un fallo de carga: se escribe que aún no se ha
 * aplicado ninguna, que es lo que ocurre.
 */
export function ExpedienteScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [expediente, setExpediente] = useState<Expediente | null>(null);
  const [historial, setHistorial] = useState<LineaDeHistorial[]>([]);
  const [entradas, setEntradas] = useState<EntradaAfectada[]>([]);
  const [politica, setPolitica] = useState<PoliticaAplicada | null>(null);
  const [respuesta, setRespuesta] = useState('');
  const [errorDeRespuesta, setErrorDeRespuesta] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'noEncontrado' | 'noDisponible' | null
  >(null);
  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  const cargar = useCallback(async () => {
    if (!id) return;
    setCargando(true);
    setFallo(null);
    try {
      const ficha = await EventAftersaleRepository.leer(id);
      setExpediente(ficha);
      // Las tres piezas de apoyo van juntas y ninguna tumba la pantalla: el
      // expediente ya se leyó, y quedarse sin la línea de tiempo es peor
      // contado como «no pudimos cargar» que enseñado vacío.
      const [linea, tickets, reglas] = await Promise.all([
        EventAftersaleRepository.historial(id).catch(() => [] as LineaDeHistorial[]),
        EventAftersaleRepository.entradas(id).catch(() => [] as EntradaAfectada[]),
        // 404 AQUÍ NO ES UN ERROR: es que todavía no hay decisión.
        EventAftersaleRepository.politica(id).catch(() => null),
      ]);
      setHistorial(linea);
      setEntradas(tickets);
      setPolitica(reglas);
    } catch (error) {
      if (error instanceof ApiError && esPosventaApagada(error.code)) {
        setFallo('noDisponible');
      } else if (
        error instanceof ApiError &&
        (error.status === 404 || error.code === 'event_case_not_found')
      ) {
        setFallo('noEncontrado');
      } else if (error instanceof ApiError && esFalloDeRed(error.code)) {
        setFallo('sinConexion');
      } else {
        setFallo('red');
      }
    } finally {
      setCargando(false);
    }
  }, [id]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const textoDelError = (error: unknown) => {
    const clave =
      error instanceof ApiError ? claveDeErrorDePosventa(error.code) : null;
    if (clave !== null) return t(clave as TranslationKey);
    return error instanceof Error && error.message.trim() !== ''
      ? error.message
      : t('common.tryAgain');
  };

  const conCerrojo = async (accion: () => Promise<void>) => {
    // ANTES DEL PRIMER `await`, que aquí puede ser un diálogo: dos toques
    // rápidos mandarían dos veces el mismo paso, y el segundo chocaría con la
    // máquina de estados del servidor.
    if (ocupadoRef.current || !id) return;
    ocupadoRef.current = true;
    setOcupado(true);
    try {
      await accion();
    } catch (error) {
      notify(t('posventa.noSePudo'), textoDelError(error));
      void cargar();
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  const responder = () => {
    const limpia = motivoUtil(respuesta);
    if (limpia === null) {
      setErrorDeRespuesta(t('posventa.faltaMotivo'));
      return;
    }
    setErrorDeRespuesta(null);
    void conCerrojo(async () => {
      const actualizado = await EventAftersaleRepository.responder(
        id as string,
        limpia,
      );
      setExpediente(actualizado);
      setRespuesta('');
      void cargar();
    });
  };

  const retirar = () =>
    void conCerrojo(async () => {
      const aceptado = await confirm({
        title: t('posventa.retirarTitulo'),
        message: t('posventa.retirarCuerpo'),
        confirmLabel: t('posventa.retirarBoton'),
        destructive: true,
      });
      if (!aceptado) return;
      const actualizado = await EventAftersaleRepository.retirar(id as string);
      setExpediente(actualizado);
      void cargar();
    });

  const volver = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/posventa' as never);
  };

  if (cargando) {
    return (
      <AppScreen>
        <AppHeader title={t('posventa.tituloExpediente')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || !expediente) {
    return (
      <AppScreen>
        <AppHeader title={t('posventa.tituloExpediente')} onBack={volver} />
        {fallo === 'noEncontrado' || fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            icon={fallo === 'noDisponible' ? 'clock' : 'inbox'}
            title={
              fallo === 'noEncontrado'
                ? t('posventa.noEncontrado')
                : t('posventa.noDisponible')
            }
            description={
              fallo === 'noEncontrado'
                ? t('posventa.noEncontradoCuerpo')
                : t('posventa.noDisponibleCuerpo')
            }
            actionLabel={t('posventa.verSolicitudes')}
            onAction={() => router.replace('/posventa' as never)}
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

  const tono = tonoDelEstado(expediente.status);
  const colorDelEstado =
    tono === 'bueno'
      ? colors.success
      : tono === 'malo'
        ? colors.danger
        : colors.textMuted;
  const iconoDelEstado =
    tono === 'bueno' ? 'check-circle' : tono === 'malo' ? 'alert-circle' : 'clock';

  const dineroDeVuelta = elDineroYaVolvio(expediente.status, expediente.outcome);
  // APROBADO, EN COLA Y EJECUTÁNDOSE: los tres son «todavía no ha vuelto».
  const decididoSinCobrar =
    expediente.status === 'approved' ||
    expediente.status === 'refund_pending' ||
    expediente.status === 'refund_processing';
  const importe = importeDeLaDevolucion(
    expediente.refund_amount_minor,
    expediente.currency,
  );
  const contestable = puedeResponder(expediente);
  const retirable = puedeRetirar(expediente);
  const escritos = largoDelMotivo(respuesta);

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={t('posventa.tituloExpediente')} onBack={volver} />

      <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
        <Feather name={iconoDelEstado} size={16} color={colorDelEstado} />
        <Text variant="secondary" color={colorDelEstado} style={styles.crece}>
          {t(claveDelEstadoDeExpediente(expediente.status) as TranslationKey)}
        </Text>
      </View>

      <Text variant="title">
        {t(claveDelTipoDeExpediente(expediente.kind) as TranslationKey)}
      </Text>
      {momentoLegible(expediente.created_at) !== '' ? (
        <Text variant="caption" color={colors.textMuted}>
          {t('posventa.abiertaEl', { fecha: momentoLegible(expediente.created_at) })}
        </Text>
      ) : null}

      {/*
        APROBAR NO ES HABER PAGADO. Mientras el proveedor no confirme el
        movimiento, esto se dice con todas las letras: `approved` es «te
        dijimos que sí», no «ya lo tienes».
      */}
      {decididoSinCobrar ? (
        <View style={[styles.recuadro, { borderColor: colors.border }]}>
          <Text variant="secondary" weight="700">
            {t('posventa.aprobadaNoEsPagada')}
          </Text>
          <Text variant="caption" color={colors.textMuted}>
            {t('posventa.sinPlazos')}
          </Text>
        </View>
      ) : null}

      {expediente.outcome !== null ? (
        <View style={styles.bloque}>
          <Text variant="caption" color={colors.textMuted}>
            {t('posventa.desenlaceTitulo')}
          </Text>
          <Text
            variant="secondary"
            weight="700"
            color={dineroDeVuelta ? colors.success : colors.text}
          >
            {t(claveDelDesenlace(expediente.outcome) as TranslationKey)}
          </Text>
          {importe !== null ? (
            <Text variant="secondary">
              {t('posventa.importeAprobado', { importe })}
            </Text>
          ) : (
            <Text variant="caption" color={colors.textMuted}>
              {t('posventa.importeSinDecidir')}
            </Text>
          )}
        </View>
      ) : null}

      {expediente.reason !== null && expediente.reason.trim() !== '' ? (
        <View style={styles.bloque}>
          <Text variant="caption" color={colors.textMuted}>
            {t('posventa.tuMotivo')}
          </Text>
          <Text variant="secondary">{expediente.reason}</Text>
        </View>
      ) : null}

      <Text variant="caption" color={colors.textMuted}>
        {t('posventa.historialTitulo')}
      </Text>
      {historial.length === 0 ? (
        <Text variant="secondary" color={colors.textMuted}>
          {t('posventa.historialVacio')}
        </Text>
      ) : (
        historial.map((paso, indice) => (
          <View
            key={`${paso.created_at}-${paso.to_status}-${indice}`}
            style={[styles.paso, { borderColor: colors.border }]}
          >
            <Text variant="secondary" weight="700">
              {t(claveDelEstadoDeExpediente(paso.to_status) as TranslationKey)}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {`${t(claveDelActor(paso.actor_role) as TranslationKey)} · ${momentoLegible(
                paso.created_at,
              )}`}
            </Text>
            {paso.reason !== null && paso.reason.trim() !== '' ? (
              <Text variant="secondary">{paso.reason}</Text>
            ) : null}
          </View>
        ))
      )}

      <Text variant="caption" color={colors.textMuted}>
        {t('posventa.entradasTitulo')}
      </Text>
      {entradas.length === 0 ? (
        <Text variant="secondary" color={colors.textMuted}>
          {t('posventa.entradasVacio')}
        </Text>
      ) : (
        entradas.map((entrada) => (
          <View
            key={entrada.ticket_id}
            style={[styles.paso, { borderColor: colors.border }]}
          >
            <Text variant="secondary" weight="700">
              {entrada.name}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {t('posventa.entradaAhora', {
                estado: t(
                  claveDelEstadoDeEntradaAfectada(entrada.status) as TranslationKey,
                ),
              })}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {t('posventa.entradaAlAbrir', {
                estado: t(
                  claveDelEstadoDeEntradaAfectada(
                    entrada.status_at_open,
                  ) as TranslationKey,
                ),
              })}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {t('posventa.entradaEfecto', {
                efecto: t(claveDelEfecto(entrada.effect) as TranslationKey),
              })}
            </Text>
          </View>
        ))
      )}

      <Text variant="caption" color={colors.textMuted}>
        {t('posventa.politicaTitulo')}
      </Text>
      {politica === null ? (
        <Text variant="secondary" color={colors.textMuted}>
          {t('posventa.politicaSinAplicar')}
        </Text>
      ) : (
        <View style={[styles.recuadro, { borderColor: colors.border }]}>
          <Text variant="secondary" weight="700">
            {t('posventa.politicaVersion', { version: politica.version })}
          </Text>
          {momentoLegible(politica.published_at) !== '' ? (
            <Text variant="caption" color={colors.textMuted}>
              {t('posventa.politicaPublicada', {
                fecha: momentoLegible(politica.published_at),
              })}
            </Text>
          ) : null}
          {politica.body !== null && politica.body.trim() !== '' ? (
            <Text variant="secondary">{politica.body}</Text>
          ) : null}
        </View>
      )}

      {/*
        LAS ACCIONES SON LAS QUE MANDA EL SERVIDOR. Ni una más.
      */}
      {contestable ? (
        <View style={styles.bloque}>
          <Text variant="secondary" weight="700">
            {t('posventa.responderTitulo')}
          </Text>
          <Text variant="caption" color={colors.textMuted}>
            {t('posventa.responderAyuda')}
          </Text>
          <Input
            placeholder={t('posventa.motivoEjemplo')}
            value={respuesta}
            onChangeText={(texto) => {
              setRespuesta(texto.slice(0, LARGO_MAXIMO_DEL_MOTIVO));
              if (errorDeRespuesta !== null) setErrorDeRespuesta(null);
            }}
            maxLength={LARGO_MAXIMO_DEL_MOTIVO}
            multiline
            numberOfLines={4}
            style={styles.campoLargo}
            disabled={ocupado}
            error={errorDeRespuesta ?? undefined}
          />
          <Text variant="caption" color={colors.textMuted}>
            {t('posventa.motivoContador', {
              n: escritos,
              max: LARGO_MAXIMO_DEL_MOTIVO,
            })}
          </Text>
          <Button
            label={t('posventa.responderEnviar')}
            onPress={responder}
            loading={ocupado}
            disabled={ocupado}
          />
        </View>
      ) : null}

      {retirable ? (
        <Button
          label={t('posventa.retirar')}
          variant="secondary"
          onPress={retirar}
          disabled={ocupado}
        />
      ) : null}

      {!contestable && !retirable ? (
        <Text variant="caption" color={colors.textMuted}>
          {t('posventa.sinAcciones')}
        </Text>
      ) : null}

      <Button
        label={t('posventa.verSolicitudes')}
        variant="secondary"
        onPress={() => router.replace('/posventa' as never)}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  crece: { flex: 1, gap: 4 },
  bloque: { gap: 4 },
  aviso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  recuadro: {
    gap: 4,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  paso: {
    gap: 4,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  campoLargo: {
    minHeight: 90,
    textAlignVertical: 'top',
    paddingTop: spacing.sm,
  },
});
