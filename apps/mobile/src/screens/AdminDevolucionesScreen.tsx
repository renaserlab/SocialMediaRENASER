import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Chip } from '@/components/Chip';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { registrarSalidaPropia } from '@/navigation/capasAbiertas';
import { deCentavos } from '@/lib/dinero';
import { toast } from '@/lib/toast';
import { ApiError } from '@/services/api';
import {
  ACCIONES_FINANCIERAS,
  ESTADOS_DE_SOLICITUD,
  OwnerRepository,
  type AccionDeDevolucion,
  type DetalleDeSolicitud,
  type EstadoDeSolicitudAdmin,
  type SolicitudAdmin,
} from '@/repositories/OwnerRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

import { esProhibido, useTextosDeGestion } from '@/screens/GestionDeCursoScreen';

/**
 * La bandeja de devoluciones de ADMINISTRACIÓN.
 *
 * TRES REGLAS, y las tres nacen de que aquí se mueve dinero de otra persona:
 *
 *  1. ANTES DE CADA ACCIÓN FINANCIERA SE AVISA de lo que va a pasar, con
 *     palabras y no con un «¿Seguro?». Aprobar autoriza; ejecutar es lo que
 *     pide el dinero a la pasarela, y reintentar vuelve a pedírselo.
 *
 *  2. NO SE PUEDE PULSAR DOS VECES. El cerrojo es una `ref` —no el estado, que
 *     no está puesto hasta el siguiente render— y mientras se envía TODOS los
 *     botones quedan deshabilitados, no solo el pulsado: aprobar y rechazar a
 *     la vez es peor que aprobar dos veces.
 *
 *  3. RECHAZAR EXIGE MOTIVO. Un rechazo sin nada escrito deja a quien lo pidió
 *     sin saber por qué. El botón no se ofrece hasta que hay texto, y el
 *     servidor lo vuelve a exigir.
 *
 * EL PERMISO LO COMPROBA EL SERVIDOR. Esta pantalla no decide quién es
 * administración: si la respuesta es 403 se dice claramente en vez de dejar una
 * lista vacía que parecería «no hay solicitudes».
 */

const POR_PAGINA = 20;

/**
 * Qué se puede hacer desde cada estado, según lo que el servidor acepta. El
 * servidor vuelve a decidirlo: esconder un botón NO es un permiso.
 *
 * `requested` no ofrece aprobar ni rechazar: hay que tomarla primero, y esa era
 * la fila que producía botones muertos. `refund_processing` se afina en
 * `accionesDisponibles`, porque ahí depende de la referencia de la pasarela.
 */
const ACCIONES_POR_ESTADO: Record<EstadoDeSolicitudAdmin, readonly AccionDeDevolucion[]> = {
  requested: ['take', 'cancel'],
  under_review: ['approve', 'reject', 'cancel'],
  approved: ['execute', 'cancel'],
  refund_processing: ['retry'],
  refunded: [],
  rejected: [],
  failed: ['retry', 'cancel'],
  cancelled: [],
};

/**
 * Lo mismo, ya resuelto para una solicitud concreta.
 *
 * En `refund_processing` CON referencia externa el reembolso ya está pedido:
 * reintentarlo sería pedir otro, así que solo cabe conciliar. Sin referencia no
 * hay nada que preguntarle a la pasarela y lo que toca es volver a ejecutarlo.
 */
function accionesDisponibles(solicitud: SolicitudAdmin): readonly AccionDeDevolucion[] {
  if (solicitud.status === 'refund_processing') {
    return solicitud.externalReference ? ['reconcile'] : ['retry'];
  }
  return ACCIONES_POR_ESTADO[solicitud.status];
}

/** El aviso de cada acción. Sin entrada no hay confirmación que enseñar. */
const AVISOS: Partial<Record<AccionDeDevolucion, string>> = {
  approve: 'devolucionesAdmin.avisoAprobar',
  reject: 'devolucionesAdmin.avisoRechazar',
  cancel: 'devolucionesAdmin.avisoCancelar',
  execute: 'devolucionesAdmin.avisoEjecutar',
  retry: 'devolucionesAdmin.avisoReintentar',
  reconcile: 'devolucionesAdmin.avisoReconciliar',
};

