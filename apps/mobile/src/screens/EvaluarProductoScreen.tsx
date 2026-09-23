import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';

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
  DIMENSIONES_ORDENADAS,
  FALLAS_CRITICAS,
  LARGO_DE_LA_NOTA,
  LARGO_DE_LA_RAZON,
  LARGO_DEL_RESUMEN_DE_EVIDENCIA,
  LARGO_MAXIMO_DE_LAS_NOTAS,
  PUNTUACION_MAXIMA_DE_DIMENSION,
  RAZONES_EXIGIDAS,
  TIPOS_DE_EVIDENCIA,
  abreviarIdentificador,
  claveDeErrorDeProductos,
  claveDeLaDecision,
  claveDeLaDimension,
  claveDeLaFallaCritica,
  claveDelBloqueoDeEvaluacion,
  claveDelCuerpoDelFallo,
  claveDelFallo,
  claveDelTipoDeEvidencia,
  combinacionImposible,
  esConflicto,
  esDecisionCondicionada,
  evaluacionAbierta,
  evidenciaDeLaDimension,
  falloDeCarga,
  pesoDeLaDimension,
  previsualizarDecision,
  puntuacionLegible,
  revisarRazones,
  revisarResumenDeEvidencia,
  revisarPuntuacion,
  rutaValida,
  seReintenta,
  soloDigitos,
  textoUtil,
  type EvaluacionRead,
  type EvidenciaRead,
  type FalloDeCarga,
} from '@/lib/evaluacionDeProductos';
import { ProductAdmissionRepository } from '@/repositories/ProductAdmissionRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/** Una razón mientras se escribe: la evidencia elegida y el texto. */
type RazonEnCurso = { evidencia: string | null; texto: string };

const RAZONES_VACIAS: RazonEnCurso[] = Array.from(
  { length: RAZONES_EXIGIDAS },
  () => ({ evidencia: null, texto: '' }),
);

/**
 * Evaluar una versión de producto. Pantalla INTERNA.
 *
 * LO QUE ESTA PANTALLA NO PUEDE HACER, y está escrito aquí porque es lo que se confunde:
 *
 *   · NO DECIDE. Pone puntuaciones y registra evidencia; qué significa esa puntuación lo
 *     dice la matriz del servidor. El botón de decidir manda la falla crítica y una nota,
 *     y nada más: no existe un campo «decisión» ni un campo «puntuación total».
 *   · NO PUNTÚA SIN EVIDENCIA QUE SE SOSTENGA. Se puede escribir una nota antes de
 *     registrar la evidencia, pero la evaluación NO se puede decidir mientras alguna de
 *     las seis dimensiones no tenga al menos una: se dice arriba, todo el tiempo.
 *   · NO ESCRIBE UNA RAZÓN SUELTA. Las tres razones se ELIGEN de la evidencia ya
 *     registrada; el selector no tiene una opción «sin evidencia» y el repositorio no
 *     admite una razón sin `evidence_id`.
 *   · NO TOCA DINERO. No hay saldo, no hay precio editable y no hay transferencia.
 *
 * LA FALLA CRÍTICA ES UN SELECTOR APARTE, y al elegirla la pantalla dice con todas las
 * letras que el resultado va a ser un rechazo: rechaza directo y no se compensa con
 * puntaje, así que verla al lado de una puntuación alta tiene que resultar inequívoco.
 *
 * SIEMPRE SE ENSEÑA QUÉ FALTA. Las dimensiones sin puntuar y las que no tienen evidencia,
 * las dos a la vez, aunque el servidor conteste primero una y luego la otra.
 *
 * LA PUNTUACIÓN VA EN CENTÉSIMAS: 9 000 son 90,00. El campo de cada dimensión acepta un
 * entero de 0 a 100 y solo dígitos; la coma solo aparece al LEER el total.
 *
 * UNA EVALUACIÓN DECIDIDA NO SE REESCRIBE. Cuando el servidor la manda cerrada, la
 * pantalla la enseña y quita todos los controles: el servidor contesta
 * `product_evaluation_closed` y esconderlo tras un formulario que no funciona sería peor.
 */
