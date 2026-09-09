import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { DateField } from '@/components/DateField';
import { SinTecladoDelante } from '@/components/SinTecladoDelante';
import { TimeField } from '@/components/TimeField';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { claveDelEstado } from '@/lib/admisionDeEvento';
import { confirm, notify } from '@/lib/confirm';
import {
  CATEGORIAS,
  aforoEscrito,
  claveDeCategoria,
  estaEnRevision,
  fechaDeInicio,
  hayCambiosSinGuardar,
  motivoParaNoEnviar,
  sePuedeEditar,
  type CamposDelBorrador,
} from '@/lib/eventoDelOrganizador';
import { toast } from '@/lib/toast';
import {
  EventOrganizerRepository,
  type EventoDelOrganizador,
} from '@/repositories/EventOrganizerRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';

const MODALIDADES = [
  { valor: 'presential' as const, clave: 'evento.modalidad.presencial' },
  { valor: 'online' as const, clave: 'evento.modalidad.online' },
  { valor: 'live' as const, clave: 'evento.modalidad.live' },
];

const vacio = (): CamposDelBorrador => ({
  title: '',
  description: '',
  promise: '',
  category: '',
  location: '',
  eventType: 'presential',
  dia: '',
  hora: '',
  capacity: '',
});

/** Date -> dd/mm/aaaa y HH:MM, que es como hablan `DateField` y `TimeField`. */
function partes(iso: string | null): { dia: string; hora: string } {
  if (!iso) return { dia: '', hora: '' };
  const f = new Date(iso);
  if (Number.isNaN(f.getTime())) return { dia: '', hora: '' };
  const dos = (n: number) => String(n).padStart(2, '0');
  return {
    dia: `${dos(f.getDate())}/${dos(f.getMonth() + 1)}/${f.getFullYear()}`,
    hora: `${dos(f.getHours())}:${dos(f.getMinutes())}`,
  };
}

function aCampos(evento: EventoDelOrganizador): CamposDelBorrador {
  return {
    title: evento.title,
    description: evento.description,
    promise: evento.promise ?? '',
    category: evento.category ?? '',
    location: evento.location ?? '',
    eventType: evento.event_type,
    ...partes(evento.starts_at),
    capacity: evento.capacity === null ? '' : String(evento.capacity),
  };
}

/**
 * El borrador de un evento, y la puerta para mandarlo a revisión.
 *
 * LO QUE ESTA PANTALLA NO PUEDE HACER, y cada una es una decisión:
 *
 *   - Publicar. Enviar a revisión no publica; lo dice antes de enviar y lo
 *     vuelve a decir después. Publicar es de la admisión.
 *   - Cambiar el estado. No hay ningún control que escriba `workflow_status`:
 *     el ciclo se mueve con acciones con nombre y el servidor las comprueba.
 *   - Editar un evento ya enviado o aprobado. Se pone en solo lectura, porque
 *     lo que curaduría revisa es la versión congelada y cambiarla por debajo
 *     convertiría la revisión en una foto de algo que ya no existe.
 *
 * SE GUARDA A MEDIAS. Un borrador incompleto se guarda igual; lo que hace falta
 * completo es ENVIARLO, y la pantalla dice qué falta antes de ofrecerlo.
 */
