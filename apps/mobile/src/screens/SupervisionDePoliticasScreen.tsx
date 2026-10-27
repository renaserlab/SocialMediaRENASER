import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import {
  ESTADOS_DE_POLITICA,
  LIMITE_INICIAL,
  PESTANAS,
  PESTANA_INICIAL,
  TIPOS_DE_POLITICA,
  agruparPorOrganizador,
  claveDeLaPestana,
  claveDelCambio,
  claveDelCuerpoDelFallo,
  claveDelEstadoDePolitica,
  claveDelFallo,
  claveDelTipoDePolitica,
  compararParametros,
  contarEventosSinPolitica,
  contarOrganizadoresSinPolitica,
  cuantosFiltros,
  estaVigente,
  estadoDeLaLista,
  falloDesde,
  filasDeParametros,
  huellaAbreviada,
  llegoAlTope,
  loEscribeElOrganizador,
  noDecideNada,
  referenciaAbreviada,
  siguienteLimite,
  soloLosCambios,
  textoDeFiltro,
  tonoDelEstado,
  versionAnterior,
  type EventoSinPolitica,
  type Fallo,
  type Pestana,
  type PoliticaSupervisada,
  type ValorDeParametro,
} from '@/lib/supervisionDePoliticas';
import { EventPolicyAdminRepository } from '@/repositories/EventPolicyAdminRepository';
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
 * El panel de políticas de evento: SUPERVISIÓN Y TRAZABILIDAD.
 *
 * NO SE APRUEBA NADA AQUÍ, y no es una limitación de la pantalla: no existe el
 * trámite. Quien organiza publica sus condiciones y la empresa las mira. Por eso
 * no hay aprobar, rechazar, suspender, editar ni borrar; tampoco apagados, que
 * prometerían que algún día se encienden.
 *
 * LA PESTAÑA QUE IMPORTA ES LA PRIMERA: eventos publicados vendiendo sin
 * condiciones escritas. Se ven, se cuentan por organizador y se puede abrir cada
 * uno. Que esa lista esté vacía es la buena noticia, y se dice con un texto
 * distinto del de un fallo al pedirla: lo segundo no significa que no haya
 * ninguno, significa que no lo sabemos.
 *
 * LA HUELLA Y LAS REFERENCIAS SE ENSEÑAN. `params_sha256` abreviada es lo que
 * hace demostrable qué se publicó; `published_by` y `created_by` son
 * identificadores internos y se enseñan como referencia para investigar, sin
 * inventarles un nombre que el contrato no trae.
 *
 * QUIÉN PUEDE ABRIRLA LO DECIDE EL SERVIDOR: sin rol de administración llega un
 * 403 y se dice con su propio mensaje, no con un «no hay nada».
 */
