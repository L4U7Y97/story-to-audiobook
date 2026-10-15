import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { parseEpub } from '@/ingest/epub';
import { readTxtFile } from '@/ingest/txt';

/**
 * Spec success criterion 1: importing the fixtures as .txt and as .epub gives Part.text identical,
 * byte for byte, to the expected canonical text. For .txt that is the fixture itself; for .epub it
 * is `<fixture>.epub.txt` (HTML rendering joins hard-wrapped lines, so the two differ).
 */
const FIXTURES = ['en/pride-ch1', 'es/marianela-ch1'];

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** An EPUB like Project Gutenberg's: one XHTML file, one <p> per paragraph, source line wraps kept. */
async function epubOf(text: string, title: string): Promise<Uint8Array> {
  const body = text
    .split(/\n\n+/)
    .map((p) => `    <p>\n      ${escape(p).replace(/\n/g, '\n      ')}\n    </p>`)
    .join('\n');
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file(
    'META-INF/container.xml',
    `<?xml version='1.0' encoding='utf-8'?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  );
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escape(title)}</dc:title></metadata>
  <manifest><item id="c1" href="text.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/></spine>
</package>`,
  );
  zip.file(
    'OEBPS/text.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>${escape(title)}</title></head>
  <body>
${body}
  </body>
</html>`,
  );
  return zip.generateAsync({ type: 'uint8array' });
}

describe.each(FIXTURES)('fixture %s', (path) => {
  const bytes = readFileSync(`tests/fixtures/${path}.txt`);
  const canonical = bytes.toString('utf8');
  const epubCanonical = readFileSync(`tests/fixtures/${path}.epub.txt`, 'utf8');

  it('imports as .txt byte for byte', async () => {
    const { text, notice } = await readTxtFile(new File([bytes], `${path}.txt`));
    expect(notice).toBeUndefined();
    expect(text).toBe(canonical);
  });

  it('imports a Windows copy (BOM, CRLF) as the same canonical text', async () => {
    const windows = '﻿' + canonical.replace(/\n/g, '\r\n');
    const { text } = await readTxtFile(new File([windows], `${path}.txt`));
    expect(text).toBe(canonical);
  });

  it('imports as .epub byte for byte', async () => {
    const book = await parseEpub(await epubOf(canonical, path));
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0]!.text).toBe(epubCanonical);
  });
});
