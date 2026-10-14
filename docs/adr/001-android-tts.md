# ADR-001: Android playback with native TTS in a foreground service

- **Status:** Proposed. The approach is built; the device test is still pending.
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

| Item                                                            | Result |
| --------------------------------------------------------------- | ------ |
| Phone model / Android version                                   |        |
| Still playing after 30 min locked                               |        |
| Completed utterances / elapsed time                             |        |
| Largest gap between utterances / gaps over 3 s                  |        |
| Notification controls work (locked and unlocked)                |        |
| Device voices for en / es (Count voices button, after starting) |        |
| Battery optimisation setting needed?                            |        |

## Consequences

- Playback state lives natively. The JS player (Task 11) must treat native progress events as the source of truth for position.
- Pause restarts the current segment, which is acceptable since segments are short.
- The fallback, if the test fails, is a "keep screen on" mode (dimmed) while playing.
