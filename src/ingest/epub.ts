import JSZip from 'jszip';
import type { Hint } from '@/format/types';

export interface EpubChapter {
  /** Path of the spine document inside the archive. */
  href: string;
  title: string;
  /** Canonical text: never modified after import. */
  text: string;
  hints: Hint[];
}

export interface EpubBook {
  title: string;
  chapters: EpubChapter[];
}

export class EpubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpubError';
  }
}

const BLOCKS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tr',
  'ul',
]);
const SKIPPED = new Set([
  'script',
  'style',
  'head',
  'title',
  'svg',
  'img',
  'audio',
  'video',
  'math',
  'noscript',
  'template',
  'rt',
  'rp',
  'object',
  'iframe',
]);
const EMPHASIS = new Set(['em', 'i']);
/** HTML whitespace (not U+00A0, which is content). */
const HTML_SPACE = /[ \t\n\r\f]+/g;

/**
 * Reads an EPUB: container.xml → OPF → spine order. Each linear spine document becomes a
 * chapter whose text follows the extraction rules in SPEC.md (ingest).
 */
export async function parseEpub(data: ArrayBuffer | Uint8Array | Blob): Promise<EpubBook> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new EpubError('This file is not a valid EPUB (it is not a zip archive).');
  }

  const container = await readXml(zip, 'META-INF/container.xml');
  const opfPath = container.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath) throw new EpubError('The EPUB has no package document.');
  const opf = await readXml(zip, opfPath);
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const manifest = new Map<string, { href: string; type: string }>();
  for (const item of Array.from(opf.getElementsByTagName('item'))) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (id && href)
      manifest.set(id, { href: resolve(base, href), type: item.getAttribute('media-type') ?? '' });
  }

  const title = opf.getElementsByTagName('dc:title')[0]?.textContent?.trim() || 'Untitled';
  const chapters: EpubChapter[] = [];
  for (const ref of Array.from(opf.getElementsByTagName('itemref'))) {
    if (ref.getAttribute('linear') === 'no') continue;
    const item = manifest.get(ref.getAttribute('idref') ?? '');
    if (!item || !/html/.test(item.type)) continue;
    const doc = await readHtml(zip, item.href);
    if (!doc) continue;
    // Files often hold several chapters (Project Gutenberg splits by size): one section per heading.
    const sections = extractSections(doc);
    sections.forEach((section, k) => {
      chapters.push({
        href: sections.length > 1 ? `${item.href}#${k}` : item.href,
        title: section.title ?? `Section ${chapters.length + 1}`,
        text: section.text,
        hints: section.hints,
      });
    });
  }
  if (chapters.length === 0) throw new EpubError('No readable chapters were found in this EPUB.');
  return { title, chapters };
}

/** Extracts the text of an XHTML document body, with emphasis (em/i) ranges as hints. */
export function extractText(doc: Document): { text: string; hints: Hint[] } {
  const builder = new TextBuilder();
  const body = doc.body ?? doc.getElementsByTagName('body')[0] ?? doc.documentElement;
  builder.walk(body);
  return { text: builder.out, hints: builder.hints };
}

export interface Section {
  title?: string;
  text: string;
  hints: Hint[];
}

/**
 * Splits a document at its h1–h3 headings. Text before the first heading (front matter) is a
 * section of its own; blank sections are dropped.
 */
export function extractSections(doc: Document): Section[] {
  const builder = new TextBuilder();
  builder.walk(doc.body ?? doc.getElementsByTagName('body')[0] ?? doc.documentElement);
  const { out: text, hints, headings } = builder;
  const starts = [{ start: 0, title: undefined as string | undefined }, ...headings];
  const sections: Section[] = [];
  starts.forEach((h, i) => {
    const end = starts[i + 1]?.start ?? text.length;
    // The paragraph break before the next heading belongs to neither section.
    const sectionText = text.slice(h.start, end).replace(/\n+$/u, '');
    if (!/\S/u.test(sectionText)) return;
    const sectionEnd = h.start + sectionText.length;
    sections.push({
      title: h.title,
      text: sectionText,
      hints: hints
        .filter((x) => x.start < sectionEnd && x.end > h.start)
        .map((x) => ({
          ...x,
          start: Math.max(x.start, h.start) - h.start,
          end: Math.min(x.end, sectionEnd) - h.start,
        })),
    });
  });
  return sections;
}

