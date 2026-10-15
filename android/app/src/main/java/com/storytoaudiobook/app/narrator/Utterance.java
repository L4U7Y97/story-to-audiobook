package com.storytoaudiobook.app.narrator;

/** One piece of text to speak with a given voice. Mirrors `NativeUtterance` in src/playback/nativeBridge.ts. */
public final class Utterance {
    public final String id;
    public final String text;
    public final String voiceName; // may be null: use the engine default for `lang`
    public final String lang; // BCP-47, may be null
    public final float pitch;
    public final float rate;
    public final String title; // shown in the media notification (the story), may be null
    public final String subtitle; // shown in the media notification (the part), may be null

    public Utterance(
        String id,
        String text,
        String voiceName,
        String lang,
        float pitch,
        float rate,
        String title,
        String subtitle
    ) {
        this.id = id;
        this.text = text;
        this.voiceName = voiceName;
        this.lang = lang;
        this.pitch = pitch;
        this.rate = rate;
        this.title = title;
        this.subtitle = subtitle;
    }
}
