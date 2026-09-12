import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Avatar } from '@/components/Avatar';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import { irAlPerfil } from '@/lib/irAlPerfil';
import { toast } from '@/lib/toast';
import {
  CLAVE_SIN_PRECIO,
  catalogoDisponible,
  claveDeConfianza,
  claveDeErrorDeProductos,
  claveDeErrorPorEstado,
  claveDelBloquePersonal,
  claveDelCuerpoDelBloquePersonal,
  contadorDeLaBolsa,
  conGuardado,
  esFaltaDeSesion,
  esGuardadosApagado,
  esProductosApagado,
  indicadorDeConfianza,
  portadaVacia,
  precioDeLaTarjeta,
  sePuedeMostrarLaImagen,
  textoDelManifiesto,
  type Portada,
  type TarjetaDeProducto,
} from '@/lib/productos';
import { ProductCatalogRepository } from '@/repositories/ProductCatalogRepository';
import { pedirPerfil } from '@/services/cachePerfil';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError, haySesion } from '@/services/api';

/** Traduce una clave que viene calculada del módulo de lógica. */
export function useClaveDeProductos() {
  const { t } = useTranslation();
  return useCallback(
    (clave: string, params?: Record<string, string | number>) =>
      t(clave as TranslationKey, params),
    [t],
  );
}

type TarjetaProps = {
  tarjeta: TarjetaDeProducto;
  onAbrir: (productoId: string) => void;
  onGuardar?: (tarjeta: TarjetaDeProducto) => void;
  ocupado?: boolean;
};

/**
 * Una tarjeta de producto en una lista (§3.1), a media fila.
 *
 * VIVE AQUÍ y la usan las cuatro pantallas de Productos, en vez de copiarse
 * cuatro veces: la regla de qué se enseña —precio o «sin configurar», UN solo
 * indicador de confianza y nada más— tiene que estar escrita una vez. Cuatro
 * copias son cuatro sitios donde alguien añade «4,8 ★» y solo se nota en uno.
 *
 * EL RÓTULO «APROBADO POR Z» NO ES UN ADORNO NI UNA SUPOSICIÓN: publicar exige
 * una evaluación aprobada con sus tres razones (`service.publicar`), y el
 * catálogo solo devuelve lo publicado. Todo lo que llega aquí pasó por ahí.
 *
 * EL INDICADOR DE CONFIANZA ES UNO Y ES EL ORIGEN. En la referencia visual hay
 * «98 % lo recomienda» y «Garantía 3 años»: el primero necesita reseñas y el
 * segundo condiciones de garantía aprobadas, y no existe ninguna de las dos
 * cosas. Se pinta lo que manda el contrato (`trust: 'origin'`) o no se pinta.
 *
 * SIN BOTÓN DE COMPRAR. Lo único que se ofrece es abrirla y guardarla —el
 * corazón—, y guardar NO RESERVA NADA: no es un carrito.
 */
