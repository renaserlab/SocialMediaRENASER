import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { EstadoDelCatalogo } from '@/components/EstadoDelCatalogo';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { TarjetaDeServicio } from '@/components/TarjetaDeServicio';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import {
  MODALIDADES_OFRECIDAS,
  claveDeLaModalidad,
  nombreDeLaCategoria,
  type FalloDelCatalogo,
} from '@/lib/serviciosCatalogo';
import {
  SIN_FILTROS,
  TIPOS_DE_PRECIO_OFRECIDOS,
  categoriasFrecuentes,
  claveDeLaSeccion,
  claveDelOrden,
  claveDelTipoDePrecio,
  conGuardado,
  cuantosFiltros,
  estaBuscando,
  filtrosDesdeRuta,
  juntarSinRepetir,
  limpiarFiltros,
  ordenElegido,
  ordenesPosibles,
  revisarFiltros,
  rutaDesdeFiltros,
  type CategoriaDelCatalogo,
  type Filtros,
  type SeccionDeSugerencias,
  type TarjetaDeServicio as Tarjeta,
} from '@/lib/serviciosDescubrimiento';
import { leerConsultaInvalida, leerFalloDelCatalogo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceDiscoveryRepository } from '@/repositories/ServiceDiscoveryRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Servicios: la entrada desde Explorar. Buscar por lo que se necesita,
 * entrar por categoría, afinar con filtros y ordenar.
 *
 * TODO LO FILTRA Y ORDENA EL SERVIDOR, por cursor: aquí no se recorta ni se
 * reordena ninguna lista. LOS FILTROS VIVEN EN LA RUTA: volver desde una
 * ficha, o abrir un enlace, los conserva.
 *
 * Sin búsqueda ni filtros se enseñan las SUGERENCIAS, cada una con su razón,
 * y solo si hay alguna: nunca una lista cualquiera presentada como
 * «para ti».
 *
 * NO HAY RESERVAS NI PAGOS: aquí se descubre; contratar llega después.
 */
