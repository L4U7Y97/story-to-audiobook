import { describe, expect, it } from 'vitest';
import { buildSpikeQueue, gapStats } from '@/spike/spikeQueue';

describe('buildSpikeQueue', () => {
  it('builds unique ids with varied pitch', () => {
    const q = buildSpikeQueue(8);
    expect(new Set(q.map((u) => u.id)).size).toBe(8);
    expect(new Set(q.map((u) => u.pitch)).size).toBeGreaterThan(1);
  });
});

describe('gapStats', () => {
  it('measures the gap from a done event to the next start', () => {
    const stats = gapStats([
      { kind: 'start', at: 0 },
      { kind: 'done', at: 1000 },
      { kind: 'start', at: 1200 },
      { kind: 'done', at: 2000 },
      { kind: 'start', at: 6000 },
    ]);
    expect(stats).toEqual({ done: 2, maxGapMs: 4000, gapsOver3s: 1 });
  });
});
