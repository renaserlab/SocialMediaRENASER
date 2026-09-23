import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { Button } from '@/components/Button';
import { SectionTitle } from '@/components/SectionTitle';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { HojaDeValoracion } from '@/components/valoraciones/HojaDeValoracion';
import { PuntuacionEnEstrellas } from '@/components/valoraciones/PuntuacionEnEstrellas';
import { ResumenDeLasValoraciones } from '@/components/valoraciones/ResumenDeLasValoraciones';
import { confirm, notify } from '@/lib/confirm';
import { irAlPerfil } from '@/lib/irAlPerfil';
import { toast } from '@/lib/toast';
import {
  POR_PAGINA,
  fusionarPaginas,
  hayMasPaginas,
  mensajeDeErrorDeValoracion,
  miValoracion,
  normalizaResumen,
  seccionNoMontada,
  type ResumenDeValoraciones,
} from '@/lib/valoracionesDeCurso';
import {
  CourseReviewRepository,
  type ValoracionDeCurso,
} from '@/repositories/CourseReviewRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

type Props = {
  cursoId: string;
  /**
   * Si a esta persona se le OFRECE valorar. Es una pista para no ensenar un
   * boton imposible —valorar pide haber PAGADO el curso, asi que en uno gratis
   * no lo hay—, NO un permiso: quien decide es el servidor, que vuelve a mirar
   * la compra y la devolucion en cada escritura. Por eso todos sus rechazos
   * estan traducidos y se leen dentro de la hoja.
   */
  puedeValorar: boolean;
};

/**
 * Las valoraciones de un curso: resumen, listado y la propia.
 *
 * TRES ESTADOS QUE NO SON EL MISMO, y confundirlos era el fallo evidente:
 *
 *   - CARGANDO: todavia no se sabe nada.
 *   - VACIO: el servidor contesto y no hay ninguna. Se dice «Sin valoraciones»
 *     y jamas «0.0» (ver `ResumenDeLasValoraciones`).
 *   - ERROR: no se pudo leer. Se dice, y se ofrece reintentar. Callarlo lo
 *     convertiria en «este curso no tiene valoraciones», que es una afirmacion
 *     sobre el curso y puede ser falsa.
 *
 * Y UNO MAS QUE NO SE PINTA. Con 503 y `course_reviews_not_available` la
 * seccion entera desaparece, sin error y sin hueco: no es que fallara nada, es
 * que la migracion 0056 no esta aplicada en esta instalacion. Ensenar «no
 * pudimos cargar las valoraciones» donde no hay valoraciones montadas seria
 * inventar una averia.
 */