/**
 * Los códigos que significan «el expediente ya no está en ese estado»: otro
 * administrador llegó antes, o un webhook entró entre medias. Ahí reintentar no
 * arregla nada y recargar sí, y por eso llevan mensaje propio.
 *
 * ES UNA LISTA CERRADA, Y NO «cualquier 422». El backend usa ese mismo código
 * de respuesta para cosas que NO son un desfase de pantalla y que quedaban
 * tapadas bajo «alguien lo movió»:
 *
 *   · `refund_not_reconciled` — la pasarela dice haber devuelto un importe que
 *     no cuadra con la orden. Es una alarma contable y hay que leerla entera.
 *   · `refund_reason_required` — falta escribir el motivo del rechazo. Lo
 *     arregla quien está mirando la pantalla, no una recarga.
 */
const CONFLICTOS_DE_ESTADO = new Set([
  'refund_invalid_transition',
  'refund_already_refunded',
  'refund_no_external_reference',
  'refund_acceptance_not_needed',
]);

function esConflictoDeEstado(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  // El 409 sí lo es por definición; el 422 depende de QUÉ falló.
  return error.status === 409 || CONFLICTOS_DE_ESTADO.has(error.code);
}

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

export function AdminDevolucionesScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const t = useTextosDeGestion();

  const [solicitudes, setSolicitudes] = useState<SolicitudAdmin[]>([]);
  const [texto, setTexto] = useState('');
  const [busqueda, setBusqueda] = useState('');
  const [estado, setEstado] = useState<EstadoDeSolicitudAdmin | null>(null);
  const [cargando, setCargando] = useState(true);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [hayMas, setHayMas] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prohibido, setProhibido] = useState(false);
  /** Qué solicitud está abierta. `null` es la lista. */
  const [abierta, setAbierta] = useState<DetalleDeSolicitud | null>(null);
  const [abriendo, setAbriendo] = useState(false);
  const masRef = useRef(false);
  /*
    EL DETALLE SE CIERRA CON EL ATRAS FISICO, no solo con su enlace «Volver».

    No es una pantalla aparte: es esta misma cambiando lo que pinta. Sin esto,
    la tecla Atras de Android veia una ruta anterior, salia de la bandeja
    entera y quien estaba mirando un expediente acababa fuera de la seccion.
  */
  useEffect(() => {
    if (!abierta) return;
    return registrarSalidaPropia(() => setAbierta(null));
  }, [abierta]);

  useEffect(() => {
    const temporizador = setTimeout(() => setBusqueda(texto.trim()), 350);
    return () => clearTimeout(temporizador);
  }, [texto]);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    setProhibido(false);
    try {
      const pagina = await OwnerRepository.solicitudes({
        status: estado,
        q: busqueda || undefined,
        limit: POR_PAGINA,
        offset: 0,
      });
      setSolicitudes(pagina);
      setHayMas(pagina.length === POR_PAGINA);
    } catch (e) {
      if (esProhibido(e)) setProhibido(true);
      else setError(e instanceof Error ? e.message : t('common.loadFailed'));
      setSolicitudes([]);
      setHayMas(false);
    } finally {
      setCargando(false);
    }
  }, [busqueda, estado, t]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const cargarMas = useCallback(async () => {
    if (masRef.current || !hayMas || cargando) return;
    masRef.current = true;
    setCargandoMas(true);
    try {
      const pagina = await OwnerRepository.solicitudes({
        status: estado,
        q: busqueda || undefined,
        limit: POR_PAGINA,
        offset: solicitudes.length,
      });
      setSolicitudes((previas) => {
        const vistas = new Set(previas.map((s) => s.id));
        return [...previas, ...pagina.filter((s) => !vistas.has(s.id))];
      });
      setHayMas(pagina.length === POR_PAGINA);
    } catch {
      setHayMas(false);
    } finally {
      masRef.current = false;
      setCargandoMas(false);
    }
  }, [busqueda, cargando, estado, hayMas, solicitudes.length]);

  const abrir = useCallback(
    async (id: string) => {
      setAbriendo(true);
      try {
        setAbierta(await OwnerRepository.solicitud(id));
      } catch (e) {
        if (esProhibido(e)) notify(t('devolucionesAdmin.sinPermiso'), t('common.tryAgain'));
        else notify(t('devolucionesAdmin.detalleFallo'), t('common.tryAgain'));
      } finally {
        setAbriendo(false);
      }
    },
    [t],
  );

  const cabecera = (
    <AppHeader
      title={t('devolucionesAdmin.titulo')}
      onBack={() => {
        if (abierta) {
          setAbierta(null);
          return;
        }
        if (router.canGoBack()) router.back();
        else router.replace('/');
      }}
    />
  );

  if (prohibido) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {cabecera}
        <StateView state="empty" icon="lock" description={t('devolucionesAdmin.sinPermiso')} />
      </View>
    );
  }

  if (abierta) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {cabecera}
        <Detalle
          solicitud={abierta}
          t={t}
          onVolver={() => setAbierta(null)}
          onCambio={(nueva) => {
            setAbierta(nueva);
            // La lista de detrás se queda desfasada en cuanto cambia un estado.
            void cargar();
          }}
        />
      </View>
    );
  }

  const filtros = (
    <View style={styles.cabecera}>
      <Input
        value={texto}
        onChangeText={setTexto}
        placeholder={t('devolucionesAdmin.buscar')}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
      />
      <View style={styles.chips}>
        <Chip
          label={t('devolucionesAdmin.todas')}
          selected={estado === null}
          onPress={() => setEstado(null)}
        />
        {ESTADOS_DE_SOLICITUD.map((valor) => (
          <Chip
            key={valor}
            label={t(`devolucionesAdmin.estado.${valor}`)}
            selected={estado === valor}
            onPress={() => setEstado(valor)}
          />
        ))}
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {cabecera}
      <FlatList
        data={solicitudes}
        keyExtractor={(solicitud) => solicitud.id}
        ListHeaderComponent={filtros}
        contentContainerStyle={styles.lista}
        keyboardShouldPersistTaps="handled"
        onEndReachedThreshold={0.4}
        onEndReached={() => void cargarMas()}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => void abrir(item.id)}
            disabled={abriendo}
            accessibilityRole="button"
            accessibilityLabel={item.courseTitle || item.id}
            accessibilityState={{ disabled: abriendo }}
            style={[
              styles.fila,
              {
                borderColor: colors.border,
                backgroundColor: colors.surface,
                opacity: abriendo ? 0.6 : 1,
              },
            ]}
          >
            <Text style={[styles.nombre, { color: colors.text }]} numberOfLines={2}>
              {item.courseTitle}
            </Text>
            {item.requesterName ? (
              <Text style={[styles.dato, { color: colors.textMuted }]} numberOfLines={1}>
                {item.requesterName}
              </Text>
            ) : null}
            <Text style={[styles.dato, { color: colors.textMuted }]}>
              {`${t('devolucionesAdmin.pedidaEl', { fecha: fechaLegible(item.requestedAt) })} · ${deCentavos(
                item.amountMinor,
                item.currency,
              )}`}
            </Text>
            <Etiqueta texto={t(`devolucionesAdmin.estado.${item.status}`)} />
          </Pressable>
        )}
        ListEmptyComponent={
          cargando ? (
            <StateView state="loading" />
          ) : error ? (
            <StateView state="error" description={error} onRetry={() => void cargar()} />
          ) : (
            <StateView
              state="empty"
              icon="inbox"
              title={t('devolucionesAdmin.vacioTitulo')}
              description={t('devolucionesAdmin.vacioCuerpo')}
            />
          )
        }
        ListFooterComponent={
          cargandoMas ? (
            <ActivityIndicator style={styles.pie} color={colors.textMuted} />
          ) : hayMas ? (
            <Pressable
              onPress={() => void cargarMas()}
              accessibilityRole="button"
              accessibilityLabel={t('devolucionesAdmin.cargarMas')}
              style={styles.pie}
            >
              <Text style={[styles.cargarMas, { color: colors.text }]}>
                {t('devolucionesAdmin.cargarMas')}
              </Text>
            </Pressable>
          ) : null
        }
      />
    </View>
  );
}

