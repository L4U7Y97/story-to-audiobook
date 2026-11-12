# Spec: Story to Audiobook (MVP)

Status: **approved 2026-10-14**. Source of intent: [docs/intent/story-to-audiobook.md](docs/intent/story-to-audiobook.md).

## Objective

A personal app that reads stories aloud with a distinct voice for the narrator and for each character. The user uploads a story as a whole or in parts (.txt, .epub or pasted text). The app first **analyses** each part into a standard format that says, for every range of characters, who is speaking or thinking it, how (narration, speech, thought, written text), and in what tone. **The story text is never modified.** Each story keeps a persistent **cast**: characters, aliases and voice settings. Later uploads reuse the same voices, and the user can change any voice at any time.

- **User:** one person, using an Android phone (primary) and a desktop browser (secondary). No accounts, no backend.
- **Primary scenario:** upload chapter 1 today and chapter 2 next week, hear the same voices for the same people, and keep listening with the phone locked in a pocket.

### User stories

1. As the user, I can create a story and add a part by picking a .txt or .epub file or by pasting text, and choose where in the story the part goes.
2. As the user, I can add, insert, reorder, rename, replace and delete parts at any time.
3. As the user, each part is analysed automatically after upload: with my LLM API key if one is set, or with a free on-device method if not. I can see the progress.
4. As the user, I can see the story's cast, rename characters, add aliases, merge duplicates and change each character's voice (device voice, pitch, speed), with a "preview" button.
5. As the user, I can correct who a segment belongs to (tap a segment → pick a character, or create a new one), for one line, the rest of a part, a whole part ("told by"), or a passage such as a letter or a tale someone tells.
6. As the user, I can press play and hear the story from where I left off, with each segment in its speaker's voice. Playback continues with the screen locked and moves on to the next part by itself.
7. As the user, I can follow along in a text view that highlights the segment being spoken, and tap any paragraph to play from there.
8. As the user, I can export a story (text, analysis, cast) to a single JSON file and import it again, because all data lives only on my device.

## Capability map

The modules are tightly coupled through one shared contract, the **story format**, so they live in one spec with a section each. Module ids are stable and are used by the plan and tasks.

| Module id  | Responsibility                                                                              | Depends on       |
| ---------- | ------------------------------------------------------------------------------------------- | ---------------- |
| `format`   | Types, invariants and validation of the story format (the contract every other module uses) | —                |
| `storage`  | IndexedDB persistence, export and import, settings, API key                                 | `format`         |
| `ingest`   | .txt, .epub and pasted text → canonical part text                                           | `format`         |
| `analysis` | Unit segmentation, heuristic analyser, LLM analyser, merging results into segments          | `format`         |
| `cast`     | Automatic voice assignment, merge, rename, alias handling                                   | `format`         |
| `playback` | Speech engine adapters (web, Android native), queue, position tracking                      | `format`, `cast` |
| `ui`       | Vue screens: library, story, parts, cast, reader and player, settings                       | all              |

