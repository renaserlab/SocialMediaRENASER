import React, { useCallback, useRef, useState } from 'react';
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
import { confirm, notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import {
  ESTADOS_QUE_SE_FILTRAN,
  LARGO_MAXIMO_DEL_MOTIVO,
  LIMITE_INICIAL,
  abreviarIdentificador,
  claveDeErrorDeProductos,
  claveDelBloqueoDePublicacion,
  claveDelCuerpoDelFallo,
  claveDelEstadoDeProducto,
  claveDelFallo,
  enCatalogo,
  esAprobadoConCondiciones,
  esConflicto,
  falloDeCarga,
  llegoAlTope,
  ofreceSuspender,
  revisarMotivo,
  sePuedePublicar,
  seReintenta,
  siguienteLimite,
  tonoDelEstado,
  transicionExigeMotivo,
  transicionesQueSeOfrecen,
  type FalloDeCarga,
  type ProductoDeAdministracion,
} from '@/lib/evaluacionDeProductos';
import { ProductAdmissionRepository } from '@/repositories/ProductAdmissionRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Lo que se está haciendo con un producto: suspenderlo o moverlo a un estado.
 *
 * `hasta` es `null` cuando lo que se pide es una suspensión, que tiene su propia ruta
 * porque comprueba cosas que `transition` no comprueba.
 */
type EnCurso = { id: string; hasta: string | null };

/**
 * El listado administrativo de productos. Pantalla INTERNA.
 *
 * LOS BOTONES LOS MANDA EL SERVIDOR. Cada producto viene con `acciones` —lo que ESTE
 * actor puede hacer ahora— y con `bloqueo` —por qué todavía no se puede publicar—. Aquí
 * no se recalcula ninguna de las dos cosas: repetir las comprobaciones de la evaluación
 * aprobada, las tres razones y la foto es exactamente cómo se acaba enseñando un botón
 * que el servidor va a rechazar. Y el servidor lo vuelve a comprobar en cada ruta.
 *
 * `conditionally_approved` NO PUEDE PUBLICAR, Y SE DICE. No se esconde el botón sin más:
 * el motivo es que la empresa no ha definido qué condiciones exactas se le exigen a un
 * producto aprobado con condiciones, y hay que volver a evaluarlo. Un botón ausente sin
 * explicación se lee como un fallo de la aplicación.
 *
 * PUBLICAR Y SUSPENDER NO SON TRANSICIONES CUALQUIERA. Tienen su propia ruta y no se
 * ofrecen entre los saltos genéricos: publicar exige la evaluación, las razones y la
 * foto; suspender exige un motivo que se le pueda enseñar a quien vende.
 *
 * SUSPENDER NO ES RETIRAR. Suspender saca el producto del catálogo y se puede deshacer
 * volviendo a publicar; retirar no se deshace, y es un salto aparte que la máquina del
 * servidor solo ofrece a administración.
 *
 * NINGÚN PERMISO FINANCIERO. Aquí no hay saldos, ni transferencias, ni precios
 * editables: publicar un producto no mueve dinero.
 *
 * QUIÉN PUEDE ABRIRLA LO DECIDE EL SERVIDOR. Quien no es curaduría recibe un 403 y lee
 * su propio aviso.
 */
export function AdminProductosScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();

  /** `t` no acepta una cadena suelta: las claves salen del módulo de reglas. */
  const f = (clave: string, params?: Record<string, string | number>) =>
    t(clave as TranslationKey, params);

  const [filas, setFilas] = useState<ProductoDeAdministracion[]>([]);
  const [estado, setEstado] = useState<string | null>(null);
  const [limite, setLimite] = useState<number>(LIMITE_INICIAL);

  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<FalloDeCarga | null>(null);
  const [conflicto, setConflicto] = useState(false);

  const [abierto, setAbierto] = useState<string | null>(null);
  const [enCurso, setEnCurso] = useState<EnCurso | null>(null);
  const [motivo, setMotivo] = useState('');
  const [errorDelFormulario, setErrorDelFormulario] = useState<string | null>(null);

  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      setFilas(await ProductAdmissionRepository.productos({ estado, limite }));
    } catch (error) {
      setFallo(
        error instanceof ApiError
          ? falloDeCarga(error.status, error.code)
          : falloDeCarga(null, null),
      );
    } finally {
      setCargando(false);
    }
  }, [estado, limite]);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  const textoDelError = (error: unknown) => {
    if (error instanceof ApiError) {
      const clave = claveDeErrorDeProductos(error.code);
      if (clave !== null) return f(clave);
      if (error.status === 403) return f('productosAdmin.falloCuerpo.sinPermiso');
      if (error.status === 401) return f('productosAdmin.falloCuerpo.sinSesion');
      if (error.status === 422) return f('productosAdmin.falloCuerpo.datosInvalidos');
    }
    return error instanceof Error && error.message.trim() !== ''
      ? error.message
      : t('common.tryAgain');
  };

  /** El cerrojo, ANTES del primer `await` —que aquí es un diálogo—. */
  const conCerrojo = async (trabajo: () => Promise<void>) => {
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    setOcupado(true);
    setConflicto(false);
    try {
      await trabajo();
    } catch (error) {
      if (error instanceof ApiError && esConflicto(error.code)) {
        setConflicto(true);
        await cargar();
      } else {
        notify(f('productosAdmin.noSePudo'), textoDelError(error));
      }
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  const cerrarFormulario = () => {
    setEnCurso(null);
    setMotivo('');
    setErrorDelFormulario(null);
  };

  const abrirFormulario = (producto: ProductoDeAdministracion, hasta: string | null) => {
    setEnCurso({ id: producto.id, hasta });
    setMotivo('');
    setErrorDelFormulario(null);
  };

  const elegirEstado = (valor: string | null) => {
    setLimite(LIMITE_INICIAL);
    cerrarFormulario();
    setEstado(valor);
  };

  /**
   * Publica. SIN CUERPO: el servidor comprueba la evaluación, las razones y la foto.
   *
   * Solo se llega aquí cuando `sePuedePublicar` lee que el servidor lo ofrece y no ha
   * mandado ningún bloqueo.
   */
  const publicar = (producto: ProductoDeAdministracion) => {
    void conCerrojo(async () => {
      const aceptado = await confirm({
        title: f('productosAdmin.confirmarPublicarTitulo'),
        message: f('productosAdmin.confirmarPublicarCuerpo'),
        confirmLabel: f('productosAdmin.publicar'),
      });
      if (!aceptado) return;
      await ProductAdmissionRepository.publicar(producto.id);
      await cargar();
      toast(f('productosAdmin.publicado'));
    });
  };

  /**
   * Suspende o transiciona. EL MOTIVO SE COMPRUEBA AQUÍ cuando hace falta.
   *
   * Suspender lo exige el servidor (`product_suspension_needs_reason`); devolver a
   * borrador y retirar lo exigen aquí, porque un producto que vuelve sin una línea que
   * explique por qué deja a quien lo vende sin nada que corregir.
   */
  const mover = (producto: ProductoDeAdministracion, hasta: string | null) => {
    const obligatorio = hasta === null || transicionExigeMotivo(hasta);
    const revisado = revisarMotivo(obligatorio, motivo);
    if (revisado.estado === 'falta') {
      setErrorDelFormulario(f('productosAdmin.faltaMotivo'));
      return;
    }
    if (revisado.estado === 'largo') {
      setErrorDelFormulario(f('productosAdmin.motivoLargo', { max: revisado.maximo }));
      return;
    }
    setErrorDelFormulario(null);

    void conCerrojo(async () => {
      const aceptado = await confirm({
        title:
          hasta === null
            ? f('productosAdmin.confirmarSuspenderTitulo')
            : f('productosAdmin.confirmarTransicionTitulo', {
                estado: f(claveDelEstadoDeProducto(hasta)),
              }),
        message:
          hasta === null
            ? f('productosAdmin.confirmarSuspenderCuerpo')
            : f('productosAdmin.confirmarTransicionCuerpo'),
        confirmLabel: hasta === null ? f('productosAdmin.suspender') : f('productosAdmin.mandar'),
        destructive: true,
      });
      if (!aceptado) return;
      if (hasta === null) {
        await ProductAdmissionRepository.suspender(
          producto.id,
          revisado.motivo as string,
        );
      } else {
        await ProductAdmissionRepository.transicionar(
          producto.id,
          hasta,
          revisado.motivo,
        );
      }
      await cargar();
      cerrarFormulario();
      toast(f('productosAdmin.hecho'));
    });
  };

  /**
   * Abre la evaluación de la versión borrador y lleva a la pantalla de evaluar.
   *
   * ES IDEMPOTENTE en el servidor: si ya había una abierta, devuelve la misma. Por eso
   * el botón no promete «crear»: promete «evaluar».
   */
  const evaluar = (producto: ProductoDeAdministracion) => {
    const version = producto.draft?.id ?? null;
    if (version === null) {
      notify(f('productosAdmin.noSePudo'), f('productosAdmin.sinVersionQueEvaluar'));
      return;
    }
    void conCerrojo(async () => {
      const evaluacion = await ProductAdmissionRepository.abrirEvaluacion(version);
      router.push(`/admin/productos/evaluar/${evaluacion.id}` as never);
    });
  };

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));

  const masArriba = siguienteLimite(limite);
  const tope = llegoAlTope(filas.length, limite);

  const aviso = (
    <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
      <Feather name="package" size={16} color={colors.textMuted} />
      <View style={styles.crece}>
        <Text variant="secondary" weight="700">
          {f('productosAdmin.avisoPanelTitulo')}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('productosAdmin.avisoPanelCuerpo')}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('productosAdmin.sinDinero')}
        </Text>
      </View>
    </View>
  );

  const filtros = (
    <View style={styles.filtros}>
      <Text variant="caption" color={colors.textMuted}>
        {f('productosAdmin.filtroEstado')}
      </Text>
      <View style={styles.chips}>
        <Chip
          label={f('productosAdmin.filtroTodos')}
          selected={estado === null}
          rol="radio"
          disabled={ocupado}
          onPress={() => elegirEstado(null)}
        />
        {ESTADOS_QUE_SE_FILTRAN.map((valor) => (
          <Chip
            key={valor}
            label={f(claveDelEstadoDeProducto(valor))}
            selected={estado === valor}
            rol="radio"
            disabled={ocupado}
            onPress={() => elegirEstado(valor)}
          />
        ))}
      </View>
    </View>
  );

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('productosAdmin.tituloPanel')} onBack={volver} />
        {aviso}
        {filtros}
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('productosAdmin.tituloPanel')} onBack={volver} />
        {aviso}
        {seReintenta(fallo) ? (
          <StateView
            state={fallo === 'sinConexion' ? 'offline' : 'error'}
            description={fallo === 'sinConexion' ? undefined : t('common.loadFailed')}
            onRetry={() => void cargar()}
          />
        ) : (
          <StateView
            state="empty"
            icon={
              fallo === 'noDisponible'
                ? 'clock'
                : fallo === 'noEncontrada'
                  ? 'inbox'
                  : 'lock'
            }
            title={f(claveDelFallo(fallo))}
            description={f(claveDelCuerpoDelFallo(fallo))}
          />
        )}
      </AppScreen>
    );
  }

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('productosAdmin.tituloPanel')} onBack={volver} />
      {aviso}
      {filtros}

      {/* Las postulaciones de proveedor son otra bandeja, y se llega desde aquí. */}
      <Button
        label={f('productosAdmin.irAAdmision')}
        variant="secondary"
        onPress={() => router.push('/admin/productos/admision' as never)}
        disabled={ocupado}
      />

      {/*
        Y las fotografías son una TERCERA bandeja. Aprobar un producto no aprueba
        las imágenes que le añadan después: cada una se mira aparte, y el motivo
        del rechazo es lo único que le permite corregirla a quien la subió.
      */}
      <Button
        label={f('fotos.bandeja.acceso')}
        variant="secondary"
        onPress={() => router.push('/admin/productos/fotos' as never)}
        disabled={ocupado}
      />

      {/*
        Y LOS PAQUETES QUE TODAVÍA NO HAN LLEGADO. Es una bandeja de vigilancia,
        no de trabajo: ahí no se despacha ni se escribe «entregado», porque
        ninguna de las dos cosas se pueden saber desde una oficina. Lo que se ve
        es cuánto lleva esperando cada uno, que es un hecho, y NO se marca
        ninguno como atrasado: ninguna política publica un plazo de despacho.
      */}
      <Button
        label={f('envio.admin.acceso')}
        variant="secondary"
        onPress={() => router.push('/admin/productos/envios' as never)}
        disabled={ocupado}
      />

      {/*
        Y LAS RECLAMACIONES QUE ESPERAN UNA DECISIÓN. Esta sí es una bandeja de
        trabajo: es el único sitio donde se registra qué se acordó sobre un
        pedido que llegó mal. REGISTRARLO NO ES EJECUTARLO: no mueve dinero ni
        devuelve nada al almacén, y la pantalla lo dice antes de pulsar.
      */}
      <Button
        label={f('incidencia.admin.acceso')}
        variant="secondary"
        onPress={() => router.push('/admin/productos/reclamaciones' as never)}
        disabled={ocupado}
      />

      {/* Y LA COLA DE VALORACIONES. MODERAR ES ESCONDER, NUNCA REESCRIBIR: la
          puntuacion, el texto y quien lo escribio se quedan como estaban. */}
      <Button
        label={f('resenaDeProducto.moderar.titulo')}
        variant="secondary"
        onPress={() => router.push('/admin/productos/resenas' as never)}
        disabled={ocupado}
      />

      {conflicto ? (
        <View style={[styles.recuadro, { borderColor: colors.danger }]}>
          <Text variant="secondary" weight="700" color={colors.danger}>
            {f('productosAdmin.conflictoTitulo')}
          </Text>
          <Text variant="secondary">{f('productosAdmin.conflictoCuerpo')}</Text>
          <Button
            label={f('productosAdmin.conflictoReintentar')}
            variant="secondary"
            onPress={() => {
              setConflicto(false);
              void cargar();
            }}
            disabled={ocupado}
          />
        </View>
      ) : null}

      {filas.length === 0 ? (
        <StateView
          state="empty"
          title={f('productosAdmin.panelVacio')}
          description={f('productosAdmin.panelVacioCuerpo')}
          onRetry={() => void cargar()}
        />
      ) : (
        filas.map((producto) => {
          const nombre = producto.draft?.name ?? producto.published?.name ?? null;
          const referencia = abreviarIdentificador(producto.id);
          const tono = tonoDelEstado(producto.status);
          const colorDelEstado =
            tono === 'alerta'
              ? colors.danger
              : tono === 'catalogo'
                ? colors.text
                : colors.textMuted;
          const claveDelBloqueo = claveDelBloqueoDePublicacion(producto);
          const puedePublicar = sePuedePublicar(producto);
          const puedeSuspender = ofreceSuspender(producto.acciones);
          const saltos = transicionesQueSeOfrecen(producto.acciones);
          const estaAbierto = abierto === producto.id;
          const formularioAqui =
            enCurso !== null && enCurso.id === producto.id ? enCurso : null;
          const sinNada =
            !puedePublicar && !puedeSuspender && saltos.length === 0;

          return (
            <View key={producto.id} style={[styles.fila, { borderColor: colors.border }]}>
              <View style={styles.cabecera}>
                <View style={styles.crece}>
                  {nombre !== null ? (
                    <Text variant="secondary" weight="700">
                      {nombre}
                    </Text>
                  ) : (
                    <Text variant="secondary" weight="700">
                      {f('productosAdmin.sinNombre')}
                    </Text>
                  )}
                  <Text variant="caption" color={colorDelEstado}>
                    {f(claveDelEstadoDeProducto(producto.status))}
                  </Text>
                  <Text variant="caption" color={colors.textMuted}>
                    {f('productosAdmin.vendedor', { nombre: producto.seller_name })}
                  </Text>
                </View>
                <Feather
                  name={enCatalogo(producto.status) ? 'eye' : 'eye-off'}
                  size={18}
                  color={colorDelEstado}
                />
              </View>

              {referencia !== null ? (
                <Text variant="caption" color={colors.textMuted}>
                  {f('productosAdmin.referencia', { valor: referencia })}
                </Text>
              ) : null}
              {producto.suspension_reason !== null &&
              producto.suspension_reason.trim() !== '' ? (
                <Text variant="caption" color={colors.danger}>
                  {f('productosAdmin.motivoSuspension', {
                    motivo: producto.suspension_reason,
                  })}
                </Text>
              ) : null}

              {/* POR QUÉ NO SE PUEDE PUBLICAR, DICHO. Nunca un botón ausente y
                  ninguna explicación. */}
              {claveDelBloqueo !== null ? (
                <View style={[styles.paso, { borderColor: colors.border }]}>
                  <Text variant="caption" color={colors.textMuted}>
                    {f('productosAdmin.bloqueoTitulo')}
                  </Text>
                  <Text variant="secondary">{f(claveDelBloqueo)}</Text>
                  {esAprobadoConCondiciones(producto.status) ? (
                    <Text variant="caption" color={colors.textMuted}>
                      {f('productosAdmin.condicionadoQueHacer')}
                    </Text>
                  ) : null}
                </View>
              ) : null}

              <Pressable
                onPress={() => setAbierto(estaAbierto ? null : producto.id)}
                style={styles.enlace}
                accessibilityRole="button"
                accessibilityState={{ expanded: estaAbierto }}
                accessibilityLabel={
                  estaAbierto
                    ? f('productosAdmin.cerrarDetalle')
                    : f('productosAdmin.verDetalle')
                }
              >
                <Feather
                  name={estaAbierto ? 'chevron-up' : 'chevron-down'}
                  size={16}
                  color={colors.textMuted}
                />
                <Text variant="caption" color={colors.textMuted}>
                  {estaAbierto
                    ? f('productosAdmin.cerrarDetalle')
                    : f('productosAdmin.verDetalle')}
                </Text>
              </Pressable>

              {estaAbierto ? (
                <View style={styles.bloque}>
                  <Button
                    label={f('productosAdmin.evaluar')}
                    variant="secondary"
                    onPress={() => evaluar(producto)}
                    disabled={ocupado}
                  />
                </View>
              ) : null}

              {/* --------------------- Publicar / suspender ------------------- */}
              {puedePublicar ? (
                <Button
                  label={f('productosAdmin.publicar')}
                  onPress={() => publicar(producto)}
                  loading={ocupado}
                  disabled={ocupado}
                />
              ) : null}

              {formularioAqui !== null ? (
                <View style={[styles.recuadro, { borderColor: colors.border }]}>
                  <Text variant="secondary" weight="700">
                    {formularioAqui.hasta === null
                      ? f('productosAdmin.suspender')
                      : f('productosAdmin.transicionar', {
                          estado: f(claveDelEstadoDeProducto(formularioAqui.hasta)),
                        })}
                  </Text>
                  <Text variant="caption" color={colors.textMuted}>
                    {formularioAqui.hasta === null
                      ? f('productosAdmin.suspenderCuerpo')
                      : f('productosAdmin.transicionarCuerpo')}
                  </Text>
                  <Input
                    label={
                      formularioAqui.hasta === null ||
                      transicionExigeMotivo(formularioAqui.hasta)
                        ? f('productosAdmin.motivoObligatorio')
                        : f('productosAdmin.motivoOpcional')
                    }
                    placeholder={f('productosAdmin.motivoAyuda')}
                    value={motivo}
                    onChangeText={(texto) => {
                      setMotivo(texto.slice(0, LARGO_MAXIMO_DEL_MOTIVO));
                      if (errorDelFormulario !== null) setErrorDelFormulario(null);
                    }}
                    maxLength={LARGO_MAXIMO_DEL_MOTIVO}
                    multiline
                    numberOfLines={3}
                    style={styles.campoLargo}
                    disabled={ocupado}
                  />
                  <Text variant="caption" color={colors.textMuted}>
                    {f('productosAdmin.motivoContador', {
                      n: motivo.length,
                      max: LARGO_MAXIMO_DEL_MOTIVO,
                    })}
                  </Text>
                  {errorDelFormulario !== null ? (
                    <Text variant="caption" color={colors.danger}>
                      {errorDelFormulario}
                    </Text>
                  ) : null}
                  <Button
                    label={f('productosAdmin.mandar')}
                    onPress={() => mover(producto, formularioAqui.hasta)}
                    loading={ocupado}
                    disabled={ocupado}
                  />
                  <Button
                    label={t('common.cancel')}
                    variant="ghost"
                    onPress={cerrarFormulario}
                    disabled={ocupado}
                  />
                </View>
              ) : (
                <View style={styles.chips}>
                  {puedeSuspender ? (
                    <Button
                      label={f('productosAdmin.suspender')}
                      variant="ghost"
                      onPress={() => abrirFormulario(producto, null)}
                      disabled={ocupado}
                    />
                  ) : null}
                  {saltos.map((hasta) => (
                    <Button
                      key={hasta}
                      label={f('productosAdmin.transicionar', {
                        estado: f(claveDelEstadoDeProducto(hasta)),
                      })}
                      variant="secondary"
                      onPress={() => abrirFormulario(producto, hasta)}
                      disabled={ocupado}
                    />
                  ))}
                </View>
              )}

              {sinNada ? (
                <Text variant="caption" color={colors.textMuted}>
                  {f('productosAdmin.sinAccion')}
                </Text>
              ) : null}
            </View>
          );
        })
      )}

      {/* EL TOPE SE DICE. El servidor no manda cursor: «cincuenta» no es «todos». */}
      {tope ? (
        <Text variant="caption" color={colors.textMuted}>
          {f('productosAdmin.tope', { n: limite })}
        </Text>
      ) : null}
      {tope && masArriba !== null ? (
        <Button
          label={f('productosAdmin.verMas', { n: masArriba })}
          variant="secondary"
          onPress={() => setLimite(masArriba)}
          disabled={ocupado}
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
  bloque: { gap: spacing.sm },
  cabecera: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  aviso: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  fila: {
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  recuadro: {
    gap: spacing.sm,
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
  enlace: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
  },
  campoLargo: {
    minHeight: 72,
    textAlignVertical: 'top',
    paddingTop: spacing.sm,
  },
});
