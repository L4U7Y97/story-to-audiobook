import { describe, expect, it } from 'vitest';
import { canonicalize } from '@/ingest/canonicalize';
import { decodeTxt, readTxtFile, titleFromFileName } from '@/ingest/txt';
import { fromPaste } from '@/ingest/paste';

describe('canonicalize', () => {
  it('converts CRLF and CR to LF', () => {
    expect(canonicalize('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('strips only a leading BOM', () => {
    expect(canonicalize('﻿Hello﻿')).toBe('Hello﻿');
  });

  it('keeps everything else byte-for-byte', () => {
    // Also a no-break space before “Café”, whose é is followed by a combining acute accent.
    const text = '  “Zoë”,\tshe said —in no hurry—…  Coming‽ Café́ 😀\n\n\n';
    expect(canonicalize(text)).toBe(text);
  });
});

describe('decodeTxt', () => {
  it('decodes UTF-8 (with BOM) without a notice', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Brontë\r\n')]);
    expect(decodeTxt(bytes)).toEqual({ text: 'Brontë\n' });
  });

  it('falls back to windows-1252 with a notice', () => {
    // "naïve “x”" in windows-1252: ï = 0xEF, “ = 0x93, ” = 0x94
    const bytes = new Uint8Array([0x6e, 0x61, 0xef, 0x76, 0x65, 0x20, 0x93, 0x78, 0x94]);
    const result = decodeTxt(bytes);
    expect(result.text).toBe('naïve “x”');
    expect(result.notice).toMatch(/Windows-1252/);
  });
});

describe('readTxtFile', () => {
  it('uses the file name as title', async () => {
    const file = new File(['Chapter 1: Renée\r\n'], 'Renee - ch 1.txt', { type: 'text/plain' });
    expect(await readTxtFile(file)).toEqual({ title: 'Renee - ch 1', text: 'Chapter 1: Renée\n' });
  });

  it('keeps a name without an extension', () => {
    expect(titleFromFileName('notes')).toBe('notes');
    expect(titleFromFileName('.txt')).toBe('.txt');
  });
});

describe('fromPaste', () => {
  it('applies only the canonical rules', () => {
    expect(fromPaste('“Hi,”\r\nshe said.  ')).toBe('“Hi,”\nshe said.  ');
  });
});