**Build order:** `format` → `storage`, `ingest` → `analysis` (heuristic first, then LLM) → `cast` → `playback` (web, then Android) → `ui` (grows alongside, one vertical slice at a time).
**Risk-first exception:** the Android background-playback spike (R1) runs **before** any module work. See [Risks](#risks).

## Tech stack

| Concern                  | Choice                                                                                  | Notes                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Language                 | TypeScript 5.x, `strict: true`                                                          |                                                                                                  |
| UI                       | Vue 3 (Composition API, `<script setup>`)                                               | Same family as the earlier attempt in git history                                                |
| Build                    | Vite                                                                                    | Dev server on port **3000** to match `.claude/launch.json`                                       |
| Native shell             | Capacitor 8, **Android only**                                                           | iOS out of scope                                                                                 |
| Storage                  | IndexedDB via Dexie 4                                                                   | `navigator.storage.persist()` requested on first run                                             |
| Small settings / API key | `@capacitor/preferences` (Android SharedPreferences, `localStorage` on web)             |                                                                                                  |
| Export files (Android)   | `@capacitor/filesystem` + `@capacitor/share` (write to cache, open the share sheet)     | On the web the export is a normal download                                                       |
| EPUB                     | JSZip + `DOMParser` (no epub framework)                                                 | Full control over text extraction                                                                |
| LLM                      | `@anthropic-ai/sdk` + `zod` (structured outputs via `output_config.format`)             | Called straight from the client with the user's key (`dangerouslyAllowBrowser: true`). No proxy. |
| TTS (web)                | Web Speech API `speechSynthesis`                                                        |                                                                                                  |
| TTS (Android)            | Native Android `TextToSpeech` behind a Capacitor plugin with a foreground media service | Decided by spike R1                                                                              |
| Tests                    | Vitest, `fake-indexeddb`, `happy-dom`, `fast-check` (property tests for invariants)     |                                                                                                  |
| Lint and format          | ESLint (typescript-eslint + eslint-plugin-vue), Prettier                                |                                                                                                  |

**Prerequisites:** Node 22 LTS, JDK 21, Android Studio (SDK + platform tools), an Android phone with USB debugging.

## Commands

```
Install:        npm install
Dev (web):      npm run dev                 # vite --port 3000
Typecheck:      npm run typecheck           # vue-tsc --noEmit
Lint:           npm run lint                # eslint . --max-warnings 0
Format:         npm run format              # prettier --write .
Test:           npm test                    # vitest run
Test (watch):   npm run test:watch          # vitest
Coverage:       npm run test:coverage       # vitest run --coverage
LLM eval:       npm run eval:llm            # needs ANTHROPIC_API_KEY; real API calls, costs money
Build (web):    npm run build               # vue-tsc --noEmit && vite build
Android sync:   npm run android:sync        # npm run build && npx cap sync android
Android APK:    npm run android:apk         # android:sync, then android\gradlew.bat assembleDebug
Android run:    npm run android:run         # npx cap run android (device over USB)
Open Studio:    npx cap open android
```

## Project structure

```
src/
  format/        → types.ts, invariants.ts, validate.ts (pure TS, no Vue, no I/O)
  storage/       → db.ts (Dexie schema), repositories, exportImport.ts, settings.ts
  ingest/        → txt.ts, epub.ts, paste.ts, canonicalize.ts
  analysis/
    units.ts     → splits text into units (paragraph/quote/dash boundaries)
    heuristic/   → speechVerbs.{en,es}.ts, attribute.ts, tone.ts, index.ts
    llm/         → prompt.ts, schema.ts (zod), client.ts, chunking.ts, cost.ts
    merge.ts     → unit labels → validated segments
    analyzer.ts  → picks LLM or heuristic and runs a part through it
  cast/          → assignVoices.ts, merge.ts, aliases.ts
  playback/
    engine.ts    → SpeechEngine interface
    webEngine.ts → speechSynthesis implementation
    nativeEngine.ts → Capacitor plugin bridge
    player.ts    → queue, position, part advance
  ui/
    views/       → LibraryView, StoryView, ReaderView, CastView, SettingsView
    components/  → small presentational components
  main.ts, App.vue
android/         → Capacitor Android project (generated; native plugin in android/app/src/main/java/.../narrator/)
tests/
  unit/          → mirrors src/ (format, ingest, analysis, cast, storage, playback)
  fixtures/      → short public-domain samples (en + es), hand-labelled expected segments
docs/
  intent/        → confirmed intent
  adr/           → architecture decisions (e.g. ADR-001 native TTS service)
SPEC.md          → this file
```

## The story format (module `format`)

This is the core contract. Everything is stored as plain JSON in IndexedDB, and the same shapes are used for export.

```ts
export const SCHEMA_VERSION = 1;

export type Lang = 'en' | 'es';
export type Mode = 'narration' | 'speech' | 'thought' | 'written'; // written = letters, signs, notes read aloud
export type ToneLabel =
  | 'neutral'
  | 'whisper'
  | 'shout'
  | 'angry'
  | 'sad'
  | 'happy'
  | 'fearful'
  | 'sarcastic'
  | 'tender'
  | 'excited'
  | 'tired'
  | 'urgent'
  | 'mocking'
  | 'pleading';

export interface Tone {
  label: ToneLabel;
  intensity?: 1 | 2 | 3; // mild / clear / extreme
  notes?: string; // free-form, e.g. "through tears", "drunk" — stored, not voiced in MVP
}

export interface Story {
  id: string; // uuid
  schemaVersion: number;
  title: string;
  lang: Lang;
  partIds: string[]; // reading order; with books, grouped by book (all of book 1's parts, then book 2's…)
  books?: { id: string; title: string }[]; // optional: separate books of one story (a series), in order; when present every Part has a bookId of one of them; the cast is shared by all books
  cast: Character[];
  narratorId: string; // always present; a Character with role 'narrator': the default teller, who reads narration unless a part or passage is told by a character; may carry the main narrator's name and aliases
  position?: { partId: string; segmentIndex: number };
  createdAt: string;
  updatedAt: string; // ISO
}

export interface Character {
  id: string;
  role: 'narrator' | 'character' | 'unknown'; // one 'unknown' bucket for unattributed speech
  name: string;
  aliases: string[]; // "Liz", "Miss Bennet"
  gender?: 'male' | 'female' | 'other'; // hint for voice choice only
  description?: string; // short, from the LLM; helps keep later parts consistent
  voice: VoiceSettings;
  firstSeenPartId?: string;
}

export interface VoiceSettings {
  voiceName?: string; // device voice id; may be missing on another device
  lang: string; // BCP-47, e.g. 'es-AR'; used when voiceName is unavailable
  pitch: number; // 0.5–2.0
  rate: number; // 0.5–2.0, multiplied by the player's global speed
}

export interface Part {
  id: string;
  storyId: string;
  bookId?: string; // set iff the story has books
  title: string;
  source: { kind: 'txt' | 'epub' | 'paste'; fileName?: string; epubHref?: string };
  text: string; // canonical text — immutable after creation
  textHash: string; // SHA-256 of text
  hints?: Hint[]; // non-text metadata from the source, e.g. EPUB italics
  analysisStatus: 'pending' | 'running' | 'done' | 'failed';
}

export interface Hint {
  start: number;
  end: number;
  kind: 'emphasis';
}

export interface Analysis {
  partId: string;
  textHash: string; // must equal Part.textHash or the analysis is stale
  analyzer: { kind: 'llm' | 'heuristic' | 'mixed'; model?: string; version: number };
  createdAt: string;
  segments: Segment[];
}

export interface Segment {
  start: number; // UTF-16 code-unit offset into Part.text, inclusive
  end: number; // exclusive
  speakerId: string; // Character.id; for narration, whoever tells that stretch (the narrator, or a character telling it in the first person)
  mode: Mode;
  tone?: Tone;
  source: 'llm' | 'heuristic' | 'user'; // 'user' = manual correction, never overwritten by re-analysis of other parts
}
```

### Invariants (checked by `validate.ts`; any violation means the analysis is rejected, never stored)

1. **Tiling:** segments are sorted, contiguous and cover the whole text: `segments[0].start === 0`, `segments[i].end === segments[i+1].start`, `last.end === text.length`, and every `start < end`.
2. **Text preservation:** `segments.map(s => text.slice(s.start, s.end)).join('') === text`. This follows from (1) but is asserted explicitly as the headline guarantee.
3. Every `speakerId` exists in `story.cast`.
4. `analysis.textHash === part.textHash`.
5. Whitespace-only stretches between spoken content belong to a neighbouring segment (whitespace never gets its own speaker). Playback skips segments whose text is only whitespace or punctuation.

Offsets are UTF-16 code units, the native unit of both JS strings and Java/Kotlin strings, so ranges mean the same thing on both sides of the Capacitor bridge.

## Module `ingest`

**Canonical text.** The text stored in `Part.text`. The only transformations ever applied, all at import time and before any offset exists:

- Strip a leading BOM.
- Convert `\r\n` and `\r` to `\n`.
- **.txt:** decode as UTF-8. If that fails, fall back to windows-1252 and show a notice.
- **.epub:** read `META-INF/container.xml` → OPF → spine order. For each XHTML document, extract text nodes in document order, collapsing source whitespace (spaces, tabs, newlines) the way a browser renders it; U+00A0 is kept. Block elements (`p`, `div`, `h1–h6`, `li`, `blockquote`, …) are separated by `\n\n`, and `br` becomes `\n`. Images, scripts and styles are dropped. `<em>`/`<i>` ranges become `Hint{kind:'emphasis'}` (a common marker for thoughts). Each spine document is split at its `h1`–`h3` headings (files often hold several chapters), and each section becomes a suggested part, which the user can deselect or combine in a preview before importing. Title pages, licences and tables of contents start unselected.
- **Paste:** taken verbatim (after the two normalisations above).

No Unicode normalisation, no whitespace collapsing, no hyphen repair. After creation `Part.text` is **never written again**. "Replace part" creates new text and a new hash, discards the old analysis, and keeps the part id and position.

## Module `analysis`

### Step 1: Units (shared by both analysers)

`units.ts` splits a part's text into **units**, the smallest pieces that get labelled. Boundaries are:

- paragraph breaks (`\n`)
- quoted speech: `"…"`, `“…”`, `«…»`, `‘…’` (straight `'` only when clearly a quote and not an apostrophe)
- Spanish dash dialogue: a paragraph starting with `—` opens speech; a later `—` followed by a narration cue (lowercase word, or a speech verb) switches to narration (the _inciso_); the next `—` returns to speech
- Spanish multi-paragraph quotations: a paragraph that starts with `»` after a paragraph left inside `«…»` continues the quotation

Units tile the text (same invariants as segments). Each unit has a provisional mode: `speech` if inside quotes or dash dialogue, otherwise `narration`.

### Step 2a: Heuristic analyser (no API key)

- **Speaker attribution** in a window around each speech unit:
  - speech verb + name or descriptor (`said Elizabeth`, `Elizabeth replied`, `—dijo Elizabeth`, `—dijo la Nela`, `—dijo entonces el doctor`), using en/es verb lists. A subject before the verb wins over a word after it (`Tom asked Anne` → Tom), and so does one right before a short aside (`Tom, red-faced, shouted`, `At last Mr. Bennet, laying down his paper, said`); a verb after `, and` and an aside goes with the clause before it (`Nela miró a Pablo, y después de un rato, dijo:` → Nela), unless the person before the aside opens the sentence (`Suddenly Tom, and I shall never forget it, shouted` → Tom) and the verb has no subject after it (`—dijo Ana, y después de un rato, respondió Pablo` → Pablo). A verb joined by `and` or `then` has the subject of the clause right before the join when that clause has a verb after its subject, also past a set phrase or a short phrase (`Tom came in, and Anne smiled and then said` → Anne, `and Anne at last looked up and said`, `and the old man by the fire looked up and said`, `Pablo entró, Nela se levantó, y después de un rato, dijo:` → Nela, `y Nela por fin levantó la vista y dijo:`, `y la mujer del panadero abrió y le dijo:`, `Pablo cogió el abrigo, su madre suspiró y dijo:` → su madre), else the sentence’s (`Then Mr. Darcy bowed and said`, `Tom waited until she had finished, then said` → Tom). After a name, in a stretch that runs to a comma before the join, an English verb has a verb's shape (`Tom came in, Anne cast a glance at him, and said` → Anne), but a participle or adjective that tells a state is no verb (`Anne still pale,`, `Anne quite exhausted beside him,`, `Anne bound for London with him,` → Tom), and neither is a Spanish participle in past narration or an adjective after a set phrase (`Pablo entró, Nela de pronto pálida, y dijo:` → Pablo). Adverbs, an emphatic `herself` and set phrases may come before the verb (`and Anne herself opened the door and said`, `and Anne once more smiled and said`, `y Ana por fin apoya la cabeza en su hombro y dice:` → Anne, Ana); right after `and` or `y`, with no comma before the join, any phrase may, before a verb in any tense (`and Anne without a word gathers up her notes and says` → Anne), though not the rest of an object list (`Tom kissed his mother, and Anne on both cheeks and said` → Tom). An appositive, the rest of a list, a phrase with no verb and someone's comment are no such clause (`Tom looked at his daughter, Jane, and said`, `Tom kissed his mother, then his sister, and said`, `Tom looked at Mary, then at Anne, and said`, `Tom waited at the door, Anne at his side, and said`, `Tom thanked everyone, Jane included, and said`, `Tom looked at the two girls, Anne still pale, and said`, `Tom sat down, Anne opposite, and said`, `Tom hesitated, she thought, and then said`, `Tom hesitated, Anne must have noticed, and then said`, `Tom was lying, Anne was sure, and then said`, `Pablo abrazó a su hijo, un niño de seis años, y le dijo:`, `Pablo entró, Nela todavía dormida, y dijo:` → Tom, Pablo), though a comment `and` or `but` opens is (`but Anne noticed, and said` → Anne), and so is one with an object (`Tom hesitated, Anne saw it, and said`, `Pablo tosió, Ana lo oyó, y gritó desde la cocina:` → Anne, Ana) and, in Spanish present narration, a bare `ve`, `oye`, `nota` or `siente` (`Ana la llama desde el patio, Nela oye, y responde:` → Nela), unless its subject asked the question the line answers and someone hesitated (`—¿Pasa algo? —preguntó Ana.` / `Pablo dudó, ella lo vio, y luego dijo: —No.` → Pablo). A purpose after an act, `so` with a modal (`Tom held the door, so Anne could get through, and said` → Tom), is no such clause either, though after a state `so` opens one (`Tom was gone, so Anne could at last ask her question, and said` → Anne). Between commas a descriptor opens such a clause only after `and` or `but`, before a Spanish past form (`su madre se puso en pie, y dijo:`), or right after a phrase or clause that opens a sentence with no subject of its own (`Seeing Tom, the old woman rose, and said` → the old woman; in English that opening may run on past a comma when nobody is its subject or when `and` goes on with it: `When the music stopped, and the dancers had gone, the old man rose, and said`, `When the music stopped, and Anne sat down again, the old man rose, and said` → the old man; after such an English opening, the last part before the join is the clause when its descriptor's verb is an irregular past, which is never a participle: `When the music stopped, Tom looked at Anne, the old man rose, and said` → the old man; not `Cuando Ana llegó, abrazó a su hijo, un niño pálido y delgado, y le dijo:` → Ana). The teller's hedge is no such clause (`Anne hesitated, I think, and said`, `Anne hesitated, I was told, and said` → Anne), though the clause after it is (`Tom came in, and I suppose Anne smiled and said` → Anne), and the teller's comment is one only on a state (`Anne was right, I thought, and said` → the narrator, but `Tom hesitated, I noticed, and then said` → Tom). After the teller watched someone (`I noticed that Anne looked away, and after a moment, said`) turn-taking decides, but a `that` after a noun or `knew` brings in nobody (`I put on the coat that Anne had given me, and after a moment, said` → the narrator). A subject `and` or `y` brings in right before an aside is the tag's when it cannot be one more object: right after the tag's own subject, also past an adverb (`said Anne slowly, and Tom, and after a moment, replied` → Tom) or, before a reply, past the person the tag is said to (`said Mrs. Bennet to Tom, and Anne, and after a pause, replied` → Anne, but `said Mrs. Bennet to Anne, and Tom, and after a moment, added` → Mrs. Bennet), as `he` or `él`, in Spanish without the `a` of the person before it or after `y entonces` (`Nela miró a Ana, y el médico, y después de un rato, dijo:`, `Nela cerró la puerta, y entonces el médico, y después de un rato, dijo:` → el médico; `y entonces al médico,` stays an object, and so does `y entonces una enfermera,` after `pidió un médico,`), or before an aside that is a remark of its own when no person, or people a plural noun names, comes right before the `and` (`dijo Nela, y Pablo, y esto no lo olvidaré nunca, respondió` → Pablo, `Mrs. Bennet looked at Anne, and he, and this I will never forget, said` → Tom, `Mrs. Bennet looked away, and Anne, and this surprised me, said` → Anne, but `Mrs. Bennet kissed the twins, and Anne, and I shall never forget it, said` → Mrs. Bennet), never in a list (`Mrs. Bennet kissed Tom, and then Anne, and after a moment, said` → Mrs. Bennet). With no cast, the teller's hedge still makes the teller say nothing (`Elizabeth hesitated, I believe, and then said` → not the narrator). In Spanish, someone in an aside that `cuando` or `al` opens after the join, who sees or hears the person (`la vio`, `la ve`, `verla`), says the line unless they spoke last (`Ana entró, y cuando Pablo la vio, exclamó:` → Pablo), but not someone who acts on them (`Ana estaba en el jardín, y cuando Pablo la llamó, contestó:` → Ana). `to X`, `a X` and `al X` name the person spoken to, never the speaker. An indefinite subject (`someone said`, `said somebody else`, `Someone turned and said`, `Then someone said:`, `—dijo alguien`) → the `unknown` character. A verb with an object of its own reports speech and tags no line (`She nodded and said goodbye.`, `He said nothing.`, `dijo adiós`, `Tom had said so early that morning.`, `Tom had said so early that very morning.`, `Ninguno dijo nada más.`, `Apenas dijo nada en toda la tarde.`), unlike an adverb after it (`I said so quietly that he leaned in`, `—dijo nada más entrar`, `—dije nada más dármelo`, `—Sí —dije nada más.`, `dije algo nervioso`).
  - first-person tags (`I said`, `said I`, `I'd said`, `I ask.`, `I tell Mom.`, `I turned to her and said:`, `—dije`, `—respondí`, `—le pregunté`, `—pregunto`; never a question such as `Should I tell Mom?`, though `Only then did I tell her.` is a tag) → the narrator entry. A tag said to the narrator (`me dijo`, `asked me`, `said to me`, `I was asked`) or with someone else as its subject (`she asked`, `someone said`; in a first-person part also `—dijo` and `—añadió`, but not `—decía`, which can mean `yo decía`) never goes to the narrator. Hearsay is read by the verb it reports: `I was told I said` is the narrator's, `I was told she asked` is hers.
  - a **first-person part** has at least one tag by the narrator or said to the narrator. Only the verb a tag is read from counts (the first one after a line, else the last one before it, or a colon intro's), so an `I` next to a tag (`said Elizabeth. As I have said, she was tired.`, `I said nothing. “Eat,” Mom said.`), before another subject's verb (`I suppose she sighed and said`, `I daresay Mrs. Bennet turned and said`), in a question (`“Tom?” Why had he told me nothing?` and `Did he mean it, I asked myself, as I watched him go?`, which tag no line, though `“I’m fine,” I said, but was I?`, `“I’m fine!” Will said, but was he?`, `“Goodbye!” When he turned, Anne whispered, but did he hear?` and `I said, because what else could I say?` are tags: a cast name before its verb, or a wh-word before its subject, opens no question), in a character's thought (`She told me so, Tom thought.`) or in an aside (`as my aunt told me`, `como nos dice el refrán`) does not make one.
  - pronoun (`she asked`, `she turned and said`, `—dijo él`) → the most recent character of matching gender, preferring people named earlier in the same paragraph; never the narrator, never the person the line is said to. A reply verb (`replied`, `respondió`) skips the person just answered; in a colon intro after a tag it does so when the line asked something (a question anywhere in it, even after someone else's question: `“Is that you?” asked Mary.` / `“Where were you? I waited all night,” said Anne, and she replied:` → Mary) or was said to someone (`“Where were you?” asked Tom, and he answered:`, `“Where were you?” said Anne, and she replied:`, `“Good night, Mama,” said Anne, and she replied:`, `—Buenas noches, hermana —dijo Ana, y ella respondió:`), or when nothing but the reply's `he` or `she` and their gestures comes between the line and the reply (`“You’re late,” said Anne, and she replied:`), unless the line answers a question asked just before it; across a heading, only a line that just hesitates still answers it (`“Will you marry me?” asked Tom.` / `CHAPTER II` / `“Well,” said Anne, and she answered:` → Anne), and not after a paragraph that sets the new scene with its people (`CHAPTER II` / `Anne and Mary sat by the fire.` / `“Well,” said Anne, and she replied:` → Mary). The tag's speaker goes on after someone else's act or question (`“Out,” said Tom, and when she frowned, he answered:`, `“I’m going out,” said Anne. When Mary asked where, she answered:`), after an aside that says so (`“Who?” said Anne, and then, recovering herself, she answered:`, `reponiéndose`; not `volviéndose hacia la puerta` or `contentándose con eso`) and when the reply answers itself (`and she answered her own question:`, `y ella se respondió a sí misma:`). Someone of that gender the intro opens with answers unless they asked (`“It’s cold tonight,” said Anne. Mary nodded, and then she replied:` → Mary; not knowing what to say asks nothing: `Mary did not know what to say, and then she replied:` → Mary), and the person the reply is said to never gives it (`and then she replied to her sister:`). A colon intro whose verb has a subject of its own gives the line to that subject (`“You’re late,” said Anne, and Mary replied:` → Mary), also when it reports the answer (`—¿Vendrás? —preguntó Pablo, y Nela dijo que no:` → Nela). When nobody of that gender is found, nothing else (a beat, the paragraph's other tags, a continuation, turn-taking) gives the line, or the line after a colon intro such as `She turned and said:`, to someone whose known gender is another (a gender the analyser only guessed from such a line in this part is not known): it goes to someone else the rules below allow, or to the `unknown` character.
  - the subject of an action beat right before the line in the same paragraph, or of an inciso between two lines, when the beat names nobody else and its subject is a pronoun, the narrator's `I`, a descriptor or a name already known (a cast member or a character found earlier in the part; a beat never adds a name) (`Tom shrugged. “Nowhere.”`, `—Hola —Ana sonrió—. ¿Qué tal?`, `—Nada —me encogí de hombros—.`)
  - continuation verbs with no subject (`added`, `añadió`, `prosiguió`) → the last speaker, unless the verb rules them out (`—añadió` after the narrator's line in a first-person part)
  - unattributed back-and-forth → alternate between the last two speakers. In a first-person part the narrator takes part even before it speaks, and the next speaker is, in this order: someone the narration has just brought in or the last line was said to; someone who has spoken in the current scene, latest first (the narrator among them); the narrator, if it has not; earlier speakers; people only mentioned. A scene starts when someone the narration brought in after a scene break, time passing or someone leaving (`* * *`, `In the evening`, `Tom left.`, but not `A moment later` or `on my left`), or in the clause where time passes (`Then Anne came to see me that evening.`, `I went to see Anne the next day.`), speaks for the first time with a tag or beat of their own. A later scene break, or someone who has spoken leaving (also `everyone had left`), counts for people named before it too (`Then Anne came in, and Tom left.`); a later time cue counts only for someone so far only named, in a sentence about them, at its start or, when they arrive, in its subject’s own clause (`I had not seen Anne for a month. In the evening she came to see me.`, `I had asked Anne to come. She arrived that evening.`, `She appeared the next morning.`, `She came with her mother that evening.`, `She only came that evening.`, `Anne was not back until that evening.`, `Anne did not even come down until that evening.`, `Anne didn’t make it back until the next morning.`, `She came round to see how I was the next morning.`, `No vi a Ana hasta el día siguiente.`, `Se presentó una hora más tarde.`, `Regresó a recogerlas al día siguiente.`, `I had sent Anne to the village. She returned that evening.`, `Suddenly Anne stopped writing. Months later, she knocked on my door.`, but not `She was leaving the next day.`, `She appeared tired that evening.`, `She appeared in better spirits that evening.`, `She returned to London the next day.`, `She returned my letter the next day.`, `She came to a decision that evening.`, `Volvió a llover esa noche.`, `Volvió en sí esa noche.`, `She usually came in the evening.`, `She came every day in the evening.`, `A few weeks later she would be married.`, `Anne did not leave her bed until that evening.` or `Tom went out. He came back later.`, where the `he` may be someone who has spoken), not for someone who came in (`Then Anne came in. Later I would remember…`), and without a cue they join the talk (`Then Anne came in.`). A plan to come is no coming in when the narration goes on to tell of the arrival, in the same paragraph or a later one (`I had written to Anne. Then Anne agreed to come. She arrived that evening.`, `Then Anne agreed to come.` / `She arrived the next morning.`). A conversation the narrator only watches still alternates between the two people talking.
  - after two or more narration paragraphs → the one person the last narration paragraph introduced, otherwise the `unknown` character
- **New characters:** a capitalised token in the attribution position that isn't a cast name or alias (the narrator's own name and aliases count; its default name does not), a sentence-initial or all-capitals unknown word, a heading, a word after a place preposition (`in London`, `from Mr. Collins`) or a stop-word. Added with role `character`. In a first-person part, an unknown name used only to address someone creates no character (it is often the narrator's own name). Neither does the name or nickname the narration gives the narrator (`My name is Ishmael`, `called me Kit`, `they call me the old man`, `me llamaban la niña`), nor a name that is also an interjection or a sacred name, alone or in a sacred phrase (`¡Ay, Jesús!`, `¡Jesús María!`, `¡Jesús María José!`, `¡Jesús, Madre de Dios!`, `¡Jesús, María, José y todos los santos!`, `¡Jesús, María!` even with a María in the cast, `el Colegio Jesús María`, `rezó a Jesús de Nazaret`, `al niño Jesús`; `Jesús Pérez`, `María Jesús`, `Jesús María Pérez`, `don Jesús María`, `Fray Jesús María` and `su tío Jesús` are ordinary names), until someone of that name speaks, which includes answering a line a tag says to them (`—le preguntó a Jesús.`).
- **Headings** (short lines with no final punctuation: capitals, Title Case, `Chapter…`, scene breaks) are never read for names.
- **Thought:** `thought`/`wondered`/`pensó`/`pensaba`/`se preguntó`/`me dije`/`asked herself` cues, or an emphasis hint next to such a cue in the same sentence.
- **Tone:** from the speech verb only (`whispered`/`susurró` → whisper, `shouted`/`gritó` → shout, and so on). Otherwise none.
- The heuristic never names the narrator and never gives narration to a character: a chapter or passage told by a character is fixed with "Told by" in the reader, or detected by the LLM analyser.
- Deterministic: the same text and cast always give the same output.

### Step 2b: LLM analyser (API key set)

- **Provider:** Anthropic Messages API, called from the client with the user's key. **Model** is configurable in Settings; default `claude-haiku-5-5` with `output_config.effort: 'low'` (labelling is a simple task; the effort level is also a setting). Other choices offered: `claude-sonnet-5-5`, `claude-opus-5-5`.
- **Input per request:** the story language, the current cast (`id`, `name`, `aliases`, `description`, `gender`), the last ~20 labelled units from before the chunk (context), and a chunk of numbered units (about 300 units or about 6k tokens).
- **Output (structured output, zod schema):**
  ```ts
  { units: Array<{
      id: number;
      spans: Array<{ text?: string; speaker: string; mode: Mode; tone?: Tone }>
    }>;
    newCharacters: Array<{ ref: string; name: string; aliases: string[]; gender?: ...; description: string }>;
    aliasAdditions: Array<{ characterId: string; alias: string }> }
  ```
  - `speaker` is an existing character id or a `ref` from `newCharacters`.
  - One span means "the whole unit" (`text` omitted). Several spans split the unit, and **their `text` values concatenated must equal the unit text exactly**.
  - The prompt shows the cast under short codes (`N` narrator, `U` unknown, `c1`… characters, `x1`… characters found earlier in the same part) instead of ids, which keeps output short; units are shown trimmed, as JSON strings.
- **The model never returns offsets or rewritten text that is stored.** The client converts spans to offsets by walking the unit text: each span's `text` must appear in order, whitespace between spans may be skipped (it stays with the earlier span), and a span that is only whitespace is rejected. If that fails, a unit is missing, or a speaker is unknown, that unit falls back to its heuristic label (`analyzer.kind = 'mixed'`). This keeps the guarantee with any model behaviour.
- **New characters** whose name matches the cast (same rules as `matchCast`) are mapped to the existing character instead of duplicated, and their other names become aliases; a name that matches no one maps to the one member that one of its aliases names exactly, unless that alias is a description ("his lady"), "I", a word of the proposal's own full name that the member's full name contradicts, as in `matchCast` ("Jane" of "Jane Fairfax" is not "Jane Bennet"), or the family name after a woman's title ("Watson" of "Mrs. Watson") of a member not known to be a woman, which then stays his and does not become her alias. After "Miss", "Ms" or "Mlle" the name is the member's own when the member's full names show it is not a family name, by starting with it or leaving it out ("Miss Elizabeth" or "Miss Eliza" for "Elizabeth Bennet"), unless the member is known to be a man. Without such a full name a woman's own name looks like a man's family name, so "Miss Elizabeth" is not a member called only "Elizabeth", just as "Miss Smith" is not "Smith", nor is "Miss Marple" one called "Marple" and "Jane Marple", just as "Miss Bingley" is not "Charles Bingley": a woman made twice, whom the user can merge, is the milder mistake. Heuristic characters used by fallback units are matched the same way. Proposals named like the narrator, or "the narrator", are the narrator. A proposal whose `ref` is a code the prompt showed counts only if it names that member.
- **Who tells:** narration is voiced by whoever tells that stretch: `N`, or a character telling it in the first person (their chapter, a tale, a letter or diary), who then also voices their own "I" lines. The prompt shows the narrator's name and aliases and how it told the story's other analysed parts (first or third person). Context from the previous part ends with "(end of the previous part)".
- **Narrator aliases** the model proposes are kept only when they are real names that belong to no other character and fit the narrator's existing names (or the narrator has none). The unknown speaker never gets aliases from the model, and no one gets "I", "yo" or "the narrator" as an alias, nor, unless known to be a woman, a woman's title before a family name they go by, read as for new characters ("Mrs. Watson" for "Watson", who may be her husband, but "Miss Jane" for "Jane Eyre").
- Units that **fall back** to the heuristic take the teller the model chose nearby for their narration and "I" lines. Narration the model gives to `U` goes to the teller in effect.
- **Cost shown before running:** with a key set, new parts wait for a confirmation that shows the model, the number of requests, the estimated tokens and the price (local token estimate and a price table in `cost.ts`). The user can run Claude, use the free method, or decide later. After a run the actual cost from the API's usage is shown.
- **Refusals:** a response with `stop_reason: 'refusal'` (Haiku 5.5 has no server-side fallback) is treated like a failed chunk: that chunk's units get heuristic labels and the part is marked `mixed`. A response cut off at `max_tokens` is split in half and retried; below 8 units it falls back to the heuristic.
- **Errors:** 401 → "API key rejected", no retry. 429/5xx/network → retry with backoff (the SDK's own, 4 retries). Finished chunk responses are kept in memory until the part is stored, so "Retry" resumes without paying again for them; they are kept per part, model, effort, prompt version and the cast's members and roles (what the prompt's codes stand for), so "Retry" asks again once a character has been added or merged away; renames, alias, gender and voice edits, and merging the narrator or the unknown speaker (who are never removed), keep them. On final failure, the part is marked `failed` with a "Retry" and an "Analyse without Claude" button.
- **The API key** is stored in Preferences, never written to exports, never logged, and only sent to `api.anthropic.com`.

### Step 3: Merge

Unit labels become segments. Adjacent units with the same speaker, mode and tone are coalesced into one segment. The result is validated (invariants 1–5) before it is stored. Internal labels (such as the heuristic's teller flag) are never stored.

### Re-analysis rules

- **New part:** analysed with the current cast as context; new characters are appended to the cast.
- **Replaced part:** only that part is re-analysed. Voice settings are untouched. Characters that are no longer referenced anywhere are flagged "unused", not deleted.
- **Re-run analysis** on an existing part (for example after adding an API key): segments with `source: 'user'` are re-applied: fresh segments are cut at the edges of every range the user corrected, and each piece inside a corrected range takes the user's speaker and mode.

## Module `cast`

- **Auto voice assignment** (new character): list the device voices for the story language and give the narrator the platform default voice for that language. Characters rotate through the remaining voices. When the voice list runs out, or there's only one, pitch (0.75–1.3) and rate (0.9–1.1) are varied deterministically from a hash of the character id, nudged by the gender hint (lower or higher pitch). No two characters may share the same (voiceName, pitch, rate) combination.
- **Portability:** if `voiceName` isn't available on the current device, use the best voice for `voice.lang`, keep pitch and rate, and show a small "substituted" badge.
- **Merge B → A:** A gets B's name and aliases as aliases (never a default name such as "Narrator"), every segment with `speakerId === B` in every analysis of the story is rewritten to A, and B is removed. This happens in one IndexedDB transaction. When B is the narrator or the unknown speaker (never removed), the moved lines become user corrections, so re-analysis keeps them. Merging the narrator into a character also moves the narrator's own name and aliases to it and resets the narrator's name. The unknown speaker passes on no names: it keeps its aliases (names the user merged into it), so those names stay unattributed in later parts.
- **Rename and edit aliases:** these change only the cast record. Segments reference ids, so they're unaffected. The old name stays an alias, except a default name ("Narrator", "Unknown speaker"); renaming the narrator to "Narrator" or "Narrador" un-names it, keeping only the other names the user lists. The unknown speaker keeps no old names (it is matched only by names merged into it). A name another member already has, as the new name or as one of the other names, is refused, with a hint to merge instead, or, for a name the unknown speaker has, to take it off the unknown speaker first (nobody is the same person as the unknown speaker). "Narrator" or "Narrador" typed as a name, in a rename or as a new character in the reader, means the narrator.
- **Narrator names:** the narrator's own name and aliases are matched like a character's (its default name is not), so a name merged into the narrator stays the narrator's in later parts.
- **Changing a voice** takes effect from the next segment played, with no re-analysis.

## Module `playback`

```ts
export interface Utterance {
  id: string;
  text: string;
  voice: VoiceSettings;
}
export interface SpeechEngine {
  listVoices(lang?: string): Promise<DeviceVoice[]>;
  // Plays the utterances in order; resolves when all are done or stop() is called.
  play(queue: Utterance[], onProgress: (utteranceId: string) => void): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
}
```

- **Web engine:** `speechSynthesis`, one `SpeechSynthesisUtterance` per segment.
- **Android engine:** a native Capacitor plugin that receives a **batch** of utterances (the rest of the current part plus the next one, if analysed) and plays them inside a **foreground service with a media notification** (play/pause, next and previous segment). Progress events are emitted back to JS. Because the queue lives natively, playback doesn't depend on the WebView being active while the screen is locked. Exact approach decided by spike R1 and recorded in `docs/adr/001-android-tts.md`.
  - The notification is a media notification backed by a `MediaSession` (story and part as titles), so the same controls appear on the lock screen. Pause and play pressed there are reported to the player. Headset buttons are not supported yet (ADR-001).
  - The service saves the last utterance it started; when a story is opened and that record is newer than the story's saved position, playback resumes from it (covers an app killed while the WebView was asleep).
- **Player:**
  - Builds utterances from segments (skipping whitespace- or punctuation-only ones).
  - Applies the global speed multiplier.
  - Persists `story.position` on every progress event (throttled to once every 2 s plus on pause).
  - Moves to the next part automatically. If the next part isn't analysed yet, it stops with a message.
- **Controls:** play/pause, previous/next segment, previous/next paragraph, previous/next part, global speed (0.5–2.0), tap a paragraph to play from it.

## Module `ui`

Mobile-first, works at 360 px wide, dark and light theme (follows the system, with a manual override stored locally).

| View            | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library         | List of stories (title, number of parts, analysis status), create, import JSON, delete (tap twice)                                                                                                                                                                                                                                                                                                                                                                  |
| Story           | Ordered parts list (move up/down, insert at a position, replace, rename, re-analyse, delete), add part (file/paste), per-part analysis status with progress and cost estimate, export                                                                                                                                                                                                                                                                               |
| Reader / player | Text of the current part with lines said, thought or read out coloured by speaker (the narrator has a colour of its own) and narration a character tells marked in their colour; current segment highlighted and kept in view; tap paragraph to play; tap segment → reassign speaker: this line, the following lines of that speaker, every line of that speaker in the part ("Told by …"), or a range ending at a line tapped next; player bar fixed at the bottom |
| Cast            | Characters with role, aliases, usage count, voice controls (voice picker, pitch, rate), preview button, merge, rename (a name another member has is refused, pointing to the merge to use instead, or to the unknown speaker's card to free a name it has); parts each character tells; the narrator card explains when to name the narrator                                                                                                                        |
| Settings        | API key (masked, test button), model choice, default speed, theme, storage usage                                                                                                                                                                                                                                                                                                                                                                                    |

## Code style

- Pure logic (`format`, `ingest`, `analysis`, `cast`) is framework-free TypeScript: plain functions, named exports, no classes, and no I/O inside pure functions. Vue and Capacitor are only used in `ui`, `storage` and `playback`.
- Classes only for adapters that wrap a stateful platform API (`WebSpeechEngine`, `NativeSpeechEngine`).
- Naming: `camelCase` for functions and variables, `PascalCase` for types and components, files `camelCase.ts` / `PascalCase.vue`.
- Errors: domain functions return results for expected failures (`{ ok: false, reason }`) and throw only on programmer error.
- Prettier defaults with `singleQuote: true`, `printWidth: 100`.

```ts
// src/format/validate.ts
export type ValidationResult = { ok: true } | { ok: false; reason: string };

export function validateSegments(
  text: string,
  segments: Segment[],
  castIds: Set<string>,
): ValidationResult {
  if (segments.length === 0)
    return text.length === 0 ? { ok: true } : { ok: false, reason: 'no segments' };
  if (segments[0].start !== 0) return { ok: false, reason: 'does not start at 0' };

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s.start >= s.end) return { ok: false, reason: `empty segment at ${i}` };
    if (i > 0 && segments[i - 1].end !== s.start)
      return { ok: false, reason: `gap or overlap at ${i}` };
    if (!castIds.has(s.speakerId)) return { ok: false, reason: `unknown speaker ${s.speakerId}` };
  }

  if (segments.at(-1)!.end !== text.length)
    return { ok: false, reason: 'does not reach end of text' };
  return { ok: true };
}
```

## Testing strategy

| Level                 | What                                                                                                                                                                                                                                                                                                                                                                                                            | Where                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Unit                  | Canonicalisation, EPUB extraction, unit splitting (en quotes, es dashes, apostrophes, nested quotes), heuristic attribution, LLM span → offset conversion and fallback, merge, voice assignment, cast merge                                                                                                                                                                                                     | `tests/unit/**`                                                       |
| Property              | For random text and random analyser output (including malformed LLM spans), the stored analysis either satisfies the invariants or is rejected. **Text preservation never fails.**                                                                                                                                                                                                                              | `tests/unit/format/*.property.test.ts` (fast-check)                   |
| Integration           | Dexie repositories against `fake-indexeddb`; export → import round-trip is byte-identical; cast merge rewrites segments across parts                                                                                                                                                                                                                                                                            | `tests/unit/storage/**`                                               |
| UI wiring             | Reader and Cast views mounted on stories stored in `fake-indexeddb`, with a memory router and a stub player, and driven as a user would: speaker picker, "Told by", passages, speaker colours, name clashes, renames and merges                                                                                                                                                                                 | `tests/unit/ui/**` (happy-dom, `tests/helpers/ui.ts`)                 |
| Fixture accuracy      | Hand-labelled public-domain excerpts (en: _Pride and Prejudice_; es: Galdós, _Marianela_), ~150 units each, and first-person passages written for these tests (en: lighthouse, es: abuela). Heuristic: speech vs narration ≥ 95%, speaker attribution ≥ 70%. A regression set of short multi-part stories (third person, first person, alternating narrators, frames, letters) whose error counts may not grow. | `tests/fixtures/`, `tests/helpers/heldoutStories.ts`, run in CI       |
| LLM accuracy (manual) | Same fixtures through the real API, speaker attribution ≥ 90%. Not in CI (costs money).                                                                                                                                                                                                                                                                                                                         | `npm run eval:llm` (`tests/eval/`, results in `docs/eval-results.md`) |
| Manual device         | Checklist on the Android phone: background playback with the screen locked for 30 min, notification controls, resume after app kill, voice substitution                                                                                                                                                                                                                                                         | `docs/manual-test-checklist.md`                                       |

**Coverage:** ≥ 90% lines for `format` and `analysis`, ≥ 80% for `ingest`, `cast` and `storage`. UI isn't held to a coverage number.

## Boundaries

- **Always:**
  - Run `typecheck`, `lint` and `test` before every commit.
  - Validate every analysis against the invariants before storing it.
  - Keep `format`, `analysis`, `ingest` and `cast` free of Vue and Capacitor imports.
  - Add a fixture test when fixing an attribution bug.
- **Ask first:**
  - Adding a dependency not listed in the tech stack.
  - Changing the story format or bumping `SCHEMA_VERSION` (needs a migration).
  - Adding any network call other than `api.anthropic.com`.
  - Changing the native plugin's public API.
- **Never:**
  - Write to `Part.text` after creation, or "clean up" or normalise story text beyond the two import rules.
  - Store LLM-produced text as story text.
  - Log or export the API key.
  - Add a backend, accounts or telemetry.
  - Commit secrets or the keystore.
  - Disable or skip a failing test to get to green.

## Success criteria

1. Importing the en and es fixtures as .txt and as .epub gives `Part.text` identical (byte-for-byte) to the expected canonical text.
2. For every part analysed by either analyser, concatenating the segment slices equals `Part.text` (asserted in code and in property tests).
3. With no API key, a 5,000-word chapter is analysed on a mid-range Android phone in under 5 s, and the heuristic meets the fixture thresholds above.
4. With an API key, analysis of the same chapter completes, shows a cost estimate beforehand, and meets ≥ 90% attribution on the fixtures in the manual eval.
5. Uploading part 2 of a story reuses the existing characters' ids and voices for every character already present in part 1 (verified on fixtures split into two parts).
6. Merging two characters updates every segment in every part, and playback uses the surviving character's voice.
7. On the Android phone, playback continues with the screen locked for at least 30 minutes, notification controls work, and reopening the app resumes from the saved position (within one segment).
8. Changing a character's voice takes effect from the next segment of that character without re-analysis.
9. A story exported to JSON and imported on the desktop web app plays with the same cast. Voices missing on that device are substituted and marked.
10. The app works fully offline when no API key is set (no network requests at all).
11. A first-person narrator who is addressed by name keeps one voice: no character is created from the narrator's name in a first-person part (one with a speech tag by the narrator or said to the narrator, see Step 2a), and a name merged into the narrator is not re-created in later parts.

## Risks

| Id  | Risk                                                             | Mitigation                                                                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Android stops TTS or kills the WebView when the screen is locked | **Spike first:** a minimal Capacitor app with a native plugin, `TextToSpeech` in a foreground service with a media notification, playing a 30-minute queue with the screen locked. Record the result in ADR-001. If it fails, the fallback is a keep-awake mode (screen dimmed on). |
| R2  | Few distinct device voices (often 1–3 per language on Android)   | Pitch and rate variation per character; the user can install more voices (Google TTS voice packs); the Cast view makes overrides easy                                                                                                                                               |
| R3  | Heuristic attribution is weak on unattributed dialogue           | Manual segment reassignment; LLM path; fixture tests that track accuracy over time                                                                                                                                                                                                  |
| R4  | The LLM returns spans that don't match the unit text             | Per-unit fallback to the heuristic label, so analysis never fails because of the model                                                                                                                                                                                              |
| R5  | IndexedDB is evicted or data is lost on uninstall                | `storage.persist()`; JSON export; Settings shows storage usage                                                                                                                                                                                                                      |
| R6  | EPUB edge cases (odd spines, nested markup, footnotes)           | Import preview showing the extracted text per spine item before saving; fixture EPUBs                                                                                                                                                                                               |

## Decisions (resolved open questions, 2026-10-14)

1. Default LLM model is **`claude-haiku-5-5`**, about $0.05 to analyse a 90k-word novel. Sonnet 5.5 and Opus 5.5 can be picked in Settings.
2. Minimum Android version: **Android 10 (API 29)**.
3. Manual segment reassignment (user story 5) is **in** the MVP.
4. EPUB italics are kept as `emphasis` hints (metadata only) and used to spot thoughts.

## Open questions

None at this time.