function Detalle({
  solicitud,
  t,
  onVolver,
  onCambio,
}: {
  solicitud: DetalleDeSolicitud;
  t: (clave: string, params?: Record<string, string | number>) => string;
  onVolver: () => void;
  onCambio: (nueva: DetalleDeSolicitud) => void;
}) {
  const { colors } = useAppTheme();
  const [notas, setNotas] = useState('');
  /** Qué acción se está enviando. Mientras haya una, NINGUNA está disponible. */
  const [enviando, setEnviando] = useState<AccionDeDevolucion | null>(null);
  const enviandoRef = useRef(false);

  const ejecutar = async (accion: AccionDeDevolucion): Promise<void> => {
    // Cerrojo síncrono: `enviando` no está puesto hasta el siguiente render, y
    // dos toques rápidos caben de sobra en ese hueco. Se cierra ANTES de abrir
    // el diálogo, porque cerrarlo después deja pasar los dos toques: los dos
    // encuentran la referencia abierta y aceptar los dos avisos ejecuta la
    // acción financiera dos veces.
    if (enviandoRef.current) return;
    const motivo = notas.trim();
    if (accion === 'reject' && motivo === '') {
      notify(t('devolucionesAdmin.notasFaltan'));
      return;
    }
    enviandoRef.current = true;
    const aviso = AVISOS[accion];
    if (aviso) {
      const aceptado = await confirm({
        title: ACCIONES_FINANCIERAS.includes(accion)
          ? t('devolucionesAdmin.avisoTitulo')
          : t(`devolucionesAdmin.${accion === 'reject' ? 'rechazar' : 'cancelar'}`),
        message: t(aviso),
        confirmLabel: t(`devolucionesAdmin.${ETIQUETA_DE_ACCION[accion]}`),
        destructive: accion === 'reject' || accion === 'cancel',
      });
      if (!aceptado) {
        enviandoRef.current = false;
        return;
      }
    }
    setEnviando(accion);
    try {
      await OwnerRepository.accion(solicitud.id, accion, motivo || undefined);
      // Se relee el expediente entero: la respuesta de la acción puede no traer
      // el historial, y el historial es lo que aquí hay que ver.
      onCambio(await OwnerRepository.solicitud(solicitud.id));
      setNotas('');
      toast(t('devolucionesAdmin.hecho'));
    } catch (e) {
      /*
        Tres desenlaces distintos, tres mensajes distintos. Un 403 es «tu cuenta
        no puede»; un 409/422, «el expediente ya no está en ese estado» —y
        entonces se relee, porque la pantalla es la que va desfasada—; lo demás
        es un fallo de verdad.
      */
      const conflicto = esConflictoDeEstado(e);
      notify(
        esProhibido(e)
          ? t('devolucionesAdmin.sinPermiso')
          : conflicto
            ? t('devolucionesAdmin.conflicto')
            : t('devolucionesAdmin.fallo'),
        e instanceof Error ? e.message : t('common.tryAgain'),
      );
      if (conflicto) {
        try {
          onCambio(await OwnerRepository.solicitud(solicitud.id));
        } catch {
          // Si tampoco se puede releer, se queda lo que hay: ya se avisó.
        }
      }
    } finally {
      enviandoRef.current = false;
      setEnviando(null);
    }
  };

  const disponibles = accionesDisponibles(solicitud);
  const ocupado = enviando !== null;

  return (
    <AppScreen contentStyle={styles.detalle}>
      <Pressable
        onPress={onVolver}
        accessibilityRole="button"
        accessibilityLabel={t('devolucionesAdmin.volver')}
        style={styles.volver}
      >
        <Feather name="arrow-left" size={14} color={colors.text} />
        <Text style={[styles.volverTexto, { color: colors.text }]}>
          {t('devolucionesAdmin.volver')}
        </Text>
      </Pressable>

      <Text style={[styles.nombre, { color: colors.text }]}>{solicitud.courseTitle}</Text>
      {solicitud.requesterName ? (
        <Text style={[styles.dato, { color: colors.textMuted }]}>{solicitud.requesterName}</Text>
      ) : null}
      <Text style={[styles.dato, { color: colors.textMuted }]}>
        {`${t('devolucionesAdmin.pedidaEl', { fecha: fechaLegible(solicitud.requestedAt) })} · ${deCentavos(
          solicitud.amountMinor,
          solicitud.currency,
        )}`}
      </Text>
      <Etiqueta texto={t(`devolucionesAdmin.estado.${solicitud.status}`)} />
      {solicitud.reason ? (
        <Text style={[styles.parrafo, { color: colors.text }]}>{solicitud.reason}</Text>
      ) : null}

      {/* HISTORIAL DE ESTADOS: sin él una bandeja no es un expediente, es una
          lista de botones. */}
      <Text style={[styles.seccion, { color: colors.textMuted }]}>
        {t('devolucionesAdmin.historial')}
      </Text>
      <View
        style={[styles.tarjeta, { borderColor: colors.border, backgroundColor: colors.surface }]}
      >
        {solicitud.history.map((paso) => (
          <View key={paso.id} style={styles.paso}>
            <Text style={[styles.pasoEstado, { color: colors.text }]}>
              {t(`devolucionesAdmin.estado.${paso.status}`)}
            </Text>
            <Text style={[styles.dato, { color: colors.textMuted }]}>
              {[fechaLegible(paso.at), paso.actor].filter(Boolean).join(' · ')}
            </Text>
            {paso.notes ? (
              <Text style={[styles.dato, { color: colors.textMuted }]}>{paso.notes}</Text>
            ) : null}
          </View>
        ))}
      </View>

      {disponibles.length > 0 ? (
        <React.Fragment>
          <Input
            value={notas}
            onChangeText={setNotas}
            label={t('devolucionesAdmin.notas')}
            multiline
            numberOfLines={3}
            editable={!ocupado}
          />
          <View style={styles.acciones}>
            {disponibles.map((accion) => (
              <Pressable
                key={accion}
                onPress={() => void ejecutar(accion)}
                /* Mientras se envía CUALQUIER acción, todas quedan apagadas. */
                disabled={ocupado}
                accessibilityRole="button"
                accessibilityLabel={t(`devolucionesAdmin.${ETIQUETA_DE_ACCION[accion]}`)}
                accessibilityState={{ disabled: ocupado }}
                style={[
                  styles.accion,
                  { borderColor: colors.border, opacity: ocupado ? 0.5 : 1 },
                ]}
              >
                {enviando === accion ? (
                  <ActivityIndicator size="small" color={colors.text} />
                ) : (
                  <Text style={[styles.accionTexto, { color: colors.text }]}>
                    {t(`devolucionesAdmin.${ETIQUETA_DE_ACCION[accion]}`)}
                  </Text>
                )}
              </Pressable>
            ))}
          </View>
        </React.Fragment>
      ) : null}
    </AppScreen>
  );
}