export function EditarEventoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [campos, setCampos] = useState<CamposDelBorrador>(vacio);
  /** Lo último confirmado por el servidor: con esto se sabe qué falta guardar. */
  const [guardado, setGuardado] = useState<CamposDelBorrador>(vacio);
  const [evento, setEvento] = useState<EventoDelOrganizador | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  /** Cerrojo síncrono: dos toques no mandan dos envíos. */
  const ocupadoRef = useRef(false);

  const cargar = useCallback(async () => {
    if (!id) return;
    setCargando(true);
    setFallo(false);
    try {
      const datos = await EventOrganizerRepository.leer(id);
      setEvento(datos);
      setCampos(aCampos(datos));
      setGuardado(aCampos(datos));
    } catch {
      setFallo(true);
    } finally {
      setCargando(false);
    }
  }, [id]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const editable = evento !== null && sePuedeEditar(evento.workflow_status);
  const ocupado = guardando || enviando;
  const sinGuardar = hayCambiosSinGuardar(campos, guardado);
  const faltante = motivoParaNoEnviar(campos);

  const cuerpo = () => ({
    title: campos.title.trim(),
    description: campos.description.trim(),
    promise: campos.promise.trim() || null,
    category: campos.category.trim() || null,
    location: campos.location.trim() || null,
    event_type: campos.eventType,
    // LA HORA NO SE INVENTA. Sin día o sin hora se manda `null`, que es lo
    // único cierto: antes se componía la fecha a las 19:00 «por poner algo» y
    // esa hora acababa impresa en la ficha pública.
    starts_at: fechaDeInicio(campos.dia, campos.hora)?.toISOString() ?? null,
    capacity: aforoEscrito(campos.capacity),
  });

  const guardar = async (): Promise<boolean> => {
    if (!id || ocupadoRef.current) return false;
    ocupadoRef.current = true;
    setGuardando(true);
    try {
      const datos = await EventOrganizerRepository.guardar(id, cuerpo());
      setEvento(datos);
      setGuardado(aCampos(datos));
      return true;
    } catch (error) {
      notify(
        t('common.saveFailed'),
        error instanceof Error && error.message.trim() !== ''
          ? error.message
          : t('common.tryAgain'),
      );
      return false;
    } finally {
      ocupadoRef.current = false;
      setGuardando(false);
    }
  };

  const enviar = async () => {
    if (!id || ocupadoRef.current) return;
    if (faltante) {
      notify(t('miEvento.noSePuedeEnviar'), t(faltante as TranslationKey));
      return;
    }
    // ENVIAR NO PUBLICA, y se dice ANTES. Después ya es tarde para explicarlo.
    const aceptado = await confirm({
      title: t('miEvento.enviarTitulo'),
      message: t('miEvento.enviarCuerpo'),
      confirmLabel: t('miEvento.enviar'),
    });
    if (!aceptado) return;

    // Se guarda primero: enviar lo que hay en la pantalla y no lo que quedó en
    // el servidor la última vez. Si el guardado falla, no se envía nada.
    if (sinGuardar && !(await guardar())) return;

    ocupadoRef.current = true;
    setEnviando(true);
    try {
      const datos = await EventOrganizerRepository.enviarARevision(id);
      setEvento(datos);
      setGuardado(aCampos(datos));
      toast(t('miEvento.enviado'));
    } catch (error) {
      notify(
        t('common.saveFailed'),
        error instanceof Error && error.message.trim() !== ''
          ? error.message
          : t('common.tryAgain'),
      );
    } finally {
      ocupadoRef.current = false;
      setEnviando(false);
    }
  };

  const salir = () =>
    router.canGoBack() ? router.back() : router.replace('/mis-eventos' as never);

  const volver = async () => {
    // Salir con algo escrito y sin guardar lo perdía en silencio.
    if (!sinGuardar || !editable) return salir();
    const seguir = await confirm({
      title: t('miEvento.salirSinGuardar'),
      message: t('miEvento.salirSinGuardarCuerpo'),
      confirmLabel: t('miEvento.salirIgual'),
      destructive: true,
    });
    if (seguir) salir();
  };

  if (cargando) {
    return (
      <AppScreen>
        <AppHeader title={t('miEvento.titulo')} onBack={() => void volver()} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo || !evento) {
    return (
      <AppScreen>
        <AppHeader title={t('miEvento.titulo')} onBack={() => void volver()} />
        <StateView
          state="error"
          description={t('common.loadFailed')}
          onRetry={() => void cargar()}
        />
      </AppScreen>
    );
  }

  return (
    <SinTecladoDelante>
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={t('miEvento.titulo')} onBack={() => void volver()} />

      {/* El estado, siempre a la vista. */}
      <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
        <Feather name="info" size={16} color={colors.textMuted} />
        <Text variant="secondary" color={colors.textMuted} style={styles.crece}>
          {t(claveDelEstado(evento.workflow_status) as TranslationKey)}
          {estaEnRevision(evento.workflow_status)
            ? ` · ${t('miEvento.enRevisionNoSePublica')}`
            : ''}
        </Text>
      </View>

      {/* Las observaciones de la revisión, con sus palabras. */}
      {evento.ultima_observacion &&
      evento.ultima_observacion.decision !== 'approved' ? (
        <View style={[styles.observacion, { borderColor: colors.danger }]}>
          <Text variant="caption" color={colors.danger} weight="700">
            {t('miEvento.observaciones')}
          </Text>
          <Text variant="secondary">{evento.ultima_observacion.reason}</Text>
        </View>
      ) : null}

      {!editable ? (
        <Text variant="caption" color={colors.textMuted}>
          {t('miEvento.soloLectura')}
        </Text>
      ) : null}

      <Input
        label={t('miEvento.campoTitulo')}
        value={campos.title}
        onChangeText={(v) => setCampos({ ...campos, title: v })}
        editable={editable && !ocupado}
        maxLength={160}
      />
      <Input
        label={t('miEvento.campoPromesa')}
        value={campos.promise}
        onChangeText={(v) => setCampos({ ...campos, promise: v })}
        editable={editable && !ocupado}
        maxLength={200}
        placeholder={t('miEvento.promesaEjemplo')}
      />
      <Input
        label={t('miEvento.campoDescripcion')}
        value={campos.description}
        onChangeText={(v) => setCampos({ ...campos, description: v })}
        editable={editable && !ocupado}
        maxLength={2000}
        multiline
        numberOfLines={5}
        style={styles.parrafo}
      />

      <Text variant="caption" color={colors.textMuted}>
        {t('miEvento.campoCategoria')}
      </Text>
      <View style={styles.fichas}>
        {CATEGORIAS.map((categoria) => {
          const elegida = campos.category === categoria;
          return (
            <Pressable
              key={categoria}
              disabled={!editable || ocupado}
              onPress={() => setCampos({ ...campos, category: categoria })}
              style={[
                styles.ficha,
                {
                  borderColor: elegida ? colors.primary : colors.border,
                  backgroundColor: elegida ? colors.primary : 'transparent',
                },
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected: elegida }}
            >
              <Text
                variant="caption"
                color={elegida ? colors.onPrimary : colors.text}
              >
                {t(claveDeCategoria(categoria) as TranslationKey)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Text variant="caption" color={colors.textMuted}>
        {t('miEvento.campoModalidad')}
      </Text>
      <View style={styles.fichas}>
        {MODALIDADES.map((modalidad) => {
          const elegida = campos.eventType === modalidad.valor;
          return (
            <Pressable
              key={modalidad.valor}
              disabled={!editable || ocupado}
              onPress={() => setCampos({ ...campos, eventType: modalidad.valor })}
              style={[
                styles.ficha,
                {
                  borderColor: elegida ? colors.primary : colors.border,
                  backgroundColor: elegida ? colors.primary : 'transparent',
                },
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected: elegida }}
            >
              <Text
                variant="caption"
                color={elegida ? colors.onPrimary : colors.text}
              >
                {t(modalidad.clave as TranslationKey)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/*
        DÍA Y HORA, LOS DOS. El selector de fecha no captura hora, así que con
        él solo había que inventarla; y una hora inventada se publica igual que
        una escrita. En solo lectura no se pintan: el componente no acepta
        `editable`, y dejarlo activo permitía cambiar la fecha de un evento que
        ya no se puede guardar, perdiendo el cambio sin avisar.
      */}
      {editable ? (
        <>
          <DateField
            label={t('miEvento.campoFecha')}
            value={campos.dia}
            onChange={(v) => setCampos({ ...campos, dia: v })}
            minDate={new Date()}
          />
          <TimeField
            label={t('miEvento.campoHora')}
            value={campos.hora}
            onChange={(v) => setCampos({ ...campos, hora: v })}
          />
        </>
      ) : (
        <Dato
          etiqueta={t('miEvento.campoFecha')}
          valor={
            campos.dia && campos.hora
              ? `${campos.dia} · ${campos.hora}`
              : t('evento.sinFecha')
          }
        />
      )}

      {campos.eventType === 'presential' ? (
        <Input
          label={t('miEvento.campoRecinto')}
          value={campos.location}
          onChangeText={(v) => setCampos({ ...campos, location: v })}
          editable={editable && !ocupado}
          maxLength={200}
        />
      ) : null}

      <Input
        label={t('miEvento.campoAforo')}
        value={campos.capacity}
        onChangeText={(v) => setCampos({ ...campos, capacity: v.replace(/[^0-9]/g, '') })}
        editable={editable && !ocupado}
        keyboardType="number-pad"
        maxLength={7}
      />
      <Text variant="caption" color={colors.textMuted}>
        {t('miEvento.aforoVacio')}
      </Text>

      {/* El aforo APROBADO, cuando la admisión puso uno distinto. */}
      {evento.approved_capacity !== null ? (
        <Text variant="caption" color={colors.textMuted}>
          {t('miEvento.aforoAprobado', { aforo: evento.approved_capacity })}
        </Text>
      ) : null}

      {editable ? (
        <>
          <Button
            label={t('miEvento.guardar')}
            variant="secondary"
            onPress={() => void guardar()}
            loading={guardando}
            disabled={ocupado || !sinGuardar}
          />
          {faltante ? (
            <Text variant="caption" color={colors.textMuted}>
              {t(faltante as TranslationKey)}
            </Text>
          ) : null}
          <Button
            label={t('miEvento.enviar')}
            onPress={() => void enviar()}
            loading={enviando}
            disabled={ocupado || faltante !== null}
          />
        </>
      ) : null}
    </AppScreen>
    </SinTecladoDelante>
  );
}

/** Un dato que ya no se puede editar. */
function Dato({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  const { colors } = useAppTheme();
  return (
    <View>
      <Text variant="caption" color={colors.textMuted}>
        {etiqueta}
      </Text>
      <Text variant="secondary">{valor}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  crece: { flex: 1 },
  parrafo: { minHeight: 110, textAlignVertical: 'top' },
  fichas: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  ficha: {
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 36,
    justifyContent: 'center',
  },
  aviso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  observacion: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: 4,
  },
});
