import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import { irAlPerfil } from '@/lib/irAlPerfil';
import { SinCambioDeSeccion } from '@/navigation/tabSwipe';
import { toast } from '@/lib/toast';
import {
  BLOQUES_DE_LA_FICHA,
  CLAVE_SIN_PRECIO,
  claveDeAccion,
  claveDeDimension,
  claveDeErrorDeProductos,
  claveDeErrorPorEstado,
  claveDeTipoDeEvidencia,
  claveDelBloque,
  claveDelBloqueFuera,
  deltaDeLaVariante,
  esFaltaDeSesion,
  esGuardadosApagado,
  esProductosApagado,
  etiquetaDeVersion,
  huellaCorta,
  iconoDeLaDimension,
  momentoLegible,
  opcionesDeLaVariante,
  partesDelSello,
  posicionEnLaGaleria,
  precioLegible,
  razonesOrdenadas,
  seDejaFuera,
  selloAbreInforme,
  sePuedeMostrarLaImagen,
  type BloqueDeLaFicha,
  type Ficha,
} from '@/lib/productos';
import { ProductCatalogRepository } from '@/repositories/ProductCatalogRepository';
import { CuadriculaDeProductos, useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * La ficha de un producto, EN EL ORDEN INALTERABLE del blueprint §4.
 *
 * El orden lo recorre `BLOQUES_DE_LA_FICHA`, no el JSX suelto: así reordenar
 * algo exige cambiar la lista del módulo —y la prueba que la compara con este
 * fichero—. En el JSX a mano, el orden se rompe en el primer arreglo de
 * maquetación y nadie se entera.
 *
 * LOS BLOQUES SIN DATOS SE DEJAN FUERA, CON UN ESTADO HONESTO. Tres de ellos
 * hoy siempre: no hay reseñas de productos (`rating: null`), no hay compra
 * física (`purchasable: false`) y no hay condiciones de entrega ni de
 * devolución aprobadas (`delivery: null`). Se dice en una línea corta y
 * verdadera; rellenarlos con «4,8 ★», «llega en 3-5 días» o «30 días para
 * devolver» sería inventarse lo que la empresa todavía no ha decidido.
 *
 * NINGÚN BOTÓN QUE PROMETA COMPRAR. No hay carrito ni checkout en la API, y la
 * barra fija de abajo lleva lo único que se puede hacer de verdad: guardar
 * —que NO reserva nada— y abrir el informe.
 *
 * EL SELLO LO ESCRIBE EL SERVIDOR (`seal`) y ABRE EL INFORME. Un sello que no
 * se puede comprobar es un adorno, así que cuando no hay informe —la admisión
 * no está desplegada— se lee, pero no es un botón.
 *
 * LAS RAZONES VAN CON SU EVIDENCIA. De qué sale cada una es lo único que la
 * distingue de una frase escrita a mano.
 */
export function ProductoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();
  const { productId } = useLocalSearchParams<{ productId: string }>();

  const [ficha, setFicha] = useState<Ficha | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'noDisponible' | 'noEncontrado' | null
  >(null);
  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);
  /** Qué imagen de la galería se está viendo. El contador cuenta ESTO. */
  const [enLaGaleria, setEnLaGaleria] = useState(0);

  const cargar = useCallback(async () => {
    if (!productId) return;
    setCargando(true);
    setFallo(null);
    try {
      setFicha(await ProductCatalogRepository.ficha(productId));
    } catch (error) {
      if (error instanceof ApiError && esProductosApagado(error.code)) setFallo('noDisponible');
      else if (error instanceof ApiError && error.status === 404) setFallo('noEncontrado');
      else if (error instanceof ApiError && esFalloDeRed(error.code)) setFallo('sinConexion');
      else setFallo('red');
    } finally {
      setCargando(false);
    }
  }, [productId]);

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
  const alternarGuardado = () => {
    if (ficha === null || ocupadoRef.current) return;
    const actual = ficha;
    ocupadoRef.current = true;
    setOcupado(true);
    void (async () => {
      try {
        const resultado = actual.saved
          ? await ProductCatalogRepository.quitar(actual.product_id)
          : await ProductCatalogRepository.guardar(actual.product_id);
        setFicha((leida) => (leida === null ? leida : { ...leida, saved: resultado.saved }));
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

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/productos' as never));
  const abrirInforme = () =>
    router.push(`/productos/${productId}/evaluacion` as never);
  const abrirProducto = (otro: string) => router.push(`/productos/${otro}` as never);

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('productos.ficha.titulo')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || ficha === null) {
    const blando = fallo === 'noDisponible' || fallo === 'noEncontrado';
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('productos.ficha.titulo')} onBack={volver} />
        {blando ? (
          <StateView
            state="empty"
            icon={fallo === 'noDisponible' ? 'clock' : 'package'}
            title={f(
              fallo === 'noDisponible' ? 'productos.noDisponible' : 'productos.error.noEncontrado',
            )}
            description={f(
              fallo === 'noDisponible'
                ? 'productos.noDisponibleCuerpo'
                : 'productos.error.noEncontradoCuerpo',
            )}
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

  const leida = ficha;
  const precio = precioLegible(leida.price_minor, leida.currency);

  /** El título de un bloque, si ese bloque lleva uno. */
  const tituloDelBloque = (cual: BloqueDeLaFicha) => {
    const clave = claveDelBloque(cual);
    if (clave === null) return null;
    return <Text variant="titleMedium">{f(clave)}</Text>;
  };

  /** Lo que se dice EN LUGAR de un bloque que no tiene datos. */
  const sinDatos = (bloque: BloqueDeLaFicha) => {
    const clave = claveDelBloqueFuera(bloque);
    if (clave === null) return null;
    return (
      <Text key={`fuera-${bloque}`} variant="caption" color={colors.textMuted}>
        {f(clave)}
      </Text>
    );
  };

  const bloque = (cual: BloqueDeLaFicha) => {
    if (seDejaFuera(leida, cual)) return sinDatos(cual);
    switch (cual) {
      case 'galeria':
        return (
          <View key={cual} style={styles.galeria}>
            {/* Una imagen por pantalla, con su contador abajo a la derecha. El
                contador cuenta LO QUE SE ESTÁ VIENDO: se actualiza al soltar el
                dedo, no se escribe «1/5» fijo. */}
            <SinCambioDeSeccion>
              <ScrollView
                horizontal
                pagingEnabled
                showsHorizontalScrollIndicator={false}
                onMomentumScrollEnd={(evento) => {
                  const ancho = evento.nativeEvent.layoutMeasurement.width || 1;
                  setEnLaGaleria(Math.round(evento.nativeEvent.contentOffset.x / ancho));
                }}
              >
                {leida.gallery.map((media) => (
                  <View
                    key={media.id}
                    style={[styles.imagen, { borderColor: colors.border }]}
                    accessibilityLabel={media.alt_text ?? f('productos.ficha.imagenSinTexto')}
                  >
                    {/* La ruta no se puede firmar todavía: se enseña el texto
                        alternativo, que sí es un dato real. */}
                    {sePuedeMostrarLaImagen(media.storage_path) ? null : (
                      <Feather name="image" size={26} color={colors.textMuted} />
                    )}
                    <Text variant="caption" color={colors.textMuted} numberOfLines={2}>
                      {media.alt_text ?? f('productos.ficha.imagenNoDisponible')}
                    </Text>
                  </View>
                ))}
              </ScrollView>
            </SinCambioDeSeccion>
            {leida.gallery.length > 1 ? (
              <Text
                variant="caption"
                color={colors.textMuted}
                style={[styles.contadorDeGaleria, { borderColor: colors.border }]}
              >
                {f('productos.ficha.galeriaContador', {
                  i: posicionEnLaGaleria(enLaGaleria, leida.gallery.length),
                  n: leida.gallery.length,
                })}
              </Text>
            ) : null}
          </View>
        );

      case 'creador':
        return (
          <Text key={cual} variant="caption" color={colors.textMuted}>
            {f('productos.ficha.creadorEs', { nombre: leida.seller_name })}
          </Text>
        );

      case 'nombre':
        return (
          <View key={cual} style={styles.grupo}>
            {/* EL NOMBRE Y EL PRECIO, EN LA MISMA LÍNEA, como en la referencia.
                El precio es el bloque siguiente del blueprint y por eso su
                `case` no pinta nada: si estuviera debajo, el orden se leería
                igual pero la ficha no se parecería a lo aprobado. */}
            <View style={styles.linea}>
              <Text variant="title" style={styles.nombre}>
                {leida.name}
              </Text>
              <Text variant="titleMedium">
                {precio.configurado ? precio.texto : f(CLAVE_SIN_PRECIO)}
              </Text>
            </View>
            {etiquetaDeVersion(leida.version) !== '' ? (
              <Text variant="caption" color={colors.textMuted}>
                {f('productos.ficha.version', { version: etiquetaDeVersion(leida.version) })}
              </Text>
            ) : null}
            {leida.published_at !== null ? (
              <Text variant="caption" color={colors.textMuted}>
                {f('productos.ficha.publicado', { momento: momentoLegible(leida.published_at) })}
              </Text>
            ) : null}
            {/* La huella de lo publicado: es lo que hace demostrable qué se
                evaluó. */}
            <Text variant="caption" color={colors.textMuted}>
              {f('productos.ficha.huella', { huella: huellaCorta(leida.content_sha256) })}
            </Text>
          </View>
        );

      // El precio se pinta ARRIBA, junto al nombre: ver el `case 'nombre'`.
      case 'precio':
        return null;

      case 'sello':
        return (
          <View key={cual} style={[styles.sello, { borderColor: colors.border }]}>
            {/* La Z en su círculo, como en la referencia. */}
            <View style={[styles.disco, { backgroundColor: colors.text }]}>
              <Text variant="secondary" weight="900" color={colors.background}>
                {'Z'}
              </Text>
            </View>
            {/* EL TEXTO DEL SELLO ES EL DEL SERVIDOR, palabra por palabra: solo
                se parte por su punto medio para poder pintar las dos mitades. */}
            <View style={styles.selloTexto}>
              <Text variant="secondary" weight="700">
                {partesDelSello(leida.seal).titulo}
              </Text>
              {partesDelSello(leida.seal).cuerpo !== null ? (
                <Text variant="caption" color={colors.textMuted}>
                  {partesDelSello(leida.seal).cuerpo}
                </Text>
              ) : null}
              {selloAbreInforme(leida) ? (
                <Button
                  label={f(claveDeAccion('verInforme'))}
                  variant="secondary"
                  icon="file-text"
                  onPress={abrirInforme}
                />
              ) : (
                <Text variant="caption" color={colors.textMuted}>
                  {f('productos.ficha.selloSinInforme')}
                </Text>
              )}
            </View>
          </View>
        );

      case 'razones':
        return (
          <View key={cual} style={styles.grupo}>
            {tituloDelBloque(cual)}
            {/* LAS TRES EN FILA, cada una con su icono encima. */}
            <View style={styles.razones}>
              {razonesOrdenadas(leida).map((razon) => {
                const icono = iconoDeLaDimension(razon.evidence_dimension);
                return (
                  <View
                    key={`${razon.position}-${razon.text}`}
                    style={[styles.razon, { borderColor: colors.border }]}
                  >
                    {/* EL ICONO SALE DE LA EVIDENCIA (`evidence_dimension`), no
                        de un gusto: una dimensión que no conocemos va sin él. */}
                    {icono !== null ? (
                      <Feather
                        name={icono as keyof typeof Feather.glyphMap}
                        size={18}
                        color={colors.text}
                      />
                    ) : null}
                    <Text variant="caption" weight="700" numberOfLines={3}>
                      {razon.text}
                    </Text>
                    {/* DE QUÉ EVIDENCIA SALE. Sin esto es una frase escrita a mano. */}
                    <Text variant="caption" color={colors.textMuted}>
                      {f('productos.ficha.razonEvidencia', {
                        tipo: f(claveDeTipoDeEvidencia(razon.evidence_kind)),
                        dimension: f(claveDeDimension(razon.evidence_dimension)),
                      })}
                    </Text>
                  </View>
                );
              })}
            </View>
          </View>
        );

      case 'variantes':
        return (
          <View key={cual} style={styles.grupo}>
            {tituloDelBloque(cual)}
            {leida.variants.map((variante) => {
              const delta = deltaDeLaVariante(leida, variante);
              return (
                <View
                  key={variante.id}
                  style={[styles.tarjeta, { borderColor: colors.border }]}
                >
                  <Text variant="secondary" weight="700">
                    {variante.name}
                  </Text>
                  <Text variant="caption" color={colors.textMuted}>
                    {f('productos.ficha.sku', { sku: variante.sku })}
                  </Text>
                  {opcionesDeLaVariante(variante).map(([clave, valor]) => (
                    <Text key={clave} variant="caption" color={colors.textMuted}>
                      {`${clave}: ${valor}`}
                    </Text>
                  ))}
                  {delta.configurado ? (
                    <Text variant="caption">
                      {f('productos.ficha.varianteDelta', { texto: delta.texto })}
                    </Text>
                  ) : null}
                </View>
              );
            })}
          </View>
        );

      case 'descripcion':
        return (
          <View key={cual} style={styles.grupo}>
            {tituloDelBloque(cual)}
            {leida.summary !== null ? <Text variant="secondary">{leida.summary}</Text> : null}
            {leida.description !== null ? <Text>{leida.description}</Text> : null}
          </View>
        );

      case 'materialesYOrigen':
        return (
          <View key={cual} style={styles.grupo}>
            {tituloDelBloque(cual)}
            {leida.materials !== null ? (
              <Text variant="caption">
                {f('productos.ficha.materiales', { valor: leida.materials })}
              </Text>
            ) : null}
            {leida.origin_country !== null ? (
              <Text variant="caption">
                {f('productos.ficha.origen', { valor: leida.origin_country })}
              </Text>
            ) : null}
            {leida.manufacturer !== null ? (
              <Text variant="caption">
                {f('productos.ficha.fabricante', { valor: leida.manufacturer })}
              </Text>
            ) : null}
          </View>
        );

      // Los tres que hoy nunca tienen datos entran por `seDejaFuera` y salen
      // como una línea honesta; estos `case` existen para el día que el
      // servidor mande algo de verdad, y para que el orden esté completo.
      case 'valoracion':
      case 'compraProtegida':
      case 'entregaYDevolucion':
        return sinDatos(cual);

      case 'perfilDelCreador':
        return (
          <View key={cual} style={[styles.tarjeta, { borderColor: colors.border }]}>
            <Text variant="secondary" weight="700">
              {leida.seller_name}
            </Text>
            <Button
              label={f(claveDeAccion('verCreador'))}
              variant="secondary"
              icon="user"
              onPress={() => irAlPerfil(router, leida.seller_profile_id)}
            />
          </View>
        );

      case 'relacionados':
        return (
          <View key={cual} style={styles.grupo}>
            {tituloDelBloque(cual)}
            <Text variant="caption" color={colors.textMuted}>
              {f('productos.ficha.relacionadosCuerpo')}
            </Text>
            <CuadriculaDeProductos tarjetas={leida.related} onAbrir={abrirProducto} />
          </View>
        );

      // LA BARRA FIJA SE PINTA ABAJO, fuera del scroll: es el último bloque del
      // blueprint y tiene que seguir ahí cuando la ficha es larga.
      case 'barraFija':
        return null;

      default:
        return null;
    }
  };

  return (
    <AppScreen scroll={false}>
      <AppHeader
        title={f('productos.ficha.titulo')}
        onBack={volver}
        rightIcon="shopping-bag"
        onRightPress={() => router.push('/productos/guardados' as never)}
      />
      <ScrollView contentContainerStyle={styles.contenido} showsVerticalScrollIndicator={false}>
        {BLOQUES_DE_LA_FICHA.map((cual) => bloque(cual))}
      </ScrollView>

      {/*
        La barra fija: el precio a la izquierda y, donde la referencia pone
        «Comprar», lo único que hoy se puede hacer de verdad.

        NO VENDE NADA. `purchasable` es `false` y no hay carrito, ni checkout,
        ni pedido en la API: un botón de comprar aquí sería la promesa más
        visible y la más imposible de cumplir de toda la pantalla.
      */}
      <View style={[styles.barraFija, { borderColor: colors.border }]}>
        <View style={styles.linea}>
          <View style={styles.barraPrecio}>
            <Text variant="titleMedium">
              {precio.configurado ? precio.texto : f(CLAVE_SIN_PRECIO)}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {f('productos.ficha.sinComprar')}
            </Text>
          </View>
          <Button
            label={f(leida.saved ? 'productos.accion.quitar' : 'productos.accion.guardar')}
            variant="secondary"
            icon={leida.saved ? 'check' : 'heart'}
            onPress={alternarGuardado}
            loading={ocupado}
            disabled={ocupado}
          />
        </View>
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  grupo: { gap: spacing.sm },
  linea: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  nombre: { flex: 1 },
  galeria: { gap: spacing.xs },
  imagen: {
    // Una por pantalla: el ancho lo pone el contenedor del scroll horizontal.
    width: 280,
    height: 240,
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginRight: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contadorDeGaleria: {
    alignSelf: 'flex-end',
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  sello: {
    flexDirection: 'row',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  disco: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selloTexto: { flex: 1, gap: spacing.xs },
  razones: { flexDirection: 'row', gap: spacing.sm },
  razon: {
    flexBasis: '31%',
    flexGrow: 1,
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  tarjeta: {
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  barraPrecio: { flex: 1, gap: 2 },
  barraFija: {
    gap: spacing.sm,
    borderTopWidth: 1,
    padding: spacing.lg,
  },
});
