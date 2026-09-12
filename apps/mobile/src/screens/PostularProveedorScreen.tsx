import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import { toast } from '@/lib/toast';
import {
  DOCUMENTOS,
  LARGO_DEL_NOMBRE,
  LARGO_DE_LA_NOTA,
  LARGO_DE_LA_PROPUESTA,
  LARGO_DE_LA_RUTA,
  MAXIMO_DE_DOCUMENTOS,
  claveDeErrorDeProveedor,
  claveDeErrorPorEstado,
  claveDeFallo,
  claveDeLaSituacion,
  claveDelCuerpoDeLaSituacion,
  claveDelEstadoDePostulacion,
  claveDelCuerpoDelEstadoDePostulacion,
  claveDelTipoDeDocumento,
  documentoVacio,
  esProductosApagado,
  fechaLegible,
  formularioDePostulacionDesde,
  formularioDePostulacionVacio,
  hayQueRecargar,
  motivoDeLaDecision,
  peticionDePostulacion,
  sePuedeEnviarPostulacion,
  sePuedeEscribirPostulacion,
  sePuedeRetirarPostulacion,
  situacionDelProveedor,
  validarPostulacion,
  type EstadoDelProveedor,
  type Fallo,
  type FormularioDePostulacion,
} from '@/lib/proveedorDeProductos';
import { ProductSellerRepository } from '@/repositories/ProductSellerRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * «Postula tu producto»: la admisión de quien produce.
 *
 * LO QUE ESTA PANTALLA DICE Y NO ADIVINA. El estado sale del contrato entero
 * —`seller_status` y `application`— y se cuenta con una sola frase: sin
 * postular, borrador, enviada, en revisión, aceptada o rechazada. UN RECHAZO
 * ENSEÑA SU MOTIVO, que es el único que el servidor deja salir; las notas
 * internas de quien decidió no están en ningún molde de lectura y aquí no se
 * echan de menos.
 *
 * LOS BOTONES APARECEN CUANDO EL CONTRATO DICE QUE SE PUEDE. Enviar, solo sobre
 * un borrador (`applications.ENVIABLES`); retirar, solo mientras la postulación
 * esté viva; escribir, solo mientras no sea ya responsable comercial y la viva
 * siga siendo un borrador. Ni uno de ellos se decide mirando un `status` a mano.
 *
 * NINGÚN CAMPO NACE CON VALOR, y los documentos nacen en CERO. Qué papeles
 * exige la empresa depende de la entidad legal que vende y del país, y eso no
 * está decidido: ofrecer «identidad» y «datos fiscales» de partida sería
 * decidirlo desde aquí. Cada documento lleva su tipo y, o la RUTA del archivo
 * en el almacenamiento, o una nota que lo explique. Nunca un enlace: una URL
 * firmada caduca.
 *
 * Y NO HAY NINGUNA PROMESA DE PLAZO. Cuánto tarda una revisión no lo dice el
 * contrato, así que no se escribe aquí.
 */
