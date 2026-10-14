import { canonicalize } from './canonicalize';

/** Pasted text is taken verbatim apart from the canonical line-ending rules. */
export function fromPaste(raw: string): string {
  return canonicalize(raw);
}
