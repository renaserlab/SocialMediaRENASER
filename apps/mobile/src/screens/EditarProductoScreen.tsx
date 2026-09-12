import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import { toast } from '@/lib/toast';
import {
  LARGO_DEL_ALTERNATIVO,
  LARGO_DEL_FABRICANTE,
  LARGO_DEL_NOMBRE_DEL_PRODUCTO,
  LARGO_DEL_NOMBRE_DE_VARIANTE,
  LARGO_DEL_RESUMEN,
  LARGO_DE_LA_DESCRIPCION,
  LARGO_DE_LA_RUTA,
  LARGO_DE_LA_VERSION,
  LARGO_DE_LOS_MATERIALES,
  MAXIMO_DE_FOTOS,
  MAXIMO_DE_VARIANTES,
  accionesOfrecidas,
  claveDeErrorDeProveedor,
  claveDeErrorPorEstado,
  claveDeFallo,
  claveDelEstadoDeProducto,
  esProductosApagado,
  fotoVacia,
  formularioDeProductoDesde,
  formularioDeProductoVacio,
  hayAlgoEscrito,
  hayQueRecargar,
  opcionVacia,
  peticionDeVersion,
  sePuedeEditarProducto,
  validarProducto,
  varianteVacia,
  versionEnBorrador,
  type Fallo,
  type FormularioDeProducto,
  type ProductoDelProveedor,
} from '@/lib/proveedorDeProductos';
import { ProductSellerRepository } from '@/repositories/ProductSellerRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Crear un producto y escribir el borrador de su versión.
 *
 * NINGÚN CAMPO NACE CON VALOR. Ni el precio, ni la moneda, ni una variante de
 * ejemplo, ni una versión llamada «1». Un `precio: 0` precargado dice que este
 * producto es gratis, y lo habría decidido la aplicación; una moneda precargada
 * dice en qué país se vende. Lo que nadie escribe NO VIAJA en la petición, y la
 * clave ausente es exactamente lo que el servidor entiende por «sin
 * configurar»: `price_minor: null` es «sin precio», no «gratis».
 *
 * EL PRECIO VA CON SU MONEDA O NO VA. Lo impone un CHECK de la 0070 —`(price_minor
 * is null) = (currency is null)`— y aquí se dice antes de mandar nada, porque un
 * importe sin moneda no es un importe. El importe se escribe en UNIDADES
 * MENORES, que es la unidad del contrato: convertirlo aquí exigiría saber
 * cuántos decimales tiene cada moneda, y eso el servidor no lo manda.
 *
 * LA GALERÍA GUARDA RUTAS DEL ALMACENAMIENTO, NUNCA ENLACES. Una URL firmada
 * caduca, y guardarla haría que la ficha dejara de cargar sin que nadie tocara
 * nada. Se rechaza aquí cualquier cosa con `://`, igual que en el servidor.
 *
 * SOLO EL BORRADOR SE EDITA. Si el producto ya salió de borrador la pantalla no
 * ofrece campos: lo dice y deja leer. Editar lo que alguien está evaluando
 * cambiaría el objeto de la evaluación a mitad de camino.
 *
 * CREAR NO ES PUBLICAR. El producto nace borrador y «Postula tu producto» lo
 * manda a admisión; el sello de Z lo pone quien evalúa y quien administra.
 */
