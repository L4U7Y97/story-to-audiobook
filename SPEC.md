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
5. As the user, I can correct who a segment belongs to (tap a segment → pick a character, or create a new one).
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
  partIds: string[]; // reading order
  cast: Character[];
  narratorId: string; // always present; a Character with role 'narrator'
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
  speakerId: string; // Character.id
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

Units tile the text (same invariants as segments). Each unit has a provisional mode: `speech` if inside quotes or dash dialogue, otherwise `narration`.

### Step 2a: Heuristic analyser (no API key)

- **Speaker attribution** in a window around each speech unit:
  - speech verb + name (`said Elizabeth`, `Elizabeth replied`, `—dijo Elizabeth`, `murmuró ella`), using en/es verb lists
  - pronoun → most recent character of matching gender
  - unattributed back-and-forth → alternate between the last two speakers
  - otherwise → the `unknown` character
- **New characters:** a capitalised token in the attribution position that isn't a cast name or alias, sentence-initial word or stop-word. Added with role `character`.
- **Thought:** `thought`/`wondered`/`pensó`/`se preguntó` cues, or an emphasis hint covering a narration unit next to such a cue.
- **Tone:** from the speech verb only (`whispered`/`susurró` → whisper, `shouted`/`gritó` → shout, and so on). Otherwise none.
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
- **New characters** whose name matches the cast (same rules as `matchCast`) are mapped to the existing character instead of duplicated. Heuristic characters used by fallback units are matched the same way.
- **Cost shown before running:** with a key set, new parts wait for a confirmation that shows the model, the number of requests, the estimated tokens and the price (local token estimate and a price table in `cost.ts`). The user can run Claude, use the free method, or decide later. After a run the actual cost from the API's usage is shown.
- **Refusals:** a response with `stop_reason: 'refusal'` (Haiku 5.5 has no server-side fallback) is treated like a failed chunk: that chunk's units get heuristic labels and the part is marked `mixed`. A response cut off at `max_tokens` is split in half and retried; below 8 units it falls back to the heuristic.
- **Errors:** 401 → "API key rejected", no retry. 429/5xx/network → retry with backoff (the SDK's own, 4 retries). Finished chunk responses are kept in memory until the part is stored, so "Retry" resumes without paying again for them. On final failure, the part is marked `failed` with a "Retry" and an "Analyse without Claude" button.
- **The API key** is stored in Preferences, never written to exports, never logged, and only sent to `api.anthropic.com`.

### Step 3: Merge

Unit labels become segments. Adjacent units with the same speaker, mode and tone are coalesced into one segment. The result is validated (invariants 1–5) before it is stored.

### Re-analysis rules

- **New part:** analysed with the current cast as context; new characters are appended to the cast.
- **Replaced part:** only that part is re-analysed. Voice settings are untouched. Characters that are no longer referenced anywhere are flagged "unused", not deleted.
- **Re-run analysis** on an existing part (for example after adding an API key): segments with `source: 'user'` are re-applied: every new segment that lies inside a range the user corrected takes the user's speaker and mode.

## Module `cast`

- **Auto voice assignment** (new character): list the device voices for the story language and give the narrator the platform default voice for that language. Characters rotate through the remaining voices. When the voice list runs out, or there's only one, pitch (0.75–1.3) and rate (0.9–1.1) are varied deterministically from a hash of the character id, nudged by the gender hint (lower or higher pitch). No two characters may share the same (voiceName, pitch, rate) combination.
- **Portability:** if `voiceName` isn't available on the current device, use the best voice for `voice.lang`, keep pitch and rate, and show a small "substituted" badge.
- **Merge B → A:** A gets B's name and aliases as aliases, every segment with `speakerId === B` in every analysis of the story is rewritten to A, and B is removed. This happens in one IndexedDB transaction.
- **Rename and edit aliases:** these change only the cast record. Segments reference ids, so they're unaffected.
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
- **Player:**
  - Builds utterances from segments (skipping whitespace- or punctuation-only ones).
  - Applies the global speed multiplier.
  - Persists `story.position` on every progress event (throttled to once every 2 s plus on pause).
  - Moves to the next part automatically. If the next part isn't analysed yet, it stops with a message.
- **Controls:** play/pause, previous/next segment, previous/next paragraph, previous/next part, global speed (0.5–2.0), tap a paragraph to play from it.

## Module `ui`

Mobile-first, works at 360 px wide, dark and light theme (follows the system, with a manual override stored locally).

| View            | Content                                                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library         | List of stories (title, number of parts, analysis status), create, import JSON                                                                                                                  |
| Story           | Ordered parts list (move up/down, insert at a position, replace, rename, re-analyse, delete), add part (file/paste), per-part analysis status with progress and cost estimate, export           |
| Reader / player | Text of the current part with segments coloured by speaker; current segment highlighted and kept in view; tap paragraph to play; tap segment → reassign speaker; player bar fixed at the bottom |
| Cast            | Characters with role, aliases, usage count, voice controls (voice picker, pitch, rate), preview button, merge, rename                                                                           |
| Settings        | API key (masked, test button), model choice, default speed, theme, storage usage                                                                                                                |

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

| Level                 | What                                                                                                                                                                                                        | Where                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Unit                  | Canonicalisation, EPUB extraction, unit splitting (en quotes, es dashes, apostrophes, nested quotes), heuristic attribution, LLM span → offset conversion and fallback, merge, voice assignment, cast merge | `tests/unit/**`                                                       |
| Property              | For random text and random analyser output (including malformed LLM spans), the stored analysis either satisfies the invariants or is rejected. **Text preservation never fails.**                          | `tests/unit/format/*.property.test.ts` (fast-check)                   |
| Integration           | Dexie repositories against `fake-indexeddb`; export → import round-trip is byte-identical; cast merge rewrites segments across parts                                                                        | `tests/unit/storage/**`                                               |
| Fixture accuracy      | Hand-labelled public-domain excerpts (en: _Pride and Prejudice_; es: Galdós, _Marianela_), ~150 units each. Heuristic: speech vs narration ≥ 95%, speaker attribution ≥ 70%.                                | `tests/fixtures/`, run in CI                                          |
| LLM accuracy (manual) | Same fixtures through the real API, speaker attribution ≥ 90%. Not in CI (costs money).                                                                                                                     | `npm run eval:llm` (`tests/eval/`, results in `docs/eval-results.md`) |
| Manual device         | Checklist on the Android phone: background playback with the screen locked for 30 min, notification controls, resume after app kill, voice substitution                                                     | `docs/manual-test-checklist.md`                                       |

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
