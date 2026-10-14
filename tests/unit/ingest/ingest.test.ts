import { describe, expect, it } from 'vitest';
import { canonicalize } from '@/ingest/canonicalize';
import { decodeTxt, readTxtFile, titleFromFileName } from '@/ingest/txt';
import { fromPaste } from '@/ingest/paste';

describe('canonicalize', () => {
  it('converts CRLF and CR to LF', () => {
    expect(canonicalize('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('strips only a leading BOM', () => {
    expect(canonicalize('﻿Hola﻿')).toBe('Hola﻿');
  });

  it('keeps everything else byte-for-byte', () => {
    const text = '  “Sí”,\tdijo —sin prisa—…  ¿Vienes? Café́ 😀\n\n\n';
    expect(canonicalize(text)).toBe(text);
  });
});

describe('decodeTxt', () => {
  it('decodes UTF-8 (with BOM) without a notice', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Niño\r\n')]);
    expect(decodeTxt(bytes)).toEqual({ text: 'Niño\n' });
  });

  it('falls back to windows-1252 with a notice', () => {
    // "canción “x”" in windows-1252: ó = 0xF3, “ = 0x93, ” = 0x94
    const bytes = new Uint8Array([
      0x63, 0x61, 0x6e, 0x63, 0x69, 0xf3, 0x6e, 0x20, 0x93, 0x78, 0x94,
    ]);
    const result = decodeTxt(bytes);
    expect(result.text).toBe('canción “x”');
    expect(result.notice).toMatch(/Windows-1252/);
  });
});

describe('readTxtFile', () => {
  it('uses the file name as title', async () => {
    const file = new File(['Capítulo 1\r\n'], 'Marianela - cap 1.txt', { type: 'text/plain' });
    expect(await readTxtFile(file)).toEqual({ title: 'Marianela - cap 1', text: 'Capítulo 1\n' });
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
