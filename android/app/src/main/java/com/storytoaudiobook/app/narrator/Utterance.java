package com.storytoaudiobook.app.narrator;

/** One piece of text to speak with a given voice. Mirrors `Utterance` in src/playback/engine.ts. */
public final class Utterance {
    public final String id;
    public final String text;
    public final String voiceName; // may be null: use the engine default for `lang`
    public final String lang; // BCP-47, may be null
    public final float pitch;
    public final float rate;

    public Utterance(String id, String text, String voiceName, String lang, float pitch, float rate) {
        this.id = id;
        this.text = text;
        this.voiceName = voiceName;
        this.lang = lang;
        this.pitch = pitch;
        this.rate = rate;
    }
}