export function TarjetaDeProductoEnLista({
  tarjeta,
  onAbrir,
  onGuardar,
  ocupado = false,
}: TarjetaProps) {
  const { colors } = useAppTheme();
  const f = useClaveDeProductos();
  const precio = precioDeLaTarjeta(tarjeta);
  const confianza = indicadorDeConfianza(tarjeta);
  const claveConfianza = confianza !== null ? claveDeConfianza(confianza.clase) : null;

  return (
    <View style={styles.tarjeta}>
      <Pressable
        onPress={() => onAbrir(tarjeta.product_id)}
        accessibilityRole="button"
        accessibilityLabel={tarjeta.name}
        style={styles.tarjetaCuerpo}
      >
        {/* La imagen no se puede firmar todavía: se dice, no se finge. */}
        <View
          style={[
            styles.miniatura,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          {sePuedeMostrarLaImagen(tarjeta.image_path) ? null : (
            <Feather name="image" size={22} color={colors.textMuted} />
          )}
        </View>
        <Text variant="caption" color={colors.textMuted} style={styles.rotulo}>
          {f('productos.aprobadoPorZ')}
        </Text>
        <Text variant="secondary" weight="700" numberOfLines={2}>
          {tarjeta.name}
        </Text>
        <Text variant="caption" color={colors.textMuted} numberOfLines={1}>
          {tarjeta.seller_name}
        </Text>
        <Text variant="titleMedium">
          {precio.configurado ? precio.texto : f(CLAVE_SIN_PRECIO)}
        </Text>
        {/* UNA SOLA LÍNEA DE CONFIANZA, con el icono de lo que de verdad es. */}
        {claveConfianza !== null && confianza !== null ? (
          <View style={styles.confianza}>
            <Feather name="map-pin" size={12} color={colors.textMuted} />
            <Text variant="caption" color={colors.textMuted} numberOfLines={1}>
              {f(claveConfianza, { valor: confianza.valor })}
            </Text>
          </View>
        ) : null}
      </Pressable>

      {/* El corazón, sobre la imagen y en su círculo, como la referencia. */}
      {onGuardar ? (
        <Pressable
          onPress={() => onGuardar(tarjeta)}
          disabled={ocupado}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityState={{ selected: tarjeta.saved }}
          accessibilityLabel={f(
            tarjeta.saved ? 'productos.accion.quitar' : 'productos.accion.guardar',
          )}
          style={[styles.corazon, { backgroundColor: colors.background, borderColor: colors.border }]}
        >
          {/* La FORMA cambia, no solo el color: guardado se ve sin distinguir
              tonos. */}
          <Feather
            name={tarjeta.saved ? 'check' : 'heart'}
            size={16}
            color={tarjeta.saved ? colors.primary : colors.text}
          />
        </Pressable>
      ) : null}
    </View>
  );
}

/** Una cuadrícula de tarjetas. DOS COLUMNAS COMO MÁXIMO (§3). */
export function CuadriculaDeProductos({
  tarjetas,
  onAbrir,
  onGuardar,
  ocupado,
}: {
  tarjetas: TarjetaDeProducto[];
  onAbrir: (productoId: string) => void;
  onGuardar?: (tarjeta: TarjetaDeProducto) => void;
  ocupado?: boolean;
}) {
  return (
    <View style={styles.cuadricula}>
      {tarjetas.map((tarjeta) => (
        <View key={tarjeta.product_id} style={styles.celda}>
          <TarjetaDeProductoEnLista
            tarjeta={tarjeta}
            onAbrir={onAbrir}
            onGuardar={onGuardar}
            ocupado={ocupado}
          />
        </View>
      ))}
    </View>
  );
}

/**
 * La portada de Productos Z (blueprint §3).
 *
 * EL MANIFIESTO ES TEXTO —centrado y pequeño, como en la referencia—, no un
 * banner: «No está todo. Está lo que merece estar.» es una promesa, y una
 * promesa se lee. Lo manda el servidor en `manifest` y se enseña tal cual.
 *
 * «SELECCIÓN Z» NO ES UNA LISTA A DEDO. Viene ordenada por la puntuación de la
 * evaluación aprobada, que es un dato verificado. En la referencia ese bloque
 * lleva además un TÍTULO EDITORIAL grande sobre una imagen; ese texto NO EXISTE
 * en el contrato —el servidor no manda ningún titular de la selección— así que
 * aquí va el rótulo y las tarjetas, y el titular queda pendiente de un campo y
 * de una decisión editorial.
 *
 * EL SEGUNDO BLOQUE SE LLAMA «NUEVOS EN Z», y no «Elegidos para ti» como en la
 * referencia, porque el contrato manda `personalized: false`: no hay
 * recomendador de productos y llamar «para ti» a lo más reciente sería mentir
 * con el título. El día que exista, el servidor dirá `true` y el título
 * cambiará solo.
 *
 * LA BOLSA LLEVA A LOS GUARDADOS, no a un carrito, y su contador aparece SOLO
 * cuando hay uno o más: un «0» colgando del icono parece un error.
 *
 * LA FOTO DE CADA CREADOR NO VIENE EN `CreadorRead`, pero sí su `profile_id`:
 * se resuelve con la caché de perfiles que ya usa el resto de la aplicación, y
 * quien no tenga foto sale con su inicial. Ninguna imagen inventada.
 *
 * `disponible: false` NO ES «no hay productos»: son las migraciones de
 * Productos sin aplicar en esta base. Se dice con esas palabras y sin pintar
 * una lista vacía que haría pensar que Z no tiene nada.
 */
export function ProductosScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();

  const [portada, setPortada] = useState<Portada | null>(null);
  const [contador, setContador] = useState<number | null>(null);
  const [fotos, setFotos] = useState<Record<string, string>>({});
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<'red' | 'sinConexion' | 'noDisponible' | null>(null);
  const ocupadoRef = useRef(false);
  const [ocupado, setOcupado] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      const leida = await ProductCatalogRepository.portada();
      setPortada(leida);
      // LAS FOTOS DE LOS CREADORES, de la caché de perfiles. Como mucho ocho
      // —lo que trae el bloque—, y quien falle se queda con su inicial.
      void (async () => {
        const encontradas: Record<string, string> = {};
        await Promise.allSettled(
          leida.creadores.map(async (creador) => {
            const perfil = await pedirPerfil(creador.profile_id);
            if (perfil.avatarUrl) encontradas[creador.profile_id] = perfil.avatarUrl;
          }),
        );
        setFotos((actuales) => ({ ...actuales, ...encontradas }));
      })();
      // EL CONTADOR SOLO CON SESIÓN. `GET /products/saved` exige entrar, y
      // pedirlo sin sesión dejaría un 401 en el registro cada vez que alguien
      // abre el catálogo desde fuera.
      if (await haySesion()) {
        try {
          setContador(contadorDeLaBolsa((await ProductCatalogRepository.guardados()).length));
        } catch {
          // Sin contador se sigue entrando a la bolsa: no es un error de la
          // portada y no se cuenta como tal.
          setContador(null);
        }
      } else {
        setContador(null);
      }
    } catch (error) {
      if (error instanceof ApiError && esProductosApagado(error.code)) {
        setFallo('noDisponible');
      } else if (error instanceof ApiError && esFalloDeRed(error.code)) {
        setFallo('sinConexion');
      } else {
        setFallo('red');
      }
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const textoDelError = (error: unknown) => {
    if (error instanceof ApiError) {
      const porCodigo = claveDeErrorDeProductos(error.code);
      if (porCodigo !== null) return f(porCodigo);
      const porEstado = claveDeErrorPorEstado(error.status);
      if (porEstado !== null) return f(porEstado);
    }
    return error instanceof Error && error.message.trim() !== ''
      ? error.message
      : t('common.tryAgain');
  };

  /** Guardar o quitar. El cerrojo se cierra ANTES del primer await. */
  const alternarGuardado = (tarjeta: TarjetaDeProducto) => {
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    setOcupado(true);
    void (async () => {
      try {
        const resultado = tarjeta.saved
          ? await ProductCatalogRepository.quitar(tarjeta.product_id)
          : await ProductCatalogRepository.guardar(tarjeta.product_id);
        setContador(contadorDeLaBolsa(resultado.count));
        setPortada((actual) =>
          actual === null
            ? actual
            : {
                ...actual,
                seleccion: conGuardado(actual.seleccion, tarjeta.product_id, resultado.saved),
                para_ti: conGuardado(actual.para_ti, tarjeta.product_id, resultado.saved),
              },
        );
        toast(f(resultado.saved ? 'productos.guardado' : 'productos.quitado'));
      } catch (error) {
        if (error instanceof ApiError && esFaltaDeSesion(error.status)) {
          notify(f('productos.error.sinSesion'), f('productos.error.sinSesionCuerpo'));
        } else if (error instanceof ApiError && esGuardadosApagado(error.code)) {
          notify(
            f('productos.error.guardadosNoDisponibles'),
            f('productos.error.guardadosNoDisponiblesCuerpo'),
          );
        } else {
          notify(f('productos.noSePudo'), textoDelError(error));
        }
      } finally {
        ocupadoRef.current = false;
        setOcupado(false);
      }
    })();
  };

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const abrir = (productoId: string) => router.push(`/productos/${productoId}` as never);
  const irALaBolsa = () => router.push('/productos/guardados' as never);
  const irAlBuscador = () => router.push('/productos/buscar' as never);

  const encabezado = (
    <AppHeader
      title={f('productos.titulo')}
      onBack={volver}
      rightIcon="shopping-bag"
      onRightPress={irALaBolsa}
      rightBadge={contador !== null}
    />
  );

  /** Un título de sección con su enlace a la derecha, como la referencia. */
  const seccion = (titulo: string, alPulsar?: () => void) => (
    <View style={styles.linea}>
      <Text variant="titleMedium">{titulo}</Text>
      {alPulsar ? (
        <Pressable
          onPress={alPulsar}
          accessibilityRole="button"
          accessibilityLabel={f('productos.verTodo')}
          hitSlop={8}
          style={styles.verTodo}
        >
          <Text variant="caption" weight="700">
            {f('productos.verTodo')}
          </Text>
          <Feather name="chevron-right" size={14} color={colors.text} />
        </Pressable>
      ) : null}
    </View>
  );

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || portada === null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        {fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            icon="clock"
            title={f('productos.noDisponible')}
            description={f('productos.noDisponibleCuerpo')}
          />
        ) : (
          <StateView
            state={fallo === 'sinConexion' ? 'offline' : 'error'}
            description={fallo === 'sinConexion' ? undefined : t('common.loadFailed')}
            onRetry={() => void cargar()}
          />
        )}
      </AppScreen>
    );
  }

  return (
    <AppScreen contentStyle={styles.contenido}>
      {encabezado}

      {/* El contador de la bolsa: SOLO si hay algo guardado. */}
      {contador !== null ? (
        <Pressable
          onPress={irALaBolsa}
          accessibilityRole="button"
          accessibilityLabel={f('productos.bolsaContador', { n: contador })}
          style={({ pressed }) => [
            styles.bolsa,
            { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Feather name="heart" size={14} color={colors.text} />
          <Text variant="caption" weight="700">
            {f('productos.bolsaContador', { n: contador })}
          </Text>
        </Pressable>
      ) : null}

      {/* El buscador. Lo que filtra lo filtra el servidor, en su pantalla. */}
      <Pressable
        onPress={irAlBuscador}
        accessibilityRole="button"
        accessibilityLabel={f('productos.buscador')}
        style={({ pressed }) => [
          styles.buscador,
          { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <Feather name="search" size={16} color={colors.textMuted} />
        <Text variant="caption" color={colors.textMuted}>
          {f('productos.buscador')}
        </Text>
      </Pressable>

      {/* EL MANIFIESTO, COMO TEXTO: centrado, gris y pequeño. */}
      <Text variant="caption" color={colors.textMuted} style={styles.manifiesto}>
        {textoDelManifiesto(portada)}
      </Text>

      {!catalogoDisponible(portada) ? (
        <StateView
          state="empty"
          icon="clock"
          title={f('productos.noDisponible')}
          description={f('productos.noDisponibleCuerpo')}
        />
      ) : portadaVacia(portada) ? (
        <StateView
          state="empty"
          icon="package"
          title={f('productos.vacio')}
          description={f('productos.vacioCuerpo')}
          onRetry={() => void cargar()}
        />
      ) : (
        <>
          {portada.seleccion.length > 0 ? (
            <>
              {/* El rótulo en versalitas. SIN titular editorial: no existe. */}
              <Text variant="caption" color={colors.textMuted} style={styles.rotulo}>
                {f('productos.seleccion')}
              </Text>
              <Text variant="caption" color={colors.textMuted}>
                {f('productos.seleccionCuerpo')}
              </Text>
              <CuadriculaDeProductos
                tarjetas={portada.seleccion}
                onAbrir={abrir}
                onGuardar={alternarGuardado}
                ocupado={ocupado}
              />
            </>
          ) : null}

          {/* EL TÍTULO HONESTO: `personalized: false` es «Nuevos en Z». */}
          {portada.para_ti.length > 0 ? (
            <>
              {seccion(f(claveDelBloquePersonal(portada.personalized)), irAlBuscador)}
              <Text variant="caption" color={colors.textMuted}>
                {f(claveDelCuerpoDelBloquePersonal(portada.personalized))}
              </Text>
              <CuadriculaDeProductos
                tarjetas={portada.para_ti}
                onAbrir={abrir}
                onGuardar={alternarGuardado}
                ocupado={ocupado}
              />
            </>
          ) : null}

          {portada.creadores.length > 0 ? (
            <>
              {seccion(f('productos.creadores'), irAlBuscador)}
              <Text variant="caption" color={colors.textMuted}>
                {f('productos.creadoresCuerpo')}
              </Text>
              {portada.creadores.map((creador) => (
                <Pressable
                  key={creador.seller_id}
                  onPress={() => irAlPerfil(router, creador.profile_id)}
                  accessibilityRole="button"
                  accessibilityLabel={creador.name}
                  style={({ pressed }) => [
                    styles.creador,
                    { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
                  ]}
                >
                  <Avatar
                    size={48}
                    image={fotos[creador.profile_id] ?? null}
                    name={creador.name}
                  />
                  <View style={styles.creadorTexto}>
                    <Text variant="secondary" weight="700" numberOfLines={1}>
                      {creador.name}
                    </Text>
                    <Text variant="caption" color={colors.textMuted} numberOfLines={2}>
                      {creador.proposal ?? f('productos.sinPropuesta')}
                    </Text>
                  </View>
                  <Feather name="chevron-right" size={16} color={colors.textMuted} />
                </Pressable>
              ))}
            </>
          ) : null}
        </>
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  cuadricula: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  // DOS COLUMNAS COMO MÁXIMO (§3): media fila menos el hueco del medio.
  celda: { flexBasis: '47%', flexGrow: 1, maxWidth: '50%' },
  tarjeta: { gap: spacing.xs },
  tarjetaCuerpo: { gap: spacing.xs },
  miniatura: {
    // Cuadrada, como la referencia.
    aspectRatio: 1,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Versalitas pequeñas: el rótulo acompaña, no compite con el nombre.
  rotulo: { textTransform: 'uppercase', letterSpacing: 1.1, fontSize: 10 },
  confianza: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  corazon: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  linea: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    minHeight: 44,
  },
  verTodo: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 44, paddingLeft: spacing.sm },
  manifiesto: { textAlign: 'center' },
  bolsa: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    minHeight: 32,
  },
  buscador: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    minHeight: 44,
  },
  creador: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  creadorTexto: { flex: 1, gap: spacing.xs },
});
