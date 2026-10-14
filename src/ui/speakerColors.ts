import type { Character } from '@/format/types';

const PALETTE_SIZE = 8;

/** A stable palette slot per character (the narrator gets none), in cast order. */
export function speakerColorIndex(cast: readonly Character[]): Map<string, number> {
  const map = new Map<string, number>();
  let i = 0;
  for (const c of cast) {
    if (c.role === 'narrator') continue;
    map.set(c.id, i++ % PALETTE_SIZE);
  }
  return map;
}
