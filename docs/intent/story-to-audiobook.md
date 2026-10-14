# Intent: Story to Audiobook

Confirmed with the user on 2026-10-14 via an interview-me session.

- **Outcome:** A personal app that turns any story into a multi-voice read-aloud. Every line is tagged with who is narrating, speaking or thinking it, plus a tone, and playback keeps going with the screen locked.
- **User:** The author alone, mainly on an Android phone (Capacitor, built from Windows), with the same app usable in a desktop browser. No accounts, no backend. Everything is stored on the device, and the optional LLM API key stays in the app.
- **Input:** .txt, .epub or pasted text. A story is an ordered list of parts (chapters or pages) that can be added, inserted, reordered or replaced.
- **Analysis:** If an API key is set, an LLM gets each part plus the story's existing cast. If not, free heuristics run in the app. Output is only character ranges into the original text, checked to match it exactly. **The story text never changes.**
- **Cast memory:** Each story keeps its characters, aliases and voice settings. New parts reuse the cast, duplicates can be merged, and voices can be changed at any time.
- **Playback:** Free device TTS, with characters told apart by voice, pitch and speed. Tone tags are stored in the format for a later upgrade but not voiced in the MVP.
- **Languages:** English and Spanish. The heuristics handle both "quoted" dialogue and —dash— dialogue.
- **Success:** Upload chapter 1 today and chapter 2 next week, hear the same voices for the same people, and listen with the phone in a pocket.
- **Out of scope (MVP):** iOS, PDF and .docx, paid or neural TTS, actually voicing tone, sync or cloud storage, and sharing.

## Decisions and why

| Decision | Reason |
|---|---|
| Bring-your-own API key, no backend | Single user; a public app would need a paid proxy and abuse control, which conflicts with "no registration" and "client-side" |
| Free device TTS | Zero running cost matters more than expressiveness for the MVP |
| Free heuristic fallback when there's no key | The app must work with no paid services at all |
| Capacitor, Android first | Browser TTS stops when a mobile screen locks; the user is on Android and Windows (iOS needs a Mac) |
| No PDF | Extracting text from PDFs means rewriting it, which conflicts with "the text never changes" |
