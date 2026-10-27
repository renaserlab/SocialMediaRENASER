import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useLocalSearchParams, useRouter } from 'expo-router';

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
  DESENLACES,
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
  tonoDelEstado,
} from '@/lib/posventaDeEventos';
import {
  CLASIFICACIONES_QUE_SE_PUEDEN_ELEGIR,
  ESCALERA_DEL_DINERO,
  LARGO_MAXIMO_DEL_MOTIVO_DE_DECISION,
  LARGO_MAXIMO_DE_LA_NOTA_INTERNA,
  accionesDeAdministracion,
  claveDeAccion,
  claveDeClasificacion,
  claveDeErrorDeAdministracion,
  claveDeFaseDelDinero,
  claveDelCampoDelEvento,
  claveDelCuerpoDeLaFase,
  esConflictoDeExpediente,
  estaSinClasificar,
  exigeMotivo,
  faseAlcanzada,
  faseDelDinero,
  leerImporte,
  llevaDesenlace,
  pasosSinPantalla,
  textoUtil,
  tonoDeLaFase,
  type AccionDeAdministracion,
} from '@/lib/posventaAdmin';
import {
  EventAftersaleAdminRepository,
  type CambioDelEvento,
  type ExpedienteDeAdministracion,
} from '@/repositories/EventAftersaleAdminRepository';
import {
  EventAftersaleRepository,
  type EntradaAfectada,
  type LineaDeHistorial,
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
 * Un expediente visto por quien lo decide.
 *
 * CUATRO COSAS DISTINTAS, PINTADAS DISTINTAS. «Aprobada», «pedida al
 * proveedor», «en curso» y «confirmada» tienen cada una su fila en la escalera
 * del dinero, con su propia explicación de qué ha pasado y qué NO ha pasado
 * todavía. Aprobar deja el expediente en `approved` y nada más: ni esta
 * pantalla ni ninguna otra puede declarar que el dinero volvió, porque eso solo
 * lo alcanza un aviso verificado del proveedor.
 *
 * ALGUIEN PUEDE ADELANTARSE, Y NO ES UN ERROR SECO. Dos personas con el mismo
 * caso abierto es lo normal en una bandeja compartida. Cuando el servidor
 * contesta 409 `event_case_changed`, aquí se dice que otra persona actuó
 * primero, se RECARGA el expediente y se deja decidir otra vez sobre lo que hay
 * ahora, en vez de mandar a alguien a salir y volver a entrar.
 *
 * LOS BOTONES SON LOS DEL SERVIDOR, filtrados por los que tienen ruta escrita.
 * Ejecutar la devolución o darla por resuelta no se hacen desde la aplicación:
 * se nombran —para que nadie crea que el expediente está atascado— y no se
 * pintan como botones que acabarían en un 404.
 *
 * NO HAY LECTURA POR ID EN EL SERVIDOR. El expediente se busca dentro de la
 * bandeja, acotada por el evento cuando se llega desde la lista. Si no aparece,
 * se dice que no se encuentra: no se finge nada.
 */
export function ExpedienteAdminScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id, evento } = useLocalSearchParams<{ id: string; evento?: string }>();

  const [expediente, setExpediente] = useState<ExpedienteDeAdministracion | null>(null);
  const [historial, setHistorial] = useState<LineaDeHistorial[]>([]);
  const [entradas, setEntradas] = useState<EntradaAfectada[]>([]);
  const [detalleDelComprador, setDetalleDelComprador] = useState(true);
  const [cambios, setCambios] = useState<CambioDelEvento[]>([]);
  const [versionDePolitica, setVersionDePolitica] = useState<string | null>(null);

  const [accion, setAccion] = useState<AccionDeAdministracion | null>(null);
  const [motivo, setMotivo] = useState('');
  const [notaInterna, setNotaInterna] = useState('');
  const [desenlace, setDesenlace] = useState<string | null>(null);
  const [importe, setImporte] = useState('');
  const [moneda, setMoneda] = useState('');
  const [errorDelFormulario, setErrorDelFormulario] = useState<string | null>(null);

  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'sinPermiso' | 'noEncontrado' | 'noDisponible' | null
  >(null);
  const [conflicto, setConflicto] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  const cargar = useCallback(async () => {
    if (!id) return;
    setCargando(true);
    setFallo(null);
    try {
      const ficha = await EventAftersaleAdminRepository.buscarEnLaBandeja(
        id,
        evento ?? null,
      );
      if (ficha === null) {
        setFallo('noEncontrado');
        return;
      }
      setExpediente(ficha);
      /*
        LO DE APOYO NO TUMBA LA PANTALLA. El expediente ya se leyó; quedarse sin
        la línea de tiempo se cuenta como lo que es —no se pudo ver— y no como
        un fallo de carga entero.

        EL HISTORIAL Y LAS ENTRADAS SON RUTAS DEL COMPRADOR: el servidor las
        entrega solo a quien compró, así que desde administración contestan 404.
        Se intentan igual —por si algún día se abren— y, si no vienen, se dice
        con todas las letras en vez de enseñar dos listas vacías que se leerían
        como «este expediente no tiene entradas».
      */
      const [linea, tickets, cambiosDelEvento, politicas] = await Promise.all([
        EventAftersaleRepository.historial(id).catch(() => null),
        EventAftersaleRepository.entradas(id).catch(() => null),
        EventAftersaleAdminRepository.cambios({
          eventoId: ficha.event_id,
          limite: 50,
        }).catch(() => [] as CambioDelEvento[]),
        ficha.policy_id !== null
          ? EventAftersaleAdminRepository.politicas('aftersale_eligibility').catch(
              () => [],
            )
          : Promise.resolve([]),
      ]);
      setDetalleDelComprador(linea !== null || tickets !== null);
      setHistorial(linea ?? []);
      setEntradas(tickets ?? []);
      setCambios(cambiosDelEvento);
      setVersionDePolitica(
        politicas.find((politica) => politica.id === ficha.policy_id)?.version ?? null,
      );
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
  }, [id, evento]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const textoDelError = (error: unknown) => {
    if (error instanceof ApiError) {
      const clave =
        claveDeErrorDeAdministracion(error.code) ?? claveDeErrorDePosventa(error.code);
      if (clave !== null) return t(clave as TranslationKey);
    }
    return error instanceof Error && error.message.trim() !== ''
      ? error.message
      : t('common.tryAgain');
  };

  const conCerrojo = async (trabajo: () => Promise<void>) => {
    // ANTES DEL PRIMER `await`, que aquí puede ser un diálogo: dos toques
    // rápidos mandarían dos veces la misma decisión sobre el dinero de alguien.
    if (ocupadoRef.current || !id) return;
    ocupadoRef.current = true;
    setOcupado(true);
    setConflicto(false);
    try {
      await trabajo();
    } catch (error) {
      /*
        ALGUIEN ACTUÓ PRIMERO. No es un error que cerrar y olvidar: se avisa, se
        recarga el expediente y el formulario sigue abierto con lo escrito, para
        poder volver a decidir sobre el estado que hay ahora.
      */
      if (error instanceof ApiError && esConflictoDeExpediente(error.code)) {
        setConflicto(true);
        await cargar();
      } else {
        notify(t('posventaAdmin.noSePudo'), textoDelError(error));
      }
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  const limpiarFormulario = () => {
    setAccion(null);
    setMotivo('');
    setNotaInterna('');
    setDesenlace(null);
    setImporte('');
    setMoneda('');
    setErrorDelFormulario(null);
  };

  /** Manda la acción elegida. El servidor decide; aquí solo se valida lo obvio. */
  const enviar = (cual: AccionDeAdministracion) => {
    const motivoLimpio = textoUtil(motivo, LARGO_MAXIMO_DEL_MOTIVO_DE_DECISION);
    const notasLimpias = textoUtil(notaInterna, LARGO_MAXIMO_DE_LA_NOTA_INTERNA);
    if (exigeMotivo(cual) && motivoLimpio === null) {
      setErrorDelFormulario(t('posventaAdmin.faltaMotivo'));
      return;
    }
    const dinero = leerImporte(importe, moneda);
    if (llevaDesenlace(cual)) {
      if (dinero.estado === 'invalido') {
        setErrorDelFormulario(t('posventaAdmin.importeInvalido'));
        return;
      }
      if (dinero.estado === 'incompleto') {
        setErrorDelFormulario(
          dinero.falta === 'moneda'
            ? t('posventaAdmin.faltaMoneda')
            : t('posventaAdmin.faltaImporte'),
        );
        return;
      }
    }
    setErrorDelFormulario(null);

    void conCerrojo(async () => {
      if (cual === 'approved' || cual === 'rejected') {
        const aceptado = await confirm({
          title:
            cual === 'approved'
              ? t('posventaAdmin.aprobarTitulo')
              : t('posventaAdmin.rechazarTitulo'),
          message:
            cual === 'approved'
              ? t('posventaAdmin.aprobarCuerpo')
              : t('posventaAdmin.rechazarCuerpo'),
          confirmLabel:
            cual === 'approved'
              ? t('posventaAdmin.aprobarBoton')
              : t('posventaAdmin.rechazarBoton'),
          destructive: cual === 'rejected',
        });
        if (!aceptado) return;
      }

      const caso = id as string;
      let actualizado: ExpedienteDeAdministracion;
      if (cual === 'under_review') {
        actualizado = await EventAftersaleAdminRepository.tomar(caso, notasLimpias);
      } else if (cual === 'awaiting_information') {
        actualizado = await EventAftersaleAdminRepository.pedirInformacion(
          caso,
          motivoLimpio as string,
          notasLimpias,
        );
      } else if (cual === 'approved') {
        actualizado = await EventAftersaleAdminRepository.aprobar(caso, {
          motivo: motivoLimpio,
          notas: notasLimpias,
          desenlace,
          importeMinor: dinero.estado === 'listo' ? dinero.centavos : null,
          moneda: dinero.estado === 'listo' ? dinero.moneda : null,
        });
      } else {
        actualizado = await EventAftersaleAdminRepository.rechazar(
          caso,
          motivoLimpio as string,
          notasLimpias,
        );
      }
      setExpediente(actualizado);
      limpiarFormulario();
      toast(t('posventaAdmin.hecho'));
      await cargar();
    });
  };

  const clasificar = (cambio: CambioDelEvento, clasificacion: string) =>
    void conCerrojo(async () => {
      const actualizado = await EventAftersaleAdminRepository.clasificar(
        cambio.id,
        clasificacion,
      );
      setCambios((previos) =>
        previos.map((fila) => (fila.id === actualizado.id ? actualizado : fila)),
      );
      toast(t('posventaAdmin.hecho'));
    });

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/admin/posventa' as never);

  if (cargando) {
    return (
      <AppScreen>
        <AppHeader title={t('posventaAdmin.tituloExpediente')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || expediente === null) {
    return (
      <AppScreen>
        <AppHeader title={t('posventaAdmin.tituloExpediente')} onBack={volver} />
        {fallo === 'noEncontrado' ||
        fallo === 'noDisponible' ||
        fallo === 'sinPermiso' ? (
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
                ? t('posventaAdmin.noDisponible')
                : fallo === 'sinPermiso'
                  ? t('posventaAdmin.sinPermiso')
                  : t('posventaAdmin.noEncontrado')
            }
            description={
              fallo === 'noDisponible'
                ? t('posventaAdmin.noDisponibleCuerpo')
                : fallo === 'sinPermiso'
                  ? t('posventaAdmin.sinPermisoCuerpo')
                  : t('posventaAdmin.noEncontradoCuerpo')
            }
            actionLabel={t('posventaAdmin.verBandeja')}
            onAction={() => router.replace('/admin/posventa' as never)}
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
  const fase = faseDelDinero(expediente.status, expediente.outcome);
  const dineroDeVuelta = elDineroYaVolvio(expediente.status, expediente.outcome);
  const cifra = importeDeLaDevolucion(
    expediente.refund_amount_minor,
    expediente.currency,
  );
  const disponibles = accionesDeAdministracion(expediente);
  const fuera = pasosSinPantalla(expediente);

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={t('posventaAdmin.tituloExpediente')} onBack={volver} />

      <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
        <Feather
          name={
            tono === 'bueno' ? 'check-circle' : tono === 'malo' ? 'alert-circle' : 'clock'
          }
          size={16}
          color={colorDelEstado}
        />
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

      {/* ALGUIEN SE ADELANTÓ: se dice, se recargó, y se puede volver a decidir. */}
      {conflicto ? (
        <View style={[styles.recuadro, { borderColor: colors.danger }]}>
          <Text variant="secondary" weight="700" color={colors.danger}>
            {t('posventaAdmin.conflictoTitulo')}
          </Text>
          <Text variant="secondary">{t('posventaAdmin.conflictoCuerpo')}</Text>
          <Button
            label={t('posventaAdmin.conflictoReintentar')}
            variant="secondary"
            onPress={() => {
              setConflicto(false);
              void cargar();
            }}
            disabled={ocupado}
          />
        </View>
      ) : null}

      {/*
        LA ESCALERA DEL DINERO. Cuatro peldaños que NO son el mismo hecho:
        aprobada, pedida al proveedor, en curso y confirmada. Solo el último
        significa que el dinero volvió, y así está escrito peldaño a peldaño.
      */}
      <Text variant="caption" color={colors.textMuted}>
        {t('posventaAdmin.dineroTitulo')}
      </Text>
      {fase === null ? (
        <Text variant="secondary" color={colors.textMuted}>
          {t('posventaAdmin.sinDineroEnJuego')}
        </Text>
      ) : (
        <View style={[styles.recuadro, { borderColor: colors.border }]}>
          {ESCALERA_DEL_DINERO.map((peldano) => {
            const hecho = faseAlcanzada(fase, peldano);
            const actual = peldano === fase;
            const tonoDelPeldano = tonoDeLaFase(peldano);
            const color = !hecho
              ? colors.textMuted
              : tonoDelPeldano === 'bueno'
                ? colors.success
                : colors.text;
            return (
              <View key={peldano} style={styles.peldano}>
                <Feather
                  name={hecho ? 'check-circle' : 'circle'}
                  size={16}
                  color={color}
                />
                <View style={styles.crece}>
                  <Text variant="secondary" weight={actual ? '700' : '400'} color={color}>
                    {t(claveDeFaseDelDinero(peldano) as TranslationKey)}
                  </Text>
                  {actual ? (
                    <Text variant="caption" color={colors.textMuted}>
                      {t(claveDelCuerpoDeLaFase(peldano) as TranslationKey)}
                    </Text>
                  ) : null}
                </View>
              </View>
            );
          })}
          {fase === 'fallido' ? (
            <View style={styles.peldano}>
              <Feather name="alert-circle" size={16} color={colors.danger} />
              <View style={styles.crece}>
                <Text variant="secondary" weight="700" color={colors.danger}>
                  {t(claveDeFaseDelDinero('fallido') as TranslationKey)}
                </Text>
                <Text variant="caption" color={colors.textMuted}>
                  {t(claveDelCuerpoDeLaFase('fallido') as TranslationKey)}
                </Text>
              </View>
            </View>
          ) : null}
        </View>
      )}

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
          {cifra !== null ? (
            <Text variant="secondary">{t('posventa.importeAprobado', { importe: cifra })}</Text>
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
            {t('posventaAdmin.motivoDeQuienPide')}
          </Text>
          <Text variant="secondary">{expediente.reason}</Text>
        </View>
      ) : null}

      {/* SOLO ADMINISTRACIÓN. No sale de esta pantalla. */}
      <Text variant="caption" color={colors.textMuted}>
        {t('posventaAdmin.notasInternasTitulo')}
      </Text>
      <Text variant="secondary" color={colors.textMuted}>
        {expediente.internal_notes !== null && expediente.internal_notes.trim() !== ''
          ? expediente.internal_notes
          : t('posventaAdmin.notasInternasVacio')}
      </Text>

      <Text variant="caption" color={colors.textMuted}>
        {t('posventaAdmin.tecnicoTitulo')}
      </Text>
      <View style={[styles.recuadro, { borderColor: colors.border }]}>
        <Text variant="caption" color={colors.textMuted}>
          {t('posventaAdmin.proveedor', { valor: expediente.provider })}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {t('posventaAdmin.entorno', { valor: expediente.environment })}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {versionDePolitica !== null
            ? t('posventa.politicaVersion', { version: versionDePolitica })
            : expediente.policy_id !== null
              ? t('posventaAdmin.politicaSinNombre')
              : t('posventa.politicaSinAplicar')}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {expediente.assignee_id !== null
            ? t('posventaAdmin.tomado')
            : t('posventaAdmin.sinTomar')}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {t('posventaAdmin.compradorId', { valor: expediente.buyer_id })}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {t('posventaAdmin.organizadorId', { valor: expediente.organizer_id })}
        </Text>
      </View>

      {/* --------------------------- Decidir --------------------------- */}
      <Text variant="caption" color={colors.textMuted}>
        {t('posventaAdmin.decidirTitulo')}
      </Text>
      {disponibles.length === 0 ? (
        <Text variant="secondary" color={colors.textMuted}>
          {t('posventaAdmin.sinAcciones')}
        </Text>
      ) : (
        <View style={styles.chips}>
          {disponibles.map((cual) => (
            <Chip
              key={cual}
              label={t(claveDeAccion(cual) as TranslationKey)}
              selected={accion === cual}
              rol="radio"
              disabled={ocupado}
              onPress={() => {
                setErrorDelFormulario(null);
                setAccion(accion === cual ? null : cual);
              }}
            />
          ))}
        </View>
      )}

      {/* LO QUE EXISTE Y NO SE HACE AQUÍ. Nombrarlo evita que un expediente
          parezca atascado por no tener botones. */}
      {fuera.length > 0 ? (
        <Text variant="caption" color={colors.textMuted}>
          {t('posventaAdmin.pasosFuera', {
            pasos: fuera
              .map((paso) => t(claveDelEstadoDeExpediente(paso) as TranslationKey))
              .join(', '),
          })}
        </Text>
      ) : null}

      {accion !== null ? (
        <View style={[styles.recuadro, { borderColor: colors.border }]}>
          <Text variant="secondary" weight="700">
            {t(claveDeAccion(accion) as TranslationKey)}
          </Text>
          {accion === 'approved' ? (
            <Text variant="caption" color={colors.textMuted}>
              {t('posventaAdmin.aprobarNoEsPagar')}
            </Text>
          ) : null}

          <Input
            label={
              exigeMotivo(accion)
                ? t('posventaAdmin.motivoObligatorio')
                : t('posventaAdmin.motivoOpcional')
            }
            placeholder={t('posventaAdmin.motivoAyuda')}
            value={motivo}
            onChangeText={(texto) => {
              setMotivo(texto.slice(0, LARGO_MAXIMO_DEL_MOTIVO_DE_DECISION));
              if (errorDelFormulario !== null) setErrorDelFormulario(null);
            }}
            maxLength={LARGO_MAXIMO_DEL_MOTIVO_DE_DECISION}
            multiline
            numberOfLines={3}
            style={styles.campoLargo}
            disabled={ocupado}
          />
          <Text variant="caption" color={colors.textMuted}>
            {t('posventa.motivoContador', {
              n: motivo.length,
              max: LARGO_MAXIMO_DEL_MOTIVO_DE_DECISION,
            })}
          </Text>

          <Input
            label={t('posventaAdmin.notaInterna')}
            placeholder={t('posventaAdmin.notaInternaAyuda')}
            value={notaInterna}
            onChangeText={(texto) =>
              setNotaInterna(texto.slice(0, LARGO_MAXIMO_DE_LA_NOTA_INTERNA))
            }
            maxLength={LARGO_MAXIMO_DE_LA_NOTA_INTERNA}
            multiline
            numberOfLines={3}
            style={styles.campoLargo}
            disabled={ocupado}
          />

          {llevaDesenlace(accion) ? (
            <>
              <Text variant="caption" color={colors.textMuted}>
                {t('posventaAdmin.desenlaceTitulo')}
              </Text>
              <View style={styles.chips}>
                {DESENLACES.map((cual) => (
                  <Chip
                    key={cual}
                    label={t(claveDelDesenlace(cual) as TranslationKey)}
                    selected={desenlace === cual}
                    rol="radio"
                    disabled={ocupado}
                    onPress={() => setDesenlace(desenlace === cual ? null : cual)}
                  />
                ))}
              </View>
              <Text variant="caption" color={colors.textMuted}>
                {t('posventaAdmin.importeAyuda')}
              </Text>
              <Input
                label={t('posventaAdmin.importe')}
                value={importe}
                onChangeText={(texto) => {
                  setImporte(texto);
                  if (errorDelFormulario !== null) setErrorDelFormulario(null);
                }}
                keyboardType="decimal-pad"
                disabled={ocupado}
              />
              <Input
                label={t('posventaAdmin.moneda')}
                value={moneda}
                onChangeText={(texto) => {
                  setMoneda(texto.slice(0, 3));
                  if (errorDelFormulario !== null) setErrorDelFormulario(null);
                }}
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={3}
                disabled={ocupado}
              />
            </>
          ) : null}

          {errorDelFormulario !== null ? (
            <Text variant="caption" color={colors.danger}>
              {errorDelFormulario}
            </Text>
          ) : null}

          <Button
            label={t('posventaAdmin.mandar')}
            onPress={() => enviar(accion)}
            loading={ocupado}
            disabled={ocupado}
          />
          <Button
            label={t('common.cancel')}
            variant="ghost"
            onPress={limpiarFormulario}
            disabled={ocupado}
          />
        </View>
      ) : null}

      {/* -------------------------- Historial -------------------------- */}
      <Text variant="caption" color={colors.textMuted}>
        {t('posventa.historialTitulo')}
      </Text>
      {!detalleDelComprador ? (
        <Text variant="secondary" color={colors.textMuted}>
          {t('posventaAdmin.detalleNoDisponible')}
        </Text>
      ) : historial.length === 0 ? (
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

      {/* -------------------------- Entradas --------------------------- */}
      {detalleDelComprador ? (
        <>
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
                  {t('posventa.entradaEfecto', {
                    efecto: t(claveDelEfecto(entrada.effect) as TranslationKey),
                  })}
                </Text>
              </View>
            ))
          )}
        </>
      ) : null}

      {/* ------------------- Cambios del evento ------------------------ */}
      <Text variant="caption" color={colors.textMuted}>
        {t('posventaAdmin.cambiosTitulo')}
      </Text>
      <Text variant="caption" color={colors.textMuted}>
        {t('posventaAdmin.clasificarAviso')}
      </Text>
      {cambios.length === 0 ? (
        <Text variant="secondary" color={colors.textMuted}>
          {t('posventaAdmin.cambiosVacio')}
        </Text>
      ) : (
        cambios.map((cambio) => (
          <View key={cambio.id} style={[styles.paso, { borderColor: colors.border }]}>
            <Text variant="secondary" weight="700">
              {t(claveDelCampoDelEvento(cambio.field) as TranslationKey)}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {t('posventaAdmin.cambioAntes', {
                valor: cambio.previous_value ?? t('posventaAdmin.cambioSinValor'),
              })}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {t('posventaAdmin.cambioAhora', {
                valor: cambio.new_value ?? t('posventaAdmin.cambioSinValor'),
              })}
            </Text>
            <Text
              variant="caption"
              color={
                estaSinClasificar(cambio.classification) ? colors.danger : colors.textMuted
              }
            >
              {t(claveDeClasificacion(cambio.classification) as TranslationKey)}
            </Text>
            <View style={styles.chips}>
              {CLASIFICACIONES_QUE_SE_PUEDEN_ELEGIR.map((cual) => (
                <Chip
                  key={cual}
                  label={t(claveDeClasificacion(cual) as TranslationKey)}
                  selected={cambio.classification === cual}
                  rol="radio"
                  disabled={ocupado}
                  onPress={() => clasificar(cambio, cual)}
                />
              ))}
            </View>
          </View>
        ))
      )}

      <Button
        label={t('posventaAdmin.verBandeja')}
        variant="secondary"
        onPress={() => router.replace('/admin/posventa' as never)}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  crece: { flex: 1, gap: 4 },
  bloque: { gap: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  aviso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  recuadro: {
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  peldano: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  paso: {
    gap: 4,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  campoLargo: {
    minHeight: 72,
    textAlignVertical: 'top',
    paddingTop: spacing.sm,
  },
});
