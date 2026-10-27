import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import { CLAVE_SIN_IMPORTE } from '@/lib/carrito';
import {
  camposIncompletos,
  claveDeErrorDePedidos,
  claveDeLaCompra,
  claveDelCampo,
  claveDeLoQueFalta,
  direccionCompleta,
  esPedidoApagado,
  plazoConfigurado,
  sePuedeDecirCompraProtegida,
  subtotalDelGrupo,
  type Condiciones,
  type Direccion,
  type GrupoDelCarrito,
  type Preparacion,
} from '@/lib/pedidos';
import {
  claveDeErrorDeProductos,
  claveDeErrorPorEstado,
  esFaltaDeSesion,
} from '@/lib/productos';
import { ProductOrderRepository } from '@/repositories/ProductOrderRepository';
import { useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Comprar: revisar lo que llevas, decir a dónde va y leer las condiciones.
 *
 * ESTA PANTALLA NO COBRA NADA. Lo que hace al final es CREAR EL PEDIDO, que
 * reserva las unidades y deja la compra esperando pago. Ir a la pasarela es el
 * paso siguiente y ocurre en la pantalla del pedido, fuera de la aplicación.
 *
 * NO HAY FORMULARIO DE TARJETA, y no puede haberlo: los datos de la tarjeta se
 * escriben en la página alojada de la pasarela y no pasan por Z. Tampoco hay
 * PayPal ni ningún otro método: el único que existe es el que está configurado.
 *
 * IMPUESTOS Y ENVÍO NO SE ENSEÑAN COMO CERO. No están decididos —no hay entidad
 * fiscal, ni transportista, ni tarifas— y una línea «Envío: 0,00» es una promesa
 * de envío gratuito que nadie ha hecho. Se dice con palabras que faltan.
 *
 * NO SE DICE «COMPRA PROTEGIDA» SIN POLÍTICA. Sin plazo para reportar una
 * incidencia no hay ninguna protección que ofrecer, y decirlo igualmente es lo
 * que hace que alguien compre creyendo que tiene un recurso que no tiene.
 *
 * UN PEDIDO, UN PROVEEDOR. Si la bolsa mezcla, se pide elegir: repartir un cobro
 * entre proveedores exige saber quién responde de qué y cómo se liquida, y eso
 * no está decidido.
 *
 * EL DOBLE TOQUE ESTÁ BLOQUEADO EN DOS SITIOS: un cerrojo de referencia aquí
 * —`useState` se actualiza en el siguiente render y dos toques seguidos pasarían
 * los dos— y una clave de idempotencia que viaja al servidor, que es la que de
 * verdad impide que se creen dos pedidos.
 */
export function CheckoutDeProductosScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();

  const [preparacion, setPreparacion] = useState<Preparacion | null>(null);
  const [condiciones, setCondiciones] = useState<Condiciones | null>(null);
  const [elegido, setElegido] = useState<string | null>(null);
  const [acepta, setAcepta] = useState(false);
  const [verTexto, setVerTexto] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [creando, setCreando] = useState(false);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'noDisponible' | 'sinSesion' | null
  >(null);
  const ocupadoRef = useRef(false);
  /**
   * Si ya se intentó reservar con algo sin terminar.
   *
   * EL FORMULARIO NO NACE EN ROJO. Los campos obligatorios se marcaban como
   * error desde el primer render, antes de escribir una letra: nadie se había
   * equivocado todavía. Ahora se marcan después del primer intento, que es
   * cuando decir «esto falta» responde a algo.
   */
  const [intentado, setIntentado] = useState(false);
  /*
    LAS CONDICIONES PUEDEN NO ESTAR POR TRES MOTIVOS DISTINTOS, y los tres se
    leían como «todavía no hay condiciones publicadas para ese país»: mientras
    se pedían, cuando la petición fallaba y cuando de verdad no las hay. Solo
    lo último lo dice el servidor (`product_policy_not_configured`).
  */
  const [cargandoCondiciones, setCargandoCondiciones] = useState(false);
  const [falloDeCondiciones, setFalloDeCondiciones] = useState<string | null>(null);
  /** Sube al reintentar: es lo que vuelve a pedir las condiciones. */
  const [intentoDeCondiciones, setIntentoDeCondiciones] = useState(0);

  const [direccion, setDireccion] = useState<Partial<Direccion>>({
    country_code: '',
  });

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      const p = await ProductOrderRepository.preparacion();
      setPreparacion(p);
      const comprables = p.groups.filter((g) => g.purchasable);
      //: UNO SOLO SE ELIGE SOLO. Con varios NO se elige por nadie: cada pedido
      //: es de un proveedor, y decidirlo por su cuenta cobraría lo del que la
      //: aplicación hubiera puesto primero.
      const solo = comprables.length === 1 ? comprables[0] : undefined;
      if (solo !== undefined) setElegido((actual) => actual ?? solo.seller_id);
      //: EL PAÍS NO SE ADIVINA. Se propone el único donde hay condiciones
      //: publicadas cuando hay exactamente uno; con varios, lo escribe quien
      //: compra. Elegirlo por él mandaría el paquete a otro sitio.
      const unico = p.countries_with_policy.length === 1 ? p.countries_with_policy[0] : null;
      if (unico !== undefined && unico !== null) {
        setDireccion((d) => ({ ...d, country_code: d.country_code || unico }));
      }
    } catch (error) {
      if (error instanceof ApiError && esFaltaDeSesion(error.status)) setFallo('sinSesion');
      else if (error instanceof ApiError && esPedidoApagado(error.code)) setFallo('noDisponible');
      else if (error instanceof ApiError && esFalloDeRed(error.code)) setFallo('sinConexion');
      else setFallo('red');
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  //: LAS CONDICIONES SE PIDEN POR PAÍS, y se vuelven a pedir cuando cambia:
  //: son las de la jurisdicción de ENTREGA, no las del país de quien compra.
  const pais = (direccion.country_code ?? '').trim().toUpperCase();
  useEffect(() => {
    let vivo = true;
    if (pais.length !== 2) {
      setCondiciones(null);
      setCargandoCondiciones(false);
      setFalloDeCondiciones(null);
      return () => {
        vivo = false;
      };
    }
    setCargandoCondiciones(true);
    setFalloDeCondiciones(null);
    void (async () => {
      try {
        const c = await ProductOrderRepository.condiciones(pais);
        if (vivo) {
          setCondiciones(c);
          //: ACEPTAR SE PIERDE AL CAMBIAR DE PAÍS. Lo que se acepta es un texto
          //: concreto, y el de otro país es otro texto.
          setAcepta(false);
        }
      } catch (error) {
        if (vivo) {
          setCondiciones(null);
          setAcepta(false);
          //: «NO HAY» SOLO SI LO DICE EL SERVIDOR. Cualquier otra cosa —sin
          //: red, un 500— es un fallo de la petición: se dice y se reintenta.
          const noHay =
            error instanceof ApiError && error.code === 'product_policy_not_configured';
          setFalloDeCondiciones(noHay ? null : textoDelError(error));
        }
      } finally {
        if (vivo) setCargandoCondiciones(false);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [pais, intentoDeCondiciones]);

  const textoDelError = (error: unknown) => {
    if (error instanceof ApiError) {
      const dePedidos = claveDeErrorDePedidos(error.code);
      if (dePedidos !== null) return f(dePedidos);
      const porCodigo = claveDeErrorDeProductos(error.code);
      if (porCodigo !== null) return f(porCodigo);
      const porEstado = claveDeErrorPorEstado(error.status);
      if (porEstado !== null) return f(porEstado);
    }
    return error instanceof Error && error.message.trim() !== ''
      ? error.message
      : t('common.tryAgain');
  };

  const comprables = (preparacion?.groups ?? []).filter((g) => g.purchasable);
  const grupo = comprables.find((g) => g.seller_id === elegido) ?? null;
  const faltanCampos = camposIncompletos(direccion);
  const listo =
    grupo !== null &&
    condiciones !== null &&
    acepta &&
    direccionCompleta(direccion) &&
    preparacion?.disponible === true;

  const crear = () => {
    if (ocupadoRef.current || grupo === null || condiciones === null) return;
    //: SIN TERMINAR NO SE MANDA NADA: el toque enseña qué falta, campo por
    //: campo, y el pie ya dice si lo que falta es aceptar las condiciones.
    if (!listo) {
      setIntentado(true);
      return;
    }
    ocupadoRef.current = true;
    setCreando(true);
    void (async () => {
      try {
        const pedido = await ProductOrderRepository.crear({
          sellerId: grupo.seller_id,
          direccion: {
            recipient_name: (direccion.recipient_name ?? '').trim(),
            phone: (direccion.phone ?? '').trim(),
            country_code: pais,
            region: (direccion.region ?? '').trim(),
            city: (direccion.city ?? '').trim(),
            district: (direccion.district ?? '').trim() || null,
            address_line: (direccion.address_line ?? '').trim(),
            reference: (direccion.reference ?? '').trim() || null,
            postal_code: (direccion.postal_code ?? '').trim() || null,
            instructions: (direccion.instructions ?? '').trim() || null,
          },
          policyId: condiciones.policy_id,
          policySha256: condiciones.terms_sha256,
          clave: claveDeLaCompra(grupo.seller_id, Date.now()),
        });
        router.replace(`/productos/pedidos/${pedido.id}` as never);
      } catch (error) {
        notify(f('carrito.noSePudo'), textoDelError(error));
      } finally {
        ocupadoRef.current = false;
        setCreando(false);
      }
    })();
  };

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/productos/carrito' as never);

  const encabezado = <AppHeader title={f('pedidoDeProducto.checkout.titulo')} onBack={volver} />;

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        {fallo === 'sinSesion' ? (
          <StateView
            state="empty"
            icon="lock"
            title={f('carrito.error.sinSesion')}
            description={f('carrito.error.sinSesionCuerpo')}
          />
        ) : fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            icon="clock"
            title={f('pedidoDeProducto.error.noDisponible')}
            description={f('pedidoDeProducto.falta.migration_0078')}
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

  /*
    LO QUE FALTA, DICHO CON PALABRAS. Esta es la pantalla donde alguien
    descubre que no puede comprar, y merece saber por qué: no es un fallo suyo
    ni una avería, es que la empresa no ha terminado de configurar la venta.
  */
  const pendiente = preparacion?.pending_configuration ?? [];
  if (preparacion !== null && !preparacion.disponible) {
    return (
      <AppScreen scroll={false}>
        {encabezado}
        <ScrollView contentContainerStyle={styles.contenido}>
          <StateView
            state="empty"
            icon="clock"
            title={f('pedidoDeProducto.checkout.noSePuede')}
            description={f('carrito.todaviaNoSeCompra')}
          />
          <View style={[styles.bloque, { borderColor: colors.border }]}>
            <Text variant="titleMedium">{f('pedidoDeProducto.checkout.faltaTitulo')}</Text>
            {pendiente.map((clave) => (
              <View key={clave} style={styles.fila}>
                <Feather name="minus" size={14} color={colors.textMuted} />
                <Text variant="caption" color={colors.textMuted} style={styles.crece}>
                  {f(claveDeLoQueFalta(clave))}
                </Text>
              </View>
            ))}
          </View>
        </ScrollView>
      </AppScreen>
    );
  }

  if (comprables.length === 0) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        <StateView
          state="empty"
          icon="shopping-bag"
          title={f('pedidoDeProducto.checkout.bolsaVacia')}
          onRetry={() => void cargar()}
        />
      </AppScreen>
    );
  }

  const campo = (
    clave: keyof Direccion,
    opciones?: { multilinea?: boolean; teclado?: 'phone-pad' | 'default' },
  ) => (
    <Input
      key={clave}
      label={f(claveDelCampo(clave))}
      value={(direccion[clave] ?? '') as string}
      onChangeText={(valor: string) => setDireccion((d) => ({ ...d, [clave]: valor }))}
      editable={!creando}
      multiline={opciones?.multilinea === true}
      keyboardType={opciones?.teclado ?? 'default'}
      autoCapitalize={clave === 'country_code' ? 'characters' : 'sentences'}
      maxLength={clave === 'country_code' ? 2 : undefined}
      error={
        intentado && faltanCampos.includes(clave as never)
          ? f(claveDelCampo(clave))
          : undefined
      }
    />
  );

  const subtotal = subtotalDelGrupo(grupo);

  const plazo = (valor: number | null, unidad: 'dias' | 'horas') =>
    plazoConfigurado(valor)
      ? f(`pedidoDeProducto.condiciones.${unidad}`, { n: valor as number })
      : f('pedidoDeProducto.condiciones.pendiente');

  return (
    <AppScreen scroll={false}>
      {encabezado}
      <ScrollView contentContainerStyle={styles.contenido} showsVerticalScrollIndicator={false}>
        <Text variant="caption" color={colors.textMuted}>
          {f('pedidoDeProducto.checkout.cuerpo')}
        </Text>

        {/* 1. QUÉ LLEVAS, y de quién. Un pedido, un proveedor. */}
        <View style={[styles.bloque, { borderColor: colors.border }]}>
          <Text variant="titleMedium">{f('pedidoDeProducto.checkout.revisar')}</Text>
          {comprables.length > 1 ? (
            <Text variant="caption" color={colors.textMuted}>
              {f('pedidoDeProducto.checkout.variosProveedores')}
            </Text>
          ) : null}
          {comprables.map((g: GrupoDelCarrito) => {
            const suyo = subtotalDelGrupo(g);
            const activo = g.seller_id === elegido;
            return (
              <Pressable
                key={g.seller_id}
                onPress={() => setElegido(g.seller_id)}
                disabled={creando}
                accessibilityRole="radio"
                accessibilityState={{ selected: activo, disabled: creando }}
                accessibilityLabel={g.seller_name}
                style={[
                  styles.proveedor,
                  { borderColor: activo ? colors.primary : colors.border },
                ]}
              >
                <Feather
                  name={activo ? 'check-circle' : 'circle'}
                  size={18}
                  color={activo ? colors.primary : colors.textMuted}
                />
                <View style={styles.crece}>
                  <Text variant="secondary" weight="700">
                    {g.seller_name}
                  </Text>
                  <Text variant="caption" color={colors.textMuted}>
                    {f('pedidoDeProducto.checkout.unidades', { n: g.units })}
                  </Text>
                </View>
                <Text variant="secondary">
                  {suyo.configurado ? suyo.texto : f(CLAVE_SIN_IMPORTE)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* 2. A DÓNDE VA. */}
        <View style={[styles.bloque, { borderColor: colors.border }]}>
          <Text variant="titleMedium">{f('pedidoDeProducto.direccion.titulo')}</Text>
          <Text variant="caption" color={colors.textMuted}>
            {f('pedidoDeProducto.direccion.sinUbicacion')}
          </Text>
          {campo('recipient_name')}
          {campo('phone', { teclado: 'phone-pad' })}
          {campo('country_code')}
          {campo('region')}
          {campo('city')}
          {campo('district')}
          {campo('address_line', { multilinea: true })}
          {campo('reference')}
          {campo('postal_code')}
          {campo('instructions', { multilinea: true })}
        </View>

        {/* 3. LAS CONDICIONES. Sin ellas no se vende, y se dice. */}
        <View style={[styles.bloque, { borderColor: colors.border }]}>
          <Text variant="titleMedium">{f('pedidoDeProducto.condiciones.titulo')}</Text>
          {condiciones === null ? (
            cargandoCondiciones ? (
              <Text variant="caption" color={colors.textMuted}>
                {t('common.loading')}
              </Text>
            ) : falloDeCondiciones !== null ? (
              <>
                <InlineError message={falloDeCondiciones} />
                <Button
                  label={t('common.retry')}
                  variant="secondary"
                  onPress={() => setIntentoDeCondiciones((n) => n + 1)}
                />
              </>
            ) : (
              <Text variant="caption" color={colors.textMuted}>
                {f(
                  pais.length === 2
                    ? 'pedidoDeProducto.error.sinPolitica'
                    : 'pedidoDeProducto.condiciones.faltaElPais',
                )}
              </Text>
            )
          ) : (
            <>
              <View style={styles.dato}>
                <Text variant="caption" color={colors.textMuted}>
                  {f('pedidoDeProducto.condiciones.entidad')}
                </Text>
                <Text variant="secondary">{condiciones.seller_entity}</Text>
              </View>
              <Text variant="caption" color={colors.textMuted}>
                {f('pedidoDeProducto.condiciones.version', { n: condiciones.version })}
              </Text>

              {(
                [
                  ['desistimiento', condiciones.withdrawal_days, 'dias'],
                  ['incidencia', condiciones.incident_report_hours, 'horas'],
                  ['devolucion', condiciones.return_shipment_days, 'dias'],
                ] as Array<[string, number | null, 'dias' | 'horas']>
              ).map(([nombre, valor, unidad]) => (
                <View key={nombre} style={styles.dato}>
                  <Text variant="caption" color={colors.textMuted} style={styles.crece}>
                    {f(`pedidoDeProducto.condiciones.${nombre}`)}
                  </Text>
                  <Text variant="caption">{plazo(valor, unidad)}</Text>
                </View>
              ))}

              {(
                [
                  ['porteRemordimiento', condiciones.buyer_pays_return_for_remorse, 'comprador'],
                  ['porteDefecto', condiciones.seller_pays_return_for_defect, 'proveedor'],
                ] as Array<[string, boolean | null, 'comprador' | 'proveedor']>
              ).map(([nombre, valor, quien]) => (
                <View key={nombre} style={styles.dato}>
                  <Text variant="caption" color={colors.textMuted} style={styles.crece}>
                    {f(`pedidoDeProducto.condiciones.${nombre}`)}
                  </Text>
                  <Text variant="caption">
                    {valor === null || valor === undefined
                      ? f('pedidoDeProducto.condiciones.pendiente')
                      : valor
                        ? f(`pedidoDeProducto.condiciones.${quien}`)
                        : f(
                            `pedidoDeProducto.condiciones.${
                              quien === 'comprador' ? 'proveedor' : 'comprador'
                            }`,
                          )}
                  </Text>
                </View>
              ))}

              {/* COMPRA PROTEGIDA SOLO SI HAY PLAZO. Ver la cabecera. */}
              <Text variant="caption" color={colors.textMuted}>
                {sePuedeDecirCompraProtegida(condiciones)
                  ? f('pedidoDeProducto.compraProtegida', {
                      n: condiciones.incident_report_hours as number,
                    })
                  : f('pedidoDeProducto.sinCompraProtegida')}
              </Text>

              <Pressable
                onPress={() => setVerTexto((v) => !v)}
                accessibilityRole="button"
                accessibilityLabel={f('pedidoDeProducto.condiciones.leer')}
                style={styles.fila}
              >
                <Feather name={verTexto ? 'chevron-up' : 'chevron-down'} size={16} color={colors.text} />
                <Text variant="caption" weight="700">
                  {f('pedidoDeProducto.condiciones.leer')}
                </Text>
              </Pressable>
              {verTexto ? (
                <Text variant="caption" color={colors.textMuted}>
                  {condiciones.terms}
                </Text>
              ) : null}

              <Pressable
                onPress={() => setAcepta((v) => !v)}
                disabled={creando}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: acepta, disabled: creando }}
                accessibilityLabel={f('pedidoDeProducto.condiciones.acepto')}
                style={styles.fila}
              >
                <Feather
                  name={acepta ? 'check-square' : 'square'}
                  size={20}
                  color={acepta ? colors.primary : colors.textMuted}
                />
                <Text variant="caption" style={styles.crece}>
                  {f('pedidoDeProducto.condiciones.acepto')}
                </Text>
              </Pressable>
            </>
          )}
        </View>
      </ScrollView>

      {/*
        EL PIE. El subtotal que calculó el servidor, la verdad sobre impuestos y
        envío, y el botón que RESERVA. No dice «Pagar»: no paga.
      */}
      <View style={[styles.pie, { borderColor: colors.border }]}>
        <View style={styles.pieLinea}>
          <Text variant="secondary" color={colors.textMuted}>
            {f('pedidoDeProducto.checkout.subtotal')}
          </Text>
          <Text variant="titleMedium">
            {subtotal.configurado ? subtotal.texto : f(CLAVE_SIN_IMPORTE)}
          </Text>
        </View>
        <Text variant="caption" color={colors.textMuted}>
          {f('pedidoDeProducto.checkout.sinImpuestosNiEnvio')}
        </Text>
        {!acepta && condiciones !== null ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('pedidoDeProducto.condiciones.hayQueAceptar')}
          </Text>
        ) : null}
        {faltanCampos.length > 0 ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('pedidoDeProducto.direccion.faltan', {
              campos: faltanCampos.map((c) => f(claveDelCampo(c))).join(', '),
            })}
          </Text>
        ) : null}
        {/*
          APAGADO SOLO POR LO QUE UN TOQUE NO PUEDE EXPLICAR: que no haya
          proveedor elegido o que no haya condiciones que aceptar. Con la
          dirección a medias o sin aceptar, el toque no manda nada (`crear` lo
          comprueba) y marca lo que falta.
        */}
        <Button
          label={creando ? f('pedidoDeProducto.checkout.creando') : f('pedidoDeProducto.checkout.crear')}
          onPress={crear}
          disabled={creando || grupo === null || condiciones === null}
          loading={creando}
          icon="lock"
        />
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  bloque: {
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  proveedor: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    minHeight: 56,
  },
  fila: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: 44 },
  dato: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexWrap: 'wrap' },
  crece: { flex: 1 },
  pie: { gap: spacing.sm, borderTopWidth: 1, padding: spacing.lg },
  pieLinea: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
});