export function ValoracionesDelCurso({ cursoId, puedeValorar }: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();

  const [resumen, setResumen] = useState<ResumenDeValoraciones>(() => normalizaResumen(null));
  const [lista, setLista] = useState<ValoracionDeCurso[]>([]);
  const [cargando, setCargando] = useState(true);
  /**
   * El fallo TAL CUAL lo lanzo el servidor, sin traducir.
   *
   * Se guarda crudo y se traduce al pintar para que cambiar de idioma no
   * obligue a volver a pedir la lista, y para que el codigo siga disponible:
   * es lo unico que distingue «no se pudo» de «esto todavia no existe aqui».
   */
  const [fallo, setFallo] = useState<unknown>(null);
  const [hayMas, setHayMas] = useState(false);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [falloAlSeguir, setFalloAlSeguir] = useState(false);
  const [hojaAbierta, setHojaAbierta] = useState(false);
  /** Cerrojos sincronos: dos toques no piden dos paginas ni borran dos veces. */
  const siguiendoRef = useRef(false);
  const retirandoRef = useRef(false);
  /**
   * Que carga es la buena.
   *
   * Sube en cada peticion y tambien al desmontar. Sin esto, la respuesta de un
   * curso que ya se cerro —o de una carga anterior que tardo mas— pisaria la
   * lista del curso que se esta mirando.
   */
  const generacionRef = useRef(0);

  const cargar = useCallback(async () => {
    generacionRef.current += 1;
    const generacion = generacionRef.current;
    const alDia = () => generacionRef.current === generacion;
    setCargando(true);
    setFallo(null);
    setFalloAlSeguir(false);
    /*
      `allSettled` y no `all`: con la 0056 sin aplicar fallan LAS DOS, y con
      `all` el segundo rechazo se queda sin recoger y salta el aviso de promesa
      no manejada. Aqui se miran las dos respuestas y se decide una vez.
    */
    const [conResumen, conLista] = await Promise.allSettled([
      CourseReviewRepository.resumen(cursoId),
      CourseReviewRepository.listar(cursoId, { limite: POR_PAGINA, desde: 0 }),
    ]);
    if (!alDia()) return;
    if (conResumen.status === 'rejected') {
      setFallo(conResumen.reason);
      setCargando(false);
      return;
    }
    if (conLista.status === 'rejected') {
      setFallo(conLista.reason);
      setCargando(false);
      return;
    }
    setResumen(conResumen.value);
    setLista(conLista.value);
    setHayMas(hayMasPaginas(conLista.value.length, POR_PAGINA));
    setCargando(false);
  }, [cursoId]);

  useEffect(() => {
    void cargar();
    // Al cambiar de curso o al desmontar, lo que quede en vuelo ya no vale.
    return () => {
      generacionRef.current += 1;
    };
  }, [cargar]);

  const verMas = async () => {
    if (siguiendoRef.current) return;
    siguiendoRef.current = true;
    setCargandoMas(true);
    setFalloAlSeguir(false);
    try {
      const siguiente = await CourseReviewRepository.listar(cursoId, {
        limite: POR_PAGINA,
        desde: lista.length,
      });
      // Sin fusionar, una valoracion publicada entre dos peticiones desplaza a
      // las demas y alguna llega dos veces.
      setLista((previas) => fusionarPaginas(previas, siguiente));
      setHayMas(hayMasPaginas(siguiente.length, POR_PAGINA));
    } catch {
      // Lo que ya se leyo SIGUE en pantalla: perder la lista entera por no
      // poder pedir la pagina siguiente seria cambiar un contratiempo por un
      // borrado.
      setFalloAlSeguir(true);
    } finally {
      siguiendoRef.current = false;
      setCargandoMas(false);
    }
  };

  const mia = miValoracion(lista);

  const retirar = async () => {
    if (!mia || retirandoRef.current) return;
    // Echado ANTES del primer `await`, que aqui es el propio dialogo: si no,
    // dos toques abren dos confirmaciones sobre la misma valoracion.
    retirandoRef.current = true;
    try {
      const aceptado = await confirm({
        title: t('valoracion.retirarTitulo'),
        message: t('valoracion.retirarCuerpo'),
        confirmLabel: t('valoracion.retirarConfirmar'),
        destructive: true,
      });
      if (!aceptado) return;
      await CourseReviewRepository.retirar(cursoId, mia.id);
      toast(t('valoracion.retirada'));
      await cargar();
    } catch (error) {
      notify(t('common.deleteFailed'), mensajeDeErrorDeValoracion(error, t));
    } finally {
      retirandoRef.current = false;
    }
  };

  // La funcion no esta montada en esta instalacion: ni seccion, ni error.
  if (seccionNoMontada(fallo)) return null;

  return (
    <View style={styles.seccion}>
      <SectionTitle title={t('valoracion.titulo')} />

      {cargando ? (
        <StateView state="loading" style={styles.estado} />
      ) : fallo !== null ? (
        <StateView
          state="error"
          description={mensajeDeErrorDeValoracion(fallo, t)}
          onRetry={() => void cargar()}
          style={styles.estado}
        />
      ) : (
        <React.Fragment>
          <ResumenDeLasValoraciones resumen={resumen} />

          {lista.length === 0 ? (
            <Text variant="secondary" color={colors.textMuted} style={styles.vacio}>
              {t('valoracion.vacio')}
            </Text>
          ) : (
            <View style={styles.lista}>
              {lista.map((valoracion) => (
                <Fila
                  key={valoracion.id}
                  valoracion={valoracion}
                  onAbrirPerfil={() => irAlPerfil(router, valoracion.autorId)}
                />
              ))}
            </View>
          )}

          {falloAlSeguir ? (
            <Text variant="secondary" color={colors.danger} style={styles.vacio}>
              {t('common.loadMoreFailed')}
            </Text>
          ) : null}

          {hayMas ? (
            <Button
              label={t('valoracion.verMas')}
              variant="secondary"
              loading={cargandoMas}
              disabled={cargandoMas}
              onPress={() => void verMas()}
              style={styles.accion}
            />
          ) : null}

          {mia ? (
            <React.Fragment>
              {/*
                MODERADA: se dice. Aparece en la lista porque la propia se ve
                siempre, y sin este aviso quien la escribio la daria por
                publicada y no entenderia por que la media no se movio.
              */}
              {mia.enRevision ? (
                <Text variant="secondary" color={colors.textMuted} style={styles.vacio}>
                  {t('valoracion.enRevision')}
                </Text>
              ) : null}
              <Button
                label={t('valoracion.editarMia')}
                variant="secondary"
                onPress={() => setHojaAbierta(true)}
                style={styles.accion}
              />
              {/*
                Retirar una moderada la borraria y dejaria publicar otra igual,
                asi que el servidor lo rechaza. No se ofrece el boton para no
                mandar a nadie a un error.
              */}
              {mia.enRevision ? null : (
                <Pressable
                  onPress={() => void retirar()}
                  style={styles.retirar}
                  accessibilityRole="button"
                  accessibilityLabel={t('valoracion.retirarTitulo')}
                >
                  <Feather name="trash-2" size={14} color={colors.textMuted} />
                  <Text variant="secondary" weight="700" color={colors.textMuted}>
                    {t('valoracion.retirarTitulo')}
                  </Text>
                </Pressable>
              )}
            </React.Fragment>
          ) : puedeValorar ? (
            <Button
              label={t('valoracion.valorar')}
              variant="secondary"
              onPress={() => setHojaAbierta(true)}
              style={styles.accion}
            />
          ) : null}
        </React.Fragment>
      )}

      <HojaDeValoracion
        visible={hojaAbierta}
        onClose={() => setHojaAbierta(false)}
        cursoId={cursoId}
        existente={mia}
        onGuardada={(_, editada) => {
          // Cerrar ANTES del aviso: la hoja es un Modal y en iOS taparia el
          // toast. Y recargar, porque la media y la distribucion las calcula
          // el servidor: recomponerlas aqui seria inventarlas.
          setHojaAbierta(false);
          toast(editada ? t('valoracion.actualizada') : t('valoracion.publicada'));
          void cargar();
        }}
      />
    </View>
  );
}

