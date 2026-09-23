import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import { irAlPerfil } from '@/lib/irAlPerfil';
import {
  type ResumenDeResenas,
  ajustadaLegible,
  comprasVerificadas,
  esResenasApagadas,
  hayValoraciones,
  porcentajeLegible,
  promedioLegible,
  usaReferenciaPorDefecto,
} from '@/lib/resenasDeProductos';
import { ProductReviewRepository } from '@/repositories/ProductReviewRepository';
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
import {
  claveDeErrorDelCarrito,
  claveDeLaPulsacion,
  contadorDeLaBolsa,
  esCarritoApagado,
} from '@/lib/carrito';
import { ProductCartRepository } from '@/repositories/ProductCartRepository';
import { ProductCatalogRepository } from '@/repositories/ProductCatalogRepository';
import { CuadriculaDeProductos, useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError, haySesion } from '@/services/api';

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
 * SE PUEDE AÑADIR A LA BOLSA, QUE NO ES PAGAR. Desde la 0075 hay bolsa con
 * cantidades y variantes, y la barra fija lo ofrece; sigue sin haber checkout,
 * ni pedido, ni cobro, así que el botón dice «Añadir a la bolsa» y no otra cosa
 * en ninguno de los tres idiomas. Solo aparece cuando la ficha tiene al menos
 * una variante Y un precio configurado: sin variante no se sabe qué se mete, y
 * sin precio la bolsa no podría sumar nada. Cuando no aparece NO SE EXPLICA
 * NADA, porque no es un error: es un producto que todavía no se puede pedir.
 *
 * HAY QUE ELEGIR VARIANTE ANTES. El servidor añade por `variant_id`, no por
 * producto: elegir una por nuestra cuenta —la primera, la más barata— sería
 * meter en la bolsa algo que nadie pidió.
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
  /**
   * La puntuacion del producto. `null` = todavia no se ha leido; un
   * resumen con `total` en cero = LEIDO Y NO HAY NINGUNA, que no es lo
   * mismo y se pinta distinto.
   */
  const [valoracion, setValoracion] = useState<ResumenDeResenas | null>(null);
  const ocupadoRef = useRef(false);
  /** Qué imagen de la galería se está viendo. El contador cuenta ESTO. */
  const [enLaGaleria, setEnLaGaleria] = useState(0);
  /** Qué variante se ha elegido. `null` = todavía ninguna, y no se supone. */
  const [varianteElegida, setVarianteElegida] = useState<string | null>(null);
  /** Unidades en la bolsa. `null` = no hay contador que enseñar. */
  const [enLaBolsa, setEnLaBolsa] = useState<number | null>(null);
  /**
   * La clave de idempotencia de la pulsación que está en curso.
   *
   * Se genera UNA VEZ y se reenvía si hay que reintentar: es lo que distingue
   * un doble toque —que no debe sumar dos— de dos toques, que sí. Se suelta al
   * terminar bien, para que la siguiente pulsación sí cuente.
   */
  const claveDeAnadirRef = useRef<{ varianteId: string; clave: string } | null>(null);

  /**
   * El contador de la bolsa, en UNA llamada y SOLO CON SESIÓN.
   *
   * Es un adorno, no el contenido: si falla —401 sin sesión, 503 con la 0075
   * sin aplicar— no se enseña ningún número y tampoco un error.
   */
  const leerContadores = useCallback(async () => {
    if (!(await haySesion())) {
      setEnLaBolsa(null);
      return;
    }
    try {
      setEnLaBolsa(contadorDeLaBolsa((await ProductCartRepository.contadores()).cart_units));
    } catch {
      setEnLaBolsa(null);
    }
  }, []);

  /**
   * La puntuacion, EN SU PROPIA PETICION Y SIN TUMBAR LA FICHA.
   *
   * Es un bloque de la ficha, no la ficha: si la 0081 no esta aplicada o
   * la peticion falla, el resto se sigue viendo y el bloque sale como la
   * linea honesta que ya salia antes de que existieran las valoraciones.
   */
  const leerValoracion = useCallback(async () => {
    if (!productId) return;
    try {
      setValoracion(await ProductReviewRepository.resumen(productId));
    } catch (error) {
      if (!(error instanceof ApiError) || !esResenasApagadas(error.code)) {
        setValoracion(null);
      }
    }
  }, [productId]);

  const cargar = useCallback(async () => {
    if (!productId) return;
    setCargando(true);
    setFallo(null);
    try {
      setFicha(await ProductCatalogRepository.ficha(productId));
      void leerContadores();
      void leerValoracion();
    } catch (error) {
      if (error instanceof ApiError && esProductosApagado(error.code)) setFallo('noDisponible');
      else if (error instanceof ApiError && error.status === 404) setFallo('noEncontrado');
      else if (error instanceof ApiError && esFalloDeRed(error.code)) setFallo('sinConexion');
      else setFallo('red');
    } finally {
      setCargando(false);
    }
  }, [productId, leerContadores]);

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

  /**
   * Añadir una unidad de la variante elegida a la bolsa. NO ES COMPRAR.
   *
   * La clave de idempotencia se genera una vez por pulsación y se reenvía tal
   * cual si hay que reintentar: así un doble toque —o un reintento tras un
   * fallo de red que sí llegó— ajusta la línea en vez de duplicarla.
   */
  const anadirALaBolsa = () => {
    if (ficha === null || ocupadoRef.current) return;
    const actual = ficha;
    const varianteId = varianteElegida;
    if (varianteId === null) {
      notify(f('carrito.elegirVariante'), f('carrito.elegirVarianteCuerpo'));
      return;
    }
    const enCurso = claveDeAnadirRef.current;
    const clave =
      enCurso !== null && enCurso.varianteId === varianteId
        ? enCurso.clave
        : claveDeLaPulsacion(actual.product_id, varianteId, Date.now());
    claveDeAnadirRef.current = { varianteId, clave };
    ocupadoRef.current = true;
    setOcupado(true);
    void (async () => {
      try {
        const bolsa = await ProductCartRepository.anadir({
          productoId: actual.product_id,
          varianteId,
          cantidad: 1,
          clave,
        });
        // El contador sale de la bolsa que acaba de contestar: es la misma que
        // se acaba de escribir, así que no hace falta volver a preguntar.
        setEnLaBolsa(contadorDeLaBolsa(bolsa.units));
        claveDeAnadirRef.current = null;
        toast(f('carrito.anadido'));
      } catch (error) {
        if (error instanceof ApiError && esFaltaDeSesion(error.status)) {
          notify(f('productos.error.sinSesion'), f('productos.error.sinSesionCuerpo'));
        } else if (error instanceof ApiError && esCarritoApagado(error.code)) {
          notify(f('carrito.error.noDisponible'), f('carrito.error.noDisponibleCuerpo'));
        } else {
          const deLaBolsa =
            error instanceof ApiError ? claveDeErrorDelCarrito(error.code) : null;
          notify(
            f('productos.noSePudo'),
            deLaBolsa !== null ? f(deLaBolsa) : textoDelError(error),
          );
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
  /**
   * Si esta ficha se puede añadir a la bolsa.
   *
   * Las dos condiciones son del contrato, no de gusto: sin variante el servidor
   * no sabe qué línea crear (`variant_id` es obligatorio) y sin precio la bolsa
   * no podría sumar nada. Cuando falta alguna, el botón NO SE PINTA y no se
   * escribe ninguna disculpa.
   */
  const sePuedeAnadir = leida.variants.length > 0 && precio.configurado;

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
                    {/* LA FOTOGRAFÍA APROBADA. Si el servidor no pudo firmarla
                        se enseña el texto alternativo, que sí es un dato real,
                        y no un hueco. */}
                    {sePuedeMostrarLaImagen(media.url) ? (
                      <ExpoImage
                        source={{
                          uri: media.url as string,
                          cacheKey: media.storage_path,
                        }}
                        style={styles.imagenFoto}
                        contentFit="cover"
                        transition={120}
                        recyclingKey={media.storage_path}
                        accessibilityLabel={
                          media.alt_text ?? f('productos.ficha.imagenSinTexto')
                        }
                      />
                    ) : (
                      <>
                        <Feather name="image" size={26} color={colors.textMuted} />
                        <Text variant="caption" color={colors.textMuted} numberOfLines={2}>
                          {media.alt_text ?? f('productos.ficha.imagenNoDisponible')}
                        </Text>
                      </>
                    )}
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
            {/* CADA VARIANTE SE PUEDE ELEGIR, y elegir no mete nada en ninguna
                parte: solo dice cuál es la que se añadiría. Lo elegido se marca
                con un icono de comprobación Y con el borde, nunca con el color
                a solas. */}
            {leida.variants.map((variante) => {
              const delta = deltaDeLaVariante(leida, variante);
              const elegida = varianteElegida === variante.id;
              return (
                <Pressable
                  key={variante.id}
                  onPress={() => setVarianteElegida(elegida ? null : variante.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: elegida }}
                  accessibilityLabel={variante.name}
                  style={({ pressed }) => [
                    styles.tarjeta,
                    {
                      borderColor: elegida ? colors.text : colors.border,
                      borderWidth: elegida ? 2 : 1,
                      opacity: pressed ? 0.7 : 1,
                    },
                  ]}
                >
                  <View style={styles.linea}>
                    <Text variant="secondary" weight="700" style={styles.nombre}>
                      {variante.name}
                    </Text>
                    <Feather
                      name={elegida ? 'check-circle' : 'circle'}
                      size={18}
                      color={elegida ? colors.text : colors.textMuted}
                    />
                  </View>
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
                </Pressable>
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

      // LA VALORACION REAL (Incremento 8). SIN RESENAS SIGUE SALIENDO LA
      // LINEA HONESTA de siempre: un producto sin opiniones no puntua 0,0
      // y cinco estrellas vacias dirian que esta mal valorado.
      //
      // SE ENSENA LA AJUSTADA, que es la que pide el blueprint, y cuando se
      // apoya en la referencia general —porque de donde sale el promedio de
      // categoria no lo ha decidido nadie— la pantalla lo dice.
      case 'valoracion':
        if (!hayValoraciones(valoracion)) return sinDatos(cual);
        return (
          <View key={cual} style={styles.grupo}>
            {tituloDelBloque(cual)}
            <View style={[styles.tarjeta, { borderColor: colors.border }]}>
              {/* NI UNA ESTRELLA AQUI, Y ES A PROPOSITO. Dibujarlas obligaba a
                  redondear la puntuacion ajustada, y con pocas valoraciones eso
                  miente a lo grande: una sola de UNA estrella daba 3,9 y
                  encendia CUATRO, porque el 91 % de esa cifra es la referencia
                  general. Lo encontro la revision independiente. La captura
                  pide un numero y un recuento, no estrellas; las estrellas de
                  cada persona se leen en su valoracion, donde son suyas. */}
              <View style={styles.linea}>
                <Text variant="titleMedium">{ajustadaLegible(valoracion)}</Text>
                {/* Y EL PROMEDIO REAL AL LADO: lo que de verdad puntuaron. */}
                {promedioLegible(valoracion) !== null ? (
                  <Text variant="caption" color={colors.textMuted}>
                    {f('resenaDeProducto.ficha.promedioReal', {
                      n: promedioLegible(valoracion) as string,
                    })}
                  </Text>
                ) : null}
              </View>
              <Text variant="caption" color={colors.textMuted}>
                {`${comprasVerificadas(valoracion)} ${
                  comprasVerificadas(valoracion) === 1
                    ? f('resenaDeProducto.ficha.unaCompraVerificada')
                    : f('resenaDeProducto.ficha.comprasVerificadas')
                }`}
              </Text>
              {porcentajeLegible(valoracion?.recommend_bps) !== null ? (
                <Text variant="caption" color={colors.textMuted}>
                  {`${porcentajeLegible(valoracion?.recommend_bps)} ${f(
                    'resenaDeProducto.ficha.loRecomienda',
                  )}`}
                </Text>
              ) : null}
              {usaReferenciaPorDefecto(valoracion) ? (
                <Text variant="caption" color={colors.textMuted}>
                  {f('resenaDeProducto.ficha.referenciaPorDefecto')}
                </Text>
              ) : null}
              <Button
                label={f('resenaDeProducto.ficha.verTodas')}
                variant="secondary"
                icon="star"
                onPress={() =>
                  router.push(`/productos/${productId}/resenas` as never)
                }
              />
            </View>
          </View>
        );

      // Los dos que hoy nunca tienen datos entran por `seDejaFuera` y salen
      // como una línea honesta; estos `case` existen para el día que el
      // servidor mande algo de verdad, y para que el orden esté completo.
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
        onRightPress={() => router.push('/productos/carrito' as never)}
        rightBadge={enLaBolsa !== null}
      />
      <ScrollView contentContainerStyle={styles.contenido} showsVerticalScrollIndicator={false}>
        {BLOQUES_DE_LA_FICHA.map((cual) => bloque(cual))}
      </ScrollView>

      {/*
        La barra fija: el precio a la izquierda y, donde la referencia pone
        «Comprar», lo único que hoy se puede hacer de verdad.

        AÑADIR A LA BOLSA NO ES PAGAR, y el texto no lo insinúa en ninguno de
        los tres idiomas: no hay checkout, ni pedido, ni cobro en la API, y la
        línea de debajo del precio lo sigue diciendo.
      */}
      <View style={[styles.barraFija, { borderColor: colors.border }]}>
        <View style={styles.linea}>
          <View style={styles.barraPrecio}>
            <Text variant="titleMedium">
              {precio.configurado ? precio.texto : f(CLAVE_SIN_PRECIO)}
            </Text>
            {/* SOLO CUANDO ES VERDAD. Se pintaba siempre, y el día que se
                encendieran las ventas diría «todavía no se compran productos»
                encima del botón de la bolsa. Lo decide el servidor. */}
            {!leida.purchasable ? (
              <Text variant="caption" color={colors.textMuted}>
                {f('productos.ficha.sinComprar')}
              </Text>
            ) : null}
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
        {/* SIN VARIANTES O SIN PRECIO, NO HAY BOTÓN Y NO SE EXPLICA NADA: no es
            un error, es un producto que todavía no se puede pedir. */}
        {sePuedeAnadir ? (
          <Button
            label={f('carrito.anadir')}
            icon="shopping-bag"
            onPress={anadirALaBolsa}
            disabled={ocupado}
          />
        ) : null}
        {sePuedeAnadir && varianteElegida === null ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('carrito.elegirVariante')}
          </Text>
        ) : null}
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
  imagenFoto: { width: '100%', height: '100%' },
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
