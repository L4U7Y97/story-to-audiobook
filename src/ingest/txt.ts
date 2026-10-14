import { canonicalize } from './canonicalize';

export interface IngestedText {
  title: string;
  text: string;
  /** Shown to the user when the import needed a guess (e.g. a legacy encoding). */
  notice?: string;
}

/** Decodes a .txt file as UTF-8, falling back to windows-1252 for legacy files. */
export function decodeTxt(bytes: ArrayBuffer | Uint8Array): { text: string; notice?: string } {
  try {
    return { text: canonicalize(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch {
    return {
      text: canonicalize(new TextDecoder('windows-1252').decode(bytes)),
      notice: 'This file is not UTF-8; it was read as Windows-1252 (Western European).',
    };
  }
}

export async function readTxtFile(file: File): Promise<IngestedText> {
  const decoded = decodeTxt(await file.arrayBuffer());
  return { title: titleFromFileName(file.name), ...decoded };
}

export function titleFromFileName(name: string): string {
  return name.replace(/\.[^.]+$/, '').trim() || name;
}
