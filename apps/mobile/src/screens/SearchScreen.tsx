import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppScreen } from '@/components/AppScreen';
import { AppHeader } from '@/components/AppHeader';
import { Input } from '@/components/Input';
import { ListRow } from '@/components/ListRow';
import { SectionTitle } from '@/components/SectionTitle';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import {
  FilaDeResultado,
  filasDeResultados,
  useTextosDeBusqueda,
  type FilaDeBusqueda,
} from '@/components/resultadosDeBusqueda';
import { useTranslation } from '@/i18n/useTranslation';
import { SearchRepository } from '@/repositories/SearchRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import {
  ampliar,
  anotarTecleo,
  aplicar,
  debeDecirSinResultados,
  esBuscable,
  estadoInicial,
  estaOcupado,
  ESPERA_DE_TECLEO_MS,
  lanzar,
  marcarFallo,
  normalizarTermino,
  totalDeResultados,
  type EstadoDeBusqueda,
  type Grupo,
} from '@/lib/busquedaProgresiva';

const RECENTS_KEY = 'renaser-recent-searches';
const MAX_RECENTS = 6;

/** Las filas propias de esta pantalla: las búsquedas recientes. */
type FilaDeReciente = { kind: 'recent'; key: string; value: string };
type SearchRow = FilaDeBusqueda | FilaDeReciente;

/**
 * La pantalla de buscar.
 *
 * TODO LO QUE SE VE AQUI LO RESUELVE `GET /api/v1/search`. Antes esta pantalla
 * filtraba `state.posts` —las veinte publicaciones ya descargadas, asi que una
 * publicacion de hace tres meses no aparecia jamas— y se bajaba el catalogo
 * entero de cursos para pasarle un `includes`. Ahora pregunta a la base, que es
 * donde estan todas las filas, y de paso encuentra por TEMA: «muebles» saca
 * carpinteria aunque esa palabra no este escrita en ningun sitio.
 *
 * LA LOGICA DE LA CARRERA NO ESTA AQUI, esta en `lib/busquedaProgresiva.ts`, y
 * es lo que impide que la respuesta lenta de «carp» pise a la de
 * «carpinteria». COMO SE PINTA UN RESULTADO TAMPOCO: eso vive en
 * `components/resultadosDeBusqueda.tsx`, compartido con el buscador de
 * Explorar, que es el que la gente usa de verdad. Esta pantalla solo mueve
 * datos: pide, entrega el sello y pinta.
 *
 * LO UNICO QUE ES SUYO Y NO DE EXPLORAR son las busquedas recientes: alli el
 * buscador vive encima del muro y una lista de terminos pasados taparia justo
 * lo que la persona ha ido a ver.
 */
