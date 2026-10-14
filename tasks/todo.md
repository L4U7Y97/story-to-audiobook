# Tasks: Story to Audiobook (MVP)

Plan: [plan.md](plan.md) · Spec: [SPEC.md](../SPEC.md)

Standard verification for every task unless noted:

```
npm run typecheck
npm run lint
npm test
```

---

## Phase 0: Risk spike

### - [ ] Task 1: Scaffold the project

**Description:** Create the Vite + Vue 3 + TypeScript app with ESLint, Prettier, Vitest and the npm scripts from the spec. Initialise Capacitor 8 and add the Android platform. Rename the `.claude/launch.json` config to `vite-dev` (port 3000).
**Acceptance criteria:**

- [x] `npm run dev` serves a placeholder page on port 3000
- [x] `npm run typecheck`, `lint`, `test` (one trivial test) and `build` all pass
- [ ] `npm run android:apk` produces a debug APK that opens on the phone — APK builds; **install on phone pending (no device connected)**
      **Verification:** run all commands above; install the APK on the phone.
      **Dependencies:** None
      **Files:** `package.json`, `vite.config.ts`, `tsconfig*.json`, `eslint.config.js`, `.prettierrc`, `capacitor.config.ts`, `src/main.ts`, `src/App.vue`, `.claude/launch.json`, `.gitignore`, `android/` (generated)
      **Scope:** M (mostly generated config)

### - [ ] Task 2: Spike: native TTS in a foreground service (throwaway)

**Description:** A minimal Capacitor plugin (Kotlin) that accepts a list of `{id, text, pitch, rate, voiceName}`, speaks them in order with Android `TextToSpeech` inside a foreground media-playback service with a notification (play/pause, next), and emits `progress(id)` events to JS. A test button queues ~30 minutes of text.
**Acceptance criteria:**

- [ ] With the screen locked, playback continues for 30 minutes on the phone
- [ ] Notification play/pause and next work; progress events arrive in JS after unlocking
- [ ] `docs/adr/001-android-tts.md` records the result and the chosen approach (or the keep-awake fallback)
      **Verification:** manual device test (screen locked, app in background, 30 min).
      **Dependencies:** T1
      **Files:** `android/app/src/main/java/.../narrator/NarratorPlugin.kt`, `NarratorService.kt`, `AndroidManifest.xml`, `src/playback/nativeBridge.ts`, `docs/adr/001-android-tts.md`
      **Scope:** M

### Checkpoint A: go/no-go on background playback

- [ ] ADR-001 written; human confirms the native-service approach (or accepts the fallback)

---

## Phase 1: Foundation

### - [x] Task 3: Story format types, validator and property tests

**Description:** Implement `src/format` exactly as specified: types, `SCHEMA_VERSION`, `validateSegments` (invariants 1–4), `isSpeakable` (invariant 5), and helpers (`sliceSegment`, `sha256`).
**Acceptance criteria:**

- [x] Unit tests cover each invariant violation with a clear `reason`
- [x] A fast-check property test shows that any segments passing validation reproduce the text exactly, and that random corruptions are rejected
- [x] Coverage ≥ 90% for `src/format`
      **Verification:** `npm test -- format`
      **Dependencies:** T1
      **Files:** `src/format/types.ts`, `src/format/validate.ts`, `src/format/hash.ts`, `tests/unit/format/validate.test.ts`, `tests/unit/format/validate.property.test.ts`
      **Scope:** S

### - [x] Task 4: Storage layer

**Description:** Dexie database (`stories`, `parts`, `analyses` tables) and repository functions: create/list/get story, add/insert/reorder parts (updating `partIds`), save an analysis (rejecting invalid ones via `validateSegments`), and a settings wrapper over Capacitor Preferences. Request `navigator.storage.persist()` on start.
**Acceptance criteria:**

- [x] Repository tests run against `fake-indexeddb` and cover create, insert at a position, reorder and delete
- [x] Saving an analysis whose `textHash` doesn't match, or that fails validation, throws and stores nothing
- [x] `Part.text` has no update path in the repository API
      **Verification:** `npm test -- storage`
      **Dependencies:** T3
      **Files:** `src/storage/db.ts`, `src/storage/stories.ts`, `src/storage/parts.ts`, `src/storage/settings.ts`, `tests/unit/storage/*.test.ts`
      **Scope:** M

