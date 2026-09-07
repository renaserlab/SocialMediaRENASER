import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { Avatar } from '@/components/Avatar';
import { Chip } from '@/components/Chip';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { irAlPerfil } from '@/lib/irAlPerfil';
import { notify } from '@/lib/confirm';
import { MessageRepository } from '@/repositories/MessageRepository';
import {
  OwnerRepository,
  type AlumnoDelCurso,
  type FiltroDeAlumnos,
} from '@/repositories/OwnerRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

import { esProhibido, useTextosDeGestion } from '@/screens/GestionDeCursoScreen';

/**
 * Quién está dentro de un curso, para quien lo creó.
 *
 * SE PAGINA DE VERDAD. Un curso con dos mil inscritos no cabe en una respuesta
 * ni en una lista pintada de golpe: se piden veinte, se pintan veinte y el
 * resto llega al bajar (o pulsando, para quien no llegue al final con el dedo).
 *
 * LA BÚSQUEDA Y LOS FILTROS VIAJAN AL SERVIDOR, no se aplican sobre lo ya
 * descargado: filtrar aquí solo escondería filas de la primera página y diría
 * «nadie coincide» sobre una lista que ni siquiera está entera.
 *
 * MENSAJE REUTILIZA LA MENSAJERÍA QUE YA HAY: `getOrCreateDirect` y la pantalla
 * `/chat/[id]`, exactamente como el perfil y las historias. Aquí no se escribe
 * ningún chat nuevo.
 */

const POR_PAGINA = 20;

/** Los filtros de la barra. `null` es «todos» y no manda parámetro. */
const FILTROS: ReadonlyArray<{ valor: FiltroDeAlumnos | null; clave: string }> = [
  { valor: null, clave: 'alumnos.todos' },
  { valor: 'not_started', clave: 'alumnos.estado.not_started' },
  { valor: 'in_progress', clave: 'alumnos.estado.in_progress' },
  { valor: 'completed', clave: 'alumnos.estado.completed' },
  { valor: 'revoked', clave: 'alumnos.estado.revoked' },
];

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

