import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { Input } from '@/components/Input';
import { ListRow } from '@/components/ListRow';
import { SectionTitle } from '@/components/SectionTitle';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { assets } from '@/data/assets';
import { SearchRepository } from '@/repositories/SearchRepository';
import { profileImageUrl } from '@/services/storage';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { irAlPerfil } from '@/lib/irAlPerfil';
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
  type CursoDto,
  type EstadoDeBusqueda,
  type EtiquetaDto,
  type EventoDto,
  type Grupo,
  type PersonaDto,
  type PublicacionDto,
} from '@/lib/busquedaProgresiva';

const RECENTS_KEY = 'renaser-recent-searches';
const MAX_RECENTS = 6;

/** Fila de la lista aplanada (secciones + resultados en una sola FlashList). */
type SearchRow =
  | { kind: 'section'; key: string; title: string; action?: string; onAction?: () => void }
  | { kind: 'temas'; key: string; texto: string }
  | { kind: 'recent'; key: string; value: string }
  | { kind: 'person'; key: string; persona: PersonaDto }
  | { kind: 'hashtag'; key: string; etiqueta: EtiquetaDto }
  | { kind: 'post'; key: string; publicacion: PublicacionDto }
  | { kind: 'course'; key: string; curso: CursoDto }
  | { kind: 'event'; key: string; evento: EventoDto };

/** El dia y el mes de un evento, o nada si la fecha no vino o no se entiende. */
function fechaCorta(iso: string | null): string {
  if (!iso) return '';
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return '';
  return fecha.toLocaleDateString('es-PE', { day: 'numeric', month: 'short' });
}

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
 * «carpinteria». Esta pantalla solo mueve datos: pide, entrega el sello y
 * pinta.
 */
