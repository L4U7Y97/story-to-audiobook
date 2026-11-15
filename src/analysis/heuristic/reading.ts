/** What every reader of a part shares: the Lookup and Reading views of it, and Who says a line. */

import type { Unit } from '../units';
import type { Cast } from './cast';
import type { Turns } from './turns';

/** Reading a part without changing its cast: the text, a unit's text, who a name or mention is. */
export interface Lookup {
  readonly text: string;
  slice(u: Unit): string;
  readonly cast: Pick<Cast, 'mentions' | 'match' | 'keys'>;
}

/** The whole reading of a part: its cast and turn-taking, which readers may change. */
export interface Reading extends Lookup {
  readonly cast: Cast;
  readonly turns: Turns;
}

/** A speaker, and whether the teller's "I" chose them rather than a name or turn-taking. */
export interface Who {
  key: string;
  teller: boolean;
}

/** A speaker found by a name, a pronoun or turn-taking: not chosen by the teller's "I". */
export function someone(key: string | undefined): Who | undefined {
  return key === undefined ? undefined : { key, teller: false };
}