export function EstudiantesDelCursoScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const t = useTextosDeGestion();
  const { id } = useLocalSearchParams<{ id: string }>();
  const courseId = typeof id === 'string' ? id : '';

  const [alumnos, setAlumnos] = useState<AlumnoDelCurso[]>([]);
  const [texto, setTexto] = useState('');
  /** Lo que de verdad se manda: el texto reposado, para no pedir por letra. */
  const [busqueda, setBusqueda] = useState('');
  const [filtro, setFiltro] = useState<FiltroDeAlumnos | null>(null);
  const [cargando, setCargando] = useState(true);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [hayMas, setHayMas] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prohibido, setProhibido] = useState(false);
  /** A quién se le está abriendo el chat. También es el cerrojo del doble toque. */
  const [abriendoChat, setAbriendoChat] = useState<string | null>(null);
  const chatRef = useRef(false);
  /** Cerrojo de la página siguiente: `onEndReached` se dispara varias veces. */
  const masRef = useRef(false);
  /**
   * La ULTIMA pagina pedida no llego.
   *
   * Antes esto apagaba `hayMas` y no se decia nada: la lista quedaba truncada
   * con el mismo aspecto que una lista completa, asi que se leia como «ya no
   * hay mas» cuando lo que habia era un fallo de red. En una bandeja de
   * expedientes o en un listado de ventas eso es dar por vistas cosas que no se
   * han visto. Ahora se avisa en el pie y se puede reintentar la misma pagina.
   */
  const [falloAlPaginar, setFalloAlPaginar] = useState(false);


  useEffect(() => {
    const temporizador = setTimeout(() => setBusqueda(texto.trim()), 350);
    return () => clearTimeout(temporizador);
  }, [texto]);

  const cargar = useCallback(async () => {
    if (!courseId) return;
    setCargando(true);
    // Recargar de cero borra el fallo de la pagina anterior: se vuelve a
    // empezar y ese error ya no describe nada.
    setFalloAlPaginar(false);
    setError(null);
    setProhibido(false);
    try {
      const pagina = await OwnerRepository.estudiantes(courseId, {
        limit: POR_PAGINA,
        offset: 0,
        q: busqueda || undefined,
        state: filtro,
      });
      setAlumnos(pagina);
      setHayMas(pagina.length === POR_PAGINA);
    } catch (e) {
      if (esProhibido(e)) setProhibido(true);
      else setError(e instanceof Error ? e.message : t('common.loadFailed'));
      setAlumnos([]);
      setHayMas(false);
    } finally {
      setCargando(false);
    }
  }, [courseId, busqueda, filtro, t]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const cargarMas = useCallback(async () => {
    if (masRef.current || !hayMas || cargando || !courseId) return;
    masRef.current = true;
    setCargandoMas(true);
    try {
      const pagina = await OwnerRepository.estudiantes(courseId, {
        limit: POR_PAGINA,
        offset: alumnos.length,
        q: busqueda || undefined,
        state: filtro,
      });
      // Por id: si alguien se inscribe entre dos páginas, el desplazamiento
      // devolvería una fila repetida y React se quejaría de la clave.
      setAlumnos((previos) => {
        const vistos = new Set(previos.map((a) => a.id));
        return [...previos, ...pagina.filter((a) => !vistos.has(a.id))];
      });
      setHayMas(pagina.length === POR_PAGINA);
      setFalloAlPaginar(false);
    } catch {
      // Una página que no llega no borra las que ya se leen NI cierra la lista:
      // `hayMas` se queda como estaba para que el reintento pida la misma.
      setFalloAlPaginar(true);
    } finally {
      masRef.current = false;
      setCargandoMas(false);
    }
  }, [alumnos.length, busqueda, cargando, courseId, filtro, hayMas]);

  const escribirA = useCallback(
    async (alumno: AlumnoDelCurso) => {
      // El cerrojo se mira ANTES de pedir nada: dos toques seguidos creaban dos
      // conversaciones (el mismo fallo ya corregido en el perfil).
      if (chatRef.current) return;
      chatRef.current = true;
      setAbriendoChat(alumno.id);
      try {
        const conversacion = await MessageRepository.getOrCreateDirect(alumno.id);
        router.push({
          pathname: '/chat/[id]',
          params: { id: conversacion.id, name: alumno.fullName },
        } as never);
      } catch {
        notify(t('alumnos.mensajeFallo'), t('common.tryAgain'));
      } finally {
        chatRef.current = false;
        setAbriendoChat(null);
      }
    },
    [router, t],
  );

  const cabecera = (
    <AppHeader
      title={t('alumnos.titulo')}
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
    />
  );

  const filtros = (
    <View style={styles.cabecera}>
      <Input
        value={texto}
        onChangeText={setTexto}
        placeholder={t('alumnos.buscar')}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
      />
      {/*
        ELECCION UNICA: `radio` y no `checkbox`, y la barra entera es un
        `radiogroup`. Elegir un filtro apaga el anterior, y anunciarlos como
        casillas hacia creer que se podian acumular.
      */}
      <View style={styles.chips} accessibilityRole="radiogroup">
        {FILTROS.map((opcion) => (
          <Chip
            key={opcion.clave}
            rol="radio"
            label={t(opcion.clave)}
            selected={filtro === opcion.valor}
            onPress={() => setFiltro(opcion.valor)}
          />
        ))}
      </View>
    </View>
  );

  if (prohibido) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {cabecera}
        <StateView state="empty" icon="lock" description={t('gestion.sinPermiso')} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {cabecera}
      <FlatList
        data={alumnos}
        keyExtractor={(alumno) => alumno.id}
        ListHeaderComponent={filtros}
        contentContainerStyle={styles.lista}
        keyboardShouldPersistTaps="handled"
        onEndReachedThreshold={0.4}
        onEndReached={() => void cargarMas()}
        renderItem={({ item }) => (
          <FilaDeAlumno
            alumno={item}
            t={t}
            ocupado={abriendoChat !== null}
            escribiendo={abriendoChat === item.id}
            onPerfil={() => irAlPerfil(router, item.id)}
            onMensaje={() => void escribirA(item)}
          />
        )}
        ListEmptyComponent={
          cargando ? (
            <StateView state="loading" />
          ) : error ? (
            <StateView state="error" description={error} onRetry={() => void cargar()} />
          ) : busqueda || filtro ? (
            <StateView state="empty" icon="search" description={t('alumnos.sinResultados')} />
          ) : (
            <StateView
              state="empty"
              icon="users"
              title={t('alumnos.vacioTitulo')}
              description={t('alumnos.vacioCuerpo')}
            />
          )
        }
        ListFooterComponent={
          cargandoMas ? (
            <ActivityIndicator style={styles.pie} color={colors.textMuted} />
          ) : falloAlPaginar ? (
            <Pressable
              onPress={() => void cargarMas()}
              accessibilityRole="button"
              accessibilityLabel={t('common.retry')}
              style={styles.pie}
            >
              <Text style={[styles.cargarMas, { color: colors.danger }]}>
                {t('common.loadMoreFailed')}
              </Text>
            </Pressable>
          ) : hayMas ? (
            // Botón ADEMÁS del desplazamiento: en web y con listas cortas el
            // final no siempre se alcanza arrastrando.
            <Pressable
              onPress={() => void cargarMas()}
              accessibilityRole="button"
              accessibilityLabel={t('alumnos.cargarMas')}
              style={styles.pie}
            >
              <Text style={[styles.cargarMas, { color: colors.text }]}>
                {t('alumnos.cargarMas')}
              </Text>
            </Pressable>
          ) : null
        }
      />
    </View>
  );
}