### - [x] Task 5: Ingest .txt and pasted text

**Description:** `canonicalize` (BOM strip, CRLF/CR → LF only), a .txt decoder (UTF-8, fallback to windows-1252 with a notice), and paste.
**Acceptance criteria:**

- [x] Tests: CRLF/CR/BOM handling; non-ASCII en/es text unchanged; tabs, double spaces and unusual whitespace preserved byte-for-byte
- [x] A windows-1252 file decodes correctly and returns a notice
      **Verification:** `npm test -- ingest`
      **Dependencies:** T3
      **Files:** `src/ingest/canonicalize.ts`, `src/ingest/txt.ts`, `src/ingest/paste.ts`, `tests/unit/ingest/*.test.ts`
      **Scope:** S

### - [x] Task 6: Library and "add part" UI slice

**Description:** Library view (list and create stories, choose language en/es) and Story view (ordered parts list, add a part by paste or .txt file, at the end or after a chosen part). Parts show `analysisStatus: pending`.
**Acceptance criteria:**

- [x] Creating a story and adding two parts works on desktop; data survives a reload
- [x] Layout works at 360 px wide
      **Verification:** run the dev server; create a story, add a pasted part and a .txt part, reload, and check both are still there.
      **Dependencies:** T4, T5
      **Files:** `src/ui/views/LibraryView.vue`, `src/ui/views/StoryView.vue`, `src/ui/components/AddPartDialog.vue`, `src/App.vue`, `src/ui/router.ts`
      **Scope:** M

### Checkpoint B: Foundation

- [ ] All tests pass, build is clean, stories and parts persist

---

## Phase 2: First playable slice (desktop)

### - [x] Task 7: Unit segmentation

**Description:** `splitUnits(text, lang)` splits on paragraphs, the four quote styles (handling apostrophes) and Spanish dash dialogue with incisos. Gives each unit a provisional mode.
**Acceptance criteria:**

- [x] Units always tile the text (property test, reusing the T3 validator)
- [x] Table tests for: `“Hi,” she said, “bye.”` → 3 units; `—Hola —dijo Ana—. ¿Vienes?` → 3 units; `don't`/`l'eau` are not quotes; nested quotes; a quote spanning paragraphs
      **Verification:** `npm test -- units`
      **Dependencies:** T3
      **Files:** `src/analysis/units.ts`, `tests/unit/analysis/units.test.ts`
      **Scope:** S

### - [x] Task 8: Heuristic analyser with fixtures

**Description:** Speech-verb lists (en/es), speaker attribution (name, pronoun → gender, alternation, unknown), new-character detection, thought cues, and tone from speech verbs. Add hand-labelled fixtures: a _Pride and Prejudice_ excerpt (en) and a _Marianela_ excerpt (es), ~150 units each.
**Acceptance criteria:**

- [x] Deterministic output (same input gives deep-equal output)
- [x] Fixtures: speech vs narration ≥ 95%, speaker attribution ≥ 70%, asserted in tests
- [x] Coverage ≥ 90% for `src/analysis/heuristic`
      **Verification:** `npm test -- heuristic`
      **Dependencies:** T7
      **Files:** `src/analysis/heuristic/{speechVerbs.en,speechVerbs.es,attribute,tone,index}.ts`, `tests/fixtures/{en,es}/*`, `tests/unit/analysis/heuristic.test.ts`
      **Scope:** M

### - [x] Task 9: Analysis pipeline wired to uploads

**Description:** `merge.ts` (unit labels → coalesced segments) and `analyzer.ts` (run the heuristic on a part with the current cast, append new characters, validate, store). Adding a part triggers analysis; the Story view shows status (pending/running/done/failed).
**Acceptance criteria:**

