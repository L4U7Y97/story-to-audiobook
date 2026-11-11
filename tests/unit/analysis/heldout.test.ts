import { describe, expect, it } from 'vitest';
import { judgeStory } from '../../helpers/heldout';
import { STORIES } from '../../helpers/heldoutStories';

// Error budgets measured when narrator support was added; they may only go down.
const MAX_ERRORS = { third: 7, first: 18 };

describe('heuristic on the multi-part regression stories', () => {
  const results = STORIES.map((story) => ({ story, ...judgeStory(story) }));

  it('reports its errors', () => {
    for (const r of results) {
      console.info(
        `${r.story.id}: ${r.total - r.hard}/${r.total}` +
          (r.misses.length ? `\n  - ${r.misses.join('\n  - ')}` : ''),
      );
    }
  });

  it.each([
    ['third', true],
    ['first', false],
  ] as const)('keeps %s-person errors within budget', (kind, third) => {
    const errors = results
      .filter((r) => r.story.third === third)
      .reduce((sum, r) => sum + r.hard, 0);
    expect(errors).toBeLessThanOrEqual(MAX_ERRORS[kind]);
  });

  it('never names the narrator', () => {
    for (const r of results) {
      const narrator = r.cast.find((c) => c.role === 'narrator')!;
      expect(narrator.aliases, r.story.id).toEqual([]);
      expect(narrator.name, r.story.id).toBe('Narrator');
    }
  });

  it('never creates a character from a heading, a nationality or the narrator', () => {
    for (const r of results) {
      const names = r.cast.filter((c) => c.role === 'character').map((c) => c.name);
      for (const bad of ['Narrator', 'English', 'Thornfield', 'AMY', 'NICK', 'DUNNE', 'CHAPTER']) {
        expect(names, r.story.id).not.toContain(bad);
      }
    }
  });
});