function FilaDeAlumno({
  alumno,
  t,
  ocupado,
  escribiendo,
  onPerfil,
  onMensaje,
}: {
  alumno: AlumnoDelCurso;
  t: (clave: string, params?: Record<string, string | number>) => string;
  ocupado: boolean;
  escribiendo: boolean;
  onPerfil: () => void;
  onMensaje: () => void;
}) {
  const { colors } = useAppTheme();
  return (
    <View style={[styles.fila, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <View style={styles.filaSuperior}>
        {/* Avatar y nombre abren el perfil. Un solo pulsable para los dos: en
            web cada Pressable es un <button> y anidarlos rompe la hidratación. */}
        <Pressable
          onPress={onPerfil}
          accessibilityRole="button"
          accessibilityLabel={alumno.fullName || alumno.username}
          style={styles.persona}
        >
          <Avatar size={40} image={alumno.avatarUrl ?? null} name={alumno.fullName} />
          <View style={styles.personaTextos}>
            <Text style={[styles.nombre, { color: colors.text }]} numberOfLines={1}>
              {alumno.fullName || alumno.username}
            </Text>
            {alumno.username ? (
              <Text style={[styles.dato, { color: colors.textMuted }]} numberOfLines={1}>
                {`@${alumno.username}`}
              </Text>
            ) : null}
          </View>
        </Pressable>

        <Pressable
          onPress={onMensaje}
          disabled={ocupado}
          accessibilityRole="button"
          accessibilityLabel={t('alumnos.mensaje')}
          accessibilityState={{ disabled: ocupado }}
          style={[styles.mensaje, { borderColor: colors.border, opacity: ocupado ? 0.5 : 1 }]}
        >
          {escribiendo ? (
            <ActivityIndicator size="small" color={colors.text} />
          ) : (
            <React.Fragment>
              <Feather name="message-circle" size={14} color={colors.text} />
              <Text style={[styles.mensajeTexto, { color: colors.text }]}>
                {t('alumnos.mensaje')}
              </Text>
            </React.Fragment>
          )}
        </Pressable>
      </View>

      <Text style={[styles.dato, { color: colors.textMuted }]}>
        {t('alumnos.progreso', {
          hechas: alumno.lessonsCompleted,
          total: alumno.lessonsTotal,
          porcentaje: alumno.progressPercent,
        })}
      </Text>
      {alumno.enrolledAt ? (
        <Text style={[styles.dato, { color: colors.textMuted }]}>
          {t('alumnos.inscritoEl', { fecha: fechaLegible(alumno.enrolledAt) })}
        </Text>
      ) : null}

      <View style={styles.etiquetas}>
        <Etiqueta texto={t(`alumnos.estado.${alumno.state}`)} />
        <Etiqueta texto={t(`alumnos.origen.${alumno.source}`)} />
      </View>
      {alumno.accessState === 'revoked' ? (
        <Text style={[styles.dato, { color: colors.textMuted }]}>{t('alumnos.sinAcceso')}</Text>
      ) : null}
    </View>
  );
}

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
  cabecera: { gap: spacing.sm, marginBottom: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  fila: { borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.xs },
  filaSuperior: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  persona: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  personaTextos: { flex: 1, gap: 2 },
  nombre: { fontSize: 15, fontWeight: '800' },
  dato: { fontSize: 12 },
  mensaje: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minWidth: 44,
    justifyContent: 'center',
  },
  mensajeTexto: { fontSize: 12, fontWeight: '700' },
  etiquetas: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
  etiqueta: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 3,
  },
  etiquetaTexto: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  pie: { paddingVertical: spacing.lg, alignItems: 'center' },
  cargarMas: { fontSize: 13, fontWeight: '700' },
});
