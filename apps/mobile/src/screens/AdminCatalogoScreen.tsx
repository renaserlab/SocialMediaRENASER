import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { EstadoDelCatalogo } from '@/components/EstadoDelCatalogo';
import { ListRow } from '@/components/ListRow';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { fechaCorta } from '@/lib/serviciosAdmision';
import {
  COLAS,
  FILTROS_DE_MODALIDAD,
  FILTROS_DE_VERSION,
  categoriasEnArbol,
  claveDeLaCola,
  claveDeLaModalidad,
  claveDelEstadoDeLaVersion,
  claveDelEstadoDelServicio,
  etiquetaDeCategoria,
  juntar,
  nombreDeLaCategoria,
  type Categoria,
  type Cola,
  type FalloDelCatalogo,
  type ServicioAdminResumen,
} from '@/lib/serviciosCatalogo';
import { leerFalloDelCatalogo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceCatalogAdminRepository } from '@/repositories/ServiceCatalogAdminRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * La bandeja del catálogo de Servicios, para el equipo de Z.
 *
 * - DE FÁBRICA, lo que espera a Z: versiones enviadas, en revisión y
 *   aprobadas sin publicar, lo más reciente primero.
 * - FILTROS: la cola, el estado de la versión (en la cola de pendientes), la
 *   modalidad y la categoría.
 * - PAGINACIÓN POR CURSOR; una respuesta vieja no pisa un filtro nuevo.
 * - Quien no revisa ve «sin permiso»: lo decide el servidor.
 */
export function AdminCatalogoScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { f, textoDelError, idioma } = useTextosDeServicios('catalogo');
  const [cola, setCola] = useState<Cola>('pending');
  const [estadoDeVersion, setEstadoDeVersion] = useState<string | null>(null);
  const [modalidad, setModalidad] = useState<string | null>(null);
  const [categoria, setCategoria] = useState<string | null>(null);
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [filas, setFilas] = useState<ServicioAdminResumen[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [fallo, setFallo] = useState<FalloDelCatalogo | null>(null);
  const [masCargando, setMasCargando] = useState(false);
  const pedido = useRef(0);

  const filtros = { cola, estadoDeVersion: cola === 'pending' ? estadoDeVersion : null, modalidad, categoria };

  const cargar = useCallback(async () => {
    const este = ++pedido.current;
    setFallo(null);
    setFilas(null);
    try {
      const pagina = await ServiceCatalogAdminRepository.bandeja({
        cola,
        estadoDeVersion: cola === 'pending' ? estadoDeVersion : null,
        modalidad,
        categoria,
        cursor: null,
      });
      if (este !== pedido.current) return;
      setFilas(pagina.items);
      setCursor(pagina.next_cursor);
    } catch (error) {
      if (este === pedido.current) setFallo(leerFalloDelCatalogo(error));
    }
  }, [cola, estadoDeVersion, modalidad, categoria]);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  // Las categorías solo sirven para filtrar: sin ellas, no hay ese filtro.
  useEffect(() => {
    let vigente = true;
    ServiceCatalogAdminRepository.categorias()
      .then((lista) => vigente && setCategorias(lista))
      .catch(() => undefined);
    return () => {
      vigente = false;
    };
  }, []);

  const verMas = async () => {
    if (!cursor || masCargando) return;
    // Si mientras tanto cambió un filtro, esta página es de otra lista.
    const este = pedido.current;
    setMasCargando(true);
    try {
      const pagina = await ServiceCatalogAdminRepository.bandeja({ ...filtros, cursor });
      if (este !== pedido.current) return;
      setFilas((actuales) => juntar(actuales ?? [], pagina.items));
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
        title={f('servicios.catalogo.admin.titulo')}
        onBack={volver}
        rightIcon="grid"
        rightLabel={f('servicios.catalogo.categorias.titulo')}
        onRightPress={() => router.push('/admin/servicios/categorias' as never)}
      />
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.catalogo.admin.intro')}
      </Text>
      <View style={styles.fila} accessibilityRole="radiogroup">
        {COLAS.map((opcion) => (
          <Chip key={opcion} rol="radio" label={f(claveDeLaCola(opcion))} selected={cola === opcion} onPress={() => setCola(opcion)} />
        ))}
      </View>
      {cola === 'pending' ? (
        <View style={styles.fila} accessibilityRole="radiogroup">
          {FILTROS_DE_VERSION.map((opcion) => (
            <Chip
              key={opcion ?? 'todas'}
              rol="radio"
              label={opcion ? f(claveDelEstadoDeLaVersion(opcion)) : f('servicios.admin.todos')}
              selected={estadoDeVersion === opcion}
              onPress={() => setEstadoDeVersion(opcion)}
            />
          ))}
        </View>
      ) : null}
      <View style={styles.fila} accessibilityRole="radiogroup">
        {FILTROS_DE_MODALIDAD.map((opcion) => (
          <Chip
            key={opcion ?? 'todas'}
            rol="radio"
            label={opcion ? f(claveDeLaModalidad(opcion)) : f('servicios.catalogo.admin.todasLasModalidades')}
            selected={modalidad === opcion}
            onPress={() => setModalidad(opcion)}
          />
        ))}
      </View>
      {categorias.length > 0 ? (
        <View style={styles.fila} accessibilityRole="radiogroup">
          <Chip
            rol="radio"
            label={f('servicios.catalogo.admin.todasLasCategorias')}
            selected={categoria === null}
            onPress={() => setCategoria(null)}
          />
          {categoriasEnArbol(categorias).map((c) => (
            <Chip
              key={c.id}
              rol="radio"
              label={etiquetaDeCategoria(c, categorias, idioma)}
              selected={categoria === c.id}
              onPress={() => setCategoria(c.id)}
            />
          ))}
        </View>
      ) : null}
      <Button
        label={f('servicios.catalogo.admin.categorias')}
        variant="ghost"
        icon="grid"
        onPress={() => router.push('/admin/servicios/categorias' as never)}
      />

      {fallo !== null ? (
        <EstadoDelCatalogo fallo={fallo} onRetry={() => void cargar()} />
      ) : filas === null ? (
        <StateView state="loading" />
      ) : filas.length === 0 ? (
        <StateView state="empty" icon="inbox" title={f('servicios.catalogo.admin.vacia')} />
      ) : (
        <>
          {filas.map((s) => {
            const partes = [s.provider_name, f(claveDelEstadoDelServicio(s.status))];
            if (s.open_version && s.open_version_status) {
              partes.push(
                `${f('servicios.catalogo.versionN', { n: s.open_version })} ${f(claveDelEstadoDeLaVersion(s.open_version_status))}`,
              );
            }
            partes.push(nombreDeLaCategoria(s.category, idioma));
            const fecha = s.submitted_at ?? s.updated_at;
            return (
              <ListRow
                key={s.id}
                title={s.title ?? f('servicios.catalogo.sinTitulo')}
                subtitle={`${partes.join(' · ')} · ${fechaCorta(fecha)}`}
                leftIcon="briefcase"
                rightIcon="chevron-right"
                onPress={() => router.push(`/admin/servicios/catalogo/${s.id}` as never)}
              />
            );
          })}
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