/** Fecha corta, o nada si el servidor mandara algo que no es una fecha. */
function fechaCorta(iso: string): string {
  const momento = new Date(iso);
  return Number.isNaN(momento.getTime()) ? '' : momento.toLocaleDateString();
}

function Fila({
  valoracion,
  onAbrirPerfil,
}: {
  valoracion: ValoracionDeCurso;
  onAbrirPerfil: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  // El servidor manda '' cuando no encuentra el perfil. Sin nombre y sin
  // usuario NO se inventa ninguno: la valoracion se lee igual sin firma.
  const nombre = valoracion.autorNombre.trim() || (valoracion.autorUsuario.trim() ? `@${valoracion.autorUsuario.trim()}` : '');
  const fecha = fechaCorta(valoracion.creadaEnIso);

  return (
    <View style={[styles.fila, { borderColor: colors.border }]}>
      <View style={styles.cabeceraDeFila}>
        {nombre ? (
          <Pressable
            onPress={onAbrirPerfil}
            style={styles.autor}
            accessibilityRole="button"
            accessibilityLabel={t('curso.verPerfilDe').replace('{nombre}', nombre)}
          >
            <Text variant="secondary" weight="700">
              {nombre}
            </Text>
          </Pressable>
        ) : null}
        {fecha ? (
          <Text variant="caption" color={colors.textMuted}>
            {fecha}
          </Text>
        ) : null}
      </View>

      <PuntuacionEnEstrellas valor={valoracion.puntuacion} />

      {/*
        EL SELLO SOLO CUANDO EL SERVIDOR LO DA. Lo calcula el mirando la compra
        y el acceso de HOY; deducirlo aqui era imposible y ensenarlo siempre lo
        convertiria en un adorno.
      */}
      {valoracion.compraVerificada ? (
        <View style={styles.sello}>
          <Feather name="check-circle" size={12} color={colors.success} />
          <Text variant="caption" color={colors.success}>
            {t('valoracion.compraVerificada')}
          </Text>
        </View>
      ) : null}

      {valoracion.comentario ? (
        <Text variant="body" style={styles.comentario}>
          {valoracion.comentario}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  seccion: { marginTop: spacing.xl },
  estado: { minHeight: 120 },
  vacio: { marginTop: spacing.md },
  lista: { marginTop: spacing.md, gap: spacing.md },
  fila: { borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm },
  cabeceraDeFila: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  // 44 pt es el minimo pulsable; el nombre solo se queda por debajo.
  autor: { flexShrink: 1, minHeight: 44, justifyContent: 'center' },
  sello: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  comentario: { marginTop: spacing.xs },
  accion: { marginTop: spacing.md },
  retirar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg,
    minHeight: 44,
  },
});