export function EvaluarProductoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ evaluationId?: string }>();
  const evaluationId = typeof params.evaluationId === 'string' ? params.evaluationId : '';

  /** `t` no acepta una cadena suelta: las claves salen del módulo de reglas. */
  const f = (clave: string, params2?: Record<string, string | number>) =>
    t(clave as TranslationKey, params2);

  const [evaluacion, setEvaluacion] = useState<EvaluacionRead | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<FalloDeCarga | null>(null);
  const [conflicto, setConflicto] = useState(false);

  /** Lo escrito en cada campo de puntuación, por dimensión. */
  const [escritas, setEscritas] = useState<Record<string, string>>({});
  const [apuntes, setApuntes] = useState<Record<string, string>>({});
  const [errorDeDimension, setErrorDeDimension] = useState<Record<string, string>>({});

  /** El formulario de evidencia, abierto sobre UNA dimensión. */
  const [evidenciaAbierta, setEvidenciaAbierta] = useState<string | null>(null);
  const [tipo, setTipo] = useState<string | null>(null);
  const [resumen, setResumen] = useState('');
  const [ruta, setRuta] = useState('');
  const [errorDeEvidencia, setErrorDeEvidencia] = useState<string | null>(null);

  const [razones, setRazones] = useState<RazonEnCurso[]>(RAZONES_VACIAS);
  const [errorDeRazones, setErrorDeRazones] = useState<string | null>(null);

  /** La falla crítica elegida a mano. `null` es «no hay ninguna». */
  const [falla, setFalla] = useState<string | null>(null);
  const [notasDeLaDecision, setNotasDeLaDecision] = useState('');

  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      setEvaluacion(await ProductAdmissionRepository.evaluacion(evaluationId));
    } catch (error) {
      setFallo(
        error instanceof ApiError
          ? falloDeCarga(error.status, error.code)
          : falloDeCarga(null, null),
      );
    } finally {
      setCargando(false);
    }
  }, [evaluationId]);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  /**
   * Vuelve a leer la evaluación entera tras cambiar algo.
   *
   * SOLO `GET /evaluations/{id}` DEVUELVE LAS RAZONES con la evidencia de la que salen;
   * las demás rutas contestan la evaluación con `reasons` vacío. Quedarse con esa
   * respuesta haría desaparecer de la pantalla tres razones que siguen guardadas.
   */
  const refrescar = async () => {
    setEvaluacion(await ProductAdmissionRepository.evaluacion(evaluationId));
  };

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

  /** El cerrojo, ANTES del primer `await`. */
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

  /* ----------------------------- Puntuar ----------------------------------- */

  /**
   * Manda la nota de UNA dimensión. Se revisa aquí: solo dígitos, de 0 a 100.
   *
   * Una coma no se corrige por nuestra cuenta: se dice que no vale. Redondear «90,5» a
   * algo sería guardar una nota que nadie escribió.
   */
  const puntuar = (dimension: string) => {
    const revisada = revisarPuntuacion(escritas[dimension]);
    if (revisada.estado !== 'listo') {
      setErrorDeDimension((previos) => ({
        ...previos,
        [dimension]:
          revisada.estado === 'falta'
            ? f('productosAdmin.faltaPuntuacion')
            : revisada.estado === 'invalida'
              ? f('productosAdmin.puntuacionInvalida')
              : f('productosAdmin.puntuacionFuera', {
                  min: revisada.minimo,
                  max: revisada.maximo,
                }),
      }));
      return;
    }
    setErrorDeDimension((previos) => ({ ...previos, [dimension]: '' }));
    void conCerrojo(async () => {
      await ProductAdmissionRepository.puntuar(evaluationId, dimension, {
        score: revisada.score,
        note: textoUtil(apuntes[dimension], LARGO_DE_LA_NOTA),
      });
      await refrescar();
      toast(f('productosAdmin.puntuada'));
    });
  };

  /* ---------------------------- Evidencia ---------------------------------- */

  const cerrarEvidencia = () => {
    setEvidenciaAbierta(null);
    setTipo(null);
    setResumen('');
    setRuta('');
    setErrorDeEvidencia(null);
  };

  const abrirEvidencia = (dimension: string) => {
    setEvidenciaAbierta(dimension);
    setTipo(null);
    setResumen('');
    setRuta('');
    setErrorDeEvidencia(null);
  };

  /** Registra una evidencia. SOLO AÑADIR: el servidor no la reescribe ni la borra. */
  const registrarEvidencia = (dimension: string) => {
    if (tipo === null) {
      setErrorDeEvidencia(f('productosAdmin.faltaTipoDeEvidencia'));
      return;
    }
    const revisado = revisarResumenDeEvidencia(resumen);
    if (revisado.estado !== 'listo') {
      setErrorDeEvidencia(
        revisado.estado === 'falta'
          ? f('productosAdmin.faltaResumen')
          : revisado.estado === 'corto'
            ? f('productosAdmin.resumenCorto', { min: revisado.minimo })
            : f('productosAdmin.resumenLargo', { max: revisado.maximo }),
      );
      return;
    }
    if (!rutaValida(ruta)) {
      /* UNA URL NO ES UNA RUTA. El servidor la rechaza y se dice antes de mandarla. */
      setErrorDeEvidencia(f('productosAdmin.rutaInvalida'));
      return;
    }
    setErrorDeEvidencia(null);
    void conCerrojo(async () => {
      await ProductAdmissionRepository.registrarEvidencia(evaluationId, {
        dimension,
        kind: tipo,
        summary: revisado.resumen,
        storage_path: textoUtil(ruta, 512),
      });
      await refrescar();
      cerrarEvidencia();
      toast(f('productosAdmin.evidenciaRegistrada'));
    });
  };

  /* ------------------------------ Razones ---------------------------------- */

  const cambiarRazon = (indice: number, cambio: Partial<RazonEnCurso>) => {
    setRazones((previas) =>
      previas.map((razon, i) => (i === indice ? { ...razon, ...cambio } : razon)),
    );
    if (errorDeRazones !== null) setErrorDeRazones(null);
  };

  /**
   * Guarda las tres razones. CADA UNA SOBRE UNA EVIDENCIA DE ESTA EVALUACIÓN.
   *
   * Se reemplazan enteras, igual que en el servidor, así que guardar dos veces lo mismo
   * deja lo mismo. Y una razón sin evidencia elegida no sale de aquí.
   */
  const guardarRazones = () => {
    const escritasAhora = razones.filter(
      (razon) => razon.evidencia !== null || razon.texto.trim() !== '',
    );
    const revisadas = revisarRazones(
      escritasAhora.map((razon) => ({
        evidence_id: razon.evidencia,
        text: razon.texto,
      })),
      evaluacion?.evidence ?? [],
    );
    if (revisadas.estado !== 'listo') {
      setErrorDeRazones(
        revisadas.estado === 'demasiadas'
          ? f('productosAdmin.razonesDemasiadas', { max: revisadas.maximo })
          : revisadas.estado === 'repetida'
            ? f('productosAdmin.razonRepetida', { n: revisadas.posicion })
            : revisadas.motivo.estado === 'sinEvidencia'
              ? f('productosAdmin.razonSinEvidencia', { n: revisadas.posicion })
              : revisadas.motivo.estado === 'falta'
                ? f('productosAdmin.razonSinTexto', { n: revisadas.posicion })
                : revisadas.motivo.estado === 'corto'
                  ? f('productosAdmin.razonCorta', {
                      n: revisadas.posicion,
                      min: revisadas.motivo.minimo,
                    })
                  : f('productosAdmin.razonLarga', {
                      n: revisadas.posicion,
                      max: revisadas.motivo.maximo,
                    }),
      );
      return;
    }
    setErrorDeRazones(null);
    void conCerrojo(async () => {
      await ProductAdmissionRepository.elegirRazones(evaluationId, revisadas.razones);
      await refrescar();
      toast(f('productosAdmin.razonesGuardadas'));
    });
  };

  /* ------------------------------ Decidir ---------------------------------- */

  const decidir = () => {
    void conCerrojo(async () => {
      const vista = previsualizarDecision(evaluacion, falla);
      const aceptado = await confirm({
        title: f('productosAdmin.confirmarDecidirTitulo'),
        message:
          vista.estado === 'fallaCritica'
            ? f('productosAdmin.confirmarFallaCuerpo', {
                falla: f(claveDeLaFallaCritica(vista.falla)),
              })
            : vista.estado === 'listo'
              ? f('productosAdmin.confirmarDecidirCuerpo', {
                  decision: f(claveDeLaDecision(vista.decision)),
                  total: puntuacionLegible(vista.total) ?? '',
                })
              : f('productosAdmin.confirmarFaltanCuerpo'),
        confirmLabel: f('productosAdmin.decidir'),
        destructive: vista.estado === 'fallaCritica',
      });
      if (!aceptado) return;
      await ProductAdmissionRepository.decidirEvaluacion(evaluationId, {
        critical_failure: falla,
        notes: textoUtil(notasDeLaDecision, LARGO_MAXIMO_DE_LAS_NOTAS),
      });
      await refrescar();
      toast(f('productosAdmin.evaluacionDecidida'));
    });
  };

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));

  /* ------------------------------ Pintar ----------------------------------- */

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('productosAdmin.tituloEvaluar')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || evaluacion === null) {
    const cual: FalloDeCarga = fallo ?? 'noEncontrada';
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('productosAdmin.tituloEvaluar')} onBack={volver} />
        {seReintenta(cual) ? (
          <StateView
            state={cual === 'sinConexion' ? 'offline' : 'error'}
            description={cual === 'sinConexion' ? undefined : t('common.loadFailed')}
            onRetry={() => void cargar()}
          />
        ) : (
          <StateView
            state="empty"
            icon={
              cual === 'noDisponible'
                ? 'clock'
                : cual === 'noEncontrada'
                  ? 'inbox'
                  : 'lock'
            }
            title={f(claveDelFallo(cual))}
            description={f(claveDelCuerpoDelFallo(cual))}
          />
        )}
      </AppScreen>
    );
  }

  const abierta = evaluacionAbierta(evaluacion.status);
  const vista = previsualizarDecision(evaluacion, falla);
  const claveDelBloqueo = claveDelBloqueoDeEvaluacion(evaluacion.bloqueo);
  const totalDecidido = puntuacionLegible(evaluacion.score_total);
  const producto = abreviarIdentificador(evaluacion.product_id);
  const version = abreviarIdentificador(evaluacion.version_id);
  /* Ni un segundo: una falla crítica al lado de «aprobado» sería una contradicción. */
  const imposible =
    vista.estado === 'listo' && combinacionImposible(vista.decision, falla);

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('productosAdmin.tituloEvaluar')} onBack={volver} />

      {/* ------------------------- Qué se está evaluando ---------------------- */}
      <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
        <Feather name="clipboard" size={16} color={colors.textMuted} />
        <View style={styles.crece}>
          <Text variant="secondary" weight="700">
            {f('productosAdmin.avisoEvaluarTitulo')}
          </Text>
          <Text variant="caption" color={colors.textMuted}>
            {f('productosAdmin.avisoEvaluarCuerpo')}
          </Text>
          <Text variant="caption" color={colors.textMuted}>
            {f('productosAdmin.sinDinero')}
          </Text>
          {producto !== null ? (
            <Text variant="caption" color={colors.textMuted}>
              {f('productosAdmin.productoRef', { valor: producto })}
            </Text>
          ) : null}
          {version !== null ? (
            <Text variant="caption" color={colors.textMuted}>
              {f('productosAdmin.versionRef', { valor: version })}
            </Text>
          ) : null}
        </View>
      </View>

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

      {/* ---------------- La evaluación ya decidida, solo lectura ------------- */}
      {!abierta ? (
        <View style={[styles.recuadro, { borderColor: colors.border }]}>
          <Text variant="secondary" weight="700">
            {f('productosAdmin.yaDecidida')}
          </Text>
          <Text variant="caption" color={colors.textMuted}>
            {f('productosAdmin.yaDecididaCuerpo')}
          </Text>
          {evaluacion.decision !== null ? (
            <Text variant="secondary">
              {f('productosAdmin.decisionTomada', {
                decision: f(claveDeLaDecision(evaluacion.decision)),
              })}
            </Text>
          ) : null}
          {/* `null` NO ES CERO: si no hay total, no se escribe ningún número. */}
          {totalDecidido !== null ? (
            <Text variant="secondary">
              {f('productosAdmin.totalDecidido', { total: totalDecidido })}
            </Text>
          ) : (
            <Text variant="caption" color={colors.textMuted}>
              {f('productosAdmin.sinTotal')}
            </Text>
          )}
          {evaluacion.critical_failure !== null ? (
            <Text variant="secondary" color={colors.danger}>
              {f('productosAdmin.fallaRegistrada', {
                falla: f(claveDeLaFallaCritica(evaluacion.critical_failure)),
              })}
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* ------------------------- QUÉ FALTA, siempre ------------------------ */}
      <View style={[styles.recuadro, { borderColor: colors.border }]}>
        <Text variant="secondary" weight="700">
          {f('productosAdmin.queFaltaTitulo')}
        </Text>
        {vista.estado === 'faltan' ? (
          <>
            {vista.sinPuntuar.length === 0 ? null : (
              <Text variant="secondary">
                {f('productosAdmin.faltanPuntuar', {
                  dimensiones: vista.sinPuntuar
                    .map((d) => f(claveDeLaDimension(d)))
                    .join(SEPARADOR),
                })}
              </Text>
            )}
            {vista.sinEvidencia.length === 0 ? null : (
              <Text variant="secondary">
                {f('productosAdmin.faltanEvidencia', {
                  dimensiones: vista.sinEvidencia
                    .map((d) => f(claveDeLaDimension(d)))
                    .join(SEPARADOR),
                })}
              </Text>
            )}
            {/* LA PUNTUACIÓN CON CINCO DIMENSIONES NO ES UNA PUNTUACIÓN: no se
                escribe ningún número mientras falte alguna. */}
            <Text variant="caption" color={colors.textMuted}>
              {f('productosAdmin.sinTotalTodavia')}
            </Text>
          </>
        ) : vista.estado === 'fallaCritica' ? (
          <Text variant="secondary" color={colors.danger}>
            {f('productosAdmin.fallaMandaSobreTodo')}
          </Text>
        ) : (
          <Text variant="secondary">{f('productosAdmin.nadaFalta')}</Text>
        )}
        {claveDelBloqueo !== null ? (
          <Text variant="caption" color={colors.textMuted}>
            {f(claveDelBloqueo)}
          </Text>
        ) : null}
      </View>

      {/* ------------------------- LAS SEIS DIMENSIONES ---------------------- */}
      <Text variant="secondary" weight="700">
        {f('productosAdmin.dimensionesTitulo')}
      </Text>
      {DIMENSIONES_ORDENADAS.map((dimension) => {
        const peso = pesoDeLaDimension(evaluacion.matriz, dimension);
        const puesta = evaluacion.scores.find((s) => s.dimension === dimension);
        const suEvidencia: EvidenciaRead[] = evidenciaDeLaDimension(
          evaluacion.evidence,
          dimension,
        );
        const problema = errorDeDimension[dimension] ?? '';
        const formularioAqui = evidenciaAbierta === dimension;
        const notaPuesta =
          puesta?.note !== undefined && puesta.note !== null && puesta.note.trim() !== ''
            ? puesta.note
            : null;

        return (
          <View key={dimension} style={[styles.fila, { borderColor: colors.border }]}>
            <View style={styles.cabecera}>
              <View style={styles.crece}>
                <Text variant="secondary" weight="700">
                  {f(claveDeLaDimension(dimension))}
                </Text>
                {/* EL PESO LO MANDA EL SERVIDOR con cada evaluación. */}
                {peso !== null ? (
                  <Text variant="caption" color={colors.textMuted}>
                    {f('productosAdmin.peso', { peso })}
                  </Text>
                ) : null}
              </View>
              <Feather
                name={puesta ? 'check-circle' : 'circle'}
                size={18}
                color={puesta ? colors.text : colors.textMuted}
              />
            </View>

            {puesta ? (
              <Text variant="secondary">
                {f('productosAdmin.puntuacionPuesta', {
                  score: puesta.score,
                  peso: puesta.weight,
                })}
              </Text>
            ) : (
              <Text variant="caption" color={colors.textMuted}>
                {f('productosAdmin.sinPuntuacion')}
              </Text>
            )}
            {notaPuesta !== null ? (
              <Text variant="caption" color={colors.textMuted}>
                {f('productosAdmin.notaDeLaPuntuacion', { nota: notaPuesta })}
              </Text>
            ) : null}

            {abierta ? (
              <>
                <Input
                  label={f('productosAdmin.campoPuntuacion', {
                    max: PUNTUACION_MAXIMA_DE_DIMENSION,
                  })}
                  placeholder={f('productosAdmin.campoPuntuacionAyuda')}
                  value={escritas[dimension] ?? ''}
                  onChangeText={(texto) => {
                    /* SOLO DÍGITOS: el servidor quiere un entero, no «90,5». */
                    setEscritas((previas) => ({
                      ...previas,
                      [dimension]: soloDigitos(texto),
                    }));
                    if (problema !== '') {
                      setErrorDeDimension((previos) => ({
                        ...previos,
                        [dimension]: '',
                      }));
                    }
                  }}
                  keyboardType="number-pad"
                  maxLength={3}
                  disabled={ocupado}
                />
                <Input
                  label={f('productosAdmin.campoNota')}
                  placeholder={f('productosAdmin.campoNotaAyuda')}
                  value={apuntes[dimension] ?? ''}
                  onChangeText={(texto) =>
                    setApuntes((previos) => ({
                      ...previos,
                      [dimension]: texto.slice(0, LARGO_DE_LA_NOTA),
                    }))
                  }
                  maxLength={LARGO_DE_LA_NOTA}
                  multiline
                  numberOfLines={2}
                  style={styles.campoLargo}
                  disabled={ocupado}
                />
                {problema !== '' ? (
                  <Text variant="caption" color={colors.danger}>
                    {problema}
                  </Text>
                ) : null}
                <Button
                  label={f('productosAdmin.guardarPuntuacion')}
                  variant="secondary"
                  onPress={() => puntuar(dimension)}
                  loading={ocupado}
                  disabled={ocupado}
                />
              </>
            ) : null}

            {/* ---------------- La evidencia DE ESTA DIMENSIÓN --------------- */}
            <Text variant="caption" color={colors.textMuted}>
              {f('productosAdmin.evidenciaTitulo')}
            </Text>
            {suEvidencia.length === 0 ? (
              <Text variant="caption" color={colors.danger}>
                {f('productosAdmin.sinEvidenciaAqui')}
              </Text>
            ) : (
              suEvidencia.map((e) => (
                <View key={e.id} style={[styles.paso, { borderColor: colors.border }]}>
                  <Text variant="secondary" weight="700">
                    {f(claveDelTipoDeEvidencia(e.kind))}
                  </Text>
                  <Text variant="caption" color={colors.textMuted}>
                    {e.summary}
                  </Text>
                  {e.storage_path !== null && e.storage_path.trim() !== '' ? (
                    <Text variant="caption" color={colors.textMuted}>
                      {f('productosAdmin.evidenciaConArchivo')}
                    </Text>
                  ) : null}
                </View>
              ))
            )}

            {abierta && !formularioAqui ? (
              <Button
                label={f('productosAdmin.anadirEvidencia')}
                variant="ghost"
                onPress={() => abrirEvidencia(dimension)}
                disabled={ocupado}
              />
            ) : null}

            {abierta && formularioAqui ? (
              <View style={[styles.recuadro, { borderColor: colors.border }]}>
                <Text variant="secondary" weight="700">
                  {f('productosAdmin.anadirEvidencia')}
                </Text>
                <Text variant="caption" color={colors.textMuted}>
                  {f('productosAdmin.evidenciaSoloAnadir')}
                </Text>
                <Text variant="caption" color={colors.textMuted}>
                  {f('productosAdmin.tipoDeEvidencia')}
                </Text>
                <View style={styles.chips}>
                  {TIPOS_DE_EVIDENCIA.map((kind) => (
                    <Chip
                      key={kind}
                      label={f(claveDelTipoDeEvidencia(kind))}
                      selected={tipo === kind}
                      rol="radio"
                      disabled={ocupado}
                      onPress={() => {
                        setTipo(kind);
                        setErrorDeEvidencia(null);
                      }}
                    />
                  ))}
                </View>
                <Input
                  label={f('productosAdmin.campoResumen', {
                    min: LARGO_DEL_RESUMEN_DE_EVIDENCIA.minimo,
                  })}
                  placeholder={f('productosAdmin.campoResumenAyuda')}
                  value={resumen}
                  onChangeText={(texto) => {
                    setResumen(texto.slice(0, LARGO_DEL_RESUMEN_DE_EVIDENCIA.maximo));
                    if (errorDeEvidencia !== null) setErrorDeEvidencia(null);
                  }}
                  maxLength={LARGO_DEL_RESUMEN_DE_EVIDENCIA.maximo}
                  multiline
                  numberOfLines={3}
                  style={styles.campoLargo}
                  disabled={ocupado}
                />
                <Input
                  label={f('productosAdmin.campoRuta')}
                  placeholder={f('productosAdmin.campoRutaAyuda')}
                  value={ruta}
                  onChangeText={(texto) => {
                    setRuta(texto);
                    if (errorDeEvidencia !== null) setErrorDeEvidencia(null);
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  disabled={ocupado}
                />
                {errorDeEvidencia !== null ? (
                  <Text variant="caption" color={colors.danger}>
                    {errorDeEvidencia}
                  </Text>
                ) : null}
                <Button
                  label={f('productosAdmin.mandar')}
                  onPress={() => registrarEvidencia(dimension)}
                  loading={ocupado}
                  disabled={ocupado}
                />
                <Button
                  label={t('common.cancel')}
                  variant="ghost"
                  onPress={cerrarEvidencia}
                  disabled={ocupado}
                />
              </View>
            ) : null}
          </View>
        );
      })}

      {/* -------------------------- LAS TRES RAZONES ------------------------- */}
      <Text variant="secondary" weight="700">
        {f('productosAdmin.razonesTitulo')}
      </Text>
      <Text variant="caption" color={colors.textMuted}>
        {f('productosAdmin.razonesCuerpo')}
      </Text>

      {evaluacion.reasons.length === 0 ? (
        <Text variant="caption" color={colors.textMuted}>
          {f('productosAdmin.sinRazones')}
        </Text>
      ) : (
        evaluacion.reasons.map((razon) => (
          <View
            key={razon.position}
            style={[styles.paso, { borderColor: colors.border }]}
          >
            <Text variant="secondary" weight="700">
              {f('productosAdmin.razonNumero', { n: razon.position })}
            </Text>
            <Text variant="secondary">{razon.text}</Text>
            {/* DE QUÉ EVIDENCIA SALE. Sin esto no se puede comprobar. */}
            <Text variant="caption" color={colors.textMuted}>
              {f('productosAdmin.razonSaleDe', {
                tipo: f(claveDelTipoDeEvidencia(razon.evidence_kind)),
                dimension: f(claveDeLaDimension(razon.evidence_dimension)),
              })}
            </Text>
          </View>
        ))
      )}

      {abierta ? (
        <View style={[styles.recuadro, { borderColor: colors.border }]}>
          {evaluacion.evidence.length === 0 ? (
            /* SIN EVIDENCIA NO HAY RAZONES QUE ELEGIR, y se dice en vez de
               ofrecer un campo de texto que no llevaría a ningún sitio. */
            <Text variant="secondary">{f('productosAdmin.razonesSinEvidencia')}</Text>
          ) : (
            <>
              {razones.map((razon, indice) => (
                <View key={indice} style={styles.bloque}>
                  <Text variant="secondary" weight="700">
                    {f('productosAdmin.razonNumero', { n: indice + 1 })}
                  </Text>
                  <Text variant="caption" color={colors.textMuted}>
                    {f('productosAdmin.elegirEvidencia')}
                  </Text>
                  <View style={styles.chips}>
                    {evaluacion.evidence.map((e) => (
                      <Chip
                        key={e.id}
                        label={f('productosAdmin.evidenciaEtiqueta', {
                          tipo: f(claveDelTipoDeEvidencia(e.kind)),
                          dimension: f(claveDeLaDimension(e.dimension)),
                        })}
                        selected={razon.evidencia === e.id}
                        rol="radio"
                        disabled={ocupado}
                        onPress={() => cambiarRazon(indice, { evidencia: e.id })}
                      />
                    ))}
                  </View>
                  <Input
                    label={f('productosAdmin.campoRazon', {
                      min: LARGO_DE_LA_RAZON.minimo,
                    })}
                    placeholder={f('productosAdmin.campoRazonAyuda')}
                    value={razon.texto}
                    onChangeText={(texto) =>
                      cambiarRazon(indice, {
                        texto: texto.slice(0, LARGO_DE_LA_RAZON.maximo),
                      })
                    }
                    maxLength={LARGO_DE_LA_RAZON.maximo}
                    multiline
                    numberOfLines={2}
                    style={styles.campoLargo}
                    disabled={ocupado}
                  />
                </View>
              ))}
              {errorDeRazones !== null ? (
                <Text variant="caption" color={colors.danger}>
                  {errorDeRazones}
                </Text>
              ) : null}
              <Button
                label={f('productosAdmin.guardarRazones')}
                variant="secondary"
                onPress={guardarRazones}
                loading={ocupado}
                disabled={ocupado}
              />
            </>
          )}
        </View>
      ) : null}

      {/* ---------------------- LA FALLA CRÍTICA, APARTE --------------------- */}
      {abierta ? (
        <View style={[styles.recuadro, { borderColor: colors.danger }]}>
          <Text variant="secondary" weight="700" color={colors.danger}>
            {f('productosAdmin.fallaTitulo')}
          </Text>
          <Text variant="caption" color={colors.textMuted}>
            {f('productosAdmin.fallaCuerpo')}
          </Text>
          <View style={styles.chips}>
            <Chip
              label={f('productosAdmin.sinFalla')}
              selected={falla === null}
              rol="radio"
              disabled={ocupado}
              onPress={() => setFalla(null)}
            />
            {FALLAS_CRITICAS.map((cual) => (
              <Chip
                key={cual}
                label={f(claveDeLaFallaCritica(cual))}
                selected={falla === cual}
                rol="radio"
                disabled={ocupado}
                onPress={() => setFalla(cual)}
              />
            ))}
          </View>
          {/* ELEGIDA UNA FALLA, EL RESULTADO SERÁ RECHAZO. Con todas las letras. */}
          {falla !== null ? (
            <Text variant="secondary" weight="700" color={colors.danger}>
              {f('productosAdmin.fallaSeraRechazo', {
                falla: f(claveDeLaFallaCritica(falla)),
              })}
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* --------------------- LA DECISIÓN, PREVISUALIZADA ------------------- */}
      {abierta ? (
        <View style={[styles.recuadro, { borderColor: colors.border }]}>
          <Text variant="secondary" weight="700">
            {f('productosAdmin.previsualizacionTitulo')}
          </Text>
          <Text variant="caption" color={colors.textMuted}>
            {f('productosAdmin.previsualizacionCuerpo')}
          </Text>

          {vista.estado === 'fallaCritica' ? (
            <Text variant="secondary" weight="700" color={colors.danger}>
              {f('productosAdmin.previsionRechazo', {
                decision: f(claveDeLaDecision(vista.decision)),
              })}
            </Text>
          ) : vista.estado === 'faltan' ? (
            <Text variant="secondary">{f('productosAdmin.previsionSinDatos')}</Text>
          ) : (
            <>
              <Text variant="secondary" weight="700">
                {f('productosAdmin.previsionDecision', {
                  decision: f(claveDeLaDecision(vista.decision)),
                })}
              </Text>
              <Text variant="secondary">
                {f('productosAdmin.previsionTotal', {
                  total: puntuacionLegible(vista.total) ?? '',
                })}
              </Text>
              {esDecisionCondicionada(vista.decision) ? (
                <Text variant="caption" color={colors.textMuted}>
                  {f('productosAdmin.bloqueo.condicionado')}
                </Text>
              ) : null}
            </>
          )}

          {/* Un imposible nunca se pinta: si apareciera, se dice y no se manda. */}
          {imposible ? (
            <Text variant="secondary" weight="700" color={colors.danger}>
              {f('productosAdmin.combinacionImposible')}
            </Text>
          ) : null}

          <Input
            label={f('productosAdmin.notasEtiqueta')}
            placeholder={f('productosAdmin.notasAyuda')}
            value={notasDeLaDecision}
            onChangeText={(texto) =>
              setNotasDeLaDecision(texto.slice(0, LARGO_MAXIMO_DE_LAS_NOTAS))
            }
            maxLength={LARGO_MAXIMO_DE_LAS_NOTAS}
            multiline
            numberOfLines={2}
            style={styles.campoLargo}
            disabled={ocupado}
          />

          <Button
            label={f('productosAdmin.decidir')}
            onPress={decidir}
            loading={ocupado}
            disabled={ocupado || imposible || vista.estado === 'faltan'}
          />
          {vista.estado === 'faltan' ? (
            <Text variant="caption" color={colors.textMuted}>
              {f('productosAdmin.decidirBloqueado')}
            </Text>
          ) : null}
        </View>
      ) : null}
    </AppScreen>
  );
}

/** Lo que va entre dos nombres de dimensión al enumerarlas. */
const SEPARADOR = ' · ';

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
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
  campoLargo: {
    minHeight: 72,
    textAlignVertical: 'top',
    paddingTop: spacing.sm,
  },
});