export function SupervisionDePoliticasScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();

  /*
    Las claves de este panel se están escribiendo en las tablas de idiomas en
    paralelo. El molde es el mismo `t`: cuando lleguen, esto no cambia.
  */
  const f = useCallback(
    (clave: string, params?: Record<string, string | number>) =>
      t(clave as TranslationKey, params),
    [t],
  );

  const [pestana, setPestana] = useState<Pestana>(PESTANA_INICIAL);

  // Los eventos que venden sin condiciones escritas.
  const [faltantes, setFaltantes] = useState<EventoSinPolitica[]>([]);
  const [limiteFaltantes, setLimiteFaltantes] = useState<number>(LIMITE_INICIAL);
  const [cargandoFaltantes, setCargandoFaltantes] = useState(true);
  const [falloFaltantes, setFalloFaltantes] = useState<Fallo | null>(null);

  // Lo publicado, con sus filtros.
  const [politicas, setPoliticas] = useState<PoliticaSupervisada[]>([]);
  const [tipo, setTipo] = useState<string | null>(null);
  const [estado, setEstado] = useState<string | null>(null);
  const [eventoEscrito, setEventoEscrito] = useState('');
  const [eventoFiltrado, setEventoFiltrado] = useState<string | null>(null);
  const [organizadorEscrito, setOrganizadorEscrito] = useState('');
  const [organizadorFiltrado, setOrganizadorFiltrado] = useState<string | null>(null);
  const [limite, setLimite] = useState<number>(LIMITE_INICIAL);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<Fallo | null>(null);

  // La que está desplegada, y su lectura fresca.
  const [abierta, setAbierta] = useState<string | null>(null);
  const [detalle, setDetalle] = useState<PoliticaSupervisada | null>(null);
  const [cargandoDetalle, setCargandoDetalle] = useState(false);
  const [detalleNoActualizado, setDetalleNoActualizado] = useState(false);

  const comoFallo = (error: unknown): Fallo =>
    error instanceof ApiError ? falloDesde(error.status, error.code) : 'red';

  const cargarFaltantes = useCallback(async () => {
    setCargandoFaltantes(true);
    setFalloFaltantes(null);
    try {
      setFaltantes(await EventPolicyAdminRepository.sinPolitica(limiteFaltantes));
    } catch (error) {
      setFalloFaltantes(comoFallo(error));
    } finally {
      setCargandoFaltantes(false);
    }
  }, [limiteFaltantes]);

  const cargarPoliticas = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      setPoliticas(
        await EventPolicyAdminRepository.supervisar({
          organizadorId: organizadorFiltrado,
          eventoId: eventoFiltrado,
          tipo,
          estado,
          limite,
        }),
      );
    } catch (error) {
      setFallo(comoFallo(error));
    } finally {
      setCargando(false);
    }
  }, [organizadorFiltrado, eventoFiltrado, tipo, estado, limite]);

  // Cada pestaña pide lo suyo, y solo cuando se está mirando.
  useFocusEffect(
    useCallback(() => {
      if (pestana === 'sinPolitica') void cargarFaltantes();
      else void cargarPoliticas();
    }, [pestana, cargarFaltantes, cargarPoliticas]),
  );

  const desplegar = async (politica: PoliticaSupervisada) => {
    if (abierta === politica.id) {
      setAbierta(null);
      setDetalle(null);
      return;
    }
    setAbierta(politica.id);
    setDetalle(null);
    setDetalleNoActualizado(false);
    setCargandoDetalle(true);
    try {
      setDetalle(await EventPolicyAdminRepository.detalle(politica.id));
    } catch {
      // Se sigue enseñando lo que trajo la lista, diciendo que no se refrescó.
      setDetalleNoActualizado(true);
    } finally {
      setCargandoDetalle(false);
    }
  };

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));

  const textoDelValor = (valor: ValorDeParametro): string =>
    valor.forma === 'texto' ? valor.texto : f(valor.clave, valor.params);

  const pestanas = (
    <View style={styles.chips}>
      {PESTANAS.map((cual) => (
        <Chip
          key={cual}
          label={f(claveDeLaPestana(cual))}
          selected={pestana === cual}
          rol="radio"
          onPress={() => setPestana(cual)}
        />
      ))}
    </View>
  );

  const avisoDeFallo = (cual: Fallo, reintentar: () => void) =>
    cual === 'sinPermiso' || cual === 'noDisponible' ? (
      <StateView
        state="empty"
        icon={cual === 'noDisponible' ? 'clock' : 'lock'}
        title={f(claveDelFallo(cual))}
        description={f(claveDelCuerpoDelFallo(cual))}
      />
    ) : (
      <StateView
        state={cual === 'sinConexion' ? 'offline' : 'error'}
        description={cual === 'sinConexion' ? undefined : f(claveDelCuerpoDelFallo(cual))}
        onRetry={reintentar}
      />
    );

  /* ---------------------------------------------------------------------- */
  /* Sin política: lo que se está vendiendo sin condiciones escritas         */
  /* ---------------------------------------------------------------------- */
  const vistaSinPolitica = () => {
    const que = estadoDeLaLista({
      cargando: cargandoFaltantes,
      fallo: falloFaltantes,
      filas: faltantes.length,
    });
    if (que === 'cargando') return <StateView state="loading" />;
    if (que === 'error' && falloFaltantes !== null) {
      return avisoDeFallo(falloFaltantes, () => void cargarFaltantes());
    }
    if (que === 'vacio') {
      // VACÍO NO ES FALLO: aquí significa que nadie vende sin condiciones.
      return (
        <StateView
          state="empty"
          icon="check-circle"
          title={f('politicasAdmin.sinPoliticaVacia')}
          description={f('politicasAdmin.sinPoliticaVaciaCuerpo')}
          onRetry={() => void cargarFaltantes()}
        />
      );
    }

    const masArriba = siguienteLimite(limiteFaltantes);
    const tope = llegoAlTope(faltantes.length, limiteFaltantes);
    return (
      <>
        <Text variant="caption" color={colors.textMuted}>
          {f('politicasAdmin.sinPoliticaIntro')}
        </Text>
        <Text variant="secondary" weight="700" color={colors.danger}>
          {f('politicasAdmin.sinPoliticaResumen', {
            eventos: contarEventosSinPolitica(faltantes),
            organizadores: contarOrganizadoresSinPolitica(faltantes),
          })}
        </Text>

        {agruparPorOrganizador(faltantes).map((grupo) => {
          const ref = referenciaAbreviada(grupo.organizadorId);
          return (
            <View key={grupo.organizadorId ?? 'sinOrganizador'} style={styles.grupo}>
              <Text variant="caption" color={colors.textMuted}>
                {ref === null
                  ? f('politicasAdmin.organizadorDesconocido')
                  : f('politicasAdmin.organizador', { ref })}
              </Text>
              {grupo.eventos.map((evento) => (
                <Pressable
                  key={evento.event_id}
                  onPress={() => router.push(`/eventos/${evento.event_id}` as never)}
                  style={[styles.fila, { borderColor: colors.border }]}
                  accessibilityRole="button"
                  accessibilityLabel={f('politicasAdmin.abrirEvento', {
                    titulo: evento.title ?? f('politicasAdmin.eventoSinTitulo'),
                  })}
                >
                  <View style={styles.crece}>
                    <Text variant="secondary" weight="700">
                      {evento.title ?? f('politicasAdmin.eventoSinTitulo')}
                    </Text>
                    <Text variant="caption" color={colors.textMuted}>
                      {f('politicasAdmin.eventoRef', {
                        ref: referenciaAbreviada(evento.event_id) ?? '',
                      })}
                    </Text>
                  </View>
                  <Feather name="chevron-right" size={18} color={colors.textMuted} />
                </Pressable>
              ))}
            </View>
          );
        })}

        {tope ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('politicasAdmin.tope', { n: limiteFaltantes })}
          </Text>
        ) : null}
        {tope && masArriba !== null ? (
          <Button
            label={f('politicasAdmin.verMas', { n: masArriba })}
            variant="secondary"
            onPress={() => setLimiteFaltantes(masArriba)}
          />
        ) : null}
      </>
    );
  };

  /* ---------------------------------------------------------------------- */
  /* Publicadas: mirar, filtrar y comparar                                   */
  /* ---------------------------------------------------------------------- */
  const filtros = (
    <View style={styles.filtros}>
      <Text variant="caption" color={colors.textMuted}>
        {f('politicasAdmin.filtroTipo')}
      </Text>
      <View style={styles.chips}>
        <Chip
          label={f('politicasAdmin.filtroTodos')}
          selected={tipo === null}
          rol="radio"
          onPress={() => {
            setLimite(LIMITE_INICIAL);
            setTipo(null);
          }}
        />
        {TIPOS_DE_POLITICA.map((valor) => (
          <Chip
            key={valor}
            label={f(claveDelTipoDePolitica(valor))}
            selected={tipo === valor}
            rol="radio"
            onPress={() => {
              setLimite(LIMITE_INICIAL);
              setTipo(valor);
            }}
          />
        ))}
      </View>

      <Text variant="caption" color={colors.textMuted}>
        {f('politicasAdmin.filtroEstado')}
      </Text>
      <View style={styles.chips}>
        <Chip
          label={f('politicasAdmin.filtroTodos')}
          selected={estado === null}
          rol="radio"
          onPress={() => {
            setLimite(LIMITE_INICIAL);
            setEstado(null);
          }}
        />
        {ESTADOS_DE_POLITICA.map((valor) => (
          <Chip
            key={valor}
            label={f(claveDelEstadoDePolitica(valor))}
            selected={estado === valor}
            rol="radio"
            onPress={() => {
              setLimite(LIMITE_INICIAL);
              setEstado(valor);
            }}
          />
        ))}
      </View>

      <Input
        label={f('politicasAdmin.filtroEvento')}
        placeholder={f('politicasAdmin.filtroEventoAyuda')}
        value={eventoEscrito}
        onChangeText={setEventoEscrito}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Input
        label={f('politicasAdmin.filtroOrganizador')}
        placeholder={f('politicasAdmin.filtroOrganizadorAyuda')}
        value={organizadorEscrito}
        onChangeText={setOrganizadorEscrito}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View style={styles.chips}>
        <Button
          label={f('politicasAdmin.filtroAplicar')}
          variant="secondary"
          onPress={() => {
            setLimite(LIMITE_INICIAL);
            setEventoFiltrado(textoDeFiltro(eventoEscrito));
            setOrganizadorFiltrado(textoDeFiltro(organizadorEscrito));
          }}
          disabled={
            textoDeFiltro(eventoEscrito) === eventoFiltrado &&
            textoDeFiltro(organizadorEscrito) === organizadorFiltrado
          }
        />
        {eventoFiltrado !== null || organizadorFiltrado !== null ? (
          <Button
            label={f('politicasAdmin.filtroQuitar')}
            variant="ghost"
            onPress={() => {
              setEventoEscrito('');
              setOrganizadorEscrito('');
              setLimite(LIMITE_INICIAL);
              setEventoFiltrado(null);
              setOrganizadorFiltrado(null);
            }}
          />
        ) : null}
      </View>
    </View>
  );

  const detalleDeLaPolitica = (fila: PoliticaSupervisada) => {
    // Lo fresco si llegó; si no, lo que trajo la lista, dicho.
    const politica = detalle !== null && detalle.id === fila.id ? detalle : fila;
    const huella = huellaAbreviada(politica.params_sha256);
    const publicoQuien = referenciaAbreviada(politica.published_by);
    const creoQuien = referenciaAbreviada(politica.created_by);
    const anterior = versionAnterior(politicas, politica);
    const cambios =
      anterior === null
        ? null
        : soloLosCambios(compararParametros(anterior.params, politica.params));

    return (
      <View style={[styles.detalle, { borderColor: colors.border }]}>
        {cargandoDetalle ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('politicasAdmin.detalleCargando')}
          </Text>
        ) : null}
        {detalleNoActualizado ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('politicasAdmin.detalleNoActualizado')}
          </Text>
        ) : null}

        <Text variant="caption" color={colors.textMuted}>
          {loEscribeElOrganizador(politica.policy_type)
            ? f('politicasAdmin.laEscribeElOrganizador')
            : f('politicasAdmin.laEscribeLaEmpresa')}
        </Text>

        {/* LA HUELLA SE ENSEÑA: es lo que hace demostrable qué se publicó. */}
        {huella !== null ? (
          <View style={styles.grupo}>
            <Text variant="caption" color={colors.textMuted}>
              {f('politicasAdmin.huella', { huella })}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {f('politicasAdmin.huellaAyuda')}
            </Text>
          </View>
        ) : null}

        <Text variant="caption" color={colors.textMuted}>
          {publicoQuien === null
            ? f('politicasAdmin.sinReferencia')
            : f('politicasAdmin.publicadaPor', { ref: publicoQuien })}
        </Text>
        {creoQuien !== null ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('politicasAdmin.creadaPor', { ref: creoQuien })}
          </Text>
        ) : null}

        {fechaLegible(politica.published_at) !== '' ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('politicasAdmin.publicadaEl', {
              fecha: fechaLegible(politica.published_at),
            })}
          </Text>
        ) : null}
        <Text variant="caption" color={colors.textMuted}>
          {f('politicasAdmin.creadaEl', { fecha: fechaLegible(politica.created_at) })}
        </Text>
        {fechaLegible(politica.effective_from) !== '' ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('politicasAdmin.vigenteDesde', {
              fecha: fechaLegible(politica.effective_from),
            })}
          </Text>
        ) : null}
        {fechaLegible(politica.effective_to) !== '' ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('politicasAdmin.vigenteHasta', {
              fecha: fechaLegible(politica.effective_to),
            })}
          </Text>
        ) : null}

        {/* LOS PARÁMETROS, LEGIBLES. Lo que no sabemos nombrar se enseña crudo. */}
        <Text variant="secondary" weight="700">
          {f('politicasAdmin.parametros')}
        </Text>
        {noDecideNada(politica.params) ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('politicasAdmin.sinParametros')}
          </Text>
        ) : (
          filasDeParametros(politica.params).map((parametro) => (
            <View key={parametro.clave} style={styles.parametro}>
              <Text variant="caption" color={colors.textMuted}>
                {parametro.etiqueta === null ? parametro.clave : f(parametro.etiqueta)}
              </Text>
              <Text variant="caption">{textoDelValor(parametro.valor)}</Text>
            </View>
          ))
        )}

        {/* EL TEXTO QUE LEE QUIEN COMPRA. */}
        <Text variant="secondary" weight="700">
          {f('politicasAdmin.texto')}
        </Text>
        <Text variant="caption" color={politica.body ? colors.text : colors.textMuted}>
          {politica.body ?? f('politicasAdmin.sinTexto')}
        </Text>

        {/* COMPARAR, NO REESCRIBIR: las dos versiones existen y siguen ahí. */}
        <Text variant="secondary" weight="700">
          {anterior === null
            ? f('politicasAdmin.sinComparacion')
            : f('politicasAdmin.comparacion', { version: anterior.version })}
        </Text>
        {cambios !== null && cambios.length === 0 ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('politicasAdmin.sinCambios')}
          </Text>
        ) : null}
        {cambios !== null
          ? cambios.map((cambio) => (
              <View key={`cambio-${cambio.clave}`} style={styles.parametro}>
                <Text variant="caption" color={colors.textMuted}>
                  {cambio.etiqueta === null ? cambio.clave : f(cambio.etiqueta)}
                </Text>
                <Text variant="caption">
                  {f('politicasAdmin.antesAhora', {
                    antes:
                      cambio.antes === null
                        ? f(claveDelCambio('anadido'))
                        : textoDelValor(cambio.antes),
                    ahora:
                      cambio.ahora === null
                        ? f(claveDelCambio('quitado'))
                        : textoDelValor(cambio.ahora),
                  })}
                </Text>
              </View>
            ))
          : null}
      </View>
    );
  };

  const vistaPublicadas = () => {
    const que = estadoDeLaLista({ cargando, fallo, filas: politicas.length });
    if (que === 'cargando') {
      return (
        <>
          {filtros}
          <StateView state="loading" />
        </>
      );
    }
    if (que === 'error' && fallo !== null) {
      return avisoDeFallo(fallo, () => void cargarPoliticas());
    }

    const masArriba = siguienteLimite(limite);
    const tope = llegoAlTope(politicas.length, limite);
    return (
      <>
        {filtros}
        <Text variant="caption" color={colors.textMuted}>
          {f('politicasAdmin.soloLectura')}
        </Text>

        {que === 'vacio' ? (
          <StateView
            state="empty"
            title={f('politicasAdmin.listaVacia')}
            description={
              cuantosFiltros({
                organizadorId: organizadorFiltrado,
                eventoId: eventoFiltrado,
                tipo,
                estado,
              }) > 0
                ? f('politicasAdmin.listaVaciaFiltrada')
                : f('politicasAdmin.listaVaciaCuerpo')
            }
            onRetry={() => void cargarPoliticas()}
          />
        ) : (
          politicas.map((politica) => {
            const nombre = f(claveDelTipoDePolitica(politica.policy_type));
            const tono = tonoDelEstado(politica.status);
            const colorDelEstado =
              tono === 'vigente'
                ? colors.success
                : tono === 'historico'
                  ? colors.textMuted
                  : colors.text;
            const desplegada = abierta === politica.id;
            return (
              <View key={politica.id} style={styles.grupo}>
                <Pressable
                  onPress={() => void desplegar(politica)}
                  style={[styles.fila, { borderColor: colors.border }]}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: desplegada }}
                  accessibilityLabel={
                    desplegada
                      ? f('politicasAdmin.cerrarPolitica', { tipo: nombre })
                      : f('politicasAdmin.abrirPolitica', { tipo: nombre })
                  }
                >
                  <View style={styles.crece}>
                    <Text variant="secondary" weight="700">
                      {nombre}
                    </Text>
                    <Text variant="caption" color={colorDelEstado}>
                      {f(claveDelEstadoDePolitica(politica.status))}
                    </Text>
                    {estaVigente(politica) ? (
                      <Text variant="caption" color={colors.success}>
                        {f('politicasAdmin.vigente')}
                      </Text>
                    ) : null}
                    <Text variant="caption" color={colors.textMuted}>
                      {f('politicasAdmin.version', { version: politica.version })}
                    </Text>
                    <Text variant="caption" color={colors.textMuted}>
                      {referenciaAbreviada(politica.event_id) === null
                        ? f('politicasAdmin.sinEvento')
                        : f('politicasAdmin.eventoRef', {
                            ref: referenciaAbreviada(politica.event_id) ?? '',
                          })}
                    </Text>
                  </View>
                  <Feather
                    name={desplegada ? 'chevron-up' : 'chevron-down'}
                    size={18}
                    color={colors.textMuted}
                  />
                </Pressable>
                {desplegada ? detalleDeLaPolitica(politica) : null}
              </View>
            );
          })
        )}

        {tope ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('politicasAdmin.tope', { n: limite })}
          </Text>
        ) : null}
        {tope && masArriba !== null ? (
          <Button
            label={f('politicasAdmin.verMas', { n: masArriba })}
            variant="secondary"
            onPress={() => setLimite(masArriba)}
          />
        ) : null}
      </>
    );
  };

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('politicasAdmin.tituloPanel')} onBack={volver} />
      {pestanas}
      {pestana === 'sinPolitica' ? vistaSinPolitica() : vistaPublicadas()}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  filtros: { gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  crece: { flex: 1, gap: 4 },
  grupo: { gap: spacing.sm },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    minHeight: 44,
  },
  detalle: {
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  parametro: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
});
