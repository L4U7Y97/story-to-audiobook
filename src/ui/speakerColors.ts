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

/**
 * A speaker's colour as a CSS value: their palette slot's, or for the narrator (who has no slot)
 * its own colour, which differs from every slot's.
 */
export function speakerTint(colors: ReadonlyMap<string, number>, id: string): string {
  const slot = colors.get(id);
  return slot === undefined ? 'var(--narrator)' : `var(--speaker-${slot})`;
}
