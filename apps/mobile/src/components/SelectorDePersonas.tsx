import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { Avatar } from '@/components/Avatar';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { SinCambioDeSeccion } from '@/navigation/tabSwipe';
import { MencionRepository } from '@/repositories/MencionRepository';
import { palette, radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { PersonaEtiquetada } from '@/types';
import { useTranslation } from '@/i18n/useTranslation';

/** Paleta fija de lo que se pinta ENCIMA de un vídeo, como en `SelectorDeTemas`. */
const sobreVideo = palette('dark');

/**
 * A cuánta gente se puede etiquetar. Tiene que coincidir con
 * `MAX_MENCIONES_POR_PUBLICACION` del backend, que es quien manda de verdad:
 * aquí el tope existe para que el aviso aparezca ANTES de publicar, no para
 * proteger nada.
 */
const MAXIMO_POR_DEFECTO = 10;

type Props = {
  seleccionadas: PersonaEtiquetada[];
  alCambiar: (personas: PersonaEtiquetada[]) => void;
  maximo?: number;
  /** Paleta de superficie sobre vídeo (Crear) vs. pantalla normal (Editar). */
  variante?: 'clara' | 'sobreMedia';
  /**
   * El encabezado y la ayuda, cuando NO se está etiquetando.
   *
   * Por omisión son los de etiquetar («¿Quién sale aquí?»), que es para lo
   * que nació. Añadir gente a un grupo usa la misma lista —la filtra el
   * servidor igual, sin bloqueos— pero esa pregunta ahí no tiene sentido.
   */
  titulo?: string;
  ayuda?: string;
};

/**
 * Elegir a quién se etiqueta en una publicación.
 *
 * POR QUE SE ELIGE DE UNA LISTA Y NO SE ESCRIBE «@ana». Porque etiquetar manda
 * una notificación, y «@ana» es ambiguo: hay varias Anas, los nombres de
 * usuario cambian, y adivinar significa avisar a la persona equivocada. Aquí se
 * elige un perfil real y lo que viaja al servidor son identificadores.
 *
 * QUIEN NO PUEDE SER ETIQUETADO NO APARECE. La lista la filtra el servidor
 * (`/mentions/candidates`) excluyendo bloqueos en los dos sentidos, así que el
 * límite se nota donde tiene que notarse —la persona no está— y no en un error
 * al publicar. No se filtra aquí: el móvil no sabe quién bloqueó a quién, ni
 * debe saberlo.
 *
 * ETIQUETAR ES OPCIONAL, y eso manda sobre todo lo demás: si la búsqueda falla
 * —red caída, backend antiguo— no se pinta ningún resultado y publicar sigue
 * funcionando igual.
 */
export function SelectorDePersonas({
  seleccionadas,
  alCambiar,
  maximo = MAXIMO_POR_DEFECTO,
  variante = 'clara',
  titulo,
  ayuda,
}: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const superficie = variante === 'sobreMedia' ? sobreVideo : colors;

  const [termino, setTermino] = useState('');
  const [resultados, setResultados] = useState<PersonaEtiquetada[]>([]);
  const [buscando, setBuscando] = useState(false);

  useEffect(() => {
    const limpio = termino.trim();
    if (limpio.length < 2) {
      setResultados([]);
      return;
    }
    let vivo = true;
    setBuscando(true);
    // Pequeña espera para no lanzar una petición por cada tecla, igual que en
    // la pantalla de buscar.
    const temporizador = setTimeout(() => {
      MencionRepository.buscarCandidatos(limpio)
        .then((lista) => {
          if (vivo) setResultados(lista);
        })
        .catch((error) => {
          // Un fallo al buscar no puede impedir publicar: se deja la lista
          // vacía y queda constancia en el log.
          console.warn('[etiquetar] no se pudo buscar a quién etiquetar', error);
          if (vivo) setResultados([]);
        })
        .finally(() => {
          if (vivo) setBuscando(false);
        });
    }, 250);
    return () => {
      vivo = false;
      clearTimeout(temporizador);
    };
  }, [termino]);

  const alTope = seleccionadas.length >= maximo;
  const estaElegida = (id: string) => seleccionadas.some((p) => p.id === id);

  const alternar = (persona: PersonaEtiquetada) => {
    if (estaElegida(persona.id)) {
      alCambiar(seleccionadas.filter((p) => p.id !== persona.id));
      return;
    }
    if (alTope) return;
    alCambiar([...seleccionadas, persona]);
    // Se limpia la búsqueda al elegir: lo normal es buscar a la siguiente
    // persona, y dejar el término puesto obliga a borrarlo a mano cada vez.
    setTermino('');
    setResultados([]);
  };

  return (
    <View style={styles.raiz}>
      <View style={styles.cabecera}>
        <Text variant="secondary" weight="700" color={superficie.text} accessibilityRole="header">
          {titulo ?? t('tagging.question')}
        </Text>
        {/*
          El aviso del tope ocupa el sitio de la ayuda en vez de añadirse
          debajo: así la fila no cambia de alto al elegir a la última persona y
          no mueve el botón de publicar justo cuando alguien va a pulsarlo.
        */}
        <Text variant="caption" color={superficie.textMuted}>
          {alTope
            ? `Máximo ${maximo}. Quita a alguien para agregar a otra persona.`
            : (ayuda ?? `Etiqueta hasta ${maximo} personas`)}
        </Text>
      </View>

      {seleccionadas.length > 0 ? (
        /*
          Blindado frente al gesto de cambiar de sección: sin esto, arrastrar la
          fila de personas elegidas se llevaría la pantalla entera. Y dentro de
          Crear hay DOS gestos por encima (el carrusel de secciones y el propio
          de la pantalla), que es justo lo que `SinCambioDeSeccion` resuelve
          bloqueándolos todos. Ver `navigation/tabSwipe.tsx`.
        */
        <SinCambioDeSeccion>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.elegidas}
            keyboardShouldPersistTaps="handled"
          >
            {seleccionadas.map((persona) => (
              <Pressable
                key={persona.id}
                onPress={() => alternar(persona)}
                style={[styles.pildora, { borderColor: superficie.textMuted }]}
                accessibilityRole="button"
                accessibilityLabel={`Quitar la etiqueta de ${persona.nombre}`}
              >
                <Avatar size={22} image={persona.avatarUrl ?? null} name={persona.nombre} />
                <Text variant="caption" weight="700" color={superficie.text}>
                  {persona.usuario ? `@${persona.usuario}` : persona.nombre}
                </Text>
                <Feather name="x" size={13} color={superficie.textMuted} />
              </Pressable>
            ))}
          </ScrollView>
        </SinCambioDeSeccion>
      ) : null}

      <Input
        value={termino}
        onChangeText={setTermino}
        placeholder={t('tagging.searchPlaceholder')}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={t('tagging.searchLabel')}
      />

      {termino.trim().length >= 2 ? (
        <View style={styles.resultados}>
          {resultados.length === 0 ? (
            <Text variant="caption" color={superficie.textMuted}>
              {buscando ? t('search.searching') : t('tagging.noMatches')}
            </Text>
          ) : (
            resultados.map((persona) => {
              const elegida = estaElegida(persona.id);
              // Al llegar al tope los demás se atenúan en vez de desaparecer:
              // que la lista se encoja sola desorienta más que una fila apagada.
              const apagada = !elegida && alTope;
              return (
                <Pressable
                  key={persona.id}
                  onPress={() => alternar(persona)}
                  disabled={apagada}
                  style={[styles.fila, apagada && styles.apagada]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: elegida, disabled: apagada }}
                  accessibilityLabel={
                    elegida
                      ? `Quitar la etiqueta de ${persona.nombre}`
                      : `Etiquetar a ${persona.nombre}`
                  }
                >
                  <Avatar size={34} image={persona.avatarUrl ?? null} name={persona.nombre} />
                  <View style={styles.datos}>
                    <Text variant="secondary" weight="700" color={superficie.text}>
                      {persona.nombre}
                    </Text>
                    {persona.usuario ? (
                      <Text variant="caption" color={superficie.textMuted}>
                        @{persona.usuario}
                      </Text>
                    ) : null}
                  </View>
                  <Feather
                    name={elegida ? 'check-circle' : 'circle'}
                    size={18}
                    color={elegida ? colors.primary : superficie.textMuted}
                  />
                </Pressable>
              );
            })
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  raiz: { gap: spacing.sm },
  cabecera: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, flexWrap: 'wrap' },
  elegidas: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 2 },
  pildora: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  resultados: { gap: spacing.xs },
  fila: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 6 },
  apagada: { opacity: 0.4 },
  datos: { flex: 1 },
});
