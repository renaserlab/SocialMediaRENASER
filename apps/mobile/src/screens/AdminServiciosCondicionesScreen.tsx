import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { Input } from '@/components/Input';
import { SectionTitle } from '@/components/SectionTitle';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import {
  REPOSTULACIONES,
  TIPOS_DE_CREDENCIAL,
  TIPOS_DE_DOCUMENTO,
  alternar,
  claveDelEstadoDePolitica,
  claveDelTipoDeCredencial,
  claveDelTipoDeDocumento,
  condicionesDesde,
  condicionesVacias,
  fechaCorta,
  huellaCorta,
  peticionDeCondiciones,
  type FalloDeCarga,
  type Fallo,
  type FormularioDeCondiciones,
  type Politica,
  type Terminos,
  type TipoDePolitica,
} from '@/lib/serviciosAdmision';
import { leerFallo, useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceAdmissionRepository } from '@/repositories/ServiceAdmissionRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Las condiciones del prestador: versiones, borrador, vista previa y
 * publicación.
 *
 * - UNA PUBLICADA NO SE EDITA: se publica otra versión, que supera a la
 *   anterior en la misma transacción. Quien ya aceptó sigue apuntando a la
 *   versión que aceptó; al enviar tendrá que aceptar la nueva.
 * - CREAR, EDITAR Y PUBLICAR ES DE ADMINISTRACIÓN; moderación solo mira. Lo
 *   decide el servidor; aquí se enseña su respuesta.
 * - NADA SE SIEMBRA: sin una versión publicada, nadie puede enviar su
 *   postulación, y es lo correcto hasta que la empresa escriba el texto.
 *
 * La MISMA pantalla sirve las condiciones de CONTRATACIÓN (`booking_terms`,
 * Incremento 5), las que acepta quien contrata: un texto sin parámetros. Sin
 * una publicada para el país del prestador, ninguna reserva se confirma.
 */
