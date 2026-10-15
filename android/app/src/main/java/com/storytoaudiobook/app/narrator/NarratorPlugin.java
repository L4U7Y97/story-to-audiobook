package com.storytoaudiobook.app.narrator;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.speech.tts.TextToSpeech;
import android.speech.tts.Voice;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.json.JSONException;
import org.json.JSONObject;

/** JS bridge for {@link NarratorService}. See src/playback/nativeBridge.ts for the TS side. */
@CapacitorPlugin(
    name = "Narrator",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class NarratorPlugin extends Plugin implements NarratorService.Listener {

    /** A TextToSpeech used only to list voices while the playback service isn't running. */
    private TextToSpeech voiceTts;
    private boolean voiceTtsReady = false;
    private final List<PluginCall> waitingForVoices = new ArrayList<>();

    @Override
    public void load() {
        NarratorService.setListener(this);
    }

    @Override
    protected void handleOnDestroy() {
        NarratorService.setListener(null);
        if (voiceTts != null) voiceTts.shutdown();
    }

    @PluginMethod
    public void play(PluginCall call) {
        JSArray items = call.getArray("queue");
        if (items == null) {
            call.reject("queue is required");
            return;
        }
        List<Utterance> queue = new ArrayList<>();
        try {
            for (int i = 0; i < items.length(); i++) {
                JSONObject o = items.getJSONObject(i);
                queue.add(new Utterance(
                    o.getString("id"),
                    o.getString("text"),
                    o.optString("voiceName", null),
                    o.optString("lang", null),
                    (float) o.optDouble("pitch", 1.0),
                    (float) o.optDouble("rate", 1.0),
                    o.optString("title", null),
                    o.optString("subtitle", null)
                ));
            }
        } catch (JSONException e) {
            call.reject("invalid queue: " + e.getMessage());
            return;
        }
        NarratorService.setQueue(queue, call.getInt("startIndex", 0), call.getString("batch", ""));
        send(NarratorService.ACTION_PLAY, true);
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        NarratorService s = NarratorService.getInstance();
        if (s != null) s.pause();
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        NarratorService s = NarratorService.getInstance();
        if (s != null) s.resume();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (NarratorService.getInstance() != null) send(NarratorService.ACTION_STOP, false);
        call.resolve();
    }

    /** Lists the device voices; works whether or not the playback service is running. */
    @PluginMethod
    public void getVoices(PluginCall call) {
        NarratorService s = NarratorService.getInstance();
        Set<Voice> fromService = s != null ? s.getVoices() : null;
        if (fromService != null) {
            resolveVoices(call, fromService);
            return;
        }
        if (voiceTtsReady) {
            resolveVoices(call, voiceTts.getVoices());
            return;
        }
        waitingForVoices.add(call);
        if (voiceTts == null) {
            voiceTts = new TextToSpeech(getContext(), status -> getBridge().executeOnMainThread(() -> {
                voiceTtsReady = status == TextToSpeech.SUCCESS;
                for (PluginCall waiting : waitingForVoices) {
                    resolveVoices(waiting, voiceTtsReady ? voiceTts.getVoices() : null);
                }
                waitingForVoices.clear();
            }));
        }
    }

    /** The last utterance the service started, saved natively so a killed app can resume there. */
    @PluginMethod
    public void getLastSpoken(PluginCall call) {
        SharedPreferences prefs =
            getContext().getSharedPreferences(NarratorService.PREFS, Context.MODE_PRIVATE);
        JSObject result = new JSObject();
        String id = prefs.getString(NarratorService.PREF_LAST_ID, null);
        if (id != null) {
            result.put("id", id);
            result.put("at", prefs.getLong(NarratorService.PREF_LAST_AT, 0));
        }
        call.resolve(result);
    }

    private void resolveVoices(PluginCall call, Set<Voice> voices) {
        JSArray out = new JSArray();
        if (voices != null) {
            for (Voice v : voices) {
                JSObject o = new JSObject();
                o.put("name", v.getName());
                o.put("lang", v.getLocale().toLanguageTag());
                o.put("network", v.isNetworkConnectionRequired());
                o.put("quality", v.getQuality());
                out.put(o);
            }
        }
        JSObject result = new JSObject();
        result.put("voices", out);
        result.put("ready", voices != null);
        call.resolve(result);
    }

    private void send(String action, boolean foreground) {
        Intent intent = new Intent(getContext(), NarratorService.class).setAction(action);
        if (foreground) ContextCompat.startForegroundService(getContext(), intent);
        else getContext().startService(intent);
    }

    // --- NarratorService.Listener -------------------------------------------------------------

    @Override
    public void onUtteranceStart(String batch, String id, int index) {
        notifyListeners("utteranceStart", utteranceEvent(batch, id, index), true);
    }

    @Override
    public void onUtteranceDone(String batch, String id, int index) {
        notifyListeners("utteranceDone", utteranceEvent(batch, id, index), true);
    }

    @Override
    public void onStateChange(String batch, String state) {
        JSObject data = new JSObject();
        data.put("batch", batch);
        data.put("state", state);
        notifyListeners("state", data, true);
    }

    @Override
    public void onError(String message) {
        JSObject data = new JSObject();
        data.put("message", message);
        notifyListeners("error", data, true);
    }

    private static JSObject utteranceEvent(String batch, String id, int index) {
        JSObject data = new JSObject();
        data.put("batch", batch);
        data.put("id", id);
        data.put("index", index);
        data.put("at", System.currentTimeMillis());
        return data;
    }
}
