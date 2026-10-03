import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { EstadoDelCatalogo } from '@/components/EstadoDelCatalogo';
import { Input } from '@/components/Input';
import { ListRow } from '@/components/ListRow';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import {
  categoriaDesde,
  categoriaVacia,
  categoriasEnArbol,
  etiquetaDeCategoria,
  madresPosibles,
  nombreDeLaCategoria,
  peticionDeCategoria,
  type Categoria,
  type Fallo,
  type FalloDelCatalogo,
  type FormularioDeCategoria,
} from '@/lib/serviciosCatalogo';
import { leerFalloDelCatalogo, useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceCatalogAdminRepository } from '@/repositories/ServiceCatalogAdminRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/** Qué se está editando: una nueva, una existente, o nada. */
type Editando = { original: Categoria | null } | null;

/**
 * Las categorías del catálogo de Servicios, para el equipo de Z.
 *
 * - DOS NIVELES como mucho: una categoría puede tener madre, y la madre no.
 * - EL SLUG SE ELIGE AL CREAR Y NO CAMBIA; el estado se cambia con sus dos
 *   botones, nunca en el formulario.
 * - DESACTIVAR NO BORRA: deja de aceptar servicios nuevos y envíos, y los que
 *   ya la usan la siguen nombrando. Se pregunta antes.
 * - No hay categorías de fábrica: las crea la empresa.
 * - Moderación las ve; solo administración las cambia (lo dice el servidor).
 */
export function AdminCategoriasDeServiciosScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { f, idioma } = useTextosDeServicios('catalogo');
  const [categorias, setCategorias] = useState<Categoria[] | null>(null);
  const [fallo, setFallo] = useState<FalloDelCatalogo | null>(null);
  const [editando, setEditando] = useState<Editando>(null);
  const [formulario, setFormulario] = useState<FormularioDeCategoria>(categoriaVacia());
  const [fallos, setFallos] = useState<Fallo[]>([]);

  const cargar = useCallback(async () => {
    setFallo(null);
    try {
      setCategorias(await ServiceCatalogAdminRepository.categorias());
    } catch (error) {
      setFallo(leerFalloDelCatalogo(error));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );
  const { ocupado, correr } = useCerrojo(cargar, 'catalogo');

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/admin/servicios/catalogo' as never);
  const titulo = f('servicios.catalogo.categorias.titulo');

  const abrir = (original: Categoria | null) => {
    setEditando({ original });
    setFormulario(original ? categoriaDesde(original) : categoriaVacia());
    setFallos([]);
  };

  const guardar = () => {
    if (editando === null) return;
    const { original } = editando;
    const { peticion, fallos: encontrados } = peticionDeCategoria(formulario, original);
    setFallos(encontrados);
    if (peticion === null) return;
    void correr(async () => {
      if (original) await ServiceCatalogAdminRepository.editarCategoria(original.id, peticion);
      else await ServiceCatalogAdminRepository.crearCategoria(peticion);
      setEditando(null);
      toast(f(original ? 'servicios.catalogo.categorias.guardada' : 'servicios.catalogo.categorias.creada'));
      await cargar();
    });
  };

  const cambiarEstado = (categoria: Categoria, activar: boolean) =>
    void correr(async () => {
      if (!activar) {
        const si = await confirm({
          title: f('servicios.catalogo.categorias.desactivarTitulo'),
          message: f('servicios.catalogo.categorias.desactivarAviso'),
          confirmLabel: f('servicios.catalogo.categorias.desactivar'),
          destructive: true,
        });
        if (!si) return;
        await ServiceCatalogAdminRepository.desactivarCategoria(categoria.id);
      } else {
        await ServiceCatalogAdminRepository.activarCategoria(categoria.id);
      }
      setEditando(null);
      toast(f(activar ? 'servicios.catalogo.categorias.activada' : 'servicios.catalogo.categorias.desactivada'));
      await cargar();
    });

  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <EstadoDelCatalogo fallo={fallo} onRetry={() => void cargar()} />
      </AppScreen>
    );
  }
  if (categorias === null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  const error = (campo: string) => {
    const hallado = fallos.find((x) => x.campo === campo);
    return hallado ? f(hallado.clave) : undefined;
  };
  const cambiar = (campo: keyof FormularioDeCategoria) => (valor: string) =>
    setFormulario((actual) => ({ ...actual, [campo]: valor }));
  const original = editando?.original ?? null;

  return (
    <AppScreen teclado contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.catalogo.categorias.intro')}
      </Text>
      <Button
        label={f('servicios.catalogo.categorias.nueva')}
        icon="plus"
        variant="secondary"
        disabled={ocupado}
        onPress={() => abrir(null)}
      />

      {editando !== null ? (
        <View style={[styles.tarjeta, { borderColor: colors.primary }]}>
          <Text weight="700">
            {original
              ? f('servicios.catalogo.categorias.editar', { nombre: nombreDeLaCategoria(original, idioma) })
              : f('servicios.catalogo.categorias.nueva')}
          </Text>
          {original ? (
            <Text variant="caption" color={colors.textMuted}>
              {f('servicios.catalogo.categorias.slugFijo', { slug: original.slug })}
            </Text>
          ) : (
            <Input
              label={f('servicios.catalogo.categorias.slug')}
              value={formulario.slug}
              onChangeText={(v) => cambiar('slug')(v.toLowerCase())}
              autoCapitalize="none"
              maxLength={60}
              placeholder={f('servicios.catalogo.categorias.slugAyuda')}
              error={error('slug')}
            />
          )}
          <Input
            label={f('servicios.catalogo.categorias.nombre')}
            value={formulario.nombre}
            onChangeText={cambiar('nombre')}
            maxLength={80}
            error={error('nombre')}
          />
          <Input
            label={f('servicios.catalogo.categorias.nombreEn')}
            value={formulario.nombreEn}
            onChangeText={cambiar('nombreEn')}
            maxLength={80}
            error={error('nombreEn')}
          />
          <Input
            label={f('servicios.catalogo.categorias.nombrePt')}
            value={formulario.nombrePt}
            onChangeText={cambiar('nombrePt')}
            maxLength={80}
            error={error('nombrePt')}
          />
          <Input
            label={f('servicios.catalogo.categorias.descripcion')}
            value={formulario.descripcion}
            onChangeText={cambiar('descripcion')}
            maxLength={280}
            multiline
            error={error('descripcion')}
          />
          <Input
            label={f('servicios.catalogo.categorias.icono')}
            value={formulario.icono}
            onChangeText={(v) => cambiar('icono')(v.toLowerCase())}
            autoCapitalize="none"
            maxLength={40}
            placeholder={f('servicios.catalogo.categorias.iconoAyuda')}
            error={error('icono')}
          />
          <Input
            label={f('servicios.catalogo.categorias.pais')}
            value={formulario.pais}
            onChangeText={(v) => cambiar('pais')(v.toUpperCase())}
            autoCapitalize="characters"
            maxLength={2}
            placeholder={f('servicios.catalogo.categorias.paisAyuda')}
            error={error('pais')}
          />
          <Input
            label={f('servicios.catalogo.categorias.orden')}
            value={formulario.orden}
            onChangeText={(v) => cambiar('orden')(v.replace(/[^0-9]/g, ''))}
            keyboardType="number-pad"
            maxLength={6}
            error={error('orden')}
          />
          <Text weight="600">{f('servicios.catalogo.categorias.madre')}</Text>
          <View style={styles.fila} accessibilityRole="radiogroup">
            <Chip
              rol="radio"
              label={f('servicios.catalogo.categorias.sinMadre')}
              selected={formulario.madre === null}
              onPress={() => setFormulario({ ...formulario, madre: null })}
            />
            {madresPosibles(categorias, original?.id ?? null).map((c) => (
              <Chip
                key={c.id}
                rol="radio"
                label={nombreDeLaCategoria(c, idioma)}
                selected={formulario.madre === c.id}
                onPress={() => setFormulario({ ...formulario, madre: c.id })}
              />
            ))}
          </View>
          {error('formulario') ? (
            <Text variant="caption" color={colors.danger}>
              {error('formulario')}
            </Text>
          ) : null}
          <View style={styles.fila}>
            <Button
              label={f('servicios.catalogo.categorias.guardar')}
              icon="save"
              loading={ocupado}
              disabled={ocupado}
              onPress={guardar}
            />
            {original ? (
              <Button
                label={f(
                  original.status === 'active'
                    ? 'servicios.catalogo.categorias.desactivar'
                    : 'servicios.catalogo.categorias.activar',
                )}
                variant="secondary"
                disabled={ocupado}
                onPress={() => cambiarEstado(original, original.status !== 'active')}
              />
            ) : null}
            <Button label={f('servicios.retirar.cancelar')} variant="ghost" onPress={() => setEditando(null)} />
          </View>
        </View>
      ) : null}

      {categorias.length === 0 ? (
        <StateView
          state="empty"
          icon="grid"
          title={f('servicios.catalogo.categorias.ninguna')}
          description={f('servicios.catalogo.categorias.ningunaCuerpo')}
        />
      ) : (
        categoriasEnArbol(categorias).map((c) => (
          <ListRow
            key={c.id}
            title={etiquetaDeCategoria(c, categorias, idioma)}
            subtitle={`${c.slug} · ${f(
              c.status === 'active' ? 'servicios.catalogo.categorias.activa' : 'servicios.catalogo.categorias.inactiva',
            )}${c.country_code ? ` · ${c.country_code}` : ''}`}
            leftIcon={c.status === 'active' ? 'check-circle' : 'slash'}
            rightIcon="edit-3"
            onPress={() => abrir(c)}
          />
        ))
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  tarjeta: { gap: spacing.sm, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
  fila: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