/** Joins chapters into one part: paragraphs separated by a blank line, hints shifted. */
export function combineChapters(chapters: readonly EpubChapter[]): { text: string; hints: Hint[] } {
  let text = '';
  const hints: Hint[] = [];
  for (const c of chapters) {
    if (text) text += '\n\n';
    const offset = text.length;
    hints.push(...c.hints.map((h) => ({ ...h, start: h.start + offset, end: h.end + offset })));
    text += c.text;
  }
  return { text, hints };
}

const HEADINGS = new Set(['h1', 'h2', 'h3']);

class TextBuilder {
  out = '';
  hints: Hint[] = [];
  /** Where each h1–h3 heading's text starts in `out`, with the heading text as a title. */
  headings: Array<{ start: number; title: string }> = [];
  private pendingBreak: 0 | 1 | 2 = 0;
  private pendingSpace = false;
  /** Open em/i and heading elements, each waiting for the offset of its first text. */
  private readonly openEmphasis: Array<{ start: number | null }> = [];

  walk(node: Node): void {
    if (node.nodeType === 3 /* text */ || node.nodeType === 4 /* CDATA */) {
      this.write(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== 1 /* element */) return;
    const name = (node as Element).localName.toLowerCase();
    if (SKIPPED.has(name)) return;
    if (name === 'br') {
      this.pendingBreak = Math.max(this.pendingBreak, 1) as 1 | 2;
      return;
    }
    const block = BLOCKS.has(name);
    const emphasis = EMPHASIS.has(name);
    if (block) this.pendingBreak = 2;
    const marker = { start: null as number | null };
    if (emphasis) this.openEmphasis.push(marker);
    const heading = HEADINGS.has(name) ? { start: null as number | null } : undefined;
    if (heading) this.openEmphasis.push(heading);
    for (const child of Array.from(node.childNodes)) this.walk(child);
    if (heading) {
      this.openEmphasis.splice(this.openEmphasis.indexOf(heading), 1);
      const title = (node.textContent ?? '').replace(HTML_SPACE, ' ').trim();
      if (heading.start !== null) this.headings.push({ start: heading.start, title });
    }
    if (emphasis) {
      this.openEmphasis.splice(this.openEmphasis.indexOf(marker), 1);
      if (marker.start !== null && this.out.length > marker.start) {
        this.hints.push({ start: marker.start, end: this.out.length, kind: 'emphasis' });
      }
    }
    if (block) this.pendingBreak = 2;
  }

  private write(raw: string): void {
    let t = raw.replace(HTML_SPACE, ' ');
    if (!t) return;
    if (t.startsWith(' ')) {
      this.pendingSpace = true;
      t = t.slice(1);
    }
    const trailing = t.endsWith(' ');
    if (trailing) t = t.slice(0, -1);
    if (!t) return;
    this.flush();
    for (const m of this.openEmphasis) m.start ??= this.out.length;
    this.out += t;
    this.pendingSpace = trailing;
  }

  private flush(): void {
    if (this.out) {
      if (this.pendingBreak) this.out += this.pendingBreak === 2 ? '\n\n' : '\n';
      else if (this.pendingSpace) this.out += ' ';
    }
    this.pendingBreak = 0;
    this.pendingSpace = false;
  }
}

async function readXml(zip: JSZip, path: string): Promise<Document> {
  const file = zip.file(path);
  if (!file) throw new EpubError(`The EPUB is missing ${path}.`);
  const doc = new DOMParser().parseFromString(
    withoutXmlDeclaration(await file.async('string')),
    'application/xml',
  );
  if (doc.getElementsByTagName('parsererror').length) {
    throw new EpubError(`The EPUB file ${path} is not valid XML.`);
  }
  return doc;
}

async function readHtml(zip: JSZip, path: string): Promise<Document | undefined> {
  const file = zip.file(path);
  if (!file) return undefined;
  const source = withoutXmlDeclaration(await file.async('string'));
  const xhtml = new DOMParser().parseFromString(source, 'application/xhtml+xml');
  if (!xhtml.getElementsByTagName('parsererror').length) return xhtml;
  // Some EPUBs ship HTML that is not well-formed XML.
  return new DOMParser().parseFromString(source, 'text/html');
}

/**
 * JSZip has already decoded the file, so the XML declaration carries no information; some
 * parsers reject valid single-quoted declarations (<?xml version='1.0'?>), so drop it.
 */
function withoutXmlDeclaration(source: string): string {
  return source.replace(/^\uFEFF?\s*<\?xml[^?]*\?>/u, '');
}

/** Resolves an href relative to the OPF folder ("../Text/ch1.xhtml#x" → "OEBPS/Text/ch1.xhtml"). */
function resolve(base: string, href: string): string {
  const parts = (base + decodeURIComponent(href.split('#')[0]!)).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}