export function PostularProveedorScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();

  /* Las claves de esta pantalla viven en las tablas de idiomas; el molde es el
     mismo `t`. */
  const f = useCallback(
    (clave: string, params?: Record<string, string | number>) =>
      t(clave as TranslationKey, params),
    [t],
  );

  const [estado, setEstado] = useState<EstadoDelProveedor | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'sinPermiso' | 'sinSesion' | 'noDisponible' | null
  >(null);

  const [formulario, setFormulario] = useState<FormularioDePostulacion | null>(null);
  const [fallos, setFallos] = useState<Fallo[]>([]);

  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  const leerFallo = (error: unknown) => {
    if (error instanceof ApiError && esProductosApagado(error.code)) {
      return 'noDisponible' as const;
    }
    if (error instanceof ApiError && error.status === 401) return 'sinSesion' as const;
    if (error instanceof ApiError && error.status === 403) return 'sinPermiso' as const;
    if (error instanceof ApiError && esFalloDeRed(error.code)) return 'sinConexion' as const;
    return 'red' as const;
  };

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      setEstado(await ProductSellerRepository.estado());
    } catch (error) {
      setFallo(leerFallo(error));
    } finally {
      setCargando(false);
    }
  }, []);

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

  /**
   * El cerrojo. SE CIERRA ANTES DEL PRIMER `await`, que aquí puede ser el
   * propio diálogo: dos toques seguidos enviarían dos veces, y la segunda
   * llegaría con la postulación ya enviada.
   */
  const conCerrojo = async (trabajo: () => Promise<void>) => {
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    setOcupado(true);
    try {
      await trabajo();
    } catch (error) {
      notify(f('proveedorProductos.postular.noSePudo'), textoDelError(error));
      if (error instanceof ApiError && hayQueRecargar(error.status, error.code)) {
        setFormulario(null);
        setFallos([]);
        await cargar();
      }
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  const abrirEditor = () => {
    const postulacion = estado?.application ?? null;
    // Un borrador que ya existe se abre como está; lo que no hay, nace vacío.
    const editable = postulacion !== null && postulacion.status === 'draft';
    setFormulario(
      editable ? formularioDePostulacionDesde(postulacion) : formularioDePostulacionVacio(),
    );
    setFallos([]);
  };

  const guardar = () => {
    if (formulario === null) return;
    const { peticion, fallos: encontrados } = peticionDePostulacion(formulario);
    if (peticion === null) {
      setFallos(encontrados);
      return;
    }
    setFallos([]);
    void conCerrojo(async () => {
      await ProductSellerRepository.guardarPostulacion(peticion);
      setFormulario(null);
      toast(f('proveedorProductos.postular.guardada'));
      await cargar();
    });
  };

  const enviar = () =>
    void conCerrojo(async () => {
      const aceptado = await confirm({
        title: f('proveedorProductos.postular.enviarTitulo'),
        // EL AVISO VA ANTES: después de enviar ya no se puede cambiar.
        message: f('proveedorProductos.postular.enviarAviso'),
        confirmLabel: f('proveedorProductos.postular.enviar'),
      });
      if (!aceptado) return;
      await ProductSellerRepository.enviarPostulacion();
      toast(f('proveedorProductos.postular.enviada'));
      await cargar();
    });

  const retirar = () =>
    void conCerrojo(async () => {
      const aceptado = await confirm({
        title: f('proveedorProductos.postular.retirarTitulo'),
        message: f('proveedorProductos.postular.retirarAviso'),
        confirmLabel: f('proveedorProductos.postular.retirar'),
        destructive: true,
      });
      if (!aceptado) return;
      await ProductSellerRepository.retirarPostulacion();
      setFormulario(null);
      toast(f('proveedorProductos.postular.retirada'));
      await cargar();
    });

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));

  /* ------------------------------------------------------------------ */
  /* Estados completos antes de pintar nada                              */
  /* ------------------------------------------------------------------ */

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('proveedorProductos.postular.titulo')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || estado === null) {
    const blando = fallo === 'noDisponible' || fallo === 'sinPermiso' || fallo === 'sinSesion';
    const titulo =
      fallo === 'noDisponible'
        ? f('proveedorProductos.error.admisionNoDisponible')
        : fallo === 'sinSesion'
          ? f('proveedorProductos.error.sinSesion')
          : f('proveedorProductos.error.sinPermiso');
    const cuerpo =
      fallo === 'noDisponible'
        ? f('proveedorProductos.error.admisionNoDisponibleCuerpo')
        : fallo === 'sinSesion'
          ? f('proveedorProductos.error.sinSesionCuerpo')
          : f('proveedorProductos.error.sinPermisoCuerpo');
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('proveedorProductos.postular.titulo')} onBack={volver} />
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

  const situacion = situacionDelProveedor(estado);
  const postulacion = estado.application;
  const motivo = motivoDeLaDecision(estado);
  const sePuedeEscribir = sePuedeEscribirPostulacion(estado);
  const editando = formulario !== null;

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

  /* ------------------------------------------------------------------ */
  /* El editor. Nace VACÍO y sin un solo documento.                      */
  /* ------------------------------------------------------------------ */

  const editor = () => {
    if (formulario === null) return null;
    const documentos = formulario.documentos;
    return (
      <View style={[styles.tarjeta, { borderColor: colors.border }]}>
        <Text variant="secondary" weight="700">
          {f('proveedorProductos.postular.editorTitulo')}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('proveedorProductos.postular.editorCuerpo')}
        </Text>

        <Input
          label={f('proveedorProductos.postular.nombreEtiqueta')}
          placeholder={f('proveedorProductos.postular.nombreAyuda')}
          value={formulario.nombre}
          onChangeText={(nombre) => setFormulario({ ...formulario, nombre })}
          error={mensajeDe('nombre')}
          maxLength={LARGO_DEL_NOMBRE[1]}
          editable={!ocupado}
        />
        <Text variant="caption" color={colors.textMuted}>
          {f('proveedorProductos.postular.nombreCuerpo')}
        </Text>

        <Input
          label={f('proveedorProductos.postular.propuestaEtiqueta')}
          placeholder={f('proveedorProductos.postular.propuestaAyuda')}
          value={formulario.propuesta}
          onChangeText={(propuesta) => setFormulario({ ...formulario, propuesta })}
          error={mensajeDe('propuesta')}
          multiline
          numberOfLines={6}
          maxLength={LARGO_DE_LA_PROPUESTA[1]}
          editable={!ocupado}
        />
        <Text variant="caption" color={colors.textMuted}>
          {f('proveedorProductos.postular.propuestaCuerpo', {
            min: LARGO_DE_LA_PROPUESTA[0],
            max: LARGO_DE_LA_PROPUESTA[1],
          })}
        </Text>

        <Text variant="secondary" weight="700">
          {f('proveedorProductos.postular.documentos')}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('proveedorProductos.postular.documentosCuerpo')}
        </Text>

        {documentos.map((documento, indice) => (
          <View
            key={`documento-${indice}`}
            style={[styles.tarjeta, { borderColor: colors.border }]}
          >
            <Text variant="caption" color={colors.textMuted}>
              {f('proveedorProductos.postular.tipoDeDocumento')}
            </Text>
            <View style={styles.chips}>
              {DOCUMENTOS.map((tipo) => (
                <Chip
                  key={tipo}
                  label={f(claveDelTipoDeDocumento(tipo))}
                  rol="radio"
                  selected={documento.kind === tipo}
                  disabled={ocupado}
                  onPress={() => {
                    const copia = [...documentos];
                    copia[indice] = { ...documento, kind: tipo };
                    setFormulario({ ...formulario, documentos: copia });
                  }}
                />
              ))}
            </View>

            <Input
              label={f('proveedorProductos.postular.rutaEtiqueta')}
              placeholder={f('proveedorProductos.postular.rutaAyuda')}
              value={documento.ruta}
              onChangeText={(ruta) => {
                const copia = [...documentos];
                copia[indice] = { ...documento, ruta };
                setFormulario({ ...formulario, documentos: copia });
              }}
              maxLength={LARGO_DE_LA_RUTA[1]}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!ocupado}
            />
            {/* SE GUARDA LA RUTA, NO UN ENLACE. Se dice aquí, no al fallar. */}
            <Text variant="caption" color={colors.textMuted}>
              {f('proveedorProductos.postular.rutaCuerpo')}
            </Text>

            <Input
              label={f('proveedorProductos.postular.notaEtiqueta')}
              placeholder={f('proveedorProductos.postular.notaAyuda')}
              value={documento.nota}
              onChangeText={(nota) => {
                const copia = [...documentos];
                copia[indice] = { ...documento, nota };
                setFormulario({ ...formulario, documentos: copia });
              }}
              error={mensajeDe('documento', indice)}
              multiline
              numberOfLines={3}
              maxLength={LARGO_DE_LA_NOTA}
              editable={!ocupado}
            />

            <Button
              label={f('proveedorProductos.postular.quitarDocumento')}
              variant="ghost"
              onPress={() =>
                setFormulario({
                  ...formulario,
                  documentos: documentos.filter((_, otro) => otro !== indice),
                })
              }
              disabled={ocupado}
            />
          </View>
        ))}

        {documentos.length < MAXIMO_DE_DOCUMENTOS ? (
          <Button
            label={f('proveedorProductos.postular.anadirDocumento')}
            variant="secondary"
            icon="plus"
            onPress={() =>
              setFormulario({ ...formulario, documentos: [...documentos, documentoVacio()] })
            }
            disabled={ocupado}
          />
        ) : (
          <Text variant="caption" color={colors.textMuted}>
            {f('proveedorProductos.error.demasiadosDocumentos', {
              max: MAXIMO_DE_DOCUMENTOS,
              min: 0,
            })}
          </Text>
        )}

        {fallos
          .filter((x) => x.campo === 'postulacion')
          .map((x, indice) => (
            <Text key={`${x.codigo}-${indice}`} variant="caption" color={colors.danger}>
              {f(claveDeFallo(x), { max: x.max ?? 0, min: x.min ?? 0 })}
            </Text>
          ))}

        <Button
          label={f('proveedorProductos.postular.guardar')}
          onPress={guardar}
          loading={ocupado}
          disabled={ocupado || validarPostulacion(formulario).length > 0}
        />
        <Button
          label={t('common.cancel')}
          variant="ghost"
          onPress={() => {
            setFormulario(null);
            setFallos([]);
          }}
          disabled={ocupado}
        />
        {/* Enviar no está aquí: se envía lo GUARDADO, no lo que se escribe. */}
        <Text variant="caption" color={colors.textMuted}>
          {f('proveedorProductos.postular.seEnviaLoGuardado')}
        </Text>
      </View>
    );
  };

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('proveedorProductos.postular.titulo')} onBack={volver} />

      {/* DÓNDE ESTOY, con una sola frase y sin adivinar nada. */}
      <View style={[styles.tarjeta, { borderColor: colors.border }]}>
        <Text variant="secondary" weight="700">
          {f(claveDeLaSituacion(situacion))}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f(claveDelCuerpoDeLaSituacion(situacion))}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('proveedorProductos.marca.evaluado')}
        </Text>
      </View>

      {postulacion !== null ? (
        <View style={[styles.tarjeta, { borderColor: colors.border }]}>
          <View style={styles.linea}>
            <Text variant="secondary" weight="700">
              {f(claveDelEstadoDePostulacion(postulacion.status))}
            </Text>
            {postulacion.submitted_at !== null ? (
              <Text variant="caption" color={colors.textMuted}>
                {f('proveedorProductos.postular.enviadaEl', {
                  fecha: fechaLegible(postulacion.submitted_at),
                })}
              </Text>
            ) : null}
          </View>
          <Text variant="caption" color={colors.textMuted}>
            {f(claveDelCuerpoDelEstadoDePostulacion(postulacion.status))}
          </Text>

          <Text variant="caption">{postulacion.display_name}</Text>
          <Text variant="caption" color={colors.textMuted}>
            {postulacion.proposal}
          </Text>

          {postulacion.decided_at !== null ? (
            <Text variant="caption" color={colors.textMuted}>
              {f('proveedorProductos.postular.decididaEl', {
                fecha: fechaLegible(postulacion.decided_at),
              })}
            </Text>
          ) : null}

          {/* EL MOTIVO, cuando lo hay. Un «no» sin motivo no se le enseña a
              nadie: la base misma lo exige para un rechazo. */}
          {motivo !== null ? (
            <Text variant="caption" color={colors.danger}>
              {f('proveedorProductos.postular.motivo', { motivo })}
            </Text>
          ) : null}

          {postulacion.documents.length > 0 ? (
            postulacion.documents.map((documento) => (
              <Text key={documento.id} variant="caption" color={colors.textMuted}>
                {f('proveedorProductos.postular.documentoContado', {
                  tipo: f(claveDelTipoDeDocumento(documento.kind)),
                  detalle: documento.storage_path ?? documento.note ?? '',
                })}
              </Text>
            ))
          ) : (
            <Text variant="caption" color={colors.textMuted}>
              {f('proveedorProductos.postular.sinDocumentos')}
            </Text>
          )}
        </View>
      ) : null}

      {/* Los botones, solo cuando el contrato dice que se puede. */}
      {sePuedeEnviarPostulacion(estado) ? (
        <Button
          label={f('proveedorProductos.postular.enviar')}
          onPress={enviar}
          disabled={ocupado || editando}
        />
      ) : null}

      {sePuedeEscribir && !editando ? (
        <Button
          label={
            postulacion !== null && postulacion.status === 'draft'
              ? f('proveedorProductos.postular.seguirEscribiendo')
              : f('proveedorProductos.postular.escribir')
          }
          variant="secondary"
          icon="edit-3"
          onPress={abrirEditor}
          disabled={ocupado}
        />
      ) : null}

      {!sePuedeEscribir && situacion === 'enRevision' ? (
        <Text variant="caption" color={colors.textMuted}>
          {f('proveedorProductos.postular.noSePuedeEditar')}
        </Text>
      ) : null}

      {editando ? editor() : null}

      {sePuedeRetirarPostulacion(estado) ? (
        <Button
          label={f('proveedorProductos.postular.retirar')}
          variant="ghost"
          onPress={retirar}
          disabled={ocupado}
        />
      ) : null}

      {/* Ya es responsable comercial: lo que toca es ir a sus productos. */}
      {situacion === 'proveedorActivo' ? (
        <Button
          label={f('proveedorProductos.postular.irAMisProductos')}
          variant="secondary"
          icon="package"
          onPress={() => router.push('/proveedor/productos' as never)}
          disabled={ocupado}
        />
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  linea: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    minHeight: 44,
  },
  tarjeta: {
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
});