/** El sufijo de la clave de cada acción. */
const ETIQUETA_DE_ACCION: Record<AccionDeDevolucion, string> = {
  take: 'tomar',
  approve: 'aprobar',
  reject: 'rechazar',
  cancel: 'cancelar',
  execute: 'ejecutar',
  retry: 'reintentar',
  reconcile: 'reconciliar',
};

function Etiqueta({ texto }: { texto: string }) {
  const { colors } = useAppTheme();
  return (
    <View style={[styles.etiqueta, { borderColor: colors.border }]}>
      <Text style={[styles.etiquetaTexto, { color: colors.text }]}>{texto}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  lista: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm },
  detalle: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm },
  cabecera: { gap: spacing.sm, marginBottom: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  fila: { borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.xs },
  nombre: { fontSize: 15, fontWeight: '800' },
  dato: { fontSize: 12 },
  parrafo: { fontSize: 13, lineHeight: 19, marginTop: spacing.sm },
  seccion: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.lg,
  },
  tarjeta: { borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.md },
  paso: { gap: 2 },
  pasoEstado: { fontSize: 13, fontWeight: '700' },
  etiqueta: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 3,
    marginTop: spacing.xs,
  },
  etiquetaTexto: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  acciones: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  accion: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minWidth: 96,
    alignItems: 'center',
  },
  accionTexto: { fontSize: 13, fontWeight: '700' },
  volver: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
  volverTexto: { fontSize: 13, fontWeight: '700' },
  pie: { paddingVertical: spacing.lg, alignItems: 'center' },
  cargarMas: { fontSize: 13, fontWeight: '700' },
});