export function SearchScreen() {
  const { colors } = useAppTheme();
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
  const { resultados } = estado;

  const rows = useMemo<SearchRow[]>(() => {
    if (!buscando) {
      if (recents.length === 0) return [];
      return [
        { kind: 'section', key: 'sec-recents', title: 'Búsquedas recientes', action: 'Borrar', onAction: clearRecents },
        ...recents.map((value) => ({ kind: 'recent' as const, key: `r-${value}`, value })),
      ];
    }

    const out: SearchRow[] = [];

    /*
      Por que se dice en que temas se esta buscando: sin esta linea, encontrar
      un curso de carpinteria escribiendo «muebles» parece un fallo. Un buscador
      que acierta sin explicar por que no se lee como listo, se lee como averiado.
    */
    if (resultados.temas.length > 0) {
      out.push({
        kind: 'temas',
        key: 'temas',
        texto: `También buscamos en ${resultados.temas.map((t) => t.name).join(', ')}`,
      });
    }

    /** La cabecera de un grupo, con su «Ver más» si el backend dijo que hay más. */
    const seccion = (grupo: Grupo, titulo: string) => {
      const hayMas = resultados.siguiente[grupo] != null;
      out.push({
        kind: 'section',
        key: `sec-${grupo}`,
        title: titulo,
        action: hayMas ? (estado.ampliando === grupo ? 'Cargando…' : 'Ver más') : undefined,
        onAction: hayMas && estado.ampliando === null ? () => verMas(grupo) : undefined,
      });
    };

    if (resultados.people.length > 0) {
      seccion('people', 'Personas');
      resultados.people.forEach((persona) =>
        out.push({ kind: 'person', key: `p-${persona.id}`, persona }),
      );
    }
    /*
      Las etiquetas van DESPUES de las personas y ANTES de las publicaciones: se
      busca sobre todo a alguien, y una etiqueta es un atajo a muchas
      publicaciones, asi que ofrecerla antes que las publicaciones sueltas
      ahorra un paso.
    */
    if (resultados.hashtags.length > 0) {
      seccion('hashtags', 'Etiquetas');
      resultados.hashtags.forEach((etiqueta) =>
        out.push({ kind: 'hashtag', key: `h-${etiqueta.tag}`, etiqueta }),
      );
    }
    if (resultados.posts.length > 0) {
      seccion('posts', 'Publicaciones');
      resultados.posts.forEach((publicacion) =>
        out.push({ kind: 'post', key: `o-${publicacion.id}`, publicacion }),
      );
    }
    if (resultados.courses.length > 0) {
      seccion('courses', 'Cursos');
      resultados.courses.forEach((curso) =>
        out.push({ kind: 'course', key: `c-${curso.id}`, curso }),
      );
    }
    if (resultados.events.length > 0) {
      seccion('events', 'Eventos');
      resultados.events.forEach((evento) =>
        out.push({ kind: 'event', key: `e-${evento.id}`, evento }),
      );
    }
    return out;
    // `recents`/`clearRecents` solo afectan al modo sin búsqueda.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buscando, resultados, estado.ampliando, recents, verMas]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title="Buscar"
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/explore'))}
      />

      <View style={styles.searchWrapper}>
        <Input
          placeholder="Personas, publicaciones, cursos o eventos..."
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
              Buscando…
            </Text>
          ) : null
        }
        ListEmptyComponent={
          !buscando ? (
            <StateView
              state="empty"
              icon="search"
              title="Busca en Z"
              description="Encuentra personas, publicaciones, cursos y eventos."
            />
          ) : estado.fallo ? (
            <StateView
              state="error"
              title="No pudimos buscar"
              description="Revisa tu conexión e inténtalo de nuevo."
              onRetry={reintentar}
            />
          ) : debeDecirSinResultados(estado) ? (
            <StateView
              state="empty"
              icon="search"
              title="Sin resultados"
              description={`No encontramos nada para "${estado.termino}".`}
            />
          ) : (
            <StateView state="loading" />
          )
        }
        renderItem={({ item: row }: { item: SearchRow }) => {
          switch (row.kind) {
            case 'section':
              return (
                <SectionTitle title={row.title} action={row.action} onActionPress={row.onAction} />
              );
            case 'temas':
              return (
                <Text variant="secondary" color={colors.textMuted} style={styles.temas}>
                  {row.texto}
                </Text>
              );
            case 'recent':
              return (
                <ListRow title={row.value} leftIcon="clock" rightIcon="chevron-right" onPress={() => setQuery(row.value)} />
              );
            case 'person': {
              const avatar = profileImageUrl(row.persona.avatar_path);
              /*
                El subtitulo es el @usuario y, si no lo tiene, lo que declara
                PODER APORTAR. Nunca lo que quiere aprender: el contrato del
                backend ni siquiera trae ese dato.
              */
              const subtitulo = row.persona.username
                ? `@${row.persona.username}`
                : row.persona.offer_topics.join(' · ') || row.persona.bio;
              return (
                <ListRow
                  title={row.persona.full_name}
                  subtitle={subtitulo || undefined}
                  leftComponent={
                    <ExpoImage
                      source={avatar ? { uri: avatar } : assets.avatar}
                      style={styles.avatar}
                      contentFit="cover"
                      cachePolicy="memory-disk"
                    />
                  }
                  rightIcon="chevron-right"
                  onPress={() => {
                    persistRecent(query);
                    irAlPerfil(router, row.persona.id);
                  }}
                />
              );
            }
            case 'hashtag':
              return (
                <ListRow
                  title={`#${row.etiqueta.display_tag}`}
                  // La cuenta la da el servidor y es la REAL (solo publicado).
                  // El plural se escribe entero: «1 publicaciones» se lee mal.
                  subtitle={
                    row.etiqueta.posts_count === 1
                      ? '1 publicación'
                      : `${row.etiqueta.posts_count} publicaciones`
                  }
                  leftIcon="hash"
                  rightIcon="chevron-right"
                  onPress={() => {
                    persistRecent(query);
                    // Se navega con la forma NORMALIZADA (`tag`), que es la que
                    // de verdad existe: `display_tag` es solo para pintar.
                    router.push(`/hashtag/${encodeURIComponent(row.etiqueta.tag)}` as never);
                  }}
                />
              );
            case 'post':
              return (
                <Pressable
                  onPress={() => {
                    persistRecent(query);
                    router.push(`/post/${row.publicacion.id}` as never);
                  }}
                  style={({ pressed }) => [styles.postRow, { borderBottomColor: colors.border, opacity: pressed ? 0.75 : 1 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Ver publicación de ${row.publicacion.author_name}`}
                >
                  <Text variant="secondary" weight="700">{row.publicacion.author_name}</Text>
                  <Text variant="body" color={colors.textMuted} numberOfLines={2}>{row.publicacion.body}</Text>
                </Pressable>
              );
            case 'course':
              return (
                <ListRow
                  title={row.curso.title}
                  subtitle={
                    row.curso.coming_soon
                      ? 'Próximamente'
                      : row.curso.subtitle || row.curso.author_name || 'Programa'
                  }
                  leftIcon="book"
                  rightIcon="chevron-right"
                  onPress={() => {
                    persistRecent(query);
                    router.push(`/course/${row.curso.id}` as never);
                  }}
                />
              );
            case 'event': {
              const cuando = fechaCorta(row.evento.starts_at);
              const donde = row.evento.location ?? '';
              return (
                <ListRow
                  title={row.evento.title}
                  subtitle={[cuando, donde].filter(Boolean).join(' · ') || undefined}
                  leftIcon="calendar"
                  rightIcon="chevron-right"
                  onPress={() => {
                    persistRecent(query);
                    router.push('/events' as never);
                  }}
                />
              );
            }
          }
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  searchWrapper: { position: 'relative', paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  searchInput: { paddingLeft: 30 },
  searchIcon: { position: 'absolute', left: spacing.lg + spacing.md, top: 15 },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
  avatar: { width: 40, height: 40, borderRadius: 20 },
  postRow: { paddingVertical: spacing.md, borderBottomWidth: 1, gap: 4 },
  temas: { marginBottom: spacing.sm },
  buscando: { paddingVertical: spacing.sm },
});
