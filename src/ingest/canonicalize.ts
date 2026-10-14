const BOM = '﻿';

/**
 * The only transformations ever applied to story text, before any offset exists:
 * strip a leading byte-order mark and convert CRLF / CR line endings to LF.
 * Everything else — whitespace, quotes, dashes, Unicode forms — is kept exactly as given.
 */
export function canonicalize(raw: string): string {
  const withoutBom = raw.startsWith(BOM) ? raw.slice(1) : raw;
  return withoutBom.replace(/\r\n?/g, '\n');
}