export function SearchScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [recents, setRecents] = useState<string[]>([]);
  const [estado, setEstado] = useState<EstadoDeBusqueda>(estadoInicial);

  /*
    El estado tambien en una referencia.

    Hace falta porque lanzar una peticion NECESITA el sello que sale de la misma
    transicion que actualiza el estado, y los actualizadores de `useState` tienen
    que ser puros: sacar el sello desde dentro de uno es un efecto colateral que
    en modo estricto se ejecuta dos veces. Con la referencia, la transicion se
    calcula una vez, fuera, y `setEstado` recibe el resultado ya hecho.
  */
  const refEstado = useRef(estado);
  const cambiar = useCallback((paso: (previo: EstadoDeBusqueda) => EstadoDeBusqueda) => {
    const siguiente = paso(refEstado.current);
    if (siguiente === refEstado.current) return;
    refEstado.current = siguiente;
    setEstado(siguiente);
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(RECENTS_KEY)
      .then((raw) => {
        if (raw) setRecents(JSON.parse(raw) as string[]);
      })
      .catch(() => {});
  }, []);

  const persistRecent = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length < 2) return;
    const next = [trimmed, ...recents.filter((r) => r !== trimmed)].slice(0, MAX_RECENTS);
    setRecents(next);
    AsyncStorage.setItem(RECENTS_KEY, JSON.stringify(next)).catch(() => {});
  };

  const clearRecents = () => {
    setRecents([]);
    AsyncStorage.removeItem(RECENTS_KEY).catch(() => {});
  };

  /*
    Una sola peticion por pausa al teclear, y se cancela si el texto cambia.

    La cancelacion es un ahorro, NO la garantia: una respuesta puede estar ya
    viajando cuando se aborta, y en la web el `fetch` cancelado a veces resuelve
    igual. Lo que de verdad evita pintar resultados de otra busqueda es el sello
    que se comprueba al aplicar.
  */
  useEffect(() => {
    cambiar((previo) => anotarTecleo(previo, query));
    const texto = normalizarTermino(query);
    if (!esBuscable(texto)) return;

    const control = new AbortController();
    const temporizador = setTimeout(() => {
      const { estado: enVuelo, sello } = lanzar(refEstado.current, texto);
      refEstado.current = enVuelo;
      setEstado(enVuelo);

      SearchRepository.buscar(texto, { signal: control.signal })
        .then((respuesta) => cambiar((previo) => aplicar(previo, sello, respuesta)))
        .catch(() => {
          // Cancelar no es fallar: el aviso de error seria de una busqueda que
          // ya nadie espera.
          if (control.signal.aborted) return;
          cambiar((previo) => marcarFallo(previo, sello));
        });
    }, ESPERA_DE_TECLEO_MS);

    return () => {
      clearTimeout(temporizador);
      control.abort();
    };
  }, [query, cambiar]);

  /** Pide la pagina siguiente de un grupo, sin tocar los demas. */
  const verMas = useCallback(
    (grupo: Grupo) => {
      const paso = ampliar(refEstado.current, grupo);
      if (!paso) return;
      refEstado.current = paso.estado;
      setEstado(paso.estado);
      SearchRepository.buscar(paso.sello.termino, { grupo, salto: paso.sello.salto })
        .then((respuesta) => cambiar((previo) => aplicar(previo, paso.sello, respuesta)))
        .catch(() => cambiar((previo) => marcarFallo(previo, paso.sello)));
    },
    [cambiar],
  );

  /** Vuelve a lanzar la busqueda actual tal cual, para el boton de reintentar. */
  const reintentar = useCallback(() => {
    const texto = normalizarTermino(query);
    if (!esBuscable(texto)) return;
    const { estado: enVuelo, sello } = lanzar(refEstado.current, texto);
    refEstado.current = enVuelo;
    setEstado(enVuelo);
    SearchRepository.buscar(texto)
      .then((respuesta) => cambiar((previo) => aplicar(previo, sello, respuesta)))
      .catch(() => cambiar((previo) => marcarFallo(previo, sello)));
  }, [query, cambiar]);

  const buscando = esBuscable(estado.tecleado);
  const ocupado = estaOcupado(estado);
  const total = totalDeResultados(estado);
  const textosDeBusqueda = useTextosDeBusqueda();

  const rows = useMemo<SearchRow[]>(() => {
    if (!buscando) {
      if (recents.length === 0) return [];
      return [
        {
          kind: 'section',
          key: 'sec-recents',
          title: t('search.recent'),
          action: t('search.clearRecent'),
          onAction: clearRecents,
        },
        ...recents.map((value) => ({ kind: 'recent' as const, key: `r-${value}`, value })),
      ];
    }
    return filasDeResultados(estado.resultados, {
      ampliando: estado.ampliando,
      verMas,
      textos: textosDeBusqueda,
    });
    // `recents`/`clearRecents` solo afectan al modo sin búsqueda.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buscando, estado.resultados, estado.ampliando, recents, verMas, textosDeBusqueda, t]);

  return (
    <AppScreen scroll={false}>
      <AppHeader
        title={t('search.title')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/explore'))}
      />

      <View style={styles.searchWrapper}>
        <Input
          placeholder={t('search.placeholder')}
          placeholderTextColor={colors.textMuted}
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={() => persistRecent(query)}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          containerStyle={styles.searchInput}
        />
        <View style={styles.searchIcon}>
          <Feather name="search" size={18} color={colors.textMuted} />
        </View>
      </View>

      <FlashList
        data={rows}
        keyExtractor={(row: SearchRow) => row.key}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        /*
          Mientras llega la respuesta nueva se siguen viendo los resultados
          anteriores con este aviso encima. Vaciar la lista en cada tecla hace
          que escribir sea un parpadeo, y esconde justo el resultado que a lo
          mejor ya estaba en pantalla.
        */
        ListHeaderComponent={
          ocupado && total > 0 ? (
            <Text variant="secondary" color={colors.textMuted} style={styles.buscando}>
              {t('search.searching')}
            </Text>
          ) : null
        }
        ListEmptyComponent={
          !buscando ? (
            <StateView
              state="empty"
              icon="search"
              title={t('search.startTitle')}
              description={t('search.startBody')}
            />
          ) : estado.fallo ? (
            <StateView
              state="error"
              title={t('search.failedTitle')}
              description={t('common.checkConnection')}
              onRetry={reintentar}
            />
          ) : debeDecirSinResultados(estado) ? (
            <StateView
              state="empty"
              icon="search"
              title={t('search.emptyTitle')}
              description={t('search.emptyBody', { termino: estado.termino })}
            />
          ) : (
            <StateView state="loading" />
          )
        }
        renderItem={({ item: row }: { item: SearchRow }) => {
          // La unica fila que es de esta pantalla y no del buscador compartido.
          if (row.kind === 'recent') {
            return (
              <ListRow
                title={row.value}
                leftIcon="clock"
                rightIcon="chevron-right"
                onPress={() => setQuery(row.value)}
              />
            );
          }
          // La cabecera de «Búsquedas recientes» lleva su propia acción y no
          // pasa por el buscador compartido, que no sabe de recientes.
          if (row.kind === 'section' && row.key === 'sec-recents') {
            return (
              <SectionTitle title={row.title} action={row.action} onActionPress={row.onAction} />
            );
          }
          return <FilaDeResultado fila={row} alAbrir={() => persistRecent(query)} />;
        }}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  searchWrapper: { position: 'relative', paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  searchInput: { paddingLeft: 30 },
  searchIcon: { position: 'absolute', left: spacing.lg + spacing.md, top: 15 },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
  buscando: { paddingVertical: spacing.sm },
});
