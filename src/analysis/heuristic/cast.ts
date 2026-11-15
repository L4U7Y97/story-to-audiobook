/** The cast as a part's reading builds it, and the mentions a run of tokens has in that cast. */

import type { Character, Gender } from '@/format/types';
import { castEntry, matchCast, type CastEntry } from '../castMatch';
import type { AliasAddition, NewCharacter } from '../labels';
import { findMentions } from './mentions';
import type { Mention, Token } from './tokens';

export class Cast {
  readonly entries: CastEntry[];
  readonly narratorKey: string;
  readonly unknownKey: string;
  readonly aliasAdditions: AliasAddition[] = [];
  /** Counts the names and aliases added to the cast, which change what mentions finds. */
  private castVersion = 0;
  private readonly mentionCache = new WeakMap<Token[], { version: number; mentions: Mention[] }>();
  private newCount = 0;

  constructor(cast: readonly Character[]) {
    this.entries = cast.map((c) => castEntry(c));
    this.narratorKey = cast.find((c) => c.role === 'narrator')!.id;
    this.unknownKey = cast.find((c) => c.role === 'unknown')!.id;
  }

  get version(): number {
    return this.castVersion;
  }

  match(name: string): CastEntry | undefined {
    return matchCast(name, this.entries);
  }

  /** The keys of the people these mentions name who are in the cast or found in the part. */
  keys(mentions: Mention[]): string[] {
    return mentions
      .map((m) => matchCast(m.name, this.entries)?.key)
      .filter((k): k is string => k !== undefined);
  }

  mentions(tokens: Token[]): Mention[] {
    // The same tokens are read for many verbs; the mentions change only with the cast.
    const cached = this.mentionCache.get(tokens);
    if (cached?.version === this.castVersion) return cached.mentions;
    const mentions = findMentions(tokens, (name) => !!matchCast(name, this.entries));
    this.mentionCache.set(tokens, { version: this.castVersion, mentions });
    return mentions;
  }

  /**
   * Finds or creates the character a mention refers to. `learn`: the mention names a speaker (a
   * tag or colon-intro subject), so a new name for an existing character is kept as an alias;
   * the narrator and the unknown speaker never get aliases from here.
   */
  resolve(m: Mention, learn = false): string {
    const existing = matchCast(m.name, this.entries);
    if (existing) {
      if (existing.role !== 'character') return existing.key;
      if (m.gender && !existing.gender) existing.gender = m.gender;
      const known = [existing.name, ...existing.aliases].some(
        (n) => n.toLowerCase() === m.name.toLowerCase(),
      );
      if (!known && learn) {
        existing.aliases.push(m.name);
        this.castVersion++;
        if (!existing.key.startsWith('new:')) {
          this.aliasAdditions.push({ characterId: existing.key, alias: m.name });
        }
      }
      return existing.key;
    }
    const entry: CastEntry = {
      key: `new:${++this.newCount}`,
      name: m.name,
      aliases: [],
      gender: m.gender,
      role: 'character',
    };
    this.entries.push(entry);
    this.castVersion++;
    return entry.key;
  }

  /** A gender learned for `key`. It changes no name, so what mentions finds stays the same. */
  learnGender(key: string, gender: Gender): void {
    this.entry(key).gender = gender;
  }

  entry(key: string): CastEntry {
    return this.entries.find((e) => e.key === key)!;
  }

  /** The characters this part added who say a line in `used`, with their entries' own aliases. */
  newCharacters(used: ReadonlySet<string>): NewCharacter[] {
    return this.entries
      .filter((e) => e.key.startsWith('new:') && used.has(e.key))
      .map((e) => ({
        ref: e.key,
        name: e.name,
        aliases: e.aliases,
        ...(e.gender ? { gender: e.gender } : {}),
      }));
  }
}
