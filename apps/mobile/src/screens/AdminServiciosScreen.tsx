import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { ListRow } from '@/components/ListRow';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import {
  FILTROS_DE_ESTADO,
  FILTROS_DE_TIPO,
  claveDelEstado,
  claveDelTipoDePrestador,
  fechaCorta,
  juntarPaginas,
  type EstadoDePostulacion,
  type FalloDeCarga,
  type SolicitudResumen,
  type TipoDePrestador,
} from '@/lib/serviciosAdmision';
import { leerFallo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceAdmissionRepository } from '@/repositories/ServiceAdmissionRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * La bandeja de postulaciones de prestadores de Servicios.
 *
 * - DE FÁBRICA, lo que espera a Z: enviadas, en revisión y reenviadas.
 * - FILTROS por estado y por tipo (persona o empresa). Un filtro que no
 *   existe es un error del servidor, no una lista vacía.
 * - PAGINACIÓN POR CURSOR: «Ver más» pide la siguiente página; las filas que
 *   se repitan no se pintan dos veces.
 * - Quien no revisa ve «sin permiso»: lo decide el servidor.
 */
export function AdminServiciosScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { f, textoDelError } = useTextosDeServicios();
  const [estado, setEstado] = useState<EstadoDePostulacion | null>(null);
  const [tipo, setTipo] = useState<TipoDePrestador | null>(null);
  const [filas, setFilas] = useState<SolicitudResumen[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [fallo, setFallo] = useState<FalloDeCarga | null>(null);
  const [masCargando, setMasCargando] = useState(false);
  const pedido = useRef(0);

  const cargar = useCallback(async () => {
    const este = ++pedido.current;
    setFallo(null);
    setFilas(null);
    try {
      const pagina = await ServiceAdmissionRepository.bandeja({ estado, tipo, cursor: null });
      // Si mientras tanto cambió el filtro, esta respuesta ya no vale.
      if (este !== pedido.current) return;
      setFilas(pagina.items);
      setCursor(pagina.next_cursor);
    } catch (error) {
      if (este === pedido.current) setFallo(leerFallo(error));
    }
  }, [estado, tipo]);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  const verMas = async () => {
    if (!cursor || masCargando) return;
    setMasCargando(true);
    try {
      const pagina = await ServiceAdmissionRepository.bandeja({ estado, tipo, cursor });
      setFilas((actuales) => juntarPaginas(actuales ?? [], pagina.items));
      setCursor(pagina.next_cursor);
    } catch (error) {
      notify(f('servicios.noSePudo'), textoDelError(error));
    } finally {
      setMasCargando(false);
    }
  };

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/admin' as never));

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader
        title={f('servicios.admin.titulo')}
        onBack={volver}
        rightIcon="file-text"
        onRightPress={() => router.push('/admin/servicios/condiciones' as never)}
      />
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.admin.intro')}
      </Text>
      <View style={styles.fila}>
        {FILTROS_DE_ESTADO.map((opcion) => (
          <Chip
            key={opcion ?? 'pendientes'}
            rol="radio"
            label={opcion ? f(claveDelEstado(opcion)) : f('servicios.admin.pendientes')}
            selected={estado === opcion}
            onPress={() => setEstado(opcion)}
          />
        ))}
      </View>
      <View style={styles.fila}>
        {FILTROS_DE_TIPO.map((opcion) => (
          <Chip
            key={opcion ?? 'todos'}
            rol="radio"
            label={opcion ? f(claveDelTipoDePrestador(opcion)) : f('servicios.admin.todos')}
            selected={tipo === opcion}
            onPress={() => setTipo(opcion)}
          />
        ))}
      </View>
      <View style={styles.fila}>
        <Button
          label={f('servicios.admin.condiciones')}
          variant="ghost"
          icon="file-text"
          onPress={() => router.push('/admin/servicios/condiciones' as never)}
        />
        <Button
          label={f('servicios.admin.condicionesDeContratacion')}
          variant="ghost"
          icon="file-text"
          onPress={() => router.push('/admin/servicios/condiciones-de-contratacion' as never)}
        />
        <Button
          label={f('servicios.admin.reservas')}
          variant="ghost"
          icon="calendar"
          onPress={() => router.push('/admin/servicios/reservas' as never)}
        />
      </View>

      {fallo !== null ? (
        <EstadoDeServicios fallo={fallo} onRetry={() => void cargar()} />
      ) : filas === null ? (
        <StateView state="loading" />
      ) : filas.length === 0 ? (
        <StateView state="empty" icon="inbox" title={f('servicios.admin.vacia')} />
      ) : (
        <>
          {filas.map((s) => (
            <ListRow
              key={s.id}
              title={s.display_name}
              subtitle={`${f(claveDelEstado(s.status))} · ${f(claveDelTipoDePrestador(s.provider_type))}${
                s.last_submitted_at ? ` · ${fechaCorta(s.last_submitted_at)}` : ''
              }`}
              leftIcon="user"
              rightIcon="chevron-right"
              onPress={() => router.push(`/admin/servicios/${s.id}` as never)}
            />
          ))}
          {cursor ? (
            <Button
              label={f('servicios.admin.verMas')}
              variant="secondary"
              loading={masCargando}
              disabled={masCargando}
              onPress={() => void verMas()}
            />
          ) : null}
        </>
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  fila: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
