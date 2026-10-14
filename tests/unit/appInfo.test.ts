import { describe, expect, it } from 'vitest';
import { appName } from '@/appInfo';

describe('appInfo', () => {
  it('exposes the app name', () => {
    expect(appName).toBe('Story to Audiobook');
  });
});