- [x] Adding a part produces a stored, valid analysis and updates the story's cast
- [x] Analysing part 2 with part 1's cast reuses the existing character ids (fixture split into two parts)
- [x] A 5,000-word chapter is analysed in < 1 s on desktop (benchmark test)
      **Verification:** `npm test -- analysis`; manual check in the dev server.
      **Dependencies:** T4, T6, T8
      **Files:** `src/analysis/merge.ts`, `src/analysis/analyzer.ts`, `src/ui/views/StoryView.vue`, `tests/unit/analysis/{merge,analyzer}.test.ts`
      **Scope:** M

### - [x] Task 10: Automatic voice assignment and basic Cast view

**Description:** `assignVoices` (narrator gets the default voice; characters rotate through voices; deterministic pitch and rate variation from the id hash, nudged by gender; no duplicate combinations). Cast view lists characters with a voice picker, pitch and rate sliders, and a preview button (web engine).
**Acceptance criteria:**

- [x] With 1 device voice and 10 characters, all 11 (voice, pitch, rate) combinations are distinct (test)
- [x] Changing a voice in the Cast view persists and previews immediately
      **Verification:** `npm test -- cast`; manual check in the Cast view.
      **Dependencies:** T3, T9
      **Files:** `src/cast/assignVoices.ts`, `src/ui/views/CastView.vue`, `tests/unit/cast/assignVoices.test.ts`
      **Scope:** M

### - [x] Task 11: Speech engine interface, web engine and player

**Description:** The `SpeechEngine` interface, `WebSpeechEngine`, a `FakeSpeechEngine` for tests, and `player.ts` (build utterances from segments, skip unspeakable ones, apply global speed, emit current segment, persist position throttled to 2 s plus on pause, advance to the next analysed part, stop at an unanalysed one).
**Acceptance criteria:**

- [x] Player tests with the fake engine: order, skipping, part advance, stop on unanalysed part, position saving, resume from a saved position
- [x] A voice change takes effect at the next utterance of that character
      **Verification:** `npm test -- playback`
      **Dependencies:** T4, T10
      **Files:** `src/playback/{engine,webEngine,fakeEngine,player}.ts`, `tests/unit/playback/player.test.ts`
      **Scope:** M

### - [x] Task 12: Reader and player UI

**Description:** Reader view showing the part text with segments tinted by speaker, the current segment highlighted and scrolled into view, tap a paragraph to play from it. A fixed player bar with play/pause, previous/next segment, paragraph and part, and speed.
**Acceptance criteria:**

- [x] On desktop: paste a chapter → it plays with distinct voices for narrator and characters, and the highlight follows
- [x] Reload → play resumes from the saved segment
      **Verification:** manual check in the dev server with the en and es fixtures.
      **Dependencies:** T11
      **Files:** `src/ui/views/ReaderView.vue`, `src/ui/components/PlayerBar.vue`, `src/ui/components/SegmentText.vue`, `src/ui/composables/usePlayer.ts`
      **Scope:** M

### Checkpoint C: first playable slice

- [ ] All tests pass; the en and es fixtures play end-to-end on desktop with multiple voices
- [ ] Review with the human before Android work

---

## Phase 3: Android

### - [ ] Task 13: Native speech engine

**Description:** Turn the spike into the production plugin, with batch queue, pause/resume/stop, progress events, notification controls (play/pause, previous/next segment) and voice listing. Add `NativeSpeechEngine` implementing `SpeechEngine`, selected automatically on Android. The player sends the rest of the current part plus the next analysed part as one batch.
**Acceptance criteria:**

- [ ] The same player tests pass with the engine swapped (the interface contract is unchanged)
- [ ] On the phone, the Reader highlight follows playback, and notification controls work
      **Verification:** `npm test`; manual device test.
      **Dependencies:** T2, T11, T12
      **Files:** `android/.../narrator/{NarratorPlugin,NarratorService}.kt`, `src/playback/nativeEngine.ts`, `src/playback/index.ts`
      **Scope:** M

### - [ ] Task 14: Device checklist and resume after kill

**Description:** Write `docs/manual-test-checklist.md` (spec success criterion 7) and make sure position is saved natively as well, so a killed app resumes correctly.
**Acceptance criteria:**

