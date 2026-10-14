import { describe, expect, it } from 'vitest';
import { sha256 } from '@/format/hash';

describe('sha256', () => {
  it('matches the known digest of "abc"', async () => {
    expect(await sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('distinguishes text that differs only in line endings', async () => {
    expect(await sha256('a\nb')).not.toBe(await sha256('a\r\nb'));
  });
});
