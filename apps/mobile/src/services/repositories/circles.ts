import { mockDelay } from '@/services/repositories/_delay';
import { circle } from '@/data/mockData';
import { AuthRepository } from '@/repositories/AuthRepository';
import { CommunityRepository } from '@/repositories/CommunityRepository';
import type { Circle } from '@/types';

/**
 * Fuente única de la verdad para los círculos.
 *
 * Antes se consultaba Supabase directamente con un `as unknown as Circle[]`,
 * así que llegaba `members_count` donde la vista lee `members` y el contador
 * salía vacío. Ahora se pasa por el backend, que ya entrega el modelo mapeado.
 */
const backendEnabled = AuthRepository.enabled;

export async function fetchCircles(): Promise<Circle[]> {
  if (!backendEnabled) {
    await mockDelay();
    return [circle];
  }
  return CommunityRepository.list();
}

/** Los ids reales son UUID; el prototipo enlazaba por slug ('lideres-renaser'). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function fetchCircleById(id: string): Promise<Circle | null> {
  if (!backendEnabled) {
    await mockDelay();
    const all = [circle];
    // Demo: si el id no coincide (p. ej. desde la galería /dev), caemos al único
    // círculo mock para que la pantalla siga siendo navegable.
    return all.find((c) => c.id === id) ?? all[0] ?? null;
  }

  // Varias pantallas siguen enlazando al slug del prototipo. En vez de pedir un
  // id que no existe (404), se resuelve al primer círculo real.
  if (!UUID_RE.test(id)) {
    const all = await CommunityRepository.list();
    return all[0] ?? null;
  }
  return CommunityRepository.getById(id);
}