- [ ] Locked-screen playback for ≥ 30 min passes on the phone
- [ ] Force-stopping the app and reopening it resumes within one segment
      **Verification:** run the checklist on the device and record the results in the doc.
      **Dependencies:** T13
      **Files:** `docs/manual-test-checklist.md`, `android/.../narrator/NarratorService.kt`, `src/playback/player.ts`
      **Scope:** S

### Checkpoint D: Android

- [ ] Spec success criterion 7 is met on the phone

---

## Phase 4: Story and cast management

### - [x] Task 15: EPUB import with preview

**Description:** JSZip + DOMParser extraction following the spec rules (spine order, block → `\n`, paragraphs → `\n\n`, drop images/scripts/styles, `em`/`i` → emphasis hints). An import preview lists spine items with their extracted text, and the user can deselect items or group them into parts. Emphasis hints feed thought detection in the heuristic.
**Acceptance criteria:**

- [x] A fixture EPUB extracts to exactly the expected canonical text, and hints land on the right ranges
- [x] Importing selected chapters creates one part per selected group, in order
      **Verification:** `npm test -- epub`; manual import on the phone.
      **Dependencies:** T9
      **Files:** `src/ingest/epub.ts`, `src/ui/components/EpubImportDialog.vue`, `src/analysis/heuristic/attribute.ts`, `tests/unit/ingest/epub.test.ts`, `tests/fixtures/*.epub`
      **Scope:** M

### - [x] Task 16: Part management

**Description:** Reorder (drag), insert above/below, rename, delete, and replace (new text and hash, old analysis discarded, same id and position, re-analysis with voices kept). Characters not referenced anywhere are flagged "unused".
**Acceptance criteria:**

- [x] Replacing a part never changes any character's voice settings (test)
- [x] The unused flag appears or disappears correctly after delete and replace (test)
      **Verification:** `npm test -- parts`; manual check in the Story view.
      **Dependencies:** T9
      **Files:** `src/storage/parts.ts`, `src/cast/usage.ts`, `src/ui/views/StoryView.vue`, `tests/unit/storage/parts.test.ts`
      **Scope:** M

### - [x] Task 17: Cast operations

**Description:** Rename, edit aliases, and merge B → A in one Dexie transaction (aliases folded in, every segment in every part rewritten, B removed). UI in the Cast view.
**Acceptance criteria:**

- [x] After a merge, no analysis references B, all analyses still validate, and A has B's name as an alias (test)
- [x] If the merge fails mid-way it rolls back fully (test with an injected failure)
      **Verification:** `npm test -- cast`
      **Dependencies:** T10
      **Files:** `src/cast/merge.ts`, `src/cast/aliases.ts`, `src/ui/views/CastView.vue`, `tests/unit/cast/merge.test.ts`
      **Scope:** M

### - [x] Task 18: Manual segment reassignment

**Description:** Tap a segment in the Reader to pick a speaker (or create a new character). The segment is stored with `source: 'user'`, and adjacent segments are coalesced if they now match.
**Acceptance criteria:**

- [x] The reassignment persists and plays with the new voice
- [x] Re-running analysis on the part keeps user segments whose ranges still match (test)
      **Verification:** `npm test -- reassign`; manual check.
      **Dependencies:** T12, T17
      **Files:** `src/analysis/reassign.ts`, `src/ui/components/SpeakerPicker.vue`, `src/ui/views/ReaderView.vue`, `tests/unit/analysis/reassign.test.ts`
      **Scope:** S

### Checkpoint E: management

- [ ] All tests pass; full story workflow (EPUB → reorder → merge → fix speaker → play) works on the phone

---

## Phase 5: LLM analysis

### - [ ] Task 19: Settings view

**Description:** API key (masked, stored in Preferences, a "test key" button making one minimal request), model (default `claude-haiku-5-5`, also Sonnet 5.5 and Opus 5.5), effort (default `low`), default speed, theme override, storage usage.
**Acceptance criteria:**