export function AdminServiciosCondicionesScreen({ tipo = 'provider_terms' }: { tipo?: TipoDePolitica } = {}) {
  const deContratacion = tipo === 'booking_terms';
  const { colors } = useAppTheme();
  const router = useRouter();
  const { f } = useTextosDeServicios();
  const [politicas, setPoliticas] = useState<Politica[] | null>(null);
  const [fallo, setFallo] = useState<FalloDeCarga | null>(null);
  const [formulario, setFormulario] = useState<FormularioDeCondiciones | null>(null);
  const [editando, setEditando] = useState<Politica | null>(null);
  const [fallos, setFallos] = useState<Fallo[]>([]);
  const [vista, setVista] = useState<Terminos | null>(null);

  const cargar = useCallback(async () => {
    setFallo(null);
    try {
      setPoliticas(await ServiceAdmissionRepository.condiciones(null, tipo));
    } catch (error) {
      setFallo(leerFallo(error));
    }
  }, [tipo]);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );
  const { ocupado, correr } = useCerrojo(cargar);

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/admin/servicios' as never));
  const titulo = f(deContratacion ? 'servicios.politica.tituloContratacion' : 'servicios.politica.titulo');

  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <EstadoDeServicios fallo={fallo} onRetry={() => void cargar()} />
      </AppScreen>
    );
  }
  if (politicas === null) {
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

  const guardar = () => {
    if (formulario === null) return;
    const { peticion: leida, fallos: encontrados } = peticionDeCondiciones(formulario);
    setFallos(encontrados);
    if (leida === null) return;
    // Las de contratación no llevan parámetros (el servidor rechaza cualquiera).
    const peticion = deContratacion ? { ...leida, parameters: {} } : leida;
    void correr(async () => {
      if (editando) {
        await ServiceAdmissionRepository.editarBorrador(editando.id, {
          title: peticion.title,
          body: peticion.body,
          parameters: peticion.parameters,
        });
      } else {
        const creada = await ServiceAdmissionRepository.crearBorrador(peticion, tipo);
        // Si ya había un borrador de ese país, el servidor devuelve ESE, sin
        // tocarlo. Ni se dice «guardado» ni se tira lo escrito: el formulario
        // pasa a editar ese borrador, y guardar otra vez lo reemplaza.
        if (creada.title !== peticion.title || creada.body !== peticion.body) {
          setEditando(creada);
          toast(f('servicios.politica.yaHabiaBorrador'));
          await cargar();
          return;
        }
      }
      setFormulario(null);
      setEditando(null);
      toast(f('servicios.politica.guardada'));
      await cargar();
    });
  };

  const verPrevia = (p: Politica) =>
    void correr(async () => {
      setVista(await ServiceAdmissionRepository.vistaPrevia(p.id));
    });

  const publicar = (p: Politica) =>
    void correr(async () => {
      const si = await confirm({
        title: f('servicios.politica.publicarTitulo'),
        message: f('servicios.politica.publicarAviso', { pais: p.country_code, version: p.version }),
        confirmLabel: f('servicios.politica.publicar'),
      });
      if (!si) return;
      await ServiceAdmissionRepository.publicar(p.id);
      toast(f('servicios.politica.publicada'));
      setVista(null);
      await cargar();
    });

  return (
    <AppScreen teclado contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />
      <Text variant="caption" color={colors.textMuted}>
        {f(deContratacion ? 'servicios.politica.introContratacion' : 'servicios.politica.intro')}
      </Text>

      {formulario === null ? (
        <Button
          label={f('servicios.politica.nuevoBorrador')}
          icon="plus"
          variant="secondary"
          onPress={() => {
            setEditando(null);
            setFallos([]);
            setFormulario(condicionesVacias());
          }}
        />
      ) : (
        <View style={[styles.tarjeta, { borderColor: colors.primary }]}>
          <Input
            label={f('servicios.campo.country_code')}
            value={formulario.pais}
            onChangeText={(v) => setFormulario({ ...formulario, pais: v.toUpperCase() })}
            autoCapitalize="characters"
            maxLength={2}
            editable={editando === null}
            error={error('pais')}
          />
          <Input
            label={f('servicios.politica.tituloDelTexto')}
            value={formulario.titulo}
            onChangeText={(v) => setFormulario({ ...formulario, titulo: v })}
            maxLength={200}
            error={error('titulo')}
          />
          <Input
            label={f('servicios.politica.texto')}
            value={formulario.texto}
            onChangeText={(v) => setFormulario({ ...formulario, texto: v })}
            multiline
            error={error('texto')}
          />
          {deContratacion ? null : (
          <>
          <Text weight="600">{f('servicios.politica.repostulacion')}</Text>
          <View style={styles.acciones} accessibilityRole="radiogroup">
            {REPOSTULACIONES.map((opcion) => (
              <Chip
                key={opcion}
                rol="radio"
                label={f(`servicios.politica.repostular.${opcion}`)}
                selected={formulario.repostulacion === opcion}
                onPress={() => setFormulario({ ...formulario, repostulacion: opcion })}
              />
            ))}
          </View>
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.politica.documentosBase')}
          </Text>
          <Text weight="600">{f('servicios.politica.documentosPersona')}</Text>
          <View style={styles.acciones}>
            {TIPOS_DE_DOCUMENTO.map((tipo) => (
              <Chip
                key={tipo}
                label={f(claveDelTipoDeDocumento(tipo))}
                selected={formulario.documentosPersona.includes(tipo)}
                onPress={() =>
                  setFormulario({ ...formulario, documentosPersona: alternar(formulario.documentosPersona, tipo) })
                }
              />
            ))}
          </View>
          <Text weight="600">{f('servicios.politica.documentosEmpresa')}</Text>
          <View style={styles.acciones}>
            {TIPOS_DE_DOCUMENTO.map((tipo) => (
              <Chip
                key={tipo}
                label={f(claveDelTipoDeDocumento(tipo))}
                selected={formulario.documentosEmpresa.includes(tipo)}
                onPress={() =>
                  setFormulario({ ...formulario, documentosEmpresa: alternar(formulario.documentosEmpresa, tipo) })
                }
              />
            ))}
          </View>
          <Text weight="600">{f('servicios.politica.credencialesExigidas')}</Text>
          <View style={styles.acciones}>
            {TIPOS_DE_CREDENCIAL.map((tipo) => (
              <Chip
                key={tipo}
                label={f(claveDelTipoDeCredencial(tipo))}
                selected={formulario.credenciales.includes(tipo)}
                onPress={() =>
                  setFormulario({ ...formulario, credenciales: alternar(formulario.credenciales, tipo) })
                }
              />
            ))}
          </View>
          </>
          )}
          <View style={styles.acciones}>
            <Button label={f('servicios.politica.guardarBorrador')} icon="save" loading={ocupado} disabled={ocupado} onPress={guardar} />
            <Button label={f('servicios.retirar.cancelar')} variant="ghost" onPress={() => setFormulario(null)} />
          </View>
        </View>
      )}

      {vista !== null ? (
        <View style={[styles.tarjeta, { borderColor: colors.border }]}>
          <Text weight="700">{vista.title}</Text>
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.condiciones.huella', { huella: huellaCorta(vista.sha256) })}
          </Text>
          <Text selectable>{vista.body}</Text>
          <Button label={f('servicios.politica.cerrarVista')} variant="ghost" onPress={() => setVista(null)} />
        </View>
      ) : null}

      <SectionTitle title={f('servicios.politica.versiones')} />
      {politicas.length === 0 ? (
        <StateView
          state="empty"
          icon="file-text"
          title={f('servicios.politica.ninguna')}
          description={f(deContratacion ? 'servicios.politica.ningunaContratacionCuerpo' : 'servicios.politica.ningunaCuerpo')}
        />
      ) : (
        politicas.map((p) => (
          <View key={p.id} style={[styles.tarjeta, { borderColor: colors.border }]}>
            <Text weight="600">{`${p.country_code} · v${p.version} · ${p.title}`}</Text>
            <Text variant="caption" color={colors.textMuted}>
              {`${f(claveDelEstadoDePolitica(p.status))}${p.published_at ? ` · ${fechaCorta(p.published_at)}` : ''} · ${huellaCorta(p.body_sha256)}`}
            </Text>
            <View style={styles.acciones}>
              <Button label={f('servicios.politica.vistaPrevia')} variant="ghost" icon="eye" disabled={ocupado} onPress={() => verPrevia(p)} />
              {p.status === 'draft' ? (
                <>
                  <Button
                    label={f('servicios.politica.editar')}
                    variant="ghost"
                    icon="edit-3"
                    disabled={ocupado}
                    onPress={() => {
                      setEditando(p);
                      setFallos([]);
                      setFormulario(condicionesDesde(p));
                    }}
                  />
                  <Button label={f('servicios.politica.publicar')} variant="ghost" icon="upload-cloud" disabled={ocupado} onPress={() => publicar(p)} />
                </>
              ) : null}
            </View>
          </View>
        ))
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  tarjeta: { gap: spacing.sm, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
  acciones: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
});
