# ADR-001: Android playback with native TTS in a foreground service

- **Status:** Proposed. Passed on the Android 15 emulator (2026-10-15, results below); a real-phone check is still pending for vendor battery savers and lock-screen controls.
- **Date:** 2026-10-14
- **Spec risk:** R1 (Android stops TTS when the screen locks)

## Context

In a mobile browser or WebView, `speechSynthesis` stops when the screen locks or the app goes to the background. The app's main use is listening with the phone locked in a pocket, so playback can't depend on JavaScript running in the WebView.

## Decision

A custom Capacitor plugin, `Narrator` (Java, `android/app/src/main/java/com/storytoaudiobook/app/narrator/`):

- **`NarratorPlugin`** receives a whole **queue** of utterances (`id`, `text`, `voiceName`, `lang`, `pitch`, `rate`) from JS. It hands the queue to the service through a static holder (avoiding Intent size limits) and starts the service.
- **`NarratorService`** is a foreground service of type `mediaPlayback`. It owns:
  - `TextToSpeech` (audio attributes `USAGE_MEDIA` / `CONTENT_TYPE_SPEECH`)
  - audio focus (pauses on loss)
  - a partial wake lock while playing
  - a notification with Previous / Play-Pause / Next actions
- Utterances are spoken **one at a time**. Each `onDone` callback starts the next one natively, so JS isn't involved during playback.
- Events go back to JS: `utteranceStart`, `utteranceDone` (with native timestamps), `state` and `error`.
- TTS has no real pause, so pause calls `stop()` and resume restarts the current utterance.

Rejected alternatives:

- **Web Speech in the WebView, plus a keep-alive plugin.** It depends on the WebView not being throttled, which Android doesn't guarantee.
- **`@capacitor-community/text-to-speech`.** It speaks one utterance per JS call, so JS has to run between utterances, which is the very thing that fails when locked. It also has no foreground service.
- **Kotlin.** The generated project is Java. Kotlin would add Gradle plugin setup for no benefit at this size.

## Device test (to fill in)

Install with `npm run android:apk`, then `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`, or copy the APK to the phone.

1. Open the app, tap **Start 400 utterances**, and allow notifications.
2. Lock the screen and put the phone away for **30 minutes**.
3. Check: is speech still playing? Do the lock-screen notification controls (pause, next) work?
4. Unlock and record from the spike screen:

| Item                                                            | Emulator (2026-10-15)                                                                                                                                                 | Phone |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Phone model / Android version                                   | Android Emulator 34.2, Pixel profile, Android 15 (API 35, Google Play image), Google TTS                                                                              |       |
| Still playing after 30 min locked                               | Yes. Screen off, battery unplugged and **deep Doze forced** (`dumpsys deviceidle force-idle`) for 33 min; the service stayed in the foreground throughout             |       |
| Completed utterances / elapsed time                             | 349 in 37 min 18 s (≈10 per minute, steady every minute while asleep: segment 8 → 340). The emulator synthesises slower than a phone                                  |       |
| Largest gap between utterances / gaps over 3 s                  | 23.8 s, once: the TTS engine warming up on the first sentence, before the screen went off. The two other gaps over 3 s were deliberate pauses during the control test |       |
| Notification controls work (locked and unlocked)                | Unlocked: Pause, Play, Next and Previous all work (Next/Previous keep the paused state). Locked: not tested (the emulator has no screen lock set)                     |       |
| Device voices for en / es (Count voices button, after starting) | 467 in total; 51 en, 18 es (11 of them offline)                                                                                                                       |       |
| Battery optimisation setting needed?                            | No (stock Android). Vendor battery savers (Samsung, Xiaomi…) can only be checked on a real phone                                                                      |       |

**Task 13 follow-up (production engine, 2026-10-15):** the notification is now a `MediaStyle` notification backed by a `MediaSession`, showing the story and part as the media card in the shade (and on the lock screen), with pause, play, previous and next. The player batches the rest of the part plus the next analysed part, so the service crosses into the next part without JS (verified with the screen off and Doze forced). Results are tracked in `docs/manual-test-checklist.md`.

**Known limitation: headset and Bluetooth media buttons.** `dumpsys media_session` reports "Media button session is null" during playback: Android routes media buttons to the app it sees playing audio, and TextToSpeech audio is played by the TTS engine's process, not ours. Fixing it would mean playing audio from our own process (for example synthesising to a file and playing it with `MediaPlayer`, or a silent `AudioTrack` alongside TTS). Deferred until it's wanted.

**Emulator findings to act on in Task 13** (done):

- The notification sits collapsed in the "Silent" section, so its buttons only appear after expanding it, and it isn't a media notification. Use `MediaStyle` with a `MediaSession` so the controls show inline, on the lock screen and to headphones and Bluetooth buttons.
- JS kept receiving progress events while the screen was off (the spike screen counted all 349), but the production player must still treat native events as the source of truth.

## Consequences

- Playback state lives natively. The JS player (Task 11) must treat native progress events as the source of truth for position.
- Pause restarts the current segment, which is acceptable since segments are short.
- The fallback, if the test fails, is a "keep screen on" mode (dimmed) while playing.