- [ ] The key never appears in IndexedDB, exports or console output (test greps the export output)
- [ ] An invalid key shows "API key rejected"
      **Verification:** `npm test -- settings`; manual check with a real key.
      **Dependencies:** T4
      **Files:** `src/ui/views/SettingsView.vue`, `src/storage/settings.ts`, `src/analysis/llm/client.ts`, `tests/unit/storage/settings.test.ts`
      **Scope:** S

### - [ ] Task 20: LLM analyser

**Description:** Zod schema, prompt (language, cast, context units, numbered chunk), chunking (~300 units or ~6k tokens), and span → offset conversion with per-unit heuristic fallback. Refusal and failed chunks fall back to the heuristic (`mixed`); 401 means no retry; 429/5xx/network retry with backoff. Uses `@anthropic-ai/sdk` with `dangerouslyAllowBrowser: true` (verify the option name against the SDK docs before writing).
**Acceptance criteria:**

- [ ] With a mocked client: valid output → segments; spans that don't match, missing units and unknown speakers → per-unit fallback; refusal → chunk fallback. All results pass validation.
- [ ] Property test: random malformed LLM output never produces an invalid stored analysis
- [ ] New characters and alias additions from the LLM are merged into the cast
      **Verification:** `npm test -- llm`
      **Dependencies:** T9, T19
      **Files:** `src/analysis/llm/{schema,prompt,chunking,client,index}.ts`, `src/analysis/analyzer.ts`, `tests/unit/analysis/llm*.test.ts`
      **Scope:** M

### - [ ] Task 21: LLM experience and manual eval

**Description:** Cost estimate shown before analysis (`cost.ts` price table), per-chunk progress, "retry" and "analyse without LLM" on failure, "re-analyse with LLM" for existing parts. Add an `npm run eval:llm` script that runs the fixtures through the real API and reports attribution accuracy.
**Acceptance criteria:**

- [ ] The estimate for the en fixture is within ±50% of the actual usage reported by the API
- [ ] `eval:llm` reports ≥ 90% attribution on both fixtures with Haiku 5.5 (manual run, recorded in `docs/eval-results.md`)
      **Verification:** manual run with a real key.
      **Dependencies:** T20
      **Files:** `src/analysis/llm/cost.ts`, `src/ui/views/StoryView.vue`, `scripts/eval-llm.ts`, `docs/eval-results.md`
      **Scope:** M

### Checkpoint F: LLM

- [ ] All tests pass; spec success criterion 4 is met

---

## Phase 6: Data safety and polish

### - [ ] Task 22: Export and import

**Description:** Export a story (story + parts + analyses, no settings or key) to one JSON file (Capacitor Filesystem/Share on Android, download on web). Import it with a schema version check and new ids if the story already exists.
**Acceptance criteria:**

- [ ] Round trip: export → import → export gives an identical result apart from ids and timestamps (test)
- [ ] An exported file imported on desktop web plays with the same cast (spec success criterion 9)
      **Verification:** `npm test -- exportImport`; manual phone → desktop transfer.
      **Dependencies:** T4, T17
      **Files:** `src/storage/exportImport.ts`, `src/ui/views/LibraryView.vue`, `src/ui/views/StoryView.vue`, `tests/unit/storage/exportImport.test.ts`
      **Scope:** M

### - [ ] Task 23: Portability, offline guarantee and polish

**Description:** Voice substitution with a "substituted" badge; a test that no network request happens without a key; dark/light theme following the system with an override; a 360 px layout pass; accessibility basics (labels, focus, contrast).
**Acceptance criteria:**

- [ ] A story with a missing `voiceName` plays using a voice for the same language with the same pitch and rate, and shows the badge
- [ ] A test with `fetch` stubbed to throw shows the full no-key flow (import → analyse → play) makes no network call
      **Verification:** `npm test`; manual check on the phone and in desktop Chrome.
      **Dependencies:** T13, T22
      **Files:** `src/cast/resolveVoice.ts`, `src/ui/styles/theme.css`, `src/ui/components/*`, `tests/unit/cast/resolveVoice.test.ts`, `tests/unit/offline.test.ts`
      **Scope:** M

### Final checkpoint

- [ ] Spec success criteria 1–10 all verified
- [ ] Coverage thresholds met
- [ ] Manual device checklist passed
