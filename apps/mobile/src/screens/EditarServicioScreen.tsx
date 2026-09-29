import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { EstadoDelCatalogo } from '@/components/EstadoDelCatalogo';
import { Input } from '@/components/Input';
import { ListRow } from '@/components/ListRow';
import { SectionTitle } from '@/components/SectionTitle';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import {
  LARGOS,
  MODALIDADES,
  MODELOS_DE_PRECIO,
  MONEDAS,
  cambiosDelBorrador,
  categoriasEnArbol,
  claveDeLaModalidad,
  claveDelModeloDePrecio,
  claveDelRequisito,
  esReenvio,
  etiquetaDeCategoria,
  formularioDesde,
  llevaImporte,
  type Categoria,
  type Fallo,
  type FormularioDelServicio,
} from '@/lib/serviciosCatalogo';
import { useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { useParametroDeRuta, useServicioPropio } from '@/hooks/useCatalogoDeServicios';
import { ServiceCatalogRepository } from '@/repositories/ServiceCatalogRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * «Completar información»: el contenido del BORRADOR, por secciones.
 *
 * - SOLO VIAJA LO QUE CAMBIÓ, y nunca un estado. Guardar a medias no exige
 *   nada: lo que falta para ENVIAR lo dice el servidor (`missing`), y se
 *   enseña debajo después de cada guardado.
 * - GRATIS NO ES «SIN PRECIO»: el modelo se elige expresamente, y el importe
 *   solo se pide en «precio fijo» y «desde».
 * - LA CATEGORÍA solo se cambia mientras el servicio nunca se publicó.
 * - SALIR CON CAMBIOS SIN GUARDAR PREGUNTA ANTES: no se pierde lo escrito.
 * - Si Z pidió cambios, los campos que señaló llevan la marca.
 */
export function EditarServicioScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('serviceId');
  const { f, idioma } = useTextosDeServicios('catalogo');
  const { servicio, setServicio, fallo, cargar } = useServicioPropio(id);
  const { ocupado, correr } = useCerrojo(cargar, 'catalogo');
  const [formulario, setFormulario] = useState<FormularioDelServicio | null>(null);
  const [fallos, setFallos] = useState<Fallo[]>([]);
  const [categorias, setCategorias] = useState<Categoria[]>([]);

  // El formulario nace UNA vez del servidor; recargar al volver no pisa lo escrito.
  useEffect(() => {
    if (servicio?.open_version && formulario === null) {
      setFormulario(formularioDesde(servicio.open_version, servicio.category.id));
    }
  }, [servicio, formulario]);

  const categoriaCambiable = servicio !== null && servicio.first_published_at === null;
  useEffect(() => {
    if (!categoriaCambiable) return;
    let vigente = true;
    // Sin la lista, la categoría simplemente no se ofrece: no es un fallo.
    ServiceCatalogRepository.categorias()
      .then((lista) => vigente && setCategorias(lista))
      .catch(() => undefined);
    return () => {
      vigente = false;
    };
  }, [categoriaCambiable]);

  const ruta = `/servicios/prestador/catalogo/${id}`;
  const sinGuardar =
    servicio?.open_version && formulario
      ? Object.keys(
          cambiosDelBorrador(formulario, servicio.open_version, servicio.category.id, { categoriaCambiable }).cambios,
        ).length > 0
      : false;

  const salir = async (destino?: string) => {
    if (sinGuardar) {
      const si = await confirm({
        title: f('servicios.catalogo.editar.salirTitulo'),
        message: f('servicios.catalogo.editar.salirAviso'),
        confirmLabel: f('servicios.catalogo.editar.descartar'),
        destructive: true,
      });
      if (!si) return;
    }
    if (destino) router.push(destino as never);
    else if (router.canGoBack()) router.back();
    else router.replace(ruta as never);
  };
  const titulo = f('servicios.catalogo.paso.informacion');

  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={() => void salir()} />
        <EstadoDelCatalogo fallo={fallo} onRetry={() => void cargar()} />
      </AppScreen>
    );
  }
  if (servicio === null || (servicio.can_edit && formulario === null)) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={() => void salir()} />
        <StateView state="loading" />
      </AppScreen>
    );
  }
  if (!servicio.can_edit || !servicio.open_version || formulario === null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={() => void salir()} />
        <StateView
          state="empty"
          icon="lock"
          title={f('servicios.catalogo.editar.noEditable')}
          description={f('servicios.catalogo.editar.noEditableCuerpo')}
          actionLabel={f('servicios.catalogo.servicio')}
          onAction={() => router.replace(ruta as never)}
        />
      </AppScreen>
    );
  }

  const version = servicio.open_version;
  const senalados = esReenvio(servicio) ? (servicio.last_observation?.fields ?? []) : [];
  const error = (campo: string) => {
    const hallado = fallos.find((x) => x.campo === campo);
    return hallado ? f(hallado.clave) : undefined;
  };
  const etiqueta = (clave: string, senal: string) =>
    senalados.includes(senal) ? `${f(clave)} · ${f('servicios.catalogo.editar.corregir')}` : f(clave);
  const cambiar = (campo: keyof FormularioDelServicio) => (valor: string) =>
    setFormulario((actual) => (actual ? { ...actual, [campo]: valor } : actual));

  const guardar = () => {
    const { cambios, fallos: encontrados } = cambiosDelBorrador(formulario, version, servicio.category.id, {
      categoriaCambiable,
    });
    setFallos(encontrados);
    if (encontrados.length > 0) {
      toast(f('servicios.catalogo.editar.revisaLosCampos'));
      return;
    }
    if (Object.keys(cambios).length === 0) {
      toast(f('servicios.validacion.sinCambios'));
      return;
    }
    void correr(async () => {
      const nuevo = await ServiceCatalogRepository.guardarBorrador(servicio.id, cambios);
      setServicio(nuevo);
      if (nuevo.open_version) setFormulario(formularioDesde(nuevo.open_version, nuevo.category.id));
      toast(f('servicios.catalogo.editar.guardado'));
    });
  };

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={() => void salir()} />
      <Text variant="secondary">{f('servicios.catalogo.editar.intro')}</Text>

      {/* Lo básico */}
      <SectionTitle title={f('servicios.catalogo.editar.seccionBasico')} />
      {categoriaCambiable && categorias.length > 0 ? (
        <>
          <Text weight="600">{etiqueta('servicios.catalogo.campo.category', 'category')}</Text>
          <View style={styles.fila} accessibilityRole="radiogroup">
            {categoriasEnArbol(categorias).map((c) => (
              <Chip
                key={c.id}
                rol="radio"
                label={etiquetaDeCategoria(c, categorias, idioma)}
                selected={formulario.categoria === c.id}
                onPress={() => setFormulario({ ...formulario, categoria: c.id })}
              />
            ))}
          </View>
        </>
      ) : (
        <Text variant="caption" color={colors.textMuted}>
          {f('servicios.catalogo.editar.categoriaFija')}
        </Text>
      )}
      <Input
        label={etiqueta('servicios.catalogo.campo.title', 'title')}
        value={formulario.titulo}
        onChangeText={cambiar('titulo')}
        maxLength={LARGOS.titulo[1]}
        error={error('titulo')}
      />
      <Input
        label={etiqueta('servicios.catalogo.campo.summary', 'summary')}
        value={formulario.resumen}
        onChangeText={cambiar('resumen')}
        maxLength={LARGOS.resumen[1]}
        multiline
        error={error('resumen')}
        placeholder={f('servicios.catalogo.editar.resumenAyuda')}
      />
      <Input
        label={etiqueta('servicios.catalogo.campo.description', 'description')}
        value={formulario.descripcion}
        onChangeText={cambiar('descripcion')}
        maxLength={LARGOS.descripcion[1]}
        multiline
        error={error('descripcion')}
      />

      {/* Cómo se presta */}
      <SectionTitle title={f('servicios.catalogo.editar.seccionModalidad')} />
      <Text weight="600">{etiqueta('servicios.catalogo.campo.modality', 'modality')}</Text>
      <View style={styles.fila} accessibilityRole="radiogroup">
        {MODALIDADES.map((m) => (
          <Chip
            key={m}
            rol="radio"
            label={f(claveDeLaModalidad(m))}
            selected={formulario.modalidad === m}
            onPress={() => setFormulario({ ...formulario, modalidad: m })}
          />
        ))}
      </View>
      {formulario.modalidad !== null && formulario.modalidad !== 'virtual' ? (
        <Input
          label={etiqueta('servicios.catalogo.campo.location_area', 'location_area')}
          value={formulario.zona}
          onChangeText={cambiar('zona')}
          maxLength={LARGOS.zona[1]}
          error={error('zona')}
          placeholder={f('servicios.catalogo.editar.zonaAyuda')}
        />
      ) : null}
      <Input
        label={etiqueta('servicios.catalogo.editar.duracion', 'duration')}
        value={formulario.duracion}
        onChangeText={(v) => cambiar('duracion')(v.replace(/[^0-9]/g, ''))}
        keyboardType="number-pad"
        maxLength={4}
        error={error('duracion')}
      />
      <Input
        label={etiqueta('servicios.catalogo.editar.capacidad', 'capacity')}
        value={formulario.capacidad}
        onChangeText={(v) => cambiar('capacidad')(v.replace(/[^0-9]/g, ''))}
        keyboardType="number-pad"
        maxLength={4}
        error={error('capacidad')}
      />

      {/* El precio */}
      <SectionTitle title={f('servicios.catalogo.editar.seccionPrecio')} />
      <Text weight="600">{etiqueta('servicios.catalogo.campo.price', 'price')}</Text>
      <View style={styles.fila} accessibilityRole="radiogroup">
        {MODELOS_DE_PRECIO.map((m) => (
          <Chip
            key={m}
            rol="radio"
            label={f(claveDelModeloDePrecio(m))}
            selected={formulario.modeloDePrecio === m}
            onPress={() => setFormulario({ ...formulario, modeloDePrecio: m })}
          />
        ))}
      </View>
      {llevaImporte(formulario.modeloDePrecio) ? (
        <>
          <Input
            label={f('servicios.catalogo.editar.importe')}
            value={formulario.importe}
            onChangeText={cambiar('importe')}
            keyboardType="decimal-pad"
            maxLength={14}
            error={error('importe')}
            placeholder={f('servicios.catalogo.editar.importeAyuda')}
          />
          <Text weight="600">{f('servicios.catalogo.editar.moneda')}</Text>
          <View style={styles.fila} accessibilityRole="radiogroup">
            {MONEDAS.map((m) => (
              <Chip
                key={m}
                rol="radio"
                label={m}
                selected={formulario.moneda === m}
                onPress={() => setFormulario({ ...formulario, moneda: m })}
              />
            ))}
          </View>
          {error('moneda') ? (
            <Text variant="caption" color={colors.danger}>
              {error('moneda')}
            </Text>
          ) : null}
        </>
      ) : null}
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.catalogo.editar.sinCobros')}
      </Text>

      {/* Qué incluye */}
      <SectionTitle title={f('servicios.catalogo.editar.seccionAlcance')} />
      <Input
        label={etiqueta('servicios.catalogo.campo.scope', 'scope')}
        value={formulario.alcance}
        onChangeText={cambiar('alcance')}
        maxLength={LARGOS.alcance[1]}
        multiline
        error={error('alcance')}
        placeholder={f('servicios.catalogo.editar.alcanceAyuda')}
      />
      <Input
        label={etiqueta('servicios.catalogo.campo.includes', 'includes')}
        value={formulario.incluye}
        onChangeText={cambiar('incluye')}
        multiline
        error={error('incluye')}
        placeholder={f('servicios.catalogo.editar.unaPorLinea')}
      />
      <Input
        label={etiqueta('servicios.catalogo.campo.excludes', 'excludes')}
        value={formulario.excluye}
        onChangeText={cambiar('excluye')}
        multiline
        error={error('excluye')}
        placeholder={f('servicios.catalogo.editar.unaPorLinea')}
      />
      <Input
        label={etiqueta('servicios.catalogo.campo.requirements', 'requirements')}
        value={formulario.requisitos}
        onChangeText={cambiar('requisitos')}
        maxLength={LARGOS.requisitos[1]}
        multiline
        error={error('requisitos')}
        placeholder={f('servicios.catalogo.editar.requisitosAyuda')}
      />
      <Input
        label={etiqueta('servicios.catalogo.editar.condiciones', 'conditions')}
        value={formulario.condiciones}
        onChangeText={cambiar('condiciones')}
        maxLength={LARGOS.condiciones[1]}
        multiline
        error={error('condiciones')}
      />

      <Button
        label={f('servicios.catalogo.editar.guardar')}
        icon="save"
        loading={ocupado}
        disabled={ocupado}
        onPress={guardar}
      />
      {sinGuardar ? (
        <Text variant="caption" color={colors.textMuted}>
          {f('servicios.catalogo.editar.sinGuardar')}
        </Text>
      ) : null}

      {servicio.missing.length > 0 ? (
        <View style={[styles.tarjeta, { borderColor: colors.border }]}>
          <Text weight="700">{f('servicios.catalogo.faltan')}</Text>
          {servicio.missing.map((codigo) => (
            <Text key={codigo} variant="secondary">
              {`• ${f(claveDelRequisito(codigo))}`}
            </Text>
          ))}
        </View>
      ) : null}
      <ListRow
        title={f('servicios.catalogo.paso.imagenes')}
        leftIcon="image"
        rightIcon="chevron-right"
        onPress={() => void salir(`${ruta}/imagenes`)}
      />
      <ListRow
        title={f('servicios.catalogo.revisarYEnviar')}
        leftIcon="send"
        rightIcon="chevron-right"
        onPress={() => void salir(`${ruta}/enviar`)}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  fila: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tarjeta: { gap: spacing.xs, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
});
