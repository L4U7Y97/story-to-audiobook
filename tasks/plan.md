# Implementation Plan: Story to Audiobook (MVP)

Source: [SPEC.md](../SPEC.md) (approved 2026-10-14). Tasks with acceptance criteria are in [todo.md](todo.md).

## Overview

A Vue 3 + TypeScript app wrapped with Capacitor for Android, with no backend. A story is an ordered list of parts with immutable text. Each part is analysed into segments (ranges into the text, each with a speaker, mode and tone), either by an on-device heuristic or by Claude Haiku 5.5 with the user's key. Playback is device TTS using per-character voice settings. On Android it runs in a native foreground service so it survives screen lock.

## Architecture decisions

- **Risk first.** Android background TTS (spec R1) is the only thing that could change the architecture, so a throwaway spike proves it before any module work. Everything else is known technology.
- **Format before features.** `src/format` (types + validator) is the contract every module uses. It is built and property-tested first, so later modules can't drift from the "text never changes" guarantee.
- **Heuristic before LLM.** The free analyser, plus a web player, gives a full playable slice on desktop early. The LLM analyser then plugs into the same unit → label → merge pipeline and falls back to the heuristic per unit.
- **Web engine before native engine.** The player is built against the `SpeechEngine` interface with a fake engine in tests. The web engine gives quick desktop iteration, and the native engine (built from the spike) drops in behind the same interface.
- **Vertical slices.** From Task 6 on, every task ends with something visible in the app.

## Dependency graph

```
T1 scaffold ── T2 Android TTS spike ──► Checkpoint A (go/no-go on native service)
   │
   ├─ T3 format ─┬─ T4 storage ─┬─ T6 library + add part (UI slice)
   │             ├─ T5 ingest ──┘
   │             ├─ T7 units ── T8 heuristic ── T9 analyse pipeline ─┐
   │             └──────────────────────────── T10 cast voices ──────┤
   │                                         T11 engine + player ────┤
   │                                                T12 reader UI ◄──┘ ► Checkpoint C
   │
   ├─ T13 native engine (needs T2, T11) ── T14 APK + device checklist ► Checkpoint D
   ├─ T15 EPUB · T16 parts mgmt · T17 cast ops · T18 segment reassign ► Checkpoint E
   ├─ T19 settings ── T20 LLM analyser ── T21 LLM UX + eval ► Checkpoint F
   └─ T22 export/import · T23 portability + offline + polish ► Final checkpoint
```

## Phases

| Phase                             | Tasks   | Result                                                                              |
| --------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| 0. Risk spike                     | T1–T2   | Project builds for web and Android; background TTS proven (or fallback chosen)      |
| 1. Foundation                     | T3–T6   | Create a story, add parts from paste or .txt, data persists                         |
| 2. First playable slice (desktop) | T7–T12  | Paste a chapter → heuristic analysis → hear it in multiple voices with highlighting |
| 3. Android                        | T13–T14 | Same on the phone, screen locked, notification controls                             |
| 4. Story and cast management      | T15–T18 | EPUB, part reordering and replacement, cast merge and rename, fix speakers          |
| 5. LLM analysis                   | T19–T21 | API key settings, Haiku 5.5 analysis with fallback, cost estimate                   |
| 6. Data safety and polish         | T22–T23 | Export/import, voice substitution, offline guarantee, theme and layout              |

## Parallelization

Mostly a one-person, sequential build. If several sessions are available, these pairs are independent once their dependencies are done: T4/T5, T7/T10, T15/T16/T17, T19/T22. T13 (Kotlin) can run in parallel with Phase 4 once T11 exists.

## Risks and mitigations

| Risk                             | Impact | Mitigation                                                                          |
| -------------------------------- | ------ | ----------------------------------------------------------------------------------- |
| R1 Android stops TTS when locked | High   | T2 spike before anything else; fallback is keep-awake mode, decided at Checkpoint A |
| R2 Few device voices             | Medium | Pitch and rate variation (T10); the user can install voice packs                    |
| R3 Weak heuristic attribution    | Medium | Fixture accuracy tests (T8), manual reassignment (T18), LLM (T20)                   |
| R4 LLM span mismatch             | Low    | Per-unit fallback, property tests (T20)                                             |
| R5 Data loss on uninstall        | Medium | `storage.persist()` + JSON export (T22)                                             |
| R6 EPUB edge cases               | Medium | Import preview + fixture EPUBs (T15)                                                |

## Open questions

None. The spec's questions are resolved in its Decisions section.