export function EditarProductoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { productId } = useLocalSearchParams<{ productId?: string }>();

  const f = useCallback(
    (clave: string, params?: Record<string, string | number>) =>
      t(clave as TranslationKey, params),
    [t],
  );

  const esNuevo = typeof productId !== 'string' || productId === '';

  const [producto, setProducto] = useState<ProductoDelProveedor | null>(null);
  const [formulario, setFormulario] = useState<FormularioDeProducto>(
    formularioDeProductoVacio(),
  );
  const [fallos, setFallos] = useState<Fallo[]>([]);
  const [cargando, setCargando] = useState(!esNuevo);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'sinPermiso' | 'sinSesion' | 'noEncontrado' | 'noDisponible' | null
  >(null);

  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  const leerFallo = (error: unknown) => {
    if (error instanceof ApiError && esProductosApagado(error.code)) {
      return 'noDisponible' as const;
    }
    if (error instanceof ApiError && error.status === 401) return 'sinSesion' as const;
    if (error instanceof ApiError && error.status === 403) return 'sinPermiso' as const;
    if (error instanceof ApiError && error.status === 404) return 'noEncontrado' as const;
    if (error instanceof ApiError && esFalloDeRed(error.code)) return 'sinConexion' as const;
    return 'red' as const;
  };

  const cargar = useCallback(async () => {
    if (esNuevo || typeof productId !== 'string') return;
    setCargando(true);
    setFallo(null);
    try {
      const leido = await ProductSellerRepository.producto(productId);
      setProducto(leido);
      const borrador = versionEnBorrador(leido);
      /*
        SE CARGA LO QUE HAY, Y NADA MÁS. Lo que el borrador no trae sigue vacío:
        rellenarlo con un valor de partida cambiaría, al guardar, un dato que
        nadie tocó. Sin borrador el formulario nace en blanco —no se copia la
        versión publicada, porque lo publicado no se reescribe— y el servidor
        abrirá una versión nueva al guardar.
      */
      setFormulario(
        borrador !== null ? formularioDeProductoDesde(borrador) : formularioDeProductoVacio(),
      );
      setFallos([]);
    } catch (error) {
      setFallo(leerFallo(error));
    } finally {
      setCargando(false);
    }
  }, [esNuevo, productId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const textoDelError = (error: unknown) => {
    if (error instanceof ApiError) {
      const porCodigo = claveDeErrorDeProveedor(error.code);
      if (porCodigo !== null) return f(porCodigo);
      const porEstado = claveDeErrorPorEstado(error.status);
      if (porEstado !== null) return f(porEstado);
    }
    return error instanceof Error && error.message.trim() !== ''
      ? error.message
      : t('common.tryAgain');
  };

  const conCerrojo = async (trabajo: () => Promise<void>) => {
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    setOcupado(true);
    try {
      await trabajo();
    } catch (error) {
      notify(f('proveedorProductos.editar.noSePudo'), textoDelError(error));
      if (error instanceof ApiError && hayQueRecargar(error.status, error.code)) {
        await cargar();
      }
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  const guardar = () => {
    const { peticion, fallos: encontrados } = peticionDeVersion(formulario);
    if (peticion === null) {
      setFallos(encontrados);
      return;
    }
    setFallos([]);
    void conCerrojo(async () => {
      if (esNuevo || typeof productId !== 'string') {
        const creado = await ProductSellerRepository.crearProducto(peticion);
        toast(f('proveedorProductos.productos.creado'));
        // Se sustituye la ruta: volver atrás a «nuevo» crearía otro producto.
        router.replace(`/proveedor/productos/${creado.id}` as never);
        return;
      }
      setProducto(await ProductSellerRepository.guardarBorrador(productId, peticion));
      toast(f('proveedorProductos.editar.guardado'));
      await cargar();
    });
  };

  /** «Postula tu producto»: lo manda a admisión y deja de ser editable. */
  const postular = () => {
    if (producto === null) return;
    void conCerrojo(async () => {
      const aceptado = await confirm({
        title: f('proveedorProductos.productos.postularTitulo'),
        message: f('proveedorProductos.productos.postularAviso'),
        confirmLabel: f('proveedorProductos.marca.postula'),
      });
      if (!aceptado) return;
      await ProductSellerRepository.postularProducto(producto.id);
      toast(f('proveedorProductos.productos.postulado'));
      await cargar();
    });
  };

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/proveedor/productos' as never);

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('proveedorProductos.editar.tituloEditar')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
    const blando =
      fallo === 'noDisponible' ||
      fallo === 'sinPermiso' ||
      fallo === 'sinSesion' ||
      fallo === 'noEncontrado';
    const titulo =
      fallo === 'noDisponible'
        ? f('proveedorProductos.error.noDisponible')
        : fallo === 'sinSesion'
          ? f('proveedorProductos.error.sinSesion')
          : fallo === 'sinPermiso'
            ? f('proveedorProductos.error.sinPermiso')
            : f('proveedorProductos.error.noEncontrado');
    const cuerpo =
      fallo === 'noDisponible'
        ? f('proveedorProductos.error.noDisponibleCuerpo')
        : fallo === 'sinSesion'
          ? f('proveedorProductos.error.sinSesionCuerpo')
          : fallo === 'sinPermiso'
            ? f('proveedorProductos.error.sinPermisoCuerpo')
            : f('proveedorProductos.error.noEncontradoCuerpo');
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('proveedorProductos.editar.tituloEditar')} onBack={volver} />
        {blando ? (
          <StateView
            state="empty"
            icon={fallo === 'noDisponible' ? 'clock' : 'lock'}
            title={titulo}
            description={cuerpo}
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

  const titulo = esNuevo
    ? f('proveedorProductos.editar.tituloNuevo')
    : f('proveedorProductos.editar.tituloEditar');

  /* NO SE PUEDE EDITAR LO QUE ALGUIEN ESTÁ MIRANDO. Se dice y se deja leer. */
  if (producto !== null && !sePuedeEditarProducto(producto)) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView
          state="empty"
          icon="lock"
          title={f(claveDelEstadoDeProducto(producto.status))}
          description={f('proveedorProductos.editar.noEditable')}
        />
        <Button
          label={f('proveedorProductos.productos.titulo')}
          variant="secondary"
          icon="package"
          onPress={() => router.replace('/proveedor/productos' as never)}
        />
      </AppScreen>
    );
  }

  const falloDe = (campo: string, indice?: number) =>
    fallos.find((x) => x.campo === campo && x.indice === indice) ?? null;
  const mensajeDe = (campo: string, indice?: number) => {
    const encontrado = falloDe(campo, indice);
    if (encontrado === null) return undefined;
    return f(claveDeFallo(encontrado), {
      min: encontrado.min ?? 0,
      max: encontrado.max ?? 0,
    });
  };

  const variantes = formulario.variantes;
  const galeria = formulario.galeria;
  const sePuedePostular =
    producto !== null && accionesOfrecidas(producto).includes('submitted');

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />

      <View style={[styles.tarjeta, { borderColor: colors.border }]}>
        <Text variant="secondary" weight="700">
          {f('proveedorProductos.marca.productoDeExcelencia')}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('proveedorProductos.editar.cuerpo')}
        </Text>
        {/* CREAR NO ES PUBLICAR, y se dice antes de escribir nada. */}
        <Text variant="caption" color={colors.textMuted}>
          {f('proveedorProductos.editar.sinPublicar')}
        </Text>
      </View>

      <Input
        label={f('proveedorProductos.editar.nombreEtiqueta')}
        placeholder={f('proveedorProductos.editar.nombreAyuda')}
        value={formulario.nombre}
        onChangeText={(nombre) => setFormulario({ ...formulario, nombre })}
        error={mensajeDe('nombre')}
        maxLength={LARGO_DEL_NOMBRE_DEL_PRODUCTO[1]}
        editable={!ocupado}
      />

      <Input
        label={f('proveedorProductos.editar.versionEtiqueta')}
        placeholder={f('proveedorProductos.editar.versionAyuda')}
        value={formulario.version}
        onChangeText={(version) => setFormulario({ ...formulario, version })}
        error={mensajeDe('version')}
        maxLength={LARGO_DE_LA_VERSION}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!ocupado}
      />
      <Text variant="caption" color={colors.textMuted}>
        {f('proveedorProductos.editar.versionCuerpo')}
      </Text>

      <Input
        label={f('proveedorProductos.editar.resumenEtiqueta')}
        placeholder={f('proveedorProductos.editar.resumenAyuda')}
        value={formulario.resumen}
        onChangeText={(resumen) => setFormulario({ ...formulario, resumen })}
        error={mensajeDe('resumen')}
        multiline
        numberOfLines={3}
        maxLength={LARGO_DEL_RESUMEN}
        editable={!ocupado}
      />

      <Input
        label={f('proveedorProductos.editar.descripcionEtiqueta')}
        placeholder={f('proveedorProductos.editar.descripcionAyuda')}
        value={formulario.descripcion}
        onChangeText={(descripcion) => setFormulario({ ...formulario, descripcion })}
        error={mensajeDe('descripcion')}
        multiline
        numberOfLines={8}
        maxLength={LARGO_DE_LA_DESCRIPCION}
        editable={!ocupado}
      />

      <Input
        label={f('proveedorProductos.editar.materialesEtiqueta')}
        placeholder={f('proveedorProductos.editar.materialesAyuda')}
        value={formulario.materiales}
        onChangeText={(materiales) => setFormulario({ ...formulario, materiales })}
        error={mensajeDe('materiales')}
        multiline
        numberOfLines={4}
        maxLength={LARGO_DE_LOS_MATERIALES}
        editable={!ocupado}
      />

      <Input
        label={f('proveedorProductos.editar.paisEtiqueta')}
        placeholder={f('proveedorProductos.editar.paisAyuda')}
        value={formulario.pais}
        onChangeText={(pais) => setFormulario({ ...formulario, pais })}
        error={mensajeDe('pais')}
        maxLength={2}
        autoCapitalize="characters"
        autoCorrect={false}
        editable={!ocupado}
      />

      <Input
        label={f('proveedorProductos.editar.fabricanteEtiqueta')}
        placeholder={f('proveedorProductos.editar.fabricanteAyuda')}
        value={formulario.fabricante}
        onChangeText={(fabricante) => setFormulario({ ...formulario, fabricante })}
        error={mensajeDe('fabricante')}
        maxLength={LARGO_DEL_FABRICANTE[1]}
        editable={!ocupado}
      />

      {/* EL PRECIO VA CON SU MONEDA O NO VA. */}
      <View style={[styles.tarjeta, { borderColor: colors.border }]}>
        <Text variant="secondary" weight="700">
          {f('proveedorProductos.editar.precioTitulo')}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('proveedorProductos.editar.precioConMoneda')}
        </Text>
        <Input
          label={f('proveedorProductos.editar.precioEtiqueta')}
          placeholder={f('proveedorProductos.editar.precioAyuda')}
          value={formulario.precio}
          onChangeText={(precio) => setFormulario({ ...formulario, precio })}
          error={mensajeDe('precio')}
          keyboardType="number-pad"
          editable={!ocupado}
        />
        <Input
          label={f('proveedorProductos.editar.monedaEtiqueta')}
          placeholder={f('proveedorProductos.editar.monedaAyuda')}
          value={formulario.moneda}
          onChangeText={(moneda) => setFormulario({ ...formulario, moneda })}
          error={mensajeDe('moneda')}
          maxLength={3}
          autoCapitalize="characters"
          autoCorrect={false}
          editable={!ocupado}
        />
      </View>

      {/* Variantes. SIN EXISTENCIAS: cuántas hay es inventario, y no existe. */}
      <View style={[styles.tarjeta, { borderColor: colors.border }]}>
        <Text variant="secondary" weight="700">
          {f('proveedorProductos.editar.variantes')}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('proveedorProductos.editar.variantesCuerpo')}
        </Text>

        {variantes.map((variante, indice) => (
          <View
            key={`variante-${indice}`}
            style={[styles.tarjeta, { borderColor: colors.border }]}
          >
            <Input
              label={f('proveedorProductos.editar.skuEtiqueta')}
              placeholder={f('proveedorProductos.editar.skuAyuda')}
              value={variante.sku}
              onChangeText={(sku) => {
                const copia = [...variantes];
                copia[indice] = { ...variante, sku };
                setFormulario({ ...formulario, variantes: copia });
              }}
              error={mensajeDe('variante', indice)}
              maxLength={48}
              autoCapitalize="characters"
              autoCorrect={false}
              editable={!ocupado}
            />
            <Input
              label={f('proveedorProductos.editar.nombreDeVariante')}
              placeholder={f('proveedorProductos.editar.nombreDeVarianteAyuda')}
              value={variante.nombre}
              onChangeText={(nombre) => {
                const copia = [...variantes];
                copia[indice] = { ...variante, nombre };
                setFormulario({ ...formulario, variantes: copia });
              }}
              maxLength={LARGO_DEL_NOMBRE_DE_VARIANTE[1]}
              editable={!ocupado}
            />

            <Text variant="caption" color={colors.textMuted}>
              {f('proveedorProductos.editar.opciones')}
            </Text>
            {variante.opciones.map((opcion, posicion) => (
              <View key={`opcion-${indice}-${posicion}`} style={styles.campo}>
                <Input
                  label={f('proveedorProductos.editar.opcionClave')}
                  placeholder={f('proveedorProductos.editar.opcionClaveAyuda')}
                  value={opcion.clave}
                  onChangeText={(clave) => {
                    const copia = [...variantes];
                    const opciones = [...variante.opciones];
                    opciones[posicion] = { ...opcion, clave };
                    copia[indice] = { ...variante, opciones };
                    setFormulario({ ...formulario, variantes: copia });
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!ocupado}
                />
                <Input
                  label={f('proveedorProductos.editar.opcionValor')}
                  placeholder={f('proveedorProductos.editar.opcionValorAyuda')}
                  value={opcion.valor}
                  onChangeText={(valor) => {
                    const copia = [...variantes];
                    const opciones = [...variante.opciones];
                    opciones[posicion] = { ...opcion, valor };
                    copia[indice] = { ...variante, opciones };
                    setFormulario({ ...formulario, variantes: copia });
                  }}
                  editable={!ocupado}
                />
                <Button
                  label={f('proveedorProductos.editar.quitarOpcion')}
                  variant="ghost"
                  onPress={() => {
                    const copia = [...variantes];
                    copia[indice] = {
                      ...variante,
                      opciones: variante.opciones.filter((_, otro) => otro !== posicion),
                    };
                    setFormulario({ ...formulario, variantes: copia });
                  }}
                  disabled={ocupado}
                />
              </View>
            ))}
            <Button
              label={f('proveedorProductos.editar.anadirOpcion')}
              variant="secondary"
              icon="plus"
              onPress={() => {
                const copia = [...variantes];
                copia[indice] = {
                  ...variante,
                  opciones: [...variante.opciones, opcionVacia()],
                };
                setFormulario({ ...formulario, variantes: copia });
              }}
              disabled={ocupado}
            />

            <Input
              label={f('proveedorProductos.editar.diferenciaEtiqueta')}
              placeholder={f('proveedorProductos.editar.diferenciaAyuda')}
              value={variante.diferencia}
              onChangeText={(diferencia) => {
                const copia = [...variantes];
                copia[indice] = { ...variante, diferencia };
                setFormulario({ ...formulario, variantes: copia });
              }}
              editable={!ocupado}
            />

            <Button
              label={f('proveedorProductos.editar.quitarVariante')}
              variant="ghost"
              onPress={() =>
                setFormulario({
                  ...formulario,
                  variantes: variantes.filter((_, otro) => otro !== indice),
                })
              }
              disabled={ocupado}
            />
          </View>
        ))}

        {variantes.length < MAXIMO_DE_VARIANTES ? (
          <Button
            label={f('proveedorProductos.editar.anadirVariante')}
            variant="secondary"
            icon="plus"
            onPress={() =>
              setFormulario({ ...formulario, variantes: [...variantes, varianteVacia()] })
            }
            disabled={ocupado}
          />
        ) : (
          <Text variant="caption" color={colors.textMuted}>
            {f('proveedorProductos.error.demasiadasVariantes', {
              max: MAXIMO_DE_VARIANTES,
              min: 0,
            })}
          </Text>
        )}
      </View>

      {/* La galería: RUTAS DEL ALMACENAMIENTO, nunca enlaces. */}
      <View style={[styles.tarjeta, { borderColor: colors.border }]}>
        <Text variant="secondary" weight="700">
          {f('proveedorProductos.editar.galeria')}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('proveedorProductos.editar.galeriaCuerpo')}
        </Text>

        {galeria.map((foto, indice) => (
          <View key={`foto-${indice}`} style={[styles.tarjeta, { borderColor: colors.border }]}>
            <Input
              label={f('proveedorProductos.editar.rutaEtiqueta')}
              placeholder={f('proveedorProductos.editar.rutaAyuda')}
              value={foto.ruta}
              onChangeText={(ruta) => {
                const copia = [...galeria];
                copia[indice] = { ...foto, ruta };
                setFormulario({ ...formulario, galeria: copia });
              }}
              error={mensajeDe('foto', indice)}
              maxLength={LARGO_DE_LA_RUTA[1]}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!ocupado}
            />
            <Input
              label={f('proveedorProductos.editar.alternativoEtiqueta')}
              placeholder={f('proveedorProductos.editar.alternativoAyuda')}
              value={foto.alternativo}
              onChangeText={(alternativo) => {
                const copia = [...galeria];
                copia[indice] = { ...foto, alternativo };
                setFormulario({ ...formulario, galeria: copia });
              }}
              maxLength={LARGO_DEL_ALTERNATIVO}
              editable={!ocupado}
            />
            <Button
              label={f('proveedorProductos.editar.quitarFoto')}
              variant="ghost"
              onPress={() =>
                setFormulario({
                  ...formulario,
                  galeria: galeria.filter((_, otro) => otro !== indice),
                })
              }
              disabled={ocupado}
            />
          </View>
        ))}

        {galeria.length < MAXIMO_DE_FOTOS ? (
          <Button
            label={f('proveedorProductos.editar.anadirFoto')}
            variant="secondary"
            icon="plus"
            onPress={() => setFormulario({ ...formulario, galeria: [...galeria, fotoVacia()] })}
            disabled={ocupado}
          />
        ) : (
          <Text variant="caption" color={colors.textMuted}>
            {f('proveedorProductos.error.demasiadasFotos', { max: MAXIMO_DE_FOTOS, min: 0 })}
          </Text>
        )}
      </View>

      {/* Lo que afecta a todo el formulario se dice aquí, no al ser rechazado. */}
      {fallos
        .filter((x) => x.campo === 'producto')
        .map((x, indice) => (
          <Text key={`${x.codigo}-${indice}`} variant="caption" color={colors.danger}>
            {f(claveDeFallo(x), { max: x.max ?? 0, min: x.min ?? 0 })}
          </Text>
        ))}

      {!hayAlgoEscrito(formulario) ? (
        <Text variant="caption" color={colors.textMuted}>
          {f('proveedorProductos.editar.nadaEscrito')}
        </Text>
      ) : null}

      <Button
        label={esNuevo ? f('proveedorProductos.editar.crear') : f('proveedorProductos.editar.guardar')}
        onPress={guardar}
        loading={ocupado}
        disabled={ocupado || validarProducto(formulario).length > 0}
      />

      {/* «Postula tu producto»: se postula lo GUARDADO, no lo que se escribe. */}
      {sePuedePostular ? (
        <>
          <Button
            label={f('proveedorProductos.marca.postula')}
            variant="secondary"
            icon="send"
            onPress={postular}
            disabled={ocupado}
          />
          <Text variant="caption" color={colors.textMuted}>
            {f('proveedorProductos.editar.sePostulaLoGuardado')}
          </Text>
        </>
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  campo: { gap: spacing.xs },
  tarjeta: {
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
});
