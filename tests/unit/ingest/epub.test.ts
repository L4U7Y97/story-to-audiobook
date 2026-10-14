import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { combineChapters, EpubError, extractSections, parseEpub } from '@/ingest/epub';

// Single-quoted declaration, as Project Gutenberg writes it.
const CONTAINER = `<?xml version='1.0' encoding='utf-8'?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Una historia</dc:title></metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="Text/chapter%201.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="empty" href="Text/blank.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="nav" linear="no"/>
    <itemref idref="c1"/>
    <itemref idref="empty"/>
    <itemref idref="c2"/>
  </spine>
</package>`;

const xhtml = (body: string) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title><style>p{}</style></head>
<body>${body}</body></html>`;

const CH1 = xhtml(`
  <h1>Capítulo
      uno</h1>
  <p>—Hola   —dijo
     Ana—. ¿Vienes?</p>
  <p><em>Debo irme</em>, pensó. A&#160;las&nbsp;nueve &amp; media.<br/>Otra línea.</p>
  <script>alert('no')</script>
  <div><p>Anidado <i>muy <b>bien</b></i>.</p></div>
  <img src="x.png" alt="ignored"/>`).replace('&nbsp;', '&#160;');

const CH2 = xhtml(`<section><h2>Dos</h2><p>Fin.</p></section>`);

async function makeEpub(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return zip.generateAsync({ type: 'uint8array' });
}

const BOOK = {
  'META-INF/container.xml': CONTAINER,
  'OEBPS/content.opf': OPF,
  'OEBPS/nav.xhtml': xhtml('<nav><ol><li>TOC</li></ol></nav>'),
  'OEBPS/Text/chapter 1.xhtml': CH1,
  'OEBPS/Text/ch2.xhtml': CH2,
  'OEBPS/Text/blank.xhtml': xhtml('<p>   </p>'),
};

describe('parseEpub', () => {
  it('reads linear spine documents in order and skips empty ones', async () => {
    const book = await parseEpub(await makeEpub(BOOK));
    expect(book.title).toBe('Una historia');
    expect(book.chapters.map((c) => [c.href, c.title])).toEqual([
      ['OEBPS/Text/chapter 1.xhtml', 'Capítulo uno'],
      ['OEBPS/Text/ch2.xhtml', 'Dos'],
    ]);
  });

  it('extracts canonical text: blocks → blank lines, br → newline, collapsed source whitespace', async () => {
    const [ch1] = (await parseEpub(await makeEpub(BOOK))).chapters;
    expect(ch1!.text).toBe(
      'Capítulo uno\n\n' +
        '—Hola —dijo Ana—. ¿Vienes?\n\n' +
        'Debo irme, pensó. A las nueve & media.\nOtra línea.\n\n' +
        'Anidado muy bien.',
    );
  });

  it('records italics as emphasis hints on the right ranges', async () => {
    const [ch1] = (await parseEpub(await makeEpub(BOOK))).chapters;
    const spans = ch1!.hints.map((h) => ch1!.text.slice(h.start, h.end));
    expect(spans).toEqual(['Debo irme', 'muy bien']);
    expect(ch1!.hints.every((h) => h.kind === 'emphasis')).toBe(true);
  });

  it('falls back to HTML parsing for documents that are not well-formed XML', async () => {
    const opf = OPF.replace('<itemref idref="c2"/>', '');
    const book = await parseEpub(
      await makeEpub({
        ...BOOK,
        'OEBPS/content.opf': opf,
        'OEBPS/Text/chapter 1.xhtml': '<p>Uno<br>dos',
      }),
    );
    expect(book.chapters[0]!.text).toBe('Uno\ndos');
  });

  it('explains what is wrong with broken files', async () => {
    await expect(parseEpub(new Uint8Array([1, 2, 3]))).rejects.toThrow(EpubError);
    await expect(parseEpub(await makeEpub({ 'x.txt': 'x' }))).rejects.toThrow('missing META-INF');
    const noChapters = {
      ...BOOK,
      'OEBPS/content.opf': OPF.replace(/<itemref idref="c[12]"\/>/g, ''),
    };
    await expect(parseEpub(await makeEpub(noChapters))).rejects.toThrow('No readable chapters');
  });
});

describe('combineChapters', () => {
  it('joins chapters with a blank line and shifts hints', async () => {
    const { chapters } = await parseEpub(await makeEpub(BOOK));
    const combined = combineChapters(chapters);
    expect(combined.text).toBe(`${chapters[0]!.text}\n\n${chapters[1]!.text}`);
    expect(combined.hints.map((h) => combined.text.slice(h.start, h.end))).toEqual([
      'Debo irme',
      'muy bien',
    ]);
  });
});

describe('extractSections', () => {
  it('splits a document at its headings, keeping front matter and shifting hints', async () => {
    const doc = new DOMParser().parseFromString(
      xhtml(`<p>Front matter.</p>
        <h2><img src="x.jpg"/><br/>Chapter I.</h2><p>It is a <em>truth</em> here.</p>
        <h2>Chapter II.</h2><p>Second <i>one</i>.</p>`).replace(/^<\?xml[^?]*\?>/, ''),
      'application/xhtml+xml',
    );
    const sections = extractSections(doc);
    expect(sections.map((s) => [s.title, s.text])).toEqual([
      [undefined, 'Front matter.'],
      ['Chapter I.', 'Chapter I.\n\nIt is a truth here.'],
      ['Chapter II.', 'Chapter II.\n\nSecond one.'],
    ]);
    expect(sections.map((s) => s.hints.map((h) => s.text.slice(h.start, h.end)))).toEqual([
      [],
      ['truth'],
      ['one'],
    ]);
  });
});