export function ServiciosScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const params = useLocalSearchParams();
  const { f, textoDelError, idioma } = useTextosDeServicios('descubrimiento');
  const filtros = useMemo(() => filtrosDesdeRuta(params), [params]);
  const clave = JSON.stringify(rutaDesdeFiltros(filtros));

  const [texto, setTexto] = useState(filtros.q);
  const [errorDeBusqueda, setErrorDeBusqueda] = useState<string | null>(null);
  const [categorias, setCategorias] = useState<CategoriaDelCatalogo[]>([]);
  const [todas, setTodas] = useState(false);
  const [items, setItems] = useState<Tarjeta[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [secciones, setSecciones] = useState<SeccionDeSugerencias[]>([]);
  const [fallo, setFallo] = useState<FalloDelCatalogo | null>(null);
  const [consultaInvalida, setConsultaInvalida] = useState<string | null>(null);
  const [masCargando, setMasCargando] = useState(false);
  const [guardando, setGuardando] = useState<string | null>(null);
  const [hoja, setHoja] = useState<Filtros | null>(null);
  const pedido = useRef(0);

  useEffect(() => setTexto(filtros.q), [filtros.q]);

  const aplicar = useCallback(
    (nuevos: Filtros) => {
      router.replace({ pathname: '/servicios', params: rutaDesdeFiltros(nuevos) } as never);
    },
    [router],
  );

  const cargar = useCallback(async () => {
    const este = ++pedido.current;
    setFallo(null);
    setConsultaInvalida(null);
    setItems(null);
    try {
      const [pagina, cats, sugerencias] = await Promise.all([
        ServiceDiscoveryRepository.catalogo(filtros, null),
        ServiceDiscoveryRepository.categorias(),
        estaBuscando(filtros) ? Promise.resolve({ sections: [] }) : ServiceDiscoveryRepository.sugerencias(),
      ]);
      if (este !== pedido.current) return;
      setItems(pagina.items);
      setCursor(pagina.next_cursor);
      setCategorias(cats);
      setSecciones(sugerencias.sections);
    } catch (error) {
      if (este !== pedido.current) return;
      const invalida = leerConsultaInvalida(error);
      if (invalida) setConsultaInvalida(invalida);
      else setFallo(leerFalloDelCatalogo(error));
    }
    // `clave` resume los filtros: cambiar uno vuelve a pedir desde el principio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave]);

  // AL CAMBIAR LOS FILTROS, no al volver a la pantalla: volver de una ficha
  // conserva las páginas ya cargadas y la posición.
  useEffect(() => {
    void cargar();
  }, [cargar]);

  const verMas = async () => {
    if (!cursor || masCargando) return;
    const este = pedido.current;
    setMasCargando(true);
    try {
      const pagina = await ServiceDiscoveryRepository.catalogo(filtros, cursor);
      if (este !== pedido.current) return;
      setItems((actuales) => juntarSinRepetir(actuales ?? [], pagina.items));
      setCursor(pagina.next_cursor);
    } catch (error) {
      notify(f('servicios.noSePudo'), textoDelError(error));
    } finally {
      setMasCargando(false);
    }
  };

  const alternarGuardado = async (tarjeta: Tarjeta) => {
    if (guardando) return;
    setGuardando(tarjeta.id);
    try {
      const r = tarjeta.saved
        ? await ServiceDiscoveryRepository.quitar(tarjeta.id)
        : await ServiceDiscoveryRepository.guardar(tarjeta.id);
      setItems((actuales) => (actuales ? conGuardado(actuales, tarjeta.id, r.saved) : actuales));
      setSecciones((actuales) => actuales.map((s) => ({ ...s, items: conGuardado(s.items, tarjeta.id, r.saved) })));
    } catch (error) {
      notify(f('servicios.noSePudo'), textoDelError(error));
    } finally {
      setGuardando(null);
    }
  };

  const buscar = () => {
    const nuevos = { ...filtros, q: texto.trim() };
    const problema = revisarFiltros(nuevos);
    if (problema?.campo === 'q') {
      setErrorDeBusqueda(f(problema.clave));
      return;
    }
    setErrorDeBusqueda(null);
    aplicar(nuevos);
  };

  const aplicarHoja = () => {
    if (!hoja) return;
    const problema = revisarFiltros(hoja);
    if (problema) {
      notify(f('servicios.descubrir.filtros.titulo'), f(problema.clave));
      return;
    }
    setHoja(null);
    aplicar(hoja);
  };

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/explore' as never));
  const abrir = (t: Tarjeta) => router.push(`/servicios/ficha/${t.id}` as never);
  const buscando = estaBuscando(filtros);
  const cuantos = cuantosFiltros(filtros);
  const visibles = todas ? categorias : categoriasFrecuentes(categorias);

  const tarjetas = (lista: Tarjeta[]) =>
    lista.map((t) => (
      <TarjetaDeServicio
        key={t.id}
        tarjeta={t}
        alAbrir={() => abrir(t)}
        alGuardar={() => void alternarGuardado(t)}
        guardando={guardando === t.id}
      />
    ));

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader
        title={f('servicios.descubrir.titulo')}
        onBack={volver}
        rightIcon="bookmark"
        rightLabel={f('servicios.descubrir.guardados.abrir')}
        onRightPress={() => router.push('/servicios/guardados' as never)}
      />
      <Button
        label={f('servicios.reserva.misReservas')}
        variant="ghost"
        icon="calendar"
        onPress={() => router.push('/servicios/reservas' as never)}
      />
      <Text variant="title" accessibilityRole="header">
        {f('servicios.descubrir.pregunta')}
      </Text>
      <Input
        value={texto}
        onChangeText={(v) => {
          setTexto(v);
          setErrorDeBusqueda(null);
        }}
        placeholder={f('servicios.descubrir.buscarPlaceholder')}
        accessibilityLabel={f('servicios.descubrir.buscarEtiqueta')}
        returnKeyType="search"
        onSubmitEditing={buscar}
        maxLength={120}
        error={errorDeBusqueda ?? undefined}
      />
      <View style={styles.fila}>
        <Button label={f('servicios.descubrir.buscar')} icon="search" onPress={buscar} />
        <Button
          label={cuantos > 0 ? f('servicios.descubrir.filtros.conCuantos', { n: cuantos }) : f('servicios.descubrir.filtros.titulo')}
          icon="sliders"
          variant="secondary"
          onPress={() => setHoja(filtros)}
        />
      </View>

      {categorias.length > 0 ? (
        <View style={styles.bloque}>
          <Text weight="700">{f('servicios.descubrir.frecuentes')}</Text>
          <View style={styles.chips}>
            {visibles.map((c) => (
              <Chip
                key={c.id}
                label={nombreDeLaCategoria(c, idioma)}
                selected={filtros.categoria === c.id}
                rol="radio"
                onPress={() => aplicar({ ...filtros, categoria: filtros.categoria === c.id ? null : c.id })}
              />
            ))}
            {categorias.length > visibles.length || todas ? (
              <Chip
                label={todas ? f('servicios.descubrir.verMenos') : f('servicios.descubrir.verTodas')}
                rol="button"
                onPress={() => setTodas(!todas)}
              />
            ) : null}
          </View>
        </View>
      ) : null}

      {buscando ? (
        <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel={f('servicios.descubrir.ordenar')}>
          {ordenesPosibles(filtros).map((o) => (
            <Chip
              key={o}
              label={f(claveDelOrden(o))}
              selected={ordenElegido(filtros) === o}
              rol="radio"
              onPress={() => aplicar({ ...filtros, orden: o })}
            />
          ))}
        </View>
      ) : null}

      {consultaInvalida !== null ? (
        <StateView
          state="empty"
          icon="alert-circle"
          title={f(consultaInvalida)}
          description={f('servicios.descubrir.consultaInvalidaCuerpo')}
          actionLabel={f('servicios.descubrir.limpiar')}
          onAction={() => aplicar(SIN_FILTROS)}
        />
      ) : fallo !== null ? (
        <EstadoDelCatalogo fallo={fallo} onRetry={() => void cargar()} />
      ) : items === null ? (
        <StateView state="loading" />
      ) : (
        <>
          {!buscando
            ? secciones.map((s) => {
                const titulo = claveDeLaSeccion(s.reason);
                return titulo && s.items.length > 0 ? (
                  <View key={s.reason} style={styles.bloque}>
                    <Text weight="700" accessibilityRole="header">
                      {f(titulo)}
                    </Text>
                    {tarjetas(s.items)}
                  </View>
                ) : null;
              })
            : null}
          {items.length === 0 ? (
            buscando ? (
              <StateView
                state="empty"
                icon="search"
                title={f('servicios.descubrir.sinResultados')}
                description={f('servicios.descubrir.sinResultadosCuerpo')}
                actionLabel={f('servicios.descubrir.limpiar')}
                onAction={() => aplicar(SIN_FILTROS)}
              />
            ) : (
              <StateView
                state="empty"
                icon="briefcase"
                title={f('servicios.descubrir.vacio')}
                description={f('servicios.descubrir.vacioCuerpo')}
              />
            )
          ) : (
            <View style={styles.bloque}>
              <Text weight="700" accessibilityRole="header">
                {buscando ? f('servicios.descubrir.resultados') : f('servicios.descubrir.todos')}
              </Text>
              {tarjetas(items)}
              {cursor ? (
                <Button
                  label={f('servicios.admin.verMas')}
                  variant="secondary"
                  loading={masCargando}
                  disabled={masCargando}
                  onPress={() => void verMas()}
                />
              ) : null}
            </View>
          )}
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.descubrir.soloDescubrir')}
          </Text>
        </>
      )}

      <BottomSheet visible={hoja !== null} onClose={() => setHoja(null)} desplazable>
        {hoja ? (
          <View style={styles.hoja}>
            <Text variant="title" accessibilityRole="header">
              {f('servicios.descubrir.filtros.titulo')}
            </Text>
            <Text weight="700">{f('servicios.descubrir.filtros.modalidad')}</Text>
            <View style={styles.chips} accessibilityRole="radiogroup">
              <Chip label={f('servicios.descubrir.filtros.cualquiera')} rol="radio" selected={hoja.modalidad === null}
                onPress={() => setHoja({ ...hoja, modalidad: null })} />
              {MODALIDADES_OFRECIDAS.map((m) => (
                <Chip key={m} label={f(claveDeLaModalidad(m))} rol="radio" selected={hoja.modalidad === m}
                  onPress={() => setHoja({ ...hoja, modalidad: m })} />
              ))}
            </View>
            <Text weight="700">{f('servicios.descubrir.filtros.precio')}</Text>
            <View style={styles.chips} accessibilityRole="radiogroup">
              {/* En el piloto no hay fichas con importe: solo se ofrece
                  filtrar por lo que existe. Sin moneda ni rango. */}
              {[null, ...TIPOS_DE_PRECIO_OFRECIDOS].map((p) => (
                <Chip key={p ?? 'cualquiera'} label={f(claveDelTipoDePrecio(p))} rol="radio" selected={hoja.precio === p}
                  onPress={() => setHoja({ ...hoja, precio: p, moneda: null, minimo: '', maximo: '' })} />
              ))}
            </View>
            <Input
              label={f('servicios.descubrir.filtros.zona')}
              placeholder={f('servicios.descubrir.filtros.zonaPlaceholder')}
              value={hoja.zona}
              maxLength={80}
              onChangeText={(v) => setHoja({ ...hoja, zona: v })}
            />
            <Chip
              label={f('servicios.descubrir.filtros.credencial')}
              rol="checkbox"
              selected={hoja.conCredencial}
              icon="check-circle"
              onPress={() => setHoja({ ...hoja, conCredencial: !hoja.conCredencial })}
            />
            <View style={styles.fila}>
              <Button label={f('servicios.descubrir.limpiar')} variant="secondary" onPress={() => setHoja(limpiarFiltros(hoja))} />
              <Button label={f('servicios.descubrir.filtros.aplicar')} onPress={aplicarHoja} />
            </View>
          </View>
        ) : null}
      </BottomSheet>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  fila: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  bloque: { gap: spacing.sm },
  hoja: { gap: spacing.md, padding: spacing.lg },
});
